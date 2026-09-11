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
// tells the operator to open the Activity tab -- it never synthesizes a header
// or drives the site's UI. The documents endpoints additionally need the
// bearer the app sets only once its own Documents page has loaded, so they
// throw their own named error naming that header, never its value.
//
// This module is exercised end to end only by the spike; nothing in the
// test suite runs against the institution or a browser. The pure
// request-building helpers it exports (buildActivityRequestBody etc.) have
// their own fixture-only tests in test/bridge.test.mjs.

const CAPTURED_HEADERS_SLOT = "kithmind.capturedHeaders";
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

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
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
 * else: not returned, not logged, not sent over the debugging connection. */
const HEADER_HOOK = `(() => {
  const WANTED = ${JSON.stringify(WANTED_HEADERS)};
  const slot = (globalThis[Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)})] ??= {});
  const capture = (name, value) => {
    const canonical = String(name).toLowerCase();
    if (value && WANTED.includes(canonical)) slot[canonical] = value;
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
    const slot = Object.fromEntries(Object.entries(globalThis[Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)})] ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
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
    const response = await fetch(${JSON.stringify(origin)} + ${JSON.stringify(url)}, {
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

/**
 * Builds the `AdapterSession` the README describes. Options (all from the
 * environment when omitted, matching run.ts's own no-default convention):
 *   - `cdpHttpBase`: e.g. "http://127.0.0.1:9222" (MS_CDP_HTTP_BASE)
 *   - `origin`: the signed-in app's origin, e.g. "https://www.morganstanley.com" (MS_ORIGIN)
 * Connects to the existing tab, installs the header hook, reloads once, and
 * returns fetchText/fetchBytes that translate this adapter's logical paths
 * (see resolveEndpoint) into page-context fetches. Never navigates to a
 * login page and never touches the tab's DOM.
 */
export default async function createMorganStanleySession(options = {}) {
  const cdpHttpBase = options.cdpHttpBase ?? requiredEnv("MS_CDP_HTTP_BASE");
  const origin = options.origin ?? requiredEnv("MS_ORIGIN");

  const target = await findPageTarget(cdpHttpBase, origin);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HEADER_HOOK });

  const slotKeys = () =>
    evaluate(cdp, `Object.keys(globalThis[Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)})] ?? {})`);

  // A document that already carries captured headers (a hook installed by an
  // earlier session in this tab) is usable as is; reloading it would only
  // race the app's on-load request. Otherwise reload and wait for the *new*
  // document, marked by the disappearance of a sentinel set on the old one,
  // before trusting the slot: reading the old document's slot right after
  // Page.reload returns stale keys and the fetch that follows finds nothing.
  if ((await slotKeys()).length === 0) {
    await evaluate(cdp, "globalThis.__kithmindReloadSentinel = true; true");
    await cdp.send("Page.reload");
    let fresh = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (!fresh) {
        fresh = await evaluate(cdp, "globalThis.__kithmindReloadSentinel === undefined").catch(() => false);
      }
      if (fresh && (await slotKeys().catch(() => [])).length > 0) break;
      if (attempt === 299) {
        throw new Error("no session headers captured after reload: open the Activity tab and retry");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // The documents bearer rides on the app's own Documents call, which lands
  // a little after the first XHR headers. Give it up to twenty seconds; a
  // session that never sees it still works for the activity tier, and the
  // documents tier then fails by name as before.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const keys = (await slotKeys().catch(() => [])).map((k) => k.toLowerCase());
    if (keys.includes(AUTHORIZATION_HEADER)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  async function fetchText(path, query = {}) {
    const request = resolveEndpoint(path, query);
    return evaluate(cdp, pageFetchExpression(origin, request));
  }

  async function fetchBytes(path, query = {}) {
    const request = resolveEndpoint(path, query);
    const base64 = await evaluate(cdp, pageFetchBytesExpression(origin, request));
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }

  return { institutionSlug: "morgan-stanley", fetchText, fetchBytes };
}
