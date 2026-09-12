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
  v.literal("card"),
);

/**
 * Target rows and vector rows now accept the same three kinds: P2-70j writes
 * card vectors. The alias is kept because both names are referenced widely.
 */
export const embeddingTargetRowKindValidator = embeddingTargetKindValidator;

/**
 * Section 8.2 of the document-card plan, as a space-level switch so the code
 * can deploy before the pilot corpus carries its opt-in. Absent means
 * `all_chunks`, which is exactly the behaviour before this change; the
 * operator flips a space to `cards_and_opted_in_chunks` only after the
 * grandfathering migration has run and the frozen scorer has been rerun.
 */
export const embeddingTargetPolicyValidator = v.union(
  v.literal("all_chunks"),
  v.literal("cards_and_opted_in_chunks"),
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

/**
 * P2-6f: the two lifecycle buckets no target row can distinguish. Current
 * memories need no counter of their own, because a thought target is eligible
 * exactly when its thought is lifecycle-current, so `eligibleCounts.thought`
 * already counts them.
 */
export const historicalThoughtCountsValidator = v.object({
  superseded: v.number(),
  retracted: v.number(),
});

/** One space's index coverage, read from the counters and nothing else. */
export const spaceEmbeddingCoverageValidator = v.object({
  spaceId: v.id("spaces"),
  // `unknown` is a space whose counters have never been seeded and audited.
  status: v.union(
    v.literal("unknown"),
    v.literal("complete"),
    v.literal("incomplete"),
  ),
  fingerprint: v.optional(v.string()),
  eligible: v.optional(embeddingKindCountsValidator),
  covered: v.optional(embeddingKindCountsValidator),
  drift: v.boolean(),
  lastAuditAt: v.optional(v.number()),
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
  // Section 8.2 of the document-card plan. Absent is `all_chunks`.
  targetPolicy: v.optional(embeddingTargetPolicyValidator),
  counterDrift: v.optional(v.boolean()),
  // Absent until a scan phase counts them. Maintained by the same eligibility
  // write that retires the thought's target, so stats never scan thoughts.
  historicalThoughtCounts: v.optional(historicalThoughtCountsValidator),
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
  /**
   * The card target's identity. It is the `events` row id, not the card
   * generation id, so re-extraction over unchanged text keeps the target and
   * its vector (I3). The live card generation is resolved at read time.
   */
  eventId: v.optional(v.id("events")),
  processingGenerationId: v.optional(v.id("processingGenerations")),
  inputHash: v.string(),
  embedding: v.array(v.float64()),
  // Generation-free scope. Written on every new vector, read by no reader
  // until the P2-6d cutover flips the filter field.
  scopeV2: v.optional(v.string()),
};
