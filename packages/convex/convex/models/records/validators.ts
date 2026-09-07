import { v, type Infer } from "convex/values";

import {
  observationValueValidator,
  occurrenceValidator,
} from "./valueValidators";

export const recordEventTypeValidator = v.union(
  v.literal("lab_panel"),
  v.literal("vehicle_service"),
  v.literal("financial_transaction"),
);

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
  observations: v.array(stagedObservationValidator),
});

export const stageRecordBatchInputValidator = v.object({
  spaceId: v.id("spaces"),
  processingGenerationId: v.id("processingGenerations"),
  userId: v.id("users"),
  records: v.array(stagedEventRecordValidator),
});

export type RecordEventType = Infer<typeof recordEventTypeValidator>;
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
  userId: v.id("users"),
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
  userId: v.id("users"),
};
