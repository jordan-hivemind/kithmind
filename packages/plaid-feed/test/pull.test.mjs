// `pullItem`'s control flow against a mocked Plaid client and a fake pool
// (an object with just `.query`, recording every call): balances mapping,
// holdings mapping, the transactions-sync cursor, and ITEM_LOGIN_REQUIRED
// handling, all without a network call or a real database.

import assert from "node:assert/strict";
import test from "node:test";

import { pullItem } from "../dist/index.js";

function fakePool(shouldFail = () => false) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      const trimmed = text.trim();
      calls.push({ text: trimmed, params });
      if (shouldFail(trimmed, params)) {
        throw new Error("simulated_row_failure");
      }
      return { rows: [] };
    },
  };
}

const item = {
  itemId: "item-1",
  institutionId: "ins_chase",
  institutionName: "Chase",
  keychainService: "com.kithmind.plaid.item.chase",
  transactionsCursor: null,
  needsRelinkAt: null,
};

const account = {
  account_id: "acc-1",
  balances: {
    available: 500,
    current: 500,
    limit: null,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
  },
  mask: "0000",
  name: "Checking",
  official_name: null,
  type: "depository",
  subtype: "checking",
};

const investmentAccount = {
  ...account,
  account_id: "acc-2",
  type: "investment",
  subtype: "brokerage",
};

const security = {
  security_id: "sec-1",
  name: "Fund",
  ticker_symbol: "FND",
  type: "etf",
  close_price: 10,
  close_price_as_of: "2026-09-21",
  iso_currency_code: "USD",
  unofficial_currency_code: null,
};

const holding = {
  account_id: "acc-2",
  security_id: "sec-1",
  institution_price: 10,
  institution_value: 1000,
  cost_basis: 900,
  quantity: 100,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
};

function axiosError(errorCode) {
  const error = new Error(errorCode);
  error.response = { data: { error_code: errorCode } };
  return error;
}

/** A client whose four endpoints all succeed with one small page each. */
function happyClient() {
  return {
    async accountsBalanceGet() {
      return {
        data: {
          accounts: [account],
          item: { consented_products: ["transactions", "investments"] },
        },
      };
    },
    async investmentsHoldingsGet() {
      return {
        data: {
          accounts: [investmentAccount],
          holdings: [holding],
          securities: [security],
        },
      };
    },
    async transactionsSync({ cursor }) {
      assert.equal(cursor, undefined, "first sync call has no cursor");
      return {
        data: {
          accounts: [account],
          added: [
            {
              transaction_id: "tx-1",
              account_id: "acc-1",
              date: "2026-09-20",
              authorized_date: "2026-09-19",
              name: "Coffee",
              merchant_name: "Cafe",
              amount: 5,
              iso_currency_code: "USD",
              unofficial_currency_code: null,
              pending: false,
              personal_finance_category: { primary: "FOOD_AND_DRINK" },
            },
          ],
          modified: [],
          removed: [],
          next_cursor: "cursor-1",
          has_more: false,
        },
      };
    },
    async investmentsTransactionsGet() {
      return {
        data: {
          securities: [security],
          investment_transactions: [
            {
              investment_transaction_id: "itx-1",
              account_id: "acc-2",
              security_id: "sec-1",
              date: "2026-09-15",
              name: "Buy",
              quantity: 10,
              amount: -100,
              price: 10,
              fees: 0,
              type: "buy",
              subtype: "buy",
              iso_currency_code: "USD",
              unofficial_currency_code: null,
            },
          ],
          total_investment_transactions: 1,
        },
      };
    },
  };
}

test("a full success maps every product and reports the new cursor", async () => {
  const pool = fakePool();
  const result = await pullItem(happyClient(), pool, item, "access-token-1");
  assert.equal(result.status, "ok");
  assert.equal(result.accounts, 1);
  assert.equal(result.balances, 1);
  assert.equal(result.holdings, 1);
  assert.equal(result.transactionsAdded, 1);
  assert.equal(result.transactionsModified, 0);
  assert.equal(result.transactionsRemoved, 0);
  assert.equal(result.investmentTransactions, 1);
  assert.equal(result.error, null);

  const success = pool.calls.find((call) =>
    call.text.includes("SET last_pulled_at = transaction_timestamp(),\n            last_pull_error = NULL"),
  );
  assert.ok(success, "recorded a success update");
  assert.deepEqual(success.params, ["item-1", "cursor-1"]);
});

test("ITEM_LOGIN_REQUIRED on the required balances call ends the pull and needs a relink", async () => {
  const pool = fakePool();
  const client = happyClient();
  client.accountsBalanceGet = async () => {
    throw axiosError("ITEM_LOGIN_REQUIRED");
  };
  let holdingsCalled = false;
  client.investmentsHoldingsGet = async () => {
    holdingsCalled = true;
    return { data: { accounts: [], holdings: [], securities: [] } };
  };

  const result = await pullItem(client, pool, item, "access-token-1");
  assert.equal(result.status, "needs_relink");
  assert.equal(result.accounts, 0);
  assert.equal(holdingsCalled, false, "a login failure stops the rest of the item's pull");

  const failure = pool.calls.find((call) =>
    call.text.includes("needs_relink_at = CASE WHEN $3 THEN transaction_timestamp()"),
  );
  assert.ok(failure, "recorded a failure update");
  assert.deepEqual(failure.params, ["item-1", "ITEM_LOGIN_REQUIRED", true]);
});

test("PRODUCTS_NOT_SUPPORTED on holdings is not a failure: it just reports zero holdings", async () => {
  const pool = fakePool();
  const client = happyClient();
  client.investmentsHoldingsGet = async () => {
    throw axiosError("PRODUCTS_NOT_SUPPORTED");
  };

  const result = await pullItem(client, pool, item, "access-token-1");
  assert.equal(result.status, "ok");
  assert.equal(result.holdings, 0);
  // The rest of the item's pull still ran.
  assert.equal(result.transactionsAdded, 1);
  assert.equal(result.investmentTransactions, 1);
});

test("an unexpected transactions-sync error fails the item and skips investment transactions", async () => {
  const pool = fakePool();
  const client = happyClient();
  client.transactionsSync = async () => {
    throw new Error("ECONNRESET");
  };
  let investmentTransactionsCalled = false;
  client.investmentsTransactionsGet = async () => {
    investmentTransactionsCalled = true;
    return { data: { securities: [], investment_transactions: [], total_investment_transactions: 0 } };
  };

  const result = await pullItem(client, pool, item, "access-token-1");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "ECONNRESET");
  assert.equal(investmentTransactionsCalled, false);

  const failure = pool.calls.find((call) =>
    call.text.includes("needs_relink_at = CASE WHEN $3 THEN transaction_timestamp()"),
  );
  assert.deepEqual(failure.params, ["item-1", "ECONNRESET", false]);
});

test("the transactions-sync cursor is threaded through a second page", async () => {
  const pool = fakePool();
  const client = happyClient();
  let calls = 0;
  client.transactionsSync = async ({ cursor }) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(cursor, "stored-cursor", "resumes from the item's stored cursor");
      return {
        data: {
          accounts: [],
          added: [],
          modified: [],
          removed: [],
          next_cursor: "page-2-cursor",
          has_more: true,
        },
      };
    }
    assert.equal(cursor, "page-2-cursor");
    return {
      data: {
        accounts: [],
        added: [],
        modified: [],
        removed: [],
        next_cursor: "final-cursor",
        has_more: false,
      },
    };
  };

  const resumingItem = { ...item, transactionsCursor: "stored-cursor" };
  const result = await pullItem(client, pool, resumingItem, "access-token-1");
  assert.equal(result.status, "ok");
  assert.equal(calls, 2);

  const success = pool.calls.find((call) => call.params?.[0] === "item-1" && call.params?.[1] === "final-cursor");
  assert.ok(success, "the final cursor from the second page was persisted");
});

test("an item whose consented products exclude investments skips the investments calls without failing", async () => {
  const pool = fakePool();
  const client = happyClient();
  client.accountsBalanceGet = async () => ({
    data: {
      accounts: [account],
      item: { consented_products: ["transactions"] },
    },
  });
  let holdingsCalled = false;
  let investmentTransactionsCalled = false;
  client.investmentsHoldingsGet = async () => {
    holdingsCalled = true;
    return { data: { accounts: [], holdings: [], securities: [] } };
  };
  client.investmentsTransactionsGet = async () => {
    investmentTransactionsCalled = true;
    return { data: { securities: [], investment_transactions: [], total_investment_transactions: 0 } };
  };

  const result = await pullItem(client, pool, item, "access-token-1");
  assert.equal(result.status, "ok");
  assert.equal(holdingsCalled, false, "Chase-shaped item: never asks for holdings");
  assert.equal(investmentTransactionsCalled, false);
  assert.equal(result.holdings, 0);
  assert.equal(result.investmentTransactions, 0);
  // The required product (transactions) still ran normally.
  assert.equal(result.transactionsAdded, 1);
});

test("an item with no product list on its Item still attempts investments (tolerating PRODUCTS_NOT_SUPPORTED)", async () => {
  const pool = fakePool();
  const client = happyClient();
  client.accountsBalanceGet = async () => ({ data: { accounts: [account] } });
  let holdingsCalled = false;
  client.investmentsHoldingsGet = async () => {
    holdingsCalled = true;
    throw axiosError("PRODUCTS_NOT_SUPPORTED");
  };

  const result = await pullItem(client, pool, item, "access-token-1");
  assert.equal(result.status, "ok");
  assert.equal(holdingsCalled, true, "an unknown product list is not treated as 'no investments'");
  assert.equal(result.holdings, 0);
});

// PLAID-2: the first real pull hit an institution with 23 accounts and
// failed partway through on a single security's currency CHECK. A per-row
// upsert failure for a security or a holding must be counted, not thrown,
// so the rest of that item -- including transactions fetched afterward --
// still gets written, while the item's exit is still non-zero overall.
test("a security row upsert failure is counted, not thrown, and the rest of the item still writes", async () => {
  const pool = fakePool((text) => text.startsWith("INSERT INTO kith.plaid_securities"));
  const client = happyClient();

  const result = await pullItem(client, pool, item, "access-token-1");
  assert.equal(result.status, "ok");
  // happyClient's security cache-refresh appears in both the holdings
  // response and the investment-transactions response, so this one
  // security fails its upsert twice -- once per call site -- both counted.
  assert.equal(result.rowFailures, 2);
  assert.equal(result.error, null);
  // Balances (fetched before the failing security) and transactions
  // (fetched after it) both still wrote.
  assert.equal(result.balances, 1);
  assert.equal(result.transactionsAdded, 1);
  assert.equal(result.investmentTransactions, 1);

  const success = pool.calls.find((call) =>
    call.text.includes("SET last_pulled_at = transaction_timestamp(),\n            last_pull_error = NULL"),
  );
  assert.ok(success, "the item is still recorded as a success");
});

test("a holding row upsert failure is counted, not thrown, and the rest of the item still writes", async () => {
  const pool = fakePool((text) => text.startsWith("INSERT INTO kith.plaid_holding_snapshots"));
  const client = happyClient();

  const result = await pullItem(client, pool, item, "access-token-1");
  assert.equal(result.status, "ok");
  assert.equal(result.rowFailures, 1);
  assert.equal(result.holdings, 0, "the failed holding was not counted as written");
  assert.equal(result.transactionsAdded, 1);
  assert.equal(result.investmentTransactions, 1);
});

test("a row failure with no other error still makes the caller's process exit non-zero", async () => {
  const pool = fakePool((text) => text.startsWith("INSERT INTO kith.plaid_securities"));
  const client = happyClient();

  const result = await pullItem(client, pool, item, "access-token-1");
  // Mirrors pullAll's own anyFailed computation: status alone would say
  // "ok", but rowFailures must still be visible to a caller deciding the
  // exit code.
  assert.equal(result.status, "ok");
  assert.ok(result.rowFailures > 0);
});
