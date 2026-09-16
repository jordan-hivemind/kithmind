// `POST /api/kith/thoughts/capture`, against a real database.
//
// Drives the real gate (`lib/kith/capture.ts`'s `captureThoughtFromWeb`,
// shared with the MCP `capture_thought` tool) through the route, the same
// shape `lib/mcp/postgres-writes.test.ts` uses for the tool itself: a stated
// classifier decision injected through `setCaptureClassifier`, restored after
// every case so none leaks into the next. No embedding index is seeded here
// (`postgres-writes.test.ts`'s own comment explains why that is a deliberate
// amount of fixture machinery), so the gate's `indexReady` check is false for
// every case and the embedder is never called; one case asserts that
// directly, through the same unified seam `reads.ts`'s vector-backed read
// tools use (`lib/mcp/embedder.ts`, re-exported here as `setCaptureEmbedder`).
//
// A signed-in web session (`sessionCookie`), not an API key: this route's
// caller is the dashboard, and `webPrincipalLoader` reloads that session from
// the cookie on every one of the gate's transactions, exactly as
// `mcpPrincipalLoader` reloads an API key credential for the MCP tool.

import { randomBytes } from "node:crypto";

import { applyKithSchema, createKithPool, newKithId, withKithTransaction } from "@repo/kith-store";
import {
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  sessionCookie,
  setDefaultWriteSpace,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  type CaptureClassifier,
  type CaptureEmbedder,
  setCaptureClassifier,
  setCaptureEmbedder,
} from "@/lib/kith/capture";
import { setKithPool } from "@/lib/kith/pool";

import { POST } from "./route";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const secret = randomBytes(32).toString("hex");
const ORIGIN = "https://kith.example.test";
const URL_PATH = `${ORIGIN}/api/kith/thoughts/capture`;

type CaptureResponse = {
  thoughtId?: string;
  metadata: { type: string; topics: string[]; people: string[]; summary: string };
  disposition: string;
  operationSummary?: string;
};

describeWithDatabase("POST /api/kith/thoughts/capture", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  const restoreSeams: Array<() => void> = [];

  /** One stated classifier answer, in the shape the parser produces. */
  function classified(
    action: "ADD" | "NOOP" | "SUPERSEDE" | "RETRACT" | "ASK" | "SKIP",
    fields: { summary?: string; reason?: string } = {},
  ) {
    return {
      classification: {
        action,
        relatedThoughtIds: [],
        reason: fields.reason ?? "synthetic reason",
      },
      metadata: {
        type: "decision" as const,
        topics: ["ledger"],
        people: ["Rowan"],
        actionItems: [],
        summary: fields.summary ?? "Classified summary",
      },
    };
  }

  function setClassifier(answer: CaptureClassifier) {
    restoreSeams.push(setCaptureClassifier(answer));
  }

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

  async function signedInUser(): Promise<{ userId: string; cookie: string; spaceId: string }> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `i7a-capture-${randomBytes(4).toString("hex")}@example.test`,
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

  /** Revokes every session belonging to `userId`. One fresh user per test, so this is unambiguous. */
  async function revokeSession(userId: string): Promise<void> {
    await inTransaction((ctx) =>
      ctx.client.query("UPDATE kith.sessions SET revoked_at = now() WHERE user_id = $1", [userId]),
    );
  }

  function baseHeaders(cookie: string | null): Headers {
    const headers = new Headers({ "Content-Type": "application/json", origin: ORIGIN });
    if (cookie !== null) headers.set("cookie", cookie);
    return headers;
  }

  function jsonRequest(body: unknown, cookie: string | null): Request {
    return new Request(URL_PATH, {
      method: "POST",
      headers: baseHeaders(cookie),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function bodyOf(response: Response): Promise<CaptureResponse> {
    return (await response.json()) as CaptureResponse;
  }

  beforeAll(async () => {
    databaseName = `kith_i7a_capture_test_${randomBytes(8).toString("hex")}`;
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
    restorePool = setKithPool(pool);
    process.env.KITH_SESSION_SECRET = secret;
    process.env.KITH_POSTGRES_SURFACE = "postgres";
  }, 60_000);

  afterEach(() => {
    while (restoreSeams.length > 0) restoreSeams.pop()!();
  });

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    delete process.env.KITH_SESSION_SECRET;
    delete process.env.KITH_POSTGRES_SURFACE;
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  test("stores via the classifier's ADD decision, and never calls the embedder without a ready index", async () => {
    const user = await signedInUser();
    setClassifier(async () => classified("ADD", { summary: "Typed into the browser" }));
    let embedderCalls = 0;
    const failingEmbedder: CaptureEmbedder = async () => {
      embedderCalls += 1;
      throw new Error("should not be called: no complete index on this space");
    };
    restoreSeams.push(setCaptureEmbedder(failingEmbedder));

    const response = await POST(
      jsonRequest({ content: "Decided to migrate the web app off Convex onto PostgreSQL." }, user.cookie),
    );
    expect(response.status).toBe(201);
    const body = await bodyOf(response);
    expect(body.disposition).toBe("stored");
    expect(body.thoughtId).toBeTruthy();
    expect(body.metadata.summary).toBe("Typed into the browser");
    expect(embedderCalls).toBe(0);
  });

  test("a retried identical capture is reported as a duplicate and stores no second row", async () => {
    const user = await signedInUser();
    setClassifier(async () => classified("ADD"));
    const content = `Renewed the car registration for another year (${randomBytes(3).toString("hex")}).`;

    const first = await POST(jsonRequest({ content }, user.cookie));
    const firstBody = await bodyOf(first);
    expect(firstBody.disposition).toBe("stored");

    const second = await POST(jsonRequest({ content }, user.cookie));
    expect(second.status).toBe(200);
    const secondBody = await bodyOf(second);
    expect(secondBody.disposition).toBe("duplicate");
    expect(secondBody.thoughtId).toBe(firstBody.thoughtId);

    const count = await inTransaction(
      async (ctx) =>
        (
          await ctx.client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM kith.thoughts WHERE space_id = $1 AND content = $2",
            [user.spaceId, content],
          )
        ).rows[0]!.n,
    );
    expect(count).toBe("1");
  });

  test("an unavailable classifier needs confirmation and stores nothing, failing closed", async () => {
    const user = await signedInUser();
    const before = await inTransaction(
      async (ctx) =>
        (
          await ctx.client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM kith.thoughts WHERE space_id = $1",
            [user.spaceId],
          )
        ).rows[0]!.n,
    );
    setClassifier(async () => null);
    const response = await POST(
      jsonRequest({ content: `A synthetic note the classifier never sees (${randomBytes(3).toString("hex")}).` }, user.cookie),
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.disposition).toBe("needs_confirmation");
    expect(body.thoughtId).toBeUndefined();
    expect(body.operationSummary).toBe(
      "Memory was not stored because the admission check was unavailable",
    );
    const after = await inTransaction(
      async (ctx) =>
        (
          await ctx.client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM kith.thoughts WHERE space_id = $1",
            [user.spaceId],
          )
        ).rows[0]!.n,
    );
    expect(after).toBe(before);
  });

  test("a non-string spaceId is refused rather than silently dropped", async () => {
    const user = await signedInUser();
    const response = await POST(
      jsonRequest({ content: "anything at all", spaceId: 12345 }, user.cookie),
    );
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ error: "Invalid request" });
  });

  test("a session revoked between the gate's two provider calls denies the write and stores nothing", async () => {
    const user = await signedInUser();
    const before = await inTransaction(
      async (ctx) =>
        (
          await ctx.client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM kith.thoughts WHERE space_id = $1",
            [user.spaceId],
          )
        ).rows[0]!.n,
    );
    // The revocation lands where webPrincipalLoader's distinguishing property
    // matters: the gate calls the classifier between its second and third
    // transaction, so a session that dies there must deny on the reload
    // transaction 3 does, exactly as a revoked API key denies capture_thought
    // in lib/mcp/postgres-writes.test.ts's own version of this case.
    setClassifier(async () => {
      await revokeSession(user.userId);
      return classified("ADD");
    });
    const response = await POST(
      jsonRequest({ content: `Revoked mid-gate (${randomBytes(3).toString("hex")}).` }, user.cookie),
    );
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ error: "Not authenticated" });
    const after = await inTransaction(
      async (ctx) =>
        (
          await ctx.client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM kith.thoughts WHERE space_id = $1",
            [user.spaceId],
          )
        ).rows[0]!.n,
    );
    expect(after).toBe(before);
  });

  test("one user's cookie naming another user's space is refused in words that name no space, and writes nothing there", async () => {
    const userA = await signedInUser();
    const userB = await signedInUser();
    setClassifier(async () => classified("ADD"));

    const response = await POST(
      jsonRequest(
        { content: "Trying to write into a space I was never granted.", spaceId: userB.spaceId },
        userA.cookie,
      ),
    );
    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: "Space not found" });
    expect(JSON.stringify(body)).not.toContain(userB.spaceId);

    const count = await inTransaction(
      async (ctx) =>
        (
          await ctx.client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM kith.thoughts WHERE space_id = $1",
            [userB.spaceId],
          )
        ).rows[0]!.n,
    );
    expect(count).toBe("0");
  });

  test("a default write space that is no longer available is refused by name, not the opaque 500", async () => {
    const user = await signedInUser();
    const sharedSpace = newKithId();
    await inTransaction(async (ctx) => {
      await ctx.client.query(
        "INSERT INTO kith.spaces (id, kind, name, created_by) VALUES ($1, 'shared', 'Now unavailable', $2)",
        [sharedSpace, user.userId],
      );
      await ctx.client.query(
        "INSERT INTO kith.space_members (id, space_id, user_id, role) VALUES ($1, $2, $3, 'owner')",
        [newKithId(), sharedSpace, user.userId],
      );
      await setDefaultWriteSpace(ctx, {
        principal: { userId: user.userId, capabilities: ["read", "write", "ingest"] as const },
        spaceId: sharedSpace,
      });
      // The membership that made it a valid default is gone; resolveWriteSpace
      // must not fall back to Personal silently.
      await ctx.client.query("DELETE FROM kith.space_members WHERE space_id = $1", [sharedSpace]);
    });

    setClassifier(async () => classified("ADD"));
    const response = await POST(
      jsonRequest({ content: `No explicit space, and the default is gone (${randomBytes(3).toString("hex")}).` }, user.cookie),
    );
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ error: "Default write space is not available" });
  });

  test("an unauthenticated request is refused with 401 and stores nothing", async () => {
    const response = await POST(jsonRequest({ content: "anything at all" }, null));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string; code?: string };
    expect(body).toEqual({ error: "Not authenticated", code: "not_authenticated" });
  });

  test("a cross-origin request is refused before any transaction opens", async () => {
    const user = await signedInUser();
    const request = jsonRequest({ content: "anything at all" }, user.cookie);
    request.headers.set("origin", "https://attacker.example.test");
    const response = await POST(request);
    expect(response.status).toBe(403);
  });

  test("under the convex surface the route does not exist", async () => {
    const user = await signedInUser();
    process.env.KITH_POSTGRES_SURFACE = "convex";
    try {
      const response = await POST(jsonRequest({ content: "anything at all" }, user.cookie));
      expect(response.status).toBe(404);
    } finally {
      process.env.KITH_POSTGRES_SURFACE = "postgres";
    }
  });
});
