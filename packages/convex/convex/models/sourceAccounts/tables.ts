import { defineTable } from "convex/server";
import { v } from "convex/values";

export const sourceAccountFields = {
  spaceId: v.id("spaces"),
  connector: v.string(),
  accountId: v.string(),
  name: v.string(),
  enabled: v.boolean(),
  cursor: v.optional(v.string()),
  cursorVersion: v.number(),
  freshnessMs: v.number(),
  coverageInvalidatedAt: v.optional(v.number()),
  lastEnumeratedAt: v.optional(v.number()),
  lastProcessedAt: v.optional(v.number()),
  createdBy: v.id("users"),
};

export const sourceAccountTables = {
  sourceAccounts: defineTable(sourceAccountFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_space_connector_account", ["spaceId", "connector", "accountId"]),
};
