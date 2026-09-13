import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { getConvexSize } from "convex/values";
import { isBinaryClass } from "@repo/worker-protocol";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";
import type { PrincipalRef } from "../../lib/spaces";
import { digestProcessingConfiguration } from "../ingestion/hash";
import { planInlineText } from "../ingestion/inlineText";
import { sha256Utf8 } from "../provenance/model";
import {
  MAX_PARSER_ARTIFACT_BYTES,
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
  requireInlineSourceRevision,
} from "../provenance/representations";
import { verifySealedParsedPayload } from "../provenance/parsedStaging";
import { artifactBoundExtractionFingerprint } from "./archivedDiscovery";
import { requireWorkerSourceAccount, type WorkerPrincipal } from "./auth";
import { workerProtocolError } from "./errors";
import { consumeWorkerMutationRateLimit } from "./rateLimit";
import { FS_TEXT_PROFILE } from "./profile";
import type {
  ProcessingAssessmentCounts,
  WorkerAssessmentBeginResult,
  WorkerAssessmentPageResult,
  WorkerProcessingStatus,
  WorkerRequest,
} from "./protocol";

export const WORKER_ASSESSMENT_IDLE_MS = 30 * 60 * 1_000;
export const WORKER_ASSESSMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
// One extra index row lets Convex prove page completion while the response is
// still hard-checked to one returned document.
const ASSESSMENT_PAGE_MAXIMUM_ROWS_READ = 2;
const ASSESSMENT_PAGE_MAXIMUM_BYTES_READ = 2 * 1024 * 1024;
const ASSESSMENT_MINIMUM_CHAIN_BYTES_REMAINING = 8 * 1024 * 1024;
const ASSESSMENT_MINIMUM_CHAIN_DOCUMENTS_REMAINING = 12;
const ASSESSMENT_MINIMUM_STAGE_BYTES_REMAINING = 2 * 1024 * 1024;
const ASSESSMENT_MINIMUM_STAGE_DOCUMENTS_REMAINING = 6;
const ASSESSMENT_MINIMUM_COMMIT_BYTES_REMAINING = 512 * 1024;
const ASSESSMENT_MAX_DETAIL_ROW_BYTES = 128 * 1024;

type LoadedWorkerSource = Awaited<
  ReturnType<typeof requireWorkerSourceAccount>
>;
type Assessment = Doc<"workerProcessingAssessments">;
type AssessmentState = Assessment["state"];
type StaleReason = NonNullable<Assessment["staleReason"]>;
type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

export function generationOriginalRecoverySelectionIsClosed(value: {
  originalBackupReceiptId?: unknown;
  originalProviderReferenceId?: unknown;
  originalProviderBindingEpoch?: unknown;
}): boolean {
  return (
    (value.originalBackupReceiptId !== undefined &&
      value.originalProviderReferenceId === undefined &&
      value.originalProviderBindingEpoch === undefined) ||
    (value.originalBackupReceiptId === undefined &&
      typeof value.originalProviderReferenceId === "string" &&
      safeInteger(value.originalProviderBindingEpoch))
  );
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function historicalArchiveReceiptIsValid(
  receipt: Doc<"sourceArtifactArchiveReceipts">,
  expected: {
    revision: Doc<"sourceRevisions">;
    artifact: Doc<"sourceParserArtifacts">;
    subjectKind: "original_bytes" | "parser_output";
    copyRole: "primary" | "independent_backup";
  },
): boolean {
  const { revision, artifact, subjectKind, copyRole } = expected;
  const plaintext =
    subjectKind === "original_bytes"
      ? {
          hash: revision.contentHash,
          byteLength: revision.byteLength,
          mediaType: revision.mediaType,
        }
      : {
          hash: artifact.outputHash,
          byteLength: artifact.outputByteLength,
          mediaType: artifact.outputMediaType,
        };
  return (
    receipt.spaceId === revision.spaceId &&
    receipt.sourceItemId === revision.sourceItemId &&
    receipt.sourceRevisionId === revision._id &&
    receipt.subjectKind === subjectKind &&
    receipt.copyRole === copyRole &&
    receipt.parserArtifactId ===
      (subjectKind === "parser_output" ? artifact._id : undefined) &&
    receipt.receiptVersion === "archive_receipt_v1" &&
    receipt.archiveRepresentation === "age_encrypted_v1" &&
    receipt.hashAuthority === "worker_asserted" &&
    receipt.verificationKind === "ciphertext_readback_sha256" &&
    UUID_PATTERN.test(receipt.clientReceiptId) &&
    UUID_PATTERN.test(receipt.archiveObjectId) &&
    [
      receipt.requestDigest,
      receipt.archiveProfileFingerprint,
      receipt.archiveIdentityFingerprint,
      receipt.recipientFingerprint,
      receipt.repositoryKeyDomainFingerprint,
      receipt.storageFailureDomainFingerprint,
      receipt.plaintextHash,
      receipt.ciphertextHash,
    ].every((value) => SHA256_PATTERN.test(value)) &&
    receipt.plaintextHash === plaintext.hash &&
    receipt.plaintextByteLength === plaintext.byteLength &&
    receipt.plaintextMediaType === plaintext.mediaType &&
    safeInteger(receipt.ciphertextByteLength, 1) &&
    receipt.ciphertextByteLength <= MAX_PARSER_ARTIFACT_BYTES + 1024 * 1024 &&
    safeInteger(receipt.createdAt) &&
    safeInteger(receipt.readbackVerifiedAt, receipt.createdAt)
  );
}

function sourceNumber(value: number | undefined): number {
  return value ?? 0;
}

function sourceFenceIsValid(source: Doc<"sourceAccounts">): boolean {
  return [
    sourceNumber(source.inventoryEpoch),
    sourceNumber(source.completedInventoryEpoch),
    sourceNumber(source.manifestVersion),
    sourceNumber(source.workerAssessmentEpoch),
    sourceNumber(source.coverageInvalidatedAt),
    sourceNumber(source.lastEnumeratedAt),
    sourceNumber(source.lastProcessedAt),
  ].every((value) => safeInteger(value));
}

function safeAdd(value: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + increment);
}

function detailRowsAreBounded(...rows: unknown[]): boolean {
  try {
    return rows.every(
      (row) =>
        row === null ||
        row === undefined ||
        getConvexSize(row as never) <= ASSESSMENT_MAX_DETAIL_ROW_BYTES,
    );
  } catch {
    return false;
  }
}

async function requireReadHeadroom(
  ctx: MutationCtx,
  bytes = ASSESSMENT_MINIMUM_STAGE_BYTES_REMAINING,
  documents = ASSESSMENT_MINIMUM_STAGE_DOCUMENTS_REMAINING,
): Promise<void> {
  const metrics = await ctx.meta.getTransactionMetrics();
  if (
    !safeInteger(metrics.bytesRead.remaining) ||
    !safeInteger(metrics.documentsRead.remaining) ||
    metrics.bytesRead.remaining < bytes ||
    metrics.documentsRead.remaining < documents
  )
    throw new Error("insufficient_read_headroom");
}

async function requireCommitHeadroom(ctx: MutationCtx): Promise<void> {
  const metrics = await ctx.meta.getTransactionMetrics();
  if (
    !safeInteger(metrics.bytesWritten.remaining) ||
    !safeInteger(metrics.documentsWritten.remaining) ||
    metrics.bytesWritten.remaining <
      ASSESSMENT_MINIMUM_COMMIT_BYTES_REMAINING ||
    metrics.documentsWritten.remaining < 3
  )
    throw new Error("insufficient_write_headroom");
}

function emptyCounts(): ProcessingAssessmentCounts {
  return {
    items: {
      ready: 0,
      pending: 0,
      failed: 0,
      needsReview: 0,
      explicitGap: 0,
      unavailable: 0,
      ignoredForgotten: 0,
    },
    unresolvedEntries: { needsReview: 0, ignoredForgotten: 0 },
  };
}

function countsAreValid(counts: ProcessingAssessmentCounts): boolean {
  return [
    counts.items.ready,
    counts.items.pending,
    counts.items.failed,
    counts.items.needsReview,
    counts.items.explicitGap,
    counts.items.unavailable,
    counts.items.ignoredForgotten,
    counts.unresolvedEntries.needsReview,
    counts.unresolvedEntries.ignoredForgotten,
  ].every((value) => safeInteger(value));
}

function countsEqual(
  left: ProcessingAssessmentCounts,
  right: ProcessingAssessmentCounts,
): boolean {
  return (
    left.items.ready === right.items.ready &&
    left.items.pending === right.items.pending &&
    left.items.failed === right.items.failed &&
    left.items.needsReview === right.items.needsReview &&
    left.items.explicitGap === right.items.explicitGap &&
    left.items.unavailable === right.items.unavailable &&
    left.items.ignoredForgotten === right.items.ignoredForgotten &&
    left.unresolvedEntries.needsReview ===
      right.unresolvedEntries.needsReview &&
    left.unresolvedEntries.ignoredForgotten ===
      right.unresolvedEntries.ignoredForgotten
  );
}

function lastPageResultIsCurrent(assessment: Assessment): boolean {
  try {
    const result = assessment.lastPageResult;
    if (
      !assessment.lastPageRequestId ||
      !assessment.lastPageRequestDigest ||
      !assessment.lastPageInputPhase ||
      assessment.lastPageOrdinal === undefined ||
      !result ||
      !safeInteger(assessment.lastPageOrdinal) ||
      result.ordinal !== assessment.lastPageOrdinal ||
      result.nextOrdinal !== assessment.nextOrdinal ||
      result.state !== assessment.state ||
      result.phase !== assessment.phase ||
      !safeInteger(result.inspected) ||
      result.inspected > 1
    )
      return false;
    if (assessment.state === "running") {
      return (
        result.counts === undefined &&
        result.completedAt === undefined &&
        result.staleReason === undefined
      );
    }
    if (assessment.state === "complete" || assessment.state === "incomplete") {
      return (
        assessment.phase === "done" &&
        assessment.completedAt !== undefined &&
        result.completedAt === assessment.completedAt &&
        result.counts !== undefined &&
        countsEqual(result.counts, assessment.counts) &&
        result.staleReason === undefined
      );
    }
    return false;
  } catch {
    return false;
  }
}

function incrementCount(
  counts: ProcessingAssessmentCounts,
  bucket:
    | keyof ProcessingAssessmentCounts["items"]
    | "unresolvedNeedsReview"
    | "unresolvedIgnoredForgotten",
): ProcessingAssessmentCounts {
  const next = structuredClone(counts);
  if (bucket === "unresolvedNeedsReview") {
    next.unresolvedEntries.needsReview += 1;
  } else if (bucket === "unresolvedIgnoredForgotten") {
    next.unresolvedEntries.ignoredForgotten += 1;
  } else {
    next.items[bucket] += 1;
  }
  return next;
}

/** Total predicate used by status and cleanup. Malformed rows never pin detail. */
export function isAssessmentSnapshotCurrent(
  source: Doc<"sourceAccounts">,
  assessment: Doc<"workerProcessingAssessments">,
): boolean {
  try {
    return Boolean(
      (assessment.state === "complete" || assessment.state === "incomplete") &&
      assessment.phase === "done" &&
      assessment.spaceId === source.spaceId &&
      assessment.sourceAccountId === source._id &&
      assessment.inventoryEpoch === sourceNumber(source.inventoryEpoch) &&
      assessment.completedInventoryEpoch ===
        sourceNumber(source.completedInventoryEpoch) &&
      assessment.manifestVersion === sourceNumber(source.manifestVersion) &&
      assessment.assessmentEpoch ===
        sourceNumber(source.workerAssessmentEpoch) &&
      assessment.coverageInvalidatedAt ===
        sourceNumber(source.coverageInvalidatedAt) &&
      assessment.lastEnumeratedAt === sourceNumber(source.lastEnumeratedAt) &&
      assessment.lastProcessedAtAtCompletion ===
        sourceNumber(source.lastProcessedAt) &&
      [
        assessment.inventoryEpoch,
        assessment.completedInventoryEpoch,
        assessment.manifestVersion,
        assessment.assessmentEpoch,
        assessment.coverageInvalidatedAt,
        assessment.lastEnumeratedAt,
        assessment.scanCompletedAt,
        assessment.scanEntryCount,
        assessment.scanChangedCount,
        assessment.scanGapCount,
        assessment.scanReviewCount,
        assessment.nextOrdinal,
        assessment.accountedScanEntries,
        assessment.queuedScanEntries,
        assessment.gapScanEntries,
        assessment.reviewScanEntries,
        assessment.ignoredScanEntries,
        assessment.unchangedScanEntries,
      ].every((value) => safeInteger(value)) &&
      assessment.accountedScanEntries === assessment.scanEntryCount &&
      assessment.queuedScanEntries === assessment.scanChangedCount &&
      assessment.gapScanEntries === assessment.scanGapCount &&
      assessment.reviewScanEntries === assessment.scanReviewCount &&
      assessment.accountedScanEntries ===
        assessment.queuedScanEntries +
          assessment.gapScanEntries +
          assessment.reviewScanEntries +
          assessment.ignoredScanEntries +
          assessment.unchangedScanEntries &&
      safeInteger(assessment.completedAt) &&
      safeInteger(assessment.lastProcessedAtAtCompletion) &&
      countsAreValid(assessment.counts) &&
      sourceFenceIsValid(source) &&
      assessment.state ===
        terminalState(assessment.counts, assessment.scanStateAtStart),
    );
  } catch {
    return false;
  }
}

async function digest(domain: string, value: unknown): Promise<string> {
  return await sha256Utf8(`${domain}\0${JSON.stringify(value)}`);
}

function ensureSameActor(
  principal: WorkerPrincipal,
  row: { actorUserId: Id<"users">; actorCredentialId: Id<"apiKeys"> },
): void {
  if (
    row.actorUserId !== principal.userId ||
    row.actorCredentialId !== principal.credentialId
  ) {
    throw workerProtocolError("not_found");
  }
}

async function requireOriginalActor(
  ctx: DbCtx,
  source: LoadedWorkerSource,
  actor: { actorUserId: Id<"users">; actorCredentialId: Id<"apiKeys"> },
): Promise<boolean> {
  try {
    const account = await requireSourceAccountAccess(
      ctx,
      { userId: actor.actorUserId, credentialId: actor.actorCredentialId },
      source.account._id,
      "ingest",
    );
    return account.spaceId === source.spaceId && account.connector === "fs";
  } catch {
    return false;
  }
}

function scanCountersValid(scan: Doc<"workerSourceScans">): boolean {
  return (
    safeInteger(scan.entryCount) &&
    safeInteger(scan.changedCount) &&
    safeInteger(scan.gapCount) &&
    safeInteger(scan.reviewCount) &&
    scan.changedCount + scan.gapCount + scan.reviewCount <= scan.entryCount
  );
}

async function loadAssessment(
  ctx: DbCtx,
  source: LoadedWorkerSource,
  rawId: string,
): Promise<Assessment> {
  const id = ctx.db.normalizeId("workerProcessingAssessments", rawId);
  if (!id) throw workerProtocolError("invalid_request");
  const row = await ctx.db.get(id);
  if (
    !row ||
    row.spaceId !== source.spaceId ||
    row.sourceAccountId !== source.account._id
  ) {
    throw workerProtocolError("not_found");
  }
  ensureSameActor(source.principal, row);
  return row;
}

function beginResult(
  assessment: Assessment,
  reused: boolean,
): WorkerAssessmentBeginResult {
  return {
    operation: "processing.assessBegin",
    assessmentId: assessment._id,
    scanId: assessment.scanId,
    inventoryEpoch: assessment.inventoryEpoch,
    manifestVersion: assessment.manifestVersion,
    state: assessment.state,
    nextOrdinal: assessment.nextOrdinal,
    ...(assessment.state === "complete" || assessment.state === "incomplete"
      ? { counts: assessment.counts, completedAt: assessment.completedAt }
      : {}),
    ...(assessment.state === "stale"
      ? { staleReason: assessment.staleReason }
      : {}),
    reused,
  };
}

function pageResult(
  assessmentId: Id<"workerProcessingAssessments">,
  result: NonNullable<Assessment["lastPageResult"]>,
  reused: boolean,
): WorkerAssessmentPageResult {
  return {
    operation: "processing.assessPage",
    assessmentId,
    ...result,
    reused,
  };
}

async function currentFenceReason(
  ctx: DbCtx,
  source: LoadedWorkerSource,
  assessment: Assessment,
  now: number,
): Promise<StaleReason | undefined> {
  if (
    !sourceFenceIsValid(source.account) ||
    !detailRowsAreBounded(source.account)
  ) {
    return "source_changed";
  }
  if (
    ![
      assessment.inventoryEpoch,
      assessment.completedInventoryEpoch,
      assessment.manifestVersion,
      assessment.assessmentEpoch,
      assessment.coverageInvalidatedAt,
      assessment.lastEnumeratedAt,
      assessment.lastProcessedAtAtStart,
      assessment.scanCompletedAt,
      assessment.scanEntryCount,
      assessment.scanChangedCount,
      assessment.scanGapCount,
      assessment.scanReviewCount,
      assessment.nextOrdinal,
      assessment.startedAt,
      assessment.updatedAt,
      assessment.expiresAt,
      assessment.retireAt,
    ].every((value) => safeInteger(value)) ||
    !countsAreValid(assessment.counts)
  ) {
    return "detail_unavailable";
  }
  if (assessment.expiresAt <= now) {
    return "expired";
  }
  if (
    assessment.spaceId !== source.spaceId ||
    assessment.sourceAccountId !== source.account._id ||
    source.account.activeWorkerAssessmentId !== assessment._id ||
    assessment.inventoryEpoch !== sourceNumber(source.account.inventoryEpoch) ||
    assessment.completedInventoryEpoch !==
      sourceNumber(source.account.completedInventoryEpoch) ||
    assessment.manifestVersion !==
      sourceNumber(source.account.manifestVersion) ||
    assessment.assessmentEpoch !==
      sourceNumber(source.account.workerAssessmentEpoch) ||
    assessment.coverageInvalidatedAt !==
      sourceNumber(source.account.coverageInvalidatedAt) ||
    assessment.lastEnumeratedAt !==
      sourceNumber(source.account.lastEnumeratedAt)
  ) {
    return "source_changed";
  }
  if (!(await requireOriginalActor(ctx, source, assessment))) {
    return "source_changed";
  }
  const scan = await ctx.db.get(assessment.scanId);
  if (!scan || !detailRowsAreBounded(assessment, scan)) {
    return "detail_unavailable";
  }
  if (
    scan.spaceId !== source.spaceId ||
    scan.sourceAccountId !== source.account._id ||
    scan.state !== assessment.scanStateAtStart ||
    scan.completedAt !== assessment.scanCompletedAt ||
    scan.inventoryEpoch !== assessment.inventoryEpoch ||
    scan.reconcileManifestVersion !== assessment.manifestVersion ||
    scan.entryCount !== assessment.scanEntryCount ||
    scan.changedCount !== assessment.scanChangedCount ||
    scan.gapCount !== assessment.scanGapCount ||
    scan.reviewCount !== assessment.scanReviewCount ||
    source.account.activeWorkerScanId !== undefined
  ) {
    return "source_changed";
  }
  if (!scanCountersValid(scan)) return "detail_unavailable";
  return undefined;
}

async function markStale(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  assessment: Assessment,
  reason: StaleReason,
  now: number,
  replay?: {
    requestId: string;
    requestDigest: string;
    ordinal: number;
    inputPhase: Assessment["phase"];
  },
): Promise<Assessment> {
  const nextOrdinal = assessment.nextOrdinal;
  const staleReplay =
    replay ??
    (assessment.lastPageRequestId &&
    assessment.lastPageRequestDigest &&
    assessment.lastPageInputPhase &&
    assessment.lastPageOrdinal !== undefined
      ? {
          requestId: assessment.lastPageRequestId,
          requestDigest: assessment.lastPageRequestDigest,
          ordinal: assessment.lastPageOrdinal,
          inputPhase: assessment.lastPageInputPhase,
        }
      : undefined);
  const result: NonNullable<Assessment["lastPageResult"]> | undefined =
    staleReplay
      ? {
          state: "stale",
          phase: "done",
          ordinal: staleReplay.ordinal,
          inspected: 0,
          nextOrdinal,
          staleReason: reason,
        }
      : undefined;
  await ctx.db.patch(assessment._id, {
    state: "stale",
    staleReason: reason,
    phase: "done",
    cursor: undefined,
    updatedAt: now,
    retireAt: safeAdd(now, WORKER_ASSESSMENT_RETENTION_MS),
    ...(staleReplay
      ? {
          lastPageRequestId: staleReplay.requestId,
          lastPageRequestDigest: staleReplay.requestDigest,
          lastPageInputPhase: staleReplay.inputPhase,
          lastPageOrdinal: staleReplay.ordinal,
          lastPageResult: result,
        }
      : {}),
  });
  if (source.account.activeWorkerAssessmentId === assessment._id) {
    await ctx.db.patch(source.account._id, {
      activeWorkerAssessmentId: undefined,
    });
  }
  const updated = await ctx.db.get(assessment._id);
  if (!updated) throw workerProtocolError("scan_conflict");
  return updated;
}

export async function beginProcessingAssessment(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "processing.assessBegin" }>,
  now: number,
): Promise<WorkerAssessmentBeginResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  if (
    !sourceFenceIsValid(source.account) ||
    !detailRowsAreBounded(source.account)
  ) {
    throw workerProtocolError("scan_conflict");
  }
  const requestDigest = await digest("worker-processing-assess-begin:v1", [
    source.account._id,
    request.requestId,
    request.scanId,
    request.expectedInventoryEpoch,
    request.expectedManifestVersion,
  ]);
  const prior = await ctx.db
    .query("workerProcessingAssessments")
    .withIndex("by_sourceAccountId_and_requestId", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("requestId", request.requestId),
    )
    .take(2);
  if (prior.length > 1) throw workerProtocolError("scan_conflict");
  if (prior[0]) {
    if (
      prior[0].spaceId !== source.spaceId ||
      prior[0].sourceAccountId !== source.account._id
    )
      throw workerProtocolError("scan_conflict");
    ensureSameActor(source.principal, prior[0]);
    if (prior[0].requestDigest !== requestDigest) {
      throw workerProtocolError("request_conflict");
    }
    if (prior[0].state === "running") {
      const reason = await currentFenceReason(ctx, source, prior[0], now);
      if (reason)
        return beginResult(
          await markStale(ctx, source, prior[0], reason, now),
          true,
        );
    } else if (
      (prior[0].state === "complete" || prior[0].state === "incomplete") &&
      !isAssessmentSnapshotCurrent(source.account, prior[0])
    ) {
      return beginResult(
        await markStale(ctx, source, prior[0], "source_changed", now),
        true,
      );
    }
    return beginResult(prior[0], true);
  }

  if (
    request.expectedInventoryEpoch !==
      sourceNumber(source.account.inventoryEpoch) ||
    request.expectedManifestVersion !==
      sourceNumber(source.account.manifestVersion)
  ) {
    throw workerProtocolError("stale_observation");
  }
  const scanId = ctx.db.normalizeId("workerSourceScans", request.scanId);
  if (!scanId) throw workerProtocolError("invalid_request");
  const scan = await ctx.db.get(scanId);
  if (
    !scan ||
    scan.spaceId !== source.spaceId ||
    scan.sourceAccountId !== source.account._id
  ) {
    throw workerProtocolError("not_found");
  }
  if (
    (scan.state !== "enumerated" && scan.state !== "needs_review") ||
    !safeInteger(scan.completedAt) ||
    scan.inventoryEpoch !== request.expectedInventoryEpoch ||
    (scan.state === "enumerated" &&
      scan.inventoryEpoch !==
        sourceNumber(source.account.completedInventoryEpoch)) ||
    scan.reconcileManifestVersion !== request.expectedManifestVersion ||
    source.account.activeWorkerScanId !== undefined ||
    !scanCountersValid(scan) ||
    !detailRowsAreBounded(source.account, scan)
  ) {
    throw workerProtocolError("scan_not_ready");
  }

  if (source.account.activeWorkerAssessmentId) {
    const active = await ctx.db.get(source.account.activeWorkerAssessmentId);
    if (
      !active ||
      active.spaceId !== source.spaceId ||
      active.sourceAccountId !== source.account._id
    ) {
      throw workerProtocolError("scan_conflict");
    }
    if (active.state === "running") {
      const reason = await currentFenceReason(ctx, source, active, now);
      if (!reason) throw workerProtocolError("scan_conflict");
      await markStale(ctx, source, active, reason, now);
    } else {
      await ctx.db.patch(source.account._id, {
        activeWorkerAssessmentId: undefined,
      });
    }
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const expiresAt = safeAdd(now, WORKER_ASSESSMENT_IDLE_MS);
  const id = await ctx.db.insert("workerProcessingAssessments", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    scanId,
    requestId: request.requestId,
    requestDigest,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    inventoryEpoch: request.expectedInventoryEpoch,
    completedInventoryEpoch: sourceNumber(
      source.account.completedInventoryEpoch,
    ),
    manifestVersion: request.expectedManifestVersion,
    assessmentEpoch: sourceNumber(source.account.workerAssessmentEpoch),
    coverageInvalidatedAt: sourceNumber(source.account.coverageInvalidatedAt),
    lastEnumeratedAt: sourceNumber(source.account.lastEnumeratedAt),
    lastProcessedAtAtStart: sourceNumber(source.account.lastProcessedAt),
    scanCompletedAt: scan.completedAt,
    scanStateAtStart: scan.state,
    scanEntryCount: scan.entryCount,
    scanChangedCount: scan.changedCount,
    scanGapCount: scan.gapCount,
    scanReviewCount: scan.reviewCount,
    state: "running",
    phase: "items",
    nextOrdinal: 0,
    counts: emptyCounts(),
    accountedScanEntries: 0,
    queuedScanEntries: 0,
    gapScanEntries: 0,
    reviewScanEntries: 0,
    ignoredScanEntries: 0,
    unchangedScanEntries: 0,
    startedAt: now,
    updatedAt: now,
    expiresAt,
    retireAt: safeAdd(now, WORKER_ASSESSMENT_RETENTION_MS),
  });
  await ctx.db.patch(source.account._id, { activeWorkerAssessmentId: id });
  const assessment = await ctx.db.get(id);
  if (!assessment) throw workerProtocolError("scan_conflict");
  return beginResult(assessment, false);
}

type ScanProofBucket =
  | "queuedScanEntries"
  | "gapScanEntries"
  | "reviewScanEntries"
  | "ignoredScanEntries"
  | "unchangedScanEntries";

type ItemClassification = {
  bucket: keyof ProcessingAssessmentCounts["items"];
  proof?: ScanProofBucket;
};

function validDiscoveryWorkRuntimeState(
  work: Doc<"workerDiscoveryWork">,
): boolean {
  const leaseAbsent =
    work.leaseToken === undefined &&
    work.leaseOwnerCredentialId === undefined &&
    work.leaseExpiresAt === undefined;
  if (work.state === "queued") {
    return leaseAbsent && safeInteger(work.nextAttemptAt);
  }
  if (work.state === "leased") {
    return (
      Boolean(work.leaseToken) &&
      work.leaseOwnerCredentialId !== undefined &&
      safeInteger(work.leaseExpiresAt) &&
      work.nextAttemptAt === undefined
    );
  }
  if (work.state === "failed") {
    return (
      leaseAbsent &&
      Boolean(work.failureCode) &&
      work.retryable !== undefined &&
      (work.retryable
        ? safeInteger(work.nextAttemptAt)
        : work.nextAttemptAt === undefined)
    );
  }
  return leaseAbsent && work.nextAttemptAt === undefined;
}

function validIngestJobRuntimeState(job: Doc<"ingestJobs">): boolean {
  const leaseAbsent =
    job.leaseToken === undefined &&
    job.workerLeaseOwnerCredentialId === undefined &&
    job.leaseExpiresAt === undefined;
  if (job.state === "queued") {
    return (
      leaseAbsent && safeInteger(job.nextAttemptAt) && job.error === undefined
    );
  }
  if (job.state === "processing" || job.state === "staged") {
    return (
      Boolean(job.leaseToken) &&
      job.workerLeaseOwnerCredentialId !== undefined &&
      safeInteger(job.leaseExpiresAt) &&
      job.nextAttemptAt === undefined &&
      job.error === undefined
    );
  }
  if (job.state === "failed") {
    return (
      leaseAbsent &&
      job.error !== undefined &&
      safeInteger(job.error.at) &&
      (job.error.retryable
        ? safeInteger(job.nextAttemptAt)
        : job.nextAttemptAt === undefined)
    );
  }
  return leaseAbsent && job.nextAttemptAt === undefined;
}

async function exactEntryForItem(
  ctx: MutationCtx,
  assessment: Assessment,
  item: Doc<"sourceItems">,
): Promise<Doc<"workerScanEntries"> | undefined> {
  const entries = await ctx.db
    .query("workerScanEntries")
    .withIndex("by_scanId_and_sourceItemId", (q) =>
      q.eq("scanId", assessment.scanId).eq("sourceItemId", item._id),
    )
    .take(2);
  if (entries.length > 1) throw workerProtocolError("scan_conflict");
  const entry = entries[0];
  if (!entry) return undefined;
  await requireReadHeadroom(ctx);
  const page = await ctx.db.get(entry.scanPageId);
  if (
    entry.spaceId !== assessment.spaceId ||
    entry.sourceAccountId !== assessment.sourceAccountId ||
    entry.scanId !== assessment.scanId ||
    !page ||
    page.spaceId !== assessment.spaceId ||
    page.sourceAccountId !== assessment.sourceAccountId ||
    page.scanId !== assessment.scanId ||
    page._id !== entry.scanPageId ||
    !detailRowsAreBounded(entry, page)
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return entry;
}

async function itemDigests(
  item: Doc<"sourceItems">,
  entry: Doc<"workerScanEntries">,
) {
  if (!item.externalId || !item.uri || !entry.contentHash) return undefined;
  const externalIdHash = await sha256Utf8(item.externalId);
  const uriDigest = await digest("worker-fs-uri:v1", [
    item.sourceAccountId,
    item.uri,
  ]);
  const processingIdentityDigest = await digest(
    "worker-fs-processing-identity:v1",
    [
      entry.contentHash,
      FS_TEXT_PROFILE.mediaType,
      FS_TEXT_PROFILE.profileId,
      FS_TEXT_PROFILE.extractionFingerprint,
      FS_TEXT_PROFILE.extractorFingerprint,
      FS_TEXT_PROFILE.recordSchemaFingerprint,
      FS_TEXT_PROFILE.normalizationFingerprint,
      FS_TEXT_PROFILE.chunkerFingerprint,
    ],
  );
  const inventoryMetadataDigest = await digest(
    "worker-fs-inventory-metadata:v1",
    [
      externalIdHash,
      uriDigest,
      item.title ?? null,
      item.docType ?? null,
      entry.sourceModifiedAt,
      "ready",
      entry.contentHash,
      entry.byteLength ?? null,
      null,
      FS_TEXT_PROFILE.profileId,
    ],
  );
  return {
    externalIdHash,
    uriDigest,
    processingIdentityDigest,
    inventoryMetadataDigest,
  };
}

async function binaryItemDigests(
  item: Doc<"sourceItems">,
  entry: Doc<"workerScanEntries">,
) {
  // P2-70i2: the class is part of both digests, so a PDF receipt can never
  // satisfy a workbook and a workbook receipt can never satisfy a PDF. For a
  // PDF entry these are the same two literals the digest carried before, so
  // every existing digest is unchanged byte for byte.
  if (
    !isBinaryClass(entry.binaryParserProfileId, entry.binaryMediaType) ||
    !item.externalId ||
    !item.uri ||
    !entry.contentHash ||
    !entry.parserFingerprint ||
    !entry.extractionConfigurationFingerprint ||
    !entry.extractorFingerprint ||
    !entry.recordSchemaFingerprint ||
    !entry.normalizationFingerprint ||
    !entry.chunkerFingerprint ||
    !entry.correctionRevision
  )
    return undefined;
  const externalIdHash = await sha256Utf8(item.externalId);
  const uriDigest = await digest("worker-fs-uri:v1", [
    item.sourceAccountId,
    item.uri,
  ]);
  return {
    externalIdHash,
    uriDigest,
    processingIdentityDigest: await digest(
      "worker-fs-binary-processing-identity:v1",
      [
        entry.contentHash,
        entry.binaryMediaType,
        entry.binaryParserProfileId,
        entry.parserFingerprint,
        entry.extractionConfigurationFingerprint,
        entry.extractorFingerprint,
        entry.recordSchemaFingerprint,
        entry.normalizationFingerprint,
        entry.chunkerFingerprint,
        entry.correctionRevision,
      ],
    ),
    inventoryMetadataDigest: await digest(
      "worker-fs-binary-inventory-metadata:v1",
      [
        externalIdHash,
        uriDigest,
        item.title ?? null,
        item.docType ?? null,
        entry.sourceModifiedAt,
        "ready_binary_v1",
        entry.contentHash,
        entry.byteLength,
        entry.binaryParserProfileId,
      ],
    ),
  };
}

async function terminalParsedReady(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  assessment: Assessment,
  item: Doc<"sourceItems">,
  entry: Doc<"workerScanEntries">,
): Promise<boolean> {
  if (
    entry.contentRepresentation !== "archived_binary_v1" ||
    !isBinaryClass(entry.binaryParserProfileId, entry.binaryMediaType) ||
    item.lifecycle !== "available" ||
    item.lastFailure !== undefined ||
    item.workerLastSeenInventoryEpoch !== assessment.inventoryEpoch ||
    item.workerObservationEpoch !== entry.observationEpoch ||
    item.workerProcessingEpoch !== entry.processingEpoch ||
    item.workerContentHash !== entry.contentHash ||
    item.workerProfileId !== entry.binaryParserProfileId ||
    item.workerSourceModifiedAt !== entry.sourceModifiedAt ||
    !item.desiredRevisionId ||
    item.activeRevisionId !== item.desiredRevisionId ||
    !item.activeGenerationId ||
    !safeInteger(item.desiredProcessingEpoch) ||
    !safeInteger(entry.observationEpoch) ||
    !safeInteger(entry.processingEpoch) ||
    !safeInteger(entry.byteLength)
  )
    return false;
  const calculated = await binaryItemDigests(item, entry);
  if (
    !calculated ||
    item.externalIdHash !== calculated.externalIdHash ||
    item.workerInventoryMetadataDigest !== calculated.inventoryMetadataDigest ||
    item.workerProcessingIdentityDigest !==
      calculated.processingIdentityDigest ||
    entry.externalIdHash !== calculated.externalIdHash ||
    entry.uriDigest !== calculated.uriDigest ||
    entry.inventoryMetadataDigest !== calculated.inventoryMetadataDigest ||
    entry.processingIdentityDigest !== calculated.processingIdentityDigest
  )
    return false;
  const [revision, generation] = await Promise.all([
    ctx.db.get(item.desiredRevisionId),
    ctx.db.get(item.activeGenerationId),
  ]);
  if (
    !revision ||
    !generation ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== item._id ||
    revision.representation !== "archived_binary_v1" ||
    revision.contentHashAuthority !== "worker_asserted" ||
    revision.contentHash !== entry.contentHash ||
    revision.byteLength !== entry.byteLength ||
    revision.mediaType !== entry.binaryMediaType ||
    generation.spaceId !== source.spaceId ||
    generation.sourceAccountId !== source.account._id ||
    generation.sourceItemId !== item._id ||
    generation.sourceRevisionId !== revision._id ||
    generation.desiredProcessingEpoch !== item.desiredProcessingEpoch ||
    generation.state !== "ready" ||
    !generation.sourceTextVersionId ||
    !generation.parserArtifactId ||
    !generation.archiveSetDigest ||
    !generation.normalizedBundleDigest ||
    !generation.payloadManifestId ||
    !safeInteger(generation.activatedAt) ||
    generation.deactivatedAt !== undefined ||
    generation.expectedEventCount !== 0 ||
    generation.expectedObservationCount !== 0 ||
    generation.actualEventCount !== 0 ||
    generation.actualObservationCount !== 0
  )
    return false;
  if (
    !generation.originalPrimaryReceiptId ||
    !generation.parserPrimaryReceiptId ||
    !generation.parserBackupReceiptId ||
    !generationOriginalRecoverySelectionIsClosed(generation)
  )
    return false;
  const [
    artifact,
    text,
    jobs,
    originalPrimary,
    originalBackup,
    providerOriginal,
    parserPrimary,
    parserBackup,
  ] = await Promise.all([
    ctx.db.get(generation.parserArtifactId),
    ctx.db.get(generation.sourceTextVersionId),
    ctx.db
      .query("ingestJobs")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(2),
    ctx.db.get(generation.originalPrimaryReceiptId),
    generation.originalBackupReceiptId
      ? ctx.db.get(generation.originalBackupReceiptId)
      : null,
    generation.originalProviderReferenceId
      ? ctx.db.get(generation.originalProviderReferenceId)
      : null,
    ctx.db.get(generation.parserPrimaryReceiptId),
    ctx.db.get(generation.parserBackupReceiptId),
  ]);
  const job = jobs[0];
  let revisionShape;
  let textShape;
  try {
    revisionShape = parseSourceRevisionRepresentation(revision);
    textShape = text ? parseSourceTextRepresentation(text) : undefined;
  } catch {
    return false;
  }
  if (
    !artifact ||
    !text ||
    jobs.length !== 1 ||
    !job ||
    !originalPrimary ||
    (!originalBackup && !providerOriginal) ||
    !parserPrimary ||
    !parserBackup ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account._id ||
    artifact.sourceItemId !== item._id ||
    artifact.sourceRevisionId !== revision._id ||
    artifact.parserFingerprint !== entry.parserFingerprint ||
    artifact.hashAuthority !== "worker_asserted" ||
    !UUID_PATTERN.test(artifact.clientArtifactId) ||
    !SHA256_PATTERN.test(artifact.outputHash) ||
    !safeInteger(artifact.outputByteLength, 1) ||
    artifact.outputByteLength > MAX_PARSER_ARTIFACT_BYTES ||
    artifact.outputMediaType.length === 0 ||
    artifact.outputMediaType.length > 255 ||
    !safeInteger(artifact.createdAt) ||
    revisionShape.kind !== "archived_binary_v1" ||
    textShape?.kind !== "parsed_pages_v1" ||
    !textShape.sealed ||
    textShape.hashAuthority !== "server_verified_retained_text" ||
    text.spaceId !== source.spaceId ||
    text.sourceRevisionId !== revision._id ||
    text.representation !== "parsed_pages_v1" ||
    text.parserArtifactId !== artifact._id ||
    text.extractionFingerprint !==
      (await artifactBoundExtractionFingerprint(
        artifact.parserFingerprint,
        artifact.outputHash,
        entry.extractionConfigurationFingerprint!,
      )) ||
    generation.extractionFingerprint !== text.extractionFingerprint ||
    generation.processingFingerprint !==
      (await digestProcessingConfiguration({
        extractionFingerprint: text.extractionFingerprint,
        extractorFingerprint: entry.extractorFingerprint!,
        recordSchemaFingerprint: entry.recordSchemaFingerprint!,
        normalizationFingerprint: entry.normalizationFingerprint!,
        chunkerFingerprint: entry.chunkerFingerprint!,
        correctionRevision: entry.correctionRevision!,
      })) ||
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account._id ||
    job.sourceItemId !== item._id ||
    job.sourceRevisionId !== revision._id ||
    job.processingGenerationId !== generation._id ||
    job.desiredProcessingEpoch !== item.desiredProcessingEpoch ||
    job.workerManaged !== true ||
    job.workerProcessingMode !== "parsed_pages_v1" ||
    job.state !== "ready" ||
    job.leaseToken !== undefined ||
    job.leaseExpiresAt !== undefined ||
    job.workerLeaseOwnerCredentialId !== undefined
  )
    return false;
  const receipts = [
    [originalPrimary, "original_bytes", "primary"],
    ...(originalBackup
      ? ([[originalBackup, "original_bytes", "independent_backup"]] as const)
      : []),
    [parserPrimary, "parser_output", "primary"],
    [parserBackup, "parser_output", "independent_backup"],
  ] as const;
  if (
    receipts.some(
      ([receipt, subject, role]) =>
        !historicalArchiveReceiptIsValid(receipt, {
          revision,
          artifact,
          subjectKind: subject,
          copyRole: role,
        }) ||
        receipt.spaceId !== source.spaceId ||
        receipt.sourceAccountId !== source.account._id ||
        receipt.sourceItemId !== item._id,
    )
  )
    return false;
  if (
    (originalBackup &&
      (originalPrimary._id === originalBackup._id ||
        originalPrimary.archiveIdentityFingerprint ===
          originalBackup.archiveIdentityFingerprint ||
        originalPrimary.recipientFingerprint ===
          originalBackup.recipientFingerprint ||
        originalPrimary.repositoryKeyDomainFingerprint ===
          originalBackup.repositoryKeyDomainFingerprint ||
        originalPrimary.storageFailureDomainFingerprint ===
          originalBackup.storageFailureDomainFingerprint)) ||
    (providerOriginal &&
      (providerOriginal.spaceId !== source.spaceId ||
        providerOriginal.sourceAccountId !== source.account._id ||
        providerOriginal.sourceItemId !== item._id ||
        providerOriginal.sourceRevisionId !== revision._id ||
        providerOriginal.referenceVersion !== "provider_original_v1" ||
        providerOriginal.providerKind !== "dropbox_v1" ||
        providerOriginal.verificationAuthority !== "worker_asserted" ||
        providerOriginal.sourceContentHash !== revision.contentHash ||
        providerOriginal.sourceByteLength !== revision.byteLength ||
        !SHA256_PATTERN.test(providerOriginal.referenceFingerprint))) ||
    parserPrimary._id === parserBackup._id ||
    parserPrimary.archiveIdentityFingerprint ===
      parserBackup.archiveIdentityFingerprint ||
    parserPrimary.recipientFingerprint === parserBackup.recipientFingerprint ||
    parserPrimary.repositoryKeyDomainFingerprint ===
      parserBackup.repositoryKeyDomainFingerprint ||
    parserPrimary.storageFailureDomainFingerprint ===
      parserBackup.storageFailureDomainFingerprint ||
    !SHA256_PATTERN.test(generation.archiveSetDigest)
  )
    return false;
  try {
    const counts = await verifySealedParsedPayload(ctx, generation);
    return (
      generation.actualPageCount === counts.actualPageCount &&
      generation.actualEvidenceSpanCount === counts.actualEvidenceSpanCount &&
      generation.actualDocumentCount === counts.actualDocumentCount &&
      generation.actualChunkCount === counts.actualChunkCount
    );
  } catch {
    return false;
  }
}

async function terminalReady(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  assessment: Assessment,
  item: Doc<"sourceItems">,
  entry: Doc<"workerScanEntries">,
): Promise<boolean> {
  if (entry.contentRepresentation === "archived_binary_v1")
    return terminalParsedReady(ctx, source, assessment, item, entry);
  if (
    item.lifecycle !== "available" ||
    item.lastFailure !== undefined ||
    item.workerLastSeenInventoryEpoch !== assessment.inventoryEpoch ||
    item.workerObservationEpoch !== entry.observationEpoch ||
    item.workerProcessingEpoch !== entry.processingEpoch ||
    item.workerContentHash !== entry.contentHash ||
    item.workerProfileId !== FS_TEXT_PROFILE.profileId ||
    item.workerSourceModifiedAt !== entry.sourceModifiedAt ||
    item.desiredRevisionId === undefined ||
    item.activeRevisionId !== item.desiredRevisionId ||
    item.activeGenerationId === undefined ||
    entry.byteLength === undefined ||
    !safeInteger(entry.observationEpoch) ||
    !safeInteger(entry.processingEpoch) ||
    !safeInteger(entry.byteLength) ||
    !safeInteger(item.workerObservationEpoch) ||
    !safeInteger(item.workerProcessingEpoch) ||
    !safeInteger(item.workerSourceModifiedAt) ||
    !safeInteger(entry.sourceModifiedAt) ||
    !safeInteger(item.desiredProcessingEpoch)
  )
    return false;
  const calculated = await itemDigests(item, entry);
  if (
    !calculated ||
    item.externalIdHash !== calculated.externalIdHash ||
    item.workerInventoryMetadataDigest !== calculated.inventoryMetadataDigest ||
    item.workerProcessingIdentityDigest !==
      calculated.processingIdentityDigest ||
    entry.externalIdHash !== calculated.externalIdHash ||
    entry.uriDigest !== calculated.uriDigest ||
    entry.inventoryMetadataDigest !== calculated.inventoryMetadataDigest ||
    entry.processingIdentityDigest !== calculated.processingIdentityDigest
  )
    return false;
  const [revision, generation] = await Promise.all([
    ctx.db.get(item.desiredRevisionId),
    ctx.db.get(item.activeGenerationId),
  ]);
  if (!revision || !generation || !detailRowsAreBounded(revision, generation))
    return false;
  let revisionText: string;
  try {
    revisionText = requireInlineSourceRevision(revision).text;
  } catch {
    return false;
  }
  const revisionHash = await sha256Utf8(revisionText);
  const revisionByteLength = new TextEncoder().encode(revisionText).byteLength;
  let plan: ReturnType<typeof planInlineText>;
  try {
    plan = planInlineText(revisionText);
  } catch {
    return false;
  }
  await requireReadHeadroom(ctx);
  const jobs = await ctx.db
    .query("ingestJobs")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", generation._id),
    )
    .take(2);
  if (jobs.length !== 1) return false;
  const job = jobs[0]!;
  if (!detailRowsAreBounded(job)) return false;
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
    extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
    recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
    normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
    chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
    correctionRevision: `filesystem-observation-v1:${entry.processingEpoch}`,
  });
  return Boolean(
    revision.spaceId === source.spaceId &&
    revision.sourceItemId === item._id &&
    revision._id === item.desiredRevisionId &&
    revision.contentHash === entry.contentHash &&
    revision.byteLength === entry.byteLength &&
    revisionHash === revision.contentHash &&
    revisionByteLength === revision.byteLength &&
    revision.mediaType === FS_TEXT_PROFILE.mediaType &&
    generation.spaceId === source.spaceId &&
    generation.sourceAccountId === source.account._id &&
    generation.sourceItemId === item._id &&
    generation.sourceRevisionId === revision._id &&
    generation.desiredProcessingEpoch === item.desiredProcessingEpoch &&
    generation.state === "ready" &&
    generation.processingFingerprint === processingFingerprint &&
    generation.extractionFingerprint ===
      FS_TEXT_PROFILE.extractionFingerprint &&
    generation.extractorFingerprint === FS_TEXT_PROFILE.extractorFingerprint &&
    generation.recordSchemaFingerprint ===
      FS_TEXT_PROFILE.recordSchemaFingerprint &&
    generation.normalizationFingerprint ===
      FS_TEXT_PROFILE.normalizationFingerprint &&
    generation.chunkerFingerprint === FS_TEXT_PROFILE.chunkerFingerprint &&
    generation.correctionRevision ===
      `filesystem-observation-v1:${entry.processingEpoch}` &&
    safeInteger(generation.activatedAt) &&
    generation.deactivatedAt === undefined &&
    safeInteger(generation.expectedPageCount) &&
    safeInteger(generation.expectedEvidenceSpanCount) &&
    safeInteger(generation.expectedDocumentCount) &&
    safeInteger(generation.expectedChunkCount) &&
    generation.expectedPageCount === plan.expectedPageCount &&
    generation.expectedEvidenceSpanCount === plan.expectedEvidenceSpanCount &&
    generation.expectedDocumentCount === plan.expectedDocumentCount &&
    generation.expectedChunkCount === plan.expectedChunkCount &&
    generation.expectedEventCount === 0 &&
    generation.expectedObservationCount === 0 &&
    generation.actualPageCount === generation.expectedPageCount &&
    generation.actualEvidenceSpanCount ===
      generation.expectedEvidenceSpanCount &&
    generation.actualDocumentCount === generation.expectedDocumentCount &&
    generation.actualChunkCount === generation.expectedChunkCount &&
    generation.actualEventCount === 0 &&
    generation.actualObservationCount === 0 &&
    job.spaceId === source.spaceId &&
    job.sourceAccountId === source.account._id &&
    job.sourceItemId === item._id &&
    job.sourceRevisionId === revision._id &&
    job.processingGenerationId === generation._id &&
    job.desiredProcessingEpoch === item.desiredProcessingEpoch &&
    job.workerManaged === true &&
    job.workerDiscoveryWorkId !== undefined &&
    safeInteger(job.workerObservationEpoch) &&
    job.workerObservationEpoch <= entry.observationEpoch &&
    job.actorCredentialId !== undefined &&
    job.admittedByCredentialId !== undefined &&
    job.actorUserId === job.admittedByUserId &&
    job.actorCredentialId === job.admittedByCredentialId &&
    job.state === "ready" &&
    safeInteger(job.attempts) &&
    safeInteger(job.leaseEpoch) &&
    job.leaseToken === undefined &&
    job.leaseExpiresAt === undefined &&
    job.workerLeaseOwnerCredentialId === undefined &&
    job.nextAttemptAt === undefined &&
    job.error === undefined,
  );
}

async function classifyWork(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  item: Doc<"sourceItems">,
  entry: Doc<"workerScanEntries">,
): Promise<keyof ProcessingAssessmentCounts["items"]> {
  if (!entry.discoveryWorkId) throw workerProtocolError("scan_conflict");
  await requireReadHeadroom(ctx);
  const work = await ctx.db.get(entry.discoveryWorkId);
  if (
    !work ||
    work.spaceId !== source.spaceId ||
    work.sourceAccountId !== source.account._id ||
    work.sourceItemId !== item._id ||
    work.scanId !== entry.scanId ||
    work.scanEntryId !== entry._id ||
    work.observationEpoch !== entry.observationEpoch ||
    work.processingEpoch !== entry.processingEpoch ||
    work.contentHash !== entry.contentHash ||
    work.byteLength !== entry.byteLength ||
    !safeInteger(work.observationEpoch) ||
    !safeInteger(work.processingEpoch) ||
    !safeInteger(work.attempts) ||
    !safeInteger(work.leaseEpoch) ||
    !detailRowsAreBounded(work) ||
    !validDiscoveryWorkRuntimeState(work)
  )
    throw workerProtocolError("scan_conflict");
  if (!(await requireOriginalActor(ctx, source, work))) return "needsReview";
  if (work.state === "queued" || work.state === "leased") return "pending";
  if (work.state === "failed") {
    if (work.retryable === undefined || !work.failureCode) {
      throw workerProtocolError("scan_conflict");
    }
    return work.retryable ? "failed" : "needsReview";
  }
  if (work.state === "needs_review" || work.state === "obsolete")
    return "needsReview";
  if (
    work.state !== "admitted" ||
    !work.ingestJobId ||
    !work.sourceRevisionId ||
    !work.processingGenerationId ||
    work.expectedDesiredProcessingEpoch === undefined
  )
    throw workerProtocolError("scan_conflict");
  const [job, generation, revision] = await Promise.all([
    ctx.db.get(work.ingestJobId),
    ctx.db.get(work.processingGenerationId),
    ctx.db.get(work.sourceRevisionId),
  ]);
  if (
    !job ||
    !generation ||
    !revision ||
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account._id ||
    job.sourceItemId !== item._id ||
    job.sourceRevisionId !== revision._id ||
    job.processingGenerationId !== generation._id ||
    job.workerManaged !== true ||
    job.workerDiscoveryWorkId !== work._id ||
    job.workerObservationEpoch !== work.observationEpoch ||
    generation.spaceId !== source.spaceId ||
    generation.sourceAccountId !== source.account._id ||
    generation.sourceItemId !== item._id ||
    generation.sourceRevisionId !== revision._id ||
    generation.state !== job.state ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== item._id ||
    item.desiredRevisionId !== revision._id ||
    item.desiredProcessingEpoch !== job.desiredProcessingEpoch ||
    generation.desiredProcessingEpoch !== job.desiredProcessingEpoch ||
    work.expectedDesiredProcessingEpoch + 1 !== job.desiredProcessingEpoch ||
    !detailRowsAreBounded(job, generation, revision) ||
    !validIngestJobRuntimeState(job)
  )
    throw workerProtocolError("scan_conflict");
  if (
    job.actorCredentialId === undefined ||
    job.actorCredentialId !== work.actorCredentialId ||
    job.actorUserId !== work.actorUserId ||
    job.admittedByCredentialId !== work.actorCredentialId ||
    job.admittedByUserId !== work.actorUserId
  )
    throw workerProtocolError("scan_conflict");
  if (
    !(await requireOriginalActor(ctx, source, {
      actorUserId: job.actorUserId,
      actorCredentialId: job.actorCredentialId,
    }))
  )
    return "needsReview";
  if (
    job.state === "queued" ||
    job.state === "processing" ||
    job.state === "staged"
  )
    return "pending";
  if (job.state === "failed") {
    if (!job.error) throw workerProtocolError("scan_conflict");
    return job.error.retryable ? "failed" : "needsReview";
  }
  return "needsReview";
}

async function classifyItem(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  assessment: Assessment,
  item: Doc<"sourceItems">,
): Promise<ItemClassification> {
  if (
    item.spaceId !== source.spaceId ||
    item.sourceAccountId !== source.account._id
  )
    throw workerProtocolError("scan_conflict");
  const entry = await exactEntryForItem(ctx, assessment, item);
  if (item.lifecycle === "forgotten" || item.lifecycle === "forgetting") {
    if (!entry || entry.state === "ignored_forgotten") {
      return {
        bucket: "ignoredForgotten",
        ...(entry ? { proof: "ignoredScanEntries" as const } : {}),
      };
    }
    throw workerProtocolError("scan_conflict");
  }
  if (!entry) {
    if (item.lifecycle === "unavailable") {
      return { bucket: "unavailable" };
    }
    if (assessment.scanStateAtStart === "needs_review") {
      return { bucket: "needsReview" };
    }
    throw workerProtocolError("scan_conflict");
  }
  if (entry.state === "gap")
    return { bucket: "explicitGap", proof: "gapScanEntries" };
  if (entry.state === "needs_review")
    return { bucket: "needsReview", proof: "reviewScanEntries" };
  if (entry.state === "ignored_forgotten") {
    throw workerProtocolError("scan_conflict");
  }
  if (await terminalReady(ctx, source, assessment, item, entry)) {
    return {
      bucket: "ready",
      proof:
        entry.state === "queued" ? "queuedScanEntries" : "unchangedScanEntries",
    };
  }
  if (entry.state !== "queued") throw workerProtocolError("scan_conflict");
  return {
    bucket: await classifyWork(ctx, source, item, entry),
    proof: "queuedScanEntries",
  };
}

function terminalState(
  counts: ProcessingAssessmentCounts,
  scanState: Assessment["scanStateAtStart"],
): "complete" | "incomplete" {
  return scanState === "enumerated" &&
    counts.items.pending === 0 &&
    counts.items.failed === 0 &&
    counts.items.needsReview === 0 &&
    counts.items.explicitGap === 0 &&
    counts.items.unavailable === 0 &&
    counts.unresolvedEntries.needsReview === 0
    ? "complete"
    : "incomplete";
}

export async function advanceProcessingAssessment(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "processing.assessPage" }>,
  now: number,
): Promise<WorkerAssessmentPageResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const assessment = await loadAssessment(ctx, source, request.assessmentId);
  const replayInputPhase = assessment.lastPageInputPhase;
  if (assessment.lastPageRequestId === request.requestId) {
    if (!replayInputPhase || !assessment.lastPageResult) {
      throw workerProtocolError("scan_conflict");
    }
    const replayDigest = await digest("worker-processing-assess-page:v1", [
      source.account._id,
      assessment._id,
      request.requestId,
      replayInputPhase,
      request.ordinal,
      request.maxItems,
    ]);
    if (
      assessment.lastPageRequestDigest !== replayDigest ||
      assessment.lastPageOrdinal !== request.ordinal
    )
      throw workerProtocolError("request_conflict");
    if (assessment.state === "running") {
      const reason = await currentFenceReason(ctx, source, assessment, now);
      if (reason) {
        const stale = await markStale(ctx, source, assessment, reason, now, {
          requestId: request.requestId,
          requestDigest: replayDigest,
          ordinal: request.ordinal,
          inputPhase: replayInputPhase,
        });
        return pageResult(stale._id, stale.lastPageResult!, true);
      }
    } else if (
      (assessment.state === "complete" || assessment.state === "incomplete") &&
      !isAssessmentSnapshotCurrent(source.account, assessment)
    ) {
      const stale = await markStale(
        ctx,
        source,
        assessment,
        "source_changed",
        now,
        {
          requestId: request.requestId,
          requestDigest: replayDigest,
          ordinal: request.ordinal,
          inputPhase: replayInputPhase,
        },
      );
      return pageResult(stale._id, stale.lastPageResult!, true);
    }
    if (assessment.state === "stale") {
      return pageResult(
        assessment._id,
        {
          state: "stale",
          phase: "done",
          ordinal: request.ordinal,
          inspected: 0,
          nextOrdinal: assessment.nextOrdinal,
          staleReason: assessment.staleReason ?? "detail_unavailable",
        },
        true,
      );
    }
    if (!lastPageResultIsCurrent(assessment)) {
      const stale = await markStale(
        ctx,
        source,
        assessment,
        "detail_unavailable",
        now,
        {
          requestId: request.requestId,
          requestDigest: replayDigest,
          ordinal: request.ordinal,
          inputPhase: replayInputPhase,
        },
      );
      return pageResult(stale._id, stale.lastPageResult!, true);
    }
    return pageResult(assessment._id, assessment.lastPageResult, true);
  }
  if (assessment.state !== "running" || assessment.phase === "done") {
    throw workerProtocolError("scan_not_ready");
  }
  if (request.ordinal !== assessment.nextOrdinal) {
    throw workerProtocolError("scan_not_ready");
  }
  const requestDigest = await digest("worker-processing-assess-page:v1", [
    source.account._id,
    assessment._id,
    request.requestId,
    assessment.phase,
    request.ordinal,
    request.maxItems,
  ]);
  const reason = await currentFenceReason(ctx, source, assessment, now);
  if (reason) {
    const stale = await markStale(ctx, source, assessment, reason, now, {
      requestId: request.requestId,
      requestDigest,
      ordinal: request.ordinal,
      inputPhase: assessment.phase,
    });
    return pageResult(stale._id, stale.lastPageResult!, false);
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);

  let counts = assessment.counts;
  let accounted = assessment.accountedScanEntries;
  let queued = assessment.queuedScanEntries;
  let gap = assessment.gapScanEntries;
  let review = assessment.reviewScanEntries;
  let ignored = assessment.ignoredScanEntries;
  let unchanged = assessment.unchangedScanEntries;
  if (
    ![accounted, queued, gap, review, ignored, unchanged].every((v) =>
      safeInteger(v),
    ) ||
    !countsAreValid(counts)
  ) {
    const stale = await markStale(
      ctx,
      source,
      assessment,
      "detail_unavailable",
      now,
      {
        requestId: request.requestId,
        requestDigest,
        ordinal: request.ordinal,
        inputPhase: assessment.phase,
      },
    );
    return pageResult(stale._id, stale.lastPageResult!, false);
  }
  let phase: Assessment["phase"] = assessment.phase;
  let cursor: string | undefined = assessment.cursor;
  let inspected = 0;

  try {
    if (phase === "items") {
      const page = await ctx.db
        .query("sourceItems")
        .withIndex("by_sourceAccountId", (q) =>
          q.eq("sourceAccountId", source.account._id),
        )
        .paginate({
          cursor: cursor ?? null,
          numItems: 1,
          maximumRowsRead: ASSESSMENT_PAGE_MAXIMUM_ROWS_READ,
          maximumBytesRead: ASSESSMENT_PAGE_MAXIMUM_BYTES_READ,
        });
      if (page.pageStatus === "SplitRequired" || page.page.length > 1) {
        throw new Error("split_required");
      }
      await requireReadHeadroom(
        ctx,
        ASSESSMENT_MINIMUM_CHAIN_BYTES_REMAINING,
        ASSESSMENT_MINIMUM_CHAIN_DOCUMENTS_REMAINING,
      );
      for (const item of page.page) {
        if (!detailRowsAreBounded(item)) throw new Error("oversized_detail");
        const classified = await classifyItem(ctx, source, assessment, item);
        counts = incrementCount(counts, classified.bucket);
        if (classified.proof === "queuedScanEntries") queued += 1;
        else if (classified.proof === "gapScanEntries") gap += 1;
        else if (classified.proof === "reviewScanEntries") review += 1;
        else if (classified.proof === "ignoredScanEntries") ignored += 1;
        else if (classified.proof === "unchangedScanEntries") unchanged += 1;
        if (classified.proof) accounted += 1;
        inspected += 1;
      }
      if (page.isDone) {
        phase = "unresolved_entries";
        cursor = undefined;
      } else cursor = page.continueCursor;
    } else {
      const page = await ctx.db
        .query("workerScanEntries")
        .withIndex("by_scanId_and_sourceItemId", (q) =>
          q.eq("scanId", assessment.scanId).eq("sourceItemId", undefined),
        )
        .paginate({
          cursor: cursor ?? null,
          numItems: 1,
          maximumRowsRead: ASSESSMENT_PAGE_MAXIMUM_ROWS_READ,
          maximumBytesRead: ASSESSMENT_PAGE_MAXIMUM_BYTES_READ,
        });
      if (page.pageStatus === "SplitRequired" || page.page.length > 1) {
        throw new Error("split_required");
      }
      for (const entry of page.page) {
        if (!detailRowsAreBounded(entry)) throw new Error("oversized_detail");
        await requireReadHeadroom(ctx);
        const scanPage = await ctx.db.get(entry.scanPageId);
        if (
          entry.spaceId !== source.spaceId ||
          entry.sourceAccountId !== source.account._id ||
          entry.scanId !== assessment.scanId ||
          !scanPage ||
          scanPage.spaceId !== source.spaceId ||
          scanPage.sourceAccountId !== source.account._id ||
          scanPage.scanId !== assessment.scanId ||
          !detailRowsAreBounded(scanPage)
        )
          throw new Error("invalid_detail");
        if (entry.state === "ignored_forgotten") {
          counts = incrementCount(counts, "unresolvedIgnoredForgotten");
          ignored += 1;
        } else if (entry.state === "needs_review") {
          counts = incrementCount(counts, "unresolvedNeedsReview");
          review += 1;
        } else throw new Error("invalid_unresolved_entry");
        accounted += 1;
        inspected += 1;
      }
      if (page.isDone) {
        phase = "done";
        cursor = undefined;
      } else cursor = page.continueCursor;
    }
  } catch {
    const stale = await markStale(
      ctx,
      source,
      assessment,
      "detail_unavailable",
      now,
      {
        requestId: request.requestId,
        requestDigest,
        ordinal: request.ordinal,
        inputPhase: assessment.phase,
      },
    );
    return pageResult(stale._id, stale.lastPageResult!, false);
  }

  if (
    !countsAreValid(counts) ||
    ![accounted, queued, gap, review, ignored, unchanged].every((value) =>
      safeInteger(value),
    )
  ) {
    const stale = await markStale(
      ctx,
      source,
      assessment,
      "detail_unavailable",
      now,
      {
        requestId: request.requestId,
        requestDigest,
        ordinal: request.ordinal,
        inputPhase: assessment.phase,
      },
    );
    return pageResult(stale._id, stale.lastPageResult!, false);
  }

  const nextOrdinal = assessment.nextOrdinal + 1;
  if (!safeInteger(nextOrdinal)) throw workerProtocolError("scan_conflict");
  let state: AssessmentState = "running";
  let completedAt: number | undefined;
  if (phase === "done") {
    const finalReason = await currentFenceReason(ctx, source, assessment, now);
    if (finalReason) {
      const stale = await markStale(ctx, source, assessment, finalReason, now, {
        requestId: request.requestId,
        requestDigest,
        ordinal: request.ordinal,
        inputPhase: assessment.phase,
      });
      return pageResult(stale._id, stale.lastPageResult!, false);
    }
    if (
      accounted !== assessment.scanEntryCount ||
      queued !== assessment.scanChangedCount ||
      gap !== assessment.scanGapCount ||
      review !== assessment.scanReviewCount ||
      accounted !== queued + gap + review + ignored + unchanged
    ) {
      const stale = await markStale(
        ctx,
        source,
        assessment,
        "detail_unavailable",
        now,
        {
          requestId: request.requestId,
          requestDigest,
          ordinal: request.ordinal,
          inputPhase: assessment.phase,
        },
      );
      return pageResult(stale._id, stale.lastPageResult!, false);
    }
    state = terminalState(counts, assessment.scanStateAtStart);
    completedAt = now;
  }
  const result: NonNullable<Assessment["lastPageResult"]> = {
    state,
    phase,
    ordinal: request.ordinal,
    inspected,
    nextOrdinal,
    ...(completedAt === undefined ? {} : { counts, completedAt }),
  };
  try {
    await requireCommitHeadroom(ctx);
  } catch {
    const stale = await markStale(
      ctx,
      source,
      assessment,
      "detail_unavailable",
      now,
      {
        requestId: request.requestId,
        requestDigest,
        ordinal: request.ordinal,
        inputPhase: assessment.phase,
      },
    );
    return pageResult(stale._id, stale.lastPageResult!, false);
  }
  await ctx.db.patch(assessment._id, {
    state,
    phase,
    cursor,
    nextOrdinal,
    counts,
    accountedScanEntries: accounted,
    queuedScanEntries: queued,
    gapScanEntries: gap,
    reviewScanEntries: review,
    ignoredScanEntries: ignored,
    unchangedScanEntries: unchanged,
    lastPageRequestId: request.requestId,
    lastPageRequestDigest: requestDigest,
    lastPageInputPhase: assessment.phase,
    lastPageOrdinal: request.ordinal,
    lastPageResult: result,
    updatedAt: now,
    expiresAt: safeAdd(now, WORKER_ASSESSMENT_IDLE_MS),
    retireAt: safeAdd(now, WORKER_ASSESSMENT_RETENTION_MS),
    ...(completedAt === undefined
      ? {}
      : {
          completedAt,
          lastProcessedAtAtCompletion: sourceNumber(
            source.account.lastProcessedAt,
          ),
        }),
  });
  if (completedAt !== undefined) {
    await ctx.db.patch(source.account._id, {
      activeWorkerAssessmentId: undefined,
      latestWorkerAssessmentId: assessment._id,
    });
  }
  return pageResult(assessment._id, result, false);
}

export async function getProcessingAssessmentStatus(
  ctx: QueryCtx,
  source: LoadedWorkerSource,
  now: number,
): Promise<WorkerProcessingStatus> {
  if (source.account.activeWorkerAssessmentId) {
    const active = await ctx.db.get(source.account.activeWorkerAssessmentId);
    if (
      !active ||
      active.spaceId !== source.spaceId ||
      active.sourceAccountId !== source.account._id
    )
      throw workerProtocolError("scan_conflict");
    if (
      active.state === "running" &&
      !(await currentFenceReason(ctx, source, active, now))
    ) {
      return {
        state: "assessing",
        assessmentId: active._id,
        startedAt: active.startedAt,
      };
    }
  }
  if (!source.account.latestWorkerAssessmentId)
    return { state: "not_assessed" };
  const latest = await ctx.db.get(source.account.latestWorkerAssessmentId);
  if (
    !latest ||
    latest.spaceId !== source.spaceId ||
    latest.sourceAccountId !== source.account._id
  )
    throw workerProtocolError("scan_conflict");
  if (!isAssessmentSnapshotCurrent(source.account, latest))
    return { state: "not_assessed" };
  return {
    state: latest.state as "complete" | "incomplete",
    assessmentId: latest._id,
    scanId: latest.scanId,
    inventoryEpoch: latest.inventoryEpoch,
    manifestVersion: latest.manifestVersion,
    completedAt: latest.completedAt!,
    counts: latest.counts,
  };
}
