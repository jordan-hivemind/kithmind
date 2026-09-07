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

function request(pathname: string, method = "GET") {
  return new NextRequest(`https://brain.example.test${pathname}`, { method });
}

describe("web authentication middleware", () => {
  test("lets the exact bearer ingest endpoint reach its route handler", async () => {
    const isAuthenticated = vi.fn().mockResolvedValue(false);
    const ingest = request("/api/ingest", "POST");

    expect(isPublicRoute(ingest)).toBe(true);
    expect(
      await handleMiddlewareRequest(ingest, {
        convexAuth: { isAuthenticated },
      }),
    ).toBeUndefined();
    expect(isAuthenticated).not.toHaveBeenCalled();
  });

  test("still redirects unauthenticated web and ingest subpaths", async () => {
    for (const pathname of ["/settings", "/api/ingest/other"]) {
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
});
