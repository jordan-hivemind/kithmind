// The read half of the MCP tool surface, once per backend.
//
// Slice i3 of the web and MCP surface plan moves the 14 read tools onto
// `@repo/kith-store` under `KITH_POSTGRES_SURFACE=postgres`. The tools
// themselves keep their schemas, their descriptions and their presentation:
// what changes is where the rows come from. So the rows are what this module
// is about. `McpReads` is one method per read tool, returning exactly the
// shape the Convex function returned, and `server.ts` formats that shape the
// way it always has. Parity is then a property of this file rather than
// something restated at fourteen call sites.
//
// Three rules from the plan are enforced here rather than in the tools:
//
//   * Section 4.3, one transaction per tool call. Every PostgreSQL method
//     opens exactly one `REPEATABLE READ READ ONLY` transaction through i2's
//     loader and runs every service it needs on that one client, so the halves
//     of one answer come from one snapshot. `query_records` is the one
//     documented exception and says why below.
//   * Section 3.3, the space set is resolved from the reloaded principal.
//     `getAuthorizedReadSpaceIds` is the only way a space id reaches a
//     statement; a caller-supplied `spaceIds` is an argument to it, never a
//     value passed through it.
//   * Section 4.4, the embedding request happens before the transaction opens.
//     `prepareEmbedQuery` does the provider round trip and hands the tool a
//     resolved vector, so no `pg` connection is ever held across an outbound
//     HTTP call. A failure there is `undefined`, which is what makes
//     `vectorStatus` "unavailable" while the keyword leg still answers.

import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import {
  blendRecallContext,
  coreLimitFor,
} from "@repo/db/convex/models/recallBlend";
import { documents, embeddings, memory, records } from "@repo/kith-store";
import type { EmbedQuery } from "@repo/kith-store/embeddings";
import {
  getAuthorizedReadSpaceIds,
  type IdentityCtx,
  listSpaces as listIdentitySpaces,
  type Principal,
} from "@repo/kith-store/identity";
import type { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs } from "convex/server";

import type { WithMcpPrincipal } from "./principal";

/** The snippet bound `models/thoughts/mcpActions.ts` applies to index rows. */
const SNIPPET_CHARS = 240;

function truncateSnippet(content: string): string {
  const chars: string[] = [];
  for (const character of content) {
    if (chars.length >= SNIPPET_CHARS) return `${chars.join("")}…`;
    chars.push(character);
  }
  return content;
}

export type VectorStatus = "ready" | "unavailable";

export type FactResult = {
  id: string;
  spaceId?: string;
  userId?: string;
  statement: string;
  subject: {
    id: string;
    key: string;
    kind: string;
    name: string;
    aliases: string[];
  } | null;
  predicate: string;
  value: unknown;
  sourceType: "user_stated" | "user_confirmed";
  sourceRef?: string;
  observedAt?: number;
  batchId?: string;
  confidence: number;
  isCore: boolean;
  validFrom?: number;
  validTo?: number;
  status: "current" | "superseded" | "retracted";
  supersededAt?: number;
  supersededBy?: string;
  supersedes?: string[];
  changeReason?: string;
  createdAt: number;
  updatedAt?: number;
};

export type ThoughtIndexRow = {
  _id: string;
  userId?: string;
  spaceId?: string;
  summary: string;
  snippet: string;
  type: string;
  topics: string[];
  score: number;
  createdAt: number;
  memoryStatus: "current" | "superseded" | "retracted";
  isCore?: boolean;
  validFrom?: number;
  validTo?: number;
  supersededAt?: number;
  changeReason?: string;
};

export type TimelineRow = {
  _id: string;
  userId?: string;
  spaceId?: string;
  summary: string;
  snippet: string;
  type: string;
  topics: string[];
  createdAt: number;
  memoryStatus: "current" | "superseded" | "retracted";
  isCore?: boolean;
  validFrom?: number;
  validTo?: number;
};

export type ThoughtMetadataResult = {
  type: string;
  topics: string[];
  people: string[];
  actionItems: string[];
  summary: string;
};

export type BrowseThought = {
  _id: string;
  spaceId?: string;
  _creationTime: number;
  content: string;
  metadata: ThoughtMetadataResult;
  userId: string;
  memoryStatus?: "current" | "superseded" | "retracted";
  isCore?: boolean;
  validFrom?: number;
  validTo?: number;
  supersededAt?: number;
  changeReason?: string;
};

export type FullThought = {
  _id: string;
  userId?: string;
  spaceId?: string;
  content: string;
  metadata: ThoughtMetadataResult;
  createdAt: number;
  updatedAt?: number;
  memoryStatus: "current" | "superseded" | "retracted";
  isCore?: boolean;
  validFrom?: number;
  validTo?: number;
  supersededAt?: number;
  supersededBy?: string;
  supersedes?: string[];
  changeReason?: string;
};

export type CoreThought = {
  _id: string;
  spaceId?: string;
  _creationTime: number;
  content: string;
  metadata: ThoughtMetadataResult;
  userId: string;
  memoryStatus?: "current" | "superseded" | "retracted";
  isCore?: boolean;
  validFrom?: number;
  validTo?: number;
};

/**
 * `recall_context`'s blended rows, before presentation.
 *
 * `empty` is the pre-blend emptiness the tool's "Run /brain-init" answer keys
 * on: the blend can legitimately select nothing from a non-empty store, and
 * telling a populated brain to initialize itself would be wrong.
 */
export type RecallRows = {
  coreFacts: FactResult[];
  coreThoughts: CoreThought[];
  relevanceFacts: FactResult[];
  relevanceThoughts: Array<FullThought & { score: number }>;
  vectorStatus: VectorStatus;
  empty: boolean;
};

export type ReadSpaces = { spaceIds?: string[] };

export type SearchDocumentsArgs = ReadSpaces & {
  query: string;
  searchMode?: "keyword" | "hybrid";
  docType?: string;
  from?: number;
  to?: number;
  limit?: number;
  includeHistorical?: boolean;
};

export type SearchThoughtsArgs = ReadSpaces & {
  query: string;
  type?:
    | "decision"
    | "person_note"
    | "idea"
    | "meeting_note"
    | "task"
    | "reference";
  limit: number;
  includeHistorical: boolean;
};

export type RecallArgs = ReadSpaces & {
  query: string;
  limit: number;
  includeHistorical: boolean;
};

export type BrowseArgs = ReadSpaces & {
  limit: number;
  type?: SearchThoughtsArgs["type"];
  topic?: string;
  includeHistorical: boolean;
};

export type InventoryArgs = ReadSpaces & {
  sourceAccountId: string;
  fileName?: string;
  folderPath?: string;
  exclusionReason?: string;
  duplicateGroupId?: string;
  cursor?: string;
  limit?: number;
};

export type ReviewQueueArgs = ReadSpaces & {
  sourceAccountId: string;
  class?: string;
  cursor?: string;
  limit?: number;
};

export type TimelineArgs = ReadSpaces & {
  seedId?: string;
  aroundMs?: number;
  before: number;
  after: number;
  type?: SearchThoughtsArgs["type"];
};

/** One method per read tool. `server.ts` formats what these return. */
export type McpReads = {
  listSpaces(): Promise<unknown>;
  queryRecords(query: unknown): Promise<unknown>;
  searchDocuments(args: SearchDocumentsArgs): Promise<unknown>;
  getDocument(
    args: ReadSpaces & { documentId: string; includeHistorical?: boolean },
  ): Promise<unknown>;
  /** An object, because `list_sources` may add a `financeArchive` block. */
  listSources(
    args: ReadSpaces & { sourceAccountId?: string; limit?: number },
  ): Promise<Record<string, unknown>>;
  listInventory(args: InventoryArgs): Promise<unknown>;
  listReviewQueue(args: ReviewQueueArgs): Promise<unknown>;
  searchFacts(
    args: ReadSpaces & {
      query: string;
      limit: number;
      includeHistorical: boolean;
    },
  ): Promise<FactResult[]>;
  searchThoughts(
    args: SearchThoughtsArgs,
  ): Promise<{ results: ThoughtIndexRow[]; vectorStatus: VectorStatus }>;
  recallContext(args: RecallArgs): Promise<RecallRows>;
  browseRecent(args: BrowseArgs): Promise<BrowseThought[]>;
  getThoughts(args: ReadSpaces & { ids: string[] }): Promise<FullThought[]>;
  timelineThoughts(args: TimelineArgs): Promise<TimelineRow[]>;
  getStats(args: ReadSpaces): Promise<unknown>;
  /** The space set the finance provider is authorized against, per call. */
  authorizedSpaceIds(): Promise<string[]>;
};

// ---------------------------------------------------------------------------
// The Convex surface
// ---------------------------------------------------------------------------

/** The three Convex calls the tools make. Nothing here constructs a client. */
export type ConvexGateway = Pick<
  ConvexHttpClient,
  "query" | "mutation" | "action"
>;

function scopedReads(spaceIds?: string[]) {
  return spaceIds === undefined ? {} : { spaceIds: spaceIds as Id<"spaces">[] };
}

export function convexReads(convex: ConvexGateway): McpReads {
  return {
    async listSpaces() {
      return await convex.query(api.models.spaces.mcpQueries.list, {});
    },
    async queryRecords(query) {
      return await convex.mutation(api.models.records.queryMcp.run, {
        query: query as FunctionArgs<
          typeof api.models.records.queryMcp.run
        >["query"],
      });
    },
    async searchDocuments({ spaceIds, ...args }) {
      return await convex.action(api.models.documents.mcpActions.search, {
        ...args,
        ...scopedReads(spaceIds),
      });
    },
    async getDocument({ spaceIds, documentId, ...args }) {
      return await convex.query(api.models.documents.mcpQueries.get, {
        ...args,
        documentId: documentId as Id<"documents">,
        ...scopedReads(spaceIds),
      });
    },
    async listSources({ spaceIds, sourceAccountId, ...args }) {
      return (await convex.query(api.models.documents.mcpQueries.listSources, {
        ...args,
        ...scopedReads(spaceIds),
        ...(sourceAccountId === undefined
          ? {}
          : { sourceAccountId: sourceAccountId as Id<"sourceAccounts"> }),
      })) as Record<string, unknown>;
    },
    async listInventory({ spaceIds, sourceAccountId, ...args }) {
      return await convex.query(
        api.models.documents.mcpQueries.listInventory,
        {
          ...(args as FunctionArgs<
            typeof api.models.documents.mcpQueries.listInventory
          >),
          sourceAccountId: sourceAccountId as Id<"sourceAccounts">,
          ...scopedReads(spaceIds),
        },
      );
    },
    async listReviewQueue({ spaceIds, sourceAccountId, ...args }) {
      return await convex.query(
        api.models.records.mcpQueries.listReviewQueue,
        {
          ...(args as FunctionArgs<
            typeof api.models.records.mcpQueries.listReviewQueue
          >),
          sourceAccountId: sourceAccountId as Id<"sourceAccounts">,
          ...scopedReads(spaceIds),
        },
      );
    },
    async searchFacts({ spaceIds, query, limit, includeHistorical }) {
      return (await convex.query(api.models.facts.mcpQueries.search, {
        query,
        limit,
        includeHistorical,
        ...scopedReads(spaceIds),
      })) as FactResult[];
    },
    async searchThoughts({ spaceIds, query, type, limit, includeHistorical }) {
      return (await convex.action(
        api.models.thoughts.mcpActions.searchWithStatus,
        {
          ...scopedReads(spaceIds),
          query,
          type,
          limit,
          includeHistorical,
        },
      )) as { results: ThoughtIndexRow[]; vectorStatus: VectorStatus };
    },
    async recallContext({ spaceIds, query, limit, includeHistorical }) {
      // The four reads stay one `Promise.all` in this order. They are four
      // round trips to one Convex deployment, so issuing them together is what
      // keeps the tool's latency what it was.
      const [coreFacts, coreThoughts, relevantFacts, searchResult] =
        (await Promise.all([
          convex.query(api.models.facts.mcpQueries.listCore, {
            ...scopedReads(spaceIds),
            limit: coreLimitFor(limit),
          }),
          convex.query(api.models.thoughts.mcpQueries.listCore, {
            ...scopedReads(spaceIds),
            limit: coreLimitFor(limit),
          }),
          convex.query(api.models.facts.mcpQueries.search, {
            ...scopedReads(spaceIds),
            query,
            limit,
            includeHistorical,
          }),
          convex.action(api.models.thoughts.mcpActions.searchWithStatus, {
            ...scopedReads(spaceIds),
            query,
            limit,
            includeHistorical,
          }),
        ])) as [
          FactResult[],
          CoreThought[],
          FactResult[],
          { results: ThoughtIndexRow[]; vectorStatus: VectorStatus },
        ];
      const { results: index, vectorStatus } = searchResult;
      const blend = blendRecallContext({
        coreFacts,
        coreThoughts,
        relevantFacts,
        relevantThoughts: index,
        limit,
        factId: (fact) => fact.id,
        coreThoughtId: (thought) => thought._id,
        relevantThoughtId: (row) => row._id,
      });
      const hydrated =
        blend.relevanceThoughts.length === 0
          ? []
          : ((await convex.action(api.models.thoughts.mcpActions.getByIds, {
              ...scopedReads(spaceIds),
              ids: blend.relevanceThoughts.map((row) => row._id) as never,
            })) as FullThought[]);
      const byId = new Map(hydrated.map((thought) => [thought._id, thought]));
      return {
        coreFacts: blend.coreFacts,
        coreThoughts: blend.coreThoughts,
        relevanceFacts: blend.relevanceFacts,
        relevanceThoughts: blend.relevanceThoughts.flatMap((row) => {
          const thought = byId.get(row._id);
          return thought ? [{ ...thought, score: row.score }] : [];
        }),
        vectorStatus,
        empty:
          coreFacts.length === 0 &&
          coreThoughts.length === 0 &&
          relevantFacts.length === 0 &&
          index.length === 0,
      };
    },
    async browseRecent({ spaceIds, limit, type, topic, includeHistorical }) {
      return (await convex.query(api.models.thoughts.mcpQueries.listByUser, {
        limit,
        type,
        topic,
        includeHistorical,
        ...scopedReads(spaceIds),
      })) as BrowseThought[];
    },
    async getThoughts({ spaceIds, ids }) {
      return (await convex.action(api.models.thoughts.mcpActions.getByIds, {
        ids: ids as never,
        ...scopedReads(spaceIds),
      })) as FullThought[];
    },
    async timelineThoughts({ spaceIds, seedId, aroundMs, before, after, type }) {
      return (await convex.action(api.models.thoughts.mcpActions.timeline, {
        ...scopedReads(spaceIds),
        seedId: seedId as never,
        aroundMs,
        before,
        after,
        type,
      })) as TimelineRow[];
    },
    async getStats({ spaceIds }) {
      return await convex.query(
        api.models.thoughts.mcpQueries.getStats,
        scopedReads(spaceIds),
      );
    },
    async authorizedSpaceIds() {
      const spaces = (await convex.query(
        api.models.spaces.mcpQueries.list,
        {},
      )) as Array<{ spaceId: string }>;
      return spaces.map((space) => space.spaceId);
    },
  };
}

// ---------------------------------------------------------------------------
// The PostgreSQL surface
// ---------------------------------------------------------------------------

/**
 * The query embedder, resolved before any transaction opens.
 *
 * Injectable the way `lib/kith/pool.ts` makes the pool injectable: nothing in
 * the app calls the setter, and a test that wants a failing provider says so
 * rather than standing up an HTTP endpoint that returns 500.
 */
export type McpEmbedder = (query: string) => Promise<{
  vector: readonly number[];
  fingerprint: string;
}>;

let embedder: McpEmbedder | undefined;

export function setMcpEmbedder(next: McpEmbedder | undefined): () => void {
  const previous = embedder;
  embedder = next;
  return () => {
    embedder = previous;
  };
}

async function defaultEmbedder(query: string) {
  const config = embeddings.loadEmbeddingConfig(process.env);
  const result = await embeddings.requestEmbedding(query, config);
  return { vector: result.vector, fingerprint: result.fingerprint };
}

/**
 * One provider round trip, outside the transaction, turned into an
 * `EmbedQuery` that resolves the already-obtained vector.
 *
 * `undefined` when the provider failed or is not configured. The search legs
 * treat an absent embedder exactly as `searchMode: "keyword"` does, which is
 * section 4.4's rule: a vector outage degrades ranking and never withholds
 * retained keyword evidence.
 */
async function prepareEmbedQuery(
  query: string,
): Promise<EmbedQuery | undefined> {
  try {
    const resolved = await (embedder ?? defaultEmbedder)(query);
    return async () => resolved;
  } catch {
    return undefined;
  }
}

function factResult(fact: memory.HydratedFact): FactResult {
  // `undefined` rather than `null` for every absent field: Convex omits an
  // optional field it does not have, and the tools serialize what they are
  // given. A `null` here would be a visible difference in the tool's own JSON.
  return {
    id: fact.id,
    spaceId: fact.spaceId,
    userId: fact.userId,
    statement: fact.statement,
    subject: {
      id: fact.subject.id,
      key: fact.subject.key,
      kind: fact.subject.kind,
      name: fact.subject.name,
      aliases: [...fact.subject.aliases],
    },
    predicate: fact.predicate,
    value: fact.value,
    sourceType: fact.sourceType as "user_stated" | "user_confirmed",
    ...(fact.sourceRef === null ? {} : { sourceRef: fact.sourceRef }),
    ...(fact.observedAt === undefined ? {} : { observedAt: fact.observedAt }),
    ...(fact.batchId === null ? {} : { batchId: fact.batchId }),
    confidence: fact.confidence,
    isCore: fact.isCore,
    ...(fact.validFrom === undefined ? {} : { validFrom: fact.validFrom }),
    ...(fact.validTo === undefined ? {} : { validTo: fact.validTo }),
    status: fact.status,
    ...(fact.supersededAt === undefined
      ? {}
      : { supersededAt: fact.supersededAt }),
    ...(fact.supersededBy === null
      ? {}
      : { supersededBy: fact.supersededBy }),
    ...(fact.supersedes.length === 0
      ? {}
      : { supersedes: [...fact.supersedes] }),
    ...(fact.changeReason === null
      ? {}
      : { changeReason: fact.changeReason }),
    createdAt: fact.createdAt,
    ...(fact.updatedAt === undefined ? {} : { updatedAt: fact.updatedAt }),
  };
}

function thoughtMetadata(
  metadata: memory.Thought["metadata"],
): ThoughtMetadataResult {
  return {
    type: metadata.type,
    topics: [...metadata.topics],
    people: [...metadata.people],
    actionItems: [...metadata.actionItems],
    summary: metadata.summary,
  };
}

function fullThought(thought: memory.Thought): FullThought {
  return {
    _id: thought.id,
    userId: thought.userId,
    spaceId: thought.spaceId,
    content: thought.content,
    metadata: thoughtMetadata(thought.metadata),
    createdAt: thought.createdAt,
    ...(thought.updatedAt === undefined
      ? {}
      : { updatedAt: thought.updatedAt }),
    memoryStatus: thought.memoryStatus ?? "current",
    isCore: thought.isCore,
    ...(thought.validFrom === undefined
      ? {}
      : { validFrom: thought.validFrom }),
    ...(thought.validTo === undefined ? {} : { validTo: thought.validTo }),
    ...(thought.supersededAt === undefined
      ? {}
      : { supersededAt: thought.supersededAt }),
    ...(thought.supersededBy === null
      ? {}
      : { supersededBy: thought.supersededBy }),
    ...(thought.supersedes.length === 0
      ? {}
      : { supersedes: [...thought.supersedes] }),
    ...(thought.changeReason === null
      ? {}
      : { changeReason: thought.changeReason }),
  };
}

function browseThought(thought: memory.Thought): BrowseThought {
  return {
    _id: thought.id,
    spaceId: thought.spaceId,
    _creationTime: thought.createdAt,
    content: thought.content,
    metadata: thoughtMetadata(thought.metadata),
    userId: thought.userId,
    memoryStatus: thought.memoryStatus ?? "current",
    isCore: thought.isCore,
    ...(thought.validFrom === undefined
      ? {}
      : { validFrom: thought.validFrom }),
    ...(thought.validTo === undefined ? {} : { validTo: thought.validTo }),
    ...(thought.supersededAt === undefined
      ? {}
      : { supersededAt: thought.supersededAt }),
    ...(thought.changeReason === null
      ? {}
      : { changeReason: thought.changeReason }),
  };
}

function coreThought(thought: memory.Thought): CoreThought {
  return {
    _id: thought.id,
    spaceId: thought.spaceId,
    _creationTime: thought.createdAt,
    content: thought.content,
    metadata: thoughtMetadata(thought.metadata),
    userId: thought.userId,
    memoryStatus: thought.memoryStatus ?? "current",
    isCore: thought.isCore,
    ...(thought.validFrom === undefined
      ? {}
      : { validFrom: thought.validFrom }),
    ...(thought.validTo === undefined ? {} : { validTo: thought.validTo }),
  };
}

function indexRow(
  thought: memory.Thought & { score: number },
): ThoughtIndexRow {
  return {
    _id: thought.id,
    userId: thought.userId,
    spaceId: thought.spaceId,
    summary: thought.metadata.summary,
    snippet: truncateSnippet(thought.content),
    type: thought.metadata.type,
    topics: [...thought.metadata.topics],
    score: thought.score,
    createdAt: thought.createdAt,
    memoryStatus: thought.memoryStatus ?? "current",
    isCore: thought.isCore,
    ...(thought.validFrom === undefined
      ? {}
      : { validFrom: thought.validFrom }),
    ...(thought.validTo === undefined ? {} : { validTo: thought.validTo }),
    ...(thought.supersededAt === undefined
      ? {}
      : { supersededAt: thought.supersededAt }),
    ...(thought.changeReason === null
      ? {}
      : { changeReason: thought.changeReason }),
  };
}

function timelineRow(thought: memory.Thought): TimelineRow {
  return {
    _id: thought.id,
    userId: thought.userId,
    spaceId: thought.spaceId,
    summary: thought.metadata.summary,
    snippet: truncateSnippet(thought.content),
    type: thought.metadata.type,
    topics: [...thought.metadata.topics],
    createdAt: thought.createdAt,
    memoryStatus: thought.memoryStatus ?? "current",
    isCore: thought.isCore,
    ...(thought.validFrom === undefined
      ? {}
      : { validFrom: thought.validFrom }),
    ...(thought.validTo === undefined ? {} : { validTo: thought.validTo }),
  };
}

export function postgresReads(withPrincipal: WithMcpPrincipal): McpReads {
  /** One tool call, one `REPEATABLE READ READ ONLY` transaction. */
  function read<T>(
    run: (session: {
      ctx: IdentityCtx;
      principal: Principal;
      spaces: (requested?: string[]) => Promise<string[]>;
    }) => Promise<T>,
  ): Promise<T> {
    return withPrincipal(
      ({ ctx, principal }) =>
        run({
          ctx,
          principal,
          spaces: (requested) =>
            getAuthorizedReadSpaceIds(ctx, principal, requested),
        }),
      { readOnly: true },
    );
  }

  return {
    async listSpaces() {
      return await read(async ({ ctx, principal }) => {
        const spaces = await listIdentitySpaces(ctx, { principal });
        const coverage = await embeddings.spaceEmbeddingCoverage(
          ctx,
          spaces.map((space) => space.spaceId),
        );
        const bySpace = new Map(
          coverage.map((entry) => [entry.spaceId, entry]),
        );
        return spaces.map((space) => ({
          ...space,
          coverage: bySpace.get(space.spaceId) ?? {
            spaceId: space.spaceId,
            status: "unknown" as const,
            drift: false,
          },
        }));
      });
    },
    async queryRecords(query) {
      // The one read tool that is not read-only. The Convex original is a
      // `mutation` for the same reason: a paged record query creates, advances
      // or consumes a single-use cursor in `kith.record_query_sessions` and
      // takes `FOR UPDATE` locks on the snapshot rows, neither of which a
      // `READ ONLY` transaction may do. Its authority is still `read`:
      // `executeRecordQuery` reloads the principal and calls
      // `requireSpaceAccess(..., "read")` on the query's own space inside this
      // transaction.
      return await withPrincipal(({ ctx, principal }) =>
        records.executeRecordQuery(ctx, {
          principal,
          query: query as records.RecordQuery,
          now: ctx.now,
        }),
      );
    },
    async searchDocuments({ spaceIds, searchMode, ...args }) {
      const embedQuery =
        (searchMode ?? "hybrid") === "hybrid"
          ? await prepareEmbedQuery(args.query)
          : undefined;
      return await read(async ({ ctx, spaces }) => {
        const authorized = await spaces(spaceIds);
        // `mcpActions.search`'s own gate, kept verbatim so a request the
        // Convex path refuses is refused here too.
        if (
          !args.query.trim() ||
          args.query.trim().length > 500 ||
          authorized.length > 32
        ) {
          throw new Error("Document search request is invalid");
        }
        let semantic:
          | embeddings.DocumentSemanticCandidates
          | undefined;
        if (embedQuery) {
          const targets = await embeddings.getActiveTargets(ctx, authorized);
          const generated = await embedQuery(args.query);
          // The configured profile has to agree with the index, not merely
          // with itself: `searchChunkAndCardVectorCandidates` checks the
          // targets against each other and this checks them against the
          // vector that was actually generated.
          const expected = embeddings.compatibleSearchFingerprint(
            authorized,
            targets,
          );
          if (expected && expected === generated.fingerprint) {
            semantic = await embeddings.searchChunkAndCardVectorCandidates(
              ctx,
              authorized,
              targets,
              generated.vector as number[],
            );
          }
        }
        return await documents.searchDocuments(
          ctx.client,
          authorized,
          args,
          semantic,
        );
      });
    },
    async getDocument({ spaceIds, documentId, includeHistorical }) {
      return await read(async ({ ctx, spaces }) =>
        documents.getDocument(
          ctx.client,
          await spaces(spaceIds),
          documentId,
          includeHistorical,
        ),
      );
    },
    async listSources({ spaceIds, sourceAccountId, limit }) {
      return await read(
        async ({ ctx, spaces }) =>
          (await documents.listSources(ctx.client, await spaces(spaceIds), {
            ...(sourceAccountId === undefined ? {} : { sourceAccountId }),
            ...(limit === undefined ? {} : { limit }),
          })) as Record<string, unknown>,
      );
    },
    async listInventory({ spaceIds, ...args }) {
      return await read(async ({ ctx, spaces }) =>
        documents.listInventory(
          ctx.client,
          await spaces(spaceIds),
          args as documents.InventoryListArgs,
        ),
      );
    },
    async listReviewQueue({ spaceIds, ...args }) {
      return await read(async ({ ctx, spaces }) =>
        records.listReviewQueue(
          ctx.client,
          await spaces(spaceIds),
          args as records.ReviewQueueListArgs,
        ),
      );
    },
    async searchFacts({ spaceIds, query, limit, includeHistorical }) {
      return await read(async ({ ctx, spaces }) => {
        const authorized = await spaces(spaceIds);
        if (authorized.length === 0) return [];
        const facts = await embeddings.searchFacts(ctx, authorized, query, {
          limit,
          includeHistorical,
        });
        return facts.map(factResult);
      });
    },
    async searchThoughts({
      spaceIds,
      query,
      type,
      limit,
      includeHistorical,
    }) {
      const embedQuery = await prepareEmbedQuery(query);
      return await read(async ({ ctx, spaces }) => {
        const authorized = await spaces(spaceIds);
        const found = await embeddings.searchThoughtsHybrid(
          ctx,
          authorized,
          query,
          {
            ...(type === undefined ? {} : { type }),
            limit,
            includeHistorical,
            ...(embedQuery === undefined ? {} : { embedQuery }),
          },
        );
        return {
          results: found.results.map(indexRow),
          vectorStatus: found.vectorStatus,
        };
      });
    },
    async recallContext({ spaceIds, query, limit, includeHistorical }) {
      const embedQuery = await prepareEmbedQuery(query);
      return await read(async ({ ctx, spaces }) => {
        const authorized = await spaces(spaceIds);
        // Section 4.3's worked example: the candidates, the core halves and
        // the hydration all run on this one client, so a capture that commits
        // mid-call cannot appear in one half of the blend and not the other.
        const candidates = await embeddings.recallCandidates(
          ctx,
          authorized,
          query,
          {
            limit,
            includeHistorical,
            ...(embedQuery === undefined ? {} : { embedQuery }),
          },
        );
        const blend = await memory.recallContext(ctx, authorized, candidates, {
          limit,
          includeHistorical,
        });
        return {
          coreFacts: blend.coreFacts.map(factResult),
          coreThoughts: blend.coreThoughts.map(coreThought),
          relevanceFacts: blend.relevanceFacts.map(factResult),
          relevanceThoughts: blend.relevanceThoughts.map((thought) => ({
            ...fullThought(thought),
            score: candidates.thoughtScores.get(thought.id) ?? 0,
          })),
          vectorStatus: candidates.vectorStatus,
          // The Convex tool tests the four pre-blend lists. The blend selects
          // at least one core fact whenever there is one and at least one core
          // thought whenever there is one and no core fact, so the two
          // conditions agree; the candidate lists are the other two verbatim.
          empty:
            blend.coreFacts.length === 0 &&
            blend.coreThoughts.length === 0 &&
            candidates.factIds.length === 0 &&
            candidates.thoughtIds.length === 0,
        };
      });
    },
    async browseRecent({ spaceIds, limit, type, topic, includeHistorical }) {
      return await read(async ({ ctx, spaces }) => {
        const found = await memory.listBySpaces(
          ctx,
          await spaces(spaceIds),
          limit,
          includeHistorical,
          {
            ...(type === undefined ? {} : { type }),
            ...(topic === undefined ? {} : { topic }),
          },
        );
        return found.map(browseThought);
      });
    },
    async getThoughts({ spaceIds, ids }) {
      return await read(async ({ ctx, spaces }) => {
        const found = await memory.getThoughtsByAuthorizedIds(
          ctx,
          await spaces(spaceIds),
          ids,
        );
        return found.map(fullThought);
      });
    },
    async timelineThoughts({ spaceIds, ...args }) {
      return await read(async ({ ctx, spaces }) => {
        const found = await memory.listAroundTime(
          ctx,
          await spaces(spaceIds),
          args,
        );
        return found.map(timelineRow);
      });
    },
    async getStats({ spaceIds }) {
      return await read(async ({ ctx, spaces }) => {
        const stats: Record<string, unknown> = {
          ...(await memory.computeSpaceStats(ctx, await spaces(spaceIds))),
        };
        // `mcpQueries.getStats` returns everything the digest computes except
        // `dateRange`, which no tool renders. Dropped here so the two surfaces
        // answer with the same keys.
        delete stats.dateRange;
        return stats;
      });
    },
    async authorizedSpaceIds() {
      return await read(async ({ ctx, principal }) => {
        const spaces = await listIdentitySpaces(ctx, { principal });
        return spaces.map((space) => space.spaceId);
      });
    },
  };
}
