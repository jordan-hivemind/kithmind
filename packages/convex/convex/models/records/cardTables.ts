import { defineTable } from "convex/server";
import { v } from "convex/values";

import { recordEventTypeValidator } from "./validators";

/**
 * Section 7 of docs/plans/2026-09-12-document-cards.md names two review item
 * kinds for a card that did not fully publish. Both are recorded in this one
 * table because both are the same fact, a field the gate refused, and only
 * the tier tells them apart.
 */
export const cardFieldDropKindValidator = v.union(
  /** An optional field failed the gate. The rest of the card published. */
  v.literal("field_dropped"),
  /** A required field failed at the top automatic step. Nothing published. */
  v.literal("card_gate_failed"),
);

/**
 * Section 4.3 and section 7. Nothing is silently dropped: a card field whose
 * evidence does not resolve, or whose span does not reproduce the proposed
 * value, is not stored, and this row is what the review surface of P2-70k
 * counts. It carries the field name, the review kind and the closed gate
 * failure code, never the field value: an unproved value is exactly what must
 * not be retained.
 */
export const cardFieldDropFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  processingGenerationId: v.id("processingGenerations"),
  recordKind: recordEventTypeValidator,
  kind: cardFieldDropKindValidator,
  fieldKey: v.string(),
  /** One `CardGateFailureCode`, or the evidence reason before the gate. */
  code: v.string(),
  reason: v.string(),
  createdAt: v.number(),
};

/**
 * Section 5.4: one row per gate run, per document and tier. It records how
 * many fields passed, dropped and failed and under which closed codes, and
 * no value and no field text, so cost and ladder reporting never becomes a
 * second copy of the owner's documents. P2-70e adds the token counts, the
 * measured cost and the timings of the runner that produced the candidate.
 */
export const cardExtractionAttemptFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  recordKind: recordEventTypeValidator,
  step: v.union(v.literal("local"), v.literal("tier0"), v.literal("tier1")),
  gateVersion: v.string(),
  promptVersion: v.string(),
  playbookVersion: v.string(),
  cardSchemaVersion: v.number(),
  outcome: v.union(
    v.literal("accepted"),
    v.literal("escalated"),
    v.literal("review"),
    /**
     * Section 5.1: a ladder step that was not configured. It is recorded so
     * the row exists and so a skipped step can never be read as a passed one.
     */
    v.literal("skipped"),
  ),
  passedFieldCount: v.number(),
  droppedFieldCount: v.number(),
  failedFieldCount: v.number(),
  /** The distinct closed codes raised, sorted. Counts, never values. */
  failureCodes: v.array(v.string()),
  /**
   * P2-70e metering. Optional only because rows written by P2-70c and P2-70d
   * predate the runner; every row the ladder writes carries all of them.
   * Counts and a price, never a value and never any document text.
   */
  modelId: v.optional(v.string()),
  priceTableVersion: v.optional(v.string()),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  /**
   * Integer micro-USD from the declared price table. Money never crosses a
   * JavaScript float in this repository, and an integer never rounds.
   */
  costMicroUsd: v.optional(v.number()),
  wallTimeMs: v.optional(v.number()),
  createdAt: v.number(),
};

export const cardTables = {
  cardFieldDrops: defineTable(cardFieldDropFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_processingGenerationId", ["processingGenerationId"])
    // P2-70k: the review queue counts and pages dropped fields and gate
    // failures for one source account. Neither existing index scopes to an
    // account, so a review would otherwise have to filter a space-wide,
    // bounded scan in application code and risk another account's rows
    // crowding a smaller account out of the bound.
    .index("by_space_account", ["spaceId", "sourceAccountId"]),
  cardExtractionAttempts: defineTable(cardExtractionAttemptFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceItemId", ["sourceItemId"]),
};
