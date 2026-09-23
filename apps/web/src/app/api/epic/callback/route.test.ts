// No database and no session: this route only catches Epic's OAuth
// redirect and hands the authorization code back to the person, so the
// three cases that matter are the success page, the OAuth error page, and
// the 400 when Epic sends neither.

import { describe, expect, test } from "vitest";

import { GET } from "./route";

const BASE = "https://kith.example.test/api/epic/callback";

describe("GET /api/epic/callback", () => {
  test("code and state present: 200, renders the copy box, never logs the code", async () => {
    const response = await GET(new Request(`${BASE}?code=abc123&state=xyz789`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).toMatch(/style-src 'nonce-[^']+'/);
    expect(csp).not.toContain("unsafe-inline");

    const html = await response.text();
    expect(html).toContain("abc123");
    expect(html).toContain("xyz789");
    expect(html).toContain("Paste this into the terminal that is waiting for it.");
    expect(html).toContain('id="copy-code"');

    // The nonce in the CSP header must match the nonce on the emitted tags.
    const scriptNonce = csp!.match(/script-src 'nonce-([^']+)'/)?.[1];
    const styleNonce = csp!.match(/style-src 'nonce-([^']+)'/)?.[1];
    expect(html).toContain(`<script nonce="${scriptNonce}">`);
    expect(html).toContain(`<style nonce="${styleNonce}">`);
  });

  test("code without state: renders without a state row", async () => {
    const response = await GET(new Request(`${BASE}?code=abc123`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("abc123");
    expect(html).not.toContain(">State<");
  });

  test("error present: shows the error and description instead of a code box, no script", async () => {
    const response = await GET(
      new Request(`${BASE}?error=access_denied&error_description=User+declined`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src 'none'");

    const html = await response.text();
    expect(html).toContain("access_denied");
    expect(html).toContain("User declined");
    expect(html).not.toContain('id="copy-code"');
    expect(html).not.toContain("<script");
  });

  test("neither code nor error: 400 with the same page style", async () => {
    const response = await GET(new Request(BASE));
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const html = await response.text();
    expect(html).toContain("Epic authorization failed");
    expect(html).toContain("did not return a code or an error");
  });

  test("a code containing markup is escaped, not executed", async () => {
    const response = await GET(
      new Request(`${BASE}?code=${encodeURIComponent('<script>alert(1)</script>')}`),
    );
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
