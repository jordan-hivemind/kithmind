// A fixture-backed AdapterSession for testing src/adapter.mjs without a
// browser, a site or a session -- the same role synthetic Trust's
// createSyntheticSession plays for the reference adapter. src/bridge.mjs (the
// only thing that talks to a real signed-in tab) has its own proof in
// ../spike/. Nothing in the test suite runs against the institution or a
// browser.

import { ACTIVITY_PAGES } from "./activity.mjs";
import {
  STATEMENT_DOCS,
  CONFIRMATION_DOCS,
  PAGINATED_STATEMENT_DOCS,
  MOST_RECENT_YEAR,
  OVERLAP_DOC,
  LAST12MONTHS_ONLY_DOC,
  documentsPage,
  DOCUMENTS_PAGE_SIZE,
} from "./documents.mjs";
import { TABULAR_EXPORT_CSV } from "./tabular.mjs";
import { STATEMENT_LINES, CONFIRMATION_LINES } from "./statementLines.mjs";
import { accountsResponse } from "./accounts.mjs";
import { buildMinimalPdf } from "./pdf.mjs";

/**
 * @param {object} [options]
 * @param {number} [options.activityFailAtPage] fail the activity fetch for this page number once
 * @param {"exhaustive"|"noTotal"|"paginated"|"overlapping"} [options.documentsMode] how the documents-list fixture reports its total ("paginated" also serves more statements than one page holds; "overlapping" serves the same ClientStatements document under MOST_RECENT_YEAR and again under Last12Months, per F1-42)
 * @param {{docType: string, timeFrame: string, page: string}[]} [options.documentsPagesRequested] collects every *successful* documents page the adapter asked for, in order (one calendar year at a time, per documentTimeFrames())
 * @param {{docType: string, timeFrame: string, page: string}[]} [options.documentsCallLog] collects every /documents attempt, successful or not (unlike documentsPagesRequested, which only sees successes) -- used to prove retry counts and pull ordering
 * @param {number} [options.documentsServiceErrorCount] make this many leading /documents calls throw the transient "request failed: 400 ... Service Error" fetchWithServiceErrorRetry retries (src/adapter.mjs); calls after the budget is spent succeed normally
 * @param {Promise<void>} [options.documentsGateFirstCall] awaited before answering the very first /documents call, so a test can observe what has (not) run while it is pending -- proves the two document types are pulled sequentially, not concurrently
 * @param {boolean} [options.documentDownloadHtml] serve an HTML login page instead of a PDF for a document download
 * @param {boolean} [options.documentsFail] make every /documents fetch throw (e.g. the missing Authorization bearer)
 * @param {number} [options.accountsStatus] make /accounts throw a bridge-shaped "request failed: <status> ..." error
 */
export function createFixtureSession(options = {}) {
  const documentsMode = options.documentsMode ?? "exhaustive";
  let serviceErrorsRemaining = options.documentsServiceErrorCount ?? 0;
  let gatedFirstCall = false;

  async function fetchText(path, query = {}) {
    if (path === "/activity") {
      const pageNumber = Number(query.page ?? "1");
      if (pageNumber === options.activityFailAtPage) {
        throw new Error(`synthetic outage on page ${pageNumber}`);
      }
      const page = ACTIVITY_PAGES[pageNumber - 1];
      if (!page) throw new RangeError(`fixture session: no activity page ${pageNumber}`);
      return JSON.stringify(page);
    }
    if (path === "/documents") {
      const isFirstCall = !gatedFirstCall;
      gatedFirstCall = true;
      // Logged before the gate so a test can observe that this call has
      // *started* while it is still pending -- that is what proves a later
      // call did or did not start concurrently with it.
      options.documentsCallLog?.push({ docType: query.docType, timeFrame: query.timeFrame, page: query.page });
      if (isFirstCall && options.documentsGateFirstCall) await options.documentsGateFirstCall;
      if (options.documentsFail) {
        throw new Error("request failed: 401 missing Authorization bearer (synthetic)");
      }
      if (serviceErrorsRemaining > 0) {
        serviceErrorsRemaining -= 1;
        throw new Error("request failed: 400 Service Error (synthetic transient failure)");
      }
      options.documentsPagesRequested?.push({ docType: query.docType, timeFrame: query.timeFrame, page: query.page });
      // "overlapping" (F1-42): the same ClientStatements document is served
      // under both MOST_RECENT_YEAR and Last12Months, plus a second document
      // Last12Months alone reports -- every other timeframe is empty.
      if (documentsMode === "overlapping" && query.docType === "ClientStatements") {
        const items =
          query.timeFrame === MOST_RECENT_YEAR
            ? [OVERLAP_DOC]
            : query.timeFrame === "Last12Months"
              ? [OVERLAP_DOC, LAST12MONTHS_ONLY_DOC]
              : [];
        return JSON.stringify(documentsPage(items, { totalCount: items.length }));
      }
      const statements = documentsMode === "paginated" ? PAGINATED_STATEMENT_DOCS : STATEMENT_DOCS;
      const source = query.docType === "ClientStatements" ? statements : CONFIRMATION_DOCS;
      // The adapter asks one calendar year at a time (TimeFrame), and the
      // real listing serves one page per request within that year -- the
      // fixture has to slice the same way, per year. "Last12Months" never
      // matches a four-digit year, so it reports empty here unless
      // documentsMode is "overlapping" (handled above).
      const yearItems = source.filter((d) => String(d.documentDate).slice(0, 4) === query.timeFrame);
      const page = Number(query.page ?? "1");
      const items = yearItems.slice((page - 1) * DOCUMENTS_PAGE_SIZE, page * DOCUMENTS_PAGE_SIZE);
      if (documentsMode === "noTotal") {
        return JSON.stringify(documentsPage(items, { totalCount: null }));
      }
      return JSON.stringify(documentsPage(items, { totalCount: yearItems.length }));
    }
    if (path === "/export/tabular") {
      return TABULAR_EXPORT_CSV;
    }
    if (path === "/accounts") {
      if (options.accountsStatus) {
        throw new Error(`request failed: ${options.accountsStatus} synthetic accounts outage`);
      }
      return JSON.stringify(accountsResponse());
    }
    throw new RangeError(`fixture session: unknown path ${path}`);
  }

  async function fetchBytes(path) {
    if (path.startsWith("/documents/")) {
      if (options.documentDownloadHtml) {
        // What a signed-out or mis-routed download answers with, at HTTP 200.
        return new TextEncoder().encode("<!doctype html><title>Sign in</title>");
      }
      const [docId] = path.slice("/documents/".length).split("::");
      const lines = docId.includes("CONF") ? CONFIRMATION_LINES : STATEMENT_LINES;
      return buildMinimalPdf(lines.split("\n"));
    }
    return new TextEncoder().encode(await fetchText(path));
  }

  return { institutionSlug: "morgan-stanley", fetchText, fetchBytes };
}
