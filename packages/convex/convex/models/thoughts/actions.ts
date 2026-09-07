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
import { memoryStatus, thoughtMetadata, thoughtType } from "./validators";
import { memorySourceType } from "./validators";
import { principalRefValidator } from "../apiKeys/validators";

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
    const embedding = await ctx.runAction(
      internal.models.thoughts.helpers.generateEmbedding,
      { text: content },
    );

    const similarResults = await ctx.vectorSearch("thoughts", "by_embedding", {
      vector: embedding,
      limit: 256,
      filter: (q) => q.eq("spaceId", args.spaceId),
    });

    const candidates = similarResults
      .filter((r) => r._score >= SIMILARITY_THRESHOLD)
      .slice(0, MAX_CANDIDATES * 5);

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
        ids: candidates.map((r) => r._id),
      },
    );
    const candidateById = new Map(
      candidateDocs.map((doc) => [doc._id as string, doc]),
    );

    // Preserve vector-search ranking; `getByIds` does not guarantee order.
    const validCandidates = candidates
      .map((r) => candidateById.get(r._id as string))
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
          const replacementEmbedding = canReuseEmbedding(
            content,
            replacementContent,
          )
            ? embedding
            : await ctx.runAction(
                internal.models.thoughts.helpers.generateEmbedding,
                { text: replacementContent },
              );
          const replacementMetadata =
            analysis?.metadata ?? fallbackThoughtMetadata(replacementContent);

          const thoughtId: Id<"thoughts"> = await ctx.runMutation(
            internal.models.thoughts.private.transitionMemoryAuthorized,
            {
              principal: args.principal,
              spaceId: args.spaceId,
              content: replacementContent,
              embedding: replacementEmbedding,
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

export const hybridSearch = internalAction({
  args: {
    principal: principalRefValidator,
    spaceIds: v.optional(v.array(v.id("spaces"))),
    query: v.string(),
    type: v.optional(thoughtType),
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      _id: v.id("thoughts"),
      content: v.string(),
      metadata: thoughtMetadata,
      userId: v.id("users"),
      spaceId: v.id("spaces"),
      score: v.float64(),
      createdAt: v.number(),
      memoryStatus,
      isCore: v.optional(v.boolean()),
      validFrom: v.optional(v.number()),
      validTo: v.optional(v.number()),
      supersededAt: v.optional(v.number()),
      changeReason: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 10, 100);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Thought limit must be a positive integer");
    }
    const candidateCap = 50;
    const K = 60; // RRF constant

    const authorizedSpaceIds: Array<Id<"spaces">> = await ctx.runQuery(
      internal.models.thoughts.private.resolveReadSpacesForAction,
      { principal: args.principal, spaceIds: args.spaceIds },
    );
    if (authorizedSpaceIds.length === 0) return [];
    // Authorize before spending an embedding request, then generate once for
    // the globally merged vector search.
    const embedding = await ctx.runAction(
      internal.models.thoughts.helpers.generateEmbedding,
      { text: args.query },
    );

    const activeAt = Date.now();
    const [vectorHitsBySpace, textHits] = await Promise.all([
      Promise.all(
        authorizedSpaceIds.map((spaceId) =>
          ctx.vectorSearch("thoughts", "by_embedding", {
            vector: embedding,
            limit: args.includeHistorical ? candidateCap : candidateCap * 4,
            filter: (q) => q.eq("spaceId", spaceId),
          }),
        ),
      ),
      ctx.runQuery(internal.models.thoughts.private.searchByTextAuthorized, {
        principal: args.principal,
        spaceIds: authorizedSpaceIds,
        query: args.query,
        type: args.type,
        limit: candidateCap,
        includeHistorical: args.includeHistorical,
        activeAt,
      }),
    ]);
    const vectorHits = vectorHitsBySpace
      .flat()
      .sort(
        (left, right) =>
          right._score - left._score ||
          String(left._id).localeCompare(String(right._id)),
      )
      .slice(0, args.includeHistorical ? candidateCap : candidateCap * 4);

    // Vector indexes cannot filter optional lifecycle fields, so hydrate once
    // and post-filter historical results. Text hits are filtered in their query.
    const vectorIds = vectorHits.map((hit) => hit._id);
    const fetchedDocs: Array<{
      _id: Id<"thoughts">;
      _creationTime: number;
      content: string;
      metadata: Infer<typeof thoughtMetadata>;
      userId: string;
      spaceId?: Id<"spaces">;
      updatedAt?: number;
      memoryStatus?: MemoryStatus;
      isCore?: boolean;
      validFrom?: number;
      validTo?: number;
      supersededAt?: number;
      changeReason?: string;
    }> = await ctx.runQuery(
      internal.models.thoughts.private.getByIdsAuthorized,
      {
        principal: args.principal,
        spaceIds: authorizedSpaceIds,
        ids: vectorIds,
      },
    );
    const docById = new Map(fetchedDocs.map((doc) => [doc._id as string, doc]));
    const filteredVectorHits = vectorHits.filter((hit) => {
      const doc = docById.get(hit._id);
      return (
        doc !== undefined &&
        (args.type === undefined || doc.metadata.type === args.type) &&
        isMemoryRetrievable(doc, args.includeHistorical, activeAt)
      );
    });

    // Reciprocal Rank Fusion uses one-based ranks: score = Σ 1 / (K + rank).
    const rrf = new Map<string, number>();
    filteredVectorHits.forEach((h, rank) => {
      rrf.set(h._id, (rrf.get(h._id) ?? 0) + 1 / (K + rank + 1));
    });
    // Cast narrows textHits to _id only; upstream `internal as any` collapses the runQuery return type.
    (textHits as Array<{ _id: string }>).forEach((h, rank) => {
      rrf.set(h._id, (rrf.get(h._id) ?? 0) + 1 / (K + rank + 1));
    });

    const rankedIds = [...rrf.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([id]) => id);

    // Hydrate final ranked results with a single batch query.
    const hydrated: Array<{
      _id: Id<"thoughts">;
      _creationTime: number;
      content: string;
      metadata: Infer<typeof thoughtMetadata>;
      userId: string;
      spaceId?: Id<"spaces">;
      updatedAt?: number;
      memoryStatus?: MemoryStatus;
      isCore?: boolean;
      validFrom?: number;
      validTo?: number;
      supersededAt?: number;
      changeReason?: string;
    }> = await ctx.runQuery(
      internal.models.thoughts.private.getByIdsAuthorized,
      {
        principal: args.principal,
        spaceIds: authorizedSpaceIds,
        ids: rankedIds as Array<Id<"thoughts">>,
      },
    );
    const hydratedById = new Map(hydrated.map((d) => [d._id as string, d]));

    return rankedIds
      .map((id) => {
        const doc = hydratedById.get(id);
        return doc
          ? {
              _id: doc._id,
              content: doc.content,
              metadata: doc.metadata,
              userId: doc.userId as Id<"users">,
              spaceId: doc.spaceId!,
              score: rrf.get(id)!,
              createdAt: doc._creationTime,
              memoryStatus: doc.memoryStatus ?? "current",
              isCore: doc.isCore,
              validFrom: doc.validFrom,
              validTo: doc.validTo,
              supersededAt: doc.supersededAt,
              changeReason: doc.changeReason,
            }
          : null;
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
  },
});
