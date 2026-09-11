// Synthetic documents-list fixtures. Real field names from the observed request
// ("Documents > Account Documents, filterable by account, type ... and
// timeframe"), invented ids and dates. No real account number, no person.

import { MS_DOCUMENTS_ITEMS_KEY, MS_DOCUMENTS_TOTAL_KEY } from "../src/adapter.mjs";

export const STATEMENT_DOCS = [
  { externalId: "STMT-2025-01", keyAccount: "MS-ACCT-0001", periodStart: "2025-01-01", periodEnd: "2025-01-31", label: "January 2025 statement" },
  { externalId: "STMT-2025-02", keyAccount: "MS-ACCT-0001", periodStart: "2025-02-01", periodEnd: "2025-02-28", label: "February 2025 statement" },
  { externalId: "STMT-2025-02-B", keyAccount: "MS-ACCT-0002", periodStart: "2025-02-01", periodEnd: "2025-02-28", label: "February 2025 statement" },
];

export const CONFIRMATION_DOCS = [
  { externalId: "CONF-2025-0117", keyAccount: "MS-ACCT-0001", periodStart: "2025-01-17", periodEnd: "2025-01-17", label: "Trade confirmation, January 17 2025" },
  { externalId: "CONF-2025-0304", keyAccount: "MS-ACCT-0001", periodStart: "2025-03-04", periodEnd: "2025-03-04", label: "Trade confirmation, March 4 2025" },
];

export function documentsPage(items, { docType, totalCount }) {
  return { [MS_DOCUMENTS_ITEMS_KEY]: items, [MS_DOCUMENTS_TOTAL_KEY]: totalCount, docType };
}
