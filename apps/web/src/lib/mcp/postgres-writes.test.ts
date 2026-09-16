// The three write and ingest tools, and the two routes, on PostgreSQL.
//
// The same shape as `postgres-reads.test.ts`: one synthetic fixture in a
// throwaway database, every case driven through the registered MCP tool or the
// real route handler rather than through `@repo/kith-store`, and a recording
// pool so the transaction each call opens is visible. Synthetic rows only.
//
// What i4 has to hold, and where each property is asserted:
//
//   * Capability. `remember_fact` and `capture_thought` need `write`,
//     `ingest_url` and `/api/ingest` need `ingest`, and a credential without it
//     is refused.
//   * Destination. The tool's optional `spaceId` reaches the store only through
//     `resolveWriteSpace`, and the default is the configured write space, then
//     Personal. A space the credential was not granted is refused in words that
//     name no space id, so a caller cannot tell "not yours" from "no such
//     space" and cannot learn an id it did not already have.
//   * One transaction per call, `SERIALIZABLE`, with the principal reloaded
//     inside it. The pool proxy records every `BEGIN`.
//   * Revocation. A key revoked between two calls denies on the second.
//   * Idempotency. `/api/ingest` answers a repeated `requestId` with the first
//     admission's rows rather than admitting again.
//   * Wire parity. `/api/worker` answers the worker protocol's own synthetic
//     fixtures with the same status and the same body as the store's own
//     adapter, and its error table is the one the Convex leg uses.
//
// The suite skips cleanly when `KITH_STORE_DATABASE_URL` is not set.

import { randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WorkerProtocolErrorCode } from "@repo/db/convex/models/workers/protocol";
import {
  applyKithSchema,
  createKithPool,
  newKithId,
  withKithTransaction,
  workers,
} from "@repo/kith-store";
import {
  createApiKey,
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { setKithPool } from "@/lib/kith/pool";
import { backendWorkerError, workerErrorForCode } from "@/lib/worker/http";

const convexMocks = vi.hoisted(() => ({
  query: vi.fn(),
  action: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = convexMocks.query;
    action = convexMocks.action;
    mutation = convexMocks.mutation;
    setAuth() {}
  },
}));

import { POST as ingestRoute } from "../../app/api/ingest/route";
import { POST as workerRoute } from "../../app/api/worker/route";
import { mcpPrincipalLoader } from "./principal";
import { createMcpServer, type McpServerCredential } from "./server";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const SERIALIZABLE_BEGIN = "BEGIN ISOLATION LEVEL SERIALIZABLE";

type Key = { id: string; rawKey: string };

type Fixture = {
  userId: string;
  /** Personal, granted to every credential below. */
  spaceA: string;
  /** Shared, a live membership, granted to `keyBoth` only. */
  spaceB: string;
  /** Another user's space. No membership at all. */
  spaceForeign: string;
  keyWrite: Key;
  keyBoth: Key;
  keyReadOnly: Key;
  keyIngest: Key;
  keyNoIngest: Key;
  keyRevocable: Key;
  sourceAccountA: string;
  workerSourceAccount: string;
  keyWorker: Key;
};

describeWithDatabase("MCP write and ingest tools on PostgreSQL", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let fixture: Fixture;
  /** Every `BEGIN` the pool issued since the last reset. */
  let transactionLog: string[] = [];

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

  function inTransaction<T>(
    work: (ctx: IdentityCtx) => Promise<T>,
  ): Promise<T> {
    return withKithTransaction(pool, (client) => work(identityCtx(client)));
  }

  /** The pool the app sees, with every `BEGIN` recorded. See i3's suite. */
  function recordingPool(inner: pg.Pool): pg.Pool {
    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property !== "connect") {
          return Reflect.get(target, property, receiver);
        }
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client);
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty !== "query") {
                return Reflect.get(
                  clientTarget,
                  clientProperty,
                  clientReceiver,
                );
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

  async function seedSourceAccount(
    ctx: IdentityCtx,
    input: {
      spaceId: string;
      userId: string;
      connector: string;
      accountId: string;
    },
  ): Promise<string> {
    const id = newKithId();
    await ctx.client.query(
      `INSERT INTO kith.source_accounts
         (id, space_id, created_at, connector, account_id, name, enabled,
          cursor_version, freshness_ms, inventory_epoch,
          completed_inventory_epoch, manifest_version, created_by)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, true,
               0, 60000, 0, 0, 0, $6)`,
      [
        id,
        input.spaceId,
        input.connector,
        input.accountId,
        "Synthetic capture",
        input.userId,
      ],
    );
    return id;
  }

  async function buildFixture(): Promise<Fixture> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `mcp-writes-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const userId = session.userId;
      const spaceA = await ensurePersonalSpace(ctx, userId);

      const spaceB = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.spaces (id, kind, name, created_by)
           VALUES ($1, 'shared', 'Shared archive', $2)`,
        [spaceB, userId],
      );
      await ctx.client.query(
        `INSERT INTO kith.space_members (id, space_id, user_id, role)
           VALUES ($1, $2, $3, 'owner')`,
        [newKithId(), spaceB, userId],
      );

      // A second account entirely, so "a space this credential may not write"
      // has both of its shapes: one the user is a member of and one it is not.
      const outsider = await signUp(ctx, {
        email: `mcp-writes-outsider-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceForeign = await ensurePersonalSpace(ctx, outsider.userId);

      const owner = {
        userId,
        capabilities: ["read", "write", "ingest"] as const,
      };
      const sourceAccountA = await seedSourceAccount(ctx, {
        spaceId: spaceA,
        userId,
        connector: "mcp-client",
        accountId: "desktop-capture",
      });
      const workerSourceAccount = await seedSourceAccount(ctx, {
        spaceId: spaceA,
        userId,
        connector: "fs",
        accountId: "worker-fixture",
      });

      const key = (
        name: string,
        capabilities: Array<"read" | "write" | "ingest">,
        spaceIds: string[],
        sourceAccountIds: string[] = [],
      ) =>
        createApiKey(ctx, {
          principal: owner,
          name,
          capabilities,
          spaceIds,
          sourceAccountIds,
        });

      return {
        userId,
        spaceA,
        spaceB,
        spaceForeign,
        keyWrite: await key(
          "write, personal only",
          ["read", "write"],
          [spaceA],
        ),
        keyBoth: await key(
          "write, both spaces",
          ["read", "write"],
          [spaceA, spaceB],
        ),
        keyReadOnly: await key("read only", ["read"], [spaceA]),
        keyIngest: await key(
          "ingest",
          ["read", "ingest"],
          [spaceA],
          [sourceAccountA, workerSourceAccount],
        ),
        keyNoIngest: await key("no ingest", ["read", "write"], [spaceA]),
        keyRevocable: await key("revocable", ["read", "write"], [spaceA]),
        keyWorker: await key(
          "worker",
          ["read", "ingest"],
          [spaceA],
          [workerSourceAccount],
        ),
        sourceAccountA,
        workerSourceAccount,
      };
    });
  }

  beforeAll(async () => {
    databaseName = `kith_mcp_writes_test_${randomBytes(8).toString("hex")}`;
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
    restorePool = setKithPool(recordingPool(pool));
    fixture = await buildFixture();
  }, 120_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("KITH_POSTGRES_SURFACE", "postgres");
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://synthetic.convex.cloud");
    vi.resetAllMocks();
    transactionLog = [];
  });

  afterEach(() => vi.unstubAllEnvs());

  // -------------------------------------------------------------------------
  // Tool plumbing
  // -------------------------------------------------------------------------

  function credentialFor(keyId: string): McpServerCredential {
    return {
      surface: "postgres",
      withPrincipal: mcpPrincipalLoader({
        userId: fixture.userId,
        credentialId: keyId,
      }),
    };
  }

  async function callTool(
    keyId: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    const server = createMcpServer(
      credentialFor(keyId),
      "user-test:key-test",
      null,
    );
    const client = new Client({ name: "postgres-writes", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
      await server.close();
    }
  }

  function text(result: unknown): string {
    const content = (result as { content?: Array<{ text?: string }> }).content;
    return content?.[0]?.text ?? "";
  }

  /** Every string in a denial, so "it names no space id" can be checked. */
  function mentionsNoSpaceId(body: string) {
    for (const spaceId of [
      fixture.spaceA,
      fixture.spaceB,
      fixture.spaceForeign,
    ]) {
      expect(body).not.toContain(spaceId);
    }
  }

  const factArgs = (overrides: Record<string, unknown> = {}) => ({
    subject: {
      kind: "person",
      name: `Rowan ${randomBytes(3).toString("hex")}`,
    },
    predicate: "home_city",
    value: { type: "text", value: "Oakland" },
    sourceType: "user_stated",
    ...overrides,
  });

  const captureArgs = (overrides: Record<string, unknown> = {}) => ({
    content: `The synthetic household reviews the ledger each quarter (${randomBytes(3).toString("hex")}).`,
    sourceType: "user_stated",
    ...overrides,
  });

  const urlArgs = (overrides: Record<string, unknown> = {}) => ({
    requestId: `synthetic-url-${randomBytes(4).toString("hex")}`,
    source: {
      connector: "mcp-client",
      accountId: "desktop-capture",
      externalId: `synthetic/item-${randomBytes(4).toString("hex")}`,
    },
    url: "https://example.test/synthetic/note",
    ...overrides,
  });

  // -------------------------------------------------------------------------
  // Capability
  // -------------------------------------------------------------------------

  test("remember_fact and capture_thought are denied without write", async () => {
    const fact = await callTool(
      fixture.keyReadOnly.id,
      "remember_fact",
      factArgs(),
    );
    expect(fact.isError).toBe(true);
    expect(text(fact)).toContain("Space not found");
    mentionsNoSpaceId(text(fact));

    const thought = await callTool(
      fixture.keyReadOnly.id,
      "capture_thought",
      captureArgs(),
    );
    expect(thought.isError).toBe(true);
    expect(text(thought)).toContain(
      "Thought capture requires read and write capabilities",
    );

    // Nothing was written by either refusal.
    const written = await pool.query(
      "SELECT count(*)::int AS n FROM kith.facts WHERE space_id = $1",
      [fixture.spaceA],
    );
    expect(typeof written.rows[0]!.n).toBe("number");
  });

  test("ingest_url is denied without the ingest capability", async () => {
    const denied = await callTool(
      fixture.keyNoIngest.id,
      "ingest_url",
      urlArgs(),
    );
    expect(denied.isError).toBe(true);
    // `Source account not found` and `Space not found` are both non-enumerating;
    // which one comes back must not depend on whether the account exists.
    expect(text(denied)).toMatch(/not found/);
    mentionsNoSpaceId(text(denied));
  });

  test("ingest_url queues one request with the ingest capability", async () => {
    const args = urlArgs();
    const queued = await callTool(fixture.keyIngest.id, "ingest_url", args);
    expect(queued.isError).not.toBe(true);
    const body = JSON.parse(text(queued)) as Record<string, unknown>;
    expect(body.state).toBe("queued");
    expect(body.workerRequired).toBe(true);
    expect(body.requestId).toBe(args.requestId);

    const row = await pool.query(
      `SELECT space_id, url, state FROM kith.source_fetch_requests
         WHERE request_id = $1`,
      [args.requestId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.space_id).toBe(fixture.spaceA);
    expect(row.rows[0]!.state).toBe("queued");

    // A repeat of the same request is the same row, not a second one.
    const again = await callTool(fixture.keyIngest.id, "ingest_url", args);
    expect(JSON.parse(text(again))).toEqual(body);
  });

  // -------------------------------------------------------------------------
  // Destination space resolution
  // -------------------------------------------------------------------------

  test("the destination is the personal space when none is named", async () => {
    const stored = await callTool(
      fixture.keyWrite.id,
      "remember_fact",
      factArgs(),
    );
    expect(stored.isError).not.toBe(true);
    const { factId } = JSON.parse(text(stored)) as { factId: string };
    const row = await pool.query(
      "SELECT space_id FROM kith.facts WHERE id = $1",
      [factId],
    );
    expect(row.rows[0]!.space_id).toBe(fixture.spaceA);
  });

  test("an explicitly named granted space is the destination", async () => {
    const stored = await callTool(
      fixture.keyBoth.id,
      "capture_thought",
      captureArgs({ spaceId: fixture.spaceB }),
    );
    expect(stored.isError).not.toBe(true);
    expect(text(stored)).toContain("Disposition: stored");
    const citation = /Citation: thought:(\S+)/.exec(text(stored));
    expect(citation).not.toBeNull();
    const row = await pool.query(
      "SELECT space_id FROM kith.thoughts WHERE id = $1",
      [citation![1]],
    );
    expect(row.rows[0]!.space_id).toBe(fixture.spaceB);
  });

  test("the configured default write space is the destination", async () => {
    const other = await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `mcp-writes-default-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const personal = await ensurePersonalSpace(ctx, session.userId);
      const shared = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.spaces (id, kind, name, created_by)
           VALUES ($1, 'shared', 'Configured default', $2)`,
        [shared, session.userId],
      );
      await ctx.client.query(
        `INSERT INTO kith.space_members (id, space_id, user_id, role)
           VALUES ($1, $2, $3, 'owner')`,
        [newKithId(), shared, session.userId],
      );
      await ctx.client.query(
        `UPDATE kith.user_space_settings SET default_write_space_id = $2
           WHERE user_id = $1`,
        [session.userId, shared],
      );
      const key = await createApiKey(ctx, {
        principal: {
          userId: session.userId,
          capabilities: ["read", "write"] as const,
        },
        name: "Configured default",
        capabilities: ["read", "write"],
        spaceIds: [personal, shared],
      });
      return { userId: session.userId, keyId: key.id, personal, shared };
    });

    const server = createMcpServer(
      {
        surface: "postgres",
        withPrincipal: mcpPrincipalLoader({
          userId: other.userId,
          credentialId: other.keyId,
        }),
      },
      "user-test:key-test",
      null,
    );
    const client = new Client({ name: "postgres-writes", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    let stored;
    try {
      stored = await client.callTool({
        name: "remember_fact",
        arguments: factArgs(),
      });
    } finally {
      await client.close();
      await server.close();
    }
    const { factId } = JSON.parse(text(stored)) as { factId: string };
    const row = await pool.query(
      "SELECT space_id FROM kith.facts WHERE id = $1",
      [factId],
    );
    expect(row.rows[0]!.space_id).toBe(other.shared);
    expect(row.rows[0]!.space_id).not.toBe(other.personal);
  });

  test("a space the credential was not granted is refused, naming no id", async () => {
    // Two shapes of "not yours": a live membership the credential's grant
    // excludes, and a space with no membership at all. Both are the same words.
    for (const spaceId of [fixture.spaceB, fixture.spaceForeign]) {
      const fact = await callTool(
        fixture.keyWrite.id,
        "remember_fact",
        factArgs({ spaceId }),
      );
      expect(fact.isError).toBe(true);
      expect(text(fact)).toContain("Space not found");
      mentionsNoSpaceId(text(fact));

      const thought = await callTool(
        fixture.keyWrite.id,
        "capture_thought",
        captureArgs({ spaceId }),
      );
      expect(thought.isError).toBe(true);
      expect(text(thought)).toContain("Space not found");
      mentionsNoSpaceId(text(thought));
    }

    // And a space id that is not an id at all is the same refusal, so the
    // shape of the argument does not distinguish either.
    const nonsense = await callTool(
      fixture.keyWrite.id,
      "remember_fact",
      factArgs({ spaceId: "not-a-space" }),
    );
    expect(nonsense.isError).toBe(true);
  });

  // -------------------------------------------------------------------------
  // One transaction per call
  // -------------------------------------------------------------------------

  test("each write and ingest tool opens exactly one SERIALIZABLE transaction", async () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [
      [fixture.keyWrite.id, "remember_fact", factArgs()],
      [fixture.keyWrite.id, "capture_thought", captureArgs()],
      [fixture.keyIngest.id, "ingest_url", urlArgs()],
    ];
    for (const [keyId, name, args] of calls) {
      transactionLog = [];
      const result = await callTool(keyId, name, args);
      expect(result.isError, `${name} failed: ${text(result)}`).not.toBe(true);
      expect(transactionLog, name).toEqual([SERIALIZABLE_BEGIN]);
    }
  });

  test("a denial also costs exactly one transaction", async () => {
    transactionLog = [];
    const denied = await callTool(
      fixture.keyWrite.id,
      "remember_fact",
      factArgs({ spaceId: fixture.spaceB }),
    );
    expect(denied.isError).toBe(true);
    expect(transactionLog).toEqual([SERIALIZABLE_BEGIN]);
  });

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  test("a key revoked between two calls denies on the second", async () => {
    const first = await callTool(
      fixture.keyRevocable.id,
      "remember_fact",
      factArgs(),
    );
    expect(first.isError).not.toBe(true);

    await pool.query("DELETE FROM kith.api_keys WHERE id = $1", [
      fixture.keyRevocable.id,
    ]);

    const second = await callTool(
      fixture.keyRevocable.id,
      "remember_fact",
      factArgs(),
    );
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("Not authenticated");
  });

  // -------------------------------------------------------------------------
  // capture_thought's provider-free admission gate
  // -------------------------------------------------------------------------

  test("capture_thought keeps the gate branches that need no provider", async () => {
    const ungrounded = await callTool(fixture.keyWrite.id, "capture_thought", {
      content: "The synthetic ledger is reviewed every quarter.",
    });
    expect(ungrounded.isError).not.toBe(true);
    expect(text(ungrounded)).toContain("Disposition: needs_confirmation");
    expect(text(ungrounded)).toContain("grounding is unknown");

    const derivedAge = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs({ content: "Rowan is 41 years old." }),
    );
    expect(derivedAge.isError).not.toBe(true);
    expect(text(derivedAge)).toContain("Disposition: skipped");

    // Neither branch wrote a row.
    const stored = await pool.query(
      `SELECT count(*)::int AS n FROM kith.thoughts
         WHERE content LIKE '%41 years old%'
            OR content = 'The synthetic ledger is reviewed every quarter.'`,
    );
    expect(stored.rows[0]!.n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // /api/ingest
  // -------------------------------------------------------------------------

  function ingestBody(overrides: Record<string, unknown> = {}) {
    return {
      requestId: `synthetic-capture-${randomBytes(4).toString("hex")}`,
      expectedDesiredProcessingEpoch: 0,
      source: {
        connector: "mcp-client",
        accountId: "desktop-capture",
        externalId: `synthetic/note-${randomBytes(4).toString("hex")}`,
        capturedAt: "2026-09-06T18:00:00Z",
      },
      title: "Synthetic service note",
      text: "The synthetic vehicle received an oil change on 2026-09-01.",
      docType: "vehicle-service",
      ...overrides,
    };
  }

  function jsonRequest(url: string, rawKey: string, body: unknown) {
    return new Request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  test("/api/ingest admits through the e2 lane and is idempotent by requestId", async () => {
    const body = ingestBody();
    const first = await ingestRoute(
      jsonRequest(
        "https://example.test/api/ingest",
        fixture.keyIngest.rawKey,
        body,
      ),
    );
    expect([200, 202]).toContain(first.status);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(typeof firstBody.sourceItemId).toBe("string");
    expect(typeof firstBody.sourceRevisionId).toBe("string");
    expect(typeof firstBody.processingGenerationId).toBe("string");
    expect(typeof firstBody.ingestJobId).toBe("string");
    expect(typeof firstBody.desiredProcessingEpoch).toBe("number");
    expect(typeof firstBody.isActive).toBe("boolean");
    expect(["ready", "queued", "needs_review", "failed"]).toContain(
      firstBody.state,
    );

    // The same request again: the first admission's rows, not a second
    // admission. One work row, one revision, one generation.
    const second = await ingestRoute(
      jsonRequest(
        "https://example.test/api/ingest",
        fixture.keyIngest.rawKey,
        body,
      ),
    );
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(firstBody);

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM kith.source_revisions WHERE source_item_id = $1`,
      [firstBody.sourceItemId],
    );
    expect(rows.rows[0]!.n).toBe(1);

    // Convex was not asked anything.
    expect(convexMocks.action).not.toHaveBeenCalled();
  });

  test("/api/ingest refuses a credential without ingest, naming no space id", async () => {
    const response = await ingestRoute(
      jsonRequest(
        "https://example.test/api/ingest",
        fixture.keyNoIngest.rawKey,
        ingestBody(),
      ),
    );
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(JSON.parse(body).error.code).toBe("forbidden");
    mentionsNoSpaceId(body);
  });

  test("/api/ingest refuses an unknown bearer with 401 and no backend detail", async () => {
    const response = await ingestRoute(
      jsonRequest(
        "https://example.test/api/ingest",
        "ob_0000000000000000000000000000000000000000000000000000000000000000",
        ingestBody(),
      ),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="ingest"',
    );
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Unauthorized" },
    });
  });

  // -------------------------------------------------------------------------
  // /api/worker wire parity
  // -------------------------------------------------------------------------

  function workerBase(operation: string) {
    return {
      protocolVersion: 1,
      operation,
      spaceId: fixture.spaceA,
      sourceAccountId: fixture.workerSourceAccount,
    };
  }

  /** The route and the store's own adapter, on the same request body. */
  async function bothWorkerPaths(rawKey: string, body: unknown) {
    const viaRoute = await workerRoute(
      jsonRequest("https://example.test/api/worker", rawKey, body),
    );
    const viaAdapter = await workers.handlePostgresWorkerRequest(
      pool,
      jsonRequest("https://example.test/api/worker", rawKey, body),
    );
    return {
      route: { status: viaRoute.status, body: await viaRoute.json() },
      adapter: { status: viaAdapter.status, body: await viaAdapter.json() },
    };
  }

  test("/api/worker answers the protocol fixtures exactly as the store adapter does", async () => {
    // The worker protocol suite's own synthetic fixtures
    // (`packages/kith-store/test/workerHttp.test.mjs`): a status read, a
    // request-id replay that must report `reused`, a denial and a malformed
    // body. Both paths run the same dispatcher, so what this pins is the
    // route's envelope: status, body and error mapping.
    const status = await bothWorkerPaths(
      fixture.keyWorker.rawKey,
      workerBase("source.status"),
    );
    expect(status.route.status).toBe(200);
    expect(status.route.body).toEqual(status.adapter.body);
    expect((status.route.body as { operation: string }).operation).toBe(
      "source.status",
    );

    const scanBegin = {
      ...workerBase("scan.begin"),
      requestId: "route-scan-begin",
      watcherId: "route-watcher",
      connectorVersion: "route-test-v1",
      mode: "normal",
      expectedInventoryEpoch: 0,
    };
    const begun = await workerRoute(
      jsonRequest(
        "https://example.test/api/worker",
        fixture.keyWorker.rawKey,
        scanBegin,
      ),
    );
    expect(begun.status).toBe(200);
    const begunBody = (await begun.json()) as Record<string, unknown>;
    expect(begunBody.operation).toBe("scan.begin");
    expect(begunBody.reused).toBe(false);

    // The replay, through both paths. A repeated request id is the same scan.
    const replay = await bothWorkerPaths(fixture.keyWorker.rawKey, scanBegin);
    expect(replay.route.status).toBe(200);
    expect(replay.route.body).toEqual(replay.adapter.body);
    expect((replay.route.body as { reused: boolean }).reused).toBe(true);
    expect((replay.route.body as { scanId: string }).scanId).toBe(
      begunBody.scanId,
    );

    // A credential with no grant on this source account.
    const denied = await bothWorkerPaths(
      fixture.keyWrite.rawKey,
      workerBase("source.status"),
    );
    expect(denied.route.status).toBe(denied.adapter.status);
    expect(denied.route.body).toEqual(denied.adapter.body);
    expect(denied.route.status).toBe(403);
    expect(denied.route.body).toEqual({
      error: { code: "not_authorized", message: "Not authorized" },
    });

    // A body the shared parser rejects.
    const malformed = await bothWorkerPaths(fixture.keyWorker.rawKey, {
      protocolVersion: 1,
      operation: "not.an.operation",
    });
    expect(malformed.route.status).toBe(malformed.adapter.status);
    expect(malformed.route.body).toEqual(malformed.adapter.body);
    expect(malformed.route.status).toBe(400);

    expect(convexMocks.action).not.toHaveBeenCalled();
  });

  test("/api/worker maps every protocol code the way the Convex leg does", async () => {
    // Both legs now call one table. This is the assertion that keeps it one:
    // the Convex classifier's output and the PostgreSQL classifier's output
    // are the same code type, and this route turns either into the same
    // status and message.
    const codes: WorkerProtocolErrorCode[] = [
      "not_authenticated",
      "not_authorized",
      "invalid_request",
      "not_found",
      "source_unavailable",
      "request_conflict",
      "scan_conflict",
      "scan_not_ready",
      "identity_review_required",
      "rate_limited",
      "reservation_expired",
      "stale_observation",
      "desired_processing_epoch_conflict",
      "lease_conflict",
    ];
    for (const code of codes) {
      const fromConvex = backendWorkerError({
        data: { type: "worker_protocol_error", code },
      });
      const fromPostgres = workerErrorForCode(code);
      expect([fromConvex.status, fromConvex.code, fromConvex.message]).toEqual([
        fromPostgres.status,
        fromPostgres.code,
        fromPostgres.message,
      ]);
    }
  });

  test("/api/worker refuses an unknown bearer with 401", async () => {
    const response = await workerRoute(
      jsonRequest(
        "https://example.test/api/worker",
        "ob_1111111111111111111111111111111111111111111111111111111111111111",
        workerBase("source.status"),
      ),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "not_authenticated", message: "Not authenticated" },
    });
  });
});
