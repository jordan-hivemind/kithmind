// The session bridge (README, "How the session works"): attaches over the Chrome
// DevTools Protocol to a Chrome tab a person is already signed in to,
// installs a header-capture hook inside the page, reloads once, and issues
// every fetch from *inside* that page so the app's own X-XSRF-TOKEN and
// X-DEVICE-FOOTPRINT headers ride along. Proven credential-free against a
// local page in ../spike/bridge-spike.mjs; this file is that same mechanism
// wired to an AdapterSession and to Morgan Stanley's specific requests.
//
// No login, no navigation to a login form, no credential anywhere in this
// file: the captured header *values* never cross the CDP boundary (see
// fetchInPage below). If the capture slot is empty, every call throws and
// tells the operator to open the Activity tab -- it never synthesizes a header
// or drives the site's UI.
//
// This module is exercised end to end only by the spike; nothing in the
// test suite runs against the institution or a browser. The pure
// request-building helpers it exports (buildActivityRequestBody etc.) have
// their own fixture-only tests in test/bridge.test.mjs.

const CAPTURED_HEADERS_SLOT = "kithmind.capturedHeaders";
const WANTED_HEADERS = ["x-xsrf-token", "x-device-footprint"];

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

/**
 * The documents-list POST body. The observed request names its
 * `filters` array fields (DocType, DocSubType, KeyAccountNo) and `TimeFrame`
 * but not the exact envelope beyond that, so this is the adapter's working
 * assumption for the request shape -- confirmed the same way as the response
 * envelope keys in src/adapter.mjs, by running it once and reading the error
 * or the result rather than trusting the guess silently.
 */
export function buildDocumentsRequestBody(query = {}) {
  return JSON.stringify({
    filters: [
      { DocType: query.docType ?? "", DocSubType: query.docSubType ?? "", KeyAccountNo: query.keyAccount ?? "" },
    ],
    TimeFrame: query.timeFrame ?? "All",
    PageNumber: Number(query.page ?? "1"),
  });
}

/**
 * Endpoint routing for every logical path this adapter's `AdapterSession`
 * calls. Only the activity path is known; the rest
 * (documents, tabular export, per-document download, account list) are not,
 * so they are read from the environment with no guessed default -- an unset
 * one throws a clear, named error rather than silently posting to a made-up
 * URL. Confirm each real path during the first discover() run
 * (README, "Operator runbook") and set it once in the operator's environment.
 */
function resolveEndpoint(path, query) {
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
    return {
      method: "POST",
      url: requiredEnv("MS_DOCUMENTS_PATH"),
      body: buildDocumentsRequestBody(query),
    };
  }
  if (path.startsWith("/documents/")) {
    const [externalId] = path.slice("/documents/".length).split("::");
    return {
      method: "GET",
      url: `${requiredEnv("MS_DOCUMENT_DOWNLOAD_PATH_PREFIX")}${encodeURIComponent(externalId)}`,
      body: null,
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
    return { method: "GET", url: requiredEnv("MS_ACCOUNTS_PATH"), body: null };
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

/** Installed once, before the tab's next navigation. Allowlisted by name;
 * stores values in a page-side slot the bridge never reads out of the page. */
const HEADER_HOOK = `(() => {
  const WANTED = ${JSON.stringify(WANTED_HEADERS)};
  const slot = (globalThis[Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)})] ??= {});
  const original = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (WANTED.includes(String(name).toLowerCase())) slot[String(name)] = value;
    return original.call(this, name, value);
  };
})()`;

/** A fetch expression evaluated *inside* the page: it reads the captured
 * headers out of the page-side slot and spreads them into the request, so
 * only the response body -- never a header value -- crosses the CDP
 * boundary back to Node. Throws in-page, with an instruction to open the
 * Activity tab, when the slot is still empty. */
function pageFetchExpression(origin, { method, url, body }) {
  return `(async () => {
    const slot = globalThis[Symbol.for(${JSON.stringify(CAPTURED_HEADERS_SLOT)})] ?? {};
    if (Object.keys(slot).length === 0) {
      throw new Error("no session headers captured yet: open the Activity tab in this Chrome window, then retry");
    }
    const response = await fetch(${JSON.stringify(origin)} + ${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)},
      headers: { "Content-Type": "application/json", ...slot },
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
