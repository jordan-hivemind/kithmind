// The one unified ledger end to end, against a real throwaway Postgres: an
// archive-style account and account history seeded straight into the
// `finance` schema, a Plaid-style account and history written through this
// package's own `pull` mapping (`upsertAccount`/`upsertTransaction`), then
// `import-archive`'s matching and boundary rule reconciling the two into
// `kith.fin_accounts`/`fin_transactions`, and `@repo/kith-store`'s
// `listLedger` reading the result back as one stream.
//
// FIN-1 (migration 048_finance_unify.sql), replacing the plan's original
// `kith.finance_account_links` design with one physical ledger. See
// docs/plans/2026-09-22-simplification-and-feeds.md.
//
// Skips cleanly without a database, matching every other Postgres test in
// this repository: set KITH_STORE_DATABASE_URL to a throwaway Postgres (this
// test creates and drops its own database on that server) to run it.

import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { admin, applyKithSchema } from "@repo/kith-store";
import { identityCtx } from "@repo/kith-store/identity";
import { applyPgSchema, createArchiveClient } from "@repo/finance-archive";

import {
  archiveReader,
  importArchive,
  mapAccount,
  mapTransaction,
  openPool,
  upsertAccount,
  upsertPlaidItem,
  upsertTransaction,
} from "../dist/index.js";

const url = process.env.KITH_STORE_DATABASE_URL;
const skip = url
  ? false
  : "set KITH_STORE_DATABASE_URL to a throwaway Postgres to run this test";

async function throwawayDatabase(t) {
  const admin_ = new pg.Client({ connectionString: url });
  await admin_.connect();
  const name = `plaid_feed_test_${randomBytes(8).toString("hex")}`;
  await admin_.query(`CREATE DATABASE ${name}`);
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  const dbUrl = parsed.toString();
  t.after(async () => {
    await admin_.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin_.end();
  });
  return dbUrl;
}

const account = {
  account_id: "plaid-acc-1",
  balances: {
    available: null,
    current: null,
    limit: null,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
  },
  mask: "4321",
  name: "Brokerage",
  official_name: "Individual Brokerage Account",
  type: "investment",
  subtype: "brokerage",
};

function plaidTransaction(id, date, amount) {
  return {
    transaction_id: id,
    account_id: "plaid-acc-1",
    date,
    authorized_date: date,
    name: "Trade",
    merchant_name: null,
    amount,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    pending: false,
    personal_finance_category: null,
  };
}

test(
  "import-archive plus a Plaid pull produce one unified ledger per account",
  { skip },
  async (t) => {
    const dbUrl = await throwawayDatabase(t);

    // Every connection this test opens is closed here, in this order,
    // before the test function returns -- and so before `throwawayDatabase`'s
    // own `t.after` runs `DROP DATABASE ... WITH (FORCE)`. Relying on
    // multiple `t.after` hooks for this instead left a client still open
    // when the force-drop ran, which kills its connection out from under it
    // ("terminating connection due to administrator command") and fails the
    // test on an unrelated race rather than a real assertion.
    const kithClient = new pg.Client({ connectionString: dbUrl });
    const archiveClient = createArchiveClient(dbUrl, "finance");
    const pool = openPool(dbUrl);
    try {
      await kithClient.connect();
      await applyKithSchema(kithClient);

      await archiveClient.connect();
      await applyPgSchema(archiveClient, "finance");

      await runLedgerAssertions({ kithClient, archiveClient, pool });
    } finally {
      await pool.end();
      await archiveClient.end();
      await kithClient.end();
    }
  },
);

async function runLedgerAssertions({ kithClient, archiveClient, pool }) {
  // Seed one archive account, "Individual Brokerage" at Morgan Stanley,
  // mask 4321 -- the same mask the Plaid account below reports, so
  // import-archive's institution+mask matching links them onto one
  // kith.fin_accounts row rather than creating two.
  await archiveClient.query(
    `INSERT INTO institutions (id, name, slug)
     VALUES ('arch-inst-1', 'Morgan Stanley', 'morgan-stanley')`,
  );
  await archiveClient.query(
    `INSERT INTO accounts
       (id, institution_id, acct_last4, display_name, account_type, base_currency)
     VALUES ('arch-acc-1', 'arch-inst-1', '4321', 'Individual Brokerage', 'brokerage', 'USD')`,
  );
  // Two archive transactions: one well before any Plaid history (must be
  // imported) and one dated after the earliest Plaid transaction below
  // (must be skipped -- it is Plaid's job to cover that date now).
  await archiveClient.query(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, description, amount, currency, row_hash, imported_at)
     VALUES
       ('arch-txn-old', 'arch-acc-1', '2020-01-15', 'Dividend', 'Dividend payment', 12.34, 'USD', 'hash-old', now()),
       ('arch-txn-new', 'arch-acc-1', '2024-06-01', 'Dividend', 'Dividend payment', 15.00, 'USD', 'hash-new', now())`,
  );

  // Run the Plaid side of "pull": the same upsert functions pull.ts calls,
  // against a fresh kith.plaid_items row and two transactions, one dated
  // 2024-02-20 (the earlier of the two -- this becomes the boundary) and
  // one dated 2024-03-01.
  await upsertPlaidItem(pool, {
    itemId: "item-1",
    institutionId: "ins_morganstanley",
    institutionName: "Morgan Stanley",
    keychainService: "com.kithmind.plaid.item.morgan-stanley",
  });
  await upsertAccount(pool, mapAccount(account, "item-1", "Morgan Stanley"));
  await upsertTransaction(
    pool,
    mapTransaction(plaidTransaction("plaid-txn-1", "2024-02-20", -50), "item-1"),
  );
  await upsertTransaction(
    pool,
    mapTransaction(plaidTransaction("plaid-txn-2", "2024-03-01", -75), "item-1"),
  );

  // Now import-archive: matches the archive account onto the Plaid
  // account's existing kith.fin_accounts row by institution+mask, then
  // applies the boundary rule against that row's earliest Plaid date.
  const result = await importArchive(archiveReader(archiveClient), pool);
  assert.equal(result.accountsMatched, 1, "the archive account matched the Plaid account's existing row");
  assert.equal(result.accountsCreated, 0);
  assert.equal(result.transactionsImported, 1, "only the pre-boundary archive transaction was imported");
  assert.equal(result.transactionsSkippedPastBoundary, 1);

  // One account row for this real account, not two.
  const { rows: finAccounts } = await kithClient.query(
    `SELECT id, archive_account_id, plaid_account_id
       FROM kith.fin_accounts
      WHERE institution_name = 'Morgan Stanley'`,
  );
  assert.equal(finAccounts.length, 1);
  assert.equal(finAccounts[0].archive_account_id, "arch-acc-1");
  assert.equal(finAccounts[0].plaid_account_id, "plaid-acc-1");
  const finAccountId = finAccounts[0].id;

  // No duplicate transactions: three rows total for this account (one
  // archive, two Plaid), not four -- the skipped archive row never landed.
  const ctx = identityCtx(kithClient);
  const ledger = await admin.listLedger(ctx, { accountId: finAccountId });
  assert.equal(ledger.rows.length, 3);
  assert.deepEqual(
    ledger.rows.map((row) => [row.date, row.source]),
    [
      ["2024-03-01", "plaid"],
      ["2024-02-20", "plaid"],
      ["2020-01-15", "archive"],
    ],
    "newest first, and the skipped archive row (2024-06-01) is absent",
  );

  // Idempotent: re-running import-archive does not duplicate the archive
  // transaction or account it already wrote.
  const second = await importArchive(archiveReader(archiveClient), pool);
  assert.equal(second.accountsCreated, 0);
  assert.equal(second.accountsMatched, 1);
  const ledgerAgain = await admin.listLedger(ctx, { accountId: finAccountId });
  assert.equal(ledgerAgain.rows.length, 3);
}
