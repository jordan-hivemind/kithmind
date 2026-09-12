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
  startInactivityWatch,
  INACTIVITY_DIALOG_EXPRESSION,
  waitForSignIn,
  reloadAndCaptureHeaders,
  waitForAllHeaders,
  closeSession,
  sharedOnce,
  createSharedGate,
} from "../src/bridge.mjs";

// A fake cdp for the resume tests below: `Runtime.evaluate` is answered by
// pattern-matching the expression text (the shapes bridge.mjs ever sends:
// read the slot's keys, read its diagnostics, set/check the reload sentinel,
// or the bearer-refresh call), and every other method call (Page.enable,
// Page.reload, Page.navigate, Page.addScriptToEvaluateOnNewDocument) is just
// recorded. This is the same "fake cdp" shape startKeepAlive's own tests
// already use below, extended to script a sequence of slot-key readings and
// to record whether `close()` was called.
function makeFakeCdp(slotKeysSequence) {
  const calls = [];
  let slotReadIndex = 0;
  let closed = false;
  const cdp = {
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expression = params.expression;
        if (/GetAccessToken/.test(expression)) {
          return { result: { value: "refreshed" } }; // refreshBearer
        }
        if (/__kithmindReloadSentinel = true/.test(expression)) {
          return { result: { value: true } }; // reloadAndCaptureHeaders: set sentinel
        }
        if (/__kithmindReloadSentinel === undefined/.test(expression)) {
          return { result: { value: true } }; // reloadAndCaptureHeaders: sentinel check -- "fresh" immediately
        }
        if (/Object\.fromEntries\(Object\.entries\(globalThis\[Symbol\.for/.test(expression)) {
          return { result: { value: {} } }; // diagnostics (names + lengths only) -- not asserted on here
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
    close: () => {
      closed = true;
    },
  };
  return { cdp, calls, isClosed: () => closed };
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

// --- F1-63: the inactivity dialog watch -------------------------------------
//
// The site's page-side idle timer counts user input, not the adapter's
// requests, so the server-side keep-alive above does not stop it: 20 to 45
// minutes into a continuous pull the page puts up an inactivity dialog and
// then signs the session out. The bridge answers that dialog and does not
// touch the idle timer (src/bridge.mjs, startInactivityWatch). These tests
// drive it with the fake cdp and fake timers; nothing here opens a browser.

/** A fake cdp whose Runtime.evaluate answers the inactivity check with a
 * scripted sequence of page-side return values (or throws, for the failure
 * test), and records every expression it was sent. */
function makeInactivityCdp(results) {
  const expressions = [];
  let index = 0;
  const cdp = {
    send: (method, params) => {
      if (method !== "Runtime.evaluate") return Promise.resolve({ result: { value: null } });
      expressions.push(params.expression);
      const next = results[Math.min(index, results.length - 1)];
      index += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ result: { value: next } });
    },
    close: () => {},
  };
  return { cdp, expressions };
}

/** Captures console.error for the duration of the test, restoring it after. */
function captureLogs(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return lines;
}

/** Lets the fake cdp's already-resolved promises settle between fake ticks.
 * setImmediate, not a chain of microtasks: evaluate()'s Promise.race and its
 * finally() take more turns than a fixed chain reliably covers, and setTimeout
 * is mocked here. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("startInactivityWatch returns an interval that is unref'd -- it must never be the reason the process stays up", (t) => {
  // Real timers, for the same reason startKeepAlive's unref test uses them.
  const { cdp } = makeInactivityCdp([null]);
  const watch = startInactivityWatch(cdp);
  t.after(() => clearInterval(watch));
  assert.equal(watch.hasRef(), false);
});

test("startInactivityWatch checks the page for an inactivity dialog once a minute", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  captureLogs(t);
  const { cdp, expressions } = makeInactivityCdp([null]);
  const watch = startInactivityWatch(cdp);
  t.after(() => clearInterval(watch));

  assert.equal(expressions.length, 0, "no check before the first minute elapses");
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(expressions.length, 1);
  // The check matches on the dialog's own role and text, in the page.
  assert.match(expressions[0], /role="alertdialog"/);
  assert.match(expressions[0], /inactiv\|signed out\|session\.\*\(expir\|time\)\|stay signed in/);
  assert.match(expressions[0], /stay\|continue\|keep\|extend\|yes/);

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(expressions.length, 2, "polls every minute, not just once");
});

test("startInactivityWatch answers a matching dialog and logs the button text and nothing else from it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const lines = captureLogs(t);
  // What the page-side check returns after it clicked: the button's text and
  // no other dialog content -- the dialog body never leaves the page
  // (src/bridge.mjs, INACTIVITY_DIALOG_EXPRESSION).
  const { cdp } = makeInactivityCdp([{ button: "Stay Signed In" }, null]);
  const watch = startInactivityWatch(cdp);
  t.after(() => clearInterval(watch));

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[bridge\] inactivity dialog answered: Stay Signed In$/);

  // Nothing further is logged once the dialog is gone.
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(lines.length, 1);
});

test("startInactivityWatch logs an unanswerable dialog once per occurrence, not once per minute", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const lines = captureLogs(t);
  // Dialog up with no matching button for three polls, then gone, then back.
  const { cdp } = makeInactivityCdp([{ button: null }, { button: null }, { button: null }, null, { button: null }]);
  const watch = startInactivityWatch(cdp);
  t.after(() => clearInterval(watch));

  for (let i = 0; i < 3; i += 1) {
    t.mock.timers.tick(60_000);
    await flush();
  }
  assert.deepEqual(
    lines.map((line) => line.replace(/^\S+ /, "")),
    ["[bridge] inactivity dialog seen, no button matched"],
    "one line for the occurrence, not one per poll",
  );

  t.mock.timers.tick(60_000); // dialog gone
  await flush();
  t.mock.timers.tick(60_000); // a new occurrence
  await flush();
  assert.equal(lines.length, 2, "a later, separate occurrence logs again");
});

test("startInactivityWatch swallows an evaluate failure, logs it once, and keeps polling", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const lines = captureLogs(t);
  const { cdp, expressions } = makeInactivityCdp([new Error("page evaluation timed out")]);
  const watch = startInactivityWatch(cdp);
  t.after(() => clearInterval(watch));

  for (let i = 0; i < 3; i += 1) {
    t.mock.timers.tick(60_000);
    await flush();
  }
  // Nothing thrown into the pull; one line, not three.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[bridge\] inactivity watch failed:/);
  assert.equal(expressions.length, 3, "a failed check does not stop the watch");
});

test("startInactivityWatch skips every tick while the session is paused for sign-in, and resumes after", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  captureLogs(t);
  const { cdp, expressions } = makeInactivityCdp([null]);
  let paused = true;
  const watch = startInactivityWatch(cdp, () => paused);
  t.after(() => clearInterval(watch));

  t.mock.timers.tick(5 * 60_000);
  await flush();
  assert.equal(expressions.length, 0, "no clicking in a tab the owner is signing into");

  paused = false;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(expressions.length, 1, "resumes on its own once the pause lifts");
});

test("closeSession stops the inactivity watch as well as the keep-alive", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  captureLogs(t);
  const calls = [];
  let closed = false;
  const cdp = {
    send: (method, params) => {
      calls.push({ method, params });
      return Promise.resolve({ result: { value: null } });
    },
    close: () => {
      closed = true;
    },
  };
  const keepAlive = startKeepAlive(cdp, "https://app.example.invalid");
  const watch = startInactivityWatch(cdp);

  closeSession(cdp, keepAlive, watch);
  assert.equal(closed, true);

  t.mock.timers.tick(10 * 60 * 1000);
  await flush();
  assert.equal(calls.length, 0, "neither timer remains after close");
});

// The page-side half of the watch, run against a stub DOM in a vm context --
// the same technique the page-fetch expression's tests above use. Without
// this, a broken selector or a click that never fires would still satisfy the
// Node-side tests, which only ever see the value the page returns.
function fakeElement({ text = "", visible = true, children = [], value = "" } = {}) {
  const element = {
    innerText: text,
    value,
    clicked: 0,
    getBoundingClientRect: () => (visible ? { width: 400, height: 200 } : { width: 0, height: 0 }),
    querySelectorAll: () => children,
    click() {
      element.clicked += 1;
    },
  };
  return element;
}

function runDialogCheck(containers) {
  const sandbox = vm.createContext({
    document: { querySelectorAll: () => containers },
    getComputedStyle: () => ({ visibility: "visible" }),
  });
  // JSON round trip: the vm returns a cross-realm object, and in production
  // this value crosses the CDP boundary as JSON anyway.
  return JSON.parse(JSON.stringify(vm.runInContext(INACTIVITY_DIALOG_EXPRESSION, sandbox) ?? null));
}

test("the page-side check clicks the stay-signed-in button of a visible inactivity dialog and returns only its text", () => {
  const stay = fakeElement({ text: "Stay Signed In" });
  const signOut = fakeElement({ text: "Sign Out" });
  const dialog = fakeElement({
    // A real dialog names the account and the timeout; none of this may be
    // returned to Node.
    text: "You are about to be signed out due to inactivity. Account ...1234.",
    children: [signOut, stay],
  });

  assert.deepEqual(runDialogCheck([dialog]), { button: "Stay Signed In" });
  assert.equal(stay.clicked, 1);
  assert.equal(signOut.clicked, 0, "never clicks the sign-out button");
});

test("the page-side check ignores a hidden dialog and a dialog whose text is about something else", () => {
  const hidden = fakeElement({
    text: "Your session is about to expire",
    visible: false,
    children: [fakeElement({ text: "Continue" })],
  });
  assert.equal(runDialogCheck([hidden]), null);

  const unrelated = fakeElement({
    text: "Confirm this trade",
    children: [fakeElement({ text: "Continue" })],
  });
  assert.equal(runDialogCheck([unrelated]), null);
});

test("the page-side check reports a matching dialog with no matching button instead of clicking something else", () => {
  const close = fakeElement({ text: "Close" });
  const dialog = fakeElement({ text: "Session timed out", children: [close] });
  assert.deepEqual(runDialogCheck([dialog]), { button: null });
  assert.equal(close.clicked, 0);
});

// F1-54: a same-origin resume (an inline re-auth screen, or an in-app
// redirect) never destroys the page's JS context, so the header slot can
// otherwise still hold the *previous* session's xsrf token and device
// footprint straight through the pause -- not just its stale bearer.
//
// F1-54b: clearing the slot in place (the original F1-54 fix) and then only
// navigating within the app was not enough -- an in-app hash navigation
// alone never makes the app re-derive its device-footprint, which it only
// computes once per real page load, so a post-resume request still paired a
// freshly minted bearer with a *stale* device-footprint and the documents
// endpoint 400'd every one of them (seen live 2026-09-11 and again
// 2026-09-12). The fix is to make resume indistinguishable from a cold
// start: tear the paused connection down and reconnect, so the page-side
// slot is a brand new object the reload (not a clear) recreates -- the same
// reload cold start uses, which is what makes the app re-issue its
// device-footprint request.
test("waitForSignIn tears the paused connection down and reconnects, running the same reload cold start uses, rather than clearing the slot in place", async () => {
  // The old, paused connection: read once (the trigger check) and found to
  // still carry the previous session's headers -- exactly as it would if the
  // JS context never reset across the pause.
  const { cdp: oldCdp, calls: oldCalls, isClosed: oldClosed } = makeFakeCdp([
    ["x-xsrf-token", "x-device-footprint", "authorization"],
  ]);
  // The reconnected connection: empty right after the forced reload, then
  // all three fresh once the Documents navigation lands.
  const { cdp: newCdp, calls: newCalls } = makeFakeCdp([
    [],
    ["x-xsrf-token", "x-device-footprint", "authorization"],
  ]);
  let oldKeepAliveTicks = 0;
  const oldKeepAlive = setInterval(() => {
    oldKeepAliveTicks += 1;
  }, 2);

  const result = await withFakeFetch("https://app.example.invalid/atrium/#/documents", () =>
    waitForSignIn(oldCdp, "https://app.example.invalid", "http://cdp.invalid", "SIGNED_OUT: test", {
      signInWaitMs: 5000,
      pollIntervalMs: 1,
      headerWaitMs: 50,
      headerPollIntervalMs: 1,
      keepAlive: oldKeepAlive,
      // Stands in for the real connectAndInstallHook (connect + Page.enable +
      // Runtime.enable + reinstall the hook): recorded on newCdp exactly as
      // the real one would be, so the assertions below can tell a cold
      // start's own sequence apart from what came after it.
      reconnect: async () => {
        await newCdp.send("Page.enable");
        await newCdp.send("Runtime.enable");
        await newCdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "(hook)" });
        return newCdp;
      },
    }),
  );

  assert.ok(result, "resumes");
  assert.equal(result.cdp, newCdp, "the slot is recreated on a new connection, not mutated in place");
  assert.notEqual(result.keepAlive, oldKeepAlive, "a fresh keep-alive replaces the old one");
  clearInterval(result.keepAlive);

  assert.equal(oldClosed(), true, "the paused CDP connection is closed");
  const ticksAtResume = oldKeepAliveTicks;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(oldKeepAliveTicks, ticksAtResume, "the old keep-alive interval is cleared, not left running against a closed socket");
  assert.equal(
    oldCalls.some((c) => c.method === "Runtime.evaluate" && /delete/.test(c.params.expression)),
    false,
    "never clears the old slot in place",
  );

  // The reconnected cdp runs the exact same steps a cold start does --
  // reloadAndCaptureHeaders below is the same function createMorganStanleySession
  // calls -- before anything resume-specific (Documents navigation, bearer
  // refresh) happens.
  // (One Runtime.evaluate between the hook install and the sentinel set is
  // this module's own diagnostics read -- names and lengths only, see
  // logSlotDiagnostics -- not a slot mutation.)
  const methodSequence = newCalls.map((c) => c.method);
  assert.deepEqual(
    methodSequence.slice(0, 6),
    ["Page.enable", "Runtime.enable", "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate", "Runtime.evaluate", "Page.reload"],
    "reconnect, then the same sentinel-reload cold start uses",
  );

  const navigateIndex = newCalls.findIndex((c) => c.method === "Page.navigate");
  assert.notEqual(navigateIndex, -1);
  assert.match(newCalls[navigateIndex].params.url, /#\/documents$/);
  assert.ok(navigateIndex > methodSequence.indexOf("Page.reload"), "navigates to Documents only after the reload, not instead of it");

  const bearerIndex = newCalls.findIndex((c) => c.method === "Runtime.evaluate" && /GetAccessToken/.test(c.params.expression));
  assert.notEqual(bearerIndex, -1, "explicitly refreshes the bearer after resume, rather than hoping navigation alone captured the right one");
  assert.ok(navigateIndex < bearerIndex, "refreshes the bearer only after giving navigation a chance to repopulate the slot");
});

// The reconnect sequence above (Page.enable, Runtime.enable, install hook,
// sentinel set, Page.reload, sentinel check, slot read) is not a resume-only
// invention -- it is reloadAndCaptureHeaders, the exact same exported
// function createMorganStanleySession's cold start calls. This proves that
// function's own shape directly.
test("reloadAndCaptureHeaders -- the shared reload cold start and resume both run -- sets a sentinel, reloads, and waits for the fresh document's slot", async () => {
  const { cdp, calls } = makeFakeCdp([["x-xsrf-token"]]);
  await reloadAndCaptureHeaders(cdp);
  const methodSequence = calls.map((c) => c.method);
  assert.deepEqual(methodSequence, ["Runtime.evaluate", "Page.reload", "Runtime.evaluate", "Runtime.evaluate"]);
  assert.match(calls[0].params.expression, /__kithmindReloadSentinel = true/);
  assert.match(calls[2].params.expression, /__kithmindReloadSentinel === undefined/);
});

test("waitForAllHeaders polls until every WANTED_HEADERS entry is present", async () => {
  const { cdp, calls } = makeFakeCdp([["x-xsrf-token"], ["x-xsrf-token", "x-device-footprint", "authorization"]]);
  const ok = await waitForAllHeaders(cdp, 1000, 1);
  assert.equal(ok, true);
  assert.equal(calls.filter((c) => c.method === "Runtime.evaluate").length, 2);
});

test("waitForAllHeaders gives up and returns false once the deadline passes", async () => {
  const { cdp } = makeFakeCdp([["x-xsrf-token"]]);
  const ok = await waitForAllHeaders(cdp, 5, 1);
  assert.equal(ok, false);
});

// F1-62's `sharedOnce` gate (tested directly below) is what keeps concurrent
// fetchText/fetchBytes lanes from each driving their own reconnect when they
// all hit a sign-out together; this proves that guarantee still holds for
// the new tear-down-and-reconnect resume specifically -- one lane reconnects,
// every lane resumes onto the same new connection.
test("lanes sharing the sign-in gate all resume onto the same reconnected session after just one reconnect", async () => {
  const { cdp: oldCdp } = makeFakeCdp([["x-xsrf-token", "x-device-footprint", "authorization"]]);
  const { cdp: newCdp } = makeFakeCdp([[], ["x-xsrf-token", "x-device-footprint", "authorization"]]);
  const gate = createSharedGate();
  let reconnectCalls = 0;

  const startResume = () =>
    withFakeFetch("https://app.example.invalid/atrium/#/documents", () =>
      waitForSignIn(oldCdp, "https://app.example.invalid", "http://cdp.invalid", "SIGNED_OUT: test", {
        signInWaitMs: 5000,
        pollIntervalMs: 1,
        headerWaitMs: 50,
        headerPollIntervalMs: 1,
        reconnect: async () => {
          reconnectCalls += 1;
          await newCdp.send("Page.enable");
          await newCdp.send("Runtime.enable");
          await newCdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "(hook)" });
          return newCdp;
        },
      }),
    );

  // Three concurrent lanes all hit the same sign-out at once.
  const results = await Promise.all([sharedOnce(gate, startResume), sharedOnce(gate, startResume), sharedOnce(gate, startResume)]);

  assert.equal(reconnectCalls, 1, "only the first lane actually drives the reconnect");
  for (const result of results) {
    assert.equal(result.cdp, newCdp, "every lane proceeds on the same reconnected session");
    clearInterval(result.keepAlive);
  }
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

// F1-62. `--concurrency` runs several fetchText/fetchBytes calls at once
// against one session; `sharedOnce` is what keeps a session pause (a lost
// sign-in, a bearer refresh) from being driven more than once at a time when
// several concurrent callers hit it together. These tests exercise that gate
// directly -- no CDP, no WebSocket, no real session -- the same way the tests
// above exercise waitForSignIn/refreshBearer/startKeepAlive directly.

test("sharedOnce pauses every concurrent stream on the same wait and resolves them all together", async () => {
  const gate = createSharedGate();
  let starts = 0;
  let releaseStart;
  const started = new Promise((resolve) => { releaseStart = resolve; });
  function start() {
    starts += 1;
    return new Promise((resolve) => {
      releaseStart();
      setTimeout(() => resolve("resumed"), 20);
    });
  }

  // Three "streams" all hit the pause at once, before it resolves.
  const callers = [sharedOnce(gate, start), sharedOnce(gate, start), sharedOnce(gate, start)];
  await started;
  // A fourth stream joins a little later, still before the first wait settles.
  await new Promise((resolve) => setTimeout(resolve, 5));
  callers.push(sharedOnce(gate, start));

  const results = await Promise.all(callers);
  assert.equal(starts, 1, "only the first caller actually starts the wait");
  assert.deepEqual(results, ["resumed", "resumed", "resumed", "resumed"], "every caller resolves to the same outcome");
});

test("sharedOnce clears its gate once the wait settles, so a later pause gets its own fresh wait", async () => {
  const gate = createSharedGate();
  let starts = 0;
  const start = () => {
    starts += 1;
    return Promise.resolve("resumed");
  };

  await sharedOnce(gate, start);
  assert.equal(gate.pending, null, "the gate is empty again once the wait settles");
  await sharedOnce(gate, start);
  assert.equal(starts, 2, "a later, unrelated pause starts its own wait rather than replaying the first one's result");
});

test("sharedOnce clears its gate even when the wait itself fails, so a failed resume never wedges later streams", async () => {
  const gate = createSharedGate();
  const failingStart = () => Promise.reject(new Error("sign-in wait failed"));

  await assert.rejects(() => sharedOnce(gate, failingStart), /sign-in wait failed/);
  assert.equal(gate.pending, null, "a rejected wait still clears the gate");

  let secondStarted = false;
  await sharedOnce(gate, () => {
    secondStarted = true;
    return Promise.resolve("resumed");
  });
  assert.equal(secondStarted, true, "a later stream is not stuck behind the earlier failure");
});
