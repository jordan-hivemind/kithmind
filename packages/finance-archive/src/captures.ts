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
//
// F1-34 closed three holes a mainline review left open here:
//
// 1. Every path segment is checked against the closed grammar in rawTree.ts
//    (`assertArchiveSegment`) before it is joined. A source id or capture id
//    used to enter a path unvalidated, so `../..` in either one wrote
//    outside this space's namespace.
// 2. Capture identity is unique across the whole captures namespace, not
//    within one partition. The conflict check used to scan a single
//    source/year/month directory, so the same capture id reused with a
//    different source or a different capture month passed it and wrote a
//    second, disagreeing record. `<root>/captures/.by-id/<captureId>` is now
//    the index of every capture id in this space: one hard link, claimed
//    atomically before the partitioned record is written, so a reuse
//    anywhere is a conflict. The index entry is a hard link to the manifest
//    itself, so it carries no second copy of the bytes and can never dangle
//    or disagree with what it indexes. The name is dot-prefixed, which no
//    valid source id can be, so it cannot collide with a source's directory.
// 3. Reading a capture back verifies it (`readCaptureManifest`): a closed
//    versioned schema, the manifest hash in its own file name, the partition
//    it sits in, and the existence and hash of the retained object it
//    names. A rebuild that has lost the archive database takes captures as
//    fact, so a tampered or dangling one has to be rejected rather than
//    believed.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { AcquisitionGap, CapabilityTier } from "./adapter.js";
import type { RetentionRecord } from "./retention.js";
import {
  ARCHIVE_SEGMENT,
  assertArchiveSegment,
  rawDocumentPath,
  readAndVerify,
  sha256HexOf,
} from "./rawTree.js";

/**
 * The capture record format this build writes and is willing to read. A
 * closed version, not a compatibility range: `readCaptureManifest` refuses
 * anything else rather than guess at a record written by a build that knew
 * different rules.
 */
export const CAPTURE_MANIFEST_VERSION = 1;

/**
 * One capture: one acquisition event that produced a document's bytes.
 * References the captured document by its content hash (rawTree.ts,
 * `documents/` namespace) rather than embedding or duplicating the bytes.
 */
export type CaptureManifest = {
  /** Always `CAPTURE_MANIFEST_VERSION`. */
  readonly version: typeof CAPTURE_MANIFEST_VERSION;
  /**
   * This capture's own identity: an idempotency key for one acquisition
   * attempt, minted once (`persistAcquiredDocument` mints one when none is
   * supplied) and reused only by a retry of that same attempt. Reusing it
   * for a different acquisition -- different bytes, different period,
   * anything that changes the manifest -- is a conflict `writeCaptureManifest`
   * refuses outright rather than silently overwriting or coexisting, and
   * that holds across the whole captures namespace, not just within one
   * source and month.
   */
  readonly captureId: string;
  /**
   * The opaque identity of the source this capture came from: the archive's
   * `institutions.id` (F1-34), which is the same stable id the read
   * contract's `sourceObject.sourceId` carries. The partition segment under
   * `captures/` and nothing human-readable, so the tree's layout does not
   * publish who the source is; the slug below is metadata inside the record.
   */
  readonly sourceId: string;
  /** The content hash of the document this capture acquired (rawTree.ts,
   * `documents/`). Not this capture's own hash -- see `manifestSha256` on
   * `CaptureWriteResult` for that. */
  readonly documentSha256: string;
  /** The institution's stable slug, recorded so a rebuild that has lost the
   * database can still read what the source was called. Metadata only: it is
   * not this capture's identity and not a path segment. */
  readonly institutionSlug: string;
  /** Last four digits only, matching the privacy rule the database itself
   * enforces (accounts.acct_last4); null when the account has none on file;
   * or the literal `"all"` (F1-35) for an institution-wide pull that names
   * no single account -- this capture belongs to the institution, not to one
   * account, and `"all"` says so rather than a guessed or borrowed last4. */
  readonly acctLast4: string | null;
  readonly docType: string;
  /**
   * F1-71. The provider's own id for the document this capture acquired
   * (`DiscoveredDocument.providerDocumentId`, adapter.ts), recorded so the
   * raw tree keeps saying which document a capture is *of* -- the thing a
   * rebuild needs and that `documentSha256` cannot answer for a source that
   * re-renders its bytes on every download.
   *
   * Absent, not null, on every record written before this field existed and
   * on a capture whose adapter names no id: the reader below accepts a
   * missing key here (and only here) rather than bumping
   * `CAPTURE_MANIFEST_VERSION`, which would refuse every capture already on
   * disk. Absent means "this capture does not say," the same honest-null
   * policy the database columns use, and the writer omits the key entirely
   * rather than writing a null, so a capture with nothing to record hashes
   * exactly as it did before.
   */
  readonly providerDocumentId?: string;
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
        `(indexed at ${existingPath}); reusing a capture id for conflicting content is a ` +
        "reconciliation problem, not something writeCaptureManifest resolves silently",
    );
    this.name = "CaptureConflictError";
  }
}

/**
 * Thrown when a capture on disk cannot be taken as fact: its record does not
 * match the closed schema, its own hash, the partition it sits in, or the
 * retained object it names. `reason` separates the cases, because "someone
 * edited this" and "the bytes it cites are gone" call for different
 * responses from a rebuild.
 */
export class CaptureIntegrityError extends Error {
  readonly reason:
    | "schema"
    | "manifest_hash"
    | "partition"
    | "missing_document"
    | "document_hash";

  constructor(reason: CaptureIntegrityError["reason"], path: string, detail: string) {
    super(`capture at ${path} is not trustworthy (${reason}): ${detail}`);
    this.name = "CaptureIntegrityError";
    this.reason = reason;
  }
}

/** The index directory of every capture id written under one space. Dot-
 * prefixed on purpose: `ARCHIVE_SEGMENT` forbids a leading dot, so no source
 * id can ever name this directory. */
const CAPTURE_INDEX_DIR = ".by-id";

const SHA256 = /^[0-9a-f]{64}$/;
const CAPTURE_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})-([0-9a-f]{64})\.json$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function captureDir(root: string, sourceId: string, capturedAt: string): string {
  const capturedDate = new Date(capturedAt);
  if (Number.isNaN(capturedDate.getTime())) {
    throw new RangeError(
      `capturedAt is not a valid ISO 8601 instant: ${JSON.stringify(capturedAt)}`,
    );
  }
  const yyyy = String(capturedDate.getUTCFullYear());
  const mm = String(capturedDate.getUTCMonth() + 1).padStart(2, "0");
  return join(
    root,
    "captures",
    assertArchiveSegment(sourceId, "capture source id"),
    yyyy,
    mm,
  );
}

/**
 * Writes one capture's manifest, write-once and content-addressed by its own
 * hash, under `<root>/captures/<sourceId>/<yyyy>/<mm>/`, `yyyy`/`mm` taken
 * from `capturedAt` (UTC). The file name is
 * `<captureId>-<manifestSha256>.json`, so a byte-identical resubmission of
 * the same capture (a retry) always lands on the same path, write-once,
 * exactly like a raw document's bytes.
 *
 * `captureId` is claimed in one index for the whole space,
 * `<root>/captures/.by-id/<captureId>`, before the partitioned record is
 * written. The claim is a `linkSync`, which fails with EEXIST rather than
 * overwriting, so it is atomic against a concurrent writer as well as
 * against the partition-hopping the old per-directory scan missed: reusing
 * an id under a different source or a different capture month is a
 * `CaptureConflictError` like any other reuse, not a second record. A retry
 * of the same attempt hashes identically, so its claim resolves to the same
 * bytes and the write stays an idempotent no-op.
 */
export function writeCaptureManifest(
  root: string,
  manifest: CaptureManifest,
): CaptureWriteResult {
  if (manifest.version !== CAPTURE_MANIFEST_VERSION) {
    throw new TypeError(
      `capture manifest version ${JSON.stringify(manifest.version)} is not the version this ` +
        `build writes (${CAPTURE_MANIFEST_VERSION})`,
    );
  }
  assertArchiveSegment(manifest.captureId, "capture id");
  const dir = captureDir(root, manifest.sourceId, manifest.capturedAt);
  mkdirSync(dir, { recursive: true });

  const bytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const manifestSha256 = sha256HexOf(bytes);
  const finalPath = join(dir, `${manifest.captureId}-${manifestSha256}.json`);
  const indexDir = join(root, "captures", CAPTURE_INDEX_DIR);
  const indexPath = join(indexDir, manifest.captureId);
  mkdirSync(indexDir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, bytes, { flag: "wx" });
  try {
    try {
      linkSync(tmpPath, indexPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // The id is already claimed. Identical content is a retry of that same
      // attempt; anything else is two acquisitions wearing one id.
      if (sha256HexOf(readFileSync(indexPath)) !== manifestSha256) {
        throw new CaptureConflictError(manifest.captureId, indexPath);
      }
    }

    if (existsSync(finalPath)) {
      readAndVerify(finalPath, manifestSha256);
      return { path: finalPath, status: "already_exists", manifestSha256 };
    }
    try {
      linkSync(tmpPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      readAndVerify(finalPath, manifestSha256);
      return { path: finalPath, status: "already_exists", manifestSha256 };
    }
    return { path: finalPath, status: "written", manifestSha256 };
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

/** What `readCaptureManifestById` found: the verified manifest, the
 * canonical partitioned path it lives at, and that file's own content hash
 * (its manifest's `manifestSha256`, matching `CaptureWriteResult`) -- so a
 * caller that goes on to build a synthetic `PersistedAcquisition` (the
 * reparse operator command) can cite the real, already-written capture
 * record rather than inventing one. */
export type CaptureManifestLookup = {
  readonly manifest: CaptureManifest;
  readonly path: string;
  readonly manifestSha256: string;
};

/**
 * Reads a capture manifest knowing only its id (`documents.capture_id`),
 * via the space-wide `.by-id` index (above): a hard link to the canonical
 * partitioned file, so its bytes -- and therefore its hash and content --
 * are identical. The canonical path itself is only knowable from the
 * manifest's own `sourceId`/`capturedAt`, which is why this reads the index
 * copy first rather than asking the caller to already know the partition.
 * Delegates to `readCaptureManifest` for the full verification (schema,
 * hash, partition, retained document) once that path is reconstructed, so a
 * capture found this way is checked exactly as strictly as one found by
 * walking the tree.
 *
 * The reparse operator command (run.ts) is the intended caller: it knows a
 * document's `capture_id` from the archive database, not the source/month
 * partition the capture was originally filed under.
 */
export function readCaptureManifestById(root: string, captureId: string): CaptureManifestLookup {
  const indexPath = join(
    root,
    "captures",
    CAPTURE_INDEX_DIR,
    assertArchiveSegment(captureId, "capture id"),
  );
  const indexBytes = readFileSync(indexPath);
  const parsed = parseManifest(indexPath, indexBytes);
  const manifestSha256 = sha256HexOf(indexBytes);
  const path = join(
    captureDir(root, parsed.sourceId, parsed.capturedAt),
    `${parsed.captureId}-${manifestSha256}.json`,
  );
  return { manifest: readCaptureManifest(path), path, manifestSha256 };
}

function isSegment(value: unknown): boolean {
  return typeof value === "string" && ARCHIVE_SEGMENT.test(value);
}

function isText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isDate(value: unknown): boolean {
  return typeof value === "string" && ISO_DATE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The closed schema. Every key is required, every value is bounded, and a
 * key not listed here fails the record: an unbounded `JSON.parse` cast used
 * to let anything with the right few fields be read back as provenance.
 */
const MANIFEST_FIELDS: Record<string, (value: unknown) => boolean> = {
  version: (value) => value === CAPTURE_MANIFEST_VERSION,
  captureId: isSegment,
  sourceId: isSegment,
  documentSha256: (value) => typeof value === "string" && SHA256.test(value),
  institutionSlug: isText,
  acctLast4: (value) =>
    value === null ||
    value === "all" ||
    (typeof value === "string" && /^[0-9]{4}$/.test(value)),
  docType: isText,
  // F1-71: the one optional field. See CaptureManifest.providerDocumentId --
  // absent on every capture written before it existed, which is most of a
  // live raw tree, so requiring it would refuse them all.
  providerDocumentId: (value) => value === undefined || isText(value),
  periodStart: isDate,
  periodEnd: isDate,
  capturedAt: (value) =>
    typeof value === "string" && !Number.isNaN(new Date(value).getTime()),
  capabilityTier: isText,
  gaps: (value) =>
    Array.isArray(value) &&
    value.every(
      (gap) =>
        isRecord(gap) &&
        Object.keys(gap).length === 3 &&
        isDate(gap.periodStart) &&
        isDate(gap.periodEnd) &&
        isText(gap.reason),
    ),
  originalExtension: (value) =>
    value === null || (typeof value === "string" && /^\.[A-Za-z0-9]{1,16}$/.test(value)),
  retention: (value) =>
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isRecord(value.policy) &&
    isText((value.policy as Record<string, unknown>).version) &&
    isText(value.projectionVersion) &&
    Array.isArray(value.droppedPaths) &&
    value.droppedPaths.every(isText),
};

function parseManifest(path: string, bytes: Buffer): CaptureManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CaptureIntegrityError("schema", path, "not JSON");
  }
  if (!isRecord(parsed)) {
    throw new CaptureIntegrityError("schema", path, "not a JSON object");
  }
  for (const key of Object.keys(parsed)) {
    if (!(key in MANIFEST_FIELDS)) {
      throw new CaptureIntegrityError(
        "schema",
        path,
        `unknown field ${JSON.stringify(key)}`,
      );
    }
  }
  for (const [key, valid] of Object.entries(MANIFEST_FIELDS)) {
    if (!valid(parsed[key])) {
      throw new CaptureIntegrityError(
        "schema",
        path,
        `field ${JSON.stringify(key)} is missing or not what version ` +
          `${CAPTURE_MANIFEST_VERSION} of this record allows`,
      );
    }
  }
  return parsed as unknown as CaptureManifest;
}

/**
 * Reads one capture manifest back, and refuses to return one that cannot be
 * taken as fact. The point of this file existing: a rebuild that has lost
 * the archive database still has every capture, each naming the document it
 * acquired by content hash -- which means a rebuild believes these records,
 * so every claim one makes about itself is checked before it is returned.
 *
 * Four checks, each its own `CaptureIntegrityError.reason`:
 * `schema` (a closed, versioned shape, not an unbounded cast),
 * `manifest_hash` (the file's own name states its content hash, so a record
 * edited in place no longer matches its path),
 * `partition` (the source and capture month in the record are the directory
 * it sits in, so a record cannot be moved under another source),
 * `missing_document`/`document_hash` (the retained object it cites exists
 * under `documents/` and still hashes to the recorded value).
 */
export function readCaptureManifest(path: string): CaptureManifest {
  const bytes = readFileSync(path);
  const named = CAPTURE_FILE.exec(basename(path));
  if (!named) {
    throw new CaptureIntegrityError(
      "manifest_hash",
      path,
      "file name does not spell <captureId>-<manifestSha256>.json",
    );
  }
  const actual = sha256HexOf(bytes);
  if (actual !== named[2]) {
    throw new CaptureIntegrityError(
      "manifest_hash",
      path,
      `content hashes to ${actual} but its name claims ${named[2]}`,
    );
  }

  const manifest = parseManifest(path, bytes);
  if (manifest.captureId !== named[1]) {
    throw new CaptureIntegrityError(
      "manifest_hash",
      path,
      `record names capture ${JSON.stringify(manifest.captureId)} but its file names ` +
        `${JSON.stringify(named[1])}`,
    );
  }

  // <root>/captures/<sourceId>/<yyyy>/<mm>/<file>
  const dir = dirname(path);
  const root = resolve(dir, "..", "..", "..", "..");
  if (captureDir(root, manifest.sourceId, manifest.capturedAt) !== dir) {
    throw new CaptureIntegrityError(
      "partition",
      path,
      "the source and capture month it records are not the ones it is filed under",
    );
  }

  const documentPath = rawDocumentPath(root, manifest.documentSha256);
  if (!existsSync(documentPath)) {
    throw new CaptureIntegrityError(
      "missing_document",
      path,
      `the retained object it cites (${manifest.documentSha256}) is not in this raw tree`,
    );
  }
  try {
    readAndVerify(documentPath, manifest.documentSha256);
  } catch (error) {
    throw new CaptureIntegrityError(
      "document_hash",
      path,
      (error as Error).message,
    );
  }
  return manifest;
}
