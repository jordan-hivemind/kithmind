import { v } from "convex/values";

export const sourceLifecycleValidator = v.union(
  v.literal("available"),
  v.literal("unavailable"),
  v.literal("forgetting"),
  v.literal("forgotten"),
);

export const provenanceFailureValidator = v.object({
  code: v.string(),
  message: v.string(),
  at: v.number(),
});

export const publicationStateValidator = v.union(
  v.literal("staged"),
  v.literal("active"),
  v.literal("historical"),
);

export const evidenceLocatorValidator = v.union(
  v.object({
    kind: v.literal("page"),
    label: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("section"),
    heading: v.string(),
  }),
  v.object({
    kind: v.literal("sheet"),
    sheet: v.string(),
    range: v.string(),
  }),
  v.object({
    kind: v.literal("pdf"),
    pageNumber: v.number(),
    boundingBox: v.optional(
      v.object({
        left: v.number(),
        top: v.number(),
        right: v.number(),
        bottom: v.number(),
      }),
    ),
  }),
);

export const sourceItemFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  externalIdHash: v.string(),
  externalId: v.optional(v.string()),
  title: v.optional(v.string()),
  docType: v.optional(v.string()),
  uri: v.optional(v.string()),
  lifecycle: sourceLifecycleValidator,
  originalLinkAvailable: v.boolean(),
  desiredRevisionId: v.optional(v.id("sourceRevisions")),
  desiredProcessingEpoch: v.number(),
  activeRevisionId: v.optional(v.id("sourceRevisions")),
  activeGenerationId: v.optional(v.id("processingGenerations")),
  lastFailure: v.optional(provenanceFailureValidator),
  forgottenAt: v.optional(v.number()),
  forgottenBy: v.optional(v.id("users")),
  workerObservationEpoch: v.optional(v.number()),
  workerProcessingEpoch: v.optional(v.number()),
  workerInventoryMetadataDigest: v.optional(v.string()),
  workerProcessingIdentityDigest: v.optional(v.string()),
  workerContentHash: v.optional(v.string()),
  workerSourceModifiedAt: v.optional(v.number()),
  workerProfileId: v.optional(v.string()),
  workerLastSeenInventoryEpoch: v.optional(v.number()),
};

export const sourceRevisionFields = {
  spaceId: v.id("spaces"),
  sourceItemId: v.id("sourceItems"),
  contentHash: v.string(),
  byteLength: v.number(),
  mediaType: v.string(),
  inlineText: v.string(),
  capturedAt: v.number(),
  userId: v.id("users"),
  archiveRef: v.optional(v.string()),
};

export const sourceTextVersionFields = {
  spaceId: v.id("spaces"),
  sourceRevisionId: v.id("sourceRevisions"),
  extractionFingerprint: v.string(),
  text: v.string(),
  textHash: v.string(),
  byteLength: v.number(),
  evidenceSealed: v.boolean(),
};

export const sourcePageFields = {
  spaceId: v.id("spaces"),
  sourceTextVersionId: v.id("sourceTextVersions"),
  ordinal: v.number(),
  start: v.number(),
  end: v.number(),
  text: v.string(),
  textHash: v.string(),
};

export const evidenceSpanFields = {
  spaceId: v.id("spaces"),
  sourceRevisionId: v.id("sourceRevisions"),
  sourceTextVersionId: v.id("sourceTextVersions"),
  sourcePageId: v.id("sourcePages"),
  ordinal: v.number(),
  start: v.number(),
  end: v.number(),
  quoteHash: v.string(),
  locator: v.optional(evidenceLocatorValidator),
};

export const documentFields = {
  spaceId: v.id("spaces"),
  processingGenerationId: v.id("processingGenerations"),
  sourceItemId: v.id("sourceItems"),
  sourceRevisionId: v.id("sourceRevisions"),
  sourceTextVersionId: v.id("sourceTextVersions"),
  documentKey: v.string(),
  title: v.string(),
  docType: v.string(),
  capturedAt: v.number(),
  evidenceSpanIds: v.array(v.id("evidenceSpans")),
  publicationState: publicationStateValidator,
};

export const chunkFields = {
  spaceId: v.id("spaces"),
  processingGenerationId: v.id("processingGenerations"),
  documentId: v.id("documents"),
  ordinal: v.number(),
  text: v.string(),
  evidenceSpanIds: v.array(v.id("evidenceSpans")),
  publicationState: publicationStateValidator,
};
