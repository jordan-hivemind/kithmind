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
//     inside it. The pool proxy records every `BEGIN`. `capture_thought` is the
//     one exception and the proxy is how its shape is asserted: three
//     transactions around two provider calls, and one when it stops before
//     either.
//   * The admission gate. Every classifier branch, with the decision injected
//     and no provider reached, checked against what the tool answers and what
//     the database holds afterwards.
//   * Revocation. A key revoked between two calls denies on the second, and a
//     key revoked *during* the gate's provider calls denies the write.
//   * Idempotency. `/api/ingest` answers a repeated `requestId` with the first
//     admission's rows rather than admitting again.
//   * Wire parity. `/api/worker` answers the worker protocol's own synthetic
//     fixtures with the same status and the same body as the store's own
//     adapter, and the two share one error table.
//
// The suite skips cleanly when `KITH_STORE_DATABASE_URL` is not set.

import { createHash, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  applyKithSchema,
  createKithPool,
  embeddings,
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
import type { WorkerProtocolErrorCode } from "@repo/worker-protocol/request";
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
import { workerErrorForCode } from "@/lib/worker/http";

vi.mock("server-only", () => ({}));

import { POST as ingestRoute } from "../../app/api/ingest/route";
import { POST as workerRoute } from "../../app/api/worker/route";
import {
  type CaptureClassifier,
  type CaptureClassifierInput,
  type CaptureEmbedder,
  captureThoughtFromWeb,
  setCaptureClassifier,
  setCaptureEmbedder,
} from "../kith/capture";
import { mcpPrincipalLoader } from "./principal";
import { createMcpServer, type McpServerCredential } from "./server";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const SERIALIZABLE_BEGIN = "BEGIN ISOLATION LEVEL SERIALIZABLE";
const READ_ONLY_BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

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
  /** Seam restores, unwound in `afterEach` so no case leaks a provider stub. */
  const restoreSeams: Array<() => void> = [];

  /** One stated classifier answer, in the shape the parser produces. */
  function classified(
    action: "ADD" | "NOOP" | "SUPERSEDE" | "RETRACT" | "ASK" | "SKIP",
    fields: {
      relatedThoughtIds?: string[];
      reason?: string;
      replacementContent?: string;
      summary?: string;
      topics?: string[];
      people?: string[];
    } = {},
  ) {
    return {
      classification: {
        action,
        relatedThoughtIds: fields.relatedThoughtIds ?? [],
        reason: fields.reason ?? "synthetic reason",
        ...(fields.replacementContent === undefined
          ? {}
          : { replacementContent: fields.replacementContent }),
      },
      metadata: {
        type: "decision" as const,
        topics: fields.topics ?? ["ledger"],
        people: fields.people ?? ["Rowan"],
        actionItems: [],
        summary: fields.summary ?? "Classified summary",
      },
    };
  }

  /** Replaces the classifier for one case, recording what it was asked. */
  function setClassifier(answer: CaptureClassifier) {
    const seen: CaptureClassifierInput[] = [];
    restoreSeams.push(
      setCaptureClassifier(async (input) => {
        seen.push(input);
        return await answer(input);
      }),
    );
    return seen;
  }

  function setEmbedder(next: CaptureEmbedder) {
    restoreSeams.push(setCaptureEmbedder(next));
  }

  // ---------------------------------------------------------------------------
  // A real embedding index, seeded the way the store's own fixtures seed one.
  //
  // The gate's vector leg only runs when a space's thought index is complete,
  // and a stored capture is what makes it incomplete, so a suite that never
  // seeds one never reaches the embedder at all. These four helpers are the
  // smallest thing that gets a space to `thoughtStatus: "ready"` and keeps it
  // there. Raw SQL, like `seedSourceAccount` above: the writers that own these
  // tables belong to other slices and a test that could only run after them
  // would prove nothing about this one.
  // ---------------------------------------------------------------------------

  const DIMENSIONS = 1536;
  /** A unit vector with a single 1. Cosine against itself is 1. */
  function oneHot(index: number): number[] {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    vector[index] = 1;
    return vector;
  }
  const vectorLiteral = (vector: number[]) => `[${vector.join(",")}]`;
  const sha256Hex = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const scopeV2 = (spaceId: string, fingerprint: string) =>
    JSON.stringify(["embedding-vector-scope-v2", spaceId, fingerprint, "thought"]);
  const searchScope = (
    spaceId: string,
    fingerprint: string,
    generationId: string,
  ) =>
    JSON.stringify([
      "embedding-vector-scope-v1",
      spaceId,
      fingerprint,
      generationId,
      "thought",
    ]);

  type SeededIndex = { fingerprint: string; generationId: string };

  /**
   * A synthetic profile, deliberately not the production one: nothing here may
   * pass by accidentally matching the real embedding identity. The fingerprint
   * is computed rather than invented, because `requireGenerationProfile`
   * recomputes it from the profile's own columns and refuses a generation
   * whose stored fingerprint does not match.
   */
  const SYNTHETIC_PROFILE = {
    protocol: "openai-embeddings-v1",
    providerId: "synthetic",
    model: "synthetic-embed-small",
    modelRevision: "synthetic-rev-1",
    dimensions: DIMENSIONS,
    normalization: "none-v1",
    preprocessing: "none-v1",
  } as const;

  /** An active generation with zeroed counters, so captures build the counts. */
  async function seedActiveIndex(spaceId: string): Promise<SeededIndex> {
    const fingerprint =
      await embeddings.fingerprintEmbeddingConfig(SYNTHETIC_PROFILE);
    const profileId = newKithId();
    const generationId = newKithId();
    // One row per fingerprint, which migration 016 enforces: two spaces on one
    // profile share it, exactly as `ensureEmbeddingProfile` would leave them.
    await pool.query(
      `INSERT INTO kith.embedding_profiles
         (id, created_at, fingerprint, protocol, provider_id, model,
          model_revision, dimensions, normalization, preprocessing)
       VALUES ($1, transaction_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (fingerprint) DO NOTHING`,
      [
        profileId,
        fingerprint,
        SYNTHETIC_PROFILE.protocol,
        SYNTHETIC_PROFILE.providerId,
        SYNTHETIC_PROFILE.model,
        SYNTHETIC_PROFILE.modelRevision,
        SYNTHETIC_PROFILE.dimensions,
        SYNTHETIC_PROFILE.normalization,
        SYNTHETIC_PROFILE.preprocessing,
      ],
    );
    const profile = await pool.query<{ id: string }>(
      "SELECT id FROM kith.embedding_profiles WHERE fingerprint = $1",
      [fingerprint],
    );
    await pool.query(
      `INSERT INTO kith.embedding_generations
         (id, space_id, created_at, embedding_profile_id, fingerprint, state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'active')`,
      [generationId, spaceId, profile.rows[0]!.id, fingerprint],
    );
    const zero = JSON.stringify({ thought: 0, chunk: 0, card: 0 });
    await pool.query(
      `INSERT INTO kith.space_embedding_states
         (id, space_id, created_at, eligibility_epoch,
          active_embedding_generation_id, active_fingerprint, eligible_counts,
          covered_counts, counter_drift, last_audit_at)
       VALUES ($1, $2, transaction_timestamp(), 1, $3, $4, $5::jsonb, $6::jsonb,
               false, transaction_timestamp())
       ON CONFLICT (space_id) DO UPDATE
         SET active_embedding_generation_id = EXCLUDED.active_embedding_generation_id,
             active_fingerprint = EXCLUDED.active_fingerprint,
             eligible_counts = EXCLUDED.eligible_counts,
             covered_counts = EXCLUDED.covered_counts,
             counter_drift = false,
             last_audit_at = EXCLUDED.last_audit_at`,
      [
        newKithId(),
        spaceId,
        generationId,
        fingerprint,
        zero,
        JSON.stringify([{ fingerprint, counts: { thought: 0, chunk: 0, card: 0 } }]),
      ],
    );
    return { fingerprint, generationId };
  }

  /**
   * Covers every eligible, uncovered thought target in the space, then makes
   * the counters say so. A miniature `runEmbeddingFill` -- which has no
   * production caller yet, which is the whole reason the gate needed a keyword
   * leg. Every vector is the same axis, so every covered memory is a candidate
   * for a query on that axis and the assertions are about *which* memories are
   * reachable, never about ranking.
   */
  async function makeIndexReady(
    spaceId: string,
    index: SeededIndex,
  ): Promise<void> {
    const owed = await pool.query<{ id: string; content: string }>(
      `SELECT t.id, t.content FROM kith.thoughts t
         WHERE t.space_id = $1
           AND (t.memory_status IS NULL OR t.memory_status = 'current')`,
      [spaceId],
    );
    for (const { id, content } of owed.rows) {
      const inputHash = sha256Hex(content);
      await pool.query(
        `INSERT INTO kith.embedding_targets
           (id, space_id, created_at, target_kind, target_id, input_hash,
            state, covered_fingerprint, updated_at)
         VALUES ($1, $2, transaction_timestamp(), 'thought', $3, $4,
                 'eligible', $5, transaction_timestamp())
         ON CONFLICT (space_id, target_kind, target_id) DO UPDATE
           SET input_hash = EXCLUDED.input_hash,
               state = 'eligible',
               covered_fingerprint = EXCLUDED.covered_fingerprint,
               updated_at = EXCLUDED.updated_at`,
        [newKithId(), spaceId, id, inputHash, index.fingerprint],
      );
      await pool.query(
        `DELETE FROM kith.embedding_vectors
           WHERE space_id = $1 AND target_kind = 'thought' AND thought_id = $2`,
        [spaceId, id],
      );
      await pool.query(
        `INSERT INTO kith.embedding_vectors
           (id, space_id, created_at, embedding_generation_id,
            embedding_fingerprint, target_kind, search_scope, thought_id,
            input_hash, embedding, scope_v2)
         VALUES ($1, $2, transaction_timestamp(), $3, $4, 'thought', $5, $6, $7,
                 $8::public.vector, $9)`,
        [
          newKithId(),
          spaceId,
          index.generationId,
          index.fingerprint,
          searchScope(spaceId, index.fingerprint, index.generationId),
          id,
          inputHash,
          vectorLiteral(oneHot(0)),
          scopeV2(spaceId, index.fingerprint),
        ],
      );
    }
    // What a clean audit would leave behind.
    const counted = await pool.query<{
      target_kind: string;
      eligible: number;
      covered: number;
    }>(
      `SELECT target_kind,
              count(*) FILTER (WHERE state = 'eligible')::int AS eligible,
              count(*) FILTER (WHERE state = 'eligible'
                                 AND covered_fingerprint = $2)::int AS covered
         FROM kith.embedding_targets WHERE space_id = $1
        GROUP BY target_kind`,
      [spaceId, index.fingerprint],
    );
    const eligible = { thought: 0, chunk: 0, card: 0 };
    const covered = { thought: 0, chunk: 0, card: 0 };
    for (const row of counted.rows) {
      eligible[row.target_kind as keyof typeof eligible] = row.eligible;
      covered[row.target_kind as keyof typeof covered] = row.covered;
    }
    await pool.query(
      `UPDATE kith.space_embedding_states
          SET eligible_counts = $2::jsonb, covered_counts = $3::jsonb,
              counter_drift = false, counter_drift_reason = NULL,
              last_audit_at = transaction_timestamp()
        WHERE space_id = $1`,
      [
        spaceId,
        JSON.stringify(eligible),
        JSON.stringify([{ fingerprint: index.fingerprint, counts: covered }]),
      ],
    );
  }

  /** A second account with its own personal and shared space, and one key. */
  async function isolatedWriter() {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `mcp-writes-index-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const personal = await ensurePersonalSpace(ctx, session.userId);
      const shared = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.spaces (id, kind, name, created_by)
           VALUES ($1, 'shared', 'Indexed shared archive', $2)`,
        [shared, session.userId],
      );
      await ctx.client.query(
        `INSERT INTO kith.space_members (id, space_id, user_id, role)
           VALUES ($1, $2, $3, 'owner')`,
        [newKithId(), shared, session.userId],
      );
      const key = await createApiKey(ctx, {
        principal: {
          userId: session.userId,
          capabilities: ["read", "write"] as const,
        },
        name: "indexed writer",
        capabilities: ["read", "write"],
        spaceIds: [personal, shared],
      });
      return { userId: session.userId, keyId: key.id, personal, shared };
    });
  }

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
    vi.resetAllMocks();
    transactionLog = [];
    // Nothing in this suite may reach a provider. The classifier is stated per
    // case; the default refuses, which is also the fail-closed answer, so a
    // case that forgets to state one cannot pass by storing.
    restoreSeams.push(setCaptureClassifier(async () => null));
    restoreSeams.push(
      setCaptureEmbedder(async () => {
        throw new Error("no embedder was injected for this case");
      }),
    );
  });

  afterEach(() => {
    while (restoreSeams.length > 0) restoreSeams.pop()!();
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // Tool plumbing
  // -------------------------------------------------------------------------

  /**
   * `userId` defaults to the fixture's owner, which is who nearly every case
   * writes as. The cases that seed their own embedding index sign up a second
   * account, and a credential reference is a user *and* a key: passing the key
   * alone would reload it against the wrong user and deny.
   */
  function credentialFor(
    keyId: string,
    userId: string = fixture.userId,
  ): McpServerCredential {
    return {
      surface: "postgres",
      withPrincipal: mcpPrincipalLoader({ userId, credentialId: keyId }),
    };
  }

  async function callTool(
    keyId: string,
    name: string,
    args: Record<string, unknown>,
    userId: string = fixture.userId,
  ) {
    const server = createMcpServer(
      credentialFor(keyId, userId),
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

  /** Rows in one space, so "the refusal wrote nothing" can be a difference. */
  async function rowCounts(spaceId: string) {
    const counted = await pool.query<{ facts: number; thoughts: number }>(
      `SELECT (SELECT count(*) FROM kith.facts WHERE space_id = $1)::int AS facts,
              (SELECT count(*) FROM kith.thoughts WHERE space_id = $1)::int AS thoughts`,
      [spaceId],
    );
    return counted.rows[0]!;
  }

  test("remember_fact and capture_thought are denied without write", async () => {
    const before = await rowCounts(fixture.spaceA);

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

    // Neither refusal wrote a row. A count taken before and compared after,
    // rather than a count inspected on its own: the destination is Personal,
    // which other cases in this suite write to, so only the difference across
    // these two calls says anything.
    expect(await rowCounts(fixture.spaceA)).toEqual(before);
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
    setClassifier(async () => classified("ADD"));
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

  test("remember_fact and ingest_url open exactly one SERIALIZABLE transaction", async () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [
      [fixture.keyWrite.id, "remember_fact", factArgs()],
      [fixture.keyIngest.id, "ingest_url", urlArgs()],
    ];
    for (const [keyId, name, args] of calls) {
      transactionLog = [];
      const result = await callTool(keyId, name, args);
      expect(result.isError, `${name} failed: ${text(result)}`).not.toBe(true);
      expect(transactionLog, name).toEqual([SERIALIZABLE_BEGIN]);
    }
  });

  test("capture_thought is three transactions around its two provider calls", async () => {
    // Section 4.4 forbids holding a `pg` connection across an outbound call, and
    // the gate makes two, so the one-transaction rule has exactly one exception
    // and this is its shape: authorize, call out, re-authorize, call out,
    // re-authorize and apply. The middle one is read only because gathering
    // candidates and covering facts must not be able to write.
    setClassifier(async () => classified("ADD"));
    transactionLog = [];
    const stored = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs(),
    );
    expect(stored.isError, text(stored)).not.toBe(true);
    expect(transactionLog).toEqual([
      SERIALIZABLE_BEGIN,
      READ_ONLY_BEGIN,
      SERIALIZABLE_BEGIN,
    ]);

    // A provider-free refusal never reaches either call, so it costs one.
    transactionLog = [];
    const ungrounded = await callTool(fixture.keyWrite.id, "capture_thought", {
      content: `Ungrounded ${randomBytes(3).toString("hex")}.`,
    });
    expect(text(ungrounded)).toContain("Disposition: needs_confirmation");
    expect(transactionLog).toEqual([SERIALIZABLE_BEGIN]);
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

    // And so does a capture denied at the destination, for the same reason:
    // the refusal happens in the first transaction, before anything outbound.
    transactionLog = [];
    const capture = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs({ spaceId: fixture.spaceB }),
    );
    expect(capture.isError).toBe(true);
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
  // capture_thought's admission gate
  // -------------------------------------------------------------------------

  test("capture_thought advertises the deduplicating contract it honors", async () => {
    // The i4 follow-up made the hint and the description untrue of the
    // PostgreSQL lane, which stored a duplicate and skipped nothing sensitive.
    // The admission gate is ported, so both claims hold again. Checked where a
    // client reads them rather than at the constant.
    const listed = async (credential: McpServerCredential) => {
      const server = createMcpServer(credential, "user-test:key-test", null);
      const client = new Client({ name: "postgres-writes", version: "1" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([
          server.connect(serverTransport),
          client.connect(clientTransport),
        ]);
        const { tools } = await client.listTools();
        return tools.find((tool) => tool.name === "capture_thought")!;
      } finally {
        await client.close();
        await server.close();
      }
    };

    const advertised = await listed(credentialFor(fixture.keyWrite.id));
    expect(advertised.annotations?.idempotentHint).toBe(true);
    expect(advertised.description).toContain(
      "The server deduplicates and preserves changed or corrected prior information as linked history.",
    );
  });

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

  /** One thought row, by id, straight from the table. */
  async function storedThought(id: string) {
    const found = await pool.query(
      `SELECT content, metadata, memory_status, superseded_by, supersedes,
              change_reason, space_id
         FROM kith.thoughts WHERE id = $1`,
      [id],
    );
    return found.rows[0] ?? null;
  }

  function citationOf(result: unknown): string | null {
    return /Citation: thought:(\S+)/.exec(text(result))?.[1] ?? null;
  }

  async function thoughtsIn(spaceId: string): Promise<number> {
    const counted = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM kith.thoughts WHERE space_id = $1",
      [spaceId],
    );
    return counted.rows[0]!.n;
  }

  test("ADD stores the classifier's metadata, not the fallback", async () => {
    setClassifier(async () =>
      classified("ADD", {
        summary: "Quarterly ledger review",
        topics: ["ledger", "cadence"],
        people: ["Rowan"],
      }),
    );
    const stored = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs(),
    );
    expect(stored.isError, text(stored)).not.toBe(true);
    expect(text(stored)).toContain("Disposition: stored");
    expect(text(stored)).toContain("Type: decision");
    expect(text(stored)).toContain("Topics: ledger, cadence");
    expect(text(stored)).toContain("People: Rowan");
    expect(text(stored)).toContain("Summary: Quarterly ledger review");

    const row = await storedThought(citationOf(stored)!);
    expect(row.metadata.summary).toBe("Quarterly ledger review");
    expect(row.metadata.type).toBe("decision");
    expect(row.memory_status).toBe("current");
  });

  test("NOOP answers with the memory it cited and writes nothing", async () => {
    setClassifier(async () => classified("ADD"));
    const first = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs(),
    );
    const existing = citationOf(first)!;
    const before = await thoughtsIn(fixture.spaceA);

    setClassifier(async () =>
      classified("NOOP", { relatedThoughtIds: [existing] }),
    );
    const duplicate = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs(),
    );
    expect(text(duplicate)).toContain("Disposition: duplicate");
    expect(text(duplicate)).toContain("Thought already captured");
    expect(citationOf(duplicate)).toBe(existing);
    expect(await thoughtsIn(fixture.spaceA)).toBe(before);
  });

  test("SUPERSEDE stores the replacement and retires the previous memory", async () => {
    setClassifier(async () => classified("ADD"));
    const first = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs({ content: "Rowan attends Lakeside School." }),
    );
    const previous = citationOf(first)!;

    setClassifier(async () =>
      classified("SUPERSEDE", {
        relatedThoughtIds: [previous],
        reason: "The school changed",
        replacementContent:
          "Rowan currently attends Redwood Academy. He previously attended Lakeside School.",
        summary: "Attends Redwood Academy",
      }),
    );
    const superseded = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs({ content: "Rowan attends Redwood Academy." }),
    );
    expect(text(superseded)).toContain("Disposition: superseded");
    expect(text(superseded)).toContain(
      "preserved 1 previous memory as historical",
    );

    const replacement = await storedThought(citationOf(superseded)!);
    expect(replacement.content).toContain("previously attended Lakeside");
    expect(replacement.supersedes).toEqual([previous]);
    const retired = await storedThought(previous);
    expect(retired.memory_status).toBe("superseded");
    expect(retired.superseded_by).toBe(citationOf(superseded));
    expect(retired.change_reason).toBe("The school changed");
  });

  test("RETRACT marks the previous memory inaccurate", async () => {
    setClassifier(async () => classified("ADD"));
    const first = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs({ content: "The synthetic vehicle is a sedan." }),
    );
    const previous = citationOf(first)!;

    setClassifier(async () =>
      classified("RETRACT", {
        relatedThoughtIds: [previous],
        reason: "The earlier claim was wrong",
        replacementContent:
          "The synthetic vehicle is a wagon. The earlier record calling it a sedan was inaccurate.",
      }),
    );
    const corrected = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs({ content: "The synthetic vehicle is a wagon." }),
    );
    expect(text(corrected)).toContain("Disposition: corrected");
    expect(text(corrected)).toContain(
      "marked 1 previous memory as inaccurate",
    );
    expect((await storedThought(previous)).memory_status).toBe("retracted");
  });

  test("ASK and SKIP store nothing, and SKIP covers credentials", async () => {
    const before = await thoughtsIn(fixture.spaceA);

    setClassifier(async () =>
      classified("ASK", { reason: "route this to remember_fact" }),
    );
    const asked = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs({ content: "Rowan's employer is Northwind." }),
    );
    expect(text(asked)).toContain("Disposition: needs_confirmation");
    expect(text(asked)).toContain(
      "Memory was not stored: route this to remember_fact",
    );

    // The ported prompt's SKIP rules name credentials and secrets outright.
    // The synthetic token below is not a credential; what is asserted is that a
    // SKIP leaves no row anywhere, so nothing of the kind can be retained.
    const secret = `sk-synthetic-not-a-real-token-${randomBytes(4).toString("hex")}`;
    setClassifier(async () =>
      classified("SKIP", { reason: "credentials are never stored" }),
    );
    const skipped = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs({ content: `The service token is ${secret}.` }),
    );
    expect(text(skipped)).toContain("Disposition: skipped");
    expect(text(skipped)).toContain(
      "Memory was skipped: credentials are never stored",
    );
    expect(text(skipped)).not.toContain("Citation:");

    expect(await thoughtsIn(fixture.spaceA)).toBe(before);
    const leaked = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM kith.thoughts WHERE content LIKE $1",
      [`%${secret}%`],
    );
    expect(leaked.rows[0]!.n).toBe(0);
  });

  test("an unavailable classifier fails closed and stores nothing", async () => {
    const before = await thoughtsIn(fixture.spaceA);
    // The default seam already answers `null`; stating it makes the case read
    // as what it is rather than as a case that forgot to set one.
    setClassifier(async () => null);
    const declined = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs(),
    );
    expect(declined.isError).not.toBe(true);
    expect(text(declined)).toContain("Disposition: needs_confirmation");
    expect(text(declined)).toContain(
      "Memory was not stored because the admission check was unavailable",
    );
    expect(text(declined)).not.toContain("Citation:");
    expect(await thoughtsIn(fixture.spaceA)).toBe(before);

    // A classifier that throws is the same answer: it is caught and read as
    // null, and nothing about the failure reaches the client.
    setClassifier(async () => {
      throw new Error("provider said: synthetic-key is invalid");
    });
    const threw = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs(),
    );
    expect(text(threw)).toContain(
      "Memory was not stored because the admission check was unavailable",
    );
    expect(text(threw)).not.toContain("synthetic-key");
    expect(await thoughtsIn(fixture.spaceA)).toBe(before);
  });

  test("the gate sees covering facts from the destination space only", async () => {
    const subject = `Rowan ${randomBytes(3).toString("hex")}`;
    const stored = await callTool(
      fixture.keyWrite.id,
      "remember_fact",
      factArgs({ subject: { kind: "person", name: subject } }),
    );
    const { factId } = JSON.parse(text(stored)) as { factId: string };

    const seen = setClassifier(async () =>
      classified("NOOP", { relatedThoughtIds: [factId] }),
    );
    const duplicate = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs({ content: `${subject} lives in Oakland.` }),
    );
    expect(text(duplicate)).toContain("Disposition: duplicate");
    expect(text(duplicate)).toContain("Already recorded as a structured fact");
    expect(text(duplicate)).not.toContain("Citation:");

    // Everything the classifier was shown came from the destination space.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.coveringFacts.some((fact) => fact.id === factId)).toBe(
      true,
    );
  });

  test("the vector leg runs on a complete index and reaches one space only", async () => {
    // The case that needs a real index: without one the gate takes its keyword
    // leg, the embedder is never called, and a candidate-isolation assertion
    // over an empty list proves nothing.
    const writer = await isolatedWriter();
    const call = (name: string, args: Record<string, unknown>) =>
      callTool(writer.keyId, name, args, writer.userId);
    const personalIndex = await seedActiveIndex(writer.personal);
    const sharedIndex = await seedActiveIndex(writer.shared);

    // A freshly seeded index has zero eligible and zero covered targets, which
    // is "complete" and therefore ready, so even the seeding captures reach the
    // embedder. That is the behaviour under test; it just means the embedder
    // has to be wired before them.
    const subject = `quarterly ledger review ${randomBytes(3).toString("hex")}`;
    setEmbedder(async () => ({
      vector: oneHot(0),
      fingerprint: personalIndex.fingerprint,
    }));
    setClassifier(async () => classified("ADD"));
    const mine = await call("capture_thought", captureArgs({ content: subject }));
    // The isolation control: the same words, in the other space, with its own
    // complete index. It is the nearest possible row and must never appear.
    const foreign = await call(
      "capture_thought",
      captureArgs({ content: subject, spaceId: writer.shared }),
    );
    expect(text(mine)).toContain("Disposition: stored");
    expect(text(foreign)).toContain("Disposition: stored");
    const mineId = citationOf(mine)!;
    const foreignId = citationOf(foreign)!;

    await makeIndexReady(writer.personal, personalIndex);
    await makeIndexReady(writer.shared, sharedIndex);

    let embedded = 0;
    setEmbedder(async () => {
      embedded += 1;
      return { vector: oneHot(0), fingerprint: personalIndex.fingerprint };
    });
    const seen = setClassifier(async () => classified("ADD"));
    const next = await call(
      "capture_thought",
      captureArgs({ content: `${subject} and its cadence` }),
    );
    expect(text(next)).toContain("Disposition: stored");

    // The embedder was reached, which is what a complete index buys.
    expect(embedded).toBe(1);
    const ids = seen[0]!.candidates.map((candidate) => candidate.id);
    expect(ids).toContain(mineId);
    expect(ids).not.toContain(foreignId);
    const spaces = await pool.query<{ space_id: string }>(
      "SELECT DISTINCT space_id FROM kith.thoughts WHERE id = ANY($1::text[])",
      [ids],
    );
    expect(spaces.rows.map((row) => row.space_id)).toEqual([writer.personal]);
  });

  test("an incomplete index takes the keyword leg without calling the embedder", async () => {
    // The reproduction, through the tool. A stored capture leaves an eligible,
    // uncovered target, so its own space's thought index reports itself
    // incomplete and the vector leg would drop every candidate. Before the
    // keyword leg existed the next capture was blind, and a retried one stored
    // a duplicate.
    const writer = await isolatedWriter();
    const index = await seedActiveIndex(writer.personal);
    const subject = `synthetic bicycle maintenance ${randomBytes(3).toString("hex")}`;

    setEmbedder(async () => ({
      vector: oneHot(0),
      fingerprint: index.fingerprint,
    }));
    setClassifier(async () => classified("ADD"));
    const first = await callTool(
      writer.keyId,
      "capture_thought",
      captureArgs({ content: subject }),
      writer.userId,
    );
    expect(text(first)).toContain("Disposition: stored");
    const firstId = citationOf(first)!;

    // That store left an eligible, uncovered target. No fill runs, so the
    // index is incomplete from here on.
    let embedded = 0;
    setEmbedder(async () => {
      embedded += 1;
      return { vector: oneHot(0), fingerprint: index.fingerprint };
    });
    const seen = setClassifier(async () => classified("ADD"));
    const second = await callTool(
      writer.keyId,
      "capture_thought",
      captureArgs({ content: `${subject} continues` }),
      writer.userId,
    );
    expect(text(second)).toContain("Disposition: stored");

    // The memory text never went to the provider, and the gate still saw the
    // first memory.
    expect(embedded).toBe(0);
    expect(seen[0]!.candidates.map((candidate) => candidate.id)).toContain(
      firstId,
    );
  });

  test("a retried identical capture stores one memory, not two", async () => {
    // What the keyword leg cannot be relied on for. Two byte-identical
    // captures seconds apart from one author is a host retrying a call whose
    // response it lost; the classifier may still say ADD, and the store
    // refuses the second write on its own.
    const writer = await isolatedWriter();
    const content = `The synthetic household files receipts weekly (${randomBytes(4).toString("hex")}).`;
    setClassifier(async () => classified("ADD"));

    const first = await callTool(
      writer.keyId,
      "capture_thought",
      captureArgs({ content }),
      writer.userId,
    );
    expect(text(first)).toContain("Disposition: stored");
    const retry = await callTool(
      writer.keyId,
      "capture_thought",
      captureArgs({ content }),
      writer.userId,
    );
    expect(text(retry)).toContain("Disposition: duplicate");
    expect(text(retry)).toContain("Thought already captured");
    expect(citationOf(retry)).toBe(citationOf(first));
    expect(await thoughtsIn(writer.personal)).toBe(1);
  });

  test("an embedder that fails or disagrees with the index fails closed", async () => {
    const writer = await isolatedWriter();
    const index = await seedActiveIndex(writer.personal);
    setEmbedder(async () => ({
      vector: oneHot(0),
      fingerprint: index.fingerprint,
    }));
    setClassifier(async () => classified("ADD"));
    const seed = await callTool(
      writer.keyId,
      "capture_thought",
      captureArgs({
        content: `A seeded memory ${randomBytes(3).toString("hex")}.`,
      }),
      writer.userId,
    );
    expect(text(seed)).toContain("Disposition: stored");
    await makeIndexReady(writer.personal, index);
    const before = await thoughtsIn(writer.personal);

    // The index says it is complete, so the vector leg is the comparison set
    // this capture was going to be judged against. Losing it after asking for
    // it is the admission check failing, not degrading.
    let classified_calls = 0;
    setClassifier(async () => {
      classified_calls += 1;
      return classified("ADD");
    });
    setEmbedder(async () => {
      throw new Error("provider said: synthetic-key is invalid");
    });
    const threw = await callTool(
      writer.keyId,
      "capture_thought",
      captureArgs(),
      writer.userId,
    );
    expect(threw.isError).not.toBe(true);
    expect(text(threw)).toContain("Disposition: needs_confirmation");
    expect(text(threw)).toContain(
      "Memory was not stored because the admission check was unavailable",
    );
    expect(text(threw)).not.toContain("synthetic-key");
    expect(text(threw)).not.toContain("provider said");

    // A provider whose profile disagrees with the index is the same answer: a
    // vector from another profile is not comparable with these rows.
    setEmbedder(async () => ({
      vector: oneHot(0),
      fingerprint: "f".repeat(64),
    }));
    const mismatched = await callTool(
      writer.keyId,
      "capture_thought",
      captureArgs(),
      writer.userId,
    );
    expect(text(mismatched)).toContain("Disposition: needs_confirmation");
    expect(text(mismatched)).toContain(
      "Memory was not stored because the admission check was unavailable",
    );

    // Neither reached the classifier, and neither stored anything.
    expect(classified_calls).toBe(0);
    expect(await thoughtsIn(writer.personal)).toBe(before);
  });

  test("a key revoked during the provider calls denies the write", async () => {
    const key = await inTransaction((ctx) =>
      createApiKey(ctx, {
        principal: {
          userId: fixture.userId,
          capabilities: ["read", "write", "ingest"] as const,
        },
        name: "revoked mid-gate",
        capabilities: ["read", "write"],
        spaceIds: [fixture.spaceA],
      }),
    );
    const before = await thoughtsIn(fixture.spaceA);

    // The revocation lands where the gate is outside every transaction, which
    // is the window the two re-authorizations exist to close.
    setClassifier(async () => {
      await pool.query("DELETE FROM kith.api_keys WHERE id = $1", [key.id]);
      return classified("ADD");
    });
    const denied = await callTool(key.id, "capture_thought", captureArgs());
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("Not authenticated");
    expect(await thoughtsIn(fixture.spaceA)).toBe(before);
  });

  test("an embedding failure fails closed, and no index means no provider call", async () => {
    const before = await thoughtsIn(fixture.spaceA);
    // No active embedding index on this space, so there is nothing to search
    // and the memory never leaves the process: the embedder is not called and
    // the classifier still runs against covering facts alone.
    let embedded = 0;
    setEmbedder(async () => {
      embedded += 1;
      throw new Error("provider said: synthetic-key is invalid");
    });
    setClassifier(async () => classified("ADD"));
    const stored = await callTool(
      fixture.keyWrite.id,
      "capture_thought",
      captureArgs(),
    );
    expect(embedded).toBe(0);
    expect(text(stored)).toContain("Disposition: stored");
    expect(await thoughtsIn(fixture.spaceA)).toBe(before + 1);
  });

  test("Quick Capture runs the same gate and labels its own grounding", async () => {
    // i5 has not landed, so there is no route to drive; this is the handler's
    // core, which the route will call. `sourceType` is not an argument: a
    // person typed the words into their own browser, which is what
    // `publicActions.capture` means by `user_confirmed`.
    const seen = setClassifier(async () =>
      classified("ADD", { summary: "Typed into the browser" }),
    );
    const content = `The synthetic household reviews the ledger (${randomBytes(3).toString("hex")}).`;
    const result = await captureThoughtFromWeb(
      mcpPrincipalLoader({
        userId: fixture.userId,
        credentialId: fixture.keyWrite.id,
      }),
      { content },
    );
    expect(result.disposition).toBe("stored");
    expect(result.metadata.summary).toBe("Typed into the browser");
    expect(seen[0]!.sourceType).toBe("user_confirmed");
    const row = await storedThought(result.thoughtId!);
    expect(row.space_id).toBe(fixture.spaceA);

    // And the gate's refusals reach Quick Capture unchanged.
    setClassifier(async () => null);
    const declined = await captureThoughtFromWeb(
      mcpPrincipalLoader({
        userId: fixture.userId,
        credentialId: fixture.keyWrite.id,
      }),
      { content: `Another synthetic note ${randomBytes(3).toString("hex")}.` },
    );
    expect(declined.disposition).toBe("needs_confirmation");
    expect(declined.thoughtId).toBeUndefined();
    expect(declined.operationSummary).toBe(
      "Memory was not stored because the admission check was unavailable",
    );
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
  });

  test("the web route's error table matches the store adapter's, code for code", async () => {
    // There really are two tables, and this compares them. The second is
    // `packages/kith-store/src/workers/http.ts`'s `WORKER_ERRORS`, which is
    // what `handlePostgresWorkerRequest` answers from. If the store adds a code
    // or changes a status, a worker would get one answer from the adapter and
    // another from this route, and this is where that shows up.
    const codes = Object.keys(
      workers.WORKER_ERRORS,
    ) as WorkerProtocolErrorCode[];
    expect(codes).toHaveLength(14);

    for (const code of codes) {
      const [status, message] = workers.WORKER_ERRORS[code];
      const web = workerErrorForCode(code);
      expect([web.status, web.code, web.message], code).toEqual([
        status,
        code,
        message,
      ]);
      // And the store's own classifier reaches the same row, so a refusal the
      // dispatcher raises lands where the adapter's does.
      expect(
        workers.workerProtocolErrorCode(
          Object.assign(new Error("private detail"), {
            data: { type: "worker_protocol_error", code },
          }),
        ),
        code,
      ).toBe(code);
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
