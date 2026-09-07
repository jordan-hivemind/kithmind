import { ConvexError, v } from "convex/values";

import { mutation } from "../../_generated/server";
import { requireOAuthExchangeIdentity } from "../../lib/mcpAuth";
import { requireSpaceAccess, webPrincipal } from "../../lib/spaces";
import { hasNoOAuthLifecycle, isPendingOAuthKey } from "../apiKeys/validators";

const MAX_AUTHORIZATION_CODE_LIFETIME_MS = 10 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;

function invalidGrant(): never {
  throw new ConvexError({
    code: "invalid_grant",
    message: "Authorization code is invalid or was already used.",
  });
}

export const activateAuthorizationGrant = mutation({
  args: {
    codeHash: v.string(),
    keyHash: v.string(),
    bindingHash: v.string(),
    requestHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.object({
    status: v.union(v.literal("activated"), v.literal("replayed")),
  }),
  handler: async (ctx, args) => {
    const exchange = await requireOAuthExchangeIdentity(ctx);
    const now = Date.now();
    if (
      !HASH.test(args.codeHash) ||
      !HASH.test(args.keyHash) ||
      !HASH.test(args.bindingHash) ||
      !HASH.test(args.requestHash) ||
      args.codeHash !== exchange.codeHash ||
      args.keyHash !== exchange.keyHash ||
      args.keyHash !== exchange.key.keyHash ||
      args.bindingHash !== exchange.bindingHash ||
      args.requestHash !== exchange.requestHash ||
      !Number.isSafeInteger(args.expiresAt) ||
      args.expiresAt <= now ||
      args.expiresAt > now + MAX_AUTHORIZATION_CODE_LIFETIME_MS
    ) {
      invalidGrant();
    }

    const existing = await ctx.db
      .query("consumedOAuthCodes")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", args.codeHash))
      .take(2);
    if (existing.length > 1) invalidGrant();
    const receipt = existing[0];
    if (receipt) {
      const safelyBound =
        receipt.apiKeyId === exchange.key._id &&
        receipt.userId === exchange.userId &&
        receipt.requestHash === args.requestHash &&
        receipt.bindingHash === args.bindingHash &&
        receipt.keyHash === exchange.key.keyHash;
      if (!safelyBound) invalidGrant();
      if (hasNoOAuthLifecycle(exchange.key)) {
        await ctx.db.delete(exchange.key._id);
      }
      return { status: "replayed" as const };
    }

    const key = exchange.key;
    if (
      !isPendingOAuthKey(key) ||
      key.oauthCodeHash !== args.codeHash ||
      key.oauthBindingHash !== args.bindingHash ||
      key.oauthRequestHash !== args.requestHash ||
      key.oauthGrantExpiresAt !== args.expiresAt ||
      key.oauthGrantExpiresAt <= now ||
      key.capabilities.length === 0 ||
      key.capabilities.length > 2 ||
      key.spaceIds.length === 0 ||
      key.spaceIds.length > 100 ||
      Boolean(key.sourceAccountIds?.length)
    ) {
      invalidGrant();
    }
    if (
      key.capabilities.some(
        (capability) => capability !== "read" && capability !== "write",
      ) ||
      new Set(key.capabilities).size !== key.capabilities.length ||
      new Set(key.spaceIds).size !== key.spaceIds.length
    ) {
      invalidGrant();
    }
    const principal = webPrincipal(exchange.userId);
    try {
      for (const spaceId of key.spaceIds) {
        await requireSpaceAccess(ctx, principal, spaceId, "read");
      }
    } catch {
      invalidGrant();
    }

    await ctx.db.insert("consumedOAuthCodes", {
      userId: exchange.userId,
      apiKeyId: key._id,
      requestHash: args.requestHash,
      codeHash: args.codeHash,
      bindingHash: args.bindingHash,
      keyHash: key.keyHash,
      expiresAt: args.expiresAt,
    });
    await ctx.db.patch(key._id, {
      oauthLifecycle: undefined,
      oauthRequestHash: undefined,
      oauthCodeHash: undefined,
      oauthBindingHash: undefined,
      oauthBindingSeedHash: undefined,
      oauthEncryptedCode: undefined,
      oauthGrantExpiresAt: undefined,
      oauthPreparationExpiresAt: undefined,
      oauthPreparationNonce: undefined,
      lastUsedAt: now,
    });
    return { status: "activated" as const };
  },
});
