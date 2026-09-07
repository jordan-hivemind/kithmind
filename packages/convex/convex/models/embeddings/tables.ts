import { defineTable } from "convex/server";

import {
  embeddingGenerationFields,
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
  embeddingVectors: defineTable(embeddingVectorFields)
    .index("by_embeddingGenerationId", ["embeddingGenerationId"])
    .index("by_generation_and_thoughtId", [
      "embeddingGenerationId",
      "thoughtId",
    ])
    .index("by_generation_and_chunkId", ["embeddingGenerationId", "chunkId"])
    .index("by_thoughtId", ["thoughtId"])
    .index("by_chunkId", ["chunkId"])
    .vectorIndex("by_embedding_1536", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["searchScope"],
    }),
};
