// `PATCH` and `DELETE /api/kith/thoughts/:id`, against a real database.
//
// Same shape as `investments/route.test.ts`: an owner with a thought, a
// stranger who must not see or touch it, and a reader of the owner's own
// space who may read but not write. `PATCH` and `DELETE` both route through
// `writableThought` (`lib/kith/memory-write.ts`), so the two write cases
// below cover both handlers with one setup each.

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

describeWithDatabase("/api/kith/thoughts/[id]", () => {
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
        email: `ui-edit-thought-${randomBytes(4).toString("hex")}@example.test`,
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

  async function makeThought(session: Session, content: string): Promise<string> {
    return await inTransaction((ctx) =>
      memory.captureThought(ctx, session.userId, session.spaceId, {
        content,
        metadata: {
          type: "reference",
          topics: ["synthetic"],
          people: [],
          actionItems: [],
          summary: content,
        },
      }),
    );
  }

  async function getThought(id: string) {
    return await inTransaction((ctx) => memory.getThoughtById(ctx, id));
  }

  function request(path: string, cookie: string | null, method: string, body?: unknown): Request {
    const headers = new Headers({ "Content-Type": "application/json", origin: ORIGIN });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}/api/kith/thoughts${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function on(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  const editBody = {
    content: "The archive lives on the new drive.",
    type: "reference",
    topics: ["archive"],
    people: [],
  };

  beforeAll(async () => {
    databaseName = `kith_ui_edit_thoughts_test_${randomBytes(8).toString("hex")}`;
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

  test("owner and editor may edit: the old content stays in history under the old id", async () => {
    const owner = await signedInUser();
    const id = await makeThought(owner, "The archive lives on the old drive.");

    const response = await PATCH(request(`/${id}`, owner.cookie, "PATCH", editBody), on(id));
    expect(response.status).toBe(200);
    const { thoughtId } = (await response.json()) as { thoughtId: string };
    expect(thoughtId).not.toBe(id);

    const edited = await getThought(thoughtId);
    expect(edited).toMatchObject({ content: editBody.content, memoryStatus: "current" });
    expect(edited!.metadata.topics).toEqual(["archive"]);

    // History preserved: the old row survives, superseded rather than gone,
    // with its original content intact.
    const previous = await getThought(id);
    expect(previous).toMatchObject({
      memoryStatus: "superseded",
      content: "The archive lives on the old drive.",
    });
  });

  test("content is bounded like a capture, and topics/people are capped rather than rejected", async () => {
    const owner = await signedInUser();
    const id = await makeThought(owner, "Bounded edit.");

    const tooLong = await PATCH(
      request(`/${id}`, owner.cookie, "PATCH", { ...editBody, content: "x".repeat(2_001) }),
      on(id),
    );
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({
      error: "Memory content must contain 1-2000 characters",
    });

    const empty = await PATCH(
      request(`/${id}`, owner.cookie, "PATCH", { ...editBody, content: "   " }),
      on(id),
    );
    expect(empty.status).toBe(400);

    // At the bound, and untouched by the edit: the row PATCH refused above
    // must not have changed anything.
    const unchanged = await getThought(id);
    expect(unchanged).toMatchObject({ memoryStatus: "current", content: "Bounded edit." });

    const capped = await PATCH(
      request(`/${id}`, owner.cookie, "PATCH", {
        ...editBody,
        content: "x".repeat(2_000),
        topics: ["a", "b", "c", "d", "e"],
        people: Array.from({ length: 15 }, (_, i) => `person-${i}`),
      }),
      on(id),
    );
    expect(capped.status).toBe(200);
    const { thoughtId } = (await capped.json()) as { thoughtId: string };
    const edited = await getThought(thoughtId);
    expect(edited!.content.length).toBe(2_000);
    expect(edited!.metadata.topics.length).toBe(3);
    expect(edited!.metadata.people.length).toBe(10);
  });

  test("owner may delete: the row survives, retracted, with its content preserved", async () => {
    const owner = await signedInUser();
    const id = await makeThought(owner, "A thought to be deleted.");

    const response = await DELETE(request(`/${id}`, owner.cookie, "DELETE"), on(id));
    expect(response.status).toBe(204);

    const deleted = await getThought(id);
    expect(deleted).toMatchObject({
      memoryStatus: "retracted",
      content: "A thought to be deleted.",
    });
  });

  test("a reader may not edit or delete", async () => {
    const owner = await signedInUser();
    const reader = await signedInUser();
    await addReader(owner.spaceId, reader.userId);
    const id = await makeThought(owner, "Read-only thought.");

    const edited = await PATCH(request(`/${id}`, reader.cookie, "PATCH", editBody), on(id));
    expect(edited.status).toBe(400);
    expect(await edited.json()).toMatchObject({ error: "Thought not found" });

    const deleted = await DELETE(request(`/${id}`, reader.cookie, "DELETE"), on(id));
    expect(deleted.status).toBe(400);
    expect(await deleted.json()).toMatchObject({ error: "Thought not found" });

    const unchanged = await getThought(id);
    expect(unchanged).toMatchObject({ memoryStatus: "current", content: "Read-only thought." });
  });

  test("a thought in another space is invisible: the same denial as a missing id", async () => {
    const owner = await signedInUser();
    const stranger = await signedInUser();
    const id = await makeThought(owner, "Not the stranger's thought.");

    const edited = await PATCH(request(`/${id}`, stranger.cookie, "PATCH", editBody), on(id));
    expect(edited.status).toBe(400);
    const editedBody = await edited.json();
    expect(editedBody).toMatchObject({ error: "Thought not found" });

    const deleted = await DELETE(request(`/${id}`, stranger.cookie, "DELETE"), on(id));
    expect(deleted.status).toBe(400);
    expect(await deleted.json()).toMatchObject({ error: "Thought not found" });

    const missing = await PATCH(
      request(`/${newKithId()}`, stranger.cookie, "PATCH", editBody),
      on(newKithId()),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual(editedBody);

    const unchanged = await getThought(id);
    expect(unchanged).toMatchObject({ memoryStatus: "current", content: "Not the stranger's thought." });
  });
});
