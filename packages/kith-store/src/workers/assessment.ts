import type {
  ProcessingAssessmentCounts,
  WorkerAssessmentBeginResult,
  WorkerAssessmentPageResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";
import {
  digestProcessingConfiguration,
  planInlineText,
  sha256Hex,
} from "../ingestion/inline.js";
import { newKithId, KITH_ID } from "../ids.js";
import {
  camelizeProcessingGeneration,
  camelizeSourceParserArtifact,
  camelizeSourceTextVersion,
  camelizeSourceItem,
  camelizeSourceRevision,
  loadCurrentArchiveBinding,
  loadProviderOriginalBinding,
  requireInlineSourceRevision,
  requireIndependentArchivePair,
  verifySealedParsedPayload,
  type SourceItemRow,
} from "../provenance/index.js";
import { requireArchiveReceiptChain } from "./archiveForget.js";
import { archiveSetDigest } from "./archivedDiscovery.js";
import {
  ensureSameActor,
  requireOriginalActor,
  requireWorkerSourceAccount,
  type LoadedWorkerSource,
} from "./auth.js";
import { decodeCursor, keysetPage, keysetTail } from "./cursor.js";
import { at, exec, nowPlus, row, rows, type WorkerCtx } from "./db.js";
import {
  isWorkerTransactionAbort,
  WorkerProtocolError,
  workerProtocolError,
} from "./errors.js";
import {
  countsWithReasons,
  incrementReason,
  reasonSink,
  readNotReadyReasons,
  stagedReason,
  type NotReadyReason,
  type NotReadyReasons,
  type ReasonStage,
} from "./notReady.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import { artifactBoundExtractionFingerprint } from "./entries.js";
import { FS_TEXT_PROFILE } from "./profile.js";
import { requireProviderOriginalReferenceChain } from "./providerOriginalForget.js";
import {
  camelizeAssessment,
  camelizeDiscoveryWork,
  camelizeIngestJob,
  camelizeScan,
  camelizeScanEntry,
  camelizeSourceAccount,
  type WorkerProcessingAssessmentRow,
  type WorkerScanEntryRow,
} from "./rows.js";

export const WORKER_ASSESSMENT_IDLE_MS = 30 * 60 * 1_000;
export const WORKER_ASSESSMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

type AssessmentPhase = "items" | "unresolved_entries" | "done";
type StaleReason = "source_changed" | "detail_unavailable" | "expired";
type Proof =
  | "queuedScanEntries"
  | "gapScanEntries"
  | "reviewScanEntries"
  | "ignoredScanEntries"
  | "unchangedScanEntries";
type ItemBucket = keyof ProcessingAssessmentCounts["items"];
type StoredPage = Omit<
  WorkerAssessmentPageResult,
  "operation" | "assessmentId" | "reused"
>;

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sourceTime(value: Date | null): number {
  return value?.getTime() ?? 0;
}

function emptyCounts(): ProcessingAssessmentCounts {
  return {
    items: {
      ready: 0,
      pending: 0,
      failed: 0,
      parked: 0,
      needsReview: 0,
      explicitGap: 0,
      unavailable: 0,
      ignoredForgotten: 0,
    },
    unresolvedEntries: { needsReview: 0, ignoredForgotten: 0 },
  };
}

/**
 * The protocol-shaped counts, rebuilt field by field. Rebuilding rather than
 * casting is what keeps a stored extra key (today `notReadyReasons`, see
 * `notReady.ts`) out of every response: the worker's own parser refuses a
 * `counts` object carrying any key beyond `items` and `unresolvedEntries`
 * (`packages/pipeline/src/transport.ts`), so every reader of an assessment's
 * `counts` column must come through here rather than cast the row value.
 */
export function normalizedCounts(
  value: Record<string, unknown> | null,
): ProcessingAssessmentCounts | null {
  if (
    !value ||
    typeof value.items !== "object" ||
    value.items === null ||
    typeof value.unresolvedEntries !== "object" ||
    value.unresolvedEntries === null
  )
    return null;
  const items = value.items as Record<string, unknown>;
  const unresolved = value.unresolvedEntries as Record<string, unknown>;
  const counts: ProcessingAssessmentCounts = {
    items: {
      ready: items.ready as number,
      pending: items.pending as number,
      failed: items.failed as number,
      parked: (items.parked ?? 0) as number,
      needsReview: items.needsReview as number,
      explicitGap: items.explicitGap as number,
      unavailable: items.unavailable as number,
      ignoredForgotten: items.ignoredForgotten as number,
    },
    unresolvedEntries: {
      needsReview: unresolved.needsReview as number,
      ignoredForgotten: unresolved.ignoredForgotten as number,
    },
  };
  return [
    counts.items.ready,
    counts.items.pending,
    counts.items.failed,
    counts.items.parked,
    counts.items.needsReview,
    counts.items.explicitGap,
    counts.items.unavailable,
    counts.items.ignoredForgotten,
    counts.unresolvedEntries.needsReview,
    counts.unresolvedEntries.ignoredForgotten,
  ].every(safeInteger)
    ? counts
    : null;
}

function readCounts(
  value: Record<string, unknown> | null,
): ProcessingAssessmentCounts {
  return normalizedCounts(value) ?? workerProtocolError("scan_conflict");
}

function countsEqual(
  leftValue: Record<string, unknown> | null,
  rightValue: Record<string, unknown> | null,
): boolean {
  const left = normalizedCounts(leftValue);
  const right = normalizedCounts(rightValue);
  return Boolean(
    left &&
    right &&
    left.items.ready === right.items.ready &&
    left.items.pending === right.items.pending &&
    left.items.failed === right.items.failed &&
    left.items.parked === right.items.parked &&
    left.items.needsReview === right.items.needsReview &&
    left.items.explicitGap === right.items.explicitGap &&
    left.items.unavailable === right.items.unavailable &&
    left.items.ignoredForgotten === right.items.ignoredForgotten &&
    left.unresolvedEntries.needsReview ===
      right.unresolvedEntries.needsReview &&
    left.unresolvedEntries.ignoredForgotten ===
      right.unresolvedEntries.ignoredForgotten,
  );
}

function incrementItem(
  counts: ProcessingAssessmentCounts,
  bucket: ItemBucket,
): ProcessingAssessmentCounts {
  return {
    ...counts,
    items: { ...counts.items, [bucket]: counts.items[bucket] + 1 },
  };
}

async function digest(domain: string, value: unknown): Promise<string> {
  return sha256Hex(`${domain}\0${JSON.stringify(value)}`);
}

async function lockSource(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
): Promise<LoadedWorkerSource> {
  const raw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_accounts WHERE id = $1 FOR UPDATE",
    [source.account.id],
  );
  if (!raw) workerProtocolError("not_authorized");
  const account = camelizeSourceAccount(raw);
  if (account.spaceId !== source.spaceId) workerProtocolError("not_found");
  return { ...source, account };
}

function scanCountersValid(scan: ReturnType<typeof camelizeScan>): boolean {
  return (
    [scan.entryCount, scan.changedCount, scan.gapCount, scan.reviewCount].every(
      safeInteger,
    ) && scan.entryCount >= scan.changedCount + scan.gapCount + scan.reviewCount
  );
}

function snapshotCurrent(
  source: LoadedWorkerSource,
  assessment: WorkerProcessingAssessmentRow,
): boolean {
  return (
    assessment.spaceId === source.spaceId &&
    assessment.sourceAccountId === source.account.id &&
    assessment.inventoryEpoch === (source.account.inventoryEpoch ?? 0) &&
    assessment.completedInventoryEpoch ===
      (source.account.completedInventoryEpoch ?? 0) &&
    assessment.manifestVersion === (source.account.manifestVersion ?? 0) &&
    assessment.assessmentEpoch ===
      (source.account.workerAssessmentEpoch ?? 0) &&
    sourceTime(assessment.coverageInvalidatedAt) ===
      sourceTime(source.account.coverageInvalidatedAt) &&
    sourceTime(assessment.lastEnumeratedAt) ===
      sourceTime(source.account.lastEnumeratedAt)
  );
}

async function currentFenceReason(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  assessment: WorkerProcessingAssessmentRow,
): Promise<StaleReason | null> {
  if (assessment.expiresAt.getTime() <= ctx.now) return "expired";
  if (
    assessment.state !== "running" ||
    source.account.activeWorkerAssessmentId !== assessment.id ||
    !snapshotCurrent(source, assessment) ||
    sourceTime(assessment.lastProcessedAtAtStart) !==
      sourceTime(source.account.lastProcessedAt)
  )
    return "source_changed";
  const scanRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_source_scans WHERE id = $1",
    [assessment.scanId],
  );
  if (!scanRaw) return "detail_unavailable";
  const scan = camelizeScan(scanRaw);
  return scan.spaceId === assessment.spaceId &&
    scan.sourceAccountId === assessment.sourceAccountId &&
    scan.state === assessment.scanStateAtStart &&
    scan.completedAt?.getTime() === sourceTime(assessment.scanCompletedAt) &&
    scan.inventoryEpoch === assessment.inventoryEpoch &&
    scan.reconcileManifestVersion === assessment.manifestVersion &&
    scan.entryCount === assessment.scanEntryCount &&
    scan.changedCount === assessment.scanChangedCount &&
    scan.gapCount === assessment.scanGapCount &&
    scan.reviewCount === assessment.scanReviewCount
    ? null
    : "source_changed";
}

function beginResult(
  assessment: WorkerProcessingAssessmentRow,
  reused: boolean,
): WorkerAssessmentBeginResult {
  return {
    operation: "processing.assessBegin",
    assessmentId: assessment.id,
    scanId: assessment.scanId,
    inventoryEpoch: assessment.inventoryEpoch,
    manifestVersion: assessment.manifestVersion,
    state: assessment.state,
    nextOrdinal: assessment.nextOrdinal,
    ...(assessment.state === "complete" || assessment.state === "incomplete"
      ? {
          counts: readCounts(assessment.counts),
          completedAt: assessment.completedAt!.getTime(),
        }
      : {}),
    ...(assessment.state === "stale"
      ? {
          staleReason: (assessment.staleReason ??
            "detail_unavailable") as StaleReason,
        }
      : {}),
    reused,
  };
}

function pageResult(
  assessmentId: string,
  result: StoredPage,
  reused: boolean,
): WorkerAssessmentPageResult {
  const { counts, ...rest } = result;
  return {
    operation: "processing.assessPage",
    assessmentId,
    ...rest,
    ...(counts === undefined
      ? {}
      : { counts: readCounts(counts as unknown as Record<string, unknown>) }),
    reused,
  };
}

function validStoredPage(
  assessment: WorkerProcessingAssessmentRow,
  value: Record<string, unknown> | null,
): value is StoredPage {
  if (!value) return false;
  const terminal =
    assessment.state === "complete" || assessment.state === "incomplete";
  return (
    value.state === assessment.state &&
    value.phase === assessment.phase &&
    value.ordinal === assessment.lastPageOrdinal &&
    value.nextOrdinal === assessment.nextOrdinal &&
    safeInteger(value.ordinal) &&
    safeInteger(value.nextOrdinal) &&
    safeInteger(value.inspected) &&
    (assessment.state === "running"
      ? value.phase !== "done" &&
        value.counts === undefined &&
        value.completedAt === undefined
      : assessment.state === "stale"
        ? value.phase === "done" &&
          value.inspected === 0 &&
          ["source_changed", "detail_unavailable", "expired"].includes(
            String(value.staleReason),
          )
        : terminal &&
          value.phase === "done" &&
          value.completedAt === assessment.completedAt?.getTime() &&
          typeof value.counts === "object" &&
          value.counts !== null &&
          countsEqual(
            value.counts as Record<string, unknown>,
            assessment.counts,
          ))
  );
}

async function markStale(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  assessment: WorkerProcessingAssessmentRow,
  reason: StaleReason,
  replay?: {
    requestId: string;
    requestDigest: string;
    ordinal: number;
    inputPhase: Exclude<AssessmentPhase, "done">;
  },
): Promise<WorkerProcessingAssessmentRow> {
  const stored: StoredPage | null = replay
    ? {
        state: "stale",
        phase: "done",
        ordinal: replay.ordinal,
        inspected: 0,
        nextOrdinal: assessment.nextOrdinal,
        staleReason: reason,
      }
    : null;
  await exec(
    ctx,
    `UPDATE kith.worker_processing_assessments SET
       state = 'stale', stale_reason = $2, phase = 'done', cursor = NULL,
       updated_at = $3, expires_at = $3, retire_at = $4,
       last_page_request_id = COALESCE($5, last_page_request_id),
       last_page_request_digest = COALESCE($6, last_page_request_digest),
       last_page_input_phase = COALESCE($7, last_page_input_phase),
       last_page_ordinal = COALESCE($8, last_page_ordinal),
       last_page_result = COALESCE($9::jsonb, last_page_result)
     WHERE id = $1`,
    [
      assessment.id,
      reason,
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_ASSESSMENT_RETENTION_MS)),
      replay?.requestId ?? null,
      replay?.requestDigest ?? null,
      replay?.inputPhase ?? null,
      replay?.ordinal ?? null,
      stored ? JSON.stringify(stored) : null,
    ],
  );
  if (source.account.activeWorkerAssessmentId === assessment.id) {
    await exec(
      ctx,
      "UPDATE kith.source_accounts SET active_worker_assessment_id = NULL WHERE id = $1 AND active_worker_assessment_id = $2",
      [source.account.id, assessment.id],
    );
    source.account.activeWorkerAssessmentId = null;
  }
  const raw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_processing_assessments WHERE id = $1",
    [assessment.id],
  );
  if (!raw) workerProtocolError("scan_conflict");
  return camelizeAssessment(raw);
}

export async function beginProcessingAssessment(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "processing.assessBegin" }>,
): Promise<WorkerAssessmentBeginResult> {
  let source = await requireWorkerSourceAccount(ctx, principal, request);
  source = await lockSource(ctx, source);
  const requestDigest = await digest("worker-processing-assess-begin:v1", [
    source.account.id,
    request.requestId,
    request.scanId,
    request.expectedInventoryEpoch,
    request.expectedManifestVersion,
  ]);
  const priorRows = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_processing_assessments
     WHERE source_account_id = $1 AND request_id = $2 LIMIT 2 FOR UPDATE`,
    [source.account.id, request.requestId],
  );
  if (priorRows.length > 1) workerProtocolError("scan_conflict");
  if (priorRows[0]) {
    let prior = camelizeAssessment(priorRows[0]);
    ensureSameActor(source.principal, prior);
    if (prior.requestDigest !== requestDigest)
      workerProtocolError("request_conflict");
    if (prior.state === "running") {
      const reason = await currentFenceReason(ctx, source, prior);
      if (reason) prior = await markStale(ctx, source, prior, reason);
    } else if (
      (prior.state === "complete" || prior.state === "incomplete") &&
      (!snapshotCurrent(source, prior) ||
        prior.lastProcessedAtAtCompletion?.getTime() !==
          sourceTime(source.account.lastProcessedAt))
    ) {
      prior = await markStale(ctx, source, prior, "source_changed");
    }
    return beginResult(prior, true);
  }
  if (
    ![
      source.account.inventoryEpoch ?? 0,
      source.account.completedInventoryEpoch ?? 0,
      source.account.manifestVersion ?? 0,
      source.account.workerAssessmentEpoch ?? 0,
    ].every(safeInteger)
  )
    workerProtocolError("scan_conflict");
  if (
    request.expectedInventoryEpoch !== (source.account.inventoryEpoch ?? 0) ||
    request.expectedManifestVersion !== (source.account.manifestVersion ?? 0)
  )
    workerProtocolError("stale_observation");
  if (!KITH_ID.test(request.scanId)) workerProtocolError("invalid_request");
  const scanRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_source_scans WHERE id = $1 FOR UPDATE",
    [request.scanId],
  );
  if (!scanRaw) workerProtocolError("not_found");
  const scan = camelizeScan(scanRaw);
  if (
    scan.spaceId !== source.spaceId ||
    scan.sourceAccountId !== source.account.id
  )
    workerProtocolError("not_found");
  if (
    (scan.state !== "enumerated" && scan.state !== "needs_review") ||
    !scan.completedAt ||
    scan.inventoryEpoch !== request.expectedInventoryEpoch ||
    (scan.state === "enumerated" &&
      scan.inventoryEpoch !== (source.account.completedInventoryEpoch ?? 0)) ||
    scan.reconcileManifestVersion !== request.expectedManifestVersion ||
    source.account.activeWorkerScanId !== null ||
    !scanCountersValid(scan)
  )
    workerProtocolError("scan_not_ready");
  if (source.account.activeWorkerAssessmentId) {
    const activeRaw = await row<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.worker_processing_assessments WHERE id = $1 FOR UPDATE",
      [source.account.activeWorkerAssessmentId],
    );
    if (!activeRaw) workerProtocolError("scan_conflict");
    const active = camelizeAssessment(activeRaw);
    if (
      active.spaceId !== source.spaceId ||
      active.sourceAccountId !== source.account.id
    )
      workerProtocolError("scan_conflict");
    if (active.state === "running") {
      const reason = await currentFenceReason(ctx, source, active);
      if (!reason) workerProtocolError("scan_conflict");
      await markStale(ctx, source, active, reason);
    } else {
      await exec(
        ctx,
        "UPDATE kith.source_accounts SET active_worker_assessment_id = NULL WHERE id = $1",
        [source.account.id],
      );
      source.account.activeWorkerAssessmentId = null;
    }
  }
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const id = newKithId();
  const counts = emptyCounts();
  await exec(
    ctx,
    `INSERT INTO kith.worker_processing_assessments
     (id, space_id, source_account_id, scan_id, request_id, request_digest,
      actor_user_id, actor_credential_id, inventory_epoch,
      completed_inventory_epoch, manifest_version, assessment_epoch,
      coverage_invalidated_at, last_enumerated_at, last_processed_at_at_start,
      scan_completed_at, scan_state_at_start, scan_entry_count,
      scan_changed_count, scan_gap_count, scan_review_count, state, phase,
      next_ordinal, counts, accounted_scan_entries, queued_scan_entries,
      gap_scan_entries, review_scan_entries, ignored_scan_entries,
      unchanged_scan_entries, started_at, updated_at, expires_at, retire_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
      $18,$19,$20,$21,'running','items',0,$22::jsonb,0,0,0,0,0,0,$23,$23,$24,$25)`,
    [
      id,
      source.spaceId,
      source.account.id,
      scan.id,
      request.requestId,
      requestDigest,
      source.principal.userId,
      source.principal.credentialId,
      request.expectedInventoryEpoch,
      source.account.completedInventoryEpoch ?? 0,
      request.expectedManifestVersion,
      source.account.workerAssessmentEpoch ?? 0,
      at(sourceTime(source.account.coverageInvalidatedAt)),
      at(sourceTime(source.account.lastEnumeratedAt)),
      at(sourceTime(source.account.lastProcessedAt)),
      scan.completedAt,
      scan.state,
      scan.entryCount,
      scan.changedCount,
      scan.gapCount,
      scan.reviewCount,
      JSON.stringify(counts),
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_ASSESSMENT_IDLE_MS)),
      at(nowPlus(ctx.now, WORKER_ASSESSMENT_RETENTION_MS)),
    ],
  );
  await exec(
    ctx,
    "UPDATE kith.source_accounts SET active_worker_assessment_id = $2 WHERE id = $1",
    [source.account.id, id],
  );
  const raw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_processing_assessments WHERE id = $1",
    [id],
  );
  if (!raw) workerProtocolError("scan_conflict");
  return beginResult(camelizeAssessment(raw), false);
}

function proofForEntry(entry: WorkerScanEntryRow): Proof {
  return entry.state === "queued"
    ? "queuedScanEntries"
    : entry.state === "gap"
      ? "gapScanEntries"
      : entry.state === "needs_review"
        ? "reviewScanEntries"
        : entry.state === "ignored_forgotten"
          ? "ignoredScanEntries"
          : "unchangedScanEntries";
}

async function exactEntry(
  ctx: WorkerCtx,
  assessment: WorkerProcessingAssessmentRow,
  item: SourceItemRow,
): Promise<WorkerScanEntryRow | null> {
  const found = await rows<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_scan_entries WHERE scan_id = $1 AND source_item_id = $2 LIMIT 2",
    [assessment.scanId, item.id],
  );
  if (found.length > 1) workerProtocolError("scan_conflict");
  if (!found[0]) return null;
  const entry = camelizeScanEntry(found[0]);
  const page = await row<{
    id: string;
    space_id: string;
    source_account_id: string;
    scan_id: string;
  }>(
    ctx,
    "SELECT id, space_id, source_account_id, scan_id FROM kith.worker_scan_pages WHERE id = $1",
    [entry.scanPageId],
  );
  if (
    entry.spaceId !== assessment.spaceId ||
    entry.sourceAccountId !== assessment.sourceAccountId ||
    entry.scanId !== assessment.scanId ||
    !page ||
    page.space_id !== assessment.spaceId ||
    page.source_account_id !== assessment.sourceAccountId ||
    page.scan_id !== assessment.scanId
  )
    workerProtocolError("scan_conflict");
  return entry;
}

async function inlineEntryDigests(
  item: SourceItemRow,
  entry: WorkerScanEntryRow,
) {
  if (!item.externalId || !item.uri || !entry.contentHash) return null;
  const externalIdHash = await sha256Hex(item.externalId);
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
  return {
    externalIdHash,
    uriDigest,
    processingIdentityDigest,
    inventoryMetadataDigest: await digest("worker-fs-inventory-metadata:v1", [
      externalIdHash,
      uriDigest,
      item.title ?? null,
      item.docType ?? null,
      entry.sourceModifiedAt.getTime(),
      "ready",
      entry.contentHash,
      entry.byteLength,
      null,
      FS_TEXT_PROFILE.profileId,
    ]),
  };
}

/**
 * The shared preconditions of `terminalReady`, split only so a failure can
 * name which group disagreed. The conditions and their order are exactly the
 * single `if` this replaced, so the boolean answer is unchanged.
 */
function itemPreconditionReason(
  assessment: WorkerProcessingAssessmentRow,
  item: SourceItemRow,
  entry: WorkerScanEntryRow,
): NotReadyReason | null {
  if (item.lifecycle !== "available" || item.lastFailure !== null)
    return "item_state";
  if (
    item.workerLastSeenInventoryEpoch !== assessment.inventoryEpoch ||
    item.workerObservationEpoch !== entry.observationEpoch ||
    item.workerProcessingEpoch !== entry.processingEpoch
  )
    return "item_epoch_mismatch";
  if (
    item.workerContentHash !== entry.contentHash ||
    item.workerSourceModifiedAt?.getTime() !== entry.sourceModifiedAt.getTime()
  )
    return "content_hash_mismatch";
  if (
    !item.desiredRevisionId ||
    item.activeRevisionId !== item.desiredRevisionId ||
    !item.activeGenerationId
  )
    return "revision_not_active";
  if (
    !safeInteger(item.desiredProcessingEpoch) ||
    !safeInteger(entry.observationEpoch) ||
    !safeInteger(entry.processingEpoch) ||
    !safeInteger(entry.byteLength)
  )
    return "epoch_not_integer";
  return null;
}

type BinaryFingerprints = {
  parser: string;
  extraction: string;
  extractor: string;
  recordSchema: string;
  normalization: string;
  chunker: string;
  correctionRevision: string;
};

/**
 * The seven per-entry fingerprints the archived-binary path needs, or which
 * one was missing. Same conditions and same order as the single `if` this
 * replaced; it also does the narrowing that `if` used to do.
 */
function binaryFingerprints(
  entry: WorkerScanEntryRow,
): BinaryFingerprints | NotReadyReason {
  if (!entry.parserFingerprint) return "fingerprint_mismatch:parser";
  if (!entry.extractionConfigurationFingerprint)
    return "fingerprint_mismatch:extraction";
  if (!entry.extractorFingerprint) return "fingerprint_mismatch:extractor";
  if (!entry.recordSchemaFingerprint)
    return "fingerprint_mismatch:record_schema";
  if (!entry.normalizationFingerprint)
    return "fingerprint_mismatch:normalization";
  if (!entry.chunkerFingerprint) return "fingerprint_mismatch:chunker";
  if (!entry.correctionRevision) return "fingerprint_mismatch:correction";
  return {
    parser: entry.parserFingerprint,
    extraction: entry.extractionConfigurationFingerprint,
    extractor: entry.extractorFingerprint,
    recordSchema: entry.recordSchemaFingerprint,
    normalization: entry.normalizationFingerprint,
    chunker: entry.chunkerFingerprint,
    correctionRevision: entry.correctionRevision,
  };
}

/**
 * Runs one loader and, if it throws, names the stage and the kind of error
 * before rethrowing it unchanged.
 *
 * Rethrowing is what keeps this diagnostic: the caller's behaviour is exactly
 * what it was when the whole region shared one catch, because every throw
 * still reaches that catch. The sink keeps the first reason, so the stage
 * recorded here wins over the fallback the outer catch would record.
 */
async function staged<T>(
  note: (reason: NotReadyReason) => void,
  stage: ReasonStage,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isWorkerTransactionAbort(error)) throw error;
    note(stagedReason(stage, error));
    throw error;
  }
}

/**
 * `note` receives the first condition group that refused the item. It is
 * diagnostic: no branch below changes because of it, and the returned boolean
 * is the same one this function returned before reasons existed.
 */
async function terminalReady(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  assessment: WorkerProcessingAssessmentRow,
  item: SourceItemRow,
  entry: WorkerScanEntryRow,
  note: (reason: NotReadyReason) => void,
): Promise<boolean> {
  const no = (reason: NotReadyReason): false => {
    note(reason);
    return false;
  };
  const precondition = itemPreconditionReason(assessment, item, entry);
  if (precondition) return no(precondition);
  // Each read is staged with the row it is for, so a database fault or a row
  // the camelizer refuses names the table rather than the whole region.
  const revisionRaw = await staged(note, "row_parse_error:revision", async () =>
    row<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.source_revisions WHERE id=$1",
      [item.desiredRevisionId],
    ),
  );
  const generationRaw = await staged(
    note,
    "row_parse_error:generation",
    async () =>
      row<Record<string, unknown>>(
        ctx,
        "SELECT * FROM kith.processing_generations WHERE id=$1",
        [item.activeGenerationId],
      ),
  );
  const jobRows = await staged(note, "row_parse_error:job", async () =>
    rows<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.ingest_jobs WHERE processing_generation_id=$1 LIMIT 2",
      [item.activeGenerationId],
    ),
  );
  if (!revisionRaw || !generationRaw) return no("detail_missing");
  if (jobRows.length !== 1) return no("job_count");
  const revision = await staged(note, "row_parse_error:revision", async () =>
    camelizeSourceRevision(revisionRaw),
  );
  const generation = await staged(
    note,
    "row_parse_error:generation",
    async () => camelizeProcessingGeneration(generationRaw),
  );
  const job = await staged(note, "row_parse_error:job", async () =>
    camelizeIngestJob(jobRows[0]!),
  );
  if (
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== item.id ||
    generation.spaceId !== source.spaceId ||
    generation.sourceAccountId !== source.account.id ||
    generation.sourceItemId !== item.id ||
    generation.sourceRevisionId !== revision.id ||
    generation.desiredProcessingEpoch !== item.desiredProcessingEpoch ||
    generation.state !== "ready" ||
    !generation.activatedAt ||
    generation.deactivatedAt !== null
  )
    return no("generation_shape");
  if (
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account.id ||
    job.sourceItemId !== item.id ||
    job.sourceRevisionId !== revision.id ||
    job.processingGenerationId !== generation.id ||
    job.desiredProcessingEpoch !== item.desiredProcessingEpoch ||
    job.workerManaged !== true ||
    job.state !== "ready" ||
    job.leaseToken !== null ||
    job.leaseExpiresAt !== null ||
    job.workerLeaseOwnerCredentialId !== null ||
    job.nextAttemptAt !== null ||
    job.error !== null
  )
    return no("job_shape");
  if (entry.contentRepresentation === "archived_binary_v1") {
    if (
      revision.representation !== "archived_binary_v1" ||
      revision.contentHashAuthority !== "worker_asserted" ||
      revision.contentHash !== entry.contentHash ||
      revision.byteLength !== entry.byteLength ||
      revision.mediaType !== entry.binaryMediaType
    )
      return no("revision_shape");
    if (
      !generation.sourceTextVersionId ||
      !generation.parserArtifactId ||
      !generation.archiveSetDigest ||
      !generation.normalizedBundleDigest ||
      !generation.payloadManifestId ||
      !generation.parserPrimaryReceiptId
    )
      return no("generation_shape");
    if (item.workerProfileId !== entry.binaryParserProfileId)
      return no("profile_mismatch");
    const fingerprints = binaryFingerprints(entry);
    if (typeof fingerprints === "string") return no(fingerprints);
    if (
      Boolean(generation.originalBackupReceiptId) ===
        Boolean(generation.originalProviderReferenceId) ||
      (generation.originalProviderReferenceId !== null &&
        !safeInteger(generation.originalProviderBindingEpoch))
    )
      return no("archive_selection");
    try {
      const artifactRaw = await staged(
        note,
        "row_parse_error:parser_artifact",
        async () =>
          row<Record<string, unknown>>(
            ctx,
            "SELECT * FROM kith.source_parser_artifacts WHERE id=$1",
            [generation.parserArtifactId],
          ),
      );
      const textRaw = await staged(
        note,
        "row_parse_error:text_version",
        async () =>
          row<Record<string, unknown>>(
            ctx,
            "SELECT * FROM kith.source_text_versions WHERE id=$1",
            [generation.sourceTextVersionId],
          ),
      );
      if (!artifactRaw || !textRaw) return no("artifact_missing");
      const artifact = await staged(
        note,
        "row_parse_error:parser_artifact",
        async () => camelizeSourceParserArtifact(artifactRaw),
      );
      const text = await staged(
        note,
        "row_parse_error:text_version",
        async () => camelizeSourceTextVersion(textRaw),
      );
      const [expectedExtraction, expectedProcessing] = await staged(
        note,
        "fingerprint_digest_error",
        async () => {
          const extraction = await artifactBoundExtractionFingerprint(
            artifact.parserFingerprint,
            artifact.outputHash,
            fingerprints.extraction,
          );
          return [
            extraction,
            await digestProcessingConfiguration({
              extractionFingerprint: extraction,
              extractorFingerprint: fingerprints.extractor,
              recordSchemaFingerprint: fingerprints.recordSchema,
              normalizationFingerprint: fingerprints.normalization,
              chunkerFingerprint: fingerprints.chunker,
              correctionRevision: fingerprints.correctionRevision,
            }),
          ] as const;
        },
      );
      if (
        artifact.spaceId !== source.spaceId ||
        artifact.sourceAccountId !== source.account.id ||
        artifact.sourceItemId !== item.id ||
        artifact.sourceRevisionId !== revision.id ||
        artifact.parserFingerprint !== entry.parserFingerprint ||
        text.spaceId !== source.spaceId ||
        text.sourceRevisionId !== revision.id ||
        text.parserArtifactId !== artifact.id ||
        text.representation !== "parsed_pages_v1" ||
        text.evidenceSealed !== true ||
        text.textHashAuthority !== "server_verified_retained_text"
      )
        return no("text_version_shape");
      if (
        text.extractionFingerprint !== expectedExtraction ||
        generation.extractionFingerprint !== expectedExtraction ||
        generation.processingFingerprint !== expectedProcessing ||
        generation.extractorFingerprint !== entry.extractorFingerprint ||
        generation.recordSchemaFingerprint !== entry.recordSchemaFingerprint ||
        generation.normalizationFingerprint !==
          entry.normalizationFingerprint ||
        generation.chunkerFingerprint !== entry.chunkerFingerprint ||
        generation.correctionRevision !== entry.correctionRevision
      )
        return no("fingerprint_mismatch:derived");

      const subject = {
        spaceId: source.spaceId,
        sourceAccountId: source.account.id,
        sourceItemId: item.id,
        sourceRevisionId: revision.id,
      };
      const originalPrimary = await staged(
        note,
        "binding_load_error:original_bytes/primary",
        async () =>
          loadCurrentArchiveBinding(ctx.client, {
            ...subject,
            subjectKind: "original_bytes",
            copyRole: "primary",
          }),
      );
      const originalBackup = await staged(
        note,
        "binding_load_error:original_bytes/independent_backup",
        async () =>
          loadCurrentArchiveBinding(ctx.client, {
            ...subject,
            subjectKind: "original_bytes",
            copyRole: "independent_backup",
          }),
      );
      const provider = await staged(
        note,
        "provider_binding_load_error",
        async () => loadProviderOriginalBinding(ctx.client, revision.id),
      );
      const parserPrimary = await staged(
        note,
        "binding_load_error:parser_output/primary",
        async () =>
          loadCurrentArchiveBinding(ctx.client, {
            ...subject,
            parserArtifactId: artifact.id,
            subjectKind: "parser_output",
            copyRole: "primary",
          }),
      );
      const parserBackup = await staged(
        note,
        "binding_load_error:parser_output/independent_backup",
        async () =>
          loadCurrentArchiveBinding(ctx.client, {
            ...subject,
            parserArtifactId: artifact.id,
            subjectKind: "parser_output",
            copyRole: "independent_backup",
          }),
      );
      if (!parserPrimary) return no("binding_missing:parser/primary");
      const providerV2 = provider?.reference.referenceVersion === "provider_original_v2";
      if (
        providerV2
          ? Boolean(originalPrimary || originalBackup || parserBackup)
          : !originalPrimary ||
            !parserBackup ||
            Boolean(originalBackup) === Boolean(provider)
      )
        return no(
          providerV2
            ? "archive_selection"
            : !originalPrimary
              ? "binding_missing:original/primary"
              : !parserBackup
                ? "binding_missing:parser/backup"
                : originalBackup
                  ? "binding_missing:original/backup"
                  : "binding_missing:provider",
        );
      await staged(note, "receipt_chain", async () => {
        if (originalPrimary)
          await requireArchiveReceiptChain(ctx, source, item, originalPrimary.receipt);
        await requireArchiveReceiptChain(
          ctx,
          source,
          item,
          parserPrimary.receipt,
        );
        if (parserBackup)
          await requireArchiveReceiptChain(ctx, source, item, parserBackup.receipt);
        if (originalBackup)
          await requireArchiveReceiptChain(
            ctx,
            source,
            item,
            originalBackup.receipt,
          );
      });
      if (provider)
        await staged(note, "provider_reference_load_error", async () =>
          requireProviderOriginalReferenceChain(
            ctx,
            source,
            item,
            provider.reference,
          ),
        );
      await staged(note, "archive_independence", async () => {
        if (parserBackup)
          requireIndependentArchivePair(parserPrimary.receipt, parserBackup.receipt);
        if (originalPrimary && originalBackup)
          requireIndependentArchivePair(
            originalPrimary.receipt,
            originalBackup.receipt,
          );
      });
      const archiveSet = await staged(
        note,
        "archive_set_digest_error",
        async () =>
          archiveSetDigest(
            originalPrimary,
            originalBackup,
            provider
              ? {
                  reference: provider.reference,
                  bindingEpoch: provider.binding.bindingEpoch,
                }
              : null,
            parserPrimary,
            parserBackup,
          ),
      );
      if (
        generation.archiveSetDigest !== archiveSet ||
        generation.originalPrimaryReceiptId !== (originalPrimary?.receipt.id ?? null) ||
        generation.originalBackupReceiptId !==
          (originalBackup?.receipt.id ?? null) ||
        generation.originalProviderReferenceId !==
          (provider?.reference.id ?? null) ||
        generation.originalProviderBindingEpoch !==
          (provider?.binding.bindingEpoch ?? null) ||
        generation.parserPrimaryReceiptId !== parserPrimary.receipt.id ||
        generation.parserBackupReceiptId !== (parserBackup?.receipt.id ?? null)
      )
        return no(
          generation.archiveSetDigest !== archiveSet
            ? "archive_set_digest_mismatch"
            : "generation_receipt_mismatch",
        );
      // The verifier names the check that refused before it throws. The sink
      // keeps the first reason, so that detail wins over the `scan_conflict`
      // code the stage would otherwise record on its own.
      const verified = await staged(note, "payload_verify_error", async () =>
        verifySealedParsedPayload(ctx.client, generation, (detail) =>
          note(`payload_verify_error:${detail}`),
        ),
      );
      return (
        generation.actualPageCount === verified.actualPageCount &&
        generation.actualEvidenceSpanCount ===
          verified.actualEvidenceSpanCount &&
        generation.actualDocumentCount === verified.actualDocumentCount &&
        generation.actualChunkCount === verified.actualChunkCount
      ) || no("sealed_payload_counts");
    } catch (error) {
      if (isWorkerTransactionAbort(error)) throw error;
      return no("archive_chain_error");
    }
  }
  if (
    entry.contentRepresentation !== "inline_utf8_v1" ||
    item.workerProfileId !== FS_TEXT_PROFILE.profileId
  )
    return no("profile_mismatch");
  const calculated = await inlineEntryDigests(item, entry);
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
    return no("inline_digest_mismatch");
  let text: string;
  try {
    text = requireInlineSourceRevision(revision).text;
  } catch {
    return no("inline_text_missing");
  }
  const plan = planInlineText(text);
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
    extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
    recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
    normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
    chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
    correctionRevision: `filesystem-observation-v1:${entry.processingEpoch}`,
  });
  if (
    !(
      revision.contentHash === entry.contentHash &&
      revision.byteLength === entry.byteLength &&
      revision.contentHash === (await sha256Hex(text)) &&
      revision.byteLength === Buffer.byteLength(text, "utf8") &&
      revision.mediaType === FS_TEXT_PROFILE.mediaType
    )
  )
    return no("inline_text_rehash");
  if (
    !(
      generation.processingFingerprint === processingFingerprint &&
      generation.extractionFingerprint ===
        FS_TEXT_PROFILE.extractionFingerprint &&
      generation.extractorFingerprint ===
        FS_TEXT_PROFILE.extractorFingerprint &&
      generation.recordSchemaFingerprint ===
        FS_TEXT_PROFILE.recordSchemaFingerprint &&
      generation.normalizationFingerprint ===
        FS_TEXT_PROFILE.normalizationFingerprint &&
      generation.chunkerFingerprint === FS_TEXT_PROFILE.chunkerFingerprint &&
      generation.correctionRevision ===
        `filesystem-observation-v1:${entry.processingEpoch}`
    )
  )
    return no("fingerprint_mismatch:inline");
  return (
    (generation.expectedPageCount === plan.expectedPageCount &&
    generation.expectedEvidenceSpanCount === plan.expectedEvidenceSpanCount &&
    generation.expectedDocumentCount === plan.expectedDocumentCount &&
    generation.expectedChunkCount === plan.expectedChunkCount &&
    generation.actualPageCount === generation.expectedPageCount &&
    generation.actualEvidenceSpanCount ===
      generation.expectedEvidenceSpanCount &&
    generation.actualDocumentCount === generation.expectedDocumentCount &&
    generation.actualChunkCount === generation.expectedChunkCount &&
    generation.expectedEventCount === 0 &&
    generation.actualEventCount === 0 &&
    generation.expectedObservationCount === 0 &&
    generation.actualObservationCount === 0) ||
    no("plan_counts")
  );
}

async function classifyWork(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  item: SourceItemRow,
  entry: WorkerScanEntryRow,
): Promise<ItemBucket> {
  if (!entry.discoveryWorkId) workerProtocolError("scan_conflict");
  const raw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_discovery_work WHERE id = $1",
    [entry.discoveryWorkId],
  );
  if (!raw) workerProtocolError("scan_conflict");
  const work = camelizeDiscoveryWork(raw);
  if (
    work.spaceId !== source.spaceId ||
    work.sourceAccountId !== source.account.id ||
    work.sourceItemId !== item.id ||
    work.scanId !== entry.scanId ||
    work.scanEntryId !== entry.id ||
    work.observationEpoch !== entry.observationEpoch ||
    work.processingEpoch !== entry.processingEpoch ||
    work.contentHash !== entry.contentHash ||
    work.byteLength !== entry.byteLength ||
    !safeInteger(work.attempts) ||
    !safeInteger(work.leaseEpoch)
  )
    workerProtocolError("scan_conflict");
  try {
    await requireOriginalActor(ctx, source, work);
  } catch (error) {
    if (isWorkerTransactionAbort(error)) throw error;
    if (error instanceof WorkerProtocolError && error.code === "not_authorized")
      return "needsReview";
    throw error;
  }
  if (work.state === "queued" || work.state === "leased") return "pending";
  if (work.state === "failed") {
    if (work.retryable === null || !work.failureCode)
      workerProtocolError("scan_conflict");
    return work.retryable ? "failed" : "parked";
  }
  if (work.state === "needs_review" || work.state === "obsolete")
    return "needsReview";
  if (
    work.state !== "admitted" ||
    !work.ingestJobId ||
    !work.processingGenerationId
  )
    workerProtocolError("scan_conflict");
  const jobRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.ingest_jobs WHERE id = $1",
    [work.ingestJobId],
  );
  if (!jobRaw) workerProtocolError("scan_conflict");
  const job = camelizeIngestJob(jobRaw);
  if (
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account.id ||
    job.sourceItemId !== item.id ||
    job.processingGenerationId !== work.processingGenerationId ||
    job.workerDiscoveryWorkId !== work.id ||
    job.workerManaged !== true
  )
    workerProtocolError("scan_conflict");
  if (job.state === "ready") return "needsReview";
  if (
    job.state === "queued" ||
    job.state === "processing" ||
    job.state === "staged"
  )
    return "pending";
  if (job.state === "failed") {
    const retryable =
      job.error && typeof job.error.retryable === "boolean"
        ? job.error.retryable
        : null;
    if (retryable === null) workerProtocolError("scan_conflict");
    return retryable ? "failed" : "parked";
  }
  return "needsReview";
}

async function classifyItem(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  assessment: WorkerProcessingAssessmentRow,
  item: SourceItemRow,
  note: (reason: NotReadyReason) => void,
): Promise<{ bucket: ItemBucket; proof?: Proof }> {
  if (
    item.spaceId !== source.spaceId ||
    item.sourceAccountId !== source.account.id
  )
    workerProtocolError("scan_conflict");
  const entry = await exactEntry(ctx, assessment, item);
  if (item.lifecycle === "forgotten" || item.lifecycle === "forgetting") {
    if (!entry || entry.state === "ignored_forgotten")
      return {
        bucket: "ignoredForgotten",
        ...(entry ? { proof: "ignoredScanEntries" as const } : {}),
      };
    workerProtocolError("scan_conflict");
  }
  if (!entry) {
    if (item.lifecycle === "unavailable") return { bucket: "unavailable" };
    if (assessment.scanStateAtStart === "needs_review")
      return { bucket: "needsReview" };
    workerProtocolError("scan_conflict");
  }
  if (entry.state === "gap")
    return { bucket: "explicitGap", proof: "gapScanEntries" };
  if (entry.state === "needs_review")
    return { bucket: "needsReview", proof: "reviewScanEntries" };
  if (entry.state === "ignored_forgotten") workerProtocolError("scan_conflict");
  if (await terminalReady(ctx, source, assessment, item, entry, note))
    return { bucket: "ready", proof: proofForEntry(entry) };
  if (entry.state === "unchanged" && !entry.discoveryWorkId)
    workerProtocolError("scan_conflict");
  return {
    bucket: await classifyWork(ctx, source, item, entry),
    proof: proofForEntry(entry),
  };
}

function terminalState(
  counts: ProcessingAssessmentCounts,
  scanState: string,
): "complete" | "incomplete" {
  return scanState === "enumerated" &&
    counts.items.pending === 0 &&
    counts.items.failed === 0 &&
    counts.items.needsReview === 0 &&
    counts.items.unavailable === 0 &&
    counts.unresolvedEntries.needsReview === 0
    ? "complete"
    : "incomplete";
}

export async function advanceProcessingAssessment(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "processing.assessPage" }>,
): Promise<WorkerAssessmentPageResult> {
  let source = await requireWorkerSourceAccount(ctx, principal, request);
  source = await lockSource(ctx, source);
  if (!KITH_ID.test(request.assessmentId))
    workerProtocolError("invalid_request");
  const raw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_processing_assessments WHERE id = $1 FOR UPDATE",
    [request.assessmentId],
  );
  if (!raw) workerProtocolError("not_found");
  let assessment = camelizeAssessment(raw);
  if (
    assessment.spaceId !== source.spaceId ||
    assessment.sourceAccountId !== source.account.id
  )
    workerProtocolError("not_found");
  ensureSameActor(source.principal, assessment);
  if (assessment.lastPageRequestId === request.requestId) {
    if (
      !assessment.lastPageInputPhase ||
      !assessment.lastPageResult ||
      assessment.lastPageOrdinal === null
    )
      workerProtocolError("scan_conflict");
    const replayInputPhase = assessment.lastPageInputPhase;
    const replayDigest = await digest("worker-processing-assess-page:v1", [
      source.account.id,
      assessment.id,
      request.requestId,
      replayInputPhase,
      request.ordinal,
      request.maxItems,
    ]);
    if (
      assessment.lastPageRequestDigest !== replayDigest ||
      assessment.lastPageOrdinal !== request.ordinal
    )
      workerProtocolError("request_conflict");
    if (assessment.state === "running") {
      const reason = await currentFenceReason(ctx, source, assessment);
      if (reason)
        assessment = await markStale(ctx, source, assessment, reason, {
          requestId: request.requestId,
          requestDigest: replayDigest,
          ordinal: request.ordinal,
          inputPhase: replayInputPhase,
        });
    } else if (
      (assessment.state === "complete" || assessment.state === "incomplete") &&
      (!snapshotCurrent(source, assessment) ||
        assessment.lastProcessedAtAtCompletion?.getTime() !==
          sourceTime(source.account.lastProcessedAt))
    ) {
      assessment = await markStale(ctx, source, assessment, "source_changed", {
        requestId: request.requestId,
        requestDigest: replayDigest,
        ordinal: request.ordinal,
        inputPhase: replayInputPhase,
      });
    }
    if (!validStoredPage(assessment, assessment.lastPageResult)) {
      if (assessment.state === "stale") workerProtocolError("scan_conflict");
      assessment = await markStale(
        ctx,
        source,
        assessment,
        "detail_unavailable",
        {
          requestId: request.requestId,
          requestDigest: replayDigest,
          ordinal: request.ordinal,
          inputPhase: replayInputPhase,
        },
      );
    }
    return pageResult(
      assessment.id,
      assessment.lastPageResult as StoredPage,
      true,
    );
  }
  if (assessment.state !== "running" || assessment.phase === "done")
    workerProtocolError("scan_not_ready");
  if (request.ordinal !== assessment.nextOrdinal)
    workerProtocolError("scan_not_ready");
  const inputPhase = assessment.phase;
  const requestDigest = await digest("worker-processing-assess-page:v1", [
    source.account.id,
    assessment.id,
    request.requestId,
    inputPhase,
    request.ordinal,
    request.maxItems,
  ]);
  const reason = await currentFenceReason(ctx, source, assessment);
  if (reason) {
    assessment = await markStale(ctx, source, assessment, reason, {
      requestId: request.requestId,
      requestDigest,
      ordinal: request.ordinal,
      inputPhase,
    });
    return pageResult(
      assessment.id,
      assessment.lastPageResult as StoredPage,
      false,
    );
  }
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  let counts = readCounts(assessment.counts);
  // Diagnostic tally, carried across pages in the same jsonb column.
  let reasons: NotReadyReasons = readNotReadyReasons(assessment.counts);
  let accounted = assessment.accountedScanEntries;
  let queued = assessment.queuedScanEntries;
  let gap = assessment.gapScanEntries;
  let review = assessment.reviewScanEntries;
  let ignored = assessment.ignoredScanEntries;
  let unchanged = assessment.unchangedScanEntries;
  let phase: AssessmentPhase = inputPhase;
  let cursor = assessment.cursor;
  let inspected = 0;
  if (phase === "items") {
    const tail = keysetTail(decodeCursor(cursor), 2);
    const fetched = await rows<Record<string, unknown>>(
      ctx,
      `SELECT *, created_at::text AS cursor_created_at FROM kith.source_items
       WHERE source_account_id = $1 ${tail.sql}`,
      [source.account.id, ...tail.values, request.maxItems + 1],
    );
    const page = keysetPage(
      fetched.map((value) => ({
        createdAt: String(value.cursor_created_at),
        id: String(value.id),
        value: camelizeSourceItem(value),
      })),
      request.maxItems,
    );
    for (const wrapped of page.page) {
      const item = wrapped.value;
      const sink = reasonSink();
      let classified: { bucket: ItemBucket; proof?: Proof };
      try {
        classified = await classifyItem(ctx, source, assessment, item, sink.note);
      } catch (error) {
        if (isWorkerTransactionAbort(error)) throw error;
        if (!(error instanceof WorkerProtocolError)) throw error;
        // The swallow that turns any protocol error into `unavailable`. It
        // keeps the readiness reason when there is one (that is the condition
        // that led here) and otherwise names the code it ate.
        sink.note(`protocol_error:${error.code}`);
        const entry = await exactEntry(ctx, assessment, item);
        classified = {
          bucket: "unavailable",
          ...(entry ? { proof: proofForEntry(entry) } : {}),
        };
      }
      const reason = sink.first();
      if (reason && classified.bucket !== "ready")
        reasons = incrementReason(reasons, reason);
      counts = incrementItem(counts, classified.bucket);
      if (classified.proof === "queuedScanEntries") queued += 1;
      else if (classified.proof === "gapScanEntries") gap += 1;
      else if (classified.proof === "reviewScanEntries") review += 1;
      else if (classified.proof === "ignoredScanEntries") ignored += 1;
      else if (classified.proof === "unchangedScanEntries") unchanged += 1;
      if (classified.proof) accounted += 1;
      inspected += 1;
    }
    cursor = page.continueCursor;
    if (page.isDone) {
      phase = "unresolved_entries";
      cursor = null;
    }
  } else {
    const tail = keysetTail(decodeCursor(cursor), 2);
    const fetched = await rows<Record<string, unknown>>(
      ctx,
      `SELECT *, created_at::text AS cursor_created_at FROM kith.worker_scan_entries
       WHERE scan_id = $1 AND source_item_id IS NULL ${tail.sql}`,
      [assessment.scanId, ...tail.values, request.maxItems + 1],
    );
    const page = keysetPage(
      fetched.map((value) => ({
        createdAt: String(value.cursor_created_at),
        id: String(value.id),
        value: camelizeScanEntry(value),
      })),
      request.maxItems,
    );
    for (const wrapped of page.page) {
      const entry = wrapped.value;
      const scanPage = await row<{
        space_id: string;
        source_account_id: string;
        scan_id: string;
      }>(
        ctx,
        "SELECT space_id, source_account_id, scan_id FROM kith.worker_scan_pages WHERE id = $1",
        [entry.scanPageId],
      );
      if (
        !scanPage ||
        entry.spaceId !== source.spaceId ||
        entry.sourceAccountId !== source.account.id ||
        entry.scanId !== assessment.scanId ||
        scanPage.space_id !== source.spaceId ||
        scanPage.source_account_id !== source.account.id ||
        scanPage.scan_id !== assessment.scanId
      )
        workerProtocolError("scan_conflict");
      if (entry.state === "ignored_forgotten") {
        counts.unresolvedEntries.ignoredForgotten += 1;
        ignored += 1;
      } else if (entry.state === "needs_review") {
        counts.unresolvedEntries.needsReview += 1;
        review += 1;
      } else workerProtocolError("scan_conflict");
      accounted += 1;
      inspected += 1;
    }
    cursor = page.continueCursor;
    if (page.isDone) {
      phase = "done";
      cursor = null;
    }
  }
  const nextOrdinal = assessment.nextOrdinal + 1;
  if (
    ![nextOrdinal, accounted, queued, gap, review, ignored, unchanged].every(
      safeInteger,
    )
  )
    workerProtocolError("scan_conflict");
  let state: "running" | "complete" | "incomplete" = "running";
  let completedAt: number | undefined;
  if (phase === "done") {
    if (
      accounted !== assessment.scanEntryCount ||
      queued !== assessment.scanChangedCount ||
      gap !== assessment.scanGapCount ||
      review !== assessment.scanReviewCount ||
      accounted !== queued + gap + review + ignored + unchanged
    ) {
      assessment = await markStale(
        ctx,
        source,
        assessment,
        "detail_unavailable",
        {
          requestId: request.requestId,
          requestDigest,
          ordinal: request.ordinal,
          inputPhase,
        },
      );
      return pageResult(
        assessment.id,
        assessment.lastPageResult as StoredPage,
        false,
      );
    }
    state = terminalState(counts, assessment.scanStateAtStart ?? "");
    completedAt = ctx.now;
  }
  const stored: StoredPage = {
    state,
    phase,
    ordinal: request.ordinal,
    inspected,
    nextOrdinal,
    ...(completedAt === undefined ? {} : { counts, completedAt }),
  };
  await exec(
    ctx,
    `UPDATE kith.worker_processing_assessments SET state=$2, phase=$3, cursor=$4,
     next_ordinal=$5, counts=$6::jsonb, accounted_scan_entries=$7,
     queued_scan_entries=$8, gap_scan_entries=$9, review_scan_entries=$10,
     ignored_scan_entries=$11, unchanged_scan_entries=$12,
     last_page_request_id=$13, last_page_request_digest=$14,
     last_page_input_phase=$15, last_page_ordinal=$16, last_page_result=$17::jsonb,
     updated_at=$18, expires_at=$19, retire_at=$20, completed_at=$21,
     last_processed_at_at_completion=$22 WHERE id=$1`,
    [
      assessment.id,
      state,
      phase,
      cursor,
      nextOrdinal,
      JSON.stringify(countsWithReasons(counts, reasons)),
      accounted,
      queued,
      gap,
      review,
      ignored,
      unchanged,
      request.requestId,
      requestDigest,
      inputPhase,
      request.ordinal,
      JSON.stringify(stored),
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_ASSESSMENT_IDLE_MS)),
      at(nowPlus(ctx.now, WORKER_ASSESSMENT_RETENTION_MS)),
      at(completedAt),
      completedAt === undefined
        ? null
        : at(sourceTime(source.account.lastProcessedAt)),
    ],
  );
  if (completedAt !== undefined) {
    await exec(
      ctx,
      "UPDATE kith.source_accounts SET active_worker_assessment_id=NULL, latest_worker_assessment_id=$2 WHERE id=$1 AND active_worker_assessment_id=$2",
      [source.account.id, assessment.id],
    );
  }
  return pageResult(assessment.id, stored, false);
}
