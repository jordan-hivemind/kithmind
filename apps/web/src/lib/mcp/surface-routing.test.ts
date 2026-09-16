// The two routes that now follow the surface flag, and nothing else does.
//
// This replaces `surface-pinning.test.ts`, which asserted the opposite. i2
// pinned `/api/ingest` and `/api/worker` to Convex through a second
// authenticator that ignored `KITH_POSTGRES_SURFACE`, because those routes did
// all of their work on Convex and a credential resolved against
// `kith.api_keys` must not authorize work in a backend that never checked it.
// i4 moves each route's work and its authentication together, so the pin is
// gone and the property to hold is the one these cases state: one flag, one
// backend, for the credential and for the work in the same request.
//
// The proof is by exclusion in both directions, which is what makes it a
// routing test rather than a behaviour test. Under `convex` the process is
// given a pool that fails the test if anything checks out a connection, so a
// route that answers at all answered without touching PostgreSQL. Under
// `postgres` the Convex client is mocked and asserted never to be called, so a
// route that reaches the pool reached it *instead of* Convex rather than as
// well as it. What each surface then does with the request is asserted against
// a real database in `postgres-writes.test.ts` and, for the Convex leg, by the
// suites that already covered it.

import { api } from "@repo/db/convex/_generated/api";
import { getFunctionName } from "convex/server";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  setAuth: vi.fn(),
  createConvexMcpToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    action = mocks.action;
    setAuth = mocks.setAuth;
  },
}));
vi.mock("@/lib/mcp/convex-auth", () => ({
  createConvexMcpToken: mocks.createConvexMcpToken,
}));

import { setKithPool } from "@/lib/kith/pool";

import { POST as ingest } from "../../app/api/ingest/route";
import { POST as worker } from "../../app/api/worker/route";
import { authenticateApiKey } from "./auth";

/** A pool that records every checkout and refuses it. */
let connections = 0;
const poisonedPool = {
  connect() {
    connections += 1;
    return Promise.reject(new Error("the PostgreSQL surface was reached"));
  },
} as unknown as pg.Pool;

function bearerRequest(url: string) {
  return new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer synthetic-key" },
  });
}

const ROUTES = [
  ["/api/ingest", ingest, "https://example.test/api/ingest"],
  ["/api/worker", worker, "https://example.test/api/worker"],
] as const;

describe("the ingest and worker routes follow the surface flag", () => {
  let restorePool: () => void;

  beforeEach(() => {
    vi.resetAllMocks();
    connections = 0;
    restorePool = setKithPool(poisonedPool);
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    mocks.action.mockResolvedValue({ userId: "user-1", keyId: "key-1" });
    mocks.createConvexMcpToken.mockResolvedValue("signed-token");
  });

  afterEach(() => {
    restorePool();
    vi.unstubAllEnvs();
  });

  test.each(ROUTES)(
    "%s resolves the bearer on Convex under the convex surface",
    async (_name, handler, url) => {
      vi.stubEnv("KITH_POSTGRES_SURFACE", "convex");

      // Past 401 and stopped at the content type, which is far enough: the
      // question is which backend resolved the bearer.
      const response = await handler(bearerRequest(url));
      expect(response.status).toBe(415);

      expect(getFunctionName(mocks.action.mock.calls[0]![0])).toBe(
        getFunctionName(api.models.apiKeys.mcpAuth.authenticateKeyHash),
      );
      expect(connections).toBe(0);
    },
  );

  test.each(ROUTES)(
    "%s resolves the bearer on PostgreSQL under the postgres surface",
    async (_name, handler, url) => {
      vi.stubEnv("KITH_POSTGRES_SURFACE", "postgres");

      // The pool refuses, so the route reports the authentication backend as
      // unavailable. A 503 rather than a 401 is itself part of the contract:
      // an outage must not tell a client its credential is bad.
      const response = await handler(bearerRequest(url));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "authentication_unavailable",
          message: "Authentication service is unavailable",
        },
      });

      expect(connections).toBe(1);
      // Not "Convex was not asked to do the work": Convex was not asked
      // anything at all, including to resolve the bearer.
      expect(mocks.action).not.toHaveBeenCalled();
      expect(mocks.createConvexMcpToken).not.toHaveBeenCalled();
    },
  );

  test.each(ROUTES)(
    "%s refuses a bearer-less request on either surface without a backend call",
    async (_name, handler, url) => {
      for (const surface of ["convex", "postgres"] as const) {
        vi.stubEnv("KITH_POSTGRES_SURFACE", surface);
        const response = await handler(
          new Request(url, {
            method: "POST",
            headers: { authorization: "Basic c2VjcmV0" },
          }),
        );
        expect(response.status, surface).toBe(401);
        expect(response.headers.get("www-authenticate"), surface).toMatch(
          /^Bearer realm="/,
        );
      }
      expect(mocks.action).not.toHaveBeenCalled();
      expect(connections).toBe(0);
    },
  );

  test("there is one authenticator and it reads the flag", async () => {
    vi.stubEnv("KITH_POSTGRES_SURFACE", "convex");
    expect(await authenticateApiKey("Bearer synthetic-key")).toEqual({
      userId: "user-1",
      keyId: "key-1",
    });
    expect(connections).toBe(0);

    vi.stubEnv("KITH_POSTGRES_SURFACE", "postgres");
    await expect(authenticateApiKey("Bearer synthetic-key")).rejects.toThrow(
      "the PostgreSQL surface was reached",
    );
    expect(connections).toBe(1);

    // i2's flag-ignoring authenticator is gone rather than merely unused.
    const auth: Record<string, unknown> = await import("./auth");
    expect(Object.keys(auth)).not.toContain("authenticateApiKeyOnConvex");
  });
});
