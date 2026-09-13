// Row types for the worker protocol's own tables, and the one rename that turns
// a `SELECT *` into the shape the ported logic already reads.
//
// `camelize` from `provenance/sql.ts` does the work; this module only declares
// which columns each table reads back as a JS `number` (migration 004 typed every
// Convex `v.number()` as `numeric`, which node-pg returns as a string on purpose)
// and what the resulting object looks like.
//
// One name is not the Convex name and cannot be. Migration 004's generator gave
// `_creationTime` the column `created_at`, so a table whose Convex document also
// had its own `createdAt` field got `created_at_field` for it -- hence
// `createdAtField` below. `createdAt` is always the creation time and is what the
// keyset order is built on; `createdAtField` is the domain's own timestamp, which
// for `worker_discovery_work` is the one the reservation order used to sort by.
// They are written together and are equal for every row this surface inserts.

import { camelize } from "../provenance/sql.js";

export type SourceAccountRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  connector: string | null;
  accountId: string | null;
  name: string | null;
  enabled: boolean | null;
  cursor: string | null;
  cursorVersion: number | null;
  freshnessMs: number | null;
  coverageInvalidatedAt: Date | null;
  lastEnumeratedAt: Date | null;
  lastProcessedAt: Date | null;
  inventoryEpoch: number | null;
  completedInventoryEpoch: number | null;
  manifestVersion: number | null;
  activeWorkerScanId: string | null;
  workerAssessmentEpoch: number | null;
  activeWorkerAssessmentId: string | null;
  latestWorkerAssessmentId: string | null;
  binaryProfileId: string | null;
  binaryProfileIds: string[] | null;
  binaryProfileAuditDigest: string | null;
  binaryProfileEnabledAt: Date | null;
  subjectEntityId: string | null;
  embedFullChunks: boolean | null;
  createdBy: string | null;
};

const SOURCE_ACCOUNT_NUMERIC = [
  "cursorVersion",
  "freshnessMs",
  "inventoryEpoch",
  "completedInventoryEpoch",
  "manifestVersion",
  "workerAssessmentEpoch",
] as const;

export function camelizeSourceAccount(
  raw: Record<string, unknown>,
): SourceAccountRow {
  return camelize<SourceAccountRow>(raw, SOURCE_ACCOUNT_NUMERIC);
}

export type WorkerScanState =
  "open" | "sealed" | "reconciling" | "enumerated" | "needs_review" | "failed";

export type WorkerScanFailureCode =
  | "empty"
  | "enumeration_interrupted"
  | "oversized"
  | "permission_denied"
  | "unreadable"
  | "unstable"
  | "unsupported"
  | "encrypted";

export type ReconcileResult = {
  state: "reconciling" | "enumerated" | "needs_review";
  inspected: number;
  unavailable: number;
  done: boolean;
};

export type WorkerSourceScanRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  requestId: string;
  requestDigest: string;
  watcherId: string;
  connectorVersion: string;
  hostAffinity: string | null;
  mode: "normal" | "identity_recovery";
  inventoryEpoch: number;
  manifestVersionAtBegin: number;
  actorUserId: string;
  actorCredentialId: string;
  state: WorkerScanState;
  nextPageOrdinal: number;
  inventoryCursor: string | null;
  inventoryDone: boolean;
  lastInventoryRequestId: string | null;
  lastInventoryRequestDigest: string | null;
  lastInventoryInputCursor: string | null;
  lastInventoryOutputCursor: string | null;
  lastInventoryDone: boolean | null;
  pageCount: number;
  entryCount: number;
  changedCount: number;
  gapCount: number;
  reviewCount: number;
  sealRequestId: string | null;
  sealRequestDigest: string | null;
  manifestVersionAtSeal: number | null;
  reconcileManifestVersion: number | null;
  reconcileCursor: string | null;
  nextReconcileOrdinal: number;
  reconcileNeedsReview: boolean | null;
  lastReconcileRequestId: string | null;
  lastReconcileRequestDigest: string | null;
  lastReconcileResult: ReconcileResult | null;
  startedAt: Date;
  sealedAt: Date | null;
  completedAt: Date | null;
  failureCode: WorkerScanFailureCode | null;
  expiresAt: Date;
  retireAt: Date;
};

const SCAN_NUMERIC = [
  "inventoryEpoch",
  "manifestVersionAtBegin",
  "nextPageOrdinal",
  "pageCount",
  "entryCount",
  "changedCount",
  "gapCount",
  "reviewCount",
  "manifestVersionAtSeal",
  "reconcileManifestVersion",
  "nextReconcileOrdinal",
] as const;

export function camelizeScan(
  raw: Record<string, unknown>,
): WorkerSourceScanRow {
  return camelize<WorkerSourceScanRow>(raw, SCAN_NUMERIC);
}

export type WorkerScanPageRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  scanId: string;
  ordinal: number;
  requestId: string;
  requestDigest: string | null;
  redactedAt: Date | null;
  entryCount: number;
  createdAtField: Date;
  retireAt: Date;
};

export function camelizeScanPage(
  raw: Record<string, unknown>,
): WorkerScanPageRow {
  return camelize<WorkerScanPageRow>(raw, ["ordinal", "entryCount"]);
}

export type WorkerScanEntryState =
  "unchanged" | "queued" | "gap" | "ignored_forgotten" | "needs_review";

export type WorkerScanEntryRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  scanId: string;
  scanPageId: string;
  sourceItemId: string | null;
  discoveryWorkId: string | null;
  identityKeyHash: string;
  externalIdHash: string | null;
  uriDigest: string;
  inventoryMetadataDigest: string;
  processingIdentityDigest: string | null;
  contentHash: string | null;
  byteLength: number | null;
  contentRepresentation: "inline_utf8_v1" | "archived_binary_v1" | null;
  binaryParserProfileId: string | null;
  binaryMediaType: string | null;
  parserFingerprint: string | null;
  extractionConfigurationFingerprint: string | null;
  extractorFingerprint: string | null;
  recordSchemaFingerprint: string | null;
  normalizationFingerprint: string | null;
  chunkerFingerprint: string | null;
  correctionRevision: string | null;
  sourceModifiedAt: Date;
  observationEpoch: number | null;
  processingEpoch: number | null;
  state: WorkerScanEntryState;
  issueCode: string | null;
  proposedExternalId: string | null;
  proposedUri: string | null;
  proposedTitle: string | null;
  proposedDocType: string | null;
  observedAt: Date;
  retireAt: Date;
};

export function camelizeScanEntry(
  raw: Record<string, unknown>,
): WorkerScanEntryRow {
  return camelize<WorkerScanEntryRow>(raw, [
    "byteLength",
    "observationEpoch",
    "processingEpoch",
  ]);
}

export type WorkerDiscoveryWorkState =
  "queued" | "leased" | "admitted" | "failed" | "needs_review" | "obsolete";

export type WorkerDiscoveryWorkRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  scanId: string;
  scanEntryId: string;
  observationEpoch: number;
  processingEpoch: number;
  expectedDesiredProcessingEpoch: number | null;
  state: WorkerDiscoveryWorkState;
  contentHash: string;
  byteLength: number;
  capturedAt: Date;
  sourceModifiedAt: Date;
  mediaType: string;
  profileId: string;
  contentRepresentation: "inline_utf8_v1" | "archived_binary_v1" | null;
  parserFingerprint: string | null;
  extractionConfigurationFingerprint: string | null;
  correctionRevision: string | null;
  extractionFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  title: string | null;
  docType: string | null;
  uri: string;
  actorUserId: string;
  actorCredentialId: string;
  attempts: number;
  leaseEpoch: number;
  leaseToken: string | null;
  leaseOwnerCredentialId: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date | null;
  failureCode: string | null;
  retryable: boolean | null;
  ingestRequestId: string | null;
  ingestJobId: string | null;
  sourceRevisionId: string | null;
  processingGenerationId: string | null;
  createdAtField: Date;
  retireAt: Date;
};

const WORK_NUMERIC = [
  "observationEpoch",
  "processingEpoch",
  "expectedDesiredProcessingEpoch",
  "byteLength",
  "attempts",
  "leaseEpoch",
] as const;

export function camelizeDiscoveryWork(
  raw: Record<string, unknown>,
): WorkerDiscoveryWorkRow {
  return camelize<WorkerDiscoveryWorkRow>(raw, WORK_NUMERIC);
}

export type WorkerReservationReceiptRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  kind: string;
  requestId: string;
  requestDigest: string;
  actorUserId: string;
  actorCredentialId: string;
  targetCount: number;
  createdAtField: Date;
  expiresAt: Date;
  invalidatedAt: Date | null;
  retireAt: Date;
};

export function camelizeReservationReceipt(
  raw: Record<string, unknown>,
): WorkerReservationReceiptRow {
  return camelize<WorkerReservationReceiptRow>(raw, ["targetCount"]);
}

export type WorkerReservationTargetRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  receiptId: string;
  ordinal: number;
  discoveryWorkId: string | null;
  ingestJobId: string | null;
  leaseEpoch: number;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export function camelizeReservationTarget(
  raw: Record<string, unknown>,
): WorkerReservationTargetRow {
  return camelize<WorkerReservationTargetRow>(raw, ["ordinal", "leaseEpoch"]);
}

export type WorkerOperationReceiptRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string | null;
  discoveryWorkId: string | null;
  operation: string;
  phase: string | null;
  requestId: string;
  requestDigest: string;
  actorUserId: string;
  actorCredentialId: string;
  leaseEpoch: number | null;
  leaseTokenHash: string | null;
  sourceRevisionId: string | null;
  processingGenerationId: string | null;
  ingestJobId: string | null;
  desiredProcessingEpoch: number | null;
  resultState: string | null;
  resultLeaseExpiresAt: Date | null;
  resultActivatedAt: Date | null;
  resultPreviousGenerationId: string | null;
  resultActualPageCount: number | null;
  resultActualEvidenceSpanCount: number | null;
  resultActualDocumentCount: number | null;
  resultActualChunkCount: number | null;
  resultRetryable: boolean | null;
  resultNextAttemptAt: Date | null;
  resultFailureCode: string | null;
  resultFailureAt: Date | null;
  createdAtField: Date;
  retireAt: Date;
};

export function camelizeOperationReceipt(
  raw: Record<string, unknown>,
): WorkerOperationReceiptRow {
  return camelize<WorkerOperationReceiptRow>(raw, [
    "leaseEpoch",
    "desiredProcessingEpoch",
    "resultActualPageCount",
    "resultActualEvidenceSpanCount",
    "resultActualDocumentCount",
    "resultActualChunkCount",
  ]);
}

export type WorkerProcessingAssessmentRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  scanId: string;
  requestId: string;
  requestDigest: string;
  actorUserId: string;
  actorCredentialId: string;
  inventoryEpoch: number;
  completedInventoryEpoch: number;
  manifestVersion: number;
  assessmentEpoch: number;
  coverageInvalidatedAt: Date | null;
  lastEnumeratedAt: Date | null;
  lastProcessedAtAtStart: Date | null;
  scanCompletedAt: Date | null;
  scanStateAtStart: string | null;
  scanEntryCount: number;
  scanChangedCount: number;
  scanGapCount: number;
  scanReviewCount: number;
  state: "running" | "complete" | "incomplete" | "stale";
  staleReason: string | null;
  phase: "items" | "unresolved_entries" | "done";
  cursor: string | null;
  nextOrdinal: number;
  counts: Record<string, unknown> | null;
  accountedScanEntries: number;
  queuedScanEntries: number;
  gapScanEntries: number;
  reviewScanEntries: number;
  ignoredScanEntries: number;
  unchangedScanEntries: number;
  lastPageRequestId: string | null;
  lastPageRequestDigest: string | null;
  lastPageInputPhase: "items" | "unresolved_entries" | null;
  lastPageOrdinal: number | null;
  lastPageResult: Record<string, unknown> | null;
  startedAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  lastProcessedAtAtCompletion: Date | null;
  retireAt: Date;
};

export function camelizeAssessment(
  raw: Record<string, unknown>,
): WorkerProcessingAssessmentRow {
  return camelize<WorkerProcessingAssessmentRow>(raw, [
    "inventoryEpoch",
    "completedInventoryEpoch",
    "manifestVersion",
    "assessmentEpoch",
    "scanEntryCount",
    "scanChangedCount",
    "scanGapCount",
    "scanReviewCount",
    "nextOrdinal",
    "accountedScanEntries",
    "queuedScanEntries",
    "gapScanEntries",
    "reviewScanEntries",
    "ignoredScanEntries",
    "unchangedScanEntries",
    "lastPageOrdinal",
  ]);
}

export type IngestJobState =
  | "queued"
  | "processing"
  | "staged"
  | "ready"
  | "failed"
  | "needs_review"
  | "obsolete_generation";

export type IngestJobRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  processingGenerationId: string;
  admittedByUserId: string;
  admittedByCredentialId: string | null;
  actorUserId: string;
  actorCredentialId: string | null;
  actorReplacedAt: Date | null;
  actorReplacedBy: string | null;
  desiredProcessingEpoch: number;
  state: IngestJobState;
  attempts: number;
  leaseEpoch: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  workerManaged: boolean | null;
  workerLeaseOwnerCredentialId: string | null;
  nextAttemptAt: Date | null;
  error: Record<string, unknown> | null;
  workerDiscoveryWorkId: string | null;
  workerObservationEpoch: number | null;
  workerProcessingMode: string | null;
};

export function camelizeIngestJob(raw: Record<string, unknown>): IngestJobRow {
  return camelize<IngestJobRow>(raw, [
    "desiredProcessingEpoch",
    "attempts",
    "leaseEpoch",
    "workerObservationEpoch",
  ]);
}

export type IngestRequestRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  requestId: string;
  requestDigest: string;
  sourceItemId: string;
  sourceRevisionId: string;
  processingGenerationId: string;
  ingestJobId: string;
  actorUserId: string;
  actorCredentialId: string | null;
};

export function camelizeIngestRequest(
  raw: Record<string, unknown>,
): IngestRequestRow {
  return camelize<IngestRequestRow>(raw);
}

export type SourceAliasDigestRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  kind: string;
  digest: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

export function camelizeAliasDigest(
  raw: Record<string, unknown>,
): SourceAliasDigestRow {
  return camelize<SourceAliasDigestRow>(raw);
}
