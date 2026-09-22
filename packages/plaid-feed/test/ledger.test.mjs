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
  assert.equal(second.linksSet, 0, "an already-linked account re-derives to the same link without writing");
  const ledgerAgain = await admin.listLedger(ctx, { accountId: finAccountId });
  assert.equal(ledgerAgain.rows.length, 3);
}

test(
  "import-archive merges an archive-only account into a feed account that appears later, and self-repairs the overlap",
  { skip },
  async (t) => {
    const dbUrl = await throwawayDatabase(t);
    const kithClient = new pg.Client({ connectionString: dbUrl });
    const archiveClient = createArchiveClient(dbUrl, "finance");
    const pool = openPool(dbUrl);
    try {
      await kithClient.connect();
      await applyKithSchema(kithClient);
      await archiveClient.connect();
      await applyPgSchema(archiveClient, "finance");

      await archiveClient.query(
        `INSERT INTO institutions (id, name, slug)
         VALUES ('arch-inst-2', 'Vanguard', 'vanguard')`,
      );
      await archiveClient.query(
        `INSERT INTO accounts
           (id, institution_id, acct_last4, display_name, account_type, base_currency)
         VALUES ('arch-acc-2', 'arch-inst-2', '7777', 'Retirement IRA', 'retirement', 'USD')`,
      );
      // One transaction well before any Plaid history exists, one dated
      // after where the Plaid account's own history will start once it
      // shows up -- both import with no boundary on the first run (there is
      // no feed account yet), which is exactly the bug this test guards:
      // a first run before the feed account exists must not leave the
      // later-arriving overlap stuck in the ledger forever.
      await archiveClient.query(
        `INSERT INTO transactions
           (id, account_id, process_date, activity_type, description, amount, currency, row_hash, imported_at)
         VALUES
           ('arch-txn-a-old', 'arch-acc-2', '2019-01-01', 'Dividend', 'Dividend payment', 5.00, 'USD', 'hash-a-old', now()),
           ('arch-txn-a-new', 'arch-acc-2', '2024-05-01', 'Dividend', 'Dividend payment', 6.00, 'USD', 'hash-a-new', now())`,
      );

      // First run: no Plaid account for this institution/mask yet, so the
      // archive account becomes its own archive-only row with both
      // transactions imported (nothing to bound against).
      const first = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(first.accountsCreated, 1);
      assert.equal(first.accountsMatched, 0);

      const { rows: archiveOnlyRows } = await kithClient.query(
        `SELECT id, archive_account_id, plaid_account_id
           FROM kith.fin_accounts WHERE institution_name = 'Vanguard'`,
      );
      assert.equal(archiveOnlyRows.length, 1);
      assert.equal(archiveOnlyRows[0].archive_account_id, "arch-acc-2");
      assert.equal(archiveOnlyRows[0].plaid_account_id, null);
      const archiveOnlyId = archiveOnlyRows[0].id;

      const { rows: beforeMerge } = await kithClient.query(
        `SELECT source_ref, date::text AS date FROM kith.fin_transactions
          WHERE account_id = $1 ORDER BY date`,
        [archiveOnlyId],
      );
      assert.deepEqual(beforeMerge.map((r) => r.source_ref), ["arch-txn-a-old", "arch-txn-a-new"]);

      // Now a matching Plaid account shows up (the owner links the
      // institution and `pull` runs), with a transaction dated between the
      // two archive rows -- this becomes the boundary.
      await upsertPlaidItem(pool, {
        itemId: "item-2",
        institutionId: "ins_vanguard",
        institutionName: "Vanguard",
        keychainService: "com.kithmind.plaid.item.vanguard",
      });
      await upsertAccount(
        pool,
        mapAccount({ ...account, account_id: "plaid-acc-2", mask: "7777", name: "IRA" }, "item-2", "Vanguard"),
      );
      await upsertTransaction(
        pool,
        mapTransaction(
          { ...plaidTransaction("plaid-txn-2", "2024-02-01", -25), account_id: "plaid-acc-2" },
          "item-2",
        ),
      );

      // Second run: merges the archive-only row into the feed row, and
      // self-repairs the overlap the first run had no way to know about --
      // the now-past-boundary archive transaction is deleted, not just
      // skipped on the way in.
      const second = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(second.accountsCreated, 0);
      assert.equal(second.accountsMerged, 1, "the archive-only row merged into the feed row");
      assert.equal(second.linksSet, 1);
      assert.ok(second.rowsDeletedAsOverlap >= 1, "the overlapping archive row was deleted, not left behind");

      const { rows: merged } = await kithClient.query(
        `SELECT id, archive_account_id, plaid_account_id
           FROM kith.fin_accounts WHERE institution_name = 'Vanguard'`,
      );
      assert.equal(merged.length, 1, "one row, not two, after the merge");
      assert.equal(merged[0].archive_account_id, "arch-acc-2");
      assert.equal(merged[0].plaid_account_id, "plaid-acc-2");
      assert.notEqual(merged[0].id, archiveOnlyId, "the merge kept the feed row's own id, not the archive-only row's");

      const ctx = identityCtx(kithClient);
      const ledger = await admin.listLedger(ctx, { accountId: merged[0].id });
      assert.deepEqual(
        ledger.rows.map((row) => [row.date, row.source]),
        [
          ["2024-02-01", "plaid"],
          ["2019-01-01", "archive"],
        ],
        "the pre-boundary archive row survived the merge; the past-boundary one was removed",
      );

      // Idempotent from here too: a third run repeats nothing.
      const third = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(third.accountsMerged, 0);
      assert.equal(third.rowsDeletedAsOverlap, 0);
      const ledgerAgain = await admin.listLedger(ctx, { accountId: merged[0].id });
      assert.equal(ledgerAgain.rows.length, 2);
    } finally {
      await pool.end();
      await archiveClient.end();
      await kithClient.end();
    }
  },
);

test(
  "import-archive links two archive accounts at the same institution to their own distinct feed accounts, not to each other",
  { skip },
  async (t) => {
    const dbUrl = await throwawayDatabase(t);
    const kithClient = new pg.Client({ connectionString: dbUrl });
    const archiveClient = createArchiveClient(dbUrl, "finance");
    const pool = openPool(dbUrl);
    try {
      await kithClient.connect();
      await applyKithSchema(kithClient);
      await archiveClient.connect();
      await applyPgSchema(archiveClient, "finance");

      // Two archive accounts at the same institution and of the same
      // account_type ("bank"), distinguished only by mask and display name
      // -- exactly the shape that would collapse onto one fin_accounts row
      // if matching ever claimed a candidate for more than one archive
      // account.
      await archiveClient.query(
        `INSERT INTO institutions (id, name, slug) VALUES ('arch-inst-3', 'Chase', 'chase')`,
      );
      await archiveClient.query(
        `INSERT INTO accounts
           (id, institution_id, acct_last4, display_name, account_type, base_currency)
         VALUES
           ('arch-acc-checking', 'arch-inst-3', '1111', 'Checking', 'bank', 'USD'),
           ('arch-acc-savings', 'arch-inst-3', '2222', 'Savings', 'bank', 'USD')`,
      );
      await archiveClient.query(
        `INSERT INTO transactions
           (id, account_id, process_date, activity_type, description, amount, currency, row_hash, imported_at)
         VALUES
           ('arch-txn-checking', 'arch-acc-checking', '2019-01-01', 'Deposit', 'Deposit', 100.00, 'USD', 'hash-checking', now()),
           ('arch-txn-savings', 'arch-acc-savings', '2019-01-01', 'Deposit', 'Deposit', 200.00, 'USD', 'hash-savings', now())`,
      );

      await upsertPlaidItem(pool, {
        itemId: "item-3",
        institutionId: "ins_chase",
        institutionName: "Chase",
        keychainService: "com.kithmind.plaid.item.chase",
      });
      await upsertAccount(
        pool,
        mapAccount(
          { ...account, account_id: "plaid-acc-checking", mask: "1111", name: "Checking" },
          "item-3",
          "Chase",
        ),
      );
      await upsertAccount(
        pool,
        mapAccount(
          { ...account, account_id: "plaid-acc-savings", mask: "2222", name: "Savings" },
          "item-3",
          "Chase",
        ),
      );
      // A boundary transaction on each feed account, both dated after both
      // archive rows, so both archive rows still import (before the
      // boundary) and attribution is checkable independent of the boundary
      // rule.
      await upsertTransaction(
        pool,
        mapTransaction(
          { ...plaidTransaction("plaid-txn-checking", "2024-01-01", -10), account_id: "plaid-acc-checking" },
          "item-3",
        ),
      );
      await upsertTransaction(
        pool,
        mapTransaction(
          { ...plaidTransaction("plaid-txn-savings", "2024-01-01", -20), account_id: "plaid-acc-savings" },
          "item-3",
        ),
      );

      const result = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(result.accountsMatched, 2);
      assert.equal(result.accountsCreated, 0);
      assert.equal(result.accountsMerged, 0);

      const { rows: finAccounts } = await kithClient.query(
        `SELECT id, mask, archive_account_id, plaid_account_id
           FROM kith.fin_accounts WHERE institution_name = 'Chase' ORDER BY mask`,
      );
      assert.equal(finAccounts.length, 2, "two distinct rows, not one shared row");
      assert.equal(finAccounts[0].mask, "1111");
      assert.equal(finAccounts[0].archive_account_id, "arch-acc-checking");
      assert.equal(finAccounts[0].plaid_account_id, "plaid-acc-checking");
      assert.equal(finAccounts[1].mask, "2222");
      assert.equal(finAccounts[1].archive_account_id, "arch-acc-savings");
      assert.equal(finAccounts[1].plaid_account_id, "plaid-acc-savings");

      const { rows: checkingArchiveTx } = await kithClient.query(
        `SELECT amount FROM kith.fin_transactions
          WHERE account_id = $1 AND source = 'archive'`,
        [finAccounts[0].id],
      );
      assert.equal(Number(checkingArchiveTx[0].amount), 100, "the checking account got its own archive transaction");
      const { rows: savingsArchiveTx } = await kithClient.query(
        `SELECT amount FROM kith.fin_transactions
          WHERE account_id = $1 AND source = 'archive'`,
        [finAccounts[1].id],
      );
      assert.equal(Number(savingsArchiveTx[0].amount), 200, "the savings account got its own archive transaction, not the checking one's");
    } finally {
      await pool.end();
      await archiveClient.end();
      await kithClient.end();
    }
  },
);
