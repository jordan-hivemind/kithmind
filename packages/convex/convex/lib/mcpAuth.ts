import { internal as _internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import type { Capability, Principal } from "./spaces";
import {
  principalFromApiKey,
  principalRef,
  requireSpaceAccess,
} from "./spaces";

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
    typeof identity.apiKeyId !== "string"
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

export async function requireMcpUserId(
  ctx: McpFunctionContext,
  operation: Capability,
): Promise<Id<"users">> {
  const principal = await requireMcpPrincipal(ctx);
  try {
    if ("db" in ctx) {
      const settings = await ctx.db
        .query("userSpaceSettings")
        .withIndex("by_userId", (q) => q.eq("userId", principal.userId))
        .take(2);
      if (settings.length !== 1) throw new Error("Not authorized");
      await requireSpaceAccess(
        ctx,
        principal,
        settings[0]!.personalSpaceId,
        operation,
      );
    } else {
      await ctx.runQuery(internal.models.spaces.private.authorizePersonal, {
        principal: principalRef(principal),
        operation,
      });
    }
  } catch {
    throw new Error("Not authorized");
  }
  return principal.userId;
}
