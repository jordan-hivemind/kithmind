// The raw tree writer (F1-18): persisting acquired bytes and retained text
// to a configured local directory, write-once, hash-verified on write and on
// read back. No real path, institution, account or document content appears
// in this suite; every fixture directory is a temp dir removed on teardown.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openArchive,
  persistAcquiredDocument,
  readAndVerify,
  recordRetainedTextPath,
  resolveRawTreeRoot,
  sha256HexOf,
  writeRawDocument,
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

/** A throwaway archive with one document row seeded, for the recordRetainedTextPath tests. */
function archiveWithDocument(t, sha256) {
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
  db.prepare(
    `INSERT INTO documents (id, institution_id, account_id, doc_type, file_path, sha256, parsed_ok)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run("doc_1", INSTITUTION.id, ACCOUNT.id, "pdf_statement", "/irrelevant/path", sha256);
  return db;
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

  const first = writeRawDocument(root, bytes);
  assert.equal(first.status, "written");
  assert.equal(first.sha256, sha256HexOf(bytes));
  assert.ok(existsSync(first.path));
  assert.deepEqual(readFileSync(first.path), Buffer.from(bytes));

  const second = writeRawDocument(root, bytes);
  assert.equal(second.status, "already_exists", "re-acquiring identical bytes is a no-op, not an error");
  assert.equal(second.path, first.path);
  assert.deepEqual(readFileSync(second.path), Buffer.from(bytes), "content is unchanged, not rewritten");
});

test("writeRawDocument makes an accidental collision impossible: two different byte strings never land on the same path", (t) => {
  const root = rawTreeRoot(t);
  const a = writeRawDocument(root, new TextEncoder().encode("synthetic document A"));
  const b = writeRawDocument(root, new TextEncoder().encode("synthetic document B"));
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.sha256, b.sha256);
});

test("readAndVerify detects a corrupted raw-tree file instead of returning wrong bytes", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic statement bytes, to be corrupted");
  const written = writeRawDocument(root, bytes);

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
  const written = writeRawDocument(root, bytes);
  writeFileSync(written.path, "corrupted content");

  // Re-acquiring the same original bytes must not silently treat the
  // corrupted file on disk as an already-written match.
  assert.throws(() => writeRawDocument(root, bytes), /raw tree corruption detected/);
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

test("persistAcquiredDocument writes bytes and retained text together and reports both paths", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic acquired statement bytes");
  const acquired = {
    bytes,
    manifest: {
      kind: "pdf_statement",
      periodStart: "2025-01-01",
      periodEnd: "2025-01-31",
      capturedAt: "2025-02-01T00:00:00.000Z",
      contentHash: sha256HexOf(bytes),
      reportedRowCount: null,
      gaps: [],
    },
  };

  const persisted = persistAcquiredDocument(root, acquired, "synthetic retained text layer");
  assert.equal(persisted.documentWrite.status, "written");
  assert.equal(persisted.textWrite.status, "written");
  assert.ok(existsSync(persisted.filePath));
  assert.ok(existsSync(persisted.textPath));
  assert.equal(readFileSync(persisted.textPath, "utf8"), "synthetic retained text layer");

  // Re-acquiring the identical pull persists nothing new.
  const again = persistAcquiredDocument(root, acquired, "synthetic retained text layer");
  assert.equal(again.documentWrite.status, "already_exists");
  assert.equal(again.textWrite.status, "already_exists");
  assert.equal(again.filePath, persisted.filePath);
});

test("persistAcquiredDocument with no extracted text writes only the document", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic tabular export bytes");
  const acquired = {
    bytes,
    manifest: {
      kind: "tabular_export",
      periodStart: "2025-01-01",
      periodEnd: "2025-01-31",
      capturedAt: "2025-02-01T00:00:00.000Z",
      contentHash: sha256HexOf(bytes),
      reportedRowCount: null,
      gaps: [],
    },
  };

  const persisted = persistAcquiredDocument(root, acquired);
  assert.ok(existsSync(persisted.filePath));
  assert.equal(persisted.textPath, null);
  assert.equal(persisted.textWrite, null);
});

test("persistAcquiredDocument refuses a pull whose adapter mis-reported its own content hash", (t) => {
  const root = rawTreeRoot(t);
  const bytes = new TextEncoder().encode("synthetic bytes with a mismatched manifest hash");
  const acquired = {
    bytes,
    manifest: {
      kind: "pdf_statement",
      periodStart: "2025-01-01",
      periodEnd: "2025-01-31",
      capturedAt: "2025-02-01T00:00:00.000Z",
      contentHash: "0".repeat(64),
      reportedRowCount: null,
      gaps: [],
    },
  };

  assert.throws(
    () => persistAcquiredDocument(root, acquired),
    /does not match/,
  );
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
