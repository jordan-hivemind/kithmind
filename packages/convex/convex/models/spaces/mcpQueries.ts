import { v } from "convex/values";

import { query } from "../../_generated/server";
import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import { spaceKind, spaceRole } from "./validators";

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      spaceId: v.id("spaces"),
      name: v.string(),
      kind: spaceKind,
      role: spaceRole,
    }),
  ),
  handler: async (ctx) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(ctx, principal);
    const rows = await Promise.all(
      spaceIds.map(async (spaceId) => ({
        space: await ctx.db.get(spaceId),
        memberships: await ctx.db
          .query("spaceMembers")
          .withIndex("by_spaceId_and_userId", (q) =>
            q.eq("spaceId", spaceId).eq("userId", principal.userId),
          )
          .take(2),
      })),
    );
    return rows
      .filter((row) => row.space !== null && row.memberships.length === 1)
      .map(({ space, memberships }) => ({
        spaceId: space!._id,
        name: space!.name,
        kind: space!.kind,
        role: memberships[0]!.role,
      }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.spaceId.localeCompare(right.spaceId),
      );
  },
});
