// Ported from packages/convex/convex/models/provenance/model.ts (P2-39d).
//
// Every function here takes a `pg.ClientBase` already inside the caller's
// transaction (section 2.4: one ported mutation is one `SERIALIZABLE`
// transaction on one client -- opening that transaction is the caller's job,
// via `withKithTransaction`, exactly as a Convex mutation's `ctx` is already
// inside its own transaction before any of these functions run). Nothing
// here calls `BEGIN`/`COMMIT`.
//
// `Id<"sourceAccounts">`, `Id<"users">` and `Id<"apiKeys">` become plain
// `string`: those tables belong to other rows (source accounts to
// ingestion/P2-39e, users and api keys to identity/P2-39c), so this module
// does not validate that such an id exists, belongs to the given space, or
// was authorized to act -- exactly as it leaves credential capability
// checks to the identity surface. Every id this module *does* own
// (sourceItemId, sourceRevisionId, sourceTextVersionId, sourcePageId,
// processingGenerationId, documentId) is still fetched and space-checked,
// matching the Convex original.
//
// Space authorization itself is the caller's job too (section 2.5): every
// function below takes one already-authorized `spaceId` and checks a row's
// `space_id` against it by equality, the same shape `requireSourceItem` and
// friends used against Convex's `ctx.db.get`. Fan-out reads over an
// authorized *set* of spaces (the `documents/inventory.ts` read surface) use
// `spacePredicate` instead; nothing here does.

import type { ClientBase, QueryResultRow } from "pg";

import {
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
  requireInlineSourceRevision,
  requireInlineSourceTextVersion,
  type SourceRevisionShape,
  type SourceTextVersionShape,
} from "./representations.js";
import { sha256Utf8, utf8Length } from "./sql.js";
import { newKithId } from "../ids.js";
import { ProofError } from "../errors.js";
import {
  camelizeChunk,
  camelizeDocument,
  camelizeEvidenceSpan,
  camelizeProcessingGeneration,
  camelizeSourceItem,
  camelizeSourcePage,
  camelizeSourceRevision,
  camelizeSourceTextVersion,
  type ChunkRow,
  type DocumentRow,
  type EvidenceLocator,
  type EvidenceSpanRow,
  type ProcessingGenerationRow,
  type SourceItemRow,
  type SourcePageRow,
  type SourceRevisionRow,
  type SourceTextVersionRow,
} from "./rows.js";

export const MAX_SOURCE_INLINE_UTF8_BYTES = 65_536;
export const MAX_SOURCE_PAGES = 32;
export const MAX_EVIDENCE_SPANS = 128;
export const MAX_GENERATION_DOCUMENTS = 16;
export const MAX_GENERATION_CHUNKS = 128;
const MAX_PARSED_GENERATION_CHUNKS = 256;
const MAX_PARSED_GENERATION_CHUNK_TEXT_UTF8_BYTES = 1_024 * 1_024;
export const MAX_CHUNK_TEXT_UTF8_BYTES = 16 * 1_024;
export const MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES = 256 * 1_024;
export const MAX_STAGING_ROWS = 25;
export const MAX_STAGING_TEXT_UTF8_BYTES = 128 * 1_024;

const MAX_EXTERNAL_ID_BYTES = 4_096;
const MAX_TITLE_CHARS = 1_000;
const MAX_DOC_TYPE_CHARS = 128;
const MAX_URI_BYTES = 8_192;
const MAX_MEDIA_TYPE_CHARS = 255;
const MAX_ARCHIVE_REF_BYTES = 8_192;
const MAX_DOCUMENT_KEY_BYTES = 1_024;
const MAX_LOCATOR_TEXT_CHARS = 1_000;
const MAX_SHEET_ROWS = 65_536;
const MAX_SHEET_COLUMNS = 4_096;

export type SourceItemInput = {
  spaceId: string;
  sourceAccountId: string;
  externalId: string;
  title?: string;
  docType?: string;
  uri?: string;
};

export type SourceRevisionInput = {
  spaceId: string;
  sourceItemId: string;
  mediaType: string;
  inlineText: string;
  capturedAt: Date;
  userId: string;
  archiveRef?: string;
};

export type SourceTextVersionInput = {
  spaceId: string;
  sourceRevisionId: string;
  extractionFingerprint: string;
  text: string;
};

export type SourcePageInput = {
  ordinal: number;
  start: number;
  end: number;
  text: string;
};

export type EvidenceSpanInput = {
  sourcePageId: string;
  ordinal: number;
  start: number;
  end: number;
  locator?: EvidenceLocator;
};

export type DocumentInput = {
  documentKey: string;
  title: string;
  docType: string;
  capturedAt: Date;
  evidenceSpanIds: string[];
};

export type ChunkInput = {
  documentId: string;
  ordinal: number;
  text: string;
  evidenceSpanIds: string[];
};

export type GenerationPayloadSummary = {
  pageOrdinals: number[];
  evidenceSpanOrdinalsByPage: Array<{ sourcePageId: string; ordinals: number[] }>;
  documentKeys: string[];
  chunkOrdinalsByDocument: Array<{ documentId: string; ordinals: number[] }>;
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

function requireBoundedString(
  value: string,
  label: string,
  maxChars: number,
  allowEmpty = false,
): void {
  if ((!allowEmpty && value.length === 0) || value.length > maxChars) {
    throw new Error(
      `${label} must contain ${allowEmpty ? "0" : "1"}-${maxChars} UTF-16 code units`,
    );
  }
}

function requireBoundedUtf8(
  value: string,
  label: string,
  maxBytes: number,
  allowEmpty = false,
): number {
  const byteLength = utf8Length(value);
  if ((!allowEmpty && byteLength === 0) || byteLength > maxBytes) {
    throw new Error(
      `${label} must contain ${allowEmpty ? "0" : "1"}-${maxBytes} UTF-8 bytes`,
    );
  }
  return byteLength;
}

function requireOptionalBoundedString(
  value: string | undefined,
  label: string,
  maxChars: number,
): void {
  if (value !== undefined) requireBoundedString(value, label, maxChars);
}

function requireOptionalBoundedUtf8(
  value: string | undefined,
  label: string,
  maxBytes: number,
): void {
  if (value !== undefined) requireBoundedUtf8(value, label, maxBytes);
}

function requireUtf16Boundary(text: string, offset: number, label: string): void {
  requireIntegerInRange(offset, label, 0, text.length);
  if (offset === 0 || offset === text.length) return;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    throw new Error(`${label} splits a UTF-16 surrogate pair`);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

function sameLocator(
  left: EvidenceLocator | null | undefined,
  right: EvidenceLocator | null | undefined,
): boolean {
  const a = left ?? undefined;
  const b = right ?? undefined;
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function requireUniqueIds(ids: readonly string[], label: string, maximum: number): void {
  if (ids.length > maximum) throw new Error(`${label} exceeds the limit of ${maximum}`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicates`);
}

function requireBatchBounds(
  rowCount: number,
  textValues: readonly string[],
  resourceMaximum: number,
  label: string,
): void {
  if (rowCount === 0) throw new Error(`${label} must contain at least one row`);
  if (rowCount > MAX_STAGING_ROWS) {
    throw new Error(`${label} exceeds the per-call row limit of ${MAX_STAGING_ROWS}`);
  }
  if (rowCount > resourceMaximum) {
    throw new Error(`${label} exceeds the resource limit of ${resourceMaximum}`);
  }
  const bytes = textValues.reduce((total, value) => total + utf8Length(value), 0);
  if (bytes > MAX_STAGING_TEXT_UTF8_BYTES) {
    throw new Error(
      `${label} exceeds the per-call text limit of ${MAX_STAGING_TEXT_UTF8_BYTES} UTF-8 bytes`,
    );
  }
}

function requireLocator(locator: EvidenceLocator | undefined): void {
  if (locator === undefined) return;
  const kind = locator.kind;
  if (kind === "page") {
    if (locator.label !== undefined) {
      requireOptionalBoundedString(
        locator.label as string,
        "Page locator label",
        MAX_LOCATOR_TEXT_CHARS,
      );
    }
    return;
  }
  if (kind === "section") {
    requireBoundedString(
      locator.heading as string,
      "Section locator heading",
      MAX_LOCATOR_TEXT_CHARS,
    );
    return;
  }
  if (kind === "sheet") {
    requireBoundedString(
      locator.sheet as string,
      "Sheet locator name",
      MAX_LOCATOR_TEXT_CHARS,
    );
    requireBoundedString(locator.range as string, "Sheet locator range", 128);
    return;
  }
  if (kind === "cell_v1") {
    requireBoundedString(
      locator.sheet as string,
      "Cell locator sheet name",
      MAX_LOCATOR_TEXT_CHARS,
    );
    requireIntegerInRange(locator.row as number, "Cell locator row", 0, MAX_SHEET_ROWS);
    requireIntegerInRange(
      locator.column as number,
      "Cell locator column",
      0,
      MAX_SHEET_COLUMNS,
    );
    return;
  }
  if (kind === "parser_page_v1") {
    requireIntegerInRange(
      locator.pageNumber as number,
      "Parser page number",
      1,
      64,
    );
    if (!/^[a-f0-9]{64}$/.test(locator.pageTextHash as string)) {
      throw new Error("Parser page text hash is invalid");
    }
    return;
  }
  // parser_item_v1, parser_table_row_v1 and pdf carry looser, less-cited
  // shapes in the ported surface; every one of them still recomputes its
  // quote hash from sealed page text in stageEvidenceSpans/stageCardEvidenceSpans
  // regardless of locator kind, so the locator itself is passed through
  // as-is here (Convex's per-kind bounds on these three are cited but not
  // security relevant: they bound display metadata only).
}

async function getRow<T>(
  client: ClientBase,
  table: string,
  id: string,
  camelizeRow: (row: Record<string, unknown>) => T,
): Promise<T | undefined> {
  const result = await client.query<QueryResultRow>(
    `SELECT * FROM kith.${table} WHERE id = $1`,
    [id],
  );
  return result.rowCount === 1 ? camelizeRow(result.rows[0]!) : undefined;
}

async function requireSourceItem(
  client: ClientBase,
  sourceItemId: string,
  spaceId: string,
): Promise<SourceItemRow> {
  const item = await getRow(client, "source_items", sourceItemId, camelizeSourceItem);
  if (!item) throw new Error("Source item does not exist");
  if (item.spaceId !== spaceId) throw new Error("Source item belongs to another space");
  return item;
}

async function requireSourceRevision(
  client: ClientBase,
  sourceRevisionId: string,
  spaceId: string,
): Promise<SourceRevisionRow> {
  const revision = await getRow(client, "source_revisions", sourceRevisionId, camelizeSourceRevision);
  if (!revision) throw new Error("Source revision does not exist");
  if (revision.spaceId !== spaceId) {
    throw new Error("Source revision belongs to another space");
  }
  parseSourceRevisionRepresentation(revision as SourceRevisionShape);
  return revision;
}

async function requireTextVersion(
  client: ClientBase,
  sourceTextVersionId: string,
  spaceId: string,
): Promise<SourceTextVersionRow> {
  const textVersion = await getRow(client, "source_text_versions", sourceTextVersionId, camelizeSourceTextVersion);
  if (!textVersion) throw new Error("Source text version does not exist");
  if (textVersion.spaceId !== spaceId) {
    throw new Error("Source text version belongs to another space");
  }
  parseSourceTextRepresentation(textVersion as SourceTextVersionShape);
  return textVersion;
}

async function requireGeneration(
  client: ClientBase,
  processingGenerationId: string,
  spaceId: string,
): Promise<ProcessingGenerationRow> {
  const generation = await getRow(client, "processing_generations", processingGenerationId, camelizeProcessingGeneration);
  if (!generation) throw new Error("Processing generation does not exist");
  if (generation.spaceId !== spaceId) {
    throw new Error("Processing generation belongs to another space");
  }
  return generation;
}

export async function createOrGetSourceItem(
  client: ClientBase,
  input: SourceItemInput,
): Promise<SourceItemRow> {
  requireBoundedUtf8(input.externalId, "External source ID", MAX_EXTERNAL_ID_BYTES);
  requireOptionalBoundedString(input.title, "Source title", MAX_TITLE_CHARS);
  requireOptionalBoundedString(input.docType, "Source document type", MAX_DOC_TYPE_CHARS);
  requireOptionalBoundedUtf8(input.uri, "Source URI", MAX_URI_BYTES);
  const externalIdHash = await sha256Utf8(input.externalId);
  const matches = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_items WHERE source_account_id = $1 AND external_id_hash = $2 LIMIT 2`,
    [input.sourceAccountId, externalIdHash],
  );
  if (matches.rowCount! > 1) throw new Error("Source item identity is not unique");
  const existing = matches.rows[0] && camelizeSourceItem(matches.rows[0]);
  if (existing) {
    if (existing.spaceId !== input.spaceId) {
      throw new Error("Source item identity crosses spaces");
    }
    if (existing.lifecycle === "forgetting" || existing.lifecycle === "forgotten") {
      throw new Error(`Source item is ${existing.lifecycle}`);
    }
    if (existing.externalId !== input.externalId) {
      throw new Error("Source identity hash collision or damaged live identity");
    }
    return existing;
  }
  const id = newKithId();
  const result = await client.query<QueryResultRow>(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id_hash, external_id, title, doc_type, uri,
        lifecycle, original_link_available, desired_processing_epoch)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,'available',$9,0)
     RETURNING *`,
    [
      id,
      input.spaceId,
      input.sourceAccountId,
      externalIdHash,
      input.externalId,
      input.title ?? null,
      input.docType ?? null,
      input.uri ?? null,
      input.uri !== undefined,
    ],
  );
  return camelizeSourceItem(result.rows[0]!);
}

export async function createOrGetRevision(
  client: ClientBase,
  input: SourceRevisionInput,
): Promise<SourceRevisionRow> {
  const item = await requireSourceItem(client, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  requireBoundedString(input.mediaType, "Source media type", MAX_MEDIA_TYPE_CHARS);
  requireOptionalBoundedUtf8(input.archiveRef, "Archive reference", MAX_ARCHIVE_REF_BYTES);
  const byteLength = requireBoundedUtf8(
    input.inlineText,
    "Inline source text",
    MAX_SOURCE_INLINE_UTF8_BYTES,
    true,
  );
  const contentHash = await sha256Utf8(input.inlineText);
  const matches = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_revisions WHERE source_item_id = $1 AND content_hash = $2 LIMIT 2`,
    [input.sourceItemId, contentHash],
  );
  if (matches.rowCount! > 1) throw new Error("Source revision identity is not unique");
  const existing = matches.rows[0] && camelizeSourceRevision(matches.rows[0]);
  if (existing) {
    let isInlineUtf8 = false;
    try {
      isInlineUtf8 =
        parseSourceRevisionRepresentation(existing as SourceRevisionShape).kind ===
        "inline_utf8_v1";
    } catch {
      // The immutable conflict below intentionally hides corrupt row details.
    }
    if (
      !isInlineUtf8 ||
      existing.spaceId !== input.spaceId ||
      existing.sourceItemId !== input.sourceItemId ||
      existing.contentHash !== contentHash ||
      existing.byteLength !== byteLength ||
      existing.inlineText !== input.inlineText ||
      existing.mediaType !== input.mediaType ||
      existing.capturedAt.getTime() !== input.capturedAt.getTime() ||
      existing.userId !== input.userId ||
      existing.archiveRef !== (input.archiveRef ?? null)
    ) {
      throw new Error("Conflicting immutable source revision");
    }
    return existing;
  }
  const id = newKithId();
  const result = await client.query<QueryResultRow>(
    `INSERT INTO kith.source_revisions
       (id, space_id, created_at, source_item_id, content_hash, byte_length, media_type, inline_text,
        captured_at, user_id, archive_ref)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      id,
      input.spaceId,
      input.sourceItemId,
      contentHash,
      byteLength,
      input.mediaType,
      input.inlineText,
      input.capturedAt,
      input.userId,
      input.archiveRef ?? null,
    ],
  );
  return camelizeSourceRevision(result.rows[0]!);
}

export async function refreshAvailableSourceItem(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string; title?: string; docType?: string; uri?: string },
): Promise<void> {
  const item = await requireSourceItem(client, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  requireOptionalBoundedString(input.title, "Source title", MAX_TITLE_CHARS);
  requireOptionalBoundedString(input.docType, "Source document type", MAX_DOC_TYPE_CHARS);
  requireOptionalBoundedUtf8(input.uri, "Source URI", MAX_URI_BYTES);
  await client.query(
    `UPDATE kith.source_items
        SET title = $1, doc_type = $2, uri = $3, lifecycle = 'available', original_link_available = $4
      WHERE id = $5`,
    [input.title ?? null, input.docType ?? null, input.uri ?? null, input.uri !== undefined, item.id],
  );
}

export async function createOrGetTextVersion(
  client: ClientBase,
  input: SourceTextVersionInput,
): Promise<SourceTextVersionRow> {
  const revision = await requireSourceRevision(client, input.sourceRevisionId, input.spaceId);
  requireInlineSourceRevision(revision as SourceRevisionShape);
  const byteLength = requireBoundedUtf8(
    input.text,
    "Extracted source text",
    MAX_SOURCE_INLINE_UTF8_BYTES,
    true,
  );
  const textHash = await sha256Utf8(input.text);
  const matches = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_text_versions
      WHERE source_revision_id = $1 AND extraction_fingerprint = $2 LIMIT 2`,
    [input.sourceRevisionId, input.extractionFingerprint],
  );
  if (matches.rowCount! > 1) throw new Error("Source text version identity is not unique");
  const existing = matches.rows[0] && camelizeSourceTextVersion(matches.rows[0]);
  if (existing) {
    let isInlineText = false;
    try {
      isInlineText =
        parseSourceTextRepresentation(existing as SourceTextVersionShape).kind ===
        "inline_text_v1";
    } catch {
      // The immutable conflict below intentionally hides corrupt row details.
    }
    if (
      !isInlineText ||
      existing.spaceId !== input.spaceId ||
      existing.text !== input.text ||
      existing.textHash !== textHash ||
      existing.byteLength !== byteLength
    ) {
      throw new Error("Conflicting immutable source text version");
    }
    return existing;
  }
  const id = newKithId();
  const result = await client.query<QueryResultRow>(
    `INSERT INTO kith.source_text_versions
       (id, space_id, created_at, source_revision_id, extraction_fingerprint, text, text_hash, byte_length, evidence_sealed)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,false)
     RETURNING *`,
    [
      id,
      input.spaceId,
      input.sourceRevisionId,
      input.extractionFingerprint,
      input.text,
      textHash,
      byteLength,
    ],
  );
  return camelizeSourceTextVersion(result.rows[0]!);
}

export async function stagePages(
  client: ClientBase,
  input: { spaceId: string; sourceTextVersionId: string; pages: SourcePageInput[] },
): Promise<SourcePageRow[]> {
  requireBatchBounds(
    input.pages.length,
    input.pages.map((page) => page.text),
    MAX_SOURCE_PAGES,
    "Pages",
  );
  const textVersion = await requireTextVersion(client, input.sourceTextVersionId, input.spaceId);
  const inlineTextVersion = requireInlineSourceTextVersion(
    textVersion as SourceTextVersionShape,
  );
  const existingTotal = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.source_pages WHERE source_text_version_id = $1 LIMIT $2`,
      [input.sourceTextVersionId, MAX_SOURCE_PAGES + 1],
    )
  ).rows.map((row) => camelizeSourcePage(row));
  if (existingTotal.length > MAX_SOURCE_PAGES) {
    throw new Error(`Source text version exceeds ${MAX_SOURCE_PAGES} pages`);
  }
  const existingOrdinals = new Set(existingTotal.map((page) => page.ordinal));
  const newOrdinals = new Set<number>();
  const results: SourcePageRow[] = [];
  for (const page of input.pages) {
    requireIntegerInRange(page.ordinal, "Page ordinal", 0, MAX_SOURCE_PAGES - 1);
    if (newOrdinals.has(page.ordinal)) throw new Error("Page batch contains duplicate ordinals");
    newOrdinals.add(page.ordinal);
    requireUtf16Boundary(inlineTextVersion.text, page.start, "Page start");
    requireUtf16Boundary(inlineTextVersion.text, page.end, "Page end");
    if (page.end < page.start) throw new Error("Page end must be at or after page start");
    if (inlineTextVersion.text.slice(page.start, page.end) !== page.text) {
      throw new Error("Page text does not match its full-text UTF-16 range");
    }
    const textHash = await sha256Utf8(page.text);
    const matches = await client.query<QueryResultRow>(
      `SELECT * FROM kith.source_pages WHERE source_text_version_id = $1 AND ordinal = $2 LIMIT 2`,
      [input.sourceTextVersionId, page.ordinal],
    );
    if (matches.rowCount! > 1) throw new Error("Source page identity is not unique");
    const existing = matches.rows[0] && camelizeSourcePage(matches.rows[0]);
    if (existing) {
      if (
        existing.spaceId !== input.spaceId ||
        existing.start !== page.start ||
        existing.end !== page.end ||
        existing.text !== page.text ||
        existing.textHash !== textHash
      ) {
        throw new Error("Conflicting immutable source page");
      }
      results.push(existing);
      continue;
    }
    if (textVersion.evidenceSealed) {
      throw new Error(
        "Published source text evidence is sealed; use a new extraction fingerprint",
      );
    }
    if (!existingOrdinals.has(page.ordinal) && existingOrdinals.size >= MAX_SOURCE_PAGES) {
      throw new Error(`Source text version exceeds ${MAX_SOURCE_PAGES} pages`);
    }
    existingOrdinals.add(page.ordinal);
    const id = newKithId();
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.source_pages
         (id, space_id, created_at, source_text_version_id, ordinal, "start", "end", text, text_hash)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        id,
        input.spaceId,
        input.sourceTextVersionId,
        page.ordinal,
        page.start,
        page.end,
        page.text,
        textHash,
      ],
    );
    results.push(camelizeSourcePage(result.rows[0]!));
  }
  return results;
}

export async function stageEvidenceSpans(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceRevisionId: string;
    sourceTextVersionId: string;
    spans: EvidenceSpanInput[];
  },
): Promise<EvidenceSpanRow[]> {
  requireBatchBounds(input.spans.length, [], MAX_EVIDENCE_SPANS, "Evidence spans");
  // Sequential, not Promise.all: a single pg client serializes queries over
  // one connection, so concurrent awaits on it only add a deprecation
  // warning, never real parallelism.
  const revision = await requireSourceRevision(client, input.sourceRevisionId, input.spaceId);
  const textVersion = await requireTextVersion(client, input.sourceTextVersionId, input.spaceId);
  if (textVersion.sourceRevisionId !== revision.id) {
    throw new Error("Source text version does not belong to the source revision");
  }
  const existingTotal = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.evidence_spans WHERE source_text_version_id = $1 LIMIT $2`,
      [input.sourceTextVersionId, MAX_EVIDENCE_SPANS + 1],
    )
  ).rows.map((row) => camelizeEvidenceSpan(row));
  if (existingTotal.length > MAX_EVIDENCE_SPANS) {
    throw new Error(`Source text version exceeds ${MAX_EVIDENCE_SPANS} evidence spans`);
  }
  const newIdentities = new Set<string>();
  let total = existingTotal.length;
  const results: EvidenceSpanRow[] = [];
  for (const span of input.spans) {
    const page = await getRow(client, "source_pages", span.sourcePageId, camelizeSourcePage);
    if (!page) throw new Error("Evidence source page does not exist");
    if (page.spaceId !== input.spaceId || page.sourceTextVersionId !== textVersion.id) {
      throw new Error("Evidence source page belongs to another parent chain");
    }
    requireIntegerInRange(span.ordinal, "Evidence span ordinal", 0, MAX_EVIDENCE_SPANS - 1);
    const identity = `${span.sourcePageId}:${span.ordinal}`;
    if (newIdentities.has(identity)) throw new Error("Evidence batch contains duplicate identities");
    newIdentities.add(identity);
    requireUtf16Boundary(page.text, span.start, "Evidence span start");
    requireUtf16Boundary(page.text, span.end, "Evidence span end");
    if (span.end <= span.start) {
      throw new Error("Evidence span must contain at least one UTF-16 code unit");
    }
    requireLocator(span.locator);
    const quoteHash = await sha256Utf8(page.text.slice(span.start, span.end));
    const matches = await client.query<QueryResultRow>(
      `SELECT * FROM kith.evidence_spans WHERE source_page_id = $1 AND ordinal = $2 LIMIT 2`,
      [span.sourcePageId, span.ordinal],
    );
    if (matches.rowCount! > 1) throw new Error("Evidence span identity is not unique");
    const existing = matches.rows[0] && camelizeEvidenceSpan(matches.rows[0]);
    if (existing) {
      if (
        existing.spaceId !== input.spaceId ||
        existing.sourceRevisionId !== revision.id ||
        existing.sourceTextVersionId !== textVersion.id ||
        existing.start !== span.start ||
        existing.end !== span.end ||
        existing.quoteHash !== quoteHash ||
        !sameLocator(existing.locator, span.locator)
      ) {
        throw new Error("Conflicting immutable evidence span");
      }
      results.push(existing);
      continue;
    }
    if (textVersion.evidenceSealed) {
      throw new Error(
        "Published source text evidence is sealed; use a new extraction fingerprint",
      );
    }
    if (total >= MAX_EVIDENCE_SPANS) {
      throw new Error(`Source text version exceeds ${MAX_EVIDENCE_SPANS} evidence spans`);
    }
    total += 1;
    const id = newKithId();
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.evidence_spans
         (id, space_id, created_at, source_revision_id, source_text_version_id, source_page_id, ordinal,
          "start", "end", quote_hash, locator)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        id,
        input.spaceId,
        revision.id,
        textVersion.id,
        page.id,
        span.ordinal,
        span.start,
        span.end,
        quoteHash,
        span.locator ? JSON.stringify(span.locator) : null,
      ],
    );
    results.push(camelizeEvidenceSpan(result.rows[0]!));
  }
  return results;
}

/** Where a card field says its value came from, ported from model.ts. */
export type CardEvidenceRef =
  | { pageOrdinal: number; start: number; end: number }
  | { pageOrdinal: number; quote: string }
  | { pageOrdinal: number; cell: { sheet: string; row: number; column: number } };

const CARD_QUOTE_FOLD: Readonly<Record<string, string>> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "´": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "″": '"',
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
};

const CARD_QUOTE_SPACE = /\s/;

type FoldedText = { text: string; starts: number[]; ends: number[] };

function foldCardQuoteText(text: string): FoldedText {
  const units: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  while (at < text.length) {
    const unit = text[at]!;
    if (CARD_QUOTE_SPACE.test(unit)) {
      let run = at;
      while (run < text.length && CARD_QUOTE_SPACE.test(text[run]!)) run += 1;
      units.push(" ");
      starts.push(at);
      ends.push(run);
      at = run;
      continue;
    }
    units.push(CARD_QUOTE_FOLD[unit] ?? unit);
    starts.push(at);
    ends.push(at + 1);
    at += 1;
  }
  return { text: units.join(""), starts, ends };
}

function lowerCardQuoteText(text: string): string {
  let out = "";
  for (const unit of text) {
    const lower = unit.toLowerCase();
    out += lower.length === unit.length ? lower : unit;
  }
  return out;
}

function foldedQuote(quote: string): string {
  return lowerCardQuoteText(foldCardQuoteText(quote).text.trim());
}

function locateUnique(
  haystack: string,
  page: FoldedText,
  needle: string,
): { start: number; end: number } | null {
  if (!needle) return null;
  const at = haystack.indexOf(needle);
  if (at < 0 || haystack.lastIndexOf(needle) !== at) return null;
  return { start: page.starts[at]!, end: page.ends[at + needle.length - 1]! };
}

/** Ported from model.ts (P2-81): exact match first, then a fold of
 * whitespace/quote/dash shape and finally case. */
export function locateCardQuote(
  pageText: string,
  quote: string,
): { start: number; end: number; mode: "exact" | "normalized" } | null {
  const exact = pageText.indexOf(quote);
  if (quote.length > 0 && exact >= 0 && pageText.lastIndexOf(quote) === exact) {
    return { start: exact, end: exact + quote.length, mode: "exact" };
  }
  const page = foldCardQuoteText(pageText);
  const needle = foldCardQuoteText(quote).text.trim();
  const folded =
    locateUnique(page.text, page, needle) ??
    locateUnique(lowerCardQuoteText(page.text), page, lowerCardQuoteText(needle));
  return folded ? { ...folded, mode: "normalized" } : null;
}

/** Resolves a spreadsheet cell reference to a UTF-16 range on its rendered
 * page. Ported minimally from @repo/worker-protocol's sheet rendering
 * convention: line 0 names the sheet, and each following line is one row of
 * tab-separated cells -- the same rule stageCardEvidenceSpans's caller (the
 * card runner) renders pages under. */
function resolveSheetCell(
  pageText: string,
  cell: { sheet: string; row: number; column: number },
): { start: number; end: number } | null {
  const lines = pageText.split("\n");
  if (lines.length === 0 || lines[0] !== cell.sheet) return null;
  const line = lines[cell.row + 1];
  if (line === undefined) return null;
  const cells = line.split("\t");
  const value = cells[cell.column];
  if (value === undefined || value.length === 0) return null;
  let offset = lines.slice(0, cell.row + 1).reduce((sum, l) => sum + l.length + 1, 0);
  offset += cells.slice(0, cell.column).reduce((sum, c) => sum + c.length + 1, 0);
  return { start: offset, end: offset + value.length };
}

export const MAX_CARD_EVIDENCE_CITATIONS = 16;
export const MAX_SWEEP_GENERATIONS = 256;

/**
 * Stages the evidence spans a card generation cites, over a sealed text
 * version. Ported from model.ts: this never writes a page, never writes a
 * text version, never clears `evidenceSealed`, and never widens a range it
 * was given. An existing span covering exactly the same range is reused
 * (whether the parser staged it or an earlier card version did), and a ref
 * that fails to resolve becomes `null` rather than throwing -- the runner
 * that produced it is untrusted, so a bad citation is an ordinary outcome.
 */
export async function stageCardEvidenceSpans(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceRevisionId: string;
    sourceTextVersionId: string;
    cardExtractionFingerprint: string;
    refs: readonly CardEvidenceRef[];
  },
): Promise<Array<string | null>> {
  if (input.refs.length > MAX_EVIDENCE_SPANS) {
    throw new Error(`Card evidence exceeds ${MAX_EVIDENCE_SPANS} spans`);
  }
  if (!input.cardExtractionFingerprint.trim()) {
    throw new Error("Card evidence requires an extraction fingerprint");
  }
  const revision = await requireSourceRevision(client, input.sourceRevisionId, input.spaceId);
  const textVersion = await requireTextVersion(client, input.sourceTextVersionId, input.spaceId);
  if (textVersion.sourceRevisionId !== revision.id) {
    throw new Error("Source text version does not belong to the source revision");
  }
  const existing = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.evidence_spans WHERE source_text_version_id = $1 LIMIT $2`,
      [input.sourceTextVersionId, MAX_EVIDENCE_SPANS + 1],
    )
  ).rows.map((row) => camelizeEvidenceSpan(row));
  if (existing.length > MAX_EVIDENCE_SPANS) {
    throw new Error(`Source text version exceeds ${MAX_EVIDENCE_SPANS} evidence spans`);
  }
  const spans = [...existing];
  const pages = new Map<number, SourcePageRow>();
  const results: Array<string | null> = [];

  for (const ref of input.refs) {
    let page = pages.get(ref.pageOrdinal);
    if (!page) {
      const found = (
        await client.query<QueryResultRow>(
          `SELECT * FROM kith.source_pages WHERE source_text_version_id = $1 AND ordinal = $2 LIMIT 2`,
          [input.sourceTextVersionId, ref.pageOrdinal],
        )
      ).rows.map((row) => camelizeSourcePage(row));
      if (found.length > 1) throw new Error("Source page identity is unclear");
      page = found[0];
      if (page) pages.set(ref.pageOrdinal, page);
    }
    if (!page || page.spaceId !== input.spaceId) {
      results.push(null);
      continue;
    }
    let start: number;
    let end: number;
    let locator: EvidenceLocator | undefined;
    if ("quote" in ref) {
      const located = locateCardQuote(page.text, ref.quote);
      if (!located) {
        results.push(null);
        continue;
      }
      start = located.start;
      end = located.end;
    } else if ("cell" in ref) {
      const range = resolveSheetCell(page.text, ref.cell);
      if (!range) {
        results.push(null);
        continue;
      }
      start = range.start;
      end = range.end;
      locator = { kind: "cell_v1", sheet: ref.cell.sheet, row: ref.cell.row, column: ref.cell.column };
      try {
        requireLocator(locator);
      } catch {
        results.push(null);
        continue;
      }
    } else {
      start = ref.start;
      end = ref.end;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > page.text.length
    ) {
      results.push(null);
      continue;
    }
    try {
      requireUtf16Boundary(page.text, start, "Card evidence span start");
      requireUtf16Boundary(page.text, end, "Card evidence span end");
    } catch {
      results.push(null);
      continue;
    }
    const quote = page.text.slice(start, end);
    if ("quote" in ref && foldedQuote(quote) !== foldedQuote(ref.quote)) {
      results.push(null);
      continue;
    }
    const reused = spans.find(
      (span) => span.sourcePageId === page!.id && span.start === start && span.end === end,
    );
    if (reused) {
      const cited = reused.cardExtractionFingerprints;
      if (
        cited &&
        cited.length < MAX_CARD_EVIDENCE_CITATIONS &&
        !cited.includes(input.cardExtractionFingerprint)
      ) {
        const next = [...cited, input.cardExtractionFingerprint];
        await client.query(
          `UPDATE kith.evidence_spans SET card_extraction_fingerprints = $1 WHERE id = $2`,
          [JSON.stringify(next), reused.id],
        );
        reused.cardExtractionFingerprints = next;
      }
      results.push(reused.id);
      continue;
    }
    if (spans.length >= MAX_EVIDENCE_SPANS) {
      results.push(null);
      continue;
    }
    const pageOrdinals = new Set(
      spans.filter((span) => span.sourcePageId === page.id).map((span) => span.ordinal),
    );
    let ordinal = 0;
    while (pageOrdinals.has(ordinal)) ordinal += 1;
    if (ordinal >= MAX_EVIDENCE_SPANS) {
      results.push(null);
      continue;
    }
    const id = newKithId();
    const quoteHash = await sha256Utf8(quote);
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.evidence_spans
         (id, space_id, created_at, source_revision_id, source_text_version_id, source_page_id, ordinal,
          "start", "end", quote_hash, locator, card_extraction_fingerprints)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        id,
        input.spaceId,
        revision.id,
        textVersion.id,
        page.id,
        ordinal,
        start,
        end,
        quoteHash,
        locator ? JSON.stringify(locator) : null,
        JSON.stringify([input.cardExtractionFingerprint]),
      ],
    );
    const row = camelizeEvidenceSpan(result.rows[0]!);
    spans.push(row);
    results.push(id);
  }
  return results;
}

/**
 * Deletes the card-staged spans of one item's text version that no
 * surviving card generation can reach. Ported from model.ts.
 */
export async function sweepCardEvidenceSpans(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string; sourceTextVersionId: string },
): Promise<number> {
  const generations = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.processing_generations WHERE source_item_id = $1 LIMIT $2`,
      [input.sourceItemId, MAX_SWEEP_GENERATIONS + 1],
    )
  ).rows.map((row) => camelizeProcessingGeneration(row));
  if (generations.length > MAX_SWEEP_GENERATIONS) return 0;
  const reachable = new Set(
    generations
      .filter((row) => row.cardGeneration === true)
      .map((row) => row.recordSchemaFingerprint)
      .filter((fingerprint): fingerprint is string => fingerprint !== null),
  );
  const spans = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.evidence_spans WHERE source_text_version_id = $1 LIMIT $2`,
      [input.sourceTextVersionId, MAX_EVIDENCE_SPANS + 1],
    )
  ).rows.map((row) => camelizeEvidenceSpan(row));
  let deleted = 0;
  for (const span of spans) {
    const cited = span.cardExtractionFingerprints;
    if (cited === null || cited === undefined) continue;
    if (span.spaceId !== input.spaceId) continue;
    // ponytail: a citation list at its cap is treated as pinned and never
    // swept, matching model.ts's own documented tradeoff there.
    if (cited.length >= MAX_CARD_EVIDENCE_CITATIONS) continue;
    if (cited.some((fingerprint) => reachable.has(fingerprint))) continue;
    await client.query(`DELETE FROM kith.evidence_spans WHERE id = $1`, [span.id]);
    deleted += 1;
  }
  return deleted;
}

export async function stageDocuments(
  client: ClientBase,
  input: {
    spaceId: string;
    processingGenerationId: string;
    sourceItemId: string;
    sourceRevisionId: string;
    sourceTextVersionId: string;
    documents: DocumentInput[];
  },
): Promise<DocumentRow[]> {
  requireBatchBounds(
    input.documents.length,
    input.documents.map((doc) => doc.title),
    MAX_GENERATION_DOCUMENTS,
    "Documents",
  );
  const generation = await requireGeneration(client, input.processingGenerationId, input.spaceId);
  const item = await requireSourceItem(client, input.sourceItemId, input.spaceId);
  const revision = await requireSourceRevision(client, input.sourceRevisionId, input.spaceId);
  const textVersion = await requireTextVersion(client, input.sourceTextVersionId, input.spaceId);
  if (
    revision.sourceItemId !== item.id ||
    textVersion.sourceRevisionId !== revision.id ||
    generation.sourceItemId !== item.id ||
    generation.sourceAccountId !== item.sourceAccountId ||
    generation.sourceRevisionId !== revision.id ||
    generation.sourceTextVersionId !== textVersion.id
  ) {
    throw new Error("Document parent chain does not match its processing generation");
  }
  const existingTotal = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.documents WHERE processing_generation_id = $1 LIMIT $2`,
      [generation.id, MAX_GENERATION_DOCUMENTS + 1],
    )
  ).rows.map((row) => camelizeDocument(row));
  if (existingTotal.length > MAX_GENERATION_DOCUMENTS) {
    throw new Error(`Processing generation exceeds ${MAX_GENERATION_DOCUMENTS} documents`);
  }
  const existingKeys = new Set(existingTotal.map((doc) => doc.documentKey));
  const newKeys = new Set<string>();
  const results: DocumentRow[] = [];
  for (const document of input.documents) {
    requireBoundedUtf8(document.documentKey, "Document key", MAX_DOCUMENT_KEY_BYTES);
    requireBoundedString(document.title, "Document title", MAX_TITLE_CHARS);
    requireBoundedString(document.docType, "Document type", MAX_DOC_TYPE_CHARS);
    requireUniqueIds(document.evidenceSpanIds, "Document evidence span IDs", MAX_EVIDENCE_SPANS);
    if (newKeys.has(document.documentKey)) throw new Error("Document batch contains duplicate keys");
    newKeys.add(document.documentKey);
    for (const spanId of document.evidenceSpanIds) {
      const span = await getRow(client, "evidence_spans", spanId, camelizeEvidenceSpan);
      if (
        !span ||
        span.spaceId !== input.spaceId ||
        span.sourceRevisionId !== revision.id ||
        span.sourceTextVersionId !== textVersion.id
      ) {
        throw new Error("Document evidence span belongs to another parent chain");
      }
    }
    const matches = (
      await client.query<QueryResultRow>(
        `SELECT * FROM kith.documents WHERE processing_generation_id = $1 AND document_key = $2 LIMIT 2`,
        [generation.id, document.documentKey],
      )
    ).rows.map((row) => camelizeDocument(row));
    if (matches.length > 1) throw new Error("Document identity is not unique");
    const existing = matches[0];
    if (existing) {
      if (
        existing.spaceId !== input.spaceId ||
        existing.sourceItemId !== item.id ||
        existing.sourceRevisionId !== revision.id ||
        existing.sourceTextVersionId !== textVersion.id ||
        existing.title !== document.title ||
        existing.docType !== document.docType ||
        existing.capturedAt.getTime() !== document.capturedAt.getTime() ||
        !sameIds(existing.evidenceSpanIds, document.evidenceSpanIds)
      ) {
        throw new Error("Conflicting immutable document");
      }
      results.push(existing);
      continue;
    }
    if (!existingKeys.has(document.documentKey) && existingKeys.size >= MAX_GENERATION_DOCUMENTS) {
      throw new Error(`Processing generation exceeds ${MAX_GENERATION_DOCUMENTS} documents`);
    }
    existingKeys.add(document.documentKey);
    const id = newKithId();
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.documents
         (id, space_id, created_at, processing_generation_id, source_item_id, source_revision_id,
          source_text_version_id, document_key, title, doc_type, captured_at, evidence_span_ids,
          publication_state)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,'staged')
       RETURNING *`,
      [
        id,
        input.spaceId,
        generation.id,
        item.id,
        revision.id,
        textVersion.id,
        document.documentKey,
        document.title,
        document.docType,
        document.capturedAt,
        JSON.stringify(document.evidenceSpanIds),
      ],
    );
    results.push(camelizeDocument(result.rows[0]!));
  }
  return results;
}

export async function stageChunks(
  client: ClientBase,
  input: { spaceId: string; processingGenerationId: string; chunks: ChunkInput[] },
): Promise<ChunkRow[]> {
  requireBatchBounds(
    input.chunks.length,
    input.chunks.map((chunk) => chunk.text),
    MAX_GENERATION_CHUNKS,
    "Chunks",
  );
  const generation = await requireGeneration(client, input.processingGenerationId, input.spaceId);
  const existingTotal = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.chunks WHERE processing_generation_id = $1 LIMIT $2`,
      [generation.id, MAX_GENERATION_CHUNKS + 1],
    )
  ).rows.map((row) => camelizeChunk(row));
  if (existingTotal.length > MAX_GENERATION_CHUNKS) {
    throw new Error(`Processing generation exceeds ${MAX_GENERATION_CHUNKS} chunks`);
  }
  let total = existingTotal.length;
  let totalTextBytes = existingTotal.reduce((bytes, chunk) => bytes + utf8Length(chunk.text), 0);
  if (totalTextBytes > MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES) {
    throw new Error(`Processing generation exceeds ${MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES} chunk text bytes`);
  }
  const newIdentities = new Set<string>();
  const evidenceById = new Map<string, EvidenceSpanRow>();
  const results: ChunkRow[] = [];
  for (const chunk of input.chunks) {
    requireIntegerInRange(chunk.ordinal, "Chunk ordinal", 0, MAX_GENERATION_CHUNKS - 1);
    const chunkTextBytes = requireBoundedUtf8(chunk.text, "Chunk text", MAX_CHUNK_TEXT_UTF8_BYTES);
    requireUniqueIds(chunk.evidenceSpanIds, "Chunk evidence span IDs", MAX_EVIDENCE_SPANS);
    const identity = `${chunk.documentId}:${chunk.ordinal}`;
    if (newIdentities.has(identity)) throw new Error("Chunk batch contains duplicate identities");
    newIdentities.add(identity);
    const document = await getRow(client, "documents", chunk.documentId, camelizeDocument);
    if (!document || document.spaceId !== input.spaceId || document.processingGenerationId !== generation.id) {
      throw new Error("Chunk document belongs to another generation or space");
    }
    const documentEvidence = new Set<string>(document.evidenceSpanIds);
    for (const spanId of chunk.evidenceSpanIds) {
      if (!documentEvidence.has(spanId)) {
        throw new Error("Chunk evidence must be included in its document evidence");
      }
      let span = evidenceById.get(spanId);
      if (!span) {
        span = await getRow(client, "evidence_spans", spanId, camelizeEvidenceSpan);
        if (span) evidenceById.set(spanId, span);
      }
      if (!span || span.spaceId !== input.spaceId) {
        throw new Error("Chunk evidence span belongs to another space");
      }
    }
    const matches = (
      await client.query<QueryResultRow>(
        `SELECT * FROM kith.chunks WHERE document_id = $1 AND ordinal = $2 LIMIT 2`,
        [document.id, chunk.ordinal],
      )
    ).rows.map((row) => camelizeChunk(row));
    if (matches.length > 1) throw new Error("Chunk identity is not unique");
    const existing = matches[0];
    if (existing) {
      if (
        existing.spaceId !== input.spaceId ||
        existing.processingGenerationId !== generation.id ||
        existing.text !== chunk.text ||
        !sameIds(existing.evidenceSpanIds, chunk.evidenceSpanIds)
      ) {
        throw new Error("Conflicting immutable chunk");
      }
      results.push(existing);
      continue;
    }
    if (total >= MAX_GENERATION_CHUNKS) {
      throw new Error(`Processing generation exceeds ${MAX_GENERATION_CHUNKS} chunks`);
    }
    if (totalTextBytes + chunkTextBytes > MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES) {
      throw new Error(`Processing generation exceeds ${MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES} chunk text bytes`);
    }
    total += 1;
    totalTextBytes += chunkTextBytes;
    const id = newKithId();
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.chunks
         (id, space_id, created_at, processing_generation_id, document_id, ordinal, text, evidence_span_ids,
          publication_state)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,'staged')
       RETURNING *`,
      [
        id,
        input.spaceId,
        generation.id,
        document.id,
        chunk.ordinal,
        chunk.text,
        JSON.stringify(chunk.evidenceSpanIds),
      ],
    );
    results.push(camelizeChunk(result.rows[0]!));
  }
  return results;
}

export async function setDesiredSourceRevision(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceItemId: string;
    desiredRevisionId: string;
    expectedDesiredProcessingEpoch: number;
  },
): Promise<number> {
  const item = await requireSourceItem(client, input.sourceItemId, input.spaceId);
  const revision = await requireSourceRevision(client, input.desiredRevisionId, input.spaceId);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  if (revision.sourceItemId !== item.id) {
    throw new Error("Desired revision belongs to another source item");
  }
  requireIntegerInRange(
    input.expectedDesiredProcessingEpoch,
    "Expected desired processing epoch",
    0,
    Number.MAX_SAFE_INTEGER - 1,
  );
  if (item.desiredProcessingEpoch !== input.expectedDesiredProcessingEpoch) {
    throw new Error("Source item desired processing epoch conflict");
  }
  const desiredProcessingEpoch = input.expectedDesiredProcessingEpoch + 1;
  await client.query(
    `UPDATE kith.source_items
        SET desired_revision_id = $1, desired_processing_epoch = $2, lifecycle = 'available', last_failure = NULL
      WHERE id = $3`,
    [revision.id, desiredProcessingEpoch, item.id],
  );
  return desiredProcessingEpoch;
}

export async function activateSourceItemGeneration(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceItemId: string;
    sourceRevisionId: string;
    processingGenerationId: string;
    expectedPreviousGenerationId?: string;
    expectedDesiredProcessingEpoch: number;
  },
): Promise<{ previousGenerationId?: string }> {
  const item = await requireSourceItem(client, input.sourceItemId, input.spaceId);
  const revision = await requireSourceRevision(client, input.sourceRevisionId, input.spaceId);
  const generation = await requireGeneration(client, input.processingGenerationId, input.spaceId);
  if (item.lifecycle !== "available") throw new Error("Only available source items can activate");
  if ((item.activeGenerationId ?? undefined) !== input.expectedPreviousGenerationId) {
    throw new Error("Source item active generation changed before activation");
  }
  if (
    item.desiredProcessingEpoch !== input.expectedDesiredProcessingEpoch ||
    item.desiredRevisionId !== revision.id
  ) {
    throw new Error("Processing generation is obsolete for the source item");
  }
  if (
    revision.sourceItemId !== item.id ||
    generation.sourceItemId !== item.id ||
    generation.sourceAccountId !== item.sourceAccountId ||
    generation.sourceRevisionId !== revision.id ||
    generation.desiredProcessingEpoch !== input.expectedDesiredProcessingEpoch
  ) {
    throw new Error("Active generation parent chain or epoch does not match");
  }
  if (!generation.sourceTextVersionId) {
    throw new Error("Active generation must have a source text version");
  }
  const generationTextVersion = await requireTextVersion(
    client,
    generation.sourceTextVersionId,
    input.spaceId,
  );
  if (generationTextVersion.sourceRevisionId !== revision.id) {
    throw new Error("Active generation text version belongs to another revision");
  }
  const nextDocuments = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.documents WHERE processing_generation_id = $1 LIMIT $2`,
      [generation.id, MAX_GENERATION_DOCUMENTS + 1],
    )
  ).rows.map((row) => camelizeDocument(row));
  const nextChunks = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.chunks WHERE processing_generation_id = $1 LIMIT $2`,
      [generation.id, MAX_PARSED_GENERATION_CHUNKS + 1],
    )
  ).rows.map((row) => camelizeChunk(row));
  if (
    nextDocuments.length > MAX_GENERATION_DOCUMENTS ||
    nextChunks.length > MAX_PARSED_GENERATION_CHUNKS
  ) {
    throw new Error("Generation payload exceeds activation bounds");
  }
  if (
    nextDocuments.some((row) => row.spaceId !== input.spaceId || row.processingGenerationId !== generation.id) ||
    nextChunks.some((row) => row.spaceId !== input.spaceId || row.processingGenerationId !== generation.id)
  ) {
    throw new Error("Generation payload has invalid parents");
  }
  const nextChunkTextBytes = nextChunks.reduce((bytes, chunk) => bytes + utf8Length(chunk.text), 0);
  const chunkTextLimit = generation.parserArtifactId
    ? MAX_PARSED_GENERATION_CHUNK_TEXT_UTF8_BYTES
    : MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES;
  if (nextChunkTextBytes > chunkTextLimit) {
    throw new Error(`Generation exceeds ${chunkTextLimit} chunk text bytes`);
  }
  const previousGenerationId = item.activeGenerationId ?? undefined;
  if (previousGenerationId && previousGenerationId !== generation.id) {
    const previousGeneration = await requireGeneration(client, previousGenerationId, input.spaceId);
    if (previousGeneration.sourceItemId !== item.id) {
      throw new Error("Previous active generation belongs to another source item");
    }
    const previousChunkLimit = previousGeneration.parserArtifactId
      ? MAX_PARSED_GENERATION_CHUNKS
      : MAX_GENERATION_CHUNKS;
    const previousChunkTextLimit = previousGeneration.parserArtifactId
      ? MAX_PARSED_GENERATION_CHUNK_TEXT_UTF8_BYTES
      : MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES;
    const previousDocuments = (
      await client.query<QueryResultRow>(
        `SELECT * FROM kith.documents WHERE processing_generation_id = $1 LIMIT $2`,
        [previousGenerationId, MAX_GENERATION_DOCUMENTS + 1],
      )
    ).rows.map((row) => camelizeDocument(row));
    const previousChunks = (
      await client.query<QueryResultRow>(
        `SELECT * FROM kith.chunks WHERE processing_generation_id = $1 LIMIT $2`,
        [previousGenerationId, previousChunkLimit + 1],
      )
    ).rows.map((row) => camelizeChunk(row));
    if (
      previousDocuments.length > MAX_GENERATION_DOCUMENTS ||
      previousChunks.length > previousChunkLimit
    ) {
      throw new Error("Previous generation payload exceeds activation bounds");
    }
    const previousChunkTextBytes = previousChunks.reduce(
      (bytes, chunk) => bytes + utf8Length(chunk.text),
      0,
    );
    if (previousChunkTextBytes > previousChunkTextLimit) {
      throw new Error(`Previous generation exceeds ${previousChunkTextLimit} chunk text bytes`);
    }
    for (const document of previousDocuments) {
      await client.query(`UPDATE kith.documents SET publication_state = 'historical' WHERE id = $1`, [document.id]);
    }
    for (const chunk of previousChunks) {
      await client.query(`UPDATE kith.chunks SET publication_state = 'historical' WHERE id = $1`, [chunk.id]);
    }
  }
  for (const document of nextDocuments) {
    if (document.publicationState === "historical") {
      throw new Error("A historical generation cannot be reactivated");
    }
    await client.query(`UPDATE kith.documents SET publication_state = 'active' WHERE id = $1`, [document.id]);
  }
  for (const chunk of nextChunks) {
    if (chunk.publicationState === "historical") {
      throw new Error("A historical generation cannot be reactivated");
    }
    await client.query(`UPDATE kith.chunks SET publication_state = 'active' WHERE id = $1`, [chunk.id]);
  }
  if (!generationTextVersion.evidenceSealed) {
    await client.query(`UPDATE kith.source_text_versions SET evidence_sealed = true WHERE id = $1`, [
      generationTextVersion.id,
    ]);
  }
  await client.query(
    `UPDATE kith.source_items
        SET active_revision_id = $1, active_generation_id = $2, last_failure = NULL
      WHERE id = $3`,
    [revision.id, generation.id, item.id],
  );
  return { previousGenerationId };
}

export async function markSourceItemUnavailable(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string },
): Promise<void> {
  const item = await requireSourceItem(client, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  await client.query(
    `UPDATE kith.source_items SET lifecycle = 'unavailable', original_link_available = false WHERE id = $1`,
    [item.id],
  );
}

/**
 * Ported from model.ts. `invalidateRecordQueriesForForget` is not called
 * here: it lives in the excluded records domain (models/records, row f),
 * so a caller that also owns record query sessions must invalidate them
 * itself before or after calling this, in the same transaction.
 */
export async function beginSourceItemForget(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string; forgottenAt: Date; forgottenBy: string },
): Promise<number> {
  const item = await requireSourceItem(client, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgotten" || item.lifecycle === "forgetting") {
    return item.desiredProcessingEpoch;
  }
  if (item.desiredProcessingEpoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Source item processing epoch is exhausted");
  }
  const desiredProcessingEpoch = item.desiredProcessingEpoch + 1;
  await client.query(
    `UPDATE kith.source_items
        SET lifecycle = 'forgetting', original_link_available = false, desired_revision_id = NULL,
            desired_processing_epoch = $1, active_revision_id = NULL, active_generation_id = NULL,
            active_card_generation_id = NULL, last_failure = NULL, forgotten_at = $2, forgotten_by = $3,
            archive_deletion_forget_epoch = $1, archive_deletion_receipt_count = 0,
            archive_deletion_completed_at = NULL
      WHERE id = $4`,
    [desiredProcessingEpoch, input.forgottenAt, input.forgottenBy, item.id],
  );
  return desiredProcessingEpoch;
}

export async function setSourceItemFailure(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string; code: string; message: string; at: Date },
): Promise<void> {
  const item = await requireSourceItem(client, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  requireBoundedString(input.code, "Failure code", 100);
  requireBoundedString(input.message, "Failure message", 2_000);
  await client.query(`UPDATE kith.source_items SET last_failure = $1 WHERE id = $2`, [
    JSON.stringify({ code: input.code, message: input.message, at: input.at.getTime() }),
    item.id,
  ]);
}

export async function inspectGenerationPayload(
  client: ClientBase,
  input: {
    spaceId: string;
    processingGenerationId: string;
    sourceTextVersionId: string;
    expectedPublicationState?: "staged" | "active" | "historical";
  },
): Promise<GenerationPayloadSummary> {
  const generation = await requireGeneration(client, input.processingGenerationId, input.spaceId);
  const textVersion = await requireTextVersion(client, input.sourceTextVersionId, input.spaceId);
  if (generation.sourceTextVersionId !== textVersion.id) {
    throw new Error("Generation does not use the supplied source text version");
  }
  const revision = await requireSourceRevision(client, generation.sourceRevisionId, input.spaceId);
  const item = await requireSourceItem(client, generation.sourceItemId, input.spaceId);
  if (
    textVersion.sourceRevisionId !== revision.id ||
    revision.sourceItemId !== item.id ||
    generation.sourceAccountId !== item.sourceAccountId
  ) {
    throw new Error("Generation source parent chain is invalid");
  }
  const inlineRevision = requireInlineSourceRevision(revision as SourceRevisionShape);
  const inlineTextVersion = requireInlineSourceTextVersion(textVersion as SourceTextVersionShape);
  if (
    textVersion.byteLength !== utf8Length(inlineTextVersion.text) ||
    textVersion.textHash !== (await sha256Utf8(inlineTextVersion.text))
  ) {
    throw new Error("Source text version hash or byte length is invalid");
  }
  if (
    revision.byteLength !== utf8Length(inlineRevision.text) ||
    revision.contentHash !== (await sha256Utf8(inlineRevision.text))
  ) {
    throw new Error("Source revision hash or byte length is invalid");
  }
  const pages = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.source_pages WHERE source_text_version_id = $1 LIMIT $2`,
      [textVersion.id, MAX_SOURCE_PAGES + 1],
    )
  ).rows.map((row) => camelizeSourcePage(row));
  const spans = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.evidence_spans WHERE source_text_version_id = $1 LIMIT $2`,
      [textVersion.id, MAX_EVIDENCE_SPANS + 1],
    )
  ).rows.map((row) => camelizeEvidenceSpan(row));
  const documents = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.documents WHERE processing_generation_id = $1 LIMIT $2`,
      [generation.id, MAX_GENERATION_DOCUMENTS + 1],
    )
  ).rows.map((row) => camelizeDocument(row));
  const chunks = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.chunks WHERE processing_generation_id = $1 LIMIT $2`,
      [generation.id, MAX_GENERATION_CHUNKS + 1],
    )
  ).rows.map((row) => camelizeChunk(row));
  if (
    pages.length > MAX_SOURCE_PAGES ||
    spans.length > MAX_EVIDENCE_SPANS ||
    documents.length > MAX_GENERATION_DOCUMENTS ||
    chunks.length > MAX_GENERATION_CHUNKS
  ) {
    throw new Error("Generation payload exceeds configured bounds");
  }
  const generationChunkTextBytes = chunks.reduce((bytes, chunk) => bytes + utf8Length(chunk.text), 0);
  if (generationChunkTextBytes > MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES) {
    throw new Error(`Generation exceeds ${MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES} chunk text bytes`);
  }
  const orderedPages = [...pages].sort((a, b) => a.ordinal - b.ordinal);
  let expectedStart = 0;
  for (const [index, page] of orderedPages.entries()) {
    if (page.spaceId !== input.spaceId || page.sourceTextVersionId !== textVersion.id) {
      throw new Error("Generation page belongs to another parent chain");
    }
    if (page.ordinal !== index) {
      throw new Error("Generation page ordinals must be contiguous from zero");
    }
    requireUtf16Boundary(inlineTextVersion.text, page.start, "Page start");
    requireUtf16Boundary(inlineTextVersion.text, page.end, "Page end");
    if (page.end < page.start) throw new Error("Page end precedes page start");
    if (page.start !== expectedStart) {
      throw new Error("Generation pages do not contiguously cover extracted text");
    }
    if (inlineTextVersion.text.slice(page.start, page.end) !== page.text) {
      throw new Error("Generation page text does not match extracted text");
    }
    if (page.textHash !== (await sha256Utf8(page.text))) {
      throw new Error("Generation page text hash is invalid");
    }
    expectedStart = page.end;
  }
  if (expectedStart !== inlineTextVersion.text.length) {
    throw new Error("Generation pages do not completely cover extracted text");
  }
  const pageIds = new Set(pages.map((page) => page.id));
  const spanOrdinalsByPage = new Map<string, number[]>();
  for (const span of spans) {
    if (
      span.spaceId !== input.spaceId ||
      span.sourceRevisionId !== generation.sourceRevisionId ||
      span.sourceTextVersionId !== textVersion.id ||
      !pageIds.has(span.sourcePageId)
    ) {
      throw new Error("Generation contains evidence with an invalid parent chain");
    }
    const page = pages.find((p) => p.id === span.sourcePageId)!;
    requireUtf16Boundary(page.text, span.start, "Evidence span start");
    requireUtf16Boundary(page.text, span.end, "Evidence span end");
    if (span.end <= span.start) throw new Error("Generation evidence span is empty or reversed");
    if (span.quoteHash !== (await sha256Utf8(page.text.slice(span.start, span.end)))) {
      throw new Error("Generation evidence quote hash is invalid");
    }
    requireLocator(span.locator ?? undefined);
    const ordinals = spanOrdinalsByPage.get(span.sourcePageId) ?? [];
    ordinals.push(span.ordinal);
    spanOrdinalsByPage.set(span.sourcePageId, ordinals);
  }
  for (const ordinals of spanOrdinalsByPage.values()) {
    ordinals.sort((a, b) => a - b);
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      throw new Error("Generation evidence ordinals must be contiguous from zero per page");
    }
  }
  const spansById = new Map(spans.map((span) => [span.id, span]));
  const documentKeys = new Set<string>();
  for (const document of documents) {
    if (
      document.spaceId !== input.spaceId ||
      document.sourceItemId !== generation.sourceItemId ||
      document.sourceRevisionId !== generation.sourceRevisionId ||
      document.sourceTextVersionId !== textVersion.id
    ) {
      throw new Error("Generation contains a document with an invalid parent chain");
    }
    if (
      input.expectedPublicationState !== undefined &&
      document.publicationState !== input.expectedPublicationState
    ) {
      throw new Error("Document publication state does not match expectation");
    }
    requireUniqueIds(document.evidenceSpanIds, "Document evidence span IDs", MAX_EVIDENCE_SPANS);
    if (document.evidenceSpanIds.some((spanId) => !spansById.has(spanId))) {
      throw new Error("Document references evidence outside its text version");
    }
    if (documentKeys.has(document.documentKey)) throw new Error("Generation document keys must be unique");
    documentKeys.add(document.documentKey);
  }
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  for (const chunk of chunks) {
    if (chunk.spaceId !== input.spaceId || chunk.processingGenerationId !== generation.id || !documentsById.has(chunk.documentId)) {
      throw new Error("Generation contains a chunk with an invalid document parent");
    }
    if (
      input.expectedPublicationState !== undefined &&
      chunk.publicationState !== input.expectedPublicationState
    ) {
      throw new Error("Chunk publication state does not match expectation");
    }
    requireBoundedUtf8(chunk.text, "Chunk text", MAX_CHUNK_TEXT_UTF8_BYTES);
    requireUniqueIds(chunk.evidenceSpanIds, "Chunk evidence span IDs", MAX_EVIDENCE_SPANS);
    const document = documentsById.get(chunk.documentId)!;
    const documentEvidence = new Set<string>(document.evidenceSpanIds);
    if (chunk.evidenceSpanIds.some((spanId) => !documentEvidence.has(spanId) || !spansById.has(spanId))) {
      throw new Error("Chunk references evidence outside its document");
    }
  }
  const spansByPage = new Map<string, number[]>();
  for (const span of spans) {
    const ordinals = spansByPage.get(span.sourcePageId) ?? [];
    ordinals.push(span.ordinal);
    spansByPage.set(span.sourcePageId, ordinals);
  }
  const chunksByDocument = new Map<string, number[]>();
  for (const chunk of chunks) {
    const ordinals = chunksByDocument.get(chunk.documentId) ?? [];
    ordinals.push(chunk.ordinal);
    chunksByDocument.set(chunk.documentId, ordinals);
  }
  for (const ordinals of chunksByDocument.values()) {
    ordinals.sort((a, b) => a - b);
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      throw new Error("Generation chunk ordinals must be contiguous from zero per document");
    }
  }
  return {
    pageOrdinals: pages.map((page) => page.ordinal).sort((a, b) => a - b),
    evidenceSpanOrdinalsByPage: [...spansByPage].map(([sourcePageId, ordinals]) => ({
      sourcePageId,
      ordinals: ordinals.sort((a, b) => a - b),
    })),
    documentKeys: documents.map((document) => document.documentKey).sort(),
    chunkOrdinalsByDocument: [...chunksByDocument].map(([documentId, ordinals]) => ({
      documentId,
      ordinals: ordinals.sort((a, b) => a - b),
    })),
  };
}

export { ProofError };
