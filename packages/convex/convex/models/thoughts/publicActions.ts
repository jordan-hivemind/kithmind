import { action } from "../../_generated/server";
import { internal as _internal } from "../../_generated/api";
import { v } from "convex/values";
import { requireWebPrincipal } from "../../lib/webAuth";
import { principalRef } from "../../lib/spaces";
import { memoryStatus, thoughtMetadata } from "./validators";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internal = _internal as any;

export const capture = action({
  args: {
    content: v.string(),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    isCore: v.optional(v.boolean()),
    spaceId: v.optional(v.id("spaces")),
  },
  returns: v.object({
    thoughtId: v.optional(v.id("thoughts")),
    metadata: thoughtMetadata,
    disposition: v.union(
      v.literal("stored"),
      v.literal("duplicate"),
      v.literal("superseded"),
      v.literal("corrected"),
      v.literal("needs_confirmation"),
      v.literal("skipped"),
    ),
    operationSummary: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const ref = principalRef(principal);
    const spaceId = await ctx.runMutation(
      internal.models.thoughts.private.resolveWriteSpaceForAction,
      { principal: ref, spaceId: args.spaceId },
    );

    return await ctx.runAction(
      internal.models.thoughts.actions.captureThought,
      {
        principal: ref,
        spaceId,
        content: args.content,
        validFrom: args.validFrom,
        validTo: args.validTo,
        isCore: args.isCore,
        sourceType: "user_confirmed",
      },
    );
  },
});

export const search = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.id("spaces"),
      score: v.float64(),
      createdAt: v.number(),
      memoryStatus,
      isCore: v.optional(v.boolean()),
      validFrom: v.optional(v.number()),
      validTo: v.optional(v.number()),
      supersededAt: v.optional(v.number()),
      changeReason: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);

    return await ctx.runAction(internal.models.thoughts.actions.hybridSearch, {
      principal: principalRef(principal),
      spaceIds: args.spaceIds,
      query: args.query,
      limit: args.limit,
    });
  },
});
