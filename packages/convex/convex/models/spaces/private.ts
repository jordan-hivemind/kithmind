import { v } from "convex/values";

import { internalMutation, internalQuery } from "../../_generated/server";
import {
  getAuthorizedReadSpaceIds,
  reloadPrincipal,
  requireSpaceAccess,
  resolveWriteSpace,
} from "../../lib/spaces";
import { principalRefValidator } from "../apiKeys/validators";
import { spaceOperation, spaceRole } from "./validators";

export const authorize = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceId: v.id("spaces"),
    operation: spaceOperation,
  },
  returns: v.object({ role: spaceRole }),
  handler: async (ctx, args) => {
    const principal = await reloadPrincipal(ctx, args.principal);
    const membership = await requireSpaceAccess(
      ctx,
      principal,
      args.spaceId,
      args.operation,
    );
    return { role: membership.role };
  },
});

export const listAuthorizedReadSpaceIds = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(v.id("spaces")),
  handler: async (ctx, args) =>
    await getAuthorizedReadSpaceIds(ctx, args.principal, args.spaceIds),
});

export const authorizePersonal = internalQuery({
  args: {
    principal: principalRefValidator,
    operation: spaceOperation,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("userSpaceSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.principal.userId))
      .take(2);
    if (settings.length !== 1) throw new Error("Not authorized");
    await requireSpaceAccess(
      ctx,
      args.principal,
      settings[0]!.personalSpaceId,
      args.operation,
    );
    return null;
  },
});

export const resolveWriteDestination = internalMutation({
  args: {
    principal: principalRefValidator,
    spaceId: v.optional(v.id("spaces")),
  },
  returns: v.id("spaces"),
  handler: async (ctx, args) =>
    await resolveWriteSpace(ctx, args.principal, args.spaceId),
});
