import { defineTable } from "convex/server";
import { v } from "convex/values";

export const inlineWorkStateValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("needs_review"),
  v.literal("failed"),
  v.literal("obsolete_generation"),
);

export const inlineWorkTables = {
  inlineWork: defineTable({
    spaceId: v.id("spaces"),
    sourceAccountId: v.id("sourceAccounts"),
    sourceItemId: v.id("sourceItems"),
    sourceRevisionId: v.id("sourceRevisions"),
    processingGenerationId: v.id("processingGenerations"),
    ingestJobId: v.id("ingestJobs"),
    actorUserId: v.id("users"),
    actorCredentialId: v.optional(v.id("apiKeys")),
    state: inlineWorkStateValidator,
    attempts: v.number(),
    nextAttemptAt: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ingestJobId", ["ingestJobId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_state_and_nextAttemptAt", ["state", "nextAttemptAt"]),
  ingestRateLimits: defineTable({
    credentialId: v.id("apiKeys"),
    windowStartedAt: v.number(),
    count: v.number(),
  }).index("by_credentialId", ["credentialId"]),
};
