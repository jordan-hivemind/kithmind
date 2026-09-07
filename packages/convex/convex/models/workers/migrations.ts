import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { requireWorkerSourceAccount } from "./auth";
import { requireCurrentDiscovery, validateAdmittedChain } from "./discovery";

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
