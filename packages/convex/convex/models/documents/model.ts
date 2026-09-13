import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  classifyCoverageJob,
  classifyCoverageFetch,
  coverageEntityBelongsToSpace,
} from "../coverage/model";
import {
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
} from "../provenance/representations";
import { loadProviderOriginalReference } from "../provenance/providerOriginals";

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

type PublicationState = "staged" | "active" | "historical";

/**
 * P2-70j: one semantic candidate that is a document card rather than a
 * chunk. It answers "find the document" rather than "find the passage", so it
 * carries the card's extractive summary as its passage, the live card
 * generation as its evidence pointer and the card's own evidence spans.
 */
export type CardSearchHit = {
  eventId: Id<"events">;
  spaceId: Id<"spaces">;
  documentId: Id<"documents">;
  cardGenerationId: Id<"processingGenerations">;
  summary: string;
  evidenceSpanIds: Id<"evidenceSpans">[];
};

/** Ranking treats both legs as one ordered list of candidates. */
type SearchCandidate = {
  publicationState: PublicationState;
  rank: number;
  /** Fusion identity: the chunk row, or the card event and its document. */
  key: string;
  chunk?: Doc<"chunks">;
  card?: CardSearchHit;
};

type CitationOutput = {
  evidenceSpanId: Id<"evidenceSpans">;
  sourcePageId: Id<"sourcePages">;
  sourceTextVersionId: Id<"sourceTextVersions">;
  sourceRevisionId: Id<"sourceRevisions">;
  pageOrdinal: number;
  start: number;
  end: number;
  quote: string;
  quoteHash: string;
  locator: Doc<"evidenceSpans">["locator"];
};

class CitationOutputBudget {
  private readonly encoder = new TextEncoder();
  // Reserve opening/closing delimiters for every possible per-page or
  // per-result citation array. Each admitted citation also reserves a comma;
  // over-reserving the first item keeps admission order-independent.
  private used = 2 * Math.max(MAX_PAGES, MAX_LIMIT + 1);

  include(value: unknown): boolean {
    const size = this.encoder.encode(JSON.stringify(value)).byteLength + 1;
    if (size > MAX_CITATION_OUTPUT_BYTES - this.used) return false;
    this.used += size;
    return true;
  }
}

export function fuseDocumentCandidateRanks(
  keywordCandidates: readonly { id: string; rank: number }[],
  semanticCandidates: readonly { id: string; rank: number }[],
) {
  const scores = new Map(
    keywordCandidates.map(({ id, rank }) => [
      id,
      DOCUMENT_FUSION_KEYWORD_WEIGHT / (DOCUMENT_FUSION_RRF_K + rank + 1),
    ]),
  );
  for (const { id, rank } of semanticCandidates) {
    scores.set(
      id,
      (scores.get(id) ?? 0) +
        DOCUMENT_FUSION_SEMANTIC_WEIGHT / (DOCUMENT_FUSION_RRF_K + rank + 1),
    );
  }
  return scores;
}

export function boundedLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

export function validateSpaces(spaceIds: readonly Id<"spaces">[]) {
  if (spaceIds.length > MAX_READ_SPACES) {
    throw new Error(`Document reads support at most ${MAX_READ_SPACES} spaces`);
  }
}

function validateTimeRange(from: number | undefined, to: number | undefined) {
  if (from !== undefined && !Number.isFinite(from)) {
    throw new Error("from must be finite");
  }
  if (to !== undefined && !Number.isFinite(to)) {
    throw new Error("to must be finite");
  }
  if (from !== undefined && to !== undefined && from >= to) {
    throw new Error("Time ranges must satisfy from < to");
  }
}

function inTimeRange(
  value: number,
  from: number | undefined,
  to: number | undefined,
) {
  return (
    (from === undefined || value >= from) && (to === undefined || value < to)
  );
}

function retainedLifecycle(item: Doc<"sourceItems">) {
  return item.lifecycle === "available" || item.lifecycle === "unavailable";
}

function sourceStatus(
  item: Doc<"sourceItems">,
  generation: Doc<"processingGenerations">,
  publicationState: PublicationState,
) {
  if (publicationState === "historical") return "historical" as const;
  if (
    item.activeGenerationId !== generation._id ||
    item.desiredRevisionId !== item.activeRevisionId ||
    generation.desiredProcessingEpoch !== item.desiredProcessingEpoch ||
    item.lastFailure !== undefined
  ) {
    return "stale" as const;
  }
  return "ready" as const;
}

async function loadReadableDocument(
  ctx: Pick<QueryCtx, "db">,
  document: Doc<"documents">,
  spaceIds: ReadonlySet<Id<"spaces">>,
  includeHistorical: boolean,
) {
  if (
    !spaceIds.has(document.spaceId) ||
    document.publicationState === "staged"
  ) {
    return null;
  }
  if (document.publicationState === "historical" && !includeHistorical) {
    return null;
  }
  const item = await ctx.db.get(document.sourceItemId);
  if (!item) return null;
  const [revision, textVersion, generation, account] = await Promise.all([
    ctx.db.get(document.sourceRevisionId),
    ctx.db.get(document.sourceTextVersionId),
    ctx.db.get(document.processingGenerationId),
    ctx.db.get(item.sourceAccountId),
  ]);
  if (
    !item ||
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
    generation.sourceAccountId !== account._id ||
    revision.sourceItemId !== item._id ||
    textVersion.sourceRevisionId !== revision._id ||
    !textVersion.evidenceSealed ||
    generation.sourceItemId !== item._id ||
    generation.sourceRevisionId !== revision._id ||
    generation.sourceTextVersionId !== textVersion._id ||
    generation.state !== "ready"
  ) {
    return null;
  }
  try {
    const revisionRepresentation = parseSourceRevisionRepresentation(revision);
    const textRepresentation = parseSourceTextRepresentation(textVersion);
    if (
      (revisionRepresentation.kind === "inline_utf8_v1" &&
        textRepresentation.kind !== "inline_text_v1") ||
      (revisionRepresentation.kind === "archived_binary_v1" &&
        (textRepresentation.kind !== "parsed_pages_v1" ||
          !textRepresentation.sealed ||
          textRepresentation.hashAuthority !==
            "server_verified_retained_text" ||
          generation.parserArtifactId !== textRepresentation.parserArtifactId))
    )
      return null;
  } catch {
    return null;
  }
  if (
    document.publicationState === "active" &&
    (item.activeGenerationId !== generation._id ||
      item.activeRevisionId !== revision._id ||
      generation.deactivatedAt !== undefined)
  ) {
    return null;
  }
  if (
    document.publicationState === "historical" &&
    (generation.activatedAt === undefined ||
      generation.deactivatedAt === undefined)
  ) {
    return null;
  }
  return { item, revision, textVersion, generation, account };
}

/**
 * Section 4.2 of docs/plans/2026-09-12-document-cards.md: a document's type is
 * the accepted `card_kind` of the item's live card when there is one, and the
 * parser's own `documents.docType` otherwise, so type filtering and the card
 * cannot disagree.
 *
 * P2-80i: the card kind is read from the item here rather than written onto the
 * document row. `documents` is part of the sealed parsed payload and its
 * `docType` is inside `manifest.documentDigest`, so patching the row in place
 * made `verifySealedParsedPayload` fail for every document a card had refined.
 * Only an active document takes the overlay; a historical row keeps the type
 * its own generation parsed, which is what the card patch did too.
 */
export function effectiveDocType(
  document: Doc<"documents">,
  item: Doc<"sourceItems">,
): string | undefined {
  return document.publicationState === "active" &&
    item.cardDocType !== undefined
    ? item.cardDocType
    : document.docType;
}

async function originalRecoveryStatus(
  ctx: Pick<QueryCtx, "db">,
  generation: Doc<"processingGenerations">,
) {
  const receiptMatches = (
    receipt: Doc<"sourceArtifactArchiveReceipts"> | null,
    copyRole: "primary" | "independent_backup",
  ) =>
    Boolean(
      receipt &&
        receipt.spaceId === generation.spaceId &&
        receipt.sourceAccountId === generation.sourceAccountId &&
        receipt.sourceItemId === generation.sourceItemId &&
        receipt.sourceRevisionId === generation.sourceRevisionId &&
        receipt.subjectKind === "original_bytes" &&
        receipt.copyRole === copyRole &&
        receipt.parserArtifactId === undefined,
    );
  if (
    generation.originalPrimaryReceiptId === undefined ||
    generation.archiveSetDigest === undefined
  )
    return undefined;
  if (generation.originalBackupReceiptId !== undefined) {
    if (
      generation.originalProviderReferenceId !== undefined ||
      generation.originalProviderBindingEpoch !== undefined
    )
      return undefined;
    const [primary, independentBackup] = await Promise.all([
      ctx.db.get(generation.originalPrimaryReceiptId),
      ctx.db.get(generation.originalBackupReceiptId),
    ]);
    return {
      kind: "archive_pair_v1" as const,
      primary: receiptMatches(primary, "primary"),
      independentBackup: receiptMatches(
        independentBackup,
        "independent_backup",
      ),
    };
  }
  if (
    generation.originalProviderReferenceId === undefined ||
    generation.originalProviderBindingEpoch === undefined
  )
    return undefined;
  const [primary, reference] = await Promise.all([
    ctx.db.get(generation.originalPrimaryReceiptId),
    ctx.db.get(generation.originalProviderReferenceId),
  ]);
  if (
    !receiptMatches(primary, "primary") ||
    !reference ||
    reference.spaceId !== generation.spaceId ||
    reference.sourceAccountId !== generation.sourceAccountId ||
    reference.sourceItemId !== generation.sourceItemId ||
    reference.sourceRevisionId !== generation.sourceRevisionId
  )
    return undefined;
  let hasAdmissionAudit = false;
  try {
    await loadProviderOriginalReference(ctx, {
      referenceId: reference._id,
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
    kind: "provider_original_v1" as const,
    localPrimaryArchived: true,
    providerVerification: hasAdmissionAudit
      ? ("verified_at_admission" as const)
      : ("audit_unavailable" as const),
    verifiedAt: reference.verifiedAt,
    continuousAvailability: false as const,
    desktopRecoveryRequired: true as const,
  };
}

async function hydrateCitations(
  ctx: Pick<QueryCtx, "db">,
  evidenceSpanIds: readonly Id<"evidenceSpans">[],
  expected: {
    spaceId: Id<"spaces">;
    sourceRevisionId: Id<"sourceRevisions">;
    sourceTextVersionId: Id<"sourceTextVersions">;
  },
  budget: CitationOutputBudget,
  cache?: {
    spans: Map<Id<"evidenceSpans">, Doc<"evidenceSpans"> | null>;
    pages: Map<Id<"sourcePages">, Doc<"sourcePages"> | null>;
  },
) {
  const ids = [...new Set(evidenceSpanIds)].slice(0, MAX_CITATIONS_PER_RESULT);
  const spans: Array<Doc<"evidenceSpans"> | null> = [];
  const pages: Array<Doc<"sourcePages"> | null> = [];
  for (const id of ids) {
    let span = cache?.spans.get(id);
    if (span === undefined) {
      span = await ctx.db.get(id);
      cache?.spans.set(id, span);
    }
    spans.push(span);
    if (!span) {
      pages.push(null);
      continue;
    }
    let page = cache?.pages.get(span.sourcePageId);
    if (page === undefined) {
      page = await ctx.db.get(span.sourcePageId);
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
      span.sourcePageId !== page._id ||
      span.start < 0 ||
      span.end < span.start ||
      span.end > page.text.length
    ) {
      invalidCitations = true;
      continue;
    }
    const citation: CitationOutput = {
      evidenceSpanId: span._id,
      sourcePageId: page._id,
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
    citationsTruncated:
      evidenceSpanIds.length > MAX_CITATIONS_PER_RESULT || byteBudgetTruncated,
    invalidCitations,
    byteBudgetTruncated,
  };
}

export async function searchDocuments(
  ctx: Pick<QueryCtx, "db">,
  spaceIds: readonly Id<"spaces">[],
  args: {
    query: string;
    docType?: string;
    from?: number;
    to?: number;
    limit?: number;
    includeHistorical?: boolean;
  },
  semantic?: {
    chunkIds: readonly Id<"chunks">[];
    /** Card candidates, already rechecked against the live card generation. */
    cardHits?: readonly CardSearchHit[];
    vectorStatus: "ready" | "unavailable";
    /** Chunk targets the active fingerprint still owes (D3 B). */
    coverageIncomplete?: boolean;
  },
) {
  validateSpaces(spaceIds);
  validateTimeRange(args.from, args.to);
  const query = args.query.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) {
    throw new Error("query is invalid");
  }
  const limit = boundedLimit(args.limit);
  const states: PublicationState[] = args.includeHistorical
    ? ["active", "historical"]
    : ["active"];
  const partitions = states.flatMap((publicationState) =>
    [...spaceIds]
      .sort((left, right) => left.localeCompare(right))
      .map((spaceId) => ({ spaceId, publicationState })),
  );
  let candidateOverflow = false;
  const semanticReady = semantic?.vectorStatus === "ready";
  const keywordBudget = semanticReady
    ? MAX_SEARCH_CANDIDATES / 2
    : MAX_SEARCH_CANDIDATES;
  let remainingCandidates = keywordBudget;
  const candidates: SearchCandidate[] = [];
  for (
    let partitionIndex = 0;
    partitionIndex < partitions.length;
    partitionIndex += 1
  ) {
    const partition = partitions[partitionIndex]!;
    if (remainingCandidates === 0) {
      candidateOverflow = true;
      break;
    }
    const rows = await ctx.db
      .query("chunks")
      .withSearchIndex("by_text", (q) =>
        q
          .search("text", query)
          .eq("spaceId", partition.spaceId)
          .eq("publicationState", partition.publicationState),
      )
      .take(remainingCandidates + 1);
    if (rows.length > remainingCandidates) candidateOverflow = true;
    const accepted = rows.slice(0, remainingCandidates);
    remainingCandidates -= accepted.length;
    candidates.push(
      ...accepted.map((chunk, rank) => ({
        chunk,
        key: String(chunk._id),
        publicationState: partition.publicationState,
        rank: partitionIndex * MAX_SEARCH_CANDIDATES + rank,
      })),
    );
  }
  if (semanticReady) {
    const keywordCandidates = candidates.map((candidate) => ({
      id: candidate.key,
      rank: candidate.rank,
    }));
    const seen = new Set(candidates.map((candidate) => candidate.key));
    const cardHits = (semantic.cardHits ?? []).slice(0, keywordBudget);
    const ids = [...new Set(semantic.chunkIds)].slice(0, keywordBudget);
    candidateOverflow ||=
      semantic.chunkIds.length > keywordBudget ||
      (semantic.cardHits?.length ?? 0) > keywordBudget;
    // Both legs arrive in one score order, so their ranks share a scale: a
    // card hit and a chunk hit compete on the same reciprocal-rank curve.
    const semanticCandidates: Array<{ id: string; rank: number }> = [];
    let rank = 0;
    for (const id of ids) {
      const chunk = await ctx.db.get(id);
      if (!chunk || chunk.publicationState !== "active") continue;
      const key = String(id);
      semanticCandidates.push({ id: key, rank: rank++ });
      if (!seen.has(key)) {
        candidates.push({ chunk, key, publicationState: "active", rank: 0 });
        seen.add(key);
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
    const ranks = fuseDocumentCandidateRanks(
      keywordCandidates,
      semanticCandidates,
    );
    for (const candidate of candidates) {
      candidate.rank = -(ranks.get(candidate.key) ?? 0);
    }
  }
  candidates.sort(
    (left, right) =>
      (left.publicationState === right.publicationState
        ? 0
        : left.publicationState === "active"
          ? -1
          : 1) ||
      left.rank - right.rank ||
      left.key.localeCompare(right.key),
  );

  const authorized = new Set(spaceIds);
  const resultCountByDocument = new Map<Id<"documents">, number>();
  const returnedChunks = new Set<Id<"chunks">>();
  const chainCache = new Map<
    Id<"documents">,
    Awaited<ReturnType<typeof loadReadableDocument>>
  >();
  const citationCache = {
    spans: new Map<Id<"evidenceSpans">, Doc<"evidenceSpans"> | null>(),
    pages: new Map<Id<"sourcePages">, Doc<"sourcePages"> | null>(),
  };
  const citationBudget = new CitationOutputBudget();
  const results = [];
  let citationPartial = false;
  for (const candidate of candidates) {
    if (results.length > limit) break;
    const chunk = candidate.chunk;
    const card = candidate.card;
    // A card hit is a document-level hit: its document is named directly and
    // its passage is the card's summary, so there is no chunk to validate.
    const document = chunk
      ? await ctx.db.get(chunk.documentId)
      : await ctx.db.get(card!.documentId);
    if (
      !document ||
      (chunk
        ? chunk.publicationState !== candidate.publicationState ||
          chunk.spaceId !== document.spaceId ||
          document.processingGenerationId !== chunk.processingGenerationId ||
          document.publicationState !== chunk.publicationState ||
          returnedChunks.has(chunk._id)
        : document.spaceId !== card!.spaceId ||
          document.publicationState !== "active") ||
      (resultCountByDocument.get(document._id) ?? 0) >=
        MAX_RESULTS_PER_DOCUMENT ||
      !inTimeRange(document.capturedAt, args.from, args.to)
    ) {
      continue;
    }
    let chain = chainCache.get(document._id);
    if (chain === undefined) {
      chain = await loadReadableDocument(
        ctx,
        document,
        authorized,
        args.includeHistorical ?? false,
      );
      chainCache.set(document._id, chain);
    }
    if (!chain) continue;
    // The type filter compares the effective type, which the card overlays, so
    // it needs the chain's item and runs after the chain loads.
    const docType = effectiveDocType(document, chain.item);
    if (args.docType !== undefined && docType !== args.docType) continue;
    // Citations for a card hit resolve to the card's own evidence spans,
    // which were staged over this same sealed text version.
    const citationResult = await hydrateCitations(
      ctx,
      chunk ? chunk.evidenceSpanIds : card!.evidenceSpanIds,
      {
        spaceId: document.spaceId,
        sourceRevisionId: document.sourceRevisionId,
        sourceTextVersionId: document.sourceTextVersionId,
      },
      citationBudget,
      citationCache,
    );
    citationPartial ||=
      citationResult.invalidCitations || citationResult.byteBudgetTruncated;
    if (chunk) returnedChunks.add(chunk._id);
    resultCountByDocument.set(
      document._id,
      (resultCountByDocument.get(document._id) ?? 0) + 1,
    );
    const recovery = await originalRecoveryStatus(ctx, chain.generation);
    results.push({
      spaceId: document.spaceId,
      sourceAccountId: chain.account._id,
      sourceItemId: chain.item._id,
      sourceRevisionId: chain.revision._id,
      sourceTextVersionId: chain.textVersion._id,
      processingGenerationId: chain.generation._id,
      documentId: document._id,
      // Exactly one of these is set: a chunk hit names its passage row, a
      // card hit names the card event and the card generation it came from,
      // which is its evidence pointer.
      chunkId: chunk?._id,
      cardEventId: card?.eventId,
      cardGenerationId: card?.cardGenerationId,
      title: document.title,
      docType,
      capturedAt: document.capturedAt,
      snippet: chunk ? chunk.text : card!.summary,
      historical: document.publicationState === "historical",
      contentStatus: sourceStatus(
        chain.item,
        chain.generation,
        document.publicationState,
      ),
      sourceAvailability: chain.item.lifecycle,
      originalLinkAvailable: chain.item.originalLinkAvailable,
      retainedTextAvailable: true,
      ...(recovery ? { originalRecovery: recovery } : {}),
      vectorStatus: semanticReady
        ? ("ready" as const)
        : ("unavailable" as const),
      citations: citationResult.citations,
      citationsTruncated: citationResult.citationsTruncated,
    });
  }
  const truncated = results.length > limit;
  return {
    results: results.slice(0, limit),
    vectorStatus: semanticReady ? ("ready" as const) : ("unavailable" as const),
    partial:
      candidateOverflow ||
      citationPartial ||
      (semanticReady && semantic?.coverageIncomplete === true),
    truncated,
  };
}

export async function getDocument(
  ctx: Pick<QueryCtx, "db">,
  spaceIds: readonly Id<"spaces">[],
  documentId: Id<"documents">,
  includeHistorical = false,
) {
  validateSpaces(spaceIds);
  const document = await ctx.db.get(documentId);
  if (!document) return null;
  const chain = await loadReadableDocument(
    ctx,
    document,
    new Set(spaceIds),
    includeHistorical,
  );
  if (!chain) return null;
  const pageRows = await ctx.db
    .query("sourcePages")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", chain.textVersion._id),
    )
    .take(MAX_PAGES + 1);
  const spanRows = await ctx.db
    .query("evidenceSpans")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", chain.textVersion._id),
    )
    .take(MAX_EVIDENCE_SPANS + 1);
  if (pageRows.length > MAX_PAGES || spanRows.length > MAX_EVIDENCE_SPANS) {
    throw new Error("Document content exceeds the supported read bounds");
  }
  const allowedEvidence = new Set(document.evidenceSpanIds);
  const citationBudget = new CitationOutputBudget();
  let citationBudgetTruncated = false;
  const pages = pageRows
    .filter(
      (page) =>
        page.spaceId === document.spaceId &&
        page.sourceTextVersionId === chain.textVersion._id,
    )
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal || left._id.localeCompare(right._id),
    )
    .map((page) => ({
      sourcePageId: page._id,
      ordinal: page.ordinal,
      start: page.start,
      end: page.end,
      text: page.text,
      textHash: page.textHash,
      evidence: spanRows
        .filter(
          (span) =>
            allowedEvidence.has(span._id) &&
            span.sourcePageId === page._id &&
            span.spaceId === document.spaceId &&
            span.sourceRevisionId === chain.revision._id &&
            span.sourceTextVersionId === chain.textVersion._id &&
            span.start >= 0 &&
            span.end >= span.start &&
            span.end <= page.text.length,
        )
        .sort(
          (left, right) =>
            left.ordinal - right.ordinal || left._id.localeCompare(right._id),
        )
        .flatMap((span) => {
          const evidence = {
            evidenceSpanId: span._id,
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
  const validatedEvidenceSpanIds = pages.flatMap((page) =>
    page.evidence.map((span) => span.evidenceSpanId),
  );
  const partial =
    pages.length !== pageRows.length ||
    validatedEvidenceSpanIds.length !== allowedEvidence.size ||
    citationBudgetTruncated;
  const recovery = await originalRecoveryStatus(ctx, chain.generation);
  return {
    spaceId: document.spaceId,
    sourceAccountId: chain.account._id,
    sourceItemId: chain.item._id,
    sourceRevisionId: chain.revision._id,
    sourceTextVersionId: chain.textVersion._id,
    processingGenerationId: chain.generation._id,
    documentId: document._id,
    title: document.title,
    docType: effectiveDocType(document, chain.item),
    capturedAt: document.capturedAt,
    historical: document.publicationState === "historical",
    contentStatus: sourceStatus(
      chain.item,
      chain.generation,
      document.publicationState,
    ),
    sourceAvailability: chain.item.lifecycle,
    originalLinkAvailable: chain.item.originalLinkAvailable,
    originalUri: chain.item.uri,
    retainedTextAvailable: true,
    ...(recovery ? { originalRecovery: recovery } : {}),
    archiveRef: chain.revision.archiveRef,
    contentHash: chain.revision.contentHash,
    contentHashAuthority:
      chain.revision.representation === "archived_binary_v1"
        ? ("worker_asserted" as const)
        : ("server_verified_utf8" as const),
    textHash: chain.textVersion.textHash,
    textHashAuthority: "server_verified_retained_text" as const,
    pages,
    evidenceSpanIds: validatedEvidenceSpanIds,
    partial,
    vectorStatus: "unavailable" as const,
  };
}

async function sourceAccountMetadata(
  ctx: Pick<QueryCtx, "db">,
  account: Doc<"sourceAccounts">,
  asOf: number,
  budget: { remaining: number; overflow: boolean },
  itemCache: Map<Id<"sourceItems">, Doc<"sourceItems"> | null>,
  entityCache: Map<Id<"entities">, Doc<"entities"> | null>,
) {
  const jobStates = [
    "queued",
    "processing",
    "staged",
    "failed",
    "needs_review",
  ] as const;
  async function takeWithinBudget<T>(loader: (limit: number) => Promise<T[]>) {
    if (budget.remaining === 0) {
      budget.overflow = true;
      return [];
    }
    const rows = await loader(budget.remaining + 1);
    if (rows.length > budget.remaining) budget.overflow = true;
    const accepted = rows.slice(0, budget.remaining);
    budget.remaining -= accepted.length;
    return accepted;
  }
  const jobBatches = [];
  for (const state of jobStates) {
    const rows = await takeWithinBudget((limit) =>
      ctx.db
        .query("ingestJobs")
        .withIndex("by_sourceAccountId_and_state", (q) =>
          q.eq("sourceAccountId", account._id).eq("state", state),
        )
        .take(limit),
    );
    jobBatches.push({ state, rows });
  }
  const windows = await takeWithinBudget((limit) =>
    ctx.db
      .query("coverageWindows")
      .withIndex("by_sourceAccountId", (q) =>
        q.eq("sourceAccountId", account._id),
      )
      .take(limit),
  );
  const gaps = await takeWithinBudget((limit) =>
    ctx.db
      .query("coverageGaps")
      .withIndex("by_sourceAccountId_and_status", (q) =>
        q.eq("sourceAccountId", account._id).eq("status", "open"),
      )
      .take(limit),
  );
  const fetchRequests = await takeWithinBudget((limit) =>
    ctx.db
      .query("sourceFetchRequests")
      .withIndex("by_sourceAccountId", (q) =>
        q.eq("sourceAccountId", account._id),
      )
      .take(limit),
  );
  let pendingJobs = 0;
  let failedJobs = 0;
  let invalidJobParent = false;
  for (const request of fetchRequests) {
    const classification = await classifyCoverageFetch(
      ctx,
      account,
      request,
      itemCache,
    );
    if (classification === "current") pendingJobs += 1;
    if (classification === "invalid") invalidJobParent = true;
  }
  for (const batch of jobBatches) {
    for (const job of batch.rows) {
      const classification = await classifyCoverageJob(
        ctx,
        account,
        job,
        itemCache,
      );
      if (classification === "invalid") invalidJobParent = true;
      if (classification !== "current") continue;
      if (
        batch.state === "queued" ||
        batch.state === "processing" ||
        batch.state === "staged"
      ) {
        pendingJobs += 1;
      } else {
        failedJobs += 1;
      }
    }
  }
  const validWindows: Doc<"coverageWindows">[] = [];
  let invalidCoverageParent = false;
  for (const window of windows) {
    if (
      window.spaceId !== account.spaceId ||
      !(await coverageEntityBelongsToSpace(
        ctx,
        account.spaceId,
        window.entityId,
        entityCache,
      ))
    ) {
      invalidCoverageParent = true;
    } else {
      validWindows.push(window);
    }
  }
  const validGaps: Doc<"coverageGaps">[] = [];
  for (const gap of gaps) {
    if (
      gap.spaceId !== account.spaceId ||
      !(await coverageEntityBelongsToSpace(
        ctx,
        account.spaceId,
        gap.entityId,
        entityCache,
      ))
    ) {
      invalidCoverageParent = true;
    } else {
      validGaps.push(gap);
    }
  }
  return {
    pendingJobs,
    failedJobs,
    overflow: budget.overflow || invalidCoverageParent || invalidJobParent,
    windows: validWindows
      .slice(0, MAX_SOURCE_METADATA_ROWS)
      .sort(
        (left, right) =>
          left.from - right.from || left._id.localeCompare(right._id),
      )
      .map((window) => ({
        coverageWindowId: window._id,
        recordType: window.recordType,
        entityId: window.entityId,
        from: window.from,
        to: window.to,
        state: window.state,
        lastEnumeratedAt: window.lastEnumeratedAt,
        lastProcessedAt: window.lastProcessedAt,
        fresh:
          account.enabled &&
          (account.coverageInvalidatedAt === undefined ||
            (window.lastEnumeratedAt > account.coverageInvalidatedAt &&
              window.lastProcessedAt > account.coverageInvalidatedAt)) &&
          window.lastEnumeratedAt <= asOf &&
          window.lastProcessedAt <= asOf &&
          window.lastEnumeratedAt >= asOf - account.freshnessMs &&
          window.lastProcessedAt >= asOf - account.freshnessMs,
        discoveredCount: window.discoveredCount,
        indexedCount: window.indexedCount,
        skippedCount: window.skippedCount,
      })),
    gaps: validGaps
      .filter((gap) => gap.status === "open")
      .slice(0, MAX_SOURCE_METADATA_ROWS)
      .sort(
        (left, right) =>
          left.detectedAt - right.detectedAt ||
          left._id.localeCompare(right._id),
      )
      .map((gap) => ({
        coverageGapId: gap._id,
        recordType: gap.recordType,
        entityId: gap.entityId,
        from: gap.from,
        to: gap.to,
        reason: gap.reason,
        detectedAt: gap.detectedAt,
      })),
  };
}

export async function listSources(
  ctx: Pick<QueryCtx, "db">,
  spaceIds: readonly Id<"spaces">[],
  args: { sourceAccountId?: Id<"sourceAccounts">; limit?: number },
) {
  validateSpaces(spaceIds);
  const limit = boundedLimit(args.limit);
  const asOf = Date.now();
  const authorized = new Set(spaceIds);
  let accountOverflow = false;
  let accounts: Doc<"sourceAccounts">[];
  if (args.sourceAccountId !== undefined) {
    const account = await ctx.db.get(args.sourceAccountId);
    accounts = account && authorized.has(account.spaceId) ? [account] : [];
  } else {
    accounts = [];
    const orderedSpaces = [...spaceIds].sort((left, right) =>
      left.localeCompare(right),
    );
    for (let index = 0; index < orderedSpaces.length; index += 1) {
      const remaining = MAX_SOURCE_ACCOUNTS - accounts.length;
      if (remaining === 0) {
        accountOverflow = true;
        break;
      }
      const rows = await ctx.db
        .query("sourceAccounts")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", orderedSpaces[index]!))
        .take(remaining + 1);
      if (rows.length > remaining) accountOverflow = true;
      accounts.push(...rows.slice(0, remaining));
    }
    accounts.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left._id.localeCompare(right._id),
    );
  }

  const results = [];
  let itemOverflow = false;
  let remainingItems = MAX_SOURCE_ITEMS;
  const metadataBudget = {
    remaining: MAX_SOURCE_METADATA_ROWS,
    overflow: false,
  };
  const jobItemCache = new Map<Id<"sourceItems">, Doc<"sourceItems"> | null>();
  const coverageEntityCache = new Map<Id<"entities">, Doc<"entities"> | null>();
  for (const account of accounts) {
    if (remainingItems === 0) {
      itemOverflow = true;
      break;
    }
    const itemRows = await ctx.db
      .query("sourceItems")
      .withIndex("by_sourceAccountId", (q) =>
        q.eq("sourceAccountId", account._id),
      )
      .take(remainingItems + 1);
    if (itemRows.length > remainingItems) itemOverflow = true;
    const acceptedItemRows = itemRows.slice(0, remainingItems);
    remainingItems -= acceptedItemRows.length;
    const items = [];
    for (const item of acceptedItemRows) {
      if (
        item.spaceId !== account.spaceId ||
        item.lifecycle === "forgetting" ||
        item.lifecycle === "forgotten"
      ) {
        continue;
      }
      const generation = item.activeGenerationId
        ? await ctx.db.get(item.activeGenerationId)
        : null;
      const retainedTextAvailable = Boolean(
        generation &&
        generation.spaceId === item.spaceId &&
        generation.sourceAccountId === account._id &&
        generation.sourceItemId === item._id &&
        generation.sourceRevisionId === item.activeRevisionId &&
        generation.state === "ready" &&
        generation.deactivatedAt === undefined,
      );
      const recovery = generation
        ? await originalRecoveryStatus(ctx, generation)
        : undefined;
      items.push({
        sourceItemId: item._id,
        externalId: item.externalId,
        title: item.title,
        docType: item.docType,
        lifecycle: item.lifecycle,
        activeRevisionId: retainedTextAvailable
          ? item.activeRevisionId
          : undefined,
        activeGenerationId: retainedTextAvailable
          ? item.activeGenerationId
          : undefined,
        contentStatus: !retainedTextAvailable
          ? ("none" as const)
          : item.desiredRevisionId !== item.activeRevisionId ||
              generation?.desiredProcessingEpoch !==
                item.desiredProcessingEpoch ||
              item.lastFailure
            ? ("stale" as const)
            : ("ready" as const),
        originalLinkAvailable: item.originalLinkAvailable,
        retainedTextAvailable,
        ...(recovery ? { originalRecovery: recovery } : {}),
        lastFailure: item.lastFailure,
      });
    }
    const metadata = await sourceAccountMetadata(
      ctx,
      account,
      asOf,
      metadataBudget,
      jobItemCache,
      coverageEntityCache,
    );
    results.push({
      sourceAccountId: account._id,
      spaceId: account.spaceId,
      connector: account.connector,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      cursorVersion: account.cursorVersion,
      lastEnumeratedAt: account.lastEnumeratedAt,
      lastProcessedAt: account.lastProcessedAt,
      freshnessMs: account.freshnessMs,
      items,
      ...metadata,
    });
  }
  const flattenedItemCount = results.reduce(
    (count, result) => count + result.items.length,
    0,
  );
  return {
    sources: results.slice(0, limit),
    partial:
      accountOverflow ||
      itemOverflow ||
      metadataBudget.overflow ||
      results.some((result) => result.overflow),
    truncated: results.length > limit || flattenedItemCount > MAX_SOURCE_ITEMS,
  };
}
