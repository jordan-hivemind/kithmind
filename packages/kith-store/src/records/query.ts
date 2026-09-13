import type { ClientBase } from "pg";

import { assertKithId } from "../ids.js";
import {
  principalRef,
  reloadPrincipal,
  requireSpaceAccess,
  type Principal,
  type PrincipalRef,
  type SpaceMember,
} from "../identity/index.js";
import { calculateCoverage, type QueryCoverage } from "../coverage/index.js";
import {
  createRecordHydrationCache,
  hydrateEventVersion,
  hydrateObservation,
  type HydratedEventVersion,
  type HydratedObservation,
  type RecordEventType,
  type RecordHydrationCache,
} from "./model.js";
import {
  addDecimals,
  canonicalizeDecimal,
  MAX_DATETIME_OFFSET_MINUTES,
  selectLatestOccurrences,
  validateCurrencyCode,
  type ObservationValue,
  type Occurrence,
} from "./values.js";
import {
  advanceRecordQuerySession,
  consumeRecordQuerySession,
  createRecordQuerySession,
  resolveRecordQueryContext,
  type AuthorizedRecordQueryBinding,
  type CurrencyTotal,
  type RecordQueryCursorTuple,
} from "./querySessions.js";
import {
  validateOptionalUnitCode,
  validateQueryType,
  validateSourceAccountCount,
  type LatestEventQuery,
  type LatestObservationQuery,
  type ListEventsQuery,
  type ObservationHistoryQuery,
  type QueryConsistency,
  type RecordQuery,
  type SumMoneyQuery,
} from "./queryTypes.js";

const MAX_SOURCE_ACCOUNTS = 32,
  MAX_QUERY_SCAN_ROWS = 256,
  MAX_AGGREGATION_PAGE_ROWS = 25;
const MAX_UNDATED_SCAN_ROWS = 256,
  MAX_QUERY_RESULTS = 25,
  DEFAULT_QUERY_RESULTS = 20;
const MAX_RESULT_BYTES = 96 * 1024,
  MAX_NORMALIZED_FILTER_BYTES = 4096;
const MAX_HYDRATION_READ_BYTES = 2 * 1024 * 1024,
  MAX_HYDRATION_EVIDENCE_BYTES = 256 * 1024;
const MAX_DATE_OFFSET_MS = MAX_DATETIME_OFFSET_MINUTES * 60 * 1000;
const MIN_QUERY_TIME = -62_167_219_200_000,
  MAX_QUERY_TIME = 253_402_300_799_999;
const EVENT_TYPES = new Set([
  "lab_panel",
  "vehicle_service",
  "financial_transaction",
  "document_card",
  "safe_note_card",
  "tax_return_card",
  "k1_card",
  "brokerage_tax_package_card",
  "spreadsheet_card",
]);

type QueryCtx = { readonly client: ClientBase; readonly now: number };
type Exclusions = {
  undated: number;
  ambiguousTime: number;
  invalid: number;
  unsupportedValue: number;
  overflow: boolean;
};
export type Citation = {
  evidenceSpanId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  sourcePageId: string;
  start: number;
  end: number;
  quoteHash: string;
  quote: string;
  fields: string[];
  locator?: Record<string, unknown>;
};
export type ExactEventResult = {
  eventId: string;
  eventVersionId: string;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  entityId: string;
  eventType: RecordEventType;
  occurrence: Occurrence;
  citations: Citation[];
  originalLinkAvailable: boolean;
};
export type ExactObservationResult = ExactEventResult & {
  observationId: string;
  observationKey: string;
  observationType: string;
  value: ObservationValue;
};
type Metadata = {
  snapshotAt: number;
  consistency: QueryConsistency;
  sourceAccountIds: string[];
  coverage: QueryCoverage;
  exclusions: Exclusions;
  complete: boolean;
};
export type RecordQueryResult =
  | (Metadata & {
      operation: "latest_observation";
      status: "match" | "no_match_complete" | "no_match_incomplete";
      candidates: ExactObservationResult[];
    })
  | (Metadata & {
      operation: "observation_history";
      status: "match" | "no_match_complete" | "no_match_incomplete";
      records: ExactObservationResult[];
      cursor?: string;
    })
  | (Metadata & {
      operation: "latest_event";
      status: "match" | "no_match_complete" | "no_match_incomplete";
      candidates: ExactEventResult[];
    })
  | (Metadata & {
      operation: "list_events";
      status: "match" | "no_match_complete" | "no_match_incomplete";
      records: ExactEventResult[];
      cursor?: string;
    })
  | (Metadata & {
      operation: "sum_money";
      status:
        | "total_complete"
        | "total_partial"
        | "no_match_complete"
        | "no_match_incomplete";
      totals: CurrencyTotal[];
      contributions: ExactObservationResult[];
      contributingObservationIds: string[];
      cursor?: string;
    });
type Scope = {
  principal: Principal;
  membership: SpaceMember;
  sourceAccountIds: string[];
  authorizationSignature: string;
};
type Candidate = {
  id: string;
  space_id: string;
  source_account_id: string | null;
  source_item_id: string | null;
  processing_generation_id: string | null;
  occurrence: unknown;
  occurrence_date: string | null;
  occurrence_instant: Date | null;
  occurrence_sort_key: string | null;
};

const utf8 = (v: string) => Buffer.byteLength(v, "utf8");
function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const keys = Object.keys(value);
  if (
    required.some(
      (key) => !Object.hasOwn(value, key) || value[key] === undefined,
    ) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error("Record query is malformed");
}
function stringField(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
}
function numberField(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} is invalid`);
}
export function validateRecordQuery(value: unknown): RecordQuery {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Record query is malformed");
  const query = value as Record<string, unknown>;
  stringField(query.operation, "operation");
  const common = ["sourceAccountIds", "consistency"];
  switch (query.operation) {
    case "latest_observation":
      exactKeys(
        query,
        ["operation", "spaceId", "entityId", "observationType"],
        [...common, "asOf", "unitCode"],
      );
      stringField(query.observationType, "observationType");
      if (query.asOf !== undefined) numberField(query.asOf, "asOf");
      if (query.unitCode !== undefined) stringField(query.unitCode, "unitCode");
      break;
    case "observation_history":
      exactKeys(
        query,
        [
          "operation",
          "spaceId",
          "entityId",
          "observationType",
          "from",
          "to",
          "order",
        ],
        [...common, "cursor", "limit", "unitCode"],
      );
      stringField(query.observationType, "observationType");
      numberField(query.from, "from");
      numberField(query.to, "to");
      if (query.order !== "asc" && query.order !== "desc")
        throw new Error("order is invalid");
      if (query.unitCode !== undefined) stringField(query.unitCode, "unitCode");
      if (query.limit !== undefined) numberField(query.limit, "limit");
      if (query.cursor !== undefined) stringField(query.cursor, "cursor");
      break;
    case "latest_event":
      exactKeys(
        query,
        ["operation", "spaceId", "entityId", "eventType"],
        [...common, "asOf"],
      );
      stringField(query.eventType, "eventType");
      if (query.asOf !== undefined) numberField(query.asOf, "asOf");
      break;
    case "list_events":
      exactKeys(
        query,
        [
          "operation",
          "spaceId",
          "entityId",
          "eventType",
          "from",
          "to",
          "order",
        ],
        [...common, "cursor", "limit"],
      );
      stringField(query.eventType, "eventType");
      numberField(query.from, "from");
      numberField(query.to, "to");
      if (query.order !== "asc" && query.order !== "desc")
        throw new Error("order is invalid");
      if (query.limit !== undefined) numberField(query.limit, "limit");
      if (query.cursor !== undefined) stringField(query.cursor, "cursor");
      break;
    case "sum_money":
      exactKeys(
        query,
        ["operation", "spaceId", "lineItemType", "from", "to"],
        [...common, "cursor", "entityId", "sourceAccountId"],
      );
      stringField(query.lineItemType, "lineItemType");
      numberField(query.from, "from");
      numberField(query.to, "to");
      if (query.cursor !== undefined) stringField(query.cursor, "cursor");
      if (query.entityId !== undefined) stringField(query.entityId, "entityId");
      if (query.sourceAccountId !== undefined)
        stringField(query.sourceAccountId, "sourceAccountId");
      break;
    default:
      throw new Error("operation is invalid");
  }
  stringField(query.spaceId, "spaceId");
  assertKithId(query.spaceId, "invalid_space_id");
  if (query.operation !== "sum_money") stringField(query.entityId, "entityId");
  if ("entityId" in query && query.entityId !== undefined)
    assertKithId(query.entityId, "invalid_entity_id");
  if ("sourceAccountId" in query && query.sourceAccountId !== undefined)
    assertKithId(query.sourceAccountId, "invalid_source_account_id");
  if (query.cursor !== undefined)
    assertKithId(query.cursor, "invalid_cursor_id");
  if (
    query.consistency !== undefined &&
    query.consistency !== "snapshot" &&
    query.consistency !== "current"
  )
    throw new Error("consistency is invalid");
  if (query.sourceAccountIds !== undefined) {
    if (
      !Array.isArray(query.sourceAccountIds) ||
      query.sourceAccountIds.some((id) => typeof id !== "string")
    )
      throw new Error("sourceAccountIds is invalid");
    for (const id of query.sourceAccountIds)
      assertKithId(id, "invalid_source_account_id");
  }
  return value as RecordQuery;
}
function occurrenceTime(v: number, n: string) {
  if (!Number.isSafeInteger(v) || v < MIN_QUERY_TIME || v > MAX_QUERY_TIME)
    throw new Error(`${n} must be a supported Unix millisecond timestamp`);
}
function publicationTime(v: number) {
  if (!Number.isSafeInteger(v) || v < 0)
    throw new Error("now must be a nonnegative safe-integer timestamp");
}
function range(from: number, to: number) {
  occurrenceTime(from, "from");
  occurrenceTime(to, "to");
  if (from >= to) throw new Error("Query ranges must satisfy from < to");
}
function limit(v: number | undefined) {
  const n = v ?? DEFAULT_QUERY_RESULTS;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_QUERY_RESULTS)
    throw new Error(`limit must be an integer from 1 to ${MAX_QUERY_RESULTS}`);
  return n;
}
const uniqueSorted = (v: readonly string[]) => [...new Set(v)].sort();
function eventType(v: string): RecordEventType {
  const n = validateQueryType(v, "eventType");
  if (!EVENT_TYPES.has(n)) throw new Error("Unsupported eventType");
  return n as RecordEventType;
}
const dateAt = (v: number) => new Date(v).toISOString().slice(0, 10);
function shiftDate(date: string, days: number) {
  return dateAt(
    Math.max(
      MIN_QUERY_TIME,
      Math.min(
        MAX_QUERY_TIME,
        Date.parse(`${date}T00:00:00.000Z`) + days * 86400000,
      ),
    ),
  );
}
function empty(): Exclusions {
  return {
    undated: 0,
    ambiguousTime: 0,
    invalid: 0,
    unsupportedValue: 0,
    overflow: false,
  };
}
function queryLimitBytes(existing: unknown[], next: unknown) {
  return utf8(JSON.stringify([...existing, next])) <= MAX_RESULT_BYTES;
}
function hydration(client: ClientBase) {
  return createRecordHydrationCache(client, {
    maxLoadedUtf8Bytes: MAX_HYDRATION_READ_BYTES,
    maxEvidenceQuoteUtf8Bytes: MAX_HYDRATION_EVIDENCE_BYTES,
  });
}
function budgetError(e: unknown) {
  return (
    e instanceof Error &&
    (e.message.startsWith("Record hydration exceeds the global") ||
      e.message === "Record hydration budget is exhausted")
  );
}
function rethrowDatabaseError(error: unknown): void {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    throw error;
}
function inRange(
  o: Occurrence,
  from: number,
  to: number,
): "in" | "out" | "ambiguous" {
  if (o.precision === "unknown") return "out";
  if (o.precision === "datetime")
    return o.instant >= from && o.instant < to ? "in" : "out";
  const m = Date.parse(`${o.date}T00:00:00.000Z`),
    a = m - MAX_DATE_OFFSET_MS,
    b = m + 86400000 + MAX_DATE_OFFSET_MS;
  return a >= from && b <= to ? "in" : a < to && b > from ? "ambiguous" : "out";
}
function atOrBefore(o: Occurrence, asOf: number): "in" | "out" | "ambiguous" {
  if (o.precision === "unknown") return "out";
  if (o.precision === "datetime") return o.instant <= asOf ? "in" : "out";
  const m = Date.parse(`${o.date}T00:00:00.000Z`),
    a = m - MAX_DATE_OFFSET_MS,
    b = m + 86400000 + MAX_DATE_OFFSET_MS;
  return b <= asOf ? "in" : a <= asOf ? "ambiguous" : "out";
}
function valueMatchesUnit(v: ObservationValue, u: string | undefined) {
  return (
    u === undefined ||
    ((v.type === "decimal" || v.type === "integer") && v.unitCode === u)
  );
}

async function resolveScope(
  ctx: QueryCtx,
  ref: Principal | PrincipalRef,
  query: RecordQuery,
): Promise<Scope> {
  const p = await reloadPrincipal(
    ctx,
    "capabilities" in ref ? principalRef(ref) : ref,
  );
  const membership = await requireSpaceAccess(ctx, p, query.spaceId, "read");
  if ("entityId" in query && query.entityId !== undefined) {
    const e = await ctx.client.query(
      "SELECT space_id FROM kith.entities WHERE id=$1",
      [query.entityId],
    );
    if (e.rows.length !== 1 || e.rows[0].space_id !== query.spaceId)
      throw new Error("Entity not found");
  }
  let requested = query.sourceAccountIds;
  if (query.operation === "sum_money" && query.sourceAccountId !== undefined) {
    if (
      requested &&
      (requested.length !== 1 || requested[0] !== query.sourceAccountId)
    )
      throw new Error("sum_money account filters conflict");
    requested = [query.sourceAccountId];
  }
  let ids: string[];
  if (requested) {
    validateSourceAccountCount(requested);
    ids = uniqueSorted(requested);
  } else {
    const r = await ctx.client.query(
      "SELECT id FROM kith.source_accounts WHERE space_id=$1 ORDER BY id LIMIT $2",
      [query.spaceId, MAX_SOURCE_ACCOUNTS + 1],
    );
    if (r.rows.length > MAX_SOURCE_ACCOUNTS)
      throw new Error("Source inventory is too large; select source accounts");
    ids = r.rows.map((x) => String(x.id)).sort();
  }
  if (ids.length) {
    const r = await ctx.client.query(
      "SELECT id FROM kith.source_accounts WHERE space_id=$1 AND id=ANY($2::kith.kith_id[])",
      [query.spaceId, ids],
    );
    if (r.rows.length !== ids.length)
      throw new Error("Source account not found");
  }
  const authorizationSignature = JSON.stringify({
    userId: p.userId,
    credentialId: p.credentialId ?? null,
    membershipId: membership.id,
    membershipRole: membership.role,
    capabilities: uniqueSorted(p.capabilities),
    credentialSpaceIds: uniqueSorted(p.credentialSpaceIds ?? []),
    credentialSourceAccountIds: uniqueSorted(
      p.credentialSourceAccountIds ?? [],
    ),
    querySourceAccountIds: ids,
  });
  return {
    principal: p,
    membership,
    sourceAccountIds: ids,
    authorizationSignature,
  };
}
function normalized(query: RecordQuery, scope: Scope) {
  const common = {
    operation: query.operation,
    spaceId: query.spaceId,
    sourceAccountIds: scope.sourceAccountIds,
    consistency: query.consistency ?? "snapshot",
  };
  let value: object;
  switch (query.operation) {
    case "latest_observation":
      value = {
        ...common,
        entityId: query.entityId,
        observationType: validateQueryType(
          query.observationType,
          "observationType",
        ),
        asOf: query.asOf ?? null,
        unitCode: validateOptionalUnitCode(query.unitCode) ?? null,
      };
      break;
    case "observation_history":
      value = {
        ...common,
        entityId: query.entityId,
        observationType: validateQueryType(
          query.observationType,
          "observationType",
        ),
        from: query.from,
        to: query.to,
        order: query.order,
        unitCode: validateOptionalUnitCode(query.unitCode) ?? null,
        limit: limit(query.limit),
      };
      break;
    case "latest_event":
      value = {
        ...common,
        entityId: query.entityId,
        eventType: eventType(query.eventType),
        asOf: query.asOf ?? null,
      };
      break;
    case "list_events":
      value = {
        ...common,
        entityId: query.entityId,
        eventType: eventType(query.eventType),
        from: query.from,
        to: query.to,
        order: query.order,
        limit: limit(query.limit),
      };
      break;
    case "sum_money":
      value = {
        ...common,
        entityId: query.entityId ?? null,
        sourceAccountId: query.sourceAccountId ?? null,
        lineItemType: validateQueryType(query.lineItemType, "lineItemType"),
        from: query.from,
        to: query.to,
      };
  }
  const s = JSON.stringify(value);
  if (utf8(s) > MAX_NORMALIZED_FILTER_BYTES)
    throw new Error("Normalized query filter is too large");
  return s;
}
function binding(
  scope: Scope,
  query: RecordQuery,
  filter: string,
): AuthorizedRecordQueryBinding {
  return {
    spaceId: query.spaceId,
    userId: scope.principal.userId,
    ...(scope.principal.credentialId
      ? { credentialId: scope.principal.credentialId }
      : {}),
    membershipId: scope.membership.id,
    authorizationSignature: scope.authorizationSignature,
    operation: query.operation,
    consistency: query.consistency ?? "snapshot",
    normalizedFilter: filter,
    sourceAccountIds: scope.sourceAccountIds,
  };
}

function citations(h: HydratedEventVersion | HydratedObservation): Citation[] {
  const fields = new Map<string, string[]>();
  const groups = {
    occurrence: h.eventVersion.fieldEvidence.occurrence,
    entity: h.eventVersion.fieldEvidence.entity,
    eventType: h.eventVersion.fieldEvidence.eventType,
    ...("observation" in h
      ? { observationValue: h.observation.valueEvidence }
      : {}),
  };
  for (const [f, ids] of Object.entries(groups))
    for (const id of ids) fields.set(id, [...(fields.get(id) ?? []), f]);
  return h.evidence.map(({ span, quote }) => ({
    evidenceSpanId: span.id,
    sourceRevisionId: span.sourceRevisionId,
    sourceTextVersionId: span.sourceTextVersionId,
    sourcePageId: span.sourcePageId,
    start: span.start,
    end: span.end,
    quoteHash: span.quoteHash,
    quote,
    fields: fields.get(span.id) ?? [],
    ...(span.locator === null ? {} : { locator: span.locator }),
  }));
}
function projectEvent(h: HydratedEventVersion): ExactEventResult {
  return {
    eventId: h.event.id,
    eventVersionId: h.eventVersion.id,
    sourceAccountId: h.sourceAccount.id,
    sourceItemId: h.sourceItem.id,
    sourceRevisionId: h.sourceRevision.id,
    entityId: h.entity.id,
    eventType: h.eventVersion.eventType,
    occurrence: h.eventVersion.occurrence,
    citations: citations(h),
    originalLinkAvailable: h.sourceItem.originalLinkAvailable,
  };
}
function projectObservation(h: HydratedObservation): ExactObservationResult {
  return {
    ...projectEvent(h),
    observationId: h.observation.id,
    observationKey: h.observation.observationKey,
    observationType: h.observation.observationType,
    value: h.observation.value,
  };
}
function tuple(row: Candidate): RecordQueryCursorTuple {
  const o = row.occurrence as Occurrence;
  if (
    !o ||
    o.precision === "unknown" ||
    row.occurrence_date === null ||
    row.occurrence_sort_key === null
  )
    throw new Error("Dated record has invalid occurrence cursor fields");
  return {
    occurrenceDate: row.occurrence_date,
    occurrencePrecision: o.precision,
    ...(o.precision === "datetime" ? { occurrenceInstant: o.instant } : {}),
    sortKey: row.occurrence_sort_key,
    stableId: row.id,
  };
}

async function visibility(
  ctx: QueryCtx,
  row: Candidate,
  snapshot: number,
  ids: readonly string[],
): Promise<"visible" | "skip" | "invalid"> {
  if (!row.source_account_id || !ids.includes(row.source_account_id))
    return "skip";
  if (!row.processing_generation_id || !row.source_item_id || !row.space_id)
    return "invalid";
  const g = await ctx.client.query(
    "SELECT space_id,source_account_id,source_item_id,activated_at,deactivated_at FROM kith.processing_generations WHERE id=$1",
    [row.processing_generation_id],
  );
  if (g.rows.length !== 1) return "invalid";
  const x = g.rows[0];
  if (
    x.space_id !== row.space_id ||
    x.source_account_id !== row.source_account_id ||
    x.source_item_id !== row.source_item_id
  )
    return "invalid";
  const a = x.activated_at instanceof Date ? x.activated_at.getTime() : null,
    d = x.deactivated_at instanceof Date ? x.deactivated_at.getTime() : null;
  if (a === null || a > snapshot || (d !== null && snapshot >= d))
    return "skip";
  const i = await ctx.client.query(
    "SELECT space_id,lifecycle FROM kith.source_items WHERE id=$1",
    [row.source_item_id],
  );
  if (i.rows.length !== 1 || i.rows[0].space_id !== row.space_id)
    return "invalid";
  return i.rows[0].lifecycle === "forgetting" ||
    i.rows[0].lifecycle === "forgotten"
    ? "skip"
    : "visible";
}
function complete(c: QueryCoverage, e: Exclusions) {
  return (
    c.state === "complete" &&
    !c.overflow &&
    c.pendingJobs === 0 &&
    c.failedJobs === 0 &&
    e.invalid === 0 &&
    e.ambiguousTime === 0 &&
    e.unsupportedValue === 0 &&
    !e.overflow
  );
}
function status(matches: boolean, c: boolean) {
  return matches
    ? ("match" as const)
    : c
      ? ("no_match_complete" as const)
      : ("no_match_incomplete" as const);
}
async function coverage(
  ctx: QueryCtx,
  scope: Scope,
  type: string,
  entityId: string | undefined,
  from: number,
  to: number,
  snapshot: number,
) {
  return calculateCoverage(ctx, {
    spaceId: scope.membership.spaceId,
    sourceAccountIds: scope.sourceAccountIds,
    recordType: type,
    ...(entityId ? { entityId } : {}),
    from,
    to,
    now: ctx.now,
    snapshotAt: snapshot,
  });
}

async function undated(
  ctx: QueryCtx,
  kind: "observations" | "event_versions",
  query: RecordQuery,
  scope: Scope,
  snapshot: number,
  budget: RecordHydrationCache,
  type: string,
) {
  const account =
    query.operation === "sum_money" && !query.entityId
      ? query.sourceAccountId
      : undefined;
  const typeColumn =
    kind === "observations" ? "observation_type" : "event_type";
  const params: any[] = [];
  let where: string;
  if (account) {
    params.push(query.spaceId, account, type);
    where = `space_id=$1 AND source_account_id=$2 AND ${typeColumn}=$3`;
  } else {
    const entity = "entityId" in query ? query.entityId : undefined;
    params.push(query.spaceId, entity, type);
    where = `space_id=$1 AND entity_id=$2 AND ${typeColumn}=$3`;
  }
  params.push(MAX_UNDATED_SCAN_ROWS + 1);
  const r = await ctx.client.query(
    `SELECT * FROM kith.${kind} WHERE ${where} AND occurrence->>'precision'='unknown' ORDER BY id LIMIT $${params.length}`,
    params,
  );
  let count = 0,
    invalid = 0,
    over = false;
  for (const row of r.rows.slice(0, MAX_UNDATED_SCAN_ROWS)) {
    try {
      const v = await visibility(ctx, row, snapshot, scope.sourceAccountIds);
      if (v === "skip") continue;
      if (v === "invalid") {
        invalid++;
        continue;
      }
      if (kind === "observations")
        await hydrateObservation(ctx.client, {
          spaceId: query.spaceId,
          observationId: row.id,
          snapshot,
          sourceAccountIds: scope.sourceAccountIds,
          cache: budget,
        });
      else
        await hydrateEventVersion(ctx.client, {
          spaceId: query.spaceId,
          eventVersionId: row.id,
          snapshot,
          sourceAccountIds: scope.sourceAccountIds,
          cache: budget,
        });
      count++;
    } catch (e) {
      rethrowDatabaseError(e);
      if (budgetError(e)) {
        over = true;
        break;
      }
      invalid++;
    }
  }
  return {
    count,
    invalid,
    overflow: r.rows.length > MAX_UNDATED_SCAN_ROWS || over,
  };
}

async function initial(
  ctx: QueryCtx,
  ref: Principal | PrincipalRef,
  query: RecordQuery,
) {
  const scope = await resolveScope(ctx, ref, query),
    filter = normalized(query, scope);
  const b = binding(scope, query, filter);
  const resolved = await resolveRecordQueryContext(
    ctx,
    b,
    query.operation === "observation_history" ||
      query.operation === "list_events" ||
      query.operation === "sum_money"
      ? query.cursor
      : undefined,
  );
  return {
    scope,
    filter,
    binding: b,
    session: resolved.session,
    snapshot: resolved.snapshot,
  };
}
async function finish(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof initial>>,
  last: RecordQueryCursorTuple | undefined,
  totals: CurrencyTotal[],
  e: Exclusions,
  processed: number,
  partial: boolean,
) {
  if (!partial) {
    if (state.session)
      await consumeRecordQuerySession(ctx, state.binding, state.session.id);
    return undefined;
  }
  if (!last) throw new Error("Record query page exceeds its byte limit");
  const a = {
    lastTuple: last,
    totals,
    invalidRows: e.invalid,
    ambiguousTimeRows: e.ambiguousTime,
    unsupportedValueRows: e.unsupportedValue,
    readOverflow: e.overflow,
    processedRows: processed,
  };
  return state.session
    ? advanceRecordQuerySession(ctx, state.binding, state.session.id, a)
    : createRecordQuerySession(ctx, state.binding, state.snapshot, a);
}

async function latest(
  ctx: QueryCtx,
  ref: Principal | PrincipalRef,
  query: LatestObservationQuery | LatestEventQuery,
): Promise<RecordQueryResult> {
  if (query.asOf !== undefined) occurrenceTime(query.asOf, "asOf");
  const state = await initial(ctx, ref, query),
    isObs = query.operation === "latest_observation",
    type = isObs
      ? validateQueryType(query.observationType, "observationType")
      : eventType(query.eventType),
    table = isObs ? "observations" : "event_versions",
    typeCol = isObs ? "observation_type" : "event_type",
    asOf = query.asOf ?? state.snapshot.snapshotAt,
    budget = hydration(ctx.client),
    maxDate = dateAt(Math.min(MAX_QUERY_TIME, asOf + MAX_DATE_OFFSET_MS));
  const [dates, times] = await Promise.all([
    ctx.client.query(
      `SELECT * FROM kith.${table} WHERE space_id=$1 AND entity_id=$2 AND ${typeCol}=$3 AND occurrence->>'precision'='date' AND occurrence_date<=$4 ORDER BY occurrence_date DESC,id DESC LIMIT $5`,
      [query.spaceId, query.entityId, type, maxDate, MAX_QUERY_SCAN_ROWS + 1],
    ),
    ctx.client.query(
      `SELECT * FROM kith.${table} WHERE space_id=$1 AND entity_id=$2 AND ${typeCol}=$3 AND occurrence_instant<=$4 ORDER BY occurrence_instant DESC,id DESC LIMIT $5`,
      [
        query.spaceId,
        query.entityId,
        type,
        new Date(asOf),
        MAX_QUERY_SCAN_ROWS + 1,
      ],
    ),
  ]);
  const e = empty();
  e.overflow =
    dates.rows.length > MAX_QUERY_SCAN_ROWS ||
    times.rows.length > MAX_QUERY_SCAN_ROWS;
  const items: (HydratedObservation | HydratedEventVersion)[] = [],
    seen = new Set<string>();
  for (const row of [
    ...dates.rows.slice(0, MAX_QUERY_SCAN_ROWS),
    ...times.rows.slice(0, MAX_QUERY_SCAN_ROWS),
  ]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    try {
      const v = await visibility(
        ctx,
        row,
        state.snapshot.snapshotAt,
        state.scope.sourceAccountIds,
      );
      if (v === "skip") continue;
      if (v === "invalid") {
        e.invalid++;
        continue;
      }
      const h = isObs
        ? await hydrateObservation(ctx.client, {
            spaceId: query.spaceId,
            observationId: row.id,
            snapshot: state.snapshot.snapshotAt,
            sourceAccountIds: state.scope.sourceAccountIds,
            cache: budget,
          })
        : await hydrateEventVersion(ctx.client, {
            spaceId: query.spaceId,
            eventVersionId: row.id,
            snapshot: state.snapshot.snapshotAt,
            sourceAccountIds: state.scope.sourceAccountIds,
            cache: budget,
          });
      const ts = atOrBefore(
        isObs
          ? (h as HydratedObservation).observation.occurrence
          : (h as HydratedEventVersion).eventVersion.occurrence,
        asOf,
      );
      if (ts === "ambiguous") e.ambiguousTime++;
      if (
        ts === "in" &&
        (!isObs ||
          valueMatchesUnit(
            (h as HydratedObservation).observation.value,
            validateOptionalUnitCode(
              (query as LatestObservationQuery).unitCode,
            ),
          ))
      )
        items.push(h);
    } catch (x) {
      rethrowDatabaseError(x);
      if (budgetError(x)) {
        e.overflow = true;
        break;
      }
      e.invalid++;
    }
  }
  const selected = selectLatestOccurrences(
    items,
    (x) =>
      isObs
        ? (x as HydratedObservation).observation.occurrence
        : (x as HydratedEventVersion).eventVersion.occurrence,
    (x) =>
      isObs
        ? (x as HydratedObservation).observation.id
        : (x as HydratedEventVersion).eventVersion.id,
  );
  const projected: any[] = [];
  for (const item of selected.candidates) {
    const p = isObs
      ? projectObservation(item as HydratedObservation)
      : projectEvent(item as HydratedEventVersion);
    if (!queryLimitBytes(projected, p)) {
      e.overflow = true;
      break;
    }
    projected.push(p);
  }
  const u = await undated(
    ctx,
    table as any,
    query,
    state.scope,
    state.snapshot.snapshotAt,
    budget,
    type,
  );
  e.undated = u.count;
  e.invalid += u.invalid;
  e.overflow ||= u.overflow;
  const c = await coverage(
      ctx,
      state.scope,
      type,
      query.entityId,
      MIN_QUERY_TIME,
      Math.min(asOf + 1, MAX_QUERY_TIME),
      state.snapshot.snapshotAt,
    ),
    done = complete(c, e) && e.undated === 0;
  const meta = {
    snapshotAt: state.snapshot.snapshotAt,
    consistency: query.consistency ?? "snapshot",
    sourceAccountIds: state.scope.sourceAccountIds,
    coverage: c,
    exclusions: e,
    complete: done,
  };
  return isObs
    ? {
        ...meta,
        operation: "latest_observation",
        status: status(projected.length > 0, done),
        candidates: projected,
      }
    : {
        ...meta,
        operation: "latest_event",
        status: status(projected.length > 0, done),
        candidates: projected,
      };
}

async function paged(
  ctx: QueryCtx,
  ref: Principal | PrincipalRef,
  query: ObservationHistoryQuery | ListEventsQuery,
): Promise<RecordQueryResult> {
  range(query.from, query.to);
  const state = await initial(ctx, ref, query),
    isObs = query.operation === "observation_history",
    type = isObs
      ? validateQueryType(query.observationType, "observationType")
      : eventType(query.eventType),
    table = isObs ? "observations" : "event_versions",
    typeCol = isObs ? "observation_type" : "event_type",
    lower = `${shiftDate(dateAt(query.from), -1)}|`,
    upper = `${shiftDate(dateAt(query.to), 1)}|\uffff`,
    cursor = state.session?.lastTuple.sortKey,
    op = query.order === "asc" ? ">" : "<",
    edge = query.order === "asc" ? (cursor ?? lower) : (cursor ?? upper);
  const rows = await ctx.client.query(
    `SELECT * FROM kith.${table} WHERE space_id=$1 AND entity_id=$2 AND ${typeCol}=$3 AND occurrence_sort_key ${op} $4 AND occurrence_sort_key ${query.order === "asc" ? "<" : ">"} $5 ORDER BY occurrence_sort_key ${query.order === "asc" ? "ASC" : "DESC"} LIMIT $6`,
    [
      query.spaceId,
      query.entityId,
      type,
      edge,
      query.order === "asc" ? upper : lower,
      MAX_QUERY_SCAN_ROWS + 1,
    ],
  );
  const records: any[] = [],
    e = empty();
  if (state.session) {
    e.invalid = state.session.invalidRows;
    e.ambiguousTime = state.session.ambiguousTimeRows;
    e.unsupportedValue = state.session.unsupportedValueRows;
    e.overflow = state.session.readOverflow;
  }
  const budget = hydration(ctx.client);
  let last: RecordQueryCursorTuple | undefined,
    consumed = 0;
  for (const row of rows.rows.slice(0, MAX_QUERY_SCAN_ROWS)) {
    const t = tuple(row);
    let p: any;
    try {
      const v = await visibility(
        ctx,
        row,
        state.snapshot.snapshotAt,
        state.scope.sourceAccountIds,
      );
      if (v === "skip") {
        consumed++;
        last = t;
        continue;
      }
      if (v === "invalid") {
        e.invalid++;
        consumed++;
        last = t;
        continue;
      }
      const h = isObs
        ? await hydrateObservation(ctx.client, {
            spaceId: query.spaceId,
            observationId: row.id,
            snapshot: state.snapshot.snapshotAt,
            sourceAccountIds: state.scope.sourceAccountIds,
            cache: budget,
          })
        : await hydrateEventVersion(ctx.client, {
            spaceId: query.spaceId,
            eventVersionId: row.id,
            snapshot: state.snapshot.snapshotAt,
            sourceAccountIds: state.scope.sourceAccountIds,
            cache: budget,
          });
      const ts = inRange(
        isObs
          ? (h as HydratedObservation).observation.occurrence
          : (h as HydratedEventVersion).eventVersion.occurrence,
        query.from,
        query.to,
      );
      if (ts === "ambiguous") e.ambiguousTime++;
      if (
        ts === "in" &&
        (!isObs ||
          valueMatchesUnit(
            (h as HydratedObservation).observation.value,
            validateOptionalUnitCode(
              (query as ObservationHistoryQuery).unitCode,
            ),
          ))
      )
        p = isObs
          ? projectObservation(h as HydratedObservation)
          : projectEvent(h as HydratedEventVersion);
    } catch (x) {
      rethrowDatabaseError(x);
      if (budgetError(x)) break;
      e.invalid++;
    }
    if (
      p &&
      (!queryLimitBytes(records, p) || records.length >= limit(query.limit))
    )
      break;
    consumed++;
    last = t;
    if (p) records.push(p);
  }
  const partial = consumed < rows.rows.length,
    cursorE = { ...e };
  const u = await undated(
    ctx,
    table as any,
    query,
    state.scope,
    state.snapshot.snapshotAt,
    budget,
    type,
  );
  e.undated = u.count;
  e.invalid += u.invalid;
  e.overflow ||= u.overflow;
  const next = await finish(
      ctx,
      state,
      last,
      [],
      cursorE,
      (state.session?.processedRows ?? 0) + consumed,
      partial,
    ),
    c = await coverage(
      ctx,
      state.scope,
      type,
      query.entityId,
      query.from,
      query.to,
      state.snapshot.snapshotAt,
    ),
    done = !partial && complete(c, e) && e.undated === 0,
    meta = {
      snapshotAt: state.snapshot.snapshotAt,
      consistency: state.snapshot.consistency,
      sourceAccountIds: state.scope.sourceAccountIds,
      coverage: c,
      exclusions: e,
      complete: done,
    };
  return isObs
    ? {
        ...meta,
        operation: "observation_history",
        status: status(records.length > 0, done),
        records,
        ...(next ? { cursor: next } : {}),
      }
    : {
        ...meta,
        operation: "list_events",
        status: status(records.length > 0, done),
        records,
        ...(next ? { cursor: next } : {}),
      };
}

async function sumMoney(
  ctx: QueryCtx,
  ref: Principal | PrincipalRef,
  query: SumMoneyQuery,
): Promise<RecordQueryResult> {
  range(query.from, query.to);
  if ((query.entityId === undefined) === (query.sourceAccountId === undefined))
    throw new Error(
      "sum_money requires exactly one entityId or sourceAccountId",
    );
  const state = await initial(ctx, ref, query),
    type = validateQueryType(query.lineItemType, "lineItemType"),
    lower = `${shiftDate(dateAt(query.from), -1)}|`,
    upper = `${shiftDate(dateAt(query.to), 1)}|\uffff`,
    after = state.session?.lastTuple.sortKey ?? lower;
  const where = query.entityId
    ? "space_id=$1 AND entity_id=$2"
    : "space_id=$1 AND source_account_id=$2";
  const rows = await ctx.client.query(
    `SELECT * FROM kith.observations WHERE ${where} AND observation_type=$3 AND occurrence_sort_key>$4 AND occurrence_sort_key<$5 ORDER BY occurrence_sort_key ASC LIMIT $6`,
    [
      query.spaceId,
      query.entityId ?? query.sourceAccountId,
      type,
      after,
      upper,
      MAX_AGGREGATION_PAGE_ROWS + 1,
    ],
  );
  const totals = new Map(
      (state.session?.totals ?? []).map((x) => [x.currency, x.amount]),
    ),
    ids: string[] = [],
    contributions: ExactObservationResult[] = [],
    e = empty();
  if (state.session) {
    e.invalid = state.session.invalidRows;
    e.ambiguousTime = state.session.ambiguousTimeRows;
    e.unsupportedValue = state.session.unsupportedValueRows;
    e.overflow = state.session.readOverflow;
  }
  const budget = hydration(ctx.client);
  let last: RecordQueryCursorTuple | undefined,
    consumed = 0;
  for (const row of rows.rows.slice(0, MAX_AGGREGATION_PAGE_ROWS)) {
    const previous = last;
    last = tuple(row);
    consumed++;
    try {
      const v = await visibility(
        ctx,
        row,
        state.snapshot.snapshotAt,
        state.scope.sourceAccountIds,
      );
      if (v === "skip") continue;
      if (v === "invalid") {
        e.invalid++;
        continue;
      }
      const h = await hydrateObservation(ctx.client, {
          spaceId: query.spaceId,
          observationId: row.id,
          snapshot: state.snapshot.snapshotAt,
          sourceAccountIds: state.scope.sourceAccountIds,
          cache: budget,
        }),
        ts = inRange(h.observation.occurrence, query.from, query.to);
      if (ts === "ambiguous") {
        e.ambiguousTime++;
        continue;
      }
      if (ts !== "in") continue;
      if (h.observation.value.type !== "money") {
        e.unsupportedValue++;
        continue;
      }
      const currency = validateCurrencyCode(h.observation.value.currency),
        amount = canonicalizeDecimal(h.observation.value.amount),
        p = projectObservation(h);
      if (!queryLimitBytes(contributions, p)) {
        last = previous;
        consumed--;
        if (!contributions.length)
          throw new Error(
            "Money contribution exceeds the query result byte limit",
          );
        break;
      }
      totals.set(currency, addDecimals(totals.get(currency) ?? "0", amount));
      ids.push(row.id);
      contributions.push(p);
    } catch (x) {
      rethrowDatabaseError(x);
      if (
        x instanceof Error &&
        x.message === "Money contribution exceeds the query result byte limit"
      )
        throw x;
      if (budgetError(x)) {
        last = previous;
        consumed--;
        break;
      }
      e.invalid++;
    }
  }
  const partial = consumed < rows.rows.length,
    sorted = [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({ currency, amount })),
    cursorE = { ...e };
  const u = await undated(
    ctx,
    "observations",
    query,
    state.scope,
    state.snapshot.snapshotAt,
    budget,
    type,
  );
  e.undated = u.count;
  e.invalid += u.invalid;
  e.overflow ||= u.overflow;
  const next = await finish(
      ctx,
      state,
      last,
      sorted,
      cursorE,
      (state.session?.processedRows ?? 0) + consumed,
      partial,
    ),
    c = await coverage(
      ctx,
      state.scope,
      type,
      query.entityId,
      query.from,
      query.to,
      state.snapshot.snapshotAt,
    ),
    done = !partial && complete(c, e) && e.undated === 0,
    s = partial
      ? "total_partial"
      : sorted.length
        ? done
          ? "total_complete"
          : "total_partial"
        : done
          ? "no_match_complete"
          : "no_match_incomplete";
  return {
    operation: "sum_money",
    status: s,
    totals: sorted,
    contributions,
    contributingObservationIds: ids,
    ...(next ? { cursor: next } : {}),
    snapshotAt: state.snapshot.snapshotAt,
    consistency: state.snapshot.consistency,
    sourceAccountIds: state.scope.sourceAccountIds,
    coverage: c,
    exclusions: e,
    complete: done,
  };
}

/**
 * Executes one fully authorized query page. The caller must wrap each call in
 * `withKithTransaction`; this function reloads the mutable principal, credential
 * grants and membership inside that SERIALIZABLE transaction before any scan.
 */
export async function executeRecordQuery(
  ctx: QueryCtx,
  args: {
    principal: Principal | PrincipalRef;
    query: RecordQuery;
    now?: number;
  },
): Promise<RecordQueryResult> {
  if (args.now !== undefined && args.now !== ctx.now)
    throw new Error("Query clock must match its transaction context");
  publicationTime(ctx.now);
  const query = validateRecordQuery(args.query);
  switch (query.operation) {
    case "latest_observation":
    case "latest_event":
      return latest(ctx, args.principal, query);
    case "observation_history":
    case "list_events":
      return paged(ctx, args.principal, query);
    case "sum_money":
      return sumMoney(ctx, args.principal, query);
  }
}
