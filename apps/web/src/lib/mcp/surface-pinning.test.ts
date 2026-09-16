// The two routes that must not follow the surface flag yet.
//
// Finding 2 of the second-model review of P2-39i2. `/api/ingest` and
// `/api/worker` do all of their work through Convex until row i4 ports them. If
// they authenticated through whichever backend the flag names, then under
// `postgres` they would resolve a bearer against `kith.api_keys` and then act on
// Convex data on the strength of it: a credential one backend never checked
// authorizing work in that backend, which is the cross-surface mix `server.ts`
// refuses for the same reason.
//
// So both routes call `authenticateApiKeyOnConvex`, which does not read the
// flag. These cases prove it by setting the flag to `postgres` and giving the
// process a pool that throws if anything so much as checks out a connection.

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
import { authenticateApiKey, authenticateApiKeyOnConvex } from "./auth";

/** A pool that fails the test if the PostgreSQL path is taken at all. */
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

describe("routes pinned to Convex until i4", () => {
  let restorePool: () => void;

  beforeEach(() => {
    vi.resetAllMocks();
    connections = 0;
    restorePool = setKithPool(poisonedPool);
    vi.stubEnv("KITH_POSTGRES_SURFACE", "postgres");
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    mocks.action.mockResolvedValue({ userId: "user-1", keyId: "key-1" });
    mocks.createConvexMcpToken.mockResolvedValue("signed-token");
  });

  afterEach(() => {
    restorePool();
    vi.unstubAllEnvs();
  });

  test.each([
    ["/api/ingest", ingest, "https://example.test/api/ingest"],
    ["/api/worker", worker, "https://example.test/api/worker"],
  ])(
    "%s authenticates through Convex under the postgres surface",
    async (_name, handler, url) => {
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

  test("the Convex authenticator ignores the flag and the MCP one does not", async () => {
    expect(await authenticateApiKeyOnConvex("Bearer synthetic-key")).toEqual({
      userId: "user-1",
      keyId: "key-1",
    });
    expect(connections).toBe(0);

    // The same header through the flag-following authenticator does reach
    // PostgreSQL, which is what the two routes above must not do yet.
    await expect(authenticateApiKey("Bearer synthetic-key")).rejects.toThrow(
      "the PostgreSQL surface was reached",
    );
    expect(connections).toBe(1);
  });

  test("both authenticators still refuse a bearer-less request without a backend call", async () => {
    expect(await authenticateApiKeyOnConvex(null)).toBeNull();
    expect(await authenticateApiKeyOnConvex("Basic c2VjcmV0")).toBeNull();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(connections).toBe(0);
  });
});
