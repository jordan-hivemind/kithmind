import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  principalRef,
  reloadPrincipal,
  requireSpaceAccess,
  type Principal,
  type PrincipalRef,
} from "../../lib/spaces";
import { calculateCoverage, type QueryCoverage } from "../coverage/model";
import {
  hydrateEventVersion,
  hydrateObservation,
  createRecordHydrationCache,
  type HydratedEventVersion,
  type HydratedObservation,
  type RecordHydrationCache,
} from "./model";
import {
  advanceRecordQuerySession,
  beginRecordQuerySnapshot,
  consumeRecordQuerySession,
  createRecordQuerySession,
  getRecordQueryEpochs,
  type CurrencyTotal,
  type RecordQueryCursorTuple,
} from "./querySessions";
import type {
  LatestEventQuery,
  LatestObservationQuery,
  ListEventsQuery,
  ObservationHistoryQuery,
  RecordQuery,
  SumMoneyQuery,
} from "./queryValidators";
import {
  validateOptionalUnitCode,
  validateQueryType,
  validateSourceAccountCount,
} from "./queryValidators";
import { isRecordEventType, type RecordEventType } from "./validators";
import {
  addDecimals,
  canonicalizeDecimal,
  MAX_DATETIME_OFFSET_MINUTES,
  selectLatestOccurrences,
  validateCurrencyCode,
} from "./values";

const MAX_SOURCE_ACCOUNTS = 32;
const MAX_QUERY_SCAN_ROWS = 256;
const MAX_AGGREGATION_PAGE_ROWS = 25;
const MAX_UNDATED_SCAN_ROWS = 256;
const MAX_QUERY_RESULTS = 25;
const DEFAULT_QUERY_RESULTS = 20;
const MAX_RESULT_BYTES = 96 * 1_024;
const MAX_NORMALIZED_FILTER_BYTES = 4_096;
const MAX_HYDRATION_READ_BYTES = 2 * 1_024 * 1_024;
const MAX_HYDRATION_EVIDENCE_BYTES = 256 * 1_024;
const MAX_DATE_OFFSET_MS = MAX_DATETIME_OFFSET_MINUTES * 60 * 1_000;
const MIN_QUERY_TIME = -62_167_219_200_000;
const MAX_QUERY_TIME = 253_402_300_799_999;

type QueryOperation = RecordQuery["operation"];
type QueryConsistency = "snapshot" | "current";

type Exclusions = {
  undated: number;
  ambiguousTime: number;
  invalid: number;
  unsupportedValue: number;
  overflow: boolean;
};

type Citation = {
  evidenceSpanId: Id<"evidenceSpans">;
  sourceRevisionId: Id<"sourceRevisions">;
  sourceTextVersionId: Id<"sourceTextVersions">;
  sourcePageId: Id<"sourcePages">;
  start: number;
  end: number;
  quoteHash: string;
  quote: string;
  fields: string[];
  locator?: Doc<"evidenceSpans">["locator"];
};

export type ExactEventResult = {
  eventId: Id<"events">;
  eventVersionId: Id<"eventVersions">;
  sourceAccountId: Id<"sourceAccounts">;
  sourceItemId: Id<"sourceItems">;
  sourceRevisionId: Id<"sourceRevisions">;
  entityId: Id<"entities">;
  eventType: RecordEventType;
  occurrence: Doc<"eventVersions">["occurrence"];
  citations: Citation[];
  originalLinkAvailable: boolean;
};

export type ExactObservationResult = ExactEventResult & {
  observationId: Id<"observations">;
  observationKey: string;
  observationType: string;
  value: Doc<"observations">["value"];
};

type QueryMetadata = {
  snapshotAt: number;
  consistency: QueryConsistency;
  sourceAccountIds: Id<"sourceAccounts">[];
  coverage: QueryCoverage;
  exclusions: Exclusions;
  complete: boolean;
};

export type RecordQueryResult =
  | (QueryMetadata & {
      operation: "latest_observation";
      status: "match" | "no_match_complete" | "no_match_incomplete";
      candidates: ExactObservationResult[];
    })
  | (QueryMetadata & {
      operation: "observation_history";
      status: "match" | "no_match_complete" | "no_match_incomplete";
      records: ExactObservationResult[];
      cursor?: Id<"recordQuerySessions">;
    })
  | (QueryMetadata & {
      operation: "latest_event";
      status: "match" | "no_match_complete" | "no_match_incomplete";
      candidates: ExactEventResult[];
    })
  | (QueryMetadata & {
      operation: "list_events";
      status: "match" | "no_match_complete" | "no_match_incomplete";
      records: ExactEventResult[];
      cursor?: Id<"recordQuerySessions">;
    })
  | (QueryMetadata & {
      operation: "sum_money";
      status:
        | "total_complete"
        | "total_partial"
        | "no_match_complete"
        | "no_match_incomplete";
      totals: CurrencyTotal[];
      contributions: ExactObservationResult[];
      contributingObservationIds: Id<"observations">[];
      cursor?: Id<"recordQuerySessions">;
    });

type QueryScope = {
  principal: Principal;
  membership: Doc<"spaceMembers">;
  sourceAccountIds: Id<"sourceAccounts">[];
  authorizationSignature: string;
};

type Snapshot = {
  snapshotAt: number;
  activationEpoch: number;
  visibilityEpoch: number;
  consistency: QueryConsistency;
};

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function requireOccurrenceTime(value: number, name: string) {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_QUERY_TIME ||
    value > MAX_QUERY_TIME
  ) {
    throw new Error(`${name} must be a supported Unix millisecond timestamp`);
  }
}

function requirePublicationTime(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe-integer timestamp`);
  }
}

function requireRange(from: number, to: number) {
  requireOccurrenceTime(from, "from");
  requireOccurrenceTime(to, "to");
  if (from >= to) throw new Error("Query ranges must satisfy from < to");
}

function queryLimit(limit: number | undefined) {
  const normalized = limit ?? DEFAULT_QUERY_RESULTS;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_QUERY_RESULTS
  ) {
    throw new Error(`limit must be an integer from 1 to ${MAX_QUERY_RESULTS}`);
  }
  return normalized;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function asPrincipalRef(principal: Principal | PrincipalRef): PrincipalRef {
  return "capabilities" in principal ? principalRef(principal) : principal;
}

function eventType(value: string): RecordEventType {
  const normalized = validateQueryType(value, "eventType");
  if (!isRecordEventType(normalized)) {
    throw new Error("Unsupported eventType");
  }
  return normalized;
}

async function resolveQueryScope(
  ctx: MutationCtx,
  principalOrRef: Principal | PrincipalRef,
  query: RecordQuery,
): Promise<QueryScope> {
  const principal = await reloadPrincipal(ctx, asPrincipalRef(principalOrRef));
  const membership = await requireSpaceAccess(
    ctx,
    principal,
    query.spaceId,
    "read",
  );
  const entityId = "entityId" in query ? query.entityId : undefined;
  if (entityId !== undefined) {
    const entity = await ctx.db.get(entityId);
    if (!entity || entity.spaceId !== query.spaceId) {
      throw new Error("Entity not found");
    }
  }

  let requested = query.sourceAccountIds;
  if (query.operation === "sum_money" && query.sourceAccountId !== undefined) {
    if (
      requested !== undefined &&
      (requested.length !== 1 || requested[0] !== query.sourceAccountId)
    ) {
      throw new Error("sum_money account filters conflict");
    }
    requested = [query.sourceAccountId];
  }
  let sourceAccountIds: Id<"sourceAccounts">[];
  if (requested !== undefined) {
    validateSourceAccountCount(requested);
    sourceAccountIds = uniqueSorted(requested);
  } else {
    const accounts = await ctx.db
      .query("sourceAccounts")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", query.spaceId))
      .take(MAX_SOURCE_ACCOUNTS + 1);
    if (accounts.length > MAX_SOURCE_ACCOUNTS) {
      throw new Error("Source inventory is too large; select source accounts");
    }
    sourceAccountIds = accounts.map((account) => account._id).sort();
  }
  for (const sourceAccountId of sourceAccountIds) {
    const account = await ctx.db.get(sourceAccountId);
    if (!account || account.spaceId !== query.spaceId) {
      throw new Error("Source account not found");
    }
  }

  const authorizationSignature = JSON.stringify({
    userId: principal.userId,
    credentialId: principal.credentialId ?? null,
    membershipId: membership._id,
    membershipRole: membership.role,
    capabilities: uniqueSorted(principal.capabilities),
    credentialSpaceIds: uniqueSorted(principal.credentialSpaceIds ?? []),
    // Source-account key grants are ingest-only. They are included solely so
    // a mutable credential change invalidates a resumed cursor.
    credentialSourceAccountIds: uniqueSorted(
      principal.credentialSourceAccountIds ?? [],
    ),
    querySourceAccountIds: sourceAccountIds,
  });
  return { principal, membership, sourceAccountIds, authorizationSignature };
}

function normalizedFilter(query: RecordQuery, scope: QueryScope) {
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
        limit: queryLimit(query.limit),
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
        limit: queryLimit(query.limit),
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
      break;
  }
  const serialized = JSON.stringify(value);
  if (utf8Length(serialized) > MAX_NORMALIZED_FILTER_BYTES) {
    throw new Error("Normalized query filter is too large");
  }
  return serialized;
}

function projectCitations(
  hydrated: HydratedEventVersion | HydratedObservation,
): Citation[] {
  const fields = new Map<string, string[]>();
  for (const [field, ids] of Object.entries({
    occurrence: hydrated.eventVersion.fieldEvidence.occurrence,
    entity: hydrated.eventVersion.fieldEvidence.entity,
    eventType: hydrated.eventVersion.fieldEvidence.eventType,
    ...("observation" in hydrated
      ? { observationValue: hydrated.observation.valueEvidence }
      : {}),
  })) {
    for (const id of ids) {
      const current = fields.get(id) ?? [];
      current.push(field);
      fields.set(id, current);
    }
  }
  return hydrated.evidence.map(({ span, quote }) => ({
    evidenceSpanId: span._id,
    sourceRevisionId: span.sourceRevisionId,
    sourceTextVersionId: span.sourceTextVersionId,
    sourcePageId: span.sourcePageId,
    start: span.start,
    end: span.end,
    quoteHash: span.quoteHash,
    quote,
    fields: fields.get(span._id) ?? [],
    ...(span.locator === undefined ? {} : { locator: span.locator }),
  }));
}

function projectEvent(hydrated: HydratedEventVersion): ExactEventResult {
  return {
    eventId: hydrated.event._id,
    eventVersionId: hydrated.eventVersion._id,
    sourceAccountId: hydrated.sourceAccount._id,
    sourceItemId: hydrated.sourceItem._id,
    sourceRevisionId: hydrated.sourceRevision._id,
    entityId: hydrated.entity._id,
    eventType: hydrated.eventVersion.eventType,
    occurrence: hydrated.eventVersion.occurrence,
    citations: projectCitations(hydrated),
    originalLinkAvailable: hydrated.sourceItem.originalLinkAvailable,
  };
}

function projectObservation(
  hydrated: HydratedObservation,
): ExactObservationResult {
  return {
    ...projectEvent(hydrated),
    observationId: hydrated.observation._id,
    observationKey: hydrated.observation.observationKey,
    observationType: hydrated.observation.observationType,
    value: hydrated.observation.value,
  };
}

function valueMatchesUnit(
  value: Doc<"observations">["value"],
  unitCode: string | undefined,
) {
  if (unitCode === undefined) return true;
  return (
    (value.type === "decimal" || value.type === "integer") &&
    value.unitCode === unitCode
  );
}

function dateAt(time: number) {
  return new Date(time).toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number) {
  const shifted = Math.max(
    MIN_QUERY_TIME,
    Math.min(
      MAX_QUERY_TIME,
      Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000,
    ),
  );
  return dateAt(shifted);
}

function inRange(
  occurrence: Doc<"eventVersions">["occurrence"],
  from: number,
  to: number,
): "in" | "out" | "ambiguous" {
  if (occurrence.precision === "unknown") return "out";
  if (occurrence.precision === "datetime") {
    return occurrence.instant >= from && occurrence.instant < to ? "in" : "out";
  }
  const midnight = Date.parse(`${occurrence.date}T00:00:00.000Z`);
  const earliest = midnight - MAX_DATE_OFFSET_MS;
  const latestExclusive = midnight + 86_400_000 + MAX_DATE_OFFSET_MS;
  if (earliest >= from && latestExclusive <= to) return "in";
  return earliest < to && latestExclusive > from ? "ambiguous" : "out";
}

function atOrBefore(
  occurrence: Doc<"eventVersions">["occurrence"],
  asOf: number,
): "in" | "out" | "ambiguous" {
  if (occurrence.precision === "unknown") return "out";
  if (occurrence.precision === "datetime") {
    return occurrence.instant <= asOf ? "in" : "out";
  }
  const midnight = Date.parse(`${occurrence.date}T00:00:00.000Z`);
  const earliest = midnight - MAX_DATE_OFFSET_MS;
  const latestExclusive = midnight + 86_400_000 + MAX_DATE_OFFSET_MS;
  if (latestExclusive <= asOf) return "in";
  return earliest <= asOf ? "ambiguous" : "out";
}

function emptyExclusions(): Exclusions {
  return {
    undated: 0,
    ambiguousTime: 0,
    invalid: 0,
    unsupportedValue: 0,
    overflow: false,
  };
}

function newHydrationBudget(): RecordHydrationCache {
  return createRecordHydrationCache({
    maxLoadedUtf8Bytes: MAX_HYDRATION_READ_BYTES,
    maxEvidenceQuoteUtf8Bytes: MAX_HYDRATION_EVIDENCE_BYTES,
  });
}

function isHydrationBudgetError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.startsWith("Record hydration exceeds the global") ||
      error.message === "Record hydration budget is exhausted")
  );
}

function tupleFor(
  row: Doc<"eventVersions"> | Doc<"observations">,
): RecordQueryCursorTuple {
  if (
    row.occurrence.precision === "unknown" ||
    row.occurrenceDate === undefined ||
    row.occurrenceSortKey === undefined
  ) {
    throw new Error("Dated record has invalid occurrence cursor fields");
  }
  return {
    occurrenceDate: row.occurrenceDate,
    occurrencePrecision: row.occurrence.precision,
    ...(row.occurrence.precision === "datetime"
      ? { occurrenceInstant: row.occurrence.instant }
      : {}),
    sortKey: row.occurrenceSortKey,
    stableId: row._id,
  };
}

async function candidateVisibility(
  ctx: MutationCtx,
  row: Doc<"eventVersions"> | Doc<"observations">,
  snapshotAt: number,
  sourceAccountIds: readonly Id<"sourceAccounts">[],
): Promise<"visible" | "skip" | "invalid"> {
  if (!sourceAccountIds.includes(row.sourceAccountId)) return "skip";
  const generation = await ctx.db.get(row.processingGenerationId);
  if (
    !generation ||
    generation.spaceId !== row.spaceId ||
    generation.sourceAccountId !== row.sourceAccountId ||
    generation.sourceItemId !== row.sourceItemId
  ) {
    return "invalid";
  }
  if (
    generation.activatedAt === undefined ||
    generation.activatedAt > snapshotAt ||
    (generation.deactivatedAt !== undefined &&
      snapshotAt >= generation.deactivatedAt)
  ) {
    return "skip";
  }
  const item = await ctx.db.get(row.sourceItemId);
  if (!item || item.spaceId !== row.spaceId) return "invalid";
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    return "skip";
  }
  return "visible";
}

function terminalComplete(coverage: QueryCoverage, exclusions: Exclusions) {
  return (
    coverage.state === "complete" &&
    !coverage.overflow &&
    coverage.pendingJobs === 0 &&
    coverage.failedJobs === 0 &&
    exclusions.invalid === 0 &&
    exclusions.ambiguousTime === 0 &&
    exclusions.unsupportedValue === 0 &&
    !exclusions.overflow
  );
}

function matchStatus(hasMatch: boolean, complete: boolean) {
  if (hasMatch) return "match" as const;
  return complete
    ? ("no_match_complete" as const)
    : ("no_match_incomplete" as const);
}

async function coverageFor(
  ctx: MutationCtx,
  args: {
    sourceAccountIds: Id<"sourceAccounts">[];
    recordType: string;
    entityId?: Id<"entities">;
    from: number;
    to: number;
    now: number;
    snapshotAt: number;
  },
) {
  return await calculateCoverage(ctx, {
    sourceAccountIds: args.sourceAccountIds,
    recordType: args.recordType,
    ...(args.entityId === undefined ? {} : { entityId: args.entityId }),
    from: args.from,
    to: args.to,
    asOf: args.now,
    snapshotAt: args.snapshotAt,
  });
}

async function countUndatedObservations(
  ctx: MutationCtx,
  args: {
    query: LatestObservationQuery | ObservationHistoryQuery | SumMoneyQuery;
    scope: QueryScope;
    snapshotAt: number;
    budget: RecordHydrationCache;
  },
) {
  const observationType =
    args.query.operation === "sum_money"
      ? validateQueryType(args.query.lineItemType, "lineItemType")
      : validateQueryType(args.query.observationType, "observationType");
  const accountScope =
    args.query.operation === "sum_money" && !args.query.entityId
      ? args.query.sourceAccountId
      : undefined;
  const rows = accountScope
    ? await ctx.db
        .query("observations")
        .withIndex("by_sourceAccount_type_precision", (q) =>
          q
            .eq("sourceAccountId", accountScope)
            .eq("observationType", observationType)
            .eq("occurrence.precision", "unknown"),
        )
        .take(MAX_UNDATED_SCAN_ROWS + 1)
    : await ctx.db
        .query("observations")
        .withIndex("by_space_entity_type_precision_date", (q) =>
          q
            .eq("spaceId", args.query.spaceId)
            .eq("entityId", args.query.entityId!)
            .eq("observationType", observationType)
            .eq("occurrence.precision", "unknown"),
        )
        .take(MAX_UNDATED_SCAN_ROWS + 1);
  let count = 0;
  let invalid = 0;
  let budgetExceeded = false;
  for (const row of rows.slice(0, MAX_UNDATED_SCAN_ROWS)) {
    try {
      const visibility = await candidateVisibility(
        ctx,
        row,
        args.snapshotAt,
        args.scope.sourceAccountIds,
      );
      if (visibility === "skip") continue;
      if (visibility === "invalid") {
        invalid += 1;
        continue;
      }
      await hydrateObservation(ctx, {
        spaceId: args.query.spaceId,
        observationId: row._id,
        snapshot: args.snapshotAt,
        sourceAccountIds: args.scope.sourceAccountIds,
        cache: args.budget,
      });
      count += 1;
    } catch (error) {
      if (isHydrationBudgetError(error)) {
        budgetExceeded = true;
        break;
      }
      invalid += 1;
    }
  }
  return {
    count,
    invalid,
    overflow: rows.length > MAX_UNDATED_SCAN_ROWS || budgetExceeded,
  };
}

async function countUndatedEvents(
  ctx: MutationCtx,
  args: {
    query: LatestEventQuery | ListEventsQuery;
    scope: QueryScope;
    snapshotAt: number;
    budget: RecordHydrationCache;
  },
) {
  const rows = await ctx.db
    .query("eventVersions")
    .withIndex("by_space_entity_type_precision_date", (q) =>
      q
        .eq("spaceId", args.query.spaceId)
        .eq("entityId", args.query.entityId)
        .eq("eventType", eventType(args.query.eventType))
        .eq("occurrence.precision", "unknown"),
    )
    .take(MAX_UNDATED_SCAN_ROWS + 1);
  let count = 0;
  let invalid = 0;
  let budgetExceeded = false;
  for (const row of rows.slice(0, MAX_UNDATED_SCAN_ROWS)) {
    try {
      const visibility = await candidateVisibility(
        ctx,
        row,
        args.snapshotAt,
        args.scope.sourceAccountIds,
      );
      if (visibility === "skip") continue;
      if (visibility === "invalid") {
        invalid += 1;
        continue;
      }
      await hydrateEventVersion(ctx, {
        spaceId: args.query.spaceId,
        eventVersionId: row._id,
        snapshot: args.snapshotAt,
        sourceAccountIds: args.scope.sourceAccountIds,
        cache: args.budget,
      });
      count += 1;
    } catch (error) {
      if (isHydrationBudgetError(error)) {
        budgetExceeded = true;
        break;
      }
      invalid += 1;
    }
  }
  return {
    count,
    invalid,
    overflow: rows.length > MAX_UNDATED_SCAN_ROWS || budgetExceeded,
  };
}

async function beginOrResume(
  ctx: MutationCtx,
  args: {
    principal: Principal | PrincipalRef;
    query: ObservationHistoryQuery | ListEventsQuery | SumMoneyQuery;
    now: number;
  },
) {
  const scope = await resolveQueryScope(ctx, args.principal, args.query);
  const filter = normalizedFilter(args.query, scope);
  const cursor = args.query.cursor;
  if (cursor === undefined) {
    const epochs = await beginRecordQuerySnapshot(
      ctx,
      args.query.spaceId,
      args.now,
    );
    return {
      scope,
      filter,
      session: undefined,
      snapshot: {
        ...epochs,
        consistency: args.query.consistency ?? "snapshot",
      } satisfies Snapshot,
    };
  }
  const session = await ctx.db.get(cursor);
  const invalid = (): never => {
    throw new Error("Record query cursor is invalid; restart the query");
  };
  if (!session) {
    throw new Error("Record query cursor is invalid; restart the query");
  }
  if (
    session.operation !== args.query.operation ||
    session.spaceId !== args.query.spaceId ||
    session.userId !== scope.principal.userId ||
    session.credentialId !== scope.principal.credentialId ||
    session.membershipId !== scope.membership._id ||
    session.authorizationSignature !== scope.authorizationSignature ||
    session.normalizedFilter !== filter ||
    JSON.stringify(session.sourceAccountIds) !==
      JSON.stringify(scope.sourceAccountIds) ||
    args.now >= session.expiresAt
  ) {
    invalid();
  }
  const epochs = await getRecordQueryEpochs(ctx, args.query.spaceId, args.now);
  if (
    epochs.visibilityEpoch !== session.visibilityEpoch ||
    (session.consistency === "current" &&
      epochs.activationEpoch !== session.activationEpoch)
  ) {
    invalid();
  }
  return {
    scope,
    filter,
    session,
    snapshot: {
      snapshotAt: session.snapshotAt,
      activationEpoch: session.activationEpoch,
      visibilityEpoch: session.visibilityEpoch,
      consistency: session.consistency,
    } satisfies Snapshot,
  };
}

async function finishCursor(
  ctx: MutationCtx,
  args: {
    scope: QueryScope;
    filter: string;
    session?: Doc<"recordQuerySessions">;
    snapshot: Snapshot;
    operation: "observation_history" | "list_events" | "sum_money";
    lastTuple: RecordQueryCursorTuple;
    totals: CurrencyTotal[];
    exclusions: Exclusions;
    processedRows: number;
    now: number;
    partial: boolean;
  },
) {
  if (!args.partial) {
    if (args.session) await consumeRecordQuerySession(ctx, args.session._id);
    return undefined;
  }
  if (args.session) {
    return await advanceRecordQuerySession(ctx, args.session, {
      lastTuple: args.lastTuple,
      totals: args.totals,
      invalidRows: args.exclusions.invalid,
      ambiguousTimeRows: args.exclusions.ambiguousTime,
      unsupportedValueRows: args.exclusions.unsupportedValue,
      readOverflow: args.exclusions.overflow,
      processedRows: args.processedRows,
      now: args.now,
    });
  }
  return await createRecordQuerySession(ctx, {
    spaceId: args.scope.membership.spaceId,
    userId: args.scope.principal.userId,
    ...(args.scope.principal.credentialId
      ? { credentialId: args.scope.principal.credentialId }
      : {}),
    membershipId: args.scope.membership._id,
    authorizationSignature: args.scope.authorizationSignature,
    operation: args.operation,
    consistency: args.snapshot.consistency,
    normalizedFilter: args.filter,
    sourceAccountIds: args.scope.sourceAccountIds,
    snapshotAt: args.snapshot.snapshotAt,
    activationEpoch: args.snapshot.activationEpoch,
    visibilityEpoch: args.snapshot.visibilityEpoch,
    lastTuple: args.lastTuple,
    totals: args.totals,
    invalidRows: args.exclusions.invalid,
    ambiguousTimeRows: args.exclusions.ambiguousTime,
    unsupportedValueRows: args.exclusions.unsupportedValue,
    readOverflow: args.exclusions.overflow,
    processedRows: args.processedRows,
    now: args.now,
  });
}

function resultWouldFit(existing: unknown[], next: unknown) {
  return utf8Length(JSON.stringify([...existing, next])) <= MAX_RESULT_BYTES;
}

async function latestObservation(
  ctx: MutationCtx,
  principal: Principal | PrincipalRef,
  query: LatestObservationQuery,
  now: number,
): Promise<RecordQueryResult> {
  if (query.asOf !== undefined) requireOccurrenceTime(query.asOf, "asOf");
  const scope = await resolveQueryScope(ctx, principal, query);
  normalizedFilter(query, scope);
  const snapshot = await beginRecordQuerySnapshot(ctx, query.spaceId, now);
  const observationType = validateQueryType(
    query.observationType,
    "observationType",
  );
  const unitCode = validateOptionalUnitCode(query.unitCode);
  const asOf = query.asOf ?? snapshot.snapshotAt;
  const budget = newHydrationBudget();
  const [dateRows, datetimeRows] = await Promise.all([
    ctx.db
      .query("observations")
      .withIndex("by_space_entity_type_precision_date", (q) =>
        q
          .eq("spaceId", query.spaceId)
          .eq("entityId", query.entityId)
          .eq("observationType", observationType)
          .eq("occurrence.precision", "date")
          .lte(
            "occurrenceDate",
            dateAt(Math.min(MAX_QUERY_TIME, asOf + MAX_DATE_OFFSET_MS)),
          ),
      )
      .order("desc")
      .take(MAX_QUERY_SCAN_ROWS + 1),
    ctx.db
      .query("observations")
      .withIndex("by_space_entity_type_instant", (q) =>
        q
          .eq("spaceId", query.spaceId)
          .eq("entityId", query.entityId)
          .eq("observationType", observationType)
          .lte("occurrenceInstant", asOf),
      )
      .order("desc")
      .take(MAX_QUERY_SCAN_ROWS + 1),
  ]);
  const exclusions = emptyExclusions();
  exclusions.overflow =
    dateRows.length > MAX_QUERY_SCAN_ROWS ||
    datetimeRows.length > MAX_QUERY_SCAN_ROWS;
  const hydrated: HydratedObservation[] = [];
  const seen = new Set<string>();
  for (const row of [
    ...dateRows.slice(0, MAX_QUERY_SCAN_ROWS),
    ...datetimeRows.slice(0, MAX_QUERY_SCAN_ROWS),
  ]) {
    if (seen.has(row._id)) continue;
    seen.add(row._id);
    try {
      const visibility = await candidateVisibility(
        ctx,
        row,
        snapshot.snapshotAt,
        scope.sourceAccountIds,
      );
      if (visibility === "skip") continue;
      if (visibility === "invalid") {
        exclusions.invalid += 1;
        continue;
      }
      const item = await hydrateObservation(ctx, {
        spaceId: query.spaceId,
        observationId: row._id,
        snapshot: snapshot.snapshotAt,
        sourceAccountIds: scope.sourceAccountIds,
        cache: budget,
      });
      const timeState = atOrBefore(item.observation.occurrence, asOf);
      if (timeState === "ambiguous") exclusions.ambiguousTime += 1;
      if (
        timeState === "in" &&
        valueMatchesUnit(item.observation.value, unitCode)
      ) {
        hydrated.push(item);
      }
    } catch (error) {
      if (isHydrationBudgetError(error)) {
        exclusions.overflow = true;
        break;
      }
      exclusions.invalid += 1;
    }
  }
  const selected = selectLatestOccurrences(
    hydrated,
    (item) => item.observation.occurrence,
    (item) => item.observation._id,
  );
  const candidates: ExactObservationResult[] = [];
  for (const item of selected.candidates) {
    const projected = projectObservation(item);
    if (!resultWouldFit(candidates, projected)) {
      exclusions.overflow = true;
      break;
    }
    candidates.push(projected);
  }
  const undated = await countUndatedObservations(ctx, {
    query,
    scope,
    snapshotAt: snapshot.snapshotAt,
    budget,
  });
  exclusions.undated = undated.count;
  exclusions.invalid += undated.invalid;
  exclusions.overflow ||= undated.overflow;
  const coverage = await coverageFor(ctx, {
    sourceAccountIds: scope.sourceAccountIds,
    recordType: observationType,
    entityId: query.entityId,
    from: MIN_QUERY_TIME,
    to: Math.min(asOf + 1, MAX_QUERY_TIME),
    now,
    snapshotAt: snapshot.snapshotAt,
  });
  const complete =
    terminalComplete(coverage, exclusions) && exclusions.undated === 0;
  return {
    operation: query.operation,
    status: matchStatus(candidates.length > 0, complete),
    candidates,
    snapshotAt: snapshot.snapshotAt,
    consistency: query.consistency ?? "snapshot",
    sourceAccountIds: scope.sourceAccountIds,
    coverage,
    exclusions,
    complete,
  };
}

async function latestEvent(
  ctx: MutationCtx,
  principal: Principal | PrincipalRef,
  query: LatestEventQuery,
  now: number,
): Promise<RecordQueryResult> {
  if (query.asOf !== undefined) requireOccurrenceTime(query.asOf, "asOf");
  const scope = await resolveQueryScope(ctx, principal, query);
  normalizedFilter(query, scope);
  const snapshot = await beginRecordQuerySnapshot(ctx, query.spaceId, now);
  const type = eventType(query.eventType);
  const asOf = query.asOf ?? snapshot.snapshotAt;
  const budget = newHydrationBudget();
  const [dateRows, datetimeRows] = await Promise.all([
    ctx.db
      .query("eventVersions")
      .withIndex("by_space_entity_type_precision_date", (q) =>
        q
          .eq("spaceId", query.spaceId)
          .eq("entityId", query.entityId)
          .eq("eventType", type)
          .eq("occurrence.precision", "date")
          .lte(
            "occurrenceDate",
            dateAt(Math.min(MAX_QUERY_TIME, asOf + MAX_DATE_OFFSET_MS)),
          ),
      )
      .order("desc")
      .take(MAX_QUERY_SCAN_ROWS + 1),
    ctx.db
      .query("eventVersions")
      .withIndex("by_space_entity_type_instant", (q) =>
        q
          .eq("spaceId", query.spaceId)
          .eq("entityId", query.entityId)
          .eq("eventType", type)
          .lte("occurrenceInstant", asOf),
      )
      .order("desc")
      .take(MAX_QUERY_SCAN_ROWS + 1),
  ]);
  const exclusions = emptyExclusions();
  exclusions.overflow =
    dateRows.length > MAX_QUERY_SCAN_ROWS ||
    datetimeRows.length > MAX_QUERY_SCAN_ROWS;
  const hydrated: HydratedEventVersion[] = [];
  const seen = new Set<string>();
  for (const row of [
    ...dateRows.slice(0, MAX_QUERY_SCAN_ROWS),
    ...datetimeRows.slice(0, MAX_QUERY_SCAN_ROWS),
  ]) {
    if (seen.has(row._id)) continue;
    seen.add(row._id);
    try {
      const visibility = await candidateVisibility(
        ctx,
        row,
        snapshot.snapshotAt,
        scope.sourceAccountIds,
      );
      if (visibility === "skip") continue;
      if (visibility === "invalid") {
        exclusions.invalid += 1;
        continue;
      }
      const item = await hydrateEventVersion(ctx, {
        spaceId: query.spaceId,
        eventVersionId: row._id,
        snapshot: snapshot.snapshotAt,
        sourceAccountIds: scope.sourceAccountIds,
        cache: budget,
      });
      const timeState = atOrBefore(item.eventVersion.occurrence, asOf);
      if (timeState === "ambiguous") exclusions.ambiguousTime += 1;
      if (timeState === "in") hydrated.push(item);
    } catch (error) {
      if (isHydrationBudgetError(error)) {
        exclusions.overflow = true;
        break;
      }
      exclusions.invalid += 1;
    }
  }
  const selected = selectLatestOccurrences(
    hydrated,
    (item) => item.eventVersion.occurrence,
    (item) => item.eventVersion._id,
  );
  const candidates: ExactEventResult[] = [];
  for (const item of selected.candidates) {
    const projected = projectEvent(item);
    if (!resultWouldFit(candidates, projected)) {
      exclusions.overflow = true;
      break;
    }
    candidates.push(projected);
  }
  const undated = await countUndatedEvents(ctx, {
    query,
    scope,
    snapshotAt: snapshot.snapshotAt,
    budget,
  });
  exclusions.undated = undated.count;
  exclusions.invalid += undated.invalid;
  exclusions.overflow ||= undated.overflow;
  const coverage = await coverageFor(ctx, {
    sourceAccountIds: scope.sourceAccountIds,
    recordType: type,
    entityId: query.entityId,
    from: MIN_QUERY_TIME,
    to: Math.min(asOf + 1, MAX_QUERY_TIME),
    now,
    snapshotAt: snapshot.snapshotAt,
  });
  const complete =
    terminalComplete(coverage, exclusions) && exclusions.undated === 0;
  return {
    operation: query.operation,
    status: matchStatus(candidates.length > 0, complete),
    candidates,
    snapshotAt: snapshot.snapshotAt,
    consistency: query.consistency ?? "snapshot",
    sourceAccountIds: scope.sourceAccountIds,
    coverage,
    exclusions,
    complete,
  };
}

async function observationHistory(
  ctx: MutationCtx,
  principal: Principal | PrincipalRef,
  query: ObservationHistoryQuery,
  now: number,
): Promise<RecordQueryResult> {
  requireRange(query.from, query.to);
  const state = await beginOrResume(ctx, { principal, query, now });
  const observationType = validateQueryType(
    query.observationType,
    "observationType",
  );
  const unitCode = validateOptionalUnitCode(query.unitCode);
  const lower = `${shiftDate(dateAt(query.from), -1)}|`;
  const upper = `${shiftDate(dateAt(query.to), 1)}|\uffff`;
  const cursorKey = state.session?.lastSortKey;
  const rows = await ctx.db
    .query("observations")
    .withIndex("by_space_entity_type_sort", (q) => {
      const prefix = q
        .eq("spaceId", query.spaceId)
        .eq("entityId", query.entityId)
        .eq("observationType", observationType);
      return query.order === "asc"
        ? prefix
            .gt("occurrenceSortKey", cursorKey ?? lower)
            .lt("occurrenceSortKey", upper)
        : prefix
            .gt("occurrenceSortKey", lower)
            .lt("occurrenceSortKey", cursorKey ?? upper);
    })
    .order(query.order)
    .take(MAX_QUERY_SCAN_ROWS + 1);
  const records: ExactObservationResult[] = [];
  const exclusions = emptyExclusions();
  exclusions.invalid = state.session?.invalidRows ?? 0;
  exclusions.ambiguousTime = state.session?.ambiguousTimeRows ?? 0;
  exclusions.unsupportedValue = state.session?.unsupportedValueRows ?? 0;
  exclusions.overflow = state.session?.readOverflow ?? false;
  const budget = newHydrationBudget();
  let lastTuple: RecordQueryCursorTuple | undefined;
  let consumed = 0;
  const limit = queryLimit(query.limit);
  for (const row of rows.slice(0, MAX_QUERY_SCAN_ROWS)) {
    const tuple = tupleFor(row);
    let projected: ExactObservationResult | undefined;
    try {
      const visibility = await candidateVisibility(
        ctx,
        row,
        state.snapshot.snapshotAt,
        state.scope.sourceAccountIds,
      );
      if (visibility === "skip") {
        consumed += 1;
        lastTuple = tuple;
        continue;
      }
      if (visibility === "invalid") {
        exclusions.invalid += 1;
        consumed += 1;
        lastTuple = tuple;
        continue;
      }
      const hydrated = await hydrateObservation(ctx, {
        spaceId: query.spaceId,
        observationId: row._id,
        snapshot: state.snapshot.snapshotAt,
        sourceAccountIds: state.scope.sourceAccountIds,
        cache: budget,
      });
      const timeState = inRange(
        hydrated.observation.occurrence,
        query.from,
        query.to,
      );
      if (timeState === "ambiguous") exclusions.ambiguousTime += 1;
      if (
        timeState === "in" &&
        valueMatchesUnit(hydrated.observation.value, unitCode)
      ) {
        projected = projectObservation(hydrated);
      }
    } catch (error) {
      if (isHydrationBudgetError(error)) break;
      exclusions.invalid += 1;
    }
    if (
      projected &&
      (!resultWouldFit(records, projected) || records.length >= limit)
    )
      break;
    consumed += 1;
    lastTuple = tuple;
    if (projected) records.push(projected);
  }
  const partial = consumed < rows.length;
  if (partial && !lastTuple)
    throw new Error("Record query page exceeds its byte limit");
  const cursorExclusions = { ...exclusions };
  const undated = await countUndatedObservations(ctx, {
    query,
    scope: state.scope,
    snapshotAt: state.snapshot.snapshotAt,
    budget,
  });
  exclusions.undated = undated.count;
  exclusions.invalid += undated.invalid;
  exclusions.overflow ||= undated.overflow;
  const cursor = lastTuple
    ? await finishCursor(ctx, {
        ...state,
        operation: query.operation,
        lastTuple,
        totals: [],
        exclusions: cursorExclusions,
        processedRows: (state.session?.processedRows ?? 0) + consumed,
        now,
        partial,
      })
    : undefined;
  const coverage = await coverageFor(ctx, {
    sourceAccountIds: state.scope.sourceAccountIds,
    recordType: observationType,
    entityId: query.entityId,
    from: query.from,
    to: query.to,
    now,
    snapshotAt: state.snapshot.snapshotAt,
  });
  const complete =
    !partial &&
    terminalComplete(coverage, exclusions) &&
    exclusions.undated === 0;
  return {
    operation: query.operation,
    status: matchStatus(records.length > 0, complete),
    records,
    ...(cursor ? { cursor } : {}),
    snapshotAt: state.snapshot.snapshotAt,
    consistency: state.snapshot.consistency,
    sourceAccountIds: state.scope.sourceAccountIds,
    coverage,
    exclusions,
    complete,
  };
}

async function listEvents(
  ctx: MutationCtx,
  principal: Principal | PrincipalRef,
  query: ListEventsQuery,
  now: number,
): Promise<RecordQueryResult> {
  requireRange(query.from, query.to);
  const state = await beginOrResume(ctx, { principal, query, now });
  const type = eventType(query.eventType);
  const lower = `${shiftDate(dateAt(query.from), -1)}|`;
  const upper = `${shiftDate(dateAt(query.to), 1)}|\uffff`;
  const cursorKey = state.session?.lastSortKey;
  const rows = await ctx.db
    .query("eventVersions")
    .withIndex("by_space_entity_type_sort", (q) => {
      const prefix = q
        .eq("spaceId", query.spaceId)
        .eq("entityId", query.entityId)
        .eq("eventType", type);
      return query.order === "asc"
        ? prefix
            .gt("occurrenceSortKey", cursorKey ?? lower)
            .lt("occurrenceSortKey", upper)
        : prefix
            .gt("occurrenceSortKey", lower)
            .lt("occurrenceSortKey", cursorKey ?? upper);
    })
    .order(query.order)
    .take(MAX_QUERY_SCAN_ROWS + 1);
  const records: ExactEventResult[] = [];
  const exclusions = emptyExclusions();
  exclusions.invalid = state.session?.invalidRows ?? 0;
  exclusions.ambiguousTime = state.session?.ambiguousTimeRows ?? 0;
  exclusions.unsupportedValue = state.session?.unsupportedValueRows ?? 0;
  exclusions.overflow = state.session?.readOverflow ?? false;
  const budget = newHydrationBudget();
  let lastTuple: RecordQueryCursorTuple | undefined;
  let consumed = 0;
  const limit = queryLimit(query.limit);
  for (const row of rows.slice(0, MAX_QUERY_SCAN_ROWS)) {
    const tuple = tupleFor(row);
    let projected: ExactEventResult | undefined;
    try {
      const visibility = await candidateVisibility(
        ctx,
        row,
        state.snapshot.snapshotAt,
        state.scope.sourceAccountIds,
      );
      if (visibility === "skip") {
        consumed += 1;
        lastTuple = tuple;
        continue;
      }
      if (visibility === "invalid") {
        exclusions.invalid += 1;
        consumed += 1;
        lastTuple = tuple;
        continue;
      }
      const hydrated = await hydrateEventVersion(ctx, {
        spaceId: query.spaceId,
        eventVersionId: row._id,
        snapshot: state.snapshot.snapshotAt,
        sourceAccountIds: state.scope.sourceAccountIds,
        cache: budget,
      });
      const timeState = inRange(
        hydrated.eventVersion.occurrence,
        query.from,
        query.to,
      );
      if (timeState === "ambiguous") exclusions.ambiguousTime += 1;
      if (timeState === "in") projected = projectEvent(hydrated);
    } catch (error) {
      if (isHydrationBudgetError(error)) break;
      exclusions.invalid += 1;
    }
    if (
      projected &&
      (!resultWouldFit(records, projected) || records.length >= limit)
    )
      break;
    consumed += 1;
    lastTuple = tuple;
    if (projected) records.push(projected);
  }
  const partial = consumed < rows.length;
  if (partial && !lastTuple)
    throw new Error("Record query page exceeds its byte limit");
  const cursorExclusions = { ...exclusions };
  const undated = await countUndatedEvents(ctx, {
    query,
    scope: state.scope,
    snapshotAt: state.snapshot.snapshotAt,
    budget,
  });
  exclusions.undated = undated.count;
  exclusions.invalid += undated.invalid;
  exclusions.overflow ||= undated.overflow;
  const cursor = lastTuple
    ? await finishCursor(ctx, {
        ...state,
        operation: query.operation,
        lastTuple,
        totals: [],
        exclusions: cursorExclusions,
        processedRows: (state.session?.processedRows ?? 0) + consumed,
        now,
        partial,
      })
    : undefined;
  const coverage = await coverageFor(ctx, {
    sourceAccountIds: state.scope.sourceAccountIds,
    recordType: type,
    entityId: query.entityId,
    from: query.from,
    to: query.to,
    now,
    snapshotAt: state.snapshot.snapshotAt,
  });
  const complete =
    !partial &&
    terminalComplete(coverage, exclusions) &&
    exclusions.undated === 0;
  return {
    operation: query.operation,
    status: matchStatus(records.length > 0, complete),
    records,
    ...(cursor ? { cursor } : {}),
    snapshotAt: state.snapshot.snapshotAt,
    consistency: state.snapshot.consistency,
    sourceAccountIds: state.scope.sourceAccountIds,
    coverage,
    exclusions,
    complete,
  };
}

async function sumMoney(
  ctx: MutationCtx,
  principal: Principal | PrincipalRef,
  query: SumMoneyQuery,
  now: number,
): Promise<RecordQueryResult> {
  requireRange(query.from, query.to);
  if (
    (query.entityId === undefined) ===
    (query.sourceAccountId === undefined)
  ) {
    throw new Error(
      "sum_money requires exactly one entityId or sourceAccountId",
    );
  }
  const state = await beginOrResume(ctx, { principal, query, now });
  const lineItemType = validateQueryType(query.lineItemType, "lineItemType");
  const lower = `${shiftDate(dateAt(query.from), -1)}|`;
  const upper = `${shiftDate(dateAt(query.to), 1)}|\uffff`;
  const cursorKey = state.session?.lastSortKey;
  let candidateQuery;
  if (query.entityId) {
    candidateQuery = ctx.db
      .query("observations")
      .withIndex("by_space_entity_type_sort", (q) => {
        const prefix = q
          .eq("spaceId", query.spaceId)
          .eq("entityId", query.entityId!)
          .eq("observationType", lineItemType);
        return prefix
          .gt("occurrenceSortKey", cursorKey ?? lower)
          .lt("occurrenceSortKey", upper);
      });
  } else {
    candidateQuery = ctx.db
      .query("observations")
      .withIndex("by_sourceAccount_type_sort", (q) =>
        q
          .eq("sourceAccountId", query.sourceAccountId!)
          .eq("observationType", lineItemType)
          .gt("occurrenceSortKey", cursorKey ?? lower)
          .lt("occurrenceSortKey", upper),
      );
  }
  const loadedRows = await candidateQuery.take(MAX_AGGREGATION_PAGE_ROWS + 1);
  const totals = new Map<string, string>(
    (state.session?.totals ?? []).map((total) => [
      total.currency,
      total.amount,
    ]),
  );
  const contributingObservationIds: Id<"observations">[] = [];
  const contributions: ExactObservationResult[] = [];
  const exclusions = emptyExclusions();
  exclusions.invalid = state.session?.invalidRows ?? 0;
  exclusions.ambiguousTime = state.session?.ambiguousTimeRows ?? 0;
  exclusions.unsupportedValue = state.session?.unsupportedValueRows ?? 0;
  exclusions.overflow = state.session?.readOverflow ?? false;
  const budget = newHydrationBudget();
  let lastTuple: RecordQueryCursorTuple | undefined;
  let consumed = 0;
  for (const row of loadedRows.slice(0, MAX_AGGREGATION_PAGE_ROWS)) {
    const previousTuple = lastTuple;
    lastTuple = tupleFor(row);
    consumed += 1;
    try {
      const visibility = await candidateVisibility(
        ctx,
        row,
        state.snapshot.snapshotAt,
        state.scope.sourceAccountIds,
      );
      if (visibility === "skip") continue;
      if (visibility === "invalid") {
        exclusions.invalid += 1;
        continue;
      }
      const hydrated = await hydrateObservation(ctx, {
        spaceId: query.spaceId,
        observationId: row._id,
        snapshot: state.snapshot.snapshotAt,
        sourceAccountIds: state.scope.sourceAccountIds,
        cache: budget,
      });
      const timeState = inRange(
        hydrated.observation.occurrence,
        query.from,
        query.to,
      );
      if (timeState === "ambiguous") {
        exclusions.ambiguousTime += 1;
        continue;
      }
      if (timeState !== "in") continue;
      if (hydrated.observation.value.type !== "money") {
        exclusions.unsupportedValue += 1;
        continue;
      }
      const currency = validateCurrencyCode(
        hydrated.observation.value.currency,
      );
      const amount = canonicalizeDecimal(hydrated.observation.value.amount);
      const projected = projectObservation(hydrated);
      if (!resultWouldFit(contributions, projected)) {
        lastTuple = previousTuple;
        consumed -= 1;
        if (contributions.length === 0) {
          throw new Error(
            "Money contribution exceeds the query result byte limit",
          );
        }
        break;
      }
      totals.set(currency, addDecimals(totals.get(currency) ?? "0", amount));
      contributingObservationIds.push(row._id);
      contributions.push(projected);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "Money contribution exceeds the query result byte limit"
      ) {
        throw error;
      }
      if (isHydrationBudgetError(error)) {
        lastTuple = previousTuple;
        consumed -= 1;
        break;
      }
      exclusions.invalid += 1;
    }
  }
  const partial = consumed < loadedRows.length;
  const sortedTotals = [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount }));
  if (partial && !lastTuple)
    throw new Error("Record query scan cannot advance");
  const cursorExclusions = { ...exclusions };
  const undated = await countUndatedObservations(ctx, {
    query,
    scope: state.scope,
    snapshotAt: state.snapshot.snapshotAt,
    budget,
  });
  exclusions.undated = undated.count;
  exclusions.invalid += undated.invalid;
  exclusions.overflow ||= undated.overflow;
  const cursor = lastTuple
    ? await finishCursor(ctx, {
        ...state,
        operation: query.operation,
        lastTuple,
        totals: sortedTotals,
        exclusions: cursorExclusions,
        processedRows: (state.session?.processedRows ?? 0) + consumed,
        now,
        partial,
      })
    : undefined;
  const coverage = await coverageFor(ctx, {
    sourceAccountIds: state.scope.sourceAccountIds,
    recordType: lineItemType,
    ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
    from: query.from,
    to: query.to,
    now,
    snapshotAt: state.snapshot.snapshotAt,
  });
  const complete =
    !partial &&
    terminalComplete(coverage, exclusions) &&
    exclusions.undated === 0;
  const status = partial
    ? "total_partial"
    : sortedTotals.length > 0
      ? complete
        ? "total_complete"
        : "total_partial"
      : complete
        ? "no_match_complete"
        : "no_match_incomplete";
  return {
    operation: query.operation,
    status,
    totals: sortedTotals,
    contributions,
    contributingObservationIds,
    ...(cursor ? { cursor } : {}),
    snapshotAt: state.snapshot.snapshotAt,
    consistency: state.snapshot.consistency,
    sourceAccountIds: state.scope.sourceAccountIds,
    coverage,
    exclusions,
    complete,
  };
}

export async function executeRecordQuery(
  ctx: MutationCtx,
  args: {
    principal: Principal | PrincipalRef;
    query: RecordQuery;
    now: number;
  },
): Promise<RecordQueryResult> {
  requirePublicationTime(args.now, "now");
  switch (args.query.operation) {
    case "latest_observation":
      return await latestObservation(ctx, args.principal, args.query, args.now);
    case "observation_history":
      return await observationHistory(
        ctx,
        args.principal,
        args.query,
        args.now,
      );
    case "latest_event":
      return await latestEvent(ctx, args.principal, args.query, args.now);
    case "list_events":
      return await listEvents(ctx, args.principal, args.query, args.now);
    case "sum_money":
      return await sumMoney(ctx, args.principal, args.query, args.now);
  }
}
