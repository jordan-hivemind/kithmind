import { v, type Infer } from "convex/values";

import { validateUnitCode as validateControlledUnitCode } from "./values";

const MAX_SOURCE_ACCOUNTS = 32;
const MAX_TYPE_LENGTH = 100;

export const queryConsistencyValidator = v.union(
  v.literal("snapshot"),
  v.literal("current"),
);

const queryScopeFields = {
  spaceId: v.id("spaces"),
  sourceAccountIds: v.optional(v.array(v.id("sourceAccounts"))),
  consistency: v.optional(queryConsistencyValidator),
};

const paginatedFields = {
  cursor: v.optional(v.id("recordQuerySessions")),
  limit: v.optional(v.number()),
};

export const latestObservationQueryValidator = v.object({
  operation: v.literal("latest_observation"),
  ...queryScopeFields,
  entityId: v.id("entities"),
  observationType: v.string(),
  asOf: v.optional(v.number()),
  unitCode: v.optional(v.string()),
});

export const observationHistoryQueryValidator = v.object({
  operation: v.literal("observation_history"),
  ...queryScopeFields,
  ...paginatedFields,
  entityId: v.id("entities"),
  observationType: v.string(),
  from: v.number(),
  to: v.number(),
  order: v.union(v.literal("asc"), v.literal("desc")),
  unitCode: v.optional(v.string()),
});

export const latestEventQueryValidator = v.object({
  operation: v.literal("latest_event"),
  ...queryScopeFields,
  entityId: v.id("entities"),
  eventType: v.string(),
  asOf: v.optional(v.number()),
});

export const listEventsQueryValidator = v.object({
  operation: v.literal("list_events"),
  ...queryScopeFields,
  ...paginatedFields,
  entityId: v.id("entities"),
  eventType: v.string(),
  from: v.number(),
  to: v.number(),
  order: v.union(v.literal("asc"), v.literal("desc")),
});

export const sumMoneyQueryValidator = v.object({
  operation: v.literal("sum_money"),
  ...queryScopeFields,
  cursor: v.optional(v.id("recordQuerySessions")),
  entityId: v.optional(v.id("entities")),
  sourceAccountId: v.optional(v.id("sourceAccounts")),
  lineItemType: v.string(),
  from: v.number(),
  to: v.number(),
});

export const recordQueryValidator = v.union(
  latestObservationQueryValidator,
  observationHistoryQueryValidator,
  latestEventQueryValidator,
  listEventsQueryValidator,
  sumMoneyQueryValidator,
);

export type QueryConsistency = "snapshot" | "current";

export type LatestObservationQuery = Infer<
  typeof latestObservationQueryValidator
>;
export type ObservationHistoryQuery = Infer<
  typeof observationHistoryQueryValidator
>;
export type LatestEventQuery = Infer<typeof latestEventQueryValidator>;
export type ListEventsQuery = Infer<typeof listEventsQueryValidator>;
export type SumMoneyQuery = Infer<typeof sumMoneyQueryValidator>;
export type RecordQuery = Infer<typeof recordQueryValidator>;

export function validateQueryType(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TYPE_LENGTH) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

export function validateOptionalUnitCode(value: string | undefined) {
  if (value === undefined) return undefined;
  return validateControlledUnitCode(value);
}

export function validateSourceAccountCount(values: readonly string[]) {
  if (values.length > MAX_SOURCE_ACCOUNTS) {
    throw new Error("Source account filter is too large");
  }
}
