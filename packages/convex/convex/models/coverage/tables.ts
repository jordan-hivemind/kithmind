import { defineTable } from "convex/server";

import { coverageGapFields, coverageWindowFields } from "./validators";

export const coverageTables = {
  coverageWindows: defineTable(coverageWindowFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccount_record_entity_from", [
      "sourceAccountId",
      "recordType",
      "entityId",
      "from",
      "to",
    ])
    .index("by_sourceAccount_record", ["sourceAccountId", "recordType"])
    .index("by_space_record_entity_from", [
      "spaceId",
      "recordType",
      "entityId",
      "from",
    ]),
  coverageGaps: defineTable(coverageGapFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccountId_and_status", ["sourceAccountId", "status"])
    .index("by_sourceAccount_record_entity_status", [
      "sourceAccountId",
      "recordType",
      "entityId",
      "status",
    ])
    .index("by_sourceAccount_record_status", [
      "sourceAccountId",
      "recordType",
      "status",
    ])
    .index("by_space_record_entity_status", [
      "spaceId",
      "recordType",
      "entityId",
      "status",
    ]),
};
