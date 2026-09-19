// The `document_extraction` deferred-work kind: what schedules it, what it
// reads, and what it writes.
//
// Shape, and why it is this shape.
//
// *Pooled, not transaction scoped.* One model call per document sits in the
// middle of this job, and `KITH_IDLE_TRANSACTION_TIMEOUT_MS` is five seconds
// while a completion is bounded at two minutes. So the handler asks `drain`
// for the pool and opens two short transactions of its own with the provider
// call strictly between them -- the same rule, and the same registry scope,
// `embedding_fill` uses (`../deferred/registry.ts`).
//
// *Storage: one generic `document_statement` event per document, with one
// observation per statement.* The alternatives were a per-kind event type
// (which puts the closed enum straight back into code, defeating the whole
// point of kinds being rows) and a new statements table (which would need its
// own reader, and `query_records`, coverage and citations would not see it).
// A generic event type is the only one of the three where `sum_money`,
// `list_events` and `latest_observation` work on the result with no new read
// code at all. `event_type` is `text` in the schema and the closed list is the
// TypeScript array in `../records/model.ts`, so adding it was one line there.
//
// *The rows are written here rather than through `stageRecordBatch`.* That
// primitive stages into a generation that is still `processing` or `staged`
// and then requires a publication step to validate and activate it. Extraction
// runs *after* activation, over the sealed text of a generation that is
// already `ready`, so there is no open generation to stage into. What matters
// for reads is that every row satisfies `validateStoredEventVersion` and
// `validateStoredObservation`, which is what `query_records` runs on the way
// out; `buildRows` below writes exactly the columns those two check.
//
// *The subject entity is a placeholder.* The entity binding gate is dropped:
// names are stored as written and bound later. But `event_versions.entity_id`
// is read back through `requireEntity`, so every extraction in a space hangs
// off one `other:document` entity rather than off nothing. Binding a statement
// to a real entity later is an update to `observations.bound_entity_id`, which
// the column already exists for.

import type { ClientBase, Pool } from "pg";

import type {
  DocumentFieldCheck,
  DocumentFieldValueType,
} from "../admin/model.js";
import {
  schedule,
  type DeferredCtx,
  type DeferredWorkRow,
  type ScheduleResult,
} from "../deferred/core.js";
import { KITH_ID, newKithId } from "../ids.js";
import { locateCardQuote } from "../provenance/model.js";
import { sha256Utf8 } from "../provenance/sql.js";
import { occurrenceColumns, occurrenceSortKey } from "../records/model.js";
import type { ObservationValue, Occurrence } from "../records/values.js";
import { withKithTransaction } from "../schema.js";
import {
  openCorrection,
  reapplyCorrections,
  resolvedCorrections,
} from "./corrections.js";
import { seedDocumentTypes } from "./seed.js";
import {
  checkValue,
  isObservationFieldName,
  itemsSumToTotal,
  normalizeForMatch,
  type CorrectionReason,
} from "./gate.js";
import type { ExtractionModel, ModelReading } from "./provider.js";

// ---------------------------------------------------------------------------
// Bounds. A document past them is extracted from its first pages and says so.
// ---------------------------------------------------------------------------

/** Pages shown to the model. Past this the document is read partially and a
 * correction item records the limitation, which is the visible half of "never
 * silent". */
export const MAX_EXTRACTION_PAGES = 12;
/** Characters of page text shown to the model, whichever bound bites first. */
export const MAX_EXTRACTION_CHARS = 60_000;
/** Statements stored per document. */
export const MAX_EXTRACTION_STATEMENTS = 96;

const PLACEHOLDER_ENTITY_KEY = "other:document";
const EVENT_KEY = "document_statement:v1";
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export function extractionDedupeKey(sourceItemId: string): string {
  return `document_extraction:${sourceItemId}`;
}

/**
 * Enqueues extraction for one document, in the caller's transaction.
 *
 * Called from the three activation points beside `scheduleEmbeddingFill`, so
 * the job row commits with the publication or not at all, and a burst of
 * re-activations of the same item collapses onto one queued job.
 */
export async function scheduleDocumentExtraction(
  ctx: DeferredCtx,
  input: {
    spaceId: string;
    sourceItemId: string;
    processingGenerationId: string;
  },
): Promise<ScheduleResult> {
  return await schedule(ctx, {
    kind: "document_extraction",
    spaceId: input.spaceId,
    payload: {
      spaceId: input.spaceId,
      sourceItemId: input.sourceItemId,
      processingGenerationId: input.processingGenerationId,
    },
    dedupeKey: extractionDedupeKey(input.sourceItemId),
  });
}

/**
 * Re-extraction on demand: every document of one kind, or every document that
 * has never been extracted when `kind` is omitted. Bounded per call so an
 * accidental click cannot enqueue an unbounded sweep.
 */
export async function scheduleReextraction(
  ctx: DeferredCtx,
  input: { spaceId: string; kind?: string; limit?: number },
): Promise<string[]> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1_000);
  const result = await ctx.client.query<{
    source_item_id: string;
    processing_generation_id: string;
  }>(
    input.kind === undefined
      ? `SELECT source_item_id, processing_generation_id
           FROM kith.document_extractions
          WHERE space_id = $1 ORDER BY source_item_id LIMIT $2`
      : `SELECT source_item_id, processing_generation_id
           FROM kith.document_extractions
          WHERE space_id = $1 AND kind = $3 ORDER BY source_item_id LIMIT $2`,
    input.kind === undefined
      ? [input.spaceId, limit]
      : [input.spaceId, limit, input.kind],
  );
  const scheduled: string[] = [];
  for (const row of result.rows) {
    await scheduleDocumentExtraction(ctx, {
      spaceId: input.spaceId,
      sourceItemId: row.source_item_id,
      processingGenerationId: row.processing_generation_id,
    });
    scheduled.push(row.source_item_id);
  }
  return scheduled;
}

// ---------------------------------------------------------------------------
// Phase 1: what the model is shown
// ---------------------------------------------------------------------------

type TypeField = {
  name: string;
  valueType: DocumentFieldValueType;
  required: boolean;
  check: DocumentFieldCheck | null;
  example: string | null;
};

type LoadedType = {
  id: string;
  kind: string;
  version: number;
  guidance: string | null;
  description: string | null;
  fields: TypeField[];
};

type LoadedPage = { id: string; ordinal: number; text: string };

type Loaded = {
  spaceId: string;
  userId: string;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  processingGenerationId: string;
  pages: LoadedPage[];
  pagesTotal: number;
  types: LoadedType[];
};

async function loadDocument(
  client: ClientBase,
  spaceId: string,
  sourceItemId: string,
  now = Date.now(),
): Promise<Loaded | null> {
  const item = (
    await client.query<Record<string, unknown>>(
      `SELECT i.space_id, i.source_account_id, i.lifecycle,
              i.active_generation_id, s.created_by
         FROM kith.source_items i JOIN kith.spaces s ON s.id = i.space_id
        WHERE i.id = $1 LIMIT 1`,
      [sourceItemId],
    )
  ).rows[0];
  if (
    !item ||
    item.space_id !== spaceId ||
    item.lifecycle !== "available" ||
    typeof item.active_generation_id !== "string" ||
    typeof item.created_by !== "string"
  ) {
    return null;
  }
  const generation = (
    await client.query<Record<string, unknown>>(
      `SELECT id, space_id, source_revision_id, source_text_version_id, state
         FROM kith.processing_generations WHERE id = $1 LIMIT 1`,
      [item.active_generation_id],
    )
  ).rows[0];
  if (
    !generation ||
    generation.space_id !== spaceId ||
    generation.state !== "ready" ||
    typeof generation.source_revision_id !== "string" ||
    typeof generation.source_text_version_id !== "string"
  ) {
    return null;
  }
  const pageRows = (
    await client.query<Record<string, unknown>>(
      `SELECT id, ordinal, text FROM kith.source_pages
        WHERE source_text_version_id = $1 AND space_id = $2
        ORDER BY ordinal, id LIMIT 512`,
      [generation.source_text_version_id, spaceId],
    )
  ).rows;
  const pages = pageRows.map((row) => ({
    id: String(row.id),
    ordinal: Number(row.ordinal),
    text: String(row.text ?? ""),
  }));
  if (pages.length === 0) return null;
  return {
    spaceId,
    userId: item.created_by,
    sourceAccountId: String(item.source_account_id),
    sourceItemId,
    sourceRevisionId: generation.source_revision_id,
    sourceTextVersionId: generation.source_text_version_id,
    processingGenerationId: String(generation.id),
    pages: boundPages(pages),
    pagesTotal: pages.length,
    types: await loadTypes(client, spaceId, now),
  };
}

function boundPages(pages: readonly LoadedPage[]): LoadedPage[] {
  const kept: LoadedPage[] = [];
  let characters = 0;
  for (const page of pages) {
    if (kept.length >= MAX_EXTRACTION_PAGES) break;
    if (
      kept.length > 0 &&
      characters + page.text.length > MAX_EXTRACTION_CHARS
    ) {
      break;
    }
    characters += page.text.length;
    kept.push(page);
  }
  return kept;
}

async function loadTypes(
  client: ClientBase,
  spaceId: string,
  now: number,
): Promise<LoadedType[]> {
  // A space that has never had a document type gets the starter set, once,
  // here. Nothing else in the system would ever call the seed: the types and
  // fields screen that will own it is a later row, and until then a fresh
  // deployment would extract nothing at all while looking like it worked.
  // Idempotent by (space, kind), so this is a no-op from the second document
  // onward and it never touches a kind the owner has edited.
  const any = await client.query<{ id: string }>(
    `SELECT id FROM kith.document_types WHERE space_id = $1 LIMIT 1`,
    [spaceId],
  );
  if (any.rows.length === 0) {
    await seedDocumentTypes({ client, now }, spaceId);
  }
  // The highest active version of each kind: "editing creates a new version"
  // and an extraction runs against the current one.
  const typeRows = (
    await client.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (kind) id, kind, version, guidance, description
         FROM kith.document_types
        WHERE space_id = $1 AND active
        ORDER BY kind, version DESC LIMIT 200`,
      [spaceId],
    )
  ).rows;
  const types: LoadedType[] = [];
  for (const row of typeRows) {
    const fields = (
      await client.query<Record<string, unknown>>(
        `SELECT name, value_type, required, check_kind, example
           FROM kith.document_type_fields
          WHERE document_type_id = $1 AND space_id = $2
          ORDER BY created_at, id LIMIT 128`,
        [row.id, spaceId],
      )
    ).rows.map((field) => ({
      name: String(field.name),
      valueType: field.value_type as DocumentFieldValueType,
      required: field.required === true,
      check: (field.check_kind ?? null) as DocumentFieldCheck | null,
      example: (field.example ?? null) as string | null,
    }));
    types.push({
      id: String(row.id),
      kind: String(row.kind),
      version: Number(row.version),
      guidance: (row.guidance ?? null) as string | null,
      description: (row.description ?? null) as string | null,
      fields,
    });
  }
  return types;
}

/**
 * The prompt. One document, one call.
 *
 * Deliberately thin. Every instruction here is also enforced by the gate, so
 * a model that ignores the prompt produces correction items rather than wrong
 * facts, and lengthening the prompt buys precision the gate already provides.
 */
export function buildPrompt(loaded: Loaded): string {
  const catalog = loaded.types
    .map((type) => {
      const fields = type.fields
        .map(
          (field) =>
            `    - ${field.name} (${field.valueType})${
              field.required ? " [required]" : ""
            }${field.example ? ` e.g. ${field.example}` : ""}`,
        )
        .join("\n");
      return `  ${type.kind}: ${type.description ?? ""}\n    ${
        type.guidance ?? ""
      }\n${fields}`;
    })
    .join("\n");
  const body = loaded.pages
    .map((page) => `=== page ${page.ordinal} ===\n${page.text}`)
    .join("\n\n");
  const truncated =
    loaded.pages.length < loaded.pagesTotal
      ? `\nOnly the first ${loaded.pages.length} of ${loaded.pagesTotal} pages are shown.\n`
      : "";
  return `Read this document and report what it says. Do not infer, calculate, or convert anything.

Reply with JSON only:
{"kind": "<one kind below, or other>",
 "summary": "<one line>",
 "statements": [{"field": "<field name>", "value": <value>, "page": <page number>, "quote": "<text copied from that page>"}]}

Rules:
- Every statement needs a quote copied exactly from the page it cites. If you cannot copy a quote, omit the statement.
- Only use fields listed under the kind you chose. Omit a field the document does not state.
- Dates are YYYY-MM-DD. Money keeps the document's own digits, including the currency symbol if there is one.
- A line_item_list value is [{"description": "...", "amount": "..."}].
- Names, diagnoses and descriptions are copied as written. Do not normalize them.

Kinds:
${catalog}

Document:
${truncated}${body}
`;
}

// ---------------------------------------------------------------------------
// Phase 3: the gate, the spans and the rows
// ---------------------------------------------------------------------------

/** What the extraction row records per statement: the citation and the
 * per-statement detail `observations` has no column for. */
export type StoredStatement = {
  field: string;
  valueType: DocumentFieldValueType;
  page: number;
  quote: string;
  observationKeys: string[];
  evidenceSpanId: string;
  currencyAssumed?: true;
  /**
   * What the model read, as stored at extraction time.
   *
   * Kept here rather than inferred from the observation, because the
   * observation is the *current* value and a correction overwrites it (and is
   * re-applied after every re-extraction). Without this column the model's
   * reading would vanish the moment the owner corrected it, and the document
   * read could no longer show what was being corrected.
   */
  modelValue: ObservationValue | ObservationValue[];
};

type Prepared = {
  statements: StoredStatement[];
  observations: Array<{
    key: string;
    type: string;
    value: ObservationValue;
    evidence: string[];
  }>;
  failures: Array<{
    field: string | null;
    reason: CorrectionReason;
    reading: unknown;
  }>;
  occurrence: Occurrence;
};

async function findOrCreateSpan(
  client: ClientBase,
  loaded: Loaded,
  page: LoadedPage,
  quote: string,
): Promise<string | null> {
  const located = locateCardQuote(page.text, quote);
  if (
    !located ||
    located.start < 0 ||
    located.end <= located.start ||
    located.end > page.text.length
  ) {
    return null;
  }
  const existing = (
    await client.query<{ id: string }>(
      `SELECT id FROM kith.evidence_spans
        WHERE source_page_id = $1 AND "start" = $2 AND "end" = $3
        LIMIT 1`,
      [page.id, located.start, located.end],
    )
  ).rows[0];
  if (existing) return existing.id;
  // One aggregate rather than a scan of the page's spans: the ordinal only has
  // to be free, not the smallest free one, and a page whose spans outgrew a
  // scan bound would otherwise start reusing ordinal 0.
  const next = (
    await client.query<{ next: string }>(
      `SELECT COALESCE(max(ordinal), -1) + 1 AS next FROM kith.evidence_spans
        WHERE source_page_id = $1`,
      [page.id],
    )
  ).rows[0];
  const ordinal = Number(next?.next ?? 0);
  const id = newKithId();
  // `card_extraction_fingerprints` stays null on purpose: a null marks a span
  // that `sweepCardEvidenceSpans` must never collect, and these spans are
  // referenced by live observations rather than by a card generation.
  await client.query(
    `INSERT INTO kith.evidence_spans
       (id, space_id, created_at, source_revision_id, source_text_version_id,
        source_page_id, ordinal, "start", "end", quote_hash, locator)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,NULL)`,
    [
      id,
      loaded.spaceId,
      loaded.sourceRevisionId,
      loaded.sourceTextVersionId,
      page.id,
      ordinal,
      located.start,
      located.end,
      await sha256Utf8(page.text.slice(located.start, located.end)),
    ],
  );
  return id;
}

/**
 * Runs every statement through its gate and turns the survivors into
 * observations. A failure is recorded, never stored as a weaker fact.
 */
async function prepare(
  client: ClientBase,
  loaded: Loaded,
  reading: ModelReading,
  type: LoadedType | undefined,
): Promise<Prepared> {
  const prepared: Prepared = {
    statements: [],
    observations: [],
    failures: [],
    occurrence: { precision: "unknown" },
  };
  const fields = new Map(type ? type.fields.map((f) => [f.name, f]) : []);
  const pages = new Map(loaded.pages.map((page) => [page.ordinal, page]));
  const unknownFields: string[] = [];

  // Pass one: gate every statement. Nothing is materialised yet, because
  // whether a reading may be stored depends on what the *other* statements
  // said about the same field, and that is not known until the loop ends.
  type Accepted = {
    field: TypeField;
    page: number;
    quote: string;
    spanId: string;
    values: ObservationValue[];
    itemsTotal?: string;
    currencyAssumed?: true;
  };
  const accepted: Accepted[] = [];

  for (const statement of reading.statements.slice(
    0,
    MAX_EXTRACTION_STATEMENTS,
  )) {
    const field = fields.get(statement.field);
    // A field the type does not have, or one whose name could never be an
    // observation type. Both are the same thing to the owner -- the model
    // named something this kind cannot hold -- so they share a reason and,
    // below, a single correction row.
    if (!field || !isObservationFieldName(field.name)) {
      const named = (field?.name ?? statement.field) || "(unnamed)";
      if (!unknownFields.includes(named)) unknownFields.push(named);
      continue;
    }
    const page = pages.get(statement.page);
    if (!page || !statement.quote.trim()) {
      prepared.failures.push({
        field: field.name,
        reason: "quote_not_found",
        reading: statement.value,
      });
      continue;
    }
    const spanId = await findOrCreateSpan(
      client,
      loaded,
      page,
      statement.quote,
    );
    if (!spanId) {
      prepared.failures.push({
        field: field.name,
        reason: normalizeForMatch(page.text).includes(
          normalizeForMatch(statement.quote),
        )
          ? "span_unresolved"
          : "quote_not_found",
        reading: statement.value,
      });
      continue;
    }
    const gated = checkValue({
      valueType: field.valueType,
      value: statement.value,
      quote: statement.quote,
      pageText: page.text,
      defaultCurrency: "USD",
    });
    if (!gated.ok) {
      prepared.failures.push({
        field: field.name,
        reason: gated.reason,
        reading: statement.value,
      });
      continue;
    }
    accepted.push({
      field,
      page: statement.page,
      quote: statement.quote,
      spanId,
      values: gated.values,
      ...(gated.itemsTotal === undefined
        ? {}
        : { itemsTotal: gated.itemsTotal }),
      ...(gated.currencyAssumed ? { currencyAssumed: true as const } : {}),
    });
  }

  if (unknownFields.length > 0) {
    // One row for the whole document, not one per name: this is a sign the
    // kind is wrong or the guidance is stale, and it is one thing for the
    // owner to look at, not fifteen.
    prepared.failures.push({
      field: null,
      reason: "unknown_field",
      reading: { fields: unknownFields.slice(0, 64) },
    });
  }

  // Pass two: one observation per field per document.
  //
  // Two statements naming the same field with the same value are one reading
  // said twice, and the second is dropped. Two statements naming it with
  // *different* values are a document the model did not understand, and
  // neither value is stored: picking one would be a coin flip presented as a
  // cited fact. The owner gets a correction and both readings.
  const byField = new Map<string, Accepted[]>();
  for (const entry of accepted) {
    const group = byField.get(entry.field.name);
    if (group) group.push(entry);
    else byField.set(entry.field.name, [entry]);
  }

  const keep: Accepted[] = [];
  for (const [name, group] of byField) {
    const first = group[0]!;
    const shape = JSON.stringify(first.values);
    const disagreeing = group.filter(
      (entry) => JSON.stringify(entry.values) !== shape,
    );
    if (disagreeing.length > 0) {
      prepared.failures.push({
        field: name,
        reason: "conflicting_values",
        reading: group.map((entry) => ({
          value: entry.values,
          page: entry.page,
          quote: entry.quote,
        })),
      });
      continue;
    }
    keep.push(first);
  }

  // Pass three: materialise, in the order the model gave them, so the stored
  // statements read down the document rather than by field name.
  const kept = new Set(keep);
  const moneyByField = new Map<string, string>();
  const itemTotals = new Map<string, { total: string; check: string | null }>();
  for (const entry of accepted) {
    if (!kept.has(entry)) continue;
    kept.delete(entry);
    const name = entry.field.name;
    const keys: string[] = [];
    entry.values.forEach((value, index) => {
      const key = entry.values.length > 1 ? `${name}:${index}` : name;
      keys.push(key);
      prepared.observations.push({
        key,
        type: name,
        value,
        evidence: [entry.spanId],
      });
      if (value.type === "money" && !moneyByField.has(name)) {
        moneyByField.set(name, value.amount);
      }
      if (value.type === "date" && prepared.occurrence.precision === "unknown") {
        prepared.occurrence = { precision: "date", date: value.value };
      }
    });
    if (entry.itemsTotal !== undefined) {
      itemTotals.set(name, { total: entry.itemsTotal, check: entry.field.check });
    }
    prepared.statements.push({
      field: name,
      valueType: entry.field.valueType,
      page: entry.page,
      quote: entry.quote,
      observationKeys: keys,
      evidenceSpanId: entry.spanId,
      modelValue: entry.values.length > 1 ? entry.values : entry.values[0]!,
      ...(entry.currencyAssumed ? { currencyAssumed: true as const } : {}),
    });
  }

  // `sums_to_total`, the one check that spans two fields.
  //
  // Which field is doing the summing is data: a field whose `check_kind` is
  // `sums_to_total`. What it is summed *against* is a naming convention, not
  // data, and this is where it is written down: **a document type whose field
  // carries `sums_to_total` states the sum in a money field named `subtotal`,
  // or in one named `total` when it has no subtotal.** The preference matters
  // on a taxed receipt, where the items sum to the subtotal and the total
  // carries the tax; comparing to the total was a false mismatch on every
  // receipt with sales tax on it.
  //
  // A convention rather than a column because the alternative is a
  // `sums_into` foreign key on `document_type_fields` that every kind but
  // three would leave null, and the two names are already what every one of
  // the starter kinds calls them. Section 8 of
  // docs/plans/2026-09-18-admin-panel-and-ingestion.md states it too, so a
  // kind added from the admin screen can follow it. A kind that names its sum
  // something else simply gets no sum check, which is the same as declaring
  // none.
  //
  // Zero tolerance. The items are kept and the compared field opens the
  // correction.
  for (const [, items] of itemTotals) {
    if (items.check !== "sums_to_total") continue;
    const against = moneyByField.has("subtotal") ? "subtotal" : "total";
    const stated = moneyByField.get(against);
    if (stated === undefined) continue;
    if (!itemsSumToTotal(items.total, stated)) {
      prepared.failures.push({
        field: against,
        reason: "line_items_mismatch",
        reading: { statedTotal: stated, itemsTotal: items.total, against },
      });
    }
  }
  return prepared;
}

async function placeholderEntityId(
  client: ClientBase,
  spaceId: string,
  userId: string,
): Promise<string> {
  const existing = (
    await client.query<{ id: string }>(
      `SELECT id FROM kith.entities WHERE space_id = $1 AND key = $2 LIMIT 1`,
      [spaceId, PLACEHOLDER_ENTITY_KEY],
    )
  ).rows[0];
  if (existing) return existing.id;
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.entities
       (id, space_id, created_at, user_id, key, kind, canonical_name,
        normalized_name, aliases, normalized_aliases, updated_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,'other','Document','document',
             '[]'::jsonb,'[]'::jsonb,transaction_timestamp())`,
    [id, spaceId, userId, PLACEHOLDER_ENTITY_KEY],
  );
  return id;
}

async function stableEventId(
  client: ClientBase,
  loaded: Loaded,
): Promise<string> {
  const existing = (
    await client.query<{ id: string }>(
      `SELECT id FROM kith.events WHERE source_item_id = $1 AND event_key = $2
        LIMIT 1`,
      [loaded.sourceItemId, EVENT_KEY],
    )
  ).rows[0];
  if (existing) return existing.id;
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.events
       (id, space_id, created_at, source_account_id, source_item_id, event_key,
        created_by)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6)`,
    [
      id,
      loaded.spaceId,
      loaded.sourceAccountId,
      loaded.sourceItemId,
      EVENT_KEY,
      loaded.userId,
    ],
  );
  return id;
}

export type ExtractionOutcome = {
  sourceItemId: string;
  kind: string;
  stored: number;
  failed: number;
  truncated: boolean;
};

/**
 * The write half. One transaction: the previous extraction's rows go, the new
 * ones arrive, and the extraction row is rewritten, so a reader never sees a
 * half-replaced document. Corrections are never touched -- a human fix
 * outlives every re-extraction, and the read side prefers it.
 */
async function store(
  client: ClientBase,
  loaded: Loaded,
  reading: ModelReading,
  modelName: string,
  now: number,
): Promise<ExtractionOutcome> {
  const type = loaded.types.find(
    (candidate) => candidate.kind === reading.kind,
  );
  const prepared = await prepare(client, loaded, reading, type);
  const entityId = await placeholderEntityId(
    client,
    loaded.spaceId,
    loaded.userId,
  );
  const eventId = await stableEventId(client, loaded);

  // Replace, atomically. Observations first: they reference the version.
  await client.query(
    `DELETE FROM kith.observations WHERE event_id = $1 AND space_id = $2`,
    [eventId, loaded.spaceId],
  );
  await client.query(
    `DELETE FROM kith.event_versions WHERE event_id = $1 AND space_id = $2`,
    [eventId, loaded.spaceId],
  );

  const occurrence = prepared.occurrence;
  const columns = occurrenceColumns(occurrence);
  const versionId = newKithId();
  // Every field of an event version cites at least one span (`requireEvidence`
  // refuses an empty list), and the generic `document_statement` event has no
  // per-field evidence of its own: its occurrence, its subject and its type all
  // come from the statements. So it cites the first statement's span. A reading
  // where nothing survived its gate has no span to cite and no fact to store,
  // so it writes the extraction row and its corrections and stops there.
  const anchor = prepared.observations[0]?.evidence[0];
  const chain = [
    loaded.spaceId,
    loaded.sourceAccountId,
    loaded.sourceItemId,
    loaded.sourceRevisionId,
    loaded.sourceTextVersionId,
    loaded.processingGenerationId,
  ];
  if (anchor !== undefined) {
    await client.query(
      `INSERT INTO kith.event_versions
       (id,space_id,created_at,source_account_id,source_item_id,
        source_revision_id,source_text_version_id,processing_generation_id,
        event_id,entity_id,event_type,schema_version,occurrence,
        occurrence_date,occurrence_instant,occurrence_sort_key,field_evidence,
        doc_type_patch,user_id)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,
             'document_statement',$10,$11,$12,$13,$14,$15,NULL,$16)`,
      [
        versionId,
        ...chain,
        eventId,
        entityId,
        SCHEMA_VERSION,
        JSON.stringify(occurrence),
        columns.date,
        columns.instant,
        occurrenceSortKey(
          occurrence,
          `${eventId}|${loaded.processingGenerationId}`,
        ),
        JSON.stringify({
          occurrence: [anchor],
          entity: [anchor],
          eventType: [anchor],
        }),
        loaded.userId,
      ],
    );
    for (const observation of prepared.observations) {
      await client.query(
        `INSERT INTO kith.observations
         (id,space_id,created_at,source_account_id,source_item_id,
          source_revision_id,source_text_version_id,processing_generation_id,
          event_id,event_version_id,entity_id,event_type,occurrence,
          occurrence_date,occurrence_instant,occurrence_sort_key,
          observation_key,observation_type,schema_version,value,value_evidence,
          bound_entity_id,user_id)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,
               'document_statement',$11,$12,$13,$14,$15,$16,$17,$18,$19,NULL,
               $20)`,
        [
          newKithId(),
          ...chain,
          eventId,
          versionId,
          entityId,
          JSON.stringify(occurrence),
          columns.date,
          columns.instant,
          occurrenceSortKey(
            occurrence,
            `${eventId}|${observation.key}|${loaded.processingGenerationId}`,
          ),
          observation.key,
          observation.type,
          SCHEMA_VERSION,
          JSON.stringify(observation.value),
          JSON.stringify(observation.evidence),
          loaded.userId,
        ],
      );
    }
  }

  const truncated = loaded.pages.length < loaded.pagesTotal;
  await client.query(
    `INSERT INTO kith.document_extractions
       (id,space_id,source_item_id,processing_generation_id,event_id,kind,
        document_type_id,document_type_version,summary,model,extracted_at,
        pages_read,pages_total,statements)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (source_item_id) DO UPDATE SET
       processing_generation_id = EXCLUDED.processing_generation_id,
       event_id = EXCLUDED.event_id, kind = EXCLUDED.kind,
       document_type_id = EXCLUDED.document_type_id,
       document_type_version = EXCLUDED.document_type_version,
       summary = EXCLUDED.summary, model = EXCLUDED.model,
       extracted_at = EXCLUDED.extracted_at,
       pages_read = EXCLUDED.pages_read, pages_total = EXCLUDED.pages_total,
       statements = EXCLUDED.statements`,
    [
      newKithId(),
      loaded.spaceId,
      loaded.sourceItemId,
      loaded.processingGenerationId,
      eventId,
      type ? type.kind : "other",
      type?.id ?? null,
      type?.version ?? null,
      reading.summary || null,
      modelName,
      new Date(now),
      loaded.pages.length,
      loaded.pagesTotal,
      JSON.stringify(prepared.statements),
    ],
  );

  // A human fix outlives this replace. The observations above are the model's
  // newest reading of every field, including fields the owner has already
  // corrected, so without this line a re-extraction silently reverts a
  // correction on the exact-arithmetic side -- `latest_observation` and
  // `sum_money` back to the model's number -- while `get_document` goes on
  // showing the owner's. Re-applied inside the same transaction as the
  // replace, so no reader ever sees the reverted state.
  await reapplyCorrections(client, {
    spaceId: loaded.spaceId,
    sourceItemId: loaded.sourceItemId,
  });

  // Corrections. A field a human already fixed does not get a new open item:
  // the fix stands, the new reading is kept alongside it, and re-raising it
  // every run would make the screen unusable.
  const corrected = await resolvedCorrections(
    client,
    loaded.spaceId,
    loaded.sourceItemId,
  );
  // A correction may name a scalar field or one line's observation key, so a
  // field counts as settled when either names it. The three readers of this
  // map -- here, `read.ts` and `writeThrough` -- have to agree about that or a
  // fixed field keeps re-opening.
  const settled = (field: string): boolean =>
    corrected.has(field) ||
    [...corrected.keys()].some((key) => key.startsWith(`${field}:`));
  for (const failure of prepared.failures) {
    if (failure.field !== null && settled(failure.field)) continue;
    await openCorrection(client, {
      spaceId: loaded.spaceId,
      sourceItemId: loaded.sourceItemId,
      fieldName: failure.field,
      reason: failure.reason,
      reading: failure.reading,
    });
  }
  if (truncated) {
    await openCorrection(client, {
      spaceId: loaded.spaceId,
      sourceItemId: loaded.sourceItemId,
      fieldName: null,
      reason: "input_truncated",
      reading: {
        pagesRead: loaded.pages.length,
        pagesTotal: loaded.pagesTotal,
      },
    });
  }
  return {
    sourceItemId: loaded.sourceItemId,
    kind: type ? type.kind : "other",
    stored: prepared.observations.length,
    failed: prepared.failures.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * The `document_extraction` handler body.
 *
 * Three phases, and the middle one holds nothing: transaction, provider call,
 * transaction. `drain` hands this the pool and opens nothing itself, so there
 * is no connection checked out while the completion is in flight.
 */
export async function runDocumentExtractionJob(
  pool: Pool,
  payload: Record<string, unknown>,
  job: DeferredWorkRow,
  model: ExtractionModel,
  now: number = Date.now(),
): Promise<ExtractionOutcome | null> {
  const spaceId = payload.spaceId;
  const sourceItemId = payload.sourceItemId;
  if (
    typeof spaceId !== "string" ||
    !KITH_ID.test(spaceId) ||
    typeof sourceItemId !== "string" ||
    !KITH_ID.test(sourceItemId)
  ) {
    throw new Error(
      "document_extraction payload requires spaceId and sourceItemId",
    );
  }
  if (job.spaceId !== null && job.spaceId !== spaceId) {
    throw new Error("document_extraction payload is not in the job's space");
  }
  const loaded = await withKithTransaction(pool, (client) =>
    loadDocument(client, spaceId, sourceItemId, now),
  );
  // A document that is forgotten, unavailable, still parsing or replaced since
  // the job was queued is not an error: the activation that replaces it queues
  // its own job.
  if (!loaded || loaded.types.length === 0) return null;

  const reading = await model.read(buildPrompt(loaded));

  return await withKithTransaction(pool, async (client) => {
    // The generation may have been replaced while the model was reading. Write
    // against what is current now or not at all.
    const current = await loadDocument(client, spaceId, sourceItemId, now);
    if (
      !current ||
      current.processingGenerationId !== loaded.processingGenerationId
    ) {
      return null;
    }
    return await store(client, current, reading, model.name, now);
  });
}
