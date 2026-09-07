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
};
