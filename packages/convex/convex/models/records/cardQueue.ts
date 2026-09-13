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

/**
 * After this many consecutive ticks raise instead of returning an outcome,
 * the queue pauses with `provider_error` rather than trying a fourth
 * document. Any tick that completes without raising resets the streak.
 */
const MAX_CONSECUTIVE_TICK_FAILURES = 3;

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
 *
 * `errorCode` is set only when the tick caught the ladder raising (see
 * `runCardExtractionQueueTick`): it drives `consecutiveFailures` and the
 * eventual `provider_error` pause, and is cleared (patched to `undefined`)
 * by the very next tick that resolves normally, raised or not, so a stale
 * error never lingers once the queue is healthy again. An ordinary `review`
 * outcome the ladder itself returned (no exception) never sets it, and so
 * never counts toward the failure streak: a normal gate rejection is not a
 * production defect.
 */
export async function recordExtractionOutcome(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    kind: CardRecordKind;
    sourceItemId: Id<"sourceItems">;
    itemCreationTime: number;
    outcome: "accepted" | "review" | "refused" | "provider_failed";
    errorCode?: string;
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

  const raised = input.errorCode !== undefined;
  const consecutiveFailures = raised ? (state.consecutiveFailures ?? 0) + 1 : 0;
  const pause = raised && consecutiveFailures >= MAX_CONSECUTIVE_TICK_FAILURES;

  await ctx.db.patch(state._id, {
    cursor: input.itemCreationTime,
    documentsProcessedToday: state.documentsProcessedToday + 1,
    documentsProcessedThisWeek: state.documentsProcessedThisWeek + 1,
    costMicroUsdThisWeek: state.costMicroUsdThisWeek + costMicroUsd,
    ...(input.outcome === "accepted"
      ? { extractedCount: state.extractedCount + 1 }
      : input.outcome === "review"
        ? { gateFailedCount: state.gateFailedCount + 1 }
        : input.outcome === "provider_failed"
          ? { providerFailedCount: (state.providerFailedCount ?? 0) + 1 }
          : { skippedCount: state.skippedCount + 1 }),
    consecutiveFailures,
    lastErrorCode: input.errorCode,
    ...(pause
      ? {
          phase: "paused" as const,
          pauseReason: "provider_error" as const,
          resumeAt: undefined,
        }
      : {}),
    updatedAt: input.now,
  });
  return { phase: pause ? "paused" : state.phase };
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
    outcome: "accepted" | "review" | "refused" | "provider_failed";
    errorCode?: string;
  }) => Promise<{ phase: Doc<"cardExtractionQueueStates">["phase"] }>;
};

export type QueueTickResult = {
  status: QueueClaimResult["status"];
  /** Whether a production caller should schedule another tick. */
  continue: boolean;
};

/**
 * Both the hosted providers' own errors (`cardExtractionProvider.ts` and
 * `openAICardExtractionProvider.ts`) start with this: a transport failure,
 * a non-2xx response, missing credentials or empty input. Anything else
 * that reaches this catch is an unexpected failure elsewhere in the ladder
 * (staging, gating, publishing), which is closer in kind to an ordinary
 * gate rejection than to a provider outage, so it is counted the same way
 * a `review` outcome is.
 */
const PROVIDER_ERROR_MESSAGE_PREFIX = "Card extraction";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classifies a raised ladder call into the bucket `recordExtractionOutcome`
 * counts it under and a small, fixed error code — never the raised error's
 * full message, which (for anything other than the two hosted providers'
 * own bounded errors) is not guaranteed to be free of document content.
 */
export function classifyQueueTickFailure(error: unknown): {
  outcome: "review" | "provider_failed";
  errorCode: string;
} {
  return errorMessage(error).startsWith(PROVIDER_ERROR_MESSAGE_PREFIX)
    ? { outcome: "provider_failed", errorCode: "provider_error" }
    : { outcome: "review", errorCode: "gate_error" };
}

/**
 * Runs at most one step. A step that claims a document always resolves it,
 * one way or another: the ladder's own outcome, or, if `runLadder` (a
 * runner or provider failure) or `recordOutcome` itself raises, a caught
 * failure recorded and counted instead. Never a caller left to discover an
 * uncaught rejection with the document still claimed and nothing scheduled
 * after it, which is what a raise here used to do.
 */
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
  try {
    const ladder = await ops.runLadder(claim.sourceItemId);
    const recorded = await ops.recordOutcome({
      sourceItemId: claim.sourceItemId,
      itemCreationTime: claim.itemCreationTime,
      outcome: ladder.outcome,
    });
    return { status: "claimed", continue: recorded.phase === "running" };
  } catch (error) {
    const failure = classifyQueueTickFailure(error);
    try {
      const recorded = await ops.recordOutcome({
        sourceItemId: claim.sourceItemId,
        itemCreationTime: claim.itemCreationTime,
        outcome: failure.outcome,
        errorCode: failure.errorCode,
      });
      return { status: "claimed", continue: recorded.phase === "running" };
    } catch {
      // Recording the failure itself failed (for example, a transient
      // database error). Stop rather than risk the same document being
      // claimed forever with no record of why: the same zombie state this
      // catch exists to prevent, one level down.
      return { status: "claimed", continue: false };
    }
  }
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
        providerFailedCount: 0,
        consecutiveFailures: 0,
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

/** Same bound `reviewQueue.ts` uses for its own `cardFieldDrops` scans:
 * neither table caps a source account's or a space's drop rows on its own. */
const MAX_RERUN_SCAN_ROWS = 256;

/**
 * `npx convex run models/records/cardQueue:rerunGateFailed`. Section 7: a
 * `card_gate_failed` drop is what `hasReviewItem` checks forever, so once one
 * exists for a document the queue's forward-only cursor never reconsiders it
 * even after the underlying problem (a prompt version, a gate fix) is
 * resolved. This deletes this kind's `card_gate_failed` drops for a space, or
 * for one source account within it, and rewinds the cursor so the next tick's
 * scan starts over and reoffers every document that was only being skipped
 * for those drops. Counts only: no field value or document text is read or
 * returned.
 */
export const rerunGateFailed = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    kind: kindArg,
    sourceAccountId: v.optional(v.id("sourceAccounts")),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const kind = requireKind(args.kind);
    const state = await requireQueueState(ctx, args.spaceId, kind);
    const sourceAccountId = args.sourceAccountId;
    const rows = sourceAccountId
      ? await ctx.db
          .query("cardFieldDrops")
          .withIndex("by_space_account", (q) =>
            q.eq("spaceId", args.spaceId).eq("sourceAccountId", sourceAccountId),
          )
          .take(MAX_RERUN_SCAN_ROWS + 1)
      : await ctx.db
          .query("cardFieldDrops")
          .withIndex("by_spaceId", (q) => q.eq("spaceId", args.spaceId))
          .take(MAX_RERUN_SCAN_ROWS + 1);
    const truncated = rows.length > MAX_RERUN_SCAN_ROWS;
    const matching = rows
      .slice(0, MAX_RERUN_SCAN_ROWS)
      .filter((row) => row.kind === "card_gate_failed" && row.recordKind === kind);
    for (const row of matching) {
      await ctx.db.delete(row._id);
    }
    if (matching.length > 0) {
      await ctx.db.patch(state._id, {
        cursor: null,
        // `claimNextForExtraction` returns "idle" on phase alone, before it
        // ever looks at the cursor: an idle queue reached the end of the
        // space's documents on its last scan, and rewinding the cursor with
        // no phase change would leave it declaring itself idle forever. A
        // paused queue is left exactly as paused; only
        // `resumeExtractionQueue` lifts a pause.
        ...(state.phase === "idle" ? { phase: "running" as const } : {}),
        updatedAt: args.now ?? Date.now(),
      });
    }
    return { clearedCount: matching.length, truncated };
  },
});

/** `npx convex run models/records/cardQueue:setExtractionQueueBudgets`. Sets one or more budgets on an existing queue, returning the three budgets after the patch. Does not change phase, cursor, counters, or windows: if paused on a budget, resumeExtractionQueue lifts the pause separately. */
export const setExtractionQueueBudgets = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    kind: kindArg,
    dailyDocumentBudget: v.optional(v.number()),
    weeklyDocumentBudget: v.optional(v.number()),
    weeklyCostBudgetMicroUsd: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const kind = requireKind(args.kind);
    const state = await requireQueueState(ctx, args.spaceId, kind);
    const now = args.now ?? Date.now();

    const budgets = [
      { name: "dailyDocumentBudget" as const, value: args.dailyDocumentBudget },
      { name: "weeklyDocumentBudget" as const, value: args.weeklyDocumentBudget },
      {
        name: "weeklyCostBudgetMicroUsd" as const,
        value: args.weeklyCostBudgetMicroUsd,
      },
    ];

    const patch: Partial<Doc<"cardExtractionQueueStates">> = {};
    for (const budget of budgets) {
      if (budget.value !== undefined) {
        if (
          !Number.isInteger(budget.value) ||
          budget.value <= 0
        ) {
          throw new Error(
            `${budget.name} must be a positive integer`,
          );
        }
        patch[budget.name] = budget.value;
      }
    }

    if (Object.keys(patch).length === 0) {
      // No budgets to update; return current state
      return {
        dailyDocumentBudget: state.dailyDocumentBudget,
        weeklyDocumentBudget: state.weeklyDocumentBudget,
        weeklyCostBudgetMicroUsd: state.weeklyCostBudgetMicroUsd,
      };
    }

    patch.updatedAt = now;
    await ctx.db.patch(state._id, patch);

    const updated = { ...state, ...patch };
    return {
      dailyDocumentBudget: updated.dailyDocumentBudget,
      weeklyDocumentBudget: updated.weeklyDocumentBudget,
      weeklyCostBudgetMicroUsd: updated.weeklyCostBudgetMicroUsd,
    };
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
      providerFailed: state.providerFailedCount ?? 0,
      consecutiveFailures: state.consecutiveFailures ?? 0,
      lastErrorCode: state.lastErrorCode,
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
      v.literal("provider_failed"),
    ),
    errorCode: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) =>
    await recordExtractionOutcome(ctx, {
      spaceId: args.spaceId,
      kind: requireKind(args.kind),
      sourceItemId: args.sourceItemId,
      itemCreationTime: args.itemCreationTime,
      outcome: args.outcome,
      errorCode: args.errorCode,
      now: args.now,
    }),
});
