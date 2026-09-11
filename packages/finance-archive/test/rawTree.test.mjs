// The raw tree writer (F1-18): persisting acquired bytes and retained text
// to a configured local directory, write-once, hash-verified on write and on
// read back. Acquisition provenance -- the self-describing manifest -- moved
// to captures.ts (F1-24, see captures.test.mjs); this suite covers byte
// identity only, plus persistAcquiredDocument's end-to-end wiring of both.
// No real path, institution, account or document content appears in this
// suite; every fixture directory is a temp dir removed on teardown.

import assert from "node:assert/strict";
import {
  existsSync,
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
  ARCHIVE_LAYOUT_VERSION,
  persistAcquiredDocument,
  readAndVerify,
  readCaptureManifest,
  resolveArchiveSpaceId,
  resolveRawTreeRoot,
  retainPayload,
  sha256HexOf,
  writeRawDocument,
  writeRetainedText,
} from "../dist/index.js";

const INSTITUTION = {
  id: "inst_marrow_creek",
  name: "Marrow Creek Trust (synthetic)",
  slug: "marrow-creek",
};
const ACCOUNT = { id: "acct_synthetic_r1", last4: "0511", currency: "USD" };

// Synthetic space id (F1-28): not a real space, just what exercises the
// shared-root prefix this suite writes and reads through everywhere below.
const SPACE_ID = "space_synthetic_test";

/** A throwaway raw-tree root, removed when the test ends -- the fully
 * resolved `archive/v1/<spaceId>/` root, the same value production code
 * gets back from `resolveRawTreeRoot`, so every test in this file exercises
 * the shared-root prefix rather than a bare directory. */
function rawTreeRoot(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-raw-tree-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return resolveRawTreeRoot({
    FINANCE_ARCHIVE_RAW_TREE_ROOT: directory,
    FINANCE_ARCHIVE_SPACE_ID: SPACE_ID,
  });
}

/** A statement's bytes as the F1-23 projection retains them: a rendered
 * document has no addressable fields, so the declaration is `opaque` and the
 * bytes are retained whole. `writeRawDocument` accepts nothing else. */
const OPAQUE_POLICY = {
  kind: "opaque",
  version: "test-opaque-1",
  note: "synthetic fixture bytes, no addressable fields",
};

function opaque(bytes) {
  return retainPayload(OPAQUE_POLICY, bytes, "pdf_statement");
}

function acquiredFixture(bytes, overrides = {}) {
  const retained = opaque(bytes);
  return {
    bytes: retained.bytes,
    retention: retained.record,
    manifest: {
      kind: "pdf_statement",
      periodStart: "2025-01-01",
      periodEnd: "2025-01-31",
      capturedAt: "2025-02-01T00:00:00.000Z",
      contentHash: retained.sha256,
      reportedRowCount: null,
      gaps: [],
      ...overrides,
    },
  };
}

test("resolveArchiveSpaceId is a hard error naming what is missing when unset, and returns the value when set", () => {
  assert.throws(
    () => resolveArchiveSpaceId({}),
    /FINANCE_ARCHIVE_SPACE_ID is not set/,
  );
  assert.equal(
    resolveArchiveSpaceId({ FINANCE_ARCHIVE_SPACE_ID: "space_synthetic" }),
    "space_synthetic",
  );
});

test("resolveRawTreeRoot is a hard error naming what is missing when either the root or the space id is unset, and otherwise composes the configured root with the archive/v1 prefix and the space id (F1-28)", () => {
  assert.throws(
    () => resolveRawTreeRoot({}),
    /FINANCE_ARCHIVE_RAW_TREE_ROOT is not set/,
  );
  assert.throws(
    () => resolveRawTreeRoot({ FINANCE_ARCHIVE_RAW_TREE_ROOT: "/synthetic/raw-tree" }),
    /FINANCE_ARCHIVE_SPACE_ID is not set/,
    "a configured root does not paper over a missing space id -- no guessed value",
  );
  assert.equal(
    resolveRawTreeRoot({
      FINANCE_ARCHIVE_RAW_TREE_ROOT: "/synthetic/raw-tree",
      FINANCE_ARCHIVE_SPACE_ID: "space_synthetic",
    }),
    join("/synthetic/raw-tree", "archive", ARCHIVE_LAYOUT_VERSION, "space_synthetic"),
  );
});

test("writeRawDocument persists bytes once; a repeat write of identical bytes is a reported no-op, not a rewrite or an error", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic statement bytes, first version");

  const first = writeRawDocument(root, opaque(bytes));
  assert.equal(first.status, "written");
  assert.equal(first.sha256, sha256HexOf(bytes));
  assert.ok(existsSync(first.path));
  assert.deepEqual(readFileSync(first.path), Buffer.from(bytes));

  const second = writeRawDocument(root, opaque(bytes));
  assert.equal(second.status, "already_exists", "re-acquiring identical bytes is a no-op, not an error");
  assert.equal(second.path, first.path);
  assert.deepEqual(readFileSync(second.path), Buffer.from(bytes), "content is unchanged, not rewritten");
});

test("writeRawDocument makes an accidental collision impossible: two different byte strings never land on the same path", (t) => {
  const root = rawTreeRoot(t);
  const a = writeRawDocument(root, opaque(new TextEncoder().encode("synthetic document A")));
  const b = writeRawDocument(root, opaque(new TextEncoder().encode("synthetic document B")));
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.sha256, b.sha256);
});

test("readAndVerify detects a corrupted raw-tree file instead of returning wrong bytes", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic statement bytes, to be corrupted");
  const written = writeRawDocument(root, opaque(bytes));

  // Simulate on-disk corruption directly, bypassing the writer entirely.
  writeFileSync(written.path, "corrupted content, different from what was written");

  assert.throws(
    () => readAndVerify(written.path, written.sha256),
    /raw tree corruption detected/,
  );
});

test("a write-once path that has been corrupted is caught on the next acquisition attempt too", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic statement bytes, corrupted before re-acquisition");
  const written = writeRawDocument(root, opaque(bytes));
  writeFileSync(written.path, "corrupted content");

  // Re-acquiring the same original bytes must not silently treat the
  // corrupted file on disk as an already-written match.
  assert.throws(() => writeRawDocument(root, opaque(bytes)), /raw tree corruption detected/);
});

test("writeRetainedText persists text write-once, in a namespace separate from raw documents", (t) => {
  const root = rawTreeRoot(t);
  const text = "Synthetic retained statement text, extracted before OCR.";

  const first = writeRetainedText(root, text);
  assert.equal(first.status, "written");
  assert.equal(readFileSync(first.path, "utf8"), text);

  const second = writeRetainedText(root, text);
  assert.equal(second.status, "already_exists");
  assert.equal(second.path, first.path);

  assert.ok(!first.path.includes("/documents/"), "text lives outside the documents/ namespace");
});

test("persistAcquiredDocument writes bytes, retained text and a capture manifest together and reports all three paths", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic acquired statement bytes");
  const acquired = acquiredFixture(bytes);
  const descriptor = {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    institutionSlug: INSTITUTION.slug,
    accountLast4: ACCOUNT.last4,
    docType: "pdf_statement",
    acquired,
    originalExtension: ".pdf",
  };

  const persisted = persistAcquiredDocument(root, descriptor, "synthetic retained text layer");
  assert.equal(persisted.documentWrite.status, "written");
  assert.equal(persisted.textWrite.status, "written");
  assert.equal(persisted.captureWrite.status, "written");
  assert.ok(existsSync(persisted.filePath));
  assert.ok(existsSync(persisted.textPath));
  assert.ok(existsSync(persisted.capturePath));
  assert.equal(readFileSync(persisted.textPath, "utf8"), "synthetic retained text layer");

  const manifest = readCaptureManifest(persisted.capturePath);
  assert.equal(manifest.captureId, persisted.captureId);
  assert.equal(manifest.institutionSlug, INSTITUTION.slug);
  assert.equal(manifest.acctLast4, ACCOUNT.last4);
  assert.equal(manifest.originalExtension, ".pdf");

  // Retrying the *same* acquisition attempt (the same captureId) persists
  // nothing new -- an idempotent no-op, not a rewrite.
  const retried = persistAcquiredDocument(
    root,
    { ...descriptor, captureId: persisted.captureId },
    "synthetic retained text layer",
  );
  assert.equal(retried.documentWrite.status, "already_exists");
  assert.equal(retried.textWrite.status, "already_exists");
  assert.equal(retried.captureWrite.status, "already_exists");
  assert.equal(retried.filePath, persisted.filePath);
  assert.equal(retried.capturePath, persisted.capturePath);

  // Acquiring the identical pull *again*, with no captureId supplied, is a
  // second, distinct capture (F1-24): the document's bytes are unchanged and
  // reused, but this capture's own provenance is written and kept, not
  // discarded because the bytes it names already exist.
  const secondCapture = persistAcquiredDocument(root, descriptor, "synthetic retained text layer");
  assert.equal(secondCapture.documentWrite.status, "already_exists", "identical bytes are not rewritten");
  assert.equal(secondCapture.captureWrite.status, "written", "a second capture of the same bytes is its own record");
  assert.notEqual(secondCapture.captureId, persisted.captureId);
  assert.notEqual(secondCapture.capturePath, persisted.capturePath);
  assert.equal(secondCapture.filePath, persisted.filePath, "both captures reference the same document");

  // Both captures are still on disk, independently -- neither overwrote the
  // other.
  assert.deepEqual(readCaptureManifest(persisted.capturePath).documentSha256, persisted.documentWrite.sha256);
  assert.deepEqual(readCaptureManifest(secondCapture.capturePath).documentSha256, persisted.documentWrite.sha256);
});

test("persistAcquiredDocument with no extracted text writes only the document and its capture manifest", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic tabular export bytes");
  const acquired = acquiredFixture(bytes, { kind: "tabular_export" });

  const persisted = persistAcquiredDocument(root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    institutionSlug: INSTITUTION.slug,
    accountLast4: ACCOUNT.last4,
    docType: "tabular_export",
    acquired,
  });
  assert.ok(existsSync(persisted.filePath));
  assert.ok(existsSync(persisted.capturePath));
  assert.equal(persisted.textPath, null);
  assert.equal(persisted.textWrite, null);
  assert.equal(readCaptureManifest(persisted.capturePath).originalExtension, null);
});

test("persistAcquiredDocument refuses a pull whose adapter mis-reported its own content hash", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic bytes with a mismatched manifest hash");
  const acquired = acquiredFixture(bytes, { contentHash: "0".repeat(64) });

  assert.throws(
    () =>
      persistAcquiredDocument(root, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        institutionSlug: INSTITUTION.slug,
        accountLast4: ACCOUNT.last4,
        docType: "pdf_statement",
        acquired,
      }),
    /does not match/,
  );
});

test("persistAcquiredDocument accepts a null account last4: not every account has one on file", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic bytes for an account with no last4 on file");
  const acquired = acquiredFixture(bytes);

  const persisted = persistAcquiredDocument(root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    institutionSlug: INSTITUTION.slug,
    accountLast4: null,
    docType: "pdf_statement",
    acquired,
  });
  assert.equal(readCaptureManifest(persisted.capturePath).acctLast4, null);
});

test("given only the raw tree, with no archive database, every document and every capture can be identified well enough to re-import (F1-24), and this still holds under the shared archive/v1/<spaceId> prefix (F1-28)", (t) => {
  const root = rawTreeRoot(t);
  assert.ok(
    root.endsWith(join("archive", ARCHIVE_LAYOUT_VERSION, SPACE_ID)),
    "the root this test writes and reads through is the shared-root-prefixed one, not a bare directory",
  );

  const statementBytes = new TextEncoder().encode("synthetic PDF statement bytes");
  const statement = acquiredFixture(statementBytes, {
    kind: "pdf_statement",
    periodStart: "2025-03-01",
    periodEnd: "2025-03-31",
    capturedAt: "2025-04-01T12:00:00.000Z",
    gaps: [{ periodStart: "2025-03-15", periodEnd: "2025-03-16", reason: "synthetic outage" }],
  });
  const persistedStatement = persistAcquiredDocument(root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    institutionSlug: INSTITUTION.slug,
    accountLast4: ACCOUNT.last4,
    docType: "pdf_statement",
    acquired: statement,
    originalExtension: ".pdf",
  });
  assert.ok(
    persistedStatement.filePath.includes(join("archive", ARCHIVE_LAYOUT_VERSION, SPACE_ID, "documents")),
    "the document actually lands under the agreed archive/v1/<spaceId>/documents/ path, not directly under the configured root",
  );
  assert.ok(
    persistedStatement.capturePath.includes(join("archive", ARCHIVE_LAYOUT_VERSION, SPACE_ID, "captures")),
    "the capture manifest actually lands under the agreed archive/v1/<spaceId>/captures/ path",
  );

  // A second, later capture of byte-identical statement content -- a
  // re-acquisition after a parser fix, say. Same bytes, different time and
  // its own gaps; this is exactly the case the old content-keyed manifest
  // sidecar silently discarded.
  const restatement = acquiredFixture(statementBytes, {
    kind: "pdf_statement",
    periodStart: "2025-03-01",
    periodEnd: "2025-03-31",
    capturedAt: "2025-06-01T08:00:00.000Z",
    gaps: [],
  });
  const persistedRestatement = persistAcquiredDocument(root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    institutionSlug: INSTITUTION.slug,
    accountLast4: ACCOUNT.last4,
    docType: "pdf_statement",
    acquired: restatement,
    originalExtension: ".pdf",
  });
  assert.equal(persistedRestatement.filePath, persistedStatement.filePath, "same document, one write-once path");
  assert.notEqual(persistedRestatement.captureId, persistedStatement.captureId, "two distinct captures");

  const exportBytes = new TextEncoder().encode("synthetic tabular export bytes, second document");
  const tabularExport = acquiredFixture(exportBytes, {
    kind: "tabular_export",
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    capturedAt: "2025-05-01T09:00:00.000Z",
  });
  persistAcquiredDocument(root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    institutionSlug: INSTITUTION.slug,
    accountLast4: ACCOUNT.last4,
    docType: "tabular_export",
    acquired: tabularExport,
    originalExtension: ".csv",
  });

  // Everything from here on uses only what is sitting in the raw tree
  // directory: persistAcquiredDocument never opened a database to write any
  // of this (F1-33), so there is nothing to simulate losing.
  const captureFiles = readdirSync(join(root, "captures"), { recursive: true })
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(root, "captures", entry));
  assert.equal(captureFiles.length, 3, "one capture manifest per acquisition, not per document");

  const captures = captureFiles.map(readCaptureManifest);
  const statementCaptures = captures.filter((c) => c.docType === "pdf_statement");
  assert.equal(statementCaptures.length, 2, "both captures of the same document are still discoverable from the tree alone");
  assert.deepEqual(
    new Set(statementCaptures.map((c) => c.documentSha256)),
    new Set([sha256HexOf(statementBytes)]),
    "both captures reference the same content-addressed document",
  );
  assert.deepEqual(
    new Set(statementCaptures.map((c) => c.capturedAt)),
    new Set(["2025-04-01T12:00:00.000Z", "2025-06-01T08:00:00.000Z"]),
    "each capture keeps its own time",
  );

  const firstCapture = statementCaptures.find((c) => c.capturedAt === "2025-04-01T12:00:00.000Z");
  assert.equal(firstCapture.institutionSlug, INSTITUTION.slug);
  assert.equal(firstCapture.acctLast4, ACCOUNT.last4);
  assert.equal(firstCapture.periodStart, "2025-03-01");
  assert.equal(firstCapture.periodEnd, "2025-03-31");
  assert.equal(firstCapture.capabilityTier, "pdf_statement");
  assert.deepEqual(firstCapture.gaps, [
    { periodStart: "2025-03-15", periodEnd: "2025-03-16", reason: "synthetic outage" },
  ]);
  assert.equal(firstCapture.originalExtension, ".pdf");

  const secondCapture = statementCaptures.find((c) => c.capturedAt === "2025-06-01T08:00:00.000Z");
  assert.deepEqual(secondCapture.gaps, [], "the second capture keeps its own, different provenance");

  const exportCapture = captures.find((c) => c.docType === "tabular_export");
  assert.equal(exportCapture.institutionSlug, INSTITUTION.slug);
  assert.equal(exportCapture.acctLast4, ACCOUNT.last4);
  assert.equal(exportCapture.capabilityTier, "tabular_export");
  assert.equal(exportCapture.originalExtension, ".csv");

  // The bytes each capture references are still there, still content-
  // addressed by the same hash, and still verify -- nothing here depended
  // on the database that was just closed.
  const bytesOnDisk = readAndVerify(persistedStatement.filePath, firstCapture.documentSha256);
  assert.deepEqual(bytesOnDisk, Buffer.from(statementBytes));
});

// F1-33: the retained-text path used to be recorded with a targeted
// `recordRetainedTextPath` UPDATE against the SQLite provenance file, after
// import. It is gone: `PersistedAcquisition.textPath` now flows straight
// into `ImportDocument.textPath` (importer.ts) on the same insert as the
// rest of a document's provenance, so this suite has nothing left to persist
// after the fact. `writeRetainedText` above already covers the raw-tree
// write; `adapterImport.test.mjs` covers the field reaching Postgres.
