// The Banking & Cards screen's readers (`admin/finBanking.ts`) and
// `bankingContribution`/`mergeBankingIntoAreas` (`admin/areas.ts`).
//
// Against a real database, the same reason `adminHealthCoverage.test.mjs` is:
// the claim under test is that the schema's `kith.fin_accounts`/
// `fin_balance_snapshots`/`fin_transactions` rows are the ones these reads
// actually count, filtered to the right `type` values and never to someone
// else's investment account.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import {
  bankingContribution,
  listAccountBalanceHistory,
  listAreaCoverage,
  listBankingAccounts,
  listBankingTransactions,
  mergeBankingIntoAreas,
} from "../dist/admin/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-25T12:00:00Z");

async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  return {
    ...database,
    userId,
    spaceId,
    principal: { userId, credentialId: null },
  };
}

/** A `kith.fin_accounts` row. Plaid-linked unless `archiveAccountId` is set,
 * matching the CHECK that at least one of the two ids is present. */
async function makeFinAccount(ctx, fields = {}) {
  const id = newKithId();
  const archiveAccountId = fields.archiveAccountId ?? null;
  await ctx.client.query(
    `INSERT INTO kith.fin_accounts
       (id, institution_name, name, mask, type, subtype, archive_account_id,
        plaid_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      fields.institutionName ?? "Synthetic Bank",
      fields.name ?? "Account",
      fields.mask ?? null,
      fields.type ?? null,
      fields.subtype ?? null,
      archiveAccountId,
      archiveAccountId === null ? fields.plaidAccountId ?? `plaid-${id}` : null,
    ],
  );
  return id;
}

async function makeFinTransaction(ctx, accountId, fields = {}) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.fin_transactions
       (id, account_id, date, kind, description, amount, currency, pending,
        source, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      accountId,
      fields.date ?? "2026-08-01",
      fields.kind ?? "other",
      fields.description ?? "Synthetic transaction",
      fields.amount ?? -10,
      fields.currency ?? "USD",
      fields.pending ?? false,
      fields.source ?? "plaid",
      fields.sourceRef ?? `ref-${id}`,
    ],
  );
  return id;
}

async function makeFinBalanceSnapshot(ctx, accountId, fields = {}) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.fin_balance_snapshots
       (id, account_id, as_of, current, available, limit_amount, currency,
        source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      accountId,
      fields.asOf ?? "2026-08-31",
      fields.current ?? null,
      fields.available ?? null,
      fields.limitAmount ?? null,
      fields.currency ?? "USD",
      fields.source ?? "plaid",
    ],
  );
  return id;
}

test(
  "listBankingAccounts and bankingContribution count only depository, credit, loan and mortgage",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const ctx = f.ctx(NOW);

    const checking = await makeFinAccount(ctx, {
      institutionName: "Chase",
      name: "Checking",
      type: "depository",
      subtype: "checking",
    });
    const card = await makeFinAccount(ctx, {
      institutionName: "Chase",
      name: "Sapphire",
      type: "credit",
      subtype: "credit card",
    });
    const loan = await makeFinAccount(ctx, {
      institutionName: "Morgan Stanley",
      name: "Line of credit",
      type: "loan",
      subtype: "line of credit",
    });
    // An archive-only row (no Plaid link) whose `type` is the archive's own
    // free-text "mortgage" rather than a Plaid `loan`/`mortgage` pair -- the
    // shape `import-archive` actually produces for one.
    const archiveMortgage = await makeFinAccount(ctx, {
      institutionName: "Morgan Stanley",
      name: "Mortgage",
      type: "mortgage",
      archiveAccountId: `archive-${newKithId()}`,
    });
    const brokerage = await makeFinAccount(ctx, {
      institutionName: "Morgan Stanley",
      name: "Brokerage",
      type: "investment",
    });

    await makeFinTransaction(ctx, checking, { date: "2026-08-05", amount: 42 });
    await makeFinTransaction(ctx, card, { date: "2026-08-10", amount: 15 });
    await makeFinTransaction(ctx, loan, { date: "2026-07-01", amount: 900 });
    // The archive-only mortgage account has no transactions and no balance
    // at all -- it must still be listed.
    await makeFinTransaction(ctx, brokerage, { date: "2026-08-15", amount: 500 });

    const accounts = await listBankingAccounts(ctx);
    const ids = accounts.map((row) => row.accountId).sort();
    assert.deepEqual(ids, [checking, card, loan, archiveMortgage].sort());
    assert.equal(
      accounts.some((row) => row.accountId === brokerage),
      false,
    );

    const mortgageRow = accounts.find((row) => row.accountId === archiveMortgage);
    assert.equal(mortgageRow.currentBalance, null);
    assert.equal(mortgageRow.lastTransactionAt, null);
    assert.equal(mortgageRow.archiveAccountId !== null, true);
    assert.equal(mortgageRow.plaidAccountId, null);

    const contribution = await bankingContribution(ctx);
    // checking + card + loan transactions, not the brokerage one.
    assert.equal(contribution.sources, 4);
    assert.equal(contribution.records, 3);
    assert.equal(contribution.documents, 0);
    assert.equal(contribution.from, "2026-07-01");
    assert.equal(contribution.to, "2026-08-10");

    const areas = await listAreaCoverage(ctx, { principal: f.principal });
    const merged = mergeBankingIntoAreas(areas, contribution);
    const banking = merged.find((row) => row.area === "banking and cards");
    assert.equal(banking.sources, 4);
    assert.equal(banking.records, 3);
    assert.equal(banking.status, "covered");

    // Every other row is untouched by the merge, same guarantee
    // `mergeHealthIntoAreas` gives.
    for (const row of merged) {
      if (row.area === "banking and cards") continue;
      assert.deepEqual(row, areas.find((original) => original.area === row.area));
    }

    // `null` (no contribution) changes nothing.
    assert.deepEqual(mergeBankingIntoAreas(areas, null), areas);
  },
);

test("a credit or loan balance keeps its stored sign", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);

  const card = await makeFinAccount(ctx, { type: "credit" });
  // Plaid's own convention: a positive `current` on a credit account is the
  // amount owed. The reader must return exactly what is stored, not a
  // silently-absolute-valued or re-signed figure -- the owed/available
  // meaning is a presentation decision for the screen, not a rewrite here.
  await makeFinBalanceSnapshot(ctx, card, { current: 482.13, limitAmount: 5000 });

  const loan = await makeFinAccount(ctx, { type: "loan", subtype: "mortgage" });
  await makeFinBalanceSnapshot(ctx, loan, { current: 305000.5 });

  await makeFinTransaction(ctx, card, {
    date: "2026-08-01",
    amount: 120.5, // a purchase, stored positive
  });
  await makeFinTransaction(ctx, card, {
    date: "2026-08-02",
    amount: -60, // a payment/credit, stored negative
  });

  const accounts = await listBankingAccounts(ctx);
  const cardRow = accounts.find((row) => row.accountId === card);
  const loanRow = accounts.find((row) => row.accountId === loan);
  assert.equal(cardRow.currentBalance, 482.13);
  assert.equal(cardRow.limitAmount, 5000);
  assert.equal(loanRow.currentBalance, 305000.5);

  const { items } = await listBankingTransactions(ctx, {
    accountId: card,
    limit: 50,
  });
  const byDate = new Map(items.map((row) => [row.date, row.amount]));
  assert.equal(byDate.get("2026-08-01"), 120.5);
  assert.equal(byDate.get("2026-08-02"), -60);
});

test(
  "listBankingTransactions filters to a window, caps and counts truthfully",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const ctx = f.ctx(NOW);
    const account = await makeFinAccount(ctx, { type: "depository" });

    // One transaction 120 days back (outside a 90-day window), one 30 days
    // back (inside it), and one on the window's exact upper edge.
    await makeFinTransaction(ctx, account, {
      date: "2026-05-28", // ~120 days before NOW
      amount: -1,
      description: "old",
    });
    await makeFinTransaction(ctx, account, {
      date: "2026-08-26", // ~30 days before NOW
      amount: -2,
      description: "recent",
    });
    await makeFinTransaction(ctx, account, {
      date: "2026-09-25", // today
      amount: -3,
      description: "today",
    });

    // The 90-day default window a caller like `loadBanking` computes: today
    // minus 90 days, through tomorrow (exclusive), so "today" is included.
    const from = "2026-06-27";
    const toExclusive = "2026-09-26";
    const windowed = await listBankingTransactions(ctx, {
      from,
      toExclusive,
      limit: 50,
    });
    assert.deepEqual(
      windowed.items.map((row) => row.description).sort(),
      ["recent", "today"],
    );
    assert.equal(windowed.total, 2);

    const widened = await listBankingTransactions(ctx, {
      from: null,
      toExclusive: null,
      limit: 50,
    });
    assert.equal(widened.total, 3);

    const capped = await listBankingTransactions(ctx, {
      from: null,
      toExclusive: null,
      limit: 2,
    });
    assert.equal(capped.items.length, 2);
    // The cap never hides how many rows actually matched.
    assert.equal(capped.total, 3);
  },
);

test(
  "listAccountBalanceHistory returns at most one snapshot per month, newest first",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const ctx = f.ctx(NOW);
    const account = await makeFinAccount(ctx, { type: "depository" });

    await makeFinBalanceSnapshot(ctx, account, { asOf: "2026-07-10", current: 100 });
    await makeFinBalanceSnapshot(ctx, account, { asOf: "2026-07-31", current: 120 });
    await makeFinBalanceSnapshot(ctx, account, { asOf: "2026-08-31", current: 140 });
    await makeFinBalanceSnapshot(ctx, account, { asOf: "2026-09-25", current: 160 });

    const history = await listAccountBalanceHistory(ctx, account, 12);
    assert.deepEqual(
      history.map((row) => [row.asOf, row.current]),
      [
        ["2026-09-25", 160],
        ["2026-08-31", 140],
        ["2026-07-31", 120],
      ],
    );
  },
);
