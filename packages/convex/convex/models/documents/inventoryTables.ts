import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

/**
 * Section 2.3 of docs/plans/2026-09-12-document-cards.md: the existing
 * worker discovery gap codes, plus four additions (`encrypted`,
 * `duplicate_of`, `parse_failed`, `extraction_pending`).
 */
export const sourceInventoryExclusionReasonValidator = v.union(
  v.literal("empty"),
  v.literal("enumeration_interrupted"),
  v.literal("oversized"),
  v.literal("permission_denied"),
  v.literal("unreadable"),
  v.literal("unstable"),
  v.literal("unsupported"),
  v.literal("encrypted"),
  v.literal("duplicate_of"),
  v.literal("parse_failed"),
  v.literal("extraction_pending"),
);

export type SourceInventoryExclusionReason = Infer<
  typeof sourceInventoryExclusionReasonValidator
>;

/**
 * One current row per source-local file identity, upserted from the same
 * `scan.appendPage` submissions that populate `workerScanEntries`, but keyed
 * by file identity rather than by scan so it is not retention bounded.
 *
 * `identityUuid` in the plan is this repository's existing `identityKeyHash`
 * (the same stable per-file identity `workerScanEntries` already keys on):
 * this system assigns a deterministic hash at discovery, not a literal UUID,
 * and reusing it avoids a second identity scheme for the same file.
 */
export const sourceInventoryFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.optional(v.id("sourceItems")),
  identityKeyHash: v.string(),
  relativePath: v.string(),
  folderPath: v.string(),
  fileName: v.string(),
  byteLength: v.optional(v.number()),
  contentHash: v.optional(v.string()),
  mediaType: v.optional(v.string()),
  modifiedAt: v.number(),
  duplicateGroupId: v.optional(v.string()),
  contentIndexed: v.boolean(),
  exclusionReason: v.optional(sourceInventoryExclusionReasonValidator),
  // P2-70a2: the machine-readable failure class (an `ingestJobs.error.code`,
  // already bounded to MAX_ERROR_CODE_LENGTH and never document text) that
  // most recently drove `exclusionReason` to `parse_failed`. Absent for
  // every other reason, and cleared back to undefined the moment a later
  // job for the same file succeeds.
  exclusionDetail: v.optional(v.string()),
  firstSeenScanId: v.id("workerSourceScans"),
  lastSeenScanId: v.id("workerSourceScans"),
  missingSinceScanId: v.optional(v.id("workerSourceScans")),
};

export const inventoryTables = {
  sourceInventory: defineTable(sourceInventoryFields)
    .index("by_sourceAccountId_and_identityKeyHash", [
      "sourceAccountId",
      "identityKeyHash",
    ])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_space_account_folder", [
      "spaceId",
      "sourceAccountId",
      "folderPath",
    ])
    .index("by_space_account_fileName", [
      "spaceId",
      "sourceAccountId",
      "fileName",
    ])
    .index("by_space_account_exclusionReason", [
      "spaceId",
      "sourceAccountId",
      "exclusionReason",
    ])
    .index("by_space_duplicateGroup", ["spaceId", "duplicateGroupId"]),
};
