import { v } from "convex/values";

import type { Id } from "../../_generated/dataModel";
import { internalQuery } from "../../_generated/server";
import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import { principalRefValidator } from "../apiKeys/validators";
import {
  getActiveEmbeddingTarget,
  resolveAuthorizedChunkVectorCandidates,
} from "../embeddings/model";
import { searchDocuments } from "./model";
import { documentSearchArgs } from "./validators";

export const searchWithCandidates = internalQuery({
  args: {
    ...documentSearchArgs,
    principal: principalRefValidator,
    targets: v.array(
      v.object({
        spaceId: v.id("spaces"),
        embeddingGenerationId: v.id("embeddingGenerations"),
        fingerprint: v.string(),
      }),
    ),
    embeddingVectorIds: v.array(v.id("embeddingVectors")),
  },
  handler: async (ctx, args) => {
    // Authorization and both search legs run in this final database snapshot.
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      args.principal,
      args.spaceIds,
    );
    if (args.targets.length > 32 || args.embeddingVectorIds.length > 32) {
      throw new Error("Document vector candidates exceed their bound");
    }
    let ready = spaceIds.length > 0 && args.targets.length === spaceIds.length;
    const fingerprint = args.targets[0]?.fingerprint;
    const targetSpaces = new Set(args.targets.map((target) => target.spaceId));
    ready &&= targetSpaces.size === spaceIds.length;
    let chunkIds: Id<"chunks">[] = [];
    try {
      if (ready) {
        for (const spaceId of spaceIds) {
          const requested = args.targets.find(
            (target) => target.spaceId === spaceId,
          );
          const active = await getActiveEmbeddingTarget(ctx, spaceId);
          if (
            !requested ||
            !active ||
            active.chunkStatus !== "ready" ||
            requested.fingerprint !== fingerprint ||
            active.fingerprint !== fingerprint ||
            active.embeddingGenerationId !== requested.embeddingGenerationId
          ) {
            ready = false;
            break;
          }
        }
      }
      const candidates = ready
        ? await resolveAuthorizedChunkVectorCandidates(ctx, {
            principal: args.principal,
            targets: args.targets,
            embeddingVectorIds: args.embeddingVectorIds,
          })
        : [];
      chunkIds = candidates.map((candidate) => candidate.chunkId);
    } catch {
      // A corrupt or changed vector profile does not hide keyword evidence.
      ready = false;
    }
    return await searchDocuments(ctx, spaceIds, args, {
      chunkIds,
      vectorStatus: ready ? "ready" : "unavailable",
    });
  },
});
