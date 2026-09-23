import { randomBytes } from "node:crypto";

import { serializeSessionToken } from "@repo/kith-store/identity";
import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";

import { handleMiddlewareRequest, isPublicRoute } from "./middleware";

const secret = randomBytes(32).toString("hex");
const token = randomBytes(32).toString("hex");
const cookie = serializeSessionToken({ secret }, token);

const ENV = { KITH_SESSION_SECRET: secret } as const;
const DEVELOPMENT_ENV = {
  KITH_SESSION_SECRET: secret,
  NODE_ENV: "development",
} as const;
const TEST_ENV = {
  KITH_SESSION_SECRET: secret,
  NODE_ENV: "test",
} as const;

function request(pathname: string, method = "GET", cookieHeader?: string) {
  return new NextRequest(`https://brain.example.test${pathname}`, {
    method,
    ...(cookieHeader === undefined
      ? {}
      : { headers: { cookie: cookieHeader } }),
  });
}

function signedIn(value = cookie) {
  return `__Host-kith_session=${value}`;
}

function signedInLocally(value = cookie) {
  return `kith_session=${value}`;
}

describe("web authentication middleware", () => {
  test("accepts only the development cookie name in local development", async () => {
    expect(
      await handleMiddlewareRequest(
        request("/settings", "GET", signedInLocally()),
        { env: DEVELOPMENT_ENV },
      ),
    ).toBeUndefined();
    const hostPrefixed = await handleMiddlewareRequest(
      request("/settings", "GET", signedIn()),
      { env: DEVELOPMENT_ENV },
    );
    expect(hostPrefixed?.status).toBe(307);

    expect(
      await handleMiddlewareRequest(
        request("/settings", "GET", signedInLocally()),
        { env: TEST_ENV },
      ),
    ).toBeUndefined();

    const developmentInProduction = await handleMiddlewareRequest(
      request("/settings", "GET", signedInLocally()),
      { env: ENV },
    );
    expect(developmentInProduction?.status).toBe(307);

    const developmentInUnknownMode = await handleMiddlewareRequest(
      request("/settings", "GET", signedInLocally()),
      {
        env: { KITH_SESSION_SECRET: secret, NODE_ENV: "preview" },
      },
    );
    expect(developmentInUnknownMode?.status).toBe(307);
  });
  test.each(["/api/ingest", "/api/worker"])(
    "lets the exact bearer endpoint %s reach its route handler",
    async (pathname) => {
      const ingest = request(pathname, "POST");

      expect(isPublicRoute(ingest)).toBe(true);
      expect(await handleMiddlewareRequest(ingest, {})).toBeUndefined();
    },
  );

  test("allows the exact invite landing page without authorizing membership", async () => {
    const invite = request("/invite");
    expect(isPublicRoute(invite)).toBe(true);
    const epicCallback = request("/api/epic/callback");
    expect(isPublicRoute(epicCallback)).toBe(true);
    expect(await handleMiddlewareRequest(invite, {})).toBeUndefined();
  });

  test("still redirects unauthenticated web subpaths", async () => {
    for (const pathname of ["/settings", "/spaces", "/invite/other"]) {
      const unauthenticated = request(pathname);
      expect(isPublicRoute(unauthenticated)).toBe(false);

      const response = await handleMiddlewareRequest(unauthenticated, {});

      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toBe(
        "https://brain.example.test/sign-in",
      );
    }
  });

  // `/api/ingest/other` and `/api/worker/other` are not the exact bearer
  // endpoints (those are public), so they still hit the authentication gate,
  // and being `/api/` paths they get 401 JSON rather than a redirect -- the
  // same rule every other non-public `/api/` path gets, and the same shape
  // `app/api/auth/*` has always answered a failure with.
  test("an unauthenticated request to a non-public API subpath gets 401 JSON, not a redirect", async () => {
    for (const pathname of ["/api/ingest/other", "/api/worker/other"]) {
      const unauthenticated = request(pathname);
      expect(isPublicRoute(unauthenticated)).toBe(false);

      const response = await handleMiddlewareRequest(unauthenticated, {});

      expect(response?.status).toBe(401);
      expect(await response?.json()).toEqual({
        error: "Not authenticated",
        code: "not_authenticated",
      });
    }
  });

  // The four session routes have to be reachable without a session: three of
  // them are how a caller gets one.
  test.each([
    "/api/auth/sign-in",
    "/api/auth/sign-up",
    "/api/auth/sign-out",
    "/api/auth/change-password",
  ])("lets %s through", async (pathname) => {
    const route = request(pathname, "POST");
    expect(isPublicRoute(route)).toBe(true);
    expect(await handleMiddlewareRequest(route, {})).toBeUndefined();
  });

  test("a well-formed cookie reaches the page", async () => {
    expect(
      await handleMiddlewareRequest(request("/settings", "GET", signedIn()), {
        env: ENV,
      }),
    ).toBeUndefined();
  });

  test("an authenticated request leaves the sign-in page", async () => {
    for (const pathname of ["/sign-in", "/sign-up"]) {
      const response = await handleMiddlewareRequest(
        request(pathname, "GET", signedIn()),
        { env: ENV },
      );
      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toBe(
        "https://brain.example.test/",
      );
    }
  });

  test("a missing cookie redirects to sign-in", async () => {
    for (const pathname of ["/", "/settings", "/spaces", "/browse"]) {
      const response = await handleMiddlewareRequest(request(pathname), {
        env: ENV,
      });
      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toBe(
        "https://brain.example.test/sign-in",
      );
    }
  });

  test("an unauthenticated request to a non-public API route gets 401 JSON, not a redirect", async () => {
    const response = await handleMiddlewareRequest(
      request("/api/kith/api-keys", "GET"),
      { env: ENV },
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.get("content-type")).toContain("application/json");
    expect(await response?.json()).toEqual({
      error: "Not authenticated",
      code: "not_authenticated",
    });
  });

  test("a forged or truncated cookie is refused", async () => {
    const forged = [
      // A signature over a different token.
      `v1.${randomBytes(32).toString("hex")}.${cookie.split(".")[2]}`,
      // A signature under a different key.
      serializeSessionToken({ secret: randomBytes(32).toString("hex") }, token),
      // The token with no signature.
      `v1.${token}.`,
      token,
      // Truncations of a genuine cookie, including one character short.
      cookie.slice(0, -1),
      cookie.slice(0, 40),
      cookie.slice(0, 3),
      "",
    ];
    for (const value of forged) {
      const response = await handleMiddlewareRequest(
        request("/settings", "GET", signedIn(value)),
        { env: ENV },
      );
      expect(response?.status, JSON.stringify(value).slice(0, 32)).toBe(307);
      expect(response?.headers.get("location")).toBe(
        "https://brain.example.test/sign-in",
      );
    }
  });

  test("a missing secret authenticates nobody", async () => {
    const response = await handleMiddlewareRequest(
      request("/settings", "GET", signedIn()),
      { env: {} },
    );
    expect(response?.status).toBe(307);
  });

  test("the MCP root rewrite runs before any authentication check", async () => {
    const rewritten = await handleMiddlewareRequest(
      new NextRequest("https://brain.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer synthetic",
        },
      }),
      { env: ENV },
    );
    expect(rewritten?.headers.get("x-middleware-rewrite")).toContain(
      "/api/mcp",
    );
  });
});
