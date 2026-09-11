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
 * @param {"exhaustive"|"noTotal"|"paginated"} [options.documentsMode] how the documents-list fixture reports its total ("paginated" also serves more statements than one page holds)
 * @param {{docType: string, timeFrame: string, page: string}[]} [options.documentsPagesRequested] collects every documents page the adapter asked for, in order (one calendar year at a time, per documentTimeFrames())
 * @param {boolean} [options.documentDownloadHtml] serve an HTML login page instead of a PDF for a document download
 * @param {boolean} [options.documentsFail] make every /documents fetch throw (e.g. the missing Authorization bearer)
 * @param {number} [options.accountsStatus] make /accounts throw a bridge-shaped "request failed: <status> ..." error
 */
export function createFixtureSession(options = {}) {
  const documentsMode = options.documentsMode ?? "exhaustive";

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
      if (options.documentsFail) {
        throw new Error("request failed: 401 missing Authorization bearer (synthetic)");
      }
      options.documentsPagesRequested?.push({ docType: query.docType, timeFrame: query.timeFrame, page: query.page });
      const statements = documentsMode === "paginated" ? PAGINATED_STATEMENT_DOCS : STATEMENT_DOCS;
      const source = query.docType === "ClientStatements" ? statements : CONFIRMATION_DOCS;
      // The adapter asks one calendar year at a time (TimeFrame), and the
      // real listing serves one page per request within that year -- the
      // fixture has to slice the same way, per year.
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
