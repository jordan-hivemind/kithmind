// The authentication routes actually apply the rate limit.
//
// Database-free on purpose. `lib/kith/rate-limit.test.ts` proves the bucket
// arithmetic against a fake clock; this proves the wiring, which is a separate
// fact and the one that would go missing if a route were added later and nobody
// remembered the limiter.
//
// It works without Postgres because of where the check sits in the route: after
// the body is parsed and before `kithSessionConfig()` and the transaction. With
// no `KITH_SESSION_SECRET` configured, a well-formed request that passes the
// limit reaches the configuration error and returns 500, and one that does not
// pass returns 429 without having tried. The difference between those two status
// codes is the assertion.
//
// This file gets its own module instance, and so its own module-scoped limiter,
// because vitest isolates per file. Nothing here may run in the same file as a
// test that needs the budget.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS } from "@/lib/kith/rate-limit";

import { POST as signIn } from "./sign-in/route";
import { POST as signUp } from "./sign-up/route";

// The attempts that get past the limiter reach a configuration error the route
// logs and does not return. Captured rather than printed, both to keep the run
// readable and so the last assertion can say that what was logged stayed in the
// log.
let logged: unknown[][] = [];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function attempt(
  handler: (request: Request) => Promise<Response>,
  address: string,
  account: string,
): Promise<Response> {
  return handler(
    new Request("https://brain.example.test/api/auth/sign-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": address,
      },
      body: JSON.stringify({ email: account, password: "not the password" }),
    }),
  );
}

describe("the authentication routes are rate limited", () => {
  test.each([
    ["sign-in", signIn, "203.0.113.10"],
    ["sign-up", signUp, "203.0.113.11"],
  ] as const)("%s refuses the attempt after the limit", async (
    _name,
    handler,
    address,
  ) => {
    const statuses: number[] = [];
    // One account per attempt, so the per-address limit is what is reached and
    // not the tighter per-account one.
    for (
      let attemptNumber = 0;
      attemptNumber <= AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS;
      attemptNumber += 1
    ) {
      const response = await attempt(
        handler,
        address,
        `a${attemptNumber}@example.test`,
      );
      statuses.push(response.status);
      if (attemptNumber === AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS) {
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({ error: "Too many attempts" });
        // A wait the client can act on, and nothing about which limit refused.
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(response.headers.get("cache-control")).toBe("no-store");
      } else {
        // Got past the limiter. What it reached after that depends on whether
        // this machine has a database configured -- 500 from the missing
        // configuration, or 401 from a wrong password -- and neither is this
        // test's business. Not being refused is.
        expect(response.status).not.toBe(429);
      }
    }
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);

    // A different address still has its own budget, so the limit is per key and
    // not a global switch that one attacker can flip for everyone.
    const other = await attempt(handler, "198.51.100.7", "b@example.test");
    expect(other.status).not.toBe(429);

    // Whatever went wrong behind the route stayed in the log. A `pg` error can
    // carry the connection string and a configuration error names a variable,
    // and neither may reach a response body.
    if (other.status === 500) {
      expect(await other.json()).toEqual({ error: "Server error" });
      expect(logged.length).toBeGreaterThan(0);
    }
  });
});
