// Synthetic account list, covering every account kind mapAccountKind
// recognises: brokerage, retirement, trust, bank, credit line and mortgage.
// Invented keys and labels, no real account number, no person.

import { MS_ACCOUNTS_ITEMS_KEY } from "../src/adapter.mjs";

export const ACCOUNTS_RAW = [
  { keyAccount: "MS-ACCT-0001", label: "Brokerage", last4: "1111", accountType: "Brokerage" },
  { keyAccount: "MS-ACCT-0002", label: "Managed Program", last4: "2222", accountType: "Investment Advisory" },
  { keyAccount: "MS-ACCT-0003", label: "Traditional IRA", last4: "3333", accountType: "IRA" },
  { keyAccount: "MS-ACCT-0004", label: "Roth IRA", last4: "4444", accountType: "IRA" },
  { keyAccount: "MS-ACCT-0005", label: "Trust Account", last4: "5555", accountType: "Trust" },
  { keyAccount: "MS-ACCT-0006", label: "Cash Account", last4: "6666", accountType: "Checking" },
  { keyAccount: "MS-ACCT-0007", label: "Securities-Based Line of Credit", last4: "7777", accountType: "Securities-Based Line of Credit" },
  { keyAccount: "MS-ACCT-0008", label: "Mortgage", last4: "8888", accountType: "Mortgage" },
];

export function accountsResponse() {
  return { [MS_ACCOUNTS_ITEMS_KEY]: ACCOUNTS_RAW };
}
