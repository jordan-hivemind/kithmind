import { internalQuery, internalMutation } from "../../_generated/server";
import { v } from "convex/values";
import { _findByHash } from "./model";
import { hasNoOAuthLifecycle } from "./validators";

export const findByHash = internalQuery({
  args: { keyHash: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("apiKeys"),
      _creationTime: v.number(),
      userId: v.id("users"),
      keyHash: v.string(),
      keyPrefix: v.string(),
      name: v.string(),
      lastUsedAt: v.optional(v.number()),
      capabilities: v.optional(
        v.array(
          v.union(v.literal("read"), v.literal("write"), v.literal("ingest")),
        ),
      ),
      spaceIds: v.optional(v.array(v.id("spaces"))),
      sourceAccountIds: v.optional(v.array(v.id("sourceAccounts"))),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const key = await _findByHash(ctx, args.keyHash);
    return key && hasNoOAuthLifecycle(key) && (await ctx.db.get(key.userId))
      ? key
      : null;
  },
});

export const getById = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("apiKeys", args.id);
    const key = id ? await ctx.db.get(id) : null;
    return key && hasNoOAuthLifecycle(key) && (await ctx.db.get(key.userId))
      ? key
      : null;
  },
});

export const updateLastUsed = internalMutation({
  args: { id: v.id("apiKeys") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.id);
    if (!key || !hasNoOAuthLifecycle(key) || !(await ctx.db.get(key.userId))) {
      return false;
    }
    await ctx.db.patch(args.id, { lastUsedAt: Date.now() });
    return true;
  },
});
