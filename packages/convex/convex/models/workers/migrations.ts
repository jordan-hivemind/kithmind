import { v } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { requireWorkerSourceAccount } from "./auth";
import { requireCurrentDiscovery, validateAdmittedChain } from "./discovery";

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
