import { query } from "../../_generated/server";
import { v } from "convex/values";

import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import { getFactById, listFacts, searchFacts } from "./model";

export const search = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    return await searchFacts(ctx, spaceIds, args.query, args);
  },
});

export const listCore = query({
  args: {
    limit: v.optional(v.number()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    return await listFacts(ctx, spaceIds, { ...args, coreOnly: true });
  },
});

export const getById = query({
  args: {
    factId: v.id("facts"),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    return await getFactById(ctx, spaceIds, args.factId);
  },
});
