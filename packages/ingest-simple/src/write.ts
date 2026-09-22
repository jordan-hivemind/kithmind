// The per-file write path: one source item, one inline source revision, one
// text version, its pages, evidence spans, one document, its chunks, then
// activation. Every step below calls an existing, unmodified
// `@repo/kith-store` provenance function (`createOrGetSourceItem`,
// `createOrGetRevision`, `setDesiredSourceRevision`, `createOrGetTextVersion`,
// `stagePages`, `stageEvidenceSpans`, `stageDocuments`, `stageChunks`,
// `inspectGenerationPayload`, `activateSourceItemGeneration`), the same
// sequence `packages/kith-store/src/ingestion/inlineWork.ts`'s
// `admitInlineSourceRevision` / `stageInlineGeneration` /
// `activateInlineGeneration` use, minus the ingest-job row, lease, rate
// limit and deferred-fallback scheduling those add for a different caller.
//
// This deliberately uses the *inline* revision/text-version representation
// (`createOrGetRevision`/`createOrGetTextVersion`), not
// `createOrGetArchivedRevision`/`createOrGetParsedTextVersion`. Those binary
// counterparts store extracted text through `insertParsedPages` et al.
// (`provenance/parsedStaging.ts`), which require a `WorkerParsedStageRow` --
// `kith.worker_parsed_stages`, a resumable, row-locked staging session that
// `packages/kith-store/src/workers/parsedJobs.ts` owns -- and
// `createOrGetParserArtifact` additionally requires a real
// `kith.brain_api_keys` row (`actor_credential_id` is a hard foreign key).
// Reconstructing either is exactly the durable-worker machinery this task
// replaces, so this ingester uses the self-contained inline path instead and
// substitutes its own pre-transaction skip check (below) for the content
// hash dedupe the binary path gets for free: `createOrGetRevision`'s
// `content_hash` is `sha256(extracted text)`, not `sha256(file bytes)`, so it
// cannot answer "is this file unchanged" without extracting it first. See
// the package README for the consequence: a source revision's inline text
// (and a text version's) is capped at 8 MiB and 1,000 pages by the schema's
// existing `MAX_SOURCE_INLINE_UTF8_BYTES` / `MAX_SOURCE_PAGES` -- bounds
// sized for one household's own documents (a 90-page tax return, a 30-60
// page brokerage statement), not untrusted input. A bigger document still
// fails per file, logged, and is skipped rather than crashing the run.
// `stagePages` also enforces a MAX_STAGING_ROWS-per-call row limit
// independent of MAX_SOURCE_PAGES, so `stageOneFile` below batches page
// inserts the same way it already batches evidence spans and chunks.

import type { Pool, PoolClient } from "pg";

import { ingestion, newKithId, provenance, sha256, withKithTransaction, workers } from "@repo/kith-store";
import { scheduleDocumentExtraction } from "@repo/kith-store/extraction";

import { batches, batchesByRowsAndBytes, pageChunkRanges } from "./chunker.js";
import { depthFromFingerprint, type Depth } from "./depthPolicy.js";

const MAX_STAGING_ROWS = 25;
// `provenance.MAX_STAGING_TEXT_UTF8_BYTES`: the same per-call text-byte
// budget `requireBatchBounds` enforces for `stagePages`/`stageChunks`,
// independent of MAX_STAGING_ROWS -- see `batchesByRowsAndBytes`.
const MAX_STAGING_TEXT_UTF8_BYTES = provenance.MAX_STAGING_TEXT_UTF8_BYTES;
const DOCUMENT_KEY = "document:0";
const EXTRACTOR_FINGERPRINT = "ingest-simple";
const RECORD_SCHEMA_FINGERPRINT = "ingest-simple-v1";
const NORMALIZATION_FINGERPRINT = "ingest-simple-v1";
const CHUNKER_FINGERPRINT = "ingest-simple-page-chunks-v1";
const CORRECTION_REVISION = "ingest-simple-v1";

/** Persisted to `kith.source_items.ingest_metadata` (migration 046), the
 * ingest-simple-owned home for the depth-policy fields no existing column
 * fits (see README.md's "Depth policy"): the document's real total page
 * count and original byte size, its detected tax year, kind and ingested
 * depth, and the converter identity that produced it. Provisional, ingester-
 * owned data, not a fact or evidence -- deliberately not typed as strictly
 * as the provenance rows around it, and updated in place by a plain `UPDATE`
 * outside their immutability rules; see `setSourceItemIngestMetadata`. */
export type SourceItemIngestMetadata = {
  pageCount: number;
  byteLength: number;
  taxYear: number | null;
  kind: string;
  depth: string;
  converter: string;
};

export type IngestFileInput = {
  spaceId: string;
  sourceAccountId: string;
  externalId: string;
  title: string;
  docType: string;
  uri?: string;
  capturedAt: Date;
  userId: string;
  /** sha256 hex of the raw file bytes. Stored on the revision's
   * `archive_ref` (bounded text, otherwise unused by the inline lane), the
   * key `readActiveIngestState` reads back next run so an unchanged file at
   * an unchanged depth skips conversion entirely -- see ingest.ts. */
  fileByteHash: string;
  pages: string[];
  converterFingerprint: string;
  mediaType: string;
  /** Optional so the existing tests calling `ingestFile` directly (from
   * before this field existed) still work unchanged. Every real run through
   * ingest.ts supplies it. */
  ingestMetadata?: SourceItemIngestMetadata;
};

export type IngestFileResult = {
  sourceItemId: string;
  processingGenerationId: string;
  documentId: string;
  pageCount: number;
  chunkCount: number;
  reused: boolean;
};

/** What this source item's *active* generation carries right now, read
 * before conversion so the caller can decide whether to skip it entirely.
 * `null` when the item has never been fully activated (new, or a prior run's
 * partial attempt) -- `ingestFile` resumes that case idempotently rather than
 * skipping it. `depth` is `null` for an active generation from before this
 * package recorded depth in its extraction fingerprint (see
 * `depthPolicy.ts`); a caller must not treat that the same as `"glance"`. */
export type ActiveIngestState = { fileByteHash: string | null; depth: Depth | null };

export async function readActiveIngestState(
  pool: Pool,
  input: { spaceId: string; sourceAccountId: string; externalId: string },
): Promise<ActiveIngestState | null> {
  const externalIdHash = sha256(input.externalId);
  const { rows } = await pool.query<{ archive_ref: string | null; extraction_fingerprint: string | null }>(
    `SELECT sr.archive_ref, pg.extraction_fingerprint
       FROM kith.source_items si
       JOIN kith.source_revisions sr ON sr.id = si.active_revision_id
       JOIN kith.processing_generations pg ON pg.id = si.active_generation_id
      WHERE si.space_id = $1 AND si.source_account_id = $2 AND si.external_id_hash = $3
        AND si.active_generation_id IS NOT NULL
      LIMIT 1`,
    [input.spaceId, input.sourceAccountId, externalIdHash],
  );
  const row = rows[0];
  if (!row) return null;
  return { fileByteHash: row.archive_ref, depth: depthFromFingerprint(row.extraction_fingerprint) };
}

/**
 * True when `state` (from `readActiveIngestState`) already carries
 * `fileByteHash` at a depth this run does not need to raise. Never demotes: a
 * document already ingested in full stays full even if this run's policy (or
 * an explicit `--depth glance`) would now only glance it -- full is a
 * superset of what glance keeps, and silently discarding already-extracted
 * pages on an ordinary re-run would be a surprising, unrequested loss.
 * Promoting glance -> full is the only direction this package changes a
 * document's depth automatically; see ingest.ts, which calls this once it has
 * decided `desiredDepth` and also uses `state` to detect that promotion for
 * its summary.
 */
export function isUpToDate(
  state: ActiveIngestState | null,
  fileByteHash: string,
  desiredDepth: Depth,
): boolean {
  if (!state || state.fileByteHash !== fileByteHash) return false;
  return state.depth === "full" || state.depth === desiredDepth;
}

/** Writes `metadata` to `kith.source_items.ingest_metadata` (migration 046),
 * updating in place -- a plain `UPDATE`, not a provenance staging call, since
 * this column is deliberately outside the immutable revision/generation
 * chain (see the `SourceItemIngestMetadata` doc comment). Called from inside
 * `stageOneFile`'s transaction on every ingest and every depth promotion, so
 * it always reflects the currently active generation. */
export async function setSourceItemIngestMetadata(
  client: PoolClient,
  input: { spaceId: string; sourceItemId: string; metadata: SourceItemIngestMetadata },
): Promise<void> {
  await client.query(
    `UPDATE kith.source_items SET ingest_metadata = $1 WHERE id = $2 AND space_id = $3`,
    [JSON.stringify(input.metadata), input.sourceItemId, input.spaceId],
  );
}

function buildPageInputs(pages: readonly string[]): {
  fullText: string;
  sourcePages: Array<{ ordinal: number; start: number; end: number; text: string }>;
} {
  let fullText = "";
  const sourcePages = pages.map((text, ordinal) => {
    const start = fullText.length;
    fullText += text;
    return { ordinal, start, end: fullText.length, text };
  });
  return { fullText, sourcePages };
}

async function findOrInsertGeneration(
  client: PoolClient,
  input: {
    spaceId: string;
    sourceAccountId: string;
    sourceItemId: string;
    sourceRevisionId: string;
    processingFingerprint: string;
    extractionFingerprint: string;
    desiredProcessingEpoch: number;
    expected: { pages: number; evidence: number; documents: number; chunks: number };
  },
): Promise<provenance.ProcessingGenerationRow> {
  const existing = await client.query(
    `SELECT * FROM kith.processing_generations WHERE source_revision_id = $1 AND processing_fingerprint = $2 LIMIT 2`,
    [input.sourceRevisionId, input.processingFingerprint],
  );
  if (existing.rowCount && existing.rowCount > 1) {
    throw new Error("Processing generation identity is not unique");
  }
  if (existing.rows[0]) {
    return provenance.camelizeProcessingGeneration(existing.rows[0]);
  }
  const id = newKithId();
  const result = await client.query(
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id,
        processing_fingerprint, extraction_fingerprint, extractor_fingerprint,
        record_schema_fingerprint, normalization_fingerprint, chunker_fingerprint,
        desired_processing_epoch, card_generation, state,
        expected_page_count, expected_evidence_span_count, expected_document_count,
        expected_chunk_count, expected_event_count, expected_observation_count,
        embedding_status)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,'queued',
             $13,$14,$15,$16,0,0,'unavailable')
     RETURNING *`,
    [
      id,
      input.spaceId,
      input.sourceAccountId,
      input.sourceItemId,
      input.sourceRevisionId,
      input.processingFingerprint,
      input.extractionFingerprint,
      EXTRACTOR_FINGERPRINT,
      RECORD_SCHEMA_FINGERPRINT,
      NORMALIZATION_FINGERPRINT,
      CHUNKER_FINGERPRINT,
      input.desiredProcessingEpoch,
      input.expected.pages,
      input.expected.evidence,
      input.expected.documents,
      input.expected.chunks,
    ],
  );
  return provenance.camelizeProcessingGeneration(result.rows[0]!);
}

async function stageOneFile(
  client: PoolClient,
  input: IngestFileInput,
): Promise<IngestFileResult> {
  const { spaceId } = input;
  const item = await provenance.createOrGetSourceItem(client, {
    spaceId,
    sourceAccountId: input.sourceAccountId,
    externalId: input.externalId,
    title: input.title,
    docType: input.docType,
    ...(input.uri === undefined ? {} : { uri: input.uri }),
  });
  await provenance.refreshAvailableSourceItem(client, {
    spaceId,
    sourceItemId: item.id,
    title: input.title,
    docType: input.docType,
    ...(input.uri === undefined ? {} : { uri: input.uri }),
  });
  const { fullText, sourcePages } = buildPageInputs(input.pages);
  const revision = await provenance.createOrGetRevision(client, {
    spaceId,
    sourceItemId: item.id,
    mediaType: input.mediaType,
    inlineText: fullText,
    capturedAt: input.capturedAt,
    userId: input.userId,
    archiveRef: input.fileByteHash,
  });

  const desiredProcessingEpoch =
    item.desiredRevisionId === revision.id
      ? item.desiredProcessingEpoch
      : await provenance.setDesiredSourceRevision(client, {
          spaceId,
          sourceItemId: item.id,
          desiredRevisionId: revision.id,
          expectedDesiredProcessingEpoch: item.desiredProcessingEpoch,
        });

  // Evidence/chunk ranges are computed before staging so the expected counts
  // that go on the generation row are known up front, matching what
  // `inspectGenerationPayload` will verify once staging is done.
  const perPageRanges = input.pages.map((text) => pageChunkRanges(text));
  const totalSpans = perPageRanges.reduce((sum, ranges) => sum + ranges.length, 0);

  const textVersion = await provenance.createOrGetTextVersion(client, {
    spaceId,
    sourceRevisionId: revision.id,
    extractionFingerprint: input.converterFingerprint,
    text: fullText,
  });

  const processingFingerprint = await ingestion.digestProcessingConfiguration({
    extractionFingerprint: input.converterFingerprint,
    extractorFingerprint: EXTRACTOR_FINGERPRINT,
    recordSchemaFingerprint: RECORD_SCHEMA_FINGERPRINT,
    normalizationFingerprint: NORMALIZATION_FINGERPRINT,
    chunkerFingerprint: CHUNKER_FINGERPRINT,
    correctionRevision: CORRECTION_REVISION,
  });
  let generation = await findOrInsertGeneration(client, {
    spaceId,
    sourceAccountId: input.sourceAccountId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    processingFingerprint,
    extractionFingerprint: input.converterFingerprint,
    desiredProcessingEpoch,
    expected: { pages: sourcePages.length, evidence: totalSpans, documents: 1, chunks: totalSpans },
  });
  const reused = generation.state !== "queued" || generation.sourceTextVersionId !== null;
  if (!generation.sourceTextVersionId) {
    await client.query(
      `UPDATE kith.processing_generations SET source_text_version_id = $1 WHERE id = $2 AND space_id = $3`,
      [textVersion.id, generation.id, spaceId],
    );
    generation = { ...generation, sourceTextVersionId: textVersion.id };
  } else if (generation.sourceTextVersionId !== textVersion.id) {
    throw new Error("Processing generation text version changed underneath it");
  }

  // Batched the same way `stageEvidenceSpans`/`stageChunks` already are
  // below: `stagePages` enforces both a MAX_STAGING_ROWS-per-call row limit
  // and a MAX_STAGING_TEXT_UTF8_BYTES-per-call text-byte limit
  // (`requireBatchBounds` in provenance/model.ts), each independent of
  // MAX_SOURCE_PAGES, so a 1000-page document staged in one call would fail
  // on a per-call limit long before the resource limit.
  const stagedPages: provenance.SourcePageRow[] = [];
  for (const batch of batchesByRowsAndBytes(
    sourcePages,
    MAX_STAGING_ROWS,
    MAX_STAGING_TEXT_UTF8_BYTES,
    (page) => page.text,
  )) {
    const staged = await provenance.stagePages(client, {
      spaceId,
      sourceTextVersionId: textVersion.id,
      pages: batch,
    });
    stagedPages.push(...staged);
  }
  if (stagedPages.length !== sourcePages.length) {
    throw new Error("Page staging is incomplete");
  }

  const spanInputs = stagedPages.flatMap((page, pageIndex) =>
    perPageRanges[pageIndex]!.map((range, ordinal) => ({
      sourcePageId: page.id,
      ordinal,
      start: range.start,
      end: range.end,
      locator: { kind: "page" as const, label: `Page ${pageIndex + 1}` },
    })),
  );
  const spanIds: string[] = [];
  for (const batch of batches(spanInputs, MAX_STAGING_ROWS)) {
    const staged = await provenance.stageEvidenceSpans(client, {
      spaceId,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      spans: batch,
    });
    spanIds.push(...staged.map((span) => span.id));
  }
  if (spanIds.length !== spanInputs.length) {
    throw new Error("Evidence span staging is incomplete");
  }

  const [document] = await provenance.stageDocuments(client, {
    spaceId,
    processingGenerationId: generation.id,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    sourceTextVersionId: textVersion.id,
    documents: [
      {
        documentKey: DOCUMENT_KEY,
        title: input.title,
        docType: input.docType,
        capturedAt: input.capturedAt,
        evidenceSpanIds: spanIds,
      },
    ],
  });
  if (!document) throw new Error("Document staging is incomplete");

  // Text materialized up front (not inside the batching callback) so
  // `batchesByRowsAndBytes` can weigh each chunk's real byte size: at this
  // package's 8 KiB chunk target, MAX_STAGING_ROWS (25) chunks can be up to
  // ~200 KiB, well over the per-call MAX_STAGING_TEXT_UTF8_BYTES (128 KiB)
  // `stageChunks` also enforces.
  let spanCursor = 0;
  const chunkInputs = stagedPages.flatMap((_page, pageIndex) =>
    perPageRanges[pageIndex]!.map((range) => {
      const spanId = spanIds[spanCursor]!;
      spanCursor += 1;
      return {
        text: input.pages[pageIndex]!.slice(range.start, range.end),
        evidenceSpanIds: [spanId],
      };
    }),
  );
  let chunkTotal = 0;
  for (const batch of batchesByRowsAndBytes(
    chunkInputs,
    MAX_STAGING_ROWS,
    MAX_STAGING_TEXT_UTF8_BYTES,
    (chunk) => chunk.text,
  )) {
    const staged = await provenance.stageChunks(client, {
      spaceId,
      processingGenerationId: generation.id,
      chunks: batch.map((chunk) => ({
        documentId: document.id,
        ordinal: chunkTotal++,
        text: chunk.text,
        evidenceSpanIds: chunk.evidenceSpanIds,
      })),
    });
    if (staged.length !== batch.length) throw new Error("Chunk staging is incomplete");
  }

  await client.query(
    `UPDATE kith.processing_generations
        SET state = 'staged', actual_page_count = $1, actual_evidence_span_count = $2,
            actual_document_count = 1, actual_chunk_count = $3,
            actual_event_count = 0, actual_observation_count = 0
      WHERE id = $4 AND space_id = $5`,
    [stagedPages.length, spanIds.length, chunkTotal, generation.id, spaceId],
  );

  await provenance.inspectGenerationPayload(client, {
    spaceId,
    processingGenerationId: generation.id,
    sourceTextVersionId: textVersion.id,
    expectedPublicationState: "staged",
  });

  const { previousGenerationId } = await provenance.activateSourceItemGeneration(client, {
    spaceId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    processingGenerationId: generation.id,
    ...(item.activeGenerationId === null ? {} : { expectedPreviousGenerationId: item.activeGenerationId }),
    expectedDesiredProcessingEpoch: desiredProcessingEpoch,
  });
  await client.query(
    `UPDATE kith.processing_generations SET state = 'ready', activated_at = transaction_timestamp() WHERE id = $1`,
    [generation.id],
  );
  if (previousGenerationId) {
    await client.query(
      `UPDATE kith.processing_generations SET deactivated_at = transaction_timestamp() WHERE id = $1`,
      [previousGenerationId],
    );
  }

  // Marks this generation's chunks eligible for embedding (without this,
  // `runEmbeddingFill` finds nothing: it reads `kith.embedding_targets`,
  // which only `touchWorkerPublicationEmbedding` or the identity-gated
  // `markEligibilityTargets` populate) and enqueues classification, exactly
  // as the existing activation paths do -- reused here as a library import
  // from `@repo/kith-store`'s public "./workers" and "./extraction"
  // surfaces, not a copy: nothing under `packages/kith-store/src/workers` is
  // edited by this package. `workerCtx` needs no identity/session, unlike
  // `markEligibilityTargets`'s `IdentityCtx`, which is why this uses it
  // rather than that lower-level function directly.
  const workerCtx = workers.workerCtx(client);
  await workers.touchWorkerPublicationEmbedding(workerCtx, {
    spaceId,
    sourceItemId: item.id,
    sourceAccountId: input.sourceAccountId,
    processingGenerationId: generation.id,
    ...(previousGenerationId ? { previousGenerationId } : {}),
  });
  await scheduleDocumentExtraction(workerCtx, {
    spaceId,
    sourceItemId: item.id,
    processingGenerationId: generation.id,
  });

  if (input.ingestMetadata) {
    await setSourceItemIngestMetadata(client, {
      spaceId,
      sourceItemId: item.id,
      metadata: input.ingestMetadata,
    });
  }

  return {
    sourceItemId: item.id,
    processingGenerationId: generation.id,
    documentId: document.id,
    pageCount: stagedPages.length,
    chunkCount: chunkTotal,
    reused,
  };
}

export async function ingestFile(pool: Pool, input: IngestFileInput): Promise<IngestFileResult> {
  return withKithTransaction(pool, (client) => stageOneFile(client, input));
}
