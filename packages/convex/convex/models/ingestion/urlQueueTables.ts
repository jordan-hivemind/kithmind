import { defineTable } from "convex/server";
import { v } from "convex/values";

export const sourceFetchRequestFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  actorUserId: v.id("users"),
  actorCredentialId: v.id("apiKeys"),
  requestId: v.string(),
  requestDigest: v.string(),
  url: v.string(),
  title: v.optional(v.string()),
  state: v.literal("queued"),
  createdAt: v.number(),
};

export const urlQueueTables = {
  sourceFetchRequests: defineTable(sourceFetchRequestFields)
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccountId_requestId", ["sourceAccountId", "requestId"]),
};
