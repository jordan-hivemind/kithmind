// The i5 page loaders on PostgreSQL, against a real database.
//
// One synthetic two-user fixture: `userA` is a member only of their own
// personal space and a shared space they own; `userB` is a member only of
// their own personal space. Every loader is checked for three things:
//
//   * Unauthenticated. A missing or forged cookie returns `null`, which is
//     what each page turns into a redirect to `/sign-in`.
//   * Space isolation. `userA`'s session never sees a row from `userB`'s
//     space, and a `?space=` naming a space `userA` does not belong to falls
//     back rather than leaking `userB`'s membership detail.
//   * One transaction. Every loader call opens exactly one
//     `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, recorded the same
//     way `lib/mcp/postgres-reads.test.ts` records it.

import { randomBytes } from "node:crypto";

import {
  applyKithSchema,
  createKithPool,
  memory,
  newKithId,
  withKithTransaction,
} from "@repo/kith-store";
import {
  createSharedSpace,
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  sessionCookie,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");

type Fixture = {
  userA: { userId: string; cookie: string; spaceId: string; sharedSpaceId: string };
  userB: { userId: string; cookie: string; spaceId: string };
  /** A `reader` member of userA's shared space, for the ADM-2 admin loaders. */
  readerC: { userId: string; cookie: string; spaceId: string };
};

describeWithDatabase("i5 page loaders on PostgreSQL", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let fixture: Fixture;
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
    return withKithTransaction(pool, (client) => work(identityCtx(client)));
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

  function metadata(
    summary: string,
    type: memory.ThoughtType,
    topics: string[] = [],
  ): memory.ThoughtMetadata {
    return { type, topics, people: [], actionItems: [], summary };
  }

  async function signedInUser(): Promise<{
    userId: string;
    cookie: string;
    spaceId: string;
  }> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `i5-page-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const setCookie = sessionCookie(
        { secret, secure: false },
        session.token,
        session.expiresAt,
      );
      return {
        userId: session.userId,
        cookie: setCookie.split(";")[0]!,
        spaceId,
      };
    });
  }

  beforeAll(async () => {
    databaseName = `kith_i5_pages_test_${randomBytes(8).toString("hex")}`;
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

    vi.stubEnv("KITH_SESSION_SECRET", secret);
    process.env.KITH_SESSION_SECRET = secret;

    const userA = await signedInUser();
    const userB = await signedInUser();
    const shared = await inTransaction((ctx) =>
      createSharedSpace(ctx, { userId: userA.userId, name: "A's shared space" }),
    );

    await inTransaction(async (ctx) => {
      await memory.captureThought(ctx, userA.userId, userA.spaceId, {
        content: "userA's personal thought, only visible to userA.",
        metadata: metadata("A's note", "idea", ["a-only"]),
        sourceType: "user_stated",
      });
      await memory.rememberFact(ctx, userA.userId, userA.spaceId, {
        subject: { kind: "person", name: "Alex" },
        predicate: "home_city",
        value: { type: "text", value: "Oakland" },
        sourceType: "user_stated",
      });
      await memory.captureThought(ctx, userB.userId, userB.spaceId, {
        content: "userB's personal thought, must never appear for userA.",
        metadata: metadata("B's note", "idea", ["b-only"]),
        sourceType: "user_stated",
      });
      await memory.rememberFact(ctx, userB.userId, userB.spaceId, {
        subject: { kind: "person", name: "Blair" },
        predicate: "home_city",
        value: { type: "text", value: "Berkeley" },
        sourceType: "user_stated",
      });
    });

    // ADM-2: a member of userA's shared space who may only read it. The
    // admin loaders must show them nothing at all, which is what the panel's
    // layout turns into a 404.
    const readerC = await signedInUser();
    await inTransaction((ctx) =>
      ctx.client.query(
        `INSERT INTO kith.space_members (id, space_id, user_id, role)
         VALUES ($1, $2, $3, 'reader')`,
        [newKithId(), shared.spaceId, readerC.userId],
      ),
    );

    fixture = {
      userA: { ...userA, sharedSpaceId: shared.spaceId },
      userB,
      readerC,
    };
  }, 120_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  function resetLog() {
    transactionLog = [];
  }

  test("loadDashboard denies an unauthenticated request without touching a row", async () => {
    resetLog();
    const { loadDashboard } = await import("./dashboard");
    expect(await loadDashboard(null)).toBeNull();
    expect(await loadDashboard("__Host-kith_session=v1.bad.bad")).toBeNull();
  });

  test("loadDashboard scopes stats and recent thoughts to the caller's own space, in one read-only transaction", async () => {
    resetLog();
    const { loadDashboard } = await import("./dashboard");
    const data = await loadDashboard(fixture.userA.cookie);
    expect(data).not.toBeNull();
    expect(data!.stats.totalThoughts).toBe(1);
    expect(data!.stats.totalFacts).toBe(1);
    expect(data!.recent.map((thought) => thought.content)).toEqual([
      "userA's personal thought, only visible to userA.",
    ]);
    expect(
      data!.recent.some((thought) => thought.content.includes("userB")),
    ).toBe(false);
    expect(transactionLog).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  });

  test("loadBrowse: facts and thoughts are both scoped to the caller's space", async () => {
    resetLog();
    const { loadBrowse } = await import("./browse");
    const facts = await loadBrowse(fixture.userA.cookie, {
      view: "facts",
      includeHistorical: false,
    });
    expect(facts).not.toBeNull();
    if (facts?.view !== "facts") throw new Error("expected facts view");
    expect(facts.facts.map((fact) => fact.subject.name)).toEqual(["Alex"]);

    resetLog();
    const thoughts = await loadBrowse(fixture.userA.cookie, {
      view: "thoughts",
      includeHistorical: false,
    });
    if (thoughts?.view !== "thoughts") throw new Error("expected thoughts view");
    expect(thoughts.thoughts.map((t) => t.content)).toEqual([
      "userA's personal thought, only visible to userA.",
    ]);
    expect(transactionLog).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  });

  test("loadBrowse denies an unauthenticated request", async () => {
    const { loadBrowse } = await import("./browse");
    expect(
      await loadBrowse(null, { view: "facts", includeHistorical: false }),
    ).toBeNull();
  });

  test("POST /api/kith/thoughts/search keeps the query out of the URL and scopes results to the caller's space", async () => {
    resetLog();
    const { POST } = await import("../../app/api/kith/thoughts/search/route");
    const response = await POST(
      new Request("https://kith.example.test/api/kith/thoughts/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://kith.example.test",
          cookie: fixture.userA.cookie,
        },
        body: JSON.stringify({ query: "personal thought" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thoughts: Array<{ content: string }>;
      vectorStatus: "ready" | "unavailable";
    };
    expect(body.thoughts.map((t) => t.content)).toEqual([
      "userA's personal thought, only visible to userA.",
    ]);
    // No injected `embedQuery`, so the vector leg never runs -- see
    // `lib/kith/browse.ts`'s module comment.
    expect(body.vectorStatus).toBe("unavailable");
    expect(transactionLog).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  });

  test("loadSettings lists only the caller's own spaces and source accounts, in one transaction", async () => {
    resetLog();
    const { loadSettings } = await import("./settings-data");
    const data = await loadSettings(fixture.userA.cookie);
    expect(data).not.toBeNull();
    const spaceIds = data!.spaces.map((space) => space.spaceId);
    expect(spaceIds).toContain(fixture.userA.spaceId);
    expect(spaceIds).toContain(fixture.userA.sharedSpaceId);
    expect(spaceIds).not.toContain(fixture.userB.spaceId);
    expect(data!.apiKeys.page).toEqual([]);
    expect(transactionLog).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  });

  test("loadSettings denies an unauthenticated request", async () => {
    const { loadSettings } = await import("./settings-data");
    expect(await loadSettings(null)).toBeNull();
  });

  test("loadFamilyOverview lists the caller's spaces and, for a shared space they own, its detail", async () => {
    resetLog();
    const { loadFamilyOverview } = await import("./family-data");
    const data = await loadFamilyOverview(
      fixture.userA.cookie,
      fixture.userA.sharedSpaceId,
    );
    expect(data).not.toBeNull();
    expect(data!.spaces.map((space) => space.spaceId)).toContain(
      fixture.userA.sharedSpaceId,
    );
    expect(data!.selected?.space.spaceId).toBe(fixture.userA.sharedSpaceId);
    expect(data!.selected?.viewer.role).toBe("owner");
    expect(transactionLog).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  });

  test("loadFamilyOverview never returns another user's space detail", async () => {
    resetLog();
    const { loadFamilyOverview } = await import("./family-data");
    // userB does not belong to userA's shared space; naming it falls back to
    // no detail rather than leaking who owns it or who its members are.
    const data = await loadFamilyOverview(
      fixture.userB.cookie,
      fixture.userA.sharedSpaceId,
    );
    expect(data).not.toBeNull();
    expect(data!.spaces.map((space) => space.spaceId)).not.toContain(
      fixture.userA.sharedSpaceId,
    );
    expect(data!.selected).toBeNull();
  });

  test("loadFamilyOverview denies an unauthenticated request", async () => {
    const { loadFamilyOverview } = await import("./family-data");
    expect(await loadFamilyOverview(null, undefined)).toBeNull();
  });

  // --- ADM-2: the health, institutions and coverage loaders ----------------

  test("loadHealth reports every check, with no archive configured saying so", async () => {
    resetLog();
    const { loadHealth } = await import("./admin-data");
    const data = await loadHealth(fixture.userA.cookie);
    expect(data).not.toBeNull();
    const byId = new Map(data!.checks.map((check) => [check.id, check]));
    expect([...byId.keys()]).toEqual([
      "documents_watcher",
      "search_index",
      "background_jobs",
      "review_queue",
      "finance_archive",
      "database_backup",
    ]);
    // No source account in the fixture, so nothing is being watched, and that
    // is `not_configured` rather than a failure.
    expect(byId.get("documents_watcher")!.status).toBe("not_configured");
    // No FINANCE_ARCHIVE_* environment in this suite: an unconfigured archive
    // must never read as an empty one.
    expect(byId.get("finance_archive")!.status).toBe("not_configured");
    expect(byId.get("finance_archive")!.detail).toBe("not configured");
    // The backup lives on the owner's machine; the row exists and reports no
    // data rather than claiming the backup is fine.
    expect(byId.get("database_backup")!.status).toBe("unknown");
    expect(transactionLog).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ]);
  });

  test("loadCoverage lists every life area, all empty, in one read-only transaction", async () => {
    resetLog();
    const { loadCoverage } = await import("./admin-data");
    const data = await loadCoverage(fixture.userA.cookie);
    expect(data).not.toBeNull();
    expect(data!.areas.map((area) => area.area)).toContain("taxes");
    // userA has a thought and a fact, so memory is the one area with anything.
    const memoryArea = data!.areas.find(
      (area) => area.area === "notes and facts",
    );
    expect(memoryArea!.records).toBe(2);
    expect(memoryArea!.status).toBe("covered");
    expect(
      data!.areas.filter((area) => area.area !== "notes and facts").every(
        (area) => area.status === "empty",
      ),
    ).toBe(true);
    expect(transactionLog).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ]);
  });

  test("another space's memory never reaches the caller's coverage", async () => {
    const { loadCoverage } = await import("./admin-data");
    // userB has exactly one thought and one fact of their own, and userA has
    // exactly one of each. Neither sees three.
    const forA = await loadCoverage(fixture.userA.cookie);
    const forB = await loadCoverage(fixture.userB.cookie);
    const memoryOf = (data: Awaited<ReturnType<typeof loadCoverage>>) =>
      data!.areas.find((area) => area.area === "notes and facts")!.records;
    expect(memoryOf(forA)).toBe(2);
    expect(memoryOf(forB)).toBe(2);
  });

  test("a reader-role member administers nothing, so every admin loader is empty", async () => {
    const { loadCoverage, loadHealth, loadInstitutions } = await import(
      "./admin-data"
    );
    const health = await loadHealth(fixture.readerC.cookie);
    expect(
      health!.checks.find((check) => check.id === "documents_watcher")!.status,
    ).toBe("not_configured");
    expect(
      health!.checks.find((check) => check.id === "search_index")!.detail,
    ).toBe("nothing eligible");

    const coverage = await loadCoverage(fixture.readerC.cookie);
    // The reader has a personal space of their own, which they own, so their
    // own memory is theirs to see; what they must never see is userA's shared
    // space, which they only read.
    expect(
      coverage!.areas.every(
        (area) => area.documents === 0 && area.sources === 0,
      ),
    ).toBe(true);

    const institutions = await loadInstitutions(fixture.readerC.cookie);
    expect(institutions!.institutions).toEqual([]);
    expect(institutions!.state).toBe("not_configured");
  });

  test("the admin loaders deny an unauthenticated request", async () => {
    const { loadCoverage, loadHealth, loadInstitutions } = await import(
      "./admin-data"
    );
    expect(await loadHealth(null)).toBeNull();
    expect(await loadInstitutions(null)).toBeNull();
    expect(await loadCoverage(null)).toBeNull();
    expect(await loadHealth("__Host-kith_session=v1.bad.bad")).toBeNull();
  });
});
