// The raw tree writer (F1-18): persisting acquired bytes, retained text and
// a self-describing manifest to a configured local directory, write-once,
// hash-verified on write and on read back. No real path, institution,
// account or document content appears in this suite; every fixture
// directory is a temp dir removed on teardown.

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
  openArchive,
  persistAcquiredDocument,
  readAndVerify,
  readRawDocumentManifest,
  recordRetainedTextPath,
  resolveRawTreeRoot,
  retainPayload,
  sha256HexOf,
  writeRawDocument,
  writeRawDocumentManifest,
  writeRetainedText,
} from "../dist/index.js";
import { getEvidence } from "../dist/mcp/evidence.js";

const INSTITUTION = {
  id: "inst_marrow_creek",
  name: "Marrow Creek Trust (synthetic)",
  slug: "marrow-creek",
};
const ACCOUNT = { id: "acct_synthetic_r1", last4: "0511", currency: "USD" };

/** A throwaway raw-tree root, removed when the test ends. */
function rawTreeRoot(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-raw-tree-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A throwaway archive with one institution and one account seeded --
 * exactly what `persistAcquiredDocument` requires to resolve a manifest's
 * institution slug and account last4. */
function archiveWithSeed(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-raw-tree-db-"));
  const db = openArchive(join(directory, "archive.db"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)").run(
    INSTITUTION.id,
    INSTITUTION.name,
    INSTITUTION.slug,
  );
  db.prepare(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ACCOUNT.id, INSTITUTION.id, ACCOUNT.last4, "Synthetic account", ACCOUNT.currency);
  return db;
}

/** A throwaway archive with one institution, one account and one document
 * row seeded, for the recordRetainedTextPath tests. */
function archiveWithDocument(t, sha256) {
  const db = archiveWithSeed(t);
  db.prepare(
    `INSERT INTO documents (id, institution_id, account_id, doc_type, file_path, sha256, parsed_ok)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run("doc_1", INSTITUTION.id, ACCOUNT.id, "pdf_statement", "/irrelevant/path", sha256);
  return db;
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

test("resolveRawTreeRoot is a hard error naming what is missing when unset, and returns the value when set", () => {
  assert.throws(
    () => resolveRawTreeRoot({}),
    /FINANCE_ARCHIVE_RAW_TREE_ROOT is not set/,
  );
  assert.equal(
    resolveRawTreeRoot({ FINANCE_ARCHIVE_RAW_TREE_ROOT: "/synthetic/raw-tree" }),
    "/synthetic/raw-tree",
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

test("writeRawDocumentManifest is write-once: a second write for the same document is a no-op, not a rewrite", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic manifest write-once fixture");
  const sha256 = sha256HexOf(bytes);
  const manifest = {
    sha256,
    institutionSlug: "synthetic-institution",
    acctLast4: "1234",
    docType: "pdf_statement",
    periodStart: "2025-01-01",
    periodEnd: "2025-01-31",
    capturedAt: "2025-02-01T00:00:00.000Z",
    capabilityTier: "pdf_statement",
    gaps: [],
    originalExtension: ".pdf",
    retention: { policy: OPAQUE_POLICY, projectionVersion: "1", droppedPaths: [] },
  };

  const first = writeRawDocumentManifest(root, manifest);
  assert.equal(first.status, "written");
  assert.deepEqual(readRawDocumentManifest(first.path), manifest);

  // A second write attempt, even with different content for the same
  // document, does not overwrite: ground rule 1 covers what was acquired,
  // and the manifest is part of what was acquired.
  const second = writeRawDocumentManifest(root, { ...manifest, docType: "trade_confirmation" });
  assert.equal(second.status, "already_exists");
  assert.equal(second.path, first.path);
  assert.equal(readRawDocumentManifest(second.path).docType, "pdf_statement", "first write wins, never edited");

  assert.ok(first.path.startsWith(join(root, "documents")), "colocated with the raw bytes it describes");
  assert.ok(first.path.endsWith(".manifest.json"));
});

test("persistAcquiredDocument writes bytes, retained text and a manifest together and reports all three paths", (t) => {
  const root = rawTreeRoot(t);
  const db = archiveWithSeed(t);
  const bytes = new TextEncoder().encode("synthetic acquired statement bytes");
  const acquired = acquiredFixture(bytes);
  const descriptor = {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "pdf_statement",
    acquired,
    originalExtension: ".pdf",
  };

  const persisted = persistAcquiredDocument(db, root, descriptor, "synthetic retained text layer");
  assert.equal(persisted.documentWrite.status, "written");
  assert.equal(persisted.textWrite.status, "written");
  assert.equal(persisted.manifestWrite.status, "written");
  assert.ok(existsSync(persisted.filePath));
  assert.ok(existsSync(persisted.textPath));
  assert.ok(existsSync(persisted.manifestPath));
  assert.equal(readFileSync(persisted.textPath, "utf8"), "synthetic retained text layer");

  const manifest = readRawDocumentManifest(persisted.manifestPath);
  assert.equal(manifest.institutionSlug, INSTITUTION.slug);
  assert.equal(manifest.acctLast4, ACCOUNT.last4);
  assert.equal(manifest.originalExtension, ".pdf");

  // Re-acquiring the identical pull persists nothing new.
  const again = persistAcquiredDocument(db, root, descriptor, "synthetic retained text layer");
  assert.equal(again.documentWrite.status, "already_exists");
  assert.equal(again.textWrite.status, "already_exists");
  assert.equal(again.manifestWrite.status, "already_exists");
  assert.equal(again.filePath, persisted.filePath);
});

test("persistAcquiredDocument with no extracted text writes only the document and its manifest", (t) => {
  const root = rawTreeRoot(t);
  const db = archiveWithSeed(t);
  const bytes = new TextEncoder().encode("synthetic tabular export bytes");
  const acquired = acquiredFixture(bytes, { kind: "tabular_export" });

  const persisted = persistAcquiredDocument(db, root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "tabular_export",
    acquired,
  });
  assert.ok(existsSync(persisted.filePath));
  assert.ok(existsSync(persisted.manifestPath));
  assert.equal(persisted.textPath, null);
  assert.equal(persisted.textWrite, null);
  assert.equal(readRawDocumentManifest(persisted.manifestPath).originalExtension, null);
});

test("persistAcquiredDocument refuses a pull whose adapter mis-reported its own content hash", (t) => {
  const root = rawTreeRoot(t);
  const db = archiveWithSeed(t);
  const bytes = new TextEncoder().encode("synthetic bytes with a mismatched manifest hash");
  const acquired = acquiredFixture(bytes, { contentHash: "0".repeat(64) });

  assert.throws(
    () =>
      persistAcquiredDocument(db, root, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        docType: "pdf_statement",
        acquired,
      }),
    /does not match/,
  );
});

test("persistAcquiredDocument requires the institution and account to already be provisioned", (t) => {
  const root = rawTreeRoot(t);
  const db = archiveWithSeed(t);
  const bytes = new TextEncoder().encode("synthetic bytes for an unprovisioned institution or account");
  const acquired = acquiredFixture(bytes);

  assert.throws(
    () =>
      persistAcquiredDocument(db, root, {
        institutionId: "inst_never_provisioned",
        accountId: ACCOUNT.id,
        docType: "pdf_statement",
        acquired,
      }),
    /no institutions row/,
  );
  assert.throws(
    () =>
      persistAcquiredDocument(db, root, {
        institutionId: INSTITUTION.id,
        accountId: "acct_never_provisioned",
        docType: "pdf_statement",
        acquired,
      }),
    /no accounts row/,
  );
});

test("given only the raw tree, with no archive database, every document can be identified well enough to re-import", (t) => {
  const root = rawTreeRoot(t);
  const db = archiveWithSeed(t);

  const statementBytes = new TextEncoder().encode("synthetic PDF statement bytes");
  const statement = acquiredFixture(statementBytes, {
    kind: "pdf_statement",
    periodStart: "2025-03-01",
    periodEnd: "2025-03-31",
    capturedAt: "2025-04-01T12:00:00.000Z",
    gaps: [{ periodStart: "2025-03-15", periodEnd: "2025-03-16", reason: "synthetic outage" }],
  });
  const persistedStatement = persistAcquiredDocument(db, root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "pdf_statement",
    acquired: statement,
    originalExtension: ".pdf",
  });

  const exportBytes = new TextEncoder().encode("synthetic tabular export bytes, second document");
  const tabularExport = acquiredFixture(exportBytes, {
    kind: "tabular_export",
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    capturedAt: "2025-05-01T09:00:00.000Z",
  });
  persistAcquiredDocument(db, root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "tabular_export",
    acquired: tabularExport,
    originalExtension: ".csv",
  });

  // Simulate total loss of the archive database: everything from here on
  // uses only what is sitting in the raw tree directory, never `db` again
  // (teardown closes it once, as usual, when this test ends).
  const manifestFiles = readdirSync(root, { recursive: true })
    .filter((entry) => entry.endsWith(".manifest.json"))
    .map((entry) => join(root, entry));
  assert.equal(manifestFiles.length, 2, "one manifest sidecar per acquired document");

  const manifests = manifestFiles.map(readRawDocumentManifest);
  const byDocType = Object.fromEntries(manifests.map((m) => [m.docType, m]));

  assert.equal(byDocType.pdf_statement.sha256, sha256HexOf(statementBytes));
  assert.equal(byDocType.pdf_statement.institutionSlug, INSTITUTION.slug);
  assert.equal(byDocType.pdf_statement.acctLast4, ACCOUNT.last4);
  assert.equal(byDocType.pdf_statement.periodStart, "2025-03-01");
  assert.equal(byDocType.pdf_statement.periodEnd, "2025-03-31");
  assert.equal(byDocType.pdf_statement.capturedAt, "2025-04-01T12:00:00.000Z");
  assert.equal(byDocType.pdf_statement.capabilityTier, "pdf_statement");
  assert.deepEqual(byDocType.pdf_statement.gaps, [
    { periodStart: "2025-03-15", periodEnd: "2025-03-16", reason: "synthetic outage" },
  ]);
  assert.equal(byDocType.pdf_statement.originalExtension, ".pdf");

  assert.equal(byDocType.tabular_export.institutionSlug, INSTITUTION.slug);
  assert.equal(byDocType.tabular_export.acctLast4, ACCOUNT.last4);
  assert.equal(byDocType.tabular_export.capabilityTier, "tabular_export");
  assert.equal(byDocType.tabular_export.originalExtension, ".csv");

  // The bytes each manifest describes are still there, still content-
  // addressed by the same hash, and still verify -- nothing here depended
  // on the database that was just closed.
  const bytesOnDisk = readAndVerify(persistedStatement.filePath, byDocType.pdf_statement.sha256);
  assert.deepEqual(bytesOnDisk, Buffer.from(statementBytes));
});

test("recordRetainedTextPath sets documents.text_path, and get_evidence can then return it", (t) => {
  const root = rawTreeRoot(t);
  const text = "Synthetic statement text an assistant can cite.";
  const textWrite = writeRetainedText(root, text);
  const sha256 = "a".repeat(64);
  const db = archiveWithDocument(t, sha256);

  recordRetainedTextPath(db, sha256, textWrite.path);

  const row = db.prepare("SELECT text_path FROM documents WHERE id = ?").get("doc_1");
  assert.equal(row.text_path, textWrite.path);
  assert.ok(existsSync(row.text_path));
  assert.equal(readFileSync(row.text_path, "utf8"), text);

  // The same path get_evidence hands back for a row citing this document.
  db.prepare(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, currency, source_document_id,
        row_hash, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "txn_1",
    ACCOUNT.id,
    "2025-01-15",
    "fee",
    ACCOUNT.currency,
    "doc_1",
    "synthetic-row-hash-1",
    "2025-02-01T00:00:00.000Z",
  );
  const evidence = getEvidence(db, "transactions", "txn_1");
  assert.equal(evidence.found, true);
  assert.equal(evidence.document.textPath, textWrite.path);
  assert.ok(existsSync(evidence.document.textPath), "get_evidence returns a path that actually exists");
});

test("recordRetainedTextPath fails loudly rather than silently no-op'ing when no document matches", (t) => {
  const db = archiveWithDocument(t, "b".repeat(64));
  assert.throws(
    () => recordRetainedTextPath(db, "c".repeat(64), "/synthetic/text/path.txt"),
    /no documents row/,
  );
});
