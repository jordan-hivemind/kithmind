import type {
  ProcessingAssessmentCounts,
  WorkerProcessingStatus,
  WorkerRequest,
  WorkerSourceStatusResult,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import { requireWorkerSourceAccount, type LoadedWorkerSource } from "./auth.js";
import { row, rows, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";
import {
  camelizeAssessment,
  camelizeScan,
  type WorkerProcessingAssessmentRow,
  type WorkerSourceScanRow,
} from "./rows.js";

function sameDate(left: Date | null, right: Date | null): boolean {
  return (left?.getTime() ?? 0) === (right?.getTime() ?? 0);
}

function snapshotCurrent(
  source: LoadedWorkerSource,
  assessment: WorkerProcessingAssessmentRow,
): boolean {
  return (
    (assessment.state === "complete" || assessment.state === "incomplete") &&
    assessment.phase === "done" &&
    assessment.spaceId === source.spaceId &&
    assessment.sourceAccountId === source.account.id &&
    assessment.inventoryEpoch === (source.account.inventoryEpoch ?? 0) &&
    assessment.completedInventoryEpoch ===
      (source.account.completedInventoryEpoch ?? 0) &&
    assessment.manifestVersion === (source.account.manifestVersion ?? 0) &&
    assessment.assessmentEpoch ===
      (source.account.workerAssessmentEpoch ?? 0) &&
    sameDate(
      assessment.coverageInvalidatedAt,
      source.account.coverageInvalidatedAt,
    ) &&
    sameDate(assessment.lastEnumeratedAt, source.account.lastEnumeratedAt) &&
    sameDate(
      assessment.lastProcessedAtAtCompletion,
      source.account.lastProcessedAt,
    ) &&
    assessment.completedAt instanceof Date &&
    assessment.counts !== null &&
    assessment.accountedScanEntries === assessment.scanEntryCount &&
    assessment.queuedScanEntries === assessment.scanChangedCount &&
    assessment.gapScanEntries === assessment.scanGapCount &&
    assessment.reviewScanEntries === assessment.scanReviewCount &&
    assessment.accountedScanEntries ===
      assessment.queuedScanEntries +
        assessment.gapScanEntries +
        assessment.reviewScanEntries +
        assessment.ignoredScanEntries +
        assessment.unchangedScanEntries
  );
}

function readCounts(
  value: Record<string, unknown> | null,
): ProcessingAssessmentCounts {
  if (
    !value ||
    typeof value.items !== "object" ||
    value.items === null ||
    typeof value.unresolvedEntries !== "object" ||
    value.unresolvedEntries === null
  ) {
    workerProtocolError("scan_conflict");
  }
  return value as ProcessingAssessmentCounts;
}

export async function getProcessingAssessmentStatus(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
): Promise<WorkerProcessingStatus> {
  if (source.account.activeWorkerAssessmentId) {
    const raw = await row<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.worker_processing_assessments WHERE id = $1",
      [source.account.activeWorkerAssessmentId],
    );
    if (!raw) workerProtocolError("scan_conflict");
    const active = camelizeAssessment(raw);
    if (
      active.spaceId !== source.spaceId ||
      active.sourceAccountId !== source.account.id
    )
      workerProtocolError("scan_conflict");
    if (
      active.state === "running" &&
      active.expiresAt.getTime() > ctx.now &&
      active.inventoryEpoch === (source.account.inventoryEpoch ?? 0) &&
      active.completedInventoryEpoch ===
        (source.account.completedInventoryEpoch ?? 0) &&
      active.manifestVersion === (source.account.manifestVersion ?? 0) &&
      active.assessmentEpoch === (source.account.workerAssessmentEpoch ?? 0)
    ) {
      return {
        state: "assessing",
        assessmentId: active.id,
        startedAt: active.startedAt.getTime(),
      };
    }
  }
  if (!source.account.latestWorkerAssessmentId)
    return { state: "not_assessed" };
  const raw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_processing_assessments WHERE id = $1",
    [source.account.latestWorkerAssessmentId],
  );
  if (!raw) workerProtocolError("scan_conflict");
  const latest = camelizeAssessment(raw);
  if (
    latest.spaceId !== source.spaceId ||
    latest.sourceAccountId !== source.account.id
  )
    workerProtocolError("scan_conflict");
  if (!snapshotCurrent(source, latest)) return { state: "not_assessed" };
  if (!latest.completedAt) workerProtocolError("scan_conflict");
  return {
    state: latest.state as "complete" | "incomplete",
    assessmentId: latest.id,
    scanId: latest.scanId,
    inventoryEpoch: latest.inventoryEpoch,
    manifestVersion: latest.manifestVersion,
    completedAt: latest.completedAt.getTime(),
    counts: readCounts(latest.counts),
  };
}

function enumeration(
  source: LoadedWorkerSource,
  scan: WorkerSourceScanRow | null,
  now: number,
): WorkerSourceStatusResult["enumeration"] {
  if (!scan) {
    if (
      (source.account.completedInventoryEpoch ?? 0) ===
        (source.account.inventoryEpoch ?? 0) &&
      source.account.lastEnumeratedAt
    ) {
      return {
        state: "complete",
        completedAt: source.account.lastEnumeratedAt.getTime(),
      };
    }
    if (
      (source.account.inventoryEpoch ?? 0) >
      (source.account.completedInventoryEpoch ?? 0)
    )
      return { state: "failed" };
    return { state: "never" };
  }
  if (
    ["open", "sealed", "reconciling"].includes(scan.state) &&
    scan.expiresAt.getTime() <= now
  ) {
    return {
      state: "failed",
      scanId: scan.id,
      failureCode: "enumeration_interrupted",
    };
  }
  if (["open", "sealed", "reconciling"].includes(scan.state))
    return { state: "in_progress", scanId: scan.id };
  if (scan.state === "enumerated") {
    if (!scan.completedAt) workerProtocolError("scan_conflict");
    return {
      state: "complete",
      scanId: scan.id,
      completedAt: scan.completedAt.getTime(),
    };
  }
  if (scan.state === "needs_review") {
    return {
      state: "needs_review",
      scanId: scan.id,
      ...(scan.completedAt ? { completedAt: scan.completedAt.getTime() } : {}),
    };
  }
  return {
    state: "failed",
    scanId: scan.id,
    ...(scan.completedAt ? { completedAt: scan.completedAt.getTime() } : {}),
    ...(scan.failureCode ? { failureCode: scan.failureCode } : {}),
  };
}

export async function getWorkerSourceStatus(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "source.status" }>,
): Promise<WorkerSourceStatusResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  let scan: WorkerSourceScanRow | null = null;
  if (source.account.activeWorkerScanId) {
    const raw = await row<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.worker_source_scans WHERE id = $1",
      [source.account.activeWorkerScanId],
    );
    scan = raw ? camelizeScan(raw) : null;
    if (
      scan &&
      (scan.spaceId !== source.spaceId ||
        scan.sourceAccountId !== source.account.id)
    )
      workerProtocolError("scan_conflict");
  }
  if (!scan) {
    const recent = await rows<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.worker_source_scans WHERE source_account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [source.account.id],
    );
    scan = recent[0] ? camelizeScan(recent[0]) : null;
    if (
      scan &&
      (scan.spaceId !== source.spaceId ||
        scan.sourceAccountId !== source.account.id)
    )
      workerProtocolError("scan_conflict");
  }
  if (scan && scan.inventoryEpoch !== (source.account.inventoryEpoch ?? 0))
    scan = null;
  return {
    operation: "source.status",
    sourceAccountId: source.account.id,
    inventoryEpoch: source.account.inventoryEpoch ?? 0,
    completedInventoryEpoch: source.account.completedInventoryEpoch ?? 0,
    manifestVersion: source.account.manifestVersion ?? 0,
    enumeration: enumeration(source, scan, ctx.now),
    processing: await getProcessingAssessmentStatus(ctx, source),
    recordCoverage: "not_established",
  };
}
