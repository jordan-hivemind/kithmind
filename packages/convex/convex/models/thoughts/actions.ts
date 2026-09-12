import { internalAction } from "../../_generated/server";
import { internal as _internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { v, type Infer } from "convex/values";
import { SIMILARITY_THRESHOLD, MAX_CANDIDATES } from "./classify";
import {
  canReuseEmbedding,
  fallbackThoughtMetadata,
  normalizeCaptureContent,
  preflightNarrativeAdmission,
  type ThoughtAnalysis,
} from "./memoryAnalysis";
import {
  assertValidMemoryValidity,
  isCurrentMemory,
  isMemoryRetrievable,
  type MemoryStatus,
} from "./memoryLifecycle";
import {
  memoryStatus,
  thoughtMetadata,
  thoughtSearchResult,
  thoughtType,
  vectorStatus as vectorStatusValidator,
} from "./validators";
import { memorySourceType } from "./validators";
import { principalRefValidator } from "../apiKeys/validators";
import { embeddingVectorScopeV2 } from "../embeddings/targets";

// Break circular type inference — actions.ts exports are part of `internal`'s type,
// so referencing `internal` here creates a cycle. Runtime behavior is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internal = _internal as any;

export const captureThought = internalAction({
  args: {
    principal: principalRefValidator,
    spaceId: v.id("spaces"),
    content: v.string(),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    isCore: v.optional(v.boolean()),
    sourceType: v.optional(memorySourceType),
    sourceRef: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    batchId: v.optional(v.string()),
  },
  returns: v.object({
    thoughtId: v.optional(v.id("thoughts")),
    metadata: thoughtMetadata,
    disposition: v.union(
      v.literal("stored"),
      v.literal("duplicate"),
      v.literal("superseded"),
      v.literal("corrected"),
      v.literal("needs_confirmation"),
      v.literal("skipped"),
    ),
    operationSummary: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    await ctx.runQuery(
      internal.models.thoughts.private.requireCaptureAccessForAction,
      { principal: args.principal, spaceId: args.spaceId },
    );
    assertValidMemoryValidity(args);
    if (
      (args.observedAt !== undefined && !Number.isFinite(args.observedAt)) ||
      (args.sourceRef !== undefined &&
        (!args.sourceRef.trim() || args.sourceRef.length > 500)) ||
      (args.batchId !== undefined &&
        (!args.batchId.trim() || args.batchId.length > 160))
    ) {
      throw new Error("Invalid memory provenance");
    }
    const content = normalizeCaptureContent(args.content);

    // A client connected before `sourceType` existed cannot supply it, and its
    // cached tool schema only refreshes on reconnect. Rejecting the call breaks
    // capture outright for that client, while defaulting to `user_stated` would
    // label ungrounded content as something the user said — the exact laundering
    // this field prevents. Treat absence as ungrounded and ask instead.
    if (args.sourceType === undefined) {
      return {
        metadata: fallbackThoughtMetadata(content),
        disposition: "needs_confirmation" as const,
        operationSummary:
          "Memory was not stored because its grounding is unknown. Resend with sourceType once the user has stated or confirmed it",
      };
    }
    const sourceType = args.sourceType;

    const preflight = preflightNarrativeAdmission(content);
    if (preflight) {
      return {
        metadata: fallbackThoughtMetadata(content),
        disposition:
          preflight.action === "ASK"
            ? ("needs_confirmation" as const)
            : ("skipped" as const),
        operationSummary:
          preflight.action === "ASK"
            ? `Memory was not stored: ${preflight.reason}`
            : `Memory was skipped: ${preflight.reason}`,
      };
    }
    const existingEmbeddingTarget: {
      spaceId: Id<"spaces">;
      embeddingGenerationId: Id<"embeddingGenerations">;
      fingerprint: string;
    } | null = await ctx.runQuery(
      internal.models.thoughts.private.resolveCaptureEmbeddingTargetForAction,
      { principal: args.principal, spaceId: args.spaceId },
    );
    const configuration: {
      fingerprint: string;
      profile: {
        protocol: string;
        providerId: string;
        model: string;
        modelRevision: string;
        dimensions: number;
        normalization: string;
        preprocessing: string;
      };
    } = await ctx.runAction(
      internal.models.thoughts.helpers.getEmbeddingConfigurationIdentity,
      {},
    );
    if (
      existingEmbeddingTarget &&
      existingEmbeddingTarget.fingerprint !== configuration.fingerprint
    ) {
      throw new Error(
        "The configured embedding provider does not match the active space profile",
      );
    }
    const embeddingResult: { vector: number[]; fingerprint: string } =
      await ctx.runAction(
        internal.models.thoughts.helpers.generateEmbeddingWithMetadata,
        { text: content },
      );
    if (embeddingResult.fingerprint !== configuration.fingerprint) {
      throw new Error(
        "The configured embedding provider does not match the active space profile",
      );
    }
    const embeddingTarget: {
      spaceId: Id<"spaces">;
      embeddingGenerationId: Id<"embeddingGenerations">;
      fingerprint: string;
    } = await ctx.runMutation(
      internal.models.thoughts.private
        .resolveOrBootstrapCaptureEmbeddingTargetForAction,
      {
        principal: args.principal,
        spaceId: args.spaceId,
        fingerprint: configuration.fingerprint,
        profile: configuration.profile,
        now: Date.now(),
      },
    );
    const embedding = embeddingResult.vector;

    const similarResults = await ctx.vectorSearch(
      "embeddingVectors",
      "by_embedding_1536",
      {
        vector: embedding,
        limit: 256,
        filter: (q) =>
          q.eq(
            "scopeV2",
            embeddingVectorScopeV2({
              spaceId: embeddingTarget.spaceId,
              fingerprint: embeddingTarget.fingerprint,
              targetKind: "thought",
            }),
          ),
      },
    );

    const candidateVectors = similarResults
      .filter((r) => r._score >= SIMILARITY_THRESHOLD)
      .slice(0, MAX_CANDIDATES * 5);

    const resolvedCandidates: Array<{
      embeddingVectorId: Id<"embeddingVectors">;
      thoughtId: Id<"thoughts">;
      spaceId: Id<"spaces">;
    }> = await ctx.runQuery(
      internal.models.thoughts.private.resolveThoughtVectorCandidatesAuthorized,
      {
        principal: args.principal,
        targets: [embeddingTarget],
        embeddingVectorIds: candidateVectors.map((row) => row._id),
      },
    );
    const thoughtIdByVectorId = new Map(
      resolvedCandidates.map((row) => [
        row.embeddingVectorId as string,
        row.thoughtId,
      ]),
    );
    const candidates = candidateVectors
      .map((row) => {
        const thoughtId = thoughtIdByVectorId.get(row._id as string);
        return thoughtId ? { ...row, thoughtId } : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    // One batched read rather than a query per candidate. The vector search is
    // already scoped to this account; the ownership check below is defence in
    // depth against an index that outlives a reassignment.
    const candidateDocs: Array<{
      _id: Id<"thoughts">;
      _creationTime: number;
      content: string;
      metadata: Infer<typeof thoughtMetadata>;
      userId: string;
      spaceId?: Id<"spaces">;
      memoryStatus?: MemoryStatus;
      validFrom?: number;
      validTo?: number;
    }> = await ctx.runQuery(
      internal.models.thoughts.private.getByIdsAuthorized,
      {
        principal: args.principal,
        spaceIds: [args.spaceId],
        ids: candidates.map((r) => r.thoughtId),
      },
    );
    const candidateById = new Map(
      candidateDocs.map((doc) => [doc._id as string, doc]),
    );

    // Preserve vector-search ranking; `getByIds` does not guarantee order.
    const validCandidates = candidates
      .map((r) => candidateById.get(r.thoughtId as string))
      .filter(
        (doc): doc is NonNullable<typeof doc> =>
          doc !== undefined &&
          doc.spaceId === args.spaceId &&
          isCurrentMemory(doc.memoryStatus),
      )
      .slice(0, MAX_CANDIDATES)
      .map((doc) => ({
        _id: doc._id as string,
        content: doc.content,
        metadata: {
          type: doc.metadata.type,
          topics: doc.metadata.topics,
          people: doc.metadata.people,
          summary: doc.metadata.summary,
        },
        createdAt: doc._creationTime,
        validFrom: doc.validFrom,
        validTo: doc.validTo,
      }));

    // Structured storage owns the predicates it records, so the gate has to see
    // covering facts before it can decide this content is new.
    const coveringFacts: Array<{ id: string; statement: string }> =
      await ctx.runQuery(internal.models.facts.private.searchCoveringFacts, {
        principal: args.principal,
        spaceIds: [args.spaceId],
        query: content,
      });

    let analysis: ThoughtAnalysis | null = null;
    try {
      analysis = await ctx.runAction(
        internal.models.thoughts.classify.analyzeThought,
        {
          newContent: content,
          sourceType,
          newValidFrom: args.validFrom,
          newValidTo: args.validTo,
          candidates: validCandidates,
          coveringFacts,
        },
      );
    } catch (error) {
      console.error(
        "[Smart Save] Memory analysis failed; declining automatic storage:",
        error,
      );
    }

    // Classification can take long enough for a key or membership to change.
    // Recheck before returning any result derived from stored candidates and
    // before dispatching the final mutation, which rechecks once more.
    await ctx.runQuery(
      internal.models.thoughts.private.requireCaptureAccessForAction,
      { principal: args.principal, spaceId: args.spaceId },
    );

    let classification = analysis?.classification ?? null;

    if (!classification) {
      const metadata = fallbackThoughtMetadata(content);
      return {
        metadata,
        disposition: "needs_confirmation" as const,
        operationSummary:
          "Memory was not stored because the admission check was unavailable",
      };
    }

    if (classification.action === "ASK" || classification.action === "SKIP") {
      return {
        metadata: analysis?.metadata ?? fallbackThoughtMetadata(content),
        disposition:
          classification.action === "ASK"
            ? ("needs_confirmation" as const)
            : ("skipped" as const),
        operationSummary:
          classification.action === "ASK"
            ? `Memory was not stored: ${classification.reason}`
            : `Memory was skipped: ${classification.reason}`,
      };
    }

    if (classification?.action === "NOOP") {
      const citedId = classification.relatedThoughtIds[0];
      // The cited id may name a fact rather than a thought. Check before it
      // reaches a query validated as `v.id("thoughts")`.
      const coveringFact = coveringFacts.find((fact) => fact.id === citedId);
      if (coveringFact) {
        return {
          metadata: analysis?.metadata ?? fallbackThoughtMetadata(content),
          disposition: "duplicate" as const,
          operationSummary: `Already recorded as a structured fact: ${coveringFact.statement}`,
        };
      }

      const existingId = citedId as Id<"thoughts"> | undefined;
      const existing = existingId
        ? await ctx.runQuery(
            internal.models.thoughts.private.getByIdAuthorized,
            {
              principal: args.principal,
              id: existingId,
            },
          )
        : null;
      if (
        existing &&
        existing.spaceId === args.spaceId &&
        isCurrentMemory(existing.memoryStatus)
      ) {
        if (args.isCore !== undefined) {
          await ctx.runMutation(
            internal.models.thoughts.private.setCoreStatusAuthorized,
            {
              principal: args.principal,
              spaceId: args.spaceId,
              id: existing._id,
              isCore: args.isCore,
            },
          );
        }
        return {
          thoughtId: existing._id,
          metadata: existing.metadata,
          disposition: "duplicate" as const,
          operationSummary:
            args.isCore === undefined
              ? "Thought already captured — no changes made"
              : "Thought already captured — core status updated",
        };
      }
      classification = null;
    }

    if (
      classification?.action === "SUPERSEDE" ||
      classification?.action === "RETRACT"
    ) {
      const replacementContent = classification.replacementContent;
      if (replacementContent) {
        try {
          let replacementEmbedding = embedding;
          if (!canReuseEmbedding(content, replacementContent)) {
            const replacementResult: {
              vector: number[];
              fingerprint: string;
            } = await ctx.runAction(
              internal.models.thoughts.helpers.generateEmbeddingWithMetadata,
              { text: replacementContent },
            );
            if (replacementResult.fingerprint !== embeddingTarget.fingerprint) {
              throw new Error(
                "The configured embedding provider does not match the active space profile",
              );
            }
            replacementEmbedding = replacementResult.vector;
          }
          const replacementMetadata =
            analysis?.metadata ?? fallbackThoughtMetadata(replacementContent);

          const thoughtId: Id<"thoughts"> = await ctx.runMutation(
            internal.models.thoughts.private.transitionMemoryAuthorized,
            {
              principal: args.principal,
              spaceId: args.spaceId,
              content: replacementContent,
              embedding: replacementEmbedding,
              embeddingGenerationId: embeddingTarget.embeddingGenerationId,
              embeddingFingerprint: embeddingTarget.fingerprint,
              metadata: replacementMetadata,
              previousIds: classification.relatedThoughtIds as Array<
                Id<"thoughts">
              >,
              previousStatus:
                classification.action === "SUPERSEDE"
                  ? "superseded"
                  : "retracted",
              reason: classification.reason,
              transitionedAt: Date.now(),
              validFrom: args.validFrom,
              validTo: args.validTo,
              isCore: args.isCore,
              sourceType,
              sourceRef: args.sourceRef?.trim(),
              observedAt: args.observedAt,
              batchId: args.batchId?.trim(),
              confidence: 1,
            },
          );
          const count = classification.relatedThoughtIds.length;
          const operationSummary =
            classification.action === "SUPERSEDE"
              ? "Stored the new current memory and preserved " +
                count +
                (count === 1
                  ? " previous memory as historical"
                  : " previous memories as historical")
              : "Stored the correction and marked " +
                count +
                (count === 1
                  ? " previous memory as inaccurate"
                  : " previous memories as inaccurate");

          return {
            thoughtId,
            metadata: replacementMetadata,
            disposition:
              classification.action === "SUPERSEDE"
                ? ("superseded" as const)
                : ("corrected" as const),
            operationSummary,
          };
        } catch (error) {
          console.error(
            "[Smart Save] Memory transition failed; falling back to ADD",
            error,
          );
        }
      }
    }

    const metadata: Infer<typeof thoughtMetadata> =
      classification?.action === "ADD" && analysis
        ? analysis.metadata
        : fallbackThoughtMetadata(content);
    const thoughtId: Id<"thoughts"> = await ctx.runMutation(
      internal.models.thoughts.private.insertOneAuthorized,
      {
        principal: args.principal,
        spaceId: args.spaceId,
        content,
        embedding,
        embeddingGenerationId: embeddingTarget.embeddingGenerationId,
        embeddingFingerprint: embeddingTarget.fingerprint,
        metadata,
        validFrom: args.validFrom,
        validTo: args.validTo,
        isCore: args.isCore,
        sourceType,
        sourceRef: args.sourceRef?.trim(),
        observedAt: args.observedAt,
        batchId: args.batchId?.trim(),
        confidence: 1,
      },
    );

    return { thoughtId, metadata, disposition: "stored" as const };
  },
});

/** Trusted compatibility path for deterministic internal fixtures and jobs. */
export const captureThoughtTrustedPersonal = internalAction({
  args: {
    userId: v.id("users"),
    content: v.string(),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    isCore: v.optional(v.boolean()),
    sourceType: v.optional(memorySourceType),
    sourceRef: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    batchId: v.optional(v.string()),
  },
  returns: v.object({
    thoughtId: v.optional(v.id("thoughts")),
    metadata: thoughtMetadata,
    disposition: v.union(
      v.literal("stored"),
      v.literal("duplicate"),
      v.literal("superseded"),
      v.literal("corrected"),
      v.literal("needs_confirmation"),
      v.literal("skipped"),
    ),
    operationSummary: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const principal = { userId: args.userId };
    const spaceId: Id<"spaces"> = await ctx.runMutation(
      internal.models.thoughts.private.resolvePersonalSpaceForTrustedAction,
      { userId: args.userId },
    );
    const { userId: _userId, ...capture } = args;
    return await ctx.runAction(
      internal.models.thoughts.actions.captureThought,
      {
        principal,
        spaceId,
        ...capture,
      },
    );
  },
});

const hybridSearchArgs = {
  principal: principalRefValidator,
  spaceIds: v.optional(v.array(v.id("spaces"))),
  query: v.string(),
  type: v.optional(thoughtType),
  limit: v.optional(v.number()),
  includeHistorical: v.optional(v.boolean()),
};

type ActiveEmbeddingTarget = {
  spaceId: Id<"spaces">;
  embeddingGenerationId: Id<"embeddingGenerations">;
  fingerprint: string;
};

type HydratedThought = {
  _id: Id<"thoughts">;
  _creationTime: number;
  content: string;
  metadata: Infer<typeof thoughtMetadata>;
  userId: Id<"users">;
  spaceId?: Id<"spaces">;
  memoryStatus?: MemoryStatus;
  isCore?: boolean;
  validFrom?: number;
  validTo?: number;
  supersededAt?: number;
  changeReason?: string;
};

export function compatibleSearchFingerprint(
  spaceIds: readonly Id<"spaces">[],
  targets: readonly ActiveEmbeddingTarget[],
): string | null {
  if (spaceIds.length === 0 || targets.length !== spaceIds.length) return null;
  const bySpace = new Map(targets.map((target) => [target.spaceId, target]));
  if (bySpace.size !== spaceIds.length) return null;
  const fingerprint = bySpace.get(spaceIds[0]!)?.fingerprint;
  if (!fingerprint) return null;
  return spaceIds.every(
    (spaceId) => bySpace.get(spaceId)?.fingerprint === fingerprint,
  )
    ? fingerprint
    : null;
}

function fuseSearchRanks(
  vectorThoughtIds: readonly string[],
  textThoughtIds: readonly string[],
  limit: number,
) {
  const K = 60;
  const scores = new Map<string, number>();
  for (const [rank, id] of vectorThoughtIds.entries()) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (K + rank + 1));
  }
  for (const [rank, id] of textThoughtIds.entries()) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (K + rank + 1));
  }
  const ids = [...scores.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, limit)
    .map(([id]) => id);
  return { ids, scores };
}

async function runHybridSearch(
  // The generated action context type is recursive through `internal`; keep
  // this implementation local while the public validators retain strict IO.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: {
    principal: Infer<typeof principalRefValidator>;
    spaceIds?: Array<Id<"spaces">>;
    query: string;
    type?: Infer<typeof thoughtType>;
    limit?: number;
    includeHistorical?: boolean;
  },
): Promise<{
  results: Array<Infer<typeof thoughtSearchResult>>;
  vectorStatus: "ready" | "unavailable";
}> {
  const limit = Math.min(args.limit ?? 10, 100);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Thought limit must be a positive integer");
  }
  const candidateCap = 50;
  const activeAt = Date.now();
  const scope: {
    spaceIds: Array<Id<"spaces">>;
    targets: ActiveEmbeddingTarget[];
  } = await ctx.runQuery(
    internal.models.thoughts.private.resolveReadEmbeddingTargetsForAction,
    { principal: args.principal, spaceIds: args.spaceIds },
  );
  if (scope.spaceIds.length === 0) {
    return { results: [], vectorStatus: "unavailable" };
  }

  const textHitsPromise = ctx.runQuery(
    internal.models.thoughts.private.searchByTextAuthorized,
    {
      principal: args.principal,
      spaceIds: scope.spaceIds,
      query: args.query,
      type: args.type,
      limit: candidateCap,
      includeHistorical: args.includeHistorical,
      activeAt,
    },
  ) as Promise<Array<{ _id: Id<"thoughts"> }>>;

  let vectorStatus: "ready" | "unavailable" = "unavailable";
  let vectorThoughtIds: string[] = [];
  let vectorCandidates: Array<{
    embeddingVectorId: Id<"embeddingVectors">;
    thoughtId: Id<"thoughts">;
  }> = [];
  const expectedFingerprint = compatibleSearchFingerprint(
    scope.spaceIds,
    scope.targets,
  );
  if (expectedFingerprint) {
    try {
      const configuration: { fingerprint: string } = await ctx.runAction(
        internal.models.thoughts.helpers.getEmbeddingConfigurationIdentity,
        {},
      );
      if (configuration.fingerprint !== expectedFingerprint) {
        throw new Error("Configured embedding profile mismatch");
      }
      const generated: { vector: number[]; fingerprint: string } =
        await ctx.runAction(
          internal.models.thoughts.helpers.generateEmbeddingWithMetadata,
          { text: args.query },
        );
      if (generated.fingerprint !== expectedFingerprint) {
        throw new Error("Configured embedding profile mismatch");
      }
      const globalVectorCandidateCap = args.includeHistorical
        ? candidateCap
        : candidateCap * 4;
      const perSpaceLimit = Math.max(
        1,
        Math.floor(globalVectorCandidateCap / scope.targets.length),
      );
      const vectorHits = (
        await Promise.all(
          scope.targets.map((target) =>
            ctx.vectorSearch("embeddingVectors", "by_embedding_1536", {
              vector: generated.vector,
              limit: perSpaceLimit,
              filter: (q: { eq: (field: string, value: unknown) => unknown }) =>
                q.eq(
                  "scopeV2",
                  embeddingVectorScopeV2({
                    spaceId: target.spaceId,
                    fingerprint: target.fingerprint,
                    targetKind: "thought",
                  }),
                ),
            }),
          ),
        )
      )
        .flat()
        .sort(
          (left, right) =>
            right._score - left._score ||
            String(left._id).localeCompare(String(right._id)),
        )
        .slice(0, globalVectorCandidateCap);
      const resolved: Array<{
        embeddingVectorId: Id<"embeddingVectors">;
        thoughtId: Id<"thoughts">;
      }> = await ctx.runQuery(
        internal.models.thoughts.private
          .resolveThoughtVectorCandidatesAuthorized,
        {
          principal: args.principal,
          targets: scope.targets,
          embeddingVectorIds: vectorHits.map((hit) => hit._id),
          type: args.type,
          includeHistorical: args.includeHistorical,
          activeAt,
        },
      );
      const thoughtIdByVectorId = new Map(
        resolved.map((row) => [
          row.embeddingVectorId as string,
          row.thoughtId as string,
        ]),
      );
      vectorCandidates = vectorHits.flatMap((hit) => {
        const thoughtId = thoughtIdByVectorId.get(hit._id as string);
        return thoughtId
          ? [
              {
                embeddingVectorId: hit._id,
                thoughtId: thoughtId as Id<"thoughts">,
              },
            ]
          : [];
      });
      vectorThoughtIds = vectorCandidates.map(
        (candidate) => candidate.thoughtId as string,
      );
      vectorStatus = "ready";
    } catch {
      console.error("[Recall] Vector search unavailable");
      // Do not let a stale authorization failure turn into a keyword result.
      await ctx.runQuery(
        internal.models.thoughts.private.resolveReadSpacesForAction,
        { principal: args.principal, spaceIds: scope.spaceIds },
      );
    }
  }

  const textHits = await textHitsPromise;
  let fused = fuseSearchRanks(
    vectorThoughtIds,
    textHits.map((hit) => hit._id as string),
    limit,
  );

  let hydrated: HydratedThought[];
  try {
    const selectedIds = new Set(fused.ids);
    hydrated = await ctx.runQuery(
      internal.models.thoughts.private.hydrateHybridResultsAuthorized,
      {
        principal: args.principal,
        spaceIds: scope.spaceIds,
        ids: fused.ids as Array<Id<"thoughts">>,
        targets: vectorStatus === "ready" ? scope.targets : [],
        vectorCandidates:
          vectorStatus === "ready"
            ? vectorCandidates.filter((candidate) =>
                selectedIds.has(candidate.thoughtId as string),
              )
            : [],
      },
    );
  } catch (error) {
    if (vectorStatus !== "ready") throw error;
    console.error("[Recall] Vector generation changed during search");
    await ctx.runQuery(
      internal.models.thoughts.private.resolveReadSpacesForAction,
      { principal: args.principal, spaceIds: scope.spaceIds },
    );
    vectorStatus = "unavailable";
    fused = fuseSearchRanks(
      [],
      textHits.map((hit) => hit._id as string),
      limit,
    );
    hydrated = await ctx.runQuery(
      internal.models.thoughts.private.hydrateHybridResultsAuthorized,
      {
        principal: args.principal,
        spaceIds: scope.spaceIds,
        ids: fused.ids as Array<Id<"thoughts">>,
        targets: [],
        vectorCandidates: [],
      },
    );
  }

  const hydratedById = new Map(hydrated.map((doc) => [doc._id as string, doc]));
  const results = fused.ids
    .map((id) => {
      const doc = hydratedById.get(id);
      if (
        !doc ||
        !doc.spaceId ||
        (args.type !== undefined && doc.metadata.type !== args.type) ||
        !isMemoryRetrievable(doc, args.includeHistorical, activeAt)
      ) {
        return null;
      }
      return {
        _id: doc._id,
        content: doc.content,
        metadata: doc.metadata,
        userId: doc.userId,
        spaceId: doc.spaceId,
        score: fused.scores.get(id)!,
        createdAt: doc._creationTime,
        memoryStatus: doc.memoryStatus ?? "current",
        isCore: doc.isCore,
        validFrom: doc.validFrom,
        validTo: doc.validTo,
        supersededAt: doc.supersededAt,
        changeReason: doc.changeReason,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  return { results, vectorStatus };
}

export const hybridSearchWithStatus = internalAction({
  args: hybridSearchArgs,
  returns: v.object({
    results: v.array(thoughtSearchResult),
    vectorStatus: vectorStatusValidator,
  }),
  handler: runHybridSearch,
});

/** Legacy array result retained for web and evaluation callers. */
export const hybridSearch = internalAction({
  args: hybridSearchArgs,
  returns: v.array(thoughtSearchResult),
  handler: async (ctx, args) => (await runHybridSearch(ctx, args)).results,
});
