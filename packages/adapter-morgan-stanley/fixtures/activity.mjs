// Synthetic Morgan Stanley activity-API fixtures. Real field names
// (processDate, activityDate, tradeDate, settlementDate, accountName,
// keyAccount, activity, CCY, description, amount, quantity, price, symbol,
// cusip, checkNumber), entirely invented values. No real account number, no
// person.

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
  processDate: "2025-01-22",
  activityDate: "2025-01-22",
  tradeDate: "2025-01-21",
  settlementDate: "2025-01-23",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Bought",
  CCY: "-",
  description: "TREASURY BILL PURCHASE<br/>RATE:4.500 DUE:2026-03-15",
  amount: -9875.0,
  quantity: 10000,
  price: 98.75,
  symbol: "-",
  cusip: "912796ZZ1",
  checkNumber: null,
  runningBalances: { cash: "12345.67", totalValue: "204981.02" },
};

export const ROW_2_SELL_TRADE = {
  processDate: "2025-01-15",
  activityDate: "2025-01-15",
  tradeDate: "2025-01-14",
  settlementDate: "2025-01-17",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Sold",
  CCY: "-",
  description: "EQUITY SALE",
  amount: 5321.1,
  quantity: 25,
  price: 212.844,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: { cash: "22345.67", totalValue: "208981.02" },
};

export const ROW_3_AUTOMATED_PAYMENT = {
  processDate: "2025-02-03",
  activityDate: "2025-02-03",
  tradeDate: null,
  settlementDate: "2025-02-03",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "ACH Disbursement",
  CCY: "-",
  description: "AUTOMATED PAYMENT<br/>PAYEE:Example Utility Co<br/>ACCT:...4821",
  amount: -150.0,
  quantity: null,
  price: null,
  symbol: "-",
  cusip: null,
  checkNumber: null,
  runningBalances: { cash: "22195.67", totalValue: "208831.02" },
};

export const ROW_4_BUY_TRADE = {
  processDate: "2025-01-08",
  activityDate: "2025-01-08",
  tradeDate: "2025-01-07",
  settlementDate: "2025-01-10",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Bought",
  CCY: "-",
  description: "EQUITY PURCHASE",
  amount: -4578.0,
  quantity: 15,
  price: 305.2,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: { cash: "17767.67", totalValue: "204403.02" },
};

export const ROW_5_UNPARSEABLE_AMOUNT = {
  processDate: "2025-02-10",
  activityDate: "2025-02-10",
  tradeDate: null,
  settlementDate: "2025-02-10",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Fee",
  CCY: "-",
  description: "ACCOUNT MAINTENANCE FEE",
  amount: "N/A",
  quantity: null,
  price: null,
  symbol: "-",
  cusip: null,
  checkNumber: null,
  runningBalances: { cash: "22195.67", totalValue: "208831.02" },
};

export const ROW_6_UNKNOWN_ACTIVITY = {
  processDate: "2025-02-18",
  activityDate: "2025-02-18",
  tradeDate: null,
  settlementDate: "2025-02-18",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Zzyzx Adjustment",
  CCY: "-",
  description: "UNCLASSIFIED SHARE ADJUSTMENT",
  amount: 0.0,
  quantity: 5,
  price: null,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: { cash: "22195.67", totalValue: "208831.02" },
};

export const ROW_7_DIVIDEND = {
  processDate: "2025-02-14",
  activityDate: "2025-02-14",
  tradeDate: null,
  settlementDate: "2025-02-14",
  accountName: "Sample Retirement Account",
  keyAccount: SECOND_KEY_ACCOUNT,
  activity: "Dividend Received",
  CCY: "-",
  description: "QUARTERLY DIVIDEND",
  amount: 42.17,
  quantity: null,
  price: null,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: { cash: "22237.84", totalValue: "208873.19" },
};

export const POSTED_ACTIVITY_COUNT = 7;

function page(rows) {
  return { Result: { postedActivityCount: POSTED_ACTIVITY_COUNT, [MS_ACTIVITY_ROWS_KEY]: rows } };
}

/** Three pages with a deliberate one-row overlap (ROW_6, repeated on pages 2
 * and 3), matching the pagination-to-provider-total rule:
 * unique rows held reaches 7 (= postedActivityCount) only after page 3. */
export const ACTIVITY_PAGES = [
  page([ROW_1_TREASURY, ROW_2_SELL_TRADE, ROW_3_AUTOMATED_PAYMENT]),
  page([ROW_4_BUY_TRADE, ROW_5_UNPARSEABLE_AMOUNT, ROW_6_UNKNOWN_ACTIVITY]),
  page([ROW_6_UNKNOWN_ACTIVITY, ROW_7_DIVIDEND]),
];

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
    [MS_ACTIVITY_ROWS_KEY]: [ROW_1_TREASURY],
  },
};

/** A row with a missing CCY, for resolveRowCurrency's review-routing path
 * (src/adapter.mjs). Not part of ACTIVITY_PAGES; used only where a test
 * needs one row with a currency problem. */
export const ROW_8_MISSING_CURRENCY = {
  processDate: "2025-02-20",
  activityDate: "2025-02-20",
  tradeDate: null,
  settlementDate: "2025-02-20",
  accountName: "Sample Brokerage Account",
  keyAccount: KEY_ACCOUNT,
  activity: "Dividend Received",
  CCY: null,
  description: "QUARTERLY DIVIDEND",
  amount: 10.0,
  quantity: null,
  price: null,
  symbol: "WNDF",
  cusip: "00000WNF1",
  checkNumber: null,
  runningBalances: { cash: "22247.84", totalValue: "208883.19" },
};
