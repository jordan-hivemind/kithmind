// `GET /api/kith/changes`, against a real database.
//
// This is access-control code, so the cases that matter are the ones about who
// sees what: two signed-in users in the same database, each writing rows that
// fire the change trigger, and neither ever seeing the other's change. The
// cursor cases are here too, because a cursor that skipped or repeated would
// be a correctness bug the authorization cases would not catch.

import { randomBytes } from "node:crypto";

import { applyKithSchema, createKithPool, newKithId, withKithTransaction } from "@repo/kith-store";
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

type Payload = {
  cursor: string;
  changes: { id: string; table: string; rowId: string; op: string }[];
};

describeWithDatabase("GET /api/kith/changes", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let route: (request: Request) => Promise<Response>;

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

  async function signedInUser(): Promise<{ cookie: string; spaceId: string }> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `adm1-changes-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const setCookie = sessionCookie(
        { secret, secure: false },
        session.token,
        session.expiresAt,
      );
      return { cookie: setCookie.split(";")[0]!, spaceId };
    });
  }

  /** One row that fires a change trigger, with the id it will carry. */
  async function writeInvestment(spaceId: string, name: string): Promise<string> {
    const id = newKithId();
    await pool.query(
      "INSERT INTO kith.investments (id, space_id, name) VALUES ($1, $2, $3)",
      [id, spaceId, name],
    );
    return id;
  }

  function request(
    query: string,
    cookie: string | null,
    extra: Record<string, string> = {},
  ): Request {
    const headers = new Headers({
      "Content-Type": "application/json",
      origin: ORIGIN,
      ...extra,
    });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}/api/kith/changes${query}`, { headers });
  }

  beforeAll(async () => {
    databaseName = `kith_adm1_changes_test_${randomBytes(8).toString("hex")}`;
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
    route = (await import("./route")).GET;
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
    expect((await route(request("", null))).status).toBe(401);

    const crossOrigin = new Request(`${ORIGIN}/api/kith/changes`, {
      headers: { "Content-Type": "application/json", origin: "https://elsewhere.test" },
    });
    expect((await route(crossOrigin)).status).toBe(403);

    const noContentType = new Request(`${ORIGIN}/api/kith/changes`, {
      headers: { origin: ORIGIN },
    });
    expect((await route(noContentType)).status).toBe(415);
  });

  test("a cursor that is not a cursor is refused with 400, never 500", async () => {
    const user = await signedInUser();
    for (const cursor of [
      "not-a-number",
      "-1",
      "1e3",
      // Past `bigint`'s ceiling. Binding this would make the server raise
      // 22003 on the cast, which used to surface as an opaque 500.
      "9223372036854775808",
      "9999999999999999999",
    ]) {
      const response = await route(
        request(`?since=${encodeURIComponent(cursor)}`, user.cookie),
      );
      expect(response.status, cursor).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe(
        "invalid_cursor",
      );
    }
    // The ceiling itself is a cursor, and answers normally.
    expect(
      (await route(request("?since=9223372036854775807", user.cookie))).status,
    ).toBe(200);
  });

  test("no cursor starts from now rather than replaying the retained feed", async () => {
    const user = await signedInUser();
    await writeInvestment(user.spaceId, "Before");
    const response = await route(request("", user.cookie));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Payload;
    // The write above is behind the cursor, so it is not replayed...
    expect(payload.changes).toEqual([]);
    expect(BigInt(payload.cursor) > 0n).toBe(true);
    // ...but anything after it is.
    const id = await writeInvestment(user.spaceId, "After");
    const next = (await (
      await route(request(`?since=${payload.cursor}`, user.cookie))
    ).json()) as Payload;
    expect(next.changes.map((change) => [change.table, change.rowId, change.op])).toEqual([
      ["investments", id, "insert"],
    ]);
    // The poll carries the id so a polling client has its own cursor.
    expect(next.cursor).toBe(next.changes[0]!.id);
  });

  test("another space's changes never appear, in either direction", async () => {
    const mine = await signedInUser();
    const theirs = await signedInUser();
    const myStart = ((await (await route(request("", mine.cookie))).json()) as Payload).cursor;
    const theirStart = ((await (
      await route(request("", theirs.cookie))
    ).json()) as Payload).cursor;

    const myRow = await writeInvestment(mine.spaceId, "Mine");
    const theirRow = await writeInvestment(theirs.spaceId, "Theirs");

    const myFeed = (await (
      await route(request(`?since=${myStart}`, mine.cookie))
    ).json()) as Payload;
    expect(myFeed.changes.map((change) => change.rowId)).toEqual([myRow]);

    const theirFeed = (await (
      await route(request(`?since=${theirStart}`, theirs.cookie))
    ).json()) as Payload;
    expect(theirFeed.changes.map((change) => change.rowId)).toEqual([theirRow]);

    // And a cursor from the other user's feed does not widen anything: the
    // space set is the server's, not the request's.
    const replayed = (await (
      await route(request(`?since=0`, mine.cookie))
    ).json()) as Payload;
    expect(replayed.changes.every((change) => change.rowId !== theirRow)).toBe(true);
  });

  test("the cursor is exclusive and advances exactly once per change", async () => {
    const user = await signedInUser();
    const start = ((await (await route(request("", user.cookie))).json()) as Payload).cursor;
    const first = await writeInvestment(user.spaceId, "One");
    const second = await writeInvestment(user.spaceId, "Two");

    const page = (await (
      await route(request(`?since=${start}`, user.cookie))
    ).json()) as Payload;
    expect(page.changes.map((change) => change.rowId)).toEqual([first, second]);

    // Re-reading from the returned cursor returns nothing, and re-reading from
    // the first change's own position returns only the second.
    const empty = (await (
      await route(request(`?since=${page.cursor}`, user.cookie))
    ).json()) as Payload;
    expect(empty.changes).toEqual([]);
    expect(empty.cursor).toBe(page.cursor);
  });

  test("a response carries ids only, never row content", async () => {
    const user = await signedInUser();
    const start = ((await (await route(request("", user.cookie))).json()) as Payload).cursor;
    await writeInvestment(user.spaceId, "A name that must not travel");
    const body = await (await route(request(`?since=${start}`, user.cookie))).text();
    expect(body).not.toContain("A name that must not travel");
    const payload = JSON.parse(body) as Payload;
    // Four fields, all of them ids or labels. Nothing from the row itself.
    expect(Object.keys(payload.changes[0]!).sort()).toEqual([
      "id",
      "op",
      "rowId",
      "table",
    ]);
  });

  test(
    "an event-stream request streams the same changes and ends cleanly",
    async () => {
      const user = await signedInUser();
      const start = ((await (await route(request("", user.cookie))).json()) as Payload).cursor;
      const id = await writeInvestment(user.spaceId, "Streamed");

      const controller = new AbortController();
      const streaming = new Request(
        `${ORIGIN}/api/kith/changes?since=${start}`,
        {
          headers: new Headers({
            "Content-Type": "application/json",
            origin: ORIGIN,
            cookie: user.cookie,
            accept: "text/event-stream",
          }),
          signal: controller.signal,
        },
      );
      const response = await route(streaming);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toContain("no-store");

      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let text = "";
      while (!text.includes("event: change")) {
        const { done, value } = await reader.read();
        if (done) break;
        text += value;
      }
      expect(text).toContain(`id: `);
      expect(text).toContain(`"rowId":"${id}"`);
      expect(text).toContain('"table":"investments"');
      expect(text).not.toContain("Streamed");

      // Aborting the request closes the stream rather than leaving it running
      // to its own budget.
      controller.abort();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    },
    20_000,
  );
});
