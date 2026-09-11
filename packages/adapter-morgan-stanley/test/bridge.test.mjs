// Unit tests for the pure request-building helpers in src/bridge.mjs only.
// The CDP mechanics (attach, hook, reload, page-context fetch) are proven
// credential-free against a local page in ../spike/bridge-spike.mjs; per the
// design, nothing here opens a browser or talks to a real site.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WANTED_HEADERS,
  buildActivityRequestBody,
  buildDocumentsRequestBody,
  pageFetchExpression,
  resolveEndpoint,
} from "../src/bridge.mjs";

test("buildActivityRequestBody follows the captured request template exactly", () => {
  const body = JSON.parse(
    buildActivityRequestBody({ page: "2", pageSize: "500", dateRangeType: "Last90Days", startDate: "2025-01-01", endDate: "2025-03-31" }),
  );
  assert.equal(body.Pagination.Posted.PageNumber, 2);
  assert.equal(body.Pagination.Posted.PageSize, 500);
  assert.equal(body.Pagination.Posted.Return, true);
  assert.equal(body.Pagination.Pending.Return, false);
  assert.equal(body.DateRangeType, "Last90Days");
  assert.equal(body.StartDate, "2025-01-01");
  assert.equal(body.EndDate, "2025-03-31");
  assert.equal(body.AccountInformation.Grouping, "All");
});

test("buildActivityRequestBody defaults page 1 and YearToDate when the caller omits them", () => {
  const body = JSON.parse(buildActivityRequestBody());
  assert.equal(body.Pagination.Posted.PageNumber, 1);
  assert.equal(body.DateRangeType, "YearToDate");
  assert.equal(body.StartDate, "");
  assert.equal(body.EndDate, "");
});

test("buildDocumentsRequestBody sends the confirmed body keys and nothing else", () => {
  const body = JSON.parse(
    buildDocumentsRequestBody({ docType: "ClientStatements", keyAccount: "MS-ACCT-0001", page: "3" }),
  );
  assert.deepEqual(Object.keys(body).sort(), ["TimeFrame", "endDate", "filters", "pageNum", "sortBy", "startDate"].sort());
  // Confirmed live: pageNum is a string.
  assert.equal(body.pageNum, "3");
  // Confirmed live: filters are named entries, one each for KeyAccountNo,
  // DocType and DocSubType, every one carrying its value(s) in `values`.
  assert.equal(body.filters.length, 3);
  assert.deepEqual(
    body.filters.map((f) => f.filterName),
    ["KeyAccountNo", "DocType", "DocSubType"],
  );
  assert.deepEqual(body.filters[0].values, ["MS-ACCT-0001"]);
  assert.deepEqual(body.filters[1].values, ["ClientStatements"]);
  assert.deepEqual(body.filters[2].values, ["All"]);
  // Confirmed live: sortBy is an array, newest first by date then account.
  assert.deepEqual(body.sortBy, [
    { fieldName: "DocDate", sortOrder: "DESC" },
    { fieldName: "KeyAccountNo", sortOrder: "DESC" },
  ]);
  // No period requested, so the listing asks for the whole history.
  assert.equal(body.TimeFrame, "All");
  assert.equal(body.startDate, "");
});

test("buildDocumentsRequestBody defaults the KeyAccountNo and DocSubType filters to All", () => {
  const body = JSON.parse(buildDocumentsRequestBody({ docType: "TradeConfirmations" }));
  assert.deepEqual(body.filters[0].values, ["All"]);
  assert.deepEqual(body.filters[2].values, ["All"]);
  assert.equal(body.pageNum, "1");
});

test("buildDocumentsRequestBody carries an explicit TimeFrame -- Last30Days, Last90Days, Last12Months or a calendar year -- through unchanged", () => {
  for (const timeFrame of ["Last30Days", "Last90Days", "Last12Months", "2025"]) {
    const body = JSON.parse(buildDocumentsRequestBody({ docType: "ClientStatements", timeFrame }));
    assert.equal(body.TimeFrame, timeFrame);
  }
});

test("buildDocumentsRequestBody carries an explicit Custom TimeFrame alongside caller-supplied dates", () => {
  const body = JSON.parse(
    buildDocumentsRequestBody({ docType: "ClientStatements", timeFrame: "Custom", startDate: "2025-01-01", endDate: "2025-03-31" }),
  );
  assert.equal(body.TimeFrame, "Custom");
  assert.equal(body.startDate, "2025-01-01");
  assert.equal(body.endDate, "2025-03-31");
});

test("the documents list posts to the confirmed path with a fresh RequestID and SeqID", () => {
  const request = resolveEndpoint("/documents", { docType: "ClientStatements" });
  assert.equal(request.method, "POST");
  // Confirmed live: eight groups of four hex characters.
  assert.match(
    request.url,
    /^\/msoaz\/api\/acdsal\/accountdocs\/v2\/searchItems\?RequestID=([0-9a-f]{4}-){7}[0-9a-f]{4}&SeqID=\d{4}$/,
  );
  assert.notEqual(request.url, resolveEndpoint("/documents", { docType: "ClientStatements" }).url);
});

test("the header allowlist is exactly three header names", () => {
  assert.deepEqual([...WANTED_HEADERS].sort(), ["authorization", "x-device-footprint", "x-xsrf-token"]);
});

test("the page fetch expression forwards the captured headers without ever reading a value out", () => {
  const expression = pageFetchExpression("https://example.invalid", {
    method: "POST",
    url: "/activity",
    body: "{}",
  });
  // Spread into the request the page itself issues...
  assert.ok(expression.includes("...slot"));
  // ...and never indexed, so no value can be returned to Node. The only thing
  // the expression asks the slot about is its key names.
  assert.equal(/slot\[/.test(expression), false);
  assert.match(expression, /Object\.keys\(slot\)/);
  assert.match(expression, /return response\.text\(\);/);
  // Nor does any header value reach the expression from Node's side: the only
  // header literal in it is the content type.
  assert.equal(/x-xsrf-token|x-device-footprint|authorization/i.test(expression), false);
});

test("the documents endpoints refuse by header name until the bearer is captured", () => {
  process.env.MS_DOCUMENT_DOWNLOAD_PATH_PREFIX = "/synthetic/download/";
  for (const path of ["/documents", "/documents/STMT-2025-01::MS-ACCT-0001"]) {
    const request = resolveEndpoint(path, {});
    assert.equal(request.needsAuthorization, true);
    const expression = pageFetchExpression("https://example.invalid", request);
    // The guard tests for the name only -- never reads or reports the value.
    assert.match(expression, /"authorization" in slot/);
    assert.match(expression, /Documents page/);
    assert.equal(/slot\[/.test(expression), false);
  }
  // The activity tier is unaffected: it needs no bearer.
  assert.equal(resolveEndpoint("/activity", {}).needsAuthorization, undefined);
  assert.equal(/authorization/i.test(pageFetchExpression("https://example.invalid", resolveEndpoint("/activity", {}))), false);
});

test("neither builder ever emits a header, cookie or token field", () => {
  const forbidden = /token|cookie|header|auth|secret|password/i;
  const activityBody = buildActivityRequestBody({ page: "1" });
  const documentsBody = buildDocumentsRequestBody({ docType: "ClientStatements" });
  assert.equal(forbidden.test(activityBody), false);
  assert.equal(forbidden.test(documentsBody), false);
});
