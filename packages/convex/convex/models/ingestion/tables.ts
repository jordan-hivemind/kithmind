import { defineTable } from "convex/server";

import {
  ingestJobFields,
  ingestRequestFields,
  processingGenerationFields,
  processingGenerationPayloadManifestFields,
  spaceProcessingStateFields,
} from "./validators";

export const ingestionTables = {
  processingGenerationPayloadManifests: defineTable(
    processingGenerationPayloadManifestFields,
  )
    .index("by_processingGenerationId", ["processingGenerationId"])
    .index("by_sourceItemId", ["sourceItemId"]),
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
    .index("by_source_worker_state_nextAttemptAt", [
      "sourceAccountId",
      "workerManaged",
      "state",
      "nextAttemptAt",
    ])
    .index("by_source_worker_state_leaseExpiresAt", [
      "sourceAccountId",
      "workerManaged",
      "state",
      "leaseExpiresAt",
    ])
    .index("by_source_mode_worker_state_next", [
      "sourceAccountId",
      "workerProcessingMode",
      "workerManaged",
      "state",
      "nextAttemptAt",
    ])
    .index("by_source_mode_worker_state_lease", [
      "sourceAccountId",
      "workerProcessingMode",
      "workerManaged",
      "state",
      "leaseExpiresAt",
    ])
    .index("by_sourceAccountId_and_state", ["sourceAccountId", "state"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_sourceItemId_and_desiredProcessingEpoch", [
      "sourceItemId",
      "desiredProcessingEpoch",
    ])
    .index("by_processingGenerationId", ["processingGenerationId"])
    .index("by_workerDiscoveryWorkId", ["workerDiscoveryWorkId"])
    .index("by_state_and_nextAttemptAt", ["state", "nextAttemptAt"]),
  spaceProcessingState: defineTable(spaceProcessingStateFields).index(
    "by_spaceId",
    ["spaceId"],
  ),
};
