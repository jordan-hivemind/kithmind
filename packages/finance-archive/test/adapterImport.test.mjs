import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  adapterPullToImportDocuments,
  createSyntheticSession,
  importBatch,
  openArchive,
  resolveInstrumentId,
  syntheticAdapter,
} from "../dist/index.js";

// The seam: the F1-2 synthetic adapter's parse() output, wired through
// src/adapterImport.ts, imported end to end through the F1-3 importer. No
// hand-written ImportRow/ImportDocument stands in for the adapter's own
// output anywhere in this file. Synthetic institution, synthetic account, no
// real data.

const INSTITUTION = {
  id: "inst_thistlebrook",
  name: "Thistlebrook Trust (synthetic)",
  slug: "thistlebrook-trust",
};
const ACCOUNT = { id: "acct_synthetic", last4: "0142", currency: "USD" };

function archive(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-adapter-import-"));
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
  db.prepare(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ACCOUNT.id, INSTITUTION.id, ACCOUNT.last4, "Synthetic account", ACCOUNT.currency);
}

async function acquireAndParseActivity(session) {
  const acquired = await syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  const rows = await syntheticAdapter.parse({ kind: "structured_api", bytes: acquired.bytes });
  return { acquired, rows };
}

test("the synthetic adapter's paginated activity pull imports end to end and the page-boundary overlap deduplicates", async (t) => {
  const db = archive(t);
  seed(db);
  const session = createSyntheticSession();
  const { acquired, rows } = await acquireAndParseActivity(session);
  assert.ok(rows.length > acquired.manifest.reportedRowCount, "fixture still carries the overlap");

  const documents = adapterPullToImportDocuments(db, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    acquired,
    rows,
    docType: "activity_pull",
    docDate: null,
    filePath: "synthetic/thistlebrook-activity.json",
  });
  // One ImportDocument per page: the boundary the plan requires the
  // occurrence ordinal to respect, structural rather than lost in parse()'s
  // flat row array.
  assert.ok(documents.length > 1, "a paginated pull becomes more than one document");

  const summary = importBatch(db, { source: INSTITUTION.slug, documents }, new Date("2025-05-01"));
  assert.equal(summary.rowsInserted, acquired.manifest.reportedRowCount);
  assert.equal(summary.rowsSkipped, rows.length - acquired.manifest.reportedRowCount);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
    acquired.manifest.reportedRowCount,
  );

  // Re-importing the identical pull is a no-op: the raw tree is immutable
  // and nothing here double-counts on a second run.
  const second = importBatch(
    db,
    { source: INSTITUTION.slug, documents },
    new Date("2025-05-01"),
  );
  assert.equal(second.rowsInserted, 0);
});

test("the same paginated overlap collapses through row_hash and occurrence alone, with no provider id to lean on", async (t) => {
  const db = archive(t);
  seed(db);
  const session = createSyntheticSession();
  const { acquired, rows } = await acquireAndParseActivity(session);

  // A real institution without a stable per-transaction id looks exactly
  // like this from the importer's point of view: the same parsed content,
  // minus externalId. This is the case ParsedRow.sourceDocument and the
  // per-document occurrence ordinal exist for.
  const anonymizedRows = rows.map((row) => ({ ...row, externalId: null }));

  const documents = adapterPullToImportDocuments(db, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    acquired,
    rows: anonymizedRows,
    docType: "activity_pull",
    docDate: null,
    filePath: "synthetic/thistlebrook-activity-no-ids.json",
  });

  const summary = importBatch(db, { source: INSTITUTION.slug, documents }, new Date("2025-05-01"));
  assert.equal(summary.rowsInserted, acquired.manifest.reportedRowCount);
  assert.equal(summary.rowsSkipped, rows.length - acquired.manifest.reportedRowCount);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n,
    acquired.manifest.reportedRowCount,
  );
  // The collapse rests on content evidence across two page-documents here,
  // not a stable id, so it is visible in the review queue rather than silent.
  const crossDocDuplicates = db
    .prepare("SELECT COUNT(*) AS n FROM review_items WHERE kind = 'cross_document_duplicate'")
    .get().n;
  assert.equal(crossDocDuplicates, rows.length - acquired.manifest.reportedRowCount);
});

test("a paginated pull with no provider ids at all and a wrong reported total is caught, not silently accepted", async (t) => {
  const db = archive(t);
  seed(db);
  const session = createSyntheticSession();
  const { acquired, rows } = await acquireAndParseActivity(session);
  const anonymizedRows = rows.map((row) => ({ ...row, externalId: null }));
  // A provider total that does not match the real, deduplicated row count.
  // Without provider ids the old id-only check had nothing to compare and
  // silently did nothing; this must be caught the same way an id-based
  // mismatch already is.
  const wrongTotal = {
    ...acquired,
    manifest: { ...acquired.manifest, reportedRowCount: acquired.manifest.reportedRowCount + 1 },
  };

  assert.throws(
    () =>
      adapterPullToImportDocuments(db, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        acquired: wrongTotal,
        rows: anonymizedRows,
        docType: "activity_pull",
        docDate: null,
        filePath: "synthetic/thistlebrook-activity-wrong-total.json",
      }),
    /does not reconcile against the provider's total/,
  );
  // Refused before importBatch ever ran: no transaction, instrument or
  // review item leaked out of a pull that was never accepted.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n, 0);
});

test("a paginated pull with no stated provider total at all is imported but leaves a durable unverified mark, never silently", async (t) => {
  const db = archive(t);
  seed(db);
  const session = createSyntheticSession();
  const { acquired, rows } = await acquireAndParseActivity(session);
  const anonymizedRows = rows.map((row) => ({ ...row, externalId: null }));
  const noStatedTotal = {
    ...acquired,
    manifest: { ...acquired.manifest, reportedRowCount: null },
  };

  const documents = adapterPullToImportDocuments(db, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    acquired: noStatedTotal,
    rows: anonymizedRows,
    docType: "activity_pull",
    docDate: null,
    filePath: "synthetic/thistlebrook-activity-no-total.json",
  });

  // Ground rule 7: nothing here may claim completeness with no total to
  // reconcile against, but the pull is not refused outright either -- it is
  // recorded as unverified rather than imported (or dropped) silently.
  const unverified = db
    .prepare("SELECT kind, account_id, reason FROM review_items WHERE kind = 'unverified_pagination_total'")
    .all();
  assert.equal(unverified.length, 1);
  assert.equal(unverified[0].account_id, ACCOUNT.id);
  assert.match(unverified[0].reason, /provider reported no total/);

  const summary = importBatch(db, { source: INSTITUTION.slug, documents }, new Date("2025-05-01"));
  assert.ok(summary.rowsInserted > 0);
});

test("two legitimately identical rows in one document, with no provider id, both survive", (t) => {
  const db = archive(t);
  seed(db);
  const acquired = {
    bytes: new Uint8Array(),
    manifest: {
      kind: "tabular_export",
      periodStart: "2025-06-01",
      periodEnd: "2025-06-30",
      capturedAt: "2025-07-01T00:00:00.000Z",
      contentHash: "f".repeat(64),
      reportedRowCount: null,
      gaps: [],
    },
  };
  const baseRow = {
    sourceDocument: "tabular-export",
    externalId: null,
    tradeDate: null,
    processDate: "2025-06-10",
    settleDate: null,
    datePrecision: "day",
    activityType: "fee",
    description: "Synthetic duplicate toll charge",
    instrument: null,
    quantity: null,
    price: null,
    amount: "-12.00",
    amountNote: null,
    currency: "USD",
    runningBalance: null,
    locators: { row: { source: "tabular_export", index: 0 } },
  };
  const rows = [
    { ...baseRow, locators: { row: { source: "tabular_export", index: 4 } } },
    { ...baseRow, locators: { row: { source: "tabular_export", index: 9 } } },
  ];

  const documents = adapterPullToImportDocuments(db, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    acquired,
    rows,
    docType: "tabular_export",
    docDate: "2025-06-30",
    filePath: "synthetic/thistlebrook-tabular.csv",
  });
  assert.equal(documents.length, 1, "no pagination on this tier: one document");

  const summary = importBatch(db, { source: INSTITUTION.slug, documents }, new Date("2025-07-01"));
  assert.equal(summary.rowsInserted, 2, "equal date, amount and description is not proof of duplication");
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

test("the deliberately garbled PDF statement amount lands in the review queue carrying its note, and instruments resolve to stable rows", async (t) => {
  const db = archive(t);
  seed(db);
  const session = createSyntheticSession();
  const { documents: discovered } = await syntheticAdapter.discover(session);
  const statement = discovered.items.find((doc) => doc.kind === "pdf_statement");
  const acquired = await syntheticAdapter.acquire({
    kind: "pdf_statement",
    session,
    externalId: statement.externalId,
  });
  const rows = await syntheticAdapter.parse({ kind: "pdf_statement", bytes: acquired.bytes });
  const ambiguous = rows.filter((row) => row.amount === null);
  assert.equal(ambiguous.length, 1);

  const importDocuments = adapterPullToImportDocuments(db, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    acquired,
    rows,
    docType: "pdf_statement",
    docDate: statement.periodEnd,
    filePath: `synthetic/${statement.externalId}.txt`,
  });
  assert.equal(importDocuments.length, 1);

  const summary = importBatch(
    db,
    { source: INSTITUTION.slug, documents: importDocuments },
    new Date("2025-03-01"),
  );
  assert.equal(summary.rowsInserted, rows.length);

  const review = db
    .prepare("SELECT kind, reason, status FROM review_items WHERE kind = 'ambiguous_amount'")
    .all();
  assert.equal(review.length, 1);
  assert.equal(review[0].status, "open");
  assert.equal(review[0].reason, ambiguous[0].amountNote);

  const flaggedTransaction = db
    .prepare("SELECT amount, status FROM transactions WHERE description = ?")
    .get(ambiguous[0].description);
  assert.equal(flaggedTransaction.amount, null);
  assert.equal(flaggedTransaction.status, "review");

  // The statement's buy, sell and dividend rows reference FKE and SGH; both
  // resolve to one instrument row each, reused rather than duplicated.
  const instrumentCount = db.prepare("SELECT COUNT(*) AS n FROM instruments").get().n;
  assert.equal(instrumentCount, 2);
});

test("resolveInstrumentId: a real identifier is preferred, and two different instruments sharing a symbol never merge on cusip or isin", (t) => {
  const db = archive(t);
  seed(db);

  const zephyr = { symbol: "ZZZ", cusip: "111111ZZ1", isin: null, name: "Synthetic Zephyr Fund" };
  const zenith = { symbol: "ZZZ", cusip: "222222ZZ2", isin: null, name: "Synthetic Zenith Trust" };
  const zephyrId = resolveInstrumentId(db, zephyr);
  const zenithId = resolveInstrumentId(db, zenith);
  assert.notEqual(zephyrId, zenithId, "same symbol, different cusip: never the same instrument");

  // Stable: resolving the same descriptor again returns the same row, and a
  // real identifier never needs a review item to justify the match.
  assert.equal(resolveInstrumentId(db, zephyr), zephyrId);
  assert.equal(resolveInstrumentId(db, { ...zephyr, cusip: "111111ZZ1" }), zephyrId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM review_items").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM instruments").get().n, 2);
});

test("resolveInstrumentId: a bare symbol with no cusip, isin, or matching name stabilizes on the first match instead of growing without bound, and opens a review item", (t) => {
  const db = archive(t);
  seed(db);
  const zephyr = { symbol: "ZZZ", cusip: "111111ZZ1", isin: null, name: "Synthetic Zephyr Fund" };
  const zephyrId = resolveInstrumentId(db, zephyr);

  // No cusip, no isin, and a name that does not match anything on file:
  // never merges silently, but never mints a fresh row forever either. It
  // resolves to the existing instrument sharing this symbol and leaves the
  // weak identity for review, rather than scattering one real holding
  // across an unbounded number of instrument ids.
  const unrelatedName = { symbol: "ZZZ", cusip: null, isin: null, name: "Unrelated Zeta Corp" };
  const weakId = resolveInstrumentId(db, unrelatedName);
  assert.equal(weakId, zephyrId, "resolves to the existing row rather than minting a new one");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM instruments").get().n, 1);

  const review = db
    .prepare("SELECT kind, reason FROM review_items WHERE kind = 'weak_instrument_match'")
    .all();
  assert.equal(review.length, 1);
  assert.match(review[0].reason, /symbol "ZZZ"/);
  assert.match(review[0].reason, new RegExp(zephyrId));

  // Resolving the same weak descriptor again is stable, and flagged again:
  // every match carries the same merge risk, so every match is made visible.
  const again = resolveInstrumentId(db, { symbol: "ZZZ", cusip: null, isin: null, name: null });
  assert.equal(again, zephyrId);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM review_items WHERE kind = 'weak_instrument_match'")
      .get().n,
    2,
  );
});
