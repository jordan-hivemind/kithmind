import { randomBytes } from "node:crypto";

import {
  applyKithSchema,
  coverage,
  createKithPool,
  newKithId,
  withKithTransaction,
} from "@repo/kith-store";
import {
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  sessionCookie,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;
const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");
const ORIGIN = "https://kith.example.test";

type Session = { cookie: string; spaceId: string; userId: string };

describeWithDatabase("/api/kith/coverage-gaps", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let get: (request: Request) => Promise<Response>;
  let patch: (request: Request) => Promise<Response>;

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

  async function signedInUser(): Promise<Session> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `coverage-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      return {
        userId: session.userId,
        spaceId,
        cookie: sessionCookie(
          { secret, secure: false },
          session.token,
          session.expiresAt,
        ).split(";")[0]!,
      };
    });
  }

  async function seedGap(owner: Session): Promise<string> {
    return await inTransaction(async (ctx) => {
      const sourceAccountId = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.source_accounts
           (id,space_id,created_at,name,connector,account_id,enabled,freshness_ms)
         VALUES($1,$2,transaction_timestamp(),'Synthetic archive','filesystem',
                'synthetic-account',true,86400000)`,
        [sourceAccountId, owner.spaceId],
      );
      await coverage.upsertCoverageWindow(ctx, {
        spaceId: owner.spaceId,
        sourceAccountId,
        recordType: "statement",
        from: Date.UTC(2025, 0, 1),
        to: Date.UTC(2025, 2, 1),
        state: "complete",
        lastEnumeratedAt: Date.UTC(2025, 5, 2),
        lastProcessedAt: Date.UTC(2025, 5, 2),
        discoveredCount: 2,
        indexedCount: 2,
        skippedCount: 0,
      });
      return await coverage.openCoverageGap(ctx, {
        spaceId: owner.spaceId,
        sourceAccountId,
        recordType: "statement",
        from: Date.UTC(2025, 2, 1),
        to: Date.UTC(2025, 5, 1),
        reason: "missing_statement",
        detectedAt: Date.UTC(2025, 5, 3),
      });
    });
  }

  function request(
    cookie: string | null,
    method = "GET",
    body?: unknown,
  ): Request {
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: ORIGIN,
    });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}/api/kith/coverage-gaps`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  beforeAll(async () => {
    databaseName = `kith_coverage_gaps_${randomBytes(8).toString("hex")}`;
    await onAdmin((admin) => admin.query(`CREATE DATABASE ${databaseName}`));
    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;
    const migrator = new pg.Client({ connectionString: url.toString() });
    migrator.on("error", () => {});
    await migrator.connect();
    await applyKithSchema(migrator);
    await migrator.end();
    pool = createKithPool(url.toString(), 5);
    pool.on("error", () => {});
    restorePool = setKithPool(pool);
    process.env.KITH_SESSION_SECRET = secret;
    const route = await import("./route");
    get = route.GET;
    patch = route.PATCH;
  }, 60_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    delete process.env.KITH_SESSION_SECRET;
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  test("owner can inspect and acknowledge while reader and stranger cannot", async () => {
    const owner = await signedInUser();
    const reader = await signedInUser();
    const stranger = await signedInUser();
    await pool.query(
      "INSERT INTO kith.space_members(id,space_id,user_id,role) VALUES($1,$2,$3,'reader')",
      [newKithId(), owner.spaceId, reader.userId],
    );
    const gapId = await seedGap(owner);

    const ownerRead = await get(request(owner.cookie));
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.json()).toMatchObject({
      items: [
        {
          id: gapId,
          sourceName: "Synthetic archive",
          accountId: "synthetic-account",
          reason: "missing_statement",
        },
      ],
      overflow: false,
    });
    expect((await (await get(request(reader.cookie))).json()).items).toEqual([]);
    expect((await (await get(request(stranger.cookie))).json()).items).toEqual([]);

    for (const session of [reader, stranger]) {
      const denied = await patch(
        request(session.cookie, "PATCH", {
          id: gapId,
          action: "mark_unavailable",
        }),
      );
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({
        error: "Coverage gap not found",
      });
    }

    const acknowledged = await patch(
      request(owner.cookie, "PATCH", {
        id: gapId,
        action: "mark_not_expected",
        note: "Synthetic account starts later",
      }),
    );
    expect(acknowledged.status).toBe(204);
    const audit = await pool.query(
      `SELECT g.status,a.actor_user_id,a.action,a.note
         FROM kith.coverage_gaps g
         JOIN kith.coverage_gap_actions a ON a.coverage_gap_id=g.id
        WHERE g.id=$1`,
      [gapId],
    );
    expect(audit.rows).toEqual([
      {
        status: "resolved",
        actor_user_id: owner.userId,
        action: "mark_not_expected",
        note: "Synthetic account starts later",
      },
    ]);
    expect((await (await get(request(owner.cookie))).json()).items).toEqual([]);
  });

  test("the shared route gate and input schema reject invalid requests", async () => {
    expect((await get(request(null))).status).toBe(401);
    const invalid = await patch(
      request((await signedInUser()).cookie, "PATCH", {
        id: "gap",
        action: "hide",
      }),
    );
    expect(invalid.status).toBe(400);
  });
});
