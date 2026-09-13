// Ported from packages/convex/convex/models/facts/model.ts.
//
// Every function here takes an already-authorized `spaceId` (writes) or
// `spaceIds` set (reads) -- section 2.5's space check is the caller's job,
// exactly as `src/provenance/model.ts` and `src/documents/inventory.ts`
// already document for their own domains. `test/memoryFacts.test.mjs` proves
// the composed property end to end: `getAuthorizedReadSpaceIds` /
// `requireSpaceAccess` from `../identity/index.js` denying access, and these
// functions never seeing a space id that denial withheld.
//
// `searchFacts`'s Convex original ran over a `tsvector`-equivalent search
// index (`by_searchText`), which is P2-39g's column to add. That half of the
// read is not ported; `getFactsByIds` is the seam P2-39g's index plugs into
// instead (see the module comment on it below), and `listFacts` -- which
// needs no index, only `status`/`is_core`/`created_at` -- is fully ported.

import { row, rows, exec, at, ms, type IdentityCtx } from "../identity/db.js";
import { assertKithId, newKithId } from "../ids.js";
import { getEntity, resolveEntity, type Entity, type EntitySelector } from "./entities.js";
import { assertValidMemoryValidity, isMemoryRetrievable } from "./lifecycle.js";

export const MAX_FACT_SEARCH_LIMIT = 50;
export const DEFAULT_FACT_SEARCH_LIMIT = 10;
export const MAX_CURRENT_FACTS_PER_PREDICATE = 100;
const MAX_FACT_CANDIDATE_READS = 1_500;
const MAX_FACT_HISTORY_READS = 1_500;
const MAX_FACT_HISTORY_LINKS_PER_FACT = MAX_CURRENT_FACTS_PER_PREDICATE + 1;
const FACT_TEXT_MAX_CHARS = 1_000;
const SOURCE_REF_MAX_CHARS = 500;
const BATCH_ID_MAX_CHARS = 160;
const PREDICATE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DERIVED_OR_SENSITIVE_PREDICATES = new Set([
  "age",
  "current_age",
  "years_old",
  "password",
  "api_key",
  "access_token",
  "refresh_token",
  "secret",
]);

export type FactSourceType = "user_stated" | "user_confirmed";
export type FactStatus = "current" | "superseded" | "retracted";

export type FactValueInput =
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "datetime"; value: number }
  | { type: "number"; value: number; unit?: string }
  | { type: "boolean"; value: boolean }
  | { type: "entity"; entity: EntitySelector };

export type FactValue =
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "datetime"; value: number }
  | { type: "number"; value: number; unit?: string }
  | { type: "boolean"; value: boolean }
  | { type: "entity"; entityId: string };

type FactRow = {
  id: string;
  space_id: string;
  created_at: Date;
  user_id: string;
  subject_entity_id: string;
  predicate: string;
  value: FactValue;
  statement: string;
  search_text: string;
  source_type: FactSourceType;
  source_ref: string | null;
  observed_at: Date | null;
  batch_id: string | null;
  confidence: string | number;
  is_core: boolean | null;
  valid_from: Date | null;
  valid_to: Date | null;
  status: FactStatus;
  superseded_at: Date | null;
  superseded_by: string | null;
  supersedes: string[] | null;
  change_reason: string | null;
  updated_at: Date | null;
};

const FACT_COLUMNS = `id, space_id, created_at, user_id, subject_entity_id, predicate, value,
       statement, search_text, source_type, source_ref, observed_at, batch_id,
       confidence, is_core, valid_from, valid_to, status, superseded_at,
       superseded_by, supersedes, change_reason, updated_at`;

function boundedText(value: string, label: string, maxChars: number): string {
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maxChars) {
    throw new Error(`${label} must contain 1-${maxChars} characters`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: string | undefined,
  label: string,
  maxChars: number,
): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, maxChars);
}

export function normalizePredicate(predicate: string): string {
  const normalized = predicate.trim().toLocaleLowerCase("en-US");
  if (!PREDICATE_PATTERN.test(normalized)) {
    throw new Error("Predicate must be 2-64 lowercase letters, numbers, or underscores");
  }
  if (DERIVED_OR_SENSITIVE_PREDICATES.has(normalized)) {
    if (["age", "current_age", "years_old"].includes(normalized)) {
      throw new Error(
        "Do not store a derived age. Store date_of_birth only when the exact date was explicitly stated or confirmed.",
      );
    }
    throw new Error("Credentials and secrets must not be stored as facts");
  }
  return normalized;
}

export function normalizeIsoDate(value: string): string {
  const match = ISO_DATE_PATTERN.exec(value.trim());
  if (!match) throw new Error("Date facts must use YYYY-MM-DD");
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error("Date fact is not a real calendar date");
  }
  return `${yearText}-${monthText}-${dayText}`;
}

async function normalizeFactValue(
  ctx: IdentityCtx,
  userId: string,
  spaceId: string,
  value: FactValueInput,
): Promise<FactValue> {
  switch (value.type) {
    case "text":
      return { type: "text", value: boundedText(value.value, "Fact value", FACT_TEXT_MAX_CHARS) };
    case "date":
      return { type: "date", value: normalizeIsoDate(value.value) };
    case "datetime":
      if (!Number.isFinite(value.value)) {
        throw new Error("Datetime fact must be a finite Unix timestamp");
      }
      return value;
    case "number":
      if (!Number.isFinite(value.value)) throw new Error("Number fact must be finite");
      return { ...value, unit: normalizeOptionalText(value.unit, "Fact unit", 80) };
    case "boolean":
      return value;
    case "entity": {
      const entity = await resolveEntity(ctx, userId, spaceId, value.entity);
      return { type: "entity", entityId: entity.id };
    }
  }
}

function factValueKey(value: FactValue): string {
  switch (value.type) {
    case "entity":
      return `entity:${value.entityId}`;
    case "number":
      return `number:${value.value}:${value.unit ?? ""}`;
    default:
      return `${value.type}:${String(value.value).normalize("NFKC").toLocaleLowerCase("en-US")}`;
  }
}

function displayFactValue(value: FactValue, objectEntity: Entity | null): string {
  switch (value.type) {
    case "entity":
      return objectEntity?.canonicalName ?? "Unknown entity";
    case "datetime":
      return new Date(value.value).toISOString();
    case "number":
      return `${value.value}${value.unit ? ` ${value.unit}` : ""}`;
    case "boolean":
      return value.value ? "yes" : "no";
    default:
      return value.value;
  }
}

function predicateLabel(predicate: string): string {
  return predicate.replaceAll("_", " ");
}

export function isFactActive(
  fact: { status: FactStatus; validFrom?: number; validTo?: number },
  at: number = Date.now(),
): boolean {
  return (
    fact.status === "current" &&
    (fact.validFrom === undefined || fact.validFrom <= at) &&
    (fact.validTo === undefined || at < fact.validTo)
  );
}

/** Returns whether a fact may be returned by a read. Ported from `isFactRetrievable`. */
export function isFactRetrievable(
  fact: { status: FactStatus; validFrom?: number; validTo?: number },
  includeHistorical: boolean | undefined,
  at: number = Date.now(),
): boolean {
  return isMemoryRetrievable(
    { memoryStatus: fact.status, validFrom: fact.validFrom, validTo: fact.validTo },
    includeHistorical,
    at,
  );
}

export type RememberFactArgs = {
  subject: EntitySelector;
  predicate: string;
  value: FactValueInput;
  sourceType: FactSourceType;
  sourceRef?: string;
  observedAt?: number;
  batchId?: string;
  isCore?: boolean;
  validFrom?: number;
  validTo?: number;
  cardinality?: "single" | "multiple";
  changeKind?: "changed" | "corrected";
  changeReason?: string;
};

export type RememberFactResult = {
  factId: string;
  statement: string;
  operation: "stored" | "noop" | "superseded" | "corrected";
};

/** Ported from `rememberFact`. `spaceId` is already authorized for write. */
export async function rememberFact(
  ctx: IdentityCtx,
  userId: string,
  spaceId: string,
  args: RememberFactArgs,
): Promise<RememberFactResult> {
  assertValidMemoryValidity(args);
  if (args.observedAt !== undefined && !Number.isFinite(args.observedAt)) {
    throw new Error("observedAt must be a finite timestamp");
  }
  const subject = await resolveEntity(ctx, userId, spaceId, args.subject);
  const predicate = normalizePredicate(args.predicate);
  if (predicate === "date_of_birth" && args.value.type !== "date") {
    throw new Error("date_of_birth must use an exact date value");
  }
  const value = await normalizeFactValue(ctx, userId, spaceId, args.value);
  const objectEntity = value.type === "entity" ? await getEntity(ctx, value.entityId) : null;
  if (objectEntity && objectEntity.spaceId !== spaceId) {
    throw new Error("Fact value entity is unavailable");
  }
  const displayedValue = displayFactValue(value, objectEntity);
  const statement = `${subject.canonicalName} — ${predicateLabel(predicate)}: ${displayedValue}.`;
  const searchText = [
    subject.key,
    subject.canonicalName,
    ...subject.aliases,
    predicate,
    predicateLabel(predicate),
    displayedValue,
    objectEntity?.key,
    ...(objectEntity?.aliases ?? []),
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ");
  const sourceRef = normalizeOptionalText(args.sourceRef, "Source reference", SOURCE_REF_MAX_CHARS);
  const batchId = normalizeOptionalText(args.batchId, "Batch id", BATCH_ID_MAX_CHARS);
  const changeReason = normalizeOptionalText(args.changeReason, "Change reason", 500);

  const current = (
    await rows<FactRow>(
      ctx,
      `SELECT ${FACT_COLUMNS} FROM kith.facts
        WHERE space_id = $1 AND subject_entity_id = $2 AND predicate = $3 AND status = 'current'
        LIMIT $4`,
      [spaceId, subject.id, predicate, MAX_CURRENT_FACTS_PER_PREDICATE + 1],
    )
  ).map(toStoredFact);
  if (current.length > MAX_CURRENT_FACTS_PER_PREDICATE) {
    throw new Error(
      `Fact transition exceeds the ${MAX_CURRENT_FACTS_PER_PREDICATE}-record current-value limit`,
    );
  }
  const valueKey = factValueKey(value);
  const duplicate = current.find(
    (fact) =>
      factValueKey(fact.value) === valueKey &&
      (isFactActive(fact) || (fact.validFrom === args.validFrom && fact.validTo === args.validTo)),
  );
  if (duplicate) {
    await exec(
      ctx,
      `UPDATE kith.facts
          SET is_core = $2, source_type = $3, source_ref = $4, observed_at = $5,
              batch_id = $6, confidence = 1, statement = $7, search_text = $8, updated_at = $9
        WHERE id = $1`,
      [
        duplicate.id,
        args.isCore ?? duplicate.isCore ?? null,
        args.sourceType,
        sourceRef ?? duplicate.sourceRef ?? null,
        at(args.observedAt ?? duplicate.observedAt),
        batchId ?? duplicate.batchId ?? null,
        statement,
        searchText,
        new Date(ctx.now),
      ],
    );
    return { factId: duplicate.id, statement, operation: "noop" };
  }

  if ((args.cardinality ?? "single") === "multiple" && current.length >= MAX_CURRENT_FACTS_PER_PREDICATE) {
    throw new Error(`Fact current-value limit of ${MAX_CURRENT_FACTS_PER_PREDICATE} reached`);
  }

  const affected = (args.cardinality ?? "single") === "single" ? current : [];
  const factId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.facts
       (id, space_id, created_at, user_id, subject_entity_id, predicate, value,
        statement, search_text, source_type, source_ref, observed_at, batch_id,
        confidence, is_core, valid_from, valid_to, status, supersedes, change_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13,
               1, $14, $15, $16, 'current', $17::jsonb, $18)`,
    [
      factId,
      spaceId,
      new Date(ctx.now),
      userId,
      subject.id,
      predicate,
      JSON.stringify(value),
      statement,
      searchText,
      args.sourceType,
      sourceRef ?? null,
      at(args.observedAt),
      batchId ?? null,
      args.isCore ?? null,
      at(args.validFrom),
      at(args.validTo),
      affected.length > 0 ? JSON.stringify(affected.map((fact) => fact.id)) : null,
      changeReason ?? null,
    ],
  );

  for (const prior of affected) {
    const corrected = args.changeKind === "corrected";
    const validTo =
      !corrected &&
      args.validFrom !== undefined &&
      prior.validTo === undefined &&
      (prior.validFrom === undefined || prior.validFrom < args.validFrom)
        ? args.validFrom
        : prior.validTo;
    await exec(
      ctx,
      `UPDATE kith.facts
          SET status = $2, superseded_at = $3, superseded_by = $4, change_reason = $5,
              valid_from = $6, valid_to = $7
        WHERE id = $1`,
      [
        prior.id,
        corrected ? "retracted" : "superseded",
        new Date(ctx.now),
        factId,
        changeReason ?? (corrected ? "Earlier fact was corrected" : "Fact changed"),
        corrected ? null : at(prior.validFrom),
        corrected ? null : at(validTo),
      ],
    );
  }

  return {
    factId,
    statement,
    operation:
      affected.length === 0
        ? "stored"
        : args.changeKind === "corrected"
          ? "corrected"
          : "superseded",
  };
}

type StoredFact = {
  id: string;
  spaceId: string;
  createdAt: number;
  userId: string;
  subjectEntityId: string;
  predicate: string;
  value: FactValue;
  statement: string;
  searchText: string;
  sourceType: FactSourceType;
  sourceRef: string | null;
  observedAt: number | undefined;
  batchId: string | null;
  confidence: number;
  isCore: boolean | null;
  validFrom: number | undefined;
  validTo: number | undefined;
  status: FactStatus;
  supersededAt: number | undefined;
  supersededBy: string | null;
  supersedes: readonly string[];
  changeReason: string | null;
  updatedAt: number | undefined;
};

function toStoredFact(record: FactRow): StoredFact {
  return {
    id: record.id,
    spaceId: record.space_id,
    createdAt: ms(record.created_at)!,
    userId: record.user_id,
    subjectEntityId: record.subject_entity_id,
    predicate: record.predicate,
    value: record.value,
    statement: record.statement,
    searchText: record.search_text,
    sourceType: record.source_type,
    sourceRef: record.source_ref,
    observedAt: ms(record.observed_at) ?? undefined,
    batchId: record.batch_id,
    confidence: Number(record.confidence),
    isCore: record.is_core,
    validFrom: ms(record.valid_from) ?? undefined,
    validTo: ms(record.valid_to) ?? undefined,
    status: record.status,
    supersededAt: ms(record.superseded_at) ?? undefined,
    supersededBy: record.superseded_by,
    supersedes: record.supersedes ?? [],
    changeReason: record.change_reason,
    updatedAt: ms(record.updated_at) ?? undefined,
  };
}

export type HydratedFact = {
  id: string;
  spaceId: string;
  userId: string;
  statement: string;
  subject: { id: string; key: string; kind: string; name: string; aliases: readonly string[] };
  predicate: string;
  value:
    | Exclude<FactValue, { type: "entity" }>
    | {
        type: "entity";
        entity: { id: string; key: string; kind: string; name: string; aliases: readonly string[] };
      };
  sourceType: FactSourceType;
  sourceRef: string | null;
  observedAt: number | undefined;
  batchId: string | null;
  confidence: number;
  isCore: boolean;
  validFrom: number | undefined;
  validTo: number | undefined;
  status: FactStatus;
  supersededAt: number | undefined;
  supersededBy: string | null;
  supersedes: readonly string[];
  changeReason: string | null;
  createdAt: number;
  updatedAt: number | undefined;
};

function entityView(entity: Entity) {
  return { id: entity.id, key: entity.key, kind: entity.kind, name: entity.canonicalName, aliases: entity.aliases };
}

/**
 * Hydrates one fact row for a caller authorized to read `authorizedSpaceIds`.
 * Ported from `hydrateFact`: the subject, the object entity (if the value is
 * one), and every history link (`supersededBy` plus `supersedes`) are each
 * re-checked against the fact's own space, so a fact whose history or object
 * reaches outside that space -- which should never happen, but the schema
 * does not prove it cannot -- is withheld rather than partially rendered.
 */
export async function hydrateFact(
  ctx: IdentityCtx,
  fact: StoredFact,
  authorizedSpaceIds: ReadonlySet<string>,
): Promise<HydratedFact | null> {
  if (!authorizedSpaceIds.has(fact.spaceId)) return null;
  const historyIds = [...(fact.supersededBy ? [fact.supersededBy] : []), ...fact.supersedes];
  if (historyIds.length > MAX_FACT_HISTORY_LINKS_PER_FACT) return null;

  const [subject, objectEntity, history] = await Promise.all([
    getEntity(ctx, fact.subjectEntityId),
    fact.value.type === "entity" ? getEntity(ctx, fact.value.entityId) : Promise.resolve(null),
    Promise.all(historyIds.map((factId) => getStoredFact(ctx, factId))),
  ]);
  if (
    !subject ||
    subject.spaceId !== fact.spaceId ||
    (fact.value.type === "entity" && (!objectEntity || objectEntity.spaceId !== fact.spaceId)) ||
    history.some((linked) => !linked || linked.spaceId !== fact.spaceId)
  ) {
    return null;
  }

  return {
    id: fact.id,
    spaceId: fact.spaceId,
    userId: fact.userId,
    statement: fact.statement,
    subject: entityView(subject),
    predicate: fact.predicate,
    value:
      fact.value.type === "entity"
        ? { type: "entity", entity: entityView(objectEntity!) }
        : (fact.value as Exclude<FactValue, { type: "entity" }>),
    sourceType: fact.sourceType,
    sourceRef: fact.sourceRef,
    observedAt: fact.observedAt,
    batchId: fact.batchId,
    confidence: fact.confidence,
    isCore: fact.isCore ?? false,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
    status: fact.status,
    supersededAt: fact.supersededAt,
    supersededBy: fact.supersededBy,
    supersedes: fact.supersedes,
    changeReason: fact.changeReason,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  };
}

async function getStoredFact(ctx: IdentityCtx, id: string): Promise<StoredFact | null> {
  const record = await row<FactRow>(ctx, `SELECT ${FACT_COLUMNS} FROM kith.facts WHERE id = $1`, [
    assertKithId(id, "invalid_fact_id"),
  ]);
  return record ? toStoredFact(record) : null;
}

function assertBoundedFactRead(spaceCount: number, perSpaceLimit: number): void {
  if (spaceCount * perSpaceLimit > MAX_FACT_CANDIDATE_READS) {
    throw new Error("Fact read scope is too broad; narrow spaces or lower limit");
  }
}

function assertBoundedHistoryHydration(facts: readonly StoredFact[]): void {
  const linkCount = facts.reduce(
    (count, fact) => count + (fact.supersededBy ? 1 : 0) + fact.supersedes.length,
    0,
  );
  if (linkCount > MAX_FACT_HISTORY_READS) {
    throw new Error("Fact history expansion exceeds the read limit");
  }
}

function compareNewestFirst(left: { createdAt: number; id: string }, right: { createdAt: number; id: string }) {
  return right.createdAt - left.createdAt || left.id.localeCompare(right.id);
}

export type ListFactsOptions = {
  limit?: number;
  includeHistorical?: boolean;
  coreOnly?: boolean;
};

/**
 * Current facts (or, with `includeHistorical`, every non-retracted fact)
 * across an authorized space set. Ported from `listFacts`; needs no index,
 * only `status`/`is_core`/`created_at`, so it is fully portable now.
 */
export async function listFacts(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  options: ListFactsOptions = {},
): Promise<HydratedFact[]> {
  const requested = options.limit ?? DEFAULT_FACT_SEARCH_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error("Fact limit must be a positive integer");
  }
  const limit = Math.min(requested, MAX_FACT_SEARCH_LIMIT);
  const activeAt = new Date(ctx.now);
  const uniqueSpaceIds = [...new Set(spaceIds)];
  assertBoundedFactRead(uniqueSpaceIds.length, limit);

  const bySpace = await Promise.all(
    uniqueSpaceIds.map(async (spaceId) => {
      let sql: string;
      const values: unknown[] = [spaceId];
      if (options.includeHistorical) {
        sql = options.coreOnly
          ? `SELECT ${FACT_COLUMNS} FROM kith.facts
              WHERE space_id = $1 AND is_core IS TRUE AND status <> 'retracted'
              ORDER BY created_at DESC, id DESC LIMIT $2`
          : `SELECT ${FACT_COLUMNS} FROM kith.facts
              WHERE space_id = $1 AND status <> 'retracted'
              ORDER BY created_at DESC, id DESC LIMIT $2`;
      } else {
        sql = options.coreOnly
          ? `SELECT ${FACT_COLUMNS} FROM kith.facts
              WHERE space_id = $1 AND is_core IS TRUE AND status = 'current'
                AND (valid_from IS NULL OR valid_from <= $3)
                AND (valid_to IS NULL OR $3 < valid_to)
              ORDER BY created_at DESC, id DESC LIMIT $2`
          : `SELECT ${FACT_COLUMNS} FROM kith.facts
              WHERE space_id = $1 AND status = 'current'
                AND (valid_from IS NULL OR valid_from <= $3)
                AND (valid_to IS NULL OR $3 < valid_to)
              ORDER BY created_at DESC, id DESC LIMIT $2`;
      }
      values.push(limit);
      if (!options.includeHistorical) values.push(activeAt);
      return (await rows<FactRow>(ctx, sql, values)).map(toStoredFact);
    }),
  );
  const selected = bySpace
    .flat()
    .sort(compareNewestFirst)
    .slice(0, limit);
  assertBoundedHistoryHydration(selected);
  const authorized = new Set(uniqueSpaceIds);
  const hydrated = await Promise.all(selected.map((fact) => hydrateFact(ctx, fact, authorized)));
  return hydrated.filter((fact): fact is HydratedFact => fact !== null);
}

/** Ported from `getFactById`. */
export async function getFactById(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  factId: string,
): Promise<HydratedFact | null> {
  const fact = await getStoredFact(ctx, factId);
  if (!fact) return null;
  return await hydrateFact(ctx, fact, new Set(spaceIds));
}

/**
 * The seam P2-39g's full-text (and any future vector) index plugs into: given
 * candidate fact ids already ranked by whatever index produced them, hydrate,
 * authorize and filter each one, preserving the caller's order (recall's blend
 * is order-sensitive, see `recall.ts`). `recallCandidates` in `test/helpers/
 * memoryFixture.mjs` is the deterministic fake that stands in for the real
 * index in tests -- it ranks by a plain substring match, which is enough to
 * prove the hydrate/authorize/order contract without pretending to be
 * `tsvector` ranking.
 */
export async function getFactsByIds(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  candidateIds: readonly string[],
  options: { includeHistorical?: boolean } = {},
): Promise<HydratedFact[]> {
  if (candidateIds.length === 0) return [];
  if (candidateIds.length > MAX_FACT_CANDIDATE_READS) {
    throw new Error("Fact candidate read exceeds the read limit");
  }
  const authorized = new Set(spaceIds);
  const records = await rows<FactRow>(
    ctx,
    `SELECT ${FACT_COLUMNS} FROM kith.facts WHERE id = ANY($1::text[])`,
    [candidateIds.map((id) => assertKithId(id, "invalid_fact_id"))],
  );
  const byId = new Map(records.map((record) => [record.id, toStoredFact(record)]));
  const activeAt = ctx.now;
  const ordered = candidateIds
    .map((id) => byId.get(id))
    .filter((fact): fact is StoredFact => fact !== undefined)
    .filter((fact) => isFactRetrievable(fact, options.includeHistorical, activeAt));
  assertBoundedHistoryHydration(ordered);
  const hydrated = await Promise.all(ordered.map((fact) => hydrateFact(ctx, fact, authorized)));
  return hydrated.filter((fact): fact is HydratedFact => fact !== null);
}
