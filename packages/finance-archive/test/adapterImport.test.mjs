import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  adapterPullToImportDocuments,
  createSyntheticSession,
  importBatch,
  persistAcquiredDocument,
  resolveInstrumentId,
  resolveRawTreeRoot,
  retainPayload,
  runPositionReconciliationGate,
  runReconciliationGate,
  syntheticAdapter,
} from "../dist/index.js";
import { all, archive, count, one, skip } from "./helpers/pgArchive.mjs";

// The seam: the F1-2 synthetic adapter's parse() output, wired through
// src/adapterImport.ts, imported end to end through the F1-3 importer. No
// hand-written ImportRow/ImportDocument stands in for the adapter's own
// output anywhere in this file. Synthetic institution, synthetic account, no
// real data.
//
// One handle. `persistAcquiredDocument` writes only to the raw tree (F1-33:
// it no longer opens a database at all, SQLite or otherwise), so only the
// Postgres client from `helpers/pgArchive.mjs`'s `archive(t)` needs seeding,
// for `adapterPullToImportDocuments`/`importBatch`'s foreign keys.

const INSTITUTION = {
  id: "inst_thistlebrook",
  name: "Thistlebrook Trust (synthetic)",
  slug: "thistlebrook-trust",
};
const ACCOUNT = { id: "acct_synthetic", last4: "0142", currency: "USD" };

// Synthetic space id (F1-28): not a real space, just what exercises the
// shared-root prefix this suite writes and reads through.
const SPACE_ID = "space_synthetic_test";

/** A throwaway raw-tree root, removed when the test ends -- the fully
 * resolved `archive/v1/<spaceId>/` root, matching what production code gets
 * back from `resolveRawTreeRoot`. AdapterPull.persisted can only be produced
 * by actually persisting bytes through it (F1-18). */
function rawRoot(t) {
  const directory = mkdtempSync(
    join(tmpdir(), "kith-finance-adapter-import-raw-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return resolveRawTreeRoot({
    FINANCE_ARCHIVE_RAW_TREE_ROOT: directory,
    FINANCE_ARCHIVE_SPACE_ID: SPACE_ID,
  });
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
 * No SQLite handle (F1-33): institution slug and account last4 are the same
 * plain constants `seedPg` wrote to Postgres. */
function persist(t, acquired, docType) {
  return persistAcquiredDocument(rawRoot(t), {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    institutionSlug: INSTITUTION.slug,
    accountLast4: ACCOUNT.last4,
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
    const client = await archive(t);
    await seedPg(client);
    const session = createSyntheticSession();
    const { acquired, rows } = await acquireAndParseActivity(session);
    assert.ok(
      rows.length > acquired.manifest.reportedRowCount,
      "fixture still carries the overlap",
    );

    const persisted = persist(t, acquired, "activity_pull");
    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows,
      docType: "activity_pull",
      docDate: null,
      persisted,
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

    // F1-29. Every page row of one pull names the same retained bytes --
    // that is one immutable capture, split for dedupe, not several files --
    // while its own `sha256` row identity stays unique, because a page row's
    // is derived and names no bytes at all.
    const documentRows = await all(
      client,
      `SELECT sha256, retained_sha256, retained_byte_length::text AS retained_byte_length,
              media_type, capture_id
       FROM documents ORDER BY file_path`,
    );
    assert.equal(documentRows.length, documents.length);
    assert.equal(
      new Set(documentRows.map((row) => row.sha256)).size,
      documentRows.length,
    );
    for (const row of documentRows) {
      assert.equal(row.retained_sha256, acquired.manifest.contentHash);
      assert.equal(
        row.retained_byte_length,
        String(acquired.bytes.byteLength),
      );
      assert.equal(row.media_type, "application/json");
      assert.equal(row.capture_id, persisted.captureId);
      // A page row's identity is derived, so it is never the bytes' hash.
      assert.notEqual(row.sha256, row.retained_sha256);
    }
    assert.equal(
      new Set(documentRows.map((row) => row.retained_sha256)).size,
      1,
      "one pull is one retained object however many page documents it splits into",
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
      persisted: persist(t, acquired, "activity_pull"),
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
        persisted: persist(t, wrongTotal, "activity_pull"),
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
      persisted: persist(t, noStatedTotal, "activity_pull"),
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
        mediaType: "text/csv; charset=utf-8",
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
      persisted: persist(t, acquired, "tabular_export"),
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
      persisted: persist(t, acquired, "pdf_statement"),
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
  "persistAcquiredDocument needs no SQLite handle, and the retained text path it writes reaches documents.text_path in Postgres",
  { skip },
  async (t) => {
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

    // No `db` argument anywhere in this test: persistAcquiredDocument opens
    // no database at all (F1-33), SQLite or otherwise.
    const persisted = persistAcquiredDocument(
      rawRoot(t),
      {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        institutionSlug: INSTITUTION.slug,
        accountLast4: ACCOUNT.last4,
        docType: "pdf_statement",
        acquired,
      },
      "synthetic retained statement text",
    );
    assert.ok(persisted.textPath);

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows,
      holdings,
      docType: "pdf_statement",
      docDate: statement.periodEnd,
      persisted,
    });
    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-03-01"),
    );

    // The path used to reach the archive through a separate
    // recordRetainedTextPath UPDATE against a SQLite provenance file the
    // Postgres importer never read (dead by construction: nothing queried
    // it). It is gone; ImportDocument.textPath carries the same value onto
    // the same INSERT the rest of a document's provenance lands on.
    const row = await one(
      client,
      "SELECT text_path FROM documents WHERE sha256 = $1",
      [acquired.manifest.contentHash],
    );
    assert.equal(row.text_path, persisted.textPath);
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

// --- F1-19: activity taxonomy --------------------------------------------
//
// Two reconciliation gates depend on conventions nothing enforced and no
// adapter author could discover except by failing a gate: the position gate
// sums signed quantities (a disposal must be negative), and the cash gate
// sums every non-null amount (a type that carries an amount but moves no
// cash fails its period). ActivityTaxonomy (adapter.ts) makes both
// conventions declared and checked at import, per activity-type string.

/** A minimal, single-document tabular_export "acquisition" wrapping `rows`,
 * built the same way the duplicate-rows test above does -- enough to
 * exercise adapterPullToImportDocuments/importBatch with no real session or
 * the synthetic adapter's own fixtures. `label` only needs to be unique
 * enough to give each test its own content hash. */
function buildTabularPull(label) {
  const retained = retainPayload(
    {
      kind: "opaque",
      version: "test-tabular-1",
      note: "delimited text from a download control, no addressable fields",
    },
    new TextEncoder().encode(label),
    "tabular_export",
  );
  return {
    bytes: retained.bytes,
    retention: retained.record,
    manifest: {
      kind: "tabular_export",
      periodStart: "2025-01-01",
      periodEnd: "2025-02-01",
      capturedAt: "2025-02-01T00:00:00.000Z",
      contentHash: retained.sha256,
      mediaType: "text/csv; charset=utf-8",
      reportedRowCount: null,
      gaps: [],
    },
  };
}

/** A minimal, valid activity row for the taxonomy tests. Each test overrides
 * only what it cares about. */
function activityRow(overrides = {}) {
  return {
    sourceDocument: "tabular-export",
    externalId: null,
    tradeDate: null,
    processDate: "2025-01-15",
    settleDate: null,
    datePrecision: "day",
    activityType: "fee",
    description: "Synthetic activity",
    instrument: null,
    quantity: null,
    price: null,
    amount: "-1.00",
    amountNote: null,
    currency: "USD",
    runningBalance: null,
    locators: { row: { source: "tabular_export", index: 0 } },
    ...overrides,
  };
}

async function insertBalance(client, id, asOf, cash) {
  await client.query(
    "INSERT INTO balances (id, account_id, as_of, cash, currency) VALUES ($1, $2, $3, $4, $5)",
    [id, ACCOUNT.id, asOf, cash, "USD"],
  );
}

test(
  "F1-19: an undeclared activity type opens a review item and both gates count it exactly as before this taxonomy existed",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    const acquired = buildTabularPull("f1-19 undeclared activity type");
    const rows = [activityRow({ activityType: "unknown_type", amount: "-50.00" })];

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows,
      docType: "tabular_export",
      docDate: "2025-02-01",
      persisted: persist(t, acquired, "tabular_export"),
      // Declares other types, but not "unknown_type".
      activityTaxonomy: {
        fee: { movesCash: true, movesQuantity: false, quantitySign: "none" },
      },
    });

    const review = await all(
      client,
      "SELECT kind, account_id, raw_value, reason FROM review_items WHERE kind = $1",
      ["undeclared_activity_type"],
    );
    assert.equal(review.length, 1);
    assert.equal(review[0].account_id, ACCOUNT.id);
    assert.equal(review[0].raw_value, "unknown_type");
    assert.match(review[0].reason, /not declared/);

    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );

    // Conservative, not corrected: an undeclared type's amount is neither
    // validated nor nulled, so it still counts toward the cash gate exactly
    // as it always did.
    const stored = await one(
      client,
      "SELECT amount::text AS amount FROM transactions WHERE account_id = $1",
      [ACCOUNT.id],
    );
    // Canonical decimal form drops trailing fraction zeros (decimal.ts).
    assert.equal(stored.amount, "-50");

    await insertBalance(client, "bal_before", "2025-01-01", "1000.00");
    await insertBalance(client, "bal_after", "2025-02-01", "950.00");
    const cash = await runReconciliationGate(client);
    assert.equal(cash.periodsChecked, 1);
    assert.equal(
      cash.passed,
      1,
      "the undeclared row's amount still balances the period",
    );
  },
);

test(
  "F1-19: an amount on a type declared movesCash: false is nulled, reviewed, and excluded from the cash gate",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    const acquired = buildTabularPull("f1-19 cash on noncash activity");
    const rows = [
      activityRow({ activityType: "transfer_in_kind", amount: "100.00" }),
    ];

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows,
      docType: "tabular_export",
      docDate: "2025-02-01",
      persisted: persist(t, acquired, "tabular_export"),
      activityTaxonomy: {
        transfer_in_kind: {
          movesCash: false,
          movesQuantity: false,
          quantitySign: "none",
        },
      },
    });

    const review = await all(
      client,
      "SELECT kind, raw_value, reason FROM review_items WHERE kind = $1",
      ["cash_on_noncash_activity"],
    );
    assert.equal(review.length, 1);
    assert.equal(review[0].raw_value, "100.00");
    assert.match(review[0].reason, /movesCash: false/);

    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );

    // Never silently corrected: the amount is nulled, not dropped or fixed
    // to whatever value would make the period balance.
    const stored = await one(
      client,
      "SELECT amount FROM transactions WHERE account_id = $1",
      [ACCOUNT.id],
    );
    assert.equal(stored.amount, null);

    // Cash genuinely did not move -- securities moved in kind -- and the
    // gate agrees, because the nulled amount is excluded from its sum
    // instead of being counted as if cash had moved.
    await insertBalance(client, "bal_before", "2025-01-01", "500.00");
    await insertBalance(client, "bal_after", "2025-02-01", "500.00");
    const cash = await runReconciliationGate(client);
    assert.equal(cash.periodsChecked, 1);
    assert.equal(cash.passed, 1);
  },
);

test(
  "F1-19: a quantity whose sign disagrees with its declared type is nulled, reviewed, and the position gate surfaces the resulting mismatch",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    const acquired = buildTabularPull("f1-19 wrong sign");
    const rows = [
      activityRow({
        processDate: "2025-01-01",
        activityType: "sell",
        instrument: {
          symbol: "ZINC",
          cusip: null,
          isin: null,
          name: "Zinc Corp (synthetic)",
        },
        // Wrong: a "sell" is a disposal and must be negative. This is +5.
        quantity: "5",
        price: "100.00",
        amount: "500.00",
      }),
    ];

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows,
      docType: "tabular_export",
      docDate: "2025-02-01",
      persisted: persist(t, acquired, "tabular_export"),
      activityTaxonomy: {
        sell: { movesCash: true, movesQuantity: true, quantitySign: "negative" },
      },
    });

    const review = await all(
      client,
      "SELECT kind, raw_value, reason FROM review_items WHERE kind = $1",
      ["activity_sign_mismatch"],
    );
    assert.equal(review.length, 1);
    assert.equal(review[0].raw_value, "5");
    assert.match(review[0].reason, /quantitySign: negative/);

    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );

    // Never silently corrected: the quantity is nulled, not flipped to
    // match the declared sign. The amount is untouched -- "sell" does move
    // cash, and the sign mismatch is a quantity-only violation.
    const stored = await one(
      client,
      "SELECT quantity, amount::text AS amount FROM transactions WHERE account_id = $1",
      [ACCOUNT.id],
    );
    assert.equal(stored.quantity, null);
    // Canonical decimal form drops trailing fraction zeros (decimal.ts).
    assert.equal(stored.amount, "500");

    const instrument = await one(
      client,
      "SELECT id FROM instruments WHERE symbol = $1",
      ["ZINC"],
    );

    // The stated position fell by 5 shares, but with the quantity nulled
    // there is no transaction left to explain it: under the gate's exact
    // tolerance, that surfaces loudly as a failed period, never a silent
    // pass that only worked because a wrongly-signed value happened to
    // cancel out.
    await client.query(
      `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, currency)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["pos_before", ACCOUNT.id, "2025-01-01", instrument.id, "10", "USD"],
    );
    await client.query(
      `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, currency)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["pos_after", ACCOUNT.id, "2025-02-01", instrument.id, "5", "USD"],
    );
    const positions = await runPositionReconciliationGate(client);
    assert.equal(positions.periodsChecked, 1);
    assert.equal(positions.failed, 1);

    const [outcome] = await all(
      client,
      "SELECT status, delta::text AS delta FROM position_reconciliations WHERE account_id = $1",
      [ACCOUNT.id],
    );
    assert.equal(outcome.status, "fail");
    assert.equal(outcome.delta, "5");
  },
);

// --- F1-35: institution-wide pulls, rows attributed by their own account ---
//
// A real institution's structured activity API can return every account's
// rows in one pull, each row carrying that account's own external key
// (ParsedRow.accountExternalKey). The synthetic adapter's structured_api
// rows alternate between its two fixture accounts' external keys,
// "acct-brokerage-01" and "acct-trust-01" (fixtures.ts), for exactly this.

test(
  "a row's own accountExternalKey attributes it to a different account than the pull names, and an unresolved key opens unknown_account_key and falls back",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    const BROKERAGE = { id: "acct_brokerage_f135", last4: "4471" };
    const TRUST = { id: "acct_trust_f135", last4: "9902" };
    for (const account of [BROKERAGE, TRUST]) {
      await client.query(
        `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [account.id, INSTITUTION.id, account.last4, "Discovered account", "USD"],
      );
    }
    const accountsByExternalKey = new Map([
      ["acct-brokerage-01", BROKERAGE.id],
      ["acct-trust-01", TRUST.id],
    ]);

    const session = createSyntheticSession();
    const { acquired, rows } = await acquireAndParseActivity(session);

    // Index 3 sits inside page 1 only (paginateWithOverlap's one-row overlap
    // falls at indices 9 and 18 for a 24-row, 10-per-page pull), so this
    // targets exactly one parsed row instance -- not a duplicate half of an
    // overlapping pair that would otherwise stop collapsing to one hash once
    // only one copy's account changes.
    const targetIndex = 3;
    assert.equal(typeof rows[targetIndex].accountExternalKey, "string");
    const taggedRows = rows.map((row, index) =>
      index === targetIndex
        ? { ...row, accountExternalKey: "acct-unknown-99" }
        : row,
    );

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows: taggedRows,
      docType: "activity_pull",
      docDate: null,
      persisted: persist(t, acquired, "activity_pull"),
      accountsByExternalKey,
    });
    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );

    const brokerageCount = await count(
      client,
      "transactions",
      "WHERE account_id = $1",
      [BROKERAGE.id],
    );
    const trustCount = await count(client, "transactions", "WHERE account_id = $1", [
      TRUST.id,
    ]);
    const fallbackCount = await count(
      client,
      "transactions",
      "WHERE account_id = $1",
      [ACCOUNT.id],
    );
    assert.ok(brokerageCount > 0, "rows keyed to the brokerage account land there");
    assert.ok(trustCount > 0, "rows keyed to the trust account land there");
    // Exactly the one row whose key does not resolve falls back to the
    // pull's own account, never silently dropped.
    assert.equal(fallbackCount, 1);
    assert.equal(
      brokerageCount + trustCount + fallbackCount,
      acquired.manifest.reportedRowCount,
    );

    const [review] = await all(
      client,
      "SELECT kind, account_id, raw_value FROM review_items WHERE kind = $1",
      ["unknown_account_key"],
    );
    assert.ok(review, "an unresolved key opens a review item");
    assert.equal(review.account_id, ACCOUNT.id);
    assert.equal(review.raw_value, "acct-unknown-99");
  },
);

test(
  "an institution-wide pull persists with a null document account, while its rows still land on their own accounts",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    const BROKERAGE = { id: "acct_brokerage_f135_wide", last4: "4471" };
    const TRUST = { id: "acct_trust_f135_wide", last4: "9902" };
    for (const account of [BROKERAGE, TRUST]) {
      await client.query(
        `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [account.id, INSTITUTION.id, account.last4, "Discovered account", "USD"],
      );
    }
    const accountsByExternalKey = new Map([
      ["acct-brokerage-01", BROKERAGE.id],
      ["acct-trust-01", TRUST.id],
    ]);

    const session = createSyntheticSession();
    const { acquired, rows } = await acquireAndParseActivity(session);

    // No accountId, no accountLast4: an institution-wide pull names no
    // single account, so persistAcquiredDocument's capture manifest records
    // the literal "all" in place of one (captures.ts's acctLast4).
    const persisted = persistAcquiredDocument(rawRoot(t), {
      institutionId: INSTITUTION.id,
      accountId: null,
      institutionSlug: INSTITUTION.slug,
      accountLast4: "all",
      docType: "activity_pull",
      acquired,
    });

    const documents = await adapterPullToImportDocuments(client, {
      institutionId: INSTITUTION.id,
      accountId: null,
      acquired,
      rows,
      docType: "activity_pull",
      docDate: null,
      persisted,
      accountsByExternalKey,
    });
    assert.ok(documents.length > 0);
    for (const document of documents) {
      assert.equal(document.accountId, null);
    }

    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );

    assert.equal(
      await count(client, "documents", "WHERE account_id IS NULL"),
      documents.length,
    );
    const brokerageCount = await count(
      client,
      "transactions",
      "WHERE account_id = $1",
      [BROKERAGE.id],
    );
    const trustCount = await count(client, "transactions", "WHERE account_id = $1", [
      TRUST.id,
    ]);
    assert.ok(brokerageCount > 0);
    assert.ok(trustCount > 0);
    assert.equal(brokerageCount + trustCount, acquired.manifest.reportedRowCount);
  },
);

// --- F1-46: consolidated statements, holdings attributed per section -------
//
// A consolidated statement's positions, balances and liabilities can span
// several accounts, one per section (adapter-morgan-stanley's
// statementLayout.mjs). ParsedPosition/ParsedBalance/ParsedLiability now
// carry the same optional accountExternalKey ParsedRow already had (F1-35);
// this proves finance-archive resolves it the same way for holdings as for
// rows: a known key lands on its own account, and an unknown key opens
// unknown_account_key and falls back to the pull's own account rather than
// being dropped.

async function acquirePdfStatementForHoldings() {
  const session = createSyntheticSession();
  const { documents: discovered } = await syntheticAdapter.discover(session);
  const statement = discovered.items.find((doc) => doc.kind === "pdf_statement");
  return syntheticAdapter.acquire({
    kind: "pdf_statement",
    session,
    externalId: statement.externalId,
  });
}

test(
  "a consolidated statement's positions and balances land on the account named in their own section, and an unknown key opens unknown_account_key",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    const BROKERAGE = { id: "acct_brokerage_f146", last4: "4471" };
    const TRUST = { id: "acct_trust_f146", last4: "9902" };
    for (const account of [BROKERAGE, TRUST]) {
      await client.query(
        `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [account.id, INSTITUTION.id, account.last4, "Discovered account", "USD"],
      );
    }
    const accountsByExternalKey = new Map([
      ["acct-brokerage-01", BROKERAGE.id],
      ["acct-trust-01", TRUST.id],
    ]);

    const acquired = await acquirePdfStatementForHoldings();
    const persisted = persist(t, acquired, "pdf_statement");

    const position = (overrides) => ({
      sourceDocument: "statement",
      asOf: "2026-03-31",
      instrument: null,
      quantity: "10",
      price: "50",
      marketValue: "500",
      marketValueNote: null,
      costBasis: "400",
      unrealized: "100",
      currency: "USD",
      valuationBasis: "market_price",
      valuationNote: "Synthetic delayed market feed.",
      locators: { row: { source: "pdf_statement", index: 1 } },
      ...overrides,
    });
    const balance = (overrides) => ({
      sourceDocument: "statement",
      asOf: "2026-03-31",
      totalValue: "10000",
      totalValueNote: null,
      cash: "500",
      currency: "USD",
      periodStartValue: "9500",
      periodEndValue: "10000",
      locators: { row: { source: "pdf_statement", index: 1 } },
      ...overrides,
    });

    const pull = {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows: [],
      holdings: {
        positions: [
          position({ accountExternalKey: "acct-brokerage-01" }),
          position({ accountExternalKey: "acct-trust-01" }),
          position({ accountExternalKey: "acct-unknown-99" }),
        ],
        balances: [
          balance({ accountExternalKey: "acct-brokerage-01", totalValue: "10000" }),
          balance({ accountExternalKey: "acct-trust-01", totalValue: "25000" }),
        ],
        liabilities: [],
      },
      docType: "pdf_statement",
      docDate: "2026-03-31",
      persisted,
      accountsByExternalKey,
    };

    const documents = await adapterPullToImportDocuments(client, pull);
    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2026-04-01"),
    );

    const brokeragePositions = await count(
      client,
      "positions",
      "WHERE account_id = $1",
      [BROKERAGE.id],
    );
    const trustPositions = await count(client, "positions", "WHERE account_id = $1", [
      TRUST.id,
    ]);
    const fallbackPositions = await count(
      client,
      "positions",
      "WHERE account_id = $1",
      [ACCOUNT.id],
    );
    assert.equal(brokeragePositions, 1);
    assert.equal(trustPositions, 1);
    // The unresolved key falls back to the pull's own account rather than
    // being silently dropped (ground rule 5).
    assert.equal(fallbackPositions, 1);

    const brokerageBalance = await one(
      client,
      "SELECT total_value FROM balances WHERE account_id = $1",
      [BROKERAGE.id],
    );
    const trustBalance = await one(
      client,
      "SELECT total_value FROM balances WHERE account_id = $1",
      [TRUST.id],
    );
    assert.equal(brokerageBalance.total_value, "10000");
    assert.equal(trustBalance.total_value, "25000");

    const [review] = await all(
      client,
      "SELECT kind, account_id, raw_value FROM review_items WHERE kind = $1",
      ["unknown_account_key"],
    );
    assert.ok(review, "an unresolved key on a holding opens a review item, same as a row's");
    assert.equal(review.account_id, ACCOUNT.id);
    assert.equal(review.raw_value, "acct-unknown-99");
  },
);

// F1-43. A real institution's PDF statements use compressed content streams
// the adapter's dependency-free extractor cannot read; parse() then returns
// a parseNote instead of throwing, and the retained bytes must still be
// recorded rather than lost. No hand-built AdapterPull.acquired here either
// -- the synthetic adapter's own pdf_statement acquisition supplies real
// bytes, a real manifest and a real persisted capture; only `rows`/`parseNote`
// stand in for what a not-yet-supported extractor's parse() would have
// returned for them.
async function acquireUnparseablePdfStatement(t, client) {
  const session = createSyntheticSession();
  const { documents: discovered } = await syntheticAdapter.discover(session);
  const statement = discovered.items.find((doc) => doc.kind === "pdf_statement");
  const acquired = await syntheticAdapter.acquire({
    kind: "pdf_statement",
    session,
    externalId: statement.externalId,
  });
  const persisted = persist(t, acquired, "pdf_statement");
  const pull = {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    acquired,
    rows: [],
    parseNote: "not parsed: extractor found no text",
    docType: "pdf_statement",
    docDate: statement.periodEnd,
    persisted,
  };
  const documents = await adapterPullToImportDocuments(client, pull);
  return { pull, documents };
}

test(
  "a document the adapter retained but could not parse records one document with parsed_ok false and opens a document_unparsed review item",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    const { documents } = await acquireUnparseablePdfStatement(t, client);
    assert.equal(documents.length, 1, "a rowless pull is still one document, not zero");
    assert.equal(documents[0].parseNote, "not parsed: extractor found no text");
    assert.equal(documents[0].rows.length, 0);

    const summary = await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );
    assert.equal(summary.rowsInserted, 0);

    assert.equal(await count(client, "documents"), 1);
    const [document] = await all(client, "SELECT parsed_ok FROM documents");
    assert.equal(document.parsed_ok, false);

    const reviewItems = await all(
      client,
      "SELECT account_id, reason FROM review_items WHERE kind = $1",
      ["document_unparsed"],
    );
    assert.equal(reviewItems.length, 1);
    assert.equal(reviewItems[0].account_id, ACCOUNT.id);
    assert.equal(reviewItems[0].reason, "not parsed: extractor found no text");
  },
);

test(
  "a rerun of the same unparsed pull is skipped as already imported: no second document row or duplicate review item",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    const { pull } = await acquireUnparseablePdfStatement(t, client);
    await importBatch(
      client,
      { source: INSTITUTION.slug, documents: await adapterPullToImportDocuments(client, pull) },
      new Date("2025-05-01"),
    );
    assert.equal(await count(client, "review_items", "WHERE kind = $1", ["document_unparsed"]), 1);

    // The identical bytes, re-parsed by the same still-broken extractor,
    // produce the identical parseNote -- exactly what a real rerun looks
    // like before a real extractor replaces this one. Nothing here doubles:
    // same one document row, same one review item.
    const rerunDocuments = await adapterPullToImportDocuments(client, pull);
    const second = await importBatch(
      client,
      { source: INSTITUTION.slug, documents: rerunDocuments },
      new Date("2025-05-01"),
    );
    assert.equal(second.rowsInserted, 0);
    assert.equal(await count(client, "documents"), 1);
    assert.equal(await count(client, "review_items", "WHERE kind = $1", ["document_unparsed"]), 1);
  },
);

// --- F1-51: instrument resolution is one query per document -----------------
//
// The other half of a statement's round trips lived here: every holding
// resolved its own instrument with its own query (and its own insert when it
// was new). Against a hosted archive that is what turned two hundred holdings
// into minutes. The rules themselves are unchanged and tested above; this
// asserts the cost, which is the part a later edit can silently undo.

test(
  "resolving a statement's instruments costs the same number of queries for ten holdings and two hundred",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    const acquired = await acquirePdfStatementForHoldings();
    const persisted = persist(t, acquired, "pdf_statement");

    /** `n` holdings, each naming a distinct instrument by cusip. */
    const pullOf = (n) => ({
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows: [],
      holdings: {
        positions: Array.from({ length: n }, (_, i) => ({
          sourceDocument: "statement",
          asOf: "2026-03-31",
          instrument: {
            symbol: `SYN${n}${i}`,
            cusip: `${n}`.padStart(3, "0") + `${i}`.padStart(6, "0"),
            isin: null,
            name: `Synthetic holding ${n}-${i}`,
          },
          quantity: `${i + 1}`,
          price: "50",
          marketValue: `${(i + 1) * 50}`,
          marketValueNote: null,
          costBasis: "400",
          unrealized: "100",
          currency: "USD",
          valuationBasis: "market_price",
          valuationNote: "Synthetic delayed market feed.",
          locators: { row: { source: "pdf_statement", index: i } },
        })),
        balances: [],
        liabilities: [],
      },
      docType: "pdf_statement",
      docDate: "2026-03-31",
      persisted,
    });

    const measure = async (n) => {
      const real = client.query.bind(client);
      let queries = 0;
      client.query = (...args) => {
        queries += 1;
        return real(...args);
      };
      try {
        const documents = await adapterPullToImportDocuments(client, pullOf(n));
        return { queries, documents };
      } finally {
        client.query = real;
      }
    };

    const small = await measure(10);
    const large = await measure(200);

    assert.equal(small.documents[0].positions.length, 10);
    assert.equal(large.documents[0].positions.length, 200);
    assert.equal(
      large.queries,
      small.queries,
      `resolving 200 instruments took ${large.queries} queries where 10 took ${small.queries}; ` +
        "instrument resolution has gone back inside a per-holding loop",
    );
    // Every instrument really was resolved to its own row, not collapsed.
    assert.equal(await count(client, "instruments"), 210);
  },
);
