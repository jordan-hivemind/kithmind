import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { sha256Utf8 } from "../provenance/model";
import {
  requireInlineSourceRevision,
  requireInlineSourceTextVersion,
} from "../provenance/representations";

import {
  isCardRecordKind,
  requireCardEventSchema,
  requireCardObservationSchema,
} from "./cardSchemas";
import type { ObservationValue, Occurrence } from "./values";
import {
  canonicalizeObservationValue,
  occurrenceCalendarDate,
  validateOccurrence,
} from "./values";
import type {
  RecordEventType,
  StageRecordBatchInput,
  StagedEventRecord,
  StagedObservation,
} from "./validators";

export const MAX_EVENTS_PER_GENERATION = 32;
export const MAX_OBSERVATIONS_PER_GENERATION = 128;
export const MAX_RECORD_STAGE_ROWS = 25;
export const MAX_RECORD_STAGE_UTF8_BYTES = 128 * 1_024;
export const MAX_FIELD_EVIDENCE_SPANS = 16;
export const MAX_HYDRATED_EVIDENCE_SPANS = 64;
export const MAX_HYDRATED_EVIDENCE_UTF8_BYTES = 16 * 1_024;
export const MAX_RECORD_CLEANUP_ROWS = 25;

const MAX_EVENT_KEY_UTF8_BYTES = 512;
const MAX_OBSERVATION_KEY_UTF8_BYTES = 512;
const MAX_GENERATION_EVIDENCE_REFERENCES =
  MAX_EVENTS_PER_GENERATION * MAX_FIELD_EVIDENCE_SPANS * 3 +
  MAX_OBSERVATIONS_PER_GENERATION * MAX_FIELD_EVIDENCE_SPANS;
const MAX_GENERATION_EVIDENCE_UTF8_BYTES = 128 * 1_024;
const OBSERVATION_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

type GenerationChain = {
  space: Doc<"spaces">;
  sourceAccount: Doc<"sourceAccounts">;
  sourceItem: Doc<"sourceItems">;
  sourceRevision: Doc<"sourceRevisions">;
  sourceTextVersion: Doc<"sourceTextVersions">;
  sourceRevisionText: string;
  sourceText: string;
  generation: Doc<"processingGenerations">;
};

export type RecordHydrationCache = {
  generationChains: Map<string, GenerationChain>;
  evidenceByGeneration: Map<string, EvidenceValidationCache>;
  loadedUtf8Bytes: number;
  evidenceQuoteUtf8Bytes: number;
  maxLoadedUtf8Bytes: number;
  maxEvidenceQuoteUtf8Bytes: number;
  exhausted: boolean;
};

type EvidenceValidationCache = {
  spans: Map<string, Doc<"evidenceSpans">>;
  pages: Map<string, Doc<"sourcePages">>;
  quotes: Map<string, string>;
  validatedPageIds: Set<string>;
  validatedSpanIds: Set<string>;
  quoteUtf8Bytes: number;
  maxQuoteUtf8Bytes: number;
  hydrationCache?: RecordHydrationCache;
};

export type StageRecordBatchResult = {
  eventIds: Id<"events">[];
  eventVersionIds: Id<"eventVersions">[];
  observationIds: Id<"observations">[];
  insertedEventCount: number;
  insertedEventVersionCount: number;
  insertedObservationCount: number;
};

export type ValidatedGenerationRecords = {
  eventVersions: Doc<"eventVersions">[];
  observations: Doc<"observations">[];
  evidenceSpanCount: number;
  evidenceReferenceCount: number;
};

export type RecordHydrationScope = {
  spaceId: Id<"spaces">;
  snapshot?: number;
  sourceAccountIds?: readonly Id<"sourceAccounts">[];
  cache?: RecordHydrationCache;
};

export type HydratedEventVersion = GenerationChain & {
  event: Doc<"events">;
  eventVersion: Doc<"eventVersions">;
  entity: Doc<"entities">;
  evidenceSpans: Doc<"evidenceSpans">[];
  evidence: HydratedEvidence[];
};

export type HydratedEvidence = {
  span: Doc<"evidenceSpans">;
  quote: string;
};

export type HydratedObservation = HydratedEventVersion & {
  observation: Doc<"observations">;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function newEvidenceCache(
  spans: readonly Doc<"evidenceSpans">[] = [],
  maxQuoteUtf8Bytes = MAX_GENERATION_EVIDENCE_UTF8_BYTES,
  hydrationCache?: RecordHydrationCache,
): EvidenceValidationCache {
  return {
    spans: new Map(spans.map((span) => [span._id, span])),
    pages: new Map(),
    quotes: new Map(),
    validatedPageIds: new Set(),
    validatedSpanIds: new Set(),
    quoteUtf8Bytes: 0,
    maxQuoteUtf8Bytes,
    hydrationCache,
  };
}

export function createRecordHydrationCache(input?: {
  maxLoadedUtf8Bytes?: number;
  maxEvidenceQuoteUtf8Bytes?: number;
}): RecordHydrationCache {
  const maxLoadedUtf8Bytes = input?.maxLoadedUtf8Bytes ?? 256 * 1_024;
  const maxEvidenceQuoteUtf8Bytes =
    input?.maxEvidenceQuoteUtf8Bytes ?? 64 * 1_024;
  requireIntegerInRange(
    maxLoadedUtf8Bytes,
    "Hydration loaded-byte limit",
    1,
    16 * 1_024 * 1_024,
  );
  requireIntegerInRange(
    maxEvidenceQuoteUtf8Bytes,
    "Hydration evidence-byte limit",
    1,
    4 * 1_024 * 1_024,
  );
  return {
    generationChains: new Map(),
    evidenceByGeneration: new Map(),
    loadedUtf8Bytes: 0,
    evidenceQuoteUtf8Bytes: 0,
    maxLoadedUtf8Bytes,
    maxEvidenceQuoteUtf8Bytes,
    exhausted: false,
  };
}

function requireHydrationBudgetOpen(
  cache: RecordHydrationCache | undefined,
): void {
  if (cache?.exhausted) {
    throw new Error("Record hydration budget is exhausted");
  }
}

function reserveLoadedBytes(
  cache: RecordHydrationCache | undefined,
  bytes: number,
): void {
  if (!cache) return;
  requireHydrationBudgetOpen(cache);
  cache.loadedUtf8Bytes += bytes;
  if (cache.loadedUtf8Bytes > cache.maxLoadedUtf8Bytes) {
    cache.exhausted = true;
    throw new Error("Record hydration exceeds the global loaded-byte limit");
  }
}

function reserveEvidenceQuoteBytes(
  cache: RecordHydrationCache | undefined,
  bytes: number,
): void {
  if (!cache) return;
  requireHydrationBudgetOpen(cache);
  cache.evidenceQuoteUtf8Bytes += bytes;
  if (cache.evidenceQuoteUtf8Bytes > cache.maxEvidenceQuoteUtf8Bytes) {
    cache.exhausted = true;
    throw new Error("Record hydration exceeds the global evidence-byte limit");
  }
}

function hydrationEvidenceCache(
  hydrationCache: RecordHydrationCache | undefined,
  processingGenerationId: Id<"processingGenerations">,
): EvidenceValidationCache {
  if (!hydrationCache) {
    return newEvidenceCache([], MAX_HYDRATED_EVIDENCE_UTF8_BYTES);
  }
  const existing = hydrationCache.evidenceByGeneration.get(
    processingGenerationId,
  );
  if (existing) return existing;
  const created = newEvidenceCache(
    [],
    hydrationCache.maxEvidenceQuoteUtf8Bytes,
    hydrationCache,
  );
  hydrationCache.evidenceByGeneration.set(processingGenerationId, created);
  return created;
}

function requireUtf16Range(
  text: string,
  start: number,
  end: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length
  ) {
    throw new Error(`${label} has invalid UTF-16 offsets`);
  }
  for (const [offset, edge] of [
    [start, "start"],
    [end, "end"],
  ] as const) {
    if (offset === 0 || offset === text.length) continue;
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    if (
      before >= 0xd800 &&
      before <= 0xdbff &&
      after >= 0xdc00 &&
      after <= 0xdfff
    ) {
      throw new Error(`${label} ${edge} splits a UTF-16 surrogate pair`);
    }
  }
}

function requireIntegerInRange(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}

function requireBoundedUtf8(
  value: string,
  label: string,
  maximum: number,
): void {
  const bytes = utf8Length(value);
  if (bytes === 0 || bytes > maximum) {
    throw new Error(`${label} must contain 1-${maximum} UTF-8 bytes`);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameStructuredValue(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    sameIds(leftKeys, rightKeys) &&
    leftKeys.every((key) =>
      sameStructuredValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function requireEvidenceIds(
  ids: readonly Id<"evidenceSpans">[],
  label: string,
): void {
  if (ids.length === 0 || ids.length > MAX_FIELD_EVIDENCE_SPANS) {
    throw new Error(
      `${label} must contain 1-${MAX_FIELD_EVIDENCE_SPANS} evidence spans`,
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate evidence spans`);
  }
}

function requireObservationType(value: string): void {
  if (!OBSERVATION_TYPE_PATTERN.test(value)) {
    throw new Error(
      "Observation type must contain 1-64 lowercase letters, numbers, or underscores",
    );
  }
}

function requireSupportedSchemaVersion(value: number): void {
  if (value !== 1) throw new Error("Only record schema version 1 is supported");
}

function requireObservationSchema(
  eventType: RecordEventType,
  observationType: string,
  observationKey: string,
  value: ObservationValue,
): void {
  requireObservationType(observationType);
  if (isCardRecordKind(eventType)) {
    requireCardObservationSchema(
      eventType,
      observationType,
      observationKey,
      value,
    );
    return;
  }
  if (eventType === "financial_transaction" && value.type !== "money") {
    throw new Error("Financial transaction line items must use money values");
  }
  if (
    eventType === "lab_panel" &&
    !["decimal", "integer", "text", "boolean"].includes(value.type)
  ) {
    throw new Error(
      "Lab panel observations support decimal, integer, text, or boolean values",
    );
  }
}

function requireEventSchema(
  eventType: RecordEventType,
  schemaVersion: number,
  entity: Doc<"entities">,
): void {
  requireSupportedSchemaVersion(schemaVersion);
  if (isCardRecordKind(eventType)) {
    requireCardEventSchema(eventType, entity);
    return;
  }
  if (eventType === "lab_panel" && entity.kind !== "person") {
    throw new Error("Lab panels must belong to a person entity");
  }
  if (eventType === "vehicle_service" && entity.kind !== "other") {
    throw new Error(
      "Vehicle service must belong to an other-kind vehicle entity",
    );
  }
}

async function requireGenerationChain(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  processingGenerationId: Id<"processingGenerations">,
  cache?: RecordHydrationCache,
): Promise<GenerationChain> {
  requireHydrationBudgetOpen(cache);
  const cached = cache?.generationChains.get(processingGenerationId);
  if (cached) {
    if (cached.space._id !== spaceId) {
      throw new Error("Processing generation belongs to another space");
    }
    return cached;
  }
  const generation = await ctx.db.get(processingGenerationId);
  if (!generation) throw new Error("Processing generation does not exist");
  if (generation.spaceId !== spaceId) {
    throw new Error("Processing generation belongs to another space");
  }
  if (!generation.sourceTextVersionId) {
    throw new Error("Processing generation has no immutable text version");
  }
  const [space, sourceAccount, sourceItem, sourceRevision, sourceTextVersion] =
    await Promise.all([
      ctx.db.get(spaceId),
      ctx.db.get(generation.sourceAccountId),
      ctx.db.get(generation.sourceItemId),
      ctx.db.get(generation.sourceRevisionId),
      ctx.db.get(generation.sourceTextVersionId),
    ]);
  if (!space) throw new Error("Record space does not exist");
  if (!sourceAccount || sourceAccount.spaceId !== spaceId) {
    throw new Error("Generation source account belongs to another space");
  }
  if (
    !sourceItem ||
    sourceItem.spaceId !== spaceId ||
    sourceItem.sourceAccountId !== sourceAccount._id
  ) {
    throw new Error("Generation source item parent chain is invalid");
  }
  if (
    !sourceRevision ||
    sourceRevision.spaceId !== spaceId ||
    sourceRevision.sourceItemId !== sourceItem._id
  ) {
    throw new Error("Generation source revision parent chain is invalid");
  }
  if (
    !sourceTextVersion ||
    sourceTextVersion.spaceId !== spaceId ||
    sourceTextVersion.sourceRevisionId !== sourceRevision._id
  ) {
    throw new Error("Generation source text version parent chain is invalid");
  }
  const sourceRevisionText = requireInlineSourceRevision(sourceRevision).text;
  const sourceText = requireInlineSourceTextVersion(sourceTextVersion).text;
  reserveLoadedBytes(
    cache,
    utf8Length(sourceRevisionText) + utf8Length(sourceText),
  );
  const chain = {
    space,
    sourceAccount,
    sourceItem,
    sourceRevision,
    sourceTextVersion,
    sourceRevisionText,
    sourceText,
    generation,
  };
  cache?.generationChains.set(processingGenerationId, chain);
  return chain;
}

async function requireEntity(
  ctx: ReadCtx,
  entityId: Id<"entities">,
  spaceId: Id<"spaces">,
): Promise<Doc<"entities">> {
  const entity = await ctx.db.get(entityId);
  if (!entity) throw new Error("Record entity does not exist");
  if (entity.spaceId !== spaceId) {
    throw new Error("Record entity belongs to another space");
  }
  return entity;
}

async function requireUser(
  ctx: ReadCtx,
  userId: Id<"users">,
  label: string,
): Promise<Doc<"users">> {
  const user = await ctx.db.get(userId);
  if (!user) throw new Error(`${label} does not exist`);
  return user;
}

async function requireEvidence(
  ctx: ReadCtx,
  chain: GenerationChain,
  ids: readonly Id<"evidenceSpans">[],
  label: string,
  cache: EvidenceValidationCache,
): Promise<void> {
  requireEvidenceIds(ids, label);
  for (const id of ids) {
    requireHydrationBudgetOpen(cache.hydrationCache);
    let span = cache.spans.get(id);
    if (!span) {
      span = (await ctx.db.get(id)) ?? undefined;
      if (span) cache.spans.set(id, span);
    }
    if (
      !span ||
      span.spaceId !== chain.space._id ||
      span.sourceRevisionId !== chain.sourceRevision._id ||
      span.sourceTextVersionId !== chain.sourceTextVersion._id
    ) {
      throw new Error(`${label} belongs to another generation text chain`);
    }
    if (cache.validatedSpanIds.has(id)) continue;
    let page = cache.pages.get(span.sourcePageId);
    if (!page) {
      page = (await ctx.db.get(span.sourcePageId)) ?? undefined;
      if (page) {
        reserveLoadedBytes(cache.hydrationCache, utf8Length(page.text));
        cache.pages.set(span.sourcePageId, page);
      }
    }
    if (
      !page ||
      page.spaceId !== chain.space._id ||
      page.sourceTextVersionId !== chain.sourceTextVersion._id
    ) {
      throw new Error(`${label} has an invalid source page parent`);
    }
    if (!cache.validatedPageIds.has(page._id)) {
      requireUtf16Range(
        chain.sourceText,
        page.start,
        page.end,
        `${label} source page`,
      );
      if (chain.sourceText.slice(page.start, page.end) !== page.text) {
        throw new Error(
          `${label} source page text does not match its text version`,
        );
      }
      if ((await sha256Utf8(page.text)) !== page.textHash) {
        throw new Error(`${label} source page hash is invalid`);
      }
      cache.validatedPageIds.add(page._id);
    }
    requireUtf16Range(page.text, span.start, span.end, label);
    const quote = page.text.slice(span.start, span.end);
    if ((await sha256Utf8(quote)) !== span.quoteHash) {
      throw new Error(`${label} quote hash is invalid`);
    }
    const quoteBytes = utf8Length(quote);
    reserveEvidenceQuoteBytes(cache.hydrationCache, quoteBytes);
    cache.quoteUtf8Bytes += quoteBytes;
    if (cache.quoteUtf8Bytes > cache.maxQuoteUtf8Bytes) {
      throw new Error("Validated evidence exceeds the global UTF-8 byte limit");
    }
    cache.quotes.set(id, quote);
    cache.validatedSpanIds.add(id);
  }
}

function evidenceProjection(
  cache: EvidenceValidationCache,
  ids: readonly Id<"evidenceSpans">[],
): HydratedEvidence[] {
  return [...new Set(ids)].map((id) => {
    const span = cache.spans.get(id);
    const quote = cache.quotes.get(id);
    if (!span || quote === undefined) {
      throw new Error("Hydrated evidence was not fully validated");
    }
    return { span, quote };
  });
}

function boundedEvidenceProjection(
  cache: EvidenceValidationCache,
  ids: readonly Id<"evidenceSpans">[],
): HydratedEvidence[] {
  const evidence = evidenceProjection(cache, ids);
  const quoteBytes = evidence.reduce(
    (total, item) => total + utf8Length(item.quote),
    0,
  );
  if (
    evidence.length > MAX_HYDRATED_EVIDENCE_SPANS ||
    quoteBytes > MAX_HYDRATED_EVIDENCE_UTF8_BYTES
  ) {
    throw new Error("Hydrated record evidence exceeds the global limit");
  }
  return evidence;
}

function eventEvidenceIds(
  eventVersion: Doc<"eventVersions">,
): Id<"evidenceSpans">[] {
  return [
    ...eventVersion.fieldEvidence.occurrence,
    ...eventVersion.fieldEvidence.entity,
    ...eventVersion.fieldEvidence.eventType,
  ];
}

function canonicalOccurrenceFields(occurrence: Occurrence): {
  occurrenceDate?: string;
  occurrenceInstant?: number;
} {
  const occurrenceDate = occurrenceCalendarDate(occurrence);
  return {
    ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
    ...(occurrence.precision === "datetime"
      ? { occurrenceInstant: occurrence.instant }
      : {}),
  };
}

function sortableInstant(instant: number): string {
  return (BigInt(instant) + BigInt(Number.MAX_SAFE_INTEGER))
    .toString()
    .padStart(17, "0");
}

function occurrenceSortKey(
  occurrence: Occurrence,
  stableIdentity: string,
): string | undefined {
  const occurrenceDate = occurrenceCalendarDate(occurrence);
  if (occurrenceDate === undefined) return undefined;
  return occurrence.precision === "datetime"
    ? `${occurrenceDate}|1|${sortableInstant(occurrence.instant)}|${stableIdentity}`
    : `${occurrenceDate}|0|${stableIdentity}`;
}

function assertStageBatchBounds(input: StageRecordBatchInput): void {
  if (input.records.length === 0) {
    throw new Error("Record batch must contain at least one event");
  }
  const rowCount = input.records.reduce(
    (total, record) => total + 1 + record.observations.length,
    0,
  );
  if (rowCount > MAX_RECORD_STAGE_ROWS) {
    throw new Error(
      `Record batch exceeds the per-call row limit of ${MAX_RECORD_STAGE_ROWS}`,
    );
  }
  const bytes = utf8Length(JSON.stringify(input.records));
  if (bytes > MAX_RECORD_STAGE_UTF8_BYTES) {
    throw new Error(
      `Record batch exceeds ${MAX_RECORD_STAGE_UTF8_BYTES} UTF-8 bytes`,
    );
  }
}

function assertEventInputShape(record: StagedEventRecord): void {
  requireBoundedUtf8(record.eventKey, "Event key", MAX_EVENT_KEY_UTF8_BYTES);
  requireSupportedSchemaVersion(record.schemaVersion);
  requireEvidenceIds(record.fieldEvidence.occurrence, "Occurrence evidence");
  requireEvidenceIds(record.fieldEvidence.entity, "Entity evidence");
  requireEvidenceIds(record.fieldEvidence.eventType, "Event type evidence");
  const observationKeys = new Set<string>();
  for (const observation of record.observations) {
    requireBoundedUtf8(
      observation.observationKey,
      "Observation key",
      MAX_OBSERVATION_KEY_UTF8_BYTES,
    );
    requireObservationType(observation.observationType);
    requireEvidenceIds(observation.valueEvidence, "Observation value evidence");
    if (observationKeys.has(observation.observationKey)) {
      throw new Error("Event contains duplicate observation keys");
    }
    observationKeys.add(observation.observationKey);
  }
}

async function findStableEvent(
  ctx: ReadCtx,
  sourceItemId: Id<"sourceItems">,
  eventKey: string,
): Promise<Doc<"events"> | undefined> {
  const rows = await ctx.db
    .query("events")
    .withIndex("by_sourceItemId_and_eventKey", (q) =>
      q.eq("sourceItemId", sourceItemId).eq("eventKey", eventKey),
    )
    .take(2);
  if (rows.length > 1) throw new Error("Event identity is not unique");
  return rows[0];
}

async function findEventVersion(
  ctx: ReadCtx,
  eventId: Id<"events">,
  processingGenerationId: Id<"processingGenerations">,
): Promise<Doc<"eventVersions"> | undefined> {
  const rows = await ctx.db
    .query("eventVersions")
    .withIndex("by_eventId_and_processingGenerationId", (q) =>
      q
        .eq("eventId", eventId)
        .eq("processingGenerationId", processingGenerationId),
    )
    .take(2);
  if (rows.length > 1) throw new Error("Event version identity is not unique");
  return rows[0];
}

async function findObservation(
  ctx: ReadCtx,
  eventId: Id<"events">,
  observationKey: string,
  processingGenerationId: Id<"processingGenerations">,
): Promise<Doc<"observations"> | undefined> {
  const rows = await ctx.db
    .query("observations")
    .withIndex("by_event_observation_generation", (q) =>
      q
        .eq("eventId", eventId)
        .eq("observationKey", observationKey)
        .eq("processingGenerationId", processingGenerationId),
    )
    .take(2);
  if (rows.length > 1) throw new Error("Observation identity is not unique");
  return rows[0];
}

function sameEventVersion(
  row: Doc<"eventVersions">,
  expected: Omit<Doc<"eventVersions">, "_id" | "_creationTime">,
): boolean {
  return (
    row.spaceId === expected.spaceId &&
    row.sourceAccountId === expected.sourceAccountId &&
    row.sourceItemId === expected.sourceItemId &&
    row.sourceRevisionId === expected.sourceRevisionId &&
    row.sourceTextVersionId === expected.sourceTextVersionId &&
    row.processingGenerationId === expected.processingGenerationId &&
    row.eventId === expected.eventId &&
    row.entityId === expected.entityId &&
    row.eventType === expected.eventType &&
    row.schemaVersion === expected.schemaVersion &&
    sameStructuredValue(row.occurrence, expected.occurrence) &&
    row.occurrenceDate === expected.occurrenceDate &&
    row.occurrenceInstant === expected.occurrenceInstant &&
    row.occurrenceSortKey === expected.occurrenceSortKey &&
    sameIds(row.fieldEvidence.occurrence, expected.fieldEvidence.occurrence) &&
    sameIds(row.fieldEvidence.entity, expected.fieldEvidence.entity) &&
    sameIds(row.fieldEvidence.eventType, expected.fieldEvidence.eventType) &&
    row.userId === expected.userId
  );
}

function sameObservation(
  row: Doc<"observations">,
  expected: Omit<Doc<"observations">, "_id" | "_creationTime">,
): boolean {
  return (
    row.spaceId === expected.spaceId &&
    row.sourceAccountId === expected.sourceAccountId &&
    row.sourceItemId === expected.sourceItemId &&
    row.sourceRevisionId === expected.sourceRevisionId &&
    row.sourceTextVersionId === expected.sourceTextVersionId &&
    row.processingGenerationId === expected.processingGenerationId &&
    row.eventId === expected.eventId &&
    row.eventVersionId === expected.eventVersionId &&
    row.entityId === expected.entityId &&
    row.eventType === expected.eventType &&
    sameStructuredValue(row.occurrence, expected.occurrence) &&
    row.occurrenceDate === expected.occurrenceDate &&
    row.occurrenceInstant === expected.occurrenceInstant &&
    row.occurrenceSortKey === expected.occurrenceSortKey &&
    row.observationKey === expected.observationKey &&
    row.observationType === expected.observationType &&
    row.schemaVersion === expected.schemaVersion &&
    sameStructuredValue(row.value, expected.value) &&
    sameIds(row.valueEvidence, expected.valueEvidence) &&
    row.userId === expected.userId
  );
}

/**
 * Section 4.3 of docs/plans/2026-09-12-document-cards.md: a card field with
 * no resolvable evidence is not stored at all. This is the same check
 * `stageRecordBatch` applies through `requireEvidence` (span parent chain,
 * page parent, page hash, page-relative UTF-16 range and recomputed
 * `quoteHash`), reported per field instead of thrown, so the caller can drop
 * exactly the unresolvable fields and stage the rest.
 *
 * Failing closed is the point: any reason the evidence cannot be proved,
 * including a budget refusal, drops the field.
 */
export async function probeFieldEvidence<Key extends string>(
  ctx: ReadCtx,
  input: {
    spaceId: Id<"spaces">;
    processingGenerationId: Id<"processingGenerations">;
    fields: ReadonlyArray<{
      key: Key;
      evidenceSpanIds: readonly Id<"evidenceSpans">[];
    }>;
  },
): Promise<{
  resolved: Set<Key>;
  dropped: Array<{ key: Key; reason: string }>;
}> {
  const chain = await requireGenerationChain(
    ctx,
    input.spaceId,
    input.processingGenerationId,
  );
  const cache = newEvidenceCache();
  const resolved = new Set<Key>();
  const dropped: Array<{ key: Key; reason: string }> = [];
  for (const field of input.fields) {
    try {
      await requireEvidence(
        ctx,
        chain,
        field.evidenceSpanIds,
        `Card field ${field.key} evidence`,
        cache,
      );
      resolved.add(field.key);
    } catch (error) {
      dropped.push({
        key: field.key,
        reason: error instanceof Error ? error.message : "unresolvable",
      });
    }
  }
  return { resolved, dropped };
}

/**
 * Trusted staging primitive. Lease authorization and fencing belong to the
 * ingestion wrapper; this function enforces the immutable record boundary.
 */
export async function stageRecordBatch(
  ctx: MutationCtx,
  input: StageRecordBatchInput,
): Promise<StageRecordBatchResult> {
  assertStageBatchBounds(input);
  const chain = await requireGenerationChain(
    ctx,
    input.spaceId,
    input.processingGenerationId,
  );
  if (chain.sourceItem.lifecycle !== "available") {
    throw new Error("Records can only be staged for an available source item");
  }
  if (!["processing", "staged"].includes(chain.generation.state)) {
    throw new Error("Processing generation is not open for record staging");
  }
  await requireUser(ctx, input.userId, "Record actor");

  const existingVersions = await ctx.db
    .query("eventVersions")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", chain.generation._id),
    )
    .take(MAX_EVENTS_PER_GENERATION + 1);
  const existingObservations = await ctx.db
    .query("observations")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", chain.generation._id),
    )
    .take(MAX_OBSERVATIONS_PER_GENERATION + 1);
  if (existingVersions.length > MAX_EVENTS_PER_GENERATION) {
    throw new Error("Processing generation exceeds the event limit");
  }
  if (existingObservations.length > MAX_OBSERVATIONS_PER_GENERATION) {
    throw new Error("Processing generation exceeds the observation limit");
  }

  const batchEventKeys = new Set<string>();
  let eventVersionCount = existingVersions.length;
  let observationCount = existingObservations.length;
  let insertedEventCount = 0;
  let insertedEventVersionCount = 0;
  let insertedObservationCount = 0;
  const evidenceCache = newEvidenceCache();
  const eventIds: Id<"events">[] = [];
  const eventVersionIds: Id<"eventVersions">[] = [];
  const observationIds: Id<"observations">[] = [];

  for (const record of input.records) {
    assertEventInputShape(record);
    if (batchEventKeys.has(record.eventKey)) {
      throw new Error("Record batch contains duplicate event keys");
    }
    batchEventKeys.add(record.eventKey);
    const occurrence = validateOccurrence(record.occurrence);
    const occurrenceFields = canonicalOccurrenceFields(occurrence);
    const entity = await requireEntity(ctx, record.entityId, input.spaceId);
    requireEventSchema(record.eventType, record.schemaVersion, entity);
    await requireEvidence(
      ctx,
      chain,
      record.fieldEvidence.occurrence,
      "Occurrence evidence",
      evidenceCache,
    );
    await requireEvidence(
      ctx,
      chain,
      record.fieldEvidence.entity,
      "Entity evidence",
      evidenceCache,
    );
    await requireEvidence(
      ctx,
      chain,
      record.fieldEvidence.eventType,
      "Event type evidence",
      evidenceCache,
    );
    boundedEvidenceProjection(evidenceCache, [
      ...record.fieldEvidence.occurrence,
      ...record.fieldEvidence.entity,
      ...record.fieldEvidence.eventType,
    ]);

    let event = await findStableEvent(
      ctx,
      chain.sourceItem._id,
      record.eventKey,
    );
    if (event) {
      if (
        event.spaceId !== input.spaceId ||
        event.sourceAccountId !== chain.sourceAccount._id ||
        event.sourceItemId !== chain.sourceItem._id ||
        event.eventKey !== record.eventKey
      ) {
        throw new Error("Conflicting immutable event identity");
      }
    } else {
      const id = await ctx.db.insert("events", {
        spaceId: input.spaceId,
        sourceAccountId: chain.sourceAccount._id,
        sourceItemId: chain.sourceItem._id,
        eventKey: record.eventKey,
        createdBy: input.userId,
      });
      event = (await ctx.db.get(id))!;
      insertedEventCount += 1;
    }

    let eventVersion = await findEventVersion(
      ctx,
      event._id,
      chain.generation._id,
    );
    const expectedVersion = {
      spaceId: input.spaceId,
      sourceAccountId: chain.sourceAccount._id,
      sourceItemId: chain.sourceItem._id,
      sourceRevisionId: chain.sourceRevision._id,
      sourceTextVersionId: chain.sourceTextVersion._id,
      processingGenerationId: chain.generation._id,
      eventId: event._id,
      entityId: entity._id,
      eventType: record.eventType,
      schemaVersion: record.schemaVersion,
      occurrence,
      ...occurrenceFields,
      occurrenceSortKey: occurrenceSortKey(
        occurrence,
        `${event._id}|${chain.generation._id}`,
      ),
      fieldEvidence: record.fieldEvidence,
      userId: eventVersion?.userId ?? input.userId,
    } satisfies Omit<Doc<"eventVersions">, "_id" | "_creationTime">;
    if (eventVersion) {
      if (!sameEventVersion(eventVersion, expectedVersion)) {
        throw new Error("Conflicting immutable event version");
      }
    } else {
      if (eventVersionCount >= MAX_EVENTS_PER_GENERATION) {
        throw new Error(
          `Processing generation exceeds ${MAX_EVENTS_PER_GENERATION} events`,
        );
      }
      eventVersionCount += 1;
      const id = await ctx.db.insert("eventVersions", expectedVersion);
      eventVersion = (await ctx.db.get(id))!;
      insertedEventVersionCount += 1;
    }
    eventIds.push(event._id);
    eventVersionIds.push(eventVersion._id);

    for (const inputObservation of record.observations) {
      const value = canonicalizeObservationValue(inputObservation.value);
      requireObservationSchema(
        record.eventType,
        inputObservation.observationType,
        inputObservation.observationKey,
        value,
      );
      if (value.type === "entity") {
        await requireEntity(ctx, value.entityId, input.spaceId);
      }
      await requireEvidence(
        ctx,
        chain,
        inputObservation.valueEvidence,
        "Observation value evidence",
        evidenceCache,
      );
      boundedEvidenceProjection(evidenceCache, [
        ...record.fieldEvidence.occurrence,
        ...record.fieldEvidence.entity,
        ...record.fieldEvidence.eventType,
        ...inputObservation.valueEvidence,
      ]);
      const expectedObservation = {
        spaceId: input.spaceId,
        sourceAccountId: chain.sourceAccount._id,
        sourceItemId: chain.sourceItem._id,
        sourceRevisionId: chain.sourceRevision._id,
        sourceTextVersionId: chain.sourceTextVersion._id,
        processingGenerationId: chain.generation._id,
        eventId: event._id,
        eventVersionId: eventVersion._id,
        entityId: entity._id,
        eventType: record.eventType,
        occurrence,
        ...occurrenceFields,
        occurrenceSortKey: occurrenceSortKey(
          occurrence,
          `${event._id}|${inputObservation.observationKey}|${chain.generation._id}`,
        ),
        observationKey: inputObservation.observationKey,
        observationType: inputObservation.observationType,
        schemaVersion: record.schemaVersion,
        value,
        valueEvidence: inputObservation.valueEvidence,
        userId: eventVersion.userId,
      } satisfies Omit<Doc<"observations">, "_id" | "_creationTime">;
      const existing = await findObservation(
        ctx,
        event._id,
        inputObservation.observationKey,
        chain.generation._id,
      );
      if (existing) {
        if (!sameObservation(existing, expectedObservation)) {
          throw new Error("Conflicting immutable observation version");
        }
        observationIds.push(existing._id);
        continue;
      }
      if (observationCount >= MAX_OBSERVATIONS_PER_GENERATION) {
        throw new Error(
          `Processing generation exceeds ${MAX_OBSERVATIONS_PER_GENERATION} observations`,
        );
      }
      observationCount += 1;
      const id = await ctx.db.insert("observations", expectedObservation);
      observationIds.push(id);
      insertedObservationCount += 1;
    }
  }
  return {
    eventIds,
    eventVersionIds,
    observationIds,
    insertedEventCount,
    insertedEventVersionCount,
    insertedObservationCount,
  };
}

async function validateStoredEventVersion(
  ctx: ReadCtx,
  chain: GenerationChain,
  row: Doc<"eventVersions">,
  evidenceCache: EvidenceValidationCache,
): Promise<{
  event: Doc<"events">;
  entity: Doc<"entities">;
  references: number;
}> {
  if (
    row.spaceId !== chain.space._id ||
    row.sourceAccountId !== chain.sourceAccount._id ||
    row.sourceItemId !== chain.sourceItem._id ||
    row.sourceRevisionId !== chain.sourceRevision._id ||
    row.sourceTextVersionId !== chain.sourceTextVersion._id ||
    row.processingGenerationId !== chain.generation._id
  ) {
    throw new Error("Event version parent chain is invalid");
  }
  const [event, entity] = await Promise.all([
    ctx.db.get(row.eventId),
    requireEntity(ctx, row.entityId, chain.space._id),
  ]);
  if (
    !event ||
    event.spaceId !== chain.space._id ||
    event.sourceAccountId !== chain.sourceAccount._id ||
    event.sourceItemId !== chain.sourceItem._id
  ) {
    throw new Error("Event version has an invalid stable event parent");
  }
  requireEventSchema(row.eventType, row.schemaVersion, entity);
  const occurrence = validateOccurrence(row.occurrence);
  if (!sameStructuredValue(occurrence, row.occurrence)) {
    throw new Error("Event version occurrence is not canonical");
  }
  const occurrenceFields = canonicalOccurrenceFields(occurrence);
  if (
    row.occurrenceDate !== occurrenceFields.occurrenceDate ||
    row.occurrenceInstant !== occurrenceFields.occurrenceInstant ||
    row.occurrenceSortKey !==
      occurrenceSortKey(
        occurrence,
        `${row.eventId}|${row.processingGenerationId}`,
      )
  ) {
    throw new Error("Event version occurrence index fields are invalid");
  }
  await requireEvidence(
    ctx,
    chain,
    row.fieldEvidence.occurrence,
    "Occurrence evidence",
    evidenceCache,
  );
  await requireEvidence(
    ctx,
    chain,
    row.fieldEvidence.entity,
    "Entity evidence",
    evidenceCache,
  );
  await requireEvidence(
    ctx,
    chain,
    row.fieldEvidence.eventType,
    "Event type evidence",
    evidenceCache,
  );
  return {
    event,
    entity,
    references:
      row.fieldEvidence.occurrence.length +
      row.fieldEvidence.entity.length +
      row.fieldEvidence.eventType.length,
  };
}

async function validateStoredObservation(
  ctx: ReadCtx,
  chain: GenerationChain,
  row: Doc<"observations">,
  version: Doc<"eventVersions">,
  evidenceCache: EvidenceValidationCache,
): Promise<number> {
  if (
    row.spaceId !== chain.space._id ||
    row.sourceAccountId !== chain.sourceAccount._id ||
    row.sourceItemId !== chain.sourceItem._id ||
    row.sourceRevisionId !== chain.sourceRevision._id ||
    row.sourceTextVersionId !== chain.sourceTextVersion._id ||
    row.processingGenerationId !== chain.generation._id ||
    row.eventVersionId !== version._id ||
    row.eventId !== version.eventId ||
    row.entityId !== version.entityId ||
    row.eventType !== version.eventType ||
    row.schemaVersion !== version.schemaVersion ||
    !sameStructuredValue(row.occurrence, version.occurrence) ||
    row.occurrenceDate !== version.occurrenceDate ||
    row.occurrenceInstant !== version.occurrenceInstant ||
    row.occurrenceSortKey !==
      occurrenceSortKey(
        row.occurrence,
        `${row.eventId}|${row.observationKey}|${row.processingGenerationId}`,
      ) ||
    row.userId !== version.userId
  ) {
    throw new Error("Observation parent or event-version fields are invalid");
  }
  requireBoundedUtf8(
    row.observationKey,
    "Observation key",
    MAX_OBSERVATION_KEY_UTF8_BYTES,
  );
  const value = canonicalizeObservationValue(row.value);
  if (!sameStructuredValue(value, row.value)) {
    throw new Error("Observation value is not canonical");
  }
  requireObservationSchema(
    row.eventType,
    row.observationType,
    row.observationKey,
    value,
  );
  if (value.type === "entity") {
    await requireEntity(ctx, value.entityId, chain.space._id);
  }
  await requireEvidence(
    ctx,
    chain,
    row.valueEvidence,
    "Observation value evidence",
    evidenceCache,
  );
  return row.valueEvidence.length;
}

export async function validateGenerationRecords(
  ctx: ReadCtx,
  input: {
    spaceId: Id<"spaces">;
    processingGenerationId: Id<"processingGenerations">;
    expectedEventCount: number;
    expectedObservationCount: number;
  },
): Promise<ValidatedGenerationRecords> {
  requireIntegerInRange(
    input.expectedEventCount,
    "Expected event count",
    0,
    MAX_EVENTS_PER_GENERATION,
  );
  requireIntegerInRange(
    input.expectedObservationCount,
    "Expected observation count",
    0,
    MAX_OBSERVATIONS_PER_GENERATION,
  );
  const chain = await requireGenerationChain(
    ctx,
    input.spaceId,
    input.processingGenerationId,
  );
  const eventVersions = await ctx.db
    .query("eventVersions")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", chain.generation._id),
    )
    .take(MAX_EVENTS_PER_GENERATION + 1);
  const observations = await ctx.db
    .query("observations")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", chain.generation._id),
    )
    .take(MAX_OBSERVATIONS_PER_GENERATION + 1);
  if (eventVersions.length !== input.expectedEventCount) {
    throw new Error(
      `Generation event count mismatch: expected ${input.expectedEventCount}, found ${eventVersions.length}`,
    );
  }
  if (observations.length !== input.expectedObservationCount) {
    throw new Error(
      `Generation observation count mismatch: expected ${input.expectedObservationCount}, found ${observations.length}`,
    );
  }

  const evidenceCache = newEvidenceCache();
  const versionById = new Map<string, Doc<"eventVersions">>();
  const eventIdentityKeys = new Set<string>();
  let evidenceReferenceCount = 0;
  for (const version of eventVersions) {
    const validated = await validateStoredEventVersion(
      ctx,
      chain,
      version,
      evidenceCache,
    );
    const identity = `${validated.event._id}:${chain.generation._id}`;
    if (eventIdentityKeys.has(identity)) {
      throw new Error("Generation contains duplicate event version identities");
    }
    eventIdentityKeys.add(identity);
    versionById.set(version._id, version);
    evidenceReferenceCount += validated.references;
    boundedEvidenceProjection(evidenceCache, eventEvidenceIds(version));
  }
  const observationIdentityKeys = new Set<string>();
  const observationsPerVersion = new Map<string, number>();
  for (const observation of observations) {
    const version = versionById.get(observation.eventVersionId);
    if (!version) {
      throw new Error("Observation has no event version in its generation");
    }
    const identity = `${observation.eventId}:${observation.observationKey}:${chain.generation._id}`;
    if (observationIdentityKeys.has(identity)) {
      throw new Error("Generation contains duplicate observation identities");
    }
    observationIdentityKeys.add(identity);
    evidenceReferenceCount += await validateStoredObservation(
      ctx,
      chain,
      observation,
      version,
      evidenceCache,
    );
    boundedEvidenceProjection(evidenceCache, [
      ...eventEvidenceIds(version),
      ...observation.valueEvidence,
    ]);
    observationsPerVersion.set(
      version._id,
      (observationsPerVersion.get(version._id) ?? 0) + 1,
    );
  }
  if (evidenceReferenceCount > MAX_GENERATION_EVIDENCE_REFERENCES) {
    throw new Error("Generation record evidence exceeds the global limit");
  }
  for (const version of eventVersions) {
    if (
      (version.eventType === "lab_panel" ||
        version.eventType === "financial_transaction") &&
      !observationsPerVersion.has(version._id)
    ) {
      throw new Error(`${version.eventType} requires at least one observation`);
    }
  }
  return {
    eventVersions,
    observations,
    evidenceSpanCount: evidenceCache.spans.size,
    evidenceReferenceCount,
  };
}

function requireReadableGeneration(
  chain: GenerationChain,
  scope: RecordHydrationScope,
): void {
  if (
    chain.sourceItem.lifecycle === "forgetting" ||
    chain.sourceItem.lifecycle === "forgotten"
  ) {
    throw new Error("Source item content is not readable");
  }
  if (
    scope.sourceAccountIds &&
    !scope.sourceAccountIds.includes(chain.sourceAccount._id)
  ) {
    throw new Error("Source account is outside the requested scope");
  }
  if (chain.generation.state !== "ready") {
    throw new Error("Record generation is not ready for reads");
  }
  const { activatedAt, deactivatedAt } = chain.generation;
  if (activatedAt === undefined) {
    throw new Error("Record generation activation interval is invalid");
  }
  if (
    !Number.isSafeInteger(activatedAt) ||
    activatedAt < 0 ||
    (deactivatedAt !== undefined &&
      (!Number.isSafeInteger(deactivatedAt) || deactivatedAt <= activatedAt))
  ) {
    throw new Error("Record generation activation interval is invalid");
  }
  if (scope.snapshot === undefined) {
    if (
      chain.sourceItem.activeGenerationId !== chain.generation._id ||
      chain.sourceItem.activeRevisionId !== chain.generation.sourceRevisionId ||
      deactivatedAt !== undefined
    ) {
      throw new Error("Record generation is not the valid current generation");
    }
    return;
  }
  if (!Number.isFinite(scope.snapshot) || scope.snapshot < 0) {
    throw new Error("Record snapshot must be a non-negative finite timestamp");
  }
  if (
    activatedAt > scope.snapshot ||
    (deactivatedAt !== undefined && scope.snapshot >= deactivatedAt)
  ) {
    throw new Error("Record generation was not active at the snapshot");
  }
  if (
    deactivatedAt === undefined &&
    (chain.sourceItem.activeGenerationId !== chain.generation._id ||
      chain.sourceItem.activeRevisionId !== chain.generation.sourceRevisionId)
  ) {
    throw new Error("Open record generation is not the current source version");
  }
}

export async function hydrateEventVersion(
  ctx: ReadCtx,
  input: RecordHydrationScope & { eventVersionId: Id<"eventVersions"> },
): Promise<HydratedEventVersion> {
  requireHydrationBudgetOpen(input.cache);
  const hydrationCache =
    input.cache ??
    createRecordHydrationCache({
      maxEvidenceQuoteUtf8Bytes: MAX_HYDRATED_EVIDENCE_UTF8_BYTES,
    });
  const eventVersion = await ctx.db.get(input.eventVersionId);
  if (!eventVersion) throw new Error("Event version does not exist");
  if (eventVersion.spaceId !== input.spaceId) {
    throw new Error("Event version belongs to another space");
  }
  const chain = await requireGenerationChain(
    ctx,
    input.spaceId,
    eventVersion.processingGenerationId,
    hydrationCache,
  );
  requireReadableGeneration(chain, input);
  const evidenceCache = hydrationEvidenceCache(
    hydrationCache,
    eventVersion.processingGenerationId,
  );
  const { event, entity, references } = await validateStoredEventVersion(
    ctx,
    chain,
    eventVersion,
    evidenceCache,
  );
  if (references > MAX_HYDRATED_EVIDENCE_SPANS) {
    throw new Error("Hydrated event evidence exceeds the global limit");
  }
  const evidence = boundedEvidenceProjection(
    evidenceCache,
    eventEvidenceIds(eventVersion),
  );
  return {
    ...chain,
    event,
    eventVersion,
    entity,
    evidenceSpans: evidence.map((item) => item.span),
    evidence,
  };
}

export async function hydrateObservation(
  ctx: ReadCtx,
  input: RecordHydrationScope & { observationId: Id<"observations"> },
): Promise<HydratedObservation> {
  requireHydrationBudgetOpen(input.cache);
  const hydrationCache =
    input.cache ??
    createRecordHydrationCache({
      maxEvidenceQuoteUtf8Bytes: MAX_HYDRATED_EVIDENCE_UTF8_BYTES,
    });
  const observation = await ctx.db.get(input.observationId);
  if (!observation) throw new Error("Observation does not exist");
  if (observation.spaceId !== input.spaceId) {
    throw new Error("Observation belongs to another space");
  }
  const hydrated = await hydrateEventVersion(ctx, {
    ...input,
    cache: hydrationCache,
    eventVersionId: observation.eventVersionId,
  });
  const evidenceCache = hydrationEvidenceCache(
    hydrationCache,
    observation.processingGenerationId,
  );
  const references =
    hydrated.eventVersion.fieldEvidence.occurrence.length +
    hydrated.eventVersion.fieldEvidence.entity.length +
    hydrated.eventVersion.fieldEvidence.eventType.length +
    (await validateStoredObservation(
      ctx,
      hydrated,
      observation,
      hydrated.eventVersion,
      evidenceCache,
    ));
  if (references > MAX_HYDRATED_EVIDENCE_SPANS) {
    throw new Error("Hydrated observation evidence exceeds the global limit");
  }
  const evidence = boundedEvidenceProjection(evidenceCache, [
    ...eventEvidenceIds(hydrated.eventVersion),
    ...observation.valueEvidence,
  ]);
  return {
    ...hydrated,
    observation,
    evidenceSpans: evidence.map((item) => item.span),
    evidence,
  };
}

export async function deleteGenerationRecordsBatch(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    processingGenerationId: Id<"processingGenerations">;
    limit?: number;
  },
): Promise<{ deleted: number; done: boolean }> {
  const limit = input.limit ?? MAX_RECORD_CLEANUP_ROWS;
  requireIntegerInRange(
    limit,
    "Record cleanup limit",
    1,
    MAX_RECORD_CLEANUP_ROWS,
  );
  const generation = await ctx.db.get(input.processingGenerationId);
  if (!generation) return { deleted: 0, done: true };
  if (generation.spaceId !== input.spaceId) {
    throw new Error("Processing generation belongs to another space");
  }
  const sourceItem = await ctx.db.get(generation.sourceItemId);
  if (!sourceItem || sourceItem.spaceId !== input.spaceId) {
    throw new Error("Processing generation has an invalid source item");
  }
  if (
    (generation.activatedAt !== undefined || generation.state === "ready") &&
    sourceItem.lifecycle !== "forgetting"
  ) {
    throw new Error(
      "Activated generation records can only be deleted while forgetting their source",
    );
  }
  let deleted = 0;
  const observations = await ctx.db
    .query("observations")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", generation._id),
    )
    .take(limit);
  for (const observation of observations) {
    await ctx.db.delete(observation._id);
    deleted += 1;
  }
  if (deleted < limit) {
    const versions = await ctx.db
      .query("eventVersions")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(limit - deleted);
    for (const version of versions) {
      const child = await ctx.db
        .query("observations")
        .withIndex("by_eventVersionId", (q) =>
          q.eq("eventVersionId", version._id),
        )
        .first();
      if (child) continue;
      await ctx.db.delete(version._id);
      deleted += 1;
    }
  }
  const [observation, version] = await Promise.all([
    ctx.db
      .query("observations")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .first(),
    ctx.db
      .query("eventVersions")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .first(),
  ]);
  return { deleted, done: !observation && !version };
}

export async function deleteSourceItemRecordsBatch(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceItemId: Id<"sourceItems">;
    limit?: number;
  },
): Promise<{
  deleted: number;
  deletedObservations: number;
  deletedEventVersions: number;
  deletedEvents: number;
  done: boolean;
}> {
  const limit = input.limit ?? MAX_RECORD_CLEANUP_ROWS;
  requireIntegerInRange(
    limit,
    "Record cleanup limit",
    1,
    MAX_RECORD_CLEANUP_ROWS,
  );
  const sourceItem = await ctx.db.get(input.sourceItemId);
  if (!sourceItem) {
    return {
      deleted: 0,
      deletedObservations: 0,
      deletedEventVersions: 0,
      deletedEvents: 0,
      done: true,
    };
  }
  if (sourceItem.spaceId !== input.spaceId) {
    throw new Error("Source item belongs to another space");
  }
  if (sourceItem.lifecycle !== "forgetting") {
    throw new Error("Source record deletion requires a forgetting source item");
  }
  let deleted = 0;
  let deletedObservations = 0;
  let deletedEventVersions = 0;
  let deletedEvents = 0;
  const observations = await ctx.db
    .query("observations")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItem._id))
    .take(limit);
  for (const observation of observations) {
    await ctx.db.delete(observation._id);
    deleted += 1;
    deletedObservations += 1;
  }
  if (deleted < limit) {
    const versions = await ctx.db
      .query("eventVersions")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItem._id))
      .take(limit - deleted);
    for (const version of versions) {
      const child = await ctx.db
        .query("observations")
        .withIndex("by_eventVersionId", (q) =>
          q.eq("eventVersionId", version._id),
        )
        .first();
      if (child) continue;
      await ctx.db.delete(version._id);
      deleted += 1;
      deletedEventVersions += 1;
    }
  }
  if (deleted < limit) {
    const events = await ctx.db
      .query("events")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItem._id))
      .take(limit - deleted);
    for (const event of events) {
      const [version, observation] = await Promise.all([
        ctx.db
          .query("eventVersions")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
          .first(),
        ctx.db
          .query("observations")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
          .first(),
      ]);
      if (version || observation) continue;
      await ctx.db.delete(event._id);
      deleted += 1;
      deletedEvents += 1;
    }
  }
  const [observation, version, event] = await Promise.all([
    ctx.db
      .query("observations")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItem._id))
      .first(),
    ctx.db
      .query("eventVersions")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItem._id))
      .first(),
    ctx.db
      .query("events")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItem._id))
      .first(),
  ]);
  return {
    deleted,
    deletedObservations,
    deletedEventVersions,
    deletedEvents,
    done: !observation && !version && !event,
  };
}

// Independent source events are intentionally retained as independent stable
// identities. Matching names, dates, or values never creates a link or
// collapses exact-query contributions.
