import { QueryCtx, MutationCtx } from "../../_generated/server";
import { Id } from "../../_generated/dataModel";
import type { Capability } from "../../lib/spaces";

export async function _findByHash(ctx: QueryCtx, keyHash: string) {
  return await ctx.db
    .query("apiKeys")
    .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
    .unique();
}

export async function _listByUser(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("apiKeys")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
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
  },
) {
  await ctx.db.patch(id, fields);
}

export async function _deleteOne(ctx: MutationCtx, id: Id<"apiKeys">) {
  await ctx.db.delete(id);
}
