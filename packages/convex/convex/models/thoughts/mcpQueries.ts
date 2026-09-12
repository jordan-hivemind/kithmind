import { query } from "../../_generated/server";
import { v } from "convex/values";

import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import { spaceEmbeddingCoverageValidator } from "../embeddings/validators";
import { _computeSpaceStats, _listBySpaces, _listCoreBySpaces } from "./model";
import {
  thoughtLifecycleFields,
  thoughtMetadata,
  thoughtType,
} from "./validators";

const result = v.object({
  _id: v.id("thoughts"),
  _creationTime: v.number(),
  content: v.string(),
  metadata: thoughtMetadata,
  userId: v.id("users"),
  spaceId: v.id("spaces"),
  updatedAt: v.optional(v.number()),
  ...thoughtLifecycleFields,
});

export const listByUser = query({
  args: {
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
    type: v.optional(thoughtType),
    topic: v.optional(v.string()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(result),
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    const rows = await _listBySpaces(
      ctx,
      spaceIds,
      args.limit,
      args.includeHistorical,
      { type: args.type, topic: args.topic },
    );
    return rows
      .filter((row) => row.spaceId !== undefined)
      .map(({ embedding: _embedding, ...row }) => ({
        ...row,
        spaceId: row.spaceId!,
      }));
  },
});

export const listCore = query({
  args: {
    limit: v.optional(v.number()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(result),
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    const rows = await _listCoreBySpaces(ctx, spaceIds, args.limit);
    return rows
      .filter((row) => row.spaceId !== undefined)
      .map(({ embedding: _embedding, ...row }) => ({
        ...row,
        spaceId: row.spaceId!,
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
    partial: v.boolean(),
    coverage: v.array(spaceEmbeddingCoverageValidator),
  }),
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    const { dateRange: _dateRange, ...stats } = await _computeSpaceStats(
      ctx,
      spaceIds,
    );
    return stats;
  },
});
