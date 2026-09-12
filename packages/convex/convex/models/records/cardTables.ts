import { defineTable } from "convex/server";
import { v } from "convex/values";

import { recordEventTypeValidator } from "./validators";

/**
 * Section 4.3 and section 7 of docs/plans/2026-09-12-document-cards.md.
 * Nothing is silently dropped: a card field whose evidence does not resolve
 * is not stored, and this row is what the `field_dropped` review item of
 * P2-70k counts. It carries the field name and the failure reason, never the
 * field value: an unproved value is exactly what must not be retained.
 */
export const cardFieldDropFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  processingGenerationId: v.id("processingGenerations"),
  recordKind: recordEventTypeValidator,
  fieldKey: v.string(),
  reason: v.string(),
  createdAt: v.number(),
};

export const cardTables = {
  cardFieldDrops: defineTable(cardFieldDropFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_processingGenerationId", ["processingGenerationId"]),
};
