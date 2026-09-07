import { v } from "convex/values";

import { internalMutation } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import {
  BASELINE_EMBEDDING_DIMENSIONS,
  BASELINE_EMBEDDING_MODEL,
  BASELINE_EMBEDDING_MODEL_REVISION,
  BASELINE_EMBEDDING_PROVIDER_ID,
  EMBEDDING_NORMALIZATION,
  EMBEDDING_PREPROCESSING,
  EMBEDDING_PROTOCOL,
  fingerprintEmbeddingConfig,
  type EmbeddingProfile,
} from "../../lib/embeddingProvider";
import {
  activateEmbeddingGeneration,
  createEmbeddingGeneration,
  deriveEmbeddingManifest,
  ensureEmbeddingProfile,
  ensureSpaceEmbeddingState,
  embeddingVectorSearchScope,
  insertThoughtEmbedding,
  stageEmbeddingGeneration,
} from "./model";

export const BASELINE_EMBEDDING_PROFILE: EmbeddingProfile = {
  protocol: EMBEDDING_PROTOCOL,
  providerId: BASELINE_EMBEDDING_PROVIDER_ID,
  model: BASELINE_EMBEDDING_MODEL,
  modelRevision: BASELINE_EMBEDDING_MODEL_REVISION,
  dimensions: BASELINE_EMBEDDING_DIMENSIONS,
  normalization: EMBEDDING_NORMALIZATION,
  preprocessing: EMBEDDING_PREPROCESSING,
};

const preparationResult = v.object({
  dryRun: v.boolean(),
  blocked: v.boolean(),
  reason: v.optional(v.string()),
  eligibleThoughtCount: v.number(),
  eligibleChunkCount: v.number(),
  embeddingGenerationId: v.optional(v.id("embeddingGenerations")),
  reused: v.boolean(),
});

/**
 * Creates the baseline generation without calling an embedding provider.
 * Active chunks block this legacy-copy path because chunks have no legacy
 * vector field from which a profile can be attributed safely.
 */
export const prepareBaselineGeneration = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    dryRun: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  returns: preparationResult,
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const now = args.now ?? Date.now();
    const fingerprint = await fingerprintEmbeddingConfig(
      BASELINE_EMBEDDING_PROFILE,
    );
    const manifest = await deriveEmbeddingManifest(ctx, args.spaceId);
    if (manifest.chunkCount > 0) {
      return {
        dryRun,
        blocked: true,
        reason:
          "Active chunks lack attributable legacy vectors; rebuild them before baseline activation",
        eligibleThoughtCount: manifest.thoughtCount,
        eligibleChunkCount: manifest.chunkCount,
        reused: false,
      };
    }
    const stateRows = await ctx.db
      .query("spaceEmbeddingStates")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .take(2);
    if (stateRows.length > 1) {
      throw new Error("Duplicate space embedding state");
    }
    const activeId = stateRows[0]?.activeEmbeddingGenerationId;
    const active = activeId ? await ctx.db.get(activeId) : null;
    if (
      activeId &&
      (!active ||
        active.spaceId !== args.spaceId ||
        active.state !== "active" ||
        active.fingerprint !== stateRows[0]?.activeFingerprint)
    ) {
      throw new Error("Active embedding generation pointer is invalid");
    }
    const inactive = (
      await Promise.all(
        (["staging", "staged"] as const).map((generationState) =>
          ctx.db
            .query("embeddingGenerations")
            .withIndex("by_spaceId_and_state", (q) =>
              q.eq("spaceId", args.spaceId).eq("state", generationState),
            )
            .take(2),
        ),
      )
    ).flat();
    const reusable =
      (active?.fingerprint === fingerprint ? active : undefined) ??
      inactive.find((generation) => generation.fingerprint === fingerprint);
    if (reusable) {
      return {
        dryRun,
        blocked: false,
        eligibleThoughtCount: manifest.thoughtCount,
        eligibleChunkCount: 0,
        embeddingGenerationId: reusable._id,
        reused: true,
      };
    }
    if (dryRun) {
      return {
        dryRun: true,
        blocked: false,
        eligibleThoughtCount: manifest.thoughtCount,
        eligibleChunkCount: 0,
        reused: false,
      };
    }
    const generation = await createEmbeddingGeneration(ctx, {
      spaceId: args.spaceId,
      profile: BASELINE_EMBEDDING_PROFILE,
      fingerprint,
      createdAt: now,
    });
    return {
      dryRun: false,
      blocked: false,
      eligibleThoughtCount: manifest.thoughtCount,
      eligibleChunkCount: 0,
      embeddingGenerationId: generation._id,
      reused: false,
    };
  },
});

export const backfillBaselineThoughtVectors = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    embeddingGenerationId: v.id("embeddingGenerations"),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    scanned: v.number(),
    eligible: v.number(),
    needingBackfill: v.number(),
    copied: v.number(),
    invalid: v.number(),
    isDone: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(Math.max(args.batchSize ?? 10, 1), 25);
    const dryRun = args.dryRun ?? false;
    const generation = await ctx.db.get(args.embeddingGenerationId);
    if (
      !generation ||
      generation.spaceId !== args.spaceId ||
      generation.state !== "staging"
    ) {
      throw new Error("Baseline embedding generation is not writable");
    }
    const fingerprint = await fingerprintEmbeddingConfig(
      BASELINE_EMBEDDING_PROFILE,
    );
    if (generation.fingerprint !== fingerprint) {
      throw new Error("Baseline embedding generation has the wrong profile");
    }
    const page = await ctx.db
      .query("thoughts")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });
    let eligible = 0;
    let needingBackfill = 0;
    let copied = 0;
    let invalid = 0;
    for (const thought of page.page) {
      if (
        thought.memoryStatus !== undefined &&
        thought.memoryStatus !== "current"
      ) {
        continue;
      }
      eligible += 1;
      if (
        thought.embedding.length !== BASELINE_EMBEDDING_DIMENSIONS ||
        !thought.embedding.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ) ||
        !thought.embedding.some((value) => value !== 0)
      ) {
        invalid += 1;
        continue;
      }
      const existing = await ctx.db
        .query("embeddingVectors")
        .withIndex("by_generation_and_thoughtId", (q) =>
          q
            .eq("embeddingGenerationId", generation._id)
            .eq("thoughtId", thought._id),
        )
        .take(2);
      if (existing.length > 1) {
        invalid += 1;
        continue;
      }
      if (existing.length === 0) needingBackfill += 1;
      if (!dryRun) {
        await insertThoughtEmbedding(ctx, {
          spaceId: args.spaceId,
          thoughtId: thought._id,
          embeddingGenerationId: generation._id,
          fingerprint,
          inputText: thought.content,
          vector: thought.embedding,
          bumpEligibility: false,
        });
        if (existing.length === 0) copied += 1;
      }
    }
    return {
      scanned: page.page.length,
      eligible,
      needingBackfill,
      copied,
      invalid,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const stageBaselineGeneration = internalMutation({
  args: {
    embeddingGenerationId: v.id("embeddingGenerations"),
    stagedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await stageEmbeddingGeneration(ctx, {
      embeddingGenerationId: args.embeddingGenerationId,
      stagedAt: args.stagedAt ?? Date.now(),
    });
    return null;
  },
});

export const activateBaselineGeneration = internalMutation({
  args: {
    embeddingGenerationId: v.id("embeddingGenerations"),
    expectedPreviousGenerationId: v.optional(v.id("embeddingGenerations")),
    activatedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await activateEmbeddingGeneration(ctx, {
      embeddingGenerationId: args.embeddingGenerationId,
      expectedPreviousGenerationId: args.expectedPreviousGenerationId,
      activatedAt: args.activatedAt ?? Date.now(),
    });
    return null;
  },
});

export const auditBaselineGeneration = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    embeddingGenerationId: v.id("embeddingGenerations"),
  },
  returns: v.object({
    state: v.string(),
    active: v.boolean(),
    fingerprintMatches: v.boolean(),
    epochMatches: v.boolean(),
    manifestMatches: v.boolean(),
    expectedThoughtCount: v.number(),
    expectedChunkCount: v.number(),
    vectorThoughtCount: v.number(),
    vectorChunkCount: v.number(),
    missingTargets: v.number(),
    extraTargets: v.number(),
    duplicateTargets: v.number(),
    mismatchedTargets: v.number(),
    invalidVectors: v.number(),
  }),
  handler: async (ctx, args) => {
    const [generation, state, manifest] = await Promise.all([
      ctx.db.get(args.embeddingGenerationId),
      ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
        .unique(),
      deriveEmbeddingManifest(ctx, args.spaceId),
    ]);
    if (!generation || generation.spaceId !== args.spaceId) {
      throw new Error("Embedding generation not found in the requested space");
    }
    const fingerprint = await fingerprintEmbeddingConfig(
      BASELINE_EMBEDDING_PROFILE,
    );
    const rows = await ctx.db
      .query("embeddingVectors")
      .withIndex("by_embeddingGenerationId", (q) =>
        q.eq("embeddingGenerationId", generation._id),
      )
      .take(257);
    if (rows.length > 256) {
      throw new Error("Embedding generation exceeds its audit row bound");
    }
    let vectorThoughtCount = 0;
    let vectorChunkCount = 0;
    let duplicateTargets = 0;
    let mismatchedTargets = 0;
    let invalidVectors = 0;
    const rowsByTarget = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const targetId =
        row.targetKind === "thought" ? row.thoughtId : row.chunkId;
      const targetKey = targetId ? `${row.targetKind}:${targetId}` : undefined;
      const validVector =
        row.spaceId === args.spaceId &&
        row.embeddingGenerationId === generation._id &&
        row.embeddingFingerprint === generation.fingerprint &&
        row.searchScope ===
          embeddingVectorSearchScope({
            spaceId: row.spaceId,
            fingerprint: row.embeddingFingerprint,
            embeddingGenerationId: row.embeddingGenerationId,
            targetKind: row.targetKind,
          }) &&
        targetId !== undefined &&
        row.embedding.length === BASELINE_EMBEDDING_DIMENSIONS &&
        row.embedding.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ) &&
        row.embedding.some((value) => value !== 0);
      if (!validVector) {
        invalidVectors += 1;
      } else if (row.targetKind === "thought" && row.thoughtId) {
        vectorThoughtCount += 1;
      } else if (row.targetKind === "chunk" && row.chunkId) {
        vectorChunkCount += 1;
      } else {
        invalidVectors += 1;
      }
      if (targetKey) {
        if (rowsByTarget.has(targetKey)) duplicateTargets += 1;
        else rowsByTarget.set(targetKey, row);
      }
    }
    const manifestKeys = new Set(
      manifest.targets.map((target) => `${target.kind}:${target.targetId}`),
    );
    let missingTargets = 0;
    for (const target of manifest.targets) {
      const key = `${target.kind}:${target.targetId}`;
      const row = rowsByTarget.get(key);
      if (!row) {
        missingTargets += 1;
        continue;
      }
      if (
        row.inputHash !== target.inputHash ||
        row.processingGenerationId !== target.processingGenerationId
      ) {
        mismatchedTargets += 1;
        continue;
      }
      if (target.kind === "thought") {
        const thoughtId = ctx.db.normalizeId("thoughts", target.targetId);
        const thought = thoughtId ? await ctx.db.get(thoughtId) : null;
        if (
          !thought ||
          row.embedding.length !== thought.embedding.length ||
          row.embedding.some(
            (value, index) => value !== thought.embedding[index],
          )
        ) {
          mismatchedTargets += 1;
        }
      }
    }
    const extraTargets = [...rowsByTarget.keys()].filter(
      (key) => !manifestKeys.has(key),
    ).length;
    return {
      state: generation.state,
      active: state?.activeEmbeddingGenerationId === generation._id,
      fingerprintMatches: generation.fingerprint === fingerprint,
      epochMatches: state?.eligibilityEpoch === generation.eligibilityEpoch,
      manifestMatches:
        generation.manifestHash === manifest.hash &&
        generation.expectedThoughtCount === manifest.thoughtCount &&
        generation.expectedChunkCount === manifest.chunkCount &&
        missingTargets === 0 &&
        extraTargets === 0 &&
        duplicateTargets === 0 &&
        mismatchedTargets === 0 &&
        invalidVectors === 0,
      expectedThoughtCount: manifest.thoughtCount,
      expectedChunkCount: manifest.chunkCount,
      vectorThoughtCount,
      vectorChunkCount,
      missingTargets,
      extraTargets,
      duplicateTargets,
      mismatchedTargets,
      invalidVectors,
    };
  },
});

/** Empty-space bootstrap helper used by migrations and tests. */
export async function ensureBaselineProfileAndState(
  ctx: Parameters<typeof ensureEmbeddingProfile>[0],
  spaceId: Id<"spaces">,
  now: number,
) {
  const fingerprint = await fingerprintEmbeddingConfig(
    BASELINE_EMBEDDING_PROFILE,
  );
  await ensureSpaceEmbeddingState(ctx, spaceId);
  return await ensureEmbeddingProfile(ctx, {
    profile: BASELINE_EMBEDDING_PROFILE,
    fingerprint,
    createdAt: now,
  });
}
