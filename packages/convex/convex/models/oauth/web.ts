import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import { mutation, type MutationCtx } from "../../_generated/server";
import type { Principal } from "../../lib/spaces";
import {
  generateApiKeyMaterial,
  validateApiKeyName,
  validateApiKeyScopes,
} from "../apiKeys/public";
import { capability } from "../apiKeys/validators";
import { isPendingOAuthKey, isPreparingOAuthKey } from "../apiKeys/validators";
import { oauthError, requireOAuthWebPrincipal } from "./errors";

const GRANT_LIFETIME_MS = 5 * 60 * 1000;
const PREPARATION_LIFETIME_MS = 30 * 1000;
const MAX_LIVE_GRANTS_PER_USER = 20;
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{64}$/;

const beginArgs = {
  clientId: v.string(),
  redirectUri: v.string(),
  resource: v.string(),
  codeChallenge: v.string(),
  scope: v.literal("open-brain"),
  state: v.optional(v.string()),
  name: v.string(),
  capabilities: v.array(capability),
  spaceIds: v.array(v.string()),
};

const beginResult = v.union(
  v.object({
    status: v.literal("issued"),
    keyId: v.id("apiKeys"),
    userId: v.id("users"),
    rawKey: v.string(),
    requestHash: v.string(),
    bindingSeedHash: v.string(),
    preparationNonce: v.string(),
    grantExpiresAt: v.number(),
  }),
  v.object({
    status: v.literal("pending"),
    keyId: v.id("apiKeys"),
    encryptedCode: v.string(),
    grantExpiresAt: v.number(),
  }),
  v.object({
    status: v.literal("preparing"),
    retryAfterMs: v.number(),
  }),
  v.object({ status: v.literal("consumed") }),
);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: string): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

function requireBoundedString(
  value: string,
  maximum: number,
  allowEmpty = false,
): void {
  if (
    (!allowEmpty && !value.trim()) ||
    value.length > maximum ||
    new TextDecoder().decode(new TextEncoder().encode(value)) !== value
  ) {
    oauthError("invalid_input");
  }
}

function canonicalConsent(args: {
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  scope: "open-brain";
  state?: string;
  name: string;
  capabilities: Array<"read" | "write" | "ingest">;
  spaceIds: Id<"spaces">[];
}) {
  requireBoundedString(args.clientId, 8192);
  requireBoundedString(args.redirectUri, 2048);
  requireBoundedString(args.resource, 2048);
  requireBoundedString(args.codeChallenge, 43);
  requireBoundedString(args.state ?? "", 1024, true);
  if (!/^[A-Za-z0-9_-]{43}$/.test(args.codeChallenge)) {
    oauthError("invalid_input");
  }
  if (
    args.capabilities.some((capability) => capability === "ingest") ||
    args.capabilities.length > 2
  ) {
    oauthError("invalid_input");
  }
  return JSON.stringify({
    version: "oauth-consent-v1",
    clientId: args.clientId,
    redirectUri: args.redirectUri,
    resource: args.resource,
    codeChallenge: args.codeChallenge,
    scope: args.scope,
    state: args.state ?? null,
    name: args.name,
    capabilities: [...args.capabilities].sort(),
    spaceIds: [...args.spaceIds].map(String).sort(),
  });
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

async function validateStoredScopes(
  ctx: MutationCtx,
  principal: Principal,
  key: Doc<"apiKeys">,
) {
  try {
    await validateApiKeyScopes(
      ctx,
      principal,
      key.capabilities,
      key.spaceIds,
      key.sourceAccountIds ?? [],
    );
  } catch {
    oauthError("authorization_revoked");
  }
}

export const beginAuthorizationGrant = mutation({
  args: beginArgs,
  returns: beginResult,
  handler: async (ctx, args) => {
    const principal = await requireOAuthWebPrincipal(ctx);
    if (
      args.spaceIds.length === 0 ||
      args.spaceIds.length > 100 ||
      new Set(args.spaceIds).size !== args.spaceIds.length
    ) {
      oauthError("invalid_input");
    }
    const spaceIds = args.spaceIds.map((rawId) => {
      if (!rawId.trim() || rawId.length > 128) oauthError("invalid_input");
      const id = ctx.db.normalizeId("spaces", rawId);
      if (!id) oauthError("invalid_input");
      return id;
    });
    try {
      validateApiKeyName(args.name);
      await validateApiKeyScopes(
        ctx,
        principal,
        args.capabilities,
        spaceIds,
        [],
      );
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      oauthError("authorization_revoked");
    }
    const canonical = canonicalConsent({ ...args, spaceIds });
    const requestHash = await sha256(canonical);
    const now = Date.now();

    const consumed = await ctx.db
      .query("consumedOAuthCodes")
      .withIndex("by_userId_and_requestHash", (q) =>
        q.eq("userId", principal.userId).eq("requestHash", requestHash),
      )
      .take(2);
    if (consumed.length > 1) {
      throw new ConvexError({
        code: "invalid_oauth_state",
        message: "OAuth authorization state is invalid.",
      });
    }
    if (consumed[0] && consumed[0].expiresAt > now) {
      return { status: "consumed" as const };
    }
    if (consumed[0]) await ctx.db.delete(consumed[0]._id);

    const matches = await ctx.db
      .query("apiKeys")
      .withIndex("by_userId_and_oauthRequestHash", (q) =>
        q.eq("userId", principal.userId).eq("oauthRequestHash", requestHash),
      )
      .take(2);
    if (matches.length > 1) {
      throw new ConvexError({
        code: "invalid_oauth_state",
        message: "OAuth authorization state is invalid.",
      });
    }
    const existing = matches[0];
    if (
      existing &&
      isPendingOAuthKey(existing) &&
      existing.oauthGrantExpiresAt > now
    ) {
      await validateStoredScopes(ctx, principal, existing);
      return {
        status: "pending" as const,
        keyId: existing._id,
        encryptedCode: existing.oauthEncryptedCode,
        grantExpiresAt: existing.oauthGrantExpiresAt,
      };
    }
    if (
      existing &&
      isPreparingOAuthKey(existing) &&
      existing.oauthGrantExpiresAt > now &&
      existing.oauthPreparationExpiresAt > now
    ) {
      return {
        status: "preparing" as const,
        retryAfterMs: existing.oauthPreparationExpiresAt - now,
      };
    }
    if (existing) await ctx.db.delete(existing._id);

    const livePreparing = await ctx.db
      .query("apiKeys")
      .withIndex("by_userId_oauthLifecycle_grantExpiresAt", (q) =>
        q
          .eq("userId", principal.userId)
          .eq("oauthLifecycle", "preparing")
          .gt("oauthGrantExpiresAt", now),
      )
      .take(MAX_LIVE_GRANTS_PER_USER + 1);
    if (livePreparing.length >= MAX_LIVE_GRANTS_PER_USER) {
      oauthError("grant_limit_reached");
    }
    const livePending = await ctx.db
      .query("apiKeys")
      .withIndex("by_userId_oauthLifecycle_grantExpiresAt", (q) =>
        q
          .eq("userId", principal.userId)
          .eq("oauthLifecycle", "pending")
          .gt("oauthGrantExpiresAt", now),
      )
      .take(MAX_LIVE_GRANTS_PER_USER - livePreparing.length + 1);
    if (livePreparing.length + livePending.length >= MAX_LIVE_GRANTS_PER_USER) {
      oauthError("grant_limit_reached");
    }

    const { rawKey, keyHash } = await generateApiKeyMaterial();
    const grantExpiresAt = now + GRANT_LIFETIME_MS;
    const preparationNonce = randomNonce();
    const keyId = await ctx.db.insert("apiKeys", {
      userId: principal.userId,
      keyHash,
      keyPrefix: rawKey.slice(0, 11),
      name: args.name,
      capabilities: args.capabilities,
      spaceIds,
      sourceAccountIds: [],
      oauthLifecycle: "preparing",
      oauthRequestHash: requestHash,
      oauthBindingSeedHash: "pending",
      oauthGrantExpiresAt: grantExpiresAt,
      oauthPreparationExpiresAt: now + PREPARATION_LIFETIME_MS,
      oauthPreparationNonce: preparationNonce,
    });
    const bindingSeedHash = await sha256(
      JSON.stringify({
        version: "oauth-binding-seed-v1",
        userId: String(principal.userId),
        apiKeyId: String(keyId),
        requestHash,
        keyHash,
        clientId: args.clientId,
        redirectUri: args.redirectUri,
        resource: args.resource,
        codeChallenge: args.codeChallenge,
        scope: args.scope,
      }),
    );
    await ctx.db.patch(keyId, { oauthBindingSeedHash: bindingSeedHash });
    return {
      status: "issued" as const,
      keyId,
      userId: principal.userId,
      rawKey,
      requestHash,
      bindingSeedHash,
      preparationNonce,
      grantExpiresAt,
    };
  },
});

export const finalizeAuthorizationGrant = mutation({
  args: {
    keyId: v.id("apiKeys"),
    requestHash: v.string(),
    preparationNonce: v.string(),
    encryptedCode: v.string(),
    codeHash: v.string(),
    bindingHash: v.string(),
    grantExpiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const principal = await requireOAuthWebPrincipal(ctx);
    if (
      !HASH.test(args.requestHash) ||
      !NONCE.test(args.preparationNonce) ||
      !HASH.test(args.codeHash) ||
      !HASH.test(args.bindingHash) ||
      !/^obac1\.[A-Za-z0-9_-]+$/.test(args.encryptedCode) ||
      args.encryptedCode.length > 8192
    ) {
      oauthError("invalid_input");
    }
    const key = await ctx.db.get(args.keyId);
    if (
      !key ||
      key.userId !== principal.userId ||
      !isPreparingOAuthKey(key) ||
      key.oauthRequestHash !== args.requestHash ||
      key.oauthPreparationNonce !== args.preparationNonce
    ) {
      oauthError("grant_not_found");
    }
    const now = Date.now();
    if (
      key.oauthGrantExpiresAt <= now ||
      key.oauthPreparationExpiresAt <= now ||
      args.grantExpiresAt !== key.oauthGrantExpiresAt
    ) {
      oauthError("grant_expired");
    }
    if ((await sha256(args.encryptedCode)) !== args.codeHash) {
      oauthError("invalid_input");
    }
    const expectedBindingHash = await sha256(
      `oauth-binding-v1\0${key.oauthBindingSeedHash}\0${args.codeHash}`,
    );
    if (expectedBindingHash !== args.bindingHash) oauthError("invalid_input");
    await validateStoredScopes(ctx, principal, key);
    await ctx.db.patch(key._id, {
      oauthLifecycle: "pending",
      oauthCodeHash: args.codeHash,
      oauthBindingHash: args.bindingHash,
      oauthEncryptedCode: args.encryptedCode,
      oauthPreparationExpiresAt: undefined,
      oauthPreparationNonce: undefined,
    });
    return null;
  },
});

export const abandonAuthorizationGrant = mutation({
  args: {
    keyId: v.id("apiKeys"),
    requestHash: v.string(),
    preparationNonce: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const principal = await requireOAuthWebPrincipal(ctx);
    const key = await ctx.db.get(args.keyId);
    if (
      key &&
      key.userId === principal.userId &&
      isPreparingOAuthKey(key) &&
      key.oauthRequestHash === args.requestHash &&
      key.oauthPreparationNonce === args.preparationNonce
    ) {
      await ctx.db.delete(key._id);
    }
    return null;
  },
});
