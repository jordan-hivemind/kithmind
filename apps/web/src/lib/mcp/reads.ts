// The read half of the MCP tool surface.
//
// Slice i3 of the web and MCP surface plan moved the 14 read tools onto
// `@repo/kith-store`, and i7b deleted the Convex implementation they used to
// share this file with. The tools keep their schemas, their descriptions and
// their presentation: what changed is where the rows come from. So the rows are
// what this module is about. `McpReads` is one method per read tool, returning
// exactly the shape the Convex function returned, and `server.ts` formats that
// shape the way it always has. Parity is then a property of this file rather
// than something restated at fourteen call sites.
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
//   * Section 4.4, the embedding request happens outside a transaction, and
//     after the caller has been authorized. `prepareEmbedQuery` opens a short
//     read-only transaction that reloads the credential, resolves the space set
//     and checks the index, closes it, and only then calls the provider, so no
//     `pg` connection is held across an outbound HTTP call and no unauthorized
//     caller's text reaches the provider at all. A failure there is
//     `undefined`, which is what makes `vectorStatus` "unavailable" while the
//     keyword leg still answers. The three vector-backed tools therefore open
//     two read-only transactions; every other read tool opens one.

import { admin, documents, embeddings, memory, records } from "@repo/kith-store";
import type { EmbedQuery } from "@repo/kith-store/embeddings";
import {
  getAuthorizedReadSpaceIds,
  type IdentityCtx,
  listSpaces as listIdentitySpaces,
  type Principal,
  principalMaxSensitivity,
} from "@repo/kith-store/identity";

import { resolveMcpEmbedder } from "./embedder";
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

export type InvestmentListArgs = ReadSpaces & {
  category?: string;
  status?: "active" | "closed" | "written_off";
  nameContains?: string;
  includeArchived?: boolean;
};

/** One investment as the tools report it: the row's own fields, its computed
 * totals, and the ids of the documents its entries link to. Amounts are exact
 * decimal strings throughout, never numbers. */
export type InvestmentToolRow = {
  id: string;
  spaceId: string;
  name: string;
  category: string | null;
  signedOn: string | null;
  status: string;
  archived: boolean;
  notes: string | null;
  entryCount: number;
  totals: unknown;
  linkedDocumentIds: string[];
  unlinkedDocumentCount: number;
};

/** One method per read tool. `server.ts` formats what these return. */
export type McpReads = {
  listSpaces(): Promise<unknown>;
  queryRecords(query: unknown): Promise<unknown>;
  searchDocuments(args: SearchDocumentsArgs): Promise<unknown>;
  getDocument(
    args: ReadSpaces & { documentId: string; includeHistorical?: boolean },
  ): Promise<unknown>;
  /**
   * The sources, and the authorized set they were read under.
   *
   * `list_sources` may add a `financeArchive` block, which needs the same
   * membership the sources were read with. On PostgreSQL that set comes free
   * from the transaction that just read them, so returning it here is what
   * keeps the tool to one transaction rather than opening a second one to ask
   * the same question. On Convex it is `undefined`: the set is a separate query
   * there, and issuing it unconditionally would add a round trip to every call
   * whether or not an archive is configured, changing that surface's behaviour.
   * The tool falls back to `authorizedSpaceIds()` when it is absent.
   */
  listSources(
    args: ReadSpaces & { sourceAccountId?: string; limit?: number },
  ): Promise<{
    sources: Record<string, unknown>;
    authorizedSpaceIds?: string[];
  }>;
  listInventory(args: InventoryArgs): Promise<unknown>;
  listReviewQueue(args: ReviewQueueArgs): Promise<unknown>;
  /**
   * ADM-3, section 11's acceptance: committed versus sent versus outstanding,
   * per investment, asked through the connector.
   *
   * The space set is `getAuthorizedReadSpaceIds`, which is what every other
   * read tool in this file uses, so a `reader` member may ask about the
   * investments they can already see. The admin *screen* is narrower
   * (`getAdminSpaceIds`, owner or editor) because it is the operational
   * surface -- editing, archiving, the spreadsheet import. Reading a total is
   * not that, and giving these tools the narrower set would mean a reader's
   * credential silently answering "no investments" for a space whose documents
   * it can already search.
   */
  listInvestments(
    args: InvestmentListArgs,
  ): Promise<{ investments: InvestmentToolRow[] }>;
  getInvestment(
    args: ReadSpaces & { investmentId: string },
  ): Promise<unknown>;
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
// The PostgreSQL surface
// ---------------------------------------------------------------------------

/**
 * The query embedder, resolved before any transaction opens.
 *
 * Injectable the way `lib/kith/pool.ts` makes the pool injectable: nothing in
 * the app calls the setter, and a test that wants a failing provider says so
 * rather than standing up an HTTP endpoint that returns 500. The seam itself
 * moved to `./embedder` in i7a, which `lib/kith/capture.ts` also imports, so
 * `setMcpEmbedder` is re-exported here rather than redefined: this module's
 * own tests, and every other caller, keep importing it from `"./reads"`.
 */
export { type McpEmbedder, setMcpEmbedder } from "./embedder";

/**
 * The authorization and index check that decides whether the query text is
 * worth sending to the embedding provider, then the provider round trip.
 *
 * Two rules meet here and the order matters more than either of them alone.
 *
 * Section 4.4 says the provider call must not happen inside a transaction: a
 * `pg` connection held across an outbound HTTP call is what
 * `KITH_IDLE_TRANSACTION_TIMEOUT_MS` exists to prevent. Convex's own ordering
 * says the call must not happen before the caller has been authorized and the
 * index found compatible: `mcpActions.search` resolved the space set, read the
 * active targets and compared fingerprints, and only then embedded.
 *
 * Doing the provider call first satisfies the first rule and breaks the second.
 * A revoked key, a credential with no readable space and a deployment with no
 * compatible target would each still have sent the user's text to the provider,
 * and in the last case every `search_thoughts` and `recall_context` would have
 * shipped it and thrown the vector away. So this opens a short read-only
 * transaction of its own first, reloads the credential, resolves the authorized
 * set and reads the active targets, closes it, and embeds only if that set has
 * one compatible fingerprint. The tool's own transaction opens afterwards and
 * is still the authority: it resolves the set again and rechecks the targets,
 * so a membership or index change between the two narrows the answer rather
 * than widening it.
 *
 * The cost is one extra short read-only transaction on the three vector-backed
 * tools, which the tests assert exactly.
 *
 * `undefined` means no vector leg: an incompatible index, a provider failure, a
 * provider whose profile disagrees with the index, or no configuration at all.
 * The search legs treat that exactly as `searchMode: "keyword"` does, which is
 * the rest of section 4.4: a vector outage degrades ranking and never withholds
 * retained keyword evidence. An authorization failure is not swallowed: it
 * throws out of the probe, before any text leaves the process.
 */
async function prepareEmbedQuery(
  withPrincipal: WithMcpPrincipal,
  requestedSpaceIds: string[] | undefined,
  query: string,
  validate?: (authorizedSpaceIds: string[]) => void,
): Promise<EmbedQuery | undefined> {
  const fingerprint = await withPrincipal(
    async ({ ctx, principal }) => {
      const authorized = await getAuthorizedReadSpaceIds(
        ctx,
        principal,
        requestedSpaceIds,
      );
      validate?.(authorized);
      if (authorized.length === 0) return null;
      const targets = await embeddings.getActiveTargets(ctx, authorized);
      return embeddings.compatibleSearchFingerprint(authorized, targets);
    },
    { readOnly: true },
  );
  if (!fingerprint) return undefined;
  try {
    const resolved = await resolveMcpEmbedder()(query);
    // The configured profile has to agree with the index, not merely with
    // itself. `searchThoughtsHybrid` checks this again on its own snapshot.
    if (resolved.fingerprint !== fingerprint) return undefined;
    return async () => resolved;
  } catch {
    return undefined;
  }
}

/**
 * One investment as the two tools report it.
 *
 * `totals` is passed through exactly as the store computed it -- per currency
 * and in USD, every figure an exact decimal string straight out of a
 * `numeric` sum. Nothing here re-derives a total, so there is no second
 * arithmetic implementation to disagree with the first.
 */
function investmentToolRow(
  investment: admin.InvestmentRow,
): InvestmentToolRow {
  return {
    id: investment.id,
    spaceId: investment.spaceId,
    name: investment.name,
    category: investment.category,
    signedOn: investment.signedOn,
    status: investment.status,
    archived: investment.archivedAt !== null,
    notes: investment.notes,
    entryCount: investment.entryCount,
    totals: investment.totals,
    // From the same aggregation as the totals, so listing investments never
    // pulls the household's whole ledger to find them.
    linkedDocumentIds: investment.linkedDocumentIds,
    unlinkedDocumentCount: investment.unlinkedDocumentCount,
  };
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
      // `mcpActions.search`'s own gate, kept verbatim so a request the Convex
      // path refuses is refused here too. It runs in the probe as well, so an
      // invalid request is refused before the provider is called.
      const gate = (authorized: string[]) => {
        if (
          !args.query.trim() ||
          args.query.trim().length > 500 ||
          authorized.length > 32
        ) {
          throw new Error("Document search request is invalid");
        }
      };
      const embedQuery =
        (searchMode ?? "hybrid") === "hybrid"
          ? await prepareEmbedQuery(withPrincipal, spaceIds, args.query, gate)
          : undefined;
      return await read(async ({ ctx, principal, spaces }) => {
        const authorized = await spaces(spaceIds);
        gate(authorized);
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
          // SENS-1. The ceiling comes off the principal this transaction just
          // reloaded, never off anything the caller sent. For every credential
          // the owner has not narrowed this is `restricted`, and the store
          // returns everything without issuing an extra query.
          principalMaxSensitivity(principal),
        );
      });
    },
    async getDocument({ spaceIds, documentId, includeHistorical }) {
      return await read(async ({ ctx, principal, spaces }) =>
        documents.getDocument(
          ctx.client,
          await spaces(spaceIds),
          documentId,
          includeHistorical,
          principalMaxSensitivity(principal),
        ),
      );
    },
    async listSources({ spaceIds, sourceAccountId, limit }) {
      // The authorized set comes back with the sources so the tool's finance
      // block can use the same snapshot and the same membership, rather than
      // opening a second transaction to resolve it again.
      return await read(async ({ ctx, spaces }) => {
        const authorizedSpaceIds = await spaces(spaceIds);
        return {
          sources: (await documents.listSources(
            ctx.client,
            authorizedSpaceIds,
            {
              ...(sourceAccountId === undefined ? {} : { sourceAccountId }),
              ...(limit === undefined ? {} : { limit }),
            },
          )) as Record<string, unknown>,
          authorizedSpaceIds,
        };
      });
    },
    async listInventory({ spaceIds, ...args }) {
      return await read(async ({ ctx, principal, spaces }) =>
        documents.listInventory(
          ctx.client,
          await spaces(spaceIds),
          args as documents.InventoryListArgs,
          principalMaxSensitivity(principal),
        ),
      );
    },
    async listReviewQueue({ spaceIds, ...args }) {
      return await read(async ({ ctx, principal, spaces }) =>
        records.listReviewQueue(
          ctx.client,
          await spaces(spaceIds),
          args as records.ReviewQueueListArgs,
          principalMaxSensitivity(principal),
        ),
      );
    },
    async listInvestments({ spaceIds, ...filters }) {
      return await read(async ({ ctx, spaces }) => {
        const authorized = await spaces(spaceIds);
        // An empty authorized set is an empty answer here rather than the
        // `unauthorized` the space predicate would raise: a credential with no
        // readable space asked a question whose answer is "none", and the
        // tool boundary would mask the raise into "Internal error" anyway.
        if (authorized.length === 0) return { investments: [] };
        // One read whatever the household holds: the linked document ids come
        // from the same aggregation as the totals, so this never loads the
        // entries themselves.
        const investments = await admin.listInvestments(
          ctx,
          authorized,
          filters,
        );
        return { investments: investments.map(investmentToolRow) };
      });
    },
    async getInvestment({ spaceIds, investmentId }) {
      return await read(async ({ ctx, spaces }) => {
        const authorized = await spaces(spaceIds);
        if (authorized.length === 0) return null;
        const detail = await admin.getInvestment(
          ctx,
          authorized,
          investmentId,
        );
        if (!detail) return null;
        return {
          ...investmentToolRow(detail),
          entries: detail.entries.map((entry) => ({
            id: entry.id,
            entryType: entry.entryType,
            entryDate: entry.entryDate,
            amount: entry.amount,
            currency: entry.currency,
            exchangeRate: entry.exchangeRate,
            note: entry.note,
            documentId: entry.documentId,
          })),
        };
      });
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
      const embedQuery = await prepareEmbedQuery(withPrincipal, spaceIds, query);
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
      const embedQuery = await prepareEmbedQuery(withPrincipal, spaceIds, query);
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
