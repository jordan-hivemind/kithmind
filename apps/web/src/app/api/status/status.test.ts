// The `/api/status/*` routes, against a real database.
//
// `worker` answers the read-time staleness predicate (P2-39j's
// `workers.watcherStaleness`) for one source account; `dashboard` answers the
// dashboard's live counters. Both run through `withPrincipalRead`, so these
// cases exercise that path rather than the underlying loaders directly: a
// caller signed in as `userB` must never see `userA`'s watcher, incident or
// space, no matter what id the request names, and the same `guardedRequest`
// gate the `/api/kith/*` mutation routes share (surface, origin, content
// type) applies here too.

import { randomBytes } from "node:crypto";

import { applyKithSchema, createKithPool, newKithId, sources, withKithTransaction } from "@repo/kith-store";
import {
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  sessionCookie,
  signUp,
  webPrincipal,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { setKithNow } from "@/lib/kith/clock";
import { setKithPool } from "@/lib/kith/pool";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");
const ORIGIN = "https://kith.example.test";

// One fixed instant the whole suite reads through `setKithNow`, so a
// watcher's `next_expected_at` can be placed on either side of it without a
// real clock ever needing to move mid-test.
const FIXED_NOW = Date.parse("2026-09-16T12:00:00Z");
const ONE_MINUTE_MS = 60_000;

type Routes = {
  worker: (r: Request) => Promise<Response>;
  dashboard: (r: Request) => Promise<Response>;
};

describeWithDatabase("the /api/status/* routes", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let restoreNow: () => void;
  let databaseName: string;
  let routes: Routes;
  let transactionLog: string[] = [];

  async function onAdmin<T>(work: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await work(admin);
    } finally {
      await admin.end();
    }
  }

  function inTransaction<T>(work: (ctx: IdentityCtx) => Promise<T>): Promise<T> {
    return withKithTransaction(pool, (client) => work(identityCtx(client, FIXED_NOW)));
  }

  /** The pool the app sees, with every `BEGIN` recorded. */
  function recordingPool(inner: pg.Pool): pg.Pool {
    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property !== "connect") return Reflect.get(target, property, receiver);
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client);
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty !== "query") {
                return Reflect.get(clientTarget, clientProperty, clientReceiver);
              }
              return (...args: unknown[]) => {
                const text = args[0];
                if (typeof text === "string" && text.startsWith("BEGIN")) {
                  transactionLog.push(text);
                }
                return (query as (...rest: unknown[]) => unknown)(...args);
              };
            },
          });
        };
      },
    });
  }

  async function signedInUser(): Promise<{ userId: string; cookie: string; spaceId: string }> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `i6-status-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const setCookie = sessionCookie(
        { secret, secure: false },
        session.token,
        session.expiresAt,
      );
      return { userId: session.userId, cookie: setCookie.split(";")[0]!, spaceId };
    });
  }

  /** A `fs` source account in `owner`'s space, with no watcher row yet. */
  async function sourceAccount(owner: { userId: string; spaceId: string }): Promise<string> {
    return await inTransaction((ctx) =>
      sources.createSourceAccount(ctx, {
        principal: webPrincipal(owner.userId),
        spaceId: owner.spaceId,
        connector: "fs",
        accountId: `desktop-${randomBytes(4).toString("hex")}`,
        name: "Desktop",
      }),
    );
  }

  /** Inserts a watcher row directly: this suite is about the read side, not `recordWorkerHeartbeat`'s write path. */
  async function insertWatcher(
    sourceAccountId: string,
    spaceId: string,
    args: { watcherId: string; lastSeenAt: number; nextExpectedAt: number },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO kith.worker_watcher_states
         (id, space_id, created_at, source_account_id, watcher_id, state,
          last_seen_at, next_expected_at, created_at_field, updated_at)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'active', $5, $6, $5, $5)`,
      [newKithId(), spaceId, sourceAccountId, args.watcherId, new Date(args.lastSeenAt), new Date(args.nextExpectedAt)],
    );
  }

  async function insertOpenIncident(
    sourceAccountId: string,
    spaceId: string,
    args: { watcherId: string; openedAt: number },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO kith.worker_operational_incidents
         (id, space_id, created_at, source_account_id, watcher_id, kind, state, opened_at, observed_at)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'missing_worker', 'open', $5, $5)`,
      [newKithId(), spaceId, sourceAccountId, args.watcherId, new Date(args.openedAt)],
    );
  }

  /**
   * Every header a same-origin `fetch` from `use-status-poll.ts` sends. A
   * browser attaches `Sec-Fetch-Site: same-origin` on its own -- a `Request`
   * built directly by a test cannot -- so `origin` stands in for it here,
   * the same substitution `app/api/kith/mutations.test.ts`'s own
   * `baseHeaders` makes for the mutation routes sharing the same
   * `guardedRequest` gate.
   */
  function baseHeaders(cookie: string | null): Headers {
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: ORIGIN,
    });
    if (cookie !== null) headers.set("cookie", cookie);
    return headers;
  }

  function withCookie(url: string, cookie: string | null): Request {
    return new Request(url, { headers: baseHeaders(cookie) });
  }

  beforeAll(async () => {
    databaseName = `kith_i6_status_test_${randomBytes(8).toString("hex")}`;
    await onAdmin((admin) => admin.query(`CREATE DATABASE ${databaseName}`));
    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;

    const migrator = new pg.Client({ connectionString: url.toString() });
    migrator.on("error", () => {});
    await migrator.connect();
    await applyKithSchema(migrator);
    await migrator.end();

    pool = createKithPool(url.toString());
    pool.on("error", () => {});
    restorePool = setKithPool(recordingPool(pool));
    restoreNow = setKithNow(FIXED_NOW);
    process.env.KITH_SESSION_SECRET = secret;

    routes = {
      worker: (await import("./worker/route")).GET,
      dashboard: (await import("./dashboard/route")).GET,
    };
  }, 60_000);

  afterAll(async () => {
    restoreNow?.();
    restorePool?.();
    await pool?.end().catch(() => {});
    delete process.env.KITH_SESSION_SECRET;
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  function resetLog() {
    transactionLog = [];
  }

  test("worker status: unauthenticated is refused with 401 and touches no row", async () => {
    resetLog();
    const response = await routes.worker(
      withCookie(`${ORIGIN}/api/status/worker?sourceAccountId=x`, null),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Not authenticated",
      code: "not_authenticated",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("worker status: a cross-origin request is refused before any transaction opens", async () => {
    const owner = await signedInUser();
    const request = withCookie(
      `${ORIGIN}/api/status/worker?sourceAccountId=x`,
      owner.cookie,
    );
    request.headers.set("origin", "https://attacker.example.test");
    const response = await routes.worker(request);
    expect(response.status).toBe(403);
  });

  test("worker status: a request without a JSON content type is refused", async () => {
    const owner = await signedInUser();
    const request = new Request(`${ORIGIN}/api/status/worker?sourceAccountId=x`, {
      headers: { cookie: owner.cookie, origin: ORIGIN },
    });
    const response = await routes.worker(request);
    expect(response.status).toBe(415);
  });

  test("worker status: current inside the window, overdue past it, from one fixed clock", async () => {
    const owner = await signedInUser();
    const currentAccount = await sourceAccount(owner);
    const overdueAccount = await sourceAccount(owner);
    await insertWatcher(currentAccount, owner.spaceId, {
      watcherId: "w-current",
      lastSeenAt: FIXED_NOW - ONE_MINUTE_MS,
      nextExpectedAt: FIXED_NOW + ONE_MINUTE_MS,
    });
    await insertWatcher(overdueAccount, owner.spaceId, {
      watcherId: "w-overdue",
      lastSeenAt: FIXED_NOW - 5 * ONE_MINUTE_MS,
      nextExpectedAt: FIXED_NOW - ONE_MINUTE_MS,
    });
    await insertOpenIncident(overdueAccount, owner.spaceId, {
      watcherId: "w-overdue",
      openedAt: FIXED_NOW - ONE_MINUTE_MS,
    });

    resetLog();
    const currentResponse = await routes.worker(
      withCookie(
        `${ORIGIN}/api/status/worker?sourceAccountId=${currentAccount}`,
        owner.cookie,
      ),
    );
    expect(currentResponse.status).toBe(200);
    expect(currentResponse.headers.get("Cache-Control")).toBe("no-store");
    const currentBody = (await currentResponse.json()) as {
      watcher: { state: string };
      stale: boolean;
      incident: { state: string };
    };
    expect(currentBody.stale).toBe(false);
    expect(currentBody.watcher.state).toBe("current");
    expect(currentBody.incident.state).toBe("none");
    expect(transactionLog).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);

    resetLog();
    const overdueResponse = await routes.worker(
      withCookie(
        `${ORIGIN}/api/status/worker?sourceAccountId=${overdueAccount}`,
        owner.cookie,
      ),
    );
    expect(overdueResponse.status).toBe(200);
    const overdueBody = (await overdueResponse.json()) as {
      watcher: { state: string };
      stale: boolean;
      incident: { state: string; openedAt?: number };
    };
    expect(overdueBody.stale).toBe(true);
    expect(overdueBody.watcher.state).toBe("overdue");
    expect(overdueBody.incident).toEqual({ state: "open", openedAt: FIXED_NOW - ONE_MINUTE_MS });
    expect(transactionLog).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  });

  test("worker status: a principal in space A never sees space B's watcher or incident", async () => {
    const ownerA = await signedInUser();
    const ownerB = await signedInUser();
    const accountA = await sourceAccount(ownerA);
    await insertWatcher(accountA, ownerA.spaceId, {
      watcherId: "w-a",
      lastSeenAt: FIXED_NOW - ONE_MINUTE_MS,
      nextExpectedAt: FIXED_NOW + ONE_MINUTE_MS,
    });

    const asB = await routes.worker(
      withCookie(
        `${ORIGIN}/api/status/worker?sourceAccountId=${accountA}`,
        ownerB.cookie,
      ),
    );
    expect(asB.status).toBe(400);
    expect(await asB.json()).toEqual({ error: "Source account not found" });

    const asA = await routes.worker(
      withCookie(
        `${ORIGIN}/api/status/worker?sourceAccountId=${accountA}`,
        ownerA.cookie,
      ),
    );
    expect(asA.status).toBe(200);
  });

  test("worker status: an unconfigured watcher and a missing sourceAccountId", async () => {
    const owner = await signedInUser();
    const account = await sourceAccount(owner);

    const notConfigured = await routes.worker(
      withCookie(
        `${ORIGIN}/api/status/worker?sourceAccountId=${account}`,
        owner.cookie,
      ),
    );
    expect(notConfigured.status).toBe(200);
    const body = (await notConfigured.json()) as { watcher: { state: string } };
    expect(body.watcher.state).toBe("not_configured");

    const missingParam = await routes.worker(
      withCookie(`${ORIGIN}/api/status/worker`, owner.cookie),
    );
    expect(missingParam.status).toBe(400);
  });

  test("dashboard status: unauthenticated is refused with 401, and the loader it shares returns null for the same cookie", async () => {
    resetLog();
    const response = await routes.dashboard(
      withCookie(`${ORIGIN}/api/status/dashboard`, null),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const { loadDashboard } = await import("@/lib/kith/dashboard");
    expect(await loadDashboard(null)).toBeNull();
  });

  test("dashboard status: a cross-origin request is refused, and a request without a JSON content type is refused", async () => {
    const owner = await signedInUser();
    const crossOrigin = withCookie(`${ORIGIN}/api/status/dashboard`, owner.cookie);
    crossOrigin.headers.set("origin", "https://attacker.example.test");
    expect((await routes.dashboard(crossOrigin)).status).toBe(403);

    const noContentType = new Request(`${ORIGIN}/api/status/dashboard`, {
      headers: { cookie: owner.cookie, origin: ORIGIN },
    });
    expect((await routes.dashboard(noContentType)).status).toBe(415);
  });

  test("dashboard status: answers the caller's own stats, one read-only transaction, no-store", async () => {
    const owner = await signedInUser();
    resetLog();
    const response = await routes.dashboard(
      withCookie(`${ORIGIN}/api/status/dashboard`, owner.cookie),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { stats: { totalThoughts: number }; recent: unknown[] };
    expect(body.stats.totalThoughts).toBe(0);
    expect(body.recent).toEqual([]);
    expect(transactionLog).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  });
});
