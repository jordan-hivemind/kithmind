// F1-24: separates byte identity from acquisition provenance.
//
// rawTree.ts content-addresses a document by the hash of its retained bytes,
// which is right for the bytes: identical content always lands on one path,
// write-once. But byte equality is not source identity. The same statement
// bytes can legitimately be acquired twice -- two pulls of an overlapping
// period, a re-acquisition after a parser fix, the same document reachable
// from two endpoints -- and each acquisition has its own time, source,
// period and retention declaration, and each matters on its own. The old
// manifest sidecar was keyed on the document's content hash, so a second
// capture of identical bytes silently lost its provenance to the write-once
// no-op meant for the bytes, not for the acquisition that produced them.
//
// This file gives every capture -- every acquisition event -- its own
// immutable, content-hashed record, addressed by a capture id rather than by
// the document it references. Many captures may point at the same
// content-addressed document (rawTree.ts, `documents/`); each capture is
// independently discoverable by walking `<root>/captures/` in the raw tree,
// no database required, the same "self-describing" property rawTree.ts's
// manifest sidecar used to carry alone.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { AcquisitionGap, CapabilityTier } from "./adapter.js";
import type { RetentionRecord } from "./retention.js";
import { readAndVerify, sha256HexOf } from "./rawTree.js";

/**
 * One capture: one acquisition event that produced a document's bytes.
 * References the captured document by its content hash (rawTree.ts,
 * `documents/` namespace) rather than embedding or duplicating the bytes.
 */
export type CaptureManifest = {
  /**
   * This capture's own identity: an idempotency key for one acquisition
   * attempt, minted once (`persistAcquiredDocument` mints one when none is
   * supplied) and reused only by a retry of that same attempt. Reusing it
   * for a different acquisition -- different bytes, different period,
   * anything that changes the manifest -- is a conflict `writeCaptureManifest`
   * refuses outright rather than silently overwriting or coexisting.
   */
  readonly captureId: string;
  /** The content hash of the document this capture acquired (rawTree.ts,
   * `documents/`). Not this capture's own hash -- see `manifestSha256` on
   * `CaptureWriteResult` for that. */
  readonly documentSha256: string;
  /** The institution's stable slug, not the archive's internal row id --
   * that id means nothing once the database that minted it is gone. */
  readonly institutionSlug: string;
  /** Last four digits only, matching the privacy rule the database itself
   * enforces (accounts.acct_last4); null when the account has none on file. */
  readonly acctLast4: string | null;
  readonly docType: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly capturedAt: string;
  readonly capabilityTier: CapabilityTier;
  readonly gaps: readonly AcquisitionGap[];
  /** Dot-prefixed (".pdf", ".csv"), when the source gave one. */
  readonly originalExtension: string | null;
  /**
   * F1-23's retention record: the declaration that produced the retained
   * bytes, its version, the projection algorithm version, and the source
   * paths it dropped. This is acquisition provenance, not a property of the
   * bytes -- the same content could in principle be retained under a
   * different declaration on a later capture -- so it lives here, on the
   * capture, rather than on the document (F1-24 moved it off the document
   * manifest that F1-23 originally added it to).
   */
  readonly retention: RetentionRecord;
};

export type CaptureWriteResult = {
  readonly path: string;
  readonly status: "written" | "already_exists";
  /** sha256 of this capture manifest's own canonical JSON bytes -- what makes
   * the capture record itself content-hashed, on top of the document hash it
   * references. */
  readonly manifestSha256: string;
};

/**
 * Thrown when `captureId` already names a capture whose recorded content
 * disagrees with the one being written now. A capture id is one acquisition
 * attempt's own identity; the only safe reuse of it is a retry of that exact
 * attempt (byte-identical manifest, an idempotent no-op below). Two
 * different acquisitions colliding on the same id is a reconciliation
 * problem for a person to resolve, never something this writer resolves by
 * silently picking a winner.
 */
export class CaptureConflictError extends Error {
  constructor(captureId: string, existingPath: string) {
    super(
      `capture id ${JSON.stringify(captureId)} already names a different capture ` +
        `at ${existingPath}; reusing a capture id for conflicting content is a ` +
        "reconciliation problem, not something writeCaptureManifest resolves silently",
    );
    this.name = "CaptureConflictError";
  }
}

function captureDir(root: string, institutionSlug: string, capturedAt: string): string {
  const capturedDate = new Date(capturedAt);
  if (Number.isNaN(capturedDate.getTime())) {
    throw new RangeError(
      `capturedAt is not a valid ISO 8601 instant: ${JSON.stringify(capturedAt)}`,
    );
  }
  const yyyy = String(capturedDate.getUTCFullYear());
  const mm = String(capturedDate.getUTCMonth() + 1).padStart(2, "0");
  return join(root, "captures", institutionSlug, yyyy, mm);
}

/**
 * Writes one capture's manifest, write-once and content-addressed by its own
 * hash, under `<root>/captures/<institutionSlug>/<yyyy>/<mm>/`, `yyyy`/`mm`
 * taken from `capturedAt` (UTC). The file name is
 * `<captureId>-<manifestSha256>.json`, so a byte-identical resubmission of
 * the same capture (a retry) always lands on the same path, write-once,
 * exactly like a raw document's bytes.
 *
 * `captureId` reused for a manifest that hashes *differently* is refused
 * with `CaptureConflictError` rather than written alongside the first one or
 * silently dropped: the directory is scanned for any other file already
 * claiming this capture id before writing.
 *
 * ponytail: the scan-then-write is not atomic against a second *concurrent*
 * writer racing on the same capture id with different content -- both could
 * pass the scan and each write their own hash-suffixed file, landing two
 * conflicting captures under one id with no error raised. Acquisition in
 * this package is single-writer (see the plan's "Where things run"), so this
 * is a real but narrow gap; a directory lock or a database-backed capture
 * index would close it if acquisition ever becomes concurrent.
 */
export function writeCaptureManifest(
  root: string,
  manifest: CaptureManifest,
): CaptureWriteResult {
  const dir = captureDir(root, manifest.institutionSlug, manifest.capturedAt);
  mkdirSync(dir, { recursive: true });

  const bytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const manifestSha256 = sha256HexOf(bytes);
  const fileName = `${manifest.captureId}-${manifestSha256}.json`;
  const finalPath = join(dir, fileName);

  const prefix = `${manifest.captureId}-`;
  let siblings: string[] = [];
  try {
    siblings = readdirSync(dir);
  } catch {
    siblings = [];
  }
  for (const entry of siblings) {
    if (entry === fileName) continue;
    if (entry.startsWith(prefix) && entry.endsWith(".json")) {
      throw new CaptureConflictError(manifest.captureId, join(dir, entry));
    }
  }

  if (existsSync(finalPath)) {
    readAndVerify(finalPath, manifestSha256);
    return { path: finalPath, status: "already_exists", manifestSha256 };
  }

  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, bytes, { flag: "wx" });
  try {
    linkSync(tmpPath, finalPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      readAndVerify(finalPath, manifestSha256);
      return { path: finalPath, status: "already_exists", manifestSha256 };
    }
    throw error;
  }
  rmSync(tmpPath, { force: true });
  return { path: finalPath, status: "written", manifestSha256 };
}

/** Reads one capture manifest back. The point of this file existing: a
 * rebuild that has lost the archive database still has every capture, each
 * naming the document it acquired by content hash. */
export function readCaptureManifest(path: string): CaptureManifest {
  return JSON.parse(readFileSync(path, "utf8")) as CaptureManifest;
}
