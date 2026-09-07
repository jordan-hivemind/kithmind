import { internalAction } from "../../_generated/server";
import { v } from "convex/values";
import {
  BASELINE_EMBEDDING_DIMENSIONS,
  embeddingProfile,
  fingerprintEmbeddingConfig,
  loadEmbeddingConfig,
  requestEmbedding,
} from "../../lib/embeddingProvider";

export const EMBEDDING_DIMENSIONS = BASELINE_EMBEDDING_DIMENSIONS;

const embeddingProfileValidator = v.object({
  protocol: v.string(),
  providerId: v.string(),
  model: v.string(),
  modelRevision: v.string(),
  dimensions: v.number(),
  normalization: v.string(),
  preprocessing: v.string(),
});

export const getEmbeddingConfigurationIdentity = internalAction({
  args: {},
  returns: v.object({
    fingerprint: v.string(),
    profile: embeddingProfileValidator,
  }),
  handler: async () => {
    const config = loadEmbeddingConfig(process.env);
    return {
      fingerprint: await fingerprintEmbeddingConfig(config),
      profile: embeddingProfile(config),
    };
  },
});

export const generateEmbeddingWithMetadata = internalAction({
  args: { text: v.string() },
  returns: v.object({
    vector: v.array(v.float64()),
    fingerprint: v.string(),
    profile: embeddingProfileValidator,
  }),
  handler: async (_ctx, args) =>
    await requestEmbedding(args.text, loadEmbeddingConfig(process.env)),
});

/** Compatibility adapter for existing evaluation and trusted fixture callers. */
export const generateEmbedding = internalAction({
  args: { text: v.string() },
  returns: v.array(v.float64()),
  handler: async (_ctx, args): Promise<number[]> => {
    return (await requestEmbedding(args.text, loadEmbeddingConfig(process.env)))
      .vector;
  },
});
