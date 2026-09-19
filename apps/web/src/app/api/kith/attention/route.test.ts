// The attention queue routes, against a real database (ADM-8a).
//
// The gate-failure integration (a real `openCorrection` re-run) is proven at
// the store level, in `packages/kith-store/test/attention.test.mjs`; what
// matters here is who may reach these routes and that a write round trips
// through them the way it would through the UI: an owner with an item, a
// stranger who must not see or touch it, and a reader who may read the space
// but not the admin panel.

import { randomBytes } from "node:crypto";

import {
  applyKithSchema,
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

describeWithDatabase("/api/kith/attention", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let list: (request: Request) => Promise<Response>;
  let patch: (request: Request) => Promise<Response>;
  let del: (request: Request) => Promise<Response>;
  let listMutes: (request: Request) => Promise<Response>;
  let addMute: (request: Request) => Promise<Response>;
  let removeMute: (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  let count: (request: Request) => Promise<Response>;
  let counts: (request: Request) => Promise<Response>;

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
        email: `adm8a-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const setCookie = sessionCookie(
        { secret, secure: false },
        session.token,
        session.expiresAt,
      );
      return {
        cookie: setCookie.split(";")[0]!,
        spaceId,
        userId: session.userId,
      };
    });
  }

  function request(
    path: string,
    cookie: string | null,
    method = "GET",
    body?: unknown,
    base = "/api/kith/attention",
  ): Request {
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: ORIGIN,
    });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** One `kith.corrections` row, the shape a gate failure opens, seeded
   * directly: nothing in this build writes one through a route. */
  async function seedItem(spaceId: string, overrides: Record<string, unknown> = {}) {
    return inTransaction(async (ctx) => {
      const id = newKithId();
      const sourceItemId = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.source_items
           (id, space_id, created_at, title, worker_source_modified_at)
           VALUES ($1, $2, transaction_timestamp(), 'Synthetic receipt', $3)`,
        [sourceItemId, spaceId, overrides.workerSourceModifiedAt ?? null],
      );
      await ctx.client.query(
        `INSERT INTO kith.corrections
           (id, space_id, target_kind, target_id, field_name, reason, state,
            dedupe_key, severity)
         VALUES ($1,$2,'document',$3,'total','quote_not_found','open',$4,$5)`,
        [
          id,
          spaceId,
          sourceItemId,
          `extraction:${sourceItemId}:total:quote_not_found`,
          overrides.severity ?? "attention",
        ],
      );
      return id;
    });
  }

  async function itemsOf(session: Session, query = "") {
    const response = await list(request(query, session.cookie));
    expect(response.status).toBe(200);
    return (await response.json()) as {
      items: { id: string; state: string }[];
      counts: { attention: number; alert: number };
    };
  }

  beforeAll(async () => {
    databaseName = `kith_adm8a_attention_test_${randomBytes(8).toString("hex")}`;
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
    list = route.GET;
    patch = route.PATCH;
    del = route.DELETE;
    const mutes = await import("./mutes/route");
    listMutes = mutes.GET;
    addMute = mutes.POST;
    removeMute = (await import("./mutes/[id]/route")).DELETE;
    count = (await import("./count/route")).POST;
    counts = (await import("./counts/route")).GET;
  }, 60_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    delete process.env.KITH_SESSION_SECRET;
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  test("the shared gate applies: no session, cross-origin, wrong content type", async () => {
    expect((await list(request("", null))).status).toBe(401);

    const crossOrigin = new Request(`${ORIGIN}/api/kith/attention`, {
      headers: { "Content-Type": "application/json", origin: "https://elsewhere.test" },
    });
    expect((await list(crossOrigin)).status).toBe(403);

    const noContentType = new Request(`${ORIGIN}/api/kith/attention`, {
      headers: { origin: ORIGIN },
    });
    expect((await list(noContentType)).status).toBe(415);
  });

  test("the default view is open items of severity attention or alert", async () => {
    const owner = await signedInUser();
    const shown = await seedItem(owner.spaceId, { severity: "attention" });
    await seedItem(owner.spaceId, { severity: "info" });

    const { items, counts } = await itemsOf(owner);
    expect(items.map((item) => item.id)).toEqual([shown]);
    expect(counts).toEqual({ attention: 1, alert: 0 });

    // Info is one query param away, never counted in the badge.
    const withInfo = await itemsOf(owner, "?severity=info,attention,alert");
    expect(withInfo.items.length).toBe(2);
  });

  test("dismiss is permanent and DELETE-shaped, the way archive is", async () => {
    const owner = await signedInUser();
    const id = await seedItem(owner.spaceId);

    const response = await del(
      request("", owner.cookie, "DELETE", { action: "dismiss", id, reason: "duplicate" }),
    );
    expect(response.status).toBe(204);
    expect((await itemsOf(owner)).items).toEqual([]);

    const withDismissed = await itemsOf(owner, "?state=open,dismissed,snoozed");
    expect(withDismissed.items.map((item) => ({ id: item.id, state: item.state }))).toEqual([
      { id, state: "dismissed" },
    ]);

    // Undo brings it back to open.
    expect(
      (await patch(request("", owner.cookie, "PATCH", { action: "undo", id }))).status,
    ).toBe(204);
    expect((await itemsOf(owner)).items.map((item) => item.id)).toEqual([id]);
  });

  test("snooze hides an item from the default view", async () => {
    const owner = await signedInUser();
    const id = await seedItem(owner.spaceId);
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    expect(
      (
        await patch(
          request("", owner.cookie, "PATCH", { action: "snooze", id, until }),
        )
      ).status,
    ).toBe(204);
    expect((await itemsOf(owner)).items).toEqual([]);
  });

  test("bulk dismiss by id touches only the ids named", async () => {
    const owner = await signedInUser();
    const keep = await seedItem(owner.spaceId);
    const gone = await seedItem(owner.spaceId);

    const response = await del(
      request("", owner.cookie, "DELETE", {
        action: "dismissBulk",
        spaceId: owner.spaceId,
        filter: { kind: "ids", ids: [gone] },
        reason: "not_worth_backfilling",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 1 });
    expect((await itemsOf(owner)).items.map((item) => item.id)).toEqual([keep]);
  });

  test("a mute round trips and stops counting toward nothing it hasn't already opened", async () => {
    const owner = await signedInUser();
    const add = await addMute(
      request("", owner.cookie, "POST", {
        spaceId: owner.spaceId,
        scopeKind: "detector",
        scopeValue: "extraction",
      }, "/api/kith/attention/mutes"),
    );
    expect(add.status).toBe(201);
    const { id } = (await add.json()) as { id: string };

    const listed = await listMutes(request("", owner.cookie, "GET", undefined, "/api/kith/attention/mutes"));
    expect(listed.status).toBe(200);
    const { mutes } = (await listed.json()) as { mutes: { id: string; scopeValue: string }[] };
    expect(mutes.map((mute) => mute.scopeValue)).toEqual(["extraction"]);

    const removed = await removeMute(
      request("", owner.cookie, "DELETE", undefined, `/api/kith/attention/mutes/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(removed.status).toBe(204);
    expect(
      ((await (
        await listMutes(request("", owner.cookie, "GET", undefined, "/api/kith/attention/mutes"))
      ).json()) as { mutes: unknown[] }).mutes,
    ).toEqual([]);
  });

  test("another space's item is invisible and a reader may read but not write", async () => {
    const owner = await signedInUser();
    const stranger = await signedInUser();
    const id = await seedItem(owner.spaceId);

    expect((await itemsOf(stranger)).items).toEqual([]);
    const strangerWrite = await del(
      request("", stranger.cookie, "DELETE", { action: "dismiss", id, reason: "other" }),
    );
    expect(strangerWrite.status).toBe(400);
    expect(((await strangerWrite.json()) as { error: string }).error).toBe(
      "Attention item not found",
    );

    const reader = await signedInUser();
    await inTransaction(async (ctx) => {
      await ctx.client.query(
        `INSERT INTO kith.space_members (id, space_id, user_id, role)
           VALUES ($1, $2, $3, 'reader')`,
        [newKithId(), owner.spaceId, reader.userId],
      );
    });
    // The admin read resolves through `getAdminSpaceIds`, so a reader's own
    // space contributes nothing to the list even though they may read it.
    expect((await itemsOf(reader)).items).toEqual([]);
    const readerWrite = await del(
      request("", reader.cookie, "DELETE", { action: "dismiss", id, reason: "other" }),
    );
    expect(readerWrite.status).toBe(400);

    // Nothing was touched by any of it.
    expect((await itemsOf(owner)).items.map((item) => item.id)).toEqual([id]);
  });

  test("the before-date preview count matches the document's own date, not when the row opened", async () => {
    const owner = await signedInUser();
    await seedItem(owner.spaceId, { workerSourceModifiedAt: "2020-01-01T00:00:00Z" });
    await seedItem(owner.spaceId, { workerSourceModifiedAt: "2026-09-01T00:00:00Z" });
    // No date at all (neither an extraction nor a provider-reported modified
    // time): never matched, whatever the cutoff.
    await seedItem(owner.spaceId);

    const response = await count(
      request(
        "",
        owner.cookie,
        "POST",
        { spaceId: owner.spaceId, filter: { kind: "beforeDate", beforeDate: "2025-01-01" } },
        "/api/kith/attention/count",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 1 });

    // The preview never touches anything: all three are still open.
    const items = (await itemsOf(owner)).items;
    expect(items.length).toBe(3);
    expect(items.every((item) => item.state === "open")).toBe(true);
  });

  test("the nav badge's counts route matches attentionSeverityCounts and excludes info", async () => {
    const owner = await signedInUser();
    await seedItem(owner.spaceId, { severity: "attention" });
    await seedItem(owner.spaceId, { severity: "info" });

    const response = await counts(request("", owner.cookie, "GET", undefined, "/api/kith/attention/counts"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attention: 1, alert: 0 });
  });
});
