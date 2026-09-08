import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import { isAssessmentSnapshotCurrent } from "./assessment";
import {
  WORKER_CLEANUP_BATCH_SIZE,
  WORKER_DETAIL_RETENTION_MS,
  WORKER_SCAN_RETENTION_MS,
} from "./model";
import { WORKER_MUTATION_RATE_WINDOW_MS } from "./rateLimit";

const phases = [
  { kind: "expire_scan", state: "open" },
  { kind: "expire_scan", state: "sealed" },
  { kind: "expire_scan", state: "reconciling" },
  { kind: "work", state: "obsolete" },
  { kind: "work", state: "needs_review" },
  { kind: "work", state: "failed" },
  { kind: "entry", state: "unchanged" },
  { kind: "entry", state: "gap" },
  { kind: "entry", state: "ignored_forgotten" },
  { kind: "entry", state: "needs_review" },
  { kind: "page" },
  { kind: "scan", state: "enumerated" },
  { kind: "scan", state: "needs_review" },
  { kind: "scan", state: "failed" },
  { kind: "queued_work" },
  { kind: "reservation_target" },
  { kind: "reservation_receipt" },
  { kind: "operation_receipt" },
  { kind: "rate_limit" },
  { kind: "expire_assessment" },
  { kind: "assessment", state: "stale" },
  { kind: "assessment", state: "complete" },
  { kind: "assessment", state: "incomplete" },
  { kind: "binary_operation_receipt" },
  { kind: "parsed_stage" },
] as const;

// Phase ordering is persisted. A new layout starts a fresh, safe sweep.
const CHECKPOINT_KEY = "v5";

/** Only the exact active source assessment can pin this scan's detail. */
async function hasLiveAssessment(
  ctx: MutationCtx,
  row: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    scanId: Id<"workerSourceScans">;
  },
  now: number,
) {
  const source = await ctx.db.get(row.sourceAccountId);
  if (
    !source ||
    source.spaceId !== row.spaceId ||
    !source.activeWorkerAssessmentId
  )
    return false;
  const assessment = await ctx.db.get(source.activeWorkerAssessmentId);
  return Boolean(
    assessment &&
    assessment.sourceAccountId === source._id &&
    assessment.spaceId === source.spaceId &&
    assessment.scanId === row.scanId &&
    assessment.state === "running" &&
    Number.isSafeInteger(assessment.expiresAt) &&
    assessment.expiresAt > now,
  );
}

type Checkpoint = { cursor?: string; cutoff: number };
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };

function progress<T>(page: Page<T>, changed: number) {
  return {
    changed,
    inspected: page.page.length,
    phaseDone: page.isDone,
    ...(page.isDone ? {} : { cursor: page.continueCursor }),
  };
}

async function sweep(
  ctx: MutationCtx,
  phase: (typeof phases)[number],
  checkpoint: Checkpoint,
  now: number,
) {
  const paginationOpts = {
    numItems: WORKER_CLEANUP_BATCH_SIZE,
    cursor: checkpoint.cursor ?? null,
  };
  let changed = 0;
  if (phase.kind === "binary_operation_receipt") {
    const page = await ctx.db
      .query("workerBinaryOperationReceipts")
      .withIndex("by_retireAt", (q) => q.lte("retireAt", checkpoint.cutoff))
      .paginate(paginationOpts);
    for (const row of page.page) {
      // A receipt is the authoritative retry result through its replay window.
      if (row.retireAt > now) continue;
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "parsed_stage") {
    const page = await ctx.db
      .query("workerParsedStages")
      .withIndex("by_retireAt", (q) => q.lte("retireAt", checkpoint.cutoff))
      .paginate(paginationOpts);
    for (const row of page.page) {
      if (row.retireAt > now) continue;
      const job = await ctx.db.get(row.ingestJobId);
      // Batch and seal retries can outlive the stage's original deadline.
      const liveReceipt = await ctx.db
        .query("workerBinaryOperationReceipts")
        .withIndex("by_stageId_and_retireAt", (q) =>
          q.eq("stageId", row._id).gt("retireAt", now),
        )
        .first();
      if (liveReceipt) continue;
      if (!job) {
        const [item, account] = await Promise.all([
          ctx.db.get(row.sourceItemId),
          ctx.db.get(row.sourceAccountId),
        ]);
        const isForgottenOrphan =
          item?.lifecycle === "forgotten" &&
          item.spaceId === row.spaceId &&
          item.sourceAccountId === row.sourceAccountId &&
          account?.spaceId === row.spaceId;
        if (!isForgottenOrphan) continue;
        await ctx.db.delete(row._id);
        changed += 1;
        continue;
      }
      const hasCoherentJob =
        job.spaceId === row.spaceId &&
        job.sourceAccountId === row.sourceAccountId &&
        job.sourceItemId === row.sourceItemId &&
        job.processingGenerationId === row.processingGenerationId &&
        job.sourceRevisionId === row.sourceRevisionId &&
        job.workerProcessingMode === "parsed_pages_v1";
      // Unknown or incoherent parents are retained for explicit review. A
      // coherent live job still owns the stage regardless of its old deadline.
      if (!hasCoherentJob) continue;
      if (
        job.state === "queued" ||
        job.state === "processing" ||
        job.state === "staged"
      )
        continue;
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "expire_assessment") {
    const page = await ctx.db
      .query("workerProcessingAssessments")
      .withIndex("by_state_and_expiresAt", (q) =>
        q.eq("state", "running").lte("expiresAt", checkpoint.cutoff),
      )
      .paginate(paginationOpts);
    for (const row of page.page) {
      // A page can have renewed its deadline after this sweep began.
      if (row.expiresAt > now) continue;
      await ctx.db.patch(row._id, {
        state: "stale",
        staleReason: "expired",
        phase: "done",
        cursor: undefined,
        updatedAt: now,
        retireAt: now + WORKER_SCAN_RETENTION_MS,
      });
      const source = await ctx.db.get(row.sourceAccountId);
      if (
        source?.spaceId === row.spaceId &&
        source.activeWorkerAssessmentId === row._id
      )
        await ctx.db.patch(source._id, { activeWorkerAssessmentId: undefined });
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "assessment") {
    const page = await ctx.db
      .query("workerProcessingAssessments")
      .withIndex("by_state_and_retireAt", (q) =>
        q.eq("state", phase.state).lte("retireAt", checkpoint.cutoff),
      )
      .paginate(paginationOpts);
    for (const row of page.page) {
      const source = await ctx.db.get(row.sourceAccountId);
      if (
        source?.spaceId === row.spaceId &&
        source.latestWorkerAssessmentId === row._id &&
        isAssessmentSnapshotCurrent(source, row)
      )
        continue;
      if (source?.spaceId === row.spaceId) {
        if (source.activeWorkerAssessmentId === row._id)
          await ctx.db.patch(source._id, {
            activeWorkerAssessmentId: undefined,
          });
        if (source.latestWorkerAssessmentId === row._id)
          await ctx.db.patch(source._id, {
            latestWorkerAssessmentId: undefined,
          });
      }
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "rate_limit") {
    const page = await ctx.db
      .query("workerProtocolRateLimits")
      .withIndex("by_windowStartedAt", (q) =>
        q.lte(
          "windowStartedAt",
          checkpoint.cutoff - WORKER_MUTATION_RATE_WINDOW_MS,
        ),
      )
      .paginate(paginationOpts);
    for (const row of page.page) {
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "reservation_target") {
    const page = await ctx.db
      .query("workerReservationTargets")
      .withIndex("by_leaseExpiresAt", (q) =>
        q.lte("leaseExpiresAt", checkpoint.cutoff),
      )
      .paginate(paginationOpts);
    for (const row of page.page) {
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "reservation_receipt") {
    const page = await ctx.db
      .query("workerReservationReceipts")
      .withIndex("by_retireAt", (q) => q.lte("retireAt", checkpoint.cutoff))
      .paginate(paginationOpts);
    for (const row of page.page) {
      const target = await ctx.db
        .query("workerReservationTargets")
        .withIndex("by_receiptId_and_ordinal", (q) =>
          q.eq("receiptId", row._id),
        )
        .first();
      if (target) continue;
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "operation_receipt") {
    const page = await ctx.db
      .query("workerOperationReceipts")
      .withIndex("by_retireAt", (q) => q.lte("retireAt", checkpoint.cutoff))
      .paginate(paginationOpts);
    for (const row of page.page) {
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "queued_work") {
    const page = await ctx.db
      .query("workerDiscoveryWork")
      .withIndex("by_state_and_createdAt", (q) =>
        q.eq("state", "queued").lte("createdAt", checkpoint.cutoff),
      )
      .paginate(paginationOpts);
    for (const row of page.page) {
      const [scan, entry, item] = await Promise.all([
        ctx.db.get(row.scanId),
        ctx.db.get(row.scanEntryId),
        ctx.db.get(row.sourceItemId),
      ]);
      const sourcePage = entry ? await ctx.db.get(entry.scanPageId) : null;
      const matches =
        scan &&
        scan.spaceId === row.spaceId &&
        scan.sourceAccountId === row.sourceAccountId &&
        entry &&
        entry.spaceId === row.spaceId &&
        entry.sourceAccountId === row.sourceAccountId &&
        entry.scanId === row.scanId &&
        entry.sourceItemId === row.sourceItemId &&
        entry.discoveryWorkId === row._id &&
        entry.observationEpoch === row.observationEpoch &&
        sourcePage &&
        sourcePage.spaceId === row.spaceId &&
        sourcePage.sourceAccountId === row.sourceAccountId &&
        sourcePage.scanId === row.scanId &&
        item &&
        item.spaceId === row.spaceId &&
        item.sourceAccountId === row.sourceAccountId &&
        item.workerObservationEpoch === row.observationEpoch &&
        item.lifecycle !== "forgetting" &&
        item.lifecycle !== "forgotten";
      if (
        matches &&
        (scan.state === "enumerated" ||
          ((scan.state === "open" ||
            scan.state === "sealed" ||
            scan.state === "reconciling") &&
            scan.expiresAt > now))
      ) {
        continue;
      }
      await ctx.db.patch(row._id, {
        state: "needs_review",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        leaseOwnerCredentialId: undefined,
        nextAttemptAt: undefined,
        retireAt: now + WORKER_DETAIL_RETENTION_MS,
      });
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "expire_scan") {
    const page = await ctx.db
      .query("workerSourceScans")
      .withIndex("by_state_and_expiresAt", (q) =>
        q.eq("state", phase.state).lte("expiresAt", checkpoint.cutoff),
      )
      .paginate(paginationOpts);
    for (const scan of page.page) {
      await ctx.db.patch(scan._id, {
        state: "failed",
        failureCode: "enumeration_interrupted",
        completedAt: now,
        retireAt: now + WORKER_SCAN_RETENTION_MS,
      });
      const account = await ctx.db.get(scan.sourceAccountId);
      if (
        account &&
        account.spaceId === scan.spaceId &&
        account.activeWorkerScanId === scan._id
      ) {
        await ctx.db.patch(account._id, {
          activeWorkerScanId: undefined,
          coverageInvalidatedAt: Math.max(
            now,
            (account.coverageInvalidatedAt ?? 0) + 1,
          ),
        });
      }
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "work") {
    const page = await ctx.db
      .query("workerDiscoveryWork")
      .withIndex("by_state_and_retireAt", (q) =>
        q.eq("state", phase.state).lte("retireAt", checkpoint.cutoff),
      )
      .paginate(paginationOpts);
    for (const row of page.page) {
      // Admission envelopes referenced by jobs remain available for recovery.
      // Advancing the cursor past them lets unrelated expired rows be pruned.
      if (row.ingestJobId !== undefined) continue;
      if (await hasLiveAssessment(ctx, row, now)) continue;
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "entry") {
    const page = await ctx.db
      .query("workerScanEntries")
      .withIndex("by_state_and_retireAt", (q) =>
        q.eq("state", phase.state).lte("retireAt", checkpoint.cutoff),
      )
      .paginate(paginationOpts);
    for (const row of page.page) {
      if (await hasLiveAssessment(ctx, row, now)) continue;
      if (row.discoveryWorkId && (await ctx.db.get(row.discoveryWorkId)))
        continue;
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  if (phase.kind === "page") {
    const page = await ctx.db
      .query("workerScanPages")
      .withIndex("by_retireAt", (q) => q.lte("retireAt", checkpoint.cutoff))
      .paginate(paginationOpts);
    for (const row of page.page) {
      if (await hasLiveAssessment(ctx, row, now)) continue;
      const entry = await ctx.db
        .query("workerScanEntries")
        .withIndex("by_scanPageId", (q) => q.eq("scanPageId", row._id))
        .first();
      if (entry) continue;
      await ctx.db.delete(row._id);
      changed += 1;
    }
    return progress(page, changed);
  }
  const page = await ctx.db
    .query("workerSourceScans")
    .withIndex("by_state_and_retireAt", (q) =>
      q.eq("state", phase.state).lte("retireAt", checkpoint.cutoff),
    )
    .paginate(paginationOpts);
  for (const row of page.page) {
    if (await hasLiveAssessment(ctx, { ...row, scanId: row._id }, now))
      continue;
    const [childPage, childEntry] = await Promise.all([
      ctx.db
        .query("workerScanPages")
        .withIndex("by_scanId", (q) => q.eq("scanId", row._id))
        .first(),
      ctx.db
        .query("workerScanEntries")
        .withIndex("by_scanId", (q) => q.eq("scanId", row._id))
        .first(),
    ]);
    if (childPage || childEntry) continue;
    await ctx.db.delete(row._id);
    changed += 1;
  }
  return progress(page, changed);
}

/** One bounded page per invocation, with independent fair progress per phase. */
export const removeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const state = await ctx.db
      .query("workerCleanupState")
      .withIndex("by_key", (q) => q.eq("key", CHECKPOINT_KEY))
      .unique();
    const nextPhase = state?.nextPhase ?? 0;
    const checkpoints: Checkpoint[] =
      state?.checkpoints ?? phases.map(() => ({ cutoff: now }));
    if (
      !Number.isInteger(nextPhase) ||
      nextPhase < 0 ||
      nextPhase >= phases.length ||
      checkpoints.length !== phases.length
    ) {
      throw new Error("Worker cleanup checkpoint is invalid");
    }
    const phase = phases[nextPhase]!;
    const checkpoint = checkpoints[nextPhase]!;
    const result = await sweep(ctx, phase, checkpoint, now);
    checkpoints[nextPhase] = result.phaseDone
      ? { cutoff: now }
      : { cutoff: checkpoint.cutoff, cursor: result.cursor };
    const fields = {
      key: CHECKPOINT_KEY,
      nextPhase: (nextPhase + 1) % phases.length,
      checkpoints,
    };
    if (state) await ctx.db.patch(state._id, fields);
    else {
      await ctx.db.insert("workerCleanupState", fields);
      for (const oldKey of ["v1", "v2", "v3", "v4"]) {
        const old = await ctx.db
          .query("workerCleanupState")
          .withIndex("by_key", (q) => q.eq("key", oldKey))
          .unique();
        if (old) await ctx.db.delete(old._id);
      }
    }
    return {
      phase: nextPhase,
      changed: result.changed,
      inspected: result.inspected,
      phaseDone: result.phaseDone,
    };
  },
});
