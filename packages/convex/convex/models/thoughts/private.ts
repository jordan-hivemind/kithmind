import { internalMutation, internalQuery } from "../../_generated/server";
import { v } from "convex/values";
import { principalRefValidator } from "../apiKeys/validators";
import {
  ensurePersonalSpace,
  getAuthorizedReadSpaceIds,
  reloadPrincipal,
  requireSpaceAccess,
  resolveWriteSpace,
} from "../../lib/spaces";
import {
  _findById,
  _insertOne,
  _listBySpaces,
  _listCoreBySpaces,
  _setCoreStatus,
  _transitionMemory,
  boundedThoughtLimit,
  memoryRetrievabilityFilter,
} from "./model";
import {
  memorySourceType,
  activeThoughtEmbeddingTarget,
  thoughtLifecycleFields,
  thoughtMetadata,
  thoughtType,
} from "./validators";
import { isMemoryRetrievable } from "./memoryLifecycle";
import {
  activateEmbeddingGeneration,
  createEmbeddingGeneration,
  deriveEmbeddingManifest,
  getActiveEmbeddingTarget,
  resolveAuthorizedThoughtVectorCandidates,
  stageEmbeddingGeneration,
} from "../embeddings/model";
import { embeddingProfileValidator } from "../embeddings/validators";

export const getById = internalQuery({
  args: { id: v.id("thoughts") },
  returns: v.union(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      embedding: v.array(v.float64()),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await _findById(ctx, args.id);
  },
});

export const listCorePersonalByUser = internalQuery({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      embedding: v.array(v.float64()),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("userSpaceSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!settings) return [];
    return await _listCoreBySpaces(ctx, [settings.personalSpaceId], args.limit);
  },
});

export const insertOne = internalMutation({
  args: {
    content: v.string(),
    embedding: v.array(v.float64()),
    embeddingGenerationId: v.optional(v.id("embeddingGenerations")),
    embeddingFingerprint: v.optional(v.string()),
    metadata: thoughtMetadata,
    userId: v.id("users"),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    isCore: v.optional(v.boolean()),
    sourceType: v.optional(memorySourceType),
    sourceRef: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    batchId: v.optional(v.string()),
    confidence: v.optional(v.number()),
  },
  returns: v.id("thoughts"),
  handler: async (ctx, args) => {
    const spaceId = await ensurePersonalSpace(ctx, args.userId);
    return await _insertOne(ctx, { ...args, spaceId });
  },
});

export const resolveWriteSpaceForAction = internalMutation({
  args: {
    principal: principalRefValidator,
    spaceId: v.optional(v.id("spaces")),
  },
  returns: v.id("spaces"),
  handler: async (ctx, args) =>
    await resolveWriteSpace(ctx, args.principal, args.spaceId),
});

export const resolvePersonalSpaceForTrustedAction = internalMutation({
  args: { userId: v.id("users") },
  returns: v.id("spaces"),
  handler: async (ctx, args) => await ensurePersonalSpace(ctx, args.userId),
});

export const resolveReadSpacesForAction = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(v.id("spaces")),
  handler: async (ctx, args) =>
    await getAuthorizedReadSpaceIds(ctx, args.principal, args.spaceIds),
});

export const resolveReadEmbeddingTargetsForAction = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.object({
    spaceIds: v.array(v.id("spaces")),
    targets: v.array(activeThoughtEmbeddingTarget),
  }),
  handler: async (ctx, args) => {
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      args.principal,
      args.spaceIds,
    );
    const targets = [];
    for (const spaceId of spaceIds) {
      try {
        const target = await getActiveEmbeddingTarget(ctx, spaceId);
        if (target?.thoughtStatus === "ready") {
          targets.push({
            spaceId,
            embeddingGenerationId: target.embeddingGenerationId,
            fingerprint: target.fingerprint,
          });
        }
      } catch {
        // A damaged or changing profile disables vectors, not keyword recall.
      }
    }
    return { spaceIds, targets };
  },
});

export const resolveCaptureEmbeddingTargetForAction = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceId: v.id("spaces"),
  },
  returns: v.union(activeThoughtEmbeddingTarget, v.null()),
  handler: async (ctx, args) => {
    const principal = await reloadPrincipal(ctx, args.principal);
    await requireSpaceAccess(ctx, principal, args.spaceId, "read");
    await requireSpaceAccess(ctx, principal, args.spaceId, "write");
    const target = await getActiveEmbeddingTarget(ctx, args.spaceId);
    if (target && target.thoughtStatus !== "ready") {
      throw new Error(
        "The space has no complete active thought embedding index",
      );
    }
    if (!target) {
      const manifest = await deriveEmbeddingManifest(ctx, args.spaceId);
      if (manifest.thoughtCount > 0 || manifest.chunkCount > 0) {
        throw new Error(
          "The space has existing content and requires an embedding migration",
        );
      }
      return null;
    }
    return {
      spaceId: target.spaceId,
      embeddingGenerationId: target.embeddingGenerationId,
      fingerprint: target.fingerprint,
    };
  },
});

export const resolveOrBootstrapCaptureEmbeddingTargetForAction =
  internalMutation({
    args: {
      principal: principalRefValidator,
      spaceId: v.id("spaces"),
      fingerprint: v.string(),
      profile: embeddingProfileValidator,
      now: v.number(),
    },
    returns: activeThoughtEmbeddingTarget,
    handler: async (ctx, args) => {
      const principal = await reloadPrincipal(ctx, args.principal);
      await requireSpaceAccess(ctx, principal, args.spaceId, "read");
      await requireSpaceAccess(ctx, principal, args.spaceId, "write");
      const active = await getActiveEmbeddingTarget(ctx, args.spaceId);
      if (active) {
        if (
          active.thoughtStatus !== "ready" ||
          active.fingerprint !== args.fingerprint
        ) {
          throw new Error(
            "The configured embedding provider does not match the active space profile",
          );
        }
        return {
          spaceId: active.spaceId,
          embeddingGenerationId: active.embeddingGenerationId,
          fingerprint: active.fingerprint,
        };
      }
      const manifest = await deriveEmbeddingManifest(ctx, args.spaceId);
      if (manifest.thoughtCount > 0 || manifest.chunkCount > 0) {
        throw new Error(
          "The space has existing content and requires an embedding migration",
        );
      }
      const generation = await createEmbeddingGeneration(ctx, {
        spaceId: args.spaceId,
        profile: args.profile,
        fingerprint: args.fingerprint,
        createdAt: args.now,
      });
      await stageEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation._id,
        stagedAt: args.now,
      });
      await activateEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation._id,
        activatedAt: args.now,
      });
      return {
        spaceId: args.spaceId,
        embeddingGenerationId: generation._id,
        fingerprint: args.fingerprint,
      };
    },
  });

export const resolveThoughtVectorCandidatesAuthorized = internalQuery({
  args: {
    principal: principalRefValidator,
    targets: v.array(activeThoughtEmbeddingTarget),
    embeddingVectorIds: v.array(v.id("embeddingVectors")),
    type: v.optional(thoughtType),
    includeHistorical: v.optional(v.boolean()),
    activeAt: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      embeddingVectorId: v.id("embeddingVectors"),
      thoughtId: v.id("thoughts"),
      spaceId: v.id("spaces"),
    }),
  ),
  handler: async (ctx, args) => {
    const resolved = await resolveAuthorizedThoughtVectorCandidates(ctx, args);
    if (args.activeAt === undefined) return resolved;
    const filtered = [];
    for (const candidate of resolved) {
      const thought = await ctx.db.get(candidate.thoughtId);
      if (
        thought &&
        (args.type === undefined || thought.metadata.type === args.type) &&
        isMemoryRetrievable(thought, args.includeHistorical, args.activeAt)
      ) {
        filtered.push(candidate);
      }
    }
    return filtered;
  },
});

export const requireCaptureAccessForAction = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceId: v.id("spaces"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const principal = await reloadPrincipal(ctx, args.principal);
    await requireSpaceAccess(ctx, principal, args.spaceId, "read");
    await requireSpaceAccess(ctx, principal, args.spaceId, "write");
    return null;
  },
});

export const insertOneAuthorized = internalMutation({
  args: {
    principal: principalRefValidator,
    spaceId: v.id("spaces"),
    content: v.string(),
    embedding: v.array(v.float64()),
    embeddingGenerationId: v.optional(v.id("embeddingGenerations")),
    embeddingFingerprint: v.optional(v.string()),
    metadata: thoughtMetadata,
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    isCore: v.optional(v.boolean()),
    sourceType: v.optional(memorySourceType),
    sourceRef: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    batchId: v.optional(v.string()),
    confidence: v.optional(v.number()),
  },
  returns: v.id("thoughts"),
  handler: async (ctx, args) => {
    const principal = await reloadPrincipal(ctx, args.principal);
    await requireSpaceAccess(ctx, principal, args.spaceId, "write");
    const { principal: _principal, ...fields } = args;
    return await _insertOne(ctx, {
      ...fields,
      userId: principal.userId,
    });
  },
});

export const transitionMemory = internalMutation({
  args: {
    content: v.string(),
    embedding: v.array(v.float64()),
    embeddingGenerationId: v.optional(v.id("embeddingGenerations")),
    embeddingFingerprint: v.optional(v.string()),
    metadata: thoughtMetadata,
    userId: v.id("users"),
    previousIds: v.array(v.id("thoughts")),
    previousStatus: v.union(v.literal("superseded"), v.literal("retracted")),
    reason: v.string(),
    transitionedAt: v.number(),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    isCore: v.optional(v.boolean()),
    sourceType: v.optional(memorySourceType),
    sourceRef: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    batchId: v.optional(v.string()),
    confidence: v.optional(v.number()),
  },
  returns: v.id("thoughts"),
  handler: async (ctx, args) => {
    const spaceId = await ensurePersonalSpace(ctx, args.userId);
    return await _transitionMemory(
      ctx,
      {
        content: args.content,
        embedding: args.embedding,
        embeddingGenerationId: args.embeddingGenerationId,
        embeddingFingerprint: args.embeddingFingerprint,
        metadata: args.metadata,
        userId: args.userId,
        spaceId,
        validFrom: args.validFrom,
        validTo: args.validTo,
        isCore: args.isCore,
        sourceType: args.sourceType,
        sourceRef: args.sourceRef,
        observedAt: args.observedAt,
        batchId: args.batchId,
        confidence: args.confidence,
      },
      args.previousIds,
      args.previousStatus,
      args.reason,
      args.transitionedAt,
    );
  },
});

export const transitionMemoryAuthorized = internalMutation({
  args: {
    principal: principalRefValidator,
    spaceId: v.id("spaces"),
    content: v.string(),
    embedding: v.array(v.float64()),
    embeddingGenerationId: v.optional(v.id("embeddingGenerations")),
    embeddingFingerprint: v.optional(v.string()),
    metadata: thoughtMetadata,
    previousIds: v.array(v.id("thoughts")),
    previousStatus: v.union(v.literal("superseded"), v.literal("retracted")),
    reason: v.string(),
    transitionedAt: v.number(),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    isCore: v.optional(v.boolean()),
    sourceType: v.optional(memorySourceType),
    sourceRef: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    batchId: v.optional(v.string()),
    confidence: v.optional(v.number()),
  },
  returns: v.id("thoughts"),
  handler: async (ctx, args) => {
    const principal = await reloadPrincipal(ctx, args.principal);
    await requireSpaceAccess(ctx, principal, args.spaceId, "write");
    return await _transitionMemory(
      ctx,
      {
        content: args.content,
        embedding: args.embedding,
        embeddingGenerationId: args.embeddingGenerationId,
        embeddingFingerprint: args.embeddingFingerprint,
        metadata: args.metadata,
        userId: principal.userId,
        spaceId: args.spaceId,
        validFrom: args.validFrom,
        validTo: args.validTo,
        isCore: args.isCore,
        sourceType: args.sourceType,
        sourceRef: args.sourceRef,
        observedAt: args.observedAt,
        batchId: args.batchId,
        confidence: args.confidence,
      },
      args.previousIds,
      args.previousStatus,
      args.reason,
      args.transitionedAt,
    );
  },
});

export const setCoreStatus = internalMutation({
  args: {
    userId: v.id("users"),
    id: v.id("thoughts"),
    isCore: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const personalSpaceId = await ensurePersonalSpace(ctx, args.userId);
    await _setCoreStatus(ctx, personalSpaceId, args.id, args.isCore);
    return null;
  },
});

export const setCoreStatusAuthorized = internalMutation({
  args: {
    principal: principalRefValidator,
    spaceId: v.id("spaces"),
    id: v.id("thoughts"),
    isCore: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const principal = await reloadPrincipal(ctx, args.principal);
    await requireSpaceAccess(ctx, principal, args.spaceId, "write");
    await _setCoreStatus(ctx, args.spaceId, args.id, args.isCore);
    return null;
  },
});

export const searchByTextTrustedLegacy = internalQuery({
  args: {
    userId: v.id("users"),
    query: v.string(),
    type: v.optional(thoughtType),
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
    activeAt: v.number(),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const results = await ctx.db
      .query("thoughts")
      .withSearchIndex("by_content", (q) => {
        const base = q.search("content", args.query).eq("userId", args.userId);
        return args.type ? base.eq("metadata.type", args.type) : base;
      })
      .filter((q) =>
        memoryRetrievabilityFilter(q, args.includeHistorical, args.activeAt),
      )
      .take(limit);

    return results.map(({ embedding: _embedding, ...rest }) => rest);
  },
});

export const searchByTextAuthorized = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceIds: v.optional(v.array(v.id("spaces"))),
    query: v.string(),
    type: v.optional(thoughtType),
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
    activeAt: v.number(),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      args.principal,
      args.spaceIds,
    );
    const limit = boundedThoughtLimit(args.limit, 50);
    const rows = await Promise.all(
      spaceIds.map((spaceId) =>
        ctx.db
          .query("thoughts")
          .withSearchIndex("by_content", (q) => {
            const base = q.search("content", args.query).eq("spaceId", spaceId);
            return args.type ? base.eq("metadata.type", args.type) : base;
          })
          .filter((q) =>
            memoryRetrievabilityFilter(
              q,
              args.includeHistorical,
              args.activeAt,
            ),
          )
          .take(limit),
      ),
    );
    return rows
      .flatMap((spaceRows) => spaceRows.map((row, rank) => ({ row, rank })))
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          String(left.row._id).localeCompare(String(right.row._id)),
      )
      .slice(0, limit)
      .map(({ row: { embedding: _embedding, ...rest } }) => rest);
  },
});

export const getByIds = internalQuery({
  args: { ids: v.array(v.id("thoughts")) },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .map(({ embedding: _embedding, ...rest }) => rest);
  },
});

export const getByIdAuthorized = internalQuery({
  args: {
    principal: principalRefValidator,
    id: v.id("thoughts"),
  },
  returns: v.union(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc?.spaceId) return null;
    try {
      await requireSpaceAccess(ctx, args.principal, doc.spaceId, "read");
    } catch {
      return null;
    }
    const { embedding: _embedding, ...rest } = doc;
    return rest;
  },
});

export const getByIdsAuthorized = internalQuery({
  args: {
    principal: principalRefValidator,
    ids: v.array(v.id("thoughts")),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    if (args.ids.length > 256) throw new Error("Too many thought IDs");
    const spaceIds = new Set(
      await getAuthorizedReadSpaceIds(ctx, args.principal, args.spaceIds),
    );
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs
      .filter(
        (doc): doc is NonNullable<typeof doc> =>
          doc !== null &&
          doc.spaceId !== undefined &&
          spaceIds.has(doc.spaceId),
      )
      .map(({ embedding: _embedding, ...rest }) => rest);
  },
});

export const hydrateHybridResultsAuthorized = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceIds: v.array(v.id("spaces")),
    ids: v.array(v.id("thoughts")),
    targets: v.array(activeThoughtEmbeddingTarget),
    vectorCandidates: v.array(
      v.object({
        embeddingVectorId: v.id("embeddingVectors"),
        thoughtId: v.id("thoughts"),
      }),
    ),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    if (args.ids.length > 100 || args.vectorCandidates.length > 256) {
      throw new Error("Hybrid result hydration exceeds its bound");
    }
    const authorizedSpaceIds = new Set(
      await getAuthorizedReadSpaceIds(ctx, args.principal, args.spaceIds),
    );
    const resolved = await resolveAuthorizedThoughtVectorCandidates(ctx, {
      principal: args.principal,
      targets: args.targets,
      embeddingVectorIds: args.vectorCandidates.map(
        (candidate) => candidate.embeddingVectorId,
      ),
    });
    const thoughtIdByVectorId = new Map(
      resolved.map((candidate) => [
        candidate.embeddingVectorId,
        candidate.thoughtId,
      ]),
    );
    for (const candidate of args.vectorCandidates) {
      if (
        thoughtIdByVectorId.get(candidate.embeddingVectorId) !==
        candidate.thoughtId
      ) {
        throw new Error("Vector candidates changed during hydration");
      }
    }
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs
      .filter(
        (doc): doc is NonNullable<typeof doc> =>
          doc !== null &&
          doc.spaceId !== undefined &&
          authorizedSpaceIds.has(doc.spaceId),
      )
      .map(({ embedding: _embedding, ...rest }) => rest);
  },
});

export const listAroundTimeTrustedLegacy = internalQuery({
  args: {
    userId: v.id("users"),
    aroundMs: v.number(),
    before: v.number(),
    after: v.number(),
    type: v.optional(thoughtType),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    const type = args.type;

    // Strictly older than aroundMs, most recent first, take `before`.
    // _creationTime is the implicit suffix of every Convex index, so the
    // bound can be pushed into the index builder directly.
    const earlier = type
      ? await ctx.db
          .query("thoughts")
          .withIndex("by_userId_and_type", (q) =>
            q
              .eq("userId", args.userId)
              .eq("metadata.type", type)
              .lt("_creationTime", args.aroundMs),
          )
          .order("desc")
          .take(args.before)
      : await ctx.db
          .query("thoughts")
          .withIndex("by_userId", (q) =>
            q.eq("userId", args.userId).lt("_creationTime", args.aroundMs),
          )
          .order("desc")
          .take(args.before);

    // Strictly newer than aroundMs, oldest first, take `after`
    const later = type
      ? await ctx.db
          .query("thoughts")
          .withIndex("by_userId_and_type", (q) =>
            q
              .eq("userId", args.userId)
              .eq("metadata.type", type)
              .gt("_creationTime", args.aroundMs),
          )
          .order("asc")
          .take(args.after)
      : await ctx.db
          .query("thoughts")
          .withIndex("by_userId", (q) =>
            q.eq("userId", args.userId).gt("_creationTime", args.aroundMs),
          )
          .order("asc")
          .take(args.after);

    const combined = [...earlier.reverse(), ...later];
    return combined.map(({ embedding: _embedding, ...rest }) => rest);
  },
});

export const listAroundTimeAuthorized = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceIds: v.optional(v.array(v.id("spaces"))),
    seedId: v.optional(v.id("thoughts")),
    aroundMs: v.optional(v.number()),
    before: v.number(),
    after: v.number(),
    type: v.optional(thoughtType),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.optional(v.id("spaces")),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    if (
      !Number.isInteger(args.before) ||
      !Number.isInteger(args.after) ||
      args.before < 0 ||
      args.after < 0 ||
      args.before > 50 ||
      args.after > 50
    ) {
      throw new Error("Timeline windows must be integers from 0 to 50");
    }
    if (
      (args.seedId === undefined) === (args.aroundMs === undefined) ||
      (args.aroundMs !== undefined && !Number.isFinite(args.aroundMs))
    ) {
      throw new Error("Provide exactly one of seedId or aroundMs");
    }
    const before = args.before;
    const after = args.after;
    const activeAt = Date.now();
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      args.principal,
      args.spaceIds,
    );
    const authorized = new Set(spaceIds);
    const seed = args.seedId ? await ctx.db.get(args.seedId) : null;
    if (
      args.seedId &&
      (!seed ||
        !seed.spaceId ||
        !authorized.has(seed.spaceId) ||
        !isMemoryRetrievable(seed, false, activeAt))
    ) {
      throw new Error("Seed thought not found");
    }
    const aroundMs = seed?._creationTime ?? args.aroundMs!;
    const perSpace = await Promise.all(
      spaceIds.map(async (spaceId) => {
        const earlierQuery = args.type
          ? ctx.db
              .query("thoughts")
              .withIndex("by_spaceId_and_type", (q) =>
                q
                  .eq("spaceId", spaceId)
                  .eq("metadata.type", args.type!)
                  .lt("_creationTime", aroundMs),
              )
          : ctx.db
              .query("thoughts")
              .withIndex("by_spaceId", (q) =>
                q.eq("spaceId", spaceId).lt("_creationTime", aroundMs),
              );
        const laterQuery = args.type
          ? ctx.db
              .query("thoughts")
              .withIndex("by_spaceId_and_type", (q) =>
                q
                  .eq("spaceId", spaceId)
                  .eq("metadata.type", args.type!)
                  .gt("_creationTime", aroundMs),
              )
          : ctx.db
              .query("thoughts")
              .withIndex("by_spaceId", (q) =>
                q.eq("spaceId", spaceId).gt("_creationTime", aroundMs),
              );
        const [earlier, later] = await Promise.all([
          earlierQuery
            .order("desc")
            .filter((q) => memoryRetrievabilityFilter(q, false, activeAt))
            .take(before),
          laterQuery
            .order("asc")
            .filter((q) => memoryRetrievabilityFilter(q, false, activeAt))
            .take(after),
        ]);
        return { earlier, later };
      }),
    );
    const earlier = perSpace
      .flatMap((rows) => rows.earlier)
      .sort(
        (left, right) =>
          right._creationTime - left._creationTime ||
          String(left._id).localeCompare(String(right._id)),
      )
      .slice(0, before)
      .reverse();
    const later = perSpace
      .flatMap((rows) => rows.later)
      .sort(
        (left, right) =>
          left._creationTime - right._creationTime ||
          String(left._id).localeCompare(String(right._id)),
      )
      .slice(0, after);
    const combined = [...earlier, ...later];
    if (seed) {
      combined.push(seed);
      combined.sort(
        (left, right) =>
          left._creationTime - right._creationTime ||
          String(left._id).localeCompare(String(right._id)),
      );
    }
    return combined.map(({ embedding: _embedding, ...rest }) => rest);
  },
});

export const listBySpacesAuthorized = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceIds: v.optional(v.array(v.id("spaces"))),
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
    type: v.optional(thoughtType),
    topic: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      args.principal,
      args.spaceIds,
    );
    return await _listBySpaces(
      ctx,
      spaceIds,
      args.limit,
      args.includeHistorical,
      { type: args.type, topic: args.topic },
    );
  },
});

export const listCoreBySpacesAuthorized = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceIds: v.optional(v.array(v.id("spaces"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      args.principal,
      args.spaceIds,
    );
    return await _listCoreBySpaces(ctx, spaceIds, args.limit);
  },
});
