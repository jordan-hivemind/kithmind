import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";

import { cardEventKey, isCardRecordKind, type CardRecordKind } from "./cardSchemas";

/**
 * P2-70f, section 6 of docs/plans/2026-09-12-document-cards.md: a per-space,
 * per-kind extraction queue over admitted documents (`sourceItems`) that have
 * retained text and no accepted card of the requested kind, oldest admission
 * first (Convex orders an index by `_creationTime` after its declared
 * fields, so `sourceItems.by_spaceId` already returns admission order).
 *
 * The queue processes one document per tick. `claimNextForExtraction` is the
 * only place that decides what happens next; `recordExtractionOutcome` is the
 * only place that advances the cursor and the budget counters. Both are
 * plain mutations so a crash between them leaves the cursor exactly where it
 * was, and the next claim re-checks whether the same document already has an
 * accepted card or a review item before ever calling the ladder again.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export const DEFAULT_DAILY_DOCUMENT_BUDGET = 10;
export const DEFAULT_WEEKLY_DOCUMENT_BUDGET = 50;
/** Section 6 of the plan states the weekly cap as 50 USD. */
export const DEFAULT_WEEKLY_COST_BUDGET_MICRO_USD = 50_000_000;

/** Inventory reasons that keep a document out of the queue. Section 2.3;
 * `extraction_pending` is deliberately excluded, since it is the state of a
 * document still waiting for a card, not one excluded from getting one. */
const FORBIDDING_EXCLUSION_REASONS = new Set([
  "empty",
  "enumeration_interrupted",
  "oversized",
  "permission_denied",
  "unreadable",
  "unstable",
  "unsupported",
  "encrypted",
  "duplicate_of",
  "parse_failed",
]);

function dayWindowStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/** Monday 00:00 UTC of the week containing `now`. Epoch day 0 (1970-01-01) was a Thursday. */
function weekWindowStart(now: number): number {
  const day = dayWindowStart(now);
  const weekday = Math.floor(day / DAY_MS) % 7; // 0 = Thursday
  const daysSinceMonday = (weekday + 3) % 7;
  return day - daysSinceMonday * DAY_MS;
}

async function requireQueueState(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  kind: CardRecordKind,
): Promise<Doc<"cardExtractionQueueStates">> {
  const rows = await ctx.db
    .query("cardExtractionQueueStates")
    .withIndex("by_space_and_kind", (q) =>
      q.eq("spaceId", spaceId).eq("kind", kind),
    )
    .take(2);
  if (rows.length > 1) {
    throw new Error("Card extraction queue state is not unique");
  }
  const state = rows[0];
  if (!state) {
    throw new Error(
      "Card extraction queue was not started for this space and kind",
    );
  }
  return state;
}

/**
 * Resets a counter window that has rolled over and clears a budget pause that
 * window carried, so a paused queue resumes on its own once the calendar
 * catches up. A `manual` pause is untouched: only `resumeExtractionQueue`
 * lifts it.
 */
function rollWindows(
  state: Doc<"cardExtractionQueueStates">,
  now: number,
): Partial<Doc<"cardExtractionQueueStates">> {
  const day = dayWindowStart(now);
  const week = weekWindowStart(now);
  const dayRolled = day !== state.dayWindowStart;
  const weekRolled = week !== state.weekWindowStart;
  if (!dayRolled && !weekRolled) return {};
  const patch: Partial<Doc<"cardExtractionQueueStates">> = {};
  if (dayRolled) {
    patch.dayWindowStart = day;
    patch.documentsProcessedToday = 0;
  }
  if (weekRolled) {
    patch.weekWindowStart = week;
    patch.documentsProcessedThisWeek = 0;
    patch.costMicroUsdThisWeek = 0;
  }
  const pausedByRolledWindow =
    state.phase === "paused" &&
    ((state.pauseReason === "daily_document_budget" && dayRolled) ||
      (state.pauseReason === "weekly_document_budget" && weekRolled) ||
      (state.pauseReason === "weekly_cost_budget" && weekRolled));
  if (pausedByRolledWindow) {
    patch.phase = "running";
    patch.pauseReason = undefined;
    patch.resumeAt = undefined;
  }
  return patch;
}

async function hasRetainedText(
  ctx: QueryCtx,
  item: Doc<"sourceItems">,
): Promise<boolean> {
  if (item.lifecycle !== "available" || !item.activeGenerationId) return false;
  const generation = await ctx.db.get(item.activeGenerationId);
  return Boolean(
    generation &&
      generation.state === "ready" &&
      generation.deactivatedAt === undefined &&
      generation.sourceTextVersionId,
  );
}

async function forbidsExtraction(
  ctx: QueryCtx,
  sourceItemId: Id<"sourceItems">,
): Promise<boolean> {
  const rows = await ctx.db
    .query("sourceInventory")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItemId))
    .take(8);
  return rows.some(
    (row) =>
      row.exclusionReason !== undefined &&
      FORBIDDING_EXCLUSION_REASONS.has(row.exclusionReason),
  );
}

async function hasAcceptedCard(
  ctx: QueryCtx,
  sourceItemId: Id<"sourceItems">,
  kind: CardRecordKind,
): Promise<boolean> {
  const event = await ctx.db
    .query("events")
    .withIndex("by_sourceItemId_and_eventKey", (q) =>
      q.eq("sourceItemId", sourceItemId).eq("eventKey", cardEventKey(kind)),
    )
    .unique();
  return event !== null;
}

async function hasReviewItem(
  ctx: QueryCtx,
  sourceItemId: Id<"sourceItems">,
  kind: CardRecordKind,
): Promise<boolean> {
  const drops = await ctx.db
    .query("cardFieldDrops")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItemId))
    .collect();
  return drops.some(
    (drop) => drop.kind === "card_gate_failed" && drop.recordKind === kind,
  );
}

export type QueueClaimResult =
  | {
      status: "paused";
      reason: Exclude<
        Doc<"cardExtractionQueueStates">["pauseReason"],
        undefined
      >;
      resumeAt: number | undefined;
    }
  | { status: "idle" }
  | { status: "advanced" }
  | {
      status: "claimed";
      sourceItemId: Id<"sourceItems">;
      itemCreationTime: number;
    };

/**
 * Runs at most one step: either it pauses (a budget was reached, or an
 * operator paused it), resolves exactly one non-actionable document and
 * advances the cursor past it, finds the queue drained, or claims exactly
 * one actionable document without moving the cursor yet. Never exceeds a
 * budget by more than one document, because the check runs before every
 * single document, one at a time.
 */
export async function claimNextForExtraction(
  ctx: MutationCtx,
  input: { spaceId: Id<"spaces">; kind: CardRecordKind; now: number },
): Promise<QueueClaimResult> {
  const state = await requireQueueState(ctx, input.spaceId, input.kind);
  const rolled = rollWindows(state, input.now);
  if (Object.keys(rolled).length > 0) {
    await ctx.db.patch(state._id, { ...rolled, updatedAt: input.now });
  }
  const effective = { ...state, ...rolled };

  if (effective.phase === "paused") {
    return {
      status: "paused",
      reason: effective.pauseReason!,
      resumeAt: effective.resumeAt,
    };
  }
  if (effective.phase === "idle") {
    return { status: "idle" };
  }

  const pause = async (
    reason: "daily_document_budget" | "weekly_document_budget" | "weekly_cost_budget",
    resumeAt: number,
  ): Promise<QueueClaimResult> => {
    await ctx.db.patch(state._id, {
      phase: "paused",
      pauseReason: reason,
      resumeAt,
      updatedAt: input.now,
    });
    return { status: "paused", reason, resumeAt };
  };

  if (effective.documentsProcessedToday >= effective.dailyDocumentBudget) {
    return await pause(
      "daily_document_budget",
      dayWindowStart(input.now) + DAY_MS,
    );
  }
  if (effective.documentsProcessedThisWeek >= effective.weeklyDocumentBudget) {
    return await pause(
      "weekly_document_budget",
      weekWindowStart(input.now) + WEEK_MS,
    );
  }
  if (effective.costMicroUsdThisWeek >= effective.weeklyCostBudgetMicroUsd) {
    return await pause(
      "weekly_cost_budget",
      weekWindowStart(input.now) + WEEK_MS,
    );
  }

  const next = await ctx.db
    .query("sourceItems")
    .withIndex("by_spaceId", (q) =>
      effective.cursor === null
        ? q.eq("spaceId", input.spaceId)
        : q.eq("spaceId", input.spaceId).gt("_creationTime", effective.cursor),
    )
    .order("asc")
    .take(1);
  const item = next[0];
  if (!item) {
    await ctx.db.patch(state._id, { phase: "idle", updatedAt: input.now });
    return { status: "idle" };
  }

  const resolveAndAdvance = async (skipped: boolean) => {
    await ctx.db.patch(state._id, {
      cursor: item._creationTime,
      updatedAt: input.now,
      ...(skipped ? { skippedCount: effective.skippedCount + 1 } : {}),
    });
    return { status: "advanced" as const };
  };

  if (!(await hasRetainedText(ctx, item))) {
    return await resolveAndAdvance(false);
  }
  if (await forbidsExtraction(ctx, item._id)) {
    return await resolveAndAdvance(true);
  }
  if (await hasAcceptedCard(ctx, item._id, input.kind)) {
    return await resolveAndAdvance(false);
  }
  if (await hasReviewItem(ctx, item._id, input.kind)) {
    return await resolveAndAdvance(false);
  }

  return {
    status: "claimed",
    sourceItemId: item._id,
    itemCreationTime: item._creationTime,
  };
}

/**
 * Records what the ladder did for one claimed document: sums the cost of the
 * attempt rows it wrote (the only source of cost, per section 5.4), updates
 * the budget counters and the lifetime counts, and advances the cursor past
 * it. This is the only place a document becomes resolved after a claim, so a
 * kill before this runs leaves it unresolved and it is reconsidered, safely,
 * on the next claim.
 */
export async function recordExtractionOutcome(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    kind: CardRecordKind;
    sourceItemId: Id<"sourceItems">;
    itemCreationTime: number;
    outcome: "accepted" | "review" | "refused";
    now: number;
  },
): Promise<{ phase: Doc<"cardExtractionQueueStates">["phase"] }> {
  const state = await requireQueueState(ctx, input.spaceId, input.kind);
  const attempts = await ctx.db
    .query("cardExtractionAttempts")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", input.sourceItemId))
    .collect();
  const costMicroUsd = attempts
    .filter(
      (attempt) =>
        attempt.recordKind === input.kind && attempt.createdAt === input.now,
    )
    .reduce((total, attempt) => total + (attempt.costMicroUsd ?? 0), 0);

  await ctx.db.patch(state._id, {
    cursor: input.itemCreationTime,
    documentsProcessedToday: state.documentsProcessedToday + 1,
    documentsProcessedThisWeek: state.documentsProcessedThisWeek + 1,
    costMicroUsdThisWeek: state.costMicroUsdThisWeek + costMicroUsd,
    ...(input.outcome === "accepted"
      ? { extractedCount: state.extractedCount + 1 }
      : input.outcome === "review"
        ? { gateFailedCount: state.gateFailedCount + 1 }
        : { skippedCount: state.skippedCount + 1 }),
    updatedAt: input.now,
  });
  return { phase: state.phase };
}

// --- the plain, injectable tick, mirroring cardLadder's `CardLadderOps` ---

export type QueueTickOps = {
  claim: () => Promise<QueueClaimResult>;
  runLadder: (
    sourceItemId: Id<"sourceItems">,
  ) => Promise<{ outcome: "accepted" | "review" | "refused" }>;
  recordOutcome: (input: {
    sourceItemId: Id<"sourceItems">;
    itemCreationTime: number;
    outcome: "accepted" | "review" | "refused";
  }) => Promise<{ phase: Doc<"cardExtractionQueueStates">["phase"] }>;
};

export type QueueTickResult = {
  status: QueueClaimResult["status"];
  /** Whether a production caller should schedule another tick. */
  continue: boolean;
};

export async function runCardExtractionQueueTick(
  ops: QueueTickOps,
): Promise<QueueTickResult> {
  const claim = await ops.claim();
  if (claim.status === "paused" || claim.status === "idle") {
    return { status: claim.status, continue: false };
  }
  if (claim.status === "advanced") {
    return { status: "advanced", continue: true };
  }
  const ladder = await ops.runLadder(claim.sourceItemId);
  const recorded = await ops.recordOutcome({
    sourceItemId: claim.sourceItemId,
    itemCreationTime: claim.itemCreationTime,
    outcome: ladder.outcome,
  });
  return { status: "claimed", continue: recorded.phase === "running" };
}

// --- operator entry points -------------------------------------------------

const kindArg = v.string();

function requireKind(kind: string): CardRecordKind {
  if (!isCardRecordKind(kind)) throw new Error("Unsupported card record kind");
  return kind;
}

/**
 * `npx convex run models/records/cardQueue:startExtractionQueue`. Reuses an
 * existing queue for this space and kind (a restart is a no-op), otherwise
 * creates one at the plan's default budgets. `dryRun` writes nothing and
 * returns counts only: how many admitted documents currently qualify.
 */
export const startExtractionQueue = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    kind: kindArg,
    dailyDocumentBudget: v.optional(v.number()),
    weeklyDocumentBudget: v.optional(v.number()),
    weeklyCostBudgetMicroUsd: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    autoRun: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const kind = requireKind(args.kind);
    const now = args.now ?? Date.now();
    if (args.dryRun) {
      return await estimateQueueCounts(ctx, { spaceId: args.spaceId, kind });
    }
    const existing = await ctx.db
      .query("cardExtractionQueueStates")
      .withIndex("by_space_and_kind", (q) =>
        q.eq("spaceId", args.spaceId).eq("kind", kind),
      )
      .take(2);
    if (existing.length > 1) {
      throw new Error("Card extraction queue state is not unique");
    }
    let stateId: Id<"cardExtractionQueueStates">;
    let reused: boolean;
    if (existing[0]) {
      stateId = existing[0]._id;
      reused = true;
    } else {
      reused = false;
      stateId = await ctx.db.insert("cardExtractionQueueStates", {
        spaceId: args.spaceId,
        kind,
        phase: "running",
        cursor: null,
        dailyDocumentBudget:
          args.dailyDocumentBudget ?? DEFAULT_DAILY_DOCUMENT_BUDGET,
        weeklyDocumentBudget:
          args.weeklyDocumentBudget ?? DEFAULT_WEEKLY_DOCUMENT_BUDGET,
        weeklyCostBudgetMicroUsd:
          args.weeklyCostBudgetMicroUsd ?? DEFAULT_WEEKLY_COST_BUDGET_MICRO_USD,
        dayWindowStart: dayWindowStart(now),
        weekWindowStart: weekWindowStart(now),
        documentsProcessedToday: 0,
        documentsProcessedThisWeek: 0,
        costMicroUsdThisWeek: 0,
        extractedCount: 0,
        gateFailedCount: 0,
        skippedCount: 0,
        startedAt: now,
        updatedAt: now,
      });
    }
    if (args.autoRun) {
      await ctx.scheduler.runAfter(
        0,
        internal.models.records.cardQueue.runExtractionQueueTick,
        { spaceId: args.spaceId, kind, autoRun: true },
      );
    }
    return { reused, queueId: stateId };
  },
});

/** `npx convex run models/records/cardQueue:pauseExtractionQueue`. Manual, operator-only; only `resumeExtractionQueue` lifts it. */
export const pauseExtractionQueue = internalMutation({
  args: { spaceId: v.id("spaces"), kind: kindArg, now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const kind = requireKind(args.kind);
    const state = await requireQueueState(ctx, args.spaceId, kind);
    await ctx.db.patch(state._id, {
      phase: "paused",
      pauseReason: "manual",
      resumeAt: undefined,
      updatedAt: args.now ?? Date.now(),
    });
    return null;
  },
});

/** `npx convex run models/records/cardQueue:resumeExtractionQueue`. Lifts any pause, manual or budget, and optionally resumes ticking. */
export const resumeExtractionQueue = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    kind: kindArg,
    autoRun: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const kind = requireKind(args.kind);
    const state = await requireQueueState(ctx, args.spaceId, kind);
    const now = args.now ?? Date.now();
    await ctx.db.patch(state._id, {
      phase: "running",
      pauseReason: undefined,
      resumeAt: undefined,
      updatedAt: now,
    });
    if (args.autoRun) {
      await ctx.scheduler.runAfter(
        0,
        internal.models.records.cardQueue.runExtractionQueueTick,
        { spaceId: args.spaceId, kind, autoRun: true },
      );
    }
    return null;
  },
});

async function estimateQueueCounts(
  ctx: QueryCtx,
  input: { spaceId: Id<"spaces">; kind: CardRecordKind },
): Promise<{ queued: number; queuedIsLowerBound: boolean }> {
  const SCAN_CAP = 256;
  const items = await ctx.db
    .query("sourceItems")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", input.spaceId))
    .order("asc")
    .take(SCAN_CAP + 1);
  let queued = 0;
  for (const item of items.slice(0, SCAN_CAP)) {
    if (!(await hasRetainedText(ctx, item))) continue;
    if (await forbidsExtraction(ctx, item._id)) continue;
    if (await hasAcceptedCard(ctx, item._id, input.kind)) continue;
    if (await hasReviewItem(ctx, item._id, input.kind)) continue;
    queued += 1;
  }
  return { queued, queuedIsLowerBound: items.length > SCAN_CAP };
}

/**
 * `npx convex run models/records/cardQueue:cardExtractionQueueStatus`.
 * Counts only: no document text or value is read or returned here.
 */
export const cardExtractionQueueStatus = internalQuery({
  args: { spaceId: v.id("spaces"), kind: kindArg },
  handler: async (ctx, args) => {
    const kind = requireKind(args.kind);
    const rows = await ctx.db
      .query("cardExtractionQueueStates")
      .withIndex("by_space_and_kind", (q) =>
        q.eq("spaceId", args.spaceId).eq("kind", kind),
      )
      .take(2);
    if (rows.length > 1) {
      throw new Error("Card extraction queue state is not unique");
    }
    const state = rows[0];
    if (!state) {
      return { started: false as const };
    }
    const estimate = await estimateQueueCounts(ctx, {
      spaceId: args.spaceId,
      kind,
    });
    return {
      started: true as const,
      phase: state.phase,
      queued: estimate.queued,
      queuedIsLowerBound: estimate.queuedIsLowerBound,
      extracted: state.extractedCount,
      gateFailed: state.gateFailedCount,
      skipped: state.skippedCount,
      documentsProcessedToday: state.documentsProcessedToday,
      dailyDocumentBudget: state.dailyDocumentBudget,
      documentsProcessedThisWeek: state.documentsProcessedThisWeek,
      weeklyDocumentBudget: state.weeklyDocumentBudget,
      costMicroUsdThisWeek: state.costMicroUsdThisWeek,
      weeklyCostBudgetMicroUsd: state.weeklyCostBudgetMicroUsd,
      pauseReason: state.pauseReason,
      resumeAt: state.resumeAt,
    };
  },
});

/**
 * `npx convex run models/records/cardQueue:runExtractionQueueTick`. The
 * production tick: claims through a mutation, runs the real ladder entry
 * point (`extractCard`, which selects the local and hosted runners from the
 * environment) through an action, records the outcome through a mutation,
 * and schedules at most one successor. Never called by a test; tests drive
 * `runCardExtractionQueueTick` directly with a fixture ladder.
 */
export const runExtractionQueueTick = internalAction({
  args: {
    spaceId: v.id("spaces"),
    kind: kindArg,
    autoRun: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    status: v.union(
      v.literal("paused"),
      v.literal("idle"),
      v.literal("advanced"),
      v.literal("claimed"),
    ),
    continue: v.boolean(),
  }),
  handler: async (ctx, args): Promise<QueueTickResult> => {
    const kind = requireKind(args.kind);
    const now = args.now ?? Date.now();
    const result = await runCardExtractionQueueTick({
      claim: () =>
        ctx.runMutation(internal.models.records.cardQueue.claimTick, {
          spaceId: args.spaceId,
          kind,
          now,
        }),
      runLadder: (sourceItemId) =>
        ctx.runAction(internal.models.records.cardLadder.extractCard, {
          sourceItemId,
          kind,
          now,
        }),
      recordOutcome: (input) =>
        ctx.runMutation(internal.models.records.cardQueue.recordTick, {
          spaceId: args.spaceId,
          kind,
          now,
          ...input,
        }),
    });
    if (args.autoRun && result.continue) {
      await ctx.scheduler.runAfter(
        0,
        internal.models.records.cardQueue.runExtractionQueueTick,
        { spaceId: args.spaceId, kind, autoRun: true },
      );
    }
    return result;
  },
});

/** Internal-only wrapper so the action above can reach the mutation through `ctx.runMutation`. */
export const claimTick = internalMutation({
  args: { spaceId: v.id("spaces"), kind: kindArg, now: v.number() },
  handler: async (ctx, args) =>
    await claimNextForExtraction(ctx, {
      spaceId: args.spaceId,
      kind: requireKind(args.kind),
      now: args.now,
    }),
});

/** Internal-only wrapper so the action above can reach the mutation through `ctx.runMutation`. */
export const recordTick = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    kind: kindArg,
    sourceItemId: v.id("sourceItems"),
    itemCreationTime: v.number(),
    outcome: v.union(
      v.literal("accepted"),
      v.literal("review"),
      v.literal("refused"),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) =>
    await recordExtractionOutcome(ctx, {
      spaceId: args.spaceId,
      kind: requireKind(args.kind),
      sourceItemId: args.sourceItemId,
      itemCreationTime: args.itemCreationTime,
      outcome: args.outcome,
      now: args.now,
    }),
});
