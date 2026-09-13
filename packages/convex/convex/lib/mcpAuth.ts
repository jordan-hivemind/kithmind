import { internal as _internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import type { Principal } from "./spaces";
import { principalFromApiKey } from "./spaces";

// Avoid an inference cycle: public actions use this helper to call the API-key
// lookup in the same generated module tree.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internal = _internal as any;

type McpFunctionContext = QueryCtx | MutationCtx | ActionCtx;

export async function requireMcpPrincipal(
  ctx: McpFunctionContext,
): Promise<Principal> {
  const identity = await ctx.auth.getUserIdentity();
  const expectedIssuer = process.env.MCP_JWT_ISSUER;

  if (
    !identity ||
    !expectedIssuer ||
    identity.issuer !== expectedIssuer ||
    typeof identity.apiKeyId !== "string" ||
    identity.oauthPurpose !== undefined
  ) {
    throw new Error("Not authenticated");
  }

  let key: Doc<"apiKeys"> | null;
  if ("db" in ctx) {
    const id = ctx.db.normalizeId("apiKeys", identity.apiKeyId);
    key = id ? await ctx.db.get(id) : null;
  } else {
    key = await ctx.runQuery(internal.models.apiKeys.private.getById, {
      id: identity.apiKeyId,
    });
  }

  if (!key) throw new Error("Not authenticated");
  const principal = principalFromApiKey(key, identity.subject as Id<"users">);
  if ("db" in ctx && !(await ctx.db.get(principal.userId))) {
    throw new Error("Not authenticated");
  }
  return principal;
}

const HASH = /^[a-f0-9]{64}$/;

export async function requireOAuthExchangeIdentity(ctx: MutationCtx): Promise<{
  userId: Id<"users">;
  key: Doc<"apiKeys">;
  codeHash: string;
  keyHash: string;
  bindingHash: string;
  requestHash: string;
}> {
  const identity = await ctx.auth.getUserIdentity();
  const expectedIssuer = process.env.MCP_JWT_ISSUER;
  if (
    !identity ||
    !expectedIssuer ||
    identity.issuer !== expectedIssuer ||
    identity.oauthPurpose !== "authorization_code_exchange" ||
    typeof identity.apiKeyId !== "string" ||
    typeof identity.subject !== "string" ||
    typeof identity.oauthCodeHash !== "string" ||
    typeof identity.oauthKeyHash !== "string" ||
    typeof identity.oauthBindingHash !== "string" ||
    typeof identity.oauthRequestHash !== "string" ||
    !HASH.test(identity.oauthCodeHash) ||
    !HASH.test(identity.oauthKeyHash) ||
    !HASH.test(identity.oauthBindingHash) ||
    !HASH.test(identity.oauthRequestHash)
  ) {
    throw new Error("Not authenticated");
  }
  const keyId = ctx.db.normalizeId("apiKeys", identity.apiKeyId);
  const userId = ctx.db.normalizeId("users", identity.subject);
  const key = keyId ? await ctx.db.get(keyId) : null;
  if (!key || !userId || key.userId !== userId || !(await ctx.db.get(userId))) {
    throw new Error("Not authenticated");
  }
  return {
    userId,
    key,
    codeHash: identity.oauthCodeHash,
    keyHash: identity.oauthKeyHash,
    bindingHash: identity.oauthBindingHash,
    requestHash: identity.oauthRequestHash,
  };
}
