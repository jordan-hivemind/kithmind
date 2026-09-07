import { v } from "convex/values";

import { internalMutation, internalQuery } from "../../_generated/server";
import {
  activateEmbeddingGeneration,
  createEmbeddingGeneration,
  failEmbeddingGeneration,
  getStagingEmbeddingManifestInputs,
  insertChunkEmbedding,
  insertThoughtEmbedding,
  stageEmbeddingGeneration,
} from "./model";
import { embeddingProfileValidator } from "./validators";

export const createGeneration = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    profile: embeddingProfileValidator,
    fingerprint: v.string(),
    createdAt: v.optional(v.number()),
  },
  returns: v.object({
    embeddingGenerationId: v.id("embeddingGenerations"),
    manifestHash: v.string(),
    expectedThoughtCount: v.number(),
    expectedChunkCount: v.number(),
    eligibilityEpoch: v.number(),
  }),
  handler: async (ctx, args) => {
    const generation = await createEmbeddingGeneration(ctx, {
      ...args,
      createdAt: args.createdAt ?? Date.now(),
    });
    return {
      embeddingGenerationId: generation._id,
      manifestHash: generation.manifestHash,
      expectedThoughtCount: generation.expectedThoughtCount,
      expectedChunkCount: generation.expectedChunkCount,
      eligibilityEpoch: generation.eligibilityEpoch,
    };
  },
});

export const getStagingManifest = internalQuery({
  args: { embeddingGenerationId: v.id("embeddingGenerations") },
  returns: v.object({
    spaceId: v.id("spaces"),
    fingerprint: v.string(),
    eligibilityEpoch: v.number(),
    manifestHash: v.string(),
    inputs: v.array(
      v.union(
        v.object({
          targetKind: v.literal("thought"),
          thoughtId: v.id("thoughts"),
          inputText: v.string(),
          inputHash: v.string(),
        }),
        v.object({
          targetKind: v.literal("chunk"),
          chunkId: v.id("chunks"),
          processingGenerationId: v.id("processingGenerations"),
          inputText: v.string(),
          inputHash: v.string(),
        }),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    const { generation, inputs } = await getStagingEmbeddingManifestInputs(
      ctx,
      args.embeddingGenerationId,
    );
    return {
      spaceId: generation.spaceId,
      fingerprint: generation.fingerprint,
      eligibilityEpoch: generation.eligibilityEpoch,
      manifestHash: generation.manifestHash,
      inputs,
    };
  },
});

export const stageVectorBatch = internalMutation({
  args: {
    embeddingGenerationId: v.id("embeddingGenerations"),
    fingerprint: v.string(),
    vectors: v.array(
      v.union(
        v.object({
          targetKind: v.literal("thought"),
          thoughtId: v.id("thoughts"),
          vector: v.array(v.float64()),
        }),
        v.object({
          targetKind: v.literal("chunk"),
          chunkId: v.id("chunks"),
          vector: v.array(v.float64()),
        }),
      ),
    ),
  },
  returns: v.object({ insertedOrReused: v.number() }),
  handler: async (ctx, args) => {
    if (args.vectors.length < 1 || args.vectors.length > 10) {
      throw new Error("Embedding vector batch must contain 1-10 targets");
    }
    const { generation, inputs } = await getStagingEmbeddingManifestInputs(
      ctx,
      args.embeddingGenerationId,
    );
    if (generation.fingerprint !== args.fingerprint) {
      throw new Error("Embedding vector batch fingerprint does not match");
    }
    const inputByTarget = new Map(
      inputs.map((input) => [
        input.targetKind === "thought"
          ? `thought:${input.thoughtId}`
          : `chunk:${input.chunkId}`,
        input,
      ]),
    );
    const supplied = new Set<string>();
    for (const vector of args.vectors) {
      const key =
        vector.targetKind === "thought"
          ? `thought:${vector.thoughtId}`
          : `chunk:${vector.chunkId}`;
      if (supplied.has(key)) {
        throw new Error("Embedding vector batch contains a duplicate target");
      }
      supplied.add(key);
      const manifestInput = inputByTarget.get(key);
      if (!manifestInput || manifestInput.targetKind !== vector.targetKind) {
        throw new Error(
          "Embedding vector target is outside the staged manifest",
        );
      }
      if (vector.targetKind === "thought") {
        await insertThoughtEmbedding(ctx, {
          spaceId: generation.spaceId,
          thoughtId: vector.thoughtId,
          embeddingGenerationId: generation._id,
          fingerprint: generation.fingerprint,
          inputText: manifestInput.inputText,
          vector: vector.vector,
          bumpEligibility: false,
        });
      } else {
        await insertChunkEmbedding(ctx, {
          spaceId: generation.spaceId,
          chunkId: vector.chunkId,
          embeddingGenerationId: generation._id,
          fingerprint: generation.fingerprint,
          inputText: manifestInput.inputText,
          vector: vector.vector,
        });
      }
    }
    return { insertedOrReused: args.vectors.length };
  },
});

export const stageGeneration = internalMutation({
  args: {
    embeddingGenerationId: v.id("embeddingGenerations"),
    stagedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await stageEmbeddingGeneration(ctx, {
      embeddingGenerationId: args.embeddingGenerationId,
      stagedAt: args.stagedAt ?? Date.now(),
    });
    return null;
  },
});

export const activateGeneration = internalMutation({
  args: {
    embeddingGenerationId: v.id("embeddingGenerations"),
    expectedPreviousGenerationId: v.optional(v.id("embeddingGenerations")),
    activatedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await activateEmbeddingGeneration(ctx, {
      embeddingGenerationId: args.embeddingGenerationId,
      expectedPreviousGenerationId: args.expectedPreviousGenerationId,
      activatedAt: args.activatedAt ?? Date.now(),
    });
    return null;
  },
});

export const failGeneration = internalMutation({
  args: {
    embeddingGenerationId: v.id("embeddingGenerations"),
    code: v.string(),
    message: v.string(),
    failedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await failEmbeddingGeneration(ctx, {
      ...args,
      failedAt: args.failedAt ?? Date.now(),
    });
    return null;
  },
});
