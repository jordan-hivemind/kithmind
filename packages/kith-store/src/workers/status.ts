import {
  FS_ROOT_ALIAS,
  MAX_WORKER_SOURCE_ITEM_COUNT_ROOTS,
  type ProcessingAssessmentCounts,
  type WorkerProcessingStatus,
  type WorkerRequest,
  type WorkerSourceItemCountsResult,
  type WorkerSourceStatusResult,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import { normalizedCounts } from "./assessment.js";
import { requireWorkerSourceAccount, type LoadedWorkerSource } from "./auth.js";
import { row, rows, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";
import { RECONCILE_EXEMPT_LIFECYCLES } from "./scans.js";
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

/**
 * P2-100a: this shape-checked the stored jsonb and then cast it straight into
 * the response. A cast carries whatever extra keys the column holds, and the
 * worker's parser refuses a `counts` object with any key beyond `items` and
 * `unresolvedEntries`, so the diagnostic tally now stored beside the counts
 * would have wedged `source.status`, doctor and relocation resume. Share
 * `normalizedCounts`, which rebuilds the protocol shape field by field.
 */
function readCounts(
  value: Record<string, unknown> | null,
): ProcessingAssessmentCounts {
  return normalizedCounts(value) ?? workerProtocolError("scan_conflict");
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

/**
 * ADM-6a. How many live items this account holds, in total and per filesystem
 * root alias.
 *
 * The `WHERE` clause is the one thing in here that has to be right. It is
 * `reconcileWorkerScan`'s own skip list read forwards: that loop passes over
 * an item whose lifecycle is `forgotten`, `forgetting` or already
 * `unavailable`, and retires everything else it did not see this epoch. So
 * those lifecycles, and only those, are the ones this count leaves out.
 *
 * Review of this change: the two lists are now one list. The clause below is
 * generated from `RECONCILE_EXEMPT_LIFECYCLES`, the constant that loop's own
 * two tests are written against, so neither side can be edited without the
 * other. `IS DISTINCT FROM` rather than `NOT IN` because the column is
 * nullable and a null lifecycle is an item reconcile *would* retire, and one
 * bound parameter per lifecycle rather than an inlined list because nothing
 * here interpolates a value into SQL.
 *
 * The alias comes out of the stored `fs://` URI rather than out of
 * `source_roots`, because the watcher's side of the comparison is keyed by the
 * alias in its own host allow-list, and because an item's root is where it
 * actually is, not which row the owner has configured today. `canonicalFsUri`
 * validated the URI when it was written; the pattern is applied again here so
 * that one strange stored row cannot put a value in the response that the
 * watcher's parser would reject, which would blind the guard entirely rather
 * than lose one row of it.
 *
 * A read: no rate limit and no write, pulled once a pass beside `source.roots`.
 */
export async function getWorkerSourceItemCounts(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "source.itemCounts" }>,
): Promise<WorkerSourceItemCountsResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const exempt = RECONCILE_EXEMPT_LIFECYCLES.map(
    (_, index) => `AND lifecycle IS DISTINCT FROM $${index + 3}`,
  ).join("\n        ");
  const counted = await rows<{ root_alias: string | null; live_items: string }>(
    ctx,
    `SELECT substring(uri from '^fs://([^/]+)/') AS root_alias,
            count(*) AS live_items
       FROM kith.source_items
      WHERE source_account_id = $1 AND space_id = $2
        ${exempt}
      GROUP BY 1`,
    [source.account.id, source.spaceId, ...RECONCILE_EXEMPT_LIFECYCLES],
  );
  let liveItems = 0;
  const roots: Array<{ rootAlias: string; liveItems: number }> = [];
  for (const record of counted) {
    const count = Number(record.live_items);
    if (!Number.isSafeInteger(count)) workerProtocolError("scan_conflict");
    liveItems += count;
    if (record.root_alias === null || !FS_ROOT_ALIAS.test(record.root_alias)) {
      continue;
    }
    roots.push({ rootAlias: record.root_alias, liveItems: count });
  }
  if (!Number.isSafeInteger(liveItems)) workerProtocolError("scan_conflict");
  // Largest first, so a truncated list is the part of the account a mistake
  // would cost the most. Alias order breaks ties so the response is stable.
  roots.sort(
    (left, right) =>
      right.liveItems - left.liveItems ||
      (left.rootAlias < right.rootAlias ? -1 : 1),
  );
  return {
    operation: "source.itemCounts",
    sourceAccountId: source.account.id,
    liveItems,
    roots: roots.slice(0, MAX_WORKER_SOURCE_ITEM_COUNT_ROOTS),
    truncated: roots.length > MAX_WORKER_SOURCE_ITEM_COUNT_ROOTS,
  };
}
