import { defineTable } from "convex/server";

import {
  ingestJobFields,
  ingestRequestFields,
  processingGenerationFields,
  spaceProcessingStateFields,
} from "./validators";

export const ingestionTables = {
  processingGenerations: defineTable(processingGenerationFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccountId_and_state", ["sourceAccountId", "state"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_sourceRevisionId_and_processingFingerprint", [
      "sourceRevisionId",
      "processingFingerprint",
    ]),
  ingestRequests: defineTable(ingestRequestFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccountId_and_requestId", ["sourceAccountId", "requestId"])
    .index("by_sourceItemId", ["sourceItemId"]),
  ingestJobs: defineTable(ingestJobFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccountId_and_state", ["sourceAccountId", "state"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_processingGenerationId", ["processingGenerationId"])
    .index("by_state_and_nextAttemptAt", ["state", "nextAttemptAt"]),
  spaceProcessingState: defineTable(spaceProcessingStateFields).index(
    "by_spaceId",
    ["spaceId"],
  ),
};
