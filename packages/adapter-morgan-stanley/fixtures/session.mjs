// A fixture-backed AdapterSession for testing src/adapter.mjs without a
// browser, a site or a session -- the same role synthetic Trust's
// createSyntheticSession plays for the reference adapter. src/bridge.mjs (the
// only thing that talks to a real signed-in tab) has its own proof in
// ../spike/. Nothing in the test suite runs against the institution or a
// browser.

import { ACTIVITY_PAGES } from "./activity.mjs";
import { STATEMENT_DOCS, CONFIRMATION_DOCS, documentsPage } from "./documents.mjs";
import { TABULAR_EXPORT_CSV } from "./tabular.mjs";
import { STATEMENT_LINES, CONFIRMATION_LINES } from "./statementLines.mjs";
import { accountsResponse } from "./accounts.mjs";
import { buildMinimalPdf } from "./pdf.mjs";

/**
 * @param {object} [options]
 * @param {number} [options.activityFailAtPage] fail the activity fetch for this page number once
 * @param {"exhaustive"|"noTotal"} [options.documentsMode] how the documents-list fixture reports its total
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
      const source = query.docType === "Statements" ? STATEMENT_DOCS : CONFIRMATION_DOCS;
      if (documentsMode === "noTotal") {
        return JSON.stringify(documentsPage(source, { docType: query.docType, totalCount: null }));
      }
      return JSON.stringify(documentsPage(source, { docType: query.docType, totalCount: source.length }));
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
      const [docId] = path.slice("/documents/".length).split("::");
      const lines = docId.startsWith("CONF-") ? CONFIRMATION_LINES : STATEMENT_LINES;
      return buildMinimalPdf(lines.split("\n"));
    }
    return new TextEncoder().encode(await fetchText(path));
  }

  return { institutionSlug: "morgan-stanley", fetchText, fetchBytes };
}
