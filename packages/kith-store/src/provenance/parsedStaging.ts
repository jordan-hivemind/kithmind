// Ported from packages/convex/convex/models/provenance/parsedStaging.ts
// (P2-39d2): the parser's staging path over `kith.worker_parsed_stages`
// (row e's table, but this row's job per the task brief -- see the module
// header of `worker_parsed_stages` in migration 004), and the sealed-payload
// proof that later re-verifies a staged generation's parsed pages, evidence,
// documents and chunks against the manifest `sealParsedPayload` recorded.
//
// Two things this port deliberately does not carry over from the Convex
// original:
//
//   - `PayloadReadBudget`. It exists only to stay under Convex's own
//     per-transaction read budget (8 MiB / 1,024 documents / 1,024 point
//     reads -- see the now-deleted `models/ingestion/payloadBudget.ts`
//     import). Section 2.4 of the consolidation plan: "No platform limit,
//     but keep the existing page sizes." This port keeps every one of the
//     original's row-count ceilings (64 pages, 256 evidence spans, 16
//     documents, 256 chunks) as `LIMIT <max + 1>` overflow checks, exactly
//     as `model.ts` already does elsewhere in this package; it does not
//     replicate Convex's separate byte/read-count accounting, which had no
//     purpose beyond that platform ceiling.
//   - The `outerBudget` parameter `verifySealedParsedPayload` took so a
//     caller auditing many generations in one Convex transaction could
//     share one budget. With no such ceiling to share, this port's
//     `verifySealedParsedPayload` always owns its own reads.
//
// What is kept unchanged is the actual proof: `sealParsedPayload` recomputes
// the complete retained text, every span's quote hash, every chunk's text
// hash, the coverage-without-gaps check, and the manifest's four content
// digests from the rows it is given, and `verifySealedParsedPayload` redoes
// every one of those computations against whatever rows the database holds
// *now* and rejects on any mismatch, digest for digest, the same as the
// original. The one thing it deliberately does not redo is the manifest's
// four stored-byte totals, which measure a row's serialized shape rather than
// its content; see P2-100d at that site.
//
// `collectPayloadRows` keeps PR199's rule: a card
// runner's own evidence span (the only kind carrying
// `cardExtractionFingerprints`, which is `NULL` for every parser span) never
// counts against the parser's manifest, so a document a card had staged
// evidence over does not fail `scan_conflict` for content the parser never
// produced.
//
// These functions are transaction and authorization agnostic. The worker
// service authenticates the caller, checks the generation's current space and
// lease, then supplies a client in its staging transaction. Parsed document
// input keeps the worker protocol's epoch-millisecond `capturedAt`; this module
// converts it to PostgreSQL `timestamptz` (`Date`) at the storage boundary.
//
// P2-100e. A digest is computed over the protocol form, never over whatever a
// column happens to deserialize to. The audit of every digest and hash this
// module recomputes, against the Convex implementation at 5a922e4:
//
//   parsed-pages:v1      ordinal, start, end are `numeric` columns, and
//                        `camelizeSourcePage` coerces all three with
//                        `Number`; `textHash` is `text`. No drift.
//   parsed-evidence:v1   built by `canonicalParsedMappingManifestInput`,
//                        which re-validates every field and refuses a wrong
//                        type instead of digesting it. The locator is rebuilt
//                        field by field, so `jsonb` key order cannot reach
//                        the digest. No drift.
//   parsed-documents:v1  `captured_at` is `timestamptz`, so the row's
//                        `capturedAt` is a `Date` that `JSON.stringify`
//                        writes as an ISO string, while Convex stored and
//                        digested `v.number()` epoch milliseconds. DRIFT,
//                        fixed here. `title` and `doc_type` are `text NOT
//                        NULL` and the protocol requires both, and an absent
//                        Convex optional and a SQL `NULL` both serialize to
//                        `null` inside an array, so neither drifts.
//   parsed-chunks:v1     ordinal, start, end are `numeric` and
//                        `camelizeChunk` coerces all three; `documentId` is
//                        `text`, the text is hashed, and `evidenceSpanIds` is
//                        a `jsonb` array, whose element order `jsonb` keeps.
//                        No drift.
//   mapping manifest     `digestParsedMappingManifest`, the same protocol
//                        canonicalization as the evidence digest. No drift.
//   retained text hash   a hash of a `text` column. No drift.
//   archive set digest   `workers/archivedDiscovery.ts`, over receipt ids,
//                        fixed role literals and `bindingEpoch`, which
//                        `camelizeSourceArtifactArchiveBinding` coerces. No
//                        drift.
//   normalized bundle    stored and compared as a string; nothing recomputes
//                        it. No drift.

import type {
  ParsedChunkInput,
  ParsedDocumentInput,
  ParsedEvidenceInput,
  ParsedPageInput,
} from "@repo/worker-protocol";
import {
  canonicalParsedMappingManifestInput,
  digestParsedMappingManifest,
  parseParsedLocator,
} from "@repo/worker-protocol";
import type { ClientBase, QueryResultRow } from "pg";

import { ProofError } from "../errors.js";
import { newKithId } from "../ids.js";
import {
  camelizeChunk,
  camelizeDocument,
  camelizeEvidenceSpan,
  camelizeProcessingGenerationPayloadManifest,
  camelizeSourcePage,
  camelizeSourceTextVersion,
  type ChunkRow,
  type DocumentRow,
  type EvidenceLocator,
  type EvidenceSpanRow,
  type ProcessingGenerationRow,
  type SourcePageRow,
  type WorkerParsedStageRow,
} from "./rows.js";
import { sha256Utf8, utf8Length } from "./sql.js";

const MAX_PAGE_ROW_BYTES = 96 * 1024;
const MAX_EVIDENCE_ROW_BYTES = 8 * 1024;
const MAX_DOCUMENT_ROW_BYTES = 16 * 1024;
const MAX_CHUNK_ROW_BYTES = 24 * 1024;
const MAX_PAGE_PROFILE_CHUNK_TEXT_BYTES = 8 * 1_024;
const MAX_ROW_BYTES = MAX_PAGE_ROW_BYTES;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RETAINED_TEXT_BYTES = 1_024 * 1_024;
const MAX_LEGACY_PAGES = 32;
const MAX_LEGACY_RETAINED_TEXT_BYTES = 256 * 1_024;
const MAX_LEGACY_EVIDENCE_SPANS = 128;
const MAX_LEGACY_CHUNKS = 128;
const MAX_PAGES = 64;
const MAX_EVIDENCE_SPANS = 256;
const MAX_DOCUMENTS = 16;
export const MAX_PARSED_CHUNKS = 256;
export const MAX_PARSED_STORED_PAYLOAD_BYTES = 4 * 1_024 * 1_024;

export function isParsedStoredPayloadWithinLimit(
  ...sizes: readonly number[]
): boolean {
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0) return false;
    total += size;
    if (!Number.isSafeInteger(total) || total > MAX_PARSED_STORED_PAYLOAD_BYTES)
      return false;
  }
  return true;
}

export function isParsedProfileWithinLimits(input: {
  usesPageLocators: boolean;
  pageCount: number;
  retainedTextBytes: number;
  evidenceSpanCount: number;
  chunkCount: number;
}): boolean {
  const values = [
    input.pageCount,
    input.retainedTextBytes,
    input.evidenceSpanCount,
    input.chunkCount,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return false;
  return input.usesPageLocators
    ? input.pageCount <= MAX_PAGES &&
        input.retainedTextBytes <= MAX_RETAINED_TEXT_BYTES &&
        input.evidenceSpanCount <= MAX_EVIDENCE_SPANS &&
        input.chunkCount <= MAX_PARSED_CHUNKS
    : input.pageCount <= MAX_LEGACY_PAGES &&
        input.retainedTextBytes <= MAX_LEGACY_RETAINED_TEXT_BYTES &&
        input.evidenceSpanCount <= MAX_LEGACY_EVIDENCE_SPANS &&
        input.chunkCount <= MAX_LEGACY_CHUNKS;
}

export function isParsedChunkTextWithinLimits(
  usesPageLocators: boolean,
  chunkTextBytes: number,
): boolean {
  return (
    Number.isSafeInteger(chunkTextBytes) &&
    chunkTextBytes >= 0 &&
    chunkTextBytes <= (usesPageLocators ? MAX_RETAINED_TEXT_BYTES : MAX_LEGACY_RETAINED_TEXT_BYTES)
  );
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new ProofError("scan_conflict");
  return value;
}

function rowSize(row: Record<string, unknown>, maximum = MAX_ROW_BYTES): number {
  let size: number;
  try {
    size = utf8Length(JSON.stringify(row));
  } catch {
    throw new ProofError("invalid_request");
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) {
    throw new ProofError("invalid_request");
  }
  return size;
}

/**
 * P2-100c. Which check inside `verifySealedParsedPayload` refused, as a fixed
 * literal. The verifier's behaviour does not change: it still throws
 * `ProofError("scan_conflict")` from every site, and `note` is optional, so
 * callers that do not pass one (the seal and activate paths) are untouched.
 *
 * The literals below are the whole closed set. Never interpolate a row value,
 * an id, a count or a hash into one: an assessment row carrying these is read
 * by operators and copied into reports.
 */
export const PAYLOAD_VERIFY_DETAILS = [
  "missing_ids",
  "manifest_or_text_missing",
  "manifest_identity",
  "id_sets",
  "row_counts",
  "page_loop:ordinal",
  "page_loop:scope",
  "page_loop:offsets",
  "page_loop:hash",
  "span_loop:page",
  "span_loop:ordinal",
  "span_loop:scope",
  "span_loop:bounds",
  "span_loop:locator_kind",
  "span_loop:locator_artifact",
  "span_loop:locator_page",
  "span_loop:quote_hash",
  "locator_kinds_mixed",
  "profile_limits",
  "retained_text_bytes",
  "retained_text_hash",
  "mapping_manifest_hash",
  "publication_state_undecidable",
  "document_loop:scope",
  "document_loop:publication_state",
  "document_loop:span_ids",
  "document_loop:duplicate_key",
  "chunk_loop:document",
  "chunk_loop:scope",
  "chunk_loop:ordinal",
  "chunk_loop:bounds",
  "chunk_loop:text",
  "chunk_loop:publication_state",
  "chunk_loop:span_ids",
  "chunk_coverage_gap",
  "chunk_coverage_end",
  "chunk_text_limit",
  "chunk_ordinals",
  "page_digest",
  "evidence_digest",
  "document_digest",
  "chunk_digest",
  "retained_text_fields",
] as const;

export type PayloadVerifyDetail = (typeof PAYLOAD_VERIFY_DETAILS)[number];

export type PayloadVerifyNote = (detail: PayloadVerifyDetail) => void;

/** Names the site, then throws exactly what this site always threw. */
function refuse(note: PayloadVerifyNote | undefined, detail: PayloadVerifyDetail): never {
  note?.(detail);
  throw new ProofError("scan_conflict");
}

function storedRowSize(row: Record<string, unknown>, maximum: number): number {
  try {
    return rowSize(row, maximum);
  } catch {
    throw new ProofError("scan_conflict");
  }
}

function exactIdSet(expected: readonly string[], actual: readonly string[]): boolean {
  return (
    new Set(expected).size === expected.length &&
    new Set(actual).size === actual.length &&
    expected.length === actual.length &&
    expected.every((id) => actual.includes(id))
  );
}

function orderRowsByIds<T extends { id: string }>(ids: readonly string[], rows: readonly T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new ProofError("scan_conflict");
    return row;
  });
}

async function limited<T>(
  client: ClientBase,
  sql: string,
  values: unknown[],
  maximumCount: number,
  camelizeRow: (row: Record<string, unknown>) => T,
): Promise<T[]> {
  const result = await client.query<QueryResultRow>(sql, values);
  if (result.rowCount! > maximumCount) throw new ProofError("scan_conflict");
  return result.rows.map((row) => camelizeRow(row));
}

/**
 * The four staged tables plus the PR199 zero-count guard on the two tables
 * this row does not own (`event_versions`, `observations`: models/records
 * and models/thoughts territory, rows f and h). Queried by raw SQL rather
 * than through a ported service, exactly as this package's other modules
 * read a table another row owns when they only need to assert its shape.
 */
async function collectPayloadRows(
  client: ClientBase,
  sourceTextVersionId: string,
  processingGenerationId: string,
): Promise<{
  pages: SourcePageRow[];
  spans: EvidenceSpanRow[];
  documents: DocumentRow[];
  chunks: ChunkRow[];
  eventVersionCount: number;
  observationCount: number;
}> {
  const pages = await limited(
    client,
    `SELECT * FROM kith.source_pages WHERE source_text_version_id = $1 LIMIT $2`,
    [sourceTextVersionId, MAX_PAGES + 1],
    MAX_PAGES,
    camelizeSourcePage,
  );
  const allSpans = await limited(
    client,
    `SELECT * FROM kith.evidence_spans WHERE source_text_version_id = $1 LIMIT $2`,
    [sourceTextVersionId, MAX_EVIDENCE_SPANS + 1],
    MAX_EVIDENCE_SPANS,
    camelizeEvidenceSpan,
  );
  // PR199: the parsed payload is the parser's own spans. A card-staged span
  // (the only kind carrying `cardExtractionFingerprints`) is allowed to sit
  // over sealed text -- sealing protects the text and its pages, not
  // pointers into them -- so it must not count against this manifest.
  const spans = allSpans.filter((span) => span.cardExtractionFingerprints === null);
  const documents = await limited(
    client,
    `SELECT * FROM kith.documents WHERE processing_generation_id = $1 LIMIT $2`,
    [processingGenerationId, MAX_DOCUMENTS + 1],
    MAX_DOCUMENTS,
    camelizeDocument,
  );
  const chunks = await limited(
    client,
    `SELECT * FROM kith.chunks WHERE processing_generation_id = $1 LIMIT $2`,
    [processingGenerationId, MAX_PARSED_CHUNKS + 1],
    MAX_PARSED_CHUNKS,
    camelizeChunk,
  );
  const eventVersionCount = Number(
    (
      await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM kith.event_versions WHERE processing_generation_id = $1`,
        [processingGenerationId],
      )
    ).rows[0]!.count,
  );
  const observationCount = Number(
    (
      await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM kith.observations WHERE processing_generation_id = $1`,
        [processingGenerationId],
      )
    ).rows[0]!.count,
  );
  return { pages, spans, documents, chunks, eventVersionCount, observationCount };
}

async function loadPage(client: ClientBase, stage: WorkerParsedStageRow, ordinal: number): Promise<SourcePageRow> {
  const id = stage.pageIds[ordinal];
  const row = id
    ? (await client.query<QueryResultRow>(`SELECT * FROM kith.source_pages WHERE id = $1`, [id])).rows[0]
    : undefined;
  const page = row && camelizeSourcePage(row);
  if (!page || page.sourceTextVersionId !== stage.sourceTextVersionId || page.spaceId !== stage.spaceId || page.ordinal !== ordinal) {
    throw new ProofError("scan_conflict");
  }
  return page;
}

async function loadSpan(
  client: ClientBase,
  stage: WorkerParsedStageRow,
  pageOrdinal: number,
  ordinal: number,
): Promise<EvidenceSpanRow> {
  const id = stage.evidenceSpanIds[ordinal];
  const row = id
    ? (await client.query<QueryResultRow>(`SELECT * FROM kith.evidence_spans WHERE id = $1`, [id])).rows[0]
    : undefined;
  const selected = row && camelizeEvidenceSpan(row);
  if (
    !selected ||
    selected.ordinal !== ordinal ||
    selected.spaceId !== stage.spaceId ||
    selected.sourceRevisionId !== stage.sourceRevisionId ||
    selected.sourceTextVersionId !== stage.sourceTextVersionId ||
    stage.pageIds[pageOrdinal] !== selected.sourcePageId
  )
    throw new ProofError("scan_conflict");
  return selected;
}

export async function insertParsedPages(
  client: ClientBase,
  stage: WorkerParsedStageRow,
  rows: ParsedPageInput[],
): Promise<{ ids: string[]; bytes: number }> {
  const ids: string[] = [];
  let bytes = 0;
  let previousEnd =
    stage.pageIds.length === 0 ? 0 : (await loadPage(client, stage, stage.pageIds.length - 1)).end;
  for (const row of rows) {
    if (
      row.ordinal !== stage.pageIds.length + ids.length ||
      row.start !== previousEnd ||
      row.end - row.start !== row.text.length ||
      (await sha256Utf8(row.text)) !== row.textHash
    ) {
      throw new ProofError("invalid_request");
    }
    const id = newKithId();
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.source_pages (id, space_id, created_at, source_text_version_id, ordinal, "start", "end", text, text_hash)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [id, stage.spaceId, stage.sourceTextVersionId, row.ordinal, row.start, row.end, row.text, row.textHash],
    );
    bytes = checkedAdd(bytes, rowSize(camelizeSourcePage(result.rows[0]!), MAX_PAGE_ROW_BYTES));
    ids.push(id);
    previousEnd = row.end;
  }
  return { ids, bytes };
}

export async function insertParsedEvidence(
  client: ClientBase,
  stage: WorkerParsedStageRow,
  rows: ParsedEvidenceInput[],
): Promise<{ ids: string[]; bytes: number }> {
  const ids: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (row.ordinal !== stage.evidenceSpanIds.length + ids.length) throw new ProofError("invalid_request");
    const page = await loadPage(client, stage, row.pageOrdinal);
    if (
      row.end <= row.start ||
      row.end > page.text.length ||
      (await sha256Utf8(page.text.slice(row.start, row.end))) !== row.quoteHash
    ) {
      throw new ProofError("invalid_request");
    }
    const locator: EvidenceLocator = { ...row.locator, parserArtifactId: stage.parserArtifactId };
    if (
      locator.kind === "parser_page_v1" &&
      (locator.pageNumber !== page.ordinal + 1 || locator.pageTextHash !== page.textHash)
    ) {
      throw new ProofError("invalid_request");
    }
    const id = newKithId();
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.evidence_spans
         (id, space_id, created_at, source_revision_id, source_text_version_id, source_page_id, ordinal,
          "start", "end", quote_hash, locator)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        id,
        stage.spaceId,
        stage.sourceRevisionId,
        stage.sourceTextVersionId,
        page.id,
        row.ordinal,
        row.start,
        row.end,
        row.quoteHash,
        JSON.stringify(locator),
      ],
    );
    bytes = checkedAdd(bytes, rowSize(camelizeEvidenceSpan(result.rows[0]!), MAX_EVIDENCE_ROW_BYTES));
    ids.push(id);
  }
  return { ids, bytes };
}

export async function insertParsedDocuments(
  client: ClientBase,
  stage: WorkerParsedStageRow,
  rows: ParsedDocumentInput[],
): Promise<{ ids: string[]; bytes: number }> {
  const ids: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const prior = await client.query<QueryResultRow>(
      `SELECT 1 FROM kith.documents WHERE processing_generation_id = $1 AND document_key = $2 LIMIT 1`,
      [stage.processingGenerationId, row.documentKey],
    );
    if (prior.rowCount) throw new ProofError("request_conflict");
    const evidenceSpanIds: string[] = [];
    for (const ref of row.evidence) {
      evidenceSpanIds.push((await loadSpan(client, stage, ref.pageOrdinal, ref.evidenceOrdinal)).id);
    }
    if (new Set(evidenceSpanIds).size !== evidenceSpanIds.length) throw new ProofError("invalid_request");
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
        stage.spaceId,
        stage.processingGenerationId,
        stage.sourceItemId,
        stage.sourceRevisionId,
        stage.sourceTextVersionId,
        row.documentKey,
        row.title,
        row.docType,
        new Date(row.capturedAt),
        JSON.stringify(evidenceSpanIds),
      ],
    );
    bytes = checkedAdd(bytes, rowSize(camelizeDocument(result.rows[0]!), MAX_DOCUMENT_ROW_BYTES));
    ids.push(id);
  }
  return { ids, bytes };
}

async function loadDocument(client: ClientBase, stage: WorkerParsedStageRow, key: string): Promise<DocumentRow> {
  const rows = await client.query<QueryResultRow>(
    `SELECT * FROM kith.documents WHERE processing_generation_id = $1 AND document_key = $2 LIMIT 2`,
    [stage.processingGenerationId, key],
  );
  if (
    rows.rowCount !== 1 ||
    rows.rows[0]!.space_id !== stage.spaceId ||
    rows.rows[0]!.source_text_version_id !== stage.sourceTextVersionId ||
    !stage.documentIds.includes(rows.rows[0]!.id)
  )
    throw new ProofError("scan_conflict");
  return camelizeDocument(rows.rows[0]!);
}

export async function insertParsedChunks(
  client: ClientBase,
  stage: WorkerParsedStageRow,
  rows: ParsedChunkInput[],
): Promise<{ ids: string[]; bytes: number }> {
  const ids: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const document = await loadDocument(client, stage, row.documentKey);
    const prior = await client.query<QueryResultRow>(
      `SELECT 1 FROM kith.chunks WHERE document_id = $1 AND ordinal = $2 LIMIT 1`,
      [document.id, row.ordinal],
    );
    if (prior.rowCount || row.end <= row.start || row.text.length !== row.end - row.start) {
      throw new ProofError("invalid_request");
    }
    const evidenceSpanIds: string[] = [];
    for (const ref of row.evidence) {
      evidenceSpanIds.push((await loadSpan(client, stage, ref.pageOrdinal, ref.evidenceOrdinal)).id);
    }
    if (
      new Set(evidenceSpanIds).size !== evidenceSpanIds.length ||
      evidenceSpanIds.some((id) => !document.evidenceSpanIds.includes(id))
    )
      throw new ProofError("invalid_request");
    const id = newKithId();
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.chunks
         (id, space_id, created_at, processing_generation_id, document_id, ordinal, source_text_version_id,
          "start", "end", text, evidence_span_ids, publication_state)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,'staged')
       RETURNING *`,
      [
        id,
        stage.spaceId,
        stage.processingGenerationId,
        document.id,
        row.ordinal,
        stage.sourceTextVersionId,
        row.start,
        row.end,
        row.text,
        JSON.stringify(evidenceSpanIds),
      ],
    );
    bytes = checkedAdd(bytes, rowSize(camelizeChunk(result.rows[0]!), MAX_CHUNK_ROW_BYTES));
    ids.push(id);
  }
  return { ids, bytes };
}

function strippedLocator(locator: NonNullable<EvidenceLocator>) {
  if (
    locator.kind !== "parser_page_v1" &&
    locator.kind !== "parser_item_v1" &&
    locator.kind !== "parser_table_row_v1"
  )
    throw new ProofError("scan_conflict");
  const { parserArtifactId: _ignored, ...rest } = locator;
  return parseParsedLocator(rest);
}

export async function requirePageChunkProfile(
  pages: readonly SourcePageRow[],
  spans: readonly EvidenceSpanRow[],
  documents: readonly DocumentRow[],
  chunks: readonly ChunkRow[],
): Promise<void> {
  const document = documents[0];
  if (
    documents.length !== 1 ||
    !document ||
    document.evidenceSpanIds.length !== spans.length ||
    new Set(document.evidenceSpanIds).size !== spans.length
  )
    throw new ProofError("scan_conflict");
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const spanById = new Map(spans.map((span) => [span.id, span]));
  const consumedSpanIds = new Set<string>();
  const ranges: Array<readonly [number, number]> = [];
  for (const chunk of chunks) {
    const spanId = chunk.evidenceSpanIds[0];
    const span = spanId ? spanById.get(spanId) : undefined;
    const page = span ? pageById.get(span.sourcePageId) : undefined;
    if (
      chunk.documentId !== document.id ||
      chunk.evidenceSpanIds.length !== 1 ||
      !spanId ||
      !span ||
      !page ||
      consumedSpanIds.has(spanId) ||
      chunk.start !== page.start + span.start ||
      chunk.end !== page.start + span.end ||
      utf8Length(chunk.text) > MAX_PAGE_PROFILE_CHUNK_TEXT_BYTES ||
      (await sha256Utf8(chunk.text)) !== span.quoteHash
    )
      throw new ProofError("scan_conflict");
    consumedSpanIds.add(spanId);
    ranges.push([chunk.start!, chunk.end!]);
  }
  if (consumedSpanIds.size !== spans.length || document.evidenceSpanIds.some((id) => !consumedSpanIds.has(id))) {
    throw new ProofError("scan_conflict");
  }
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]![0] < ranges[index - 1]![1]) throw new ProofError("scan_conflict");
  }
}

async function digestRows(domain: string, rows: unknown[]): Promise<string> {
  return sha256Utf8(`${domain}\0${JSON.stringify(rows)}`);
}

// P2-100e. The canonical input of each digest, in one place, so seal and
// verify cannot drift apart and so no column's storage type can leak into a
// digest again.
//
// The canonical form is the worker protocol's form, which is what the Convex
// implementation digested and what this module's header documents as the form
// the input keeps: `capturedAt` is an epoch-millisecond number, offsets and
// ordinals are numbers, ids and hashes are strings. `parsed-evidence:v1` and
// the mapping manifest hash need no helper here: they go through
// `canonicalParsedMappingManifestInput`, which re-validates every field and
// refuses a wrong type rather than digesting it.

function pageDigestRows(pages: readonly ParsedPageInput[]): unknown[] {
  return pages.map(({ ordinal, start, end, textHash }) => [ordinal, start, end, textHash]);
}

function documentDigestRows(documents: readonly DocumentRow[]): unknown[] {
  return documents.map((row) => [
    row.documentKey,
    row.title,
    row.docType,
    row.capturedAt.getTime(),
    row.evidenceSpanIds,
  ]);
}

/**
 * The same five fields, with `capturedAt` left as the `timestamptz` Date this
 * package reads back, which `JSON.stringify` writes as an ISO string.
 *
 * Every payload sealed natively on PostgreSQL before P2-100e recorded this
 * form, because seal and verify both read the column and both drifted the same
 * way. It stays accepted, named, and second: `verifySealedParsedPayload` tries
 * the canonical form first and only falls back here. Both are full content
 * proofs over the same five fields of the same rows, so accepting either
 * weakens nothing; they differ only in how one timestamp is written down. New
 * seals record the canonical form, and no stored manifest is rewritten.
 */
function legacyDocumentDigestRows(documents: readonly DocumentRow[]): unknown[] {
  return documents.map((row) => [
    row.documentKey,
    row.title,
    row.docType,
    row.capturedAt,
    row.evidenceSpanIds,
  ]);
}

async function chunkDigestRows(chunks: readonly ChunkRow[]): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const row of chunks) {
    rows.push([row.documentId, row.ordinal, row.start, row.end, await sha256Utf8(row.text), row.evidenceSpanIds]);
  }
  return rows;
}

export type SealedPayloadSummary = {
  manifestId: string;
  pageCount: number;
  evidenceSpanCount: number;
  documentCount: number;
  chunkCount: number;
};

/**
 * Seals a staged parsed generation: recomputes the complete retained text,
 * every span's quote hash and every chunk's text hash from the rows the
 * stage names, checks they cover the text without gaps or overlaps, and
 * records the result as an immutable manifest. Ported unchanged from
 * `parsedStaging.ts`, minus the Convex read-budget bookkeeping (see the
 * module header).
 */
export async function sealParsedPayload(
  client: ClientBase,
  stage: WorkerParsedStageRow,
  now: Date,
): Promise<SealedPayloadSummary> {
  const collected = await collectPayloadRows(client, stage.sourceTextVersionId, stage.processingGenerationId);
  if (
    collected.eventVersionCount !== 0 ||
    collected.observationCount !== 0 ||
    !exactIdSet(stage.pageIds, collected.pages.map((row) => row.id)) ||
    !exactIdSet(stage.evidenceSpanIds, collected.spans.map((row) => row.id)) ||
    !exactIdSet(stage.documentIds, collected.documents.map((row) => row.id)) ||
    !exactIdSet(stage.chunkIds, collected.chunks.map((row) => row.id)) ||
    collected.pages.length !== stage.expectedPageCount ||
    collected.spans.length !== stage.expectedEvidenceSpanCount ||
    collected.documents.length !== stage.expectedDocumentCount ||
    collected.chunks.length !== stage.expectedChunkCount
  )
    throw new ProofError("scan_conflict");
  const pages = orderRowsByIds(stage.pageIds, collected.pages);
  const spans = orderRowsByIds(stage.evidenceSpanIds, collected.spans);
  const documents = orderRowsByIds(stage.documentIds, collected.documents);
  const chunks = orderRowsByIds(stage.chunkIds, collected.chunks);
  let completeText = "";
  const pageInputs: ParsedPageInput[] = [];
  for (let ordinal = 0; ordinal < pages.length; ordinal += 1) {
    const page = pages[ordinal]!;
    if (
      page.spaceId !== stage.spaceId ||
      page.sourceTextVersionId !== stage.sourceTextVersionId ||
      page.ordinal !== ordinal ||
      page.start !== completeText.length ||
      page.end !== page.start + page.text.length ||
      (await sha256Utf8(page.text)) !== page.textHash
    )
      throw new ProofError("scan_conflict");
    completeText += page.text;
    pageInputs.push({ ordinal, start: page.start, end: page.end, text: page.text, textHash: page.textHash });
  }
  const textBytes = utf8Length(completeText);
  if (textBytes > MAX_RETAINED_TEXT_BYTES) throw new ProofError("scan_conflict");
  const pageById = new Map(pages.map((row) => [row.id, row]));
  const evidenceInputs: ParsedEvidenceInput[] = spans.map((span, ordinal) => {
    const page = pageById.get(span.sourcePageId);
    if (
      !page ||
      span.ordinal !== ordinal ||
      span.spaceId !== stage.spaceId ||
      span.sourceRevisionId !== stage.sourceRevisionId ||
      span.sourceTextVersionId !== stage.sourceTextVersionId ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > page.text.length
    )
      throw new ProofError("scan_conflict");
    const storedLocator = span.locator;
    if (
      !storedLocator ||
      (storedLocator.kind !== "parser_page_v1" &&
        storedLocator.kind !== "parser_item_v1" &&
        storedLocator.kind !== "parser_table_row_v1") ||
      storedLocator.parserArtifactId !== stage.parserArtifactId ||
      (storedLocator.kind === "parser_page_v1" &&
        (storedLocator.pageNumber !== page.ordinal + 1 || storedLocator.pageTextHash !== page.textHash))
    )
      throw new ProofError("scan_conflict");
    const locator = strippedLocator(storedLocator);
    return { ordinal, pageOrdinal: page.ordinal, start: span.start, end: span.end, quoteHash: span.quoteHash, locator } as ParsedEvidenceInput;
  });
  for (const input of evidenceInputs) {
    const page = pages[input.pageOrdinal]!;
    if ((await sha256Utf8(page.text.slice(input.start, input.end))) !== input.quoteHash) {
      throw new ProofError("scan_conflict");
    }
  }
  const usesPageLocators = evidenceInputs.some((input) => input.locator.kind === "parser_page_v1");
  if (usesPageLocators && evidenceInputs.some((input) => input.locator.kind !== "parser_page_v1")) {
    throw new ProofError("scan_conflict");
  }
  if (
    !isParsedProfileWithinLimits({
      usesPageLocators,
      pageCount: pages.length,
      retainedTextBytes: textBytes,
      evidenceSpanCount: spans.length,
      chunkCount: chunks.length,
    })
  )
    throw new ProofError("scan_conflict");
  if ((await digestParsedMappingManifest(pageInputs, evidenceInputs)) !== stage.mappingManifestHash) {
    throw new ProofError("scan_conflict");
  }
  const spanIds = new Set(spans.map((row) => row.id));
  const documentKeys = new Set<string>();
  for (const document of documents) {
    if (
      document.spaceId !== stage.spaceId ||
      document.processingGenerationId !== stage.processingGenerationId ||
      document.sourceItemId !== stage.sourceItemId ||
      document.sourceRevisionId !== stage.sourceRevisionId ||
      document.sourceTextVersionId !== stage.sourceTextVersionId ||
      document.publicationState !== "staged" ||
      new Set(document.evidenceSpanIds).size !== document.evidenceSpanIds.length ||
      document.evidenceSpanIds.some((id) => !spanIds.has(id))
    )
      throw new ProofError("scan_conflict");
    if (documentKeys.has(document.documentKey)) throw new ProofError("scan_conflict");
    documentKeys.add(document.documentKey);
  }
  const documentById = new Map(documents.map((row) => [row.id, row]));
  let chunkTextBytes = 0;
  const chunkOrdinals = new Map<string, number[]>();
  const coverage = chunks
    .map((chunk) => {
      const document = documentById.get(chunk.documentId);
      if (
        !document ||
        chunk.spaceId !== stage.spaceId ||
        chunk.processingGenerationId !== stage.processingGenerationId ||
        chunk.sourceTextVersionId !== stage.sourceTextVersionId ||
        !Number.isSafeInteger(chunk.ordinal) ||
        chunk.ordinal < 0 ||
        chunk.start === null ||
        chunk.end === null ||
        !Number.isSafeInteger(chunk.start) ||
        !Number.isSafeInteger(chunk.end) ||
        chunk.start < 0 ||
        chunk.end <= chunk.start ||
        chunk.end > completeText.length ||
        completeText.slice(chunk.start, chunk.end) !== chunk.text ||
        chunk.publicationState !== "staged" ||
        new Set(chunk.evidenceSpanIds).size !== chunk.evidenceSpanIds.length ||
        chunk.evidenceSpanIds.some((id) => !document.evidenceSpanIds.includes(id))
      )
        throw new ProofError("scan_conflict");
      chunkTextBytes = checkedAdd(chunkTextBytes, utf8Length(chunk.text));
      const ordinals = chunkOrdinals.get(chunk.documentId) ?? [];
      ordinals.push(chunk.ordinal);
      chunkOrdinals.set(chunk.documentId, ordinals);
      return [chunk.start, chunk.end] as const;
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (usesPageLocators) await requirePageChunkProfile(pages, spans, documents, chunks);
  let cursor = 0;
  for (const [start, end] of coverage) {
    if (start > cursor) throw new ProofError("scan_conflict");
    cursor = Math.max(cursor, end);
  }
  if (cursor !== completeText.length || !isParsedChunkTextWithinLimits(usesPageLocators, chunkTextBytes)) {
    throw new ProofError("scan_conflict");
  }
  for (const ordinals of chunkOrdinals.values()) {
    ordinals.sort((a, b) => a - b);
    if (ordinals.some((value, index) => value !== index)) throw new ProofError("scan_conflict");
  }
  const textHash = await sha256Utf8(completeText);
  const textVersionRow = (
    await client.query<QueryResultRow>(`SELECT * FROM kith.source_text_versions WHERE id = $1`, [
      stage.sourceTextVersionId,
    ])
  ).rows[0];
  if (!textVersionRow) throw new ProofError("scan_conflict");
  const textVersion = camelizeSourceTextVersion(textVersionRow);
  if (
    textVersion.textHash !== textHash ||
    textVersion.byteLength !== textBytes ||
    textVersion.utf16Length !== completeText.length ||
    textVersion.pageCount !== pages.length ||
    textVersion.mappingManifestHash !== stage.mappingManifestHash ||
    textVersion.evidenceSealed
  )
    throw new ProofError("scan_conflict");
  const pageBytes = pages.reduce((sum, row) => checkedAdd(sum, storedRowSize(row, MAX_PAGE_ROW_BYTES)), 0);
  const evidenceBytes = spans.reduce((sum, row) => checkedAdd(sum, storedRowSize(row, MAX_EVIDENCE_ROW_BYTES)), 0);
  const documentBytes = documents.reduce((sum, row) => checkedAdd(sum, storedRowSize(row, MAX_DOCUMENT_ROW_BYTES)), 0);
  const chunkBytes = chunks.reduce((sum, row) => checkedAdd(sum, storedRowSize(row, MAX_CHUNK_ROW_BYTES)), 0);
  if (
    pageBytes !== stage.pageBytes ||
    evidenceBytes !== stage.evidenceBytes ||
    documentBytes !== stage.documentBytes ||
    chunkBytes !== stage.chunkBytes
  )
    throw new ProofError("scan_conflict");
  const manifestId = newKithId();
  const pageDigest = await digestRows("parsed-pages:v1", pageDigestRows(pageInputs));
  const evidenceDigest = await digestRows(
    "parsed-evidence:v1",
    canonicalParsedMappingManifestInput([], evidenceInputs)[2] as unknown[],
  );
  // The canonical form only. A new seal never records the legacy form.
  const documentDigest = await digestRows("parsed-documents:v1", documentDigestRows(documents));
  const chunkDigest = await digestRows("parsed-chunks:v1", await chunkDigestRows(chunks));
  const manifestResult = await client.query<QueryResultRow>(
    `INSERT INTO kith.processing_generation_payload_manifests
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, source_text_version_id,
        parser_artifact_id, processing_generation_id, archive_set_digest, normalized_bundle_digest,
        mapping_manifest_hash, page_ids, evidence_span_ids, document_ids, chunk_ids, page_count,
        evidence_span_count, document_count, chunk_count, page_bytes, evidence_bytes, document_bytes,
        chunk_bytes, page_digest, evidence_digest, document_digest, chunk_digest, retained_text_hash,
        retained_text_utf8_length, retained_text_utf16_length, manifest_version, created_at_field)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,'parsed_payload_v1',$31)
     RETURNING *`,
    [
      manifestId,
      stage.spaceId,
      stage.sourceAccountId,
      stage.sourceItemId,
      stage.sourceRevisionId,
      stage.sourceTextVersionId,
      stage.parserArtifactId,
      stage.processingGenerationId,
      stage.archiveSetDigest,
      stage.normalizedBundleDigest,
      stage.mappingManifestHash,
      JSON.stringify(stage.pageIds),
      JSON.stringify(stage.evidenceSpanIds),
      JSON.stringify(stage.documentIds),
      JSON.stringify(stage.chunkIds),
      pages.length,
      spans.length,
      documents.length,
      chunks.length,
      pageBytes,
      evidenceBytes,
      documentBytes,
      chunkBytes,
      pageDigest,
      evidenceDigest,
      documentDigest,
      chunkDigest,
      textHash,
      textBytes,
      completeText.length,
      now,
    ],
  );
  const storedManifest = camelizeProcessingGenerationPayloadManifest(manifestResult.rows[0]!);
  if (
    usesPageLocators &&
    !isParsedStoredPayloadWithinLimit(
      pageBytes,
      evidenceBytes,
      documentBytes,
      chunkBytes,
      storedRowSize(storedManifest, MAX_MANIFEST_BYTES),
    )
  )
    throw new ProofError("scan_conflict");
  await client.query(
    `UPDATE kith.source_text_versions SET evidence_sealed = true, text_hash_authority = 'server_verified_retained_text' WHERE id = $1`,
    [stage.sourceTextVersionId],
  );
  await client.query(
    `UPDATE kith.processing_generations
        SET state = 'staged', actual_page_count = $1, actual_evidence_span_count = $2, actual_document_count = $3,
            actual_chunk_count = $4, actual_event_count = 0, actual_observation_count = 0, payload_manifest_id = $5
      WHERE id = $6`,
    [pages.length, spans.length, documents.length, chunks.length, manifestId, stage.processingGenerationId],
  );
  await client.query(`UPDATE kith.ingest_jobs SET state = 'staged' WHERE id = $1`, [stage.ingestJobId]);
  await client.query(
    `UPDATE kith.worker_parsed_stages SET phase = 'staged', payload_manifest_id = $1, updated_at = $2 WHERE id = $3`,
    [manifestId, now, stage.id],
  );
  return {
    manifestId,
    pageCount: pages.length,
    evidenceSpanCount: spans.length,
    documentCount: documents.length,
    chunkCount: chunks.length,
  };
}

export type VerifiedSealedPayload = {
  actualPageCount: number;
  actualEvidenceSpanCount: number;
  actualDocumentCount: number;
  actualChunkCount: number;
  actualEventCount: number;
  actualObservationCount: number;
  verifiedDocuments: DocumentRow[];
  verifiedChunks: ChunkRow[];
};

/**
 * Re-derives every check `sealParsedPayload` made, against whatever the
 * database holds for this generation right now, and rejects on the first
 * mismatch. This is the read side of the seal: nothing here writes.
 */
/**
 * `note`, when given, receives the fixed literal naming the check that
 * refused, immediately before the throw that always happened there. It changes
 * nothing else: the error, its code and every branch are what they were, and a
 * caller that passes no note cannot tell this parameter exists.
 */
export async function verifySealedParsedPayload(
  client: ClientBase,
  generation: ProcessingGenerationRow,
  note?: PayloadVerifyNote,
): Promise<VerifiedSealedPayload> {
  const no: (detail: PayloadVerifyDetail) => never = (detail) => refuse(note, detail);
  if (!generation.payloadManifestId || !generation.sourceTextVersionId || !generation.parserArtifactId) {
    no("missing_ids");
  }
  const manifestRow = (
    await client.query<QueryResultRow>(`SELECT * FROM kith.processing_generation_payload_manifests WHERE id = $1`, [
      generation.payloadManifestId,
    ])
  ).rows[0];
  const manifest = manifestRow && camelizeProcessingGenerationPayloadManifest(manifestRow);
  const textRow = (
    await client.query<QueryResultRow>(`SELECT * FROM kith.source_text_versions WHERE id = $1`, [
      generation.sourceTextVersionId,
    ])
  ).rows[0];
  if (!manifest || !textRow) no("manifest_or_text_missing");
  const text = camelizeSourceTextVersion(textRow);
  if (
    manifest.processingGenerationId !== generation.id ||
    manifest.spaceId !== generation.spaceId ||
    manifest.sourceAccountId !== generation.sourceAccountId ||
    manifest.sourceItemId !== generation.sourceItemId ||
    manifest.sourceRevisionId !== generation.sourceRevisionId ||
    manifest.sourceTextVersionId !== generation.sourceTextVersionId ||
    manifest.parserArtifactId !== generation.parserArtifactId ||
    manifest.archiveSetDigest !== generation.archiveSetDigest ||
    manifest.normalizedBundleDigest !== generation.normalizedBundleDigest ||
    manifest.mappingManifestHash !== text.mappingManifestHash ||
    manifest.manifestVersion !== "parsed_payload_v1" ||
    text.representation !== "parsed_pages_v1" ||
    text.evidenceSealed !== true ||
    text.textHashAuthority !== "server_verified_retained_text"
  )
    no("manifest_identity");
  const collected = await collectPayloadRows(client, text.id, generation.id);
  // Split from the counts below only so a failure can be named. The order of
  // the conditions, and so the answer, is what it was.
  if (
    collected.eventVersionCount !== 0 ||
    collected.observationCount !== 0 ||
    !exactIdSet(manifest.pageIds, collected.pages.map((row) => row.id)) ||
    !exactIdSet(manifest.evidenceSpanIds, collected.spans.map((row) => row.id)) ||
    !exactIdSet(manifest.documentIds, collected.documents.map((row) => row.id)) ||
    !exactIdSet(manifest.chunkIds, collected.chunks.map((row) => row.id))
  )
    no("id_sets");
  if (
    collected.pages.length !== manifest.pageCount ||
    collected.spans.length !== manifest.evidenceSpanCount ||
    collected.documents.length !== manifest.documentCount ||
    collected.chunks.length !== manifest.chunkCount ||
    collected.pages.length !== generation.expectedPageCount ||
    collected.spans.length !== generation.expectedEvidenceSpanCount ||
    collected.documents.length !== generation.expectedDocumentCount ||
    collected.chunks.length !== generation.expectedChunkCount
  )
    no("row_counts");
  const pages = orderRowsByIds(manifest.pageIds, collected.pages);
  const spans = orderRowsByIds(manifest.evidenceSpanIds, collected.spans);
  const documents = orderRowsByIds(manifest.documentIds, collected.documents);
  const chunks = orderRowsByIds(manifest.chunkIds, collected.chunks);
  let completeText = "";
  const pageInputs: ParsedPageInput[] = [];
  for (let ordinal = 0; ordinal < pages.length; ordinal += 1) {
    const page = pages[ordinal]!;
    if (page.ordinal !== ordinal) no("page_loop:ordinal");
    if (page.spaceId !== generation.spaceId || page.sourceTextVersionId !== text.id)
      no("page_loop:scope");
    if (page.start !== completeText.length || page.end !== page.start + page.text.length)
      no("page_loop:offsets");
    if ((await sha256Utf8(page.text)) !== page.textHash) no("page_loop:hash");
    completeText += page.text;
    pageInputs.push({ ordinal, start: page.start, end: page.end, text: page.text, textHash: page.textHash });
  }
  const pageById = new Map(pages.map((row) => [row.id, row]));
  const evidenceInputs: ParsedEvidenceInput[] = [];
  for (let ordinal = 0; ordinal < spans.length; ordinal += 1) {
    const span = spans[ordinal]!;
    const page = pageById.get(span.sourcePageId);
    const locator = span.locator;
    if (!page) no("span_loop:page");
    if (span.ordinal !== ordinal) no("span_loop:ordinal");
    if (
      span.spaceId !== generation.spaceId ||
      span.sourceRevisionId !== generation.sourceRevisionId ||
      span.sourceTextVersionId !== text.id
    )
      no("span_loop:scope");
    if (
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > page.text.length
    )
      no("span_loop:bounds");
    if (
      !locator ||
      (locator.kind !== "parser_page_v1" && locator.kind !== "parser_item_v1" && locator.kind !== "parser_table_row_v1")
    )
      no("span_loop:locator_kind");
    if (locator.parserArtifactId !== generation.parserArtifactId)
      no("span_loop:locator_artifact");
    if (
      locator.kind === "parser_page_v1" &&
      (locator.pageNumber !== page.ordinal + 1 || locator.pageTextHash !== page.textHash)
    )
      no("span_loop:locator_page");
    if ((await sha256Utf8(page.text.slice(span.start, span.end))) !== span.quoteHash)
      no("span_loop:quote_hash");
    evidenceInputs.push({
      ordinal,
      pageOrdinal: page.ordinal,
      start: span.start,
      end: span.end,
      quoteHash: span.quoteHash,
      locator: strippedLocator(locator),
    });
  }
  const textBytes = utf8Length(completeText);
  const usesPageLocators = evidenceInputs.some((input) => input.locator.kind === "parser_page_v1");
  if (usesPageLocators && evidenceInputs.some((input) => input.locator.kind !== "parser_page_v1")) {
    no("locator_kinds_mixed");
  }
  if (
    !isParsedProfileWithinLimits({
      usesPageLocators,
      pageCount: pages.length,
      retainedTextBytes: textBytes,
      evidenceSpanCount: spans.length,
      chunkCount: chunks.length,
    })
  )
    no("profile_limits");
  if (textBytes > MAX_RETAINED_TEXT_BYTES) no("retained_text_bytes");
  if (text.textHash !== (await sha256Utf8(completeText))) no("retained_text_hash");
  if ((await digestParsedMappingManifest(pageInputs, evidenceInputs)) !== manifest.mappingManifestHash)
    no("mapping_manifest_hash");
  const spanIds = new Set(spans.map((row) => row.id));
  const documentById = new Map(documents.map((row) => [row.id, row]));
  const expectedPublicationState =
    generation.state === "staged"
      ? "staged"
      : generation.state === "ready" && generation.deactivatedAt === null
        ? "active"
        : generation.state === "ready" && generation.deactivatedAt !== null
          ? "historical"
          : undefined;
  if (!expectedPublicationState) no("publication_state_undecidable");
  const documentKeys = new Set<string>();
  for (const document of documents) {
    if (
      document.spaceId !== generation.spaceId ||
      document.processingGenerationId !== generation.id ||
      document.sourceItemId !== generation.sourceItemId ||
      document.sourceRevisionId !== generation.sourceRevisionId ||
      document.sourceTextVersionId !== text.id
    )
      no("document_loop:scope");
    if (document.publicationState !== expectedPublicationState)
      no("document_loop:publication_state");
    if (
      new Set(document.evidenceSpanIds).size !== document.evidenceSpanIds.length ||
      document.evidenceSpanIds.some((id) => !spanIds.has(id))
    )
      no("document_loop:span_ids");
    if (documentKeys.has(document.documentKey)) no("document_loop:duplicate_key");
    documentKeys.add(document.documentKey);
  }
  let chunkTextBytes = 0;
  const coverage: Array<readonly [number, number]> = [];
  const chunkOrdinals = new Map<string, number[]>();
  for (const chunk of chunks) {
    const document = documentById.get(chunk.documentId);
    if (!document) no("chunk_loop:document");
    if (
      chunk.spaceId !== generation.spaceId ||
      chunk.processingGenerationId !== generation.id ||
      chunk.sourceTextVersionId !== text.id
    )
      no("chunk_loop:scope");
    if (!Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 0) no("chunk_loop:ordinal");
    if (
      chunk.start === null ||
      chunk.end === null ||
      !Number.isSafeInteger(chunk.start) ||
      !Number.isSafeInteger(chunk.end) ||
      chunk.start < 0 ||
      chunk.end <= chunk.start ||
      chunk.end > completeText.length
    )
      no("chunk_loop:bounds");
    if (completeText.slice(chunk.start, chunk.end) !== chunk.text) no("chunk_loop:text");
    if (chunk.publicationState !== expectedPublicationState)
      no("chunk_loop:publication_state");
    if (
      new Set(chunk.evidenceSpanIds).size !== chunk.evidenceSpanIds.length ||
      chunk.evidenceSpanIds.some((id) => !document.evidenceSpanIds.includes(id))
    )
      no("chunk_loop:span_ids");
    chunkTextBytes = checkedAdd(chunkTextBytes, utf8Length(chunk.text));
    coverage.push([chunk.start, chunk.end]);
    const ordinals = chunkOrdinals.get(chunk.documentId) ?? [];
    ordinals.push(chunk.ordinal);
    chunkOrdinals.set(chunk.documentId, ordinals);
  }
  if (usesPageLocators) await requirePageChunkProfile(pages, spans, documents, chunks);
  coverage.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cursor = 0;
  for (const [start, end] of coverage) {
    if (start > cursor) no("chunk_coverage_gap");
    cursor = Math.max(cursor, end);
  }
  if (cursor !== completeText.length) no("chunk_coverage_end");
  if (!isParsedChunkTextWithinLimits(usesPageLocators, chunkTextBytes)) no("chunk_text_limit");
  for (const ordinals of chunkOrdinals.values()) {
    ordinals.sort((left, right) => left - right);
    if (ordinals.some((value, index) => value !== index)) no("chunk_ordinals");
  }
  // P2-100d. The verifier does not re-measure stored row bytes, and does not
  // compare the manifest's four byte totals with a recomputation.
  //
  // Those totals are `utf8Length(JSON.stringify(<whole row>))`, so they depend
  // on a row's *shape* and not only on its content: a row migrated from Convex
  // (`_id`, `_creationTime`, absent empty fields) and the same row on
  // PostgreSQL (`id`, `space_id`, an ISO `created_at`, an explicit `null` per
  // nullable column) serialize to different lengths, and adding one nullable
  // column to any of the four tables changes the length of every existing row.
  // Re-deriving a shape-dependent number and calling a mismatch a proof
  // failure refuses payloads whose content is intact, which is what buried
  // every migrated document in `unavailable`.
  //
  // Nothing is lost. The byte totals are a write-time budget, enforced where a
  // budget belongs: per row against its ceiling in `insertParsed*`, and again
  // at `sealParsedPayload`, which recomputes all four from the rows it seals,
  // requires them to equal what staging accumulated, and rejects a sealed
  // payload over `MAX_PARSED_STORED_PAYLOAD_BYTES`. They were never an
  // integrity check: a byte count cannot detect an edit that preserves length,
  // and every edit it could detect is already caught by the id sets, the row
  // counts, the page and quote hashes, the retained-text hash, the mapping
  // manifest hash and the four content digests below, each computed over an
  // explicit field list and so shape independent.
  if (manifest.pageDigest !== (await digestRows("parsed-pages:v1", pageDigestRows(pageInputs))))
    no("page_digest");
  if (
    manifest.evidenceDigest !==
    (await digestRows("parsed-evidence:v1", canonicalParsedMappingManifestInput([], evidenceInputs)[2] as unknown[]))
  )
    no("evidence_digest");
  // P2-100e. The canonical form first. A manifest sealed natively on
  // PostgreSQL before P2-100e recorded `capturedAt` as an ISO string, so that
  // form is tried second rather than refused. Both cover the same five fields
  // of the same rows, so a document whose key, title, doc type, captured-at
  // instant or evidence span ids were altered fails both.
  if (manifest.documentDigest !== (await digestRows("parsed-documents:v1", documentDigestRows(documents)))) {
    if (manifest.documentDigest !== (await digestRows("parsed-documents:v1", legacyDocumentDigestRows(documents))))
      no("document_digest");
  }
  if (manifest.chunkDigest !== (await digestRows("parsed-chunks:v1", await chunkDigestRows(chunks))))
    no("chunk_digest");
  if (
    manifest.retainedTextHash !== text.textHash ||
    manifest.retainedTextUtf8Length !== textBytes ||
    manifest.retainedTextUtf16Length !== completeText.length
  )
    no("retained_text_fields");
  return {
    actualPageCount: pages.length,
    actualEvidenceSpanCount: spans.length,
    actualDocumentCount: documents.length,
    actualChunkCount: chunks.length,
    actualEventCount: 0,
    actualObservationCount: 0,
    verifiedDocuments: documents,
    verifiedChunks: chunks,
  };
}
