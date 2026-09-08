import { defineTable } from "convex/server";
import { v } from "convex/values";

export const diagnosticsTables = {
  workerWatcherStates: defineTable({
    spaceId: v.id("spaces"),
    sourceAccountId: v.id("sourceAccounts"),
    watcherId: v.string(),
    state: v.union(v.literal("awaiting_heartbeat"), v.literal("active")),
    connectorVersion: v.optional(v.string()),
    actorUserId: v.optional(v.id("users")),
    actorCredentialId: v.optional(v.id("apiKeys")),
    lastSeenAt: v.optional(v.number()),
    nextExpectedAt: v.optional(v.number()),
    sweepAfter: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_state_and_sweepAfter", ["state", "sweepAfter"]),
  workerOperationalIncidents: defineTable({
    spaceId: v.id("spaces"),
    sourceAccountId: v.id("sourceAccounts"),
    watcherId: v.string(),
    kind: v.literal("missing_worker"),
    state: v.union(v.literal("open"), v.literal("resolved")),
    openedAt: v.number(),
    observedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_source_watcher_kind_state", [
      "sourceAccountId",
      "watcherId",
      "kind",
      "state",
    ])
    .index("by_sourceAccountId_and_state", ["sourceAccountId", "state"]),
  workerWatcherResetReceipts: defineTable({
    spaceId: v.id("spaces"),
    sourceAccountId: v.id("sourceAccounts"),
    requestId: v.string(),
    requestDigest: v.string(),
    expectedWatcherId: v.optional(v.string()),
    nextWatcherId: v.optional(v.string()),
    actorUserId: v.id("users"),
    changedAt: v.number(),
  }).index("by_sourceAccountId_and_requestId", [
    "sourceAccountId",
    "requestId",
  ]),
};
