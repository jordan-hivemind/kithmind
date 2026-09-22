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

import { admin, applyKithSchema, newKithId } from "@repo/kith-store";
import { identityCtx } from "@repo/kith-store/identity";
import { applyPgSchema, createArchiveClient } from "@repo/finance-archive";

import {
  archiveReader,
  importArchive,
  mapAccount,
  mapTransaction,
  openPool,
  setManualLink,
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

// FIN-3: the owner's live-database audit after PR 433's first real run found
// account-matching bugs and misattributed rows. The five tests below cover
// the fix end to end against a real Postgres, one per finding/requirement.

async function insertFinHolding(client, { accountId, asOf, securityId, quantity, price, value }) {
  await client.query(
    `INSERT INTO kith.fin_holding_snapshots
       (id, account_id, as_of, security_id, quantity, price, value, currency, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', 'plaid')`,
    [newKithId(), accountId, asOf, securityId, quantity, price, value],
  );
}

async function insertFinBalance(client, { accountId, asOf, current }) {
  await client.query(
    `INSERT INTO kith.fin_balance_snapshots (id, account_id, as_of, current, currency, source)
     VALUES ($1, $2, $3, $4, 'USD', 'plaid')`,
    [newKithId(), accountId, asOf, current],
  );
}

test(
  "FIN-3 collapse repro: three same-institution, same-type archive accounts with a null display name each get their own row",
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
        `INSERT INTO institutions (id, name, slug) VALUES ('arch-inst-collapse', 'Morgan Stanley', 'morgan-stanley-collapse')`,
      );
      // No Plaid accounts exist at all -- every archive account here can
      // only ever be matched (wrongly) against another archive-only row,
      // which is exactly the invariant the FIN-3 fix enforces.
      await archiveClient.query(
        `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type, base_currency)
         VALUES
           ('arch-collapse-1', 'arch-inst-collapse', '1001', NULL, 'brokerage', 'USD'),
           ('arch-collapse-2', 'arch-inst-collapse', '1002', NULL, 'brokerage', 'USD'),
           ('arch-collapse-3', 'arch-inst-collapse', '1003', NULL, 'brokerage', 'USD')`,
      );
      await archiveClient.query(
        `INSERT INTO transactions
           (id, account_id, process_date, activity_type, description, amount, currency, row_hash, imported_at)
         VALUES
           ('arch-collapse-txn-1', 'arch-collapse-1', '2020-01-01', 'Deposit', 'Deposit', 10, 'USD', 'hash-collapse-1', now()),
           ('arch-collapse-txn-2', 'arch-collapse-2', '2020-01-01', 'Deposit', 'Deposit', 20, 'USD', 'hash-collapse-2', now()),
           ('arch-collapse-txn-3', 'arch-collapse-3', '2020-01-01', 'Deposit', 'Deposit', 30, 'USD', 'hash-collapse-3', now())`,
      );

      const result = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(
        result.accountsCreated,
        3,
        "no feed account exists to match against, so each archive account must get its own row",
      );

      const { rows: finAccounts } = await kithClient.query(
        `SELECT id, archive_account_id FROM kith.fin_accounts
          WHERE archive_account_id IN ('arch-collapse-1', 'arch-collapse-2', 'arch-collapse-3')`,
      );
      assert.equal(finAccounts.length, 3, "three archive accounts must never collapse onto fewer than three fin_accounts rows");
      assert.deepEqual(
        new Set(finAccounts.map((r) => r.archive_account_id)),
        new Set(["arch-collapse-1", "arch-collapse-2", "arch-collapse-3"]),
      );

      for (const [archiveAccountId, amount] of [
        ["arch-collapse-1", 10],
        ["arch-collapse-2", 20],
        ["arch-collapse-3", 30],
      ]) {
        const finAccountId = finAccounts.find((r) => r.archive_account_id === archiveAccountId).id;
        const { rows: txRows } = await kithClient.query(
          `SELECT amount FROM kith.fin_transactions WHERE account_id = $1`,
          [finAccountId],
        );
        assert.equal(txRows.length, 1, `${archiveAccountId}'s own row should hold exactly its own transaction`);
        assert.equal(Number(txRows[0].amount), amount);
      }
    } finally {
      await pool.end();
      await archiveClient.end();
      await kithClient.end();
    }
  },
);

test(
  "FIN-3: holdings-overlap links two same-type investment accounts to their correct Plaid accounts when masks disagree",
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
        `INSERT INTO institutions (id, name, slug) VALUES ('arch-inst-hold', 'Fidelity', 'fidelity-hold')`,
      );
      await archiveClient.query(
        `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type, base_currency)
         VALUES
           ('arch-hold-1', 'arch-inst-hold', '1111', NULL, 'brokerage', 'USD'),
           ('arch-hold-2', 'arch-inst-hold', '2222', NULL, 'brokerage', 'USD')`,
      );
      await archiveClient.query(
        `INSERT INTO instruments (id, symbol, cusip, isin, name, instrument_kind)
         VALUES
           ('instr-aaa', 'AAA', 'CUSIPAAA00', NULL, 'Fund AAA', 'fund'),
           ('instr-bbb', 'BBB', 'CUSIPBBB00', NULL, 'Fund BBB', 'fund'),
           ('instr-ccc', 'CCC', 'CUSIPCCC00', NULL, 'Fund CCC', 'fund'),
           ('instr-ddd', 'DDD', 'CUSIPDDD00', NULL, 'Fund DDD', 'fund')`,
      );
      // arch-hold-1 holds AAA/BBB; arch-hold-2 holds CCC/DDD.
      await archiveClient.query(
        `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, price, market_value, currency)
         VALUES
           ('pos-1-aaa', 'arch-hold-1', '2024-06-01', 'instr-aaa', 10, 100, 1000, 'USD'),
           ('pos-1-bbb', 'arch-hold-1', '2024-06-01', 'instr-bbb', 20, 50, 1000, 'USD'),
           ('pos-2-ccc', 'arch-hold-2', '2024-06-01', 'instr-ccc', 5, 200, 1000, 'USD'),
           ('pos-2-ddd', 'arch-hold-2', '2024-06-01', 'instr-ddd', 7, 150, 1050, 'USD')`,
      );

      // Two Plaid-linked fin_accounts rows, masks that agree with *neither*
      // archive account (0/24 masks agreeing is exactly what the audit
      // found), and holdings assigned in the *opposite* order from the
      // archive accounts above: fin-1 (mask 9999) holds CCC/DDD (like
      // arch-hold-2), fin-2 (mask 8888) holds AAA/BBB (like arch-hold-1).
      // A mask- or order-based match would get this backwards.
      const finId1 = newKithId();
      const finId2 = newKithId();
      await kithClient.query(
        `INSERT INTO kith.fin_accounts (id, institution_name, name, mask, type, plaid_account_id)
         VALUES ($1, 'Fidelity', 'Brokerage One', '9999', 'brokerage', 'plaid-hold-1'),
                ($2, 'Fidelity', 'Brokerage Two', '8888', 'brokerage', 'plaid-hold-2')`,
        [finId1, finId2],
      );
      const secAaa = newKithId();
      const secBbb = newKithId();
      const secCcc = newKithId();
      const secDdd = newKithId();
      await kithClient.query(
        `INSERT INTO kith.fin_securities (id, name, ticker, cusip, isin, type, plaid_security_id)
         VALUES ($1, 'Fund AAA', 'AAA', 'CUSIPAAA00', NULL, 'fund', 'plaid-sec-aaa'),
                ($2, 'Fund BBB', 'BBB', 'CUSIPBBB00', NULL, 'fund', 'plaid-sec-bbb'),
                ($3, 'Fund CCC', 'CCC', 'CUSIPCCC00', NULL, 'fund', 'plaid-sec-ccc'),
                ($4, 'Fund DDD', 'DDD', 'CUSIPDDD00', NULL, 'fund', 'plaid-sec-ddd')`,
        [secAaa, secBbb, secCcc, secDdd],
      );
      await insertFinHolding(kithClient, { accountId: finId1, asOf: "2024-06-05", securityId: secCcc, quantity: 5, price: 200, value: 1000 });
      await insertFinHolding(kithClient, { accountId: finId1, asOf: "2024-06-05", securityId: secDdd, quantity: 7, price: 150, value: 1050 });
      await insertFinHolding(kithClient, { accountId: finId2, asOf: "2024-06-05", securityId: secAaa, quantity: 10, price: 100, value: 1000 });
      await insertFinHolding(kithClient, { accountId: finId2, asOf: "2024-06-05", securityId: secBbb, quantity: 20, price: 50, value: 1000 });

      const result = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(result.linksByMethod.holdings, 2, "both archive accounts should link by holdings overlap");
      assert.equal(result.linksByMethod.mask, 0, "neither mask matched, per the audit's own finding");

      const { rows } = await kithClient.query(
        `SELECT id, archive_account_id, match_method FROM kith.fin_accounts WHERE id = ANY($1) ORDER BY mask`,
        [[finId1, finId2]],
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      assert.equal(byId[finId1].archive_account_id, "arch-hold-2", "fin-1 holds arch-hold-2's securities, not arch-hold-1's");
      assert.equal(byId[finId1].match_method, "holdings");
      assert.equal(byId[finId2].archive_account_id, "arch-hold-1", "fin-2 holds arch-hold-1's securities, not arch-hold-2's");
      assert.equal(byId[finId2].match_method, "holdings");
    } finally {
      await pool.end();
      await archiveClient.end();
      await kithClient.end();
    }
  },
);

test(
  "FIN-3: balance matching links a credit line/loan account that has no holdings to compare",
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
        `INSERT INTO institutions (id, name, slug) VALUES ('arch-inst-loan', 'Chase', 'chase-loan')`,
      );
      await archiveClient.query(
        `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type, base_currency)
         VALUES ('arch-loan-1', 'arch-inst-loan', '4444', NULL, 'credit_line', 'USD')`,
      );
      await archiveClient.query(
        `INSERT INTO balances (id, account_id, as_of, total_value, currency)
         VALUES ('bal-loan-1', 'arch-loan-1', '2024-05-01', -5000, 'USD')`,
      );

      // A different mask (no mask match possible) and a balance 0.2% off,
      // 2 days apart -- well inside the 1%/45-day thresholds.
      const finLoanId = newKithId();
      await kithClient.query(
        `INSERT INTO kith.fin_accounts (id, institution_name, name, mask, type, plaid_account_id)
         VALUES ($1, 'Chase', 'Line of Credit', '9999', 'credit_line', 'plaid-loan-1')`,
        [finLoanId],
      );
      await insertFinBalance(kithClient, { accountId: finLoanId, asOf: "2024-05-03", current: -5010 });

      const result = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(result.linksByMethod.balance, 1, "the loan should link by balance equality");
      assert.equal(result.linksByMethod.holdings, 0);
      assert.equal(result.linksByMethod.mask, 0);

      const { rows } = await kithClient.query(
        `SELECT archive_account_id, match_method FROM kith.fin_accounts WHERE id = $1`,
        [finLoanId],
      );
      assert.equal(rows[0].archive_account_id, "arch-loan-1");
      assert.equal(rows[0].match_method, "balance");
    } finally {
      await pool.end();
      await archiveClient.end();
      await kithClient.end();
    }
  },
);

test(
  "FIN-3: a persisted --link override takes precedence over mask matching, and is never overwritten by automatic matching",
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
        `INSERT INTO institutions (id, name, slug) VALUES ('arch-inst-manual', 'Vanguard', 'vanguard-manual')`,
      );
      await archiveClient.query(
        `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type, base_currency)
         VALUES ('arch-manual-1', 'arch-inst-manual', '5555', 'Retirement', 'retirement', 'USD')`,
      );

      // fin-mask-match would win by mask if manual matching did not take
      // precedence; fin-manual-target is the owner's actual choice.
      const finMaskMatchId = newKithId();
      const finManualTargetId = newKithId();
      await kithClient.query(
        `INSERT INTO kith.fin_accounts (id, institution_name, name, mask, type, plaid_account_id)
         VALUES ($1, 'Vanguard', 'IRA', '5555', 'retirement', 'plaid-mask-match'),
                ($2, 'Vanguard', 'Rollover IRA', '7777', 'retirement', 'plaid-manual-target')`,
        [finMaskMatchId, finManualTargetId],
      );

      await setManualLink(pool, "arch-manual-1", "plaid-manual-target");

      const result = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(result.linksByMethod.manual, 1);
      assert.equal(result.linksByMethod.mask, 0, "mask matching must never even be tried once a manual override exists");

      const { rows } = await kithClient.query(
        `SELECT id, archive_account_id, match_method FROM kith.fin_accounts WHERE id = ANY($1)`,
        [[finMaskMatchId, finManualTargetId]],
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      assert.equal(byId[finManualTargetId].archive_account_id, "arch-manual-1");
      assert.equal(byId[finManualTargetId].match_method, "manual");
      assert.equal(byId[finMaskMatchId].archive_account_id, null, "the mask-matching account must stay unlinked, reserved by nothing but not chosen");

      // Persists: a second run with no --link argument at all makes the
      // same decision again, from kith.fin_account_link_overrides.
      const second = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(second.linksByMethod.manual, 0, "already linked -- re-derives to the same link without writing again");
      const { rows: again } = await kithClient.query(
        `SELECT archive_account_id FROM kith.fin_accounts WHERE id = $1`,
        [finManualTargetId],
      );
      assert.equal(again[0].archive_account_id, "arch-manual-1");
    } finally {
      await pool.end();
      await archiveClient.end();
      await kithClient.end();
    }
  },
);

test(
  "FIN-3 self-repair: moves a misattributed transaction from a wrong bucket account to the archive account it actually belongs to, then a second run is a no-op",
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
        `INSERT INTO institutions (id, name, slug) VALUES ('arch-inst-repair', 'Morgan Stanley', 'morgan-stanley-repair')`,
      );
      await archiveClient.query(
        `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type, base_currency)
         VALUES
           ('arch-bad-1', 'arch-inst-repair', '1001', NULL, 'brokerage', 'USD'),
           ('arch-bad-2', 'arch-inst-repair', '1002', NULL, 'brokerage', 'USD')`,
      );
      await archiveClient.query(
        `INSERT INTO transactions
           (id, account_id, process_date, activity_type, description, amount, currency, row_hash, imported_at)
         VALUES
           ('arch-bad-txn-1', 'arch-bad-1', '2020-01-01', 'Deposit', 'Deposit', 100, 'USD', 'hash-bad-1', now()),
           ('arch-bad-txn-2', 'arch-bad-2', '2020-01-01', 'Deposit', 'Deposit', 200, 'USD', 'hash-bad-2', now())`,
      );

      // Simulate the historical bug's end state directly: one "bucket"
      // fin_accounts row linked to arch-bad-1, but holding *both* archive
      // accounts' transactions -- arch-bad-2's row (source_ref =
      // arch-bad-txn-2) sitting on the wrong account_id.
      const bucketId = newKithId();
      await kithClient.query(
        `INSERT INTO kith.fin_accounts (id, institution_name, name, mask, type, archive_account_id)
         VALUES ($1, 'Morgan Stanley', 'Unlabeled account', '1001', 'brokerage', 'arch-bad-1')`,
        [bucketId],
      );
      await kithClient.query(
        `INSERT INTO kith.fin_transactions
           (id, account_id, date, kind, description, amount, currency, source, source_ref)
         VALUES
           ($1, $3, '2020-01-01', 'deposit', 'Deposit', 100, 'USD', 'archive', 'arch-bad-txn-1'),
           ($2, $3, '2020-01-01', 'deposit', 'Deposit', 200, 'USD', 'archive', 'arch-bad-txn-2')`,
        [newKithId(), newKithId(), bucketId],
      );

      const first = await importArchive(archiveReader(archiveClient), pool);
      assert.ok(first.rowsReattributed >= 1, "the misattributed row should be moved during self-repair");

      const { rows: finAccounts } = await kithClient.query(
        `SELECT id, archive_account_id FROM kith.fin_accounts
          WHERE archive_account_id IN ('arch-bad-1', 'arch-bad-2')`,
      );
      assert.equal(finAccounts.length, 2, "arch-bad-2 should get its own row, separate from the bucket");
      const byArchiveId = Object.fromEntries(finAccounts.map((r) => [r.archive_account_id, r.id]));
      assert.equal(byArchiveId["arch-bad-1"], bucketId, "the bucket row stays arch-bad-1's own row");

      const { rows: bucketRows } = await kithClient.query(
        `SELECT source_ref, amount FROM kith.fin_transactions WHERE account_id = $1`,
        [bucketId],
      );
      assert.equal(bucketRows.length, 1, "only arch-bad-1's own transaction remains on the bucket row");
      assert.equal(bucketRows[0].source_ref, "arch-bad-txn-1");

      const { rows: correctedRows } = await kithClient.query(
        `SELECT source_ref, amount FROM kith.fin_transactions WHERE account_id = $1`,
        [byArchiveId["arch-bad-2"]],
      );
      assert.equal(correctedRows.length, 1, "arch-bad-2's transaction moved to its own, correct row");
      assert.equal(correctedRows[0].source_ref, "arch-bad-txn-2");
      assert.equal(Number(correctedRows[0].amount), 200);

      // Idempotent: a second run against already-correct data moves nothing.
      const second = await importArchive(archiveReader(archiveClient), pool);
      assert.equal(second.rowsReattributed, 0);
      assert.equal(second.emptyAccountsRemoved, 0);
      const { rows: bucketRowsAgain } = await kithClient.query(
        `SELECT source_ref FROM kith.fin_transactions WHERE account_id = $1`,
        [bucketId],
      );
      assert.equal(bucketRowsAgain.length, 1);
    } finally {
      await pool.end();
      await archiveClient.end();
      await kithClient.end();
    }
  },
);
