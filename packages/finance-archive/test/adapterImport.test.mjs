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
  persistAcquiredDocument,
  resolveInstrumentId,
  retainPayload,
  syntheticAdapter,
} from "../dist/index.js";
import { all, archive, count, one, skip } from "./helpers/pgArchive.mjs";

// The seam: the F1-2 synthetic adapter's parse() output, wired through
// src/adapterImport.ts, imported end to end through the F1-3 importer. No
// hand-written ImportRow/ImportDocument stands in for the adapter's own
// output anywhere in this file. Synthetic institution, synthetic account, no
// real data.
//
// Two handles, deliberately. `adapterPullToImportDocuments` and `importBatch`
// were ported to Postgres (F1-22/F1-25ish) and now take the `client` from
// `helpers/pgArchive.mjs`'s `archive(t)`. `persistAcquiredDocument`, at the
// bottom of src/adapterImport.ts, was NOT ported -- F1-24 owns that raw-tree
// path and is moving it in parallel -- so it still takes a `DatabaseSync` and
// still writes to a SQLite archive opened with `openArchive`. Both handles
// are seeded with the same synthetic institution and account: the SQLite one
// because `persistAcquiredDocument` reads those rows to build the raw tree
// manifest, the Postgres one because the importer's foreign keys require
// them. This collapses to one handle once F1-24 lands.

const INSTITUTION = {
  id: "inst_thistlebrook",
  name: "Thistlebrook Trust (synthetic)",
  slug: "thistlebrook-trust",
};
const ACCOUNT = { id: "acct_synthetic", last4: "0142", currency: "USD" };

function sqliteArchive(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-adapter-import-"));
  const db = openArchive(join(directory, "archive.db"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

/** A throwaway raw-tree root, removed when the test ends. AdapterPull.persisted
 * can only be produced by actually persisting bytes through it (F1-18). */
function rawRoot(t) {
  const directory = mkdtempSync(
    join(tmpdir(), "kith-finance-adapter-import-raw-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function seedSqlite(db) {
  db.prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)").run(
    INSTITUTION.id,
    INSTITUTION.name,
    INSTITUTION.slug,
  );
  db.prepare(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    ACCOUNT.id,
    INSTITUTION.id,
    ACCOUNT.last4,
    "Synthetic account",
    ACCOUNT.currency,
  );
}

async function seedPg(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug],
  );
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      ACCOUNT.id,
      INSTITUTION.id,
      ACCOUNT.last4,
      "Synthetic account",
      ACCOUNT.currency,
    ],
  );
}

/** Persists an acquired pull's bytes for a test, the same way a real caller
 * must, and returns the PersistedAcquisition to use as AdapterPull.persisted.
 * Still SQLite-backed (F1-24 has not landed); see the file header. */
function persist(t, db, acquired, docType) {
  return persistAcquiredDocument(db, rawRoot(t), {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType,
    acquired,
  });
}

/** True when a canonical decimal string (as Postgres NUMERIC crosses the
 * driver boundary) represents a value greater than zero. String-only, so a
 * money value is never widened into a JavaScript number to compare it. */
function isPositiveDecimal(text) {
  return !/^-?0(\.0+)?$/.test(text) && !text.startsWith("-");
}

async function acquireAndParseActivity(session) {
  const acquired = await syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  const { activity: rows } = await syntheticAdapter.parse({
    kind: "structured_api",
    bytes: acquired.bytes,
  });
  return { acquired, rows };
}

test(
  "the synthetic adapter's paginated activity pull imports end to end and the page-boundary overlap deduplicates",
  { skip },
  async (t) => {
    const db = sqliteArchive(t);
    seedSqlite(db);
    const client = await archive(t);
    await seedPg(client);
    const session = createSyntheticSession();
    const { acquired, rows } = await acquireAndParseActivity(session);
    assert.ok(
      rows.length > acquired.manifest.reportedRowCount,
      "fixture still carries the overlap",
    );

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows,
      docType: "activity_pull",
      docDate: null,
      persisted: persist(t, db, acquired, "activity_pull"),
    });
    // One ImportDocument per page: the boundary the plan requires the
    // occurrence ordinal to respect, structural rather than lost in parse()'s
    // flat row array.
    assert.ok(
      documents.length > 1,
      "a paginated pull becomes more than one document",
    );

    const summary = await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );
    assert.equal(summary.rowsInserted, acquired.manifest.reportedRowCount);
    assert.equal(
      summary.rowsSkipped,
      rows.length - acquired.manifest.reportedRowCount,
    );
    assert.equal(
      await count(client, "transactions"),
      acquired.manifest.reportedRowCount,
    );

    // Re-importing the identical pull is a no-op: the raw tree is immutable
    // and nothing here double-counts on a second run.
    const second = await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );
    assert.equal(second.rowsInserted, 0);
  },
);

test(
  "the same paginated overlap collapses through row_hash and occurrence alone, with no provider id to lean on",
  { skip },
  async (t) => {
    const db = sqliteArchive(t);
    seedSqlite(db);
    const client = await archive(t);
    await seedPg(client);
    const session = createSyntheticSession();
    const { acquired, rows } = await acquireAndParseActivity(session);

    // A real institution without a stable per-transaction id looks exactly
    // like this from the importer's point of view: the same parsed content,
    // minus externalId. This is the case ParsedRow.sourceDocument and the
    // per-document occurrence ordinal exist for.
    const anonymizedRows = rows.map((row) => ({ ...row, externalId: null }));

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows: anonymizedRows,
      docType: "activity_pull",
      docDate: null,
      persisted: persist(t, db, acquired, "activity_pull"),
    });

    const summary = await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );
    assert.equal(summary.rowsInserted, acquired.manifest.reportedRowCount);
    assert.equal(
      summary.rowsSkipped,
      rows.length - acquired.manifest.reportedRowCount,
    );
    assert.equal(
      await count(client, "transactions"),
      acquired.manifest.reportedRowCount,
    );
    // The collapse rests on content evidence across two page-documents here,
    // not a stable id, so it is visible in the review queue rather than silent.
    const crossDocDuplicates = await count(
      client,
      "review_items",
      "WHERE kind = $1",
      ["cross_document_duplicate"],
    );
    assert.equal(
      crossDocDuplicates,
      rows.length - acquired.manifest.reportedRowCount,
    );
  },
);

test(
  "a paginated pull with no provider ids at all and a wrong reported total is caught, not silently accepted",
  { skip },
  async (t) => {
    const db = sqliteArchive(t);
    seedSqlite(db);
    const client = await archive(t);
    await seedPg(client);
    const session = createSyntheticSession();
    const { acquired, rows } = await acquireAndParseActivity(session);
    const anonymizedRows = rows.map((row) => ({ ...row, externalId: null }));
    // A provider total that does not match the real, deduplicated row count.
    // Without provider ids the old id-only check had nothing to compare and
    // silently did nothing; this must be caught the same way an id-based
    // mismatch already is.
    const wrongTotal = {
      ...acquired,
      manifest: {
        ...acquired.manifest,
        reportedRowCount: acquired.manifest.reportedRowCount + 1,
      },
    };

    await assert.rejects(
      adapterPullToImportDocuments(client, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        acquired: wrongTotal,
        rows: anonymizedRows,
        docType: "activity_pull",
        docDate: null,
        persisted: persist(t, db, wrongTotal, "activity_pull"),
      }),
      /does not reconcile against the provider's total/,
    );
    // Refused before importBatch ever ran: no transaction, instrument or
    // review item leaked out of a pull that was never accepted.
    assert.equal(await count(client, "transactions"), 0);
  },
);

test(
  "a paginated pull with no stated provider total at all is imported but leaves a durable unverified mark, never silently",
  { skip },
  async (t) => {
    const db = sqliteArchive(t);
    seedSqlite(db);
    const client = await archive(t);
    await seedPg(client);
    const session = createSyntheticSession();
    const { acquired, rows } = await acquireAndParseActivity(session);
    const anonymizedRows = rows.map((row) => ({ ...row, externalId: null }));
    const noStatedTotal = {
      ...acquired,
      manifest: { ...acquired.manifest, reportedRowCount: null },
    };

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired: noStatedTotal,
      rows: anonymizedRows,
      docType: "activity_pull",
      docDate: null,
      persisted: persist(t, db, noStatedTotal, "activity_pull"),
    });

    // Ground rule 7: nothing here may claim completeness with no total to
    // reconcile against, but the pull is not refused outright either -- it is
    // recorded as unverified rather than imported (or dropped) silently.
    const unverified = await all(
      client,
      "SELECT kind, account_id, reason FROM review_items WHERE kind = $1",
      ["unverified_pagination_total"],
    );
    assert.equal(unverified.length, 1);
    assert.equal(unverified[0].account_id, ACCOUNT.id);
    assert.match(unverified[0].reason, /provider reported no total/);

    const summary = await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );
    assert.ok(summary.rowsInserted > 0);
  },
);

test(
  "two legitimately identical rows in one document, with no provider id, both survive",
  { skip },
  async (t) => {
    const db = sqliteArchive(t);
    seedSqlite(db);
    const client = await archive(t);
    await seedPg(client);
    const retained = retainPayload(
      {
        kind: "opaque",
        version: "test-tabular-1",
        note: "delimited text from a download control, no addressable fields",
      },
      new TextEncoder().encode("synthetic tabular export bytes"),
      "tabular_export",
    );
    const acquired = {
      bytes: retained.bytes,
      retention: retained.record,
      manifest: {
        kind: "tabular_export",
        periodStart: "2025-06-01",
        periodEnd: "2025-06-30",
        capturedAt: "2025-07-01T00:00:00.000Z",
        contentHash: retained.sha256,
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

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows,
      docType: "tabular_export",
      docDate: "2025-06-30",
      persisted: persist(t, db, acquired, "tabular_export"),
    });
    assert.equal(
      documents.length,
      1,
      "no pagination on this tier: one document",
    );

    const summary = await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-07-01"),
    );
    assert.equal(
      summary.rowsInserted,
      2,
      "equal date, amount and description is not proof of duplication",
    );
    assert.equal(await count(client, "transactions"), 2);
    const hashes = (
      await all(client, "SELECT row_hash FROM transactions ORDER BY row_hash")
    ).map((r) => r.row_hash);
    assert.notEqual(hashes[0], hashes[1]);
  },
);

test(
  "the deliberately garbled PDF statement amount lands in the review queue carrying its note, and instruments resolve to stable rows",
  { skip },
  async (t) => {
    const db = sqliteArchive(t);
    seedSqlite(db);
    const client = await archive(t);
    await seedPg(client);
    const session = createSyntheticSession();
    const { documents: discovered } = await syntheticAdapter.discover(session);
    const statement = discovered.items.find(
      (doc) => doc.kind === "pdf_statement",
    );
    const acquired = await syntheticAdapter.acquire({
      kind: "pdf_statement",
      session,
      externalId: statement.externalId,
    });
    const { activity: rows, holdings } = await syntheticAdapter.parse({
      kind: "pdf_statement",
      bytes: acquired.bytes,
    });
    const ambiguous = rows.filter((row) => row.amount === null);
    assert.equal(ambiguous.length, 1);

    const importDocuments = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows,
      holdings,
      docType: "pdf_statement",
      docDate: statement.periodEnd,
      persisted: persist(t, db, acquired, "pdf_statement"),
    });
    assert.equal(importDocuments.length, 1);

    const holdingsRowCount =
      holdings.positions.length +
      holdings.balances.length +
      holdings.liabilities.length;
    const summary = await importBatch(
      client,
      { source: INSTITUTION.slug, documents: importDocuments },
      new Date("2025-03-01"),
    );
    assert.equal(summary.rowsInserted, rows.length + holdingsRowCount);

    const review = await all(
      client,
      "SELECT kind, reason, status FROM review_items WHERE kind = $1",
      ["ambiguous_amount"],
    );
    assert.equal(review.length, 1);
    assert.equal(review[0].status, "open");
    assert.equal(review[0].reason, ambiguous[0].amountNote);

    const flaggedTransaction = await one(
      client,
      "SELECT amount, status FROM transactions WHERE description = $1",
      [ambiguous[0].description],
    );
    assert.equal(flaggedTransaction.amount, null);
    assert.equal(flaggedTransaction.status, "review");

    // The statement's buy, sell and dividend rows reference FKE and SGH; the
    // positions table adds a private fund (no symbol at all) and a EUR share
    // class, so four distinct instruments in total, none duplicated.
    assert.equal(await count(client, "instruments"), 4);

    assert.equal(await count(client, "positions"), holdings.positions.length);
    assert.equal(await count(client, "balances"), holdings.balances.length);
    assert.equal(
      await count(client, "liabilities"),
      holdings.liabilities.length,
    );

    // Every imported holdings row carries its source document and locator
    // (ground rule 2), exactly as transactions do.
    const positionProvenance = await all(
      client,
      "SELECT source_document_id, source_locator FROM positions",
    );
    for (const row of positionProvenance) {
      assert.ok(
        row.source_document_id,
        "every position carries its source document",
      );
      assert.ok(row.source_locator, "every position carries its locator");
    }
    const balanceProvenance = await one(
      client,
      "SELECT source_document_id, source_locator FROM balances",
    );
    assert.ok(balanceProvenance.source_document_id);
    assert.ok(balanceProvenance.source_locator);
    const liabilityProvenance = await one(
      client,
      "SELECT source_document_id, source_locator FROM liabilities",
    );
    assert.ok(liabilityProvenance.source_document_id);
    assert.ok(liabilityProvenance.source_locator);

    // A total-assets query can separate marked positions from those carried
    // at cost (acceptance criterion 3): mixing the two silently would be the
    // exact confidently-wrong answer the archive exists to prevent.
    const marked = await one(
      client,
      "SELECT COALESCE(SUM(market_value), 0)::text AS total FROM positions WHERE valuation_basis = $1 AND currency = $2",
      ["market_price", "USD"],
    );
    const atCost = await one(
      client,
      "SELECT COALESCE(SUM(market_value), 0)::text AS total FROM positions WHERE valuation_basis = $1 AND currency = $2",
      ["cost", "USD"],
    );
    assert.ok(isPositiveDecimal(marked.total));
    assert.ok(isPositiveDecimal(atCost.total));
    assert.notEqual(marked.total, atCost.total);

    // The garbled market value opened its own review item too, distinct from
    // the activity-row one asserted above.
    const positionReview = await all(
      client,
      "SELECT kind, status FROM review_items WHERE kind = $1",
      ["ambiguous_market_value"],
    );
    assert.equal(positionReview.length, 1);
    assert.equal(positionReview[0].status, "open");

    // Multi-currency holdings round-trip: a EUR position's own currency is
    // preserved, not folded into the USD positions above.
    const eurPositions = await count(
      client,
      "positions",
      "WHERE currency = $1",
      ["EUR"],
    );
    assert.ok(eurPositions > 0);

    // Re-importing the identical document does not duplicate holdings rows.
    const secondSummary = await importBatch(
      client,
      { source: INSTITUTION.slug, documents: importDocuments },
      new Date("2025-03-01"),
    );
    assert.equal(secondSummary.rowsInserted, 0);
    assert.equal(await count(client, "positions"), holdings.positions.length);
    assert.equal(await count(client, "balances"), holdings.balances.length);
    assert.equal(
      await count(client, "liabilities"),
      holdings.liabilities.length,
    );
  },
);

test(
  "resolveInstrumentId: a real identifier is preferred, and two different instruments sharing a symbol never merge on cusip or isin",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    const zephyr = {
      symbol: "ZZZ",
      cusip: "111111ZZ1",
      isin: null,
      name: "Synthetic Zephyr Fund",
    };
    const zenith = {
      symbol: "ZZZ",
      cusip: "222222ZZ2",
      isin: null,
      name: "Synthetic Zenith Trust",
    };
    const zephyrId = await resolveInstrumentId(client, zephyr);
    const zenithId = await resolveInstrumentId(client, zenith);
    assert.notEqual(
      zephyrId,
      zenithId,
      "same symbol, different cusip: never the same instrument",
    );

    // Stable: resolving the same descriptor again returns the same row, and a
    // real identifier never needs a review item to justify the match.
    assert.equal(await resolveInstrumentId(client, zephyr), zephyrId);
    assert.equal(
      await resolveInstrumentId(client, { ...zephyr, cusip: "111111ZZ1" }),
      zephyrId,
    );
    assert.equal(await count(client, "review_items"), 0);
    assert.equal(await count(client, "instruments"), 2);
  },
);

test(
  "resolveInstrumentId: a bare symbol with no cusip, isin, or matching name stabilizes on the first match instead of growing without bound, and opens a review item",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    const zephyr = {
      symbol: "ZZZ",
      cusip: "111111ZZ1",
      isin: null,
      name: "Synthetic Zephyr Fund",
    };
    const zephyrId = await resolveInstrumentId(client, zephyr);

    // No cusip, no isin, and a name that does not match anything on file:
    // never merges silently, but never mints a fresh row forever either. It
    // resolves to the existing instrument sharing this symbol and leaves the
    // weak identity for review, rather than scattering one real holding
    // across an unbounded number of instrument ids.
    const unrelatedName = {
      symbol: "ZZZ",
      cusip: null,
      isin: null,
      name: "Unrelated Zeta Corp",
    };
    const weakId = await resolveInstrumentId(client, unrelatedName);
    assert.equal(
      weakId,
      zephyrId,
      "resolves to the existing row rather than minting a new one",
    );
    assert.equal(await count(client, "instruments"), 1);

    const review = await all(
      client,
      "SELECT kind, reason FROM review_items WHERE kind = $1",
      ["weak_instrument_match"],
    );
    assert.equal(review.length, 1);
    assert.match(review[0].reason, /symbol "ZZZ"/);
    assert.match(review[0].reason, new RegExp(zephyrId));

    // Resolving the same weak descriptor again is stable, and flagged again:
    // every match carries the same merge risk, so every match is made visible.
    const again = await resolveInstrumentId(client, {
      symbol: "ZZZ",
      cusip: null,
      isin: null,
      name: null,
    });
    assert.equal(again, zephyrId);
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      2,
    );
  },
);
