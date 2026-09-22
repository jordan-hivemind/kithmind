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
// (and a text version's) is capped at 64 KiB and 32 pages by the schema's
// existing `MAX_SOURCE_INLINE_UTF8_BYTES` / `MAX_SOURCE_PAGES` -- a bigger
// document fails per file, logged, and is skipped rather than crashing the
// run.

import type { Pool, PoolClient } from "pg";

import { ingestion, newKithId, provenance, sha256, withKithTransaction, workers } from "@repo/kith-store";
import { scheduleDocumentExtraction } from "@repo/kith-store/extraction";

import { batches, pageChunkRanges } from "./chunker.js";

const MAX_STAGING_ROWS = 25;
const DOCUMENT_KEY = "document:0";
const EXTRACTOR_FINGERPRINT = "ingest-simple";
const RECORD_SCHEMA_FINGERPRINT = "ingest-simple-v1";
const NORMALIZATION_FINGERPRINT = "ingest-simple-v1";
const CHUNKER_FINGERPRINT = "ingest-simple-page-chunks-v1";
const CORRECTION_REVISION = "ingest-simple-v1";

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
   * key `alreadyIngested` checks next run so an unchanged file skips
   * conversion entirely. */
  fileByteHash: string;
  pages: string[];
  converterFingerprint: string;
  mediaType: string;
};

export type IngestFileResult = {
  sourceItemId: string;
  processingGenerationId: string;
  documentId: string;
  pageCount: number;
  chunkCount: number;
  reused: boolean;
};

/**
 * Cheap pre-check, no transaction: true when this source item's *active*
 * generation already carries this exact file content, so the caller can skip
 * conversion (pdftotext/OCR) entirely. A file that changed, or one that was
 * never fully activated (a prior run's partial attempt), is not skipped here
 * -- `ingestFile` resumes it idempotently.
 */
export async function alreadyIngested(
  pool: Pool,
  input: { spaceId: string; sourceAccountId: string; externalId: string; fileByteHash: string },
): Promise<boolean> {
  const externalIdHash = sha256(input.externalId);
  const { rows } = await pool.query<{ archive_ref: string | null }>(
    `SELECT sr.archive_ref
       FROM kith.source_items si
       JOIN kith.source_revisions sr ON sr.id = si.active_revision_id
      WHERE si.space_id = $1 AND si.source_account_id = $2 AND si.external_id_hash = $3
        AND si.active_generation_id IS NOT NULL
      LIMIT 1`,
    [input.spaceId, input.sourceAccountId, externalIdHash],
  );
  return rows[0]?.archive_ref === input.fileByteHash;
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

  const stagedPages = await provenance.stagePages(client, {
    spaceId,
    sourceTextVersionId: textVersion.id,
    pages: sourcePages,
  });
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

  const chunkInputs = stagedPages.flatMap((_page, pageIndex) =>
    perPageRanges[pageIndex]!.map((range) => ({ pageIndex, range })),
  );
  let chunkTotal = 0;
  let spanCursor = 0;
  for (const batch of batches(chunkInputs, MAX_STAGING_ROWS)) {
    const staged = await provenance.stageChunks(client, {
      spaceId,
      processingGenerationId: generation.id,
      chunks: batch.map(({ pageIndex, range }) => {
        const spanId = spanIds[spanCursor]!;
        spanCursor += 1;
        return {
          documentId: document.id,
          ordinal: chunkTotal++,
          text: input.pages[pageIndex]!.slice(range.start, range.end),
          evidenceSpanIds: [spanId],
        };
      }),
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
