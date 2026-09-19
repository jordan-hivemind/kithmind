// `PATCH` and `DELETE /api/kith/facts/:id`, against a real database.
//
// Same shape as `../../thoughts/[id]/route.test.ts`: an owner with a fact, a
// stranger who must not see or touch it, and a reader of the owner's own
// space who may read but not write. `PATCH` corrects the value (the old one
// stays in history); `DELETE` retires the fact (ends its validity without
// erasing it) -- both route through `writableFact`
// (`lib/kith/memory-write.ts`).

import { randomBytes } from "node:crypto";

import {
  applyKithSchema,
  createKithPool,
  memory,
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

import { DELETE, PATCH } from "./route";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");
const ORIGIN = "https://kith.example.test";

type Session = { userId: string; cookie: string; spaceId: string };

describeWithDatabase("/api/kith/facts/[id]", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;

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
        email: `ui-edit-fact-${randomBytes(4).toString("hex")}@example.test`,
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

  async function addReader(spaceId: string, userId: string): Promise<void> {
    await inTransaction((ctx) =>
      ctx.client.query(
        `INSERT INTO kith.space_members (id, space_id, user_id, role)
         SELECT $1, $2, $3, 'reader'`,
        [newKithId(), spaceId, userId],
      ),
    );
  }

  async function makeFact(session: Session, predicate: string, value: string): Promise<string> {
    const result = await inTransaction((ctx) =>
      memory.rememberFact(ctx, session.userId, session.spaceId, {
        subject: { kind: "person", name: "Rowan" },
        predicate,
        value: { type: "text", value },
        sourceType: "user_stated",
      }),
    );
    return result.factId;
  }

  async function getFact(id: string) {
    return await inTransaction((ctx) => memory.getStoredFact(ctx, id));
  }

  function request(path: string, cookie: string | null, method: string, body?: unknown): Request {
    const headers = new Headers({ "Content-Type": "application/json", origin: ORIGIN });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}/api/kith/facts${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function on(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  beforeAll(async () => {
    databaseName = `kith_ui_edit_facts_test_${randomBytes(8).toString("hex")}`;
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
  }, 60_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    delete process.env.KITH_SESSION_SECRET;
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  test("owner's edit defaults to changeKind 'changed': the old value stays in history, not erased", async () => {
    const owner = await signedInUser();
    const id = await makeFact(owner, "home_city", "Oakland");

    const response = await PATCH(
      request(`/${id}`, owner.cookie, "PATCH", { value: "Berkeley" }),
      on(id),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { factId: string; operation: string };
    expect(body.operation).toBe("superseded");
    expect(body.factId).not.toBe(id);

    const changed = await getFact(body.factId);
    expect(changed).toMatchObject({ status: "current", value: { type: "text", value: "Berkeley" } });

    // History preserved: the old row survives, reachable, with its original
    // value -- 'changed' means the old value was true once, not erased.
    const previous = await getFact(id);
    expect(previous).toMatchObject({
      status: "superseded",
      value: { type: "text", value: "Oakland" },
      supersededBy: body.factId,
    });
  });

  test("changeKind 'corrected' withholds the old value even from history, and validFrom passes through", async () => {
    const owner = await signedInUser();
    const id = await makeFact(owner, "home_city", "Oakland");
    const validFrom = Date.parse("2026-01-01T00:00:00.000Z");

    const response = await PATCH(
      request(`/${id}`, owner.cookie, "PATCH", {
        value: "Berkeley",
        changeKind: "corrected",
        validFrom,
      }),
      on(id),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { factId: string; operation: string };
    expect(body.operation).toBe("corrected");

    const corrected = await getFact(body.factId);
    expect(corrected).toMatchObject({
      status: "current",
      value: { type: "text", value: "Berkeley" },
      validFrom,
    });

    // The old value is retracted, not superseded, and withheld even from a
    // historical read (see the store test for that assertion); it still
    // survives on its own row, unerased.
    const previous = await getFact(id);
    expect(previous).toMatchObject({ status: "retracted", value: { type: "text", value: "Oakland" } });

    const invalid = await PATCH(
      request(`/${body.factId}`, owner.cookie, "PATCH", { value: "Elsewhere", changeKind: "sideways" }),
      on(body.factId),
    );
    expect(invalid.status).toBe(400);
  });

  test("owner may retire a fact: validity ends, nothing is erased", async () => {
    const owner = await signedInUser();
    const id = await makeFact(owner, "employer", "Acme");

    const response = await DELETE(request(`/${id}`, owner.cookie, "DELETE"), on(id));
    expect(response.status).toBe(204);

    const retired = await getFact(id);
    expect(retired).toMatchObject({ status: "current", value: { type: "text", value: "Acme" } });
    expect(retired!.validTo).toBeLessThanOrEqual(Date.now());
  });

  test("a reader may not edit or retire", async () => {
    const owner = await signedInUser();
    const reader = await signedInUser();
    await addReader(owner.spaceId, reader.userId);
    const id = await makeFact(owner, "home_city", "Read-only city");

    const edited = await PATCH(
      request(`/${id}`, reader.cookie, "PATCH", { value: "Somewhere else" }),
      on(id),
    );
    expect(edited.status).toBe(400);
    expect(await edited.json()).toMatchObject({ error: "Fact not found" });

    const retired = await DELETE(request(`/${id}`, reader.cookie, "DELETE"), on(id));
    expect(retired.status).toBe(400);
    expect(await retired.json()).toMatchObject({ error: "Fact not found" });

    const unchanged = await getFact(id);
    expect(unchanged).toMatchObject({
      status: "current",
      validTo: undefined,
      value: { type: "text", value: "Read-only city" },
    });
  });

  test("a fact in another space is invisible: the same denial as a missing id", async () => {
    const owner = await signedInUser();
    const stranger = await signedInUser();
    const id = await makeFact(owner, "home_city", "Not the stranger's fact");

    const edited = await PATCH(
      request(`/${id}`, stranger.cookie, "PATCH", { value: "Stolen" }),
      on(id),
    );
    expect(edited.status).toBe(400);
    const editedBody = await edited.json();
    expect(editedBody).toMatchObject({ error: "Fact not found" });

    const retired = await DELETE(request(`/${id}`, stranger.cookie, "DELETE"), on(id));
    expect(retired.status).toBe(400);
    expect(await retired.json()).toMatchObject({ error: "Fact not found" });

    const missing = await PATCH(
      request(`/${newKithId()}`, stranger.cookie, "PATCH", { value: "Stolen" }),
      on(newKithId()),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual(editedBody);

    const unchanged = await getFact(id);
    expect(unchanged).toMatchObject({
      status: "current",
      value: { type: "text", value: "Not the stranger's fact" },
    });
  });
});
