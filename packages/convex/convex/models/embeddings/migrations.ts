import { v } from "convex/values";

import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
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
  failEmbeddingGeneration,
  insertThoughtEmbedding,
  markEligibilityTargets,
  releaseVectorCoverage,
  stageEmbeddingGeneration,
} from "./model";
import {
  auditEmbeddingCounters,
  EMBEDDING_TARGET_CAPACITY_CEILING,
  embeddingVectorScopeV2,
  runEmbeddingBuildPage,
} from "./targets";
import {
  embeddingBuildPhaseValidator,
  embeddingGenerationStateValidator,
  embeddingKindCountsValidator,
  embeddingTargetPolicyValidator,
} from "./validators";

export const BASELINE_EMBEDDING_PROFILE: EmbeddingProfile = {
  protocol: EMBEDDING_PROTOCOL,
  providerId: BASELINE_EMBEDDING_PROVIDER_ID,
  model: BASELINE_EMBEDDING_MODEL,
  modelRevision: BASELINE_EMBEDDING_MODEL_REVISION,
  dimensions: BASELINE_EMBEDDING_DIMENSIONS,
  normalization: EMBEDDING_NORMALIZATION,
  preprocessing: EMBEDDING_PREPROCESSING,
};

const MAX_BASELINE_COPY_GENERATION_HISTORY = 256;
const NON_BASELINE_HISTORY_REASON =
  "Embedding generation history includes a non-baseline profile; rebuild baseline vectors from source inputs";

/**
 * Generation rows are the bounded provenance boundary for this legacy copy.
 * Future generation cleanup must preserve profile-use evidence or retire this
 * copy path before deleting history that the guard depends on.
 */
async function baselineLegacyCopyBlockReason(
  ctx: Parameters<typeof ensureEmbeddingProfile>[0],
  spaceId: Id<"spaces">,
  baselineFingerprint: string,
): Promise<string | undefined> {
  const generations = await ctx.db
    .query("embeddingGenerations")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .take(MAX_BASELINE_COPY_GENERATION_HISTORY + 1);
  if (generations.length > MAX_BASELINE_COPY_GENERATION_HISTORY) {
    return "Embedding generation history exceeds the baseline legacy-copy safety bound; rebuild baseline vectors from source inputs";
  }
  if (
    generations.some(
      (generation) => generation.fingerprint !== baselineFingerprint,
    )
  ) {
    return NON_BASELINE_HISTORY_REASON;
  }
  return undefined;
}

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
    const historyBlockReason = await baselineLegacyCopyBlockReason(
      ctx,
      args.spaceId,
      fingerprint,
    );
    if (historyBlockReason) {
      return {
        dryRun,
        blocked: true,
        reason: historyBlockReason,
        eligibleThoughtCount: manifest.thoughtCount,
        eligibleChunkCount: manifest.chunkCount,
        reused: false,
      };
    }
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
    const historyBlockReason = await baselineLegacyCopyBlockReason(
      ctx,
      args.spaceId,
      fingerprint,
    );
    if (historyBlockReason) throw new Error(historyBlockReason);
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

// ---------------------------------------------------------------------------
// P2-6ab: target table, counters and resumable builder
// ---------------------------------------------------------------------------

const buildPageResult = v.object({
  accepted: v.boolean(),
  phase: embeddingBuildPhaseValidator,
  cursor: v.union(v.string(), v.null()),
  pageIndex: v.number(),
  scanned: v.number(),
  filled: v.number(),
  retired: v.number(),
  isDone: v.boolean(),
  counterDrift: v.boolean(),
  duplicateTargets: v.number(),
  scheduled: v.boolean(),
});

/**
 * Creates or reuses the one non-terminal build job for a space and
 * fingerprint. Rerunning it is a no-op that returns the job to resume.
 */
export const startTargetBackfill = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    fingerprint: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    autoRun: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    reused: v.boolean(),
    fingerprint: v.string(),
    jobId: v.optional(v.id("embeddingBuildJobs")),
    phase: v.optional(embeddingBuildPhaseValidator),
    cursor: v.optional(v.union(v.string(), v.null())),
    existingTargetRows: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const dryRun = args.dryRun ?? false;
    const state = await ensureSpaceEmbeddingState(ctx, args.spaceId);
    const fingerprint = args.fingerprint ?? state.activeFingerprint;
    if (!fingerprint) {
      throw new Error(
        "Space has no active embedding fingerprint; pass one explicitly",
      );
    }
    const existingTargetRows = (
      await ctx.db
        .query("embeddingTargets")
        .withIndex("by_space_kind_target", (q) => q.eq("spaceId", args.spaceId))
        .take(EMBEDDING_TARGET_CAPACITY_CEILING)
    ).length;
    const jobs = await ctx.db
      .query("embeddingBuildJobs")
      .withIndex("by_space_and_fingerprint", (q) =>
        q.eq("spaceId", args.spaceId).eq("fingerprint", fingerprint),
      )
      .collect();
    const open = jobs.filter(
      (job) => job.phase !== "done" && job.phase !== "abandoned",
    );
    if (open.length > 1) {
      throw new Error("Space has more than one open embedding build job");
    }
    const reusable = open[0];
    if (reusable) {
      return {
        dryRun,
        reused: true,
        fingerprint,
        jobId: reusable._id,
        phase: reusable.phase,
        cursor: reusable.cursor,
        existingTargetRows,
      };
    }
    if (dryRun) {
      return { dryRun: true, reused: false, fingerprint, existingTargetRows };
    }
    const jobId = await ctx.db.insert("embeddingBuildJobs", {
      spaceId: args.spaceId,
      fingerprint,
      ...(state.activeEmbeddingGenerationId &&
      state.activeFingerprint === fingerprint
        ? { embeddingGenerationId: state.activeEmbeddingGenerationId }
        : {}),
      phase: "scan",
      cursor: null,
      pageIndex: 0,
      scannedCount: 0,
      filledCount: 0,
      retiredCount: 0,
      startedAt: now,
      updatedAt: now,
    });
    if (args.autoRun) {
      await ctx.scheduler.runAfter(
        0,
        internal.models.embeddings.migrations.runTargetBackfillPage,
        { jobId, cursor: null, autoRun: true },
      );
    }
    return {
      dryRun: false,
      reused: false,
      fingerprint,
      jobId,
      phase: "scan" as const,
      cursor: null,
      existingTargetRows,
    };
  },
});

/**
 * Runs one page. The caller must pass the cursor it last received; anything
 * else is refused with the stored cursor so a replay writes nothing twice.
 * At most one successor is scheduled, and only when this page was accepted.
 */
export const runTargetBackfillPage = internalMutation({
  args: {
    jobId: v.id("embeddingBuildJobs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    autoRun: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  returns: buildPageResult,
  handler: async (ctx, args) => {
    const result = await runEmbeddingBuildPage(ctx, {
      jobId: args.jobId,
      cursor: args.cursor ?? null,
      batchSize: args.batchSize,
      now: args.now ?? Date.now(),
    });
    const scheduled = Boolean(
      args.autoRun && result.accepted && !result.isDone,
    );
    if (scheduled) {
      await ctx.scheduler.runAfter(
        0,
        internal.models.embeddings.migrations.runTargetBackfillPage,
        {
          jobId: args.jobId,
          cursor: result.cursor,
          batchSize: args.batchSize,
          autoRun: true,
        },
      );
    }
    return { ...result, scheduled };
  },
});

/**
 * Section 3.5. A build under a fingerprint that is not the active one fails
 * its generation; a build under the active fingerprint deletes no vector,
 * because everything it inserted is valid coverage of the active index.
 */
export const abandonTargetBackfill = internalMutation({
  args: {
    jobId: v.id("embeddingBuildJobs"),
    code: v.string(),
    message: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.object({
    phase: embeddingBuildPhaseValidator,
    generationFailed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Embedding build job not found");
    if (job.phase === "abandoned") {
      return { phase: job.phase, generationFailed: false };
    }
    const state = await ctx.db
      .query("spaceEmbeddingStates")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", job.spaceId))
      .unique();
    const underActiveFingerprint = state?.activeFingerprint === job.fingerprint;
    let generationFailed = false;
    if (job.embeddingGenerationId && !underActiveFingerprint) {
      const generation = await ctx.db.get(job.embeddingGenerationId);
      if (
        generation &&
        (generation.state === "staging" || generation.state === "staged")
      ) {
        await failEmbeddingGeneration(ctx, {
          embeddingGenerationId: generation._id,
          code: args.code,
          message: args.message,
          failedAt: now,
        });
        generationFailed = true;
      }
    }
    await ctx.db.patch(job._id, {
      phase: "abandoned",
      failureCode: args.code,
      failureMessage: args.message,
      updatedAt: now,
    });
    return { phase: "abandoned" as const, generationFailed };
  },
});

/** Populates `scopeV2` on existing vectors. No reader consumes it yet. */
export const backfillVectorScopeV2 = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    scanned: v.number(),
    updated: v.number(),
    alreadySet: v.number(),
    isDone: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(Math.max(args.batchSize ?? 64, 1), 128);
    const page = await ctx.db
      .query("embeddingVectors")
      .withIndex("by_space_and_scopeV2", (q) => q.eq("spaceId", args.spaceId))
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });
    let updated = 0;
    let alreadySet = 0;
    for (const row of page.page) {
      const scopeV2 = embeddingVectorScopeV2({
        spaceId: row.spaceId,
        fingerprint: row.embeddingFingerprint,
        targetKind: row.targetKind,
      });
      if (row.scopeV2 === scopeV2) {
        alreadySet += 1;
        continue;
      }
      if (!args.dryRun) await ctx.db.patch(row._id, { scopeV2 });
      updated += 1;
    }
    return {
      scanned: page.page.length,
      updated,
      alreadySet,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/** Compares the stored counters with a full recount of the target table. */
export const auditSpaceCoverage = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    fingerprint: v.optional(v.string()),
    maxRows: v.optional(v.number()),
    /** Covered targets probed for a second row. See `probeDuplicateRows`. */
    duplicateProbeLimit: v.optional(v.number()),
    repair: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    complete: v.boolean(),
    scanned: v.number(),
    counterDrift: v.boolean(),
    counterDriftReason: v.optional(v.string()),
    duplicateTargets: v.number(),
    duplicateProbeScanned: v.number(),
    duplicateProbeSaturated: v.number(),
    duplicateProbeComplete: v.boolean(),
    repaired: v.boolean(),
    fingerprint: v.string(),
    recountedEligible: embeddingKindCountsValidator,
    recountedCovered: embeddingKindCountsValidator,
    storedEligible: embeddingKindCountsValidator,
    storedCovered: embeddingKindCountsValidator,
  }),
  handler: async (ctx, args) => {
    const state = await ensureSpaceEmbeddingState(ctx, args.spaceId);
    const fingerprint = args.fingerprint ?? state.activeFingerprint;
    if (!fingerprint) {
      throw new Error(
        "Space has no active embedding fingerprint; pass one explicitly",
      );
    }
    const audit = await auditEmbeddingCounters(ctx, {
      spaceId: args.spaceId,
      fingerprint,
      maxRows: args.maxRows,
      duplicateProbeLimit: args.duplicateProbeLimit,
      repair: args.repair,
      now: args.now ?? Date.now(),
    });
    return { ...audit, fingerprint };
  },
});

// ---------------------------------------------------------------------------
// P2-6e (lite): retired same-fingerprint vectors
// ---------------------------------------------------------------------------

/**
 * The plan's vector delete budget: 128 rows of about 12.5 KiB read and written.
 * The sibling probe below adds one row read per deleted row, so a full page
 * costs roughly 3.2 MiB of the 16 MiB transaction budget.
 */
const MAX_VECTOR_CLEANUP_PAGE = 128;

/** A space keeps an active plus a retained generation, never a long history. */
const MAX_CLEANUP_GENERATIONS = 64;

const cleanupGenerationRow = v.object({
  embeddingGenerationId: v.id("embeddingGenerations"),
  fingerprint: v.string(),
  state: embeddingGenerationStateValidator,
  isActive: v.boolean(),
  targeted: v.boolean(),
  recordedThoughtCount: v.number(),
  recordedChunkCount: v.number(),
  pageRows: v.number(),
  hasMoreRows: v.boolean(),
});

/**
 * True when this target still holds a row in the *active* generation under the
 * same fingerprint, which is what makes the row being deleted a duplicate
 * rather than the target's only coverage.
 *
 * One indexed read of one row, so it stays inside the page budget. It reads the
 * active generation rather than scanning every row the target holds, and the
 * read happens before the delete, so read-your-writes cannot make an
 * already-deleted row look like a survivor.
 */
async function hasActiveGenerationRow(
  ctx: Parameters<typeof ensureEmbeddingProfile>[0],
  row: Doc<"embeddingVectors">,
  activeGenerationId: Id<"embeddingGenerations">,
): Promise<boolean> {
  const thoughtId = row.thoughtId;
  const chunkId = row.chunkId;
  const eventId = row.eventId;
  if (row.targetKind === "thought") {
    if (!thoughtId) return false;
    const matches = await ctx.db
      .query("embeddingVectors")
      .withIndex("by_generation_and_thoughtId", (q) =>
        q
          .eq("embeddingGenerationId", activeGenerationId)
          .eq("thoughtId", thoughtId),
      )
      .take(1);
    return matches.length > 0;
  }
  if (row.targetKind === "card") {
    if (!eventId) return false;
    const matches = await ctx.db
      .query("embeddingVectors")
      .withIndex("by_generation_and_eventId", (q) =>
        q
          .eq("embeddingGenerationId", activeGenerationId)
          .eq("eventId", eventId),
      )
      .take(1);
    return matches.length > 0;
  }
  if (!chunkId) return false;
  const matches = await ctx.db
    .query("embeddingVectors")
    .withIndex("by_generation_and_chunkId", (q) =>
      q.eq("embeddingGenerationId", activeGenerationId).eq("chunkId", chunkId),
    )
    .take(1);
  return matches.length > 0;
}

type GenerationVectorPage = {
  pageRows: number;
  hasMoreRows: boolean;
  scanned: number;
  deleted: number;
  duplicates: number;
  soleRows: number;
  coverageReleased: number;
  /** True when this call left the generation holding no vector row. */
  emptied: boolean;
};

/**
 * One generation's share of a delete page, with the per-row assertions both
 * operator tools rely on. It never reads the active generation's rows: the
 * page is driven from `by_embeddingGenerationId` over another generation, and
 * every row is checked against the active pointer the caller re-read from the
 * space state in this same transaction.
 */
async function deleteGenerationVectorPage(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    generation: Doc<"embeddingGenerations">;
    activeGenerationId: Id<"embeddingGenerations">;
    budget: number;
    dryRun: boolean;
  },
): Promise<GenerationVectorPage> {
  const rows = await ctx.db
    .query("embeddingVectors")
    .withIndex("by_embeddingGenerationId", (q) =>
      q.eq("embeddingGenerationId", input.generation._id),
    )
    .take(input.budget + 1);
  const page: GenerationVectorPage = {
    pageRows: 0,
    hasMoreRows: rows.length > input.budget,
    scanned: 0,
    deleted: 0,
    duplicates: 0,
    soleRows: 0,
    coverageReleased: 0,
    emptied: false,
  };
  for (const row of rows.slice(0, input.budget)) {
    // I8, step 2: every assertion below reads the row and the pointer, never
    // an argument, so the page refuses rather than over-deletes.
    if (row.spaceId !== input.spaceId) {
      throw new Error("Vector cleanup found a row in another space");
    }
    if (row.embeddingFingerprint !== input.generation.fingerprint) {
      throw new Error("Vector cleanup found a row of another fingerprint");
    }
    if (row.embeddingGenerationId === input.activeGenerationId) {
      throw new Error("Vector cleanup reached the active generation");
    }
    page.scanned += 1;
    page.pageRows += 1;
    const duplicate = await hasActiveGenerationRow(
      ctx,
      row,
      input.activeGenerationId,
    );
    if (duplicate) page.duplicates += 1;
    else page.soleRows += 1;
    if (input.dryRun) continue;
    // I4, step 3: only the target's last row releases the marker.
    if (!duplicate) {
      await releaseVectorCoverage(ctx, row);
      page.coverageReleased += 1;
    }
    await ctx.db.delete(row._id);
    page.deleted += 1;
  }
  page.emptied = !input.dryRun && !page.hasMoreRows;
  return page;
}

/**
 * Deletes the vector rows a fingerprint holds outside the space's active
 * generation, one page per call.
 *
 * P2-6d removed the generation from the vector filter, so every row of a
 * fingerprint shares one `scopeV2` value and all of them are searchable. I11
 * keeps that to one row per target from the moment it landed, but it cannot
 * reach rows an earlier generation already wrote: a space that was built twice
 * under one fingerprint returns two rows per target, the fixed candidate budget
 * yields half as many distinct targets after the reader's dedupe, and a
 * retrievable result can fall out of top-k. This is the operator tool that
 * removes them. Full retention and cleanup stay P2-6e.
 *
 * Safety, in the order the handler applies it:
 *
 * 1. I8. The active pointer is re-read from the space state inside this page's
 *    own transaction and validated, so a stale or hostile argument cannot
 *    authorize a delete. Every row is then checked against that pointer rather
 *    than against anything the caller passed.
 * 2. No row of the active generation is ever read for deletion: the page is
 *    driven from `by_embeddingGenerationId` over the other generations only.
 * 3. Counters. Deleting a duplicate must not decrement coverage for a target
 *    that still has its active row, so the marker is released only when the
 *    target holds no row in the active generation. A target whose only rows
 *    live in non-active generations is released once and becomes owed again,
 *    which the incremental fill re-embeds; `releaseVectorCoverage` ignores a
 *    second release for the same target, so a repeat cannot go negative.
 *
 * Rerun until `remaining` is false. There is no cursor: a deleted row leaves
 * the index, so every call makes progress from the front.
 */
export const deleteNonActiveGenerationVectors = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    fingerprint: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    fingerprint: v.string(),
    activeEmbeddingGenerationId: v.id("embeddingGenerations"),
    scanned: v.number(),
    deleted: v.number(),
    duplicates: v.number(),
    soleRows: v.number(),
    coverageReleased: v.number(),
    remaining: v.boolean(),
    generations: v.array(cleanupGenerationRow),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const batchSize = Math.min(
      Math.max(args.batchSize ?? MAX_VECTOR_CLEANUP_PAGE, 1),
      MAX_VECTOR_CLEANUP_PAGE,
    );
    const state = await ctx.db
      .query("spaceEmbeddingStates")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .unique();
    if (!state) throw new Error("Space embedding state not found");
    // I8, step 1: the pointer this page trusts is read here, not passed in.
    const activeGenerationId = state.activeEmbeddingGenerationId;
    if (!activeGenerationId || !state.activeFingerprint) {
      throw new Error(
        "Space has no active embedding generation; refusing to delete vectors",
      );
    }
    const activeGeneration = await ctx.db.get(activeGenerationId);
    if (
      !activeGeneration ||
      activeGeneration.spaceId !== args.spaceId ||
      activeGeneration.state !== "active" ||
      activeGeneration.fingerprint !== state.activeFingerprint
    ) {
      throw new Error("Active embedding generation pointer is invalid");
    }
    const fingerprint = args.fingerprint ?? state.activeFingerprint;

    const allGenerations = await ctx.db
      .query("embeddingGenerations")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .take(MAX_CLEANUP_GENERATIONS + 1);
    if (allGenerations.length > MAX_CLEANUP_GENERATIONS) {
      throw new Error("Space exceeds the vector cleanup generation bound");
    }

    let budget = batchSize;
    let scanned = 0;
    let deleted = 0;
    let duplicates = 0;
    let soleRows = 0;
    let coverageReleased = 0;
    let remaining = false;
    const generations = [];

    for (const generation of allGenerations) {
      const isActive = generation._id === activeGenerationId;
      const targeted = !isActive && generation.fingerprint === fingerprint;
      let pageRows = 0;
      let hasMoreRows = false;
      if (targeted) {
        const page = await deleteGenerationVectorPage(ctx, {
          spaceId: args.spaceId,
          generation,
          activeGenerationId,
          budget,
          dryRun,
        });
        budget -= page.scanned;
        scanned += page.scanned;
        deleted += page.deleted;
        duplicates += page.duplicates;
        soleRows += page.soleRows;
        coverageReleased += page.coverageReleased;
        pageRows = page.pageRows;
        hasMoreRows = page.hasMoreRows;
        if (hasMoreRows) remaining = true;
      }
      generations.push({
        embeddingGenerationId: generation._id,
        fingerprint: generation.fingerprint,
        state: generation.state,
        isActive,
        targeted,
        recordedThoughtCount: generation.completedThoughtCount,
        recordedChunkCount: generation.completedChunkCount,
        pageRows,
        hasMoreRows,
      });
    }

    return {
      dryRun,
      fingerprint,
      activeEmbeddingGenerationId: activeGenerationId,
      scanned,
      deleted,
      duplicates,
      soleRows,
      coverageReleased,
      remaining,
      generations,
    };
  },
});

// ---------------------------------------------------------------------------
// P2-6e: historical generation cleanup
// ---------------------------------------------------------------------------

/**
 * Section 4 of the capacity plan, one generation at a time:
 *
 * | Role        | Rows                                                      |
 * | ----------- | --------------------------------------------------------- |
 * | `active`    | Kept. The space state names it, re-read every page (I8).  |
 * | `retained`  | Kept. The most recently retired generation of a *different* fingerprint: the rollback artifact. |
 * | `in_flight` | Kept. A `staging` or `staged` generation still owns its rows; an operator fails it first if it is abandoned. |
 * | `deletable` | Everything else, including the active fingerprint's older generations, which is the P2-6h class. |
 *
 * Retention is by generation, not by fingerprint. The plan's I8 sentence says
 * fingerprint because it predates the row section 4 gained after P2-6d: a
 * space built twice under one fingerprint keeps two rows per target, so the
 * active fingerprint's older generations have to go while the active one stays.
 */
type CleanupRole = "active" | "retained" | "in_flight" | "deletable";

const cleanupRoleValidator = v.union(
  v.literal("active"),
  v.literal("retained"),
  v.literal("in_flight"),
  v.literal("deletable"),
);

const cleanupReportRow = v.object({
  embeddingGenerationId: v.id("embeddingGenerations"),
  fingerprint: v.string(),
  state: embeddingGenerationStateValidator,
  role: cleanupRoleValidator,
  recordedThoughtCount: v.number(),
  recordedChunkCount: v.number(),
  pageRows: v.number(),
  hasMoreRows: v.boolean(),
  cleaned: v.boolean(),
});

/** Most recent first, by the clock each state actually sets. */
function generationRecency(generation: Doc<"embeddingGenerations">): number {
  return (
    generation.deactivatedAt ??
    generation.activatedAt ??
    generation.stagedAt ??
    generation.createdAt
  );
}

function rollbackGeneration(
  generations: Doc<"embeddingGenerations">[],
  activeFingerprint: string,
): Doc<"embeddingGenerations"> | undefined {
  let best: Doc<"embeddingGenerations"> | undefined;
  for (const generation of generations) {
    if (generation.state !== "retired") continue;
    if (generation.fingerprint === activeFingerprint) continue;
    if (
      !best ||
      generationRecency(generation) > generationRecency(best) ||
      (generationRecency(generation) === generationRecency(best) &&
        generation._creationTime > best._creationTime)
    ) {
      best = generation;
    }
  }
  return best;
}

function cleanupRole(
  generation: Doc<"embeddingGenerations">,
  activeGenerationId: Id<"embeddingGenerations">,
  retainedId: Id<"embeddingGenerations"> | undefined,
): CleanupRole {
  if (generation._id === activeGenerationId) return "active";
  if (retainedId && generation._id === retainedId) return "retained";
  if (generation.state === "staging" || generation.state === "staged") {
    return "in_flight";
  }
  return "deletable";
}

/**
 * The P2-6e operator page. It deletes the vector rows of every generation the
 * retention rule above does not keep, 128 rows per call, and marks a retired
 * generation `retired_cleaned` once it holds none. Generation and profile rows
 * are never deleted: the baseline legacy-copy guard reads that history.
 *
 * Safety is the lite tool's, per page and per row: the active pointer is
 * re-read from the space state inside this transaction (I8), the active
 * generation is never read for deletion, and a coverage marker is released
 * only when the target holds no row in the active generation, so deleting a
 * duplicate cannot decrement a counter.
 *
 * Rerun until `remaining` is false, or pass `autoRun` and it schedules one
 * successor at a time. Passing `expectedActiveGenerationId` aborts the run if
 * the space activated a different generation since the previous page.
 */
export const cleanupEmbeddingGenerations = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
    expectedActiveGenerationId: v.optional(v.id("embeddingGenerations")),
    autoRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    activeFingerprint: v.string(),
    activeEmbeddingGenerationId: v.id("embeddingGenerations"),
    retainedEmbeddingGenerationId: v.optional(v.id("embeddingGenerations")),
    scanned: v.number(),
    deleted: v.number(),
    duplicates: v.number(),
    soleRows: v.number(),
    coverageReleased: v.number(),
    cleanedGenerations: v.number(),
    remaining: v.boolean(),
    scheduled: v.boolean(),
    generations: v.array(cleanupReportRow),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const batchSize = Math.min(
      Math.max(args.batchSize ?? MAX_VECTOR_CLEANUP_PAGE, 1),
      MAX_VECTOR_CLEANUP_PAGE,
    );
    // I8, step 1: the pointer this page trusts is read here, not passed in.
    const state = await ctx.db
      .query("spaceEmbeddingStates")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .unique();
    if (!state) throw new Error("Space embedding state not found");
    const activeGenerationId = state.activeEmbeddingGenerationId;
    const activeFingerprint = state.activeFingerprint;
    if (!activeGenerationId || !activeFingerprint) {
      throw new Error(
        "Space has no active embedding generation; refusing to delete vectors",
      );
    }
    if (
      args.expectedActiveGenerationId &&
      args.expectedActiveGenerationId !== activeGenerationId
    ) {
      throw new Error("Active embedding generation changed during cleanup");
    }
    const activeGeneration = await ctx.db.get(activeGenerationId);
    if (
      !activeGeneration ||
      activeGeneration.spaceId !== args.spaceId ||
      activeGeneration.state !== "active" ||
      activeGeneration.fingerprint !== activeFingerprint
    ) {
      throw new Error("Active embedding generation pointer is invalid");
    }

    const allGenerations = await ctx.db
      .query("embeddingGenerations")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .take(MAX_CLEANUP_GENERATIONS + 1);
    if (allGenerations.length > MAX_CLEANUP_GENERATIONS) {
      throw new Error("Space exceeds the vector cleanup generation bound");
    }
    const retained = rollbackGeneration(allGenerations, activeFingerprint);

    let budget = batchSize;
    let scanned = 0;
    let deleted = 0;
    let duplicates = 0;
    let soleRows = 0;
    let coverageReleased = 0;
    let cleanedGenerations = 0;
    let remaining = false;
    const generations = [];

    for (const generation of allGenerations) {
      const role = cleanupRole(generation, activeGenerationId, retained?._id);
      let pageRows = 0;
      let hasMoreRows = false;
      let cleaned = false;
      if (role === "deletable") {
        const page = await deleteGenerationVectorPage(ctx, {
          spaceId: args.spaceId,
          generation,
          activeGenerationId,
          budget,
          dryRun,
        });
        budget -= page.scanned;
        scanned += page.scanned;
        deleted += page.deleted;
        duplicates += page.duplicates;
        soleRows += page.soleRows;
        coverageReleased += page.coverageReleased;
        pageRows = page.pageRows;
        hasMoreRows = page.hasMoreRows;
        if (hasMoreRows) remaining = true;
        // A failed generation keeps its state, because that state is the
        // evidence of why it failed; only a retired one is marked cleaned.
        if (page.emptied && generation.state === "retired") {
          await ctx.db.patch(generation._id, { state: "retired_cleaned" });
          cleaned = true;
          cleanedGenerations += 1;
        }
      }
      generations.push({
        embeddingGenerationId: generation._id,
        fingerprint: generation.fingerprint,
        state: cleaned ? ("retired_cleaned" as const) : generation.state,
        role,
        recordedThoughtCount: generation.completedThoughtCount,
        recordedChunkCount: generation.completedChunkCount,
        pageRows,
        hasMoreRows,
        cleaned,
      });
    }

    const scheduled = Boolean(args.autoRun && !dryRun && remaining);
    if (scheduled) {
      await ctx.scheduler.runAfter(
        0,
        internal.models.embeddings.migrations.cleanupEmbeddingGenerations,
        {
          spaceId: args.spaceId,
          batchSize: args.batchSize,
          autoRun: true,
          expectedActiveGenerationId: activeGenerationId,
        },
      );
    }

    return {
      dryRun,
      activeFingerprint,
      activeEmbeddingGenerationId: activeGenerationId,
      ...(retained ? { retainedEmbeddingGenerationId: retained._id } : {}),
      scanned,
      deleted,
      duplicates,
      soleRows,
      coverageReleased,
      cleanedGenerations,
      remaining,
      scheduled,
      generations,
    };
  },
});

// ---------------------------------------------------------------------------
// P2-70j: the full-chunk opt-in and the space target policy
// ---------------------------------------------------------------------------

/** One page of the grandfathering migration stays far inside the write budget. */
const MAX_OPT_IN_ITEMS = 64;

/**
 * Section 8.2. Sets the full-chunk opt-in on named source items, which is how
 * the nine pilot documents are grandfathered: the corpus is identified by the
 * field this migration writes, never by an id list in code.
 *
 * Idempotent, and it reports what it changed rather than what it was asked
 * for. It marks eligibility in the same transaction, so an item that gains
 * the opt-in has its chunk targets back before the call returns.
 */
export const setChunkEmbeddingOptIn = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    sourceItemIds: v.array(v.id("sourceItems")),
    embedFullChunks: v.boolean(),
  },
  returns: v.object({
    requested: v.number(),
    changed: v.number(),
    unchanged: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.sourceItemIds.length > MAX_OPT_IN_ITEMS) {
      throw new Error("Chunk opt-in page exceeds its item bound");
    }
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;
    for (const sourceItemId of [...new Set(args.sourceItemIds)]) {
      const item = await ctx.db.get(sourceItemId);
      if (!item || item.spaceId !== args.spaceId) {
        skipped += 1;
        continue;
      }
      if (item.embedFullChunks === args.embedFullChunks) {
        unchanged += 1;
        continue;
      }
      await ctx.db.patch(item._id, { embedFullChunks: args.embedFullChunks });
      changed += 1;
      await markEligibilityTargets(ctx, args.spaceId, {
        processingGenerationIds: item.activeGenerationId
          ? [item.activeGenerationId]
          : [],
      });
    }
    return {
      requested: args.sourceItemIds.length,
      changed,
      unchanged,
      skipped,
    };
  },
});

/**
 * Section 8.2. Flips a space from embedding every active chunk to embedding
 * cards plus opted-in chunks.
 *
 * Absent is `all_chunks`, so deploying the card model changes no eligibility
 * until an operator runs this. It takes the expected current value so a
 * concurrent change cannot be overwritten, and it writes only the policy: the
 * newly ineligible chunk targets are retired by the next build's scan and
 * sweep, which is the paged path, not this one transaction.
 */
export const setSpaceTargetPolicy = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    policy: embeddingTargetPolicyValidator,
    expectedPolicy: v.optional(embeddingTargetPolicyValidator),
  },
  returns: v.object({
    changed: v.boolean(),
    policy: embeddingTargetPolicyValidator,
    previousPolicy: embeddingTargetPolicyValidator,
  }),
  handler: async (ctx, args) => {
    const state = await ensureSpaceEmbeddingState(ctx, args.spaceId);
    const previousPolicy = state.targetPolicy ?? "all_chunks";
    const expected = args.expectedPolicy ?? "all_chunks";
    if (previousPolicy !== expected) {
      throw new Error(
        `Space target policy is ${previousPolicy}, not the expected ${expected}`,
      );
    }
    if (previousPolicy === args.policy) {
      return { changed: false, policy: args.policy, previousPolicy };
    }
    await ctx.db.patch(state._id, { targetPolicy: args.policy });
    return { changed: true, policy: args.policy, previousPolicy };
  },
});
