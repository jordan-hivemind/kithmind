// Epic's OAuth redirect target for the MyChart patient-facing app.
//
// The pull itself runs on the owner's Mac, where the private key and tokens
// live -- this route only exists because Epic requires an https redirect
// URI for a production patient app. It catches the redirect, shows the
// authorization code and state in a box the person can copy, and tells them
// to paste it into the terminal that is waiting for it. No authentication,
// no database, and the code is never logged: it passes through the query
// string and the rendered page only, on a route Epic itself calls.

import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nonce(): string {
  return randomBytes(16).toString("base64");
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #ffffff;
    color: #171717;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14.5px;
  }
  .card {
    width: 100%;
    max-width: 480px;
    margin: 24px;
    border: 1px solid #e5e5e5;
    border-radius: 10px;
    padding: 24px;
  }
  .card.error { border-color: #fecaca; }
  h1 {
    font-size: 17.835px;
    font-weight: 600;
    margin: 0 0 16px;
  }
  .row { margin-bottom: 16px; }
  .row:last-child { margin-bottom: 0; }
  .label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #737373;
    margin-bottom: 4px;
  }
  .box {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13.5px;
    background: #f5f5f5;
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    padding: 10px 12px;
    word-break: break-all;
    white-space: pre-wrap;
  }
  .error .box { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }
  button {
    margin-top: 10px;
    font: inherit;
    font-size: 13.5px;
    background: #1e40af;
    color: #ffffff;
    border: none;
    border-radius: 8px;
    padding: 6px 12px;
    cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
  .hint { margin-top: 20px; font-size: 13.5px; color: #525252; }
`;

function copyScript(): string {
  return `
(function () {
  var btn = document.getElementById("copy-code");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var el = document.getElementById("code-value");
    var text = el ? el.textContent || "" : "";
    navigator.clipboard.writeText(text).then(function () {
      var original = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(function () {
        btn.textContent = original;
      }, 1500);
    });
  });
})();
`;
}

function page(options: {
  styleNonce: string;
  scriptNonce: string;
  body: string;
  cardClass?: string;
  includeScript: boolean;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Epic authorization</title>
<style nonce="${options.styleNonce}">${STYLE}</style>
</head>
<body>
<div class="card${options.cardClass ? ` ${options.cardClass}` : ""}">
${options.body}
</div>
${options.includeScript ? `<script nonce="${options.scriptNonce}">${copyScript()}</script>` : ""}
</body>
</html>`;
}

function successBody(code: string, state: string | null): string {
  const stateRow =
    state === null
      ? ""
      : `<div class="row">
  <div class="label">State</div>
  <div class="box">${escapeHtml(state)}</div>
</div>`;
  return `<h1>Epic authorization</h1>
<div class="row">
  <div class="label">Code</div>
  <div class="box" id="code-value">${escapeHtml(code)}</div>
  <button type="button" id="copy-code">Copy</button>
</div>
${stateRow}
<p class="hint">Paste this into the terminal that is waiting for it.</p>`;
}

function errorBody(error: string, description: string | null): string {
  const descriptionRow =
    description === null
      ? ""
      : `<div class="row">
  <div class="label">Description</div>
  <div class="box">${escapeHtml(description)}</div>
</div>`;
  return `<h1>Epic authorization failed</h1>
<div class="row">
  <div class="label">Error</div>
  <div class="box">${escapeHtml(error)}</div>
</div>
${descriptionRow}`;
}

function missingBody(): string {
  return `<h1>Epic authorization failed</h1>
<div class="row">
  <div class="label">Error</div>
  <div class="box">Epic did not return a code or an error.</div>
</div>`;
}

function respond(
  status: number,
  html: string,
  styleNonce: string,
  scriptNonce: string,
  includeScript: boolean,
): Response {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${styleNonce}'`,
    `script-src${includeScript ? ` 'nonce-${scriptNonce}'` : " 'none'"}`,
    "img-src 'none'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": csp,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  const styleNonce = nonce();
  const scriptNonce = nonce();

  if (error !== null) {
    const html = page({
      styleNonce,
      scriptNonce,
      cardClass: "error",
      includeScript: false,
      body: errorBody(error, errorDescription),
    });
    return respond(200, html, styleNonce, scriptNonce, false);
  }

  if (code !== null) {
    const html = page({
      styleNonce,
      scriptNonce,
      includeScript: true,
      body: successBody(code, state),
    });
    return respond(200, html, styleNonce, scriptNonce, true);
  }

  const html = page({
    styleNonce,
    scriptNonce,
    cardClass: "error",
    includeScript: false,
    body: missingBody(),
  });
  return respond(400, html, styleNonce, scriptNonce, false);
}
