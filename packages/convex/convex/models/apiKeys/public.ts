import { query, mutation } from "../../_generated/server";
import { ConvexError, v } from "convex/values";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
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
import { capability, hasNoOAuthLifecycle } from "./validators";

const keySummary = v.object({
  _id: v.id("apiKeys"),
  _creationTime: v.number(),
  keyPrefix: v.string(),
  name: v.string(),
  lastUsedAt: v.optional(v.number()),
  capabilities: v.array(capability),
  spaceIds: v.array(v.id("spaces")),
  sourceAccountIds: v.array(v.id("sourceAccounts")),
});

function summarizeKey(key: {
  _id: Id<"apiKeys">;
  _creationTime: number;
  keyPrefix: string;
  name: string;
  lastUsedAt?: number;
  capabilities: Array<"read" | "write" | "ingest">;
  spaceIds: Id<"spaces">[];
  sourceAccountIds?: Id<"sourceAccounts">[];
}) {
  return {
    _id: key._id,
    _creationTime: key._creationTime,
    keyPrefix: key.keyPrefix,
    name: key.name,
    lastUsedAt: key.lastUsedAt,
    capabilities: key.capabilities,
    spaceIds: key.spaceIds,
    sourceAccountIds: key.sourceAccountIds ?? [],
  };
}

export async function generateApiKeyMaterial() {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const rawKey =
    "ob_" +
    Array.from(randomBytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawKey),
  );
  const keyHash = Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { rawKey, keyHash };
}

export function validateApiKeyName(name: string) {
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

export async function validateApiKeyScopes(
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
  returns: v.array(keySummary),
  handler: async (ctx) => {
    const { userId } = await requireWebPrincipal(ctx);

    const keys = await _listByUser(ctx, userId);
    if (keys.some((key) => !hasNoOAuthLifecycle(key))) {
      throw new ConvexError({
        code: "invalid_api_key_state",
        message: "API key lifecycle data is invalid.",
      });
    }
    if (keys.length > 100) {
      throw new ConvexError({
        code: "api_key_list_overflow",
        message: "Too many API keys to list. Use paginated key management.",
      });
    }
    return keys.map(summarizeKey);
  },
});

export const listPage = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(keySummary),
  handler: async (ctx, args) => {
    const { userId } = await requireWebPrincipal(ctx);
    const { numItems } = args.paginationOpts;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 50) {
      throw new ConvexError({
        code: "invalid_input",
        message: "Pagination size must be between 1 and 50.",
      });
    }
    const page = await ctx.db
      .query("apiKeys")
      .withIndex("by_userId_and_oauthLifecycle", (q) =>
        q.eq("userId", userId).eq("oauthLifecycle", undefined),
      )
      .paginate(args.paginationOpts);
    if (page.page.some((key) => !hasNoOAuthLifecycle(key))) {
      throw new ConvexError({
        code: "invalid_api_key_state",
        message: "API key lifecycle data is invalid.",
      });
    }
    return { ...page, page: page.page.map(summarizeKey) };
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
    validateApiKeyName(args.name);
    await ensurePersonalSpace(ctx, userId);
    await validateApiKeyScopes(
      ctx,
      principal,
      args.capabilities,
      args.spaceIds,
      args.sourceAccountIds ?? [],
    );

    const { rawKey, keyHash } = await generateApiKeyMaterial();

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
    if (args.name !== undefined) validateApiKeyName(args.name);
    await validateApiKeyScopes(
      ctx,
      principal,
      args.capabilities,
      args.spaceIds,
      args.sourceAccountIds ?? [],
    );
    const key = await ctx.db.get(args.id);
    if (!key || key.userId !== userId || !hasNoOAuthLifecycle(key)) {
      throw new Error("API key not found");
    }
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
    if (!key || key.userId !== userId || !hasNoOAuthLifecycle(key)) {
      throw new Error("API key not found");
    }

    await _deleteOne(ctx, args.id);
    return null;
  },
});
