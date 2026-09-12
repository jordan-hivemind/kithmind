import { v } from "convex/values";

import { internalMutation } from "../../_generated/server";
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
    repair: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    complete: v.boolean(),
    scanned: v.number(),
    counterDrift: v.boolean(),
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
  if (!chunkId) return false;
  const matches = await ctx.db
    .query("embeddingVectors")
    .withIndex("by_generation_and_chunkId", (q) =>
      q.eq("embeddingGenerationId", activeGenerationId).eq("chunkId", chunkId),
    )
    .take(1);
  return matches.length > 0;
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
        const rows = await ctx.db
          .query("embeddingVectors")
          .withIndex("by_embeddingGenerationId", (q) =>
            q.eq("embeddingGenerationId", generation._id),
          )
          .take(budget + 1);
        hasMoreRows = rows.length > budget;
        if (hasMoreRows) remaining = true;
        for (const row of rows.slice(0, budget)) {
          // I8, step 2: every assertion below reads the row and the pointer,
          // never an argument, so the page refuses rather than over-deletes.
          if (row.spaceId !== args.spaceId) {
            throw new Error("Vector cleanup found a row in another space");
          }
          if (row.embeddingFingerprint !== fingerprint) {
            throw new Error(
              "Vector cleanup found a row of another fingerprint",
            );
          }
          if (row.embeddingGenerationId === activeGenerationId) {
            throw new Error("Vector cleanup reached the active generation");
          }
          scanned += 1;
          pageRows += 1;
          budget -= 1;
          const duplicate = await hasActiveGenerationRow(
            ctx,
            row,
            activeGenerationId,
          );
          if (duplicate) duplicates += 1;
          else soleRows += 1;
          if (dryRun) continue;
          // I4, step 3: only the target's last row releases the marker.
          if (!duplicate) {
            await releaseVectorCoverage(ctx, row);
            coverageReleased += 1;
          }
          await ctx.db.delete(row._id);
          deleted += 1;
        }
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
