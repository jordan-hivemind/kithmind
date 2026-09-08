import type {
  PipelineConfig,
  WorkerErrorCode,
  WorkerResponse,
  WorkerTransport,
} from "./types.js";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ID_CHARS = 256;
const MAX_URI_BYTES = 2_048;
const MAX_CURSOR_BYTES = 8_192;
const MAX_ERROR_MESSAGE_BYTES = 1_024;
const MAX_INVENTORY_ITEMS = 50;
const MAX_PAGE_ITEMS = 4;
const MAX_URI_ALIASES = 8;
const MAX_FILE_BYTES = 65_536;
const MAX_ARCHIVE_CIPHER_BYTES = 65 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const ERROR_CODES = new Set<WorkerErrorCode>([
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
]);

function failure(message: string): never {
  throw new Error(`Worker transport failed: ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failure("response is not an object");
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    failure("response has an unexpected shape");
  }
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function text(
  value: unknown,
  name: string,
  options: { maxUtf8?: number; maxUtf16?: number; pattern?: RegExp } = {},
): string {
  if (
    typeof value !== "string" ||
    !wellFormed(value) ||
    value.length === 0 ||
    (options.maxUtf16 !== undefined && value.length > options.maxUtf16) ||
    (options.maxUtf8 !== undefined &&
      Buffer.byteLength(value, "utf8") > options.maxUtf8) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    failure(`${name} is invalid`);
  }
  return value;
}

function id(value: unknown, name: string): string {
  return text(value, name, { maxUtf16: MAX_ID_CHARS, pattern: ID });
}

function digest(value: unknown, name: string): string {
  return text(value, name, { maxUtf16: 64, pattern: HEX_64 });
}

function integer(
  value: unknown,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    failure(`${name} is invalid`);
  }
  return value as number;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") failure(`${name} is invalid`);
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  name: string,
  options: readonly T[],
): T {
  const result = text(value, name);
  if (!options.includes(result as T)) failure(`${name} is invalid`);
  return result as T;
}

function optionalId(value: unknown, name: string): void {
  if (value !== undefined) id(value, name);
}

function optionalInteger(value: unknown, name: string): void {
  if (value !== undefined) integer(value, name);
}

function archiveDeletionAck(
  value: unknown,
  options: { operation: boolean; reused: boolean },
): void {
  const row = record(value);
  exact(
    row,
    [
      ...(options.operation ? ["operation"] : []),
      "deletionId",
      "receiptId",
      "forgetEpoch",
      "objectOutcome",
      "absenceAuthority",
      "completedAt",
      ...(options.reused ? ["reused"] : []),
    ],
    ["backupOutcome", "retentionDisclosure"],
  );
  if (options.operation && row.operation !== "archive.ackDeletion")
    failure("archive deletion operation is invalid");
  text(row.deletionId, "deletionId", { maxUtf16: 36, pattern: UUID });
  id(row.receiptId, "receiptId");
  integer(row.forgetEpoch, "forgetEpoch", 1);
  enumValue(row.objectOutcome, "objectOutcome", [
    "deleted",
    "already_missing",
  ] as const);
  if (row.backupOutcome !== undefined) {
    enumValue(row.backupOutcome, "backupOutcome", [
      "deleted",
      "already_missing",
    ] as const);
  }
  enumValue(row.absenceAuthority, "absenceAuthority", [
    "worker_asserted_physical_absence",
    "worker_asserted_live_repository_absence",
  ] as const);
  if (
    row.absenceAuthority === "worker_asserted_live_repository_absence"
      ? row.retentionDisclosure !==
          "provider_retained_deleted_history_possible" ||
        row.backupOutcome === undefined
      : row.retentionDisclosure !== undefined
  )
    failure("archive deletion retention disclosure is invalid");
  integer(row.completedAt, "completedAt");
  if (options.reused) boolean(row.reused, "reused");
}

function archiveForgetTargets(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "sourceItemId",
    "sourceExternalIdHash",
    "forgetEpoch",
    "targets",
    "isDone",
    "continueCursor",
  ]);
  id(value.sourceItemId, "sourceItemId");
  digest(value.sourceExternalIdHash, "sourceExternalIdHash");
  const forgetEpoch = integer(value.forgetEpoch, "forgetEpoch", 1);
  if (!Array.isArray(value.targets) || value.targets.length > MAX_PAGE_ITEMS)
    failure("archive forget target page is invalid");
  const receiptIds = new Set<string>();
  for (const targetValue of value.targets) {
    const target = record(targetValue);
    exact(
      target,
      [
        "receiptId",
        "clientReceiptId",
        "receiptRequestDigest",
        "subjectKind",
        "copyRole",
        "archiveIdentityFingerprint",
        "archiveObjectId",
        "ciphertextHash",
        "ciphertextByteLength",
        "forgetEpoch",
      ],
      ["ack"],
    );
    const receiptId = id(target.receiptId, "receiptId");
    if (receiptIds.has(receiptId)) failure("archive receipt is duplicated");
    receiptIds.add(receiptId);
    text(target.clientReceiptId, "clientReceiptId", {
      maxUtf16: 36,
      pattern: UUID,
    });
    digest(target.receiptRequestDigest, "receiptRequestDigest");
    enumValue(target.subjectKind, "subjectKind", [
      "original_bytes",
      "parser_output",
    ] as const);
    enumValue(target.copyRole, "copyRole", [
      "primary",
      "independent_backup",
    ] as const);
    digest(target.archiveIdentityFingerprint, "archiveIdentityFingerprint");
    text(target.archiveObjectId, "archiveObjectId", {
      maxUtf16: 36,
      pattern: UUID,
    });
    digest(target.ciphertextHash, "ciphertextHash");
    integer(
      target.ciphertextByteLength,
      "ciphertextByteLength",
      1,
      MAX_ARCHIVE_CIPHER_BYTES,
    );
    if (integer(target.forgetEpoch, "target forgetEpoch", 1) !== forgetEpoch)
      failure("archive forget epoch is inconsistent");
    if (target.ack !== undefined) {
      archiveDeletionAck(target.ack, { operation: false, reused: false });
      const ack = target.ack as Record<string, unknown>;
      if (
        ack.receiptId !== receiptId ||
        ack.forgetEpoch !== forgetEpoch ||
        (target.copyRole === "independent_backup") !==
          (ack.backupOutcome !== undefined) ||
        (ack.absenceAuthority === "worker_asserted_live_repository_absence" &&
          (target.copyRole !== "independent_backup" ||
            target.subjectKind !== "parser_output"))
      )
        failure("archive deletion acknowledgement is inconsistent");
    }
  }
  boolean(value.isDone, "isDone");
  text(value.continueCursor, "continueCursor", {
    maxUtf8: MAX_CURSOR_BYTES,
  });
}

function providerDetachAck(
  value: unknown,
  options: { operation: boolean; reused: boolean },
): void {
  const row = record(value);
  exact(row, [
    ...(options.operation ? ["operation"] : []),
    "detachId",
    "referenceId",
    "forgetEpoch",
    "referenceOutcome",
    "locatorBundleOutcome",
    "locatorAbsenceAuthority",
    "retentionDisclosure",
    "providerSourceOutcome",
    "completedAt",
    ...(options.reused ? ["reused"] : []),
  ]);
  if (options.operation && row.operation !== "providerOriginal.ackDetach")
    failure("provider detach operation is invalid");
  text(row.detachId, "detachId", { maxUtf16: 36, pattern: UUID });
  id(row.referenceId, "referenceId");
  integer(row.forgetEpoch, "forgetEpoch", 1);
  enumValue(row.referenceOutcome, "referenceOutcome", [
    "detached",
    "already_detached",
  ] as const);
  enumValue(row.locatorBundleOutcome, "locatorBundleOutcome", [
    "deleted",
    "already_missing",
  ] as const);
  if (
    row.locatorAbsenceAuthority !== "worker_asserted_live_repository_absence" ||
    row.retentionDisclosure !== "provider_retained_deleted_history_possible" ||
    row.providerSourceOutcome !== "retained_unchanged"
  )
    failure("provider detach disclosure is invalid");
  integer(row.completedAt, "completedAt");
  if (options.reused) boolean(row.reused, "reused");
}

function providerForgetTargets(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "sourceItemId",
    "sourceExternalIdHash",
    "forgetEpoch",
    "targets",
    "isDone",
    "continueCursor",
  ]);
  id(value.sourceItemId, "sourceItemId");
  digest(value.sourceExternalIdHash, "sourceExternalIdHash");
  const forgetEpoch = integer(value.forgetEpoch, "forgetEpoch", 1);
  if (!Array.isArray(value.targets) || value.targets.length > MAX_PAGE_ITEMS)
    failure("provider forget target page is invalid");
  const references = new Set<string>();
  for (const item of value.targets) {
    const target = record(item);
    exact(
      target,
      [
        "referenceId",
        "referenceFingerprint",
        "locatorBindingId",
        "locatorRepositoryId",
        "locatorSnapshotId",
        "locatorObjectName",
        "locatorCiphertextHash",
        "locatorCiphertextByteLength",
        "forgetEpoch",
      ],
      ["ack"],
    );
    const referenceId = id(target.referenceId, "referenceId");
    if (references.has(referenceId))
      failure("provider reference is duplicated");
    references.add(referenceId);
    digest(target.referenceFingerprint, "referenceFingerprint");
    text(target.locatorBindingId, "locatorBindingId", {
      maxUtf16: 36,
      pattern: UUID,
    });
    digest(target.locatorRepositoryId, "locatorRepositoryId");
    id(target.locatorSnapshotId, "locatorSnapshotId");
    text(target.locatorObjectName, "locatorObjectName", {
      maxUtf16: 128,
      pattern: /^[A-Za-z0-9._-]{1,128}$/,
    });
    digest(target.locatorCiphertextHash, "locatorCiphertextHash");
    integer(
      target.locatorCiphertextByteLength,
      "locatorCiphertextByteLength",
      1,
      1024 * 1024,
    );
    if (integer(target.forgetEpoch, "target forgetEpoch", 1) !== forgetEpoch)
      failure("provider forget epoch is inconsistent");
    if (target.ack !== undefined) {
      providerDetachAck(target.ack, { operation: false, reused: false });
      const ack = target.ack as Record<string, unknown>;
      if (ack.referenceId !== referenceId || ack.forgetEpoch !== forgetEpoch)
        failure("provider detach acknowledgement is inconsistent");
    }
  }
  boolean(value.isDone, "isDone");
  text(value.continueCursor, "continueCursor", { maxUtf8: MAX_CURSOR_BYTES });
}

function counts(value: unknown): void {
  const root = record(value);
  exact(root, ["items", "unresolvedEntries"]);
  const items = record(root.items);
  exact(items, [
    "ready",
    "pending",
    "failed",
    "needsReview",
    "explicitGap",
    "unavailable",
    "ignoredForgotten",
  ]);
  for (const key of Object.keys(items)) {
    integer(items[key], `counts.items.${key}`);
  }
  const unresolved = record(root.unresolvedEntries);
  exact(unresolved, ["needsReview", "ignoredForgotten"]);
  for (const key of Object.keys(unresolved)) {
    integer(unresolved[key], `counts.unresolvedEntries.${key}`);
  }
}

function status(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "sourceAccountId",
    "inventoryEpoch",
    "completedInventoryEpoch",
    "manifestVersion",
    "enumeration",
    "processing",
    "recordCoverage",
  ]);
  id(value.sourceAccountId, "sourceAccountId");
  integer(value.inventoryEpoch, "inventoryEpoch");
  integer(value.completedInventoryEpoch, "completedInventoryEpoch");
  integer(value.manifestVersion, "manifestVersion");
  if (value.recordCoverage !== "not_established") {
    failure("recordCoverage is invalid");
  }

  const enumeration = record(value.enumeration);
  const enumerationState = enumValue(enumeration.state, "enumeration.state", [
    "never",
    "in_progress",
    "complete",
    "needs_review",
    "failed",
  ] as const);
  if (enumerationState === "never") exact(enumeration, ["state"]);
  else if (enumerationState === "in_progress") {
    exact(enumeration, ["state", "scanId"]);
    id(enumeration.scanId, "enumeration.scanId");
  } else if (enumerationState === "complete") {
    exact(enumeration, ["state", "completedAt"], ["scanId"]);
    integer(enumeration.completedAt, "enumeration.completedAt");
    optionalId(enumeration.scanId, "enumeration.scanId");
  } else if (enumerationState === "needs_review") {
    exact(enumeration, ["state", "scanId"], ["completedAt"]);
    id(enumeration.scanId, "enumeration.scanId");
    optionalInteger(enumeration.completedAt, "enumeration.completedAt");
  } else {
    exact(enumeration, ["state"], ["scanId", "completedAt", "failureCode"]);
    optionalId(enumeration.scanId, "enumeration.scanId");
    optionalInteger(enumeration.completedAt, "enumeration.completedAt");
    if (enumeration.failureCode !== undefined) {
      enumValue(enumeration.failureCode, "failureCode", [
        "empty",
        "enumeration_interrupted",
        "oversized",
        "permission_denied",
        "unreadable",
        "unstable",
        "unsupported",
      ] as const);
    }
  }

  const processing = record(value.processing);
  const processingState = enumValue(processing.state, "processing.state", [
    "not_assessed",
    "assessing",
    "complete",
    "incomplete",
  ] as const);
  if (processingState === "not_assessed") exact(processing, ["state"]);
  else if (processingState === "assessing") {
    exact(processing, ["state", "assessmentId", "startedAt"]);
    id(processing.assessmentId, "processing.assessmentId");
    integer(processing.startedAt, "processing.startedAt");
  } else {
    exact(processing, [
      "state",
      "assessmentId",
      "scanId",
      "inventoryEpoch",
      "manifestVersion",
      "completedAt",
      "counts",
    ]);
    id(processing.assessmentId, "processing.assessmentId");
    id(processing.scanId, "processing.scanId");
    integer(processing.inventoryEpoch, "processing.inventoryEpoch");
    integer(processing.manifestVersion, "processing.manifestVersion");
    integer(processing.completedAt, "processing.completedAt");
    counts(processing.counts);
  }
}

function diagnosticsHeartbeat(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "sourceAccountId",
    "watcherId",
    "receivedAt",
    "nextExpectedAt",
  ]);
  id(value.sourceAccountId, "sourceAccountId");
  text(value.watcherId, "watcherId", { maxUtf16: 36, pattern: UUID });
  integer(value.receivedAt, "receivedAt");
  integer(value.nextExpectedAt, "nextExpectedAt");
}

function diagnosticsStatus(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "diagnosticsVersion",
    "sourceAccountId",
    "source",
    "watcher",
    "incident",
  ]);
  if (value.diagnosticsVersion !== 1 || value.source !== "enabled")
    failure("diagnostics status is invalid");
  id(value.sourceAccountId, "sourceAccountId");
  record(value.watcher);
  record(value.incident);
}

function inventory(value: Record<string, unknown>): void {
  exact(value, ["operation", "page", "isDone", "continueCursor"]);
  if (!Array.isArray(value.page) || value.page.length > MAX_INVENTORY_ITEMS) {
    failure("inventory page is invalid");
  }
  boolean(value.isDone, "isDone");
  text(value.continueCursor, "continueCursor", { maxUtf8: MAX_CURSOR_BYTES });
  for (const raw of value.page) {
    const row = record(raw);
    const lifecycle = enumValue(row.lifecycle, "inventory lifecycle", [
      "available",
      "unavailable",
      "tombstone",
    ] as const);
    if (lifecycle === "tombstone") {
      exact(row, ["lifecycle", "externalIdHash", "uriAliasDigests"]);
      digest(row.externalIdHash, "externalIdHash");
      if (
        !Array.isArray(row.uriAliasDigests) ||
        row.uriAliasDigests.length > MAX_URI_ALIASES
      ) {
        failure("uriAliasDigests is invalid");
      }
      for (const alias of row.uriAliasDigests) digest(alias, "uriAliasDigest");
    } else {
      exact(
        row,
        [
          "lifecycle",
          "sourceItemId",
          "externalId",
          "observationEpoch",
          "processingEpoch",
        ],
        ["uri", "inventoryMetadataDigest"],
      );
      id(row.sourceItemId, "sourceItemId");
      text(row.externalId, "externalId", { maxUtf16: 36, pattern: UUID });
      integer(row.observationEpoch, "observationEpoch");
      integer(row.processingEpoch, "processingEpoch");
      if (row.uri !== undefined)
        text(row.uri, "uri", { maxUtf8: MAX_URI_BYTES });
      if (row.inventoryMetadataDigest !== undefined) {
        digest(row.inventoryMetadataDigest, "inventoryMetadataDigest");
      }
    }
  }
}

function scanBegin(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "scanId",
    "inventoryEpoch",
    "manifestVersion",
    "state",
    "reused",
  ]);
  id(value.scanId, "scanId");
  integer(value.inventoryEpoch, "inventoryEpoch");
  integer(value.manifestVersion, "manifestVersion");
  enumValue(value.state, "scan state", [
    "open",
    "sealed",
    "reconciling",
    "enumerated",
    "needs_review",
    "failed",
  ] as const);
  boolean(value.reused, "reused");
}

function scanAppend(value: Record<string, unknown>): void {
  exact(value, ["operation", "scanId", "ordinal", "reused", "entries"]);
  id(value.scanId, "scanId");
  integer(value.ordinal, "ordinal");
  boolean(value.reused, "reused");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_PAGE_ITEMS) {
    failure("append entries are invalid");
  }
  for (const raw of value.entries) {
    const item = record(raw);
    const state = enumValue(item.state, "append state", [
      "unchanged",
      "queued",
      "gap",
      "ignored_forgotten",
      "needs_review",
    ] as const);
    if (state === "unchanged" || state === "queued" || state === "gap") {
      exact(item, [
        "state",
        "sourceItemId",
        "observationEpoch",
        "processingEpoch",
      ]);
      id(item.sourceItemId, "sourceItemId");
      integer(item.observationEpoch, "observationEpoch");
      integer(item.processingEpoch, "processingEpoch");
    } else {
      exact(item, ["state"], ["sourceItemId"]);
      optionalId(item.sourceItemId, "sourceItemId");
    }
  }
}

function scanSeal(value: Record<string, unknown>): void {
  exact(value, ["operation", "scanId", "state", "reused"]);
  id(value.scanId, "scanId");
  enumValue(value.state, "seal state", [
    "sealed",
    "needs_review",
    "failed",
  ] as const);
  boolean(value.reused, "reused");
}

function reconcile(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "scanId",
    "state",
    "inspected",
    "unavailable",
    "done",
    "reused",
  ]);
  id(value.scanId, "scanId");
  const state = enumValue(value.state, "reconcile state", [
    "reconciling",
    "enumerated",
    "needs_review",
  ] as const);
  const inspected = integer(value.inspected, "inspected", 0, 50);
  const unavailable = integer(value.unavailable, "unavailable", 0, 50);
  const done = boolean(value.done, "done");
  if (unavailable > inspected || done !== (state !== "reconciling")) {
    failure("reconcile result is inconsistent");
  }
  boolean(value.reused, "reused");
}

function reserve(
  value: Record<string, unknown>,
  kind: "discovery" | "jobs",
): void {
  exact(value, ["operation", "receiptId", "expiresAt", "reused", "targets"]);
  id(value.receiptId, "receiptId");
  integer(value.expiresAt, "expiresAt", 1);
  boolean(value.reused, "reused");
  if (!Array.isArray(value.targets) || value.targets.length > MAX_PAGE_ITEMS) {
    failure("reserve targets are invalid");
  }
  for (const raw of value.targets) {
    const item = record(raw);
    if (kind === "discovery") {
      exact(item, [
        "workId",
        "sourceItemId",
        "observationEpoch",
        "processingEpoch",
        "leaseEpoch",
        "leaseToken",
        "leaseExpiresAt",
        "uri",
        "contentHash",
        "byteLength",
      ]);
      text(item.uri, "uri", { maxUtf8: MAX_URI_BYTES });
      digest(item.contentHash, "contentHash");
      integer(item.byteLength, "byteLength", 1, MAX_FILE_BYTES);
    } else {
      exact(item, [
        "jobId",
        "workId",
        "sourceItemId",
        "observationEpoch",
        "processingEpoch",
        "state",
        "leaseEpoch",
        "leaseToken",
        "leaseExpiresAt",
      ]);
      id(item.jobId, "jobId");
      enumValue(item.state, "job state", ["processing", "staged"] as const);
    }
    id(item.workId, "workId");
    id(item.sourceItemId, "sourceItemId");
    text(item.leaseToken, "leaseToken", { maxUtf16: 64, pattern: HEX_64 });
    integer(item.observationEpoch, "observationEpoch");
    integer(item.processingEpoch, "processingEpoch");
    integer(item.leaseEpoch, "leaseEpoch", 1);
    integer(item.leaseExpiresAt, "leaseExpiresAt", 1);
  }
}

function job(value: Record<string, unknown>, operation: string): void {
  const fields = ["operation", "jobId", "state", "reused"];
  if (operation === "jobs.renew") {
    exact(value, [...fields, "leaseExpiresAt"]);
    enumValue(value.state, "job state", ["processing", "staged"] as const);
    integer(value.leaseExpiresAt, "leaseExpiresAt", 1);
  } else if (operation === "jobs.stageUtf8") {
    exact(value, [
      ...fields,
      "actualPageCount",
      "actualEvidenceSpanCount",
      "actualDocumentCount",
      "actualChunkCount",
    ]);
    if (value.state !== "staged") failure("job state is invalid");
    for (const field of [
      "actualPageCount",
      "actualEvidenceSpanCount",
      "actualDocumentCount",
      "actualChunkCount",
    ]) {
      integer(value[field], field, 0, 256);
    }
  } else if (operation === "jobs.activate") {
    exact(value, [...fields, "activatedAt"], ["previousGenerationId"]);
    if (value.state !== "ready") failure("job state is invalid");
    integer(value.activatedAt, "activatedAt");
    optionalId(value.previousGenerationId, "previousGenerationId");
  } else {
    exact(value, [...fields, "retryable", "failureCode"], ["nextAttemptAt"]);
    const state = enumValue(value.state, "job state", [
      "failed",
      "needs_review",
      "obsolete_generation",
    ] as const);
    const retryable = boolean(value.retryable, "retryable");
    enumValue(value.failureCode, "failureCode", [
      "worker_interrupted",
      "worker_resource_exhausted",
      "source_bytes_invalid",
      "staging_invalid",
    ] as const);
    optionalInteger(value.nextAttemptAt, "nextAttemptAt");
    if (
      (state === "failed" &&
        (!retryable || value.nextAttemptAt === undefined)) ||
      (state !== "failed" && (retryable || value.nextAttemptAt !== undefined))
    ) {
      failure("job failure result is inconsistent");
    }
  }
  id(value.jobId, "jobId");
  boolean(value.reused, "reused");
}

function archivedPreflight(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "sourceItemId",
    "workId",
    "expectedDesiredProcessingEpoch",
    "archiveIntentDigest",
  ]);
  id(value.sourceItemId, "sourceItemId");
  id(value.workId, "workId");
  integer(
    value.expectedDesiredProcessingEpoch,
    "expectedDesiredProcessingEpoch",
  );
  digest(value.archiveIntentDigest, "archiveIntentDigest");
}

function archivedReserve(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "workId",
    "sourceItemId",
    "observationEpoch",
    "processingEpoch",
    "leaseEpoch",
    "leaseToken",
    "leaseExpiresAt",
    "reused",
  ]);
  id(value.workId, "workId");
  id(value.sourceItemId, "sourceItemId");
  integer(value.observationEpoch, "observationEpoch");
  integer(value.processingEpoch, "processingEpoch");
  integer(value.leaseEpoch, "leaseEpoch", 1);
  text(value.leaseToken, "leaseToken", { maxUtf16: 64, pattern: HEX_64 });
  integer(value.leaseExpiresAt, "leaseExpiresAt", 1);
  boolean(value.reused, "reused");
}

function archivedLookup(value: Record<string, unknown>): void {
  const mode = enumValue(value.mode, "lookup mode", [
    "original",
    "processing",
  ] as const);
  if (value.found === false) {
    exact(value, ["operation", "mode", "found"]);
    return;
  }
  if (value.found !== true) failure("lookup found is invalid");
  if (mode === "original") {
    const provider =
      "originalProviderReferenceId" in value ||
      "originalProviderBindingEpoch" in value;
    exact(value, [
      "operation",
      "mode",
      "found",
      "sourceRevisionId",
      "originalPrimaryReceiptId",
      "originalPrimaryBindingEpoch",
      ...(provider
        ? ["originalProviderReferenceId", "originalProviderBindingEpoch"]
        : ["originalBackupReceiptId", "originalBackupBindingEpoch"]),
    ]);
    id(value.sourceRevisionId, "sourceRevisionId");
    id(value.originalPrimaryReceiptId, "originalPrimaryReceiptId");
    integer(
      value.originalPrimaryBindingEpoch,
      "originalPrimaryBindingEpoch",
      0,
    );
    if (provider) {
      id(value.originalProviderReferenceId, "originalProviderReferenceId");
      integer(
        value.originalProviderBindingEpoch,
        "originalProviderBindingEpoch",
        0,
      );
    } else {
      id(value.originalBackupReceiptId, "originalBackupReceiptId");
      integer(
        value.originalBackupBindingEpoch,
        "originalBackupBindingEpoch",
        0,
      );
    }
    return;
  }
  const provider =
    "originalProviderReferenceId" in value ||
    "originalProviderBindingEpoch" in value;
  exact(value, [
    "operation",
    "mode",
    "found",
    "sourceRevisionId",
    "parserArtifactId",
    "sourceTextVersionId",
    "processingGenerationId",
    "ingestJobId",
    "desiredProcessingEpoch",
    "archiveSetDigest",
    "originalPrimaryReceiptId",
    "originalPrimaryBindingEpoch",
    ...(provider
      ? ["originalProviderReferenceId", "originalProviderBindingEpoch"]
      : ["originalBackupReceiptId", "originalBackupBindingEpoch"]),
    "parserPrimaryReceiptId",
    "parserPrimaryBindingEpoch",
    "parserBackupReceiptId",
    "parserBackupBindingEpoch",
  ]);
  for (const field of [
    "sourceRevisionId",
    "parserArtifactId",
    "sourceTextVersionId",
    "processingGenerationId",
    "ingestJobId",
    "originalPrimaryReceiptId",
    ...(provider
      ? ["originalProviderReferenceId"]
      : ["originalBackupReceiptId"]),
    "parserPrimaryReceiptId",
    "parserBackupReceiptId",
  ]) {
    id(value[field], field);
  }
  integer(value.desiredProcessingEpoch, "desiredProcessingEpoch");
  digest(value.archiveSetDigest, "archiveSetDigest");
  for (const field of [
    "originalPrimaryBindingEpoch",
    ...(provider
      ? ["originalProviderBindingEpoch"]
      : ["originalBackupBindingEpoch"]),
    "parserPrimaryBindingEpoch",
    "parserBackupBindingEpoch",
  ]) {
    integer(value[field], field, 0);
  }
}

function archivedAdmit(value: Record<string, unknown>): void {
  const provider =
    "originalProviderReferenceId" in value ||
    "originalProviderBindingEpoch" in value;
  exact(value, [
    "operation",
    "workId",
    "sourceItemId",
    "sourceRevisionId",
    "parserArtifactId",
    "sourceTextVersionId",
    "processingGenerationId",
    "ingestJobId",
    "desiredProcessingEpoch",
    "archiveSetDigest",
    "originalPrimaryReceiptId",
    "originalPrimaryBindingEpoch",
    ...(provider
      ? ["originalProviderReferenceId", "originalProviderBindingEpoch"]
      : ["originalBackupReceiptId", "originalBackupBindingEpoch"]),
    "parserPrimaryReceiptId",
    "parserPrimaryBindingEpoch",
    "parserBackupReceiptId",
    "parserBackupBindingEpoch",
    "state",
    "reused",
  ]);
  for (const field of [
    "workId",
    "sourceItemId",
    "sourceRevisionId",
    "parserArtifactId",
    "sourceTextVersionId",
    "processingGenerationId",
    "ingestJobId",
    "originalPrimaryReceiptId",
    ...(provider
      ? ["originalProviderReferenceId"]
      : ["originalBackupReceiptId"]),
    "parserPrimaryReceiptId",
    "parserBackupReceiptId",
  ]) {
    id(value[field], field);
  }
  integer(value.desiredProcessingEpoch, "desiredProcessingEpoch");
  digest(value.archiveSetDigest, "archiveSetDigest");
  for (const field of [
    "originalPrimaryBindingEpoch",
    ...(provider
      ? ["originalProviderBindingEpoch"]
      : ["originalBackupBindingEpoch"]),
    "parserPrimaryBindingEpoch",
    "parserBackupBindingEpoch",
  ]) {
    integer(value[field], field, 0);
  }
  if (value.state !== "admitted") failure("archived admit state is invalid");
  boolean(value.reused, "reused");
}

const PARSED_STAGE_PHASES = [
  "pages",
  "evidence",
  "documents",
  "chunks",
  "seal",
  "staged",
] as const;
const PARSED_BATCH_PHASES = [
  "pages",
  "evidence",
  "documents",
  "chunks",
] as const;

function parsedPhaseLimit(phase: string): number {
  switch (phase) {
    case "pages":
      return 32;
    case "evidence":
      return 128;
    case "documents":
      return 16;
    case "chunks":
      return 128;
    case "seal":
    case "staged":
      return 0;
    default:
      failure("parsed stage phase is invalid");
  }
}

function parsedNextPhase(phase: string): string {
  switch (phase) {
    case "pages":
      return "evidence";
    case "evidence":
      return "documents";
    case "documents":
      return "chunks";
    case "chunks":
      return "seal";
    default:
      failure("parsed batch phase is invalid");
  }
}

function parsedJobRenew(value: Record<string, unknown>): void {
  exact(value, ["operation", "jobId", "state", "leaseExpiresAt", "reused"]);
  id(value.jobId, "jobId");
  enumValue(value.state, "parsed job state", ["processing", "staged"] as const);
  integer(value.leaseExpiresAt, "leaseExpiresAt", 1);
  boolean(value.reused, "reused");
}

function parsedJobFail(value: Record<string, unknown>): void {
  exact(
    value,
    ["operation", "jobId", "state", "retryable", "failureCode", "reused"],
    ["nextAttemptAt"],
  );
  id(value.jobId, "jobId");
  const state = enumValue(value.state, "parsed failure state", [
    "failed",
    "needs_review",
    "obsolete_generation",
  ] as const);
  const retryable = boolean(value.retryable, "retryable");
  enumValue(value.failureCode, "failureCode", [
    "worker_interrupted",
    "worker_resource_exhausted",
    "source_bytes_invalid",
    "staging_invalid",
  ] as const);
  optionalInteger(value.nextAttemptAt, "nextAttemptAt");
  if (
    (state === "failed" && (!retryable || value.nextAttemptAt === undefined)) ||
    (state !== "failed" && (retryable || value.nextAttemptAt !== undefined))
  ) {
    failure("parsed job failure result is inconsistent");
  }
  boolean(value.reused, "reused");
}

function parsedStageBegin(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "jobId",
    "stageId",
    "phase",
    "nextOrdinal",
    "reused",
  ]);
  id(value.jobId, "jobId");
  id(value.stageId, "stageId");
  const phase = enumValue(
    value.phase,
    "parsed stage phase",
    PARSED_STAGE_PHASES,
  );
  integer(value.nextOrdinal, "nextOrdinal", 0, parsedPhaseLimit(phase));
  boolean(value.reused, "reused");
}

function parsedStageBatch(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "jobId",
    "stageId",
    "committedPhase",
    "phase",
    "nextOrdinal",
    "acceptedCount",
    "reused",
  ]);
  id(value.jobId, "jobId");
  id(value.stageId, "stageId");
  const committed = enumValue(
    value.committedPhase,
    "parsed committed phase",
    PARSED_BATCH_PHASES,
  );
  const phase = enumValue(value.phase, "parsed stage phase", [
    "pages",
    "evidence",
    "documents",
    "chunks",
    "seal",
  ] as const);
  const advanced = phase === parsedNextPhase(committed);
  if (phase !== committed && !advanced) {
    failure("parsed stage phase does not follow committed phase");
  }
  const nextOrdinal = integer(
    value.nextOrdinal,
    "nextOrdinal",
    0,
    parsedPhaseLimit(phase),
  );
  if ((advanced && nextOrdinal !== 0) || (!advanced && nextOrdinal < 1)) {
    failure("parsed stage ordinal is inconsistent");
  }
  integer(
    value.acceptedCount,
    "acceptedCount",
    1,
    committed === "pages" ? 8 : 25,
  );
  boolean(value.reused, "reused");
}

function parsedStageSeal(value: Record<string, unknown>): void {
  exact(value, [
    "operation",
    "jobId",
    "stageId",
    "payloadManifestId",
    "state",
    "actualPageCount",
    "actualEvidenceSpanCount",
    "actualDocumentCount",
    "actualChunkCount",
    "reused",
  ]);
  id(value.jobId, "jobId");
  id(value.stageId, "stageId");
  id(value.payloadManifestId, "payloadManifestId");
  if (value.state !== "staged") failure("parsed stage seal state is invalid");
  integer(value.actualPageCount, "actualPageCount", 1, 64);
  integer(value.actualEvidenceSpanCount, "actualEvidenceSpanCount", 1, 256);
  integer(value.actualDocumentCount, "actualDocumentCount", 1, 16);
  integer(value.actualChunkCount, "actualChunkCount", 1, 256);
  boolean(value.reused, "reused");
}

function parsedActivate(value: Record<string, unknown>): void {
  exact(
    value,
    ["operation", "jobId", "state", "activatedAt", "reused"],
    ["previousGenerationId"],
  );
  id(value.jobId, "jobId");
  if (value.state !== "ready") failure("parsed activate state is invalid");
  integer(value.activatedAt, "activatedAt");
  optionalId(value.previousGenerationId, "previousGenerationId");
  boolean(value.reused, "reused");
}

function assessment(value: Record<string, unknown>, page: boolean): void {
  const required = page
    ? [
        "operation",
        "assessmentId",
        "state",
        "phase",
        "ordinal",
        "inspected",
        "nextOrdinal",
        "reused",
      ]
    : [
        "operation",
        "assessmentId",
        "scanId",
        "inventoryEpoch",
        "manifestVersion",
        "state",
        "nextOrdinal",
        "reused",
      ];
  exact(value, required, ["counts", "completedAt", "staleReason"]);
  id(value.assessmentId, "assessmentId");
  const state = enumValue(value.state, "assessment state", [
    "running",
    "complete",
    "incomplete",
    "stale",
  ] as const);
  integer(value.nextOrdinal, "nextOrdinal");
  boolean(value.reused, "reused");
  let phase: "items" | "unresolved_entries" | "done" | undefined;
  let inspected: number | undefined;
  if (page) {
    phase = enumValue(value.phase, "assessment phase", [
      "items",
      "unresolved_entries",
      "done",
    ] as const);
    integer(value.ordinal, "ordinal");
    inspected = integer(value.inspected, "inspected", 0, 1);
  } else {
    id(value.scanId, "scanId");
    integer(value.inventoryEpoch, "inventoryEpoch");
    integer(value.manifestVersion, "manifestVersion");
  }
  if (state === "complete" || state === "incomplete") {
    if (
      !("counts" in value) ||
      !("completedAt" in value) ||
      "staleReason" in value ||
      (page && phase !== "done")
    ) {
      failure("terminal assessment is inconsistent");
    }
    counts(value.counts);
    integer(value.completedAt, "completedAt");
  } else if (state === "stale") {
    if (
      "counts" in value ||
      "completedAt" in value ||
      (page && (phase !== "done" || inspected !== 0))
    ) {
      failure("stale assessment is inconsistent");
    }
    enumValue(value.staleReason, "staleReason", [
      "source_changed",
      "detail_unavailable",
      "expired",
    ] as const);
  } else if (
    "counts" in value ||
    "completedAt" in value ||
    "staleReason" in value ||
    (page && phase === "done")
  ) {
    failure("running assessment is inconsistent");
  }
}

export function parseWorkerResponse(
  value: string,
  expectedOperation: string,
): WorkerResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    failure("response is not JSON");
  }
  const result = record(parsed);
  if ("error" in result) {
    exact(result, ["error"]);
    const error = record(result.error);
    exact(error, ["code", "message"]);
    const code = text(error.code, "error code") as WorkerErrorCode;
    if (!ERROR_CODES.has(code)) failure("error code is invalid");
    text(error.message, "error message", { maxUtf8: MAX_ERROR_MESSAGE_BYTES });
    return { error: { code } };
  }
  if (result.operation !== expectedOperation) {
    failure("response operation does not match request");
  }
  switch (expectedOperation) {
    case "source.status":
      status(result);
      break;
    case "diagnostics.heartbeat":
      diagnosticsHeartbeat(result);
      break;
    case "diagnostics.status":
      diagnosticsStatus(result);
      break;
    case "archive.forgetTargets":
      archiveForgetTargets(result);
      break;
    case "archive.ackDeletion":
      archiveDeletionAck(result, { operation: true, reused: true });
      break;
    case "providerOriginal.forgetTargets":
      providerForgetTargets(result);
      break;
    case "providerOriginal.ackDetach":
      providerDetachAck(result, { operation: true, reused: true });
      break;
    case "source.inventoryPage":
      inventory(result);
      break;
    case "scan.begin":
      scanBegin(result);
      break;
    case "scan.appendPage":
      scanAppend(result);
      break;
    case "scan.seal":
      scanSeal(result);
      break;
    case "scan.reconcile":
      reconcile(result);
      break;
    case "discovery.reserve":
      reserve(result, "discovery");
      break;
    case "jobs.reserve":
      reserve(result, "jobs");
      break;
    case "discovery.admitUtf8":
      exact(result, [
        "operation",
        "workId",
        "sourceItemId",
        "sourceRevisionId",
        "processingGenerationId",
        "ingestJobId",
        "desiredProcessingEpoch",
        "state",
        "reused",
      ]);
      id(result.workId, "workId");
      id(result.sourceItemId, "sourceItemId");
      id(result.sourceRevisionId, "sourceRevisionId");
      id(result.processingGenerationId, "processingGenerationId");
      id(result.ingestJobId, "ingestJobId");
      integer(result.desiredProcessingEpoch, "desiredProcessingEpoch");
      if (result.state !== "admitted") failure("admit state is invalid");
      boolean(result.reused, "reused");
      break;
    case "discovery.preflightArchived":
      archivedPreflight(result);
      break;
    case "discovery.reserveArchived":
      archivedReserve(result);
      break;
    case "discovery.lookupArchivedAdmission":
      archivedLookup(result);
      break;
    case "discovery.admitArchived":
      archivedAdmit(result);
      break;
    case "jobs.reserveParsed":
      reserve(result, "jobs");
      break;
    case "jobs.renewParsed":
      parsedJobRenew(result);
      break;
    case "jobs.failParsed":
      parsedJobFail(result);
      break;
    case "jobs.stageParsedBegin":
      parsedStageBegin(result);
      break;
    case "jobs.stageParsedBatch":
      parsedStageBatch(result);
      break;
    case "jobs.stageParsedSeal":
      parsedStageSeal(result);
      break;
    case "jobs.activateParsed":
      parsedActivate(result);
      break;
    case "jobs.renew":
    case "jobs.stageUtf8":
    case "jobs.activate":
    case "jobs.fail":
      job(result, expectedOperation);
      break;
    case "processing.assessBegin":
      assessment(result, false);
      break;
    case "processing.assessPage":
      assessment(result, true);
      break;
    default:
      failure("unknown operation");
  }
  return result;
}

async function readBounded(
  response: Response,
  abort: () => void,
): Promise<string> {
  if (!response.body) failure("response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        abort();
        await reader.cancel().catch(() => undefined);
        failure("response exceeded byte limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    failure("response is not UTF-8");
  }
}

export class HttpWorkerTransport implements WorkerTransport {
  constructor(
    private readonly config: PipelineConfig,
    private readonly credential: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async call(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResponse> {
    const operation = request.operation;
    if (typeof operation !== "string") failure("request operation is missing");
    const controller = new AbortController();
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30_000
    ) {
      failure("request timeout is invalid");
    }
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.timeoutMs);
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.credential}`,
        },
        body: JSON.stringify(request),
      });
      const mediaType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== "application/json")
        failure("response content type is invalid");
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
          controller.abort();
          failure("response content length is invalid");
        }
        const length = Number(declaredLength);
        if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) {
          controller.abort();
          failure("response exceeded byte limit");
        }
      }
      const body = await readBounded(response, () => controller.abort());
      const parsed = parseWorkerResponse(body, operation);
      if (!response.ok && !("error" in parsed)) {
        failure("non-success response omitted a safe error");
      }
      return parsed;
    } catch {
      failure("request could not be completed");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    throw new Error("unreachable");
  }
}
