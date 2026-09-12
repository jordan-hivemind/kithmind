import { v } from "convex/values";

import { query } from "../../_generated/server";
import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import { readSpaceCounters } from "../embeddings/targets";
import { spaceEmbeddingCoverageValidator } from "../embeddings/validators";
import { spaceKind, spaceRole } from "./validators";

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      spaceId: v.id("spaces"),
      name: v.string(),
      kind: spaceKind,
      role: spaceRole,
      // P2-6f: one space-state row per space. No thought row and no vector row.
      coverage: spaceEmbeddingCoverageValidator,
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
        counters: await readSpaceCounters(ctx, spaceId),
      })),
    );
    return rows
      .filter((row) => row.space !== null && row.memberships.length === 1)
      .map(({ space, memberships, counters }) => ({
        spaceId: space!._id,
        name: space!.name,
        kind: space!.kind,
        role: memberships[0]!.role,
        coverage: counters.coverage,
      }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.spaceId.localeCompare(right.spaceId),
      );
  },
});
