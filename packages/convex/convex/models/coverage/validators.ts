import { v } from "convex/values";

export const coverageWindowState = v.union(
  v.literal("complete"),
  v.literal("partial"),
  v.literal("unknown"),
);

export const coverageGapStatus = v.union(
  v.literal("open"),
  v.literal("resolved"),
);

export const coverageWindowFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  recordType: v.string(),
  entityId: v.optional(v.id("entities")),
  from: v.number(),
  to: v.number(),
  state: coverageWindowState,
  lastEnumeratedAt: v.number(),
  lastProcessedAt: v.number(),
  discoveredCount: v.number(),
  indexedCount: v.number(),
  skippedCount: v.number(),
};

export const coverageGapFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  recordType: v.string(),
  entityId: v.optional(v.id("entities")),
  from: v.optional(v.number()),
  to: v.optional(v.number()),
  reason: v.string(),
  detectedAt: v.number(),
  status: coverageGapStatus,
  resolvedAt: v.optional(v.number()),
};

export const queryCoverageValidator = v.object({
  state: v.union(
    v.literal("complete"),
    v.literal("partial"),
    v.literal("unknown"),
    v.literal("stale"),
  ),
  asOf: v.number(),
  windows: v.array(
    v.object({
      from: v.number(),
      to: v.number(),
      sourceAccountId: v.id("sourceAccounts"),
    }),
  ),
  knownGaps: v.array(
    v.object({
      from: v.optional(v.number()),
      to: v.optional(v.number()),
      reason: v.string(),
    }),
  ),
  pendingJobs: v.number(),
  failedJobs: v.number(),
  overflow: v.boolean(),
});
