// Synthetic documents-list fixtures, shaped like the response confirmed live
// 2026-09-11 (README, "Documents listing"): `defaultDocumentList` items
// carrying documentGuid, documentTypeName, documentDate (ISO datetime),
// keyAccountNo and friends. Invented ids and dates, no real account number,
// no person.

import { MS_DOCUMENTS_ITEMS_KEY, MS_DOCUMENTS_TOTAL_KEY, documentTimeFrames } from "../src/adapter.mjs";

// The adapter asks for one calendar year at a time, the seven most recent
// years (documentTimeFrames() in ../src/adapter.mjs, oldest first). Derived
// here rather than hardcoded so these fixtures stay inside the confirmed
// window as the calendar turns over.
const YEARS = documentTimeFrames();
export const OLDEST_YEAR = YEARS[0];
export const NEWER_YEAR = YEARS[1];

function rawDocument({ documentGuid, documentTypeName, documentDate, keyAccountNo }) {
  return {
    documentGuid,
    documentId: documentGuid,
    documentTypeName,
    documentDisplayName: documentTypeName,
    documentTitle: documentTypeName,
    documentDate,
    documentLoadDate: documentDate,
    documentSource: "eStatements",
    docFormat: "PDF",
    byteLength: 45678,
    fileName: `${documentGuid}.pdf`,
    keyAccountNo,
    displayMultipleAccounts: false,
    optionalAttributeList: [],
  };
}

// Dated in OLDEST_YEAR -- the first year the adapter queries -- so these
// items are also what a pull that fails outright on its first year (see
// "noTotal" below) has already seen before it stops.
export const STATEMENT_DOCS = [
  rawDocument({ documentGuid: "DOC-STMT-0001", documentTypeName: "ClientStatements", documentDate: `${OLDEST_YEAR}-01-31T00:00:00.000Z`, keyAccountNo: "MS-ACCT-0001" }),
  rawDocument({ documentGuid: "DOC-STMT-0002", documentTypeName: "ClientStatements", documentDate: `${OLDEST_YEAR}-02-28T00:00:00.000Z`, keyAccountNo: "MS-ACCT-0001" }),
  rawDocument({ documentGuid: "DOC-STMT-0003", documentTypeName: "ClientStatements", documentDate: `${OLDEST_YEAR}-02-28T00:00:00.000Z`, keyAccountNo: "MS-ACCT-0002" }),
];

export const CONFIRMATION_DOCS = [
  rawDocument({ documentGuid: "DOC-CONF-0117", documentTypeName: "TradeConfirmations", documentDate: `${OLDEST_YEAR}-01-17T14:32:00.000Z`, keyAccountNo: "MS-ACCT-0001" }),
  rawDocument({ documentGuid: "DOC-CONF-0304", documentTypeName: "TradeConfirmations", documentDate: `${OLDEST_YEAR}-03-04T09:05:00.000Z`, keyAccountNo: "MS-ACCT-0001" }),
  // F1-40. No keyAccountNo: what the listing looks like when the provider
  // omits it for one item -- rowAccountExternalKey (and therefore this
  // document's own accountExternalKey) must come back undefined rather than
  // an empty string, so run.ts files this one institution-wide.
  rawDocument({ documentGuid: "DOC-CONF-0410", documentTypeName: "TradeConfirmations", documentDate: `${OLDEST_YEAR}-04-10T11:00:00.000Z`, keyAccountNo: undefined }),
];

/** One year's `/documents` response body. `numFound` is confirmed a string;
 * omitting it entirely (rather than sending "0") reproduces the provider
 * reporting no total at all for that year. */
export function documentsPage(items, { totalCount } = {}) {
  const body = { [MS_DOCUMENTS_ITEMS_KEY]: items };
  if (totalCount !== null && totalCount !== undefined) body[MS_DOCUMENTS_TOTAL_KEY] = String(totalCount);
  return body;
}

/** Matches MS_DOCUMENTS_PAGE_SIZE in ../src/adapter.mjs: the listing
 * paginates at roughly fifty rows. */
export const DOCUMENTS_PAGE_SIZE = 50;

/** More statements than fit on one page, so the pagination path is exercised
 * end to end. Invented ids and dates, one synthetic account, no person. */
function manyStatementDocs(year, count, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => {
    const n = startIndex + i;
    const month = String((n % 12) + 1).padStart(2, "0");
    return rawDocument({
      documentGuid: `DOC-STMT-${year}-${String(n).padStart(4, "0")}`,
      documentTypeName: "ClientStatements",
      documentDate: `${year}-${month}-15T00:00:00.000Z`,
      keyAccountNo: "MS-ACCT-0001",
    });
  });
}

/** Split across two calendar years, so a pull that pages within a year *and*
 * sums per-year totals into the provider total is exercised end to end:
 * OLDEST_YEAR gets two full pages and a partial third, NEWER_YEAR gets
 * exactly one full page, and the other five years in the window are empty
 * (one request each, reporting a total of zero). */
export const PAGINATED_STATEMENT_DOCS = [
  ...manyStatementDocs(OLDEST_YEAR, DOCUMENTS_PAGE_SIZE * 2 + 3),
  ...manyStatementDocs(NEWER_YEAR, DOCUMENTS_PAGE_SIZE, DOCUMENTS_PAGE_SIZE * 2 + 3),
];
