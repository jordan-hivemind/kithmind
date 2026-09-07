import { v } from "convex/values";

export const documentSearchArgs = {
  query: v.string(),
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
