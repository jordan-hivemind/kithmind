import { randomBytes } from "node:crypto";

import { serializeSessionToken } from "@repo/kith-store/identity";
import { NextRequest } from "next/server";
import { describe, expect, test, vi } from "vitest";

import { createRouteMatcher } from "../node_modules/@convex-dev/auth/dist/nextjs/server/routeMatcher.js";

vi.mock("@convex-dev/auth/nextjs/server", () => ({
  convexAuthNextjsMiddleware: (handler: unknown) => handler,
  createRouteMatcher,
  nextjsMiddlewareRedirect: (request: NextRequest, pathname: string) =>
    Response.redirect(new URL(pathname, request.url), 307),
}));

import { handleMiddlewareRequest, isPublicRoute } from "./middleware";

const secret = randomBytes(32).toString("hex");
const token = randomBytes(32).toString("hex");
const cookie = serializeSessionToken({ secret }, token);

const POSTGRES = {
  KITH_POSTGRES_SURFACE: "postgres",
  KITH_SESSION_SECRET: secret,
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

describe("web authentication middleware", () => {
  test.each(["/api/ingest", "/api/worker"])(
    "lets the exact bearer endpoint %s reach its route handler",
    async (pathname) => {
      const isAuthenticated = vi.fn().mockResolvedValue(false);
      const ingest = request(pathname, "POST");

      expect(isPublicRoute(ingest)).toBe(true);
      expect(
        await handleMiddlewareRequest(ingest, {
          convexAuth: { isAuthenticated },
        }),
      ).toBeUndefined();
      expect(isAuthenticated).not.toHaveBeenCalled();
    },
  );

  test("allows the exact invite landing page without authorizing membership", async () => {
    const isAuthenticated = vi.fn().mockResolvedValue(false);
    const invite = request("/invite");
    expect(isPublicRoute(invite)).toBe(true);
    expect(
      await handleMiddlewareRequest(invite, {
        convexAuth: { isAuthenticated },
      }),
    ).toBeUndefined();
    expect(isAuthenticated).not.toHaveBeenCalled();
  });

  test("still redirects unauthenticated web subpaths", async () => {
    for (const pathname of ["/settings", "/spaces", "/invite/other"]) {
      const unauthenticated = request(pathname);
      expect(isPublicRoute(unauthenticated)).toBe(false);

      const response = await handleMiddlewareRequest(unauthenticated, {
        convexAuth: { isAuthenticated: vi.fn().mockResolvedValue(false) },
      });

      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toBe(
        "https://brain.example.test/sign-in",
      );
    }
  });

  // `/api/ingest/other` and `/api/worker/other` are not the exact bearer
  // endpoints (those are public), so they still hit the authentication gate,
  // and being `/api/` paths they now get 401 JSON rather than a redirect --
  // the same rule every other non-public `/api/` path gets, and the same
  // shape `app/api/auth/*` has always answered a failure with.
  test("an unauthenticated request to a non-public API subpath gets 401 JSON, not a redirect", async () => {
    for (const pathname of ["/api/ingest/other", "/api/worker/other"]) {
      const unauthenticated = request(pathname);
      expect(isPublicRoute(unauthenticated)).toBe(false);

      const response = await handleMiddlewareRequest(unauthenticated, {
        convexAuth: { isAuthenticated: vi.fn().mockResolvedValue(false) },
      });

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
  ])("lets %s through in both surface modes", async (pathname) => {
    for (const env of [{}, POSTGRES]) {
      const isAuthenticated = vi.fn().mockResolvedValue(false);
      const route = request(pathname, "POST");
      expect(isPublicRoute(route)).toBe(true);
      expect(
        await handleMiddlewareRequest(route, {
          convexAuth: { isAuthenticated },
          env,
        }),
      ).toBeUndefined();
      expect(isAuthenticated).not.toHaveBeenCalled();
    }
  });

  test("under the convex surface the gate is still Convex Auth", async () => {
    const isAuthenticated = vi.fn().mockResolvedValue(true);
    // A valid kith cookie is not what authenticates here, and the Convex answer
    // is: i1 must be observably unchanged under the default flag.
    expect(
      await handleMiddlewareRequest(request("/settings", "GET", signedIn()), {
        convexAuth: { isAuthenticated },
        env: { KITH_SESSION_SECRET: secret },
      }),
    ).toBeUndefined();
    expect(isAuthenticated).toHaveBeenCalled();

    const denied = vi.fn().mockResolvedValue(false);
    const response = await handleMiddlewareRequest(
      request("/settings", "GET", signedIn()),
      { convexAuth: { isAuthenticated: denied }, env: {} },
    );
    expect(response?.status).toBe(307);
  });

  test("under the postgres surface a well-formed cookie reaches the page", async () => {
    const isAuthenticated = vi.fn().mockResolvedValue(false);
    expect(
      await handleMiddlewareRequest(request("/settings", "GET", signedIn()), {
        convexAuth: { isAuthenticated },
        env: POSTGRES,
      }),
    ).toBeUndefined();
    // Convex is never consulted, which is what makes this a dark deploy of one
    // surface rather than both at once.
    expect(isAuthenticated).not.toHaveBeenCalled();
  });

  test("under the postgres surface an authenticated request leaves the sign-in page", async () => {
    for (const pathname of ["/sign-in", "/sign-up"]) {
      const response = await handleMiddlewareRequest(
        request(pathname, "GET", signedIn()),
        {
          convexAuth: { isAuthenticated: vi.fn().mockResolvedValue(false) },
          env: POSTGRES,
        },
      );
      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toBe(
        "https://brain.example.test/",
      );
    }
  });

  test("under the postgres surface a missing cookie redirects to sign-in", async () => {
    for (const pathname of ["/", "/settings", "/spaces", "/browse"]) {
      const response = await handleMiddlewareRequest(request(pathname), {
        convexAuth: { isAuthenticated: vi.fn().mockResolvedValue(true) },
        env: POSTGRES,
      });
      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toBe(
        "https://brain.example.test/sign-in",
      );
    }
  });

  test("an unauthenticated request to a non-public API route gets 401 JSON, not a redirect", async () => {
    for (const env of [{}, POSTGRES]) {
      const response = await handleMiddlewareRequest(
        request("/api/kith/api-keys", "GET"),
        {
          convexAuth: { isAuthenticated: vi.fn().mockResolvedValue(false) },
          env,
        },
      );
      expect(response?.status).toBe(401);
      expect(response?.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response?.json()).toEqual({
        error: "Not authenticated",
        code: "not_authenticated",
      });
    }
  });

  test("under the postgres surface a forged or truncated cookie is refused", async () => {
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
        {
          convexAuth: { isAuthenticated: vi.fn().mockResolvedValue(true) },
          env: POSTGRES,
        },
      );
      expect(response?.status, JSON.stringify(value).slice(0, 32)).toBe(307);
      expect(response?.headers.get("location")).toBe(
        "https://brain.example.test/sign-in",
      );
    }
  });

  test("under the postgres surface a missing secret authenticates nobody", async () => {
    const response = await handleMiddlewareRequest(
      request("/settings", "GET", signedIn()),
      {
        convexAuth: { isAuthenticated: vi.fn().mockResolvedValue(true) },
        env: { KITH_POSTGRES_SURFACE: "postgres" },
      },
    );
    expect(response?.status).toBe(307);
  });

  test("the MCP root rewrite runs before any authentication check", async () => {
    const isAuthenticated = vi.fn().mockResolvedValue(false);
    const rewritten = await handleMiddlewareRequest(
      new NextRequest("https://brain.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer synthetic",
        },
      }),
      { convexAuth: { isAuthenticated }, env: POSTGRES },
    );
    expect(rewritten?.headers.get("x-middleware-rewrite")).toContain(
      "/api/mcp",
    );
    expect(isAuthenticated).not.toHaveBeenCalled();
  });
});
