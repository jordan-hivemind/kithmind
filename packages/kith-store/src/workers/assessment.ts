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
  camelizeSourceItem,
  camelizeSourceRevision,
  requireInlineSourceRevision,
  verifySealedParsedPayload,
  type SourceItemRow,
} from "../provenance/index.js";
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
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import { FS_TEXT_PROFILE } from "./profile.js";
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

function readCounts(
  value: Record<string, unknown> | null,
): ProcessingAssessmentCounts {
  const counts = value as ProcessingAssessmentCounts | null;
  if (!counts || !counts.items || !counts.unresolvedEntries) {
    workerProtocolError("scan_conflict");
  }
  const values = [
    ...Object.values(counts.items),
    ...Object.values(counts.unresolvedEntries),
  ];
  if (!values.every(safeInteger)) workerProtocolError("scan_conflict");
  return structuredClone(counts);
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
  return {
    operation: "processing.assessPage",
    assessmentId,
    ...result,
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
          JSON.stringify(value.counts) ===
            JSON.stringify(readCounts(assessment.counts)))
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

async function terminalReady(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  assessment: WorkerProcessingAssessmentRow,
  item: SourceItemRow,
  entry: WorkerScanEntryRow,
): Promise<boolean> {
  if (
    item.lifecycle !== "available" ||
    item.lastFailure !== null ||
    item.workerLastSeenInventoryEpoch !== assessment.inventoryEpoch ||
    item.workerObservationEpoch !== entry.observationEpoch ||
    item.workerProcessingEpoch !== entry.processingEpoch ||
    item.workerContentHash !== entry.contentHash ||
    item.workerSourceModifiedAt?.getTime() !==
      entry.sourceModifiedAt.getTime() ||
    !item.desiredRevisionId ||
    item.activeRevisionId !== item.desiredRevisionId ||
    !item.activeGenerationId ||
    !safeInteger(item.desiredProcessingEpoch) ||
    !safeInteger(entry.observationEpoch) ||
    !safeInteger(entry.processingEpoch) ||
    !safeInteger(entry.byteLength)
  )
    return false;
  const revisionRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_revisions WHERE id=$1",
    [item.desiredRevisionId],
  );
  const generationRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.processing_generations WHERE id=$1",
    [item.activeGenerationId],
  );
  const jobRows = await rows<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.ingest_jobs WHERE processing_generation_id=$1 LIMIT 2",
    [item.activeGenerationId],
  );
  if (!revisionRaw || !generationRaw || jobRows.length !== 1) return false;
  const revision = camelizeSourceRevision(revisionRaw);
  const generation = camelizeProcessingGeneration(generationRaw);
  const job = camelizeIngestJob(jobRows[0]!);
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
    generation.deactivatedAt !== null ||
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
    return false;
  if (entry.contentRepresentation === "archived_binary_v1") {
    if (
      revision.representation !== "archived_binary_v1" ||
      revision.contentHashAuthority !== "worker_asserted" ||
      revision.contentHash !== entry.contentHash ||
      revision.byteLength !== entry.byteLength ||
      revision.mediaType !== entry.binaryMediaType ||
      !generation.sourceTextVersionId ||
      !generation.parserArtifactId ||
      !generation.archiveSetDigest ||
      !generation.normalizedBundleDigest ||
      !generation.payloadManifestId ||
      !generation.originalPrimaryReceiptId ||
      !generation.parserPrimaryReceiptId ||
      !generation.parserBackupReceiptId ||
      Boolean(generation.originalBackupReceiptId) ===
        Boolean(generation.originalProviderReferenceId) ||
      (generation.originalProviderReferenceId !== null &&
        !safeInteger(generation.originalProviderBindingEpoch))
    )
      return false;
    try {
      const verified = await verifySealedParsedPayload(ctx.client, generation);
      return (
        generation.actualPageCount === verified.actualPageCount &&
        generation.actualEvidenceSpanCount ===
          verified.actualEvidenceSpanCount &&
        generation.actualDocumentCount === verified.actualDocumentCount &&
        generation.actualChunkCount === verified.actualChunkCount
      );
    } catch (error) {
      if (isWorkerTransactionAbort(error)) throw error;
      return false;
    }
  }
  if (
    entry.contentRepresentation !== "inline_utf8_v1" ||
    item.workerProfileId !== FS_TEXT_PROFILE.profileId
  )
    return false;
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
    return false;
  let text: string;
  try {
    text = requireInlineSourceRevision(revision).text;
  } catch {
    return false;
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
  return (
    revision.contentHash === entry.contentHash &&
    revision.byteLength === entry.byteLength &&
    revision.contentHash === (await sha256Hex(text)) &&
    revision.byteLength === Buffer.byteLength(text, "utf8") &&
    revision.mediaType === FS_TEXT_PROFILE.mediaType &&
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
    generation.expectedPageCount === plan.expectedPageCount &&
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
    generation.actualObservationCount === 0
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
  if (await terminalReady(ctx, source, assessment, item, entry))
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
      [source.account.id, ...tail.values, 2],
    );
    const page = keysetPage(
      fetched.map((value) => ({
        createdAt: String(value.cursor_created_at),
        id: String(value.id),
        value: camelizeSourceItem(value),
      })),
      1,
    );
    for (const wrapped of page.page) {
      const item = wrapped.value;
      let classified: { bucket: ItemBucket; proof?: Proof };
      try {
        classified = await classifyItem(ctx, source, assessment, item);
      } catch (error) {
        if (isWorkerTransactionAbort(error)) throw error;
        if (!(error instanceof WorkerProtocolError)) throw error;
        const entry = await exactEntry(ctx, assessment, item);
        classified = {
          bucket: "unavailable",
          ...(entry ? { proof: proofForEntry(entry) } : {}),
        };
      }
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
      [assessment.scanId, ...tail.values, 2],
    );
    const page = keysetPage(
      fetched.map((value) => ({
        createdAt: String(value.cursor_created_at),
        id: String(value.id),
        value: camelizeScanEntry(value),
      })),
      1,
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
      JSON.stringify(counts),
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
