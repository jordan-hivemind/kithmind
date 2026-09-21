// The camelCase row shapes this port hands back in place of a Convex
// `Doc<"table">`. Field names match the Convex validators in
// packages/convex/convex/models/provenance/validators.ts and
// packages/convex/convex/models/documents/inventoryTables.ts one for one;
// `id` and `spaceId` replace `_id`/`spaceId` as usual, and `createdAt` is the
// row's own structural `created_at` (section 2.2's `_creationTime`
// replacement), never to be confused with a domain `createdAt` field a table
// also has -- those are named `createdAtField` here, matching the `_field`
// suffix `packages/kith-migrate/src/schema.ts` gives the same collision.

import { camelize } from "./sql.js";

export type SourceLifecycle =
  | "available"
  | "unavailable"
  | "forgetting"
  | "forgotten";

export type ProvenanceFailure = { code: string; message: string; at: number };

export type SourceItemRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  externalIdHash: string;
  externalId: string | null;
  title: string | null;
  docType: string | null;
  uri: string | null;
  /**
   * P2-39d2, migration 006: the accepted `card_kind` of the item's live
   * card, ported from Convex's `sourceItemFields.cardDocType` (P2-80i).
   * `effectiveDocType` in `../documents/model.ts` overlays this on an
   * active document's own `docType`; it is not read anywhere else in this
   * row, since writing it is the cards domain's job (row f, out of scope).
   */
  cardDocType: string | null;
  lifecycle: SourceLifecycle;
  originalLinkAvailable: boolean;
  desiredRevisionId: string | null;
  desiredProcessingEpoch: number;
  activeRevisionId: string | null;
  activeGenerationId: string | null;
  activeCardGenerationId: string | null;
  embedFullChunks: boolean | null;
  lastFailure: ProvenanceFailure | null;
  forgottenAt: Date | null;
  forgottenBy: string | null;
  archiveDeletionForgetEpoch: number | null;
  archiveDeletionReceiptCount: number | null;
  archiveDeletionCompletedAt: Date | null;
  workerObservationEpoch: number | null;
  workerProcessingEpoch: number | null;
  workerInventoryMetadataDigest: string | null;
  workerProcessingIdentityDigest: string | null;
  workerContentHash: string | null;
  workerSourceModifiedAt: Date | null;
  workerProfileId: string | null;
  workerLastSeenInventoryEpoch: number | null;
};

export type SourceRevisionRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceItemId: string;
  contentHash: string;
  byteLength: number;
  mediaType: string;
  representation: "inline_utf8_v1" | "archived_binary_v1" | null;
  contentHashAuthority: "server_verified_utf8" | "worker_asserted" | null;
  inlineText: string | null;
  capturedAt: Date;
  userId: string;
  archiveRef: string | null;
};

export type EvidenceLocator = Record<string, unknown>;

export type SourceTextVersionRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceRevisionId: string;
  extractionFingerprint: string;
  representation: "inline_text_v1" | "parsed_pages_v1" | null;
  text: string | null;
  textHash: string;
  textHashAuthority: "server_verified_retained_text" | null;
  byteLength: number;
  utf16Length: number | null;
  pageCount: number | null;
  mappingManifestHash: string | null;
  parserArtifactId: string | null;
  evidenceSealed: boolean;
};

export type SourcePageRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceTextVersionId: string;
  ordinal: number;
  start: number;
  end: number;
  text: string;
  textHash: string;
};

export type EvidenceSpanRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  sourcePageId: string;
  ordinal: number;
  start: number;
  end: number;
  quoteHash: string;
  locator: EvidenceLocator | null;
  cardExtractionFingerprints: string[] | null;
};

export type PublicationState = "staged" | "active" | "historical";

export type DocumentRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  processingGenerationId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  documentKey: string;
  title: string;
  docType: string;
  capturedAt: Date;
  evidenceSpanIds: string[];
  publicationState: PublicationState;
};

export type ChunkRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  processingGenerationId: string;
  documentId: string;
  ordinal: number;
  sourceTextVersionId: string | null;
  start: number | null;
  end: number | null;
  text: string;
  evidenceSpanIds: string[];
  publicationState: PublicationState;
};

/**
 * P2-39d2 correction: PR206 declared this as `"staging" | "ready" |
 * "superseded"`, a plausible-looking three-state guess nothing in that PR's
 * own code branched on. The real column (`processing_generations.state`)
 * carries Convex's `processingStateValidator`
 * (`packages/convex/convex/models/ingestion/validators.ts`, the ingestion
 * domain's own enum, row e) verbatim -- migration 004 copied the column as
 * plain `text` with no CHECK, so the mistake was invisible until a caller
 * needed to compare against a real value. `verifySealedParsedPayload`
 * (parsedStaging.ts) is that caller: it distinguishes a staged, active and
 * historical generation by `state === "staged"` and `state === "ready"`
 * paired with `deactivatedAt`, exactly as the Convex original does.
 */
export type ProcessingGenerationState =
  | "queued"
  | "processing"
  | "staged"
  | "ready"
  | "needs_review"
  | "failed";

export type ProcessingGenerationRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string | null;
  processingFingerprint: string | null;
  extractionFingerprint: string | null;
  extractorFingerprint: string | null;
  recordSchemaFingerprint: string | null;
  normalizationFingerprint: string | null;
  chunkerFingerprint: string | null;
  correctionRevision: string | null;
  parserArtifactId: string | null;
  archiveSetDigest: string | null;
  normalizedBundleDigest: string | null;
  originalPrimaryReceiptId: string | null;
  originalBackupReceiptId: string | null;
  originalProviderReferenceId: string | null;
  originalProviderBindingEpoch: number | null;
  parserPrimaryReceiptId: string | null;
  parserBackupReceiptId: string | null;
  desiredProcessingEpoch: number | null;
  cardGeneration: boolean;
  state: ProcessingGenerationState;
  expectedPageCount: number | null;
  expectedEvidenceSpanCount: number | null;
  expectedDocumentCount: number | null;
  expectedChunkCount: number | null;
  expectedEventCount: number | null;
  expectedObservationCount: number | null;
  actualPageCount: number | null;
  actualEvidenceSpanCount: number | null;
  actualDocumentCount: number | null;
  actualChunkCount: number | null;
  actualEventCount: number | null;
  actualObservationCount: number | null;
  payloadManifestId: string | null;
  embeddingStatus: string | null;
  activatedAt: Date | null;
  deactivatedAt: Date | null;
};

export type SourceParserArtifactRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  clientArtifactId: string;
  parserFingerprint: string;
  outputHash: string;
  outputByteLength: number;
  outputMediaType: string;
  hashAuthority: "worker_asserted";
  userId: string;
  actorCredentialId: string;
  createdAtField: Date;
};

export type ArchiveSubjectKind = "original_bytes" | "parser_output";
export type ArchiveCopyRole = "primary" | "independent_backup";

export type SourceArtifactArchiveReceiptRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  parserArtifactId: string | null;
  subjectKind: ArchiveSubjectKind;
  copyRole: ArchiveCopyRole;
  clientReceiptId: string;
  requestDigest: string;
  receiptVersion: "archive_receipt_v1";
  archiveRepresentation: "age_encrypted_v1";
  archiveProfileFingerprint: string;
  archiveIdentityFingerprint: string;
  recipientFingerprint: string;
  repositoryKeyDomainFingerprint: string;
  storageFailureDomainFingerprint: string;
  archiveObjectId: string;
  plaintextHash: string;
  plaintextByteLength: number;
  plaintextMediaType: string;
  hashAuthority: "worker_asserted";
  ciphertextHash: string;
  ciphertextByteLength: number;
  verificationKind: "ciphertext_readback_sha256";
  readbackVerifiedAt: Date;
  userId: string;
  actorCredentialId: string;
  createdAtField: Date;
};

export type SourceInventoryExclusionReason =
  | "empty"
  | "enumeration_interrupted"
  | "oversized"
  | "permission_denied"
  | "unreadable"
  | "unstable"
  | "unsupported"
  | "encrypted"
  /**
   * ADM-4c. A provider placeholder the sync client has not downloaded. It
   * clears itself when the file syncs, unlike every other reason here, so the
   * sources screen should read it as waiting rather than as a problem.
   */
  | "not_downloaded"
  | "duplicate_of"
  | "parse_failed"
  | "extraction_pending";

export type SourceInventoryRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string | null;
  identityKeyHash: string;
  relativePath: string;
  folderPath: string;
  fileName: string;
  byteLength: number | null;
  contentHash: string | null;
  mediaType: string | null;
  modifiedAt: Date;
  duplicateGroupId: string | null;
  contentIndexed: boolean;
  exclusionReason: SourceInventoryExclusionReason | null;
  exclusionDetail: string | null;
  permissionsRestricted: boolean | null;
  permissionsDetail: string | null;
  firstSeenScanId: string;
  lastSeenScanId: string;
  missingSinceScanId: string | null;
};

// One camelizer per ported table: every `numeric` column (section on
// `camelize` in sql.ts explains why migration 004 typed them that way) is
// listed here once, so a caller never has to repeat the field list at the
// query site. `getRow`/every query in model.ts, binary.ts and
// documents/inventory.ts goes through one of these instead of the generic
// `camelize` directly.

export function camelizeSourceItem(row: Record<string, unknown>): SourceItemRow {
  return camelize<SourceItemRow>(row, [
    "desiredProcessingEpoch",
    "archiveDeletionForgetEpoch",
    "archiveDeletionReceiptCount",
    "workerObservationEpoch",
    "workerProcessingEpoch",
    "workerLastSeenInventoryEpoch",
  ]);
}

export function camelizeSourceRevision(row: Record<string, unknown>): SourceRevisionRow {
  return camelize<SourceRevisionRow>(row, ["byteLength"]);
}

export function camelizeSourceTextVersion(
  row: Record<string, unknown>,
): SourceTextVersionRow {
  return camelize<SourceTextVersionRow>(row, ["byteLength", "utf16Length", "pageCount"]);
}

export function camelizeSourcePage(row: Record<string, unknown>): SourcePageRow {
  return camelize<SourcePageRow>(row, ["ordinal", "start", "end"]);
}

export function camelizeEvidenceSpan(row: Record<string, unknown>): EvidenceSpanRow {
  return camelize<EvidenceSpanRow>(row, ["ordinal", "start", "end"]);
}

export function camelizeDocument(row: Record<string, unknown>): DocumentRow {
  return camelize<DocumentRow>(row, []);
}

export function camelizeChunk(row: Record<string, unknown>): ChunkRow {
  return camelize<ChunkRow>(row, ["ordinal", "start", "end"]);
}

export function camelizeProcessingGeneration(
  row: Record<string, unknown>,
): ProcessingGenerationRow {
  return camelize<ProcessingGenerationRow>(row, [
    "originalProviderBindingEpoch",
    "desiredProcessingEpoch",
    "expectedPageCount",
    "expectedEvidenceSpanCount",
    "expectedDocumentCount",
    "expectedChunkCount",
    "expectedEventCount",
    "expectedObservationCount",
    "actualPageCount",
    "actualEvidenceSpanCount",
    "actualDocumentCount",
    "actualChunkCount",
    "actualEventCount",
    "actualObservationCount",
  ]);
}

export function camelizeSourceParserArtifact(
  row: Record<string, unknown>,
): SourceParserArtifactRow {
  return camelize<SourceParserArtifactRow>(row, ["outputByteLength"]);
}

export function camelizeSourceArtifactArchiveReceipt(
  row: Record<string, unknown>,
): SourceArtifactArchiveReceiptRow {
  return camelize<SourceArtifactArchiveReceiptRow>(row, [
    "plaintextByteLength",
    "ciphertextByteLength",
  ]);
}

export function camelizeSourceInventory(row: Record<string, unknown>): SourceInventoryRow {
  return camelize<SourceInventoryRow>(row, ["byteLength"]);
}

// P2-39d2 additions: archive bindings/deletion, provider originals, the
// parsed-staging row and its sealed manifest. Same convention as above --
// one row type and one camelizer per table, field names matching the Convex
// validators in models/provenance/validators.ts one for one.

export type SourceArtifactArchiveBindingRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  parserArtifactId: string | null;
  subjectKind: ArchiveSubjectKind;
  subjectKey: string;
  copyRole: ArchiveCopyRole;
  receiptId: string;
  archiveIdentityFingerprint: string;
  bindingEpoch: number;
  updatedAt: Date;
  userId: string;
  actorCredentialId: string;
};

export function camelizeSourceArtifactArchiveBinding(
  row: Record<string, unknown>,
): SourceArtifactArchiveBindingRow {
  return camelize<SourceArtifactArchiveBindingRow>(row, ["bindingEpoch"]);
}

export type ArchiveAbsenceAuthority =
  | "worker_asserted_physical_absence"
  | "worker_asserted_live_repository_absence";

export type SourceArtifactDeletionAckRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  receiptId: string;
  forgetEpoch: number;
  deletionId: string;
  requestId: string;
  requestDigest: string;
  ackVersion: "archive_deletion_ack_v1";
  absenceAuthority: ArchiveAbsenceAuthority;
  retentionDisclosure: "provider_retained_deleted_history_possible" | null;
  clientReceiptId: string;
  receiptRequestDigest: string;
  sourceRevisionId: string;
  parserArtifactId: string | null;
  subjectKind: ArchiveSubjectKind;
  copyRole: ArchiveCopyRole;
  receiptVersion: "archive_receipt_v1";
  archiveRepresentation: "age_encrypted_v1";
  archiveProfileFingerprint: string;
  archiveIdentityFingerprint: string;
  recipientFingerprint: string;
  repositoryKeyDomainFingerprint: string;
  storageFailureDomainFingerprint: string;
  archiveObjectId: string;
  plaintextHash: string;
  plaintextByteLength: number;
  plaintextMediaType: string;
  hashAuthority: "worker_asserted";
  ciphertextHash: string;
  ciphertextByteLength: number;
  verificationKind: "ciphertext_readback_sha256";
  readbackVerifiedAt: Date;
  receiptUserId: string;
  receiptActorCredentialId: string;
  receiptCreatedAt: Date;
  objectOutcome: "deleted" | "already_missing";
  backupOutcome: "deleted" | "already_missing" | null;
  actorUserId: string;
  actorCredentialId: string;
  completedAt: Date;
};

export function camelizeSourceArtifactDeletionAck(
  row: Record<string, unknown>,
): SourceArtifactDeletionAckRow {
  return camelize<SourceArtifactDeletionAckRow>(row, [
    "forgetEpoch",
    "plaintextByteLength",
    "ciphertextByteLength",
  ]);
}

export type SourceProviderOriginalReferenceRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  clientReferenceId: string;
  requestDigest: string;
  referenceVersion: "provider_original_v1" | "provider_original_v2";
  providerKind: "dropbox_v1";
  referenceFingerprint: string;
  sourceContentHash: string;
  sourceByteLength: number;
  providerAccountIdHash: string;
  providerRootDirectoryIdHash: string;
  providerFileIdHash: string;
  providerRevision: string;
  providerContentHash: string;
  verifiedAt: Date;
  locatorBindingId: string | null;
  locatorManifestFingerprint: string | null;
  locatorRecipientFingerprint: string | null;
  locatorRepositoryKeyDomainFingerprint: string | null;
  locatorRepositoryId: string | null;
  locatorSnapshotId: string | null;
  locatorObjectName: string | null;
  locatorCiphertextHash: string | null;
  locatorCiphertextByteLength: number | null;
  locatorReadbackVerifiedAt: Date | null;
  verificationAuthority: "worker_asserted";
  userId: string;
  actorCredentialId: string;
  createdAtField: Date;
};

export function camelizeSourceProviderOriginalReference(
  row: Record<string, unknown>,
): SourceProviderOriginalReferenceRow {
  return camelize<SourceProviderOriginalReferenceRow>(row, [
    "sourceByteLength",
    "locatorCiphertextByteLength",
  ]);
}

export type SourceProviderOriginalBindingRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  referenceId: string;
  bindingEpoch: number;
  verifiedAt: Date;
  userId: string;
  actorCredentialId: string;
  updatedAt: Date;
};

export function camelizeSourceProviderOriginalBinding(
  row: Record<string, unknown>,
): SourceProviderOriginalBindingRow {
  return camelize<SourceProviderOriginalBindingRow>(row, ["bindingEpoch"]);
}

export type SourceProviderOriginalDetachAckRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  ackVersion: string;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  referenceId: string;
  forgetEpoch: number;
  detachId: string;
  requestId: string;
  requestDigest: string;
  referenceFingerprint: string;
  locatorBindingId: string | null;
  locatorRepositoryId: string | null;
  locatorSnapshotId: string | null;
  locatorObjectName: string | null;
  referenceOutcome: string;
  locatorBundleOutcome: string | null;
  locatorAbsenceAuthority: string | null;
  retentionDisclosure: string | null;
  providerSourceOutcome: string;
  actorUserId: string;
  actorCredentialId: string;
  completedAt: Date;
};

export function camelizeSourceProviderOriginalDetachAck(
  row: Record<string, unknown>,
): SourceProviderOriginalDetachAckRow {
  return camelize<SourceProviderOriginalDetachAckRow>(row, ["forgetEpoch"]);
}

export type WorkerParsedStagePhase =
  | "collecting"
  | "staged"
  | "verified"
  | "activated";

export type WorkerParsedStageRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  discoveryWorkId: string | null;
  ingestJobId: string;
  processingGenerationId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  parserArtifactId: string;
  archiveSetDigest: string | null;
  normalizedBundleDigest: string | null;
  mappingManifestHash: string;
  phase: string;
  nextOrdinal: number;
  expectedPageCount: number;
  expectedEvidenceSpanCount: number;
  expectedDocumentCount: number;
  expectedChunkCount: number;
  acceptedPageCount: number;
  acceptedEvidenceSpanCount: number;
  acceptedDocumentCount: number;
  acceptedChunkCount: number;
  pageIds: string[];
  evidenceSpanIds: string[];
  documentIds: string[];
  chunkIds: string[];
  pageBytes: number;
  evidenceBytes: number;
  documentBytes: number;
  chunkBytes: number;
  payloadManifestId: string | null;
  createdAtField: Date;
  updatedAt: Date;
  retireAt: Date | null;
};

export function camelizeWorkerParsedStage(
  row: Record<string, unknown>,
): WorkerParsedStageRow {
  return camelize<WorkerParsedStageRow>(row, [
    "nextOrdinal",
    "expectedPageCount",
    "expectedEvidenceSpanCount",
    "expectedDocumentCount",
    "expectedChunkCount",
    "acceptedPageCount",
    "acceptedEvidenceSpanCount",
    "acceptedDocumentCount",
    "acceptedChunkCount",
    "pageBytes",
    "evidenceBytes",
    "documentBytes",
    "chunkBytes",
  ]);
}

export type ProcessingGenerationPayloadManifestRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  parserArtifactId: string;
  processingGenerationId: string;
  archiveSetDigest: string | null;
  normalizedBundleDigest: string | null;
  mappingManifestHash: string;
  pageIds: string[];
  evidenceSpanIds: string[];
  documentIds: string[];
  chunkIds: string[];
  pageCount: number;
  evidenceSpanCount: number;
  documentCount: number;
  chunkCount: number;
  pageBytes: number;
  evidenceBytes: number;
  documentBytes: number;
  chunkBytes: number;
  pageDigest: string;
  evidenceDigest: string;
  documentDigest: string;
  chunkDigest: string;
  retainedTextHash: string;
  retainedTextUtf8Length: number;
  retainedTextUtf16Length: number;
  manifestVersion: "parsed_payload_v1";
  createdAtField: Date;
};

export function camelizeProcessingGenerationPayloadManifest(
  row: Record<string, unknown>,
): ProcessingGenerationPayloadManifestRow {
  return camelize<ProcessingGenerationPayloadManifestRow>(row, [
    "pageCount",
    "evidenceSpanCount",
    "documentCount",
    "chunkCount",
    "pageBytes",
    "evidenceBytes",
    "documentBytes",
    "chunkBytes",
    "retainedTextUtf8Length",
    "retainedTextUtf16Length",
  ]);
}
