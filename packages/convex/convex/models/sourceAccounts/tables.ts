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
  inventoryEpoch: v.optional(v.number()),
  completedInventoryEpoch: v.optional(v.number()),
  manifestVersion: v.optional(v.number()),
  activeWorkerScanId: v.optional(v.id("workerSourceScans")),
  workerAssessmentEpoch: v.optional(v.number()),
  activeWorkerAssessmentId: v.optional(v.id("workerProcessingAssessments")),
  latestWorkerAssessmentId: v.optional(v.id("workerProcessingAssessments")),
  binaryProfileId: v.optional(v.literal("pdf_docqa_v1")),
  binaryProfileAuditDigest: v.optional(v.string()),
  binaryProfileEnabledAt: v.optional(v.number()),
  /**
   * Section 4.5 of docs/plans/2026-09-12-document-cards.md. The entity a
   * generic document card belongs to. A source with none publishes no generic
   * card; guessing the subject from the uploader is the inference the
   * architecture forbids.
   */
  subjectEntityId: v.optional(v.id("entities")),
  /**
   * Section 8.2: the per-source full-chunk rule. It is the default for every
   * item of this account; an item's own `embedFullChunks` overrides it.
   */
  embedFullChunks: v.optional(v.boolean()),
  createdBy: v.id("users"),
};

export const sourceAccountTables = {
  sourceAccounts: defineTable(sourceAccountFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_space_connector_account", ["spaceId", "connector", "accountId"]),
};
