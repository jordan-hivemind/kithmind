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

export const sourceRevisionRepresentationValidator = v.union(
  v.literal("inline_utf8_v1"),
  v.literal("archived_binary_v1"),
);

export const sourceContentHashAuthorityValidator = v.union(
  v.literal("server_verified_utf8"),
  v.literal("worker_asserted"),
);

export const sourceTextRepresentationValidator = v.union(
  v.literal("inline_text_v1"),
  v.literal("parsed_pages_v1"),
);

export const sourceTextHashAuthorityValidator = v.literal(
  "server_verified_retained_text",
);

export const parserArtifactHashAuthorityValidator =
  v.literal("worker_asserted");

export const archiveSubjectKindValidator = v.union(
  v.literal("original_bytes"),
  v.literal("parser_output"),
);

export const archiveCopyRoleValidator = v.union(
  v.literal("primary"),
  v.literal("independent_backup"),
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
  v.object({
    kind: v.literal("parser_item_v1"),
    parserArtifactId: v.id("sourceParserArtifacts"),
    pageNumber: v.number(),
    itemRef: v.string(),
    sourceCharStart: v.number(),
    sourceCharEnd: v.number(),
    bbox: v.optional(v.array(v.number())),
  }),
  v.object({
    kind: v.literal("parser_table_row_v1"),
    parserArtifactId: v.id("sourceParserArtifacts"),
    pageNumber: v.number(),
    tableRef: v.string(),
    sourceRowOffset: v.number(),
    bbox: v.optional(v.array(v.number())),
    cells: v.array(
      v.object({
        column: v.number(),
        rowSpan: v.number(),
        columnSpan: v.number(),
        textHash: v.string(),
        bbox: v.optional(v.array(v.number())),
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
  archiveDeletionForgetEpoch: v.optional(v.number()),
  archiveDeletionReceiptCount: v.optional(v.number()),
  archiveDeletionCompletedAt: v.optional(v.number()),
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
  representation: v.optional(sourceRevisionRepresentationValidator),
  contentHashAuthority: v.optional(sourceContentHashAuthorityValidator),
  inlineText: v.optional(v.string()),
  capturedAt: v.number(),
  userId: v.id("users"),
  archiveRef: v.optional(v.string()),
};

export const sourceTextVersionFields = {
  spaceId: v.id("spaces"),
  sourceRevisionId: v.id("sourceRevisions"),
  extractionFingerprint: v.string(),
  representation: v.optional(sourceTextRepresentationValidator),
  text: v.optional(v.string()),
  textHash: v.string(),
  textHashAuthority: v.optional(sourceTextHashAuthorityValidator),
  byteLength: v.number(),
  utf16Length: v.optional(v.number()),
  pageCount: v.optional(v.number()),
  mappingManifestHash: v.optional(v.string()),
  parserArtifactId: v.optional(v.id("sourceParserArtifacts")),
  evidenceSealed: v.boolean(),
};

export const sourceParserArtifactFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  sourceRevisionId: v.id("sourceRevisions"),
  clientArtifactId: v.string(),
  parserFingerprint: v.string(),
  outputHash: v.string(),
  outputByteLength: v.number(),
  outputMediaType: v.string(),
  hashAuthority: parserArtifactHashAuthorityValidator,
  userId: v.id("users"),
  actorCredentialId: v.id("apiKeys"),
  createdAt: v.number(),
};

export const sourceArtifactArchiveReceiptFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  sourceRevisionId: v.id("sourceRevisions"),
  parserArtifactId: v.optional(v.id("sourceParserArtifacts")),
  subjectKind: archiveSubjectKindValidator,
  copyRole: archiveCopyRoleValidator,
  clientReceiptId: v.string(),
  requestDigest: v.string(),
  receiptVersion: v.literal("archive_receipt_v1"),
  archiveRepresentation: v.literal("age_encrypted_v1"),
  archiveProfileFingerprint: v.string(),
  archiveIdentityFingerprint: v.string(),
  recipientFingerprint: v.string(),
  repositoryKeyDomainFingerprint: v.string(),
  storageFailureDomainFingerprint: v.string(),
  archiveObjectId: v.string(),
  plaintextHash: v.string(),
  plaintextByteLength: v.number(),
  plaintextMediaType: v.string(),
  hashAuthority: parserArtifactHashAuthorityValidator,
  ciphertextHash: v.string(),
  ciphertextByteLength: v.number(),
  verificationKind: v.literal("ciphertext_readback_sha256"),
  readbackVerifiedAt: v.number(),
  userId: v.id("users"),
  actorCredentialId: v.id("apiKeys"),
  createdAt: v.number(),
};

export const sourceArtifactArchiveBindingFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  sourceRevisionId: v.id("sourceRevisions"),
  parserArtifactId: v.optional(v.id("sourceParserArtifacts")),
  subjectKind: archiveSubjectKindValidator,
  subjectKey: v.string(),
  copyRole: archiveCopyRoleValidator,
  receiptId: v.id("sourceArtifactArchiveReceipts"),
  archiveIdentityFingerprint: v.string(),
  bindingEpoch: v.number(),
  updatedAt: v.number(),
  userId: v.id("users"),
  actorCredentialId: v.id("apiKeys"),
};

export const archiveDeletionOutcomeValidator = v.union(
  v.literal("deleted"),
  v.literal("already_missing"),
);

export const sourceArtifactDeletionAckFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  receiptId: v.id("sourceArtifactArchiveReceipts"),
  forgetEpoch: v.number(),
  deletionId: v.string(),
  requestId: v.string(),
  requestDigest: v.string(),
  ackVersion: v.literal("archive_deletion_ack_v1"),
  absenceAuthority: v.literal("worker_asserted_physical_absence"),
  clientReceiptId: v.string(),
  receiptRequestDigest: v.string(),
  sourceRevisionId: v.id("sourceRevisions"),
  parserArtifactId: v.optional(v.id("sourceParserArtifacts")),
  subjectKind: archiveSubjectKindValidator,
  copyRole: archiveCopyRoleValidator,
  receiptVersion: v.literal("archive_receipt_v1"),
  archiveRepresentation: v.literal("age_encrypted_v1"),
  archiveProfileFingerprint: v.string(),
  archiveIdentityFingerprint: v.string(),
  recipientFingerprint: v.string(),
  repositoryKeyDomainFingerprint: v.string(),
  storageFailureDomainFingerprint: v.string(),
  archiveObjectId: v.string(),
  plaintextHash: v.string(),
  plaintextByteLength: v.number(),
  plaintextMediaType: v.string(),
  hashAuthority: parserArtifactHashAuthorityValidator,
  ciphertextHash: v.string(),
  ciphertextByteLength: v.number(),
  verificationKind: v.literal("ciphertext_readback_sha256"),
  readbackVerifiedAt: v.number(),
  receiptUserId: v.id("users"),
  receiptActorCredentialId: v.id("apiKeys"),
  receiptCreatedAt: v.number(),
  objectOutcome: archiveDeletionOutcomeValidator,
  backupOutcome: v.optional(archiveDeletionOutcomeValidator),
  actorUserId: v.id("users"),
  actorCredentialId: v.id("apiKeys"),
  completedAt: v.number(),
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
  sourceTextVersionId: v.optional(v.id("sourceTextVersions")),
  start: v.optional(v.number()),
  end: v.optional(v.number()),
  text: v.string(),
  evidenceSpanIds: v.array(v.id("evidenceSpans")),
  publicationState: publicationStateValidator,
};
