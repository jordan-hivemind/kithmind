// F1-8d. scripts/nullNonCashAmounts.mjs against a real, throwaway archive.
//
// The shape is the one the owner's archive holds and no reparse can reach: an
// in-kind journal between two accounts, booked as a delivery row on one
// account and a receipt row on the other, each carrying the value journalled
// as its `amount` and a `provider_txn_id`. The adapter now declares those two
// activity types `movesCash: false`, but the rows landed before it did, and a
// re-import skips them on their provider id (importer.ts, `importRows`)
// rather than rewriting them -- so the amount has to be nulled here.
//
// What this asserts: the amount is nulled, one `cash_on_noncash_activity`
// item is opened per row with the exact wording and `raw_value`
// `classifyActivity` (adapterImport.ts) uses, cash-moving rows of the same
// institution are untouched, a period that failed only because of the
// journalled value now passes, a dry run writes nothing, and a second run
// changes nothing.

import assert from "node:assert/strict";
import test from "node:test";

import { createArchiveClient } from "../dist/pgStore.js";
import { applyPgSchema } from "../dist/pgSchema.js";

import { nullNonCashAmounts } from "../scripts/nullNonCashAmounts.mjs";

import { all, one, skip, testSchemaName } from "./helpers/pgArchive.mjs";

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;

// The adapter capabilities the script reads, reduced to what it uses. The two
// journal types are non-cash; `Service Fee` is cash-moving and must survive.
const CAPABILITIES = {
  institutionSlug: "rowan-trust",
  activityTaxonomy: {
    "Transfer out of Account": { movesCash: false, movesQuantity: true, quantitySign: "negative" },
    "Transfer into Account": { movesCash: false, movesQuantity: true, quantitySign: "positive" },
    "Service Fee": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  },
};

async function archive(t) {
  const schema = testSchemaName();
  const client = createArchiveClient(url, schema);
  await client.connect();
  await applyPgSchema(client, schema);
  t.after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });
  return client;
}

/**
 * Two accounts at one institution, one activity-pull document, and one
 * statement period on the delivery account whose stated cash change is
 * explained by its fee alone -- so the period fails for exactly as long as the
 * journalled value is counted as cash, and passes once it is not.
 *
 *   stated cash: 10,000.00 -> 9,955.00, a change of -45.00
 *   activity in the window: Service Fee -45.00 (cash)
 *                           Transfer out of Account -41,250.75 (in kind)
 *   computed change while the journal counts: -41,295.75, delta -41,250.75
 */
async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ('inst-1', 'Rowan Trust', 'rowan-trust')",
  );
  await client.query(
    `INSERT INTO accounts (id, institution_id, external_key, base_currency) VALUES
       ('acct-out', 'inst-1', 'ROWAN-1', 'USD'),
       ('acct-in', 'inst-1', 'ROWAN-2', 'USD')`,
  );
  await client.query(
    "INSERT INTO instruments (id, symbol) VALUES ('instr-rwngx', 'RWNGX')",
  );
  await client.query(
    `INSERT INTO documents (id, institution_id, doc_type, doc_date, file_path, sha256) VALUES
       ('doc-pull', 'inst-1', 'activity_pull', DATE '2025-04-30', '/raw/doc-pull', $1)`,
    ["a".repeat(64)],
  );
  await client.query(
    `INSERT INTO balances (id, account_id, as_of, cash, currency, source_document_id, row_hash) VALUES
       ('bal-mar', 'acct-out', DATE '2025-03-31', 10000.00, 'USD', 'doc-pull', 'hash:bal:mar'),
       ('bal-apr', 'acct-out', DATE '2025-04-30', 9955.00, 'USD', 'doc-pull', 'hash:bal:apr')`,
  );
  await client.query(
    `INSERT INTO transactions
       (id, account_id, process_date, settle_date, date_precision, activity_type,
        description, instrument_id, amount, currency, source_document_id,
        source_locator, row_hash, provider_txn_id, imported_at)
     VALUES
       -- F1-8e. Processed on (never after) bal-mar's own date, settled on
       -- the date it actually posted: this fixture's own acquired history
       -- then reaches back far enough that the cash gate's coverage-gap
       -- rule does not turn the period this test checks into an unverified
       -- one instead of the pass it is testing for, while the row's
       -- cash-effective date (the later of the two, unchanged) still lands
       -- inside the window exactly as before.
       ('txn-out', 'acct-out', DATE '2025-03-31', DATE '2025-04-18', 'day',
        'Transfer out of Account', 'JOURNAL OUT', 'instr-rwngx', -41250.75, 'USD',
        'doc-pull', 'structured_api:0', 'hash:txn:out', 'ACT-ROWAN-000001', now()),
       ('txn-in', 'acct-in', DATE '2025-04-18', DATE '2025-04-18', 'day',
        'Transfer into Account', 'JOURNAL IN', 'instr-rwngx', 41250.75, 'USD',
        'doc-pull', 'structured_api:1', 'hash:txn:in', 'ACT-ROWAN-000002', now()),
       ('txn-fee', 'acct-out', DATE '2025-04-20', DATE '2025-04-20', 'day',
        'Service Fee', 'ADVISORY FEE', NULL, -45.00, 'USD',
        'doc-pull', 'structured_api:2', 'hash:txn:fee', 'ACT-ROWAN-000003', now())`,
  );
}

test(
  "nullNonCashAmounts nulls a stored in-kind journal's amount, opens the item adapterImport would, and turns the period it broke into a pass",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    const dryRun = await nullNonCashAmounts(client, CAPABILITIES, { dryRun: true });
    assert.equal(dryRun.rows, 2, "both journal rows, and only those, are in scope");
    assert.equal(dryRun.accounts, 2);
    assert.equal(dryRun.reviewItemsOpened, 2);
    assert.equal(dryRun.reviewItemsAlreadyOpen, 0);
    assert.equal(dryRun.rowsWithoutProviderId, 0);
    assert.deepEqual(dryRun.byActivityType, [
      ["Transfer into Account", 1],
      ["Transfer out of Account", 1],
    ]);

    const afterDryRun = await one(
      client,
      "SELECT count(*)::text AS amounts, (SELECT count(*)::text FROM review_items) AS items FROM transactions WHERE amount IS NOT NULL",
    );
    assert.equal(afterDryRun.amounts, "3", "a dry run nulls nothing");
    assert.equal(afterDryRun.items, "0", "a dry run opens nothing");

    const report = await nullNonCashAmounts(client, CAPABILITIES, { dryRun: false });
    assert.equal(report.rows, 2);
    assert.equal(report.reviewItemsOpened, 2);

    const amounts = await all(
      client,
      "SELECT id, amount FROM transactions ORDER BY id",
    );
    assert.deepEqual(
      amounts.map((row) => [row.id, row.amount]),
      [
        ["txn-fee", "-45.00"],
        ["txn-in", null],
        ["txn-out", null],
      ],
      "only the non-cash rows lose their amount; the fee keeps its own",
    );

    const items = await all(
      client,
      `SELECT kind, account_id, source_document_id, source_locator, raw_value, reason, status
         FROM review_items ORDER BY source_locator`,
    );
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((item) => [item.kind, item.account_id, item.raw_value, item.status]),
      [
        ["cash_on_noncash_activity", "acct-out", "-41250.75", "open"],
        ["cash_on_noncash_activity", "acct-in", "41250.75", "open"],
      ],
      "raw_value is the canonical decimal text, not NUMERIC's scaled spelling",
    );
    // The exact wording classifyActivity opens with, so a person reading the
    // queue cannot tell a migrated item from an imported one.
    assert.equal(
      items[0].reason,
      'activity type "Transfer out of Account" is declared movesCash: false, but this row ' +
        'carries a non-null amount ("-41250.75"); nulling the amount rather than silently ' +
        "correcting it",
    );

    // The point of the whole exercise: the period the journalled value broke.
    const verdict = await one(
      client,
      `SELECT status, delta::text AS delta, computed_change::text AS computed
         FROM reconciliations
        WHERE account_id = 'acct-out' AND period_start = DATE '2025-03-31'`,
    );
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.delta, "0");
    assert.equal(verdict.computed, "-45", "the fee alone explains the stated change");

    // Idempotent: nothing left in scope, and the items already open are not
    // reopened as duplicates.
    const again = await nullNonCashAmounts(client, CAPABILITIES, { dryRun: false });
    assert.equal(again.rows, 0);
    assert.equal(again.reviewItemsOpened, 0);
    const finalItems = await one(
      client,
      "SELECT count(*)::text AS n FROM review_items",
    );
    assert.equal(finalItems.n, "2");
  },
);
