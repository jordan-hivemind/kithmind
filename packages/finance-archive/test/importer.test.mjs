import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { importBatch, openArchive } from "../dist/index.js";

// Synthetic institution and accounts. No real institution, account, balance
// or file path appears anywhere in this suite.
const INSTITUTION = {
  id: "inst_river_bend",
  name: "River Bend Trust",
  slug: "river-bend",
};
const ACCOUNT = { id: "acct_alpha", last4: "0199", currency: "USD" };
const OTHER_ACCOUNT = { id: "acct_beta", last4: "0288", currency: "USD" };

/** Opens a throwaway archive in a temp dir and removes it when the test ends. */
function archive(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-importer-"));
  const db = openArchive(join(directory, "archive.db"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function seed(db) {
  db.prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)").run(
    INSTITUTION.id,
    INSTITUTION.name,
    INSTITUTION.slug,
  );
  for (const account of [ACCOUNT, OTHER_ACCOUNT]) {
    db.prepare(
      `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      account.id,
      INSTITUTION.id,
      account.last4,
      "Synthetic account",
      account.currency,
    );
  }
}

/** A minimal, valid row. Tests override only the fields they care about. */
function row(overrides = {}) {
  return {
    accountId: ACCOUNT.id,
    tradeDate: null,
    processDate: "2026-03-15",
    settleDate: null,
    datePrecision: "day",
    activityType: "debit",
    description: "Synthetic grocery purchase",
    instrumentId: null,
    quantity: null,
    price: null,
    amountText: "-42.10",
    currency: "USD",
    runningBalance: null,
    sourceLocator: "row:1",
    providerTxnId: null,
    ...overrides,
  };
}

/** A document wrapping the given rows, with a matching providerReportedCount. */
function document(sha256, rows, overrides = {}) {
  return {
    sha256,
    filePath: `synthetic/${sha256}.json`,
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "activity_pull",
    docDate: "2026-03-31",
    providerReportedCount: rows.length,
    rows,
    ...overrides,
  };
}

const NOW = new Date("2026-04-01T00:00:00.000Z");

test("repeated import of the same raw tree inserts nothing new", (t) => {
  const db = archive(t);
  seed(db);
  const rows = [
    row({ sourceLocator: "row:1", providerTxnId: "ptx-1" }),
    row({
      sourceLocator: "row:2",
      providerTxnId: "ptx-2",
      description: "Synthetic transit fare",
      amountText: "-3.25",
    }),
  ];
  const batch = { source: "synthetic-pull", documents: [document("a".repeat(64), rows)] };

  const first = importBatch(db, batch, NOW);
  assert.equal(first.rowsInserted, 2);
  assert.equal(first.rowsSkipped, 0);

  const second = importBatch(db, batch, NOW);
  assert.equal(second.rowsInserted, 0);
  assert.equal(second.rowsSkipped, 2);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
    2,
  );
});

test("overlapping paginated pages deduplicate via the stable provider id", (t) => {
  const db = archive(t);
  seed(db);
  const shared = row({
    sourceLocator: "page:1,row:9",
    providerTxnId: "ptx-shared",
    description: "Synthetic subscription charge",
    amountText: "-9.99",
  });
  const page1 = document("b".repeat(64), [
    row({ sourceLocator: "page:1,row:1", providerTxnId: "ptx-a", amountText: "-10.00" }),
    shared,
  ]);
  // Page 2 overlaps page 1 by one row, as a paginated activity API normally
  // does: the same transaction, same provider id, different locator.
  const page2 = document("c".repeat(64), [
    { ...shared, sourceLocator: "page:2,row:1" },
    row({ sourceLocator: "page:2,row:2", providerTxnId: "ptx-b", amountText: "-20.00" }),
  ]);

  const summary = importBatch(
    db,
    { source: "synthetic-pull", documents: [page1, page2] },
    NOW,
  );

  assert.equal(summary.rowsInserted, 3);
  assert.equal(summary.rowsSkipped, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
    3,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE provider_txn_id = ?")
      .get("ptx-shared").n,
    1,
  );
});

test("a provider-reported total that does not match the pull fails loudly", (t) => {
  const db = archive(t);
  seed(db);
  const rows = [row({ providerTxnId: "ptx-1" }), row({ providerTxnId: "ptx-2", sourceLocator: "row:2" })];
  const batch = {
    source: "synthetic-pull",
    documents: [document("d".repeat(64), rows, { providerReportedCount: 3 })],
  };

  assert.throws(() => importBatch(db, batch, NOW), /reported 3 rows/);
  // The whole run rolled back: nothing was absorbed silently.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM import_runs").get().n,
    0,
  );
});

test("an amount too precise for its currency enters the review queue, never a rounded guess", (t) => {
  const db = archive(t);
  seed(db);
  const rows = [row({ providerTxnId: "ptx-1", amountText: "12.345" })];
  const summary = importBatch(
    db,
    { source: "synthetic-pull", documents: [document("e".repeat(64), rows)] },
    NOW,
  );

  assert.equal(summary.rowsInserted, 1);
  assert.equal(summary.reviewItemsOpened, 1);

  const statement = db.prepare(
    "SELECT amount, status FROM transactions WHERE provider_txn_id = 'ptx-1'",
  );
  statement.setReadBigInts(true);
  const stored = statement.get();
  assert.equal(stored.amount, null);
  assert.equal(stored.status, "review");

  const review = db.prepare("SELECT kind, raw_value, status FROM review_items").get();
  assert.equal(review.kind, "ambiguous_amount");
  assert.equal(review.raw_value, "12.345");
  assert.equal(review.status, "open");
});

test("a future date and an implausible date open a review item without blocking the transaction", (t) => {
  const db = archive(t);
  seed(db);
  const rows = [
    row({ providerTxnId: "ptx-future", processDate: "2099-01-01" }),
    row({
      providerTxnId: "ptx-old",
      sourceLocator: "row:2",
      processDate: "1850-01-01",
    }),
  ];
  const summary = importBatch(
    db,
    { source: "synthetic-pull", documents: [document("f".repeat(64), rows)] },
    NOW,
  );

  assert.equal(summary.rowsInserted, 2);
  assert.equal(summary.reviewItemsOpened, 2);
  const kinds = db
    .prepare("SELECT kind FROM review_items ORDER BY kind")
    .all()
    .map((r) => r.kind);
  assert.deepEqual(kinds, ["future_date", "implausible_date"]);
});

test("a row with no parseable process date opens a review item and is not inserted", (t) => {
  const db = archive(t);
  seed(db);
  const rows = [row({ providerTxnId: "ptx-1", processDate: "not-a-date" })];
  const summary = importBatch(
    db,
    { source: "synthetic-pull", documents: [document("0".repeat(64), rows)] },
    NOW,
  );

  assert.equal(summary.rowsInserted, 0);
  assert.equal(summary.rowsSkipped, 1);
  assert.equal(summary.reviewItemsOpened, 1);
  assert.equal(
    db.prepare("SELECT kind FROM review_items").get().kind,
    "unparseable_process_date",
  );
});

test("equal date, amount and description is not proof of duplication: distinct provider ids are both kept", (t) => {
  const db = archive(t);
  seed(db);
  const rows = [
    row({
      providerTxnId: "ptx-coffee-1",
      sourceLocator: "row:1",
      description: "Synthetic coffee shop",
      amountText: "-4.50",
    }),
    row({
      providerTxnId: "ptx-coffee-2",
      sourceLocator: "row:2",
      description: "Synthetic coffee shop",
      amountText: "-4.50",
    }),
  ];
  const summary = importBatch(
    db,
    { source: "synthetic-pull", documents: [document("1".repeat(64), rows)] },
    NOW,
  );

  assert.equal(summary.rowsInserted, 2);
  const stored = db
    .prepare("SELECT row_hash, provider_txn_id FROM transactions ORDER BY provider_txn_id")
    .all();
  assert.equal(stored.length, 2);
  // Both rows share the same content, but they are the first and second
  // occurrence of that content within this one document, so the occurrence
  // ordinal hashed into row_hash differs and so do the stored values. Each
  // is a plain sha256 hex digest; nothing is appended after the fact.
  assert.notEqual(stored[0].row_hash, stored[1].row_hash);
  for (const s of stored) assert.match(s.row_hash, /^[0-9a-f]{64}$/);
});

test("equal date, amount and description without a provider id: both distinct rows are preserved, not merged", (t) => {
  const db = archive(t);
  seed(db);
  // No provider id at all, as from a hand-transcribed PDF statement: two
  // genuinely separate $12 tolls on the same day, worded identically. A
  // hash-only dedupe would silently destroy one of these.
  const rows = [
    row({
      sourceLocator: "page:1,row:4",
      description: "Synthetic toll charge",
      amountText: "-12.00",
    }),
    row({
      sourceLocator: "page:1,row:9",
      description: "Synthetic toll charge",
      amountText: "-12.00",
    }),
  ];
  const summary = importBatch(
    db,
    { source: "synthetic-pdf", documents: [document("2".repeat(64), rows)] },
    NOW,
  );

  assert.equal(summary.rowsInserted, 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
    2,
  );
  const hashes = db
    .prepare("SELECT row_hash FROM transactions ORDER BY row_hash")
    .all()
    .map((r) => r.row_hash);
  assert.notEqual(hashes[0], hashes[1]);
});

test("overlapping paginated pages deduplicate with no provider id at all (regression)", (t) => {
  const db = archive(t);
  seed(db);
  // One logical dividend, no providerTxnId, appearing on two overlapping
  // pages of one pull, as from a tabular export or PDF-derived activity
  // table. A naive import must not double the amount.
  const dividend = row({
    description: "Synthetic dividend",
    amountText: "12.34",
  });
  const page1 = document("5".repeat(64), [
    { ...dividend, sourceLocator: "page:1,row:1" },
  ]);
  const page2 = document("6".repeat(64), [
    { ...dividend, sourceLocator: "page:2,row:1" },
  ]);

  const summary = importBatch(
    db,
    { source: "synthetic-pull", documents: [page1, page2] },
    NOW,
  );

  assert.equal(summary.rowsInserted, 1);
  assert.equal(summary.rowsSkipped, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
    1,
  );
  const statement = db.prepare("SELECT amount FROM transactions");
  statement.setReadBigInts(true);
  assert.equal(statement.get().amount, 1234n);

  // The collapse rests on content evidence across two documents, not a
  // stable id, so it is visible in the review queue, not silent.
  const review = db.prepare("SELECT kind, reason FROM review_items").get();
  assert.equal(review.kind, "cross_document_duplicate");
  assert.match(review.reason, /page:1,row:1/);
});

test("one copy on page 1 and two copies on page 2 resolves on its own: the first dedupes, the second inserts", (t) => {
  const db = archive(t);
  seed(db);
  const toll = row({ description: "Synthetic toll charge", amountText: "-5.00" });
  const page1 = document("7".repeat(64), [
    { ...toll, sourceLocator: "page:1,row:1" },
  ]);
  const page2 = document("8".repeat(64), [
    { ...toll, sourceLocator: "page:2,row:1" },
    { ...toll, sourceLocator: "page:2,row:2" },
  ]);

  const summary = importBatch(
    db,
    { source: "synthetic-pull", documents: [page1, page2] },
    NOW,
  );

  assert.equal(summary.rowsInserted, 2);
  assert.equal(summary.rowsSkipped, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
    2,
  );
});

test("row_hash's occurrence field is required and hashed, not appended", (t) => {
  const rows = [
    row({ sourceLocator: "a", description: "Synthetic dup", amountText: "-1.00" }),
    row({ sourceLocator: "b", description: "Synthetic dup", amountText: "-1.00" }),
  ];
  const db = archive(t);
  seed(db);
  importBatch(
    db,
    { source: "synthetic-pull", documents: [document("9".repeat(64), rows)] },
    NOW,
  );
  const hashes = db
    .prepare("SELECT row_hash FROM transactions ORDER BY source_locator")
    .all()
    .map((r) => r.row_hash);
  // Two plain sha256 digests, neither derived from the other by suffixing.
  for (const hash of hashes) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hashes[0], hashes[1]);
});

test("a malformed trade date opens a review item instead of aborting the batch", (t) => {
  const db = archive(t);
  seed(db);
  const rows = [
    row({ providerTxnId: "ptx-1", tradeDate: "not-a-date" }),
    row({ providerTxnId: "ptx-2", sourceLocator: "row:2" }),
  ];
  const summary = importBatch(
    db,
    { source: "synthetic-pull", documents: [document("a1".padEnd(64, "0"), rows)] },
    NOW,
  );

  assert.equal(summary.rowsInserted, 2);
  assert.equal(summary.reviewItemsOpened, 1);
  const stored = db
    .prepare("SELECT trade_date, status FROM transactions WHERE provider_txn_id = 'ptx-1'")
    .get();
  assert.equal(stored.trade_date, null);
  assert.equal(stored.status, "review");
  assert.equal(
    db.prepare("SELECT kind FROM review_items").get().kind,
    "unparseable_trade_date",
  );
});

test("every run asserts that every transaction resolves to an account", (t) => {
  const db = archive(t);
  seed(db);
  const rows = [row({ accountId: "acct_does_not_exist", providerTxnId: "ptx-1" })];
  assert.throws(
    () =>
      importBatch(
        db,
        { source: "synthetic-pull", documents: [document("3".repeat(64), rows)] },
        NOW,
      ),
    /FOREIGN KEY|foreign key/i,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
    0,
  );
});

test("the import summary never carries row content, only counts", (t) => {
  const db = archive(t);
  seed(db);
  const rows = [row({ providerTxnId: "ptx-1" })];
  const summary = importBatch(
    db,
    { source: "synthetic-pull", documents: [document("4".repeat(64), rows)] },
    NOW,
  );
  assert.deepEqual(Object.keys(summary).sort(), [
    "filesSeen",
    "importRunId",
    "reconciliationsFailed",
    "reconciliationsPassed",
    "reviewItemsOpened",
    "rowsInserted",
    "rowsSkipped",
  ]);
  const runRow = db
    .prepare("SELECT files_seen, rows_inserted, rows_skipped FROM import_runs")
    .get();
  assert.equal(runRow.files_seen, 1);
  assert.equal(runRow.rows_inserted, 1);
  assert.equal(runRow.rows_skipped, 0);
});
