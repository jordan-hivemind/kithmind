import { QueryCtx, MutationCtx } from "../../_generated/server";
import { Id } from "../../_generated/dataModel";
import type { Capability } from "../../lib/spaces";
import { hasNoOAuthLifecycle } from "./validators";

export async function _findByHash(ctx: QueryCtx, keyHash: string) {
  const key = await ctx.db
    .query("apiKeys")
    .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
    .unique();
  return key && hasNoOAuthLifecycle(key) ? key : null;
}

export async function _listByUser(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("apiKeys")
    .withIndex("by_userId_and_oauthLifecycle", (q) =>
      q.eq("userId", userId).eq("oauthLifecycle", undefined),
    )
    .take(101);
}

export async function _insertOne(
  ctx: MutationCtx,
  fields: {
    userId: Id<"users">;
    keyHash: string;
    keyPrefix: string;
    name: string;
    capabilities: Capability[];
    spaceIds: Id<"spaces">[];
    sourceAccountIds?: Id<"sourceAccounts">[];
  },
) {
  return await ctx.db.insert("apiKeys", fields);
}

export async function _updateOne(
  ctx: MutationCtx,
  id: Id<"apiKeys">,
  fields: {
    name?: string;
    capabilities?: Capability[];
    spaceIds?: Id<"spaces">[];
    sourceAccountIds?: Id<"sourceAccounts">[];
  },
) {
  await ctx.db.patch(id, fields);
}

export async function _deleteOne(ctx: MutationCtx, id: Id<"apiKeys">) {
  await ctx.db.delete(id);
}
