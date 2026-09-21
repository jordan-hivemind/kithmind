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

import {
  scheduleInvestmentLinkForExtraction,
  withLinkEnqueueSavepoint,
} from "../admin/investmentLinkWork.js";
import type {
  DocumentFieldCheck,
  DocumentFieldValueType,
} from "../admin/model.js";
import {
  schedule,
  TerminalDeferredWorkError,
  type DeferredCtx,
  type DeferredWorkRow,
  type ScheduleResult,
} from "../deferred/core.js";
import { ProofError } from "../errors.js";
import { KITH_ID, newKithId } from "../ids.js";
import { locateCardQuote } from "../provenance/model.js";
import { EXTRACTION_SPAN_LOCATOR_KIND } from "../provenance/parsedStaging.js";
import {
  areContiguous,
  citedLines,
  numberedPage,
  pageLines,
  MAX_PAGE_LINES,
  type PageLine,
} from "./lines.js";
import { sha256Utf8 } from "../provenance/sql.js";
import { occurrenceColumns, occurrenceSortKey } from "../records/model.js";
import {
  addDecimals,
  SUPPORTED_CURRENCIES,
  type ObservationValue,
  type Occurrence,
} from "../records/values.js";
import { withKithTransaction } from "../schema.js";
import {
  openCorrection,
  reapplyCorrections,
  supersedeOpenCorrections,
  resolvedCorrections,
} from "./corrections.js";
import { seedDocumentTypes } from "./seed.js";
import { sweepUnreferencedExtractionSpans } from "./spanSweep.js";
import {
  amountsInText,
  statesOnlyOneAmount,
  candidatesFor,
  checkLineItem,
  foldTextForMatch,
  checkValue,
  readLineItems,
  valueSignature,
  type AmountScanOptions,
  type Candidate,
  type DateOrder,
  type GateSuccess,
  isObservationFieldName,
  itemsSumToTotal,
  normalizeForMatch,
  type CorrectionReason,
} from "./gate.js";
import type {
  ExtractionModel,
  ExtractionRequest,
  ModelReading,
  ModelStatement as StatementLike,
} from "./provider.js";

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

/**
 * What a job reports when the model's reply named no field this kind has.
 *
 * A named code because an operator reads it out of `deferred_work.last_error`
 * and because it is the one extraction failure that is worth looking at: the
 * document is fine, the prompt or the schema is not.
 */
export const EXTRACTION_REPLY_UNREADABLE = "extraction_reply_unreadable";

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

export type DocumentExtractionScheduleState =
  | "queued"
  | "already_queued"
  | "followup_queued"
  | "already_followup_queued";

export type DocumentExtractionScheduleResult = ScheduleResult & {
  state: DocumentExtractionScheduleState;
};

function extractionFollowUpKey(sourceItemId: string, runningJobId: string): string {
  return `${extractionDedupeKey(sourceItemId)}:after:${runningJobId}`;
}

/** Schedules owner-requested work without letting a running job absorb a
 * classification or correction made after it began reading. */
export async function scheduleDocumentExtractionRepair(
  ctx: DeferredCtx,
  input: {
    spaceId: string;
    sourceItemId: string;
    processingGenerationId: string;
  },
): Promise<DocumentExtractionScheduleResult> {
  const pending = await ctx.client.query<{
    id: string;
    state: "queued" | "running";
  }>(
    `SELECT id, state FROM kith.deferred_work
      WHERE kind = 'document_extraction' AND space_id = $1
        AND payload->>'sourceItemId' = $2
        AND state IN ('queued', 'running')
      ORDER BY CASE state WHEN 'queued' THEN 0 ELSE 1 END, updated_at DESC, id
      FOR UPDATE`,
    [input.spaceId, input.sourceItemId],
  );
  const queued = pending.rows.find((row) => row.state === "queued");
  if (queued) {
    // A queued job may name an older generation. Claim cannot pass this row
    // lock, so refresh it before reporting that existing work is sufficient.
    await ctx.client.query(
      `UPDATE kith.deferred_work
          SET payload = $2::jsonb, updated_at = transaction_timestamp()
        WHERE id = $1 AND state = 'queued'`,
      [queued.id, JSON.stringify(input)],
    );
    return { id: queued.id, deduped: true, state: "already_queued" };
  }
  const running = pending.rows.find((row) => row.state === "running");
  if (running) {
    const result = await schedule(ctx, {
      kind: "document_extraction",
      spaceId: input.spaceId,
      payload: input,
      dedupeKey: extractionFollowUpKey(input.sourceItemId, running.id),
    });
    return {
      ...result,
      state: result.deduped ? "already_followup_queued" : "followup_queued",
    };
  }
  const result = await scheduleDocumentExtraction(ctx, input);
  return { ...result, state: result.deduped ? "already_queued" : "queued" };
}

/**
 * Re-extraction on demand: every already-extracted document of one kind, or
 * every already-extracted document when `kind` is omitted. Bounded per call
 * so an accidental click cannot enqueue an unbounded sweep.
 *
 * This selects from `kith.document_extractions`, so a document that has
 * never been extracted -- one activated before the typed extraction backend
 * landed, or whose first job was lost -- has no row here to find and is
 * silently skipped. `scheduleExtractionBackfill` below is the route for that
 * case.
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

/**
 * Backfill for documents that activated before typed extraction existed, or
 * whose activation job was lost: every active document in the space with a
 * ready processing generation and no `kith.document_extractions` row at all.
 * Bounded per call for the same reason `scheduleReextraction` is.
 *
 * `apply` defaults to true (schedule); the operator CLI (`cli.ts`) passes
 * `false` for a dry-run count.
 */
export async function scheduleExtractionBackfill(
  ctx: DeferredCtx,
  input: { spaceId: string; limit?: number; apply?: boolean },
): Promise<string[]> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1_000);
  const apply = input.apply ?? true;
  // The same "current ready generation" join `loadDocument` above uses:
  // `source_items.active_generation_id` -> `processing_generations`, gated on
  // `state = 'ready'`. A document with no extraction row and no ready
  // generation is still processing or failed, not a backfill candidate.
  const result = await ctx.client.query<{
    source_item_id: string;
    processing_generation_id: string;
  }>(
    `SELECT i.id AS source_item_id,
            i.active_generation_id AS processing_generation_id
       FROM kith.source_items i
       JOIN kith.processing_generations g
         ON g.id = i.active_generation_id AND g.space_id = i.space_id
      WHERE i.space_id = $1
        AND i.lifecycle = 'available'
        AND g.state = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM kith.document_extractions e
           WHERE e.source_item_id = i.id
        )
      ORDER BY i.id LIMIT $2`,
    [input.spaceId, limit],
  );
  if (!apply) return result.rows.map((row) => row.source_item_id);
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
  /** The model this kind asks for, when it asks for one. See
   * {@link extractionModelSetting}. */
  model: string | null;
  /** How this kind writes a numeric date, when it says. See
   * {@link documentTypeSetting}. */
  dateOrder: DateOrder | null;
  /** How many pages and characters of a document of this kind the model is
   * shown. Null means the global default. A twenty-five page K-1 read twelve
   * pages at a time is a truncated K-1, and twenty of them came back that
   * way; the fix is the owner's to make per kind, not this code's to guess. */
  maxPages: number | null;
  maxChars: number | null;
  fields: TypeField[];
};

/**
 * A per-kind model override, read out of `document_types.examples`.
 *
 * A receipt full of money is worth a stronger model than a letter, and which
 * is which is the owner's call, not this code's. So it is data: an element of
 * the type's `examples` array shaped
 * `{"setting": "extraction_model", "value": "gpt-4.1"}`. Plain-string elements
 * stay what they always were, examples.
 *
 * `examples` rather than a column of its own because `document_types` has no
 * spare one and the next free migration number is already claimed by an open
 * PR, which would leave this branch's own tests unable to apply the schema.
 * ponytail: a real `extraction_model text` column is the upgrade path the
 * moment a migration is free.
 *
 * Nothing here picks a model. With no such element the configured default is
 * used, which is what every kind does until the owner says otherwise.
 */
export function documentTypeSetting(
  examples: unknown,
  name: string,
): string | null {
  if (!Array.isArray(examples)) return null;
  for (const entry of examples) {
    if (!entry || typeof entry !== "object") continue;
    const setting = entry as { setting?: unknown; value?: unknown };
    if (
      setting.setting === name &&
      typeof setting.value === "string" &&
      /^[a-zA-Z0-9._:/-]{1,200}$/.test(setting.value)
    ) {
      return setting.value;
    }
  }
  return null;
}

/** The widest a kind may set its own bounds to. A setting is the owner's
 * call; a ceiling is the daemon's, because one document must not be able to
 * spend a whole run's budget. */
export const MAX_KIND_PAGES = 60;
export const MAX_KIND_CHARS = 400_000;

/**
 * A per-kind whole number from the same data home as the model override, or
 * null. Bounded on both sides: a setting outside the ceiling is ignored
 * rather than clamped, so a typo reads as "unset" instead of as a number
 * nobody chose.
 */
export function documentTypeBound(
  examples: unknown,
  name: string,
  ceiling: number,
): number | null {
  const raw = numericSetting(examples, name);
  if (raw === null || !/^[1-9][0-9]{0,6}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= ceiling ? value : null;
}

/**
 * The same setting as {@link documentTypeSetting}, read as a number written
 * either way.
 *
 * JSON has a number type and a string type and this row is hand-edited as
 * often as it is written by the admin screen, so `{"value": 25}` and
 * `{"value": "25"}` reach this code interchangeably. Honouring only the
 * string made a bound the owner had set read as unset, which is the quietest
 * possible failure: the document comes back truncated and nothing says why.
 * Whole numbers only -- `25.5` pages is not a setting anybody meant.
 */
function numericSetting(examples: unknown, name: string): string | null {
  if (!Array.isArray(examples)) return null;
  for (const entry of examples) {
    if (!entry || typeof entry !== "object") continue;
    const setting = entry as { setting?: unknown; value?: unknown };
    if (setting.setting !== name) continue;
    if (typeof setting.value === "number") {
      if (Number.isSafeInteger(setting.value)) return String(setting.value);
      continue;
    }
    if (typeof setting.value === "string") return setting.value;
  }
  return null;
}

/** The kind's model override, or null for the configured default. */
export function extractionModelSetting(examples: unknown): string | null {
  return documentTypeSetting(examples, "extraction_model");
}

/**
 * How this kind writes a numeric date, or null.
 *
 * `01/02/26` is two different days and the string cannot settle which. Unset,
 * an ambiguous date opens a correction rather than being guessed; set, it is
 * read that way and stored. The owner's documents are overwhelmingly US, but
 * that is the owner's statement to make per kind, not this code's to assume.
 */
export function dateOrderSetting(examples: unknown): DateOrder | null {
  const value = documentTypeSetting(examples, "date_order");
  return value === "MDY" || value === "DMY" ? value : null;
}

type LoadedPage = {
  id: string;
  /**
   * The page's own ordinal in the sealed text. **Never shown to the model and
   * never used to resolve a citation.**
   *
   * In production these are 0-based and need not be dense: a single-page
   * document is one row at ordinal 0. The first version of line citations
   * printed this number as the page heading while numbering lines from 1, so
   * the model read "page 0" beside "1| ..." and answered `page: 1` -- which
   * matched no page at all on a single-page document, and the wrong page on a
   * multi-page one. Stored fields fell on every document in the trial.
   *
   * `shown` is the number the model sees and cites. This one is only for the
   * span, which indexes the real page row.
   */
  ordinal: number;
  /** This page's 1-based position in the list actually shown to the model.
   * The only number a citation is resolved through. */
  shown: number;
  text: string;
  /** The page's lines and their offsets, computed once: the prompt numbers
   * them and a citation resolves against them. */
  lines: PageLine[];
};

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
  pagesWithText: number;
  allWithText: LoadedPage[];
  types: LoadedType[];
  /** A durable owner decision that the model may not replace. */
  ownerKind: string | null;
  /** The kind the last extraction of this document settled on, when there was
   * one. Only used to pick the model before the reply names a kind. */
  priorKind: string | null;
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
              i.active_generation_id, i.owner_document_kind, s.created_by
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
  const all = pageRows.map((row) => {
    const text = String(row.text ?? "");
    return {
      id: String(row.id),
      ordinal: Number(row.ordinal),
      shown: 0,
      text,
      lines: pageLines(text),
    };
  });
  if (all.length === 0) return null;
  // A page with no words on it is not shown. A scanned letter's blank verso
  // comes through as one empty line, and offering it as a citable page is an
  // invitation to cite it. Numbering is by position in the shown list, so
  // leaving one out shifts nothing: there is no hole to shift over.
  const withText = all.filter((page) => page.text.trim().length > 0);
  const extractedKind =
    (
      await client.query<{ kind: string }>(
        `SELECT kind FROM kith.document_extractions
          WHERE space_id = $1 AND source_item_id = $2 LIMIT 1`,
        [spaceId, sourceItemId],
      )
    ).rows[0]?.kind ?? null;
  const types = await loadTypes(client, spaceId, now);
  const ownerKind = typeof item.owner_document_kind === "string"
    ? item.owner_document_kind
    : null;
  const priorKind = ownerKind ?? extractedKind;
  const priorBounds = priorKind
    ? types.find((type) => type.kind === priorKind)
    : undefined;
  const shownPages = shownFrom(
    boundPages(withText, {
      maxPages: priorBounds?.maxPages ?? null,
      maxChars: priorBounds?.maxChars ?? null,
    }),
  );
  if (shownPages.length === 0) return null;
  return {
    spaceId,
    userId: item.created_by,
    sourceAccountId: String(item.source_account_id),
    sourceItemId,
    sourceRevisionId: generation.source_revision_id,
    sourceTextVersionId: generation.source_text_version_id,
    processingGenerationId: String(generation.id),
    pages: shownPages,
    /** Every page the document has, blank ones included: this is what the
     * extraction row reports, and a document's page count is its page count. */
    pagesTotal: all.length,
    /** Pages with words on them, which is what "was anything dropped?" is
     * measured against. Leaving out a blank page loses nothing. */
    pagesWithText: withText.length,
    types,
    ownerKind,
    priorKind,
    /** Every page with words on it, kept so a wider bound can be applied
     * after the reply names a kind without reading the document again. */
    allWithText: withText,
  };
}

function boundPages(
  pages: readonly LoadedPage[],
  bounds: { maxPages?: number | null; maxChars?: number | null } = {},
): LoadedPage[] {
  const maxPages = bounds.maxPages ?? MAX_EXTRACTION_PAGES;
  const maxChars = bounds.maxChars ?? MAX_EXTRACTION_CHARS;
  const kept: LoadedPage[] = [];
  let characters = 0;
  for (const page of pages) {
    if (kept.length >= maxPages) break;
    if (kept.length > 0 && characters + page.text.length > maxChars) break;
    characters += page.text.length;
    kept.push(page);
  }
  return kept;
}

/** Re-numbers a bounded page list. The number the model sees is a position in
 * what it is shown, so widening the bound re-numbers nothing that was already
 * cited -- the wider list starts with the same pages in the same order. */
function shownFrom(pages: readonly LoadedPage[]): LoadedPage[] {
  return pages.map((page, index) => ({ ...page, shown: index + 1 }));
}

/**
 * The same document, shown through the bounds the named kind asks for.
 *
 * Returns the document unchanged -- the identical object, so a caller can ask
 * "did anything widen?" by identity -- when the kind sets no bound, is not
 * one this space has, or would show no more pages than are already shown. A
 * kind may only ever widen the view here: narrowing after the fact would hide
 * a page the model has already been shown and may already have cited.
 */
function withKindBounds(loaded: Loaded, kind: string | null): Loaded {
  const type = kind
    ? loaded.types.find((candidate) => candidate.kind === kind)
    : undefined;
  if (!type || (type.maxPages === null && type.maxChars === null)) {
    return loaded;
  }
  const pages = shownFrom(
    boundPages(loaded.allWithText, {
      maxPages: type.maxPages,
      maxChars: type.maxChars,
    }),
  );
  return pages.length > loaded.pages.length ? { ...loaded, pages } : loaded;
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
      `SELECT DISTINCT ON (kind) id, kind, version, guidance, description,
              examples
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
      model: extractionModelSetting(row.examples),
      dateOrder: dateOrderSetting(row.examples),
      maxPages: documentTypeBound(row.examples, "max_pages", MAX_KIND_PAGES),
      maxChars: documentTypeBound(row.examples, "max_chars", MAX_KIND_CHARS),
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
export function buildRequest(loaded: Loaded): ExtractionRequest {
  const requestTypes = loaded.ownerKind
    ? loaded.types.filter((type) => type.kind === loaded.ownerKind)
    : loaded.types;
  const catalog = requestTypes
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
    .map(
      (page) => `=== page ${page.shown} ===\n${numberedPage(page.lines)}`,
    )
    .join("\n\n");
  const longest = Math.max(0, ...loaded.pages.map((p) => p.lines.length));
  const truncated = [
    loaded.pages.length < loaded.pagesWithText
      ? `Only the first ${loaded.pages.length} of ${loaded.pagesTotal} pages are shown.`
      : "",
    longest > MAX_PAGE_LINES
      ? `Only the first ${MAX_PAGE_LINES} lines of a page are shown.`
      : "",
  ]
    .filter(Boolean)
    .map((note) => `\n${note}\n`)
    .join("");
  // Every field name of every active kind, deduplicated. The schema's enum and
  // the prompt's catalog are two statements of one contract.
  const fields = [
    ...new Set(requestTypes.flatMap((type) => type.fields.map((f) => f.name))),
  ];
  const classificationRule = loaded.ownerKind
    ? `\nThe owner classified this document as ${loaded.ownerKind}. Return that exact kind. Do not choose another kind or other.\n`
    : "";
  const prompt = `Read this document and report what it says. Do not infer, calculate, or convert anything.

Each page is shown as numbered lines, like "7| Subtotal    10.00". Cite the lines a value comes from by their numbers. Do not copy text back.

Pages and lines both count from 1. "page" is the number in the "=== page N ===" heading above the lines you are citing, and "lines" are the numbers to the left of the bars on that page.

Reply with JSON only, in exactly this shape:
{"kind": "<one kind below, or other>",
 "summary": "<one line>",
 "statements": [
   {"field": "<a field name listed under the kind you chose>",
    "value": "<the value, as a string>",
    "line_items": null,
    "page": <page number>,
    "lines": [<line number>]}]}

Rules:${classificationRule}
- Choose a kind from what the document itself does, not its title, folder, or general topic. A document that merely relates to an investment is not an investment agreement unless it creates or acquires an investment commitment, security, or ownership interest.
- Every statement names a field in "field". Never leave it out, never rename it, and never use the field name as a key of its own.
- "lines" holds one to three line numbers from the page named in "page". Cite the line that prints the value. You may also cite the line that prints its label, even if it is far away; they do not need to be next to each other.
- Only use fields listed under the kind you chose. Omit a field the document does not state: leave it out entirely rather than returning an empty string, a null or a blank.
- A date may be all the document prints. If it states only a year ("2024") or only a month and a year ("March 2024"), return exactly that. Never add a month or a day the document does not print.
- Copy a value exactly as the line prints it, including the currency symbol. Dates may be copied as printed.
- A line_item_list field puts its lines in "line_items" and sets "value" to null. Every other field puts its value in "value" and sets "line_items" to null.
- Each entry of "line_items" has its own "lines". Items sit on different lines; cite the line each one is printed on.
- An amount is the decimal string the line prints, with its decimal point: "12.99", never "1299" and never rounded. A trailing tax letter such as "12.99T" may be kept or dropped.
- Names, diagnoses and descriptions are copied as written. Do not normalize them.

Worked example. Given this page:
1| Bracken Tools
2| 2 Apr 2026
3| Chisel            12.00 T
4| Mallet              8.00
5| Subtotal
6| Tax
7| Total
8| 20.00
9| 1.60
10| 21.60
the reply is:
{"kind": "receipt",
 "summary": "Hardware receipt from Bracken Tools for 21.60.",
 "statements": [
   {"field": "vendor", "value": "Bracken Tools", "line_items": null, "page": 1, "lines": [1]},
   {"field": "purchase_date", "value": "2 Apr 2026", "line_items": null, "page": 1, "lines": [2]},
   {"field": "line_items", "value": null, "page": 1, "lines": [3, 4],
    "line_items": [{"description": "Chisel", "amount": "12.00", "lines": [3]},
                   {"description": "Mallet", "amount": "8.00", "lines": [4]}]},
   {"field": "subtotal", "value": "20.00", "line_items": null, "page": 1, "lines": [5, 8]},
   {"field": "tax", "value": "1.60", "line_items": null, "page": 1, "lines": [6, 9]},
   {"field": "total", "value": "21.60", "line_items": null, "page": 1, "lines": [7, 10]}]}

Kinds:
${catalog}

Document:
${truncated}${body}
`;
  return { prompt, kinds: requestTypes.map((type) => type.kind), fields };
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
  /** What this statement cited. See {@link StatementCitation}. */
  citation: StatementCitation;
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
  /** Reply entries that resolved to a field this kind declares, whether or
   * not the reading then passed its gate. Zero of these with entries in the
   * reply is a reply in the wrong shape, not a document that says nothing. */
  named: number;
  /** Reply entries that named no field, or named something this kind has no
   * column for. */
  unusable: number;
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
    /** Present when the failure belongs to a statement that cited something.
     * A document-level item (an unknown field, a truncated input) has none. */
    citation?: StatementCitation;
  }>;
  occurrence: Occurrence;
};

/**
 * Where one statement's citation points, and the text the server reads there.
 *
 * Line ids first: they resolve arithmetically against the page's own line
 * offsets, so a citation in range always produces a quote and the model is
 * never asked to reproduce anything. A reply that carried the older `quote`
 * shape instead still locates, which is what the non-schema fallback path has.
 */
/**
 * What a statement cited, as integers.
 *
 * Recorded on every stored statement and on every correction a gate opens.
 * Without it a failed reading says only "value_not_in_quote" and the scalar
 * the model returned, which is not enough to tell a model that cited the
 * wrong line from a page whose layout the reader cannot handle -- the live
 * trial stalled on exactly that. Integers only, so a diagnostic can print it
 * without printing the document.
 */
export type StatementCitation = {
  /** The page number the model was shown and cited. */
  shownPage: number;
  /** That page's own ordinal in the sealed text. */
  pageOrdinal: number;
  /** The line ids cited, in the order given. */
  lines: number[];
  /** How many citable lines that page has. */
  pageLineCount: number;
  /** Whether those ids run consecutively. A column layout cites lines far
   * apart, which is legitimate and worth being able to see. */
  contiguous: boolean;
};

/** One page line as a candidate, **with the edges it really has**. A line
 * this file builds by hand and hands to the gate without `cutStart` and
 * `cutEnd` is a line the gate reads more generously than it reads the same
 * text from `candidatesFor`: that is how a piece cut off before a minus sign
 * offered a charge for a page printing a credit. */
function lineCandidate(line: PageLine): Candidate {
  return {
    text: line.text,
    start: line.start,
    end: line.end,
    cutStart: line.cutStart,
    cutEnd: line.cutEnd,
    previousToken: line.previousToken,
    nextToken: line.nextToken,
  };
}

/** Whether one line, read on its own, states this value. */
function lineCarries(
  page: LoadedPage,
  valueType: DocumentFieldValueType,
  value: unknown,
  line: PageLine,
): boolean {
  return checkValue({
    valueType,
    value,
    candidates: [lineCandidate(line)],
    pageText: page.text,
    defaultCurrency: "USD",
  }).ok;
}

/** Which of the page's lines a matched range touches. */
function linesCovered(
  page: LoadedPage,
  range: { start: number; end: number },
): number[] {
  return page.lines
    .filter((line) => line.start < range.end && range.start < line.end)
    .map((line) => line.id);
}

/**
 * Whether the value the model copied is printed the way money is printed.
 *
 * A decimal point or a currency mark, and nothing else counts. A bare run of
 * digits is a suite number, a tax year, a page number or a count, and every
 * one of those sits a line away from a money field on some real document.
 * Scaled notation is refused by the same rule from the other side: a model
 * that reads `Raised $2.5M` and writes `2,500,000` has written a number no
 * line prints, and a bare run of digits is what that looks like.
 */
function isMoneyShaped(value: unknown): boolean {
  const text = String(value ?? "").normalize("NFKC");
  if (/\d\.|\.\d/.test(text)) return true;
  if (/[$¢£¥₩€₹]/.test(text)) return true;
  const upper = text.toUpperCase();
  return SUPPORTED_CURRENCIES.some((code) => upper.includes(code));
}

/**
 * The one line a citation may be moved to, or null.
 *
 * A K-1's dense boxes put the model one line off its value seven times in
 * the backfill, and each of those readings was right about the number. This
 * is the only rule in this file that **relaxes** a check, so every condition
 * below is a refusal and all eight have to fail before a citation moves.
 *
 * - The statement cited no line ids. The legacy quote path has no ids, so
 *   "one line off" means nothing there.
 * - A money value with no decimal point and no currency mark. `Suite 400`,
 *   `Tax year 2024` and `Page 2 of 5` each stored a total end to end.
 * - Any cited line states a value of this type. Then the model did not miss
 *   by a line, it contradicted the line it pointed at: a page printing
 *   `Fee 100.00` and `Total 250.00` stored a total of 100.
 * - The line is more than one id away from any cited line, or on another
 *   page. One off is the miss this exists for; two off is a search.
 * - The line is not directly *after* a cited line. A label stands above its
 *   amount, and the repair could not tell which side of one it was reading:
 *   `Subtotal`, `20.00`, `Total`, `21.60` with a total of 20.00 cited to
 *   `Total` stored the subtotal's amount as the total.
 * - More than one line of that window states the value. Choosing between
 *   them is a guess.
 * - Any other line of the whole document states it. A value printed twice
 *   gives no way to say which line states it, on this page or the next.
 * - The target prints anything besides that one value. A line with a word on
 *   it belongs to that word: `Tax 1.60` next to `Subtotal` stored a subtotal
 *   of 1.60, and `Invoice 48210`, `Page 2023` and a K-1's
 *   `12 Section 179 deduction` each stored a number for the field on the
 *   line beside them.
 * - The target's neighbour on the side away from the citation is itself a
 *   bare value. Then the page prints a column of values, and which of them
 *   the citation meant is arithmetic on line numbers rather than something
 *   the document states: `Subtotal`, `Tax`, `Total`, `20.00`, `1.60`,
 *   `21.60` stored a total of 20.00 from a page whose total is 21.60.
 *
 * The caller adds the two conditions that need the rest of the reply: a line
 * another accepted statement already points at, and a line two statements
 * would repair onto at once.
 */
function repairTarget(
  loaded: Loaded,
  page: LoadedPage,
  cited: readonly PageLine[],
  valueType: DocumentFieldValueType,
  value: unknown,
  citedCandidates: readonly Candidate[],
): PageLine | null {
  if (cited.length === 0) return null;
  if (valueType === "money" && !isMoneyShaped(value)) return null;
  const scan = valueType === "number" ? { percentIsNeutral: true } : {};
  for (const candidate of citedCandidates) {
    const printed = amountsInText(candidate.text, {
      ...scan,
      ...(candidate.cutStart ? { cutStart: true } : {}),
      ...(candidate.cutEnd ? { cutEnd: true } : {}),
      ...(candidate.previousToken === undefined
        ? {}
        : { previousToken: candidate.previousToken }),
      ...(candidate.nextToken === undefined
        ? {}
        : { nextToken: candidate.nextToken }),
    });
    if (printed.length > 0) return null;
  }
  // Only the line *after* a cited label, never the one before it.
  //
  // The repair had no way to tell which side of a label its value sat on,
  // and a label sits above its amount on every layout this exists for. A
  // page printing `Subtotal`, `20.00`, `Total`, `21.60` with a total of
  // 20.00 cited to `Total` stored 20: the line before `Total` belongs to
  // `Subtotal`, and reading it as the total is the silent wrong number this
  // gate exists to prevent. The backwards miss -- a citation naming the line
  // *after* the value, which the column receipt test exercised -- is refused
  // with it. It is the rarer half of a rule that could not distinguish the
  // two, and refusing is always allowed where reading is a coin flip.
  const carrying = page.lines.filter(
    (line) =>
      cited.every((one) => Math.abs(line.id - one.id) <= 1) &&
      cited.some((one) => line.id === one.id + 1) &&
      lineCarries(page, valueType, value, line),
  );
  if (carrying.length !== 1) return null;
  const target = carrying[0]!;
  const scanOf = (line: PageLine): AmountScanOptions => ({
    ...scan,
    ...(line.cutStart ? { cutStart: true as const } : {}),
    ...(line.cutEnd ? { cutEnd: true as const } : {}),
    ...(line.previousToken === undefined
      ? {}
      : { previousToken: line.previousToken }),
    ...(line.nextToken === undefined ? {} : { nextToken: line.nextToken }),
  });
  // The target has to be a value and nothing else. A line that prints a word
  // beside its amount belongs to that word: `Tax 1.60` is the tax, whatever
  // the line above it is called, and a subtotal read off it is a tax stored
  // as a subtotal. `Invoice 48210` beside `Odometer`, `Page 2023` beside
  // `Tax year` and a K-1's `12 Section 179 deduction` beside `Profit share`
  // are the same document four more times.
  if (!statesOnlyOneAmount(target.text, scanOf(target))) return null;
  // And it may not be one of a stack of values. A column receipt prints its
  // labels together and its amounts together, so the line after `Total` is
  // the *subtotal's* amount as often as the total's, and the only thing that
  // says which is counting -- which is the guess this rule exists to refuse.
  // The neighbour on the side away from the citation settles it: a label
  // there means the amounts are interleaved with their labels and the
  // citation missed by one; another bare value there means the page has a
  // column of them and nothing points into it.
  const citedIds = new Set(cited.map((one) => one.id));
  for (const neighbour of page.lines) {
    if (Math.abs(neighbour.id - target.id) !== 1) continue;
    if (citedIds.has(neighbour.id)) continue;
    if (statesOnlyOneAmount(neighbour.text, scanOf(neighbour))) return null;
  }
  for (const other of loaded.pages) {
    for (const line of other.lines) {
      if (other.shown === page.shown && line.id === target.id) continue;
      // A line with no digit on it can state no amount, and skipping it
      // keeps this scan off every word of a long document.
      if (!/\d/.test(line.text)) continue;
      if (lineCarries(other, valueType, value, line)) return null;
    }
  }
  return target;
}

/**
 * Whether the model said "nothing here".
 *
 * Nothing, and only nothing: a null, a missing value, a string with no
 * characters a reader could see, and an empty list are the same statement
 * about the document, which is that it does not state this field.
 *
 * Everything a box can *print* is a reading and goes to the gate, because
 * dropping it would silently discard something the page shows. `0` and
 * `0.00` are amounts and a K-1 prints plenty of them. `-` and `N/A` are
 * marks, not amounts: the gate refuses them for a money field, which is the
 * right answer -- a dash is not zero, and turning one into zero would put a
 * number on the page that nobody wrote. `BLANK_SPEC` in
 * `extractionCitations.test.mjs` is the table of these decisions.
 */
export function isBlankReading(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    // The zero-width characters go with the spaces: a PDF's text layer emits
    // them freely, and a box holding one holds nothing a reader can see.
    return value.replace(/[​‌‍⁠﻿]/g, "").trim() === "";
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function citationOf(
  page: LoadedPage,
  statement: { lines?: readonly number[] },
): StatementCitation {
  const lines = (
    Array.isArray(statement.lines) ? statement.lines : []
  ).filter((id): id is number => Number.isInteger(id));
  return {
    shownPage: page.shown,
    pageOrdinal: page.ordinal,
    lines,
    pageLineCount: page.lines.length,
    contiguous: areContiguous(lines),
  };
}

type ResolvedCitation = {
  /** The cited lines, in id order. Empty on the legacy quote path. */
  cited: PageLine[];
  /** The one range the legacy quote path resolved to, if that is what was
   * used. Line citations produce a range per matched value instead. */
  legacy?: { start: number; end: number };
  reason?: CorrectionReason;
};

/**
 * Which lines one statement cites, and the text at them.
 *
 * Line ids first: they resolve arithmetically against the page's own line
 * offsets, so a citation in range always produces text and the model is never
 * asked to reproduce anything. A reply that carried the older `quote` shape
 * instead still locates, which is what the non-schema fallback path has.
 */
function resolveCitation(
  page: LoadedPage,
  statement: { lines?: readonly number[]; quote?: string },
): ResolvedCitation {
  const ids = Array.isArray(statement.lines) ? statement.lines : [];
  const quoted = typeof statement.quote === "string" ? statement.quote : "";
  if (ids.length > 0) {
    const cited = citedLines(page.lines, ids);
    if (!cited) return { cited: [], reason: "citation_out_of_range" };
    return { cited };
  }
  if (!quoted.trim()) {
    // No lines and no quote: the statement cited nothing at all, which is a
    // different fault from a quote that is not on the page.
    return { cited: [], reason: "citation_missing" };
  }
  const located = locateCardQuote(page.text, quoted);
  if (
    !located ||
    located.start < 0 ||
    located.end <= located.start ||
    located.end > page.text.length
  ) {
    return {
      cited: [],
      reason: normalizeForMatch(page.text).includes(normalizeForMatch(quoted))
        ? "span_unresolved"
        : "quote_not_found",
    };
  }
  return { cited: [], legacy: { start: located.start, end: located.end } };
}

async function findOrCreateSpan(
  client: ClientBase,
  loaded: Loaded,
  page: LoadedPage,
  located: { start: number; end: number },
): Promise<string | null> {
  if (
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
  //
  // The locator carries `extraction_v1` so the parsed payload's seal can tell
  // this span from a parser one. Without a marker the seal counted extraction
  // spans against the manifest and every extracted document failed
  // `payload_verify_error:id_sets`, which stopped the watcher reporting a
  // complete pass at all. See `extractionSpanIds` in
  // `../provenance/parsedStaging.ts`.
  await client.query(
    `INSERT INTO kith.evidence_spans
       (id, space_id, created_at, source_revision_id, source_text_version_id,
        source_page_id, ordinal, "start", "end", quote_hash, locator)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,
             jsonb_build_object('kind', $10::text))`,
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
      EXTRACTION_SPAN_LOCATOR_KIND,
    ],
  );
  return id;
}

/**
 * A short, stable tag for one line item.
 *
 * The cited line the amount sits on, plus a fold of the description. Position
 * in the surviving array was what this used to be, and it moved under the
 * owner's feet: an entry failing, or the model listing the same receipt in a
 * different order, shifted every later key by one and landed a correction
 * made on one line onto another.
 *
 * ponytail: a 32-bit FNV-1a of the folded description, not a cryptographic
 * hash -- this is a key, not a commitment. Two entries with the same folded
 * description *and* the same amount line still collide, and a key still moves
 * if the page is re-parsed into different lines. Upgrade path if either
 * matters: carry the item's own span id into the key.
 */
function lineItemKey(
  lineId: number,
  description: string,
  withinLine: number,
): string {
  let hash = 0x811c9dc5;
  for (const unit of foldTextForMatch(description)) {
    hash ^= unit.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // The ordinal within its own line separates two entries that are genuinely
  // the same words and the same amount on the same line -- a receipt listing
  // one item twice. Without it they share a key, and correcting one corrects
  // both.
  return `${lineId}-${hash.toString(36).padStart(7, "0").slice(-7)}-${withinLine}`;
}

type GatedLineItems = {
  values: ObservationValue[];
  spanIds: string[];
  valueKeys: string[];
  /** Every page line an accepted entry's amount was read from. A list is the
   * only reading that can occupy a dozen lines at once, and until ADM-5h it
   * occupied none of them: a repair moved another field's citation straight
   * onto an item's own line. */
  lineIds: number[];
  /** The sum of the entries that passed. A partial list must not be compared
   * against a stated total, so the caller only carries this when nothing
   * failed. */
  itemsTotal?: string;
  currencyAssumed?: true;
  quote: string;
  failed: number;
  total: number;
  /**
   * The shape of each entry that failed, and why.
   *
   * Signatures, not content: letters folded to `a` and digits to `9`, the
   * same projection the diagnostic prints. The owner's count stays a count;
   * this is what lets an operator see that the amounts arrived without their
   * decimal point without anyone opening the receipt.
   */
  failedShapes: Array<{
    amount: string;
    description: string;
    lines: number[];
    reason: CorrectionReason;
  }>;
};

/**
 * Every entry of a list, gated on its own citation and stored on its own.
 *
 * A failing entry no longer takes the list down with it. A receipt with six
 * good lines and one the model garbled used to store nothing, which is how a
 * strong model still lost every line item on both trial documents; now the
 * six store and one correction says one is missing.
 *
 * `itemsTotal` is deliberately absent when anything failed. The sum of some of
 * the lines is not the sum of the lines, and comparing a partial sum against
 * the document's stated total would raise a mismatch that says nothing.
 */
async function gateLineItems(
  client: ClientBase,
  loaded: Loaded,
  page: LoadedPage,
  input: {
    field: TypeField;
    /** What the model put in `line_items`, already parsed off the wire. */
    value: unknown;
    cited: readonly PageLine[];
    defaultCurrency: string;
  },
): Promise<GatedLineItems> {
  const empty: GatedLineItems = {
    values: [],
    spanIds: [],
    valueKeys: [],
    lineIds: [],
    quote: "",
    failed: 1,
    total: 1,
    failedShapes: [
      {
        amount: valueSignature(input.value),
        description: "",
        lines: [],
        reason: "malformed_statement",
      },
    ],
  };
  const entries = readLineItems(input.value);
  if (!entries) return empty;

  const values: ObservationValue[] = [];
  const spanIds: string[] = [];
  const valueKeys: string[] = [];
  const lineIds: number[] = [];
  const perLine = new Map<number, number>();
  let itemsTotal = "0";
  let currencyAssumed: true | undefined;
  let quote = "";
  let failed = 0;
  const failedShapes: GatedLineItems["failedShapes"] = [];
  const note = (
    item: { amount?: unknown; description?: unknown; lines?: number[] },
    reason: CorrectionReason,
  ): void => {
    failed += 1;
    if (failedShapes.length < 32) {
      failedShapes.push({
        amount: valueSignature(item.amount),
        description: valueSignature(item.description),
        lines: item.lines ?? [],
        reason,
      });
    }
  };

  for (const entry of entries) {
    if (!entry.ok) {
      note({}, entry.reason);
      continue;
    }
    // The entry's own lines when it gave any. The statement's stand in only
    // when they name exactly one line: on a multi-line citation there is no
    // way to say which of them this entry is about, and falling back to all
    // of them let an item's description on one line pair with a different
    // item's amount on another -- the cross-item validation per-entry
    // citations exist to remove.
    const own =
      entry.item.lines.length > 0
        ? citedLines(page.lines, entry.item.lines)
        : input.cited.length === 1
          ? [...input.cited]
          : null;
    if (!own || own.length === 0) {
      note(entry.item, "citation_missing");
      continue;
    }
    const checked = checkLineItem({
      item: entry.item,
      cited: own,
      pageText: page.text,
      defaultCurrency: input.defaultCurrency,
    });
    if (!checked.ok) {
      note(entry.item, checked.reason);
      continue;
    }
    const spanId = await findOrCreateSpan(client, loaded, page, checked.span);
    if (!spanId) {
      note(entry.item, "span_unresolved");
      continue;
    }
    values.push(checked.value);
    spanIds.push(spanId);
    // The lines this entry's amount was really read from, so no other
    // field's citation can be repaired onto one of them.
    for (const id of linesCovered(page, checked.span)) lineIds.push(id);
    const seenOnLine = perLine.get(checked.lineId) ?? 0;
    perLine.set(checked.lineId, seenOnLine + 1);
    valueKeys.push(
      lineItemKey(checked.lineId, entry.item.description, seenOnLine),
    );
    itemsTotal = addDecimals(itemsTotal, checked.amount);
    if (checked.currencyAssumed) currencyAssumed = true;
    if (!quote) quote = checked.span.text;
  }

  return {
    values,
    spanIds,
    valueKeys,
    lineIds,
    ...(failed === 0 ? { itemsTotal } : {}),
    ...(currencyAssumed ? { currencyAssumed } : {}),
    quote,
    failed,
    total: entries.length,
    failedShapes,
  };
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
    named: 0,
    // The reply's own unnamed entries start the count: `parseModelReading`
    // dropped them before this function ever saw them, and a dropped entry
    // nobody counts is how the live trial's two documents extracted to
    // nothing while reporting one vague correction.
    unusable: reading.unnamed,
    statements: [],
    observations: [],
    failures: [],
    occurrence: { precision: "unknown" },
  };
  const fields = new Map(type ? type.fields.map((f) => [f.name, f]) : []);
  // Keyed by the number the model was shown, never by the page's ordinal.
  const pages = new Map(loaded.pages.map((page) => [page.shown, page]));
  const unknownFields: string[] = [];

  // Pass one: gate every statement. Nothing is materialised yet, because
  // whether a reading may be stored depends on what the *other* statements
  // said about the same field, and that is not known until the loop ends.
  type Accepted = {
    field: TypeField;
    page: number;
    quote: string;
    lines: number[];
    citation: StatementCitation;
    /** One per value, aligned with `values`: the span for the line that
     * supported it. */
    spanIds: string[];
    /** One per value: the suffix its observation key takes. A list keys by
     * the entry's own evidence rather than by its position, so a correction
     * made on one line does not land on another when the model reorders the
     * list on the next run. */
    valueKeys?: string[];
    values: ObservationValue[];
    itemsTotal?: string;
    currencyAssumed?: true;
  };
  const accepted: Accepted[] = [];
  /** `page|line` for every line an accepted statement's value was read from.
   * A repair may not land on one: two fields reading the same line is how a
   * fee becomes a total. */
  const occupied = new Set<string>();
  /** Citations that may be one line off, held until the whole reply is
   * known. See `repairTarget` for the conditions already checked, and the
   * loop below for the two that need every other statement. */
  type Repair = {
    field: TypeField;
    statement: StatementLike;
    page: LoadedPage;
    citation: StatementCitation;
    target: PageLine;
  };
  const repairs: Repair[] = [];

  /**
   * One gated reading becomes spans and an accepted entry.
   *
   * Shared by the ordinary path and the repaired one, so a statement whose
   * citation moved is stored by exactly the same code as every other, and
   * the lines it was read from are recorded either way.
   */
  const accept = async (
    field: TypeField,
    page: LoadedPage,
    statement: StatementLike,
    citation: StatementCitation,
    candidateSet: Candidate[],
    gated: GateSuccess,
  ): Promise<void> => {
    // One span per line that supported a value, so an observation cites the
    // line that prints it rather than the region it was found in.
    const spanIds: string[] = [];
    for (const index of gated.support) {
      const spanId = await findOrCreateSpan(
        client,
        loaded,
        page,
        candidateSet[index]!,
      );
      if (!spanId) {
        prepared.failures.push({
          field: field.name,
          reason: "span_unresolved",
          reading: statement.value,
          citation,
        });
        return;
      }
      spanIds.push(spanId);
    }
    for (const index of gated.support) {
      for (const id of linesCovered(page, candidateSet[index]!)) {
        occupied.add(`${page.shown}|${id}`);
      }
    }
    accepted.push({
      field,
      page: statement.page,
      quote: candidateSet[gated.support[0] ?? 0]?.text ?? "",
      lines: [...(statement.lines ?? [])],
      citation,
      spanIds,
      values: gated.values,
      ...(gated.itemsTotal === undefined
        ? {}
        : { itemsTotal: gated.itemsTotal }),
      ...(gated.currencyAssumed ? { currencyAssumed: true as const } : {}),
    });
  };

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
      prepared.unusable += 1;
      continue;
    }
    prepared.named += 1;
    // A blank box on a form is not a failed reading. Fifteen K-1 statements
    // came back with an empty value for a box the form leaves empty, and each
    // opened an item the owner would have had to dismiss one at a time. An
    // empty value for an optional field means the document does not state it,
    // which is exactly what omitting the field would have meant. A *required*
    // field still opens one, because a required field the document does not
    // state is worth knowing about.
    const page = pages.get(statement.page);
    if (isBlankReading(statement.value)) {
      if (!field.required) continue;
      prepared.failures.push({
        field: field.name,
        reason: "malformed_statement",
        reading: null,
        ...(page ? { citation: citationOf(page, statement) } : {}),
      });
      continue;
    }
    if (!page) {
      // Its own reason, not `citation_out_of_range`. A citation into a page
      // that does not exist is a model reading the page numbering differently
      // from the server, and that is a different bug from a line id off the
      // end of a page it can see -- one the counts have to be able to tell
      // apart, because the first time it happened it looked like ordinary
      // model error. Nothing is shifted to make it fit: a guess at which page
      // was meant is a wrong value with a citation.
      prepared.failures.push({
        field: field.name,
        reason: "citation_page_unknown",
        reading: statement.value,
      });
      continue;
    }
    const citation = citationOf(page, statement);
    const located = resolveCitation(page, statement);
    if (located.reason) {
      prepared.failures.push({
        field: field.name,
        reason: located.reason,
        reading: statement.value,
        citation,
      });
      continue;
    }
    // A list is gated entry by entry, each against its own cited lines.
    if (field.valueType === "line_item_list") {
      // On the legacy quote path there are no line ids, so the located range
      // stands in as the one line every entry is checked against.
      const fallback: PageLine[] =
        located.cited.length > 0
          ? [...located.cited]
          : located.legacy
            ? [
                {
                  id: 0,
                  ...located.legacy,
                  text: page.text.slice(
                    located.legacy.start,
                    located.legacy.end,
                  ),
                  // Not cut edges, deliberately and in the same way the
                  // non-list legacy branch below leaves them unset. The model
                  // chose where this quote began and ended, so an edge here
                  // is neither a printed boundary nor a cut this file made,
                  // and ADM-5g does not change what the legacy shape reads.
                  // The line-id path, which every current kind uses, cites
                  // whole lines and carries real edges.
                  cutStart: false,
                  cutEnd: false,
                },
              ]
            : [];
      const listed = await gateLineItems(client, loaded, page, {
        field,
        value: statement.value,
        cited: fallback,
        defaultCurrency: "USD",
      });
      if (listed.failed > 0) {
        prepared.failures.push({
          field: field.name,
          reason:
            listed.values.length === 0
              ? "value_not_in_quote"
              : "line_items_partial",
          // Counts only. Which entries failed is the diagnostic's business,
          // and the owner's question is "how much of this list is missing".
          reading: {
            failedItems: listed.failed,
            totalItems: listed.total,
            failedShapes: listed.failedShapes,
          },
          citation,
        });
      }
      if (listed.values.length > 0) {
        // A list occupies the lines it was read from, exactly as `accept`
        // does for every other field. Until ADM-5h it occupied none of them,
        // and a repair moved another field's citation straight onto an
        // item's own line: a receipt printing `Mallet 8.00`, `Subtotal` and
        // `Total 28.00` stored a subtotal of 8.00 off the mallet. Repairs
        // are resolved only after this loop has seen every statement, so a
        // list that arrives after the statement that would move onto it
        // blocks that move just as surely as one that arrives before.
        for (const id of listed.lineIds) {
          occupied.add(`${page.shown}|${id}`);
        }
        accepted.push({
          field,
          page: statement.page,
          quote: listed.quote,
          lines: [...(statement.lines ?? [])],
          citation,
          spanIds: listed.spanIds,
          valueKeys: listed.valueKeys,
          values: listed.values,
          itemsTotal: listed.itemsTotal,
          ...(listed.currencyAssumed ? { currencyAssumed: true as const } : {}),
        });
      }
      continue;
    }
    // Each cited line on its own, and for a text field each adjacent pair.
    // The lines between two cited ones are deliberately absent.
    const candidates: Candidate[] = located.legacy
      ? [
          {
            text: page.text.slice(located.legacy.start, located.legacy.end),
            ...located.legacy,
          },
        ]
      : candidatesFor(located.cited, field.valueType);
    const gated = checkValue({
      valueType: field.valueType,
      value: statement.value,
      candidates,
      pageText: page.text,
      defaultCurrency: "USD",
      ...(type?.dateOrder ? { dateOrder: type.dateOrder } : {}),
    });
    if (!gated.ok) {
      // The value is not on any line the model cited. It may still be one
      // line off a line that states it -- `repairTarget` holds the six
      // conditions that decide. A repair is only *proposed* here: whether it
      // stands depends on what the rest of the reply points at, and that is
      // not known until this loop ends.
      const target =
        gated.reason === "value_not_in_quote" &&
        (field.valueType === "money" || field.valueType === "number")
          ? repairTarget(
              loaded,
              page,
              located.cited,
              field.valueType,
              statement.value,
              candidates,
            )
          : null;
      if (target) {
        repairs.push({ field, statement, page, citation, target });
        continue;
      }
      prepared.failures.push({
        field: field.name,
        reason: gated.reason,
        reading: statement.value,
        citation,
      });
      continue;
    }
    await accept(field, page, statement, citation, candidates, gated);
  }

  // The repairs, now that the whole reply is known.
  //
  // Two refusals belong here and nowhere else, because each is about the run
  // rather than about one statement: a line another accepted statement was
  // already read from, and a line two statements would both move onto. Both
  // are the same fault -- a document with one value and two fields claiming
  // it -- and on a receipt printing `Subtotal`, `Tax` and `Total` above a
  // single amount it stored all three from that one line.
  for (const repair of repairs) {
    const key = `${repair.page.shown}|${repair.target.id}`;
    const contested =
      occupied.has(key) ||
      repairs.some(
        (other) =>
          other !== repair &&
          `${other.page.shown}|${other.target.id}` === key,
      );
    const candidates = [lineCandidate(repair.target)];
    const gated = contested
      ? null
      : checkValue({
          valueType: repair.field.valueType,
          value: repair.statement.value,
          candidates,
          pageText: repair.page.text,
          defaultCurrency: "USD",
          ...(type?.dateOrder ? { dateOrder: type.dateOrder } : {}),
        });
    if (!gated || !gated.ok) {
      prepared.failures.push({
        field: repair.field.name,
        reason: gated && !gated.ok ? gated.reason : "value_not_in_quote",
        reading: repair.statement.value,
        citation: repair.citation,
      });
      continue;
    }
    await accept(
      repair.field,
      repair.page,
      repair.statement,
      repair.citation,
      candidates,
      gated,
    );
  }

  if (prepared.unusable > 0) {
    // One row for the whole document, not one per name: this is a sign the
    // kind is wrong or the guidance is stale, and it is one thing for the
    // owner to look at, not fifteen. The count is on it because the names
    // alone cannot distinguish one stray field from a reply where every
    // entry was unreadable -- which is the difference the live trial could
    // not see.
    prepared.failures.push({
      field: null,
      reason: "unknown_field",
      reading: {
        fields: unknownFields.slice(0, 64),
        unnamed: reading.unnamed,
        unusable: prepared.unusable,
      },
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
      // A list always keys by evidence, even when it has one entry today: a
      // one-item list keyed `line_items` orphans the owner's correction the
      // moment next week's receipt has two.
      const key =
        entry.field.valueType === "line_item_list" || entry.values.length > 1
          ? `${name}:${entry.valueKeys?.[index] ?? index}`
          : name;
      keys.push(key);
      prepared.observations.push({
        key,
        type: name,
        value,
        evidence: [entry.spanIds[index] ?? entry.spanIds[0]!],
      });
      if (value.type === "money" && !moneyByField.has(name)) {
        moneyByField.set(name, value.amount);
      }
      // Only a full date can date an event: `occurrence_date` holds a
      // calendar day, and a year-precision value has none to give. A
      // document whose only date is "2024" keeps an unknown occurrence
      // rather than being filed under the first of January.
      if (
        value.type === "date" &&
        (value.precision ?? "day") === "day" &&
        prepared.occurrence.precision === "unknown"
      ) {
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
      evidenceSpanId: entry.spanIds[0]!,
      citation: entry.citation,
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

/**
 * An exact date already stored is not downgraded to a partial one.
 *
 * The rule, in full: **when a run offers only a year or only a month and a
 * year for a field that already holds a full day, and the day it holds
 * begins with what the new run read, the stored day and its evidence are
 * kept.** A contradiction -- a different year, or a different month --
 * replaces it, because then the two readings disagree about the document and
 * keeping the old day would be storing a date this run does not support.
 *
 * Why it is needed at all: extraction replaces a document's observations
 * wholesale on every run, and a model reads the same page differently from
 * one run to the next. Without this, a re-extraction that happened to copy
 * "2024" off a cover page turned a stored `2024-03-18` into `2024`, an
 * event's `occurrence_date` into null, and a document that was on the
 * timeline into one that is not. Nothing said anything had changed.
 *
 * The old value keeps its **own** evidence, never the new run's. The line
 * the new run cited prints a year and not a day, and attaching a day to it
 * would be the one failure this whole gate exists to prevent. Only rows from
 * the same text version qualify, because a span is an offset into the text
 * it was cut from and a reparse moves every one of them.
 */
async function keepExactDates(
  client: ClientBase,
  loaded: Loaded,
  eventId: string,
  prepared: Prepared,
): Promise<void> {
  const partial = prepared.observations.filter(
    (observation) =>
      observation.value.type === "date" &&
      observation.value.precision !== undefined,
  );
  if (partial.length === 0) return;
  const stored = await client.query<{
    observation_key: string;
    value: ObservationValue;
    value_evidence: string[];
  }>(
    `SELECT observation_key, value, value_evidence FROM kith.observations
      WHERE event_id = $1 AND space_id = $2 AND source_text_version_id = $3`,
    [eventId, loaded.spaceId, loaded.sourceTextVersionId],
  );
  const exact = new Map<string, { value: ObservationValue; evidence: string[] }>();
  for (const row of stored.rows) {
    const value = row.value;
    if (
      value &&
      value.type === "date" &&
      value.precision === undefined &&
      Array.isArray(row.value_evidence) &&
      row.value_evidence.length > 0
    ) {
      exact.set(row.observation_key, { value, evidence: row.value_evidence });
    }
  }
  if (exact.size === 0) return;
  for (const observation of partial) {
    const previous = exact.get(observation.key);
    if (!previous || previous.value.type !== "date") continue;
    const read = observation.value as { type: "date"; value: string };
    // Consistent, which for a prefix of an ISO date is exactly what it looks
    // like: `2024-03-18` begins with `2024` and with `2024-03`, and with
    // neither `2025` nor `2024-04`.
    if (!previous.value.value.startsWith(read.value)) continue;
    observation.value = previous.value;
    observation.evidence = previous.evidence;
    // And it dates the event again. A day kept as a day that left the
    // timeline anyway would be half a fix.
    if (prepared.occurrence.precision === "unknown") {
      prepared.occurrence = {
        precision: "date",
        date: previous.value.value,
      };
    }
  }
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
  retryUnreadable: boolean,
  refusedModel: string | null = null,
): Promise<ExtractionOutcome> {
  const type = loaded.types.find(
    (candidate) => candidate.kind === reading.kind,
  );
  const prepared = await prepare(client, loaded, reading, type);
  // A reply with entries in it, not one of which named a field this kind has,
  // is a model that answered in a shape nobody asked for. That is a different
  // thing from a document that states nothing, and it is worth one more call
  // before it is written down as the document's answer: the trial that found
  // this saw it on two documents out of five and a second attempt costs a
  // third of a cent. Throwing rolls the transaction back, so the retry starts
  // from the same clean state, and `fail`'s backoff schedules it.
  if (retryUnreadable && prepared.named === 0 && prepared.unusable > 0) {
    throw new ProofError(EXTRACTION_REPLY_UNREADABLE);
  }
  const entityId = await placeholderEntityId(
    client,
    loaded.spaceId,
    loaded.userId,
  );
  const eventId = await stableEventId(client, loaded);

  // Before anything is deleted: a date this document already stated in full
  // is not lost to a run that read less of it.
  await keepExactDates(client, loaded, eventId, prepared);

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

  // Partially read either way: fewer pages shown than the document has, or a
  // page longer than the model was shown. A limitation the owner cannot see is
  // the same as no limitation at all.
  const droppedPages = loaded.pages.length < loaded.pagesWithText;
  const droppedLines = loaded.pages.some(
    (page) => page.lines.length > MAX_PAGE_LINES,
  );
  const truncated = droppedPages || droppedLines;
  // Hoisted: both the row below and every `openCorrection` call past it need
  // the kind this run read the document as (ADM-8a: a document-kind mute
  // checks against exactly this value), so it is computed once rather than
  // repeating `type ? type.kind : "other"` at each site.
  const documentKind = type ? type.kind : "other";
  // ADM-8a: the source root this document's account watches, when that is
  // unambiguous -- see the function for why "unambiguous" is as far as this
  // goes.
  const sourceRootId = await resolveUnambiguousSourceRoot(
    client,
    loaded.spaceId,
    loaded.sourceAccountId,
  );
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
      documentKind,
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

  // Nothing this run stranded, and nothing the *previous* run stranded, is
  // left behind. Both cases are one query and both belong here, after the
  // three reference sites above are written: pass two of `prepare` drops a
  // whole field's statements after their spans exist, and the observation
  // replace at the top of this function abandons every span the last run
  // cited and this one did not. A stranded span used to fail the parsed
  // payload's seal outright. See `./spanSweep.ts` for the eight places a span
  // can be referenced from and why the check is a whitelist.
  //
  // ADM-5l: "what the previous run stranded" includes the spans that run
  // wrote before the `extraction_v1` marker existed. They are unmarked, the
  // observations that adopted them were replaced at the top of this function,
  // and until this sweep matched the cleanup's selection they were left for a
  // hand-run CLI -- 48 of them across 37 of the owner's generations, each one
  // failing `payload_verify_error:id_sets` all over again.
  await sweepUnreferencedExtractionSpans(client, {
    spaceId: loaded.spaceId,
    sourceTextVersionId: loaded.sourceTextVersionId,
  });

  // The previous run's open items go before this run's are written, so the
  // queue shows what is wrong now rather than everything that has ever been
  // wrong. A failure that recurs is re-opened a line below; one that no longer
  // applies simply is not.
  //
  // Before the re-apply below, not after: re-applying can itself open an item
  // (a correction whose line this run no longer cites), and clearing after
  // would delete the one row telling the owner their fix no longer lands.
  await supersedeOpenCorrections(client, {
    spaceId: loaded.spaceId,
    sourceItemId: loaded.sourceItemId,
  });

  // A human fix outlives this replace when its field belongs to the current
  // kind. The observations above are the model's newest reading of every such
  // field, so without this line a re-extraction silently reverts a correction
  // on the exact-arithmetic side -- `latest_observation` and `sum_money` back
  // to the model's number -- while `get_document` goes on showing the owner's.
  // A correction from a former kind stays in history without recreating an
  // out-of-schema observation. Re-applied inside the same transaction as the
  // replace, so no reader ever sees the reverted state.
  await reapplyCorrections(client, {
    spaceId: loaded.spaceId,
    sourceItemId: loaded.sourceItemId,
    declaredFields: new Set(type?.fields.map((field) => field.name) ?? []),
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
      // The scalar the model returned, and what it cited. The citation is
      // what makes a failure diagnosable without reading the document.
      reading: failure.citation
        ? { value: failure.reading, citation: failure.citation }
        : failure.reading,
      documentKind,
      sourceRootId,
    });
  }
  if (refusedModel !== null) {
    // One row, named, saying which string the provider would not take. The
    // reading beside it is the default model's, so the document is read.
    await openCorrection(client, {
      spaceId: loaded.spaceId,
      sourceItemId: loaded.sourceItemId,
      fieldName: null,
      reason: "extraction_model_refused",
      reading: { requestedModel: refusedModel, usedModel: modelName },
      documentKind,
      sourceRootId,
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
        pagesWithText: loaded.pagesWithText,
        pagesTotal: loaded.pagesTotal,
        linesShownPerPage: MAX_PAGE_LINES,
        longestPageLines: Math.max(
          0,
          ...loaded.pages.map((page) => page.lines.length),
        ),
      },
      documentKind,
      sourceRootId,
    });
  }
  // ADM-8c, trigger one: the statements this document now states are the
  // statements the matcher scores, so the job is enqueued here, in the
  // transaction that replaced them. A re-extraction enqueues it again, which
  // is the point -- a corrected amount has to be able to turn a suggestion
  // into a link -- and the dedupe key collapses a burst of re-activations
  // onto one queued row.
  //
  // INSIDE A SAVEPOINT, because an investments feature must never be able to
  // lose a document: a queue row that cannot be written must not take the
  // statements, the spans and the corrections down with it. See
  // `withLinkEnqueueSavepoint` for which triggers get that treatment, which
  // must not, and why 40001 and 40P01 still propagate.
  await withLinkEnqueueSavepoint(
    { client, now },
    { sourceItemId: loaded.sourceItemId, documentKind },
    () =>
      scheduleInvestmentLinkForExtraction(
        { client, now },
        {
          spaceId: loaded.spaceId,
          sourceItemId: loaded.sourceItemId,
          kind: documentKind,
        },
      ),
  );
  return {
    sourceItemId: loaded.sourceItemId,
    kind: documentKind,
    stored: prepared.observations.length,
    failed: prepared.failures.length,
    truncated,
  };
}

/**
 * The one source root a document's account watches, when that is
 * unambiguous (ADM-8a: a `source_root` attention mute needs a root id per
 * document).
 *
 * `source_items` carries no direct root column -- a real resolution would
 * match the item's `fs://<alias>/<path>` URI against `source_roots`' own
 * alias and relative path, the way the watcher itself does, and that is
 * genuine matching logic this slice is deliberately not building. When an
 * account has exactly one root there is nothing to disambiguate and this is
 * exact; with more than one (or none) it returns `null` rather than
 * guessing, so a `source_root` mute simply does not fire for that document
 * instead of firing on the wrong one.
 *
 * ponytail: upgrade path is the alias/relative-path resolution above, once a
 * real need for per-subtree mutes on a multi-root account shows up.
 */
async function resolveUnambiguousSourceRoot(
  client: ClientBase,
  spaceId: string,
  sourceAccountId: string,
): Promise<string | null> {
  const found = await client.query<{ id: string }>(
    `SELECT id FROM kith.source_roots
      WHERE space_id = $1 AND source_account_id = $2 LIMIT 2`,
    [spaceId, sourceAccountId],
  );
  return found.rows.length === 1 ? found.rows[0]!.id : null;
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
  const first = await withKithTransaction(pool, (client) =>
    loadDocument(client, spaceId, sourceItemId, now),
  );
  // A document that is forgotten, unavailable, still parsing or replaced since
  // the job was queued is not an error: the activation that replaces it queues
  // its own job.
  if (!first) return null;
  if (
    first.ownerKind !== null &&
    !first.types.some((type) => type.kind === first.ownerKind)
  ) {
    throw new TerminalDeferredWorkError("owner_classification_schema_inactive");
  }
  if (first.types.length === 0) return null;
  let loaded: Loaded = first;
  const enforceOwnerKind = (reading: ModelReading): ModelReading =>
    loaded.ownerKind === null ? reading : { ...reading, kind: loaded.ownerKind };

  // Which model reads this document.
  //
  // A kind's override can only apply once the kind is known, and the model is
  // what decides the kind. Two ways out of that, both used here: a document
  // extracted before reads with the model its recorded kind asks for, and a
  // document read for the first time is read again -- once, at most -- when
  // the kind it turned out to be asks for a different one. A kind with no
  // override, which is every kind until the owner adds one, costs exactly one
  // call as it always did.
  const request = buildRequest(loaded);
  const knownOverride = loaded.priorKind
    ? (loaded.types.find((type) => type.kind === loaded.priorKind)?.model ??
      null)
    : null;
  // A refused override falls back to the default, once.
  //
  // The override is a string an owner typed. A typo in it would otherwise
  // wedge every document of that kind: the provider refuses the model, the
  // job fails, the queue retries and fails again until the attempts run out,
  // and the only sign is a provider error that names nothing. So a refusal
  // costs one fallback call and one correction that says which string was
  // refused, and the document is read with the default model meanwhile.
  let used = knownOverride ?? model.name;
  let refusedModel: string | null = null;
  let reading: ModelReading;
  try {
    reading = enforceOwnerKind(
      await model.read(
        knownOverride ? { ...request, model: knownOverride } : request,
      ),
    );
  } catch (error) {
    // Only an override can be fallen back from. A default that fails is the
    // provider being down, which is the queue's business, not this branch's.
    if (!knownOverride) throw error;
    refusedModel = knownOverride;
    used = model.name;
    reading = enforceOwnerKind(await model.read(request));
  }
  const chosen = loaded.types.find((type) => type.kind === reading.kind);
  const wanted = chosen?.model ?? null;

  // The kind can also widen how much of the document is read, and until the
  // reply names a kind there is no way to know which bound applies. So a
  // first pass that was truncated, on a kind that asks for more, is read once
  // more with the wider bound. Twenty of the owner's K-1s average
  // twenty-five pages against a default of twelve; the setting is the fix and
  // it has to reach the document that needed it, not only the next one.
  const widened = withKindBounds(loaded, reading.kind);
  const widerRequest = widened === loaded ? null : buildRequest(widened);
  loaded = widened;

  if (refusedModel === null && (widerRequest || (wanted && wanted !== used))) {
    const next = widerRequest ?? request;
    try {
      reading = enforceOwnerKind(
        await model.read(wanted ? { ...next, model: wanted } : next),
      );
      if (wanted) used = wanted;
    } catch {
      // Keep the reading the first pass produced rather than losing the
      // document to a string the provider will refuse again. No second try:
      // that is the loop this guard exists to prevent.
      if (wanted && wanted !== used) refusedModel = wanted;
    }
  }

  return await withKithTransaction(pool, async (client) => {
    // The generation may have been replaced while the model was reading. Write
    // against what is current now or not at all.
    const current = await loadDocument(client, spaceId, sourceItemId, now);
    if (
      !current ||
      current.processingGenerationId !== loaded.processingGenerationId ||
      current.ownerKind !== loaded.ownerKind
    ) {
      return null;
    }
    // One retry, and only one: `attempts` is still 0 on a job's first run
    // (`claim` increments it only for a reclaim), so the second run settles
    // for the correction rather than looping on a model that will answer the
    // same way every time.
    return await store(
      client,
      // Through the same bounds the model was shown, or the pages it was
      // invited to cite would be pages this side of the job has never heard
      // of: every citation past the twelfth would come back
      // `citation_page_unknown`, and the document would be reported as
      // partially read when it was read whole.
      withKindBounds(current, reading.kind),
      reading,
      used,
      now,
      job.attempts === 0,
      refusedModel,
    );
  });
}
