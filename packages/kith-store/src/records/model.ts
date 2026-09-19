import type { ClientBase, QueryResultRow } from "pg";

import { newKithId } from "../ids.js";
import {
  camelizeEvidenceSpan,
  camelizeProcessingGeneration,
  camelizeSourceItem,
  camelizeSourcePage,
  camelizeSourceParserArtifact,
  camelizeSourceRevision,
  camelizeSourceTextVersion,
  type EvidenceSpanRow,
  type ProcessingGenerationRow,
  type SourceItemRow,
  type SourcePageRow,
  type SourceParserArtifactRow,
  type SourceRevisionRow,
  type SourceTextVersionRow,
} from "../provenance/rows.js";
import {
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
} from "../provenance/representations.js";
import { camelize, sha256Utf8, utf8Length } from "../provenance/sql.js";
import {
  isCardRecordKind,
  requireCardEventSchema,
  requireCardObservationSchema,
  type EntityKind,
} from "./cardSchemas.js";
import {
  canonicalizeObservationValue,
  occurrenceCalendarDate,
  validateOccurrence,
  type ObservationValue,
  type Occurrence,
} from "./values.js";

export const MAX_FIELD_EVIDENCE_SPANS = 16;
export const MAX_HYDRATED_EVIDENCE_SPANS = 64;
export const MAX_HYDRATED_EVIDENCE_UTF8_BYTES = 16 * 1_024;
export const MAX_EVENTS_PER_GENERATION = 32;
export const MAX_OBSERVATIONS_PER_GENERATION = 128;
export const MAX_RECORD_STAGE_ROWS = 25;
export const MAX_RECORD_STAGE_UTF8_BYTES = 128 * 1_024;
const MAX_EVENT_KEY_UTF8_BYTES = 512;
const MAX_OBSERVATION_KEY_UTF8_BYTES = 512;
const MAX_GENERATION_EVIDENCE_REFERENCES =
  MAX_EVENTS_PER_GENERATION * MAX_FIELD_EVIDENCE_SPANS * 3 +
  MAX_OBSERVATIONS_PER_GENERATION * MAX_FIELD_EVIDENCE_SPANS;
const MAX_GENERATION_EVIDENCE_UTF8_BYTES = 128 * 1_024;
const OBSERVATION_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const EVENT_TYPES = [
  "lab_panel",
  "vehicle_service",
  "financial_transaction",
  "document_card",
  "safe_note_card",
  "tax_return_card",
  "k1_card",
  "brokerage_tax_package_card",
  "spreadsheet_card",
  // ADM-5a. One generic event type for every typed extraction, rather than one
  // per document kind: the kind is a row in `document_types` and "adding a kind
  // is a row, not a release" (section 8 of the admin plan), so a per-kind event
  // type would put the closed enum this array is straight back in code. Being
  // outside `isCardRecordKind` is what lets these records live on the ordinary
  // parsed generation; the card lane's `cardGeneration` pairing is untouched.
  // Its fields are unconstrained here on purpose -- the per-value-type gate in
  // `src/extraction/gate.ts` is what decides whether a reading may be stored at
  // all, and a statement that fails it opens a correction instead.
  "document_statement",
] as const;

export type RecordEventType = (typeof EVENT_TYPES)[number];
export type SpaceRow = QueryResultRow & {
  id: string;
  createdAt: Date;
  kind: string | null;
  name: string | null;
  createdBy: string | null;
};
export type SourceAccountRow = QueryResultRow & {
  id: string;
  spaceId: string;
  createdAt: Date;
  subjectEntityId: string | null;
};
export type EntityRow = QueryResultRow & {
  id: string;
  spaceId: string;
  createdAt: Date;
  userId: string;
  kind: EntityKind;
};
export type EventRow = QueryResultRow & {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  eventKey: string;
  createdBy: string;
};
export type RecordFieldEvidence = {
  occurrence: string[];
  entity: string[];
  eventType: string[];
};
export type CardDocTypePatch = Array<{
  documentId: string;
  previousDocType?: string;
  appliedDocType: string;
}>;
export type EventVersionRow = QueryResultRow & {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  processingGenerationId: string;
  eventId: string;
  entityId: string;
  eventType: RecordEventType;
  schemaVersion: number;
  occurrence: Occurrence;
  occurrenceDate: string | null;
  occurrenceInstant: Date | null;
  occurrenceSortKey: string | null;
  fieldEvidence: RecordFieldEvidence;
  docTypePatch: CardDocTypePatch | null;
  userId: string;
};
export type ObservationRow = QueryResultRow & {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  processingGenerationId: string;
  eventId: string;
  eventVersionId: string;
  entityId: string;
  eventType: RecordEventType;
  occurrence: Occurrence;
  occurrenceDate: string | null;
  occurrenceInstant: Date | null;
  occurrenceSortKey: string | null;
  observationKey: string;
  observationType: string;
  schemaVersion: number;
  value: ObservationValue;
  valueEvidence: string[];
  boundEntityId: string | null;
  userId: string;
};
export type StagedObservation = {
  observationKey: string;
  observationType: string;
  value: ObservationValue;
  valueEvidence: string[];
};
export type StagedEventRecord = {
  eventKey: string;
  entityId: string;
  eventType: RecordEventType;
  schemaVersion: number;
  occurrence: Occurrence;
  fieldEvidence: RecordFieldEvidence;
  observations: StagedObservation[];
};
export type StageRecordBatchInput = {
  spaceId: string;
  processingGenerationId: string;
  userId: string;
  records: StagedEventRecord[];
};
export type StageRecordBatchResult = {
  eventIds: string[];
  eventVersionIds: string[];
  observationIds: string[];
  insertedEventCount: number;
  insertedEventVersionCount: number;
  insertedObservationCount: number;
};
export type ValidatedGenerationRecords = {
  eventVersions: EventVersionRow[];
  observations: ObservationRow[];
  evidenceSpanCount: number;
  evidenceReferenceCount: number;
};
type GenerationChain = {
  space: SpaceRow;
  sourceAccount: SourceAccountRow;
  sourceItem: SourceItemRow;
  sourceRevision: SourceRevisionRow;
  sourceTextVersion: SourceTextVersionRow;
  representation: "inline_text_v1" | "parsed_pages_v1";
  sourceText?: string;
  generation: ProcessingGenerationRow;
};
type EvidenceValidationCache = {
  spans: Map<string, EvidenceSpanRow>;
  pages: Map<string, SourcePageRow>;
  quotes: Map<string, string>;
  validatedPageIds: Set<string>;
  validatedSpanIds: Set<string>;
};

/**
 * A cache belongs to one request transaction and client. Create it after
 * BEGIN and discard it before COMMIT or ROLLBACK. The client binding catches
 * a different client; the caller must also prevent reuse across transactions
 * on the same client, after a visibility change, or for another request.
 */
export type RecordHydrationCache = {
  readonly client: ClientBase;
  generationChains: Map<string, GenerationChain>;
  evidenceByGeneration: Map<string, EvidenceValidationCache>;
  loadedUtf8Bytes: number;
  evidenceQuoteUtf8Bytes: number;
  maxLoadedUtf8Bytes: number;
  maxEvidenceQuoteUtf8Bytes: number;
  exhausted: boolean;
};
export type RecordHydrationScope = {
  spaceId: string;
  snapshot?: Date | number;
  sourceAccountIds?: readonly string[];
  cache?: RecordHydrationCache;
};
export type HydratedEvidence = { span: EvidenceSpanRow; quote: string };
export type HydratedEventVersion = GenerationChain & {
  event: EventRow;
  eventVersion: EventVersionRow;
  entity: EntityRow;
  evidenceSpans: EvidenceSpanRow[];
  evidence: HydratedEvidence[];
};
export type HydratedObservation = HydratedEventVersion & {
  observation: ObservationRow;
};

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

export function createRecordHydrationCache(
  client: ClientBase,
  input: {
    maxLoadedUtf8Bytes?: number;
    maxEvidenceQuoteUtf8Bytes?: number;
  } = {},
): RecordHydrationCache {
  const maxLoadedUtf8Bytes = input.maxLoadedUtf8Bytes ?? 256 * 1_024;
  const maxEvidenceQuoteUtf8Bytes =
    input.maxEvidenceQuoteUtf8Bytes ?? 64 * 1_024;
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
    client,
    generationChains: new Map(),
    evidenceByGeneration: new Map(),
    loadedUtf8Bytes: 0,
    evidenceQuoteUtf8Bytes: 0,
    maxLoadedUtf8Bytes,
    maxEvidenceQuoteUtf8Bytes,
    exhausted: false,
  };
}

function cacheFor(
  client: ClientBase,
  cache: RecordHydrationCache | undefined,
): RecordHydrationCache {
  if (cache && cache.client !== client) {
    throw new Error(
      "Record hydration cache belongs to another database transaction",
    );
  }
  return (
    cache ??
    createRecordHydrationCache(client, {
      maxEvidenceQuoteUtf8Bytes: MAX_HYDRATED_EVIDENCE_UTF8_BYTES,
    })
  );
}

function requireBudgetOpen(cache: RecordHydrationCache): void {
  if (cache.exhausted) throw new Error("Record hydration budget is exhausted");
}

function reserveBudget(
  cache: RecordHydrationCache,
  kind: "loadedUtf8Bytes" | "evidenceQuoteUtf8Bytes",
  maximum: "maxLoadedUtf8Bytes" | "maxEvidenceQuoteUtf8Bytes",
  bytes: number,
  label: string,
): void {
  requireBudgetOpen(cache);
  cache[kind] += bytes;
  if (cache[kind] > cache[maximum]) {
    cache.exhausted = true;
    throw new Error(`Record hydration exceeds the global ${label}-byte limit`);
  }
}

async function getRow<T>(
  client: ClientBase,
  table: string,
  id: string,
  map: (row: Record<string, unknown>) => T,
): Promise<T | undefined> {
  const result = await client.query<QueryResultRow>(
    `SELECT * FROM kith.${table} WHERE id = $1`,
    [id],
  );
  if (result.rowCount === 0) return undefined;
  if (result.rowCount !== 1)
    throw new Error(`Stored ${table} identity is not unique`);
  return map(result.rows[0]!);
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null)
    return false;
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
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameStructuredValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function requireExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} is malformed`);
  }
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`);
}

function requireDateOrNull(value: unknown, label: string): void {
  if (
    value !== null &&
    (!(value instanceof Date) || Number.isNaN(value.getTime()))
  ) {
    throw new Error(`${label} is malformed`);
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

function requireEvidenceIds(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_FIELD_EVIDENCE_SPANS ||
    value.some((id) => typeof id !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new Error(
      `${label} must contain 1-${MAX_FIELD_EVIDENCE_SPANS} unique evidence spans`,
    );
  }
  return value;
}

function requireOccurrence(value: unknown): Occurrence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored occurrence is malformed");
  }
  const precision = (value as { precision?: unknown }).precision;
  if (precision === "unknown") {
    requireExactKeys(value, ["precision"], "Stored occurrence");
  } else if (precision === "date") {
    requireExactKeys(value, ["precision", "date"], "Stored occurrence");
    requireString(value.date, "Stored occurrence date");
  } else if (precision === "datetime") {
    requireExactKeys(
      value,
      ["precision", "instant", "originalOffset"],
      "Stored occurrence",
    );
    requireString(value.originalOffset, "Stored occurrence offset");
  } else {
    throw new Error("Stored occurrence is malformed");
  }
  const canonical = validateOccurrence(value as Occurrence);
  if (!sameStructuredValue(canonical, value)) {
    throw new Error("Stored occurrence is not canonical");
  }
  return canonical;
}

function requireObservationValue(
  value: unknown,
  requireCanonical = true,
): ObservationValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored observation value is malformed");
  }
  const typed = value as Record<string, unknown>;
  switch (typed.type) {
    case "decimal":
      requireExactKeys(
        value,
        typed.originalUnit === undefined
          ? ["type", "value", "unitCode"]
          : ["type", "value", "unitCode", "originalUnit"],
        "Stored observation value",
      );
      break;
    case "money":
      requireExactKeys(
        value,
        ["type", "amount", "currency"],
        "Stored observation value",
      );
      break;
    case "integer":
      requireExactKeys(
        value,
        typed.unitCode === undefined
          ? ["type", "value"]
          : ["type", "value", "unitCode"],
        "Stored observation value",
      );
      break;
    case "text":
    case "date":
      requireExactKeys(value, ["type", "value"], "Stored observation value");
      break;
    case "boolean":
      requireExactKeys(value, ["type", "value"], "Stored observation value");
      if (typeof typed.value !== "boolean") {
        throw new Error("Stored observation value is malformed");
      }
      break;
    case "entity":
      requireExactKeys(value, ["type", "entityId"], "Stored observation value");
      requireString(typed.entityId, "Stored observation entity");
      break;
    default:
      throw new Error("Stored observation value is malformed");
  }
  const canonical = canonicalizeObservationValue(value as ObservationValue);
  if (requireCanonical && !sameStructuredValue(canonical, value)) {
    throw new Error("Observation value is not canonical");
  }
  return canonical;
}

function requireDocTypePatch(value: unknown): CardDocTypePatch | null {
  if (value === null) return null;
  if (!Array.isArray(value))
    throw new Error("Stored document type patch is malformed");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Stored document type patch is malformed");
    }
    const item = entry as Record<string, unknown>;
    requireExactKeys(
      item,
      item.previousDocType === undefined
        ? ["documentId", "appliedDocType"]
        : ["documentId", "previousDocType", "appliedDocType"],
      "Stored document type patch",
    );
    requireString(item.documentId, "Stored document type patch document");
    requireString(item.appliedDocType, "Stored applied document type");
    if (item.previousDocType !== undefined) {
      requireString(item.previousDocType, "Stored previous document type");
    }
    return item as CardDocTypePatch[number];
  });
}

function requireEventType(value: unknown): RecordEventType {
  if (!(EVENT_TYPES as readonly unknown[]).includes(value)) {
    throw new Error("Stored event type is unsupported");
  }
  return value as RecordEventType;
}

function eventVersionFromRow(row: Record<string, unknown>): EventVersionRow {
  const value = camelize<Record<string, unknown>>(row, ["schemaVersion"]);
  requireString(value.userId, "Stored event version user");
  requireExactKeys(
    value.fieldEvidence,
    ["occurrence", "entity", "eventType"],
    "Stored event evidence",
  );
  const occurrence = requireOccurrence(value.occurrence);
  requireDateOrNull(value.occurrenceInstant, "Stored event occurrence instant");
  return {
    ...value,
    eventType: requireEventType(value.eventType),
    occurrence,
    docTypePatch: requireDocTypePatch(value.docTypePatch),
    fieldEvidence: {
      occurrence: requireEvidenceIds(
        value.fieldEvidence.occurrence,
        "Occurrence evidence",
      ),
      entity: requireEvidenceIds(value.fieldEvidence.entity, "Entity evidence"),
      eventType: requireEvidenceIds(
        value.fieldEvidence.eventType,
        "Event type evidence",
      ),
    },
  } as EventVersionRow;
}

function observationFromRow(row: Record<string, unknown>): ObservationRow {
  const value = camelize<Record<string, unknown>>(row, ["schemaVersion"]);
  requireString(value.userId, "Stored observation user");
  requireString(value.observationType, "Stored observation type");
  requireString(value.observationKey, "Stored observation key");
  const occurrence = requireOccurrence(value.occurrence);
  requireDateOrNull(
    value.occurrenceInstant,
    "Stored observation occurrence instant",
  );
  return {
    ...value,
    eventType: requireEventType(value.eventType),
    occurrence,
    value: requireObservationValue(value.value),
    valueEvidence: requireEvidenceIds(
      value.valueEvidence,
      "Observation value evidence",
    ),
  } as ObservationRow;
}

function entityFromRow(row: Record<string, unknown>): EntityRow {
  const value = camelize<EntityRow>(row);
  if (
    !["person", "organization", "project", "place", "other"].includes(
      value.kind,
    )
  ) {
    throw new Error("Record entity kind is invalid");
  }
  return value;
}

function sortableInstant(instant: number): string {
  return (BigInt(instant) + BigInt(Number.MAX_SAFE_INTEGER))
    .toString()
    .padStart(17, "0");
}

/** Exported for `../extraction/model.ts`, which writes `document_statement`
 * rows directly (see the storage note there) and must derive the same index
 * fields `validateOccurrenceIndexes` checks on the way back out. */
export function occurrenceSortKey(
  occurrence: Occurrence,
  stableIdentity: string,
): string | null {
  const date = occurrenceCalendarDate(occurrence);
  if (date === undefined) return null;
  return occurrence.precision === "datetime"
    ? `${date}|1|${sortableInstant(occurrence.instant)}|${stableIdentity}`
    : `${date}|0|${stableIdentity}`;
}

function validateOccurrenceIndexes(
  occurrence: Occurrence,
  date: string | null,
  instant: Date | null,
  sortKey: string | null,
  stableIdentity: string,
  label: string,
): void {
  if (
    date !== (occurrenceCalendarDate(occurrence) ?? null) ||
    (instant?.getTime() ?? null) !==
      (occurrence.precision === "datetime" ? occurrence.instant : null) ||
    sortKey !== occurrenceSortKey(occurrence, stableIdentity)
  ) {
    throw new Error(`${label} occurrence index fields are invalid`);
  }
}

function requireEventSchema(
  type: RecordEventType,
  schemaVersion: number,
  entity: EntityRow,
): void {
  if (schemaVersion !== 1)
    throw new Error("Only record schema version 1 is supported");
  if (isCardRecordKind(type)) {
    requireCardEventSchema(type, entity);
  } else if (type === "lab_panel" && entity.kind !== "person") {
    throw new Error("Lab panels must belong to a person entity");
  } else if (type === "vehicle_service" && entity.kind !== "other") {
    throw new Error(
      "Vehicle service must belong to an other-kind vehicle entity",
    );
  }
}

function requireObservationSchema(
  eventType: RecordEventType,
  observationType: string,
  observationKey: string,
  value: ObservationValue,
): void {
  if (!OBSERVATION_TYPE_PATTERN.test(observationType)) {
    throw new Error(
      "Observation type must contain 1-64 lowercase letters, numbers, or underscores",
    );
  }
  requireBoundedUtf8(
    observationKey,
    "Observation key",
    MAX_OBSERVATION_KEY_UTF8_BYTES,
  );
  if (isCardRecordKind(eventType)) {
    requireCardObservationSchema(
      eventType,
      observationType,
      observationKey,
      value,
    );
  } else if (eventType === "financial_transaction" && value.type !== "money") {
    throw new Error("Financial transaction line items must use money values");
  } else if (
    eventType === "lab_panel" &&
    !["decimal", "integer", "text", "boolean"].includes(value.type)
  ) {
    throw new Error(
      "Lab panel observations support decimal, integer, text, or boolean values",
    );
  }
}

function requireParserArtifact(
  artifact: SourceParserArtifactRow | undefined,
  generation: ProcessingGenerationRow,
  revision: SourceRevisionRow,
): void {
  if (
    !artifact ||
    artifact.spaceId !== generation.spaceId ||
    artifact.sourceAccountId !== generation.sourceAccountId ||
    artifact.sourceItemId !== generation.sourceItemId ||
    artifact.sourceRevisionId !== revision.id ||
    artifact.hashAuthority !== "worker_asserted"
  ) {
    throw new Error("Generation parser artifact parent chain is invalid");
  }
}

async function requireGenerationChain(
  client: ClientBase,
  spaceId: string,
  generationId: string,
  cache: RecordHydrationCache,
): Promise<GenerationChain> {
  requireBudgetOpen(cache);
  const cached = cache.generationChains.get(generationId);
  if (cached) {
    if (cached.space.id !== spaceId) {
      throw new Error("Processing generation belongs to another space");
    }
    return cached;
  }
  const generation = await getRow(
    client,
    "processing_generations",
    generationId,
    camelizeProcessingGeneration,
  );
  if (!generation) throw new Error("Processing generation does not exist");
  if (generation.spaceId !== spaceId) {
    throw new Error("Processing generation belongs to another space");
  }
  if (!generation.sourceTextVersionId) {
    throw new Error("Processing generation has no immutable text version");
  }
  const space = await getRow(client, "spaces", spaceId, (row) =>
    camelize<SpaceRow>(row),
  );
  const sourceAccount = await getRow(
    client,
    "source_accounts",
    generation.sourceAccountId,
    (row) =>
      camelize<SourceAccountRow>(row, [
        "cursorVersion",
        "freshnessMs",
        "inventoryEpoch",
        "completedInventoryEpoch",
        "manifestVersion",
        "workerAssessmentEpoch",
      ]),
  );
  const sourceItem = await getRow(
    client,
    "source_items",
    generation.sourceItemId,
    camelizeSourceItem,
  );
  const sourceRevision = await getRow(
    client,
    "source_revisions",
    generation.sourceRevisionId,
    camelizeSourceRevision,
  );
  const sourceTextVersion = await getRow(
    client,
    "source_text_versions",
    generation.sourceTextVersionId,
    camelizeSourceTextVersion,
  );
  if (!space) throw new Error("Record space does not exist");
  if (!sourceAccount || sourceAccount.spaceId !== spaceId) {
    throw new Error("Generation source account belongs to another space");
  }
  if (
    !sourceItem ||
    sourceItem.spaceId !== spaceId ||
    sourceItem.sourceAccountId !== sourceAccount.id
  ) {
    throw new Error("Generation source item parent chain is invalid");
  }
  if (
    !sourceRevision ||
    sourceRevision.spaceId !== spaceId ||
    sourceRevision.sourceItemId !== sourceItem.id
  ) {
    throw new Error("Generation source revision parent chain is invalid");
  }
  if (
    !sourceTextVersion ||
    sourceTextVersion.spaceId !== spaceId ||
    sourceTextVersion.sourceRevisionId !== sourceRevision.id
  ) {
    throw new Error("Generation source text version parent chain is invalid");
  }

  const revision = parseSourceRevisionRepresentation(sourceRevision);
  const text = parseSourceTextRepresentation(sourceTextVersion);
  let representation: GenerationChain["representation"];
  let sourceText: string | undefined;
  let loadedBytes = 0;
  if (revision.kind === "inline_utf8_v1" && text.kind === "inline_text_v1") {
    if (
      utf8Length(revision.text) !== sourceRevision.byteLength ||
      (await sha256Utf8(revision.text)) !== sourceRevision.contentHash ||
      utf8Length(text.text) !== sourceTextVersion.byteLength ||
      (await sha256Utf8(text.text)) !== sourceTextVersion.textHash
    ) {
      throw new Error(
        "Generation inline source hash or byte length is invalid",
      );
    }
    representation = "inline_text_v1";
    sourceText = text.text;
    loadedBytes = utf8Length(revision.text) + utf8Length(text.text);
  } else if (
    revision.kind === "archived_binary_v1" &&
    text.kind === "parsed_pages_v1" &&
    text.sealed &&
    text.hashAuthority === "server_verified_retained_text" &&
    generation.parserArtifactId === text.parserArtifactId
  ) {
    const parserArtifact = await getRow(
      client,
      "source_parser_artifacts",
      text.parserArtifactId,
      camelizeSourceParserArtifact,
    );
    requireParserArtifact(parserArtifact, generation, sourceRevision);
    representation = "parsed_pages_v1";
  } else {
    throw new Error("Generation source representation pair is invalid");
  }
  reserveBudget(
    cache,
    "loadedUtf8Bytes",
    "maxLoadedUtf8Bytes",
    loadedBytes,
    "loaded",
  );
  const chain: GenerationChain = {
    space,
    sourceAccount,
    sourceItem,
    sourceRevision,
    sourceTextVersion,
    representation,
    ...(sourceText === undefined ? {} : { sourceText }),
    generation,
  };
  cache.generationChains.set(generationId, chain);
  return chain;
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
    !scope.sourceAccountIds.includes(chain.sourceAccount.id)
  ) {
    throw new Error("Source account is outside the requested scope");
  }
  if (chain.generation.state !== "ready") {
    throw new Error("Record generation is not ready for reads");
  }
  const { activatedAt, deactivatedAt } = chain.generation;
  if (
    !(activatedAt instanceof Date) ||
    Number.isNaN(activatedAt.getTime()) ||
    activatedAt.getTime() < 0 ||
    (deactivatedAt !== null &&
      (!(deactivatedAt instanceof Date) ||
        Number.isNaN(deactivatedAt.getTime()) ||
        deactivatedAt.getTime() <= activatedAt.getTime()))
  ) {
    throw new Error("Record generation activation interval is invalid");
  }
  const current =
    (chain.sourceItem.activeGenerationId === chain.generation.id ||
      chain.sourceItem.activeCardGenerationId === chain.generation.id) &&
    chain.sourceItem.activeRevisionId === chain.generation.sourceRevisionId;
  if (scope.snapshot === undefined) {
    if (!current || deactivatedAt !== null) {
      throw new Error("Record generation is not the valid current generation");
    }
    return;
  }
  const snapshot =
    scope.snapshot instanceof Date ? scope.snapshot.getTime() : scope.snapshot;
  if (!Number.isFinite(snapshot) || snapshot < 0) {
    throw new Error("Record snapshot must be a non-negative finite timestamp");
  }
  if (
    activatedAt.getTime() > snapshot ||
    (deactivatedAt !== null && snapshot >= deactivatedAt.getTime())
  ) {
    throw new Error("Record generation was not active at the snapshot");
  }
  if (deactivatedAt === null && !current) {
    throw new Error("Open record generation is not the current source version");
  }
}

function evidenceCache(
  cache: RecordHydrationCache,
  generationId: string,
): EvidenceValidationCache {
  const saved = cache.evidenceByGeneration.get(generationId);
  if (saved) return saved;
  const created: EvidenceValidationCache = {
    spans: new Map(),
    pages: new Map(),
    quotes: new Map(),
    validatedPageIds: new Set(),
    validatedSpanIds: new Set(),
  };
  cache.evidenceByGeneration.set(generationId, created);
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

async function requireEvidence(
  client: ClientBase,
  chain: GenerationChain,
  ids: readonly string[],
  label: string,
  hydration: RecordHydrationCache,
  cache: EvidenceValidationCache,
): Promise<void> {
  requireEvidenceIds(ids, label);
  for (const id of ids) {
    requireBudgetOpen(hydration);
    let span = cache.spans.get(id);
    if (!span) {
      span = await getRow(client, "evidence_spans", id, camelizeEvidenceSpan);
      if (span) cache.spans.set(id, span);
    }
    if (
      !span ||
      span.spaceId !== chain.space.id ||
      span.sourceRevisionId !== chain.sourceRevision.id ||
      span.sourceTextVersionId !== chain.sourceTextVersion.id
    ) {
      throw new Error(`${label} belongs to another generation text chain`);
    }
    if (cache.validatedSpanIds.has(id)) continue;
    let page = cache.pages.get(span.sourcePageId);
    if (!page) {
      page = await getRow(
        client,
        "source_pages",
        span.sourcePageId,
        camelizeSourcePage,
      );
      if (page) {
        reserveBudget(
          hydration,
          "loadedUtf8Bytes",
          "maxLoadedUtf8Bytes",
          utf8Length(page.text),
          "loaded",
        );
        cache.pages.set(page.id, page);
      }
    }
    if (
      !page ||
      page.spaceId !== chain.space.id ||
      page.sourceTextVersionId !== chain.sourceTextVersion.id
    ) {
      throw new Error(`${label} has an invalid source page parent`);
    }
    if (!cache.validatedPageIds.has(page.id)) {
      if (chain.sourceText === undefined) {
        if (
          !Number.isSafeInteger(page.start) ||
          !Number.isSafeInteger(page.end) ||
          page.start < 0 ||
          page.end - page.start !== page.text.length
        ) {
          throw new Error(
            `${label} source page range does not match its page text`,
          );
        }
      } else {
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
      }
      if ((await sha256Utf8(page.text)) !== page.textHash) {
        throw new Error(`${label} source page hash is invalid`);
      }
      cache.validatedPageIds.add(page.id);
    }
    requireUtf16Range(page.text, span.start, span.end, label);
    const quote = page.text.slice(span.start, span.end);
    if ((await sha256Utf8(quote)) !== span.quoteHash) {
      throw new Error(`${label} quote hash is invalid`);
    }
    reserveBudget(
      hydration,
      "evidenceQuoteUtf8Bytes",
      "maxEvidenceQuoteUtf8Bytes",
      utf8Length(quote),
      "evidence",
    );
    cache.quotes.set(id, quote);
    cache.validatedSpanIds.add(id);
  }
}

function boundedEvidenceProjection(
  cache: EvidenceValidationCache,
  ids: readonly string[],
): HydratedEvidence[] {
  const evidence = [...new Set(ids)].map((id) => {
    const span = cache.spans.get(id);
    const quote = cache.quotes.get(id);
    if (!span || quote === undefined) {
      throw new Error("Hydrated evidence was not fully validated");
    }
    return { span, quote };
  });
  const bytes = evidence.reduce((sum, item) => sum + utf8Length(item.quote), 0);
  if (
    evidence.length > MAX_HYDRATED_EVIDENCE_SPANS ||
    bytes > MAX_HYDRATED_EVIDENCE_UTF8_BYTES
  ) {
    throw new Error("Hydrated record evidence exceeds the global limit");
  }
  return evidence;
}

function eventEvidenceIds(row: EventVersionRow): string[] {
  return [
    ...row.fieldEvidence.occurrence,
    ...row.fieldEvidence.entity,
    ...row.fieldEvidence.eventType,
  ];
}

async function requireEntity(
  client: ClientBase,
  entityId: string,
  spaceId: string,
): Promise<EntityRow> {
  const entity = await getRow(client, "entities", entityId, entityFromRow);
  if (!entity) throw new Error("Record entity does not exist");
  if (entity.spaceId !== spaceId) {
    throw new Error("Record entity belongs to another space");
  }
  return entity;
}

async function validateStoredEventVersion(
  client: ClientBase,
  chain: GenerationChain,
  row: EventVersionRow,
  hydration: RecordHydrationCache,
  evidence: EvidenceValidationCache,
): Promise<{ event: EventRow; entity: EntityRow; references: number }> {
  if (
    row.spaceId !== chain.space.id ||
    row.sourceAccountId !== chain.sourceAccount.id ||
    row.sourceItemId !== chain.sourceItem.id ||
    row.sourceRevisionId !== chain.sourceRevision.id ||
    row.sourceTextVersionId !== chain.sourceTextVersion.id ||
    row.processingGenerationId !== chain.generation.id
  ) {
    throw new Error("Event version parent chain is invalid");
  }
  const event = await getRow(client, "events", row.eventId, (stored) =>
    camelize<EventRow>(stored),
  );
  const entity = await requireEntity(client, row.entityId, chain.space.id);
  if (
    !event ||
    event.spaceId !== chain.space.id ||
    event.sourceAccountId !== chain.sourceAccount.id ||
    event.sourceItemId !== chain.sourceItem.id
  ) {
    throw new Error("Event version has an invalid stable event parent");
  }
  requireBoundedUtf8(event.eventKey, "Event key", MAX_EVENT_KEY_UTF8_BYTES);
  requireEventSchema(row.eventType, row.schemaVersion, entity);
  if (
    isCardRecordKind(row.eventType) !==
    (chain.generation.cardGeneration === true)
  ) {
    throw new Error("Stored record kind does not match its generation kind");
  }
  validateOccurrenceIndexes(
    row.occurrence,
    row.occurrenceDate,
    row.occurrenceInstant,
    row.occurrenceSortKey,
    `${row.eventId}|${row.processingGenerationId}`,
    "Event version",
  );
  await requireEvidence(
    client,
    chain,
    row.fieldEvidence.occurrence,
    "Occurrence evidence",
    hydration,
    evidence,
  );
  await requireEvidence(
    client,
    chain,
    row.fieldEvidence.entity,
    "Entity evidence",
    hydration,
    evidence,
  );
  await requireEvidence(
    client,
    chain,
    row.fieldEvidence.eventType,
    "Event type evidence",
    hydration,
    evidence,
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
  client: ClientBase,
  chain: GenerationChain,
  row: ObservationRow,
  version: EventVersionRow,
  hydration: RecordHydrationCache,
  evidence: EvidenceValidationCache,
): Promise<number> {
  if (
    row.spaceId !== chain.space.id ||
    row.sourceAccountId !== chain.sourceAccount.id ||
    row.sourceItemId !== chain.sourceItem.id ||
    row.sourceRevisionId !== chain.sourceRevision.id ||
    row.sourceTextVersionId !== chain.sourceTextVersion.id ||
    row.processingGenerationId !== chain.generation.id ||
    row.eventVersionId !== version.id ||
    row.eventId !== version.eventId ||
    row.entityId !== version.entityId ||
    row.eventType !== version.eventType ||
    row.schemaVersion !== version.schemaVersion ||
    !sameStructuredValue(row.occurrence, version.occurrence) ||
    row.occurrenceDate !== version.occurrenceDate ||
    (row.occurrenceInstant?.getTime() ?? null) !==
      (version.occurrenceInstant?.getTime() ?? null) ||
    row.userId !== version.userId
  ) {
    throw new Error("Observation parent or event-version fields are invalid");
  }
  validateOccurrenceIndexes(
    row.occurrence,
    row.occurrenceDate,
    row.occurrenceInstant,
    row.occurrenceSortKey,
    `${row.eventId}|${row.observationKey}|${row.processingGenerationId}`,
    "Observation",
  );
  requireObservationSchema(
    row.eventType,
    row.observationType,
    row.observationKey,
    row.value,
  );
  if (row.value.type === "entity") {
    await requireEntity(client, row.value.entityId, chain.space.id);
  }
  if (row.boundEntityId !== null) {
    await requireEntity(client, row.boundEntityId, chain.space.id);
  }
  await requireEvidence(
    client,
    chain,
    row.valueEvidence,
    "Observation value evidence",
    hydration,
    evidence,
  );
  return row.valueEvidence.length;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requireStageBatchShape(input: StageRecordBatchInput): void {
  requireExactKeys(
    input,
    ["spaceId", "processingGenerationId", "userId", "records"],
    "Record batch",
  );
  requireString(input.spaceId, "Record batch space");
  requireString(input.processingGenerationId, "Record batch generation");
  requireString(input.userId, "Record batch actor");
  if (!Array.isArray(input.records) || input.records.length === 0) {
    throw new Error("Record batch must contain at least one event");
  }
  const rowCount = input.records.reduce((total, record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Staged event is malformed");
    }
    return (
      total +
      1 +
      (Array.isArray((record as StagedEventRecord).observations)
        ? (record as StagedEventRecord).observations.length
        : 0)
    );
  }, 0);
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

function requireStagedEventShape(record: StagedEventRecord): void {
  requireExactKeys(
    record,
    [
      "eventKey",
      "entityId",
      "eventType",
      "schemaVersion",
      "occurrence",
      "fieldEvidence",
      "observations",
    ],
    "Staged event",
  );
  requireString(record.eventKey, "Event key");
  requireBoundedUtf8(record.eventKey, "Event key", MAX_EVENT_KEY_UTF8_BYTES);
  requireString(record.entityId, "Event entity");
  requireEventType(record.eventType);
  if (record.schemaVersion !== 1) {
    throw new Error("Only record schema version 1 is supported");
  }
  requireExactKeys(
    record.fieldEvidence,
    ["occurrence", "entity", "eventType"],
    "Staged event evidence",
  );
  requireEvidenceIds(record.fieldEvidence.occurrence, "Occurrence evidence");
  requireEvidenceIds(record.fieldEvidence.entity, "Entity evidence");
  requireEvidenceIds(record.fieldEvidence.eventType, "Event type evidence");
  requireOccurrence(record.occurrence);
  if (!Array.isArray(record.observations)) {
    throw new Error("Staged event observations are malformed");
  }
  const keys = new Set<string>();
  for (const observation of record.observations) {
    requireExactKeys(
      observation,
      ["observationKey", "observationType", "value", "valueEvidence"],
      "Staged observation",
    );
    requireString(observation.observationKey, "Observation key");
    requireString(observation.observationType, "Observation type");
    requireBoundedUtf8(
      observation.observationKey,
      "Observation key",
      MAX_OBSERVATION_KEY_UTF8_BYTES,
    );
    if (!OBSERVATION_TYPE_PATTERN.test(observation.observationType)) {
      throw new Error(
        "Observation type must contain 1-64 lowercase letters, numbers, or underscores",
      );
    }
    requireEvidenceIds(observation.valueEvidence, "Observation value evidence");
    requireObservationValue(observation.value, false);
    if (keys.has(observation.observationKey)) {
      throw new Error("Event contains duplicate observation keys");
    }
    keys.add(observation.observationKey);
  }
}

async function lockGenerationChain(
  client: ClientBase,
  spaceId: string,
  generationId: string,
): Promise<{
  chain: GenerationChain;
  hydration: RecordHydrationCache;
  evidence: EvidenceValidationCache;
}> {
  const located = await client.query<{
    source_item_id: string | null;
  }>(
    "SELECT source_item_id FROM kith.processing_generations WHERE id=$1 AND space_id=$2",
    [generationId, spaceId],
  );
  if (located.rowCount !== 1 || !located.rows[0]!.source_item_id) {
    throw new Error("Processing generation does not exist in this space");
  }
  const sourceItemId = located.rows[0]!.source_item_id;
  const itemLock = await client.query(
    "SELECT id FROM kith.source_items WHERE id=$1 AND space_id=$2 FOR UPDATE",
    [sourceItemId, spaceId],
  );
  if (itemLock.rowCount !== 1) {
    throw new Error("Generation source item parent chain is invalid");
  }
  const generationLock = await client.query(
    "SELECT id FROM kith.processing_generations WHERE id=$1 AND space_id=$2 AND source_item_id=$3 FOR UPDATE",
    [generationId, spaceId, sourceItemId],
  );
  if (generationLock.rowCount !== 1) {
    throw new Error("Processing generation changed before it could be locked");
  }
  const hydration = createRecordHydrationCache(client, {
    maxLoadedUtf8Bytes: 16 * 1_024 * 1_024,
    maxEvidenceQuoteUtf8Bytes: MAX_GENERATION_EVIDENCE_UTF8_BYTES,
  });
  const chain = await requireGenerationChain(
    client,
    spaceId,
    generationId,
    hydration,
  );
  return {
    chain,
    hydration,
    evidence: evidenceCache(hydration, generationId),
  };
}

async function requireUser(client: ClientBase, userId: string): Promise<void> {
  const result = await client.query("SELECT id FROM kith.users WHERE id=$1", [
    userId,
  ]);
  if (result.rowCount !== 1) throw new Error("Record actor does not exist");
}

async function findStableEvent(
  client: ClientBase,
  sourceItemId: string,
  eventKey: string,
): Promise<EventRow | undefined> {
  const result = await client.query<QueryResultRow>(
    `SELECT * FROM kith.events
      WHERE source_item_id=$1 AND event_key=$2 LIMIT 2`,
    [sourceItemId, eventKey],
  );
  if (result.rows.length > 1) throw new Error("Event identity is not unique");
  return result.rows[0]
    ? camelize<EventRow>(result.rows[0] as Record<string, unknown>)
    : undefined;
}

async function findEventVersion(
  client: ClientBase,
  eventId: string,
  generationId: string,
): Promise<EventVersionRow | undefined> {
  const result = await client.query<QueryResultRow>(
    `SELECT * FROM kith.event_versions
      WHERE event_id=$1 AND processing_generation_id=$2 LIMIT 2`,
    [eventId, generationId],
  );
  if (result.rows.length > 1) {
    throw new Error("Event version identity is not unique");
  }
  return result.rows[0]
    ? eventVersionFromRow(result.rows[0] as Record<string, unknown>)
    : undefined;
}

async function findObservation(
  client: ClientBase,
  eventId: string,
  observationKey: string,
  generationId: string,
): Promise<ObservationRow | undefined> {
  const result = await client.query<QueryResultRow>(
    `SELECT * FROM kith.observations
      WHERE event_id=$1 AND observation_key=$2
        AND processing_generation_id=$3 LIMIT 2`,
    [eventId, observationKey, generationId],
  );
  if (result.rows.length > 1) {
    throw new Error("Observation identity is not unique");
  }
  return result.rows[0]
    ? observationFromRow(result.rows[0] as Record<string, unknown>)
    : undefined;
}

/** Exported alongside {@link occurrenceSortKey}, for the same reason. */
export function occurrenceColumns(occurrence: Occurrence): {
  date: string | null;
  instant: Date | null;
} {
  return {
    date: occurrenceCalendarDate(occurrence) ?? null,
    instant:
      occurrence.precision === "datetime" ? new Date(occurrence.instant) : null,
  };
}

function sameEventVersion(
  row: EventVersionRow,
  expected: {
    spaceId: string;
    sourceAccountId: string;
    sourceItemId: string;
    sourceRevisionId: string;
    sourceTextVersionId: string;
    processingGenerationId: string;
    eventId: string;
    entityId: string;
    eventType: RecordEventType;
    schemaVersion: number;
    occurrence: Occurrence;
    occurrenceDate: string | null;
    occurrenceInstant: Date | null;
    occurrenceSortKey: string | null;
    fieldEvidence: RecordFieldEvidence;
    docTypePatch: CardDocTypePatch | null;
    userId: string;
  },
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
    (row.occurrenceInstant?.getTime() ?? null) ===
      (expected.occurrenceInstant?.getTime() ?? null) &&
    row.occurrenceSortKey === expected.occurrenceSortKey &&
    sameIds(row.fieldEvidence.occurrence, expected.fieldEvidence.occurrence) &&
    sameIds(row.fieldEvidence.entity, expected.fieldEvidence.entity) &&
    sameIds(row.fieldEvidence.eventType, expected.fieldEvidence.eventType) &&
    sameStructuredValue(row.docTypePatch, expected.docTypePatch) &&
    row.userId === expected.userId
  );
}

function sameObservation(
  row: ObservationRow,
  expected: {
    spaceId: string;
    sourceAccountId: string;
    sourceItemId: string;
    sourceRevisionId: string;
    sourceTextVersionId: string;
    processingGenerationId: string;
    eventId: string;
    eventVersionId: string;
    entityId: string;
    eventType: RecordEventType;
    occurrence: Occurrence;
    occurrenceDate: string | null;
    occurrenceInstant: Date | null;
    occurrenceSortKey: string | null;
    observationKey: string;
    observationType: string;
    schemaVersion: number;
    value: ObservationValue;
    valueEvidence: string[];
    boundEntityId: string | null;
    userId: string;
  },
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
    row.schemaVersion === expected.schemaVersion &&
    sameStructuredValue(row.occurrence, expected.occurrence) &&
    row.occurrenceDate === expected.occurrenceDate &&
    (row.occurrenceInstant?.getTime() ?? null) ===
      (expected.occurrenceInstant?.getTime() ?? null) &&
    row.occurrenceSortKey === expected.occurrenceSortKey &&
    row.observationKey === expected.observationKey &&
    row.observationType === expected.observationType &&
    sameStructuredValue(row.value, expected.value) &&
    sameIds(row.valueEvidence, expected.valueEvidence) &&
    row.userId === expected.userId
  );
}

/**
 * Lower-level staging primitive. The caller must authorize the actor and
 * space, then call this on a fresh checked-out client inside a
 * `withKithTransaction` SERIALIZABLE transaction with lease fencing. A final
 * transaction must validate the completed generation again before publishing
 * it. Do not reuse a hydration cache created before the locks acquired here.
 *
 * The source-item lock serializes stable event identity across generations;
 * the generation lock serializes replay decisions and generation bounds.
 */
export async function stageRecordBatch(
  client: ClientBase,
  input: StageRecordBatchInput,
): Promise<StageRecordBatchResult> {
  requireStageBatchShape(input);
  const { chain, hydration, evidence } = await lockGenerationChain(
    client,
    input.spaceId,
    input.processingGenerationId,
  );
  if (chain.sourceItem.lifecycle !== "available") {
    throw new Error("Records can only be staged for an available source item");
  }
  if (!["processing", "staged"].includes(chain.generation.state)) {
    throw new Error("Processing generation is not open for record staging");
  }
  await requireUser(client, input.userId);
  const existingVersionsResult = await client.query<QueryResultRow>(
    `SELECT * FROM kith.event_versions
      WHERE processing_generation_id=$1 LIMIT $2`,
    [chain.generation.id, MAX_EVENTS_PER_GENERATION + 1],
  );
  const existingObservationsResult = await client.query<QueryResultRow>(
    `SELECT * FROM kith.observations
      WHERE processing_generation_id=$1 LIMIT $2`,
    [chain.generation.id, MAX_OBSERVATIONS_PER_GENERATION + 1],
  );
  if (existingVersionsResult.rows.length > MAX_EVENTS_PER_GENERATION) {
    throw new Error("Processing generation exceeds the event limit");
  }
  if (
    existingObservationsResult.rows.length > MAX_OBSERVATIONS_PER_GENERATION
  ) {
    throw new Error("Processing generation exceeds the observation limit");
  }
  let eventVersionCount = existingVersionsResult.rows.length;
  let observationCount = existingObservationsResult.rows.length;
  let insertedEventCount = 0;
  let insertedEventVersionCount = 0;
  let insertedObservationCount = 0;
  const eventIds: string[] = [];
  const eventVersionIds: string[] = [];
  const observationIds: string[] = [];
  const batchEventKeys = new Set<string>();

  for (const record of input.records) {
    requireStagedEventShape(record);
    if (batchEventKeys.has(record.eventKey)) {
      throw new Error("Record batch contains duplicate event keys");
    }
    batchEventKeys.add(record.eventKey);
    const occurrence = requireOccurrence(record.occurrence);
    const occurrenceFields = occurrenceColumns(occurrence);
    const entity = await requireEntity(client, record.entityId, input.spaceId);
    requireEventSchema(record.eventType, record.schemaVersion, entity);
    if (
      isCardRecordKind(record.eventType) !==
      (chain.generation.cardGeneration === true)
    ) {
      throw new Error(
        isCardRecordKind(record.eventType)
          ? "Card records require a card processing generation"
          : "A card processing generation accepts only card records",
      );
    }
    for (const [ids, label] of [
      [record.fieldEvidence.occurrence, "Occurrence evidence"],
      [record.fieldEvidence.entity, "Entity evidence"],
      [record.fieldEvidence.eventType, "Event type evidence"],
    ] as const) {
      await requireEvidence(client, chain, ids, label, hydration, evidence);
    }
    boundedEvidenceProjection(evidence, [
      ...record.fieldEvidence.occurrence,
      ...record.fieldEvidence.entity,
      ...record.fieldEvidence.eventType,
    ]);

    let event = await findStableEvent(
      client,
      chain.sourceItem.id,
      record.eventKey,
    );
    if (event) {
      if (
        event.spaceId !== input.spaceId ||
        event.sourceAccountId !== chain.sourceAccount.id ||
        event.sourceItemId !== chain.sourceItem.id ||
        event.eventKey !== record.eventKey
      ) {
        throw new Error("Conflicting immutable event identity");
      }
    } else {
      event = {
        id: newKithId(),
        spaceId: input.spaceId,
        createdAt: new Date(),
        sourceAccountId: chain.sourceAccount.id,
        sourceItemId: chain.sourceItem.id,
        eventKey: record.eventKey,
        createdBy: input.userId,
      };
      await client.query(
        `INSERT INTO kith.events
          (id,space_id,created_at,source_account_id,source_item_id,event_key,created_by)
        VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6)`,
        [
          event.id,
          event.spaceId,
          event.sourceAccountId,
          event.sourceItemId,
          event.eventKey,
          event.createdBy,
        ],
      );
      insertedEventCount += 1;
    }

    let version = await findEventVersion(client, event.id, chain.generation.id);
    const expectedVersion = {
      spaceId: input.spaceId,
      sourceAccountId: chain.sourceAccount.id,
      sourceItemId: chain.sourceItem.id,
      sourceRevisionId: chain.sourceRevision.id,
      sourceTextVersionId: chain.sourceTextVersion.id,
      processingGenerationId: chain.generation.id,
      eventId: event.id,
      entityId: entity.id,
      eventType: record.eventType,
      schemaVersion: record.schemaVersion,
      occurrence,
      occurrenceDate: occurrenceFields.date,
      occurrenceInstant: occurrenceFields.instant,
      occurrenceSortKey: occurrenceSortKey(
        occurrence,
        `${event.id}|${chain.generation.id}`,
      ),
      fieldEvidence: record.fieldEvidence,
      docTypePatch: null,
      userId: version?.userId ?? input.userId,
    };
    if (version) {
      if (!sameEventVersion(version, expectedVersion)) {
        throw new Error("Conflicting immutable event version");
      }
    } else {
      if (eventVersionCount >= MAX_EVENTS_PER_GENERATION) {
        throw new Error(
          `Processing generation exceeds ${MAX_EVENTS_PER_GENERATION} events`,
        );
      }
      version = {
        id: newKithId(),
        createdAt: new Date(),
        ...expectedVersion,
      } as EventVersionRow;
      await client.query(
        `INSERT INTO kith.event_versions
          (id,space_id,created_at,source_account_id,source_item_id,
           source_revision_id,source_text_version_id,processing_generation_id,
           event_id,entity_id,event_type,schema_version,occurrence,
           occurrence_date,occurrence_instant,occurrence_sort_key,
           field_evidence,doc_type_patch,user_id)
        VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17,$18)`,
        [
          version.id,
          version.spaceId,
          version.sourceAccountId,
          version.sourceItemId,
          version.sourceRevisionId,
          version.sourceTextVersionId,
          version.processingGenerationId,
          version.eventId,
          version.entityId,
          version.eventType,
          version.schemaVersion,
          version.occurrence,
          version.occurrenceDate,
          version.occurrenceInstant,
          version.occurrenceSortKey,
          version.fieldEvidence,
          version.docTypePatch,
          version.userId,
        ],
      );
      eventVersionCount += 1;
      insertedEventVersionCount += 1;
    }
    eventIds.push(event.id);
    eventVersionIds.push(version.id);

    for (const staged of record.observations) {
      const value = requireObservationValue(staged.value, false);
      requireObservationSchema(
        record.eventType,
        staged.observationType,
        staged.observationKey,
        value,
      );
      if (value.type === "entity") {
        await requireEntity(client, value.entityId, input.spaceId);
      }
      await requireEvidence(
        client,
        chain,
        staged.valueEvidence,
        "Observation value evidence",
        hydration,
        evidence,
      );
      boundedEvidenceProjection(evidence, [
        ...eventEvidenceIds(version),
        ...staged.valueEvidence,
      ]);
      const expectedObservation = {
        spaceId: input.spaceId,
        sourceAccountId: chain.sourceAccount.id,
        sourceItemId: chain.sourceItem.id,
        sourceRevisionId: chain.sourceRevision.id,
        sourceTextVersionId: chain.sourceTextVersion.id,
        processingGenerationId: chain.generation.id,
        eventId: event.id,
        eventVersionId: version.id,
        entityId: entity.id,
        eventType: record.eventType,
        occurrence,
        occurrenceDate: occurrenceFields.date,
        occurrenceInstant: occurrenceFields.instant,
        occurrenceSortKey: occurrenceSortKey(
          occurrence,
          `${event.id}|${staged.observationKey}|${chain.generation.id}`,
        ),
        observationKey: staged.observationKey,
        observationType: staged.observationType,
        schemaVersion: record.schemaVersion,
        value,
        valueEvidence: staged.valueEvidence,
        boundEntityId: null,
        userId: version.userId,
      };
      const existing = await findObservation(
        client,
        event.id,
        staged.observationKey,
        chain.generation.id,
      );
      if (existing) {
        if (!sameObservation(existing, expectedObservation)) {
          throw new Error("Conflicting immutable observation version");
        }
        observationIds.push(existing.id);
        continue;
      }
      if (observationCount >= MAX_OBSERVATIONS_PER_GENERATION) {
        throw new Error(
          `Processing generation exceeds ${MAX_OBSERVATIONS_PER_GENERATION} observations`,
        );
      }
      const observation = {
        id: newKithId(),
        createdAt: new Date(),
        ...expectedObservation,
      } as ObservationRow;
      await client.query(
        `INSERT INTO kith.observations
          (id,space_id,created_at,source_account_id,source_item_id,
           source_revision_id,source_text_version_id,processing_generation_id,
           event_id,event_version_id,entity_id,event_type,occurrence,
           occurrence_date,occurrence_instant,occurrence_sort_key,
           observation_key,observation_type,schema_version,value,
           value_evidence,bound_entity_id,user_id)
        VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          observation.id,
          observation.spaceId,
          observation.sourceAccountId,
          observation.sourceItemId,
          observation.sourceRevisionId,
          observation.sourceTextVersionId,
          observation.processingGenerationId,
          observation.eventId,
          observation.eventVersionId,
          observation.entityId,
          observation.eventType,
          observation.occurrence,
          observation.occurrenceDate,
          observation.occurrenceInstant,
          observation.occurrenceSortKey,
          observation.observationKey,
          observation.observationType,
          observation.schemaVersion,
          observation.value,
          JSON.stringify(observation.valueEvidence),
          observation.boundEntityId,
          observation.userId,
        ],
      );
      observationCount += 1;
      insertedObservationCount += 1;
      observationIds.push(observation.id);
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

/**
 * Validates the complete stored generation under the same caller-owned
 * authorized SERIALIZABLE transaction and lock order as staging. Publication
 * must use the returned proof in that transaction; a prior hydration cache is
 * not a substitute because lifecycle and generation state may have changed.
 */
export async function validateGenerationRecords(
  client: ClientBase,
  input: {
    spaceId: string;
    processingGenerationId: string;
    expectedEventCount: number;
    expectedObservationCount: number;
  },
): Promise<ValidatedGenerationRecords> {
  requireExactKeys(
    input,
    [
      "spaceId",
      "processingGenerationId",
      "expectedEventCount",
      "expectedObservationCount",
    ],
    "Generation record validation",
  );
  requireString(input.spaceId, "Generation record validation space");
  requireString(
    input.processingGenerationId,
    "Generation record validation generation",
  );
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
  const { chain, hydration, evidence } = await lockGenerationChain(
    client,
    input.spaceId,
    input.processingGenerationId,
  );
  const versionResult = await client.query<QueryResultRow>(
    `SELECT * FROM kith.event_versions
      WHERE processing_generation_id=$1 LIMIT $2`,
    [chain.generation.id, MAX_EVENTS_PER_GENERATION + 1],
  );
  const observationResult = await client.query<QueryResultRow>(
    `SELECT * FROM kith.observations
      WHERE processing_generation_id=$1 LIMIT $2`,
    [chain.generation.id, MAX_OBSERVATIONS_PER_GENERATION + 1],
  );
  if (versionResult.rows.length !== input.expectedEventCount) {
    throw new Error(
      `Generation event count mismatch: expected ${input.expectedEventCount}, found ${versionResult.rows.length}`,
    );
  }
  if (observationResult.rows.length !== input.expectedObservationCount) {
    throw new Error(
      `Generation observation count mismatch: expected ${input.expectedObservationCount}, found ${observationResult.rows.length}`,
    );
  }
  const eventVersions = versionResult.rows.map((row) =>
    eventVersionFromRow(row as Record<string, unknown>),
  );
  const observations = observationResult.rows.map((row) =>
    observationFromRow(row as Record<string, unknown>),
  );
  const versionById = new Map<string, EventVersionRow>();
  const versionIdentities = new Set<string>();
  const stableEventKeys = new Set<string>();
  let evidenceReferenceCount = 0;
  for (const version of eventVersions) {
    const validated = await validateStoredEventVersion(
      client,
      chain,
      version,
      hydration,
      evidence,
    );
    const identity = `${validated.event.id}|${chain.generation.id}`;
    if (versionIdentities.has(identity)) {
      throw new Error("Generation contains duplicate event version identities");
    }
    versionIdentities.add(identity);
    const stableKey = `${validated.event.sourceItemId}|${validated.event.eventKey}`;
    if (stableEventKeys.has(stableKey)) {
      throw new Error("Generation contains duplicate stable event identities");
    }
    stableEventKeys.add(stableKey);
    versionById.set(version.id, version);
    evidenceReferenceCount += validated.references;
    boundedEvidenceProjection(evidence, eventEvidenceIds(version));
  }
  const observationIdentities = new Set<string>();
  const observationsPerVersion = new Map<string, number>();
  for (const observation of observations) {
    const version = versionById.get(observation.eventVersionId);
    if (!version) {
      throw new Error("Observation has no event version in its generation");
    }
    const identity = `${observation.eventId}|${observation.observationKey}|${chain.generation.id}`;
    if (observationIdentities.has(identity)) {
      throw new Error("Generation contains duplicate observation identities");
    }
    observationIdentities.add(identity);
    evidenceReferenceCount += await validateStoredObservation(
      client,
      chain,
      observation,
      version,
      hydration,
      evidence,
    );
    boundedEvidenceProjection(evidence, [
      ...eventEvidenceIds(version),
      ...observation.valueEvidence,
    ]);
    observationsPerVersion.set(
      version.id,
      (observationsPerVersion.get(version.id) ?? 0) + 1,
    );
  }
  if (evidenceReferenceCount > MAX_GENERATION_EVIDENCE_REFERENCES) {
    throw new Error("Generation record evidence exceeds the global limit");
  }
  for (const version of eventVersions) {
    if (
      (version.eventType === "lab_panel" ||
        version.eventType === "financial_transaction") &&
      !observationsPerVersion.has(version.id)
    ) {
      throw new Error(`${version.eventType} requires at least one observation`);
    }
  }
  return {
    eventVersions,
    observations,
    evidenceSpanCount: evidence.spans.size,
    evidenceReferenceCount,
  };
}

/**
 * Lower-level read primitive. The caller must authenticate the principal and
 * derive an authorized space plus current source grants before calling it.
 * This function validates persisted scope and optional narrowing; it does not
 * make an authorization decision.
 */
export async function hydrateEventVersion(
  client: ClientBase,
  input: RecordHydrationScope & { eventVersionId: string },
): Promise<HydratedEventVersion> {
  const cache = cacheFor(client, input.cache);
  requireBudgetOpen(cache);
  const eventVersion = await getRow(
    client,
    "event_versions",
    input.eventVersionId,
    eventVersionFromRow,
  );
  if (!eventVersion) throw new Error("Event version does not exist");
  if (eventVersion.spaceId !== input.spaceId) {
    throw new Error("Event version belongs to another space");
  }
  const chain = await requireGenerationChain(
    client,
    input.spaceId,
    eventVersion.processingGenerationId,
    cache,
  );
  requireReadableGeneration(chain, input);
  const evidence = evidenceCache(cache, eventVersion.processingGenerationId);
  const validated = await validateStoredEventVersion(
    client,
    chain,
    eventVersion,
    cache,
    evidence,
  );
  if (validated.references > MAX_HYDRATED_EVIDENCE_SPANS) {
    throw new Error("Hydrated event evidence exceeds the global limit");
  }
  const proof = boundedEvidenceProjection(
    evidence,
    eventEvidenceIds(eventVersion),
  );
  return {
    ...chain,
    event: validated.event,
    eventVersion,
    entity: validated.entity,
    evidenceSpans: proof.map((item) => item.span),
    evidence: proof,
  };
}

/** Same lower-level authorization contract as {@link hydrateEventVersion}. */
export async function hydrateObservation(
  client: ClientBase,
  input: RecordHydrationScope & { observationId: string },
): Promise<HydratedObservation> {
  const cache = cacheFor(client, input.cache);
  requireBudgetOpen(cache);
  const observation = await getRow(
    client,
    "observations",
    input.observationId,
    observationFromRow,
  );
  if (!observation) throw new Error("Observation does not exist");
  if (observation.spaceId !== input.spaceId) {
    throw new Error("Observation belongs to another space");
  }
  const hydrated = await hydrateEventVersion(client, {
    ...input,
    cache,
    eventVersionId: observation.eventVersionId,
  });
  const evidence = evidenceCache(cache, observation.processingGenerationId);
  const references =
    hydrated.eventVersion.fieldEvidence.occurrence.length +
    hydrated.eventVersion.fieldEvidence.entity.length +
    hydrated.eventVersion.fieldEvidence.eventType.length +
    (await validateStoredObservation(
      client,
      hydrated,
      observation,
      hydrated.eventVersion,
      cache,
      evidence,
    ));
  if (references > MAX_HYDRATED_EVIDENCE_SPANS) {
    throw new Error("Hydrated observation evidence exceeds the global limit");
  }
  const proof = boundedEvidenceProjection(evidence, [
    ...eventEvidenceIds(hydrated.eventVersion),
    ...observation.valueEvidence,
  ]);
  return {
    ...hydrated,
    observation,
    evidenceSpans: proof.map((item) => item.span),
    evidence: proof,
  };
}
