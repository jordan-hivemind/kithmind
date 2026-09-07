import { v } from "convex/values";

import { mutation, query } from "../../_generated/server";
import {
  ensurePersonalSpace,
  getAuthorizedReadSpaceIds,
  requireSpaceAccess,
} from "../../lib/spaces";
import { requireWebPrincipal } from "../../lib/webAuth";
import { spaceKind, spaceRole } from "./validators";

const listedSpace = v.object({
  spaceId: v.id("spaces"),
  name: v.string(),
  kind: spaceKind,
  role: spaceRole,
});

export const ensurePersonal = mutation({
  args: {},
  returns: v.object({ personalSpaceId: v.id("spaces") }),
  handler: async (ctx) => {
    const principal = await requireWebPrincipal(ctx);
    return {
      personalSpaceId: await ensurePersonalSpace(ctx, principal.userId),
    };
  },
});

export const list = query({
  args: {},
  returns: v.array(listedSpace),
  handler: async (ctx) => {
    const principal = await requireWebPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(ctx, principal);
    const rows = await Promise.all(
      spaceIds.map(async (spaceId) => {
        const memberships = await ctx.db
          .query("spaceMembers")
          .withIndex("by_spaceId_and_userId", (q) =>
            q.eq("spaceId", spaceId).eq("userId", principal.userId),
          )
          .take(2);
        return {
          membership: memberships[0]!,
          space: await ctx.db.get(spaceId),
        };
      }),
    );
    return rows
      .filter((row) => row.space !== null)
      .map(({ membership, space }) => ({
        spaceId: membership.spaceId,
        name: space!.name,
        kind: space!.kind,
        role: membership.role,
      }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.spaceId.localeCompare(right.spaceId),
      );
  },
});

export const getSettings = query({
  args: {},
  returns: v.object({
    personalSpaceId: v.id("spaces"),
    defaultWriteSpaceId: v.optional(v.id("spaces")),
  }),
  handler: async (ctx) => {
    const { userId } = await requireWebPrincipal(ctx);
    const settings = await ctx.db
      .query("userSpaceSettings")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!settings) throw new Error("Personal space is not configured");
    return {
      personalSpaceId: settings.personalSpaceId,
      defaultWriteSpaceId: settings.defaultWriteSpaceId,
    };
  },
});

export const setDefaultWriteSpace = mutation({
  args: { spaceId: v.optional(v.id("spaces")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const { userId } = principal;
    await ensurePersonalSpace(ctx, userId);
    if (args.spaceId) {
      await requireSpaceAccess(ctx, principal, args.spaceId, "write");
    }
    const settings = await ctx.db
      .query("userSpaceSettings")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!settings) throw new Error("Personal space is not configured");
    await ctx.db.patch(settings._id, {
      defaultWriteSpaceId: args.spaceId,
    });
    return null;
  },
});
