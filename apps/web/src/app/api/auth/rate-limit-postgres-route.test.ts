// The sign-in and sign-up routes' rate limiting, spent from the durable
// `kith.auth_rate_limits` table.
//
// This is the whole of it since i7b: the in-process token bucket i1 shipped was
// only ever selected by the `convex` surface, so both routes now reach
// `checkAuthRateLimit`'s one branch.
//
// A throwaway database per run, matching `auth-routes.test.ts`'s own
// convention: this suite skips cleanly when `KITH_STORE_DATABASE_URL` is not
// set.

import { randomBytes } from "node:crypto";

import { applyKithSchema, createKithPool } from "@repo/kith-store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const secret = randomBytes(32).toString("hex");

/** A distinct account per case, so the per-account budget is never why a case
 * that means to test the per-address budget fails instead. */
let accounts = 0;
function account(): string {
  accounts += 1;
  return `owner-${accounts}-${randomBytes(4).toString("hex")}@example.test`;
}

/** A distinct address per case, deterministic so two cases never collide by
 * chance the way two random octets could. */
let addresses = 0;
function address(): string {
  addresses += 1;
  return `203.0.113.${addresses % 250}`;
}

function attempt(
  route: (request: Request) => Promise<Response>,
  path: string,
  address: string | null,
  email: string,
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (address !== null) headers.set("x-forwarded-for", address);
  return route(
    new Request(`https://brain.example.test${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password: "not the password" }),
    }),
  );
}

function signIn(address: string | null, email: string): Promise<Response> {
  return attempt(signInRoute, "/api/auth/sign-in", address, email);
}

function signUp(address: string | null, email: string): Promise<Response> {
  return attempt(signUpRoute, "/api/auth/sign-up", address, email);
}

let signInRoute: (request: Request) => Promise<Response>;
let signUpRoute: (request: Request) => Promise<Response>;

describeWithDatabase("the durable auth rate limiter", () => {
    let pool: pg.Pool;
    let restorePool: () => void;
    let databaseName: string;

    async function onAdmin<T>(
      work: (admin: pg.Client) => Promise<T>,
    ): Promise<T> {
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        return await work(admin);
      } finally {
        await admin.end();
      }
    }

    beforeAll(async () => {
      databaseName = `kith_web_ratelimit_test_${randomBytes(8).toString("hex")}`;
      await onAdmin((admin) => admin.query(`CREATE DATABASE ${databaseName}`));
      const url = new URL(adminUrl!);
      url.pathname = `/${databaseName}`;

      const migrator = new pg.Client({ connectionString: url.toString() });
      migrator.on("error", () => {});
      await migrator.connect();
      await applyKithSchema(migrator);
      await migrator.end();

      process.env.KITH_SESSION_SECRET = secret;
      pool = createKithPool(url.toString());
      pool.on("error", () => {});
      restorePool = setKithPool(pool);

      signInRoute = (await import("./sign-in/route")).POST;
      signUpRoute = (await import("./sign-up/route")).POST;
    }, 60_000);

    afterAll(async () => {
      restorePool?.();
      await pool?.end().catch(() => {});
      delete process.env.KITH_SESSION_SECRET;
      await onAdmin((admin) =>
        admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
      ).catch(() => {});
    }, 60_000);

    test("denies after the per-address budget, with a positive Retry-After", async () => {
      const clientAddress = address();
      let lastStatus = 0;
      // 30 is AUTH_RATE_LIMIT_ATTEMPTS_PER_ADDRESS; one distinct account per
      // attempt keeps the tighter per-account budget from being what refuses
      // first.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await signIn(clientAddress, account());
        lastStatus = response.status;
        expect(lastStatus).not.toBe(429);
      }
      const refused = await signIn(clientAddress, account());
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: "Too many attempts" });
      const retryAfter = Number(refused.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }, 30_000);

    test("two client addresses have independent budgets", async () => {
      const first = address();
      const second = address();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        expect((await signIn(first, account())).status).not.toBe(429);
      }
      expect((await signIn(first, account())).status).toBe(429);
      // A different address is unaffected by the first address's exhausted
      // budget.
      expect((await signIn(second, account())).status).not.toBe(429);
    }, 30_000);

    // The wiring fact: sign-up spends from the same budget as sign-in, so a
    // burst cannot sidestep the limit by changing which route it calls.
    test("sign-up spends from the same address budget as sign-in", async () => {
      const clientAddress = address();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        expect((await signIn(clientAddress, account())).status).not.toBe(429);
      }
      expect((await signUp(clientAddress, account())).status).toBe(429);
    }, 30_000);

    test("fails closed, with a 503 that names nothing, when the limiter's own transaction cannot run", async () => {
      const rejecting = new pg.Pool({
        connectionString: "postgres://nobody:nowhere@127.0.0.1:1/does-not-exist",
        max: 1,
      });
      rejecting.on("error", () => {});
      const restore = setKithPool(rejecting);
      try {
        const response = await signIn("192.0.2.99", account());
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "Service unavailable" });
        expect(response.headers.get("cache-control")).toBe("no-store");
      } finally {
        restore();
        await rejecting.end().catch(() => {});
      }
    }, 15_000);
});
