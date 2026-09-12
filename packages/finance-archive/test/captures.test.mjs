// F1-24: captures.ts in isolation. persistAcquiredDocument's end-to-end
// wiring of this module lives in rawTree.test.mjs and retention.test.mjs;
// this file exercises writeCaptureManifest/readCaptureManifest/
// CaptureConflictError directly, with no archive database and no adapter.
// F1-34 adds the path-segment, cross-partition identity and verified-read
// cases. No real path, institution, account or document content appears in
// this suite; every fixture directory is a temp dir removed on teardown.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CAPTURE_MANIFEST_VERSION,
  CaptureConflictError,
  CaptureIntegrityError,
  readCaptureManifest,
  resolveRawTreeRoot,
  retainPayload,
  sha256HexOf,
  writeCaptureManifest,
  writeRawDocument,
} from "../dist/index.js";

// Synthetic space id (F1-28): not a real space, just what exercises the
// shared-root prefix this suite writes and reads through.
const SPACE_ID = "space_synthetic_test";
// Synthetic opaque source id (F1-34): shaped like the `institutions.id` the
// capture manifest partitions on, which is never a human-readable slug.
const SOURCE_ID = "inst_synthetic_a";

const OPAQUE_POLICY = {
  kind: "opaque",
  version: "test-opaque-1",
  note: "synthetic fixture, no addressable fields",
};
const DOCUMENT_BYTES = new TextEncoder().encode("synthetic captured document bytes");
const DOCUMENT_SHA256 = sha256HexOf(DOCUMENT_BYTES);

/** A throwaway raw-tree root with the one document every fixture manifest
 * cites already written, removed when the test ends -- the fully resolved
 * `archive/v1/<spaceId>/` root, matching what production code gets back from
 * `resolveRawTreeRoot`. `readCaptureManifest` verifies the retained object a
 * capture names, so a capture with no document behind it is not a valid
 * fixture. */
function rawTreeRoot(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-captures-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = resolveRawTreeRoot({
    FINANCE_ARCHIVE_RAW_TREE_ROOT: directory,
    FINANCE_ARCHIVE_SPACE_ID: SPACE_ID,
  });
  writeRawDocument(root, retainPayload(OPAQUE_POLICY, DOCUMENT_BYTES, "pdf_statement"));
  return root;
}

const RETENTION = {
  policy: OPAQUE_POLICY,
  projectionVersion: "1",
  droppedPaths: [],
};

function manifest(overrides = {}) {
  return {
    version: CAPTURE_MANIFEST_VERSION,
    captureId: "capture-a",
    sourceId: SOURCE_ID,
    documentSha256: DOCUMENT_SHA256,
    institutionSlug: "marrow-creek",
    acctLast4: "0511",
    docType: "pdf_statement",
    periodStart: "2025-01-01",
    periodEnd: "2025-01-31",
    capturedAt: "2025-02-01T00:00:00.000Z",
    capabilityTier: "pdf_statement",
    gaps: [],
    originalExtension: ".pdf",
    retention: RETENTION,
    ...overrides,
  };
}

test("writeCaptureManifest writes once and reports a repeat of the same capture as a no-op, not a rewrite", (t) => {
  const root = rawTreeRoot(t);
  const m = manifest();

  const first = writeCaptureManifest(root, m);
  assert.equal(first.status, "written");
  assert.ok(existsSync(first.path));
  assert.deepEqual(readCaptureManifest(first.path), m);

  const second = writeCaptureManifest(root, m);
  assert.equal(second.status, "already_exists");
  assert.equal(second.path, first.path);
  assert.equal(second.manifestSha256, first.manifestSha256);
});

test("two different capture ids for byte-identical document content each keep their own manifest", (t) => {
  const root = rawTreeRoot(t);
  const first = writeCaptureManifest(root, manifest({ captureId: "capture-a", capturedAt: "2025-02-01T00:00:00.000Z" }));
  const second = writeCaptureManifest(
    root,
    manifest({ captureId: "capture-b", capturedAt: "2025-05-01T00:00:00.000Z" }),
  );

  assert.notEqual(first.path, second.path);
  assert.equal(readCaptureManifest(first.path).documentSha256, readCaptureManifest(second.path).documentSha256);
  assert.equal(readCaptureManifest(first.path).captureId, "capture-a");
  assert.equal(readCaptureManifest(second.path).captureId, "capture-b");
});

test("reusing a capture id for conflicting content is an explicit error, never a silent overwrite", (t) => {
  const root = rawTreeRoot(t);
  const first = writeCaptureManifest(root, manifest({ captureId: "capture-a" }));

  assert.throws(
    () => writeCaptureManifest(root, manifest({ captureId: "capture-a", docType: "trade_confirmation" })),
    CaptureConflictError,
  );

  // The original capture is untouched.
  assert.deepEqual(readCaptureManifest(first.path).docType, "pdf_statement");
  const filesForCaptureA = readdirSync(join(root, "captures", SOURCE_ID, "2025", "02")).filter((f) =>
    f.startsWith("capture-a-"),
  );
  assert.equal(filesForCaptureA.length, 1, "the conflicting attempt never landed a second file");
});

test("a capture id is unique across the whole captures namespace, not within one partition (F1-34)", (t) => {
  const root = rawTreeRoot(t);
  const first = writeCaptureManifest(root, manifest({ captureId: "capture-a" }));

  // Same id, a different capture month: a different partition, so the old
  // single-directory scan never saw the first record and wrote a second one.
  assert.throws(
    () => writeCaptureManifest(root, manifest({ captureId: "capture-a", capturedAt: "2025-09-01T00:00:00.000Z" })),
    CaptureConflictError,
    "reuse in another month is still reuse",
  );
  // Same id, a different source: likewise a different partition.
  assert.throws(
    () => writeCaptureManifest(root, manifest({ captureId: "capture-a", sourceId: "inst_synthetic_b" })),
    CaptureConflictError,
    "reuse under another source is still reuse",
  );

  const written = readdirSync(join(root, "captures"), { recursive: true }).filter((entry) =>
    entry.endsWith(".json"),
  );
  assert.deepEqual(written.length, 1, "neither conflicting attempt landed a record anywhere");
  assert.equal(readCaptureManifest(first.path).capturedAt, "2025-02-01T00:00:00.000Z");
});

test("a path segment that could traverse out of the space is refused before anything is written (F1-34)", (t) => {
  const root = rawTreeRoot(t);
  for (const escape of ["../../backups", "../../../outside", "a/b", "..", ""]) {
    assert.throws(
      () => writeCaptureManifest(root, manifest({ sourceId: escape })),
      /not a usable raw-tree path segment/,
      `source id ${JSON.stringify(escape)} must never become a path`,
    );
    assert.throws(
      () => writeCaptureManifest(root, manifest({ captureId: escape })),
      /not a usable raw-tree path segment/,
      `capture id ${JSON.stringify(escape)} must never become a path`,
    );
  }
  assert.ok(
    !existsSync(join(root, "captures")),
    "a refused segment never even creates a directory",
  );
});

test("captures are laid out by opaque source id and by year/month of capturedAt, discoverable by a plain directory walk", (t) => {
  const root = rawTreeRoot(t);
  const written = writeCaptureManifest(
    root,
    manifest({ sourceId: "inst_synthetic_b", capturedAt: "2025-07-15T10:30:00.000Z" }),
  );
  assert.ok(written.path.startsWith(join(root, "captures", "inst_synthetic_b", "2025", "07")));

  const found = readdirSync(root, { recursive: true }).filter((entry) => entry.endsWith(".json"));
  assert.equal(found.length, 1);
});

test("readCaptureManifest round-trips gaps and the retention record intact", (t) => {
  const root = rawTreeRoot(t);
  const m = manifest({
    gaps: [{ periodStart: "2025-01-10", periodEnd: "2025-01-12", reason: "synthetic outage" }],
    retention: {
      policy: { kind: "json_allowlist", version: "v1", fields: ["amount"] },
      projectionVersion: "1",
      droppedPaths: ["sessionToken"],
    },
  });
  const written = writeCaptureManifest(root, m);
  const read = readCaptureManifest(written.path);
  assert.deepEqual(read.gaps, m.gaps);
  assert.deepEqual(read.retention, m.retention);
});

test("readCaptureManifest rejects a capture edited in place: the file name states its hash (F1-34)", (t) => {
  const root = rawTreeRoot(t);
  const written = writeCaptureManifest(root, manifest());

  const tampered = JSON.parse(readFileSync(written.path, "utf8"));
  tampered.periodEnd = "2025-02-28";
  writeFileSync(written.path, JSON.stringify(tampered, null, 2));

  assert.throws(
    () => readCaptureManifest(written.path),
    (error) => error instanceof CaptureIntegrityError && error.reason === "manifest_hash",
    "modified provenance must never be read back as fact",
  );
});

test("F1-71: a capture may record the provider's own document id, and a capture written before that field existed still reads", (t) => {
  const root = rawTreeRoot(t);

  const withId = manifest({ captureId: "capture-pid", providerDocumentId: "MS-000123" });
  const written = writeCaptureManifest(root, withId);
  assert.deepEqual(readCaptureManifest(written.path), withId);

  // The whole reason this field is optional rather than a version bump:
  // every capture already on a live raw tree omits it, and refusing those
  // would refuse the archive's entire acquisition history.
  const without = manifest({ captureId: "capture-no-pid" });
  assert.equal("providerDocumentId" in without, false);
  const legacy = writeCaptureManifest(root, without);
  assert.deepEqual(readCaptureManifest(legacy.path), without);

  // Still closed: the field is bounded text, not anything at all.
  const dir = join(root, "captures", SOURCE_ID, "2025", "02");
  const record = { ...manifest({ captureId: "capture-bad-pid" }), providerDocumentId: 17 };
  const bytes = Buffer.from(JSON.stringify(record, null, 2), "utf8");
  const path = join(dir, `capture-bad-pid-${sha256HexOf(bytes)}.json`);
  writeFileSync(path, bytes);
  assert.throws(
    () => readCaptureManifest(path),
    (error) => error instanceof CaptureIntegrityError && error.reason === "schema",
  );
});

test("readCaptureManifest rejects a record that is not this closed, versioned schema (F1-34)", (t) => {
  const root = rawTreeRoot(t);
  const dir = join(root, "captures", SOURCE_ID, "2025", "02");
  writeCaptureManifest(root, manifest());

  // Each of these is written under its own real content hash, so only the
  // schema check can catch it.
  const rejected = [
    { ...manifest(), version: 99 },
    { ...manifest(), documentSha256: "not-a-hash" },
    { ...manifest(), acctLast4: "0511-and-more" },
    { ...manifest(), somethingExtra: "unbounded field" },
  ];
  for (const record of rejected) {
    const bytes = Buffer.from(JSON.stringify(record, null, 2), "utf8");
    const path = join(dir, `capture-z-${sha256HexOf(bytes)}.json`);
    writeFileSync(path, bytes);
    assert.throws(
      () => readCaptureManifest(path),
      (error) => error instanceof CaptureIntegrityError && error.reason === "schema",
      `${JSON.stringify(record).slice(0, 60)} must not parse as a capture`,
    );
    rmSync(path);
  }

  // And a capture filed under a source it does not record.
  const record = manifest({ captureId: "capture-y" });
  const bytes = Buffer.from(JSON.stringify(record, null, 2), "utf8");
  const wrongPartition = join(root, "captures", "inst_synthetic_b", "2025", "02");
  mkdirSync(wrongPartition, { recursive: true });
  const path = join(wrongPartition, `capture-y-${sha256HexOf(bytes)}.json`);
  writeFileSync(path, bytes);
  assert.throws(
    () => readCaptureManifest(path),
    (error) => error instanceof CaptureIntegrityError && error.reason === "partition",
  );
});

test("readCaptureManifest rejects a capture whose retained object is gone or altered (F1-34)", (t) => {
  const root = rawTreeRoot(t);

  const dangling = writeCaptureManifest(
    root,
    manifest({ captureId: "capture-dangling", documentSha256: "b".repeat(64) }),
  );
  assert.throws(
    () => readCaptureManifest(dangling.path),
    (error) => error instanceof CaptureIntegrityError && error.reason === "missing_document",
  );

  const written = writeCaptureManifest(root, manifest());
  const documentPath = join(
    root,
    "documents",
    DOCUMENT_SHA256.slice(0, 2),
    DOCUMENT_SHA256.slice(2, 4),
    DOCUMENT_SHA256,
  );
  writeFileSync(documentPath, "different bytes than the capture vouches for");
  assert.throws(
    () => readCaptureManifest(written.path),
    (error) => error instanceof CaptureIntegrityError && error.reason === "document_hash",
  );
});
