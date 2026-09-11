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
  // F1-40. No keyAccount: what the listing looks like when the provider
  // omits it for one item -- rowAccountExternalKey (and therefore this
  // document's own accountExternalKey) must come back undefined rather than
  // an empty string, so run.ts files this one institution-wide.
  { externalId: "CONF-2025-0410", keyAccount: undefined, periodStart: "2025-04-10", periodEnd: "2025-04-10", label: "Trade confirmation, April 10 2025" },
];

export function documentsPage(items, { docType, totalCount }) {
  return { [MS_DOCUMENTS_ITEMS_KEY]: items, [MS_DOCUMENTS_TOTAL_KEY]: totalCount, docType };
}

/** Matches MS_DOCUMENTS_PAGE_SIZE in ../src/adapter.mjs: the listing
 * paginates at roughly fifty rows. */
export const DOCUMENTS_PAGE_SIZE = 50;

/** More statements than fit on one page, so the pagination path is exercised
 * end to end. Invented ids and dates, one synthetic account, no person. */
function manyStatementDocs(count) {
  return Array.from({ length: count }, (_, i) => {
    const year = 2015 + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, "0");
    return {
      externalId: `STMT-${year}-${month}`,
      keyAccount: "MS-ACCT-0001",
      periodStart: `${year}-${month}-01`,
      periodEnd: `${year}-${month}-28`,
      label: `${year}-${month} statement`,
    };
  });
}

/** Two full pages and a partial third. */
export const PAGINATED_STATEMENT_DOCS = manyStatementDocs(DOCUMENTS_PAGE_SIZE * 2 + 3);
