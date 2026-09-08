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
// Each acquisition also gets a capture manifest, immutable and its own
// content-hashed record, addressed by a capture id rather than by the
// document it references (see captures.ts): the raw tree has to be
// identifiable on its own, with no working archive database, because the
// database is derived data and the raw tree is the one thing ground rule 1
// says can never be reconstructed by re-acquiring it. That manifest used to
// live here as a `.manifest.json` sidecar keyed on the document's own
// content hash, which meant two captures of byte-identical content -- an
// overlapping re-pull, a re-acquisition after a parser fix, the same
// document reachable from two endpoints -- collapsed onto one write-once
// slot and the second capture's provenance was silently discarded (F1-24).
// Byte identity (this file) and acquisition provenance (captures.ts) are two
// different things now: this file only ever answers "have these exact bytes
// been seen," and captures.ts answers "what acquisition produced them."

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

import type { RetainedPayload } from "./retention.js";
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

// The document-level manifest sidecar that used to live here moved to
// captures.ts (F1-24): `writeCaptureManifest`, addressed by capture id, not
// by this file's content hash. See that file's header for why.
