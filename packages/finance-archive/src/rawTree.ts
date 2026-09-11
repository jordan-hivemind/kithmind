// The raw tree writer. Ground rule 1 (docs/plans/2026-09-07-financial-transaction-database.md):
// raw files are immutable, written once to the raw tree, never edited, never
// deleted. `acquire` (adapter.ts) hands back bytes and a manifest; F1-2 left
// persisting those bytes to the importer, and neither F1-3 nor F1-12 picked
// it up. This file is where that finally happens: it is the only place in
// this package that touches node:fs.
//
// Layout: content-addressed, under a shared-root prefix (F1-28).
//   <configured root>/archive/v1/<space id>/documents/<sha[0:2]>/<sha[2:4]>/<sha256>
//   <configured root>/archive/v1/<space id>/text/<sha[0:2]>/<sha[2:4]>/<sha256>.txt
// (the text path is hashed on the retained text's own bytes, not the
// document's -- a separate namespace, so a text blob and a raw document can
// never collide on path even in principle, on top of sha256 already making a
// same-namespace collision practically impossible.)
//
// The `archive/v1/<space id>` prefix exists because the configured root is a
// managed root a second subsystem can also write under (the "one managed
// root, one layout" agreement in
// docs/plans/2026-09-08-unified-storage-assessment.md), not a directory this
// writer owns alone. `archive/v1` is a constant of this writer -- bumping the
// layout version is a deliberate code change, never something a caller
// selects by configuration -- and the space id is configuration, resolved
// the same hard-error way as the root itself: see `resolveArchiveSpaceId`
// below. Without the prefix, two subsystems pointed at the same configured
// root would collide directly on `documents/`, `text/` and `captures/`.
// Everything below the prefix -- content addressing, the fan-out, the
// separate text namespace, write-once, hash verification -- is unchanged.
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
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { RetainedPayload } from "./retention.js";
import { assertRetained } from "./retention.js";

const RAW_TREE_ROOT_ENV = "FINANCE_ARCHIVE_RAW_TREE_ROOT";
const SPACE_ID_ENV = "FINANCE_ARCHIVE_SPACE_ID";

/**
 * The layout version segment every path this writer produces falls under. A
 * constant of the writer, not free configuration: the agreed layout can
 * change later by changing this constant in code, which is unambiguous to a
 * reader of the tree, rather than by an environment variable that could
 * point different writers at different, silently incompatible versions.
 */
export const ARCHIVE_LAYOUT_VERSION = "v1";

/**
 * The closed grammar every caller-supplied path segment this package writes
 * must match: a space id (below), and a capture's source id and capture id
 * (captures.ts). ASCII letters, digits, `_` and `-` only, first character
 * alphanumeric, 1-128 characters. It admits no `.`, no `/` and no `\`, so a
 * matching segment can never be `..`, can never reach a parent directory and
 * can never open a second path component: a segment that matches is always
 * exactly one directory name under the root it is joined to.
 */
export const ARCHIVE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Rejects a path segment that does not match `ARCHIVE_SEGMENT`. Every
 * caller-supplied value that becomes a directory or file name in the raw
 * tree goes through this, so confinement to the managed root is a property
 * of the grammar, checked once, rather than of every `join` call being read
 * carefully.
 */
export function assertArchiveSegment(value: string, label: string): string {
  if (!ARCHIVE_SEGMENT.test(value)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} is not a usable raw-tree path segment; ` +
        "use 1-128 ASCII letters, digits, underscores or hyphens, starting with a letter " +
        "or digit -- a segment that could traverse out of the managed root is refused",
    );
  }
  return value;
}

/**
 * Reads the space id from FINANCE_ARCHIVE_SPACE_ID and nowhere else, the
 * same pattern `resolveRawTreeRoot` uses for the configured root. The space
 * id is configuration, not a default: this package has no notion of a
 * current or implied space, so a missing setting is a hard error naming
 * exactly what is missing, never a guessed value. No real space id belongs
 * in this repository.
 *
 * The value becomes one path segment under the managed root, so it must
 * match `ARCHIVE_SEGMENT`. Any nonempty string used to be accepted, which
 * meant `../../backups` resolved into a sibling subsystem's namespace under
 * the shared managed root and `../../../outside` left the managed root
 * altogether -- one space writing into another space's tree is exactly the
 * isolation failure this prefix exists to prevent.
 */
export function resolveArchiveSpaceId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const spaceId = env[SPACE_ID_ENV];
  if (!spaceId) {
    throw new Error(
      `${SPACE_ID_ENV} is not set. Point it at the space this archive belongs to; ` +
        "that id is never committed and this package never defaults to one.",
    );
  }
  return assertArchiveSegment(spaceId, SPACE_ID_ENV);
}

/**
 * Reads the raw tree root: the configured managed root
 * (FINANCE_ARCHIVE_RAW_TREE_ROOT, the same env var and nowhere else,
 * mirroring the pattern src/mcp/run.ts already uses for the reader's
 * connection string, FINANCE_ARCHIVE_READER_DATABASE_URL), joined with the
 * fixed `archive/v1` layout
 * version and the configured space id (FINANCE_ARCHIVE_SPACE_ID, above) --
 * the prefix a second subsystem writing under the same managed root also
 * agrees to (F1-28). A real path never belongs in this repository, so
 * there is no default for either setting: a missing one is a hard error
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
  if (!isAbsolute(root) || resolve(root) !== root) {
    throw new Error(
      `${RAW_TREE_ROOT_ENV} ${JSON.stringify(root)} is not a usable managed root; ` +
        "point it at an absolute, already-canonical directory (no relative path, no " +
        "trailing separator, no `.` or `..` segment), so where a space namespace lands " +
        "cannot depend on how the root itself is spelled.",
    );
  }
  const spaceId = resolveArchiveSpaceId(env);
  return join(root, "archive", ARCHIVE_LAYOUT_VERSION, spaceId);
}

/** Where `writeRawDocument` puts, and `readCaptureManifest` looks for, the
 * retained bytes with this content hash. */
export function rawDocumentPath(root: string, sha256: string): string {
  return fanoutPath(root, "documents", sha256, "");
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
