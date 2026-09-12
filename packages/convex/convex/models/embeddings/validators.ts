import { v } from "convex/values";

export const embeddingProfileFields = {
  protocol: v.string(),
  providerId: v.string(),
  model: v.string(),
  modelRevision: v.string(),
  dimensions: v.number(),
  normalization: v.string(),
  preprocessing: v.string(),
};

export const embeddingProfileValidator = v.object(embeddingProfileFields);

export const embeddingGenerationStateValidator = v.union(
  v.literal("staging"),
  v.literal("staged"),
  v.literal("active"),
  v.literal("failed"),
  v.literal("retired"),
);

export const embeddingTargetKindValidator = v.union(
  v.literal("thought"),
  v.literal("chunk"),
);

/**
 * The index-capacity plan reserves a third embedded target kind for document
 * cards. Only `embeddingTargets` accepts it today: no vector row is written
 * with it until the card model lands, so the vector union stays unchanged.
 */
export const embeddingTargetRowKindValidator = v.union(
  v.literal("thought"),
  v.literal("chunk"),
  v.literal("card"),
);

export const embeddingTargetStateValidator = v.union(
  v.literal("eligible"),
  v.literal("retired"),
);

export const embeddingKindCountsValidator = v.object({
  thought: v.number(),
  chunk: v.number(),
  card: v.number(),
});

export const embeddingBuildPhaseValidator = v.union(
  v.literal("scan"),
  v.literal("fill"),
  v.literal("audit"),
  v.literal("done"),
  v.literal("abandoned"),
);

export const storedEmbeddingProfileFields = {
  fingerprint: v.string(),
  ...embeddingProfileFields,
  createdAt: v.number(),
};

export const spaceEmbeddingStateFields = {
  spaceId: v.id("spaces"),
  eligibilityEpoch: v.number(),
  activeEmbeddingGenerationId: v.optional(v.id("embeddingGenerations")),
  activeFingerprint: v.optional(v.string()),
  activatedAt: v.optional(v.number()),
  // Index-capacity counters (I4). Absent until the target backfill seeds them.
  // ponytail: unsharded, one row per space. Ingestion is serial per space, so
  // the write-conflict ceiling is a bulk backfill; shard into a small fixed
  // number of summed rows only if the growth test shows retries.
  eligibleCounts: v.optional(embeddingKindCountsValidator),
  coveredCounts: v.optional(
    v.array(
      v.object({
        fingerprint: v.string(),
        counts: embeddingKindCountsValidator,
      }),
    ),
  ),
  counterDrift: v.optional(v.boolean()),
  lastAuditAt: v.optional(v.number()),
  lastEligibilityChangeAt: v.optional(v.number()),
};

export const embeddingTargetFields = {
  spaceId: v.id("spaces"),
  targetKind: embeddingTargetRowKindValidator,
  targetId: v.string(),
  inputHash: v.string(),
  processingGenerationId: v.optional(v.id("processingGenerations")),
  state: embeddingTargetStateValidator,
  coveredFingerprint: v.optional(v.string()),
  updatedAt: v.number(),
};

export const embeddingBuildJobFields = {
  spaceId: v.id("spaces"),
  fingerprint: v.string(),
  embeddingGenerationId: v.optional(v.id("embeddingGenerations")),
  phase: embeddingBuildPhaseValidator,
  cursor: v.union(v.string(), v.null()),
  pageIndex: v.number(),
  scannedCount: v.number(),
  filledCount: v.number(),
  retiredCount: v.number(),
  auditEligibleCounts: v.optional(embeddingKindCountsValidator),
  auditCoveredCounts: v.optional(embeddingKindCountsValidator),
  startedAt: v.number(),
  updatedAt: v.number(),
  failureCode: v.optional(v.string()),
  failureMessage: v.optional(v.string()),
};

export const embeddingGenerationFields = {
  spaceId: v.id("spaces"),
  embeddingProfileId: v.id("embeddingProfiles"),
  fingerprint: v.string(),
  state: embeddingGenerationStateValidator,
  eligibilityEpoch: v.number(),
  manifestHash: v.string(),
  expectedThoughtCount: v.number(),
  expectedChunkCount: v.number(),
  completedThoughtCount: v.number(),
  completedChunkCount: v.number(),
  coverageInvalid: v.optional(v.boolean()),
  thoughtCoverageInvalid: v.optional(v.boolean()),
  chunkCoverageInvalid: v.optional(v.boolean()),
  createdAt: v.number(),
  stagedAt: v.optional(v.number()),
  activatedAt: v.optional(v.number()),
  deactivatedAt: v.optional(v.number()),
  failureCode: v.optional(v.string()),
  failureMessage: v.optional(v.string()),
  failedAt: v.optional(v.number()),
};

export const embeddingVectorFields = {
  spaceId: v.id("spaces"),
  embeddingGenerationId: v.id("embeddingGenerations"),
  embeddingFingerprint: v.string(),
  targetKind: embeddingTargetKindValidator,
  searchScope: v.string(),
  thoughtId: v.optional(v.id("thoughts")),
  chunkId: v.optional(v.id("chunks")),
  processingGenerationId: v.optional(v.id("processingGenerations")),
  inputHash: v.string(),
  embedding: v.array(v.float64()),
  // Generation-free scope. Written on every new vector, read by no reader
  // until the P2-6d cutover flips the filter field.
  scopeV2: v.optional(v.string()),
};
