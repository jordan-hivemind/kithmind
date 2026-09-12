// Unit tests for the pure request-building helpers in src/bridge.mjs only.
// The CDP mechanics (attach, hook, reload, page-context fetch) are proven
// credential-free against a local page in ../spike/bridge-spike.mjs; per the
// design, nothing here opens a browser or talks to a real site.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  WANTED_HEADERS,
  buildActivityRequestBody,
  buildDocumentsRequestBody,
  pageFetchExpression,
  resolveEndpoint,
  evaluate,
  startKeepAlive,
  waitForSignIn,
  closeSession,
} from "../src/bridge.mjs";

// A fake cdp for the resume tests below: `Runtime.evaluate` is answered by
// pattern-matching the expression text (the same three shapes bridge.mjs
// ever sends: read the slot's keys, clear the slot, or the bearer-refresh
// call), and every other method call (Page.navigate) is just recorded. This
// is the same "fake cdp" shape startKeepAlive's own tests already use below,
// extended to script a sequence of slot-key readings.
function makeFakeCdp(slotKeysSequence) {
  const calls = [];
  let slotReadIndex = 0;
  const cdp = {
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expression = params.expression;
        if (/delete s\[k\]/.test(expression) && /Object\.keys\(s\)\) delete/.test(expression)) {
          return { result: { value: true } }; // clearCapturedHeaders
        }
        if (/GetAccessToken/.test(expression)) {
          return { result: { value: "refreshed" } }; // refreshBearer
        }
        if (/Object\.keys\(globalThis\[Symbol\.for/.test(expression)) {
          const value = slotKeysSequence[Math.min(slotReadIndex, slotKeysSequence.length - 1)];
          slotReadIndex += 1;
          return { result: { value } };
        }
        return { result: { value: null } };
      }
      return { result: { value: null } };
    },
  };
  return { cdp, calls };
}

function withFakeFetch(targetUrl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => [{ type: "page", url: targetUrl, webSocketDebuggerUrl: "ws://fake" }],
  });
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

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

test("document acquisition posts an empty body to the confirmed accountdocs/document path with the listing's documentId", () => {
  const request = resolveEndpoint("/documents/DOC-STMT-0001::MS-ACCT-0001", {});
  assert.equal(request.method, "POST");
  // Confirmed live 2026-09-11: no download-path environment variable is
  // read any more -- the documentId from the documents listing names the
  // request directly.
  assert.match(
    request.url,
    /^\/msoaz\/api\/acdsal\/accountdocs\/document\/DOC-STMT-0001\?RequestID=([0-9a-f]{4}-){7}[0-9a-f]{4}&SeqID=\d{4}$/,
  );
  assert.equal(request.body, "");
  assert.equal(request.headers.Accept, "application/json, text/plain, */*");
  assert.equal(request.needsAuthorization, true);
  // A fresh RequestID/SeqID per call, same as the documents listing.
  assert.notEqual(request.url, resolveEndpoint("/documents/DOC-STMT-0001::MS-ACCT-0001", {}).url);
});

test("the documents endpoints refuse by header name until the bearer is captured", () => {
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

test("the evaluate deadline rejects by name instead of hanging when the CDP reply never comes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // A page navigation mid-call drops the reply: this fake cdp never
  // resolves or rejects its send(), the same shape as that failure.
  const cdp = { send: () => new Promise(() => {}) };

  const pending = evaluate(cdp, "1 + 1");
  // Advance past EVALUATE_TIMEOUT_MS (90s) without a real wait.
  t.mock.timers.tick(90_001);

  await assert.rejects(pending, /page evaluation timed out after 90000ms/);
});

// F1-43: a page navigation away from the app (a session timeout redirects to
// the login page) leaves `location.href` off the app's own origin. The fetch
// expression is plain, self-invoking JS -- running it in a throwaway vm
// context with a fake `location` proves the throw without a browser, a
// credential or the app's own fetch/Headers ever being reached (the origin
// check happens before either is touched, see src/bridge.mjs).
test("the page fetch expression throws SIGNED_OUT, by name, when the tab has left the app origin", async () => {
  const expression = pageFetchExpression("https://app.example.invalid", {
    method: "GET",
    url: "/anything",
    body: null,
  });
  const sandbox = { location: { href: "https://signin.example.invalid/login" } };
  vm.createContext(sandbox);
  await assert.rejects(
    vm.runInContext(expression, sandbox),
    /^Error: SIGNED_OUT: the tab left the app origin/,
  );
});

test("the page fetch expression does not confuse a same-origin tab for a signed-out one", async () => {
  const expression = pageFetchExpression("https://app.example.invalid", {
    method: "GET",
    url: "/anything",
    body: null,
  });
  const sandbox = { location: { href: "https://app.example.invalid/activity" } };
  vm.createContext(sandbox);
  // Falls through past the origin check to the next guard (no headers
  // captured yet) rather than a SIGNED_OUT it has no business raising.
  await assert.rejects(
    vm.runInContext(expression, sandbox),
    /^Error: no session headers captured yet/,
  );
});

test("startKeepAlive returns an interval that is unref'd -- it must never be the reason the process stays up", (t) => {
  // Real timers here: node:test's mock Timeout stubs hasRef()/unref() to
  // always report ref'd, so this has to run against the genuine one.
  const cdp = { send: () => new Promise(() => {}) };
  const keepAlive = startKeepAlive(cdp, "https://app.example.invalid");
  t.after(() => clearInterval(keepAlive));
  assert.equal(keepAlive.hasRef(), false);
});

test("startKeepAlive extends the app session every four minutes through the page-side fetch, and needs no authorization", (t) => {
  // Mocks setTimeout too: evaluate()'s own 90s deadline timer (src/bridge.mjs)
  // is real and un-unref'd otherwise, which would leave this test holding
  // the process open for a genuine 90 seconds after the fake cdp already
  // resolved the race.
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const calls = [];
  const cdp = {
    send: (method, params) => {
      calls.push({ method, params });
      return Promise.resolve({ result: { value: "{}" } });
    },
  };

  const keepAlive = startKeepAlive(cdp, "https://app.example.invalid");
  t.after(() => clearInterval(keepAlive));
  assert.equal(calls.length, 0, "no call before the first four minutes elapse");

  t.mock.timers.tick(4 * 60 * 1000);
  assert.equal(calls.length, 1);
  const [{ method, params }] = calls;
  assert.equal(method, "Runtime.evaluate");
  assert.match(
    params.expression,
    /\/shell\/handler\/proxy\/sal\/api\/AzureSession\/Extend\?RequestID=([0-9a-f]{4}-){7}[0-9a-f]{4}&SeqID=\d{4}/,
  );
  // needsAuthorization: false -- the extend call never gates on the bearer.
  assert.equal(/"authorization" in slot/.test(params.expression), false);

  t.mock.timers.tick(4 * 60 * 1000);
  assert.equal(calls.length, 2, "fires again every four minutes, not just once");
});

// F1-64: a run that stops on a lost session (or completes normally) must
// close everything a bridge session holds open, or the node process outlives
// the run itself -- seen live as a 40+ minute hang with no sign-in wait ever
// logged, refusing a later run ("a run is alive") until killed by hand.
test("closeSession closes the CDP WebSocket and stops the keep-alive from ever firing again", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const calls = [];
  let closed = false;
  const cdp = {
    send: (method, params) => {
      calls.push({ method, params });
      return Promise.resolve({ result: { value: "{}" } });
    },
    close: () => {
      closed = true;
    },
  };
  const keepAlive = startKeepAlive(cdp, "https://app.example.invalid");

  closeSession(cdp, keepAlive);
  assert.equal(closed, true, "closes the CDP WebSocket");

  // Ten more minutes would fire the keep-alive twice (every four) if the
  // interval were merely unref'd rather than actually cleared.
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(calls.length, 0, "no timer remains -- the keep-alive never fires after close");
});

// F1-54: a same-origin resume (an inline re-auth screen, or an in-app
// redirect) never destroys the page's JS context, so the header slot can
// otherwise still hold the *previous* session's xsrf token and device
// footprint straight through the pause -- not just its stale bearer -- and
// every post-resume documents call 400'd carrying them (seen live
// 2026-09-11). waitForSignIn must clear every captured header before
// trusting anything recaptured after resume.
test("waitForSignIn clears every captured header before re-navigating, not just the bearer", async () => {
  // First read (the trigger check): stale headers already present, exactly
  // as they would be if the JS context never reset across the pause. Second
  // read (inside the post-clear wait loop): all three fresh again, as if the
  // app's own Documents-route calls repopulated them.
  const { cdp, calls } = makeFakeCdp([
    ["x-xsrf-token", "x-device-footprint", "authorization"],
    ["x-xsrf-token", "x-device-footprint", "authorization"],
  ]);

  const resumed = await withFakeFetch("https://app.example.invalid/atrium/#/documents", () =>
    waitForSignIn(cdp, "https://app.example.invalid", "http://cdp.invalid", "SIGNED_OUT: test", {
      signInWaitMs: 5000,
      pollIntervalMs: 1,
      headerWaitMs: 50,
      headerPollIntervalMs: 1,
    }),
  );

  assert.equal(resumed, true);

  const clearIndex = calls.findIndex(
    (c) => c.method === "Runtime.evaluate" && /Object\.keys\(s\)\) delete s\[k\]/.test(c.params.expression),
  );
  assert.notEqual(clearIndex, -1, "clears the whole slot, not just authorization");
  // The clear expression deletes every key unconditionally -- it never singles
  // out "authorization" the way the pre-fix code did.
  assert.equal(/===\s*"authorization"/.test(calls[clearIndex].params.expression), false);

  const navigateIndex = calls.findIndex((c) => c.method === "Page.navigate");
  assert.notEqual(navigateIndex, -1);
  assert.match(calls[navigateIndex].params.url, /#\/documents$/);
  // The clear happens before the navigation that is meant to repopulate the
  // slot -- clearing after would just delete what was just recaptured.
  assert.ok(clearIndex < navigateIndex, "clears before navigating, not after");

  const bearerIndex = calls.findIndex((c) => c.method === "Runtime.evaluate" && /GetAccessToken/.test(c.params.expression));
  assert.notEqual(bearerIndex, -1, "explicitly refreshes the bearer after resume, rather than hoping navigation alone captured the right one");
  assert.ok(navigateIndex < bearerIndex, "refreshes the bearer only after giving navigation a chance to repopulate the slot");
});

test("waitForSignIn gives up and returns false if the tab never returns to the app origin", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => [] }); // no matching tab, ever
  try {
    const resumed = await waitForSignIn(
      { send: async () => ({ result: { value: [] } }) },
      "https://app.example.invalid",
      "http://cdp.invalid",
      "SIGNED_OUT: test",
      { signInWaitMs: 20, pollIntervalMs: 5 },
    );
    assert.equal(resumed, false);
  } finally {
    globalThis.fetch = original;
  }
});
