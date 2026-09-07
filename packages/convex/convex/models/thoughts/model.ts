import type { Infer } from "convex/values";
import type { Expression, FilterBuilder, NamedTableInfo } from "convex/server";

import type { DataModel, Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import {
  bumpEmbeddingEligibilityEpoch,
  deleteActiveThoughtEmbeddingVectors,
  insertThoughtEmbedding,
  requireActiveEmbeddingTarget,
} from "../embeddings/model";
import {
  assertValidMemoryValidity,
  isCurrentMemory,
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

/** Loads complete stats inputs under one global row budget per table. */
export async function _loadBoundedThoughtStatsRows(
  ctx: QueryCtx,
  spaceIds: readonly Id<"spaces">[],
  maxRows: number = MAX_THOUGHT_STATS_ROWS,
) {
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error("Thought statistics limit must be a positive integer");
  }
  const thoughts: Array<Doc<"thoughts">> = [];
  for (const spaceId of spaceIds) {
    const rows = await ctx.db
      .query("thoughts")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
      .take(maxRows + 1 - thoughts.length);
    thoughts.push(...rows);
    if (thoughts.length > maxRows) {
      throw new Error("Thought statistics exceed the bounded scope");
    }
  }

  const facts: Array<Doc<"facts">> = [];
  for (const spaceId of spaceIds) {
    const rows = await ctx.db
      .query("facts")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
      .take(maxRows + 1 - facts.length);
    facts.push(...rows);
    if (facts.length > maxRows) {
      throw new Error("Thought statistics exceed the bounded scope");
    }
  }
  return { thoughts, facts };
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
        "Thought capture exceeds the active embedding manifest limit",
      );
    }
  } else {
    await bumpEmbeddingEligibilityEpoch(ctx, fields.spaceId);
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
    await bumpEmbeddingEligibilityEpoch(ctx, fields.spaceId);
    const active = await requireActiveEmbeddingTarget(ctx, {
      spaceId: fields.spaceId,
      embeddingGenerationId,
      fingerprint: embeddingFingerprint,
    });
    if (active.thoughtStatus !== "ready") {
      throw new Error(
        "Thought transition exceeds the active embedding manifest limit",
      );
    }
  } else {
    await bumpEmbeddingEligibilityEpoch(ctx, fields.spaceId);
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
