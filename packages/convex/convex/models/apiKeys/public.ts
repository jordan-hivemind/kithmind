import { query, mutation } from "../../_generated/server";
import { v } from "convex/values";
import { requireWebPrincipal } from "../../lib/webAuth";
import {
  ensurePersonalSpace,
  getAuthorizedReadSpaceIds,
} from "../../lib/spaces";
import { _listByUser, _insertOne, _deleteOne, _updateOne } from "./model";
import { capability } from "./validators";

function validateScopes(
  capabilities: Array<"read" | "write" | "ingest">,
  spaceIds: string[],
) {
  if (capabilities.length === 0 || spaceIds.length === 0) {
    throw new Error("API keys require capabilities and space scopes");
  }
  if (
    new Set(capabilities).size !== capabilities.length ||
    new Set(spaceIds).size !== spaceIds.length
  ) {
    throw new Error("API key capabilities and space scopes must be unique");
  }
  if (capabilities.includes("ingest")) {
    throw new Error("Ingest API keys are not available yet");
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
    }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    capabilities: v.array(capability),
    spaceIds: v.array(v.id("spaces")),
  },
  returns: v.object({
    id: v.id("apiKeys"),
    rawKey: v.string(),
  }),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const { userId } = principal;
    await ensurePersonalSpace(ctx, userId);
    validateScopes(args.capabilities, args.spaceIds);
    await getAuthorizedReadSpaceIds(ctx, principal, args.spaceIds);

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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const { userId } = principal;
    validateScopes(args.capabilities, args.spaceIds);
    const key = await ctx.db.get(args.id);
    if (!key || key.userId !== userId) throw new Error("API key not found");
    await getAuthorizedReadSpaceIds(ctx, principal, args.spaceIds);
    await _updateOne(ctx, args.id, {
      ...(args.name === undefined ? {} : { name: args.name }),
      capabilities: args.capabilities,
      spaceIds: args.spaceIds,
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
