import { defineTable } from "convex/server";
import { v } from "convex/values";

import {
  sourceAliasDigestFields,
  workerProtocolRateLimitFields,
  workerDiscoveryWorkFields,
  workerScanEntryFields,
  workerScanPageFields,
  workerSourceScanFields,
} from "./validators";

export const workerTables = {
  workerCleanupState: defineTable({
    key: v.string(),
    nextPhase: v.number(),
    checkpoints: v.array(
      v.object({
        cursor: v.optional(v.string()),
        cutoff: v.number(),
      }),
    ),
  }).index("by_key", ["key"]),
  workerSourceScans: defineTable(workerSourceScanFields)
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccountId_and_requestId", ["sourceAccountId", "requestId"])
    .index("by_sourceAccountId_and_state", ["sourceAccountId", "state"])
    .index("by_state_and_retireAt", ["state", "retireAt"])
    .index("by_state_and_expiresAt", ["state", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_retireAt", ["retireAt"]),
  workerScanPages: defineTable(workerScanPageFields)
    .index("by_scanId", ["scanId"])
    .index("by_scanId_and_ordinal", ["scanId", "ordinal"])
    .index("by_scanId_and_requestId", ["scanId", "requestId"])
    .index("by_retireAt", ["retireAt"]),
  workerScanEntries: defineTable(workerScanEntryFields)
    .index("by_scanId", ["scanId"])
    .index("by_scanPageId", ["scanPageId"])
    .index("by_scanId_and_identityKeyHash", ["scanId", "identityKeyHash"])
    .index("by_sourceAccountId_and_state", ["sourceAccountId", "state"])
    .index("by_sourceAccountId_and_uriDigest", ["sourceAccountId", "uriDigest"])
    .index("by_sourceAccountId_and_uriDigest_and_state", [
      "sourceAccountId",
      "uriDigest",
      "state",
    ])
    .index("by_sourceAccountId_and_uriDigest_and_sourceItemId", [
      "sourceAccountId",
      "uriDigest",
      "sourceItemId",
    ])
    .index("by_sourceAccountId_and_externalIdHash_and_sourceItemId", [
      "sourceAccountId",
      "externalIdHash",
      "sourceItemId",
    ])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_discoveryWorkId", ["discoveryWorkId"])
    .index("by_state_and_retireAt", ["state", "retireAt"])
    .index("by_retireAt", ["retireAt"]),
  workerDiscoveryWork: defineTable(workerDiscoveryWorkFields)
    .index("by_scanId", ["scanId"])
    .index("by_state_and_createdAt", ["state", "createdAt"])
    .index("by_sourceAccountId_and_state_and_nextAttemptAt", [
      "sourceAccountId",
      "state",
      "nextAttemptAt",
    ])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_sourceItemId_and_observationEpoch", [
      "sourceItemId",
      "observationEpoch",
    ])
    .index("by_ingestJobId", ["ingestJobId"])
    .index("by_state_and_retireAt", ["state", "retireAt"])
    .index("by_retireAt", ["retireAt"]),
  sourceAliasDigests: defineTable(sourceAliasDigestFields)
    .index("by_sourceAccountId_and_digest", ["sourceAccountId", "digest"])
    .index("by_sourceItemId", ["sourceItemId"]),
  workerProtocolRateLimits: defineTable(workerProtocolRateLimitFields).index(
    "by_credentialId_and_sourceAccountId",
    ["credentialId", "sourceAccountId"],
  ),
};
