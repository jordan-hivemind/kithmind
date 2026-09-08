import { defineTable } from "convex/server";
import { v } from "convex/values";

import {
  sourceAliasDigestFields,
  workerProtocolRateLimitFields,
  workerOperationReceiptFields,
  workerProcessingAssessmentFields,
  workerReservationReceiptFields,
  workerReservationTargetFields,
  workerDiscoveryWorkFields,
  workerBinaryOperationReceiptFields,
  workerScanEntryFields,
  workerScanPageFields,
  workerSourceScanFields,
  workerParsedStageFields,
} from "./validators";

export const workerTables = {
  workerParsedStages: defineTable(workerParsedStageFields)
    .index("by_processingGenerationId", ["processingGenerationId"])
    .index("by_ingestJobId", ["ingestJobId"])
    .index("by_retireAt", ["retireAt"]),
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
    .index("by_scanId_and_sourceItemId", ["scanId", "sourceItemId"])
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
    .index("by_sourceAccountId_and_state_and_leaseExpiresAt", [
      "sourceAccountId",
      "state",
      "leaseExpiresAt",
    ])
    .index("by_source_rep_state_next", [
      "sourceAccountId",
      "contentRepresentation",
      "state",
      "nextAttemptAt",
    ])
    .index("by_source_rep_state_lease", [
      "sourceAccountId",
      "contentRepresentation",
      "state",
      "leaseExpiresAt",
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
  workerProtocolRateLimits: defineTable(workerProtocolRateLimitFields)
    .index("by_credentialId_and_sourceAccountId", [
      "credentialId",
      "sourceAccountId",
    ])
    .index("by_windowStartedAt", ["windowStartedAt"]),
  workerReservationReceipts: defineTable(workerReservationReceiptFields)
    .index("by_sourceAccountId_and_kind_and_requestId", [
      "sourceAccountId",
      "kind",
      "requestId",
    ])
    .index("by_retireAt", ["retireAt"]),
  workerReservationTargets: defineTable(workerReservationTargetFields)
    .index("by_receiptId_and_ordinal", ["receiptId", "ordinal"])
    .index("by_discoveryWorkId", ["discoveryWorkId"])
    .index("by_ingestJobId", ["ingestJobId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_leaseExpiresAt", ["leaseExpiresAt"]),
  workerOperationReceipts: defineTable(workerOperationReceiptFields)
    .index("by_sourceAccountId_and_operation_and_requestId", [
      "sourceAccountId",
      "operation",
      "requestId",
    ])
    .index("by_discoveryWorkId", ["discoveryWorkId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_retireAt", ["retireAt"]),
  workerBinaryOperationReceipts: defineTable(workerBinaryOperationReceiptFields)
    .index("by_source_operation_request", [
      "sourceAccountId",
      "operation",
      "requestId",
    ])
    .index("by_discoveryWorkId", ["discoveryWorkId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_retireAt", ["retireAt"]),
  workerProcessingAssessments: defineTable(workerProcessingAssessmentFields)
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccountId_and_requestId", ["sourceAccountId", "requestId"])
    .index("by_sourceAccountId_and_state", ["sourceAccountId", "state"])
    .index("by_scanId_and_state_and_expiresAt", [
      "scanId",
      "state",
      "expiresAt",
    ])
    .index("by_state_and_expiresAt", ["state", "expiresAt"])
    .index("by_state_and_retireAt", ["state", "retireAt"]),
};
