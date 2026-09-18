// Where `/api/ingest` and `/api/worker` resolve their bearer.
//
// This was `surface-routing.test.ts`, which proved each route followed
// `KITH_POSTGRES_SURFACE` for the credential and the work in the same request.
// i7b removed the flag and the Convex backend, so what is left to hold is the
// half that survived the cutover: both routes authenticate through the one
// `authenticateApiKey`, that authenticator reads PostgreSQL, and neither route
// does any work when it cannot.
//
// The proof is by exclusion. The process is given a pool that records every
// checkout and refuses it, so a route that reaches authentication is visible,
// and a route that answers without a checkout never authenticated. What each
// route then does with an authenticated request is asserted against a real
// database in `postgres-writes.test.ts`.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

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

describe("the ingest and worker routes authenticate against PostgreSQL", () => {
  let restorePool: () => void;

  beforeEach(() => {
    connections = 0;
    restorePool = setKithPool(poisonedPool);
  });

  afterEach(() => restorePool());

  test.each(ROUTES)(
    "%s resolves the bearer on PostgreSQL",
    async (_name, handler, url) => {
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
    },
  );

  test.each(ROUTES)(
    "%s refuses a bearer-less request without a backend call",
    async (_name, handler, url) => {
      const response = await handler(
        new Request(url, {
          method: "POST",
          headers: { authorization: "Basic c2VjcmV0" },
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(
        /^Bearer realm="/,
      );
      expect(connections).toBe(0);
    },
  );

  test("there is one authenticator and it reads PostgreSQL", async () => {
    await expect(authenticateApiKey("Bearer synthetic-key")).rejects.toThrow(
      "the PostgreSQL surface was reached",
    );
    expect(connections).toBe(1);

    // i2's flag-ignoring authenticator is gone rather than merely unused.
    const auth: Record<string, unknown> = await import("./auth");
    expect(Object.keys(auth)).not.toContain("authenticateApiKeyOnConvex");
  });
});
