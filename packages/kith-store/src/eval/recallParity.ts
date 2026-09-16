// P2-39g3: the retrieval parity instrument, rerun against PostgreSQL.
//
// `docs/plans/2026-09-12-postgres-consolidation.md` section 4.2 fixes the
// acceptance: rerun the frozen question set and controls from
// `packages/convex/convex/models/thoughts/memoryEval.corpus.ts` against
// PostgreSQL, scored by the same `evaluateRetrievalCase` (`./memoryEval.ts`,
// ported verbatim), with every miss explained. This module is the seeding and
// scoring half; `packages/kith-store/test/recallParity.test.mjs` and
// `packages/kith-store/eval/run-recall-parity.mjs` are its two callers.
//
// Two phases, not one function, because the hybrid leg needs a seam between
// them: `seedRecallCorpus` writes the corpus through the real memory
// services (`captureThought`, `transitionMemory`, `rememberFact`) and returns
// every seeded id; a caller that wants the semantic leg exercised inserts
// embedding-index rows keyed by those ids (see `eval/run-recall-parity.mjs`,
// which does this the way `test/helpers/embeddingFixture.mjs` does for
// tests) before calling `scoreRecallCorpus`. `runRecallParity` is the
// keyword-mode convenience that does both steps back to back, which is all
// `test/recallParity.test.mjs` needs.
//
// Scoring itself calls `recallCandidates` (the hybrid thought leg plus the
// fact keyword leg -- see `src/embeddings/search.ts`'s module comment) and
// then blends with `recallContext`/`blendRecallContext`
// (`src/memory/recall.ts`), exactly as `evalRecall.ts`'s Convex baseline
// composed `hybridSearch` and `recallPersonalFacts` through the same blend.
// One deliberate difference: `recallContext`'s own limit is capped at
// `RECALL_MAX_LIMIT` (8), which is the MCP tool's bound, not the scorer's.
// `evalRecall.ts` scored k=5 and k=10 by calling `blendRecallContext`
// directly for the wider window; this file does the same, only bypassing the
// cap for the k=10 score. Both cutoffs are still scored on the exact
// candidate lists `recallCandidates` produced -- nothing is re-fetched, so
// there is no snapshot gap between them.
//
// Every read here is against one account's own space alone
// (`[seededAccount.spaceId]`), never the union of both. That is deliberate:
// this corpus's whole point is two accounts holding deliberately
// confusable memories, so a tenant leak can only mean the space predicate in
// `src/embeddings/search.ts` or `src/memory/{facts,thoughts}.ts` let another
// space's row through, not that the query happened to search more than one
// space.

import type { HydratedFact } from "../memory/facts.js";
import {
  getFactsByIds,
  listFacts,
  rememberFact,
} from "../memory/facts.js";
import type { Thought } from "../memory/thoughts.js";
import {
  captureThought,
  getThoughtsByIds,
  listCoreBySpaces,
  transitionMemory,
  type CaptureThoughtArgs,
} from "../memory/thoughts.js";
import {
  blendRecallContext,
  coreLimitFor,
  recallContext,
} from "../memory/recall.js";
import { exec, type IdentityCtx } from "../identity/db.js";
import { newKithId } from "../ids.js";
import {
  recallCandidates,
  type EmbedQuery,
  type VectorStatus,
} from "../embeddings/search.js";
import {
  evaluateRetrievalCase,
  type RetrievalEvaluationResult,
} from "./memoryEval.js";
import { liveRecallCorpus, type SeedFact } from "./corpus.js";

/** `evalRecall.ts`'s own baseline search budget, unchanged. */
const SEARCH_LIMIT = 10;
/** The narrower cutoff `recall_context` defaults to. */
const NARROW_LIMIT = 5;
const SEED_REASON = "memory eval baseline seed";

function seedThoughtMetadata(content: string): CaptureThoughtArgs["metadata"] {
  return { type: "reference", topics: [], people: [], actionItems: [], summary: content };
}

function parseValidity(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Corpus validity date is not parseable: ${value}`);
  }
  return parsed;
}

/** A user row. Self-contained (not imported from `test/helpers`) so a real
 * script can seed a corpus without depending on the test tree. */
async function seedUser(ctx: IdentityCtx, label: string): Promise<string> {
  const id = newKithId();
  await exec(ctx, "INSERT INTO kith.users (id, email, name) VALUES ($1, NULL, $2)", [
    id,
    `memory-eval-${label}`,
  ]);
  return id;
}

/** One personal space and its one owning membership. */
async function seedPersonalSpace(ctx: IdentityCtx, userId: string, label: string): Promise<string> {
  const spaceId = newKithId();
  await exec(
    ctx,
    "INSERT INTO kith.spaces (id, kind, name, created_by) VALUES ($1, 'personal', $2, $3)",
    [spaceId, `memory-eval-${label}`, userId],
  );
  await exec(
    ctx,
    "INSERT INTO kith.space_members (id, space_id, user_id, role) VALUES ($1, $2, $3, 'owner')",
    [newKithId(), spaceId, userId],
  );
  return spaceId;
}

export type SeededThought = { key: string; id: string; content: string };
export type SeededFact = { key: string; id: string };

export type SeededAccount = {
  label: string;
  userId: string;
  spaceId: string;
  thoughts: SeededThought[];
  facts: SeededFact[];
};

export type SeedCorpusResult = {
  accounts: SeededAccount[];
};

function findPriorFact(facts: readonly SeedFact[], key: string): SeedFact | undefined {
  return facts.find((candidate) => candidate.key === key);
}

/**
 * Seeds the frozen two-account corpus as two users, each with one personal
 * space, through the real memory services: `captureThought` for a plain
 * memory, `transitionMemory` for one that supersedes or retracts a prior key,
 * `rememberFact` for a fact (with `changeKind: "corrected"` for one the
 * corpus marks `corrects`). No embedding is written -- P2-39g1 already
 * documents that a capture through `src/memory/thoughts.ts` leaves an
 * unindexed target for the embedding build workstream to pick up, and a
 * caller that wants the hybrid leg exercised inserts vectors itself between
 * this function and `scoreRecallCorpus` (see the module comment).
 */
export async function seedRecallCorpus(ctx: IdentityCtx): Promise<SeedCorpusResult> {
  const accounts: SeededAccount[] = [];
  for (const account of liveRecallCorpus) {
    const userId = await seedUser(ctx, account.label);
    const spaceId = await seedPersonalSpace(ctx, userId, account.label);

    const thoughtIdByKey = new Map<string, string>();
    const thoughts: SeededThought[] = [];
    for (const memory of account.memories) {
      const args: CaptureThoughtArgs = {
        content: memory.content,
        metadata: seedThoughtMetadata(memory.content),
        ...(memory.isCore === undefined ? {} : { isCore: memory.isCore }),
        ...(memory.validFrom === undefined ? {} : { validFrom: parseValidity(memory.validFrom) }),
        ...(memory.validTo === undefined ? {} : { validTo: parseValidity(memory.validTo) }),
      };
      const priorKey = memory.supersedes ?? memory.retracts;
      let thoughtId: string;
      if (priorKey === undefined) {
        thoughtId = await captureThought(ctx, userId, spaceId, args);
      } else {
        const priorId = thoughtIdByKey.get(priorKey);
        if (priorId === undefined) {
          throw new Error(`Corpus memory "${memory.key}" references unseeded key "${priorKey}"`);
        }
        thoughtId = await transitionMemory(
          ctx,
          userId,
          spaceId,
          args,
          [priorId],
          memory.retracts === undefined ? "superseded" : "retracted",
          SEED_REASON,
          ctx.now,
        );
      }
      thoughtIdByKey.set(memory.key, thoughtId);
      thoughts.push({ key: memory.key, id: thoughtId, content: memory.content });
    }

    const factIdByKey = new Map<string, string>();
    const facts: SeededFact[] = [];
    for (const fact of account.facts ?? []) {
      if (fact.corrects !== undefined) {
        const prior = findPriorFact(account.facts ?? [], fact.corrects);
        // Correction metadata is driven by subject and predicate, so a
        // dangling or mismatched reference would silently seed an ordinary
        // fact and quietly weaken the case that depends on it.
        if (
          prior === undefined ||
          !factIdByKey.has(fact.corrects) ||
          prior.subjectKey !== fact.subjectKey ||
          prior.predicate !== fact.predicate
        ) {
          throw new Error(
            `Corpus fact "${fact.key}" corrects "${fact.corrects}", which is not an already-seeded fact with the same subject and predicate`,
          );
        }
      }
      const result = await rememberFact(ctx, userId, spaceId, {
        subject: { key: fact.subjectKey, kind: "person", name: fact.subjectName },
        predicate: fact.predicate,
        value: { type: "text", value: fact.value },
        sourceType: "user_stated",
        ...(fact.isCore === undefined ? {} : { isCore: fact.isCore }),
        ...(fact.validFrom === undefined ? {} : { validFrom: parseValidity(fact.validFrom) }),
        ...(fact.corrects === undefined
          ? {}
          : { changeKind: "corrected" as const, changeReason: SEED_REASON }),
      });
      factIdByKey.set(fact.key, result.factId);
      facts.push({ key: fact.key, id: result.factId });
    }

    accounts.push({ label: account.label, userId, spaceId, thoughts, facts });
  }
  return { accounts };
}

export type RecallParityMode = "keyword" | "hybrid";

export type RecallParityQueryResult = {
  name: string;
  account: string;
  query: string;
  recallAtFive: number;
  recallAtTen: number;
  tenantLeakIds: string[];
  historicalLeakIds: string[];
  missingExactStrings: string[];
  forbiddenStringsPresent: string[];
  returnedKeys: string[];
  vectorStatus: VectorStatus;
  passed: boolean;
};

export type RecallParityReport = {
  mode: RecallParityMode;
  recallAtFive: number;
  recallAtTen: number;
  totalTenantLeaks: number;
  totalHistoricalLeaks: number;
  blockingFailures: string[];
  passed: boolean;
  queries: RecallParityQueryResult[];
};

export type RunRecallParityOptions = {
  /** Absent runs keyword-only, matching `searchThoughtsHybrid`'s own
   * `searchMode: "keyword"` path. The mode label in the report is derived
   * from whether this is supplied, not asserted separately. */
  embedQuery?: EmbedQuery;
};

type Blend = {
  coreFacts: HydratedFact[];
  coreThoughts: Thought[];
  relevanceFacts: HydratedFact[];
  relevanceThoughts: Thought[];
};

function toThoughtResult(
  thought: Thought,
  ownerByThoughtId: ReadonlyMap<string, { key: string; label: string }>,
): RetrievalEvaluationResult {
  const owner = ownerByThoughtId.get(thought.id);
  return {
    id: owner?.key ?? `unseeded:${thought.id}`,
    userId: owner?.label ?? "unknown",
    memoryStatus: thought.memoryStatus ?? "current",
    content: thought.content,
  };
}

function toFactResult(
  fact: HydratedFact,
  ownerByFactId: ReadonlyMap<string, { key: string; label: string }>,
): RetrievalEvaluationResult {
  const owner = ownerByFactId.get(fact.id);
  return {
    id: owner?.key ?? `unseeded:${fact.id}`,
    userId: owner?.label ?? "unknown",
    memoryStatus: fact.status === "superseded" || fact.status === "retracted" ? fact.status : "current",
    content: fact.statement,
  };
}

/**
 * Scores every corpus query against an already-seeded database.
 *
 * `recallCandidates` is `src/embeddings/search.ts`'s ranker: the fact keyword
 * leg and the thought hybrid leg (keyword always, vector when `embedQuery` is
 * supplied and the space's active target agrees with it), exactly the
 * composition `recall_context` uses in production. `recallContext` blends the
 * candidates with the core (non-indexed) halves at the k=5 cutoff, within its
 * own `RECALL_MAX_LIMIT`; the k=10 cutoff calls `blendRecallContext` directly
 * with the same core and candidate reads, because `recallContext`'s cap would
 * otherwise silently narrow the wider window `evalRecall.ts`'s baseline also
 * scored.
 */
export async function scoreRecallCorpus(
  ctx: IdentityCtx,
  seed: SeedCorpusResult,
  options: RunRecallParityOptions = {},
): Promise<RecallParityReport> {
  const mode: RecallParityMode = options.embedQuery ? "hybrid" : "keyword";
  const ownerByThoughtId = new Map<string, { key: string; label: string }>();
  const ownerByFactId = new Map<string, { key: string; label: string }>();
  for (const account of seed.accounts) {
    for (const thought of account.thoughts) {
      ownerByThoughtId.set(thought.id, { key: thought.key, label: account.label });
    }
    for (const fact of account.facts) {
      ownerByFactId.set(fact.id, { key: fact.key, label: account.label });
    }
  }

  const toResults = (blend: Blend): RetrievalEvaluationResult[] => [
    ...blend.coreFacts.map((fact) => toFactResult(fact, ownerByFactId)),
    ...blend.coreThoughts.map((thought) => toThoughtResult(thought, ownerByThoughtId)),
    ...blend.relevanceFacts.map((fact) => toFactResult(fact, ownerByFactId)),
    ...blend.relevanceThoughts.map((thought) => toThoughtResult(thought, ownerByThoughtId)),
  ];

  const results: RecallParityQueryResult[] = [];
  for (const account of liveRecallCorpus) {
    const seededAccount = seed.accounts.find((candidate) => candidate.label === account.label);
    if (!seededAccount) throw new Error(`Corpus account "${account.label}" was not seeded`);
    const spaceIds = [seededAccount.spaceId];

    for (const query of account.queries) {
      const candidates = await recallCandidates(ctx, spaceIds, query.query, {
        limit: SEARCH_LIMIT,
        ...(query.includeHistorical === undefined ? {} : { includeHistorical: query.includeHistorical }),
        ...(options.embedQuery === undefined ? {} : { embedQuery: options.embedQuery }),
      });

      const atFive = await recallContext(ctx, spaceIds, candidates, {
        limit: NARROW_LIMIT,
        ...(query.includeHistorical === undefined ? {} : { includeHistorical: query.includeHistorical }),
      });

      // See the module comment: `recallContext`'s own cap is `RECALL_MAX_LIMIT`
      // (8), below `SEARCH_LIMIT` (10), so the wider cutoff is built from the
      // same primitives directly rather than through that cap.
      const coreLimit = coreLimitFor(SEARCH_LIMIT);
      const coreFacts = await listFacts(ctx, spaceIds, { limit: coreLimit, coreOnly: true });
      const coreThoughts = await listCoreBySpaces(ctx, spaceIds, coreLimit);
      const relevantFacts = await getFactsByIds(ctx, spaceIds, candidates.factIds, {
        ...(query.includeHistorical === undefined ? {} : { includeHistorical: query.includeHistorical }),
      });
      const relevantThoughts = await getThoughtsByIds(ctx, spaceIds, candidates.thoughtIds, {
        ...(query.includeHistorical === undefined ? {} : { includeHistorical: query.includeHistorical }),
      });
      const atTen = blendRecallContext({
        coreFacts,
        coreThoughts,
        relevantFacts,
        relevantThoughts,
        limit: SEARCH_LIMIT,
        factId: (fact) => fact.id,
        coreThoughtId: (thought) => thought.id,
        relevantThoughtId: (thought) => thought.id,
      });

      const blendedAtFive = toResults(atFive);
      const blendedAtTen = toResults(atTen);

      const shared = {
        name: `${account.label}: ${query.name}`,
        query: query.query,
        expectedUserId: account.label,
        expectedIds: query.expectedKeys,
        ...(query.includeHistorical === undefined ? {} : { includeHistorical: query.includeHistorical }),
        ...(query.expectedExactStrings === undefined ? {} : { expectedExactStrings: query.expectedExactStrings }),
        ...(query.forbiddenExactStrings === undefined ? {} : { forbiddenExactStrings: query.forbiddenExactStrings }),
      };
      const scoredFive = evaluateRetrievalCase({ ...shared, results: blendedAtFive, k: NARROW_LIMIT });
      const scoredTen = evaluateRetrievalCase({ ...shared, results: blendedAtTen, k: SEARCH_LIMIT });

      results.push({
        name: query.name,
        account: account.label,
        query: query.query,
        recallAtFive: scoredFive.recallAtK,
        recallAtTen: scoredTen.recallAtK,
        tenantLeakIds: scoredTen.tenantLeakIds,
        historicalLeakIds: scoredTen.unexpectedHistoricalIds,
        missingExactStrings: scoredTen.missingExactStrings,
        forbiddenStringsPresent: scoredTen.presentForbiddenStrings,
        returnedKeys: blendedAtTen.map((result) => result.id),
        vectorStatus: candidates.vectorStatus,
        passed: scoredTen.passed,
      });
    }
  }

  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
  // A tenant leak or a retracted/stale memory presented as history is a
  // release blocker, matching `evalRecall.ts`'s own blocking definition. A
  // missing exact string or a recall shortfall is reported but does not, on
  // its own, block: PostgreSQL full-text search stems rather than the
  // prefix/typo-tolerant Convex search index it replaces (section 2.7 of the
  // consolidation plan), so a keyword-recall difference is expected and is
  // reported by name rather than asserted away.
  const blocking = results.filter(
    (result) =>
      result.tenantLeakIds.length > 0 ||
      result.historicalLeakIds.length > 0 ||
      result.forbiddenStringsPresent.length > 0,
  );

  return {
    mode,
    recallAtFive: mean(results.map((result) => result.recallAtFive)),
    recallAtTen: mean(results.map((result) => result.recallAtTen)),
    totalTenantLeaks: results.reduce((total, result) => total + result.tenantLeakIds.length, 0),
    totalHistoricalLeaks: results.reduce((total, result) => total + result.historicalLeakIds.length, 0),
    blockingFailures: blocking.map((result) => `${result.account}: ${result.name}`),
    passed: blocking.length === 0,
    queries: results,
  };
}

/** Seeds and scores in one call -- what `test/recallParity.test.mjs` needs
 * for the keyword-only mode. A hybrid-mode caller uses `seedRecallCorpus`
 * and `scoreRecallCorpus` directly so it can insert embedding-index rows
 * between the two (see the module comment and `eval/run-recall-parity.mjs`). */
export async function runRecallParity(
  ctx: IdentityCtx,
  options: RunRecallParityOptions = {},
): Promise<RecallParityReport> {
  const seed = await seedRecallCorpus(ctx);
  return scoreRecallCorpus(ctx, seed, options);
}
