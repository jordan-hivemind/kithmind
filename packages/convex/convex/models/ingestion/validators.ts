import { v } from "convex/values";

export const processingStateValidator = v.union(
  v.literal("queued"),
  v.literal("processing"),
  v.literal("staged"),
  v.literal("ready"),
  v.literal("needs_review"),
  v.literal("failed"),
  v.literal("obsolete_generation"),
);

export const embeddingStatusValidator = v.union(
  v.literal("pending"),
  v.literal("unavailable"),
  v.literal("ready"),
  v.literal("failed"),
);

export const ingestErrorValidator = v.object({
  code: v.string(),
  message: v.string(),
  retryable: v.boolean(),
  at: v.number(),
});

export const processingGenerationFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  sourceRevisionId: v.id("sourceRevisions"),
  sourceTextVersionId: v.optional(v.id("sourceTextVersions")),
  processingFingerprint: v.string(),
  extractionFingerprint: v.string(),
  extractorFingerprint: v.string(),
  recordSchemaFingerprint: v.string(),
  normalizationFingerprint: v.string(),
  chunkerFingerprint: v.string(),
  correctionRevision: v.string(),
  parserArtifactId: v.optional(v.id("sourceParserArtifacts")),
  archiveSetDigest: v.optional(v.string()),
  normalizedBundleDigest: v.optional(v.string()),
  originalPrimaryReceiptId: v.optional(v.id("sourceArtifactArchiveReceipts")),
  originalBackupReceiptId: v.optional(v.id("sourceArtifactArchiveReceipts")),
  parserPrimaryReceiptId: v.optional(v.id("sourceArtifactArchiveReceipts")),
  parserBackupReceiptId: v.optional(v.id("sourceArtifactArchiveReceipts")),
  desiredProcessingEpoch: v.number(),
  state: processingStateValidator,
  expectedPageCount: v.number(),
  expectedEvidenceSpanCount: v.number(),
  expectedDocumentCount: v.number(),
  expectedChunkCount: v.number(),
  expectedEventCount: v.optional(v.number()),
  expectedObservationCount: v.optional(v.number()),
  actualPageCount: v.optional(v.number()),
  actualEvidenceSpanCount: v.optional(v.number()),
  actualDocumentCount: v.optional(v.number()),
  actualChunkCount: v.optional(v.number()),
  actualEventCount: v.optional(v.number()),
  actualObservationCount: v.optional(v.number()),
  embeddingStatus: embeddingStatusValidator,
  activatedAt: v.optional(v.number()),
  deactivatedAt: v.optional(v.number()),
};

export const ingestRequestFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  requestId: v.string(),
  requestDigest: v.string(),
  sourceItemId: v.id("sourceItems"),
  sourceRevisionId: v.id("sourceRevisions"),
  processingGenerationId: v.id("processingGenerations"),
  ingestJobId: v.id("ingestJobs"),
  actorUserId: v.id("users"),
  actorCredentialId: v.optional(v.id("apiKeys")),
};

export const ingestJobFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  sourceRevisionId: v.id("sourceRevisions"),
  processingGenerationId: v.id("processingGenerations"),
  admittedByUserId: v.id("users"),
  admittedByCredentialId: v.optional(v.id("apiKeys")),
  actorUserId: v.id("users"),
  actorCredentialId: v.optional(v.id("apiKeys")),
  actorReplacedAt: v.optional(v.number()),
  actorReplacedBy: v.optional(v.id("users")),
  desiredProcessingEpoch: v.number(),
  state: processingStateValidator,
  attempts: v.number(),
  leaseEpoch: v.number(),
  leaseToken: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
  workerManaged: v.optional(v.boolean()),
  workerLeaseOwnerCredentialId: v.optional(v.id("apiKeys")),
  nextAttemptAt: v.optional(v.number()),
  error: v.optional(ingestErrorValidator),
  workerDiscoveryWorkId: v.optional(v.id("workerDiscoveryWork")),
  workerObservationEpoch: v.optional(v.number()),
  workerProcessingMode: v.optional(v.literal("parsed_pages_v1")),
};

export const spaceProcessingStateFields = {
  spaceId: v.id("spaces"),
  activationEpoch: v.number(),
  activatedAt: v.number(),
};
