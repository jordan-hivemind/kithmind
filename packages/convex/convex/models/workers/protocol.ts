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
      };
};

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

export type WorkerResult =
  | WorkerSourceStatusResult
  | WorkerInventoryPageResult
  | WorkerScanBeginResult
  | WorkerScanAppendResult
  | WorkerScanSealResult
  | WorkerScanReconcileResult
  | WorkerDiscoveryReserveResult
  | WorkerDiscoveryAdmitResult
  | WorkerJobReserveResult
  | WorkerJobRenewResult
  | WorkerJobStageResult
  | WorkerJobActivateResult
  | WorkerJobFailResult
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
    case "jobs.reserve":
      exactKeys(input, [...baseKeys, "requestId", "maxItems"]);
      return {
        ...base,
        operation: "jobs.reserve",
        requestId: requestId(input.requestId),
        maxItems: integer(input.maxItems, 1, MAX_WORKER_RESERVATION_ITEMS),
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
