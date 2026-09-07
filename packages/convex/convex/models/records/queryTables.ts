import { defineTable } from "convex/server";
import { v } from "convex/values";

const recordQueryOperationValidator = v.union(
  v.literal("observation_history"),
  v.literal("list_events"),
  v.literal("sum_money"),
);

const queryConsistencyValidator = v.union(
  v.literal("snapshot"),
  v.literal("current"),
);

const cursorOccurrencePrecisionValidator = v.union(
  v.literal("date"),
  v.literal("datetime"),
);

export const recordQuerySessionFields = {
  spaceId: v.id("spaces"),
  userId: v.id("users"),
  credentialId: v.optional(v.id("apiKeys")),
  membershipId: v.id("spaceMembers"),
  authorizationSignature: v.string(),
  operation: recordQueryOperationValidator,
  consistency: queryConsistencyValidator,
  normalizedFilter: v.string(),
  sourceAccountIds: v.array(v.id("sourceAccounts")),
  snapshotAt: v.number(),
  activationEpoch: v.number(),
  visibilityEpoch: v.number(),
  lastOccurrenceDate: v.string(),
  lastOccurrencePrecision: cursorOccurrencePrecisionValidator,
  lastOccurrenceInstant: v.optional(v.number()),
  lastSortKey: v.string(),
  lastStableId: v.string(),
  totals: v.array(
    v.object({
      currency: v.string(),
      amount: v.string(),
    }),
  ),
  invalidRows: v.number(),
  ambiguousTimeRows: v.number(),
  unsupportedValueRows: v.number(),
  readOverflow: v.boolean(),
  processedRows: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  expiresAt: v.number(),
};

export const recordQuerySpaceStateFields = {
  spaceId: v.id("spaces"),
  visibilityEpoch: v.number(),
  snapshotClock: v.number(),
  updatedAt: v.number(),
};

export const recordQueryTables = {
  recordQuerySessions: defineTable(recordQuerySessionFields)
    .index("by_user_space_expires", ["userId", "spaceId", "expiresAt"])
    .index("by_space_expires", ["spaceId", "expiresAt"])
    .index("by_space_visibility_expires", [
      "spaceId",
      "visibilityEpoch",
      "expiresAt",
    ]),
  recordQuerySpaceState: defineTable(recordQuerySpaceStateFields).index(
    "by_spaceId",
    ["spaceId"],
  ),
};
