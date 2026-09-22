// Pure mapping from Plaid's own response shapes to this package's rows. No
// network, no database: fixtures below are shaped like real Plaid responses
// (with synthetic ids and amounts), matching the repo's rule that these
// tests never need a live source.

import assert from "node:assert/strict";
import test from "node:test";

import {
  institutionSlug,
  isItemLoginRequired,
  isProductNotSupported,
  itemKeychainService,
  mapAccount,
  mapBalanceSnapshot,
  mapCurrency,
  mapHoldingSnapshot,
  mapInvestmentTransaction,
  mapRemovedTransactionId,
  mapSecurity,
  mapTransaction,
  normalizeOptionalString,
  plaidErrorCode,
  todayIsoDate,
} from "../dist/index.js";

const account = {
  account_id: "acc-1",
  balances: {
    available: 100.5,
    current: 120,
    limit: null,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
  },
  mask: "1234",
  name: "Brokerage",
  official_name: "Individual Brokerage Account",
  type: "investment",
  subtype: "brokerage",
};

test("mapAccount carries the account's identity and type, not its balance", () => {
  const row = mapAccount(account, "item-1");
  assert.deepEqual(row, {
    accountId: "acc-1",
    itemId: "item-1",
    name: "Brokerage",
    officialName: "Individual Brokerage Account",
    mask: "1234",
    type: "investment",
    subtype: "brokerage",
    currency: "USD",
  });
});

test("mapAccount falls back to the unofficial currency code when there is no ISO one", () => {
  const row = mapAccount(
    {
      ...account,
      balances: { ...account.balances, iso_currency_code: null, unofficial_currency_code: "XYZ" },
    },
    "item-1",
  );
  assert.equal(row.currency, "XYZ");
});

test("mapAccount handles a null subtype", () => {
  const row = mapAccount({ ...account, subtype: null }, "item-1");
  assert.equal(row.subtype, null);
});

test("mapBalanceSnapshot carries current/available/limit and keeps the raw account", () => {
  const snapshot = mapBalanceSnapshot(account, "2026-09-22");
  assert.equal(snapshot.accountId, "acc-1");
  assert.equal(snapshot.asOf, "2026-09-22");
  assert.equal(snapshot.current, 120);
  assert.equal(snapshot.available, 100.5);
  assert.equal(snapshot.limitAmount, null);
  assert.equal(snapshot.currency, "USD");
  assert.equal(snapshot.raw, account);
});

const security = {
  security_id: "sec-1",
  name: "Vanguard Total Stock Market Index Fund",
  ticker_symbol: "VTSAX",
  type: "mutual fund",
  close_price: 123.45,
  close_price_as_of: "2026-09-21",
  iso_currency_code: "USD",
  unofficial_currency_code: null,
};

test("mapSecurity is a direct field mapping", () => {
  assert.deepEqual(mapSecurity(security), {
    securityId: "sec-1",
    name: "Vanguard Total Stock Market Index Fund",
    tickerSymbol: "VTSAX",
    type: "mutual fund",
    closePrice: 123.45,
    closePriceAsOf: "2026-09-21",
    currency: "USD",
  });
});

const holding = {
  account_id: "acc-1",
  security_id: "sec-1",
  institution_price: 123.45,
  institution_value: 4938,
  cost_basis: 4000,
  quantity: 40,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
};

test("mapHoldingSnapshot renames institution_price/institution_value to price/value", () => {
  const snapshot = mapHoldingSnapshot(holding, "2026-09-22");
  assert.equal(snapshot.accountId, "acc-1");
  assert.equal(snapshot.securityId, "sec-1");
  assert.equal(snapshot.price, 123.45);
  assert.equal(snapshot.value, 4938);
  assert.equal(snapshot.quantity, 40);
  assert.equal(snapshot.costBasis, 4000);
});

const transaction = {
  transaction_id: "tx-1",
  account_id: "acc-2",
  date: "2026-09-20",
  authorized_date: "2026-09-19",
  name: "Grocery Store",
  merchant_name: "Grocery Co",
  amount: 42.1,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  pending: false,
  personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" },
};

test("mapTransaction takes the category's primary label and starts un-removed", () => {
  const row = mapTransaction(transaction, "item-1");
  assert.equal(row.transactionId, "tx-1");
  assert.equal(row.itemId, "item-1");
  assert.equal(row.category, "FOOD_AND_DRINK");
  assert.equal(row.removedAt, null);
  assert.equal(row.pending, false);
});

test("mapTransaction tolerates a transaction with no personal_finance_category", () => {
  const row = mapTransaction({ ...transaction, personal_finance_category: undefined }, "item-1");
  assert.equal(row.category, null);
});

test("mapRemovedTransactionId is the removed transaction's id", () => {
  assert.equal(mapRemovedTransactionId({ transaction_id: "tx-9" }), "tx-9");
});

const investmentTransaction = {
  investment_transaction_id: "itx-1",
  account_id: "acc-1",
  security_id: "sec-1",
  date: "2026-09-15",
  name: "Buy VTSAX",
  quantity: 5,
  amount: -617.25,
  price: 123.45,
  fees: 0,
  type: "buy",
  subtype: "buy",
  iso_currency_code: "USD",
  unofficial_currency_code: null,
};

test("mapInvestmentTransaction carries the security and coerces type/subtype to strings", () => {
  const row = mapInvestmentTransaction(investmentTransaction, "item-1");
  assert.equal(row.investmentTransactionId, "itx-1");
  assert.equal(row.securityId, "sec-1");
  assert.equal(row.type, "buy");
  assert.equal(row.subtype, "buy");
  assert.equal(row.itemId, "item-1");
});

test("mapInvestmentTransaction allows a null security_id (cash transactions)", () => {
  const row = mapInvestmentTransaction({ ...investmentTransaction, security_id: null }, "item-1");
  assert.equal(row.securityId, null);
});

function axiosError(errorCode) {
  return { response: { data: { error_code: errorCode } } };
}

test("plaidErrorCode reads an axios-shaped Plaid error", () => {
  assert.equal(plaidErrorCode(axiosError("ITEM_LOGIN_REQUIRED")), "ITEM_LOGIN_REQUIRED");
  assert.equal(plaidErrorCode(new Error("boom")), null);
  assert.equal(plaidErrorCode(null), null);
  assert.equal(plaidErrorCode({}), null);
});

test("isItemLoginRequired matches only that one error code", () => {
  assert.equal(isItemLoginRequired(axiosError("ITEM_LOGIN_REQUIRED")), true);
  assert.equal(isItemLoginRequired(axiosError("INVALID_ACCESS_TOKEN")), false);
  assert.equal(isItemLoginRequired(new Error("network down")), false);
});

test("isProductNotSupported matches the institution-capability codes, not login errors", () => {
  assert.equal(isProductNotSupported(axiosError("PRODUCTS_NOT_SUPPORTED")), true);
  assert.equal(isProductNotSupported(axiosError("NO_INVESTMENT_ACCOUNTS")), true);
  assert.equal(isProductNotSupported(axiosError("ITEM_LOGIN_REQUIRED")), false);
});

test("todayIsoDate formats a Date as YYYY-MM-DD", () => {
  assert.equal(todayIsoDate(new Date("2026-09-22T18:30:00Z")), "2026-09-22");
});

test("institutionSlug lowercases, hyphenates and strips punctuation", () => {
  assert.equal(institutionSlug("Morgan Stanley"), "morgan-stanley");
  assert.equal(institutionSlug("Fidelity Investments"), "fidelity-investments");
  assert.equal(institutionSlug("Chase"), "chase");
  assert.equal(institutionSlug("  Vanguard, Inc.  "), "vanguard-inc");
});

test("itemKeychainService namespaces the slug under the fixed Keychain prefix", () => {
  assert.equal(
    itemKeychainService("Morgan Stanley"),
    "com.kithmind.plaid.item.morgan-stanley",
  );
});

// PLAID-2: the first real pull hit an institution whose securities carried
// a null iso_currency_code with an unofficial_currency_code (a crypto
// ticker, or a code longer than three letters), which the old
// `^[A-Z]{3}$` CHECK rejected outright. mapCurrency is the fallback that
// feeds the relaxed migration-044 CHECK.
test("mapCurrency prefers the ISO code when both are present", () => {
  assert.equal(mapCurrency("USD", "XYZ"), "USD");
});

test("mapCurrency falls back to the unofficial code when there is no ISO one", () => {
  assert.equal(mapCurrency(null, "BTC-USD"), "BTC-USD");
});

test("mapCurrency is null when neither code is present", () => {
  assert.equal(mapCurrency(null, null), null);
  assert.equal(mapCurrency(undefined, undefined), null);
});

test("mapCurrency uppercases a lowercase code", () => {
  assert.equal(mapCurrency("usd", null), "USD");
  assert.equal(mapCurrency(null, "eth"), "ETH");
});

test("mapCurrency passes through a code longer than three letters, trimmed", () => {
  assert.equal(mapCurrency(null, "  DOGE1  "), "DOGE1");
});

// PLAID-4: the second real pull failed partway through -- after 949
// investment-transaction rows had already been fetched and written -- on
// "new row for relation \"plaid_investment_transactions\" violates check
// constraint \"plaid_investment_transactions_subtype_check\"": Plaid sent an
// empty string, not just an unexpected one, for `subtype`. `normalizeOptionalString`
// is the fallback that feeds migration 047's relaxed CHECKs.
test("normalizeOptionalString trims and keeps a normal string", () => {
  assert.equal(normalizeOptionalString("  buy  "), "buy");
  assert.equal(normalizeOptionalString("buy"), "buy");
});

test("normalizeOptionalString maps an empty or whitespace-only string to null", () => {
  assert.equal(normalizeOptionalString(""), null);
  assert.equal(normalizeOptionalString("   "), null);
});

test("normalizeOptionalString maps null, undefined and a non-string value to null instead of throwing", () => {
  assert.equal(normalizeOptionalString(null), null);
  assert.equal(normalizeOptionalString(undefined), null);
  assert.equal(normalizeOptionalString(42), null);
  assert.equal(normalizeOptionalString({}), null);
});

test("mapAccount normalizes an empty official_name, mask and subtype to null", () => {
  const row = mapAccount(
    { ...account, official_name: "", mask: "", subtype: "" },
    "item-1",
  );
  assert.equal(row.officialName, null);
  assert.equal(row.mask, null);
  assert.equal(row.subtype, null);
});

test("mapSecurity normalizes an empty name, ticker_symbol and type to null", () => {
  const row = mapSecurity({ ...security, name: "", ticker_symbol: "", type: "" });
  assert.equal(row.name, null);
  assert.equal(row.tickerSymbol, null);
  assert.equal(row.type, null);
});

test("mapTransaction normalizes an empty name, merchant_name and category to null", () => {
  const row = mapTransaction(
    {
      ...transaction,
      name: "",
      merchant_name: "",
      personal_finance_category: { primary: "" },
    },
    "item-1",
  );
  assert.equal(row.name, null);
  assert.equal(row.merchantName, null);
  assert.equal(row.category, null);
});

test("mapInvestmentTransaction normalizes an empty name, type and subtype to null instead of the string \"undefined\"", () => {
  // The exact bug: the old `String(transaction.subtype)` coercion turned an
  // empty subtype into the string "" (still empty, still rejected by the
  // old CHECK) and would have turned a missing one into the literal string
  // "undefined" (accepted by the old CHECK, but wrong data).
  const row = mapInvestmentTransaction(
    { ...investmentTransaction, name: "", type: "", subtype: "" },
    "item-1",
  );
  assert.equal(row.name, null);
  assert.equal(row.type, null);
  assert.equal(row.subtype, null);
});
