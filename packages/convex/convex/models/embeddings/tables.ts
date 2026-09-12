import { defineTable } from "convex/server";

import {
  embeddingBuildJobFields,
  embeddingGenerationFields,
  embeddingTargetFields,
  storedEmbeddingProfileFields,
  embeddingVectorFields,
  spaceEmbeddingStateFields,
} from "./validators";

export const embeddingTables = {
  embeddingProfiles: defineTable(storedEmbeddingProfileFields).index(
    "by_fingerprint",
    ["fingerprint"],
  ),
  spaceEmbeddingStates: defineTable(spaceEmbeddingStateFields).index(
    "by_spaceId",
    ["spaceId"],
  ),
  embeddingGenerations: defineTable(embeddingGenerationFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_spaceId_and_state", ["spaceId", "state"])
    .index("by_spaceId_and_fingerprint", ["spaceId", "fingerprint"]),
  embeddingTargets: defineTable(embeddingTargetFields)
    .index("by_space_kind_target", ["spaceId", "targetKind", "targetId"])
    .index("by_space_and_state", ["spaceId", "state"])
    .index("by_space_and_coveredFingerprint", ["spaceId", "coveredFingerprint"])
    .index("by_space_and_updatedAt", ["spaceId", "updatedAt"]),
  embeddingBuildJobs: defineTable(embeddingBuildJobFields)
    .index("by_space_and_fingerprint", ["spaceId", "fingerprint"])
    .index("by_space_and_phase", ["spaceId", "phase"]),
  embeddingVectors: defineTable(embeddingVectorFields)
    .index("by_embeddingGenerationId", ["embeddingGenerationId"])
    .index("by_generation_and_thoughtId", [
      "embeddingGenerationId",
      "thoughtId",
    ])
    .index("by_generation_and_chunkId", ["embeddingGenerationId", "chunkId"])
    .index("by_thoughtId", ["thoughtId"])
    .index("by_chunkId", ["chunkId"])
    .index("by_space_and_scopeV2", ["spaceId", "scopeV2"])
    .vectorIndex("by_embedding_1536", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["searchScope", "scopeV2"],
    }),
};
