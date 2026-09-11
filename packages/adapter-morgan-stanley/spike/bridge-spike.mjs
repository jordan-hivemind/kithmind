// Credential-free proof of the session bridge the README describes:
// attach over the Chrome DevTools Protocol to a Chrome the person is already
// using, hook XMLHttpRequest.prototype.setRequestHeader and window.fetch
// inside the page, and issue the adapter's fetches from page context so the
// app's own XSRF, device-footprint and Authorization headers ride along.
//
// No login, no real institution, no dependency: Node 24 has fetch and a
// global WebSocket, which is the whole CDP client. Run: node bridge-spike.mjs
//
// The spike echoes the captured header values back so it can assert on them.
// The real bridge does not: the values stay in a page-side slot and only
// response bodies cross the CDP boundary (see README, "How the session works").

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CAPTURED = "kithmind.capturedHeaders";
const PAGE = readFileSync(new URL("./app.html", import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, fn, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// --- the fake signed-in app -------------------------------------------------

function startApp() {
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
      return;
    }
    const xsrf = req.headers["x-xsrf-token"];
    const footprint = req.headers["x-device-footprint"];
    const authorization = req.headers["authorization"];
    if (req.url === "/api/documents") {
      // The documents tier: the app sends a bearer here and nothing else will do.
      if (!xsrf || !authorization) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication Failed" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ xsrf, authorization }));
      return;
    }
    if (!xsrf || !footprint) {
      // Exactly what the institution does to a request rebuilt from outside
      // the page: "Authentication Failed."
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication Failed" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ xsrf, footprint }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

// --- the smallest CDP client that does the job ------------------------------

async function connect(wsUrl) {
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
  if (exceptionDetails) throw new Error(exceptionDetails.text + " " + (result?.description ?? ""));
  return result.value;
}

// --- the hook, installed before the document runs ---------------------------
//
// Allowlisted by name, stored in a page-side slot. The bridge never reads the
// values out; the page re-applies them to its own fetches.

const HOOK = `(() => {
  const WANTED = ["x-xsrf-token", "x-device-footprint", "authorization"];
  const slot = (globalThis[Symbol.for(${JSON.stringify(CAPTURED)})] ??= {});
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

const pageFetch = (origin, path) => `(async () => {
  const slot = globalThis[Symbol.for(${JSON.stringify(CAPTURED)})] ?? {};
  if (Object.keys(slot).length === 0) throw new Error("no headers captured yet");
  const response = await fetch(${JSON.stringify(origin)} + ${JSON.stringify(path)}, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...slot },
    body: "{}",
  });
  return response.status + " " + (await response.text());
})()`;

// --- run --------------------------------------------------------------------

const { server, origin } = await startApp();
const profile = await mkdtemp(join(tmpdir(), "kithmind-spike-"));
const chrome = spawn(CHROME, [
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=600,400",
  origin,
]);

let failure = null;
try {
  const port = (
    await until("DevToolsActivePort", () => readFile(join(profile, "DevToolsActivePort"), "utf8"))
  ).split("\n")[0];
  const target = await until("the app's page target", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find((t) => t.type === "page" && t.url.startsWith(origin));
  });
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // 1. Install the hook on the next document, then reload once. A person's
  //    sign-in survives a reload; waiting for the app's next XHR does not
  //    need a script to drive the site's UI.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  await cdp.send("Page.reload");

  // 2. The app's own on-load calls are what carry the headers: an XHR for
  //    activity, and a fetch for documents, which is the one with the bearer.
  const appEcho = await until("the app's on-load XHR", () =>
    evaluate(cdp, "window.__onLoadEcho ?? null"),
  );
  const appDocumentsEcho = await until("the app's on-load documents fetch", () =>
    evaluate(cdp, "window.__documentsEcho ?? null"),
  );
  const captured = await evaluate(
    cdp,
    `Object.keys(globalThis[Symbol.for(${JSON.stringify(CAPTURED)})] ?? {})`,
  );
  assert.deepEqual(captured.sort(), ["authorization", "x-device-footprint", "x-xsrf-token"]);

  // 3. A fetch issued from page context with the captured headers is accepted
  //    and echoes back the same values the app itself sent -- including the
  //    documents bearer, which only the fetch wrapper could have captured.
  const bridgeEcho = await evaluate(cdp, pageFetch(origin, "/api/activity"));
  assert.equal(bridgeEcho, appEcho);
  assert.match(bridgeEcho, /^200 /);

  const bridgeDocumentsEcho = await evaluate(cdp, pageFetch(origin, "/api/documents"));
  assert.equal(bridgeDocumentsEcho, appDocumentsEcho);
  assert.match(bridgeDocumentsEcho, /^200 /);

  // 4. The same requests from outside the page are refused, which is why the
  //    bridge exists at all.
  const outside = await fetch(`${origin}/api/activity`, { method: "POST", body: "{}" });
  assert.equal(outside.status, 401);
  const outsideDocuments = await fetch(`${origin}/api/documents`, { method: "POST", body: "{}" });
  assert.equal(outsideDocuments.status, 401);

  // 5. Nothing but header *names* ever came back over the debugging
  //    connection: the values the server echoed appear in no value the bridge
  //    read out of the page.
  const values = JSON.parse(appDocumentsEcho.slice(4));
  for (const value of Object.values(values)) {
    assert.equal(captured.some((name) => name.includes(value)), false);
  }

  await cdp.close();
  console.log("captured header names:", captured.join(", "));
  console.log("page-context fetch   :", bridgeEcho.slice(0, 12) + "...");
  console.log("documents fetch      :", bridgeDocumentsEcho.slice(0, 12) + "...");
  console.log("node-context fetch   :", outside.status, (await outside.json()).error);
  console.log("PASS");
} catch (error) {
  failure = error;
  console.error("FAIL", error);
} finally {
  chrome.kill();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);
