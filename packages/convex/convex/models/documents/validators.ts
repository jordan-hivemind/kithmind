import { v } from "convex/values";

import { sourceInventoryExclusionReasonValidator } from "./inventoryTables";

export const documentSearchArgs = {
  query: v.string(),
  searchMode: v.optional(v.union(v.literal("keyword"), v.literal("hybrid"))),
  spaceIds: v.optional(v.array(v.id("spaces"))),
  docType: v.optional(v.string()),
  from: v.optional(v.number()),
  to: v.optional(v.number()),
  limit: v.optional(v.number()),
  includeHistorical: v.optional(v.boolean()),
};

export const documentGetArgs = {
  documentId: v.id("documents"),
  spaceIds: v.optional(v.array(v.id("spaces"))),
  includeHistorical: v.optional(v.boolean()),
};

export const sourceListArgs = {
  spaceIds: v.optional(v.array(v.id("spaces"))),
  sourceAccountId: v.optional(v.id("sourceAccounts")),
  limit: v.optional(v.number()),
};

export const inventoryListArgs = {
  spaceIds: v.optional(v.array(v.id("spaces"))),
  sourceAccountId: v.id("sourceAccounts"),
  fileName: v.optional(v.string()),
  folderPath: v.optional(v.string()),
  exclusionReason: v.optional(sourceInventoryExclusionReasonValidator),
  duplicateGroupId: v.optional(v.string()),
  cursor: v.optional(v.string()),
  limit: v.optional(v.number()),
};
