// Synthetic account list, covering every account kind mapAccountKind
// recognises: brokerage, retirement, trust, bank, credit line and mortgage.
// Invented keys and labels, no real account number, no person.

import { MS_ACCOUNTS_ITEMS_KEY } from "../src/adapter.mjs";

export const ACCOUNTS_RAW = [
  { Id: "MS-ACCT-0001", Name: "nickname", Category: "Investments", AccountType: "Brokerage", IsExternal: false },
  { Id: "MS-ACCT-0002", Name: "nickname", Category: "Investments", AccountType: "Investment Advisory", IsExternal: false },
  { Id: "MS-ACCT-0003", Name: "nickname", Category: "Retirement Accounts", AccountType: "Traditional IRA", IsExternal: false },
  { Id: "MS-ACCT-0004", Name: "nickname", Category: "Retirement Accounts", AccountType: "Roth IRA", IsExternal: false },
  { Id: "MS-ACCT-0005", Name: "nickname", Category: "Trust", AccountType: "Trust", IsExternal: false },
  { Id: "MS-ACCT-0006", Name: "nickname", Category: "Cash Management", AccountType: "Checking", IsExternal: false },
  { Id: "MS-ACCT-0007", Name: "nickname", Category: "Other Loans", AccountType: "Securities-Based Line of Credit", IsExternal: false },
  { Id: "MS-ACCT-0008", Name: "nickname", Category: "Mortgage Loans", AccountType: "Mortgage", IsExternal: false },
  // An aggregated outside-institution account: listed by the site, not held here, excluded by discover.
  { Id: "EXT-ACCT-0009", Name: "nickname", Category: "Investments", AccountType: "Brokerage", IsExternal: true },
];

export function accountsResponse() {
  return { Result: { [MS_ACCOUNTS_ITEMS_KEY]: ACCOUNTS_RAW } };
}
