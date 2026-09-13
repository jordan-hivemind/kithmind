import { v } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { requireWorkerSourceAccount } from "./auth";
import {
  MAX_WORKER_DISCOVERY_ATTEMPTS,
  requireCurrentDiscovery,
  validateAdmittedChain,
} from "./discovery";

const FORGOTTEN_REPAIR_LIMIT = 25;

export async function repairForgottenProcessingStatePage(
  ctx: MutationCtx,
  args: { sourceItemId: Id<"sourceItems">; dryRun: boolean },
) {
  const item = await ctx.db.get(args.sourceItemId);
  if (!item || item.lifecycle !== "forgotten") {
    throw new Error("Repair requires one forgotten source item");
  }
  const account = await ctx.db.get(item.sourceAccountId);
  if (!account || account.spaceId !== item.spaceId) {
    throw new Error("Forgotten source item parent chain is invalid");
  }
  let remaining = FORGOTTEN_REPAIR_LIMIT;
  const counts = {
    workerBinaryOperationReceipts: 0,
    workerParsedStages: 0,
    processingGenerationPayloadManifests: 0,
  };
  let phase: keyof typeof counts | "complete" = "complete";
  let exhausted = false;

  const inspect = async (
    table: keyof typeof counts,
    rows: Array<{
      _id: Id<
        | "workerBinaryOperationReceipts"
        | "workerParsedStages"
        | "processingGenerationPayloadManifests"
      >;
      spaceId: Id<"spaces">;
      sourceAccountId: Id<"sourceAccounts">;
    }>,
  ) => {
    if (rows.length > 0 && phase === "complete") phase = table;
    counts[table] = rows.length;
    for (const row of rows) {
      if (
        row.spaceId !== item.spaceId ||
        row.sourceAccountId !== item.sourceAccountId
      ) {
        throw new Error("Forgotten processing row parent chain is invalid");
      }
      if (!args.dryRun) await ctx.db.delete(row._id);
    }
    remaining -= rows.length;
    if (remaining === 0) exhausted = true;
  };

  const binaryReceipts = await ctx.db
    .query("workerBinaryOperationReceipts")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(remaining);
  await inspect("workerBinaryOperationReceipts", binaryReceipts);
  if (remaining > 0) {
    const parsedStages = await ctx.db
      .query("workerParsedStages")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .take(remaining);
    await inspect("workerParsedStages", parsedStages);
  } else exhausted = true;
  if (remaining > 0) {
    const manifests = await ctx.db
      .query("processingGenerationPayloadManifests")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .take(remaining);
    await inspect("processingGenerationPayloadManifests", manifests);
  } else exhausted = true;
  const affected = FORGOTTEN_REPAIR_LIMIT - remaining;
  return {
    dryRun: args.dryRun,
    phase,
    counts,
    affected,
    deleted: args.dryRun ? 0 : affected,
    done: affected === 0 || (!args.dryRun && !exhausted),
  };
}

export const repairForgottenProcessingState = internalMutation({
  args: {
    sourceItemId: v.id("sourceItems"),
    dryRun: v.optional(v.boolean()),
  },
  handler: (ctx, args) =>
    repairForgottenProcessingStatePage(ctx, {
      sourceItemId: args.sourceItemId,
      dryRun: args.dryRun ?? true,
    }),
});

/** Upgrade queued B1 admissions without changing their authority or content. */
export async function backfillManagedJobsPage(
  ctx: MutationCtx,
  args: { cursor: string | null; maxItems: number; dryRun: boolean },
) {
  if (
    !Number.isInteger(args.maxItems) ||
    args.maxItems < 1 ||
    args.maxItems > 10 ||
    (args.cursor !== null && args.cursor.length > 8192)
  )
    throw new Error("Invalid migration page bounds");
  const page = await ctx.db.query("ingestJobs").paginate({
    cursor: args.cursor,
    numItems: args.maxItems,
  });
  let eligible = 0;
  let updated = 0;
  let blocked = 0;
  let skipped = 0;
  for (const job of page.page) {
    if (job.workerDiscoveryWorkId === undefined || job.workerManaged === true) {
      skipped += 1;
      continue;
    }
    const work = await ctx.db.get(job.workerDiscoveryWorkId);
    try {
      if (
        !work ||
        job.workerManaged === false ||
        job.state !== "queued" ||
        job.workerLeaseOwnerCredentialId !== undefined ||
        job.attempts !== 0 ||
        job.leaseEpoch !== 0 ||
        job.error !== undefined ||
        (job.nextAttemptAt !== undefined &&
          (!Number.isSafeInteger(job.nextAttemptAt) ||
            job.nextAttemptAt < 0)) ||
        job.leaseToken !== undefined ||
        job.leaseExpiresAt !== undefined ||
        work.state !== "admitted" ||
        work.leaseToken !== undefined ||
        work.leaseOwnerCredentialId !== undefined ||
        work.leaseExpiresAt !== undefined ||
        (work.nextAttemptAt !== undefined &&
          (!Number.isSafeInteger(work.nextAttemptAt) ||
            work.nextAttemptAt < 0)) ||
        work.ingestJobId !== job._id ||
        work.sourceRevisionId !== job.sourceRevisionId ||
        work.processingGenerationId !== job.processingGenerationId ||
        !Number.isSafeInteger(work.createdAt) ||
        work.createdAt < 0
      )
        throw new Error("Admission requires review");
      const source = await requireWorkerSourceAccount(
        ctx,
        {
          userId: work.actorUserId,
          credentialId: work.actorCredentialId,
        },
        { spaceId: job.spaceId, sourceAccountId: job.sourceAccountId },
      );
      const current = await requireCurrentDiscovery(ctx, source, work._id);
      await validateAdmittedChain(
        ctx,
        current,
        {
          sourceRevisionId: job.sourceRevisionId,
          processingGenerationId: job.processingGenerationId,
          ingestJobId: job._id,
          desiredProcessingEpoch: job.desiredProcessingEpoch,
        },
        true,
      );
    } catch {
      blocked += 1;
      continue;
    }
    eligible += 1;
    if (!args.dryRun) {
      await ctx.db.patch(job._id, {
        workerManaged: true,
        ...(job.nextAttemptAt === undefined
          ? { nextAttemptAt: work!.createdAt }
          : {}),
      });
      updated += 1;
    }
  }
  return {
    dryRun: args.dryRun,
    inspected: page.page.length,
    eligible,
    updated,
    blocked,
    skipped,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

export const backfillManagedJobs = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    maxItems: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: (ctx, args) =>
    backfillManagedJobsPage(ctx, {
      cursor: args.cursor,
      maxItems: args.maxItems ?? 10,
      dryRun: args.dryRun ?? true,
    }),
});

const REQUEUE_DEFAULT_LIMIT = 50;
const REQUEUE_MAX_LIMIT = 500;

// A transport defect (fixed in PR179/PR182) left some workerDiscoveryWork
// rows stranded in "failed"/"needs_review": failArchivedDiscovery used to
// clear nextAttemptAt even on a retryable failure (fixed in P2-80g), so
// dueDiscoveryCandidates never re-offered them. Since
// P2-80f the scan entryState rule (model.ts) re-queues a still-retryable
// failure on its own and settles an exhausted one as "unchanged", so this op
// is the operator route for re-attempting an exhausted or review-held row
// rather than the only escape from a permanent loop. It patches the row
// directly back to "queued" and never touches sourceItems, scans, or scan
// entries.
export async function requeueFailedDiscoveryWorkPage(
  ctx: MutationCtx,
  args: {
    sourceAccountId: Id<"sourceAccounts">;
    dryRun: boolean;
    limit: number;
    now: number;
  },
) {
  if (
    !Number.isInteger(args.limit) ||
    args.limit < 1 ||
    args.limit > REQUEUE_MAX_LIMIT
  )
    throw new Error("Invalid requeue page bounds");
  const byPriorState = { failed: 0, needs_review: 0 };
  let examined = 0;
  let requeued = 0;
  let skippedAttemptLimit = 0;
  for (const state of ["failed", "needs_review"] as const) {
    if (examined >= args.limit) break;
    const rows = await ctx.db
      .query("workerDiscoveryWork")
      .withIndex("by_sourceAccountId_and_state_and_nextAttemptAt", (q) =>
        q.eq("sourceAccountId", args.sourceAccountId).eq("state", state),
      )
      .take(args.limit - examined);
    for (const row of rows) {
      examined += 1;
      byPriorState[state] += 1;
      if (row.attempts >= MAX_WORKER_DISCOVERY_ATTEMPTS) {
        skippedAttemptLimit += 1;
        continue;
      }
      requeued += 1;
      if (!args.dryRun) {
        await ctx.db.patch(row._id, {
          state: "queued",
          nextAttemptAt: args.now,
          leaseToken: undefined,
          leaseOwnerCredentialId: undefined,
          leaseExpiresAt: undefined,
          retryable: undefined,
          failureCode: undefined,
        });
      }
    }
  }
  return { examined, requeued, skippedAttemptLimit, byPriorState };
}

export const requeueFailedDiscoveryWork = internalMutation({
  args: {
    sourceAccountId: v.id("sourceAccounts"),
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    requeueFailedDiscoveryWorkPage(ctx, {
      sourceAccountId: args.sourceAccountId,
      dryRun: args.dryRun ?? true,
      limit: args.limit ?? REQUEUE_DEFAULT_LIMIT,
      now: Date.now(),
    }),
});

const RESTORE_DOC_TYPE_MAX_ITEMS = 25;

/**
 * P2-80i recovery. Card activation used to patch `documents.docType` of the
 * active text generation in place. That row is part of the sealed parsed
 * payload and its `docType` is inside `manifest.documentDigest`, so every
 * patched document failed `verifySealedParsedPayload` and the worker
 * processing assessment counted it unavailable.
 *
 * This restores the sealed value from the `docTypePatch` the card version
 * recorded, and moves the accepted `card_kind` to `sourceItems.cardDocType`,
 * which is where document reads now overlay it. A patch counts as still in
 * effect only while the document still carries its `appliedDocType`, so the job
 * is idempotent: a second run finds the parser's value back on the row and
 * restores nothing. Paged over `eventVersions`; only card versions carry a
 * `docTypePatch`.
 */
export async function restoreSealedDocTypesPage(
  ctx: MutationCtx,
  args: { cursor: string | null; maxItems: number; dryRun: boolean },
) {
  if (
    !Number.isInteger(args.maxItems) ||
    args.maxItems < 1 ||
    args.maxItems > RESTORE_DOC_TYPE_MAX_ITEMS ||
    (args.cursor !== null && args.cursor.length > 8192)
  )
    throw new Error("Invalid migration page bounds");
  const page = await ctx.db.query("eventVersions").paginate({
    cursor: args.cursor,
    numItems: args.maxItems,
  });
  let patchedVersions = 0;
  let documentsRestored = 0;
  let itemsOverlaid = 0;
  let skippedNotInEffect = 0;
  for (const version of page.page) {
    const docTypePatch = version.docTypePatch;
    if (docTypePatch === undefined || docTypePatch.length === 0) continue;
    patchedVersions += 1;
    const item = await ctx.db.get(version.sourceItemId);
    if (!item || item.spaceId !== version.spaceId) {
      skippedNotInEffect += docTypePatch.length;
      continue;
    }
    let appliedInEffect: string | undefined;
    for (const entry of docTypePatch) {
      const document = await ctx.db.get(entry.documentId);
      if (
        !document ||
        document.spaceId !== version.spaceId ||
        document.sourceItemId !== item._id ||
        document.docType !== entry.appliedDocType
      ) {
        skippedNotInEffect += 1;
        continue;
      }
      if (!args.dryRun) {
        await ctx.db.patch(document._id, { docType: entry.previousDocType });
      }
      appliedInEffect = entry.appliedDocType;
      documentsRestored += 1;
    }
    // The card kind those documents were actually carrying is the one the read
    // overlay has to serve from now on.
    if (appliedInEffect !== undefined && item.cardDocType !== appliedInEffect) {
      if (!args.dryRun) {
        await ctx.db.patch(item._id, { cardDocType: appliedInEffect });
      }
      itemsOverlaid += 1;
    }
  }
  return {
    dryRun: args.dryRun,
    inspected: page.page.length,
    patchedVersions,
    documentsRestored,
    itemsOverlaid,
    skippedNotInEffect,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

export const restoreSealedDocTypes = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    maxItems: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: (ctx, args) =>
    restoreSealedDocTypesPage(ctx, {
      cursor: args.cursor,
      maxItems: args.maxItems ?? RESTORE_DOC_TYPE_MAX_ITEMS,
      dryRun: args.dryRun ?? true,
    }),
});
