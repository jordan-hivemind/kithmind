import { v, type Infer } from "convex/values";

import { CARD_RECORD_KINDS } from "./cardSchemas";
import {
  observationValueValidator,
  occurrenceValidator,
} from "./valueValidators";

/**
 * Version 1 kinds, plus the six document-card kinds of section 4.2 of
 * docs/plans/2026-09-12-document-cards.md. Cards are records: a card kind is
 * an event kind and a card field is an observation type, so nothing new is
 * stored for them.
 */
export const recordEventTypeValidator = v.union(
  v.literal("lab_panel"),
  v.literal("vehicle_service"),
  v.literal("financial_transaction"),
  v.literal("document_card"),
  v.literal("safe_note_card"),
  v.literal("tax_return_card"),
  v.literal("k1_card"),
  v.literal("brokerage_tax_package_card"),
  v.literal("spreadsheet_card"),
);

export type RecordEventType = Infer<typeof recordEventTypeValidator>;

const RECORD_EVENT_TYPES = new Set<string>(
  recordEventTypeValidator.members.map((member) => member.value),
);

export function isRecordEventType(value: string): value is RecordEventType {
  return RECORD_EVENT_TYPES.has(value);
}

/** Compile-time proof that every card kind is also a record event kind. */
const _cardKindsAreRecordEventTypes: readonly RecordEventType[] =
  CARD_RECORD_KINDS;
void _cardKindsAreRecordEventTypes;

/**
 * Section 4.2 of docs/plans/2026-09-12-document-cards.md: card activation
 * patches `documents.docType` of the active text generation in place, so
 * document type filtering and the accepted card kind cannot disagree. The
 * previous value is recorded on the card version, which is what a rollback
 * restores from.
 */
export const cardDocTypePatchValidator = v.array(
  v.object({
    documentId: v.id("documents"),
    previousDocType: v.optional(v.string()),
    appliedDocType: v.string(),
  }),
);

export type CardDocTypePatch = Infer<typeof cardDocTypePatchValidator>;

export const recordFieldEvidenceValidator = v.object({
  occurrence: v.array(v.id("evidenceSpans")),
  entity: v.array(v.id("evidenceSpans")),
  eventType: v.array(v.id("evidenceSpans")),
});

export const stagedObservationValidator = v.object({
  observationKey: v.string(),
  observationType: v.string(),
  value: observationValueValidator,
  valueEvidence: v.array(v.id("evidenceSpans")),
});

export const stagedEventRecordValidator = v.object({
  eventKey: v.string(),
  entityId: v.id("entities"),
  eventType: recordEventTypeValidator,
  schemaVersion: v.number(),
  occurrence: occurrenceValidator,
  fieldEvidence: recordFieldEvidenceValidator,
  docTypePatch: v.optional(cardDocTypePatchValidator),
  observations: v.array(stagedObservationValidator),
});

export const stageRecordBatchInputValidator = v.object({
  spaceId: v.id("spaces"),
  processingGenerationId: v.id("processingGenerations"),
  userId: v.id("users"),
  records: v.array(stagedEventRecordValidator),
});

export type RecordFieldEvidence = Infer<typeof recordFieldEvidenceValidator>;
export type StagedObservation = Infer<typeof stagedObservationValidator>;
export type StagedEventRecord = Infer<typeof stagedEventRecordValidator>;
export type StageRecordBatchInput = Infer<
  typeof stageRecordBatchInputValidator
>;

export const eventFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  eventKey: v.string(),
  createdBy: v.id("users"),
};

export const eventVersionFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  sourceRevisionId: v.id("sourceRevisions"),
  sourceTextVersionId: v.id("sourceTextVersions"),
  processingGenerationId: v.id("processingGenerations"),
  eventId: v.id("events"),
  entityId: v.id("entities"),
  eventType: recordEventTypeValidator,
  schemaVersion: v.number(),
  occurrence: occurrenceValidator,
  occurrenceDate: v.optional(v.string()),
  occurrenceInstant: v.optional(v.number()),
  occurrenceSortKey: v.optional(v.string()),
  fieldEvidence: recordFieldEvidenceValidator,
  docTypePatch: v.optional(cardDocTypePatchValidator),
  userId: v.id("users"),
};

/**
 * P2-70k, section 7 of docs/plans/2026-09-12-document-cards.md. The review
 * queue counts and, when one is named, pages one class of review item.
 * `skipped_by_type` and `duplicate_group` are the inventory-backed classes;
 * `field_dropped` and `card_gate_failed` are the two `cardFieldDrops.kind`
 * values; `queue_status` is the P2-70f extraction queue state, which has no
 * per-file rows to page and always returns its full (small, one-per-kind)
 * summary. `entity_binding_needed` is P2-70l's own class: an accepted card
 * field whose literal name matched zero, or two or more, entities.
 */
export const reviewQueueClassValidator = v.union(
  v.literal("skipped_by_type"),
  v.literal("field_dropped"),
  v.literal("card_gate_failed"),
  v.literal("duplicate_group"),
  v.literal("entity_binding_needed"),
  v.literal("queue_status"),
);

export type ReviewQueueClass = Infer<typeof reviewQueueClassValidator>;

export const reviewQueueListArgs = {
  spaceIds: v.optional(v.array(v.id("spaces"))),
  sourceAccountId: v.id("sourceAccounts"),
  class: v.optional(reviewQueueClassValidator),
  cursor: v.optional(v.string()),
  limit: v.optional(v.number()),
};

export const observationFields = {
  spaceId: v.id("spaces"),
  sourceAccountId: v.id("sourceAccounts"),
  sourceItemId: v.id("sourceItems"),
  sourceRevisionId: v.id("sourceRevisions"),
  sourceTextVersionId: v.id("sourceTextVersions"),
  processingGenerationId: v.id("processingGenerations"),
  eventId: v.id("events"),
  eventVersionId: v.id("eventVersions"),
  entityId: v.id("entities"),
  eventType: recordEventTypeValidator,
  occurrence: occurrenceValidator,
  occurrenceDate: v.optional(v.string()),
  occurrenceInstant: v.optional(v.number()),
  occurrenceSortKey: v.optional(v.string()),
  observationKey: v.string(),
  observationType: v.string(),
  schemaVersion: v.number(),
  value: observationValueValidator,
  valueEvidence: v.array(v.id("evidenceSpans")),
  /**
   * Section 4.4, P2-70l. The entity this field's literal name resolved to.
   * It is stored beside `value` and `valueEvidence`, never in place of them:
   * the literal name and the span that proves it are the answer to "which
   * companies over a year", and a binding is an annotation on that answer,
   * not a replacement for it. Absent means unbound, which is the normal
   * state for a name no entity carries yet.
   */
  boundEntityId: v.optional(v.id("entities")),
  userId: v.id("users"),
};
