import { internal as _internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { action } from "../../_generated/server";
import {
  fingerprintEmbeddingConfig,
  loadEmbeddingConfig,
  requestEmbedding,
} from "../../lib/embeddingProvider";
import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { principalRef } from "../../lib/spaces";
import type { ActiveEmbeddingTarget } from "../embeddings/model";
import { embeddingVectorScopeV2 } from "../embeddings/targets";
import { documentSearchArgs } from "./validators";

/** The plan's fixed candidate budget, split across spaces and target kinds. */
const MAX_SEMANTIC_CANDIDATES = 32;

// Explicit boundary avoids a generated action/query return inference cycle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internal = _internal as any;

export const search = action({
  args: documentSearchArgs,
  handler: async (ctx, args) => {
    const principal = principalRef(await requireMcpPrincipal(ctx));
    const spaceIds: Id<"spaces">[] = await ctx.runQuery(
      internal.models.spaces.private.listAuthorizedReadSpaceIds,
      { principal, spaceIds: args.spaceIds },
    );
    if (
      !args.query.trim() ||
      args.query.trim().length > 500 ||
      spaceIds.length > 32
    ) {
      throw new Error("Document search request is invalid");
    }
    let targets: ActiveEmbeddingTarget[] = [];
    let embeddingVectorIds: Id<"embeddingVectors">[] = [];
    if ((args.searchMode ?? "hybrid") === "hybrid") {
      try {
        const config = loadEmbeddingConfig(process.env);
        const fingerprint = await fingerprintEmbeddingConfig(config);
        const active: ActiveEmbeddingTarget[] = await ctx.runQuery(
          internal.models.embeddings.private.getActiveTargets,
          { principal, spaceIds },
        );
        // D3 B: an incomplete chunk index no longer withholds the semantic
        // leg. The shortfall is reported through `partial` by the query below.
        if (
          spaceIds.length > 0 &&
          active.length === spaceIds.length &&
          active.every((target) => target.fingerprint === fingerprint)
        ) {
          const embedding = await requestEmbedding(args.query, config);
          const hits: Array<{ _id: Id<"embeddingVectors">; _score: number }> =
            [];
          const ordered = [...active].sort((a, b) =>
            a.spaceId.localeCompare(b.spaceId),
          );
          for (const [index, target] of ordered.entries()) {
            const limit =
              Math.floor(MAX_SEMANTIC_CANDIDATES / ordered.length) +
              (index < MAX_SEMANTIC_CANDIDATES % ordered.length ? 1 : 0);
            // P2-70j: card targets are candidates alongside chunk targets
            // under the same scopeV2 scheme. Each kind asks for the space's
            // full share and the merge below keeps the global top 32, so a
            // space with no card targets loses none of its chunk budget.
            for (const targetKind of ["chunk", "card"] as const) {
              const rows = await ctx.vectorSearch(
                "embeddingVectors",
                "by_embedding_1536",
                {
                  vector: embedding.vector,
                  limit,
                  filter: (q) =>
                    q.eq(
                      "scopeV2",
                      embeddingVectorScopeV2({
                        spaceId: target.spaceId,
                        fingerprint,
                        targetKind,
                      }),
                    ),
                },
              );
              hits.push(...rows);
            }
          }
          hits.sort(
            (a, b) => b._score - a._score || a._id.localeCompare(b._id),
          );
          embeddingVectorIds = hits
            .slice(0, MAX_SEMANTIC_CANDIDATES)
            .map((hit) => hit._id);
          targets = active;
        }
      } catch {
        // Provider/index failures affect ranking, never retained keyword evidence.
        targets = [];
        embeddingVectorIds = [];
      }
    }
    return await ctx.runQuery(
      internal.models.documents.private.searchWithCandidates,
      {
        ...args,
        spaceIds,
        principal,
        targets: targets.map(
          ({ spaceId, embeddingGenerationId, fingerprint }) => ({
            spaceId,
            embeddingGenerationId,
            fingerprint,
          }),
        ),
        embeddingVectorIds,
      },
    );
  },
});
