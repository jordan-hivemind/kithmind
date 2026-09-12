import { query } from "../../_generated/server";
import { v } from "convex/values";
import { requireWebPrincipal } from "../../lib/webAuth";
import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import {
  thoughtLifecycleFields,
  thoughtMetadata,
  thoughtType,
} from "./validators";
import { _computeSpaceStats, _listBySpaces, _listCoreBySpaces } from "./model";
import { spaceEmbeddingCoverageValidator } from "../embeddings/validators";

export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
    type: v.optional(thoughtType),
    includeHistorical: v.optional(v.boolean()),
    topic: v.optional(v.string()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.id("spaces"),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    const results = await _listBySpaces(
      ctx,
      spaceIds,
      args.limit,
      args.includeHistorical,
      { type: args.type, topic: args.topic },
    );
    return results
      .filter((row) => row.spaceId !== undefined)
      .map(({ embedding: _, ...rest }) => ({
        ...rest,
        spaceId: rest.spaceId!,
      }));
  },
});

export const listCore = query({
  args: {
    limit: v.optional(v.number()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      _creationTime: v.number(),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.id("spaces"),
      updatedAt: v.optional(v.number()),
      ...thoughtLifecycleFields,
    }),
  ),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    const results = await _listCoreBySpaces(ctx, spaceIds, args.limit);
    return results
      .filter((row) => row.spaceId !== undefined)
      .map(({ embedding: _, ...rest }) => ({
        ...rest,
        spaceId: rest.spaceId!,
      }));
  },
});

export const getStats = query({
  args: { spaceIds: v.optional(v.array(v.id("spaces"))) },
  returns: v.object({
    totalThoughts: v.number(),
    totalFacts: v.number(),
    historicalThoughts: v.number(),
    historicalFacts: v.number(),
    retractedThoughts: v.number(),
    retractedFacts: v.number(),
    byType: v.array(v.object({ type: v.string(), count: v.number() })),
    topTopics: v.array(v.object({ topic: v.string(), count: v.number() })),
    topPeople: v.array(v.object({ person: v.string(), count: v.number() })),
    dateRange: v.optional(
      v.object({
        earliest: v.number(),
        latest: v.number(),
      }),
    ),
    partial: v.boolean(),
    coverage: v.array(spaceEmbeddingCoverageValidator),
  }),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    return await _computeSpaceStats(ctx, spaceIds);
  },
});
