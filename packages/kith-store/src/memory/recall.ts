// `blendRecallContext`/`coreLimitFor` are ported unchanged from
// packages/convex/convex/models/recallBlend.ts: a pure function over already
// fetched rows, so nothing about the Postgres move changes it. Two callers
// depended on it in Convex (the `recall_context` MCP tool and the evaluation
// harness) precisely so neither could silently diverge from what the other
// scores; keeping one copy here preserves that.
//
// `recallContext` below was the seam P2-39h left for P2-39g. It still does
// not take a query string or run a search itself: it takes `candidates`, the
// ranked ids an index already produced, and does only what does not depend on
// which index kind produced them -- authorize, hydrate, and blend with the
// core (non-indexed) halves. That split is deliberate and survives P2-39g1,
// because the evaluation harness scores a blend over candidate lists it
// supplies itself.
//
// P2-39g1 supplied the other half. `recallCandidates` in
// `src/embeddings/search.ts` is the real function that turns a query into
// `candidates`: facts from the keyword leg over `facts.search_text_search`,
// thoughts from the hybrid leg over `thoughts.content_search` and
// `embedding_vectors`, which is exactly how `recall_context`'s Convex
// original composed them. The deterministic fake that stood in for it while
// it did not exist is gone; `test/memory.test.mjs` calls the real one.

import type { IdentityCtx } from "../identity/db.js";
import { getFactsByIds, listFacts, type HydratedFact } from "./facts.js";
import { getThoughtsByIds, listCoreBySpaces, type Thought } from "./thoughts.js";

/**
 * Core and relevant thoughts arrive in different shapes in Convex (a
 * hydrated core row and a search index row); here both halves are the same
 * `Thought` shape, so `CoreThought`/`RelevantThought` collapse to one type
 * parameter. Kept generic anyway so `evalRecall`-style scoring code can reuse
 * it against whatever shape it already has, exactly as the Convex original
 * was written to serve both the MCP tool and the evaluation harness.
 */
export type RecallBlendInput<Fact, CoreThought, RelevantThought> = {
  coreFacts: readonly Fact[];
  coreThoughts: readonly CoreThought[];
  relevantFacts: readonly Fact[];
  relevantThoughts: readonly RelevantThought[];
  limit: number;
  factId: (fact: Fact) => string;
  coreThoughtId: (thought: CoreThought) => string;
  relevantThoughtId: (thought: RelevantThought) => string;
};

export type RecallBlend<Fact, CoreThought, RelevantThought> = {
  coreFacts: Fact[];
  coreThoughts: CoreThought[];
  relevanceFacts: Fact[];
  relevanceThoughts: RelevantThought[];
};

/** Core slots available at a given result limit. */
export function coreLimitFor(limit: number): number {
  return Math.min(3, limit);
}

export function blendRecallContext<Fact, CoreThought, RelevantThought>({
  coreFacts,
  coreThoughts,
  relevantFacts,
  relevantThoughts,
  limit,
  factId,
  coreThoughtId,
  relevantThoughtId,
}: RecallBlendInput<Fact, CoreThought, RelevantThought>): RecallBlend<
  Fact,
  CoreThought,
  RelevantThought
> {
  const coreLimit = coreLimitFor(limit);

  // Facts take at most two core slots so an account with many core facts cannot
  // crowd out every core memory.
  const selectedCoreFacts = coreFacts.slice(0, Math.min(2, coreLimit));
  const selectedCoreThoughts = coreThoughts.slice(
    0,
    Math.max(0, coreLimit - selectedCoreFacts.length),
  );

  const coreFactIds = new Set(selectedCoreFacts.map(factId));
  const coreThoughtIds = new Set(selectedCoreThoughts.map(coreThoughtId));

  const relevanceLimit = Math.max(
    0,
    limit - selectedCoreFacts.length - selectedCoreThoughts.length,
  );
  // When both stores have something to say, facts get at least one relevance
  // slot and at most half, so a precise answer is never entirely displaced by
  // narrative and never entirely displaces it.
  const factRelevanceLimit =
    relevantThoughts.length === 0
      ? relevanceLimit
      : Math.min(relevanceLimit, Math.max(1, Math.ceil(relevanceLimit / 2)));

  const relevanceFacts = relevantFacts
    .filter((fact) => !coreFactIds.has(factId(fact)))
    .slice(0, factRelevanceLimit);
  const relevanceThoughts = relevantThoughts
    .filter((thought) => !coreThoughtIds.has(relevantThoughtId(thought)))
    .slice(0, Math.max(0, relevanceLimit - relevanceFacts.length));

  return {
    coreFacts: selectedCoreFacts,
    coreThoughts: selectedCoreThoughts,
    relevanceFacts,
    relevanceThoughts,
  };
}

/** `recall_context`'s own bounds (`apps/web/src/lib/mcp/server.ts`). */
export const RECALL_DEFAULT_LIMIT = 5;
export const RECALL_MAX_LIMIT = 8;

export function boundedRecallLimit(requested: number | undefined): number {
  const limit = requested ?? RECALL_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Recall limit must be a positive integer");
  }
  return Math.min(limit, RECALL_MAX_LIMIT);
}

/** Ranked candidate ids an index (real or, in tests, a deterministic fake) produced. */
export type RecallCandidateIds = {
  factIds: readonly string[];
  thoughtIds: readonly string[];
};

export type RecallContextOptions = {
  limit?: number;
  includeHistorical?: boolean;
};

export type RecallContextResult = RecallBlend<HydratedFact, Thought, Thought>;

/**
 * The seam: core facts and core thoughts are read directly (no index needed),
 * `candidates` are hydrated and authorized, and the whole thing is blended in
 * the same order `blendRecallContext` has always produced. `spaceIds` must
 * already be the caller's authorized read set (`getAuthorizedReadSpaceIds`);
 * this function does not call the identity surface itself, matching every
 * other read in this package.
 */
export async function recallContext(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  candidates: RecallCandidateIds,
  options: RecallContextOptions = {},
): Promise<RecallContextResult> {
  const limit = boundedRecallLimit(options.limit);
  const coreLimit = coreLimitFor(limit);

  // `IdentityCtx` holds one checked-out pg client. Parallel calls only queue
  // queries on that connection and pg 9 rejects concurrent `query()` calls,
  // so keep the read sequence explicit.
  const coreFacts = await listFacts(ctx, spaceIds, { limit: coreLimit, coreOnly: true });
  const coreThoughts = await listCoreBySpaces(ctx, spaceIds, coreLimit);
  const relevantFacts = await getFactsByIds(ctx, spaceIds, candidates.factIds, {
    includeHistorical: options.includeHistorical,
  });
  const relevantThoughts = await getThoughtsByIds(ctx, spaceIds, candidates.thoughtIds, {
    includeHistorical: options.includeHistorical,
  });

  return blendRecallContext({
    coreFacts,
    coreThoughts,
    relevantFacts,
    relevantThoughts,
    limit,
    factId: (fact) => fact.id,
    coreThoughtId: (thought) => thought.id,
    relevantThoughtId: (thought) => thought.id,
  });
}
