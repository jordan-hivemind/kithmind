import { internal } from "../../_generated/api";
import { internalAction, internalMutation } from "../../_generated/server";
import { v } from "convex/values";

import { principalRefValidator } from "../apiKeys/validators";
import { planInlineText } from "./inlineText";
import { inlineIngestInputValidator } from "./inlineInput";
import {
  INLINE_WORK_FALLBACK_DELAY_MS,
  admitInlineWork,
  claimInlineWork,
  getInlineIngestResult,
  recordInlineWorkFailure,
  reserveRecoverableInlineWork,
  syncInlineWorkState,
} from "./inlineWork";
import type { Id } from "../../_generated/dataModel";

export const admit = internalMutation({
  args: {
    principal: principalRefValidator,
    input: inlineIngestInputValidator,
  },
  handler: async (ctx, args) => {
    if (!args.principal.credentialId) throw new Error("Not authenticated");
    const admitted = await admitInlineWork(ctx, {
      principal: {
        userId: args.principal.userId,
        credentialId: args.principal.credentialId,
      },
      input: args.input,
      now: Date.now(),
    });
    if (admitted.newWork) {
      await ctx.scheduler.runAfter(
        INLINE_WORK_FALLBACK_DELAY_MS,
        internal.models.ingestion.inlineWorker.process,
        { workId: admitted.workId },
      );
    }
    return admitted;
  },
});

export const claim = internalMutation({
  args: { workId: v.id("inlineWork"), leaseToken: v.string() },
  handler: async (ctx, args) =>
    await claimInlineWork(ctx, { ...args, now: Date.now() }),
});

export const recordFailure = internalMutation({
  args: {
    workId: v.id("inlineWork"),
    leaseEpoch: v.number(),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) =>
    await recordInlineWorkFailure(ctx, { ...args, now: Date.now() }),
});

export const syncState = internalMutation({
  args: { workId: v.id("inlineWork") },
  handler: async (ctx, args) =>
    await syncInlineWorkState(ctx, { ...args, now: Date.now() }),
});

export const result = internalMutation({
  args: { principal: principalRefValidator, workId: v.id("inlineWork") },
  handler: getInlineIngestResult,
});

export const reserveRecoveryBatch = internalMutation({
  args: {},
  handler: async (ctx) => await reserveRecoverableInlineWork(ctx, Date.now()),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const process = internalAction({
  args: { workId: v.id("inlineWork") },
  handler: async (ctx, args): Promise<{ state: string }> => {
    const leaseToken = crypto.randomUUID();
    const claimed: Awaited<ReturnType<typeof claimInlineWork>> =
      await ctx.runMutation(internal.models.ingestion.inlineWorker.claim, {
        workId: args.workId,
        leaseToken,
      });
    if (claimed.kind === "busy") {
      return { state: "queued" as const };
    }
    if (claimed.kind !== "claimed") {
      return { state: claimed.state ?? "failed" };
    }

    const lease = {
      principal: claimed.principal,
      jobId: claimed.jobId,
      leaseEpoch: claimed.leaseEpoch,
      leaseToken: claimed.leaseToken,
    };
    const stopIfObsolete = async (value: { state?: string }) => {
      if (value.state !== "obsolete_generation") return false;
      await ctx.runMutation(internal.models.ingestion.inlineWorker.syncState, {
        workId: args.workId,
      });
      return true;
    };

    let phase = "activation";
    try {
      if (!claimed.alreadyStaged) {
        const plan = planInlineText(claimed.text);
        phase = "text version";
        const textVersion = await ctx.runMutation(
          internal.models.ingestion.private.createTextVersion,
          { ...lease, text: claimed.text },
        );
        if (await stopIfObsolete(textVersion)) return { state: "failed" };
        phase = "pages";
        const pages = await ctx.runMutation(
          internal.models.ingestion.private.stagePages,
          {
            ...lease,
            pages: [
              {
                ordinal: 0,
                start: 0,
                end: claimed.text.length,
                text: claimed.text,
              },
            ],
          },
        );
        if (pages.state === "obsolete_generation") {
          await ctx.runMutation(
            internal.models.ingestion.inlineWorker.syncState,
            { workId: args.workId },
          );
          return { state: "failed" };
        }
        const pageId = pages.ids[0]?._id;
        if (!pageId) throw new Error("Inline page staging is incomplete");

        const spanIds: Id<"evidenceSpans">[] = [];
        phase = "evidence spans";
        for (let offset = 0; offset < plan.chunks.length; offset += 25) {
          const spanBatch = plan.chunks
            .slice(offset, offset + 25)
            .map((chunk) => ({
              sourcePageId: pageId,
              ordinal: chunk.ordinal,
              start: chunk.start,
              end: chunk.end,
              locator: { kind: "page" as const, label: "Inline text" },
            }));
          const spans = await ctx.runMutation(
            internal.models.ingestion.private.stageEvidenceSpans,
            { ...lease, spans: spanBatch },
          );
          if (spans.state === "obsolete_generation") {
            await ctx.runMutation(
              internal.models.ingestion.inlineWorker.syncState,
              { workId: args.workId },
            );
            return { state: "failed" };
          }
          spanIds.push(...spans.ids.map((span) => span._id));
        }

        phase = "document";
        const documents = await ctx.runMutation(
          internal.models.ingestion.private.stageDocuments,
          {
            ...lease,
            documents: [
              {
                documentKey: "inline-document:0",
                title: claimed.title,
                docType: claimed.docType,
                capturedAt: claimed.capturedAt,
                evidenceSpanIds: spanIds,
              },
            ],
          },
        );
        if (documents.state === "obsolete_generation") {
          await ctx.runMutation(
            internal.models.ingestion.inlineWorker.syncState,
            { workId: args.workId },
          );
          return { state: "failed" };
        }
        const documentId = documents.ids[0]?._id;
        if (!documentId)
          throw new Error("Inline document staging is incomplete");

        phase = "chunks";
        for (let offset = 0; offset < plan.chunks.length; offset += 25) {
          const chunkBatch = [];
          for (const [batchIndex, chunk] of plan.chunks
            .slice(offset, offset + 25)
            .entries()) {
            const evidenceSpanId = spanIds[offset + batchIndex];
            if (!evidenceSpanId) {
              throw new Error("Inline chunk evidence is incomplete");
            }
            chunkBatch.push({
              documentId,
              ordinal: chunk.ordinal,
              text: chunk.text,
              evidenceSpanIds: [evidenceSpanId],
            });
          }
          const chunks = await ctx.runMutation(
            internal.models.ingestion.private.stageChunks,
            { ...lease, chunks: chunkBatch },
          );
          if (chunks.state === "obsolete_generation") {
            await ctx.runMutation(
              internal.models.ingestion.inlineWorker.syncState,
              { workId: args.workId },
            );
            return { state: "failed" };
          }
        }

        phase = "final staging";
        const staged = await ctx.runMutation(
          internal.models.ingestion.private.stage,
          lease,
        );
        if (await stopIfObsolete(staged)) return { state: "failed" };
      }

      phase = "activation";
      const activated = await ctx.runMutation(
        internal.models.ingestion.private.activate,
        lease,
      );
      if (await stopIfObsolete(activated)) return { state: "failed" };
      await ctx.runMutation(internal.models.ingestion.inlineWorker.syncState, {
        workId: args.workId,
      });
      return { state: "ready" as const };
    } catch (error) {
      const failure: Awaited<ReturnType<typeof recordInlineWorkFailure>> =
        await ctx.runMutation(
          internal.models.ingestion.inlineWorker.recordFailure,
          {
            workId: args.workId,
            leaseEpoch: claimed.leaseEpoch,
            leaseToken: claimed.leaseToken,
            error: `${phase}: ${errorMessage(error)}`,
          },
        );
      return { state: failure.state };
    }
  },
});

export const recover = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const workIds: Id<"inlineWork">[] = await ctx.runMutation(
      internal.models.ingestion.inlineWorker.reserveRecoveryBatch,
      {},
    );
    for (const workId of workIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.models.ingestion.inlineWorker.process,
        { workId },
      );
    }
    return { scheduled: workIds.length };
  },
});
