import { defineTable } from "convex/server";
import { v } from "convex/values";

import { recordEventTypeValidator } from "./validators";

/**
 * P2-70f, section 6 of docs/plans/2026-09-12-document-cards.md: the
 * throttled per-space extraction queue. One row per `(spaceId, kind)`, so the
 * generic card and each later typed kind run as independent queues over the
 * same admitted documents.
 *
 * `running` scans for the next candidate and processes it; `paused` means a
 * budget was reached (`pauseReason` and `resumeAt` say which and when it
 * self-clears) or an operator called `pauseExtractionQueue`; `idle` means the
 * last scan reached the end of admitted documents with nothing left to do.
 */
export const cardExtractionQueuePhaseValidator = v.union(
  v.literal("running"),
  v.literal("paused"),
  v.literal("idle"),
);

/**
 * `manual` is an operator-initiated pause, only lifted by `resumeExtractionQueue`.
 * The three budget reasons self-clear the next time their window rolls over.
 * `provider_error` does not self-clear either: it means the ladder itself
 * threw (a runner or provider failure, not an ordinary gate rejection) on
 * `MAX_CONSECUTIVE_TICK_FAILURES` documents in a row, so a systemic problem
 * (a misconfigured request, an outage) does not silently burn through the
 * rest of the backlog marking every remaining document failed.
 */
export const cardExtractionQueuePauseReasonValidator = v.union(
  v.literal("manual"),
  v.literal("daily_document_budget"),
  v.literal("weekly_document_budget"),
  v.literal("weekly_cost_budget"),
  v.literal("provider_error"),
);

export const cardExtractionQueueStateFields = {
  spaceId: v.id("spaces"),
  /** The card kind this queue instance extracts. Generic first, per section 5.1. */
  kind: recordEventTypeValidator,
  phase: cardExtractionQueuePhaseValidator,
  /**
   * `_creationTime` of the last admitted document this queue fully resolved
   * (extracted, reviewed, skipped, or already settled), or `null` before the
   * first tick. Only items strictly after the cursor are unresolved. A
   * candidate is never counted resolved until its outcome is recorded, so a
   * kill between claiming it and recording the outcome leaves the cursor
   * exactly where it was and the same document is reconsidered on replay.
   */
  cursor: v.union(v.number(), v.null()),
  dailyDocumentBudget: v.number(),
  weeklyDocumentBudget: v.number(),
  weeklyCostBudgetMicroUsd: v.number(),
  /** Start (ms, UTC calendar day) of the window the daily counter belongs to. */
  dayWindowStart: v.number(),
  /** Start (ms, UTC Monday) of the window the weekly counters belong to. */
  weekWindowStart: v.number(),
  documentsProcessedToday: v.number(),
  documentsProcessedThisWeek: v.number(),
  costMicroUsdThisWeek: v.number(),
  /** Lifetime counts this queue instance produced. Counts only, never values. */
  extractedCount: v.number(),
  gateFailedCount: v.number(),
  skippedCount: v.number(),
  /**
   * A ladder run that raised instead of returning an outcome: the runner or
   * the provider it called failed outright (a non-2xx response, a timeout,
   * a malformed reply), as opposed to `gateFailedCount`, which also counts a
   * ladder run that returned normally but never produced a card. Optional
   * because rows written before this counter existed have neither it nor a
   * need for it: they predate a run that could ever raise this outcome.
   */
  providerFailedCount: v.optional(v.number()),
  /**
   * How many ticks in a row just raised, reset to 0 by any tick that
   * completes without raising. Drives the `provider_error` pause at
   * `MAX_CONSECUTIVE_TICK_FAILURES`. Optional for the same reason as
   * `providerFailedCount`.
   */
  consecutiveFailures: v.optional(v.number()),
  /** The most recent raised tick's sanitized error code, cleared (patched to
   * `undefined`) the next time a tick completes without raising. */
  lastErrorCode: v.optional(v.string()),
  pauseReason: v.optional(cardExtractionQueuePauseReasonValidator),
  resumeAt: v.optional(v.number()),
  startedAt: v.number(),
  updatedAt: v.number(),
};

export const cardQueueTables = {
  cardExtractionQueueStates: defineTable(cardExtractionQueueStateFields).index(
    "by_space_and_kind",
    ["spaceId", "kind"],
  ),
};
