import { query } from "../../_generated/server";
import { v } from "convex/values";

import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import { requireWebPrincipal } from "../../lib/webAuth";
import { getFactById, listFacts } from "./model";

export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    return await listFacts(ctx, spaceIds, args);
  },
});

export const getById = query({
  args: {
    factId: v.id("facts"),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    return await getFactById(ctx, spaceIds, args.factId);
  },
});
