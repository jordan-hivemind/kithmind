// The raw tree writer. Ground rule 1 (docs/plans/2026-09-07-financial-transaction-database.md):
// raw files are immutable, written once to the raw tree, never edited, never
// deleted. `acquire` (adapter.ts) hands back bytes and a manifest; F1-2 left
// persisting those bytes to the importer, and neither F1-3 nor F1-12 picked
// it up. This file is where that finally happens: it is the only place in
// this package that touches node:fs.
//
// Layout: content-addressed.
//   <root>/documents/<sha[0:2]>/<sha[2:4]>/<sha256>
//   <root>/text/<sha[0:2]>/<sha[2:4]>/<sha256>.txt
// (the text path is hashed on the retained text's own bytes, not the
// document's -- a separate namespace, so a text blob and a raw document can
// never collide on path even in principle, on top of sha256 already making a
// same-namespace collision practically impossible.)
//
// Content addressing over date- or institution-partitioning because it makes
// two of this task's hard requirements true by construction instead of by
// convention someone could get wrong: identical bytes always land on the
// same path, so a repeat write of the same content is caught by the layout
// itself rather than a lookup a caller has to remember to run; and two
// different byte strings can never collide on a path, because the path *is*
// their hash, so there is no institution/date/sequence scheme to get wrong
// under concurrent acquisition. A 2+2 hex fan-out (65536 buckets) keeps any
// one directory small at tens of thousands of documents, which stays fine
// for a person to browse by hand.
//
// Each raw document also gets a `.manifest.json` sidecar next to its bytes
// (see "self-describing manifest sidecar" below): the raw tree has to be
// identifiable on its own, with no working archive database, because the
// database is derived data and the raw tree is the one thing ground rule 1
// says can never be reconstructed by re-acquiring it.

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AcquisitionGap, CapabilityTier } from "./adapter.js";
import type { RetainedPayload, RetentionRecord } from "./retention.js";
import { assertRetained } from "./retention.js";

const RAW_TREE_ROOT_ENV = "FINANCE_ARCHIVE_RAW_TREE_ROOT";

/**
 * Reads the raw tree root from FINANCE_ARCHIVE_RAW_TREE_ROOT and nowhere
 * else, mirroring the pattern src/mcp/run.ts already uses for the archive
 * path (FINANCE_ARCHIVE_DB_PATH). A real path never belongs in this
 * repository, so there is no default: a missing setting is a hard error
 * naming exactly what is missing, not a silent fallback to a guessed
 * location.
 */
export function resolveRawTreeRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env[RAW_TREE_ROOT_ENV];
  if (!root) {
    throw new Error(
      `${RAW_TREE_ROOT_ENV} is not set. Point it at the local directory where ` +
        "acquired documents and retained text are persisted; that path is " +
        "never committed and this package never defaults to one.",
    );
  }
  return root;
}

export function sha256HexOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fanoutPath(
  root: string,
  namespace: string,
  hash: string,
  extension: string,
): string {
  return join(root, namespace, hash.slice(0, 2), hash.slice(2, 4), `${hash}${extension}`);
}

export type RawTreeWriteResult = {
  readonly path: string;
  readonly sha256: string;
  /**
   * "written" the first time these exact bytes are persisted under this
   * namespace; "already_exists" on every re-attempt after that. Re-writing
   * identical content is always a no-op reported this way, never a rewrite
   * and never a thrown error that would abort a run (requirement 1).
   */
  readonly status: "written" | "already_exists";
};

/**
 * Verifies a file on disk still hashes to `expectedSha256`. Throws a
 * descriptive error naming the path and both hashes rather than returning
 * wrong bytes: a mismatch here is a corrupted archive, and the archive's
 * whole reason to exist is that a citation can still be opened and trusted
 * (requirement 3). Used both internally, to check a file already sitting at
 * a write-once path before treating a repeat write as a safe no-op, and as a
 * general-purpose readback check for any other caller (an audit script, a
 * future `get_evidence` reader) that wants the same guarantee.
 */
export function readAndVerify(path: string, expectedSha256: string): Buffer {
  const bytes = readFileSync(path);
  const actual = sha256HexOf(bytes);
  if (actual !== expectedSha256) {
    throw new Error(
      `raw tree corruption detected: ${path} hashes to ${actual}, expected ${expectedSha256}`,
    );
  }
  return bytes;
}

/**
 * Writes `bytes` once, write-once, to a content-addressed path under
 * `root/namespace`. The hash is verified twice: once against a temp file
 * read back immediately after writing (catches a bad write before it is
 * ever linked into the tree), and once against whatever already sits at the
 * target path when a prior write is found there (catches a corrupted prior
 * file rather than silently trusting its presence) -- requirement 2.
 *
 * Write-once is enforced with a hard link rather than a rename or a plain
 * write: `linkSync` fails with EEXIST instead of silently overwriting an
 * existing target, so there is no race where two concurrent writes of the
 * same content clobber one another, and no code path in this function ever
 * deletes an existing raw-tree file (requirement 4 -- nothing here deletes a
 * prior recoverable version, validated or not).
 */
function writeContentAddressed(
  root: string,
  namespace: string,
  bytes: Uint8Array,
  extension: string,
): RawTreeWriteResult {
  const sha256 = sha256HexOf(bytes);
  const finalPath = fanoutPath(root, namespace, sha256, extension);
  mkdirSync(dirname(finalPath), { recursive: true });

  if (existsSync(finalPath)) {
    readAndVerify(finalPath, sha256);
    return { path: finalPath, sha256, status: "already_exists" };
  }

  const tmpPath = join(dirname(finalPath), `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, bytes, { flag: "wx" });
  try {
    const writtenHash = sha256HexOf(readFileSync(tmpPath));
    if (writtenHash !== sha256) {
      throw new Error(
        `raw tree write corrupted in transit: expected sha256 ${sha256} but the ` +
          `bytes on disk hash to ${writtenHash}`,
      );
    }
    linkSync(tmpPath, finalPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost a race with a concurrent writer of the same content between the
      // existsSync check above and this link. That writer's file is the
      // system of record now; verify it rather than treat our own copy as
      // authoritative.
      readAndVerify(finalPath, sha256);
      return { path: finalPath, sha256, status: "already_exists" };
    }
    throw error;
  }
  rmSync(tmpPath, { force: true });
  return { path: finalPath, sha256, status: "written" };
}

/**
 * Persists one acquired document's retained bytes, write-once, under `root`.
 *
 * Takes a `RetainedPayload` and not a `Uint8Array` (F1-23). This file is the
 * only place in the package that touches `node:fs` for a document, and
 * `retainPayload` is the only thing that produces a `RetainedPayload` --
 * branded at compile time and tracked in a run-time WeakSet -- so an
 * unprojected provider response has no route to the raw tree at all. That is
 * the same structural move F1-18 made with `AdapterPull.persisted`: not a
 * rule someone has to remember, a shape they cannot construct.
 *
 * The hash under which the bytes land is the hash of these retained bytes,
 * computed by `retainPayload` over exactly what is written here. The original
 * response is never hashed and never stored.
 */
export function writeRawDocument(
  root: string,
  retained: RetainedPayload,
): RawTreeWriteResult {
  return writeContentAddressed(root, "documents", assertRetained(retained).bytes, "");
}

/**
 * Persists retained extracted text (ground rule 6: text extraction before
 * OCR), write-once, under `root`, addressed by the text's own content hash.
 */
export function writeRetainedText(
  root: string,
  text: string,
): RawTreeWriteResult {
  return writeContentAddressed(root, "text", Buffer.from(text, "utf8"), ".txt");
}

// --- self-describing manifest sidecar --------------------------------------
// Ground rule 1 does not stop at "raw files are immutable": "all structured
// data is derived and can be rebuilt from scratch." The archive database is
// structured data -- lose it, and a directory of extension-less files named
// by hash is unlabelled unless the raw tree itself says what each one is.
// This sidecar is that label, written into the raw tree next to the bytes it
// describes rather than only into the (derived, rebuildable) database.

/** The acquisition manifest, persisted where a rebuild with no working
 * archive database can still find it: enough to identify what a raw-tree
 * document is and re-import it. */
export type RawTreeDocumentManifest = {
  readonly sha256: string;
  /** The institution's stable slug (e.g. "thistlebrook-trust"), not the
   * archive's internal institution row id -- that id means nothing once the
   * database that minted it is gone. Doubles as the identity of the adapter
   * that produced this document, since one adapter serves one institution. */
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
  /** Dot-prefixed (".pdf", ".csv"), when the source gave one. The raw bytes
   * stay content-addressed and extension-less either way -- this is where a
   * person or a rebuild learns what to call the file, not a rename target. */
  readonly originalExtension: string | null;
  /**
   * F1-23. What was retained and how, so a reader who opens this file learns
   * that it is a projection of the provider's response rather than the
   * response itself: the adapter's declaration and its version, the
   * projection algorithm version, and the source paths that were dropped
   * (paths only, never values). `mode` is `policy.kind`: `json_allowlist`
   * means fields were selected, `opaque` means the artifact had no
   * addressable fields and its bytes were retained whole.
   *
   * This is the only field F1-23 adds to the manifest. F1-24 separates byte
   * identity from capture provenance in this same type; this addition is
   * capture provenance and moves with that half.
   */
  readonly retention: RetentionRecord;
};

export type ManifestWriteResult = {
  readonly path: string;
  readonly status: "written" | "already_exists";
};

/**
 * Writes the sidecar manifest for one raw-tree document, at
 * `<root>/documents/<sha[0:2]>/<sha[2:4]>/<sha256>.manifest.json`, right next
 * to the bytes it describes. Write-once like the document itself -- the
 * manifest is part of what was acquired, not something to revise later --
 * but addressed by the *document's* hash rather than its own content, so
 * unlike `writeRawDocument`/`writeRetainedText` above there is no hash to
 * verify a pre-existing file against: the path already being occupied is the
 * only check, and a repeat write for the same document is a no-op.
 */
export function writeRawDocumentManifest(
  root: string,
  manifest: RawTreeDocumentManifest,
): ManifestWriteResult {
  const finalPath = fanoutPath(root, "documents", manifest.sha256, ".manifest.json");
  mkdirSync(dirname(finalPath), { recursive: true });
  if (existsSync(finalPath)) {
    return { path: finalPath, status: "already_exists" };
  }

  const bytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const tmpPath = join(dirname(finalPath), `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, bytes, { flag: "wx" });
  try {
    linkSync(tmpPath, finalPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { path: finalPath, status: "already_exists" };
    }
    throw error;
  }
  rmSync(tmpPath, { force: true });
  return { path: finalPath, status: "written" };
}

/** Reads one document's manifest sidecar back. The whole point of this file
 * existing: a rebuild that has lost the archive database still has this. */
export function readRawDocumentManifest(path: string): RawTreeDocumentManifest {
  return JSON.parse(readFileSync(path, "utf8")) as RawTreeDocumentManifest;
}
