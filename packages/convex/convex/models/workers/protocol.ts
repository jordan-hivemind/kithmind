import {
  assertParsedRequestSize,
  MAX_PARSED_PAGE_BATCH,
  MAX_PARSED_ROW_BATCH,
  parseParsedChunkInput,
  parseParsedDocumentInput,
  parseParsedEvidenceInput,
  parseParsedPageInput,
  type ParsedChunkInput,
  type ParsedDocumentInput,
  type ParsedEvidenceInput,
  type ParsedPageInput,
  type ParsedStagePhase,
} from "./parsedProtocol";

export const WORKER_PROTOCOL_VERSION = 1 as const;

export const WORKER_PROTOCOL_ERROR_CODES = [
  "not_authenticated",
  "not_authorized",
  "invalid_request",
  "not_found",
  "source_unavailable",
  "request_conflict",
  "scan_conflict",
  "scan_not_ready",
  "identity_review_required",
  "rate_limited",
  "reservation_expired",
  "stale_observation",
  "desired_processing_epoch_conflict",
  "lease_conflict",
] as const;

export type WorkerProtocolErrorCode =
  (typeof WORKER_PROTOCOL_ERROR_CODES)[number];

export type WorkerProtocolErrorData = {
  type: "worker_protocol_error";
  code: WorkerProtocolErrorCode;
};

const workerProtocolErrorCodes = new Set<string>(WORKER_PROTOCOL_ERROR_CODES);

export function parseWorkerProtocolErrorData(
  value: unknown,
): WorkerProtocolErrorData | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("type" in value) ||
    value.type !== "worker_protocol_error" ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !workerProtocolErrorCodes.has(value.code)
  ) {
    return undefined;
  }
  return {
    type: "worker_protocol_error",
    code: value.code as WorkerProtocolErrorCode,
  };
}

export class WorkerProtocolParseError extends Error {
  readonly code = "invalid_request" as const;

  constructor() {
    super("Invalid worker request");
    this.name = "WorkerProtocolParseError";
  }
}

export const MAX_WORKER_PAGE_ITEMS = 4;
export const MAX_WORKER_SCAN_PAGES = 64;
export const MAX_WORKER_INVENTORY_PAGE_ITEMS = 50;
export const MAX_WORKER_RECONCILE_ITEMS = 50;
export const MAX_WORKER_RESERVATION_ITEMS = 4;
export const MAX_WORKER_ASSESSMENT_ITEMS = 1;
export const MAX_WORKER_ARCHIVE_FORGET_ITEMS = 4;

export type WorkerPaginationOptions = {
  cursor: string | null;
  numItems: number;
};

export type FsDiscoveryGapCode =
  | "empty"
  | "enumeration_interrupted"
  | "oversized"
  | "permission_denied"
  | "unreadable"
  | "unstable"
  | "unsupported";

export type WorkerJobFailureCode =
  | "worker_interrupted"
  | "worker_resource_exhausted"
  | "source_bytes_invalid"
  | "staging_invalid";

export type ArchiveDeletionOutcome = "deleted" | "already_missing";

export type FsDiscoveryEntry = {
  externalId?: string;
  uri: string;
  title?: string;
  docType?: string;
  sourceModifiedAt: number;
  content:
    | {
        status: "ready";
        sha256: string;
        byteLength: number;
      }
    | {
        status: "gap";
        code: FsDiscoveryGapCode;
      }
    | {
        status: "ready_binary_v1";
        sha256: string;
        byteLength: number;
        mediaType: "application/pdf";
        parserProfileId: "pdf_docqa_v1";
        parserFingerprint: string;
        extractionConfigurationFingerprint: string;
        extractorFingerprint: string;
        recordSchemaFingerprint: string;
        normalizationFingerprint: string;
        chunkerFingerprint: string;
        correctionRevision: string;
      };
};

export type {
  ArchivedWorkIdentity,
  ArchiveReceiptSelection,
  ParsedTextDeclaration,
  ParserArtifactSelection,
} from "@repo/worker-protocol";
import type {
  ArchivedWorkIdentity,
  ArchiveReceiptSelection,
  ParsedTextDeclaration,
  ParserArtifactSelection,
} from "@repo/worker-protocol";

type WorkerSourceRequest = {
  protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  spaceId: string;
  sourceAccountId: string;
};

export type WorkerRequest =
  | (WorkerSourceRequest & {
      operation: "source.status";
    })
  | (WorkerSourceRequest & {
      operation: "diagnostics.status";
    })
  | (WorkerSourceRequest & {
      operation: "diagnostics.heartbeat";
      watcherId: string;
      connectorVersion: string;
    })
  | (WorkerSourceRequest & {
      operation: "archive.forgetTargets";
      requestId: string;
      sourceItemId: string;
      expectedForgetEpoch: number;
      paginationOpts: WorkerPaginationOptions;
    })
  | (WorkerSourceRequest & {
      operation: "archive.ackDeletion";
      requestId: string;
      sourceItemId: string;
      expectedForgetEpoch: number;
      deletionId: string;
      receiptId: string;
      objectOutcome: ArchiveDeletionOutcome;
      backupOutcome?: ArchiveDeletionOutcome;
    })
  | (WorkerSourceRequest & {
      operation: "source.inventoryPage";
      scanId: string;
      requestId: string;
      expectedInventoryEpoch: number;
      expectedManifestVersion: number;
      paginationOpts: WorkerPaginationOptions;
    })
  | (WorkerSourceRequest & {
      operation: "scan.begin";
      requestId: string;
      watcherId: string;
      connectorVersion: string;
      hostAffinity?: string;
      mode: "normal" | "identity_recovery";
      expectedInventoryEpoch: number;
    })
  | (WorkerSourceRequest & {
      operation: "scan.appendPage";
      scanId: string;
      requestId: string;
      ordinal: number;
      entries: FsDiscoveryEntry[];
    })
  | (WorkerSourceRequest & {
      operation: "scan.seal";
      scanId: string;
      requestId: string;
      expectedPageCount: number;
      health:
        { status: "healthy" } | { status: "failed"; code: FsDiscoveryGapCode };
    })
  | (WorkerSourceRequest & {
      operation: "scan.reconcile";
      scanId: string;
      requestId: string;
      expectedInventoryEpoch: number;
      ordinal: number;
      maxItems: number;
    })
  | (WorkerSourceRequest & {
      operation: "discovery.reserve";
      requestId: string;
      maxItems: number;
    })
  | (WorkerSourceRequest & {
      operation: "discovery.admitUtf8";
      requestId: string;
      workId: string;
      leaseEpoch: number;
      leaseToken: string;
      text: string;
    })
  | (WorkerSourceRequest & {
      operation: "discovery.preflightArchived";
      requestId: string;
      identity: ArchivedWorkIdentity;
      archiveIntentDigest: string;
    })
  | (WorkerSourceRequest & {
      operation: "discovery.reserveArchived";
      requestId: string;
      identity: ArchivedWorkIdentity;
    })
  | (WorkerSourceRequest & {
      operation: "discovery.lookupArchivedAdmission";
      requestId: string;
      identity: ArchivedWorkIdentity;
      lookup:
        | { mode: "original" }
        | {
            mode: "processing";
            clientArtifactId: string;
            parserOutputHash: string;
            parserOutputByteLength: number;
            parserOutputMediaType: "application/vnd.docling+json";
            parsedText: ParsedTextDeclaration;
          };
    })
  | (WorkerSourceRequest & {
      operation: "discovery.admitArchived";
      requestId: string;
      workId: string;
      leaseEpoch: number;
      leaseToken: string;
      parserArtifact: ParserArtifactSelection;
      archives: ArchiveReceiptSelection[];
      parsedText: ParsedTextDeclaration;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.reserve";
      requestId: string;
      maxItems: number;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.renew";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.stageUtf8";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.activate";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.fail";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
      failureCode: WorkerJobFailureCode;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.reserveParsed";
      requestId: string;
      maxItems: number;
      jobId?: string;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.renewParsed";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.activateParsed";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.failParsed";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
      failureCode: WorkerJobFailureCode;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.stageParsedBegin";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
      extractionFingerprint: string;
      mappingManifestHash: string;
      normalizedBundleDigest: string;
      expectedPageCount: number;
      expectedEvidenceSpanCount: number;
      expectedDocumentCount: number;
      expectedChunkCount: number;
    })
  | (WorkerSourceRequest & {
      operation: "jobs.stageParsedBatch";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
      stageId: string;
      phase: Exclude<ParsedStagePhase, "seal" | "staged">;
      ordinal: number;
      rows:
        | ParsedPageInput[]
        | ParsedEvidenceInput[]
        | ParsedDocumentInput[]
        | ParsedChunkInput[];
    })
  | (WorkerSourceRequest & {
      operation: "jobs.stageParsedSeal";
      requestId: string;
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
      stageId: string;
      normalizedBundleDigest: string;
    })
  | (WorkerSourceRequest & {
      operation: "processing.assessBegin";
      requestId: string;
      scanId: string;
      expectedInventoryEpoch: number;
      expectedManifestVersion: number;
    })
  | (WorkerSourceRequest & {
      operation: "processing.assessPage";
      requestId: string;
      assessmentId: string;
      ordinal: number;
      maxItems: number;
    });

export type ProcessingAssessmentCounts = {
  items: {
    ready: number;
    pending: number;
    failed: number;
    needsReview: number;
    explicitGap: number;
    unavailable: number;
    ignoredForgotten: number;
  };
  unresolvedEntries: {
    needsReview: number;
    ignoredForgotten: number;
  };
};

export type WorkerProcessingStatus =
  | { state: "not_assessed" }
  | { state: "assessing"; assessmentId: string; startedAt: number }
  | {
      state: "complete" | "incomplete";
      assessmentId: string;
      scanId: string;
      inventoryEpoch: number;
      manifestVersion: number;
      completedAt: number;
      counts: ProcessingAssessmentCounts;
    };

export type WorkerSourceStatusResult = {
  operation: "source.status";
  sourceAccountId: string;
  inventoryEpoch: number;
  completedInventoryEpoch: number;
  manifestVersion: number;
  enumeration:
    | { state: "never" }
    | { state: "in_progress"; scanId: string }
    | { state: "complete"; scanId?: string; completedAt: number }
    | { state: "needs_review"; scanId: string; completedAt?: number }
    | {
        state: "failed";
        scanId?: string;
        completedAt?: number;
        failureCode?: FsDiscoveryGapCode;
      };
  processing: WorkerProcessingStatus;
  recordCoverage: "not_established";
};

export type WorkerDiagnosticsWatcher =
  | { state: "not_configured" }
  | { state: "awaiting_heartbeat"; watcherId: string }
  | {
      state: "current" | "overdue";
      watcherId: string;
      lastSeenAt: number;
      nextExpectedAt: number;
    };

export type WorkerDiagnosticsIncident =
  | { state: "none" }
  | { state: "open"; kind: "missing_worker"; openedAt: number };

export type WorkerDiagnosticsStatusResult = {
  operation: "diagnostics.status";
  diagnosticsVersion: 1;
  sourceAccountId: string;
  source: "enabled";
  watcher: WorkerDiagnosticsWatcher;
  incident: WorkerDiagnosticsIncident;
};

export type WorkerDiagnosticsHeartbeatResult = {
  operation: "diagnostics.heartbeat";
  sourceAccountId: string;
  watcherId: string;
  receivedAt: number;
  nextExpectedAt: number;
};

export type WorkerInventoryItem =
  | {
      lifecycle: "available" | "unavailable";
      sourceItemId: string;
      externalId: string;
      uri?: string;
      observationEpoch: number;
      processingEpoch: number;
      inventoryMetadataDigest?: string;
    }
  | {
      lifecycle: "tombstone";
      externalIdHash: string;
      uriAliasDigests: string[];
    };

export type WorkerInventoryPageResult = {
  operation: "source.inventoryPage";
  page: WorkerInventoryItem[];
  isDone: boolean;
  continueCursor: string;
};

export type WorkerScanBeginResult = {
  operation: "scan.begin";
  scanId: string;
  inventoryEpoch: number;
  manifestVersion: number;
  state:
    | "open"
    | "sealed"
    | "reconciling"
    | "enumerated"
    | "needs_review"
    | "failed";
  reused: boolean;
};

export type WorkerScanAppendResult = {
  operation: "scan.appendPage";
  scanId: string;
  ordinal: number;
  reused: boolean;
  entries: Array<{
    state:
      "unchanged" | "queued" | "gap" | "ignored_forgotten" | "needs_review";
    sourceItemId?: string;
    observationEpoch?: number;
    processingEpoch?: number;
  }>;
};

export type WorkerScanSealResult = {
  operation: "scan.seal";
  scanId: string;
  state: "sealed" | "needs_review" | "failed";
  reused: boolean;
};

export type WorkerScanReconcileResult = {
  operation: "scan.reconcile";
  scanId: string;
  state: "reconciling" | "enumerated" | "needs_review";
  inspected: number;
  unavailable: number;
  done: boolean;
  reused: boolean;
};

export type WorkerDiscoveryReserveResult = {
  operation: "discovery.reserve";
  receiptId: string;
  expiresAt: number;
  reused: boolean;
  targets: Array<{
    workId: string;
    sourceItemId: string;
    observationEpoch: number;
    processingEpoch: number;
    leaseEpoch: number;
    leaseToken: string;
    leaseExpiresAt: number;
    uri: string;
    contentHash: string;
    byteLength: number;
  }>;
};

export type WorkerDiscoveryAdmitResult = {
  operation: "discovery.admitUtf8";
  workId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  processingGenerationId: string;
  ingestJobId: string;
  desiredProcessingEpoch: number;
  state: "admitted";
  reused: boolean;
};

export type WorkerArchivedPreflightResult = {
  operation: "discovery.preflightArchived";
  sourceItemId: string;
  workId: string;
  expectedDesiredProcessingEpoch: number;
  archiveIntentDigest: string;
};

export type WorkerArchivedReserveResult = {
  operation: "discovery.reserveArchived";
  workId: string;
  sourceItemId: string;
  observationEpoch: number;
  processingEpoch: number;
  leaseEpoch: number;
  leaseToken: string;
  leaseExpiresAt: number;
  reused: boolean;
};

export type WorkerArchivedLookupResult =
  | {
      operation: "discovery.lookupArchivedAdmission";
      mode: "original" | "processing";
      found: false;
    }
  | {
      operation: "discovery.lookupArchivedAdmission";
      mode: "original";
      found: true;
      sourceRevisionId: string;
      originalPrimaryReceiptId: string;
      originalPrimaryBindingEpoch: number;
      originalBackupReceiptId: string;
      originalBackupBindingEpoch: number;
    }
  | {
      operation: "discovery.lookupArchivedAdmission";
      mode: "processing";
      found: true;
      sourceRevisionId: string;
      parserArtifactId: string;
      sourceTextVersionId: string;
      processingGenerationId: string;
      ingestJobId: string;
      desiredProcessingEpoch: number;
      archiveSetDigest: string;
      originalPrimaryReceiptId: string;
      originalPrimaryBindingEpoch: number;
      originalBackupReceiptId: string;
      originalBackupBindingEpoch: number;
      parserPrimaryReceiptId: string;
      parserPrimaryBindingEpoch: number;
      parserBackupReceiptId: string;
      parserBackupBindingEpoch: number;
    };

export type WorkerArchivedAdmitResult = {
  operation: "discovery.admitArchived";
  workId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  parserArtifactId: string;
  sourceTextVersionId: string;
  processingGenerationId: string;
  ingestJobId: string;
  desiredProcessingEpoch: number;
  archiveSetDigest: string;
  originalPrimaryReceiptId: string;
  originalPrimaryBindingEpoch: number;
  originalBackupReceiptId: string;
  originalBackupBindingEpoch: number;
  parserPrimaryReceiptId: string;
  parserPrimaryBindingEpoch: number;
  parserBackupReceiptId: string;
  parserBackupBindingEpoch: number;
  state: "admitted";
  reused: boolean;
};

export type WorkerJobReserveResult = {
  operation: "jobs.reserve";
  receiptId: string;
  expiresAt: number;
  reused: boolean;
  targets: Array<{
    jobId: string;
    workId: string;
    sourceItemId: string;
    observationEpoch: number;
    processingEpoch: number;
    state: "processing" | "staged";
    leaseEpoch: number;
    leaseToken: string;
    leaseExpiresAt: number;
  }>;
};

export type WorkerJobRenewResult = {
  operation: "jobs.renew";
  jobId: string;
  state: "processing" | "staged";
  leaseExpiresAt: number;
  reused: boolean;
};

export type WorkerJobStageResult = {
  operation: "jobs.stageUtf8";
  jobId: string;
  state: "staged";
  actualPageCount: number;
  actualEvidenceSpanCount: number;
  actualDocumentCount: number;
  actualChunkCount: number;
  reused: boolean;
};

export type WorkerJobActivateResult = {
  operation: "jobs.activate";
  jobId: string;
  state: "ready";
  activatedAt: number;
  previousGenerationId?: string;
  reused: boolean;
};

export type WorkerJobFailResult = {
  operation: "jobs.fail";
  jobId: string;
  state: "failed" | "needs_review" | "obsolete_generation";
  retryable: boolean;
  nextAttemptAt?: number;
  failureCode: WorkerJobFailureCode;
  reused: boolean;
};

export type WorkerParsedReserveResult = Omit<
  WorkerJobReserveResult,
  "operation"
> & {
  operation: "jobs.reserveParsed";
};
export type WorkerParsedRenewResult = Omit<
  WorkerJobRenewResult,
  "operation"
> & {
  operation: "jobs.renewParsed";
};
export type WorkerParsedFailResult = Omit<WorkerJobFailResult, "operation"> & {
  operation: "jobs.failParsed";
};
export type WorkerParsedStageBeginResult = {
  operation: "jobs.stageParsedBegin";
  jobId: string;
  stageId: string;
  phase: ParsedStagePhase;
  nextOrdinal: number;
  reused: boolean;
};
export type WorkerParsedStageBatchResult = {
  operation: "jobs.stageParsedBatch";
  jobId: string;
  stageId: string;
  committedPhase: Exclude<ParsedStagePhase, "seal" | "staged">;
  phase: Exclude<ParsedStagePhase, "staged">;
  nextOrdinal: number;
  acceptedCount: number;
  reused: boolean;
};
export type WorkerParsedStageSealResult = {
  operation: "jobs.stageParsedSeal";
  jobId: string;
  stageId: string;
  payloadManifestId: string;
  state: "staged";
  actualPageCount: number;
  actualEvidenceSpanCount: number;
  actualDocumentCount: number;
  actualChunkCount: number;
  reused: boolean;
};
export type WorkerParsedActivateResult = Omit<
  WorkerJobActivateResult,
  "operation"
> & {
  operation: "jobs.activateParsed";
};

export type WorkerAssessmentBeginResult = {
  operation: "processing.assessBegin";
  assessmentId: string;
  scanId: string;
  inventoryEpoch: number;
  manifestVersion: number;
  state: "running" | "complete" | "incomplete" | "stale";
  nextOrdinal: number;
  counts?: ProcessingAssessmentCounts;
  completedAt?: number;
  reused: boolean;
  staleReason?: "source_changed" | "detail_unavailable" | "expired";
};

export type WorkerAssessmentPageResult = {
  operation: "processing.assessPage";
  assessmentId: string;
  state: "running" | "complete" | "incomplete" | "stale";
  phase: "items" | "unresolved_entries" | "done";
  ordinal: number;
  inspected: number;
  nextOrdinal: number;
  counts?: ProcessingAssessmentCounts;
  completedAt?: number;
  reused: boolean;
  staleReason?: "source_changed" | "detail_unavailable" | "expired";
};

export type WorkerArchiveDeletionAckSummary = {
  deletionId: string;
  receiptId: string;
  forgetEpoch: number;
  objectOutcome: ArchiveDeletionOutcome;
  backupOutcome?: ArchiveDeletionOutcome;
  absenceAuthority: "worker_asserted_physical_absence";
  completedAt: number;
};

export type WorkerArchiveForgetTarget = {
  receiptId: string;
  clientReceiptId: string;
  receiptRequestDigest: string;
  subjectKind: "original_bytes" | "parser_output";
  copyRole: "primary" | "independent_backup";
  archiveIdentityFingerprint: string;
  archiveObjectId: string;
  ciphertextHash: string;
  ciphertextByteLength: number;
  forgetEpoch: number;
  ack?: WorkerArchiveDeletionAckSummary;
};

export type WorkerArchiveForgetTargetsResult = {
  operation: "archive.forgetTargets";
  sourceItemId: string;
  sourceExternalIdHash: string;
  forgetEpoch: number;
  targets: WorkerArchiveForgetTarget[];
  isDone: boolean;
  continueCursor: string;
};

export type WorkerArchiveAckDeletionResult = WorkerArchiveDeletionAckSummary & {
  operation: "archive.ackDeletion";
  reused: boolean;
};

export type WorkerResult =
  | WorkerSourceStatusResult
  | WorkerDiagnosticsStatusResult
  | WorkerDiagnosticsHeartbeatResult
  | WorkerArchiveForgetTargetsResult
  | WorkerArchiveAckDeletionResult
  | WorkerInventoryPageResult
  | WorkerScanBeginResult
  | WorkerScanAppendResult
  | WorkerScanSealResult
  | WorkerScanReconcileResult
  | WorkerDiscoveryReserveResult
  | WorkerDiscoveryAdmitResult
  | WorkerArchivedPreflightResult
  | WorkerArchivedReserveResult
  | WorkerArchivedLookupResult
  | WorkerArchivedAdmitResult
  | WorkerJobReserveResult
  | WorkerJobRenewResult
  | WorkerJobStageResult
  | WorkerJobActivateResult
  | WorkerJobFailResult
  | WorkerParsedReserveResult
  | WorkerParsedRenewResult
  | WorkerParsedFailResult
  | WorkerParsedStageBeginResult
  | WorkerParsedStageBatchResult
  | WorkerParsedStageSealResult
  | WorkerParsedActivateResult
  | WorkerAssessmentBeginResult
  | WorkerAssessmentPageResult;

type JsonObject = Record<string, unknown>;

function invalid(): never {
  throw new WorkerProtocolParseError();
}

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    invalid();
  }
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function string(
  value: unknown,
  options: { maxUtf8?: number; maxUtf16?: number; pattern?: RegExp } = {},
): string {
  if (
    typeof value !== "string" ||
    !wellFormed(value) ||
    value.trim().length === 0 ||
    (options.maxUtf16 !== undefined && value.length > options.maxUtf16) ||
    (options.maxUtf8 !== undefined &&
      new TextEncoder().encode(value).byteLength > options.maxUtf8) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    return invalid();
  }
  return value;
}

function optionalString(
  value: unknown,
  options: { maxUtf8?: number; maxUtf16?: number } = {},
): string | undefined {
  return value === undefined ? undefined : string(value, options);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid();
  }
  return value;
}

function common(value: JsonObject): WorkerSourceRequest {
  if (value.protocolVersion !== WORKER_PROTOCOL_VERSION) invalid();
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    spaceId: string(value.spaceId, { maxUtf16: 256 }),
    sourceAccountId: string(value.sourceAccountId, { maxUtf16: 256 }),
  };
}

function requestId(value: unknown): string {
  return string(value, { maxUtf8: 128 });
}

function scanId(value: unknown): string {
  return string(value, { maxUtf16: 256 });
}

function epoch(value: unknown): number {
  return integer(value, 0, Number.MAX_SAFE_INTEGER - 1);
}

function paginationOptions(value: unknown): WorkerPaginationOptions {
  const input = object(value);
  exactKeys(input, ["cursor", "numItems"]);
  const cursor =
    input.cursor === null ? null : string(input.cursor, { maxUtf8: 8_192 });
  return {
    cursor,
    numItems: integer(input.numItems, 1, MAX_WORKER_INVENTORY_PAGE_ITEMS),
  };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GAP_CODES = new Set<FsDiscoveryGapCode>([
  "empty",
  "enumeration_interrupted",
  "oversized",
  "permission_denied",
  "unreadable",
  "unstable",
  "unsupported",
]);
const JOB_FAILURE_CODES = new Set<WorkerJobFailureCode>([
  "worker_interrupted",
  "worker_resource_exhausted",
  "source_bytes_invalid",
  "staging_invalid",
]);

function gapCode(value: unknown): FsDiscoveryGapCode {
  if (
    typeof value !== "string" ||
    !GAP_CODES.has(value as FsDiscoveryGapCode)
  ) {
    return invalid();
  }
  return value as FsDiscoveryGapCode;
}

function jobFailureCode(value: unknown): WorkerJobFailureCode {
  if (
    typeof value !== "string" ||
    !JOB_FAILURE_CODES.has(value as WorkerJobFailureCode)
  ) {
    return invalid();
  }
  return value as WorkerJobFailureCode;
}

function jobLeaseRequest(input: JsonObject): {
  requestId: string;
  jobId: string;
  leaseEpoch: number;
  leaseToken: string;
} {
  return {
    requestId: requestId(input.requestId),
    jobId: string(input.jobId, { maxUtf16: 256 }),
    leaseEpoch: integer(input.leaseEpoch, 1, Number.MAX_SAFE_INTEGER),
    leaseToken: string(input.leaseToken, {
      maxUtf16: 64,
      pattern: SHA256,
    }),
  };
}

function discoveryEntry(value: unknown, mode: "normal" | "identity_recovery") {
  const input = object(value);
  exactKeys(
    input,
    ["uri", "sourceModifiedAt", "content"],
    ["externalId", "title", "docType"],
  );
  const externalId =
    input.externalId === undefined
      ? undefined
      : string(input.externalId, { maxUtf8: 128, pattern: UUID });
  if (mode === "normal" && externalId === undefined) invalid();

  const contentInput = object(input.content);
  let content: FsDiscoveryEntry["content"];
  if (contentInput.status === "ready") {
    exactKeys(contentInput, ["status", "sha256", "byteLength"]);
    content = {
      status: "ready",
      sha256: string(contentInput.sha256, {
        maxUtf16: 64,
        pattern: SHA256,
      }),
      byteLength: integer(contentInput.byteLength, 1, 65_536),
    };
  } else if (contentInput.status === "ready_binary_v1") {
    exactKeys(contentInput, [
      "status",
      "sha256",
      "byteLength",
      "mediaType",
      "parserProfileId",
      "parserFingerprint",
      "extractionConfigurationFingerprint",
      "extractorFingerprint",
      "recordSchemaFingerprint",
      "normalizationFingerprint",
      "chunkerFingerprint",
      "correctionRevision",
    ]);
    if (
      contentInput.mediaType !== "application/pdf" ||
      contentInput.parserProfileId !== "pdf_docqa_v1"
    ) {
      invalid();
    }
    content = {
      status: "ready_binary_v1",
      sha256: string(contentInput.sha256, { maxUtf16: 64, pattern: SHA256 }),
      byteLength: integer(contentInput.byteLength, 1, 16 * 1_024 * 1_024),
      mediaType: "application/pdf",
      parserProfileId: "pdf_docqa_v1",
      parserFingerprint: string(contentInput.parserFingerprint, {
        maxUtf16: 64,
        pattern: SHA256,
      }),
      extractionConfigurationFingerprint: string(
        contentInput.extractionConfigurationFingerprint,
        {
          maxUtf16: 64,
          pattern: SHA256,
        },
      ),
      extractorFingerprint: string(contentInput.extractorFingerprint, {
        maxUtf8: 1_024,
      }),
      recordSchemaFingerprint: string(contentInput.recordSchemaFingerprint, {
        maxUtf8: 1_024,
      }),
      normalizationFingerprint: string(contentInput.normalizationFingerprint, {
        maxUtf8: 1_024,
      }),
      chunkerFingerprint: string(contentInput.chunkerFingerprint, {
        maxUtf8: 1_024,
      }),
      correctionRevision: string(contentInput.correctionRevision, {
        maxUtf8: 1_024,
      }),
    };
  } else if (contentInput.status === "gap") {
    exactKeys(contentInput, ["status", "code"]);
    content = { status: "gap", code: gapCode(contentInput.code) };
  } else {
    return invalid();
  }

  return {
    ...(externalId === undefined ? {} : { externalId }),
    uri: canonicalFsUri(input.uri),
    ...(input.title === undefined
      ? {}
      : { title: optionalString(input.title, { maxUtf16: 200 }) }),
    ...(input.docType === undefined
      ? {}
      : { docType: optionalString(input.docType, { maxUtf16: 100 }) }),
    sourceModifiedAt: integer(
      input.sourceModifiedAt,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    content,
  } satisfies FsDiscoveryEntry;
}

function archivedWorkIdentity(value: unknown): ArchivedWorkIdentity {
  const input = object(value);
  exactKeys(input, [
    "sourceItemId",
    "scanId",
    "observationEpoch",
    "processingEpoch",
    "contentHash",
    "byteLength",
    "mediaType",
    "parserProfileId",
    "parserFingerprint",
    "extractionConfigurationFingerprint",
    "extractorFingerprint",
    "recordSchemaFingerprint",
    "normalizationFingerprint",
    "chunkerFingerprint",
    "correctionRevision",
  ]);
  if (
    input.mediaType !== "application/pdf" ||
    input.parserProfileId !== "pdf_docqa_v1"
  ) {
    return invalid();
  }
  return {
    sourceItemId: string(input.sourceItemId, { maxUtf16: 256 }),
    scanId: scanId(input.scanId),
    observationEpoch: epoch(input.observationEpoch),
    processingEpoch: epoch(input.processingEpoch),
    contentHash: string(input.contentHash, { maxUtf16: 64, pattern: SHA256 }),
    byteLength: integer(input.byteLength, 1, 16 * 1_024 * 1_024),
    mediaType: "application/pdf",
    parserProfileId: "pdf_docqa_v1",
    parserFingerprint: string(input.parserFingerprint, {
      maxUtf16: 64,
      pattern: SHA256,
    }),
    extractionConfigurationFingerprint: string(
      input.extractionConfigurationFingerprint,
      {
        maxUtf16: 64,
        pattern: SHA256,
      },
    ),
    extractorFingerprint: string(input.extractorFingerprint, {
      maxUtf8: 1_024,
    }),
    recordSchemaFingerprint: string(input.recordSchemaFingerprint, {
      maxUtf8: 1_024,
    }),
    normalizationFingerprint: string(input.normalizationFingerprint, {
      maxUtf8: 1_024,
    }),
    chunkerFingerprint: string(input.chunkerFingerprint, { maxUtf8: 1_024 }),
    correctionRevision: string(input.correctionRevision, { maxUtf8: 1_024 }),
  };
}

function parserArtifactSelection(value: unknown): ParserArtifactSelection {
  const input = object(value);
  if (input.kind === "existing") {
    exactKeys(input, ["kind", "parserArtifactId"]);
    return {
      kind: "existing",
      parserArtifactId: string(input.parserArtifactId, { maxUtf16: 256 }),
    };
  }
  if (input.kind !== "create") return invalid();
  exactKeys(input, [
    "kind",
    "clientArtifactId",
    "outputHash",
    "outputByteLength",
    "outputMediaType",
    "createdAt",
  ]);
  if (input.outputMediaType !== "application/vnd.docling+json") invalid();
  return {
    kind: "create",
    clientArtifactId: string(input.clientArtifactId, {
      maxUtf16: 36,
      pattern: UUID,
    }),
    outputHash: string(input.outputHash, { maxUtf16: 64, pattern: SHA256 }),
    outputByteLength: integer(input.outputByteLength, 1, 64 * 1_024 * 1_024),
    outputMediaType: "application/vnd.docling+json",
    createdAt: epoch(input.createdAt),
  };
}

function archiveReceiptSelection(value: unknown): ArchiveReceiptSelection {
  const input = object(value);
  const subjectKind =
    input.subjectKind === "original_bytes" ||
    input.subjectKind === "parser_output"
      ? input.subjectKind
      : invalid();
  const copyRole =
    input.copyRole === "primary" || input.copyRole === "independent_backup"
      ? input.copyRole
      : invalid();
  if (input.kind === "existing") {
    exactKeys(input, [
      "kind",
      "subjectKind",
      "copyRole",
      "receiptId",
      "bindingEpoch",
    ]);
    return {
      kind: "existing",
      subjectKind,
      copyRole,
      receiptId: string(input.receiptId, { maxUtf16: 256 }),
      bindingEpoch: epoch(input.bindingEpoch),
    };
  }
  if (input.kind !== "create") return invalid();
  exactKeys(input, [
    "kind",
    "subjectKind",
    "copyRole",
    "clientReceiptId",
    "archiveProfileFingerprint",
    "archiveIdentityFingerprint",
    "recipientFingerprint",
    "repositoryKeyDomainFingerprint",
    "storageFailureDomainFingerprint",
    "archiveObjectId",
    "ciphertextHash",
    "ciphertextByteLength",
    "readbackVerifiedAt",
    "createdAt",
  ]);
  const fingerprint = (value: unknown) =>
    string(value, { maxUtf16: 64, pattern: SHA256 });
  return {
    kind: "create",
    subjectKind,
    copyRole,
    clientReceiptId: string(input.clientReceiptId, {
      maxUtf16: 36,
      pattern: UUID,
    }),
    archiveProfileFingerprint: fingerprint(input.archiveProfileFingerprint),
    archiveIdentityFingerprint: fingerprint(input.archiveIdentityFingerprint),
    recipientFingerprint: fingerprint(input.recipientFingerprint),
    repositoryKeyDomainFingerprint: fingerprint(
      input.repositoryKeyDomainFingerprint,
    ),
    storageFailureDomainFingerprint: fingerprint(
      input.storageFailureDomainFingerprint,
    ),
    archiveObjectId: string(input.archiveObjectId, {
      maxUtf16: 36,
      pattern: UUID,
    }),
    ciphertextHash: fingerprint(input.ciphertextHash),
    ciphertextByteLength: integer(
      input.ciphertextByteLength,
      1,
      65 * 1_024 * 1_024,
    ),
    readbackVerifiedAt: epoch(input.readbackVerifiedAt),
    createdAt: epoch(input.createdAt),
  };
}

function parsedTextDeclaration(value: unknown): ParsedTextDeclaration {
  const input = object(value);
  exactKeys(input, [
    "extractionFingerprint",
    "textHash",
    "byteLength",
    "utf16Length",
    "pageCount",
    "mappingManifestHash",
    "normalizedBundleDigest",
    "expectedEvidenceSpanCount",
    "expectedDocumentCount",
    "expectedChunkCount",
  ]);
  const hash = (value: unknown) =>
    string(value, { maxUtf16: 64, pattern: SHA256 });
  return {
    extractionFingerprint: hash(input.extractionFingerprint),
    textHash: hash(input.textHash),
    byteLength: integer(input.byteLength, 1, 1_024 * 1_024),
    utf16Length: integer(input.utf16Length, 1, 1_024 * 1_024),
    pageCount: integer(input.pageCount, 1, 64),
    mappingManifestHash: hash(input.mappingManifestHash),
    normalizedBundleDigest: hash(input.normalizedBundleDigest),
    expectedEvidenceSpanCount: integer(input.expectedEvidenceSpanCount, 1, 256),
    expectedDocumentCount: integer(input.expectedDocumentCount, 1, 16),
    expectedChunkCount: integer(input.expectedChunkCount, 1, 256),
  };
}

function canonicalFsUri(value: unknown): string {
  const uri = string(value, { maxUtf8: 2_048 });
  if (/[\u0000-\u0020\u007f\\?#]/.test(uri) || !uri.startsWith("fs://")) {
    return invalid();
  }
  const separator = uri.indexOf("/", 5);
  if (separator < 0) return invalid();
  const rootAlias = uri.slice(5, separator);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(rootAlias)) return invalid();
  const segments = uri.slice(separator + 1).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0)
  ) {
    return invalid();
  }
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return invalid();
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      encodeURIComponent(decoded) !== segment
    ) {
      return invalid();
    }
  }
  return uri;
}

/** Parse and normalize the complete public v1 command envelope. */
export function parseWorkerRequest(value: unknown): WorkerRequest {
  const input = object(value);
  const baseKeys = [
    "protocolVersion",
    "operation",
    "spaceId",
    "sourceAccountId",
  ];
  const base = common(input);

  switch (input.operation) {
    case "source.status":
      exactKeys(input, baseKeys);
      return { ...base, operation: "source.status" };
    case "diagnostics.status":
      exactKeys(input, baseKeys);
      return { ...base, operation: "diagnostics.status" };
    case "diagnostics.heartbeat":
      exactKeys(input, [...baseKeys, "watcherId", "connectorVersion"]);
      return {
        ...base,
        operation: "diagnostics.heartbeat",
        watcherId: string(input.watcherId, { maxUtf16: 36, pattern: UUID }),
        connectorVersion: string(input.connectorVersion, { maxUtf8: 100 }),
      };
    case "archive.forgetTargets":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "sourceItemId",
        "expectedForgetEpoch",
        "paginationOpts",
      ]);
      return {
        ...base,
        operation: "archive.forgetTargets",
        requestId: requestId(input.requestId),
        sourceItemId: string(input.sourceItemId, { maxUtf16: 256 }),
        expectedForgetEpoch: integer(
          input.expectedForgetEpoch,
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        paginationOpts: (() => {
          const parsed = paginationOptions(input.paginationOpts);
          if (parsed.numItems > MAX_WORKER_ARCHIVE_FORGET_ITEMS) invalid();
          return parsed;
        })(),
      };
    case "archive.ackDeletion":
      exactKeys(
        input,
        [
          ...baseKeys,
          "requestId",
          "sourceItemId",
          "expectedForgetEpoch",
          "deletionId",
          "receiptId",
          "objectOutcome",
        ],
        ["backupOutcome"],
      );
      if (
        input.objectOutcome !== "deleted" &&
        input.objectOutcome !== "already_missing"
      )
        invalid();
      if (
        input.backupOutcome !== undefined &&
        input.backupOutcome !== "deleted" &&
        input.backupOutcome !== "already_missing"
      )
        invalid();
      return {
        ...base,
        operation: "archive.ackDeletion",
        requestId: requestId(input.requestId),
        sourceItemId: string(input.sourceItemId, { maxUtf16: 256 }),
        expectedForgetEpoch: integer(
          input.expectedForgetEpoch,
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        deletionId: string(input.deletionId, {
          maxUtf16: 36,
          pattern: UUID,
        }),
        receiptId: string(input.receiptId, { maxUtf16: 256 }),
        objectOutcome: input.objectOutcome,
        ...(input.backupOutcome === undefined
          ? {}
          : { backupOutcome: input.backupOutcome }),
      };
    case "source.inventoryPage":
      exactKeys(input, [
        ...baseKeys,
        "scanId",
        "requestId",
        "expectedInventoryEpoch",
        "expectedManifestVersion",
        "paginationOpts",
      ]);
      return {
        ...base,
        operation: "source.inventoryPage",
        scanId: scanId(input.scanId),
        requestId: requestId(input.requestId),
        expectedInventoryEpoch: epoch(input.expectedInventoryEpoch),
        expectedManifestVersion: epoch(input.expectedManifestVersion),
        paginationOpts: paginationOptions(input.paginationOpts),
      };
    case "scan.begin": {
      exactKeys(
        input,
        [
          ...baseKeys,
          "requestId",
          "watcherId",
          "connectorVersion",
          "mode",
          "expectedInventoryEpoch",
        ],
        ["hostAffinity"],
      );
      if (input.mode !== "normal" && input.mode !== "identity_recovery") {
        invalid();
      }
      return {
        ...base,
        operation: "scan.begin",
        requestId: requestId(input.requestId),
        watcherId: string(input.watcherId, { maxUtf8: 128 }),
        connectorVersion: string(input.connectorVersion, { maxUtf8: 128 }),
        ...(input.hostAffinity === undefined
          ? {}
          : {
              hostAffinity: optionalString(input.hostAffinity, {
                maxUtf8: 256,
              }),
            }),
        mode: input.mode,
        expectedInventoryEpoch: epoch(input.expectedInventoryEpoch),
      };
    }
    case "scan.appendPage": {
      exactKeys(input, [
        ...baseKeys,
        "scanId",
        "requestId",
        "ordinal",
        "entries",
      ]);
      if (!Array.isArray(input.entries)) invalid();
      // Mode-dependent identity validation is repeated authoritatively after
      // the scan is loaded. Recovery permits a missing external UUID.
      const entries = input.entries.map((entry) =>
        discoveryEntry(entry, "identity_recovery"),
      );
      if (entries.length === 0 || entries.length > MAX_WORKER_PAGE_ITEMS) {
        invalid();
      }
      return {
        ...base,
        operation: "scan.appendPage",
        scanId: scanId(input.scanId),
        requestId: requestId(input.requestId),
        ordinal: integer(input.ordinal, 0, MAX_WORKER_SCAN_PAGES - 1),
        entries,
      };
    }
    case "scan.seal": {
      exactKeys(input, [
        ...baseKeys,
        "scanId",
        "requestId",
        "expectedPageCount",
        "health",
      ]);
      const healthInput = object(input.health);
      let health: Extract<WorkerRequest, { operation: "scan.seal" }>["health"];
      if (healthInput.status === "healthy") {
        exactKeys(healthInput, ["status"]);
        health = { status: "healthy" };
      } else if (healthInput.status === "failed") {
        exactKeys(healthInput, ["status", "code"]);
        health = { status: "failed", code: gapCode(healthInput.code) };
      } else {
        return invalid();
      }
      return {
        ...base,
        operation: "scan.seal",
        scanId: scanId(input.scanId),
        requestId: requestId(input.requestId),
        expectedPageCount: integer(
          input.expectedPageCount,
          0,
          MAX_WORKER_SCAN_PAGES,
        ),
        health,
      };
    }
    case "scan.reconcile":
      exactKeys(input, [
        ...baseKeys,
        "scanId",
        "requestId",
        "expectedInventoryEpoch",
        "ordinal",
        "maxItems",
      ]);
      return {
        ...base,
        operation: "scan.reconcile",
        scanId: scanId(input.scanId),
        requestId: requestId(input.requestId),
        expectedInventoryEpoch: epoch(input.expectedInventoryEpoch),
        ordinal: integer(input.ordinal, 0, Number.MAX_SAFE_INTEGER),
        maxItems: integer(input.maxItems, 1, MAX_WORKER_RECONCILE_ITEMS),
      };
    case "discovery.reserve":
      exactKeys(input, [...baseKeys, "requestId", "maxItems"]);
      return {
        ...base,
        operation: "discovery.reserve",
        requestId: requestId(input.requestId),
        maxItems: integer(input.maxItems, 1, MAX_WORKER_RESERVATION_ITEMS),
      };
    case "discovery.admitUtf8":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "workId",
        "leaseEpoch",
        "leaseToken",
        "text",
      ]);
      return {
        ...base,
        operation: "discovery.admitUtf8",
        requestId: requestId(input.requestId),
        workId: string(input.workId, { maxUtf16: 256 }),
        leaseEpoch: integer(input.leaseEpoch, 1, Number.MAX_SAFE_INTEGER),
        leaseToken: string(input.leaseToken, {
          maxUtf16: 64,
          pattern: SHA256,
        }),
        text: string(input.text, { maxUtf8: 65_536 }),
      };
    case "discovery.preflightArchived":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "identity",
        "archiveIntentDigest",
      ]);
      return {
        ...base,
        operation: "discovery.preflightArchived",
        requestId: requestId(input.requestId),
        identity: archivedWorkIdentity(input.identity),
        archiveIntentDigest: string(input.archiveIntentDigest, {
          maxUtf16: 64,
          pattern: SHA256,
        }),
      };
    case "discovery.reserveArchived":
      exactKeys(input, [...baseKeys, "requestId", "identity"]);
      return {
        ...base,
        operation: "discovery.reserveArchived",
        requestId: requestId(input.requestId),
        identity: archivedWorkIdentity(input.identity),
      };
    case "discovery.lookupArchivedAdmission": {
      exactKeys(input, [...baseKeys, "requestId", "identity", "lookup"]);
      const lookup = object(input.lookup);
      if (lookup.mode === "original") {
        exactKeys(lookup, ["mode"]);
        return {
          ...base,
          operation: "discovery.lookupArchivedAdmission",
          requestId: requestId(input.requestId),
          identity: archivedWorkIdentity(input.identity),
          lookup: { mode: "original" },
        };
      }
      if (lookup.mode !== "processing") return invalid();
      exactKeys(lookup, [
        "mode",
        "clientArtifactId",
        "parserOutputHash",
        "parserOutputByteLength",
        "parserOutputMediaType",
        "parsedText",
      ]);
      if (lookup.parserOutputMediaType !== "application/vnd.docling+json") {
        invalid();
      }
      return {
        ...base,
        operation: "discovery.lookupArchivedAdmission",
        requestId: requestId(input.requestId),
        identity: archivedWorkIdentity(input.identity),
        lookup: {
          mode: "processing",
          clientArtifactId: string(lookup.clientArtifactId, {
            maxUtf16: 36,
            pattern: UUID,
          }),
          parserOutputHash: string(lookup.parserOutputHash, {
            maxUtf16: 64,
            pattern: SHA256,
          }),
          parserOutputByteLength: integer(
            lookup.parserOutputByteLength,
            1,
            64 * 1_024 * 1_024,
          ),
          parserOutputMediaType: "application/vnd.docling+json",
          parsedText: parsedTextDeclaration(lookup.parsedText),
        },
      };
    }
    case "discovery.admitArchived": {
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "workId",
        "leaseEpoch",
        "leaseToken",
        "parserArtifact",
        "archives",
        "parsedText",
      ]);
      if (!Array.isArray(input.archives) || input.archives.length !== 4) {
        invalid();
      }
      const archives = input.archives.map(archiveReceiptSelection);
      const roles = new Set(
        archives.map((entry) => `${entry.subjectKind}:${entry.copyRole}`),
      );
      if (
        roles.size !== 4 ||
        !roles.has("original_bytes:primary") ||
        !roles.has("original_bytes:independent_backup") ||
        !roles.has("parser_output:primary") ||
        !roles.has("parser_output:independent_backup")
      ) {
        invalid();
      }
      return {
        ...base,
        operation: "discovery.admitArchived",
        requestId: requestId(input.requestId),
        workId: string(input.workId, { maxUtf16: 256 }),
        leaseEpoch: integer(input.leaseEpoch, 1, Number.MAX_SAFE_INTEGER),
        leaseToken: string(input.leaseToken, {
          maxUtf16: 64,
          pattern: SHA256,
        }),
        parserArtifact: parserArtifactSelection(input.parserArtifact),
        archives,
        parsedText: parsedTextDeclaration(input.parsedText),
      };
    }
    case "jobs.reserve":
      exactKeys(input, [...baseKeys, "requestId", "maxItems"]);
      return {
        ...base,
        operation: "jobs.reserve",
        requestId: requestId(input.requestId),
        maxItems: integer(input.maxItems, 1, MAX_WORKER_RESERVATION_ITEMS),
      };
    case "jobs.reserveParsed":
      exactKeys(input, [...baseKeys, "requestId", "maxItems"], ["jobId"]);
      if (input.jobId !== undefined && input.maxItems !== 1) invalid();
      return {
        ...base,
        operation: "jobs.reserveParsed",
        requestId: requestId(input.requestId),
        maxItems: integer(input.maxItems, 1, MAX_WORKER_RESERVATION_ITEMS),
        ...(input.jobId === undefined
          ? {}
          : { jobId: string(input.jobId, { maxUtf16: 256 }) }),
      };
    case "jobs.renew":
    case "jobs.stageUtf8":
    case "jobs.activate":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "jobId",
        "leaseEpoch",
        "leaseToken",
      ]);
      return {
        ...base,
        operation: input.operation,
        ...jobLeaseRequest(input),
      };
    case "jobs.fail":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "jobId",
        "leaseEpoch",
        "leaseToken",
        "failureCode",
      ]);
      return {
        ...base,
        operation: "jobs.fail",
        ...jobLeaseRequest(input),
        failureCode: jobFailureCode(input.failureCode),
      };
    case "jobs.renewParsed":
    case "jobs.activateParsed":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "jobId",
        "leaseEpoch",
        "leaseToken",
      ]);
      return { ...base, operation: input.operation, ...jobLeaseRequest(input) };
    case "jobs.failParsed":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "jobId",
        "leaseEpoch",
        "leaseToken",
        "failureCode",
      ]);
      return {
        ...base,
        operation: "jobs.failParsed",
        ...jobLeaseRequest(input),
        failureCode: jobFailureCode(input.failureCode),
      };
    case "jobs.stageParsedBegin": {
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "jobId",
        "leaseEpoch",
        "leaseToken",
        "extractionFingerprint",
        "mappingManifestHash",
        "normalizedBundleDigest",
        "expectedPageCount",
        "expectedEvidenceSpanCount",
        "expectedDocumentCount",
        "expectedChunkCount",
      ]);
      assertParsedRequestSize(input);
      return {
        ...base,
        operation: "jobs.stageParsedBegin",
        ...jobLeaseRequest(input),
        extractionFingerprint: string(input.extractionFingerprint, {
          maxUtf16: 64,
          pattern: SHA256,
        }),
        mappingManifestHash: string(input.mappingManifestHash, {
          maxUtf16: 64,
          pattern: SHA256,
        }),
        normalizedBundleDigest: string(input.normalizedBundleDigest, {
          maxUtf16: 64,
          pattern: SHA256,
        }),
        expectedPageCount: integer(input.expectedPageCount, 1, 64),
        expectedEvidenceSpanCount: integer(
          input.expectedEvidenceSpanCount,
          1,
          256,
        ),
        expectedDocumentCount: integer(input.expectedDocumentCount, 1, 16),
        expectedChunkCount: integer(input.expectedChunkCount, 1, 256),
      };
    }
    case "jobs.stageParsedBatch": {
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "jobId",
        "leaseEpoch",
        "leaseToken",
        "stageId",
        "phase",
        "ordinal",
        "rows",
      ]);
      assertParsedRequestSize(input);
      if (!Array.isArray(input.rows) || input.rows.length < 1) invalid();
      let rows:
        | ParsedPageInput[]
        | ParsedEvidenceInput[]
        | ParsedDocumentInput[]
        | ParsedChunkInput[];
      if (input.phase === "pages") {
        if (input.rows.length > MAX_PARSED_PAGE_BATCH) invalid();
        rows = input.rows.map(parseParsedPageInput);
      } else if (input.phase === "evidence") {
        if (input.rows.length > MAX_PARSED_ROW_BATCH) invalid();
        rows = input.rows.map(parseParsedEvidenceInput);
      } else if (input.phase === "documents") {
        if (input.rows.length > MAX_PARSED_ROW_BATCH) invalid();
        rows = input.rows.map(parseParsedDocumentInput);
      } else if (input.phase === "chunks") {
        if (input.rows.length > MAX_PARSED_ROW_BATCH) invalid();
        rows = input.rows.map(parseParsedChunkInput);
      } else invalid();
      return {
        ...base,
        operation: "jobs.stageParsedBatch",
        ...jobLeaseRequest(input),
        stageId: string(input.stageId, { maxUtf16: 256 }),
        phase: input.phase,
        ordinal: integer(input.ordinal, 0, 256),
        rows,
      };
    }
    case "jobs.stageParsedSeal":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "jobId",
        "leaseEpoch",
        "leaseToken",
        "stageId",
        "normalizedBundleDigest",
      ]);
      assertParsedRequestSize(input);
      return {
        ...base,
        operation: "jobs.stageParsedSeal",
        ...jobLeaseRequest(input),
        stageId: string(input.stageId, { maxUtf16: 256 }),
        normalizedBundleDigest: string(input.normalizedBundleDigest, {
          maxUtf16: 64,
          pattern: SHA256,
        }),
      };
    case "processing.assessBegin":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "scanId",
        "expectedInventoryEpoch",
        "expectedManifestVersion",
      ]);
      return {
        ...base,
        operation: "processing.assessBegin",
        requestId: requestId(input.requestId),
        scanId: scanId(input.scanId),
        expectedInventoryEpoch: epoch(input.expectedInventoryEpoch),
        expectedManifestVersion: epoch(input.expectedManifestVersion),
      };
    case "processing.assessPage":
      exactKeys(input, [
        ...baseKeys,
        "requestId",
        "assessmentId",
        "ordinal",
        "maxItems",
      ]);
      return {
        ...base,
        operation: "processing.assessPage",
        requestId: requestId(input.requestId),
        assessmentId: string(input.assessmentId, { maxUtf16: 256 }),
        ordinal: integer(input.ordinal, 0, Number.MAX_SAFE_INTEGER),
        maxItems: integer(input.maxItems, 1, MAX_WORKER_ASSESSMENT_ITEMS),
      };
    default:
      return invalid();
  }
}
