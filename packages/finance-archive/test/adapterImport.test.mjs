import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  adapterPullToImportDocuments,
  createSyntheticSession,
  INSTITUTION_SYMBOL_INVALIDATED,
  INSTITUTION_SYMBOL_RULE,
  INSTRUMENT_MATCH_REASON_CODES,
  INSTRUMENT_MATCH_REASON_TEXT,
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

test(
  "resolveInstrumentId: a cusip-strong match names a row on file with none, and never renames one that has a name",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    const name = async (id) =>
      (await one(client, "SELECT name FROM instruments WHERE id = $1", [id]))
        .name;

    // How this institution's two tiers describe one instrument: the activity
    // feed knows its cusip and its symbol and no name at all, and the
    // statement's holdings table names it. Before F1-76 the second sighting
    // matched the first on the cusip and then dropped the name it carried, so
    // `instruments.name` stayed null for good and nothing ever filled it.
    const fromActivity = {
      symbol: "ZZZ",
      cusip: "111111ZZ1",
      isin: null,
      name: null,
    };
    const fromStatement = { ...fromActivity, name: "Synthetic Zephyr Fund" };

    const id = await resolveInstrumentId(client, fromActivity);
    assert.equal(await name(id), null);

    assert.equal(await resolveInstrumentId(client, fromStatement), id);
    assert.equal(await count(client, "instruments"), 1);
    assert.equal(await name(id), "Synthetic Zephyr Fund");

    // A second spelling of the same instrument's name is not a conflict this
    // import is entitled to settle, so the name already on file stands.
    assert.equal(
      await resolveInstrumentId(client, {
        ...fromActivity,
        name: "Zephyr Fund (synthetic)",
      }),
      id,
    );
    assert.equal(await name(id), "Synthetic Zephyr Fund");

    // A name is a strong match's fact and only ever that: none of the above
    // was flagged, and the symbol-only tier still resolves and flags exactly
    // as it did, without naming the row it merged into.
    assert.equal(await count(client, "review_items"), 0);
    assert.equal(
      await resolveInstrumentId(client, {
        symbol: "ZZZ",
        cusip: null,
        isin: null,
        name: "Unrelated Zeta Corp",
      }),
      id,
    );
    assert.equal(await name(id), "Synthetic Zephyr Fund");
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      1,
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
    const rows = [
      // F1-8e. Dated on (never after) the balance below it anchors, so this
      // fixture's own acquired history reaches back far enough that the
      // coverage-gap rule does not turn the period this test checks into an
      // unverified one instead of the pass it is testing for. A declared
      // type with a zero amount: no review item of its own, no effect on
      // the cash sum either way.
      activityRow({
        processDate: "2025-01-01",
        activityType: "fee",
        amount: "0",
      }),
      activityRow({ activityType: "unknown_type", amount: "-50.00" }),
    ];

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

    // F1-56: the seam's own review items are carried on the ImportDocument
    // and written by importBatch, which is the first thing that knows the
    // document id, so none of them exists yet.
    assert.equal(
      (await all(client, "SELECT id FROM review_items")).length,
      0,
      "nothing is written until the document row exists",
    );

    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );

    const review = await all(
      client,
      `SELECT r.kind, r.account_id, r.raw_value, r.reason, d.sha256
         FROM review_items r JOIN documents d ON d.id = r.source_document_id
        WHERE r.kind = $1`,
      ["undeclared_activity_type"],
    );
    assert.equal(review.length, 1);
    assert.equal(review[0].account_id, ACCOUNT.id);
    assert.equal(review[0].raw_value, "unknown_type");
    assert.match(review[0].reason, /not declared/);
    assert.equal(
      review[0].sha256,
      acquired.manifest.contentHash,
      "F1-56: the item names the document its row came from",
    );

    // Conservative, not corrected: an undeclared type's amount is neither
    // validated nor nulled, so it still counts toward the cash gate exactly
    // as it always did.
    const stored = await one(
      client,
      "SELECT amount::text AS amount FROM transactions WHERE account_id = $1 AND activity_type = $2",
      [ACCOUNT.id, "unknown_type"],
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

// F1-65. A hosted reparse of 854 already-imported statements opened 76,687
// review items, 84,266 of them exact duplicates by (kind, source_document_id,
// source_locator, raw_value): the same weak instrument match and the same
// undeclared activity type, reopened on every row that carried them and
// again on every reparse. Three rows share one weak instrument (the
// resolver mints on the first, then flags every later row against it, so
// three rows produce two identical warnings before this fix) and one
// undeclared activity type (flagged fresh every row, no caching at all, so
// three rows produce three identical warnings before this fix). All three
// also carry an unparseable process date, so nothing in this document ever
// inserts and `parsed_ok` never becomes true -- exactly the "reparse of a
// document that never fully lands" case the defect was measured against,
// not the ordinary whole-document skip.
const TAXONOMY_WITHOUT_UNKNOWN_TYPE = {
  fee: { movesCash: true, movesQuantity: false, quantitySign: "none" },
};

function weakInstrumentUndeclaredRows() {
  const instrument = { symbol: "ZZZ", cusip: null, isin: null, name: null };
  return [0, 1, 2].map((index) =>
    activityRow({
      processDate: "not-a-real-date",
      activityType: "unknown_type",
      instrument,
      locators: { row: { source: "tabular_export", index } },
    }),
  );
}

test(
  "F1-65: reimporting a document twice opens each review item once, including one row's worth of duplicates within a single import",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    const acquired = buildTabularPull("f1-65 reimport idempotence");
    const persisted = persist(t, acquired, "tabular_export");
    const buildDocuments = () =>
      adapterPullToImportDocuments(client, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        acquired,
        rows: weakInstrumentUndeclaredRows(),
        docType: "tabular_export",
        docDate: "2025-02-01",
        persisted,
        activityTaxonomy: TAXONOMY_WITHOUT_UNKNOWN_TYPE,
      });

    const first = await importBatch(
      client,
      { source: INSTITUTION.slug, documents: await buildDocuments() },
      new Date("2025-05-01"),
    );

    // Nothing landed: all three rows carry an unparseable process date, so
    // `parsed_ok` stays false and a reimport reprocesses the document in
    // full rather than taking the whole-document skip.
    assert.equal(first.rowsInserted, 0);
    assert.equal(
      (await one(client, "SELECT parsed_ok FROM documents")).parsed_ok,
      false,
    );

    // One item each, not three: the resolver mints on the first row and
    // flags the other two against it (two identical warnings), and
    // classifyActivity flags all three rows identically (three identical
    // warnings) -- the buffered insert must collapse both down to one
    // within this single import, not merely across separate runs.
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      1,
    );
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "undeclared_activity_type",
      ]),
      1,
    );
    // The unparseable date is a genuine per-row fact at three different
    // locators, so it is not a duplicate and every row keeps its own item.
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "unparseable_process_date",
      ]),
      3,
    );
    const totalAfterFirst = await count(client, "review_items");
    assert.equal(totalAfterFirst, 5);
    assert.equal(first.reviewItemsOpened, 5);

    const second = await importBatch(
      client,
      { source: INSTITUTION.slug, documents: await buildDocuments() },
      new Date("2025-05-01"),
    );

    // The reparse re-derives the identical five candidates; every one of
    // them already exists on file, so this run opens none.
    assert.equal(second.reviewItemsOpened, 0);
    assert.equal(await count(client, "review_items"), totalAfterFirst);
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      1,
    );
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "undeclared_activity_type",
      ]),
      1,
    );
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "unparseable_process_date",
      ]),
      3,
    );
  },
);

test(
  "F1-65: a resolved review item is never reopened by a reimport",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    const acquired = buildTabularPull("f1-65 resolved item stays resolved");
    const persisted = persist(t, acquired, "tabular_export");
    const buildDocuments = () =>
      adapterPullToImportDocuments(client, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        acquired,
        rows: weakInstrumentUndeclaredRows(),
        docType: "tabular_export",
        docDate: "2025-02-01",
        persisted,
        activityTaxonomy: TAXONOMY_WITHOUT_UNKNOWN_TYPE,
      });

    await importBatch(
      client,
      { source: INSTITUTION.slug, documents: await buildDocuments() },
      new Date("2025-05-01"),
    );

    const resolvedAt = "2025-06-01T00:00:00.000Z";
    await client.query(
      `UPDATE review_items
         SET status = 'resolved', resolved_at = $1, resolution_note = 'confirmed correct by a person'
       WHERE kind = 'weak_instrument_match'`,
      [resolvedAt],
    );
    const beforeReimport = await one(
      client,
      "SELECT id, status, resolved_at, resolution_note FROM review_items WHERE kind = 'weak_instrument_match'",
    );
    assert.equal(beforeReimport.status, "resolved");

    const second = await importBatch(
      client,
      { source: INSTITUTION.slug, documents: await buildDocuments() },
      new Date("2025-05-01"),
    );

    // Still exactly one weak_instrument_match item -- the reimport neither
    // reopened the resolved one nor opened a fresh duplicate next to it.
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      1,
    );
    const afterReimport = await one(
      client,
      "SELECT id, status, resolved_at, resolution_note FROM review_items WHERE kind = 'weak_instrument_match'",
    );
    assert.equal(afterReimport.id, beforeReimport.id);
    assert.equal(afterReimport.status, "resolved");
    assert.equal(
      afterReimport.resolution_note,
      "confirmed correct by a person",
    );
    assert.equal(
      second.reviewItemsOpened,
      0,
      "the reimport must not count the untouched resolved item as newly opened",
    );
  },
);

// F1-58. weak_instrument_match moves from one row per document to one row
// per (institution, descriptor, matched instrument): the decision the item
// asks for -- "confirm or correct this match" -- is about the descriptor,
// not about which statement happened to restate it. A statement restates
// its holdings every month, so under the old shape the same weak match
// opened a fresh row every month too.
test(
  "F1-58: two statements restating the same weakly matched instrument open one item with occurrence_count 2, and a third publish increments it to 3",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    // Already on file, so every row below resolves to it by symbol alone --
    // a weak match from its first sighting, not a fresh mint.
    await client.query(
      "INSERT INTO instruments (id, symbol) VALUES ('instr_zephyr', 'ZEPHYR')",
    );
    const instrument = { symbol: "ZEPHYR", cusip: null, isin: null, name: null };

    async function publishStatement(label, docDate) {
      const acquired = buildTabularPull(label);
      const documents = await adapterPullToImportDocuments(client, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        acquired,
        // A distinct processDate (and so a distinct row_hash) per statement:
        // otherwise the second statement's single row would be recognized
        // as a genuine cross_document_duplicate of the first (same content,
        // different document), which is a real and unrelated feature this
        // test does not mean to exercise.
        rows: [activityRow({ instrument, processDate: docDate })],
        docType: "tabular_export",
        docDate,
        persisted: persist(t, acquired, "tabular_export"),
      });
      return importBatch(
        client,
        { source: INSTITUTION.slug, documents },
        new Date("2025-05-01"),
      );
    }

    const weakMatchRow = () =>
      one(
        client,
        "SELECT occurrence_count, source_document_id, last_seen_document_id " +
          "FROM review_items WHERE kind = 'weak_instrument_match'",
      );

    const first = await publishStatement("f1-58 january statement", "2025-01-31");
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      1,
    );
    const afterFirst = await weakMatchRow();
    assert.equal(afterFirst.occurrence_count, 1);
    assert.equal(afterFirst.last_seen_document_id, afterFirst.source_document_id);
    assert.equal(first.reviewItemsOpened, 1);
    const firstDocId = afterFirst.source_document_id;

    const second = await publishStatement("f1-58 february statement", "2025-02-28");
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      1,
      "the same descriptor restated on a second statement folds into the same item, not a second one",
    );
    const afterSecond = await weakMatchRow();
    assert.equal(afterSecond.occurrence_count, 2);
    assert.equal(
      afterSecond.source_document_id,
      firstDocId,
      "the first sighting is unchanged",
    );
    assert.notEqual(afterSecond.last_seen_document_id, firstDocId);
    // An increment to an existing item is not a newly opened one.
    assert.equal(second.reviewItemsOpened, 0);
    const secondDocId = afterSecond.last_seen_document_id;

    const third = await publishStatement("f1-58 march statement", "2025-03-31");
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      1,
    );
    const afterThird = await weakMatchRow();
    assert.equal(afterThird.occurrence_count, 3);
    assert.equal(afterThird.source_document_id, firstDocId);
    assert.notEqual(afterThird.last_seen_document_id, secondDocId);
    assert.equal(third.reviewItemsOpened, 0);
  },
);

test(
  "F1-58: a resolved instrument-level match is never reopened or recounted by a later statement restating the same descriptor",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    await client.query(
      "INSERT INTO instruments (id, symbol) VALUES ('instr_zephyr', 'ZEPHYR')",
    );
    const instrument = { symbol: "ZEPHYR", cusip: null, isin: null, name: null };

    async function publishStatement(label, docDate) {
      const acquired = buildTabularPull(label);
      const documents = await adapterPullToImportDocuments(client, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        acquired,
        // A distinct processDate (and so a distinct row_hash) per statement:
        // otherwise the second statement's single row would be recognized
        // as a genuine cross_document_duplicate of the first (same content,
        // different document), which is a real and unrelated feature this
        // test does not mean to exercise.
        rows: [activityRow({ instrument, processDate: docDate })],
        docType: "tabular_export",
        docDate,
        persisted: persist(t, acquired, "tabular_export"),
      });
      return importBatch(
        client,
        { source: INSTITUTION.slug, documents },
        new Date("2025-05-01"),
      );
    }

    await publishStatement("f1-58 resolved january", "2025-01-31");
    await client.query(
      `UPDATE review_items
         SET status = 'resolved', resolved_at = '2025-06-01T00:00:00Z',
             resolution_note = 'confirmed correct for every statement restating this descriptor'
       WHERE kind = 'weak_instrument_match'`,
    );
    const beforeSecond = await one(
      client,
      "SELECT occurrence_count, status FROM review_items WHERE kind = 'weak_instrument_match'",
    );
    assert.equal(beforeSecond.status, "resolved");
    assert.equal(beforeSecond.occurrence_count, 1);

    const second = await publishStatement("f1-58 resolved february", "2025-02-28");

    // Still exactly one item, still resolved, still counting its original
    // sighting: resolving the mapping decides it for every row that shares
    // the descriptor, so a later restatement is neither a new item nor a
    // reason to reopen or recount the resolved one.
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      1,
    );
    const afterSecond = await one(
      client,
      "SELECT occurrence_count, status, resolution_note FROM review_items WHERE kind = 'weak_instrument_match'",
    );
    assert.equal(afterSecond.status, "resolved");
    assert.equal(afterSecond.occurrence_count, 1);
    assert.equal(
      afterSecond.resolution_note,
      "confirmed correct for every statement restating this descriptor",
    );
    assert.equal(second.reviewItemsOpened, 0);
  },
);

test(
  "F1-58: a document retried before it reaches parsed_ok does not double-count its own sighting of a weak match",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    await client.query(
      "INSERT INTO instruments (id, symbol) VALUES ('instr_zephyr', 'ZEPHYR')",
    );

    const acquired = buildTabularPull("f1-58 retried document");
    const persisted = persist(t, acquired, "tabular_export");
    const instrument = { symbol: "ZEPHYR", cusip: null, isin: null, name: null };
    const buildDocuments = () =>
      adapterPullToImportDocuments(client, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        acquired,
        // An unparseable process date alongside the weak match: this
        // document never reaches parsed_ok, so a rerun reprocesses it in
        // full rather than taking the whole-document skip -- the same setup
        // F1-65's own reimport-idempotence test above uses.
        rows: [
          activityRow({ instrument, processDate: "not-a-real-date" }),
        ],
        docType: "tabular_export",
        docDate: "2025-02-01",
        persisted,
      });

    const first = await importBatch(
      client,
      { source: INSTITUTION.slug, documents: await buildDocuments() },
      new Date("2025-05-01"),
    );
    assert.equal(
      (await one(client, "SELECT parsed_ok FROM documents")).parsed_ok,
      false,
    );
    const afterFirst = await one(
      client,
      "SELECT occurrence_count FROM review_items WHERE kind = 'weak_instrument_match'",
    );
    assert.equal(afterFirst.occurrence_count, 1);
    // The weak match plus the unparseable process date: two items opened,
    // not one.
    assert.equal(first.reviewItemsOpened, 2);

    const second = await importBatch(
      client,
      { source: INSTITUTION.slug, documents: await buildDocuments() },
      new Date("2025-05-01"),
    );
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1", [
        "weak_instrument_match",
      ]),
      1,
    );
    const afterSecond = await one(
      client,
      "SELECT occurrence_count FROM review_items WHERE kind = 'weak_instrument_match'",
    );
    assert.equal(
      afterSecond.occurrence_count,
      1,
      "the same document's own sighting must not be recorded twice",
    );
    assert.equal(second.reviewItemsOpened, 0);
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
      // F1-8e. Dated on (never after) the balance below it anchors, so this
      // fixture's own acquired history reaches back far enough that the
      // coverage-gap rule does not turn the period this test checks into an
      // unverified one instead of the pass it is testing for.
      activityRow({
        processDate: "2025-01-01",
        activityType: "fee",
        amount: "0",
      }),
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
        fee: { movesCash: true, movesQuantity: false, quantitySign: "none" },
        transfer_in_kind: {
          movesCash: false,
          movesQuantity: false,
          quantitySign: "none",
        },
      },
    });

    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );

    const review = await all(
      client,
      "SELECT kind, raw_value, reason, source_document_id FROM review_items WHERE kind = $1",
      ["cash_on_noncash_activity"],
    );
    assert.equal(review.length, 1);
    assert.equal(review[0].raw_value, "100.00");
    assert.match(review[0].reason, /movesCash: false/);
    assert.notEqual(review[0].source_document_id, null);

    // Never silently corrected: the amount is nulled, not dropped or fixed
    // to whatever value would make the period balance.
    const stored = await one(
      client,
      "SELECT amount FROM transactions WHERE account_id = $1 AND activity_type = $2",
      [ACCOUNT.id, "transfer_in_kind"],
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

    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2025-05-01"),
    );

    const review = await all(
      client,
      "SELECT kind, raw_value, reason, source_document_id FROM review_items WHERE kind = $1",
      ["activity_sign_mismatch"],
    );
    assert.equal(review.length, 1);
    assert.equal(review[0].raw_value, "5");
    assert.match(review[0].reason, /quantitySign: negative/);
    assert.notEqual(review[0].source_document_id, null);

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

test(
  "a retained_text_span_v1 binding on a position's locators reaches source_locator unchanged (F1-53)",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    const acquired = await acquirePdfStatementForHoldings();
    const persisted = persist(t, acquired, "pdf_statement");

    // A binding shaped exactly the way statementLayout.mjs (adapter-morgan-
    // stanley) emits one: no `relativePath` and no `quoteSha256`, both
    // derived at read time (pgRead.ts) from `textSha256` and `quote`.
    const binding = {
      format: "retained_text_span_v1",
      textSha256: "a".repeat(64),
      textByteLength: 500,
      textCodepointLength: 500,
      start: 120,
      end: 129,
      quote: "$1,234.56",
    };
    const marketValueLocator = {
      source: "pdf_statement",
      index: 2,
      field: "HOLDINGS / Market Value",
      binding,
    };

    const pull = {
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      acquired,
      rows: [],
      holdings: {
        positions: [
          {
            sourceDocument: "statement",
            asOf: "2026-03-31",
            instrument: {
              symbol: "WNDF",
              cusip: null,
              isin: null,
              name: "WIDGET NEUTRAL FUND",
            },
            quantity: "10",
            price: "318.4",
            marketValue: "1234.56",
            marketValueNote: null,
            costBasis: "3000",
            unrealized: "184",
            currency: "USD",
            valuationBasis: "market_price",
            valuationNote: "Market Value column of the HOLDINGS table",
            locators: {
              row: { source: "pdf_statement", index: 2 },
              marketValue: marketValueLocator,
            },
          },
        ],
        balances: [],
        liabilities: [],
      },
      docType: "pdf_statement",
      docDate: "2026-03-31",
      persisted,
    };

    const documents = await adapterPullToImportDocuments(client, pull);
    await importBatch(
      client,
      { source: INSTITUTION.slug, documents },
      new Date("2026-04-01"),
    );

    const [row] = await all(
      client,
      "SELECT source_locator FROM positions WHERE account_id = $1",
      [ACCOUNT.id],
    );
    assert.ok(row, "the position landed");
    const locators = JSON.parse(row.source_locator);
    assert.deepEqual(
      locators.marketValue.binding,
      binding,
      "the binding adapterImport.ts stores is exactly the one the parser emitted",
    );
    assert.equal(locators.marketValue.field, "HOLDINGS / Market Value");
    assert.equal(locators.marketValue.source, "pdf_statement");
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

// --- F1-76 phase 3: the same-institution symbol rule --------------------------
//
// Every test below is synthetic: two invented institutions, invented tickers,
// invented identifiers. The shape is the one the owner's archive actually has
// -- an activity feed that mints an instrument with a symbol and a cusip and no
// name, and a statement that names the same holding by symbol and name with no
// identifier at all -- because that shape is the whole reason the rule exists.

const OTHER_INSTITUTION = {
  id: "inst_mistvale",
  name: "Mistvale Securities (synthetic)",
  slug: "mistvale-securities",
};
const OTHER_ACCOUNT = { id: "acct_mistvale", last4: "0777" };

async function seedOtherInstitution(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [OTHER_INSTITUTION.id, OTHER_INSTITUTION.name, OTHER_INSTITUTION.slug],
  );
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
     VALUES ($1, $2, $3, $4, 'USD')`,
    [OTHER_ACCOUNT.id, OTHER_INSTITUTION.id, OTHER_ACCOUNT.last4, "Other account"],
  );
}

/** A statement holding: symbol and name, never an identifier -- exactly what
 * this institution's statements print. */
function statementPosition(instrument, asOf = "2025-03-31") {
  return {
    sourceDocument: "statement",
    asOf,
    instrument,
    quantity: "10",
    price: "12",
    marketValue: "120",
    marketValueNote: null,
    costBasis: "100",
    unrealized: "20",
    currency: "USD",
    valuationBasis: "market_price",
    valuationNote: null,
    locators: { row: { source: "pdf_statement", index: 1 } },
  };
}

/** One pull through the real seam and importer, the way every other test in
 * this file publishes: no hand-written ImportDocument anywhere. */
async function publish(
  t,
  client,
  { label, institutionId, accountId, rows = [], positions = [], docDate },
) {
  const acquired = buildTabularPull(label);
  const documents = await adapterPullToImportDocuments(client, {
    institutionId,
    accountId,
    acquired,
    rows,
    holdings: { positions, balances: [], liabilities: [] },
    docType: "tabular_export",
    docDate,
    persisted: persist(t, acquired, "tabular_export"),
  });
  return importBatch(
    client,
    { source: "synthetic", documents },
    new Date("2025-05-01"),
  );
}

/** The activity feed's descriptor: a symbol and a cusip, and no name at all. */
const FEED = { symbol: "ZZZ", cusip: "111111ZZ1", isin: null, name: null };
/** The statement's descriptor for the same holding: symbol and name, nothing
 * that identifies it. */
const STATEMENT = {
  symbol: "ZZZ",
  cusip: null,
  isin: null,
  name: "Synthetic Zephyr Fund",
};

/** This institution's activity feed, which is what mints the instrument and
 * establishes its cusip under this institution's own rows. */
function feedPull(t, client, label, overrides = {}) {
  return publish(t, client, {
    label,
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    rows: [activityRow({ instrument: FEED, processDate: "2025-01-15", ...overrides })],
    docDate: "2025-01-31",
  });
}

const matchItems = (client) =>
  all(
    client,
    `SELECT kind, status, reason_code, institution_id, matched_instrument_id, resolution_note
       FROM review_items
      WHERE kind IN ('weak_instrument_match', 'institution_symbol_match')
      ORDER BY kind`,
  );

test(
  "F1-76: a statement holding matched by symbol alone is accepted when the same institution supplied the identifier, under its own kind, and fills the missing name",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    await feedPull(t, client, "f1-76 activity feed");
    const instrumentId = (
      await one(client, "SELECT id, name FROM instruments")
    ).id;

    const summary = await publish(t, client, {
      label: "f1-76 march statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });

    assert.equal(
      await count(client, "instruments"),
      1,
      "the statement holding resolves to the feed's instrument rather than minting a second",
    );
    const items = await matchItems(client);
    assert.equal(items.length, 1);
    assert.deepEqual(
      {
        kind: items[0].kind,
        status: items[0].status,
        reasonCode: items[0].reason_code,
        institutionId: items[0].institution_id,
        instrumentId: items[0].matched_instrument_id,
      },
      {
        kind: "institution_symbol_match",
        status: "resolved",
        reasonCode: INSTITUTION_SYMBOL_RULE,
        institutionId: INSTITUTION.id,
        instrumentId,
      },
    );
    assert.equal(summary.instrumentMatches.accepted, 1);
    assert.equal(
      Object.values(summary.instrumentMatches.refused).reduce((a, b) => a + b),
      0,
    );
    // The institution vouches for both halves, so the name it prints is this
    // instrument's name -- the same never-overwrite fill a cusip-strong match
    // performs.
    assert.equal(
      (await one(client, "SELECT name FROM instruments WHERE id = $1", [instrumentId]))
        .name,
      STATEMENT.name,
    );
  },
);

test(
  "F1-76: a symbol two instruments share is refused and stays flagged, naming the condition that failed",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);

    await feedPull(t, client, "f1-76 ambiguous feed one");
    // A second instrument under the same ticker, from the same institution.
    // Nothing about the rule can say which one a bare symbol means.
    await feedPull(t, client, "f1-76 ambiguous feed two", {
      instrument: { ...FEED, cusip: "222222ZZ2" },
      processDate: "2025-01-16",
    });
    assert.equal(await count(client, "instruments"), 2);

    const summary = await publish(t, client, {
      label: "f1-76 ambiguous statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });

    const items = await matchItems(client);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "weak_instrument_match");
    assert.equal(items[0].status, "open");
    assert.equal(items[0].reason_code, "symbol_matches_several_instruments");
    assert.equal(summary.instrumentMatches.accepted, 0);
    assert.equal(
      summary.instrumentMatches.refused.symbol_matches_several_instruments,
      1,
    );
  },
);

test(
  "F1-76: an identifier only another institution's rows vouch for is refused, and so is a holding from another institution",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    await seedOtherInstitution(client);

    // The instrument and its cusip come from the other institution's feed.
    await publish(t, client, {
      label: "f1-76 other institution feed",
      institutionId: OTHER_INSTITUTION.id,
      accountId: OTHER_ACCOUNT.id,
      rows: [activityRow({ instrument: FEED, processDate: "2025-01-15" })],
      docDate: "2025-01-31",
    });

    // Condition 2 from this institution's side: the identifier came from
    // somewhere else, so this institution is vouching for nothing.
    const foreignIdentifier = await publish(t, client, {
      label: "f1-76 statement against a foreign identifier",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });
    assert.equal(foreignIdentifier.instrumentMatches.accepted, 0);
    assert.equal(
      foreignIdentifier.instrumentMatches.refused
        .instrument_vouched_by_another_institution,
      1,
    );
    const afterForeign = await matchItems(client);
    assert.equal(afterForeign.length, 1);
    assert.equal(afterForeign[0].kind, "weak_instrument_match");
    assert.equal(afterForeign[0].institution_id, INSTITUTION.id);

    // Condition 3 from the other side, in a fresh archive so the two refusals
    // cannot be read out of each other: the identifier is this institution's,
    // and the holding is not.
    const second = await archive(t);
    await seedPg(second);
    await seedOtherInstitution(second);
    await feedPull(t, second, "f1-76 home feed");
    const foreignHolding = await publish(t, second, {
      label: "f1-76 foreign holding",
      institutionId: OTHER_INSTITUTION.id,
      accountId: OTHER_ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });
    assert.equal(foreignHolding.instrumentMatches.accepted, 0);
    assert.equal(
      foreignHolding.instrumentMatches.refused
        .instrument_vouched_by_another_institution,
      1,
    );
    const items = await matchItems(second);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "weak_instrument_match");
    assert.equal(
      items[0].institution_id,
      OTHER_INSTITUTION.id,
      "the refusal belongs to the institution whose holding was refused",
    );
  },
);

test(
  "F1-76: an instrument nothing references yet, and one with no identifier at all, are both refused by name",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    // A cusip on file that no stored row vouches for: nothing in this archive
    // says where it came from.
    await client.query(
      "INSERT INTO instruments (id, symbol, cusip) VALUES ('instr_unreferenced', 'ZZZ', '111111ZZ1')",
    );
    const unreferenced = await publish(t, client, {
      label: "f1-76 unreferenced identifier",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });
    assert.equal(
      unreferenced.instrumentMatches.refused
        .instrument_has_no_institution_evidence,
      1,
    );

    const second = await archive(t);
    await seedPg(second);
    // Referenced by this institution, but with no cusip or isin: there is no
    // identifier for the institution to have vouched for.
    await feedPull(t, second, "f1-76 identifierless feed", {
      instrument: { symbol: "ZZZ", cusip: null, isin: null, name: null },
    });
    const identifierless = await publish(t, second, {
      label: "f1-76 identifierless statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });
    assert.equal(
      identifierless.instrumentMatches.refused
        .instrument_has_no_strong_identifier,
      1,
    );
  },
);

test(
  "F1-76: a reparse of an already-imported statement resolves the open weak item the rule now accepts, naming the rule, and never deletes it",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    // The instrument and its cusip are on file, but nothing references them
    // yet -- so the first import of this statement is refused and flagged,
    // exactly as every statement holding is today.
    await client.query(
      "INSERT INTO instruments (id, symbol, cusip) VALUES ('instr_zephyr', 'ZZZ', '111111ZZ1')",
    );
    const statement = {
      label: "f1-76 reparsed statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    };
    await publish(t, client, statement);
    const flagged = await matchItems(client);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].kind, "weak_instrument_match");
    assert.equal(flagged[0].status, "open");

    // The feed lands, which is what makes the institution's own data vouch for
    // the identifier.
    await feedPull(t, client, "f1-76 late feed");

    // The same bytes again: the document is already parsed_ok, so this is the
    // whole-document skip a whole-archive reparse takes.
    const reparse = await publish(t, client, statement);
    assert.equal(reparse.instrumentMatches.accepted, 1);
    assert.equal(reparse.instrumentMatches.resolvedByRule, 1);
    assert.equal(reparse.reviewItemsResolved, 1);

    const after = await matchItems(client);
    assert.equal(after.length, 2, "the weak item is resolved, never deleted");
    const weak = after.find((item) => item.kind === "weak_instrument_match");
    const accepted = after.find(
      (item) => item.kind === "institution_symbol_match",
    );
    assert.equal(weak.status, "resolved");
    assert.equal(weak.reason_code, INSTITUTION_SYMBOL_RULE);
    assert.match(weak.resolution_note, new RegExp(INSTITUTION_SYMBOL_RULE));
    assert.equal(accepted.status, "resolved");

    // Reparsed again: the same conclusion adds nothing.
    const again = await publish(t, client, statement);
    assert.equal(again.instrumentMatches.resolvedByRule, 0);
    assert.equal(again.instrumentMatches.invalidated, 0);
    assert.deepEqual(await matchItems(client), after);
  },
);

test(
  "F1-76: a later import that makes an accepted match unsafe withdraws it and flags it again, rather than leaving it accepted on stale evidence",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    await feedPull(t, client, "f1-76 self-correction feed");
    await publish(t, client, {
      label: "f1-76 self-correction statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });
    assert.equal(
      await count(client, "review_items", "WHERE kind = $1 AND status = $2", [
        "institution_symbol_match",
        "resolved",
      ]),
      1,
    );

    // A second instrument appears under the same ticker. Condition 1 stopped
    // holding, and it stopped holding on this import.
    const later = await feedPull(t, client, "f1-76 colliding feed", {
      instrument: { ...FEED, cusip: "222222ZZ2" },
      processDate: "2025-02-15",
    });
    assert.equal(later.instrumentMatches.invalidated, 1);

    const items = await matchItems(client);
    const accepted = items.find(
      (item) => item.kind === "institution_symbol_match",
    );
    const weak = items.find((item) => item.kind === "weak_instrument_match");
    assert.equal(accepted.status, "dismissed");
    assert.match(accepted.resolution_note, /withdrawn/);
    assert.equal(weak.status, "open");
    assert.equal(weak.reason_code, INSTITUTION_SYMBOL_INVALIDATED);
  },
);

test(
  "F1-76: another institution's rows arriving on an accepted instrument withdraw the acceptance too",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    await seedOtherInstitution(client);
    await feedPull(t, client, "f1-76 shared instrument feed");
    await publish(t, client, {
      label: "f1-76 shared instrument statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });

    // The other institution's feed names the same cusip, so its rows land on
    // the same instrument and provenance stops being one institution's.
    const shared = await publish(t, client, {
      label: "f1-76 other institution shares the instrument",
      institutionId: OTHER_INSTITUTION.id,
      accountId: OTHER_ACCOUNT.id,
      rows: [activityRow({ instrument: FEED, processDate: "2025-02-20" })],
      docDate: "2025-02-28",
    });
    assert.equal(shared.instrumentMatches.invalidated, 1);

    const items = await matchItems(client);
    assert.equal(
      items.find((item) => item.kind === "institution_symbol_match").status,
      "dismissed",
    );
    const weak = items.find((item) => item.kind === "weak_instrument_match");
    assert.equal(weak.status, "open");
    assert.equal(weak.reason_code, INSTITUTION_SYMBOL_INVALIDATED);
  },
);

test(
  "F1-76: every reason code carries a fixed explanation and action, and none of them quotes the archive",
  { skip: false },
  () => {
    for (const code of INSTRUMENT_MATCH_REASON_CODES) {
      const text = INSTRUMENT_MATCH_REASON_TEXT[code];
      assert.ok(text.explanation.length > 0 && text.action.length > 0, code);
      // Fixed literals only: a queue can print these without becoming a second
      // place the owner's data lives.
      assert.doesNotMatch(
        `${text.explanation} ${text.action}`,
        /[0-9]{4}|\$/,
        code,
      );
    }
    assert.equal(
      new Set(INSTRUMENT_MATCH_REASON_CODES).size,
      INSTRUMENT_MATCH_REASON_CODES.length,
    );
  },
);

test(
  "F1-76: a refused match's own position is never evidence for the next one, so no evidence stays no evidence across imports and reparses",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    // A cusip on file that no descriptor in this archive ever stated. The rule
    // must refuse it, and must keep refusing it however many statements land:
    // each refused statement writes its own `positions` row referencing the
    // instrument, and if a position counted as evidence the second statement
    // would accept the very match the first one was refused, with no feed
    // having vouched for anything.
    await client.query(
      "INSERT INTO instruments (id, symbol, cusip) VALUES ('instr_zephyr', 'ZZZ', '111111ZZ1')",
    );
    const statement = (label, docDate) => ({
      label,
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT, docDate)],
      docDate,
    });

    const first = await publish(t, client, statement("f1-76 circular one", "2025-03-31"));
    assert.equal(
      first.instrumentMatches.refused.instrument_has_no_institution_evidence,
      1,
    );
    assert.ok((await count(client, "positions")) > 0);

    const second = await publish(t, client, statement("f1-76 circular two", "2025-04-30"));
    assert.equal(second.instrumentMatches.accepted, 0);
    assert.equal(
      second.instrumentMatches.refused.instrument_has_no_institution_evidence,
      1,
    );

    const reparse = await publish(t, client, statement("f1-76 circular one", "2025-03-31"));
    assert.equal(reparse.instrumentMatches.accepted, 0);

    const items = await matchItems(client);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "weak_instrument_match");
    assert.equal(items[0].status, "open");
    assert.equal(items[0].reason_code, "instrument_has_no_institution_evidence");
    assert.equal(await count(client, "instrument_identifier_sources"), 0);
  },
);

test(
  "F1-76: two symbols differing only by case or padding count as one shared symbol, and refuse",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    await feedPull(t, client, "f1-76 case feed");
    // Same ticker, differently spelled. Nothing about a bare symbol can say
    // which of the two a holding means, so the rule must refuse rather than
    // read two unique symbols where there is one.
    await feedPull(t, client, "f1-76 case variant feed", {
      instrument: { symbol: " zzz ", cusip: "222222ZZ2", isin: null, name: null },
      processDate: "2025-01-16",
    });
    assert.equal(await count(client, "instruments"), 2);

    const summary = await publish(t, client, {
      label: "f1-76 case statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });
    assert.equal(summary.instrumentMatches.accepted, 0);
    assert.equal(
      summary.instrumentMatches.refused.symbol_matches_several_instruments,
      1,
    );
  },
);

test(
  "F1-76: a withdrawal always leaves an open item, even over a dismissal, and a reparse never overwrites the reason that says so",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    await client.query(
      "INSERT INTO instruments (id, symbol, cusip) VALUES ('instr_zephyr', 'ZZZ', '111111ZZ1')",
    );
    // A descriptor with no name at all, so every reparse re-derives the match
    // through the rule rather than short-circuiting on the (symbol AND name)
    // tier -- which is what makes the reason-preservation assertion below test
    // anything.
    const statement = {
      label: "f1-76 dismissal statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [
        statementPosition({ symbol: "ZZZ", cusip: null, isin: null, name: null }),
      ],
      docDate: "2025-03-31",
    };
    await publish(t, client, statement);
    // A person answers the question the weak item asked.
    await client.query(
      "UPDATE review_items SET status = 'dismissed' WHERE kind = 'weak_instrument_match'",
    );

    await feedPull(t, client, "f1-76 dismissal feed");
    await publish(t, client, statement);
    assert.equal(
      (await one(client, "SELECT status FROM review_items WHERE kind = 'institution_symbol_match'"))
        .status,
      "resolved",
    );

    // The evidence the dismissal was given changes. That is a new question,
    // not the old one asked again, so the item is open regardless.
    const later = await feedPull(t, client, "f1-76 dismissal collision", {
      instrument: { ...FEED, cusip: "222222ZZ2" },
      processDate: "2025-02-15",
    });
    assert.equal(later.instrumentMatches.invalidated, 1);
    const weak = () =>
      one(
        client,
        "SELECT status, reason_code FROM review_items WHERE kind = 'weak_instrument_match'",
      );
    assert.deepEqual(await weak(), {
      status: "open",
      reason_code: INSTITUTION_SYMBOL_INVALIDATED,
    });

    // A reparse re-derives the ordinary refusal for the same match. It must
    // not overwrite the reason that says this archive took an acceptance back.
    const reparse = await publish(t, client, statement);
    assert.equal(
      reparse.instrumentMatches.refused.symbol_matches_several_instruments,
      1,
    );
    assert.deepEqual(await weak(), {
      status: "open",
      reason_code: INSTITUTION_SYMBOL_INVALIDATED,
    });
  },
);

test(
  "F1-76: a withdrawn acceptance is not re-established through the name the rule taught",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedPg(client);
    await feedPull(t, client, "f1-76 name tier feed");
    await publish(t, client, {
      label: "f1-76 name tier statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT)],
      docDate: "2025-03-31",
    });
    const instrumentId = (
      await one(client, "SELECT id FROM instruments WHERE cusip = '111111ZZ1'")
    ).id;
    // The acceptance filled the name, so every later statement now matches on
    // (symbol AND name) and never reaches the rule again.
    assert.equal(
      (await one(client, "SELECT name FROM instruments WHERE id = $1", [instrumentId]))
        .name,
      STATEMENT.name,
    );

    await feedPull(t, client, "f1-76 name tier collision", {
      instrument: { ...FEED, cusip: "222222ZZ2" },
      processDate: "2025-02-15",
    });

    // A later statement resolves through the name tier, which opens nothing.
    // The downgrade still holds, because it is recorded against the instrument
    // and institution rather than against whichever tier matched a position.
    const later = await publish(t, client, {
      label: "f1-76 name tier later statement",
      institutionId: INSTITUTION.id,
      accountId: ACCOUNT.id,
      positions: [statementPosition(STATEMENT, "2025-04-30")],
      docDate: "2025-04-30",
    });
    assert.equal(later.instrumentMatches.accepted, 0);

    const items = await matchItems(client);
    assert.equal(
      items.find((item) => item.kind === "institution_symbol_match").status,
      "dismissed",
      "the acceptance stays withdrawn",
    );
    const weak = items.find((item) => item.kind === "weak_instrument_match");
    assert.equal(weak.status, "open");
    assert.equal(weak.reason_code, INSTITUTION_SYMBOL_INVALIDATED);
    // Which is exactly what the read surface keys the ambiguous state on.
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = $1 AND status = 'open' AND matched_instrument_id = $2 AND institution_id = $3",
        ["weak_instrument_match", instrumentId, INSTITUTION.id],
      ),
      1,
    );
  },
);
