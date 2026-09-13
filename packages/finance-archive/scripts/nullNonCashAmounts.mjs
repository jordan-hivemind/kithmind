#!/usr/bin/env node
// F1-8d. Applies an adapter's *current* `activityTaxonomy` to transaction
// rows that were already stored under an older one: every row whose activity
// type is now declared `movesCash: false` but still carries an amount has the
// amount nulled and a `cash_on_noncash_activity` review item opened, exactly
// as `classifyActivity` (adapterImport.ts) would have done had the
// declaration existed when the row landed. The cash gate then no longer sums
// that amount as cash.
//
// Why a script and not a reparse. Three code paths could in principle carry a
// taxonomy change onto stored rows, and none of them does:
//
//   1. `run.ts reparse` is scoped to `REPARSEABLE_TIERS` --
//      `pdf_statement` and `trade_confirmation` only. A structured activity
//      pull (`ms-activity-3`, `doc_type = 'activity_pull'`) can split one
//      retained file across several `documents` rows sharing one
//      `retained_sha256`, so `openRetainedDocument` returns null for it and
//      the walk counts it in `documentsSkippedTier`. Rows that came from an
//      activity pull are never re-parsed at all.
//   2. Even re-imported, an activity row carries a provider id
//      (`provider_txn_id`, the site's `activityId`), and `importRows`
//      (importer.ts) treats a provider-id match as "an authoritative identity
//      match": `rowsDeduplicated += 1; continue`. It is a skip. Nothing in
//      `src/` issues an `UPDATE transactions` at all, so no re-import of any
//      kind rewrites a stored row's amount.
//   3. Nulling the amount also changes what `rowHash` would hash (amount is
//      in its preimage), so a row *without* a provider id would not
//      deduplicate at all -- it would insert a second row. That is worse than
//      skipping, and it is not what happens here only because every row in
//      scope has a provider id.
//
// So the change has to be applied directly, once, and this is that. It reads
// the taxonomy from the adapter rather than naming activity types, so it
// cannot drift from the declaration it is applying and it serves the next
// declaration too.
//
// ponytail: amounts only, not quantities. `classifyActivity` also nulls a
// quantity on a `movesQuantity: false` type, and this script deliberately
// leaves stored quantities alone: that moves the *position* gate, which is a
// separate gate with separate evidence behind it. Widen this to quantities
// when a task has measured that gate the way F1-8d measured the cash one.
//
// ponytail: `row_hash` is left as it was. It is now the hash of the row's
// pre-fix content, which is only a dedupe fallback for rows carrying no
// provider id -- and this script reports the count of in-scope rows without
// one so a future archive where that is not zero is visible rather than
// assumed. Recomputing the hashes instead would have to re-derive every
// row's per-document occurrence ordinal (two rows differing only in an amount
// collapse to one content key once both amounts are null), and getting that
// wrong breaks the `row_hash` UNIQUE invariant rather than a fallback.
//
// Usage (development-first: point this at a throwaway database before a
// hosted one, same as scripts/collapseWeakInstrumentMatches.mjs):
//
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//     node scripts/nullNonCashAmounts.mjs --adapter <module path> --dry-run
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//     node scripts/nullNonCashAmounts.mjs --adapter <module path>
//
// A non-dry run ends with a cash-gate pass scoped to the rows it changed, so
// the verdicts for exactly those periods are rewritten in the same
// transaction. Nothing else is re-gated.

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
  insertRows,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "../dist/pgStore.js";
import { fromNumericText } from "../dist/pgNumeric.js";
import { REVIEW_COLUMNS } from "../dist/importer.js";
import { cashEffectiveDate, runReconciliationGate } from "../dist/reconciliation.js";

/** The exact `cash_on_noncash_activity` wording `classifyActivity`
 * (adapterImport.ts) opens with. Duplicated as a template rather than
 * imported because that function is private to its module; the shape is
 * asserted against a stored item in test/nullNonCashAmounts.test.mjs. */
function cashOnNonCashReason(activityType, amount) {
  return (
    `activity type "${activityType}" is declared movesCash: false, but this row ` +
    `carries a non-null amount ("${amount}"); nulling the amount rather than silently ` +
    "correcting it"
  );
}

/** `review_items_dedupe_key`'s own identity (pgSchema.ts), with
 * `source_locator` coalesced to `""` the same way the index's expression
 * coalesces it, so this never disagrees with what INSERT will accept. */
function reviewDedupeKey(kind, sourceDocumentId, sourceLocator, rawValue) {
  return JSON.stringify([kind, sourceDocumentId, sourceLocator ?? "", rawValue]);
}

/**
 * Nulls the amount on every stored transaction whose activity type the
 * adapter now declares non-cash, and opens the review item each one earns.
 * `dryRun` finds and reports everything and writes nothing.
 *
 * Exported so the test can drive it against a throwaway schema instead of
 * shelling out to this file.
 */
export async function nullNonCashAmounts(
  client,
  { institutionSlug, activityTaxonomy },
  { dryRun = false } = {},
) {
  const nonCashTypes = Object.entries(activityTaxonomy ?? {})
    .filter(([, entry]) => entry.movesCash === false)
    .map(([activityType]) => activityType);

  return withArchiveTransaction(client, async (tx) => {
    await lockArchiveForWrite(tx);

    const empty = {
      nonCashTypes: nonCashTypes.length,
      rows: 0,
      accounts: 0,
      documents: 0,
      reviewItemsOpened: 0,
      reviewItemsAlreadyOpen: 0,
      rowsWithoutProviderId: 0,
      periodsRegated: 0,
      periodsPassed: 0,
      periodsFailed: 0,
      periodsUnverified: 0,
      byActivityType: [],
    };
    if (nonCashTypes.length === 0) return empty;

    // The institution the adapter speaks for, and no other: another
    // institution can spell the same activity value and mean something else.
    const institution = await tx.query(
      "SELECT id FROM institutions WHERE slug = $1",
      [institutionSlug],
    );
    const institutionId = institution.rows[0]?.id;
    if (institutionId === undefined) return empty;

    const { rows } = await tx.query(
      `SELECT t.id, t.account_id, t.activity_type, t.amount,
              t.process_date, t.settle_date,
              t.source_document_id, t.source_locator,
              t.provider_txn_id
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.institution_id = $1
          AND t.activity_type = ANY($2::text[])
          AND t.amount IS NOT NULL
        ORDER BY t.id`,
      [institutionId, nonCashTypes],
    );
    if (rows.length === 0) return { ...empty, nonCashTypes: nonCashTypes.length };

    const byActivityType = new Map();
    const accounts = new Set();
    const documents = new Set();
    let rowsWithoutProviderId = 0;
    const candidates = [];
    for (const row of rows) {
      byActivityType.set(
        row.activity_type,
        (byActivityType.get(row.activity_type) ?? 0) + 1,
      );
      accounts.add(row.account_id);
      if (row.source_document_id !== null) documents.add(row.source_document_id);
      if (row.provider_txn_id === null) rowsWithoutProviderId += 1;
      // The canonical decimal text `classifyActivity` would have seen, which
      // is what it puts in `raw_value`: NUMERIC's own spelling carries the
      // column's scale, and an uncanonical spelling here would open an item
      // that a later run of this same script does not recognize as its own.
      candidates.push({ ...row, rawValue: fromNumericText(row.amount) });
    }

    // Only items scoped to a document have an identity to dedupe against --
    // the same distinction `flushReviews` (importer.ts) and
    // `review_items_dedupe_key` both draw. An in-scope row with no document
    // opens a fresh item, exactly as it always has.
    const alreadyOpen = new Set();
    if (documents.size > 0) {
      const existing = await tx.query(
        `SELECT source_document_id, source_locator, raw_value
           FROM review_items
          WHERE kind = 'cash_on_noncash_activity'
            AND source_document_id = ANY($1::text[])`,
        [[...documents]],
      );
      for (const item of existing.rows) {
        alreadyOpen.add(
          reviewDedupeKey(
            "cash_on_noncash_activity",
            item.source_document_id,
            item.source_locator,
            item.raw_value,
          ),
        );
      }
    }

    const toInsert = [];
    let reviewItemsAlreadyOpen = 0;
    for (const row of candidates) {
      const key =
        row.source_document_id === null
          ? null
          : reviewDedupeKey(
              "cash_on_noncash_activity",
              row.source_document_id,
              row.source_locator,
              row.rawValue,
            );
      if (key !== null && alreadyOpen.has(key)) {
        reviewItemsAlreadyOpen += 1;
        continue;
      }
      if (key !== null) alreadyOpen.add(key);
      toInsert.push([
        randomUUID(),
        "cash_on_noncash_activity",
        row.account_id,
        row.source_document_id,
        row.source_locator,
        row.rawValue,
        cashOnNonCashReason(row.activity_type, row.rawValue),
      ]);
    }

    const report = {
      nonCashTypes: nonCashTypes.length,
      rows: candidates.length,
      accounts: accounts.size,
      documents: documents.size,
      reviewItemsOpened: toInsert.length,
      reviewItemsAlreadyOpen,
      rowsWithoutProviderId,
      periodsRegated: 0,
      periodsPassed: 0,
      periodsFailed: 0,
      periodsUnverified: 0,
      byActivityType: [...byActivityType.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    };
    if (dryRun) return report;

    await tx.query("UPDATE transactions SET amount = NULL WHERE id = ANY($1::text[])", [
      candidates.map((row) => row.id),
    ]);
    await insertRows(tx, "review_items", REVIEW_COLUMNS, toInsert);

    // The periods those rows sat in, and no others. Keyed by the row's
    // cash-effective date because that is the date the gate's own window
    // places it on; keying by `process_date` would miss the period a row
    // settling later actually moved. `snapshots` is empty: no stated balance
    // changed here.
    const gate = await runReconciliationGate(tx, undefined, {
      snapshots: [],
      activity: candidates.map((row) => ({
        accountId: row.account_id,
        date: cashEffectiveDate(row.process_date, row.settle_date),
      })),
    });
    return {
      ...report,
      periodsRegated: gate.periodsChecked,
      periodsPassed: gate.passed,
      periodsFailed: gate.failed,
      periodsUnverified: gate.unverified,
    };
  });
}

async function loadCapabilities(path) {
  const specifier = /^[./]/.test(path) ? pathToFileURL(path).href : path;
  const module = await import(specifier);
  const adapter = module.default ?? module.adapter;
  if (!adapter || typeof adapter.capabilities !== "function") {
    throw new Error(
      `${path} has no default export or named "adapter" export implementing InstitutionAdapter`,
    );
  }
  return adapter.capabilities();
}

async function main() {
  const { values } = parseArgs({
    options: {
      adapter: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.adapter) throw new Error("--adapter <module path> is required");
  const dryRun = values["dry-run"] === true;

  const capabilities = await loadCapabilities(values.adapter);
  const client = createArchiveClient(archiveDatabaseUrl(), archiveSchemaName());
  await client.connect();
  try {
    const report = await nullNonCashAmounts(client, capabilities, { dryRun });
    console.log(`mode: nullNonCashAmounts${dryRun ? " (dry run)" : ""}`);
    console.log(`institution: ${capabilities.institutionSlug}`);
    console.log(`activity types declared movesCash: false: ${report.nonCashTypes}`);
    console.log(
      `rows ${dryRun ? "that would have their amount nulled" : "with amount nulled"}: ${report.rows}`,
    );
    for (const [activityType, count] of report.byActivityType) {
      console.log(`  ${activityType}: ${count}`);
    }
    console.log(`accounts touched: ${report.accounts}`);
    console.log(`documents touched: ${report.documents}`);
    console.log(
      `cash_on_noncash_activity items ${dryRun ? "that would be opened" : "opened"}: ${report.reviewItemsOpened}`,
    );
    console.log(
      `items already open for the same row (left alone): ${report.reviewItemsAlreadyOpen}`,
    );
    if (report.rowsWithoutProviderId > 0) {
      console.log(
        `rows in scope carrying no provider_txn_id: ${report.rowsWithoutProviderId} ` +
          "(their row_hash no longer matches their content; see this file's header)",
      );
    }
    if (report.rows === 0) {
      console.log("nothing to null");
    } else if (dryRun) {
      console.log("re-run without --dry-run to apply this and re-gate those periods");
    } else {
      console.log(
        `cash-gate periods re-checked: ${report.periodsRegated} ` +
          `(pass ${report.periodsPassed}, fail ${report.periodsFailed}, ` +
          `unverified ${report.periodsUnverified})`,
      );
      console.log("done");
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
