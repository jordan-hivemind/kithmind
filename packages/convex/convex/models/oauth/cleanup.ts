import { v } from "convex/values";

import { internalMutation } from "../../_generated/server";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export const removeExpired = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error("OAuth cleanup limit is invalid");
    }
    const now = Date.now();
    let deleted = 0;
    let hasMore = false;

    const pending = await ctx.db
      .query("apiKeys")
      .withIndex("by_oauthLifecycle_and_oauthGrantExpiresAt", (q) =>
        q.eq("oauthLifecycle", "pending").lt("oauthGrantExpiresAt", now),
      )
      .take(limit + 1);
    hasMore ||= pending.length > limit;
    for (const key of pending.slice(0, limit)) {
      if (key.oauthLifecycle === "pending" && key.oauthGrantExpiresAt! < now) {
        await ctx.db.delete(key._id);
        deleted += 1;
      }
    }

    if (deleted < limit) {
      const preparing = await ctx.db
        .query("apiKeys")
        .withIndex("by_oauthLifecycle_and_oauthGrantExpiresAt", (q) =>
          q.eq("oauthLifecycle", "preparing").lt("oauthGrantExpiresAt", now),
        )
        .take(limit - deleted + 1);
      hasMore ||= preparing.length > limit - deleted;
      for (const key of preparing.slice(0, limit - deleted)) {
        if (
          key.oauthLifecycle === "preparing" &&
          key.oauthGrantExpiresAt! < now
        ) {
          await ctx.db.delete(key._id);
          deleted += 1;
        }
      }
    }

    if (deleted < limit) {
      const receipts = await ctx.db
        .query("consumedOAuthCodes")
        .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
        .take(limit - deleted + 1);
      hasMore ||= receipts.length > limit - deleted;
      for (const receipt of receipts.slice(0, limit - deleted)) {
        await ctx.db.delete(receipt._id);
        deleted += 1;
      }
    }
    return { deleted, hasMore: hasMore || deleted === limit };
  },
});
