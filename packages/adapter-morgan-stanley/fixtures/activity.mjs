// Synthetic Morgan Stanley activity-API fixtures. Real field names
// (activityId, transactionSequenceNumber, CCY, processDate, activityDate,
// tradeDate, settlementDate, payDate, referenceNumber, accountName,
// keyAccount, activity, trnType, category, subCategory, description, memo,
// cardNumber, amount, quantity, price, runningBalances (a scalar), symbol,
// cusip, checkNumber, fxCurrency, fxSourceCurrency, fxSourceAmount,
// fxLocalCurrency, fxLocalAmount, fxMarketRate, fxType), entirely invented
// values. No real account number, no person.

import { MS_ACTIVITY_ROWS_KEY } from "../src/adapter.mjs";

const KEY_ACCOUNT = "MS-ACCT-0001";
// The activity POST sends AccountInformation.Grouping "All", so one pull
// returns rows for every account. ROW_7 sits on a second account so the
// fixtures exercise that instead of pretending a pull is single-account.
const SECOND_KEY_ACCOUNT = "MS-ACCT-0003";

// Seven unique rows: a treasury purchase, a sell trade with a price, an
// automated payment, a buy trade with a price, a row with an unparseable
// amount, a row with an unknown (unreviewed) activity value, and a dividend
// on a second account.
export const ROW_1_TREASURY = {
  activityId: "ACT-0001-000001",
  transactionSequenceNumber: 1000001,
  CCY: "-",
  processDate: "2025-01-22",
  activityDate: "2025-01-22",
  tradeDate: "2025-01-21",
  settlementDate: "2025-01-23",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Bought",
  trnType: "Trade",
  category: "Investment",
  subCategory: "Fixed Income",
  description: "TREASURY BILL PURCHASE<br/>RATE:4.500 DUE:2026-03-15",
  amount: -9875.0,
  quantity: 10000,
  price: 98.75,
  symbol: "-",
  cusip: "912796ZZ1",
  checkNumber: null,
  runningBalances: 12345.67,
};

export const ROW_2_SELL_TRADE = {
  activityId: "ACT-0001-000002",
  transactionSequenceNumber: 1000002,
  CCY: "-",
  processDate: "2025-01-15",
  activityDate: "2025-01-15",
  tradeDate: "2025-01-14",
  settlementDate: "2025-01-17",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Sold",
  trnType: "Trade",
  category: "Investment",
  subCategory: "Equity",
  description: "EQUITY SALE",
  amount: 5321.1,
  quantity: 25,
  price: 212.844,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: 22345.67,
};

export const ROW_3_AUTOMATED_PAYMENT = {
  activityId: "ACT-0001-000003",
  transactionSequenceNumber: 1000003,
  CCY: "-",
  processDate: "2025-02-03",
  activityDate: "2025-02-03",
  tradeDate: null,
  settlementDate: "2025-02-03",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "ACH Disbursement",
  trnType: "Cash",
  category: "Payment",
  subCategory: "ACH",
  description: "AUTOMATED PAYMENT<br/>PAYEE:Example Utility Co<br/>ACCT:...4821",
  amount: -150.0,
  quantity: null,
  price: null,
  symbol: "-",
  cusip: null,
  checkNumber: null,
  runningBalances: 22195.67,
};

export const ROW_4_BUY_TRADE = {
  activityId: "ACT-0001-000004",
  transactionSequenceNumber: 1000004,
  CCY: "-",
  processDate: "2025-01-08",
  activityDate: "2025-01-08",
  tradeDate: "2025-01-07",
  settlementDate: "2025-01-10",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Bought",
  trnType: "Trade",
  category: "Investment",
  subCategory: "Equity",
  description: "EQUITY PURCHASE",
  amount: -4578.0,
  quantity: 15,
  price: 305.2,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: 17767.67,
};

export const ROW_5_UNPARSEABLE_AMOUNT = {
  activityId: "ACT-0001-000005",
  transactionSequenceNumber: 1000005,
  CCY: "-",
  processDate: "2025-02-10",
  activityDate: "2025-02-10",
  tradeDate: null,
  settlementDate: "2025-02-10",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Fee",
  trnType: "Fee",
  category: "Fee",
  subCategory: "Account",
  description: "ACCOUNT MAINTENANCE FEE",
  amount: "N/A",
  quantity: null,
  price: null,
  symbol: "-",
  cusip: null,
  checkNumber: null,
  runningBalances: 22195.67,
};

export const ROW_6_UNKNOWN_ACTIVITY = {
  activityId: "ACT-0001-000006",
  transactionSequenceNumber: 1000006,
  CCY: "-",
  processDate: "2025-02-18",
  activityDate: "2025-02-18",
  tradeDate: null,
  settlementDate: "2025-02-18",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Zzyzx Adjustment",
  trnType: "Adjustment",
  category: "Other",
  subCategory: "Other",
  description: "UNCLASSIFIED SHARE ADJUSTMENT",
  amount: 0.0,
  quantity: 5,
  price: null,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: 22195.67,
};

export const ROW_7_DIVIDEND = {
  activityId: "ACT-0001-000007",
  transactionSequenceNumber: 1000007,
  CCY: "-",
  processDate: "2025-02-14",
  activityDate: "2025-02-14",
  tradeDate: null,
  settlementDate: "2025-02-14",
  accountName: "Sample Retirement Account",
  keyAccount: SECOND_KEY_ACCOUNT,
  activity: "Dividend Received",
  trnType: "Income",
  category: "Income",
  subCategory: "Dividend",
  description: "QUARTERLY DIVIDEND",
  amount: 42.17,
  quantity: null,
  price: null,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: 22237.84,
};

export const POSTED_ACTIVITY_COUNT = 7;

function page(rows) {
  return {
    Result: {
      postedActivityCount: POSTED_ACTIVITY_COUNT,
      pendingActivityCount: 0,
      [MS_ACTIVITY_ROWS_KEY]: rows,
    },
  };
}

/** Three pages with a deliberate one-row overlap (ROW_6, repeated on pages 2
 * and 3), matching the pagination-to-provider-total rule:
 * unique rows held reaches 7 (= postedActivityCount) only after page 3. */
export const ACTIVITY_PAGES = [
  page([ROW_1_TREASURY, ROW_2_SELL_TRADE, ROW_3_AUTOMATED_PAYMENT]),
  page([ROW_4_BUY_TRADE, ROW_5_UNPARSEABLE_AMOUNT, ROW_6_UNKNOWN_ACTIVITY]),
  page([ROW_6_UNKNOWN_ACTIVITY, ROW_7_DIVIDEND]),
];

/** A foreign-currency row: CCY carries an ISO code instead of the base-currency
 * "-", and the row states the FX detail fields alongside a person-shaped
 * `memo` and a `cardNumber` -- present here only so retention.test.mjs can
 * prove the FX fields are retained (README, "Retention") while memo and
 * cardNumber are still dropped. Not part of ACTIVITY_PAGES; parse() does not
 * read the FX fields (retained for evidence and later use, not parsed yet). */
export const ROW_9_FOREIGN_CURRENCY = {
  activityId: "ACT-0001-000009",
  transactionSequenceNumber: 1000009,
  CCY: "EUR",
  processDate: "2025-03-04",
  activityDate: "2025-03-04",
  tradeDate: null,
  settlementDate: "2025-03-04",
  payDate: "2025-03-05",
  referenceNumber: "REF-0001-000009",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "ACH Disbursement",
  trnType: "Cash",
  category: "Payment",
  subCategory: "International",
  description: "INTERNATIONAL WIRE",
  memo: "Birthday gift for Sample Person",
  cardNumber: "4111-XXXX-XXXX-1234",
  amount: -100.0,
  quantity: null,
  price: null,
  symbol: "-",
  cusip: null,
  checkNumber: null,
  runningBalances: 22095.67,
  fxCurrency: "EUR",
  fxSourceCurrency: "USD",
  fxSourceAmount: 108.35,
  fxLocalCurrency: "EUR",
  fxLocalAmount: 100.0,
  fxMarketRate: 1.0835,
  fxType: "Spot",
};

/** A page whose response also echoes credential-shaped material: a session
 * token, a device id, and (per-row) accountName -- the field the retention
 * declaration deliberately excludes because it can carry a person's name.
 * Used only to prove retainPayload drops it (README, "Retention": "Two
 * deliberate exclusions"); not part of the paginated ACTIVITY_PAGES set. */
export const ACTIVITY_PAGE_WITH_CREDENTIAL_ECHO = {
  Result: {
    postedActivityCount: POSTED_ACTIVITY_COUNT,
    SessionToken: "eyFAKE.CREDENTIAL.TOKEN",
    DeviceFootprintEcho: "fp-fake-0000",
    [MS_ACTIVITY_ROWS_KEY]: [ROW_1_TREASURY, ROW_9_FOREIGN_CURRENCY],
  },
};

/** A row with a missing CCY, for resolveRowCurrency's review-routing path
 * (src/adapter.mjs). Not part of ACTIVITY_PAGES; used only where a test
 * needs one row with a currency problem. */
export const ROW_8_MISSING_CURRENCY = {
  activityId: "ACT-0001-000008",
  transactionSequenceNumber: 1000008,
  CCY: null,
  processDate: "2025-02-20",
  activityDate: "2025-02-20",
  tradeDate: null,
  settlementDate: "2025-02-20",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Dividend Received",
  trnType: "Income",
  category: "Income",
  subCategory: "Dividend",
  description: "QUARTERLY DIVIDEND",
  amount: 10.0,
  quantity: null,
  price: null,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: 22247.84,
};
