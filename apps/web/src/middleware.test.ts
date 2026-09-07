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

  test("still redirects unauthenticated web and ingest subpaths", async () => {
    for (const pathname of [
      "/settings",
      "/spaces",
      "/invite/other",
      "/api/ingest/other",
      "/api/worker/other",
    ]) {
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
