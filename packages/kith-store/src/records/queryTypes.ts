import { validateUnitCode } from "./values.js";

export type QueryConsistency = "snapshot" | "current";
type QueryScope = {
  spaceId: string;
  sourceAccountIds?: string[];
  consistency?: QueryConsistency;
};
type Paginated = { cursor?: string; limit?: number };
export type LatestObservationQuery = QueryScope & {
  operation: "latest_observation";
  entityId: string;
  observationType: string;
  asOf?: number;
  unitCode?: string;
};
export type ObservationHistoryQuery = QueryScope &
  Paginated & {
    operation: "observation_history";
    entityId: string;
    observationType: string;
    from: number;
    to: number;
    order: "asc" | "desc";
    unitCode?: string;
  };
export type LatestEventQuery = QueryScope & {
  operation: "latest_event";
  entityId: string;
  eventType: string;
  asOf?: number;
};
export type ListEventsQuery = QueryScope &
  Paginated & {
    operation: "list_events";
    entityId: string;
    eventType: string;
    from: number;
    to: number;
    order: "asc" | "desc";
  };
export type SumMoneyQuery = QueryScope & {
  operation: "sum_money";
  cursor?: string;
  entityId?: string;
  sourceAccountId?: string;
  lineItemType: string;
  from: number;
  to: number;
};
export type RecordQuery =
  | LatestObservationQuery
  | ObservationHistoryQuery
  | LatestEventQuery
  | ListEventsQuery
  | SumMoneyQuery;

export function validateQueryType(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100)
    throw new Error(`${name} is invalid`);
  return normalized;
}
export function validateOptionalUnitCode(
  value: string | undefined,
): string | undefined {
  return value === undefined ? undefined : validateUnitCode(value);
}
export function validateSourceAccountCount(values: readonly string[]): void {
  if (values.length > 32) throw new Error("Source account filter is too large");
}
