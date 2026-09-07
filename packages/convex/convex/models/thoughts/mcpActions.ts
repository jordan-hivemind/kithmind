import { action } from "../../_generated/server";
import { internal as _internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { v, type Infer } from "convex/values";
import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { principalRef } from "../../lib/spaces";
import type { MemoryStatus } from "./memoryLifecycle";
import { memorySourceType, memoryStatus, thoughtMetadata } from "./validators";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internal = _internal as any;

const SNIPPET_CHARS = 240;

function truncateSnippet(content: string): string {
  const chars: string[] = [];
  for (const ch of content) {
    if (chars.length >= SNIPPET_CHARS) {
      return chars.join("") + "…";
    }
    chars.push(ch);
  }
  return content;
}

export const capture = action({
  args: {
    content: v.string(),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    isCore: v.optional(v.boolean()),
    sourceType: v.optional(memorySourceType),
    sourceRef: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    batchId: v.optional(v.string()),
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
    const principal = await requireMcpPrincipal(ctx);
    if (
      !principal.capabilities.includes("read") ||
      !principal.capabilities.includes("write")
    ) {
      throw new Error("Thought capture requires read and write capabilities");
    }
    const ref = principalRef(principal);
    const spaceId: Id<"spaces"> = await ctx.runMutation(
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
        sourceType: args.sourceType,
        sourceRef: args.sourceRef,
        observedAt: args.observedAt,
        batchId: args.batchId,
      },
    );
  },
});

export const search = action({
  args: {
    query: v.string(),
    type: v.optional(
      v.union(
        v.literal("decision"),
        v.literal("person_note"),
        v.literal("idea"),
        v.literal("meeting_note"),
        v.literal("task"),
        v.literal("reference"),
      ),
    ),
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      summary: v.string(),
      snippet: v.string(),
      type: v.string(),
      topics: v.array(v.string()),
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
    const principal = await requireMcpPrincipal(ctx);
    const hits: Array<{
      _id: Id<"thoughts">;
      content: string;
      metadata: Infer<typeof thoughtMetadata>;
      userId: Id<"users">;
      spaceId: Id<"spaces">;
      score: number;
      createdAt: number;
      memoryStatus: MemoryStatus;
      isCore?: boolean;
      validFrom?: number;
      validTo?: number;
      supersededAt?: number;
      changeReason?: string;
    }> = await ctx.runAction(internal.models.thoughts.actions.hybridSearch, {
      principal: principalRef(principal),
      spaceIds: args.spaceIds,
      query: args.query,
      type: args.type,
      limit: args.limit,
      includeHistorical: args.includeHistorical,
    });

    return hits.map((h) => ({
      _id: h._id,
      summary: h.metadata.summary,
      snippet: truncateSnippet(h.content),
      type: h.metadata.type,
      topics: h.metadata.topics,
      userId: h.userId,
      spaceId: h.spaceId,
      score: h.score,
      createdAt: h.createdAt,
      memoryStatus: h.memoryStatus,
      isCore: h.isCore,
      validFrom: h.validFrom,
      validTo: h.validTo,
      supersededAt: h.supersededAt,
      changeReason: h.changeReason,
    }));
  },
});

export const getByIds = action({
  args: {
    ids: v.array(v.id("thoughts")),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.id("spaces"),
      createdAt: v.number(),
      updatedAt: v.optional(v.number()),
      memoryStatus,
      isCore: v.optional(v.boolean()),
      validFrom: v.optional(v.number()),
      validTo: v.optional(v.number()),
      supersededAt: v.optional(v.number()),
      supersededBy: v.optional(v.id("thoughts")),
      supersedes: v.optional(v.array(v.id("thoughts"))),
      changeReason: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.ids.length > 100) throw new Error("Too many thought IDs");
    const principal = await requireMcpPrincipal(ctx);
    const docs: Array<{
      _id: Id<"thoughts">;
      _creationTime: number;
      content: string;
      metadata: Infer<typeof thoughtMetadata>;
      userId: string;
      spaceId?: Id<"spaces">;
      updatedAt?: number;
      memoryStatus?: MemoryStatus;
      isCore?: boolean;
      validFrom?: number;
      validTo?: number;
      supersededAt?: number;
      supersededBy?: Id<"thoughts">;
      supersedes?: Array<Id<"thoughts">>;
      changeReason?: string;
    }> = await ctx.runQuery(
      internal.models.thoughts.private.getByIdsAuthorized,
      {
        principal: principalRef(principal),
        spaceIds: args.spaceIds,
        ids: args.ids,
      },
    );

    return docs
      .filter((d) => d.spaceId !== undefined)
      .map((d) => ({
        _id: d._id,
        content: d.content,
        metadata: d.metadata,
        userId: d.userId as Id<"users">,
        spaceId: d.spaceId!,
        createdAt: d._creationTime,
        updatedAt: d.updatedAt,
        memoryStatus: d.memoryStatus ?? "current",
        isCore: d.isCore,
        validFrom: d.validFrom,
        validTo: d.validTo,
        supersededAt: d.supersededAt,
        supersededBy: d.supersededBy,
        supersedes: d.supersedes,
        changeReason: d.changeReason,
      }));
  },
});

export const timeline = action({
  args: {
    seedId: v.optional(v.id("thoughts")),
    aroundMs: v.optional(v.number()),
    before: v.optional(v.number()),
    after: v.optional(v.number()),
    type: v.optional(
      v.union(
        v.literal("decision"),
        v.literal("person_note"),
        v.literal("idea"),
        v.literal("meeting_note"),
        v.literal("task"),
        v.literal("reference"),
      ),
    ),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      summary: v.string(),
      snippet: v.string(),
      type: v.string(),
      topics: v.array(v.string()),
      userId: v.id("users"),
      spaceId: v.id("spaces"),
      createdAt: v.number(),
      memoryStatus,
      isCore: v.optional(v.boolean()),
      validFrom: v.optional(v.number()),
      validTo: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const ref = principalRef(principal);
    const MAX_WINDOW = 50;
    const before = Math.min(args.before ?? 5, MAX_WINDOW);
    const after = Math.min(args.after ?? 5, MAX_WINDOW);

    const docs: Array<{
      _id: Id<"thoughts">;
      _creationTime: number;
      content: string;
      metadata: Infer<typeof thoughtMetadata>;
      userId: Id<"users">;
      spaceId?: Id<"spaces">;
      memoryStatus?: MemoryStatus;
      isCore?: boolean;
      validFrom?: number;
      validTo?: number;
    }> = await ctx.runQuery(
      internal.models.thoughts.private.listAroundTimeAuthorized,
      {
        principal: ref,
        spaceIds: args.spaceIds,
        seedId: args.seedId,
        aroundMs: args.aroundMs,
        before,
        after,
        type: args.type,
      },
    );

    return docs.map((d) => ({
      _id: d._id,
      summary: d.metadata.summary,
      snippet: truncateSnippet(d.content),
      type: d.metadata.type,
      topics: d.metadata.topics,
      userId: d.userId,
      spaceId: d.spaceId!,
      createdAt: d._creationTime,
      memoryStatus: d.memoryStatus ?? "current",
      isCore: d.isCore,
      validFrom: d.validFrom,
      validTo: d.validTo,
    }));
  },
});
