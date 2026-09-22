// `kith-plaid-feed link`: a local HTTP server serving one page that runs
// Plaid Link, so the owner can add and re-authenticate institutions without
// any of this package's code ever holding a password.
//
// Flow: the page asks this server for a `link_token`
// (`POST /api/link-token`), stores it in `localStorage` (it has to survive an
// OAuth redirect out to the institution and back), then opens Plaid Link's
// own JS (loaded from Plaid's CDN, never bundled here) with that token. On
// success the page posts the `public_token` and the institution Link
// reported back to `POST /api/exchange`, which exchanges it for an access
// token server-side, writes the token to the Keychain
// (`security add-generic-password`, never logged) and upserts the
// `plaid_items` row. `GET /api/items` lists what is already linked so the
// page can show it and let the owner link the next institution in the same
// session.
//
// Morgan Stanley requires Plaid's OAuth flow: the institution's own login
// page redirects the browser back to `redirect_uri`
// (`http://localhost:<port>/oauth`), which this server also serves the same
// page from. Link's own JS detects the redirect (`receivedRedirectUri`) and
// resumes the flow without any code here knowing that happened.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { CountryCode, Products } from "plaid";

import {
  DEFAULT_LINK_PORT,
  itemKeychainService,
  loadDatabaseUrl,
  loadPlaidCredentials,
  redirectUri,
} from "./config.js";
import { listPlaidItems, openPool, upsertPlaidItem } from "./db.js";
import { writeKeychainSecret } from "./keychain.js";
import { createPlaidClient } from "./plaidClient.js";

const CLIENT_USER_ID = "kithmind-household";

export async function runLinkServer(
  port: number = DEFAULT_LINK_PORT,
): Promise<void> {
  const [credentials, databaseUrl] = await Promise.all([
    loadPlaidCredentials(),
    loadDatabaseUrl(),
  ]);
  const client = createPlaidClient(credentials);
  const pool = openPool(databaseUrl);

  const server = createServer((req, res) => {
    handleRequest(req, res, { client, pool, port }).catch((error) => {
      // eslint-disable-next-line no-console
      console.error("plaid-feed link: unhandled request error", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal_error" }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
  process.stdout.write(
    `plaid-feed link: listening on http://localhost:${port} (Ctrl-C to stop)\n`,
  );

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.close(() => resolve());
    });
  });
}

type Deps = {
  client: ReturnType<typeof createPlaidClient>;
  pool: ReturnType<typeof openPool>;
  port: number;
};

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/oauth")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/items") {
    const items = await listPlaidItems(deps.pool);
    sendJson(res, 200, {
      items: items.map((item) => ({
        institutionName: item.institutionName,
        needsRelink: item.needsRelinkAt !== null,
      })),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/link-token") {
    const response = await deps.client.linkTokenCreate({
      client_name: "Kith Mind",
      language: "en",
      country_codes: [CountryCode.Us],
      user: { client_user_id: CLIENT_USER_ID },
      products: [Products.Investments, Products.Transactions],
      redirect_uri: redirectUri(deps.port),
    });
    sendJson(res, 200, { linkToken: response.data.link_token });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/exchange") {
    const body = (await readJsonBody(req)) as {
      publicToken?: string;
      institutionId?: string;
      institutionName?: string;
    } | null;
    if (
      body?.publicToken === undefined ||
      body.institutionId === undefined ||
      body.institutionName === undefined
    ) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    const exchange = await deps.client.itemPublicTokenExchange({
      public_token: body.publicToken,
    });
    const keychainService = itemKeychainService(body.institutionName);
    // Never logged: written straight from the exchange response to the
    // Keychain.
    await writeKeychainSecret(keychainService, exchange.data.access_token);
    await upsertPlaidItem(deps.pool, {
      itemId: exchange.data.item_id,
      institutionId: body.institutionId,
      institutionName: body.institutionName,
      keychainService,
    });
    sendJson(res, 200, { linked: true, institutionName: body.institutionName });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return null;
  return JSON.parse(text);
}

function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kith Mind: link a Plaid institution</title>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 560px; margin: 48px auto; color: #1f2937; }
  h1 { font-size: 18px; }
  button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid #2563eb; background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  ul { padding-left: 0; list-style: none; }
  li { padding: 6px 0; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; }
  .relink { color: #b45309; font-size: 12px; }
  .status { margin-top: 12px; font-size: 13px; color: #4b5563; }
</style>
</head>
<body>
<h1>Link a Plaid institution</h1>
<p>Morgan Stanley, Vanguard, Fidelity and Chase can all be linked from here, one
at a time. Each one opens Plaid's own sign-in flow; nothing you type reaches
this page.</p>
<button id="link-button">Link an institution</button>
<div class="status" id="status"></div>
<h2>Linked so far</h2>
<ul id="items"></ul>
<script>
(function () {
  const STORAGE_KEY = "kith-plaid-link-token";
  const statusEl = document.getElementById("status");
  const itemsEl = document.getElementById("items");
  const buttonEl = document.getElementById("link-button");

  function setStatus(text) {
    statusEl.textContent = text;
  }

  async function refreshItems() {
    const response = await fetch("/api/items");
    const data = await response.json();
    itemsEl.innerHTML = "";
    for (const item of data.items) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = item.institutionName;
      li.appendChild(label);
      if (item.needsRelink) {
        const relink = document.createElement("span");
        relink.className = "relink";
        relink.textContent = "needs relink";
        li.appendChild(relink);
      }
      itemsEl.appendChild(li);
    }
    if (data.items.length === 0) {
      const li = document.createElement("li");
      li.textContent = "None yet";
      itemsEl.appendChild(li);
    }
  }

  async function createLinkToken() {
    const response = await fetch("/api/link-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await response.json();
    localStorage.setItem(STORAGE_KEY, data.linkToken);
    return data.linkToken;
  }

  function openLink(token) {
    const handler = Plaid.create({
      token: token,
      receivedRedirectUri:
        window.location.pathname === "/oauth" ? window.location.href : undefined,
      onSuccess: async function (publicToken, metadata) {
        setStatus("Exchanging token for " + metadata.institution.name + "...");
        const response = await fetch("/api/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            publicToken: publicToken,
            institutionId: metadata.institution.institution_id,
            institutionName: metadata.institution.name,
          }),
        });
        const data = await response.json();
        localStorage.removeItem(STORAGE_KEY);
        setStatus(data.linked ? "Linked " + data.institutionName + "." : "Link failed.");
        buttonEl.disabled = false;
        refreshItems();
      },
      onExit: function (error) {
        buttonEl.disabled = false;
        setStatus(error ? "Exited: " + error.error_message : "Exited Link.");
      },
    });
    handler.open();
  }

  buttonEl.addEventListener("click", async function () {
    buttonEl.disabled = true;
    setStatus("Opening Plaid Link...");
    const token = await createLinkToken();
    openLink(token);
  });

  // Resuming after an OAuth redirect: Link was already initialized once
  // before the institution's own site took over the browser, so the same
  // link_token (not a fresh one) has to be reused.
  if (window.location.pathname === "/oauth") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setStatus("Resuming after sign-in...");
      openLink(stored);
    } else {
      setStatus("No pending link to resume. Go back and click Link an institution.");
    }
  }

  refreshItems();
})();
</script>
</body>
</html>
`;
}
