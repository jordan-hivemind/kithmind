import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../../_generated/server";
import type { QueryCtx } from "../../_generated/server";
import { sha256Hex } from "../ingestion/hash";
import { composeCardTargetInput } from "./cardTargets";
import {
  insertCardEmbedding,
  insertChunkEmbedding,
  insertThoughtEmbedding,
} from "./model";
import {
  EMBEDDING_FILL_PAGE,
  findEmbeddingTarget,
  owedTargetsPage,
  usesTargetCounters,
} from "./targets";
import { embeddingTargetRowKindValidator } from "./validators";

/**
 * P2-6c incremental admission: embed the targets the active fingerprint still
 * owes, and nothing else.
 *
 * The owed set is an index page, not a scan. A target is owed exactly while it
 * is eligible and carries no coverage marker, and the insert that covers it
 * removes it from that index, so the fill needs no cursor of its own. Every
 * failure the plan's section 2.3 lists resolves the same way:
 *
 * - a lost provider action leaves the target uncovered, so the next page
 *   re-embeds it;
 * - a replayed commit finds the target already covered and writes nothing;
 * - a page that crashes before its commit leaves the owed index unchanged.
 *
 * One successor is scheduled at a time, by the commit mutation, which is
 * transactional with the coverage it just recorded.
 */

/** One page is one provider batch: the plan's 32 inputs per request. */
const MAX_FILL_VECTORS = EMBEDDING_FILL_PAGE;

/** Named so the action's return type breaks its own reference cycle. */
export type EmbeddingFillResult = {
  requested: number;
  embedded: number;
  skipped: number;
  remaining: boolean;
  scheduled: boolean;
};

const fillTargetValidator = v.object({
  targetKind: embeddingTargetRowKindValidator,
  targetId: v.string(),
  inputHash: v.string(),
  inputText: v.string(),
});

async function liveTargetText(
  ctx: QueryCtx,
  spaceId: Id<"spaces">,
  row: Doc<"embeddingTargets">,
): Promise<string | null> {
  if (row.targetKind === "thought") {
    const thoughtId = ctx.db.normalizeId("thoughts", row.targetId);
    const thought = thoughtId ? await ctx.db.get(thoughtId) : null;
    return thought && thought.spaceId === spaceId ? thought.content : null;
  }
  if (row.targetKind === "chunk") {
    const chunkId = ctx.db.normalizeId("chunks", row.targetId);
    const chunk = chunkId ? await ctx.db.get(chunkId) : null;
    return chunk && chunk.spaceId === spaceId ? chunk.text : null;
  }
  const eventId = ctx.db.normalizeId("events", row.targetId);
  const event = eventId ? await ctx.db.get(eventId) : null;
  if (!event || event.spaceId !== spaceId) return null;
  const composed = await composeCardTargetInput(
    ctx,
    spaceId,
    event.sourceItemId,
    event,
  );
  return composed?.text ?? null;
}

/** The next page of targets the active fingerprint owes, with their inputs. */
export const nextEmbeddingFillPage = internalQuery({
  args: { spaceId: v.id("spaces"), limit: v.optional(v.number()) },
  returns: v.object({
    fingerprint: v.union(v.string(), v.null()),
    counted: v.boolean(),
    targets: v.array(fillTargetValidator),
  }),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("spaceEmbeddingStates")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .unique();
    if (!state || !usesTargetCounters(state)) {
      return { fingerprint: null, counted: false, targets: [] };
    }
    if (!state.activeFingerprint || !state.activeEmbeddingGenerationId) {
      return { fingerprint: null, counted: true, targets: [] };
    }
    const rows = await owedTargetsPage(
      ctx,
      args.spaceId,
      args.limit ?? MAX_FILL_VECTORS,
    );
    const targets = [];
    for (const row of rows) {
      const text = await liveTargetText(ctx, args.spaceId, row);
      // I7: a target whose live text has moved on since its eligibility write
      // is skipped rather than embedded against a stale hash. The write that
      // changed it refreshed the row, so the next page sees the new hash.
      if (text === null || (await sha256Hex(text)) !== row.inputHash) continue;
      targets.push({
        targetKind: row.targetKind,
        targetId: row.targetId,
        inputHash: row.inputHash,
        inputText: text,
      });
    }
    return { fingerprint: state.activeFingerprint, counted: true, targets };
  },
});

/** Inserts one page of vectors and schedules the successor, if any. */
export const commitEmbeddingFillPage = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    fingerprint: v.string(),
    vectors: v.array(
      v.object({
        targetKind: embeddingTargetRowKindValidator,
        targetId: v.string(),
        inputHash: v.string(),
        vector: v.array(v.float64()),
      }),
    ),
    autoRun: v.optional(v.boolean()),
  },
  returns: v.object({
    embedded: v.number(),
    skipped: v.number(),
    remaining: v.boolean(),
    scheduled: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (args.vectors.length > MAX_FILL_VECTORS) {
      throw new Error("Embedding fill page exceeds its vector budget");
    }
    const state = await ctx.db
      .query("spaceEmbeddingStates")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
      .unique();
    if (!state) throw new Error("Space embedding state not found");
    const generationId = state.activeEmbeddingGenerationId;
    if (state.activeFingerprint !== args.fingerprint || !generationId) {
      // The space activated a different profile while this page was in the
      // provider. Its vectors cover nothing; refusing them leaves the targets
      // owed, and the next pass re-embeds under the fingerprint now active.
      throw new Error("Embedding fill fingerprint is no longer active");
    }
    let embedded = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (const supplied of args.vectors) {
      const key = `${supplied.targetKind}:${supplied.targetId}`;
      if (seen.has(key)) {
        throw new Error("Embedding fill page contains a duplicate target");
      }
      seen.add(key);
      const row = await findEmbeddingTarget(
        ctx,
        args.spaceId,
        supplied.targetKind,
        supplied.targetId,
      );
      if (
        !row ||
        row.state !== "eligible" ||
        row.inputHash !== supplied.inputHash ||
        row.coveredFingerprint === args.fingerprint
      ) {
        // Retired, rewritten, or already covered by a replay of this page.
        skipped += 1;
        continue;
      }
      if (supplied.targetKind === "thought") {
        const thoughtId = ctx.db.normalizeId("thoughts", supplied.targetId);
        const thought = thoughtId ? await ctx.db.get(thoughtId) : null;
        if (!thought || (await sha256Hex(thought.content)) !== row.inputHash) {
          skipped += 1;
          continue;
        }
        await insertThoughtEmbedding(ctx, {
          spaceId: args.spaceId,
          thoughtId: thought._id,
          embeddingGenerationId: generationId,
          fingerprint: args.fingerprint,
          inputText: thought.content,
          vector: supplied.vector,
          bumpEligibility: false,
        });
      } else if (supplied.targetKind === "chunk") {
        const chunkId = ctx.db.normalizeId("chunks", supplied.targetId);
        const chunk = chunkId ? await ctx.db.get(chunkId) : null;
        if (!chunk || (await sha256Hex(chunk.text)) !== row.inputHash) {
          skipped += 1;
          continue;
        }
        await insertChunkEmbedding(ctx, {
          spaceId: args.spaceId,
          chunkId: chunk._id,
          embeddingGenerationId: generationId,
          fingerprint: args.fingerprint,
          inputText: chunk.text,
          vector: supplied.vector,
          bumpEligibility: false,
        });
      } else {
        const eventId = ctx.db.normalizeId("events", supplied.targetId);
        const event = eventId ? await ctx.db.get(eventId) : null;
        const composed = event
          ? await composeCardTargetInput(
              ctx,
              args.spaceId,
              event.sourceItemId,
              event,
            )
          : null;
        if (!composed || (await sha256Hex(composed.text)) !== row.inputHash) {
          skipped += 1;
          continue;
        }
        await insertCardEmbedding(ctx, {
          spaceId: args.spaceId,
          eventId: event!._id,
          embeddingGenerationId: generationId,
          fingerprint: args.fingerprint,
          inputText: composed.text,
          vector: supplied.vector,
          bumpEligibility: false,
        });
      }
      embedded += 1;
    }
    const remaining = (await owedTargetsPage(ctx, args.spaceId, 1)).length > 0;
    const scheduled = Boolean(args.autoRun && remaining && embedded > 0);
    if (scheduled) {
      await ctx.scheduler.runAfter(
        0,
        internal.models.embeddings.fill.runEmbeddingFill,
        { spaceId: args.spaceId, autoRun: true },
      );
    }
    return { embedded, skipped, remaining, scheduled };
  },
});

/**
 * Embeds one page through the existing provider action. A page is at most 32
 * inputs and one commit, so no invocation approaches the action time limit and
 * a crash loses at most one page of provider work.
 */
export const runEmbeddingFill = internalAction({
  args: {
    spaceId: v.id("spaces"),
    limit: v.optional(v.number()),
    autoRun: v.optional(v.boolean()),
  },
  returns: v.object({
    requested: v.number(),
    embedded: v.number(),
    skipped: v.number(),
    remaining: v.boolean(),
    scheduled: v.boolean(),
  }),
  handler: async (ctx, args): Promise<EmbeddingFillResult> => {
    const page: {
      fingerprint: string | null;
      counted: boolean;
      targets: {
        targetKind: "thought" | "chunk" | "card";
        targetId: string;
        inputHash: string;
        inputText: string;
      }[];
    } = await ctx.runQuery(
      internal.models.embeddings.fill.nextEmbeddingFillPage,
      { spaceId: args.spaceId, limit: args.limit },
    );
    if (!page.fingerprint || page.targets.length === 0) {
      return {
        requested: 0,
        embedded: 0,
        skipped: 0,
        remaining: false,
        scheduled: false,
      };
    }
    const vectors = [];
    for (const target of page.targets) {
      const result: { vector: number[]; fingerprint: string } =
        await ctx.runAction(
          internal.models.thoughts.helpers.generateEmbeddingWithMetadata,
          { text: target.inputText },
        );
      if (result.fingerprint !== page.fingerprint) {
        throw new Error(
          "Embedding fill provider profile does not match the active fingerprint",
        );
      }
      vectors.push({
        targetKind: target.targetKind,
        targetId: target.targetId,
        inputHash: target.inputHash,
        vector: result.vector,
      });
    }
    const committed: {
      embedded: number;
      skipped: number;
      remaining: boolean;
      scheduled: boolean;
    } = await ctx.runMutation(
      internal.models.embeddings.fill.commitEmbeddingFillPage,
      {
        spaceId: args.spaceId,
        fingerprint: page.fingerprint,
        vectors,
        autoRun: args.autoRun,
      },
    );
    return { requested: vectors.length, ...committed };
  },
});
