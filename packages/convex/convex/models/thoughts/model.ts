import type { Infer } from "convex/values";
import type { Expression, FilterBuilder, NamedTableInfo } from "convex/server";

import type { DataModel, Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import {
  bumpEmbeddingEligibilityEpoch,
  deleteActiveThoughtEmbeddingVectors,
  insertThoughtEmbedding,
  markEligibilityTargets,
  requireActiveEmbeddingTarget,
} from "../embeddings/model";
import {
  readSpaceCounters,
  type SpaceEmbeddingCoverage,
} from "../embeddings/targets";
import { isFactActive } from "../facts/model";
import {
  assertValidMemoryValidity,
  isCurrentMemory,
  isMemoryActive,
  safeSupersededValidTo,
  type MemoryStatus,
  type MemoryValidity,
} from "./memoryLifecycle";
import { memorySourceType, thoughtMetadata } from "./validators";

type ThoughtMetadata = Infer<typeof thoughtMetadata>;
type MemorySourceType = Infer<typeof memorySourceType>;

type ThoughtProvenance = {
  sourceType?: MemorySourceType;
  sourceRef?: string;
  observedAt?: number;
  batchId?: string;
  confidence?: number;
};

type ThoughtEmbeddingWrite = {
  embeddingGenerationId?: Id<"embeddingGenerations">;
  embeddingFingerprint?: string;
};

export const DEFAULT_CORE_MEMORY_LIMIT = 10;
export const MAX_CORE_MEMORY_LIMIT = 25;
export const DEFAULT_THOUGHT_LIMIT = 20;
export const MAX_THOUGHT_LIMIT = 100;
const MAX_FILTER_SCAN = 1_000;
export const MAX_THOUGHT_STATS_ROWS = 10_000;

export function boundedThoughtLimit(
  requestedLimit: number | undefined,
  defaultLimit: number = DEFAULT_THOUGHT_LIMIT,
): number {
  const limit = requestedLimit ?? defaultLimit;
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    throw new Error("Thought limit must be a positive integer");
  }
  return Math.min(limit, MAX_THOUGHT_LIMIT);
}

function compareNewestFirst(
  left: { _creationTime: number; _id: Id<"thoughts"> },
  right: { _creationTime: number; _id: Id<"thoughts"> },
) {
  return (
    right._creationTime - left._creationTime ||
    String(left._id).localeCompare(String(right._id))
  );
}

export async function _findById(ctx: QueryCtx, id: Id<"thoughts">) {
  return await ctx.db.get(id);
}

type ThoughtFilterBuilder = FilterBuilder<
  NamedTableInfo<DataModel, "thoughts">
>;

/**
 * Express memory lifecycle and business-time validity inside a Convex query.
 * Legacy rows omit `memoryStatus`, so undefined remains equivalent to current.
 * Applying this before `take` fills the requested result window without trying
 * to issue a second `.paginate()` call in the same function execution.
 */
export function memoryRetrievabilityFilter(
  q: ThoughtFilterBuilder,
  includeHistorical: boolean | undefined,
  activeAt: number,
): Expression<boolean> {
  const memoryStatus = q.field("memoryStatus");
  if (includeHistorical) {
    return q.neq(memoryStatus, "retracted");
  }

  const validFrom = q.field("validFrom");
  const validTo = q.field("validTo");
  return q.and(
    q.or(q.eq(memoryStatus, undefined), q.eq(memoryStatus, "current")),
    q.or(
      q.eq(validFrom, undefined),
      q.lte(validFrom as Expression<number>, activeAt),
    ),
    q.or(
      q.eq(validTo, undefined),
      q.gt(validTo as Expression<number>, activeAt),
    ),
  );
}

export async function _listByUser(
  ctx: QueryCtx,
  userId: Id<"users">,
  limit: number = 20,
  includeHistorical = false,
) {
  const activeAt = Date.now();
  return await ctx.db
    .query("thoughts")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .order("desc")
    .filter((q) => memoryRetrievabilityFilter(q, includeHistorical, activeAt))
    .take(limit);
}

export async function _listBySpaces(
  ctx: QueryCtx,
  spaceIds: readonly Id<"spaces">[],
  requestedLimit: number | undefined,
  includeHistorical = false,
  filters?: { type?: ThoughtMetadata["type"]; topic?: string },
) {
  const limit = boundedThoughtLimit(requestedLimit);
  const activeAt = Date.now();
  const rows = await Promise.all(
    spaceIds.map(async (spaceId) => {
      const query = filters?.type
        ? ctx.db
            .query("thoughts")
            .withIndex("by_spaceId_and_type", (q) =>
              q.eq("spaceId", spaceId).eq("metadata.type", filters.type!),
            )
        : ctx.db
            .query("thoughts")
            .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId));
      const candidates = await query
        .order("desc")
        .filter((q) =>
          memoryRetrievabilityFilter(q, includeHistorical, activeAt),
        )
        .take(filters?.topic ? MAX_FILTER_SCAN + 1 : limit);
      if (candidates.length > MAX_FILTER_SCAN) {
        throw new Error("Thought topic filter exceeds the bounded scan");
      }
      return filters?.topic
        ? candidates.filter((thought) =>
            thought.metadata.topics.includes(filters.topic!),
          )
        : candidates;
    }),
  );
  return rows.flat().sort(compareNewestFirst).slice(0, limit);
}

export async function _listCoreByUser(
  ctx: QueryCtx,
  userId: Id<"users">,
  requestedLimit: number = DEFAULT_CORE_MEMORY_LIMIT,
) {
  if (
    !Number.isFinite(requestedLimit) ||
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1
  ) {
    throw new Error("Core memory limit must be a positive integer");
  }
  const limit = Math.min(requestedLimit, MAX_CORE_MEMORY_LIMIT);
  const activeAt = Date.now();
  return await ctx.db
    .query("thoughts")
    .withIndex("by_userId_and_isCore", (q) =>
      q.eq("userId", userId).eq("isCore", true),
    )
    .order("desc")
    .filter((q) => memoryRetrievabilityFilter(q, false, activeAt))
    .take(limit);
}

export async function _listCoreBySpaces(
  ctx: QueryCtx,
  spaceIds: readonly Id<"spaces">[],
  requestedLimit: number | undefined,
) {
  const rawLimit = requestedLimit ?? DEFAULT_CORE_MEMORY_LIMIT;
  if (
    !Number.isFinite(rawLimit) ||
    !Number.isInteger(rawLimit) ||
    rawLimit < 1
  ) {
    throw new Error("Core memory limit must be a positive integer");
  }
  const limit = Math.min(rawLimit, MAX_CORE_MEMORY_LIMIT);
  const activeAt = Date.now();
  const rows = await Promise.all(
    spaceIds.map((spaceId) =>
      ctx.db
        .query("thoughts")
        .withIndex("by_spaceId_and_isCore", (q) =>
          q.eq("spaceId", spaceId).eq("isCore", true),
        )
        .order("desc")
        .filter((q) => memoryRetrievabilityFilter(q, false, activeAt))
        .take(limit),
    ),
  );
  return rows.flat().sort(compareNewestFirst).slice(0, limit);
}

/**
 * Rows the `byType`, `topTopics` and `topPeople` digest may scan on a counted
 * space. A thought row still carries the legacy 1,536-float vector, so this
 * bound is a read-budget bound, not a row-count preference. P1-12 replaces the
 * scan with a stored digest and this constant goes with it.
 */
export const MAX_STATS_DIGEST_ROWS = 128;
/** Fact rows carry no vector, so the fact scan keeps a far larger bound. */
export const MAX_STATS_FACT_ROWS = 4_096;

export type SpaceStats = {
  totalThoughts: number;
  totalFacts: number;
  historicalThoughts: number;
  historicalFacts: number;
  retractedThoughts: number;
  retractedFacts: number;
  byType: Array<{ type: string; count: number }>;
  topTopics: Array<{ topic: string; count: number }>;
  topPeople: Array<{ person: string; count: number }>;
  /** True when a bound bound: the digest, and any uncounted space's counts. */
  partial: boolean;
  coverage: SpaceEmbeddingCoverage[];
  dateRange?: { earliest: number; latest: number };
};

function boundedStatsLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Statistics for a set of spaces the caller may already read.
 *
 * Counts come from the space counters (P2-6f): a counted space contributes no
 * thought row to any total, and its index coverage is one row read. A space
 * whose counters were never seeded keeps the legacy bounded scan until the
 * P2-6g backfill reaches it. The digest is the one remaining scan, bounded
 * here and reported as partial when the bound binds.
 */
export async function _computeSpaceStats(
  ctx: QueryCtx,
  spaceIds: readonly Id<"spaces">[],
  options: {
    maxDigestRows?: number;
    maxScanRows?: number;
    maxFactRows?: number;
    now?: number;
  } = {},
): Promise<SpaceStats> {
  const digestLimit = boundedStatsLimit(
    options.maxDigestRows ?? MAX_STATS_DIGEST_ROWS,
    "Thought digest limit",
  );
  const scanLimit = boundedStatsLimit(
    options.maxScanRows ?? MAX_THOUGHT_STATS_ROWS,
    "Thought statistics limit",
  );
  const factLimit = boundedStatsLimit(
    options.maxFactRows ?? MAX_STATS_FACT_ROWS,
    "Fact statistics limit",
  );
  const activeAt = options.now ?? Date.now();

  const counters = await Promise.all(
    spaceIds.map((spaceId) => readSpaceCounters(ctx, spaceId)),
  );
  const uncounted = new Set(
    spaceIds
      .filter((_, index) => counters[index]!.thoughtCounts === null)
      .map(String),
  );

  let partial = false;
  let totalThoughts = 0;
  let historicalThoughts = 0;
  let retractedThoughts = 0;
  for (const report of counters) {
    const counts = report.thoughtCounts;
    if (!counts) continue;
    totalThoughts += counts.current;
    historicalThoughts += counts.superseded;
    retractedThoughts += counts.retracted;
  }

  // One scan serves the digest and, until the backfill lands, the counts of an
  // uncounted space. It is the only place stats touch a thought row.
  const thoughtBudget = uncounted.size > 0 ? scanLimit : digestLimit;
  const thoughts: Array<Doc<"thoughts">> = [];
  // Uncounted spaces first: if the budget binds, a count degrades to a sample
  // only after every space that still needs the scan has been read.
  const scanOrder = [...spaceIds].sort(
    (left, right) =>
      Number(uncounted.has(String(right))) -
      Number(uncounted.has(String(left))),
  );
  for (const spaceId of scanOrder) {
    if (thoughts.length >= thoughtBudget) {
      partial = true;
      break;
    }
    const rows = await ctx.db
      .query("thoughts")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
      .take(thoughtBudget + 1 - thoughts.length);
    thoughts.push(...rows);
    if (thoughts.length > thoughtBudget) {
      thoughts.length = thoughtBudget;
      partial = true;
      break;
    }
  }

  for (const thought of thoughts) {
    if (!uncounted.has(String(thought.spaceId))) continue;
    if (isMemoryActive(thought, activeAt)) totalThoughts += 1;
    else if (thought.memoryStatus === "superseded") historicalThoughts += 1;
    else if (thought.memoryStatus === "retracted") retractedThoughts += 1;
  }

  const facts: Array<Doc<"facts">> = [];
  for (const spaceId of spaceIds) {
    if (facts.length >= factLimit) {
      partial = true;
      break;
    }
    const rows = await ctx.db
      .query("facts")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
      .take(factLimit + 1 - facts.length);
    facts.push(...rows);
    if (facts.length > factLimit) {
      facts.length = factLimit;
      partial = true;
      break;
    }
  }

  const currentThoughts = thoughts.filter((thought) =>
    isMemoryActive(thought, activeAt),
  );
  const typeCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const peopleCounts = new Map<string, number>();
  for (const thought of currentThoughts) {
    typeCounts.set(
      thought.metadata.type,
      (typeCounts.get(thought.metadata.type) ?? 0) + 1,
    );
    for (const topic of thought.metadata.topics) {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
    for (const person of thought.metadata.people) {
      peopleCounts.set(person, (peopleCounts.get(person) ?? 0) + 1);
    }
  }

  return {
    totalThoughts,
    totalFacts: facts.filter((fact) => isFactActive(fact, activeAt)).length,
    historicalThoughts,
    historicalFacts: facts.filter((fact) => fact.status === "superseded")
      .length,
    retractedThoughts,
    retractedFacts: facts.filter((fact) => fact.status === "retracted").length,
    byType: [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    topTopics: [...topicCounts.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
      .slice(0, 10),
    topPeople: [...peopleCounts.entries()]
      .map(([person, count]) => ({ person, count }))
      .sort((a, b) => b.count - a.count || a.person.localeCompare(b.person))
      .slice(0, 10),
    partial,
    coverage: counters.map((report) => report.coverage),
    ...(currentThoughts.length > 0
      ? {
          dateRange: {
            earliest: Math.min(
              ...currentThoughts.map((thought) => thought._creationTime),
            ),
            latest: Math.max(
              ...currentThoughts.map((thought) => thought._creationTime),
            ),
          },
        }
      : {}),
  };
}

export async function _insertOne(
  ctx: MutationCtx,
  fields: {
    content: string;
    embedding: number[];
    metadata: ThoughtMetadata;
    userId: Id<"users">;
    spaceId: Id<"spaces">;
    isCore?: boolean;
  } & MemoryValidity &
    ThoughtProvenance &
    ThoughtEmbeddingWrite,
) {
  assertValidMemoryValidity(fields);
  const { embeddingGenerationId, embeddingFingerprint, ...thoughtFields } =
    fields;
  if (
    (embeddingGenerationId === undefined) !==
    (embeddingFingerprint === undefined)
  ) {
    throw new Error("Incomplete thought embedding identity");
  }
  const thoughtId = await ctx.db.insert("thoughts", {
    ...thoughtFields,
    memoryStatus: "current",
  });
  // The eligibility mark comes first so the vector insert below finds a target
  // row to mark covered. The epoch bump still follows the insert, inside
  // `insertThoughtEmbedding`.
  await markEligibilityTargets(ctx, fields.spaceId, {
    thoughtIds: [thoughtId],
  });
  if (embeddingGenerationId && embeddingFingerprint) {
    await insertThoughtEmbedding(ctx, {
      spaceId: fields.spaceId,
      thoughtId,
      embeddingGenerationId,
      fingerprint: embeddingFingerprint,
      vector: fields.embedding,
      inputText: fields.content,
    });
    const active = await requireActiveEmbeddingTarget(ctx, {
      spaceId: fields.spaceId,
      embeddingGenerationId,
      fingerprint: embeddingFingerprint,
    });
    if (active.thoughtStatus !== "ready") {
      throw new Error(
        "Thought capture requires a complete active thought embedding index",
      );
    }
  } else {
    await bumpEmbeddingEligibilityEpoch(ctx, fields.spaceId, {
      thoughtIds: [thoughtId],
    });
  }
  return thoughtId;
}

export async function _transitionMemory(
  ctx: MutationCtx,
  fields: {
    content: string;
    embedding: number[];
    metadata: ThoughtMetadata;
    userId: Id<"users">;
    spaceId: Id<"spaces">;
    isCore?: boolean;
  } & MemoryValidity &
    ThoughtProvenance &
    ThoughtEmbeddingWrite,
  previousIds: Array<Id<"thoughts">>,
  previousStatus: Exclude<MemoryStatus, "current">,
  reason: string,
  transitionedAt: number,
) {
  assertValidMemoryValidity(fields);
  const uniquePreviousIds = [...new Set(previousIds)];
  if (uniquePreviousIds.length === 0 || uniquePreviousIds.length > 10) {
    throw new Error("A memory transition requires 1-10 previous memories");
  }
  if (
    !reason.trim() ||
    reason.length > 500 ||
    !Number.isFinite(transitionedAt) ||
    transitionedAt <= 0
  ) {
    throw new Error("Invalid memory transition metadata");
  }

  const previousMemories = await Promise.all(
    uniquePreviousIds.map((id) => ctx.db.get(id)),
  );
  for (const previous of previousMemories) {
    if (
      !previous ||
      previous.spaceId !== fields.spaceId ||
      (previous.memoryStatus !== undefined &&
        previous.memoryStatus !== "current")
    ) {
      throw new Error("Previous memory is unavailable");
    }
  }

  const isCore =
    fields.isCore ?? previousMemories.some((previous) => previous!.isCore);

  const { embeddingGenerationId, embeddingFingerprint, ...thoughtFields } =
    fields;
  if (
    (embeddingGenerationId === undefined) !==
    (embeddingFingerprint === undefined)
  ) {
    throw new Error("Incomplete thought embedding identity");
  }
  const newId = await ctx.db.insert("thoughts", {
    ...thoughtFields,
    isCore,
    memoryStatus: "current",
    supersedes: uniquePreviousIds,
  });
  await markEligibilityTargets(ctx, fields.spaceId, { thoughtIds: [newId] });
  if (embeddingGenerationId && embeddingFingerprint) {
    await insertThoughtEmbedding(ctx, {
      spaceId: fields.spaceId,
      thoughtId: newId,
      embeddingGenerationId,
      fingerprint: embeddingFingerprint,
      vector: fields.embedding,
      inputText: fields.content,
      bumpEligibility: false,
    });
  }

  for (const previous of previousMemories) {
    const validTo =
      previousStatus === "superseded"
        ? safeSupersededValidTo(previous!, fields.validFrom)
        : undefined;
    await ctx.db.patch(previous!._id, {
      memoryStatus: previousStatus,
      supersededAt: transitionedAt,
      supersededBy: newId,
      changeReason: reason,
      ...(previousStatus === "retracted"
        ? { validFrom: undefined, validTo: undefined }
        : {}),
      ...(validTo === undefined ? {} : { validTo }),
    });
  }

  if (embeddingGenerationId && embeddingFingerprint) {
    await deleteActiveThoughtEmbeddingVectors(ctx, {
      spaceId: fields.spaceId,
      embeddingGenerationId,
      fingerprint: embeddingFingerprint,
      thoughtIds: uniquePreviousIds,
    });
  }
  // Supersede and retract retire exactly the memories they transitioned, and
  // the new memory above is marked in the same transaction.
  await bumpEmbeddingEligibilityEpoch(ctx, fields.spaceId, {
    thoughtIds: [newId, ...uniquePreviousIds],
  });
  if (embeddingGenerationId && embeddingFingerprint) {
    const active = await requireActiveEmbeddingTarget(ctx, {
      spaceId: fields.spaceId,
      embeddingGenerationId,
      fingerprint: embeddingFingerprint,
    });
    if (active.thoughtStatus !== "ready") {
      throw new Error(
        "Thought transition requires a complete active thought embedding index",
      );
    }
  }

  return newId;
}

export async function _setCoreStatus(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  id: Id<"thoughts">,
  isCore: boolean,
) {
  const memory = await ctx.db.get(id);
  if (
    !memory ||
    memory.spaceId !== spaceId ||
    !isCurrentMemory(memory.memoryStatus)
  ) {
    throw new Error("Current memory not found");
  }
  await ctx.db.patch(id, { isCore });
}
