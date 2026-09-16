// The 14 MCP read tools on the PostgreSQL surface, against a real database.
//
// One synthetic fixture, two spaces, and one credential granted only the first
// of them. Every case goes through the MCP client and the registered tool, not
// through `@repo/kith-store` directly: what i3 has to hold is that the tool
// answers the same question it answered on Convex, from the store, inside one
// transaction, and none of that is visible from a service call.
//
// Three properties are asserted for every tool rather than described:
//
//   * Content. The tool's own JSON is compared against the Convex path's JSON
//     for the same rows. `sameAsConvex` drives the Convex-mocked server with
//     the Convex-shaped rows this fixture holds and requires the two answers to
//     be identical text, so a field that is renamed, dropped, reordered or
//     turned from `undefined` into `null` fails here.
//   * Space isolation. A credential granted space A never sees a space B row,
//     and naming space B explicitly is refused rather than silently narrowed.
//   * One transaction. `transactionLog` records every `BEGIN` the pool issues,
//     so a tool that opened two, or opened a writable one, is visible.
//
// A throwaway database per run, created and dropped here, and synthetic rows
// only. The suite skips cleanly when `KITH_STORE_DATABASE_URL` is not set.

import { randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  applyKithSchema,
  createKithPool,
  memory,
  newKithId,
  provenance,
  withKithTransaction,
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

const convexMocks = vi.hoisted(() => ({
  query: vi.fn(),
  action: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = convexMocks.query;
    action = convexMocks.action;
    mutation = convexMocks.mutation;
    setAuth() {}
  },
}));

import type { FinanceArchiveAccess } from "./finance";
import { mcpPrincipalLoader } from "./principal";
import { setMcpEmbedder } from "./reads";
import { createMcpServer, type McpServerCredential } from "./server";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";
const DOCUMENT_TEXT = "The quarterly statement total is settled.";
const SHARED_DOCUMENT_TEXT = "The quarterly statement total is shared.";
/** Fixed capture times, one minute apart, so the timeline window is ordered. */
const THOUGHT_EPOCH = Date.UTC(2026, 1, 1, 12, 0, 0);
/** A fixed fact creation time, so the Convex comparison can state it. */
const FACT_EPOCH = Date.UTC(2026, 1, 1, 13, 0, 0);

type Fixture = {
  userId: string;
  keyIdA: string;
  keyIdBoth: string;
  spaceA: string;
  spaceB: string;
  personalName: string;
  sharedName: string;
  coreThoughtA: string;
  taskThoughtA: string;
  thoughtB: string;
  factA: string;
  entityA: string;
  documentA: string;
  documentB: string;
  sourceAccountA: string;
  sourceAccountB: string;
};

describeWithDatabase("MCP read tools on PostgreSQL", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;
  let fixture: Fixture;
  /** Every `BEGIN` the pool issued since the last reset. */
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

  /**
   * The pool the app sees, with every `BEGIN` recorded.
   *
   * A wrapper rather than a spy on `pg`: `withKithReadTransaction` checks out
   * its own client, and recording at `connect` is the only place that sees the
   * statement the transaction actually opened with.
   */
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

  /** The metadata shape every thought row carries. */
  function metadata(
    summary: string,
    type: memory.ThoughtType,
    topics: string[],
    people: string[] = [],
  ): memory.ThoughtMetadata {
    return { type, topics, people, actionItems: [], summary };
  }

  /**
   * One readable document: item, revision, text version, page, span,
   * generation, document and chunk, activated. The recipe is the store's own
   * (`test/parsedStagingAndDocuments.test.mjs`); nothing here writes a row a
   * real ingestion would not.
   */
  async function seedDocument(
    client: pg.ClientBase,
    input: {
      spaceId: string;
      userId: string;
      externalId: string;
      title: string;
      text: string;
    },
  ): Promise<{ documentId: string; sourceAccountId: string }> {
    const sourceAccountId = newKithId();
    await client.query(
      `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
         VALUES ($1, $2, transaction_timestamp(), 'synthetic', true)`,
      [sourceAccountId, input.spaceId],
    );
    const item = await provenance.createOrGetSourceItem(client, {
      spaceId: input.spaceId,
      sourceAccountId,
      externalId: input.externalId,
      title: input.title,
    });
    const revision = await provenance.createOrGetRevision(client, {
      spaceId: input.spaceId,
      sourceItemId: item.id,
      mediaType: "text/plain",
      inlineText: input.text,
      capturedAt: new Date("2026-02-01T00:00:00Z"),
      userId: input.userId,
    });
    const textVersion = await provenance.createOrGetTextVersion(client, {
      spaceId: input.spaceId,
      sourceRevisionId: revision.id,
      extractionFingerprint: "extract-v1",
      text: input.text,
    });
    const [page] = await provenance.stagePages(client, {
      spaceId: input.spaceId,
      sourceTextVersionId: textVersion.id,
      pages: [{ ordinal: 0, start: 0, end: input.text.length, text: input.text }],
    });
    const [span] = await provenance.stageEvidenceSpans(client, {
      spaceId: input.spaceId,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      spans: [{ sourcePageId: page!.id, ordinal: 0, start: 4, end: 13 }],
    });
    await provenance.setDesiredSourceRevision(client, {
      spaceId: input.spaceId,
      sourceItemId: item.id,
      desiredRevisionId: revision.id,
      expectedDesiredProcessingEpoch: 0,
    });
    const generationId = newKithId();
    await client.query(
      `INSERT INTO kith.processing_generations
         (id, space_id, created_at, source_account_id, source_item_id,
          source_revision_id, source_text_version_id, desired_processing_epoch,
          card_generation, state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 1, false, 'queued')`,
      [
        generationId,
        input.spaceId,
        sourceAccountId,
        item.id,
        revision.id,
        textVersion.id,
      ],
    );
    const [document] = await provenance.stageDocuments(client, {
      spaceId: input.spaceId,
      processingGenerationId: generationId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      documents: [
        {
          documentKey: "doc-1",
          title: input.title,
          docType: "statement",
          capturedAt: new Date("2026-02-01T00:00:00Z"),
          evidenceSpanIds: [span!.id],
        },
      ],
    });
    await provenance.stageChunks(client, {
      spaceId: input.spaceId,
      processingGenerationId: generationId,
      chunks: [
        {
          documentId: document!.id,
          ordinal: 0,
          text: input.text,
          evidenceSpanIds: [span!.id],
        },
      ],
    });
    await provenance.activateSourceItemGeneration(client, {
      spaceId: input.spaceId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      processingGenerationId: generationId,
      expectedDesiredProcessingEpoch: 1,
    });
    await client.query(
      `UPDATE kith.processing_generations
          SET state = 'ready', activated_at = transaction_timestamp()
        WHERE id = $1`,
      [generationId],
    );
    return { documentId: document!.id, sourceAccountId };
  }

  /** The review-queue rows, which no ported writer owns yet. */
  async function seedReviewRows(
    client: pg.ClientBase,
    spaceId: string,
    sourceAccountId: string,
    userId: string,
    credentialId: string,
    reason: string,
  ) {
    const scanId = newKithId();
    await client.query(
      `INSERT INTO kith.worker_source_scans
         (id, space_id, created_at, source_account_id, request_id, request_digest,
          watcher_id, connector_version, mode, inventory_epoch,
          manifest_version_at_begin, actor_user_id, actor_credential_id, state,
          next_page_ordinal, next_reconcile_ordinal, inventory_done, page_count,
          entry_count, changed_count, gap_count, review_count, started_at,
          expires_at, retire_at)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, 'fixture-watcher',
               'fixture-connector', 'normal', 0, 0, $6, $7, 'enumerated', 1, 1,
               true, 0, 0, 0, 0, 0, transaction_timestamp(),
               transaction_timestamp(), transaction_timestamp())`,
      [
        scanId,
        spaceId,
        sourceAccountId,
        scanId,
        `${scanId}-digest`,
        userId,
        credentialId,
      ],
    );
    await client.query(
      `INSERT INTO kith.source_inventory
         (id, space_id, created_at, source_account_id, identity_key_hash,
          relative_path, folder_path, file_name, modified_at, content_indexed,
          exclusion_reason, first_seen_scan_id, last_seen_scan_id)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'folder/skipped.bin',
               'folder', 'skipped.bin', transaction_timestamp(), false, $5, $6, $6)`,
      [
        newKithId(),
        spaceId,
        sourceAccountId,
        randomBytes(32).toString("hex"),
        reason,
        scanId,
      ],
    );
    await client.query(
      `INSERT INTO kith.card_field_drops
         (id, space_id, created_at, source_account_id, record_kind, kind,
          field_key, code, created_at_field)
       VALUES ($1, $2, transaction_timestamp(), $3, 'lab_panel', 'field_dropped',
               'result_value', $4, transaction_timestamp())`,
      [newKithId(), spaceId, sourceAccountId, reason],
    );
  }

  async function buildFixture(): Promise<Fixture> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `mcp-reads-${randomBytes(4).toString("hex")}@example.test`,
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
      const personal = await ctx.client.query<{ name: string }>(
        "SELECT name FROM kith.spaces WHERE id = $1",
        [spaceA],
      );

      const principal = {
        userId,
        capabilities: ["read", "write"] as const,
      };
      const keyA = await createApiKey(ctx, {
        principal,
        name: "Synthetic MCP client, one space",
        capabilities: ["read", "write"],
        spaceIds: [spaceA],
      });
      const keyBoth = await createApiKey(ctx, {
        principal,
        name: "Synthetic MCP client, both spaces",
        capabilities: ["read", "write"],
        spaceIds: [spaceA, spaceB],
      });

      const coreThought = await memory.captureThought(ctx, userId, spaceA, {
        content: "Keep the synthetic household ledger current each quarter.",
        metadata: metadata(
          "Ledger upkeep",
          "decision",
          ["ledger"],
          ["Rowan"],
        ),
        isCore: true,
        sourceType: "user_stated",
      });
      const taskThought = await memory.captureThought(ctx, userId, spaceA, {
        content: "Book the synthetic clinic appointment before the quarter ends.",
        metadata: metadata("Clinic booking", "task", ["clinic"]),
        sourceType: "user_stated",
      });
      const sharedThought = await memory.captureThought(ctx, userId, spaceB, {
        content: "The shared archive ledger is reconciled monthly.",
        metadata: metadata("Shared ledger", "decision", ["ledger"], ["Wren"]),
        sourceType: "user_stated",
      });

      // Distinct creation times. The whole fixture is one transaction and
      // `ctx.now` is fixed for it, so every capture would otherwise share one
      // `created_at` and the timeline window would have no order to find.
      for (const [index, id] of [coreThought, taskThought, sharedThought].entries()) {
        await ctx.client.query(
          "UPDATE kith.thoughts SET created_at = $2 WHERE id = $1",
          [id, new Date(THOUGHT_EPOCH + index * 60_000)],
        );
      }

      const fact = await memory.rememberFact(ctx, userId, spaceA, {
        subject: { kind: "person", name: "Rowan" },
        predicate: "home_city",
        value: { type: "text", value: "Oakland" },
        sourceType: "user_stated",
        isCore: true,
      });
      await memory.rememberFact(ctx, userId, spaceB, {
        subject: { kind: "person", name: "Wren" },
        predicate: "home_city",
        value: { type: "text", value: "Berkeley" },
        sourceType: "user_stated",
      });

      // A stated creation time, for the same reason the thoughts have one:
      // `ctx.now` is fixed for the fixture transaction, and a comparison
      // against hand-written Convex rows has to be able to name it.
      await ctx.client.query(
        "UPDATE kith.facts SET created_at = $2 WHERE id = $1",
        [fact.factId, new Date(FACT_EPOCH)],
      );
      const subject = await ctx.client.query<{ subject_entity_id: string }>(
        "SELECT subject_entity_id FROM kith.facts WHERE id = $1",
        [fact.factId],
      );

      const docA = await seedDocument(ctx.client, {
        spaceId: spaceA,
        userId,
        externalId: "fixture/personal.txt",
        title: "Quarterly statement",
        text: DOCUMENT_TEXT,
      });
      const docB = await seedDocument(ctx.client, {
        spaceId: spaceB,
        userId,
        externalId: "fixture/shared.txt",
        title: "Shared quarterly statement",
        text: SHARED_DOCUMENT_TEXT,
      });
      await seedReviewRows(
        ctx.client,
        spaceA,
        docA.sourceAccountId,
        userId,
        keyA.id,
        "unsupported",
      );
      await seedReviewRows(
        ctx.client,
        spaceB,
        docB.sourceAccountId,
        userId,
        keyA.id,
        "oversized",
      );

      return {
        userId,
        keyIdA: keyA.id,
        keyIdBoth: keyBoth.id,
        spaceA,
        spaceB,
        personalName: personal.rows[0]!.name,
        sharedName: "Shared archive",
        coreThoughtA: coreThought,
        taskThoughtA: taskThought,
        thoughtB: sharedThought,
        factA: fact.factId,
        entityA: subject.rows[0]!.subject_entity_id,
        documentA: docA.documentId,
        documentB: docB.documentId,
        sourceAccountA: docA.sourceAccountId,
        sourceAccountB: docB.sourceAccountId,
      };
    });
  }

  beforeAll(async () => {
    databaseName = `kith_mcp_reads_test_${randomBytes(8).toString("hex")}`;
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

  async function call(
    credential: McpServerCredential | string,
    name: string,
    args: Record<string, unknown>,
    // No finance archive by default: `query_records`'s finance leg is
    // unchanged by i3 and has its own suite, and `list_sources` must not gain
    // a block from it in the cases that are about its own rows.
    financeArchive: FinanceArchiveAccess | null = null,
  ) {
    const server = createMcpServer(
      credential,
      "user-test:key-test",
      financeArchive,
    );
    const client = new Client({ name: "postgres-reads", version: "1" });
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

  function credentialFor(keyId: string): McpServerCredential {
    return {
      surface: "postgres",
      withPrincipal: mcpPrincipalLoader({
        userId: fixture.userId,
        credentialId: keyId,
      }),
    };
  }

  /** One tool call on the PostgreSQL surface with the one-space credential. */
  function onPostgres(name: string, args: Record<string, unknown> = {}) {
    return call(credentialFor(fixture.keyIdA), name, args);
  }

  function onBothSpaces(name: string, args: Record<string, unknown> = {}) {
    return call(credentialFor(fixture.keyIdBoth), name, args);
  }

  function onConvex(name: string, args: Record<string, unknown> = {}) {
    return call("synthetic-convex-token", name, args);
  }

  function text(result: unknown): string {
    const content = (result as { content?: Array<{ text?: string }> }).content;
    return content?.[0]?.text ?? "";
  }

  function parsed(result: unknown): unknown {
    return JSON.parse(text(result));
  }

  /**
   * The same tool, the same arguments, on both surfaces, with the Convex path
   * fed the Convex-shaped rows this fixture holds. The two answers have to be
   * identical text.
   */
  async function sameAsConvex(
    name: string,
    args: Record<string, unknown>,
    convexRows: () => void,
  ) {
    const postgres = await onPostgres(name, args);
    transactionLog = [];
    convexRows();
    const convex = await onConvex(name, args);
    expect(text(convex)).toBe(text(postgres));
    return postgres;
  }

  // -------------------------------------------------------------------------
  // One transaction per call
  // -------------------------------------------------------------------------

  const READ_ONLY_BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

  test("every read tool opens only read-only transactions, and no more than it needs", async () => {
    // One transaction each, except the three tools that may embed the query.
    // Those open a short read-only transaction first to reload the credential,
    // resolve the space set and check the index, so an unauthorized caller's
    // text never reaches the embedding provider; the tool's own transaction
    // follows and is still the authority. `search_documents` in `keyword` mode
    // skips the probe entirely, which the last row asserts.
    const readCalls: Array<[string, Record<string, unknown>, number]> = [
      ["list_spaces", {}, 1],
      ["get_document", { documentId: fixture.documentA }, 1],
      ["list_sources", {}, 1],
      ["list_inventory", { sourceAccountId: fixture.sourceAccountA }, 1],
      ["list_review_queue", { sourceAccountId: fixture.sourceAccountA }, 1],
      ["search_facts", { query: "Oakland" }, 1],
      ["browse_recent", {}, 1],
      ["get_thoughts", { ids: [fixture.coreThoughtA] }, 1],
      ["timeline_thoughts", { seedId: fixture.coreThoughtA }, 1],
      ["get_stats", {}, 1],
      ["search_documents", { query: "quarterly", searchMode: "keyword" }, 1],
      ["search_documents", { query: "quarterly" }, 2],
      ["search_thoughts", { query: "ledger" }, 2],
      ["recall_context", { query: "ledger" }, 2],
    ];
    for (const [name, args, transactions] of readCalls) {
      transactionLog = [];
      const result = await onPostgres(name, args);
      expect(result.isError, `${name} failed: ${text(result)}`).not.toBe(true);
      expect(transactionLog, `${name} ${JSON.stringify(args)}`).toEqual(
        Array.from({ length: transactions }, () => READ_ONLY_BEGIN),
      );
    }
  });


  test("an unauthorized query never reaches the embedding provider", async () => {
    // The order the review asked for, asserted at the only place it is
    // observable: the provider itself. `prepareEmbedQuery` reloads the
    // credential, resolves the space set and checks the index in a short
    // read-only transaction, and calls the provider only if that leaves one
    // compatible fingerprint.
    const embedded: string[] = [];
    const restore = setMcpEmbedder(async (query) => {
      embedded.push(query);
      throw new Error("synthetic embedding provider outage");
    });
    try {
      // A live credential on a deployment with no compatible index. This is
      // the ordinary case and the expensive one: without the probe, every
      // call would ship the text and throw the vector away.
      for (const name of [
        "search_thoughts",
        "recall_context",
        "search_documents",
      ]) {
        const answered = await onPostgres(name, { query: "ledger" });
        expect(answered.isError, name).not.toBe(true);
      }
      expect(embedded).toEqual([]);

      // A space this credential was not granted is refused before the call.
      const denied = await onPostgres("search_thoughts", {
        query: "ledger",
        spaceIds: [fixture.spaceB],
      });
      expect(denied.isError).toBe(true);
      expect(embedded).toEqual([]);

      // And a credential revoked between two calls is refused before it too.
      const revoked = await inTransaction(async (ctx) => {
        const session = await signUp(ctx, {
          email: `mcp-embed-${randomBytes(4).toString("hex")}@example.test`,
          password: PASSWORD,
        });
        const spaceId = await ensurePersonalSpace(ctx, session.userId);
        const key = await createApiKey(ctx, {
          principal: { userId: session.userId, capabilities: ["read"] as const },
          name: "Synthetic embedder client",
          capabilities: ["read"],
          spaceIds: [spaceId],
        });
        return { userId: session.userId, keyId: key.id };
      });
      await pool.query("DELETE FROM kith.api_keys WHERE id = $1", [
        revoked.keyId,
      ]);
      const gone = await call(
        {
          surface: "postgres",
          withPrincipal: mcpPrincipalLoader({
            userId: revoked.userId,
            credentialId: revoked.keyId,
          }),
        },
        "search_thoughts",
        { query: "ledger" },
      );
      expect(gone.isError).toBe(true);
      expect(text(gone)).toContain("Not authenticated");
      expect(embedded).toEqual([]);
    } finally {
      restore();
    }
  });

  test("list_sources composes its finance block from the same transaction", async () => {
    // The archive is the fixture's own second space, so the block is in scope
    // and the membership check passes. What is under test is that resolving
    // that membership costs no second transaction: the sources read already
    // returned the authorized set.
    const requests: unknown[] = [];
    const archive = {
      spaceId: fixture.spaceB,
      read: async (request: unknown) => {
        requests.push(request);
        return {
          contract: "finance.read.v1",
          datasetRevision: "synthetic",
          coverage: [],
        } as never;
      },
    };
    transactionLog = [];
    const result = await call(
      credentialFor(fixture.keyIdBoth),
      "list_sources",
      {},
      archive,
    );
    expect(result.isError).not.toBe(true);
    expect(transactionLog).toEqual([READ_ONLY_BEGIN]);
    // The archive was asked, and whatever it said is carried in its own block
    // rather than merged into `sources`. Whether the stub's response satisfies
    // the read contract is `finance.test.ts`'s subject, not this one's.
    expect(requests).toHaveLength(1);
    const body = parsed(result) as { financeArchive?: unknown };
    expect(body.financeArchive).toBeDefined();

    // A credential without the archive's space never reaches the archive, and
    // still opens one transaction.
    requests.length = 0;
    transactionLog = [];
    const narrowed = await call(
      credentialFor(fixture.keyIdA),
      "list_sources",
      {},
      archive,
    );
    expect(narrowed.isError).not.toBe(true);
    expect(transactionLog).toEqual([READ_ONLY_BEGIN]);
    expect(requests).toEqual([]);
    expect(
      Object.hasOwn(parsed(narrowed) as object, "financeArchive"),
    ).toBe(false);
  });

  test("a read tool's transaction refuses a write at the server", async () => {
    // Section 4.2's guarantee restated at the pool the tools actually use: the
    // transaction the tools open is the one that refuses a write, so a tool
    // that wrote through a read path could not do it by accident.
    const withPrincipal = mcpPrincipalLoader({
      userId: fixture.userId,
      credentialId: fixture.keyIdA,
    });
    await expect(
      withPrincipal(
        async ({ ctx }) => {
          await ctx.client.query(
            "UPDATE kith.thoughts SET content = 'changed' WHERE id = $1",
            [fixture.coreThoughtA],
          );
        },
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/);
  });

  test("query_records opens one writable transaction, because its cursor is a write", async () => {
    transactionLog = [];
    const result = await onPostgres("query_records", {
      query: {
        operation: "latest_observation",
        spaceId: fixture.spaceA,
        entityId: fixture.entityA,
        observationType: "lab_result",
      },
    });
    expect(result.isError).not.toBe(true);
    // A real entity with no observations is a typed "nothing here vouches for
    // this", not an error and not an empty page presented as complete.
    expect(parsed(result)).toMatchObject({
      operation: "latest_observation",
      status: "no_match_incomplete",
    });
    // `executeRecordQuery` creates, advances or consumes a single-use cursor
    // and takes `FOR UPDATE` locks, neither of which a `READ ONLY` transaction
    // may do. The Convex original is a `mutation` for the same reason.
    expect(transactionLog).toEqual(["BEGIN ISOLATION LEVEL SERIALIZABLE"]);
  });

  // -------------------------------------------------------------------------
  // Per-tool content and isolation
  // -------------------------------------------------------------------------

  test("list_spaces returns the granted spaces with coverage, and only those", async () => {
    const result = await sameAsConvex("list_spaces", {}, () => {
      convexMocks.query.mockResolvedValue([
        {
          spaceId: fixture.spaceA,
          name: fixture.personalName,
          kind: "personal",
          role: "owner",
          coverage: { spaceId: fixture.spaceA, status: "unknown", drift: false },
        },
      ]);
    });
    expect(parsed(result)).toEqual([
      {
        spaceId: fixture.spaceA,
        name: fixture.personalName,
        kind: "personal",
        role: "owner",
        coverage: { spaceId: fixture.spaceA, status: "unknown", drift: false },
      },
    ]);

    const both = parsed(await onBothSpaces("list_spaces", {})) as Array<{
      spaceId: string;
    }>;
    expect(both.map((space) => space.spaceId).sort()).toEqual(
      [fixture.spaceA, fixture.spaceB].sort(),
    );
  });

  test("query_records refuses a space this credential was not granted", async () => {
    const denied = await onPostgres("query_records", {
      query: {
        operation: "latest_observation",
        spaceId: fixture.spaceB,
        entityId: fixture.entityA,
        observationType: "lab_result",
      },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("Space not found");
  });

  test("search_documents answers from the keyword leg and stays in the granted space", async () => {
    const result = parsed(
      await onPostgres("search_documents", { query: "quarterly" }),
    ) as { results: Array<{ documentId: string; title: string }> };
    expect(result.results.map((row) => row.documentId)).toEqual([
      fixture.documentA,
    ]);
    expect(result.results[0]!.title).toBe("Quarterly statement");

    const both = parsed(
      await onBothSpaces("search_documents", { query: "quarterly" }),
    ) as { results: Array<{ documentId: string }> };
    expect(both.results.map((row) => row.documentId).sort()).toEqual(
      [fixture.documentA, fixture.documentB].sort(),
    );

    // Naming the other space with a credential that was not granted it is a
    // denial, not a silently narrowed result.
    const denied = await onPostgres("search_documents", {
      query: "quarterly",
      spaceIds: [fixture.spaceB],
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toBe("Space not found");
  });

  test("get_document returns retained evidence for a granted document only", async () => {
    const result = parsed(
      await onPostgres("get_document", { documentId: fixture.documentA }),
    ) as { documentId: string; title: string; pages: Array<{ text: string }> };
    expect(result.documentId).toBe(fixture.documentA);
    expect(result.title).toBe("Quarterly statement");
    expect(result.pages[0]!.text).toBe(DOCUMENT_TEXT);

    // A document in the other space is unavailable, not a denial that would
    // confirm it exists.
    expect(
      parsed(
        await onPostgres("get_document", { documentId: fixture.documentB }),
      ),
    ).toBeNull();
  });

  test("list_sources lists the granted spaces' source accounts", async () => {
    const result = parsed(await onPostgres("list_sources", {})) as {
      sources: Array<{ sourceAccountId: string }>;
    };
    expect(result.sources.map((row) => row.sourceAccountId)).toEqual([
      fixture.sourceAccountA,
    ]);

    const both = parsed(await onBothSpaces("list_sources", {})) as {
      sources: Array<{ sourceAccountId: string }>;
    };
    expect(both.sources.map((row) => row.sourceAccountId).sort()).toEqual(
      [fixture.sourceAccountA, fixture.sourceAccountB].sort(),
    );
  });

  test("list_inventory pages one account and reads an unauthorized one as empty", async () => {
    const result = parsed(
      await onPostgres("list_inventory", {
        sourceAccountId: fixture.sourceAccountA,
      }),
    ) as {
      rows: Array<{ fileName: string; exclusionReason: string }>;
      counts: { byExclusionReason: Record<string, number> };
    };
    expect(result.rows.map((row) => row.fileName)).toEqual(["skipped.bin"]);
    expect(result.rows[0]!.exclusionReason).toBe("unsupported");
    expect(result.counts.byExclusionReason).toEqual({ unsupported: 1 });

    const foreign = parsed(
      await onPostgres("list_inventory", {
        sourceAccountId: fixture.sourceAccountB,
      }),
    ) as { rows: unknown[]; counts: { total: number } };
    expect(foreign.rows).toEqual([]);
    expect(foreign.counts.total).toBe(0);
  });

  test("list_review_queue counts one account and reads an unauthorized one as empty", async () => {
    const result = parsed(
      await onPostgres("list_review_queue", {
        sourceAccountId: fixture.sourceAccountA,
      }),
    ) as {
      counts: {
        skippedByType: { byExclusionReason: Record<string, number> };
        fieldDropped: { byCode: Record<string, number> };
      };
    };
    expect(result.counts.skippedByType.byExclusionReason).toEqual({
      unsupported: 1,
    });
    expect(result.counts.fieldDropped.byCode).toEqual({ unsupported: 1 });

    const foreign = parsed(
      await onPostgres("list_review_queue", {
        sourceAccountId: fixture.sourceAccountB,
      }),
    ) as { counts: { skippedByType: { total: number } } };
    expect(foreign.counts.skippedByType.total).toBe(0);
  });

  test("search_facts formats a fact exactly as the Convex path does", async () => {
    const found = parsed(
      await onPostgres("search_facts", { query: "Oakland" }),
    ) as Array<Record<string, unknown>>;
    expect(found).toHaveLength(1);
    const fact = found[0]!;
    expect(fact).toMatchObject({
      id: fixture.factA,
      spaceId: fixture.spaceA,
      userId: fixture.userId,
      predicate: "home_city",
      value: { type: "text", value: "Oakland" },
      sourceType: "user_stated",
      status: "current",
      isCore: true,
      citation: `fact:${fixture.factA}`,
    });
    // `undefined`, never `null`: the Convex path omits an absent optional and
    // a `null` here would be a visible difference in the tool's own JSON.
    expect(Object.hasOwn(fact, "sourceRef")).toBe(false);
    expect(Object.hasOwn(fact, "supersededBy")).toBe(false);

    // Every field written out from the fixture, not read back from the store's
    // own answer: a mock built from the result under test would compare the
    // formatter with itself. `statement` is what `rememberFact` composes and
    // `confidence` is its default for a stated fact.
    await sameAsConvex("search_facts", { query: "Oakland" }, () => {
      convexMocks.query.mockResolvedValue([
        {
          id: fixture.factA,
          spaceId: fixture.spaceA,
          userId: fixture.userId,
          statement: "Rowan — home city: Oakland.",
          subject: {
            id: fixture.entityA,
            key: "person:rowan",
            kind: "person",
            name: "Rowan",
            aliases: [],
          },
          predicate: "home_city",
          value: { type: "text", value: "Oakland" },
          sourceType: "user_stated",
          confidence: 1,
          isCore: true,
          status: "current",
          createdAt: FACT_EPOCH,
        },
      ]);
    });

    // The other space's fact is never reachable from this credential, and an
    // empty result is the tool's own sentence rather than an empty array.
    expect(text(await onPostgres("search_facts", { query: "Berkeley" }))).toBe(
      "No matching facts found.",
    );
    const both = parsed(
      await onBothSpaces("search_facts", { query: "Berkeley" }),
    ) as Array<{ spaceId: string }>;
    expect(both.map((row) => row.spaceId)).toEqual([fixture.spaceB]);
  });

  test("search_thoughts returns index rows and reports vectorStatus", async () => {
    const result = parsed(
      await onPostgres("search_thoughts", { query: "ledger" }),
    ) as {
      vectorStatus: string;
      results: Array<{ id: string; summary: string; snippet: string }>;
    };
    // No embedding index is seeded, so the semantic leg is unavailable and the
    // keyword leg answers. That is section 4.4's rule, not a degraded test.
    expect(result.vectorStatus).toBe("unavailable");
    expect(result.results.map((row) => row.id)).toEqual([fixture.coreThoughtA]);
    expect(result.results[0]!.summary).toBe("Ledger upkeep");
    expect(result.results[0]!.snippet).toBe(
      "Keep the synthetic household ledger current each quarter.",
    );

    const both = parsed(
      await onBothSpaces("search_thoughts", { query: "ledger" }),
    ) as { results: Array<{ spaceId: string }> };
    expect(both.results.map((row) => row.spaceId).sort()).toEqual(
      [fixture.spaceA, fixture.spaceB].sort(),
    );
  });

  test("a failing embedder leaves vectorStatus unavailable and the keyword leg answering", async () => {
    const restore = setMcpEmbedder(async () => {
      throw new Error("synthetic embedding provider outage");
    });
    try {
      for (const [name, key] of [
        ["search_thoughts", "results"],
        ["search_documents", "results"],
      ] as const) {
        const result = parsed(await onPostgres(name, { query: "ledger" })) as {
          vectorStatus?: string;
          results?: unknown[];
        };
        expect(result.vectorStatus, name).toBe("unavailable");
        expect(Array.isArray(result[key]), name).toBe(true);
      }
      const recall = parsed(
        await onPostgres("recall_context", { query: "ledger" }),
      ) as { vectorStatus: string; context: unknown[] };
      expect(recall.vectorStatus).toBe("unavailable");
      expect(recall.context.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  test("recall_context blends core and relevance from one snapshot", async () => {
    const result = parsed(
      await onPostgres("recall_context", { query: "clinic appointment" }),
    ) as {
      vectorStatus: string;
      context: Array<{
        id: string;
        memoryKind: string;
        source: string;
        score?: number;
        citation: string;
      }>;
    };
    expect(result.vectorStatus).toBe("unavailable");
    expect(result.context.map((row) => [row.memoryKind, row.source])).toEqual([
      ["fact", "core"],
      ["thought", "core"],
      ["thought", "relevance"],
    ]);
    expect(result.context[0]!.citation).toBe(`fact:${fixture.factA}`);
    expect(result.context[1]!.id).toBe(fixture.coreThoughtA);
    // A relevance thought carries the ranker's score, as it does on Convex.
    expect(typeof result.context[2]!.score).toBe("number");
  });

  test("recall_context never blends in a space this credential cannot read", async () => {
    // "ledger" is the word space B's thought carries, so the other space has
    // something this query genuinely matches. A query it does not match would
    // pass the assertion below whether or not the space filter existed.
    const both = parsed(
      await onBothSpaces("recall_context", { query: "ledger" }),
    ) as { context: Array<{ id: string; source: string }> };
    expect(
      both.context.some((row) => row.id === fixture.thoughtB),
      "the shared space's ledger thought is reachable with both grants",
    ).toBe(true);

    const onlyA = parsed(
      await onPostgres("recall_context", { query: "ledger" }),
    ) as { context: Array<{ id: string; spaceId: string }> };
    expect(onlyA.context.some((row) => row.id === fixture.thoughtB)).toBe(false);
    expect(onlyA.context.every((row) => row.spaceId === fixture.spaceA)).toBe(
      true,
    );
  });

  test("recall_context tells an empty space to initialize itself", async () => {
    // A query that matches nothing is not an empty brain. An unrelated space
    // with no rows at all is, and this fixture's second credential reaches
    // both, so the case uses a credential with no memory in scope.
    const empty = await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `mcp-empty-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const key = await createApiKey(ctx, {
        principal: { userId: session.userId, capabilities: ["read"] as const },
        name: "Synthetic empty client",
        capabilities: ["read"],
        spaceIds: [spaceId],
      });
      return { userId: session.userId, keyId: key.id };
    });
    const result = await call(
      {
        surface: "postgres",
        withPrincipal: mcpPrincipalLoader({
          userId: empty.userId,
          credentialId: empty.keyId,
        }),
      },
      "recall_context",
      { query: "anything at all" },
    );
    expect(parsed(result)).toEqual({
      context: [],
      vectorStatus: "unavailable",
      message:
        "Run /brain-init to add initial context, then try recall_context again.",
    });
  });

  /**
   * The Convex rows this fixture's two personal-space thoughts would have
   * been, written out rather than derived from the store's answer. Comparing
   * against rows the store produced would only prove the formatter is a
   * function; these state independently what Convex returned.
   */
  function convexThoughtDocs() {
    return [
      {
        _id: fixture.taskThoughtA,
        spaceId: fixture.spaceA,
        userId: fixture.userId,
        _creationTime: THOUGHT_EPOCH + 60_000,
        createdAt: THOUGHT_EPOCH + 60_000,
        content:
          "Book the synthetic clinic appointment before the quarter ends.",
        metadata: {
          type: "task",
          topics: ["clinic"],
          people: [],
          actionItems: [],
          summary: "Clinic booking",
        },
        memoryStatus: "current" as const,
        isCore: false,
      },
      {
        _id: fixture.coreThoughtA,
        spaceId: fixture.spaceA,
        userId: fixture.userId,
        _creationTime: THOUGHT_EPOCH,
        createdAt: THOUGHT_EPOCH,
        content: "Keep the synthetic household ledger current each quarter.",
        metadata: {
          type: "decision",
          topics: ["ledger"],
          people: ["Rowan"],
          actionItems: [],
          summary: "Ledger upkeep",
        },
        memoryStatus: "current" as const,
        isCore: true,
      },
    ];
  }

  test("browse_recent returns the granted space's thoughts newest first", async () => {
    const rows = parsed(await onPostgres("browse_recent", {})) as Array<{
      id: string;
      spaceId: string;
      content: string;
    }>;
    expect(rows.map((row) => row.id)).toEqual([
      fixture.taskThoughtA,
      fixture.coreThoughtA,
    ]);
    expect(rows.every((row) => row.spaceId === fixture.spaceA)).toBe(true);

    const filtered = parsed(
      await onPostgres("browse_recent", { type: "task" }),
    ) as Array<{ id: string }>;
    expect(filtered.map((row) => row.id)).toEqual([fixture.taskThoughtA]);

    const both = parsed(await onBothSpaces("browse_recent", {})) as Array<{
      id: string;
    }>;
    expect(both.map((row) => row.id)).toContain(fixture.thoughtB);

    await sameAsConvex("browse_recent", {}, () => {
      convexMocks.query.mockResolvedValue(convexThoughtDocs());
    });
  });

  test("get_thoughts returns full content in the caller's id order", async () => {
    const rows = parsed(
      await onPostgres("get_thoughts", {
        ids: [fixture.taskThoughtA, fixture.coreThoughtA],
      }),
    ) as Array<{ id: string; content: string; isCore: boolean }>;
    expect(rows.map((row) => row.id)).toEqual([
      fixture.taskThoughtA,
      fixture.coreThoughtA,
    ]);
    expect(rows[1]!.isCore).toBe(true);

    // An id from the other space is dropped, not denied and not returned.
    const mixed = parsed(
      await onPostgres("get_thoughts", {
        ids: [fixture.thoughtB, fixture.coreThoughtA],
      }),
    ) as Array<{ id: string }>;
    expect(mixed.map((row) => row.id)).toEqual([fixture.coreThoughtA]);

    expect(
      text(await onPostgres("get_thoughts", { ids: [fixture.thoughtB] })),
    ).toBe("No thoughts found for the provided IDs.");

    await sameAsConvex(
      "get_thoughts",
      { ids: [fixture.taskThoughtA, fixture.coreThoughtA] },
      () => {
        convexMocks.action.mockResolvedValue(convexThoughtDocs());
      },
    );
  });

  test("timeline_thoughts anchors a window and refuses a seed it may not read", async () => {
    const rows = parsed(
      await onPostgres("timeline_thoughts", { seedId: fixture.coreThoughtA }),
    ) as Array<{ id: string; summary: string }>;
    expect(rows.map((row) => row.id)).toEqual([
      fixture.coreThoughtA,
      fixture.taskThoughtA,
    ]);
    expect(rows[0]!.summary).toBe("Ledger upkeep");

    const byTime = parsed(
      await onPostgres("timeline_thoughts", { aroundMs: 0, before: 0 }),
    ) as Array<{ id: string }>;
    expect(byTime.map((row) => row.id)).toEqual([
      fixture.coreThoughtA,
      fixture.taskThoughtA,
    ]);

    const denied = await onPostgres("timeline_thoughts", {
      seedId: fixture.thoughtB,
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("Seed thought not found");

    const badArgs = await onPostgres("timeline_thoughts", {});
    expect(badArgs.isError).toBe(true);
    expect(text(badArgs)).toBe("Error: provide either `seedId` or `aroundMs`.");

    await sameAsConvex(
      "timeline_thoughts",
      { seedId: fixture.coreThoughtA },
      () => {
        convexMocks.action.mockResolvedValue(
          convexThoughtDocs()
            .slice()
            .reverse()
            .map((doc) => ({
              _id: doc._id,
              userId: doc.userId,
              spaceId: doc.spaceId,
              summary: doc.metadata.summary,
              snippet: doc.content,
              type: doc.metadata.type,
              topics: doc.metadata.topics,
              createdAt: doc.createdAt,
              memoryStatus: doc.memoryStatus,
              isCore: doc.isCore,
            })),
        );
      },
    );
  });

  test("get_stats counts the granted spaces only and drops dateRange", async () => {
    const stats = parsed(await onPostgres("get_stats", {})) as Record<
      string,
      unknown
    >;
    expect(stats).toMatchObject({
      totalThoughts: 2,
      totalFacts: 1,
      historicalThoughts: 0,
      historicalFacts: 0,
      retractedThoughts: 0,
      retractedFacts: 0,
      partial: false,
    });
    expect(stats.byType).toEqual([
      { type: "decision", count: 1 },
      { type: "task", count: 1 },
    ]);
    expect(stats.topPeople).toEqual([{ person: "Rowan", count: 1 }]);
    // `mcpQueries.getStats` strips `dateRange`; the PostgreSQL path must too.
    expect(Object.hasOwn(stats, "dateRange")).toBe(false);
    expect(stats.coverage).toEqual([
      { spaceId: fixture.spaceA, status: "unknown", drift: false },
    ]);

    const both = parsed(await onBothSpaces("get_stats", {})) as {
      totalThoughts: number;
      totalFacts: number;
      coverage: unknown[];
    };
    expect(both.totalThoughts).toBe(3);
    expect(both.totalFacts).toBe(2);
    expect(both.coverage).toHaveLength(2);

    await sameAsConvex("get_stats", {}, () => {
      convexMocks.query.mockResolvedValue({
        totalThoughts: 2,
        totalFacts: 1,
        historicalThoughts: 0,
        historicalFacts: 0,
        retractedThoughts: 0,
        retractedFacts: 0,
        byType: [
          { type: "decision", count: 1 },
          { type: "task", count: 1 },
        ],
        topTopics: [
          { topic: "clinic", count: 1 },
          { topic: "ledger", count: 1 },
        ],
        topPeople: [{ person: "Rowan", count: 1 }],
        partial: false,
        coverage: [
          { spaceId: fixture.spaceA, status: "unknown", drift: false },
        ],
      });
    });
  });

  test("write and ingest tools still refuse, naming the row that ports them", async () => {
    for (const [name, args] of [
      [
        "remember_fact",
        {
          subject: { kind: "person", name: "Rowan" },
          predicate: "home_city",
          value: { type: "text", value: "Albany" },
          sourceType: "user_stated",
        },
      ],
      ["capture_thought", { content: "Synthetic", sourceType: "user_stated" }],
      [
        "ingest_url",
        {
          requestId: "synthetic-1",
          source: {
            connector: "mcp-client",
            accountId: "synthetic",
            externalId: "synthetic",
          },
          url: "https://example.test/synthetic",
        },
      ],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await onPostgres(name, args);
      expect(result.isError, name).toBe(true);
      expect(text(result)).toContain("P2-39i4");
    }
  });

  test("a credential revoked between two calls denies on the second", async () => {
    const revoked = await inTransaction(async (ctx) => {
      const session = await signUp(ctx, {
        email: `mcp-revoked-${randomBytes(4).toString("hex")}@example.test`,
        password: PASSWORD,
      });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const key = await createApiKey(ctx, {
        principal: { userId: session.userId, capabilities: ["read"] as const },
        name: "Synthetic revocable client",
        capabilities: ["read"],
        spaceIds: [spaceId],
      });
      return { userId: session.userId, keyId: key.id };
    });
    const credential: McpServerCredential = {
      surface: "postgres",
      withPrincipal: mcpPrincipalLoader({
        userId: revoked.userId,
        credentialId: revoked.keyId,
      }),
    };
    const first = await call(credential, "browse_recent", {});
    expect(first.isError).not.toBe(true);

    await pool.query("DELETE FROM kith.api_keys WHERE id = $1", [
      revoked.keyId,
    ]);
    const second = await call(credential, "browse_recent", {});
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("Not authenticated");
  });
});
