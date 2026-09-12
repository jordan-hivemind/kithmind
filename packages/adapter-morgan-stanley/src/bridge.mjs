// The session bridge (README, "How the session works"): attaches over the Chrome
// DevTools Protocol to a Chrome tab a person is already signed in to,
// installs a header-capture hook inside the page, reloads once, and issues
// every fetch from *inside* that page so the app's own X-XSRF-TOKEN,
// X-DEVICE-FOOTPRINT and Authorization headers ride along. Proven
// credential-free against a local page in ../spike/bridge-spike.mjs; this
// file is that same mechanism wired to an AdapterSession and to Morgan
// Stanley's specific requests.
//
// No login, no navigation to a login form, no credential anywhere in this
// file: the captured header *values* never cross the CDP boundary (see
// fetchInPage below). If the capture slot is empty, every call throws and
// tells the operator to open the Activity tab -- it never synthesizes a header.
// The one part of the site's UI it ever drives is the inactivity dialog (F1-63,
// startInactivityWatch below). The documents endpoints additionally need the
// bearer the app sets only once its own Documents page has loaded, so they
// throw their own named error naming that header, never its value.
//
// This module is exercised end to end only by the spike; nothing in the
// test suite runs against the institution or a browser. The pure
// request-building helpers it exports (buildActivityRequestBody etc.) have
// their own fixture-only tests in test/bridge.test.mjs.

const CAPTURED_HEADERS_SLOT = "kithmind.capturedHeaders";
// F1-54c. A second page-side slot holding *provenance* for the first one:
// which kind of request each header was first captured from, and how long
// after the document loaded. Names and timings only -- never a value.
const CAPTURE_META_SLOT = "kithmind.captureMeta";
/** The only header names that are ever captured, and the only ones this
 * module ever names. `authorization` is the bearer the app obtains for its
 * own documents calls; it is captured, stored and re-applied entirely inside
 * the page, exactly like the other two. Exported for tests: names only, the
 * values live nowhere in Node. */
export const WANTED_HEADERS = ["x-xsrf-token", "x-device-footprint", "authorization"];
const AUTHORIZATION_HEADER = "authorization";

// --- pure request building (no CDP, no network, unit-testable) -------------

/** `RequestID=<8 hex groups>&SeqID=<4 digits>`, matching the observed
 * activity endpoint query string. The exact grouping scheme is cosmetic --
 * the site has not been observed to validate its shape, only its presence --
 * so this generates a plausible one rather than guessing a validated format. */
function randomActivityQueryIds() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const requestId = Array.from({ length: 8 }, (_, i) => hex.slice(i * 4, i * 4 + 4)).join("-");
  const seqId = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return { requestId, seqId };
}

/** `RequestID=<uuid>&SeqID=<4 digits>`, per the confirmed accounts and
 * documents-list requests -- a real UUID, unlike the activity endpoint's
 * 8-hex-group format above. Generated fresh per call, same as the activity ids. */
function randomUuidQueryIds() {
  const requestId = Array.from({ length: 8 }, () => Math.floor(Math.random() * 65536).toString(16).padStart(4, "0")).join("-");
  const seqId = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return { requestId, seqId };
}

/**
 * The activity POST body, from the observed request template. `query`
 * carries only logical, non-secret request parameters (page number, date
 * range, explicit dates) -- nothing here is a header, cookie or token.
 */
export function buildActivityRequestBody(query = {}) {
  return JSON.stringify({
    Pagination: {
      Posted: {
        PageNumber: Number(query.page ?? "1"),
        SortOrder: "desc",
        SortColumn: "ProcessDate",
        Return: true,
        PageSize: Number(query.pageSize ?? "500"),
      },
      Pending: { PageNumber: 1, SortOrder: "desc", SortColumn: "TradeDate", Return: false, PageSize: 5 },
    },
    StartDate: query.startDate ?? "",
    EndDate: query.endDate ?? "",
    DateRangeType: query.dateRangeType ?? "YearToDate",
    Filters: "All",
    LoanNote: "",
    SearchString: "",
    SearchColumn: "",
    ActivityCacheId: "",
    AccountInformation: { Grouping: "All" },
  });
}

// The documents-list body *keys* are confirmed (endDate, pageNum, filters,
// sortBy, startDate, TimeFrame), and so are the `filters` entry's fields
// (DocType, DocSubType, KeyAccountNo). Which values TimeFrame accepts is not:
// a caller-supplied period sends "Custom" alongside the explicit dates, and
// everything else asks for the whole history. Confirm both on the first real
// run rather than trusting them silently (README, "Documents listing").
const MS_DOCUMENTS_TIMEFRAME_ALL = "All";
const MS_DOCUMENTS_TIMEFRAME_CUSTOM = "Custom";

/**
 * The documents-list POST body, built from the confirmed keys. `query`
 * carries only logical request parameters (document type, account key, page
 * number, dates) -- nothing here is a header, cookie or token.
 */
export function buildDocumentsRequestBody(query = {}) {
  // Confirmed live 2026-09-11: filters are named entries, pageNum is a string,
  // sortBy is an array, TimeFrame is one of Last30Days, Last90Days,
  // Last12Months or a calendar year as a string; KeyAccountNo and DocSubType
  // take "All". Dates are empty unless a custom range is used.
  const startDate = query.startDate ?? "";
  const endDate = query.endDate ?? "";
  return JSON.stringify({
    endDate,
    pageNum: String(query.page ?? "1"),
    filters: [
      { filterName: "KeyAccountNo", values: [query.keyAccount ?? "All"] },
      { filterName: "DocType", values: [query.docType ?? ""] },
      { filterName: "DocSubType", values: [query.docSubType ?? "All"] },
    ],
    sortBy: [
      { fieldName: "DocDate", sortOrder: "DESC" },
      { fieldName: "KeyAccountNo", sortOrder: "DESC" },
    ],
    startDate,
    TimeFrame: query.timeFrame ?? MS_DOCUMENTS_TIMEFRAME_ALL,
  });
}

/**
 * Endpoint routing for every logical path this adapter's `AdapterSession`
 * calls. The activity, accounts and documents-list paths are confirmed
 * against the live site; the rest (tabular export, per-document download) are
 * not, so they are read from the environment with no guessed default -- an
 * unset one throws a clear, named error rather than silently posting to a
 * made-up URL. Confirm each remaining path during the first discover() run
 * (README, "Operator runbook") and set it once in the operator's environment.
 *
 * `needsAuthorization` marks the endpoints the app only ever calls with its
 * own bearer: the page-side fetch refuses them by name, before issuing the
 * request, when that header has not been captured yet.
 */
export function resolveEndpoint(path, query) {
  if (path === "/activity") {
    const { requestId, seqId } = randomActivityQueryIds();
    return {
      method: "POST",
      // Confirmed against the observed request (README, "Activity pagination").
      url: `/shell/handler/proxy/msomactivitysal/v1/activity?RequestID=${requestId}&SeqID=${seqId}`,
      body: buildActivityRequestBody(query),
    };
  }
  if (path === "/documents") {
    const { requestId, seqId } = randomUuidQueryIds();
    return {
      method: "POST",
      // Confirmed against the observed request (README, "Documents listing").
      url: `/msoaz/api/acdsal/accountdocs/v2/searchItems?RequestID=${requestId}&SeqID=${seqId}`,
      body: buildDocumentsRequestBody(query),
      needsAuthorization: true,
    };
  }
  if (path.startsWith("/documents/")) {
    // Confirmed live 2026-09-11 from the app's own document service: a POST
    // with an empty body to accountdocs/document/<documentId> answers with the
    // PDF bytes directly (the app reads it as a blob). The id is the
    // listing's documentId, which already names the account and date.
    const [documentId] = path.slice("/documents/".length).split("::");
    const { requestId, seqId } = randomUuidQueryIds();
    return {
      method: "POST",
      url: `/msoaz/api/acdsal/accountdocs/document/${encodeURIComponent(documentId)}?RequestID=${requestId}&SeqID=${seqId}`,
      body: "",
      headers: { Accept: "application/json, text/plain, */*" },
      needsAuthorization: true,
    };
  }
  if (path === "/export/tabular") {
    return {
      method: "POST",
      url: requiredEnv("MS_TABULAR_EXPORT_PATH"),
      body: JSON.stringify({ periodStart: query.periodStart ?? "", periodEnd: query.periodEnd ?? "" }),
    };
  }
  if (path === "/accounts") {
    const { requestId, seqId } = randomUuidQueryIds();
    // Confirmed request shape -- see adapter.mjs's fetchAccountsFromEndpoint/
    // fetchAccountsFromActivityFallback doc comment: this still 403s from a
    // page-context fetch today, hence the fallback, but the request itself
    // is confirmed, not guessed.
    const params = new URLSearchParams({
      "accountInfo.grouping": "0",
      "accountInfo.id": "",
      isLendingCacheRefreshRequired: "false",
      isCacheRefreshRequired: "false",
      topRail: "true",
      RequestID: requestId,
      SeqID: seqId,
    });
    return {
      method: "GET",
      url: `/shell/handler/restproxy/financialsal/api/v1/accounts?${params}`,
      body: null,
      headers: { Accept: "application/json, text/plain, */*" },
    };
  }
  throw new RangeError(`morgan-stanley bridge: unknown logical path ${path}`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This adapter does not guess Morgan Stanley's unconfirmed endpoint ` +
        "paths (see src/bridge.mjs, resolveEndpoint). Set it once the real path is confirmed " +
        "against a signed-in session (README, 'Operator runbook').",
    );
  }
  return value;
}

// --- CDP mechanics (unexercised outside the spike) --------------------------

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    send(method, params = {}) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

const EVALUATE_TIMEOUT_MS = 90_000;

// Exported for test/bridge.test.mjs only, to prove the deadline rejects by
// name without a real CDP connection or a real 90-second wait (the test
// drives it with a fake cdp and node:test's mock timers). Every other caller
// still reaches it only through createMorganStanleySession, unchanged.
export async function evaluate(cdp, expression) {
  // A page navigation or reload mid-call drops the reply to a pending
  // Runtime.evaluate, and without a deadline the operator command waits
  // forever with nothing in flight (seen live 2026-09-11). Fail by name
  // instead so the run counts the document as failed and moves on.
  let deadline;
  const { result, exceptionDetails } = await Promise.race([
    cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, reject) => {
      // unref: a reply that lands first must not leave this timer holding the
      // process (or a test's event loop) open for the rest of the 90 seconds.
      deadline = setTimeout(
        () => reject(new Error(`page evaluation timed out after ${EVALUATE_TIMEOUT_MS}ms: the tab may have navigated or the request never answered`)),
        EVALUATE_TIMEOUT_MS,
      ).unref();
    }),
  ]).finally(() => clearTimeout(deadline));
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text + " " + (result?.description ?? ""));
  }
  return result.value;
}

/** Installed once, before the tab's next navigation. Allowlisted by name --
 * exactly WANTED_HEADERS, stored under those canonical lowercase names (HTTP
 * header names are case-insensitive, and one key per header keeps two
 * spellings of the same name from being sent as one combined value) -- in a
 * page-side slot the bridge never reads values out of. Both mechanisms the app
 * sets these headers with are wrapped: XMLHttpRequest, which carries them
 * today, and fetch, in case the documents calls use it, so the bearer is
 * captured either way. A captured value is written to the slot and nowhere
 * else: not returned, not logged, not sent over the debugging connection.
 *
 * F1-54c: alongside the value it also records the header's *provenance* --
 * whether the request that carried it was one the app made itself or one this
 * bridge issued, and how many milliseconds after this document loaded. The
 * bridge spreads the slot into its own requests, so without this mark every
 * bridge call re-captures the values it just read and "the footprint is in the
 * slot" proves nothing about whether the app still agrees with the server
 * about it. A later app-initiated capture upgrades a `bridge` record to `app`;
 * nothing ever downgrades one. Timings and the words "app"/"bridge" only.
 * Exported for test/bridge.test.mjs, which runs it against a stub page in a vm
 * context exactly as INACTIVITY_DIALOG_EXPRESSION is tested. */
export const HEADER_HOOK = `(() => {
  const WANTED = ${JSON.stringify(WANTED_HEADERS)};
  const slot = (globalThis[Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)})] ??= {});
  const meta = (globalThis[Symbol.for(${JSON.stringify(CAPTURE_META_SLOT)})] ??= { loadedAt: Date.now(), bridgeDepth: 0, headers: {} });
  const capture = (name, value) => {
    const canonical = String(name).toLowerCase();
    if (!value || !WANTED.includes(canonical)) return;
    const source = meta.bridgeDepth > 0 ? "bridge" : "app";
    const prior = meta.headers[canonical];
    if (!prior || (prior.source === "bridge" && source === "app")) {
      meta.headers[canonical] = { source, afterLoadMs: Date.now() - meta.loadedAt };
    }
    slot[canonical] = value;
  };
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    capture(name, value);
    return originalSetRequestHeader.call(this, name, value);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    try {
      const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
      for (const name of WANTED) capture(name, headers.get(name));
    } catch {}
    return originalFetch.apply(this, arguments);
  };
})()`;

/** Page-side helper every fetch this bridge issues goes through, so the
 * capture hook above can tell those apart from the app's own requests
 * (F1-54c). It is deliberately synchronous around the `fetch` call itself --
 * the hook reads the headers before `fetch` returns its promise -- so an app
 * request that happens to be in flight is never mislabelled. */
const BRIDGE_FETCH = `const __kithmindFetch = (url, init) => {
      const meta = globalThis[Symbol.for(${JSON.stringify(CAPTURE_META_SLOT)})];
      if (meta) meta.bridgeDepth += 1;
      try {
        return fetch(url, init);
      } finally {
        if (meta) meta.bridgeDepth -= 1;
      }
    };`;

/** A fetch expression evaluated *inside* the page: it reads the captured
 * headers out of the page-side slot and spreads them into the request, so
 * only the response body -- never a header value -- crosses the CDP
 * boundary back to Node. Throws in-page, with an instruction to open the
 * Activity tab, when the slot is still empty, and -- for the documents
 * endpoints, which the app only ever calls with its own bearer -- when that
 * header has not been captured. Both errors name the header, never its
 * value. Exported for tests. */
export function pageFetchExpression(origin, { method, url, body, headers, needsAuthorization }) {
  return `(async () => {
    ${BRIDGE_FETCH}
    const slot = Object.fromEntries(Object.entries(globalThis[Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)})] ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (!location.href.startsWith(${JSON.stringify(origin)})) {
      throw new Error("SIGNED_OUT: the tab left the app origin (a session timeout redirects to the login page); sign in again and retry");
    }
    if (Object.keys(slot).length === 0) {
      throw new Error("no session headers captured yet: open the Activity tab in this Chrome window, then retry");
    }
    ${
      needsAuthorization
        ? `if (!(${JSON.stringify(AUTHORIZATION_HEADER)} in slot)) {
      throw new Error("no Authorization bearer captured yet: the documents tier also needs the app's own Documents page to have been loaded once in this Chrome window -- open it, then retry");
    }`
        : ""
    }
    const response = await __kithmindFetch(${JSON.stringify(origin)} + ${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)},
      // The documents service refuses a request without an explicit JSON
      // Accept (confirmed live 2026-09-11); the app sends it on every call.
      headers: { "Content-Type": "application/json", "Accept": "application/json", ...${JSON.stringify(headers ?? {})}, ...slot },
      credentials: "include",
      body: ${body === null ? "undefined" : JSON.stringify(body)},
    });
    if (!response.ok) {
      throw new Error("request failed: " + response.status + " " + (await response.text()).slice(0, 500));
    }
    return response.text();
  })()`;
}

function pageFetchBytesExpression(origin, request) {
  // Same request, read as an ArrayBuffer and returned base64: statements and
  // confirmations are small, and base64 over a local socket is cheaper than
  // owning a download directory.
  return pageFetchExpression(origin, request).replace(
    "return response.text();",
    `const buffer = await response.arrayBuffer();
     let binary = "";
     const bytes = new Uint8Array(buffer);
     for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
     return btoa(binary);`,
  );
}

async function findPageTarget(cdpHttpBase, originPrefix) {
  const targets = await (await fetch(`${cdpHttpBase}/json/list`)).json();
  const target = targets.find((t) => t.type === "page" && t.url.startsWith(originPrefix));
  if (!target) {
    throw new Error(
      `no open Chrome tab matches origin ${originPrefix}. Open the Morgan Stanley Activity ` +
        "tab in the dedicated archive Chrome profile and retry (README, 'Operator runbook').",
    );
  }
  return target;
}

function slotKeysExpression() {
  return `Object.keys(globalThis[Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)})] ?? {})`;
}

function currentSlotKeys(cdp) {
  return evaluate(cdp, slotKeysExpression());
}

// Diagnostics only -- per header a value *length*, never a value, plus the
// provenance the hook recorded: `source` is "app" when the first (or first
// app-initiated) request carrying it was one the app made itself and "bridge"
// when only this bridge's own request ever carried it, and `afterLoadMs` is
// how long after the document loaded that was. `documentAgeMs` dates the
// document itself, so a log line says whether a header arrived on the app's
// own bootstrap or long after. F1-54b gave a real run no way to tell what a
// resumed session actually captured; F1-54c adds where it came from, which is
// what separates a live footprint from the bridge's own echo of a dead one.
// The leading marker is what test/bridge.test.mjs's fake cdp matches on.
function captureMetaExpression() {
  return `/* kithmind:capture-meta */ (() => {
    const slot = globalThis[Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)})] ?? {};
    const meta = globalThis[Symbol.for(${JSON.stringify(CAPTURE_META_SLOT)})];
    const headers = {};
    for (const [name, value] of Object.entries(slot)) {
      const record = meta && meta.headers[name.toLowerCase()];
      headers[name.toLowerCase()] = {
        length: typeof value === "string" ? value.length : null,
        source: record ? record.source : "unknown",
        afterLoadMs: record ? record.afterLoadMs : null,
      };
    }
    return { headers, documentAgeMs: meta ? Date.now() - meta.loadedAt : null };
  })()`;
}

/** Reads the diagnostics object above. Exported for test/bridge.test.mjs only
 * (same convention as `evaluate` above). */
export function readCaptureMeta(cdp) {
  return evaluate(cdp, captureMetaExpression());
}

async function logSlotDiagnostics(cdp, step) {
  const diagnostics = await readCaptureMeta(cdp).catch((error) => ({ error: String(error?.message ?? error) }));
  console.error(new Date().toISOString(), "[bridge] diagnostics:", step, JSON.stringify(diagnostics));
}

/** Connect, enable the domains the hook and reload wait need, and install the
 * header hook fresh on this connection -- the first three steps of the
 * cold-start sequence (createMorganStanleySession) and, since F1-54b, also
 * the first three steps a resume runs after tearing its old connection down
 * (see waitForSignIn). Exported for test/bridge.test.mjs only (same
 * convention as `evaluate`/`startKeepAlive` above); every other caller
 * reaches it only through createMorganStanleySession or waitForSignIn. */
export async function connectAndInstallHook(cdpHttpBase, origin) {
  const target = await findPageTarget(cdpHttpBase, origin);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HEADER_HOOK });
  return cdp;
}

/** Forces a real reload and waits for the *new* document to have captured at
 * least one header, marked by the disappearance of a sentinel set on the old
 * one (reading the old document's slot right after Page.reload returns stale
 * keys). This is what makes the app re-derive everything it only computes
 * once per page load -- including its device-footprint -- rather than
 * carrying a stale value forward.
 *
 * With a `url` (F1-54c: a resume passes the app's own landing route) the load
 * lands there instead of on whatever the tab happened to be showing when the
 * session paused. `Page.navigate` alone is not enough: navigating from
 * `/atrium/#/documents` to `/atrium/` differs only in the fragment, which is a
 * same-document navigation that never re-bootstraps the app shell, so the
 * reload below is what makes the load real either way.
 *
 * Exported for test/bridge.test.mjs only (same convention as `evaluate`
 * above); every other caller reaches it only through
 * createMorganStanleySession or waitForSignIn. */
export async function reloadAndCaptureHeaders(cdp, url) {
  await evaluate(cdp, "globalThis.__kithmindReloadSentinel = true; true");
  if (url) await cdp.send("Page.navigate", { url });
  await cdp.send("Page.reload");
  let fresh = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!fresh) {
      fresh = await evaluate(cdp, "globalThis.__kithmindReloadSentinel === undefined").catch(() => false);
    }
    if (fresh && (await currentSlotKeys(cdp).catch(() => [])).length > 0) return;
    if (attempt === 299) {
      throw new Error("no session headers captured after reload: open the Activity tab and retry");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Polls the slot for the documents bearer alone, up to `attempts *
 * intervalMs` -- the cold-start tolerance: a session that never sees it still
 * works for the activity tier, and the documents tier then fails by name.
 * Exported for test/bridge.test.mjs only. */
export async function waitForAuthorizationHeader(cdp, attempts = 40, intervalMs = 500) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const keys = (await currentSlotKeys(cdp).catch(() => [])).map((k) => k.toLowerCase());
    if (keys.includes(AUTHORIZATION_HEADER)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** The headers the *app* must be seen issuing itself before a resumed
 * session is trusted. The bearer is not one of them: the bridge mints a
 * documents-scoped one explicitly (refreshBearer), and the app only ever
 * sends one once its own Documents page has been opened. */
const APP_ISSUED_HEADERS = ["x-xsrf-token", "x-device-footprint"];

/**
 * F1-54c. Polls the capture provenance (see captureMetaExpression) until the
 * app itself has been seen sending both an xsrf token and a device footprint
 * on this document -- the exact state a fresh process finds when the owner has
 * been clicking around after signing in, and the state in which downloads have
 * always worked.
 *
 * A header the bridge's own request carried does not count. The bridge spreads
 * the captured slot into every request it makes, so its own calls re-capture
 * whatever is already there: "the footprint is in the slot" is true the moment
 * the bridge asks for anything, and says nothing about whether the server
 * still accepts that footprint. Waiting for an app-issued one is what tells a
 * live footprint apart from the bridge's echo of a dead one.
 *
 * Resolves to the diagnostics object on success and `null` on timeout.
 * Exported for test/bridge.test.mjs only.
 */
export async function waitForAppFootprint(cdp, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = await readCaptureMeta(cdp).catch(() => null);
    const headers = meta?.headers ?? {};
    if (APP_ISSUED_HEADERS.every((name) => headers[name]?.source === "app")) return meta;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Polls the slot until every WANTED_HEADERS entry is present (or the
 * deadline passes) -- used after a resume's Documents navigation, since that
 * is what lands a documents-scoped bearer alongside the just-reloaded xsrf
 * token and device footprint. Exported for test/bridge.test.mjs only. */
export async function waitForAllHeaders(cdp, timeoutMs, intervalMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const keys = (await currentSlotKeys(cdp).catch(() => [])).map((k) => k.toLowerCase());
    if (WANTED_HEADERS.every((h) => keys.includes(h))) return true;
  }
  return false;
}

// A bearer expires long before the site session does. The app refreshes its
// own from this endpoint; doing the same, page-side, keeps the value inside
// the page exactly like a captured header. Only the outcome is reported,
// never the token. Exported for test/bridge.test.mjs's fake-cdp tests only
// (same convention as `evaluate`/`startKeepAlive` above); every other caller
// reaches it only through createMorganStanleySession or waitForSignIn below.
export async function refreshBearer(cdp, origin) {
  const { requestId, seqId } = randomUuidQueryIds();
  const ok = await evaluate(
    cdp,
    `(async () => {
      ${BRIDGE_FETCH}
      const slotKey = Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)});
      const slot = globalThis[slotKey] ?? (globalThis[slotKey] = {});
      const lower = Object.fromEntries(Object.entries(slot).map(([k, v]) => [k.toLowerCase(), v]));
      const headers = { "Accept": "application/json", "Content-Type": "application/json" };
      for (const k of ["x-xsrf-token", "x-device-footprint"]) if (lower[k]) headers[k] = lower[k];
      const r = await __kithmindFetch(${JSON.stringify(origin)} + "/shell/handler/restproxy/access/api/JWTToken/GetAccessToken?RequestID=${requestId}&SeqID=${seqId}", { method: "POST", headers, credentials: "include", body: "" });
      if (!r.ok) return "status " + r.status;
      const text = await r.text();
      let token = null;
      try { const j = JSON.parse(text); const pick = (o) => { if (!o || typeof o !== "object") return null; for (const [k, v] of Object.entries(o)) { if (typeof v === "string" && /token/i.test(k) && v.length > 40) return v; } for (const v of Object.values(o)) { const t = pick(v); if (t) return t; } return null; }; token = pick(j); } catch { token = text.length > 40 ? text.replace(/^"|"$/g, "") : null; }
      if (!token) return "no token field";
      for (const k of Object.keys(slot)) if (k.toLowerCase() === "authorization") delete slot[k];
      slot["authorization"] = token.startsWith("Bearer ") ? token : "Bearer " + token;
      return "refreshed";
    })()`,
  );
  console.error(new Date().toISOString(), "[bridge] bearer refresh:", ok);
  return ok === "refreshed";
}

// The site ends a session about forty-five minutes after sign-in no matter
// how active it is (seen live 2026-09-11 with keep-alive acknowledged to the
// end).
const SIGN_IN_WAIT_MS = Number(process.env.MS_SIGN_IN_WAIT_MS ?? 45 * 60 * 1000);
// How long a resume waits for every WANTED_HEADERS entry to be recaptured
// fresh before giving up and proceeding anyway (the retry loop in
// withBearerRetry still catches a bad outcome from here, by status code).
const RESUME_HEADER_WAIT_MS = 20_000;
// How long a resume waits for the *app* to issue a device footprint of its own
// after the landing route has loaded (F1-54c). Unlike the wait above this one
// is not best effort: a resume that never sees it fails by name rather than
// proceeding on a footprint the server would reject. Ninety seconds is far
// more than the app's own bootstrap has ever taken; the app makes these calls
// on load, so nobody has to click anything for this to pass.
const RESUME_FOOTPRINT_WAIT_MS = 90_000;
// The app's own shell and its Documents route. The landing route is loaded for
// real on resume so the app bootstraps exactly as it does after a sign-in;
// the Documents route is an in-app hash navigation, never a login page.
const APP_LANDING_PATH = "/atrium/";
const APP_DOCUMENTS_PATH = "/atrium/#/documents";

/**
 * Waits out a session pause (README, "sign in again") and, once the tab is
 * back on the app, rebuilds the session into the same state a fresh process
 * finds: it closes the old CDP socket and its keep-alive timer, reconnects,
 * reinstalls the header hook fresh, loads the app's own landing route for
 * real, and then waits for the *app* to issue an xsrf token and a device
 * footprint of its own before trusting anything.
 *
 * The history, because each step here is a fix for a specific live failure:
 *
 * F1-54: a same-origin resume (an inline re-auth screen, or an in-app
 * redirect that never leaves this origin) never destroys the page's JS
 * context, so the header slot is not reset for free the way a real
 * cross-origin login/logout round trip would reset it. Clearing the slot in
 * place and navigating within the app was not enough: an in-app hash
 * navigation never makes the app re-derive what it computes once per real
 * page load, so a post-resume request paired a freshly minted bearer with a
 * *stale* device-footprint and the documents endpoint answered HTTP 400
 * "Service Error".
 *
 * F1-54b therefore forced a reload. That still 400'd after a real sign-out
 * and re-login (seen live 2026-09-12, 17:07Z: every download failed until the
 * breaker tripped at ten), while a fresh process started after the same
 * sign-in downloaded normally. F1-54c is what that difference turned out to
 * be, and it is not the reload: it is *when* the resume decided the sign-in
 * was finished. The trigger below fires on the first xsrf token the app
 * sends, which is the first request of its post-login bootstrap; the resume
 * then tore the connection down and reloaded on top of a half-bootstrapped
 * app, and afterwards took the first footprint that appeared -- which the
 * server rejected. A fresh process never does any of that: it finds a slot
 * the app filled itself, while the owner was clicking around, and (see
 * createMorganStanleySession) deliberately does not reload it.
 *
 * So the resume now waits for that same evidence rather than for a token that
 * only proves the app has started: it loads the landing route for real, which
 * is what the app itself does after a sign-in, and holds until the capture
 * hook has recorded an app-issued footprint (waitForAppFootprint). A
 * footprint that only the bridge's own request ever carried does not count --
 * the bridge spreads the slot into its own headers, so its calls re-capture
 * whatever is already there and prove nothing. If that evidence never
 * arrives, the resume fails by name instead of proceeding on a suspect value
 * and burning every remaining document on an HTTP 400.
 *
 * `options.reconnect` and `options.keepAlive` exist for
 * test/bridge.test.mjs's fake-cdp tests only (same convention as
 * `evaluate`/`startKeepAlive` above); every other caller reaches this only
 * through createMorganStanleySession, which passes its real keep-alive
 * handle and relies on the default reconnect (connectAndInstallHook).
 * Resolves to `false` on give-up (the owner never signed back in), throws
 * when the app came back but never issued a footprint of its own, or resolves
 * to `{ cdp, keepAlive }` -- a *new* connection and keep-alive timer the
 * caller must start using in place of the old ones -- on a successful resume.
 */
export async function waitForSignIn(cdp, origin, cdpHttpBase, reason, options = {}) {
  const signInWaitMs = options.signInWaitMs ?? SIGN_IN_WAIT_MS;
  const headerWaitMs = options.headerWaitMs ?? RESUME_HEADER_WAIT_MS;
  const footprintWaitMs = options.footprintWaitMs ?? RESUME_FOOTPRINT_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const headerPollIntervalMs = options.headerPollIntervalMs ?? 500;
  const reconnect = options.reconnect ?? (() => connectAndInstallHook(cdpHttpBase, origin));
  console.error(new Date().toISOString(), "[bridge] paused: signed out; sign in again in the dedicated Chrome window to resume", "(" + reason.slice(0, 80) + ")");
  const deadline = Date.now() + signInWaitMs;
  let announced = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const targets = await (await fetch(`${cdpHttpBase}/json/list`)).json().catch(() => []);
    const onApp = targets.find((t) => t.type === "page" && t.url.startsWith(origin));
    if (!onApp) { if (Date.now() - announced > 60_000) { announced = Date.now(); console.error(new Date().toISOString(), "[bridge] still waiting for sign-in"); } continue; }
    const keys = (await currentSlotKeys(cdp).catch(() => [])).map((k) => k.toLowerCase());
    if (keys.includes("x-xsrf-token")) {
      console.error(new Date().toISOString(), "[bridge] sign-in detected: tearing down the paused session and restarting the cold-start sequence");
      if (options.keepAlive) clearInterval(options.keepAlive);
      try {
        cdp.close();
      } catch {
        // The old connection may already be gone; a resume must not fail
        // just because tearing it down did.
      }
      const fresh = await reconnect();
      await logSlotDiagnostics(fresh, "resume: reconnected, slot is a fresh page-side object");
      // A real load of the app's own landing route, not a reload of whatever
      // the login flow left the tab on and not a hash change: this is the
      // navigation the app itself performs after a sign-in, so it bootstraps
      // the same way and issues the same first authenticated requests.
      await reloadAndCaptureHeaders(fresh, `${origin}${APP_LANDING_PATH}`);
      await logSlotDiagnostics(fresh, "resume: landing route loaded");
      // Then wait for the app to have sent a footprint of its own. This is
      // the whole fix (F1-54c): everything before this point proves only that
      // the app started, and a footprint captured off the bridge's own
      // request is the bridge reading back its own echo.
      const captured = await waitForAppFootprint(fresh, footprintWaitMs, headerPollIntervalMs);
      await logSlotDiagnostics(fresh, "resume: waited for the app's own device footprint");
      if (!captured) {
        try {
          fresh.close();
        } catch {
          // Nothing to clean up if the socket is already gone.
        }
        throw new Error(
          "resume: the app never issued its own X-DEVICE-FOOTPRINT within " +
            footprintWaitMs +
            "ms of loading its landing route, so the only footprint available would be one this bridge echoed back. " +
            "Refusing to resume on it: the documents endpoint answers HTTP 400 to a footprint it did not issue. " +
            "Open the app's Activity or Documents tab in the dedicated Chrome window and rerun the same selection.",
        );
      }
      // Land on Documents so the app's own calls repopulate every wanted
      // header, including a documents-scoped bearer. In-app navigation
      // only, never a login page, and only now that the footprint above is
      // known good -- a hash change keeps the same document, so it cannot
      // undo it.
      await fresh.send("Page.navigate", { url: `${origin}${APP_DOCUMENTS_PATH}` }).catch(() => {});
      await waitForAllHeaders(fresh, headerWaitMs, headerPollIntervalMs);
      await logSlotDiagnostics(fresh, "resume: after Documents navigation");
      // The home page's own calls carry a bearer for other services, and
      // the documents API answers 409 to it (seen live 2026-09-11); mint a
      // documents-scoped one explicitly rather than hoping the wait above
      // captured the right one.
      await refreshBearer(fresh, origin);
      await logSlotDiagnostics(fresh, "resume: bearer refreshed");
      const keepAlive = startKeepAlive(fresh, origin);
      console.error(new Date().toISOString(), "[bridge] resumed: the app issued its own headers after sign-in");
      return { cdp: fresh, keepAlive };
    }
  }
  return false;
}

/**
 * F1-62. `--concurrency` runs several fetchText/fetchBytes calls at once
 * against one session. If more than one hits a SIGNED_OUT (or an
 * expired/wrong-service bearer) around the same time, only the first should
 * actually drive the recovery -- a second `waitForSignIn` racing the first
 * would navigate and clear the header slot again mid-wait, and a second
 * concurrent bearer refresh mints a token the first call's retry never sees.
 *
 * `sharedOnce(state, start)` runs `start()` at most once while a caller is
 * already waiting on it: the first caller to reach an empty `state` starts it
 * and every other concurrent caller just awaits that same promise. Once it
 * settles (however it settles), `state.pending` clears itself, so the *next*
 * pause -- a later, unrelated sign-out -- gets its own fresh call rather than
 * replaying a stale result. `state` is one `{ pending }` box per gate (a
 * session opens two: one for sign-in, one for the bearer), created fresh per
 * session so two sessions never share a gate.
 *
 * Exported for test/bridge.test.mjs only (same convention as `evaluate`/
 * `waitForSignIn` above); every other caller reaches it only through
 * `createMorganStanleySession`'s own `withBearerRetry`.
 */
export function sharedOnce(state, start) {
  if (state.pending === null) {
    state.pending = start().finally(() => {
      state.pending = null;
    });
  }
  return state.pending;
}

/** A fresh, empty `sharedOnce` gate. */
export function createSharedGate() {
  return { pending: null };
}

/**
 * Builds the `AdapterSession` the README describes. Options (all from the
 * environment when omitted, matching run.ts's own no-default convention):
 *   - `cdpHttpBase`: e.g. "http://127.0.0.1:9222" (MS_CDP_HTTP_BASE)
 *   - `origin`: the signed-in app's origin, e.g. "https://www.morganstanley.com" (MS_ORIGIN)
 * Connects to the existing tab, installs the header hook, reloads once, and
 * returns fetchText/fetchBytes that translate this adapter's logical paths
 * (see resolveEndpoint) into page-context fetches. Never navigates to a
 * login page. The only DOM it ever touches is the site's own inactivity
 * dialog (F1-63, startInactivityWatch below).
 */
export default async function createMorganStanleySession(options = {}) {
  const cdpHttpBase = options.cdpHttpBase ?? requiredEnv("MS_CDP_HTTP_BASE");
  const origin = options.origin ?? requiredEnv("MS_ORIGIN");

  // `cdp` and `keepAlive` are reassigned on resume (see waitForSignIn's doc
  // comment: F1-54b makes resume tear both down and reconnect, rather than
  // reusing the paused connection in place), so fetchText/fetchBytes/close
  // below must read them from this closure at call time, not capture them
  // once as constants.
  let cdp = await connectAndInstallHook(cdpHttpBase, origin);
  await logSlotDiagnostics(cdp, "cold start: connected");

  // A document that already carries captured headers (a hook installed by an
  // earlier session in this tab) is usable as is; reloading it would only
  // race the app's on-load request.
  if ((await currentSlotKeys(cdp)).length === 0) {
    await reloadAndCaptureHeaders(cdp);
  }
  await logSlotDiagnostics(cdp, "cold start: headers captured");

  // The documents bearer rides on the app's own Documents call, which lands
  // a little after the first XHR headers. Give it up to twenty seconds; a
  // session that never sees it still works for the activity tier, and the
  // documents tier then fails by name as before.
  await waitForAuthorizationHeader(cdp);

  // F1-62. One gate per session -- see sharedOnce's doc comment above.
  const signInGate = createSharedGate();
  const bearerRefreshGate = createSharedGate();

  // F1-63. True only while a sign-in pause -- including F1-54b's teardown
  // and reconnect below -- is in flight. The inactivity watch reads it so it
  // never clicks in a tab that is mid-reconnect or that the owner is signing
  // into.
  let paused = false;

  // F1-54b: a resume tears the paused connection and its timers down and
  // reconnects (see waitForSignIn's doc comment for why an in-place clear
  // was not enough), so this -- not waitForSignIn directly -- is what the
  // shared sign-in gate below runs: it is what swaps cdp/keepAlive/
  // inactivityWatch to the new connection once waitForSignIn resolves.
  async function resumeSession(message) {
    paused = true;
    try {
      const result = await waitForSignIn(cdp, origin, cdpHttpBase, message, { keepAlive });
      if (!result) return false;
      clearInterval(inactivityWatch);
      cdp = result.cdp;
      keepAlive = result.keepAlive;
      inactivityWatch = startInactivityWatch(cdp, () => paused);
      return true;
    } finally {
      paused = false;
    }
  }
  const pauseForSignIn = (reason) => sharedOnce(signInGate, () => resumeSession(reason));

  async function withBearerRetry(request, run) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const message = String(error?.message ?? error);
        // 401 is an expired bearer; 409 is a bearer minted for another
        // service (the home page's calls). Both are cured by the app's own
        // token endpoint.
        if (
          request.needsAuthorization &&
          /request failed: (401|409)\b/.test(message) &&
          (await sharedOnce(bearerRefreshGate, () => refreshBearer(cdp, origin)))
        ) {
          continue;
        }
        if (
          /SIGNED_OUT|no session headers captured yet/.test(message) &&
          attempt < 2 &&
          (await pauseForSignIn(message))
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("request retried too many times");
  }

  async function fetchText(path, query = {}) {
    const request = resolveEndpoint(path, query);
    return withBearerRetry(request, () => evaluate(cdp, pageFetchExpression(origin, request)));
  }

  async function fetchBytes(path, query = {}) {
    const request = resolveEndpoint(path, query);
    const base64 = await withBearerRetry(request, () => evaluate(cdp, pageFetchBytesExpression(origin, request)));
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }

  let keepAlive = startKeepAlive(cdp, origin);
  let inactivityWatch = startInactivityWatch(cdp, () => paused);

  return {
    institutionSlug: "morgan-stanley",
    fetchText,
    fetchBytes,
    close: () => closeSession(cdp, keepAlive, inactivityWatch),
  };
}

/**
 * F1-64: closes every handle a session holds open -- its interval timers
 * (the keep-alive and the inactivity watch; both already unref'd, so neither
 * alone can keep the process up) and the CDP
 * WebSocket itself, which is not unref'd and otherwise outlives a run that
 * throws (a lost session, the consecutive-failure breaker) with no sign-in
 * wait ever logged, refusing every later "a run is alive" check until killed
 * by hand. Exported for test/bridge.test.mjs only (same convention as
 * `evaluate`/`startKeepAlive` above); every other caller reaches it only
 * through createMorganStanleySession's own `close`.
 */
export function closeSession(cdp, ...timers) {
  for (const timer of timers) clearInterval(timer);
  cdp.close();
}

const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Keep-alive. A long import between two site calls (twenty minutes on the
 * first full pull) let the app session idle out and every later document
 * fetch failed on an empty header slot. The app itself extends its session
 * with this call; doing the same every four minutes keeps it alive without
 * touching any credential. `unref` so the timer never keeps the process up.
 * Exported for test/bridge.test.mjs only (same convention as `evaluate`
 * above): every other caller reaches it only through
 * createMorganStanleySession, unchanged.
 */
export function startKeepAlive(cdp, origin) {
  const keepAlive = setInterval(() => {
    const { requestId, seqId } = randomUuidQueryIds();
    evaluate(
      cdp,
      pageFetchExpression(origin, {
        method: "GET",
        url: `/shell/handler/proxy/sal/api/AzureSession/Extend?RequestID=${requestId}&SeqID=${seqId}`,
        body: null,
        headers: { Accept: "application/json" },
        needsAuthorization: false,
      }),
    )
      .then(() => console.error(new Date().toISOString(), "[bridge] keep-alive ok"))
      .catch((error) => console.error(new Date().toISOString(), "[bridge] keep-alive failed:", String(error?.message ?? error).slice(0, 120)));
  }, KEEP_ALIVE_INTERVAL_MS);
  keepAlive.unref();
  return keepAlive;
}

// --- inactivity dialog watch (F1-63) ---------------------------------------

// The session-extend call above keeps the *server* session alive, but the
// page runs a second, independent idle timer that counts user input events
// and ignores the app's own requests. During a continuous pull -- the owner's
// own documents, in a session the owner signed into by hand -- that timer
// reached zero 20 to 45 minutes in and put up an "about to be signed out due
// to inactivity" dialog, and then signed the session out while documents were
// still downloading.
//
// Two ways to answer that were authorized by the account owner in writing on
// 2026-09-12. The first -- dispatching synthetic mouse and key events through
// the CDP Input domain so the page's idle timer sees input that no person
// produced -- is deliberately not implemented here: that timer exists to
// detect whether a person is present, and manufacturing input events to tell
// it "yes" forges the one signal it is built to read. The second is
// implemented below, and is the narrower answer: the bridge does not touch
// the idle timer at all, and acts only when the site itself stops and asks
// whether the session is still wanted. It is, by the owner's own instruction
// and demonstrably so -- a document is downloading as the dialog appears --
// so answering the site's question truthfully keeps the pull going without
// fabricating anything. This is the same posture as the keep-alive above:
// use the mechanism the site offers, do not defeat the one it enforces.
const INACTIVITY_POLL_INTERVAL_MS = 60 * 1000;

/**
 * Page-side check, evaluated once a minute. Returns `null` when no inactivity
 * dialog is up, `{ button: "<text>" }` when one was found and its
 * continue-style button clicked, and `{ button: null }` when one was found
 * with no button matching. It deliberately returns *only* the button's text:
 * the dialog's own contents are read in the page, matched in the page and
 * left there, so nothing the institution renders is carried into a log line.
 * Exported for test/bridge.test.mjs, which runs it against a stub DOM in a vm
 * context exactly as the page-fetch expression is tested.
 */
export const INACTIVITY_DIALOG_EXPRESSION = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const containers = document.querySelectorAll(
    '[role="dialog"],[role="alertdialog"],dialog[open],.modal,[class*="modal"],[class*="dialog"]'
  );
  for (const container of containers) {
    if (!visible(container)) continue;
    if (!/inactiv|signed out|session.*(expir|time)|stay signed in/i.test(container.innerText || "")) continue;
    const buttons = container.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],a');
    for (const button of buttons) {
      const text = String(button.innerText || button.value || "").trim();
      if (!visible(button) || !/stay|continue|keep|extend|yes/i.test(text)) continue;
      button.click();
      return { button: text.slice(0, 60) };
    }
    return { button: null };
  }
  return null;
})()`;

/**
 * F1-63. Polls for the site's own inactivity dialog once a minute and answers
 * it (see INACTIVITY_DIALOG_EXPRESSION above for what it does and does not
 * do). `isPaused` is the session's sign-in pause: while the owner is signing
 * in again, the tab is not the app's and nothing here should be clicking, so
 * every tick is skipped until the pause lifts -- the interval itself keeps
 * running, so a resume needs no restart. Best effort throughout: an evaluate
 * failure is swallowed and logged once, never thrown into the pull. `unref`'d
 * like the keep-alive, so it never keeps the process up on its own. Exported
 * for test/bridge.test.mjs only (same convention as `startKeepAlive` above);
 * every other caller reaches it through createMorganStanleySession.
 */
export function startInactivityWatch(cdp, isPaused = () => false) {
  // One log line per *occurrence*, not per poll: an unanswerable dialog sits
  // there until a person deals with it, and would otherwise log every minute.
  let unanswered = false;
  let loggedFailure = false;
  const watch = setInterval(() => {
    if (isPaused()) return;
    evaluate(cdp, INACTIVITY_DIALOG_EXPRESSION)
      .then((found) => {
        if (!found) {
          unanswered = false;
          return;
        }
        if (found.button) {
          unanswered = false;
          console.error(new Date().toISOString(), `[bridge] inactivity dialog answered: ${found.button}`);
          return;
        }
        if (!unanswered) {
          unanswered = true;
          console.error(new Date().toISOString(), "[bridge] inactivity dialog seen, no button matched");
        }
      })
      .catch((error) => {
        if (loggedFailure) return;
        loggedFailure = true;
        console.error(new Date().toISOString(), "[bridge] inactivity watch failed:", String(error?.message ?? error).slice(0, 120));
      });
  }, INACTIVITY_POLL_INTERVAL_MS);
  watch.unref();
  return watch;
}
