// Ported from packages/convex/convex/models/documents/model.ts (P2-39d2):
// the read surface, `getDocument` and `searchDocuments`. P2-39e adds
// `listSources` and its bounded source-account metadata below.
//
// Convex's `withSearchIndex("by_text", ...)` keyword leg becomes a full-text
// predicate over `chunks.text_search` (migration 006's generated `tsvector`
// column), ranked by `ts_rank`; every other Convex index lookup here becomes a
// `SELECT ... WHERE id = $1` through this package's usual camelizers. P2-39g1
// built that predicate with `websearch_to_tsquery`; P2-39g4 moved it to the
// shared partial-overlap construction in `../textSearch.ts` after the recall
// instrument measured what AND-of-terms costs (see that module and
// docs/retrieval-parity-postgres.md). `ctx.db.get` calls that were `Promise.all`'d
// in the original run sequentially instead, exactly as `model.ts` already
// does elsewhere in this package: one `pg` client serializes queries over
// one connection, so `Promise.all` on it adds nothing but a lint warning.
//
// `effectiveDocType` is section 4.2 of docs/plans/2026-09-12-document-cards.md
// and P2-80i unchanged: an active document's type is the item's live card
// kind (`sourceItems.cardDocType`, migration 006) when one exists, and the
// parser's own `documents.docType` otherwise, read at query time rather than
// patched onto the sealed `documents` row -- patching it would change
// `manifest.documentDigest` and break `verifySealedParsedPayload` for every
// document a card had refined.
//
// This is a lower-level data service. Its callers must authenticate and derive
// `spaceIds` from current grants before calling it; the array narrows reads but
// is not an authorization decision. Callers that need a repeatable read across
// several service calls must also provide a client inside their own transaction.
// PostgreSQL values are surfaced as `Date`; the HTTP/MCP adapter serializes
// them to ISO timestamps, whereas the Convex surface serialized its millisecond
// numbers at that outer boundary. `ts_rank` supplies deterministic PostgreSQL
// keyword ordering only. It is not claimed to reproduce Convex search scores;
// retrieval-rank parity remains row g's acceptance work.

import type { ClientBase, QueryResultRow } from "pg";

import {
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
} from "../provenance/representations.js";
import { loadProviderOriginalReference } from "../provenance/providerOriginals.js";
import { spacePredicate } from "../spaces.js";
import { keywordSearchSql } from "../textSearch.js";
import { camelizeSourceAccount } from "../workers/rows.js";
import {
  camelizeChunk,
  camelizeDocument,
  camelizeEvidenceSpan,
  camelizeProcessingGeneration,
  camelizeSourceArtifactArchiveReceipt,
  camelizeSourceItem,
  camelizeSourcePage,
  camelizeSourceRevision,
  camelizeSourceTextVersion,
  type ChunkRow,
  type DocumentRow,
  type EvidenceLocator,
  type EvidenceSpanRow,
  type ProcessingGenerationRow,
  type PublicationState,
  type SourceItemRow,
  type SourcePageRow,
  type SourceRevisionRow,
  type SourceTextVersionRow,
} from "../provenance/rows.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_READ_SPACES = 32;
const MAX_SEARCH_CANDIDATES = 64;
const MAX_RESULTS_PER_DOCUMENT = 3;
const MAX_CITATIONS_PER_RESULT = 16;
const MAX_CITATION_OUTPUT_BYTES = 256 * 1024;
const MAX_PAGES = 64;
const MAX_EVIDENCE_SPANS = 256;
const MAX_SOURCE_ACCOUNTS = 32;
const MAX_SOURCE_ITEMS = 128;
const MAX_SOURCE_METADATA_ROWS = 128;
const MAX_QUERY_LENGTH = 500;
const DOCUMENT_FUSION_RRF_K = 60;
const DOCUMENT_FUSION_KEYWORD_WEIGHT = 1;
const DOCUMENT_FUSION_SEMANTIC_WEIGHT = 1.25;

/**
 * P2-70j: one semantic candidate that is a document card rather than a
 * chunk. It answers "find the document" rather than "find the passage", so
 * it carries the card's extractive summary as its passage, the live card
 * generation as its evidence pointer and the card's own evidence spans. No
 * caller in this row produces one yet (cards are row f); the shape is
 * ported so a later row is a repoint, not a rewrite.
 */
export type CardSearchHit = {
  eventId: string;
  spaceId: string;
  documentId: string;
  cardGenerationId: string;
  summary: string;
  evidenceSpanIds: string[];
};

type SearchCandidate = {
  publicationState: PublicationState;
  rank: number;
  key: string;
  chunk?: ChunkRow;
  card?: CardSearchHit;
};

export type CitationOutput = {
  evidenceSpanId: string;
  sourcePageId: string;
  sourceTextVersionId: string;
  sourceRevisionId: string;
  pageOrdinal: number;
  start: number;
  end: number;
  quote: string;
  quoteHash: string;
  locator: EvidenceLocator | null;
};

class CitationOutputBudget {
  // Reserve opening/closing delimiters for every possible per-page or
  // per-result citation array. Each admitted citation also reserves a
  // comma; over-reserving the first item keeps admission order-independent.
  private used = 2 * Math.max(MAX_PAGES, MAX_LIMIT + 1);

  include(value: unknown): boolean {
    const size = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    if (size > MAX_CITATION_OUTPUT_BYTES - this.used) return false;
    this.used += size;
    return true;
  }
}

export function fuseDocumentCandidateRanks(
  keywordCandidates: readonly { id: string; rank: number }[],
  semanticCandidates: readonly { id: string; rank: number }[],
): Map<string, number> {
  const scores = new Map<string, number>(
    keywordCandidates.map(({ id, rank }) => [
      id,
      DOCUMENT_FUSION_KEYWORD_WEIGHT / (DOCUMENT_FUSION_RRF_K + rank + 1),
    ]),
  );
  for (const { id, rank } of semanticCandidates) {
    scores.set(
      id,
      (scores.get(id) ?? 0) + DOCUMENT_FUSION_SEMANTIC_WEIGHT / (DOCUMENT_FUSION_RRF_K + rank + 1),
    );
  }
  return scores;
}

export function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

export function validateSpaces(spaceIds: readonly string[]): void {
  if (spaceIds.length > MAX_READ_SPACES) {
    throw new Error(`Document reads support at most ${MAX_READ_SPACES} spaces`);
  }
}

function validateTimeRange(from: number | undefined, to: number | undefined): void {
  if (from !== undefined && !Number.isFinite(from)) throw new Error("from must be finite");
  if (to !== undefined && !Number.isFinite(to)) throw new Error("to must be finite");
  if (from !== undefined && to !== undefined && from >= to) {
    throw new Error("Time ranges must satisfy from < to");
  }
}

function inTimeRange(value: number, from: number | undefined, to: number | undefined): boolean {
  return (from === undefined || value >= from) && (to === undefined || value < to);
}

function retainedLifecycle(item: SourceItemRow): boolean {
  return item.lifecycle === "available" || item.lifecycle === "unavailable";
}

function sourceStatus(
  item: SourceItemRow,
  generation: ProcessingGenerationRow,
  publicationState: PublicationState,
): "historical" | "stale" | "ready" {
  if (publicationState === "historical") return "historical";
  if (
    item.activeGenerationId !== generation.id ||
    item.desiredRevisionId !== item.activeRevisionId ||
    generation.desiredProcessingEpoch !== item.desiredProcessingEpoch ||
    item.lastFailure !== null
  ) {
    return "stale";
  }
  return "ready";
}

async function getRow<T>(
  client: ClientBase,
  table: string,
  id: string,
  camelizeRow: (row: Record<string, unknown>) => T,
): Promise<T | undefined> {
  const result = await client.query<QueryResultRow>(`SELECT * FROM kith.${table} WHERE id = $1`, [id]);
  return result.rowCount === 1 ? camelizeRow(result.rows[0]!) : undefined;
}

type SourceAccountRow = { id: string; spaceId: string };

async function getSourceAccount(client: ClientBase, id: string): Promise<SourceAccountRow | undefined> {
  const result = await client.query<{ id: string; space_id: string }>(
    `SELECT id, space_id FROM kith.source_accounts WHERE id = $1`,
    [id],
  );
  return result.rowCount === 1 ? { id: result.rows[0]!.id, spaceId: result.rows[0]!.space_id } : undefined;
}

type ReadableDocumentChain = {
  item: SourceItemRow;
  revision: SourceRevisionRow;
  textVersion: SourceTextVersionRow;
  generation: ProcessingGenerationRow;
  account: SourceAccountRow;
};

async function loadReadableDocument(
  client: ClientBase,
  document: DocumentRow,
  spaceIds: ReadonlySet<string>,
  includeHistorical: boolean,
): Promise<ReadableDocumentChain | null> {
  if (!spaceIds.has(document.spaceId) || document.publicationState === "staged") return null;
  if (document.publicationState === "historical" && !includeHistorical) return null;
  const item = await getRow(client, "source_items", document.sourceItemId, camelizeSourceItem);
  if (!item) return null;
  const revision = await getRow(client, "source_revisions", document.sourceRevisionId, camelizeSourceRevision);
  const textVersion = await getRow(client, "source_text_versions", document.sourceTextVersionId, camelizeSourceTextVersion);
  const generation = await getRow(client, "processing_generations", document.processingGenerationId, camelizeProcessingGeneration);
  const account = await getSourceAccount(client, item.sourceAccountId);
  if (
    !revision ||
    !textVersion ||
    !generation ||
    !account ||
    !retainedLifecycle(item) ||
    item.spaceId !== document.spaceId ||
    account.spaceId !== document.spaceId ||
    revision.spaceId !== document.spaceId ||
    textVersion.spaceId !== document.spaceId ||
    generation.spaceId !== document.spaceId ||
    generation.sourceAccountId !== account.id ||
    revision.sourceItemId !== item.id ||
    textVersion.sourceRevisionId !== revision.id ||
    !textVersion.evidenceSealed ||
    generation.sourceItemId !== item.id ||
    generation.sourceRevisionId !== revision.id ||
    generation.sourceTextVersionId !== textVersion.id ||
    generation.state !== "ready"
  ) {
    return null;
  }
  try {
    const revisionRepresentation = parseSourceRevisionRepresentation(revision);
    const textRepresentation = parseSourceTextRepresentation(textVersion);
    if (
      (revisionRepresentation.kind === "inline_utf8_v1" && textRepresentation.kind !== "inline_text_v1") ||
      (revisionRepresentation.kind === "archived_binary_v1" &&
        (textRepresentation.kind !== "parsed_pages_v1" ||
          !textRepresentation.sealed ||
          textRepresentation.hashAuthority !== "server_verified_retained_text" ||
          generation.parserArtifactId !== textRepresentation.parserArtifactId))
    )
      return null;
  } catch {
    return null;
  }
  if (
    document.publicationState === "active" &&
    (item.activeGenerationId !== generation.id ||
      item.activeRevisionId !== revision.id ||
      generation.deactivatedAt !== null)
  ) {
    return null;
  }
  if (
    document.publicationState === "historical" &&
    (generation.activatedAt === null || generation.deactivatedAt === null)
  ) {
    return null;
  }
  return { item, revision, textVersion, generation, account };
}

/**
 * Section 4.2 of docs/plans/2026-09-12-document-cards.md: a document's type
 * is the accepted `card_kind` of the item's live card when there is one, and
 * the parser's own `documents.docType` otherwise, so type filtering and the
 * card cannot disagree.
 *
 * P2-80i: the card kind is read from the item here rather than written onto
 * the document row -- see the module header. Only an active document takes
 * the overlay; a historical row keeps the type its own generation parsed.
 */
export function effectiveDocType(document: DocumentRow, item: SourceItemRow): string | undefined {
  return document.publicationState === "active" && item.cardDocType !== null
    ? item.cardDocType
    : (document.docType ?? undefined);
}

type OriginalRecoveryStatus =
  | { kind: "archive_pair_v1"; primary: boolean; independentBackup: boolean }
  | {
      kind: "provider_original_v1";
      localPrimaryArchived: true;
      providerVerification: "verified_at_admission" | "audit_unavailable";
      verifiedAt: number;
      continuousAvailability: false;
      desktopRecoveryRequired: true;
    };

async function originalRecoveryStatus(
  client: ClientBase,
  generation: ProcessingGenerationRow,
): Promise<OriginalRecoveryStatus | undefined> {
  async function receiptMatches(id: string | null, copyRole: "primary" | "independent_backup"): Promise<boolean> {
    const receipt = id
      ? await getRow(client, "source_artifact_archive_receipts", id, camelizeSourceArtifactArchiveReceipt)
      : undefined;
    return Boolean(
      receipt &&
        receipt.spaceId === generation.spaceId &&
        receipt.sourceAccountId === generation.sourceAccountId &&
        receipt.sourceItemId === generation.sourceItemId &&
        receipt.sourceRevisionId === generation.sourceRevisionId &&
        receipt.subjectKind === "original_bytes" &&
        receipt.copyRole === copyRole &&
        receipt.parserArtifactId === null,
    );
  }
  if (generation.originalPrimaryReceiptId === null || generation.archiveSetDigest === null) return undefined;
  if (generation.originalBackupReceiptId !== null) {
    if (generation.originalProviderReferenceId !== null || generation.originalProviderBindingEpoch !== null) {
      return undefined;
    }
    const primary = await receiptMatches(generation.originalPrimaryReceiptId, "primary");
    const independentBackup = await receiptMatches(generation.originalBackupReceiptId, "independent_backup");
    return { kind: "archive_pair_v1", primary, independentBackup };
  }
  if (generation.originalProviderReferenceId === null || generation.originalProviderBindingEpoch === null) {
    return undefined;
  }
  const primaryOk = await receiptMatches(generation.originalPrimaryReceiptId, "primary");
  const reference = await getRow(
    client,
    "source_provider_original_references",
    generation.originalProviderReferenceId,
    (row) => ({
      id: row.id as string,
      spaceId: row.space_id as string,
      sourceAccountId: row.source_account_id as string,
      sourceItemId: row.source_item_id as string,
      sourceRevisionId: row.source_revision_id as string,
      verifiedAt: (row.verified_at as Date).getTime(),
    }),
  );
  if (
    !primaryOk ||
    !reference ||
    reference.spaceId !== generation.spaceId ||
    reference.sourceAccountId !== generation.sourceAccountId ||
    reference.sourceItemId !== generation.sourceItemId ||
    reference.sourceRevisionId !== generation.sourceRevisionId
  )
    return undefined;
  let hasAdmissionAudit = false;
  try {
    await loadProviderOriginalReference(client, {
      referenceId: reference.id,
      spaceId: generation.spaceId,
      sourceAccountId: generation.sourceAccountId,
      sourceItemId: generation.sourceItemId,
      sourceRevisionId: generation.sourceRevisionId,
    });
    hasAdmissionAudit = true;
  } catch {
    // A corrupt immutable reference is reported without exposing provider data.
  }
  return {
    kind: "provider_original_v1",
    localPrimaryArchived: true,
    providerVerification: hasAdmissionAudit ? "verified_at_admission" : "audit_unavailable",
    verifiedAt: reference.verifiedAt,
    continuousAvailability: false,
    desktopRecoveryRequired: true,
  };
}

async function hydrateCitations(
  client: ClientBase,
  evidenceSpanIds: readonly string[],
  expected: { spaceId: string; sourceRevisionId: string; sourceTextVersionId: string },
  budget: CitationOutputBudget,
  cache?: { spans: Map<string, EvidenceSpanRow | undefined>; pages: Map<string, SourcePageRow | undefined> },
): Promise<{
  citations: CitationOutput[];
  citationsTruncated: boolean;
  invalidCitations: boolean;
  byteBudgetTruncated: boolean;
}> {
  const ids = [...new Set(evidenceSpanIds)].slice(0, MAX_CITATIONS_PER_RESULT);
  const spans: Array<EvidenceSpanRow | undefined> = [];
  const pages: Array<SourcePageRow | undefined> = [];
  for (const id of ids) {
    let span = cache?.spans.get(id);
    if (span === undefined && !cache?.spans.has(id)) {
      span = await getRow(client, "evidence_spans", id, camelizeEvidenceSpan);
      cache?.spans.set(id, span);
    }
    spans.push(span);
    if (!span) {
      pages.push(undefined);
      continue;
    }
    let page = cache?.pages.get(span.sourcePageId);
    if (page === undefined && !cache?.pages.has(span.sourcePageId)) {
      page = await getRow(client, "source_pages", span.sourcePageId, camelizeSourcePage);
      cache?.pages.set(span.sourcePageId, page);
    }
    pages.push(page);
  }
  const citations: CitationOutput[] = [];
  let invalidCitations = false;
  let byteBudgetTruncated = false;
  for (const [index, span] of spans.entries()) {
    const page = pages[index];
    if (
      !span ||
      !page ||
      span.spaceId !== expected.spaceId ||
      span.sourceRevisionId !== expected.sourceRevisionId ||
      span.sourceTextVersionId !== expected.sourceTextVersionId ||
      page.spaceId !== expected.spaceId ||
      page.sourceTextVersionId !== expected.sourceTextVersionId ||
      span.sourcePageId !== page.id ||
      span.start < 0 ||
      span.end < span.start ||
      span.end > page.text.length
    ) {
      invalidCitations = true;
      continue;
    }
    const citation: CitationOutput = {
      evidenceSpanId: span.id,
      sourcePageId: page.id,
      sourceTextVersionId: span.sourceTextVersionId,
      sourceRevisionId: span.sourceRevisionId,
      pageOrdinal: page.ordinal,
      start: span.start,
      end: span.end,
      quote: page.text.slice(span.start, span.end),
      quoteHash: span.quoteHash,
      locator: span.locator,
    };
    if (!budget.include(citation)) {
      byteBudgetTruncated = true;
      continue;
    }
    citations.push(citation);
  }
  return {
    citations,
    citationsTruncated: evidenceSpanIds.length > MAX_CITATIONS_PER_RESULT || byteBudgetTruncated,
    invalidCitations,
    byteBudgetTruncated,
  };
}

export type SearchDocumentsResult = {
  spaceId: string;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  processingGenerationId: string;
  documentId: string;
  chunkId?: string;
  cardEventId?: string;
  cardGenerationId?: string;
  title: string;
  docType: string | undefined;
  capturedAt: Date;
  snippet: string;
  historical: boolean;
  contentStatus: "historical" | "stale" | "ready";
  sourceAvailability: string;
  originalLinkAvailable: boolean | null;
  retainedTextAvailable: true;
  originalRecovery?: OriginalRecoveryStatus;
  vectorStatus: "ready" | "unavailable";
  citations: CitationOutput[];
  citationsTruncated: boolean;
};

/** One partition's worth of keyword candidates: `LIMIT remaining + 1` over
 * `chunks.text_search`, ranked by `ts_rank`, exactly mirroring Convex's
 * `.take(remainingCandidates + 1)` over its `by_text` search index.
 *
 * P2-39g4 replaced this leg's `websearch_to_tsquery` with the shared partial
 * overlap construction in `../textSearch.ts`, which every keyword leg in this
 * package now uses. `websearch_to_tsquery` ANDs every significant token, so
 * one ordinary query word the chunk happens not to contain dropped the chunk
 * outright; the shared helper ORs the query's own stemmed lexemes and ranks so
 * that a chunk matching more of them sorts first. The take, the partition and
 * the `id ASC` tiebreak are unchanged. See that module for why `ts_rank`'s
 * default normalization is the right rank here and `ts_rank_cd` is not. */
async function keywordCandidates(
  client: ClientBase,
  spaceId: string,
  publicationState: PublicationState,
  query: string,
  limit: number,
): Promise<ChunkRow[]> {
  const keyword = keywordSearchSql("text_search", 3);
  const result = await client.query<QueryResultRow>(
    `SELECT * FROM kith.chunks
      WHERE space_id = $1 AND publication_state = $2
        AND ${keyword.match}
      ORDER BY ${keyword.rank} DESC, id ASC
      LIMIT $4`,
    [spaceId, publicationState, query, limit],
  );
  return result.rows.map((row) => camelizeChunk(row));
}

export async function searchDocuments(
  client: ClientBase,
  spaceIds: readonly string[],
  args: {
    query: string;
    docType?: string;
    from?: number;
    to?: number;
    limit?: number;
    includeHistorical?: boolean;
  },
  semantic?: {
    chunkIds: readonly string[];
    /** Card candidates, already rechecked against the live card generation. */
    cardHits?: readonly CardSearchHit[];
    vectorStatus: "ready" | "unavailable";
    /** Chunk targets the active fingerprint still owes (D3 B). */
    coverageIncomplete?: boolean;
  },
): Promise<{
  results: SearchDocumentsResult[];
  vectorStatus: "ready" | "unavailable";
  partial: boolean;
  truncated: boolean;
}> {
  validateSpaces(spaceIds);
  validateTimeRange(args.from, args.to);
  const query = args.query.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) throw new Error("query is invalid");
  const limit = boundedLimit(args.limit);
  const states: PublicationState[] = args.includeHistorical ? ["active", "historical"] : ["active"];
  const partitions = states.flatMap((publicationState) =>
    [...spaceIds].sort((left, right) => left.localeCompare(right)).map((spaceId) => ({ spaceId, publicationState })),
  );
  let candidateOverflow = false;
  const semanticReady = semantic?.vectorStatus === "ready";
  const keywordBudget = semanticReady ? MAX_SEARCH_CANDIDATES / 2 : MAX_SEARCH_CANDIDATES;
  let remainingCandidates = keywordBudget;
  const candidates: SearchCandidate[] = [];
  for (let partitionIndex = 0; partitionIndex < partitions.length; partitionIndex += 1) {
    const partition = partitions[partitionIndex]!;
    if (remainingCandidates === 0) {
      candidateOverflow = true;
      break;
    }
    const rows = await keywordCandidates(client, partition.spaceId, partition.publicationState, query, remainingCandidates + 1);
    if (rows.length > remainingCandidates) candidateOverflow = true;
    const accepted = rows.slice(0, remainingCandidates);
    remainingCandidates -= accepted.length;
    candidates.push(
      ...accepted.map((chunk, rank) => ({
        chunk,
        key: chunk.id,
        publicationState: partition.publicationState,
        rank: partitionIndex * MAX_SEARCH_CANDIDATES + rank,
      })),
    );
  }
  if (semanticReady) {
    const keywordCandidateRanks = candidates.map((candidate) => ({ id: candidate.key, rank: candidate.rank }));
    const seen = new Set(candidates.map((candidate) => candidate.key));
    const cardHits = (semantic!.cardHits ?? []).slice(0, keywordBudget);
    const ids = [...new Set(semantic!.chunkIds)].slice(0, keywordBudget);
    candidateOverflow ||=
      semantic!.chunkIds.length > keywordBudget || (semantic!.cardHits?.length ?? 0) > keywordBudget;
    const semanticCandidates: Array<{ id: string; rank: number }> = [];
    let rank = 0;
    for (const id of ids) {
      const chunk = await getRow(client, "chunks", id, camelizeChunk);
      if (!chunk || chunk.publicationState !== "active") continue;
      semanticCandidates.push({ id, rank: rank++ });
      if (!seen.has(id)) {
        candidates.push({ chunk, key: id, publicationState: "active", rank: 0 });
        seen.add(id);
      }
    }
    for (const card of cardHits) {
      const key = `card:${card.eventId}:${card.documentId}`;
      semanticCandidates.push({ id: key, rank: rank++ });
      if (!seen.has(key)) {
        candidates.push({ card, key, publicationState: "active", rank: 0 });
        seen.add(key);
      }
    }
    const ranks = fuseDocumentCandidateRanks(keywordCandidateRanks, semanticCandidates);
    for (const candidate of candidates) {
      candidate.rank = -(ranks.get(candidate.key) ?? 0);
    }
  }
  candidates.sort(
    (left, right) =>
      (left.publicationState === right.publicationState ? 0 : left.publicationState === "active" ? -1 : 1) ||
      left.rank - right.rank ||
      left.key.localeCompare(right.key),
  );

  const authorized = new Set(spaceIds);
  const resultCountByDocument = new Map<string, number>();
  const returnedChunks = new Set<string>();
  const chainCache = new Map<string, ReadableDocumentChain | null>();
  const citationCache = {
    spans: new Map<string, EvidenceSpanRow | undefined>(),
    pages: new Map<string, SourcePageRow | undefined>(),
  };
  const citationBudget = new CitationOutputBudget();
  const results: SearchDocumentsResult[] = [];
  let citationPartial = false;
  for (const candidate of candidates) {
    if (results.length > limit) break;
    const chunk = candidate.chunk;
    const card = candidate.card;
    const document = chunk
      ? await getRow(client, "documents", chunk.documentId, camelizeDocument)
      : await getRow(client, "documents", card!.documentId, camelizeDocument);
    if (
      !document ||
      (chunk
        ? chunk.publicationState !== candidate.publicationState ||
          chunk.spaceId !== document.spaceId ||
          document.processingGenerationId !== chunk.processingGenerationId ||
          document.publicationState !== chunk.publicationState ||
          returnedChunks.has(chunk.id)
        : document.spaceId !== card!.spaceId || document.publicationState !== "active") ||
      (resultCountByDocument.get(document.id) ?? 0) >= MAX_RESULTS_PER_DOCUMENT ||
      !inTimeRange(document.capturedAt.getTime(), args.from, args.to)
    ) {
      continue;
    }
    let chain = chainCache.get(document.id);
    if (chain === undefined) {
      chain = await loadReadableDocument(client, document, authorized, args.includeHistorical ?? false);
      chainCache.set(document.id, chain);
    }
    if (!chain) continue;
    const docType = effectiveDocType(document, chain.item);
    if (args.docType !== undefined && docType !== args.docType) continue;
    const citationResult = await hydrateCitations(
      client,
      chunk ? chunk.evidenceSpanIds : card!.evidenceSpanIds,
      { spaceId: document.spaceId, sourceRevisionId: document.sourceRevisionId, sourceTextVersionId: document.sourceTextVersionId },
      citationBudget,
      citationCache,
    );
    citationPartial ||= citationResult.invalidCitations || citationResult.byteBudgetTruncated;
    if (chunk) returnedChunks.add(chunk.id);
    resultCountByDocument.set(document.id, (resultCountByDocument.get(document.id) ?? 0) + 1);
    const recovery = await originalRecoveryStatus(client, chain.generation);
    results.push({
      spaceId: document.spaceId,
      sourceAccountId: chain.account.id,
      sourceItemId: chain.item.id,
      sourceRevisionId: chain.revision.id,
      sourceTextVersionId: chain.textVersion.id,
      processingGenerationId: chain.generation.id,
      documentId: document.id,
      chunkId: chunk?.id,
      cardEventId: card?.eventId,
      cardGenerationId: card?.cardGenerationId,
      title: document.title,
      docType,
      capturedAt: document.capturedAt,
      snippet: chunk ? chunk.text : card!.summary,
      historical: document.publicationState === "historical",
      contentStatus: sourceStatus(chain.item, chain.generation, document.publicationState),
      sourceAvailability: chain.item.lifecycle,
      originalLinkAvailable: chain.item.originalLinkAvailable,
      retainedTextAvailable: true,
      ...(recovery ? { originalRecovery: recovery } : {}),
      vectorStatus: semanticReady ? "ready" : "unavailable",
      citations: citationResult.citations,
      citationsTruncated: citationResult.citationsTruncated,
    });
  }
  const truncated = results.length > limit;
  return {
    results: results.slice(0, limit),
    vectorStatus: semanticReady ? "ready" : "unavailable",
    partial: candidateOverflow || citationPartial || (semanticReady && semantic?.coverageIncomplete === true),
    truncated,
  };
}

export type GetDocumentResult = {
  spaceId: string;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  sourceTextVersionId: string;
  processingGenerationId: string;
  documentId: string;
  title: string;
  docType: string | undefined;
  capturedAt: Date;
  historical: boolean;
  contentStatus: "historical" | "stale" | "ready";
  sourceAvailability: string;
  originalLinkAvailable: boolean | null;
  originalUri: string | null;
  retainedTextAvailable: true;
  originalRecovery?: OriginalRecoveryStatus;
  archiveRef: string | null;
  contentHash: string;
  contentHashAuthority: "worker_asserted" | "server_verified_utf8";
  textHash: string;
  textHashAuthority: "server_verified_retained_text";
  pages: Array<{
    sourcePageId: string;
    ordinal: number;
    start: number;
    end: number;
    text: string;
    textHash: string;
    evidence: Array<{
      evidenceSpanId: string;
      ordinal: number;
      start: number;
      end: number;
      quote: string;
      quoteHash: string;
      locator: EvidenceLocator | null;
    }>;
  }>;
  evidenceSpanIds: string[];
  partial: boolean;
  vectorStatus: "unavailable";
};

export async function getDocument(
  client: ClientBase,
  spaceIds: readonly string[],
  documentId: string,
  includeHistorical = false,
): Promise<GetDocumentResult | null> {
  validateSpaces(spaceIds);
  const document = await getRow(client, "documents", documentId, camelizeDocument);
  if (!document) return null;
  const chain = await loadReadableDocument(client, document, new Set(spaceIds), includeHistorical);
  if (!chain) return null;
  const pageResult = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_pages WHERE source_text_version_id = $1 LIMIT $2`,
    [chain.textVersion.id, MAX_PAGES + 1],
  );
  const spanResult = await client.query<QueryResultRow>(
    `SELECT * FROM kith.evidence_spans WHERE source_text_version_id = $1 LIMIT $2`,
    [chain.textVersion.id, MAX_EVIDENCE_SPANS + 1],
  );
  if (pageResult.rowCount! > MAX_PAGES || spanResult.rowCount! > MAX_EVIDENCE_SPANS) {
    throw new Error("Document content exceeds the supported read bounds");
  }
  const pageRows = pageResult.rows.map((row) => camelizeSourcePage(row));
  const spanRows = spanResult.rows.map((row) => camelizeEvidenceSpan(row));
  const allowedEvidence = new Set(document.evidenceSpanIds);
  const citationBudget = new CitationOutputBudget();
  let citationBudgetTruncated = false;
  const pages = pageRows
    .filter((page) => page.spaceId === document.spaceId && page.sourceTextVersionId === chain.textVersion.id)
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .map((page) => ({
      sourcePageId: page.id,
      ordinal: page.ordinal,
      start: page.start,
      end: page.end,
      text: page.text,
      textHash: page.textHash,
      evidence: spanRows
        .filter(
          (span) =>
            allowedEvidence.has(span.id) &&
            span.sourcePageId === page.id &&
            span.spaceId === document.spaceId &&
            span.sourceRevisionId === chain.revision.id &&
            span.sourceTextVersionId === chain.textVersion.id &&
            span.start >= 0 &&
            span.end >= span.start &&
            span.end <= page.text.length,
        )
        .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
        .flatMap((span) => {
          const evidence = {
            evidenceSpanId: span.id,
            ordinal: span.ordinal,
            start: span.start,
            end: span.end,
            quote: page.text.slice(span.start, span.end),
            quoteHash: span.quoteHash,
            locator: span.locator,
          };
          if (!citationBudget.include(evidence)) {
            citationBudgetTruncated = true;
            return [];
          }
          return [evidence];
        }),
    }));
  const validatedEvidenceSpanIds = pages.flatMap((page) => page.evidence.map((span) => span.evidenceSpanId));
  const partial =
    pages.length !== pageRows.length || validatedEvidenceSpanIds.length !== allowedEvidence.size || citationBudgetTruncated;
  const recovery = await originalRecoveryStatus(client, chain.generation);
  return {
    spaceId: document.spaceId,
    sourceAccountId: chain.account.id,
    sourceItemId: chain.item.id,
    sourceRevisionId: chain.revision.id,
    sourceTextVersionId: chain.textVersion.id,
    processingGenerationId: chain.generation.id,
    documentId: document.id,
    title: document.title,
    docType: effectiveDocType(document, chain.item),
    capturedAt: document.capturedAt,
    historical: document.publicationState === "historical",
    contentStatus: sourceStatus(chain.item, chain.generation, document.publicationState),
    sourceAvailability: chain.item.lifecycle,
    originalLinkAvailable: chain.item.originalLinkAvailable,
    originalUri: chain.item.uri,
    retainedTextAvailable: true,
    ...(recovery ? { originalRecovery: recovery } : {}),
    archiveRef: chain.revision.archiveRef,
    contentHash: chain.revision.contentHash,
    contentHashAuthority: chain.revision.representation === "archived_binary_v1" ? "worker_asserted" : "server_verified_utf8",
    textHash: chain.textVersion.textHash,
    textHashAuthority: "server_verified_retained_text",
    pages,
    evidenceSpanIds: validatedEvidenceSpanIds,
    partial,
    vectorStatus: "unavailable",
  };
}

type MetadataBudget = { remaining: number; overflow: boolean };

function numberValue(value: unknown): number {
  return Number(value);
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

async function sourceAccountMetadata(
  client: ClientBase,
  account: ReturnType<typeof camelizeSourceAccount>,
  asOf: number,
  budget: MetadataBudget,
) {
  async function take(sql: string, values: unknown[]) {
    if (budget.remaining === 0) {
      budget.overflow = true;
      return [];
    }
    const result = await client.query<QueryResultRow>(sql, [...values, budget.remaining + 1]);
    if (result.rows.length > budget.remaining) budget.overflow = true;
    const accepted = result.rows.slice(0, budget.remaining);
    budget.remaining -= accepted.length;
    return accepted;
  }

  let pendingJobs = 0;
  let failedJobs = 0;
  let invalidJobParent = false;
  const jobStates = ["queued", "processing", "staged", "failed", "needs_review"] as const;
  for (const state of jobStates) {
    const jobs = await take(
      `SELECT j.*, i.id AS parent_id, i.space_id AS parent_space_id,
              i.source_account_id AS parent_source_account_id, i.lifecycle AS parent_lifecycle,
              i.desired_revision_id AS parent_desired_revision_id,
              i.desired_processing_epoch AS parent_desired_processing_epoch
         FROM kith.ingest_jobs j LEFT JOIN kith.source_items i ON i.id = j.source_item_id
        WHERE j.source_account_id = $1 AND j.state = $2 ORDER BY j.created_at, j.id LIMIT $3`,
      [account.id, state],
    );
    for (const job of jobs) {
      if (
        job.space_id !== account.spaceId || job.parent_id === null ||
        job.parent_space_id !== account.spaceId || job.parent_source_account_id !== account.id
      ) {
        invalidJobParent = true;
        continue;
      }
      if (
        job.parent_lifecycle === "forgetting" || job.parent_lifecycle === "forgotten" ||
        job.source_revision_id !== job.parent_desired_revision_id ||
        numberValue(job.desired_processing_epoch) !== numberValue(job.parent_desired_processing_epoch)
      ) continue;
      if (state === "queued" || state === "processing" || state === "staged") pendingJobs += 1;
      else failedJobs += 1;
    }
  }

  const fetches = await take(
    `SELECT f.*, i.id AS parent_id, i.space_id AS parent_space_id,
            i.source_account_id AS parent_source_account_id, i.lifecycle AS parent_lifecycle
       FROM kith.source_fetch_requests f LEFT JOIN kith.source_items i ON i.id = f.source_item_id
      WHERE f.source_account_id = $1 ORDER BY f.created_at, f.id LIMIT $2`,
    [account.id],
  );
  for (const fetch of fetches) {
    if (
      fetch.space_id !== account.spaceId || fetch.parent_id === null ||
      fetch.parent_space_id !== account.spaceId || fetch.parent_source_account_id !== account.id
    ) invalidJobParent = true;
    else if (fetch.parent_lifecycle !== "forgetting" && fetch.parent_lifecycle !== "forgotten") pendingJobs += 1;
  }

  let invalidCoverageParent = false;
  const windows = await take(
    `SELECT w.*, e.id AS parent_entity_id, e.space_id AS parent_entity_space_id
       FROM kith.coverage_windows w LEFT JOIN kith.entities e ON e.id = w.entity_id
      WHERE w.source_account_id = $1 ORDER BY w.created_at, w.id LIMIT $2`,
    [account.id],
  );
  const validWindows = windows.filter((window) => {
    const valid = window.space_id === account.spaceId &&
      (window.entity_id === null || (window.parent_entity_id !== null && window.parent_entity_space_id === account.spaceId));
    if (!valid) invalidCoverageParent = true;
    return valid;
  });
  const gaps = await take(
    `SELECT g.*, e.id AS parent_entity_id, e.space_id AS parent_entity_space_id
       FROM kith.coverage_gaps g LEFT JOIN kith.entities e ON e.id = g.entity_id
      WHERE g.source_account_id = $1 AND g.status = 'open' ORDER BY g.created_at, g.id LIMIT $2`,
    [account.id],
  );
  const validGaps = gaps.filter((gap) => {
    const valid = gap.space_id === account.spaceId &&
      (gap.entity_id === null || (gap.parent_entity_id !== null && gap.parent_entity_space_id === account.spaceId));
    if (!valid) invalidCoverageParent = true;
    return valid;
  });

  const freshnessMs = account.freshnessMs ?? 0;
  return {
    pendingJobs,
    failedJobs,
    overflow: budget.overflow || invalidCoverageParent || invalidJobParent,
    windows: validWindows
      .slice(0, MAX_SOURCE_METADATA_ROWS)
      .sort((left, right) => dateValue(left.from).getTime() - dateValue(right.from).getTime() || String(left.id).localeCompare(String(right.id)))
      .map((window) => {
        const lastEnumeratedAt = dateValue(window.last_enumerated_at);
        const lastProcessedAt = dateValue(window.last_processed_at);
        return {
          coverageWindowId: String(window.id), recordType: String(window.record_type),
          ...(window.entity_id === null ? {} : { entityId: String(window.entity_id) }),
          from: dateValue(window.from), to: dateValue(window.to), state: String(window.state),
          lastEnumeratedAt, lastProcessedAt,
          fresh: account.enabled === true &&
            (account.coverageInvalidatedAt === null ||
              (lastEnumeratedAt > account.coverageInvalidatedAt && lastProcessedAt > account.coverageInvalidatedAt)) &&
            lastEnumeratedAt.getTime() <= asOf && lastProcessedAt.getTime() <= asOf &&
            lastEnumeratedAt.getTime() >= asOf - freshnessMs && lastProcessedAt.getTime() >= asOf - freshnessMs,
          discoveredCount: numberValue(window.discovered_count), indexedCount: numberValue(window.indexed_count),
          skippedCount: numberValue(window.skipped_count),
        };
      }),
    gaps: validGaps
      .slice(0, MAX_SOURCE_METADATA_ROWS)
      .sort((left, right) => dateValue(left.detected_at).getTime() - dateValue(right.detected_at).getTime() || String(left.id).localeCompare(String(right.id)))
      .map((gap) => ({
        coverageGapId: String(gap.id), recordType: String(gap.record_type),
        ...(gap.entity_id === null ? {} : { entityId: String(gap.entity_id) }),
        ...(gap.from === null ? {} : { from: dateValue(gap.from), to: dateValue(gap.to) }),
        reason: String(gap.reason), detectedAt: dateValue(gap.detected_at),
      })),
  };
}

export async function listSources(
  client: ClientBase,
  authorizedSpaceIds: readonly string[],
  args: { sourceAccountId?: string; limit?: number },
) {
  validateSpaces(authorizedSpaceIds);
  const limit = boundedLimit(args.limit);
  // An empty authorized set answers empty, as the Convex query did, rather
  // than raising `spacePredicate`'s `ProofError`. See the same note on
  // `listInventory`: an MCP credential may legitimately hold no space grant,
  // and that is an empty inventory, not a fault the tool should relay.
  if (authorizedSpaceIds.length === 0) {
    return { sources: [], partial: false, truncated: false };
  }
  const predicate = spacePredicate(authorizedSpaceIds, args.sourceAccountId === undefined ? 1 : 2);
  const accountResult = args.sourceAccountId === undefined
    ? await client.query<QueryResultRow>(
        `SELECT * FROM kith.source_accounts WHERE ${predicate.sql}
          ORDER BY name NULLS LAST, id LIMIT $2`,
        [predicate.value, MAX_SOURCE_ACCOUNTS + 1],
      )
    : await client.query<QueryResultRow>(
        `SELECT * FROM kith.source_accounts WHERE id = $1 AND ${predicate.sql} LIMIT 2`,
        [args.sourceAccountId, predicate.value],
      );
  let accountOverflow = false;
  if (args.sourceAccountId === undefined && accountResult.rows.length > MAX_SOURCE_ACCOUNTS) accountOverflow = true;
  if (args.sourceAccountId !== undefined && accountResult.rows.length > 1) throw new Error("Source account is not unique");
  const accounts = accountResult.rows.slice(0, MAX_SOURCE_ACCOUNTS).map(camelizeSourceAccount);
  const results = [];
  let itemOverflow = false;
  let remainingItems = MAX_SOURCE_ITEMS;
  const metadataBudget = { remaining: MAX_SOURCE_METADATA_ROWS, overflow: false };
  const asOf = Date.now();
  for (const account of accounts) {
    if (remainingItems === 0) {
      itemOverflow = true;
      break;
    }
    const itemResult = await client.query<QueryResultRow>(
      `SELECT * FROM kith.source_items WHERE source_account_id = $1
        ORDER BY created_at, id LIMIT $2`,
      [account.id, remainingItems + 1],
    );
    if (itemResult.rows.length > remainingItems) itemOverflow = true;
    const itemRows = itemResult.rows.slice(0, remainingItems).map(camelizeSourceItem);
    remainingItems -= itemRows.length;
    const items = [];
    for (const item of itemRows) {
      if (item.spaceId !== account.spaceId || item.lifecycle === "forgetting" || item.lifecycle === "forgotten") continue;
      const generation = item.activeGenerationId
        ? await getRow(client, "processing_generations", item.activeGenerationId, camelizeProcessingGeneration)
        : undefined;
      const retainedTextAvailable = Boolean(
        generation && generation.spaceId === item.spaceId && generation.sourceAccountId === account.id &&
        generation.sourceItemId === item.id && generation.sourceRevisionId === item.activeRevisionId &&
        generation.state === "ready" && generation.deactivatedAt === null,
      );
      const recovery = generation ? await originalRecoveryStatus(client, generation) : undefined;
      items.push({
        sourceItemId: item.id,
        ...(item.externalId === null ? {} : { externalId: item.externalId }),
        ...(item.title === null ? {} : { title: item.title }),
        ...(item.docType === null ? {} : { docType: item.docType }),
        lifecycle: item.lifecycle,
        ...(retainedTextAvailable && item.activeRevisionId ? { activeRevisionId: item.activeRevisionId } : {}),
        ...(retainedTextAvailable && item.activeGenerationId ? { activeGenerationId: item.activeGenerationId } : {}),
        contentStatus: !retainedTextAvailable ? "none" :
          item.desiredRevisionId !== item.activeRevisionId || generation!.desiredProcessingEpoch !== item.desiredProcessingEpoch || item.lastFailure
            ? "stale" : "ready",
        originalLinkAvailable: item.originalLinkAvailable,
        retainedTextAvailable,
        ...(recovery ? { originalRecovery: recovery } : {}),
        ...(item.lastFailure === null ? {} : { lastFailure: item.lastFailure }),
      });
    }
    const metadata = await sourceAccountMetadata(client, account, asOf, metadataBudget);
    results.push({
      sourceAccountId: account.id, spaceId: account.spaceId,
      ...(account.connector === null ? {} : { connector: account.connector }),
      ...(account.accountId === null ? {} : { accountId: account.accountId }),
      ...(account.name === null ? {} : { name: account.name }),
      enabled: account.enabled === true, cursorVersion: account.cursorVersion ?? 0,
      ...(account.lastEnumeratedAt === null ? {} : { lastEnumeratedAt: account.lastEnumeratedAt }),
      ...(account.lastProcessedAt === null ? {} : { lastProcessedAt: account.lastProcessedAt }),
      freshnessMs: account.freshnessMs ?? 0, items, ...metadata,
    });
  }
  const flattenedItemCount = results.reduce((count, result) => count + result.items.length, 0);
  return {
    sources: results.slice(0, limit),
    partial: accountOverflow || itemOverflow || metadataBudget.overflow || results.some((result) => result.overflow),
    truncated: results.length > limit || flattenedItemCount > MAX_SOURCE_ITEMS,
  };
}
