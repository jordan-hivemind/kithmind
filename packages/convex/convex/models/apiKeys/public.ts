import { query, mutation } from "../../_generated/server";
import { ConvexError, v } from "convex/values";
import { requireWebPrincipal } from "../../lib/webAuth";
import {
  ensurePersonalSpace,
  getAuthorizedReadSpaceIds,
  requireSpaceAccess,
  type Principal,
} from "../../lib/spaces";
import { _listByUser, _insertOne, _deleteOne, _updateOne } from "./model";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { capability } from "./validators";

function validateName(name: string) {
  if (
    !name.trim() ||
    name.length > 200 ||
    new TextDecoder().decode(new TextEncoder().encode(name)) !== name
  ) {
    throw new ConvexError({
      code: "invalid_input",
      message: "API key name must contain 1 to 200 valid characters.",
    });
  }
}

async function validateScopes(
  ctx: MutationCtx,
  principal: Principal,
  capabilities: Array<"read" | "write" | "ingest">,
  spaceIds: Id<"spaces">[],
  sourceAccountIds: Id<"sourceAccounts">[],
) {
  if (
    !capabilities.length ||
    !spaceIds.length ||
    spaceIds.length > 100 ||
    sourceAccountIds.length > 100
  ) {
    throw new Error("API keys require bounded capabilities and space scopes");
  }
  if (
    new Set(capabilities).size !== capabilities.length ||
    new Set(spaceIds).size !== spaceIds.length ||
    new Set(sourceAccountIds).size !== sourceAccountIds.length
  ) {
    throw new Error("API key scopes must be unique");
  }
  const hasIngest = capabilities.includes("ingest");
  const hasSources = sourceAccountIds.length > 0;
  if (hasIngest !== hasSources) {
    throw new Error(
      "Ingest capability requires explicit source accounts; other keys cannot grant them",
    );
  }
  await getAuthorizedReadSpaceIds(ctx, principal, spaceIds);
  for (const sourceAccountId of sourceAccountIds) {
    const account = await ctx.db.get(sourceAccountId);
    if (!account || !account.enabled || !spaceIds.includes(account.spaceId))
      throw new Error("Source account not found");
    await requireSpaceAccess(ctx, principal, account.spaceId, "ingest");
  }
}

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("apiKeys"),
      _creationTime: v.number(),
      keyPrefix: v.string(),
      name: v.string(),
      lastUsedAt: v.optional(v.number()),
      capabilities: v.array(capability),
      spaceIds: v.array(v.id("spaces")),
      sourceAccountIds: v.array(v.id("sourceAccounts")),
    }),
  ),
  handler: async (ctx) => {
    const { userId } = await requireWebPrincipal(ctx);

    const keys = await _listByUser(ctx, userId);
    return keys.map((k) => ({
      _id: k._id,
      _creationTime: k._creationTime,
      keyPrefix: k.keyPrefix,
      name: k.name,
      lastUsedAt: k.lastUsedAt,
      capabilities: k.capabilities,
      spaceIds: k.spaceIds,
      sourceAccountIds: k.sourceAccountIds ?? [],
    }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    capabilities: v.array(capability),
    spaceIds: v.array(v.id("spaces")),
    sourceAccountIds: v.optional(v.array(v.id("sourceAccounts"))),
  },
  returns: v.object({
    id: v.id("apiKeys"),
    rawKey: v.string(),
  }),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const { userId } = principal;
    validateName(args.name);
    await ensurePersonalSpace(ctx, userId);
    await validateScopes(
      ctx,
      principal,
      args.capabilities,
      args.spaceIds,
      args.sourceAccountIds ?? [],
    );

    // Generate a random API key
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const rawKey =
      "ob_" +
      Array.from(randomBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    // Hash it for storage
    const encoder = new TextEncoder();
    const data = encoder.encode(rawKey);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const keyPrefix = rawKey.slice(0, 11); // "ob_" + first 8 hex chars

    const id = await _insertOne(ctx, {
      userId,
      keyHash,
      keyPrefix,
      name: args.name,
      capabilities: args.capabilities,
      spaceIds: args.spaceIds,
      sourceAccountIds: args.sourceAccountIds ?? [],
    });

    // rawKey is returned ONCE — never stored or retrievable again
    return { id, rawKey };
  },
});

export const update = mutation({
  args: {
    id: v.id("apiKeys"),
    name: v.optional(v.string()),
    capabilities: v.array(capability),
    spaceIds: v.array(v.id("spaces")),
    sourceAccountIds: v.optional(v.array(v.id("sourceAccounts"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const { userId } = principal;
    if (args.name !== undefined) validateName(args.name);
    await validateScopes(
      ctx,
      principal,
      args.capabilities,
      args.spaceIds,
      args.sourceAccountIds ?? [],
    );
    const key = await ctx.db.get(args.id);
    if (!key || key.userId !== userId) throw new Error("API key not found");
    await _updateOne(ctx, args.id, {
      ...(args.name === undefined ? {} : { name: args.name }),
      capabilities: args.capabilities,
      spaceIds: args.spaceIds,
      sourceAccountIds: args.sourceAccountIds ?? [],
    });
    return null;
  },
});

export const revoke = mutation({
  args: { id: v.id("apiKeys") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { userId } = await requireWebPrincipal(ctx);

    const key = await ctx.db.get(args.id);
    if (!key || key.userId !== userId) {
      throw new Error("API key not found");
    }

    await _deleteOne(ctx, args.id);
    return null;
  },
});
