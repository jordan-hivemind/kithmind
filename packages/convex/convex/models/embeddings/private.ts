import { v } from "convex/values";

import { internalQuery } from "../../_generated/server";
import { principalRefValidator } from "../apiKeys/validators";
import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import {
  getActiveEmbeddingTarget,
  resolveAuthorizedChunkVectorCandidates,
  resolveAuthorizedThoughtVectorCandidates,
} from "./model";
import { embeddingProfileValidator } from "./validators";

const activeTargetValidator = v.object({
  spaceId: v.id("spaces"),
  embeddingGenerationId: v.id("embeddingGenerations"),
  fingerprint: v.string(),
  profile: embeddingProfileValidator,
  thoughtStatus: v.union(v.literal("ready"), v.literal("unavailable")),
  chunkCoverage: v.object({ eligible: v.number(), covered: v.number() }),
});

const requestedTargetValidator = v.object({
  spaceId: v.id("spaces"),
  embeddingGenerationId: v.id("embeddingGenerations"),
  fingerprint: v.string(),
});

export const getActiveTargets = internalQuery({
  args: {
    principal: principalRefValidator,
    spaceIds: v.array(v.id("spaces")),
  },
  returns: v.array(activeTargetValidator),
  handler: async (ctx, args) => {
    if (args.spaceIds.length > 32) {
      throw new Error("Embedding target lookup exceeds its space bound");
    }
    const authorizedSpaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      args.principal,
      args.spaceIds,
    );
    const results = [];
    for (const spaceId of authorizedSpaceIds) {
      try {
        const target = await getActiveEmbeddingTarget(ctx, spaceId);
        if (target) results.push(target);
      } catch {
        // An unmigrated or damaged space disables its vectors for this
        // request; it never disables the other spaces or keyword retrieval.
      }
    }
    return results;
  },
});

export const hydrateThoughtCandidates = internalQuery({
  args: {
    principal: principalRefValidator,
    targets: v.array(requestedTargetValidator),
    embeddingVectorIds: v.array(v.id("embeddingVectors")),
  },
  returns: v.array(
    v.object({
      embeddingVectorId: v.id("embeddingVectors"),
      thoughtId: v.id("thoughts"),
      spaceId: v.id("spaces"),
    }),
  ),
  handler: async (ctx, args) =>
    await resolveAuthorizedThoughtVectorCandidates(ctx, args),
});

export const hydrateChunkCandidates = internalQuery({
  args: {
    principal: principalRefValidator,
    targets: v.array(requestedTargetValidator),
    embeddingVectorIds: v.array(v.id("embeddingVectors")),
  },
  returns: v.array(
    v.object({
      embeddingVectorId: v.id("embeddingVectors"),
      chunkId: v.id("chunks"),
      spaceId: v.id("spaces"),
    }),
  ),
  handler: async (ctx, args) =>
    await resolveAuthorizedChunkVectorCandidates(ctx, args),
});
