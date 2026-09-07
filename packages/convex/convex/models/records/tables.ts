import { defineTable } from "convex/server";

import {
  eventFields,
  eventVersionFields,
  observationFields,
} from "./validators";

export const recordTables = {
  events: defineTable(eventFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_sourceItemId_and_eventKey", ["sourceItemId", "eventKey"]),
  eventVersions: defineTable(eventVersionFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_processingGenerationId", ["processingGenerationId"])
    .index("by_eventId", ["eventId"])
    .index("by_eventId_and_processingGenerationId", [
      "eventId",
      "processingGenerationId",
    ])
    .index("by_space_entity_type_date", [
      "spaceId",
      "entityId",
      "eventType",
      "occurrenceDate",
    ])
    .index("by_space_entity_type_sort", [
      "spaceId",
      "entityId",
      "eventType",
      "occurrenceSortKey",
    ])
    .index("by_space_entity_type_instant", [
      "spaceId",
      "entityId",
      "eventType",
      "occurrenceInstant",
    ])
    .index("by_space_entity_type_precision_date", [
      "spaceId",
      "entityId",
      "eventType",
      "occurrence.precision",
      "occurrenceDate",
    ]),
  observations: defineTable(observationFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccount_type_sort", [
      "sourceAccountId",
      "observationType",
      "occurrenceSortKey",
    ])
    .index("by_sourceAccount_type_precision", [
      "sourceAccountId",
      "observationType",
      "occurrence.precision",
    ])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_processingGenerationId", ["processingGenerationId"])
    .index("by_eventId", ["eventId"])
    .index("by_eventVersionId", ["eventVersionId"])
    .index("by_event_observation_generation", [
      "eventId",
      "observationKey",
      "processingGenerationId",
    ])
    .index("by_space_entity_type_date", [
      "spaceId",
      "entityId",
      "observationType",
      "occurrenceDate",
    ])
    .index("by_space_entity_type_sort", [
      "spaceId",
      "entityId",
      "observationType",
      "occurrenceSortKey",
    ])
    .index("by_space_entity_type_instant", [
      "spaceId",
      "entityId",
      "observationType",
      "occurrenceInstant",
    ])
    .index("by_space_entity_type_precision_date", [
      "spaceId",
      "entityId",
      "observationType",
      "occurrence.precision",
      "occurrenceDate",
    ]),
};
