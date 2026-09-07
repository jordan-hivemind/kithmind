import { internal } from "../../_generated/api";
import { action } from "../../_generated/server";
import { v } from "convex/values";

import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { principalRef } from "../../lib/spaces";
import { inlineIngestInputValidator } from "./inlineInput";
import type { InlineIngestResult } from "./inlineWork";
import type { admitInlineWork } from "./inlineWork";

export const ingest = action({
  args: { input: inlineIngestInputValidator },
  returns: v.object({
    sourceItemId: v.id("sourceItems"),
    sourceRevisionId: v.id("sourceRevisions"),
    processingGenerationId: v.id("processingGenerations"),
    ingestJobId: v.id("ingestJobs"),
    documentId: v.optional(v.id("documents")),
    desiredProcessingEpoch: v.number(),
    isActive: v.boolean(),
    state: v.union(
      v.literal("ready"),
      v.literal("queued"),
      v.literal("needs_review"),
      v.literal("failed"),
    ),
  }),
  handler: async (ctx, args): Promise<InlineIngestResult> => {
    const principal = await requireMcpPrincipal(ctx);
    if (!principal.credentialId) throw new Error("Not authenticated");
    const ref = principalRef(principal);
    const admitted: Awaited<ReturnType<typeof admitInlineWork>> =
      await ctx.runMutation(internal.models.ingestion.inlineWorker.admit, {
        principal: ref,
        input: args.input,
      });
    await ctx.runAction(internal.models.ingestion.inlineWorker.process, {
      workId: admitted.workId,
    });
    return await ctx.runMutation(
      internal.models.ingestion.inlineWorker.result,
      { principal: ref, workId: admitted.workId },
    );
  },
});
