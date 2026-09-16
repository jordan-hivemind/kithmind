// P2-39g1: the search legs. A query in, ranked candidates out.
//
// Ported from five places at once, because on Convex one retrieval was one
// action calling several queries and a platform index:
//
//   * `models/thoughts/private.ts:searchByTextAuthorized` -> the keyword leg
//     over `thoughts.content_search` (migration 015).
//   * `models/thoughts/actions.ts:runHybridSearch` and `fuseSearchRanks` ->
//     `searchThoughtsHybrid`, verbatim including the 50 candidate cap, the
//     `includeHistorical ? cap : cap * 4` vector budget and the reciprocal
//     rank constant K = 60.
//   * `models/embeddings/model.ts:resolveAuthorized*VectorCandidates` -> the
//     I7 recheck every vector candidate passes before it is a result.
//   * `models/facts/model.ts:searchFacts` -> the fact keyword leg over
//     `facts.search_text_search`.
//   * `models/documents/mcpActions.ts` plus `models/documents/private.ts:
//     searchWithCandidates` -> the document semantic leg, whose output is the
//     `semantic` argument `searchDocuments` in `../documents/model.ts`
//     already takes.
//
// Three things are deliberately different from the originals.
//
// 1. Authorization. Every function takes an already-authorized `spaceIds`
//    set, this package's convention (`src/memory/facts.ts`,
//    `src/documents/model.ts`). The Convex originals each re-derived the set
//    from a `principal` because each was a separate query on a separate
//    snapshot; here the caller resolves it once and one transaction covers
//    the whole read. Every statement below still carries its own space
//    predicate -- the array narrows the read, it is not the authorization
//    decision.
//
// 2. Embedding the query is injected. `embedQuery: (text) => Promise<{vector,
//    fingerprint}>` replaces `ctx.runAction(...generateEmbeddingWithMetadata)`.
//    The provider lives in `./provider.ts` and a caller wires it; tests need
//    no network, and a read transaction never blocks on an HTTP call it did
//    not ask for.
//
// 3. `runHybridSearch`'s second try/catch is gone. Convex hydrated results in
//    a *later* snapshot than the one the vector candidates were resolved in,
//    so an activation landing in between could invalidate them, and the
//    original recovered by redoing the fusion with the keyword leg alone.
//    One PostgreSQL transaction is one snapshot: the resolve and the hydrate
//    below cannot see different generations, so there is nothing to recover
//    from. The first `vectorStatus = "unavailable"` path is unchanged.
//
// Keyword query construction (P2-39g4). The two keyword legs below, and the
// document leg in `../documents/model.ts`, share one construction from
// `../textSearch.ts`: the query's own stemmed lexemes OR'd together, ranked by
// `ts_rank` so a row matching more of them sorts first. P2-39g1 built all
// three with `websearch_to_tsquery`, which ANDs every significant token; the
// recall instrument then measured keyword recall@10 at 0.167 on the frozen
// corpus, because one ordinary query word absent from a terse memory dropped
// the whole row. That helper's comment carries the measurements behind the
// construction and the rank function. Nothing else about either leg changed:
// the space predicate, the retrievability and status filters, the per-space
// take, the merge and the limit are all as P2-39g1 ported them.
//
// SQL construction. Every identifier below is a literal in this file; every
// value is a bind parameter, including the query vector, which is bound as
// the text literal pgvector accepts (`'[1,0,...]'`) and cast with
// `$n::public.vector`. `assertSearchVector` validates dimension and
// finiteness before anything is bound, so a malformed vector never reaches
// the server. `public.` qualification is required: `withKithTransaction` pins
// `search_path` to `kith` alone, so the extension's type and operators must
// be named in full (migration 015 explains why the extension lives in
// `public`).

import type { CardSearchHit } from "../documents/model.js";
import { row, rows, type IdentityCtx } from "../identity/db.js";
import { camelizeChunk } from "../provenance/rows.js";
import { sha256Utf8 } from "../provenance/sql.js";
import { keywordSearchSql } from "../textSearch.js";
import {
  assertBoundedFactRead,
  assertBoundedHistoryHydration,
  FACT_COLUMNS,
  hydrateFact,
  storedFactFromRow,
  type FactRow,
  type HydratedFact,
  type StoredFact,
} from "../memory/facts.js";
import {
  getThoughtsByIds,
  type Thought,
  type ThoughtType,
} from "../memory/thoughts.js";
import { composeCardTargetInput } from "./cardTargets.js";
import { embeddingVectorScopeV2, type EmbeddingTargetKind } from "./scope.js";
import { BASELINE_EMBEDDING_DIMENSIONS } from "./provider.js";
import {
  compatibleSearchFingerprint,
  findEmbeddingTarget,
  getActiveEmbeddingTarget,
  getActiveTargets,
  MAX_EMBEDDING_TARGET_SPACES,
  type ActiveEmbeddingTarget,
} from "./targets.js";

/** `runHybridSearch`'s fixed candidate budget. */
export const HYBRID_CANDIDATE_CAP = 50;
/** `runHybridSearch`'s default and maximum result limits. */
export const HYBRID_DEFAULT_LIMIT = 10;
export const HYBRID_MAX_LIMIT = 100;
/** `fuseSearchRanks`'s reciprocal-rank constant. */
const FUSION_RRF_K = 60;
/** The document plan's fixed candidate budget, split across spaces and kinds. */
export const MAX_SEMANTIC_CANDIDATES = 32;
/** `resolveAuthorized*VectorCandidates`'s own bounds, ported verbatim. */
const MAX_VECTOR_CANDIDATES = 256;
const MAX_FACT_SEARCH_LIMIT = 50;
const DEFAULT_FACT_SEARCH_LIMIT = 10;
const MAX_FACT_QUERY_CHARS = 12_000;
const MAX_THOUGHT_QUERY_CHARS = 12_000;

export type SearchTarget = {
  spaceId: string;
  embeddingGenerationId?: string;
  fingerprint: string;
};

export type VectorStatus = "ready" | "unavailable";

/** The query embedder a caller injects. See note 2 in the module comment. */
export type EmbedQuery = (
  text: string,
) => Promise<{ vector: readonly number[]; fingerprint: string }>;

/**
 * Validates a query vector and renders the text literal pgvector parses.
 *
 * Dimension and finiteness are checked here rather than by the server so a
 * malformed vector is a typed refusal instead of a 1536-element round trip,
 * and so nothing that is not a finite number can ever reach the literal.
 */
export function assertSearchVector(vector: readonly number[]): string {
  if (
    !Array.isArray(vector) ||
    vector.length !== BASELINE_EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Search vector must have ${BASELINE_EMBEDDING_DIMENSIONS} dimensions`,
    );
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("Search vector must be finite");
    }
  }
  return `[${vector.join(",")}]`;
}

function boundedQuery(query: string, label: string, maxChars: number): string {
  const cleaned = query.trim();
  if (!cleaned || Array.from(cleaned).length > maxChars) {
    throw new Error(`${label} must contain 1-${maxChars} characters`);
  }
  return cleaned;
}

/**
 * The SQL form of `memoryRetrievabilityFilter`
 * (`models/thoughts/model.ts`). A retracted memory is withheld in both modes;
 * a historical read deliberately ignores the business-time window. `$${n}` is
 * the active-at bind position, appended by the caller when it is used.
 */
function retrievabilityPredicate(
  includeHistorical: boolean | undefined,
  activeAtPosition: number,
): string {
  return includeHistorical
    ? "memory_status IS DISTINCT FROM 'retracted'"
    : `(memory_status IS NULL OR memory_status = 'current')
       AND (valid_from IS NULL OR valid_from <= $${activeAtPosition})
       AND (valid_to IS NULL OR $${activeAtPosition} < valid_to)`;
}

export type ThoughtSearchOptions = {
  type?: ThoughtType;
  limit?: number;
  includeHistorical?: boolean;
};

function boundedSearchLimit(
  requested: number | undefined,
  fallback: number,
  max: number,
  label: string,
): number {
  const limit = requested ?? fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.min(limit, max);
}

/**
 * Ranked thought ids from the keyword leg, ported from
 * `searchByTextAuthorized`: one bounded `take(limit)` per space, then the
 * same rank-then-id merge, then one `slice(limit)`.
 *
 * Convex ranked by its own search index's relevance; here it is `ts_rank` over
 * the shared partial-overlap query (`../textSearch.ts`) descending, with `id`
 * ascending as the tiebreak so the merge is deterministic. This is PostgreSQL
 * ordering, not a claim of Convex ranking parity: section 4.2 of the
 * consolidation plan measures recall, which P2-39g4 restored, and score-level
 * parity is not asserted here.
 */
async function thoughtTextCandidateIds(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  query: string,
  options: ThoughtSearchOptions,
): Promise<string[]> {
  const limit = boundedSearchLimit(
    options.limit,
    HYBRID_CANDIDATE_CAP,
    HYBRID_MAX_LIMIT,
    "Thought limit",
  );
  const cleaned = boundedQuery(
    query,
    "Thought search query",
    MAX_THOUGHT_QUERY_CHARS,
  );
  const keyword = keywordSearchSql("content_search", 2);
  const ranked: Array<{ id: string; rank: number }> = [];
  for (const spaceId of [...new Set(spaceIds)]) {
    const values: unknown[] = [spaceId, cleaned];
    let where = `space_id = $1 AND ${keyword.match}`;
    if (options.type) {
      values.push(options.type);
      where += ` AND metadata ->> 'type' = $${values.length}`;
    }
    where += ` AND ${retrievabilityPredicate(options.includeHistorical, values.length + 1)}`;
    if (!options.includeHistorical) values.push(new Date(ctx.now));
    values.push(limit);
    const found = await rows<{ id: string }>(
      ctx,
      `SELECT id FROM kith.thoughts WHERE ${where}
        ORDER BY ${keyword.rank} DESC, id ASC
        LIMIT $${values.length}`,
      values,
    );
    found.forEach((record, rank) => ranked.push({ id: record.id, rank }));
  }
  return ranked
    .sort(
      (left, right) =>
        left.rank - right.rank || left.id.localeCompare(right.id),
    )
    .slice(0, limit)
    .map((candidate) => candidate.id);
}

/**
 * The keyword leg on its own, hydrated. `getThoughtsByIds` (the seam P2-39h
 * left) does the authorize, type and retrievability half, so the SQL filter
 * above and this one agree by construction.
 */
export async function searchThoughtsByText(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  query: string,
  options: ThoughtSearchOptions = {},
): Promise<Thought[]> {
  const ids = await thoughtTextCandidateIds(ctx, spaceIds, query, options);
  return await getThoughtsByIds(ctx, spaceIds, ids, {
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.includeHistorical === undefined
      ? {}
      : { includeHistorical: options.includeHistorical }),
  });
}

type VectorRow = {
  id: string;
  space_id: string;
  embedding_generation_id: string;
  embedding_fingerprint: string;
  target_kind: string;
  thought_id: string | null;
  chunk_id: string | null;
  event_id: string | null;
  processing_generation_id: string | null;
  input_hash: string;
  scope_v2: string;
  similarity: number;
};

const VECTOR_COLUMNS = `id, space_id, embedding_generation_id, embedding_fingerprint,
       target_kind, thought_id, chunk_id, event_id, processing_generation_id,
       input_hash, scope_v2`;

/**
 * One space's nearest vectors of one kind, by cosine distance.
 *
 * `<=>` is pgvector's cosine distance, matching the profile's normalized
 * assumption and Convex's own cosine index. The score is exposed as
 * `1 - distance`, which is the cosine similarity Convex's `_score` carried,
 * so `SIMILARITY_THRESHOLD`-style comparisons in a caller keep their meaning.
 *
 * No index is consulted: migration 015 deliberately creates none, so this is
 * an exact scan of the rows the `(space_id, embedding_fingerprint,
 * target_kind)` predicate admits. Correct and fast at the plan's 180 active
 * targets; the 2,000-target threshold for adding HNSW is recorded there.
 */
async function vectorCandidateRows(
  ctx: IdentityCtx,
  spaceId: string,
  fingerprint: string,
  targetKind: EmbeddingTargetKind,
  vectorLiteral: string,
  limit: number,
): Promise<VectorRow[]> {
  return await rows<VectorRow>(
    ctx,
    `SELECT ${VECTOR_COLUMNS},
            1 - (embedding OPERATOR(public.<=>) $4::public.vector) AS similarity
       FROM kith.embedding_vectors
      WHERE space_id = $1 AND embedding_fingerprint = $2 AND target_kind = $3
      ORDER BY embedding OPERATOR(public.<=>) $4::public.vector ASC, id ASC
      LIMIT $5`,
    [spaceId, fingerprint, targetKind, vectorLiteral, limit],
  );
}

/** Convex's `.flat().sort(score desc, id asc).slice(cap)` over every space. */
function mergeVectorHits(hits: VectorRow[][], cap: number): VectorRow[] {
  return hits
    .flat()
    .sort(
      (left, right) =>
        right.similarity - left.similarity || left.id.localeCompare(right.id),
    )
    .slice(0, cap);
}

function assertCandidateBounds(rowCount: number, targetCount: number): void {
  if (
    rowCount > MAX_VECTOR_CANDIDATES ||
    targetCount > MAX_EMBEDDING_TARGET_SPACES
  ) {
    throw new Error("Embedding candidate hydration exceeds its bound");
  }
}

/**
 * The scope recheck every resolver runs before it trusts a row: the active
 * fingerprint, the stored `scope_v2`, and the target-identity columns of the
 * other two kinds being absent. Migration 015 makes the last one a CHECK as
 * well; the check stays here because a row loaded before that constraint
 * existed is still read by this code.
 */
function vectorRowInScope(
  record: VectorRow,
  active: ActiveEmbeddingTarget | undefined,
  targetKind: EmbeddingTargetKind,
): active is ActiveEmbeddingTarget {
  return (
    active !== undefined &&
    active.fingerprint === record.embedding_fingerprint &&
    record.target_kind === targetKind &&
    record.scope_v2 ===
      embeddingVectorScopeV2({
        spaceId: record.space_id,
        fingerprint: record.embedding_fingerprint,
        targetKind,
      })
  );
}

/**
 * I7, eligibility half. The target table is the live eligibility record, so a
 * row whose target has been retired or rewritten since the vector was written
 * is dropped here even though the vector itself is still well formed.
 */
async function targetIsEligibleFor(
  ctx: IdentityCtx,
  record: VectorRow,
  targetId: string,
): Promise<boolean> {
  const target = await findEmbeddingTarget(
    ctx,
    record.space_id,
    record.target_kind as EmbeddingTargetKind,
    targetId,
  );
  return (
    target !== null &&
    target.state === "eligible" &&
    target.input_hash === record.input_hash
  );
}

/**
 * Loads the active target of each named space once, keyed by space. A space
 * whose pointer is broken is simply absent, which makes every candidate from
 * it fail `vectorRowInScope` -- the same outcome Convex reached by throwing
 * out of `requireActiveEmbeddingTarget` and catching in the action.
 */
function activeTargetsBySpace(
  targets: readonly ActiveEmbeddingTarget[],
): Map<string, ActiveEmbeddingTarget> {
  return new Map(targets.map((target) => [target.spaceId, target]));
}

export type ThoughtVectorCandidate = {
  embeddingVectorId: string;
  thoughtId: string;
  spaceId: string;
  similarity: number;
};

export type ThoughtVectorOptions = {
  type?: ThoughtType;
  includeHistorical?: boolean;
  /** Global candidate budget. Defaults to `runHybridSearch`'s own. */
  cap?: number;
};

/**
 * Ported from `resolveAuthorizedThoughtVectorCandidates`, with the candidate
 * scan (Convex's `ctx.vectorSearch` per target) folded in: on PostgreSQL the
 * scan and the recheck are one transaction, so splitting them into an action
 * and a query would only reintroduce the snapshot gap note 3 removes.
 *
 * `thoughtStatus` is strict (I9): a space whose thought index is incomplete
 * contributes no thought candidates at all.
 */
export async function searchThoughtVectorCandidates(
  ctx: IdentityCtx,
  targets: readonly ActiveEmbeddingTarget[],
  vector: readonly number[],
  options: ThoughtVectorOptions = {},
): Promise<ThoughtVectorCandidate[]> {
  if (targets.length === 0) return [];
  const literal = assertSearchVector(vector);
  const cap =
    options.cap ??
    (options.includeHistorical
      ? HYBRID_CANDIDATE_CAP
      : HYBRID_CANDIDATE_CAP * 4);
  const perSpaceLimit = Math.max(1, Math.floor(cap / targets.length));
  const byKind: VectorRow[][] = [];
  for (const target of targets) {
    byKind.push(
      await vectorCandidateRows(
        ctx,
        target.spaceId,
        target.fingerprint,
        "thought",
        literal,
        perSpaceLimit,
      ),
    );
  }
  const hits = mergeVectorHits(byKind, cap);
  assertCandidateBounds(hits.length, targets.length);
  const active = activeTargetsBySpace(targets);
  const accepted = new Set<string>();
  const results: ThoughtVectorCandidate[] = [];
  const activeAt = ctx.now;
  for (const record of hits) {
    const target = active.get(record.space_id);
    if (!vectorRowInScope(record, target, "thought")) continue;
    if (target.thoughtStatus !== "ready") continue;
    if (
      !record.thought_id ||
      record.chunk_id !== null ||
      record.event_id !== null ||
      record.processing_generation_id !== null
    ) {
      continue;
    }
    // One candidate per target, whatever the scan returned. Candidates arrive
    // in score order, so the best surviving row is the one that is kept.
    const targetKey = `${record.space_id}:${record.thought_id}`;
    if (accepted.has(targetKey)) continue;
    if (!(await targetIsEligibleFor(ctx, record, record.thought_id))) continue;
    const thought = await row<{
      id: string;
      space_id: string;
      content: string;
      memory_status: string | null;
      valid_from: Date | null;
      valid_to: Date | null;
      metadata: { type?: string };
    }>(
      ctx,
      `SELECT id, space_id, content, memory_status, valid_from, valid_to, metadata
         FROM kith.thoughts WHERE id = $1`,
      [record.thought_id],
    );
    if (
      !thought ||
      thought.space_id !== record.space_id ||
      !(
        thought.memory_status === null || thought.memory_status === "current"
      ) ||
      record.input_hash !== (await sha256Utf8(thought.content))
    ) {
      continue;
    }
    // `resolveThoughtVectorCandidatesAuthorized` takes `type`/
    // `includeHistorical`/`activeAt` too; the same two filters are applied
    // here so a candidate the caller could never return does not consume a
    // slot in the fused budget.
    if (options.type !== undefined && thought.metadata?.type !== options.type) {
      continue;
    }
    if (!options.includeHistorical) {
      const from = thought.valid_from?.getTime();
      const to = thought.valid_to?.getTime();
      if (
        (from !== undefined && from > activeAt) ||
        (to !== undefined && to <= activeAt)
      ) {
        continue;
      }
    }
    accepted.add(targetKey);
    results.push({
      embeddingVectorId: record.id,
      thoughtId: thought.id,
      spaceId: record.space_id,
      similarity: record.similarity,
    });
  }
  return results;
}

/** Ported verbatim from `fuseSearchRanks` in `models/thoughts/actions.ts`. */
export function fuseSearchRanks(
  vectorThoughtIds: readonly string[],
  textThoughtIds: readonly string[],
  limit: number,
): { ids: string[]; scores: Map<string, number> } {
  const scores = new Map<string, number>();
  for (const [rank, id] of vectorThoughtIds.entries()) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (FUSION_RRF_K + rank + 1));
  }
  for (const [rank, id] of textThoughtIds.entries()) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (FUSION_RRF_K + rank + 1));
  }
  const ids = [...scores.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, limit)
    .map(([id]) => id);
  return { ids, scores };
}

export type ThoughtSearchHit = Thought & { score: number };

export type HybridSearchOptions = ThoughtSearchOptions & {
  /** Absent turns the vector leg off outright, the way `searchMode: "keyword"` does. */
  embedQuery?: EmbedQuery;
};

/**
 * `runHybridSearch`, ported. The keyword leg always runs. The vector leg runs
 * only when every named space shares one active fingerprint
 * (`compatibleSearchFingerprint`) and the configured provider agrees with it;
 * anything else -- no active target, disagreeing spaces, a provider failure,
 * a fingerprint that moved under the request -- leaves `vectorStatus` at
 * `"unavailable"` and returns the keyword results. A vector outage degrades
 * ranking; it never withholds retained evidence.
 */
export async function searchThoughtsHybrid(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  query: string,
  options: HybridSearchOptions = {},
): Promise<{ results: ThoughtSearchHit[]; vectorStatus: VectorStatus }> {
  const limit = boundedSearchLimit(
    options.limit,
    HYBRID_DEFAULT_LIMIT,
    HYBRID_MAX_LIMIT,
    "Thought limit",
  );
  const uniqueSpaceIds = [...new Set(spaceIds)];
  if (uniqueSpaceIds.length === 0) {
    return { results: [], vectorStatus: "unavailable" };
  }
  const targets = await getActiveTargets(ctx, uniqueSpaceIds);
  const textIds = await thoughtTextCandidateIds(ctx, uniqueSpaceIds, query, {
    ...options,
    limit: HYBRID_CANDIDATE_CAP,
  });

  let vectorStatus: VectorStatus = "unavailable";
  let vectorThoughtIds: string[] = [];
  const expectedFingerprint = compatibleSearchFingerprint(
    uniqueSpaceIds,
    targets,
  );
  if (expectedFingerprint && options.embedQuery) {
    try {
      const generated = await options.embedQuery(query);
      if (generated.fingerprint !== expectedFingerprint) {
        throw new Error("Configured embedding profile mismatch");
      }
      const candidates = await searchThoughtVectorCandidates(
        ctx,
        targets,
        generated.vector,
        {
          ...(options.type === undefined ? {} : { type: options.type }),
          ...(options.includeHistorical === undefined
            ? {}
            : { includeHistorical: options.includeHistorical }),
        },
      );
      vectorThoughtIds = candidates.map((candidate) => candidate.thoughtId);
      vectorStatus = "ready";
    } catch {
      // Ranking degrades; retained keyword evidence does not.
      vectorThoughtIds = [];
      vectorStatus = "unavailable";
    }
  }

  const fused = fuseSearchRanks(vectorThoughtIds, textIds, limit);
  const hydrated = await getThoughtsByIds(ctx, uniqueSpaceIds, fused.ids, {
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.includeHistorical === undefined
      ? {}
      : { includeHistorical: options.includeHistorical }),
  });
  const byId = new Map(hydrated.map((thought) => [thought.id, thought]));
  const results = fused.ids.flatMap((id) => {
    const thought = byId.get(id);
    return thought ? [{ ...thought, score: fused.scores.get(id)! }] : [];
  });
  return { results, vectorStatus };
}

export type FactSearchOptions = {
  limit?: number;
  includeHistorical?: boolean;
};

/**
 * Ported from `models/facts/model.ts:searchFacts`. The Convex search index
 * carried `spaceId` and, for a current-only read, `status` as filter fields;
 * both become ordinary `WHERE` columns here, over the same
 * `facts_space_status_created_idx` the list reads use. The validity window,
 * the per-space `take(limit)`, the rank-then-recency-then-id merge and both
 * bounded-read assertions are unchanged.
 */
export async function searchFacts(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  query: string,
  options: FactSearchOptions = {},
): Promise<HydratedFact[]> {
  const cleaned = boundedQuery(
    query,
    "Fact search query",
    MAX_FACT_QUERY_CHARS,
  );
  const limit = boundedSearchLimit(
    options.limit,
    DEFAULT_FACT_SEARCH_LIMIT,
    MAX_FACT_SEARCH_LIMIT,
    "Fact search limit",
  );
  const uniqueSpaceIds = [...new Set(spaceIds)];
  assertBoundedFactRead(uniqueSpaceIds.length, limit);
  const activeAt = new Date(ctx.now);
  const keyword = keywordSearchSql("search_text_search", 2);
  const ranked: Array<{ fact: StoredFact; rank: number }> = [];
  for (const spaceId of uniqueSpaceIds) {
    const values: unknown[] = [spaceId, cleaned];
    const where = options.includeHistorical
      ? `space_id = $1 AND ${keyword.match} AND status <> 'retracted'`
      : `space_id = $1 AND ${keyword.match}
           AND status = 'current'
           AND (valid_from IS NULL OR valid_from <= $3)
           AND (valid_to IS NULL OR $3 < valid_to)`;
    if (!options.includeHistorical) values.push(activeAt);
    values.push(limit);
    const found = await rows<FactRow>(
      ctx,
      `SELECT ${FACT_COLUMNS} FROM kith.facts WHERE ${where}
        ORDER BY ${keyword.rank} DESC,
                 created_at DESC, id DESC
        LIMIT $${values.length}`,
      values,
    );
    found.forEach((record, rank) =>
      ranked.push({ fact: storedFactFromRow(record), rank }),
    );
  }
  const selected = ranked
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        right.fact.createdAt - left.fact.createdAt ||
        left.fact.id.localeCompare(right.fact.id),
    )
    .slice(0, limit)
    .map(({ fact }) => fact);
  assertBoundedHistoryHydration(selected);
  const authorized = new Set(uniqueSpaceIds);
  const hydrated: HydratedFact[] = [];
  for (const fact of selected) {
    const view = await hydrateFact(ctx, fact, authorized);
    if (view) hydrated.push(view);
  }
  return hydrated;
}

export type DocumentSemanticCandidates = {
  chunkIds: string[];
  cardHits: CardSearchHit[];
  vectorStatus: VectorStatus;
  coverageIncomplete: boolean;
};

/**
 * The document semantic leg: `models/documents/mcpActions.ts`'s per-space
 * candidate scan followed by `searchWithCandidates`'s resolution, returning
 * exactly the `semantic` argument `searchDocuments` already takes.
 *
 * `spaceIds` is an argument the Convex pair did not need at one call site but
 * did use at the other: `searchWithCandidates`'s readiness gate is
 * "every authorized space has an active target under one fingerprint", which
 * cannot be recomputed from `targets` alone, because `targets` is already the
 * filtered set. Passing both keeps the gate honest.
 *
 * Failures are swallowed the way both originals swallow them: a corrupt or
 * changed vector profile degrades ranking to keyword only and never hides
 * retained keyword evidence.
 */
export async function searchChunkAndCardVectorCandidates(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  targets: readonly ActiveEmbeddingTarget[],
  vector: readonly number[],
): Promise<DocumentSemanticCandidates> {
  const unavailable: DocumentSemanticCandidates = {
    chunkIds: [],
    cardHits: [],
    vectorStatus: "unavailable",
    coverageIncomplete: false,
  };
  const uniqueSpaceIds = [...new Set(spaceIds)];
  const targetSpaces = new Set(targets.map((target) => target.spaceId));
  if (
    uniqueSpaceIds.length === 0 ||
    targets.length !== uniqueSpaceIds.length ||
    targetSpaces.size !== uniqueSpaceIds.length
  ) {
    return unavailable;
  }
  const fingerprint = compatibleSearchFingerprint(uniqueSpaceIds, targets);
  if (!fingerprint) return unavailable;

  try {
    const literal = assertSearchVector(vector);
    // D3 B and I10: chunk coverage is a ratio the answer reports, not a gate.
    let coverageIncomplete = false;
    for (const spaceId of uniqueSpaceIds) {
      const active = await getActiveEmbeddingTarget(ctx, spaceId);
      if (!active || active.fingerprint !== fingerprint) return unavailable;
      if (active.chunkCoverage.covered < active.chunkCoverage.eligible) {
        coverageIncomplete = true;
      }
    }
    // Both kinds ask for the space's full share and the merge below keeps the
    // global top 32, so a space with no card targets loses none of its chunk
    // budget.
    const ordered = [...targets].sort((left, right) =>
      left.spaceId.localeCompare(right.spaceId),
    );
    const collected: VectorRow[][] = [];
    for (const [index, target] of ordered.entries()) {
      const limit =
        Math.floor(MAX_SEMANTIC_CANDIDATES / ordered.length) +
        (index < MAX_SEMANTIC_CANDIDATES % ordered.length ? 1 : 0);
      for (const targetKind of ["chunk", "card"] as const) {
        collected.push(
          await vectorCandidateRows(
            ctx,
            target.spaceId,
            target.fingerprint,
            targetKind,
            literal,
            limit,
          ),
        );
      }
    }
    const hits = mergeVectorHits(collected, MAX_SEMANTIC_CANDIDATES);
    assertCandidateBounds(hits.length, targets.length);
    const active = activeTargetsBySpace(targets);
    const chunkIds = await resolveChunkCandidates(ctx, hits, active);
    const cardHits = await resolveCardCandidates(ctx, hits, active);
    return {
      chunkIds,
      cardHits,
      vectorStatus: "ready",
      coverageIncomplete,
    };
  } catch {
    return unavailable;
  }
}

/** Ported from `resolveAuthorizedChunkVectorCandidates`. */
async function resolveChunkCandidates(
  ctx: IdentityCtx,
  hits: readonly VectorRow[],
  active: ReadonlyMap<string, ActiveEmbeddingTarget>,
): Promise<string[]> {
  const accepted = new Set<string>();
  const chunkIds: string[] = [];
  for (const record of hits) {
    const target = active.get(record.space_id);
    // I10: an incomplete chunk index is reported by the caller, never a
    // reason to drop a candidate whose own target is covered and eligible.
    if (!vectorRowInScope(record, target, "chunk")) continue;
    if (
      !record.chunk_id ||
      !record.processing_generation_id ||
      record.thought_id !== null
    ) {
      continue;
    }
    const targetKey = `${record.space_id}:${record.chunk_id}`;
    if (accepted.has(targetKey)) continue;
    if (!(await targetIsEligibleFor(ctx, record, record.chunk_id))) continue;
    const chunkRow = await row<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.chunks WHERE id = $1",
      [record.chunk_id],
    );
    if (!chunkRow) continue;
    const chunk = camelizeChunk(chunkRow);
    if (
      chunk.spaceId !== record.space_id ||
      chunk.processingGenerationId !== record.processing_generation_id ||
      chunk.publicationState !== "active" ||
      record.input_hash !== (await sha256Utf8(chunk.text))
    ) {
      continue;
    }
    const document = await row<{
      id: string;
      space_id: string;
      publication_state: string;
      processing_generation_id: string;
    }>(
      ctx,
      `SELECT id, space_id, publication_state, processing_generation_id
         FROM kith.documents WHERE id = $1`,
      [chunk.documentId],
    );
    const generation = await row<{
      id: string;
      space_id: string;
      source_item_id: string;
      state: string;
    }>(
      ctx,
      `SELECT id, space_id, source_item_id, state FROM kith.processing_generations
        WHERE id = $1`,
      [chunk.processingGenerationId],
    );
    const item = generation
      ? await row<{
          id: string;
          space_id: string;
          active_generation_id: string | null;
        }>(
          ctx,
          `SELECT id, space_id, active_generation_id FROM kith.source_items WHERE id = $1`,
          [generation.source_item_id],
        )
      : null;
    if (
      !document ||
      !generation ||
      !item ||
      document.publication_state !== "active" ||
      document.processing_generation_id !== generation.id ||
      generation.state !== "ready" ||
      item.active_generation_id !== generation.id ||
      item.space_id !== record.space_id
    ) {
      continue;
    }
    accepted.add(targetKey);
    chunkIds.push(chunk.id);
  }
  return chunkIds;
}

/**
 * Ported from `resolveAuthorizedCardVectorCandidates`. A card hit answers
 * "find the document" rather than "find the passage", so it resolves to the
 * documents the card describes, the card's extractive summary as the passage,
 * the live card generation as the evidence pointer, and the card's own
 * evidence spans.
 *
 * I7 in full: the active fingerprint, the target row's eligibility and hash,
 * and the live card generation are all rechecked. A vector written against a
 * card generation that has since been superseded or abandoned recomposes to a
 * different hash, or to nothing at all, and is dropped.
 */
async function resolveCardCandidates(
  ctx: IdentityCtx,
  hits: readonly VectorRow[],
  active: ReadonlyMap<string, ActiveEmbeddingTarget>,
): Promise<CardSearchHit[]> {
  const accepted = new Set<string>();
  const cardHits: CardSearchHit[] = [];
  for (const record of hits) {
    const target = active.get(record.space_id);
    if (!vectorRowInScope(record, target, "card")) continue;
    if (
      !record.event_id ||
      record.thought_id !== null ||
      record.chunk_id !== null
    ) {
      continue;
    }
    const targetKey = `${record.space_id}:${record.event_id}`;
    if (accepted.has(targetKey)) continue;
    if (!(await targetIsEligibleFor(ctx, record, record.event_id))) continue;
    const event = await row<{
      id: string;
      space_id: string;
      source_item_id: string | null;
      event_key: string | null;
    }>(
      ctx,
      `SELECT id, space_id, source_item_id, event_key FROM kith.events WHERE id = $1`,
      [record.event_id],
    );
    if (
      !event ||
      event.space_id !== record.space_id ||
      !event.source_item_id ||
      event.event_key !== "card:document_card"
    ) {
      continue;
    }
    const composed = await composeCardTargetInput(
      ctx,
      record.space_id,
      event.source_item_id,
      event,
    );
    if (
      !composed ||
      composed.documentIds.length === 0 ||
      record.input_hash !== (await sha256Utf8(composed.text))
    ) {
      continue;
    }
    accepted.add(targetKey);
    for (const documentId of composed.documentIds) {
      cardHits.push({
        eventId: event.id,
        spaceId: record.space_id,
        documentId,
        cardGenerationId: composed.cardGenerationId,
        summary: composed.summary,
        evidenceSpanIds: composed.evidenceSpanIds,
      });
    }
  }
  return cardHits;
}

export type RecallCandidateOptions = {
  limit?: number;
  includeHistorical?: boolean;
  embedQuery?: EmbedQuery;
};

/**
 * The function `src/memory/recall.ts` says P2-39g must add: a query in,
 * `{factIds, thoughtIds}` out, ready for `recallContext` to authorize,
 * hydrate and blend. It is the real ranker the deterministic fake in
 * `test/helpers/memoryFixture.mjs` stood in for.
 *
 * Facts come from the keyword leg alone, thoughts from the hybrid one,
 * matching `recall_context`'s Convex composition exactly: facts had one
 * search index and no vectors, thoughts had both.
 *
 * `thoughtScores` is the fused rank score for each returned thought id, keyed
 * by id. `recall_context` reports a `score` on every relevance thought it
 * returns, and hydration by id cannot recover it, so the ranker hands it back
 * with the ids rather than making the caller run the search twice. Facts carry
 * no score on that surface and none is returned for them.
 */
export async function recallCandidates(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  query: string,
  options: RecallCandidateOptions = {},
): Promise<{
  factIds: string[];
  thoughtIds: string[];
  thoughtScores: Map<string, number>;
  vectorStatus: VectorStatus;
}> {
  if (spaceIds.length === 0) {
    return {
      factIds: [],
      thoughtIds: [],
      thoughtScores: new Map(),
      vectorStatus: "unavailable",
    };
  }
  const facts = await searchFacts(ctx, spaceIds, query, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.includeHistorical === undefined
      ? {}
      : { includeHistorical: options.includeHistorical }),
  });
  const thoughts = await searchThoughtsHybrid(ctx, spaceIds, query, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.includeHistorical === undefined
      ? {}
      : { includeHistorical: options.includeHistorical }),
    ...(options.embedQuery === undefined
      ? {}
      : { embedQuery: options.embedQuery }),
  });
  return {
    factIds: facts.map((fact) => fact.id),
    thoughtIds: thoughts.results.map((thought) => thought.id),
    thoughtScores: new Map(
      thoughts.results.map((thought) => [thought.id, thought.score]),
    ),
    vectorStatus: thoughts.vectorStatus,
  };
}
