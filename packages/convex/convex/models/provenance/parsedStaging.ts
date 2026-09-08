import { getDocumentSize } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { PayloadReadBudget } from "../ingestion/payloadBudget";
import {
  canonicalParsedMappingManifestInput,
  digestParsedMappingManifest,
  parseParsedLocator,
  type ParsedChunkInput,
  type ParsedDocumentInput,
  type ParsedEvidenceInput,
  type ParsedPageInput,
} from "../workers/parsedProtocol";
import { workerProtocolError } from "../workers/errors";
import { sha256Utf8 } from "./model";

const MAX_PAGE_ROW_BYTES = 96 * 1024;
const MAX_EVIDENCE_ROW_BYTES = 8 * 1024;
const MAX_DOCUMENT_ROW_BYTES = 16 * 1024;
const MAX_CHUNK_ROW_BYTES = 24 * 1024;
const MAX_ROW_BYTES = MAX_PAGE_ROW_BYTES;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RETAINED_TEXT_BYTES = 256 * 1024;

type Stage = Doc<"workerParsedStages">;

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0)
    throw workerProtocolError("scan_conflict");
  return value;
}

function rowSize(
  row: Record<string, unknown>,
  maximum = MAX_ROW_BYTES,
): number {
  let size: number;
  try {
    size = getDocumentSize(row as never);
  } catch {
    throw workerProtocolError("invalid_request");
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) {
    throw workerProtocolError("invalid_request");
  }
  return size;
}

function storedRowSize(row: Record<string, unknown>, maximum: number): number {
  try {
    return rowSize(row, maximum);
  } catch {
    throw workerProtocolError("scan_conflict");
  }
}

async function collectIndexedRows<
  T extends { _id: string; _creationTime: number },
>(
  budget: PayloadReadBudget,
  maximumCount: number,
  maximumRowBytes: number,
  query: AsyncIterable<T>,
): Promise<T[]> {
  const rows: T[] = [];
  await budget.finish();
  for await (const row of query) {
    storedRowSize(row as Record<string, unknown>, maximumRowBytes);
    rows.push(row);
    if (rows.length > maximumCount) throw workerProtocolError("scan_conflict");
    await budget.finish();
  }
  return rows;
}

function exactIdSet(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  return (
    new Set(expected).size === expected.length &&
    new Set(actual).size === actual.length &&
    expected.length === actual.length &&
    expected.every((id) => actual.includes(id))
  );
}

function orderRowsByIds<T extends { _id: string }>(
  ids: readonly string[],
  rows: readonly T[],
): T[] {
  const byId = new Map(rows.map((row) => [row._id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw workerProtocolError("scan_conflict");
    return row;
  });
}

async function collectPayloadRows(
  ctx: MutationCtx,
  budget: PayloadReadBudget,
  sourceTextVersionId: Id<"sourceTextVersions">,
  processingGenerationId: Id<"processingGenerations">,
) {
  const pages = await collectIndexedRows(
    budget,
    32,
    MAX_PAGE_ROW_BYTES,
    ctx.db
      .query("sourcePages")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", sourceTextVersionId),
      ),
  );
  const spans = await collectIndexedRows(
    budget,
    128,
    MAX_EVIDENCE_ROW_BYTES,
    ctx.db
      .query("evidenceSpans")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", sourceTextVersionId),
      ),
  );
  const documents = await collectIndexedRows(
    budget,
    16,
    MAX_DOCUMENT_ROW_BYTES,
    ctx.db
      .query("documents")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", processingGenerationId),
      ),
  );
  const chunks = await collectIndexedRows(
    budget,
    128,
    MAX_CHUNK_ROW_BYTES,
    ctx.db
      .query("chunks")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", processingGenerationId),
      ),
  );
  const eventVersions = await collectIndexedRows(
    budget,
    0,
    MAX_EVIDENCE_ROW_BYTES,
    ctx.db
      .query("eventVersions")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", processingGenerationId),
      ),
  );
  const observations = await collectIndexedRows(
    budget,
    0,
    MAX_EVIDENCE_ROW_BYTES,
    ctx.db
      .query("observations")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", processingGenerationId),
      ),
  );
  return { pages, spans, documents, chunks, eventVersions, observations };
}

async function loadPage(ctx: MutationCtx, stage: Stage, ordinal: number) {
  const id = stage.pageIds[ordinal];
  const page = id ? await ctx.db.get(id) : null;
  if (
    !page ||
    page.sourceTextVersionId !== stage.sourceTextVersionId ||
    page.spaceId !== stage.spaceId ||
    page.ordinal !== ordinal
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return page;
}

async function loadSpan(
  ctx: MutationCtx,
  stage: Stage,
  pageOrdinal: number,
  ordinal: number,
) {
  const id = stage.evidenceSpanIds[ordinal];
  const selected = id ? await ctx.db.get(id) : null;
  if (
    !selected ||
    selected.ordinal !== ordinal ||
    selected.spaceId !== stage.spaceId ||
    selected.sourceRevisionId !== stage.sourceRevisionId ||
    selected.sourceTextVersionId !== stage.sourceTextVersionId ||
    stage.pageIds[pageOrdinal] !== selected.sourcePageId
  )
    throw workerProtocolError("scan_conflict");
  return selected;
}

export async function insertParsedPages(
  ctx: MutationCtx,
  stage: Stage,
  rows: ParsedPageInput[],
) {
  const ids: Id<"sourcePages">[] = [];
  let bytes = 0;
  let previousEnd =
    stage.pageIds.length === 0
      ? 0
      : (await loadPage(ctx, stage, stage.pageIds.length - 1)).end;
  for (const row of rows) {
    if (
      row.ordinal !== stage.pageIds.length + ids.length ||
      row.start !== previousEnd ||
      row.end - row.start !== row.text.length ||
      (await sha256Utf8(row.text)) !== row.textHash
    ) {
      throw workerProtocolError("invalid_request");
    }
    const value = {
      spaceId: stage.spaceId,
      sourceTextVersionId: stage.sourceTextVersionId,
      ordinal: row.ordinal,
      start: row.start,
      end: row.end,
      text: row.text,
      textHash: row.textHash,
    };
    const id = await ctx.db.insert("sourcePages", value);
    const stored = await ctx.db.get(id);
    if (!stored) throw workerProtocolError("scan_conflict");
    bytes = checkedAdd(bytes, rowSize(stored, MAX_PAGE_ROW_BYTES));
    ids.push(id);
    previousEnd = row.end;
  }
  return { ids, bytes };
}

export async function insertParsedEvidence(
  ctx: MutationCtx,
  stage: Stage,
  rows: ParsedEvidenceInput[],
) {
  const ids: Id<"evidenceSpans">[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (row.ordinal !== stage.evidenceSpanIds.length + ids.length)
      throw workerProtocolError("invalid_request");
    const page = await loadPage(ctx, stage, row.pageOrdinal);
    if (
      row.end <= row.start ||
      row.end > page.text.length ||
      (await sha256Utf8(page.text.slice(row.start, row.end))) !== row.quoteHash
    ) {
      throw workerProtocolError("invalid_request");
    }
    const locator = {
      ...row.locator,
      parserArtifactId: stage.parserArtifactId,
    };
    const value = {
      spaceId: stage.spaceId,
      sourceRevisionId: stage.sourceRevisionId,
      sourceTextVersionId: stage.sourceTextVersionId,
      sourcePageId: page._id,
      ordinal: row.ordinal,
      start: row.start,
      end: row.end,
      quoteHash: row.quoteHash,
      locator,
    };
    const id = await ctx.db.insert("evidenceSpans", value);
    const stored = await ctx.db.get(id);
    if (!stored) throw workerProtocolError("scan_conflict");
    bytes = checkedAdd(bytes, rowSize(stored, MAX_EVIDENCE_ROW_BYTES));
    ids.push(id);
  }
  return { ids, bytes };
}

export async function insertParsedDocuments(
  ctx: MutationCtx,
  stage: Stage,
  rows: ParsedDocumentInput[],
) {
  const ids: Id<"documents">[] = [];
  let bytes = 0;
  for (const row of rows) {
    const prior = await ctx.db
      .query("documents")
      .withIndex("by_processingGenerationId_and_documentKey", (q) =>
        q
          .eq("processingGenerationId", stage.processingGenerationId)
          .eq("documentKey", row.documentKey),
      )
      .take(1);
    if (prior.length) throw workerProtocolError("request_conflict");
    const evidenceSpanIds = [] as Id<"evidenceSpans">[];
    for (const ref of row.evidence)
      evidenceSpanIds.push(
        (await loadSpan(ctx, stage, ref.pageOrdinal, ref.evidenceOrdinal))._id,
      );
    if (new Set(evidenceSpanIds).size !== evidenceSpanIds.length)
      throw workerProtocolError("invalid_request");
    const value = {
      spaceId: stage.spaceId,
      processingGenerationId: stage.processingGenerationId,
      sourceItemId: stage.sourceItemId,
      sourceRevisionId: stage.sourceRevisionId,
      sourceTextVersionId: stage.sourceTextVersionId,
      documentKey: row.documentKey,
      title: row.title,
      docType: row.docType,
      capturedAt: row.capturedAt,
      evidenceSpanIds,
      publicationState: "staged" as const,
    };
    const id = await ctx.db.insert("documents", value);
    const stored = await ctx.db.get(id);
    if (!stored) throw workerProtocolError("scan_conflict");
    bytes = checkedAdd(bytes, rowSize(stored, MAX_DOCUMENT_ROW_BYTES));
    ids.push(id);
  }
  return { ids, bytes };
}

async function loadDocument(ctx: MutationCtx, stage: Stage, key: string) {
  const matches = await ctx.db
    .query("documents")
    .withIndex("by_processingGenerationId_and_documentKey", (q) =>
      q
        .eq("processingGenerationId", stage.processingGenerationId)
        .eq("documentKey", key),
    )
    .take(2);
  if (
    matches.length !== 1 ||
    matches[0]!.spaceId !== stage.spaceId ||
    matches[0]!.sourceTextVersionId !== stage.sourceTextVersionId ||
    !stage.documentIds.includes(matches[0]!._id)
  )
    throw workerProtocolError("scan_conflict");
  return matches[0]!;
}

export async function insertParsedChunks(
  ctx: MutationCtx,
  stage: Stage,
  rows: ParsedChunkInput[],
) {
  const ids: Id<"chunks">[] = [];
  let bytes = 0;
  for (const row of rows) {
    const document = await loadDocument(ctx, stage, row.documentKey);
    const prior = await ctx.db
      .query("chunks")
      .withIndex("by_documentId_and_ordinal", (q) =>
        q.eq("documentId", document._id).eq("ordinal", row.ordinal),
      )
      .take(1);
    if (
      prior.length ||
      row.end <= row.start ||
      row.text.length !== row.end - row.start
    )
      throw workerProtocolError("invalid_request");
    const evidenceSpanIds = [] as Id<"evidenceSpans">[];
    for (const ref of row.evidence)
      evidenceSpanIds.push(
        (await loadSpan(ctx, stage, ref.pageOrdinal, ref.evidenceOrdinal))._id,
      );
    if (
      new Set(evidenceSpanIds).size !== evidenceSpanIds.length ||
      evidenceSpanIds.some((id) => !document.evidenceSpanIds.includes(id))
    )
      throw workerProtocolError("invalid_request");
    const value = {
      spaceId: stage.spaceId,
      processingGenerationId: stage.processingGenerationId,
      documentId: document._id,
      ordinal: row.ordinal,
      sourceTextVersionId: stage.sourceTextVersionId,
      start: row.start,
      end: row.end,
      text: row.text,
      evidenceSpanIds,
      publicationState: "staged" as const,
    };
    const id = await ctx.db.insert("chunks", value);
    const stored = await ctx.db.get(id);
    if (!stored) throw workerProtocolError("scan_conflict");
    bytes = checkedAdd(bytes, rowSize(stored, MAX_CHUNK_ROW_BYTES));
    ids.push(id);
  }
  return { ids, bytes };
}

function strippedLocator(
  locator: NonNullable<Doc<"evidenceSpans">["locator"]>,
) {
  if (
    locator.kind !== "parser_item_v1" &&
    locator.kind !== "parser_table_row_v1"
  )
    throw workerProtocolError("scan_conflict");
  const { parserArtifactId: _ignored, ...rest } = locator;
  return parseParsedLocator(rest);
}

async function digestRows(domain: string, rows: unknown[]): Promise<string> {
  return sha256Utf8(`${domain}\0${JSON.stringify(rows)}`);
}

export async function sealParsedPayload(
  ctx: MutationCtx,
  stage: Stage,
  now: number,
) {
  const budget = new PayloadReadBudget(ctx);
  const collected = await collectPayloadRows(
    ctx,
    budget,
    stage.sourceTextVersionId,
    stage.processingGenerationId,
  );
  if (
    collected.eventVersions.length !== 0 ||
    collected.observations.length !== 0 ||
    !exactIdSet(
      stage.pageIds,
      collected.pages.map((row) => row._id),
    ) ||
    !exactIdSet(
      stage.evidenceSpanIds,
      collected.spans.map((row) => row._id),
    ) ||
    !exactIdSet(
      stage.documentIds,
      collected.documents.map((row) => row._id),
    ) ||
    !exactIdSet(
      stage.chunkIds,
      collected.chunks.map((row) => row._id),
    ) ||
    collected.pages.length !== stage.expectedPageCount ||
    collected.spans.length !== stage.expectedEvidenceSpanCount ||
    collected.documents.length !== stage.expectedDocumentCount ||
    collected.chunks.length !== stage.expectedChunkCount
  )
    throw workerProtocolError("scan_conflict");
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
      throw workerProtocolError("scan_conflict");
    completeText += page.text;
    pageInputs.push({
      ordinal,
      start: page.start,
      end: page.end,
      text: page.text,
      textHash: page.textHash,
    });
  }
  const textBytes = new TextEncoder().encode(completeText).byteLength;
  if (textBytes > MAX_RETAINED_TEXT_BYTES)
    throw workerProtocolError("scan_conflict");
  const pageById = new Map(pages.map((row) => [row._id, row]));
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
      throw workerProtocolError("scan_conflict");
    const storedLocator = span.locator;
    if (
      !storedLocator ||
      (storedLocator.kind !== "parser_item_v1" &&
        storedLocator.kind !== "parser_table_row_v1") ||
      storedLocator.parserArtifactId !== stage.parserArtifactId
    )
      throw workerProtocolError("scan_conflict");
    const locator = strippedLocator(storedLocator);
    return {
      ordinal,
      pageOrdinal: page.ordinal,
      start: span.start,
      end: span.end,
      quoteHash: span.quoteHash,
      locator,
    } as ParsedEvidenceInput;
  });
  for (const input of evidenceInputs) {
    const page = pages[input.pageOrdinal]!;
    if (
      (await sha256Utf8(page.text.slice(input.start, input.end))) !==
      input.quoteHash
    )
      throw workerProtocolError("scan_conflict");
  }
  if (
    (await digestParsedMappingManifest(pageInputs, evidenceInputs)) !==
    stage.mappingManifestHash
  )
    throw workerProtocolError("scan_conflict");
  const spanIds = new Set(spans.map((row) => row._id));
  const documentKeys = new Set<string>();
  for (const document of documents) {
    if (
      document.spaceId !== stage.spaceId ||
      document.processingGenerationId !== stage.processingGenerationId ||
      document.sourceItemId !== stage.sourceItemId ||
      document.sourceRevisionId !== stage.sourceRevisionId ||
      document.sourceTextVersionId !== stage.sourceTextVersionId ||
      document.publicationState !== "staged" ||
      new Set(document.evidenceSpanIds).size !==
        document.evidenceSpanIds.length ||
      document.evidenceSpanIds.some((id) => !spanIds.has(id))
    )
      throw workerProtocolError("scan_conflict");
    if (documentKeys.has(document.documentKey))
      throw workerProtocolError("scan_conflict");
    documentKeys.add(document.documentKey);
  }
  const documentById = new Map(documents.map((row) => [row._id, row]));
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
        !Number.isSafeInteger(chunk.start) ||
        !Number.isSafeInteger(chunk.end) ||
        chunk.start === undefined ||
        chunk.end === undefined ||
        chunk.start < 0 ||
        chunk.end <= chunk.start ||
        chunk.end > completeText.length ||
        completeText.slice(chunk.start, chunk.end) !== chunk.text ||
        chunk.publicationState !== "staged" ||
        new Set(chunk.evidenceSpanIds).size !== chunk.evidenceSpanIds.length ||
        chunk.evidenceSpanIds.some(
          (id) => !document.evidenceSpanIds.includes(id),
        )
      )
        throw workerProtocolError("scan_conflict");
      chunkTextBytes = checkedAdd(
        chunkTextBytes,
        new TextEncoder().encode(chunk.text).byteLength,
      );
      const ordinals = chunkOrdinals.get(chunk.documentId) ?? [];
      ordinals.push(chunk.ordinal);
      chunkOrdinals.set(chunk.documentId, ordinals);
      return [chunk.start, chunk.end] as const;
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cursor = 0;
  for (const [start, end] of coverage) {
    if (start > cursor) throw workerProtocolError("scan_conflict");
    cursor = Math.max(cursor, end);
  }
  if (
    cursor !== completeText.length ||
    chunkTextBytes > MAX_RETAINED_TEXT_BYTES
  )
    throw workerProtocolError("scan_conflict");
  for (const ordinals of chunkOrdinals.values()) {
    ordinals.sort((a, b) => a - b);
    if (ordinals.some((value, index) => value !== index))
      throw workerProtocolError("scan_conflict");
  }
  const textHash = await sha256Utf8(completeText);
  const textVersion = await budget.read(
    stage.sourceTextVersionId,
    MAX_ROW_BYTES,
  );
  if (
    !textVersion ||
    textVersion.textHash !== textHash ||
    textVersion.byteLength !== textBytes ||
    textVersion.utf16Length !== completeText.length ||
    textVersion.pageCount !== pages.length ||
    textVersion.mappingManifestHash !== stage.mappingManifestHash ||
    textVersion.evidenceSealed
  )
    throw workerProtocolError("scan_conflict");
  await budget.finish();
  const pageBytes = pages.reduce(
    (sum, row) => checkedAdd(sum, storedRowSize(row, MAX_PAGE_ROW_BYTES)),
    0,
  );
  const evidenceBytes = spans.reduce(
    (sum, row) => checkedAdd(sum, storedRowSize(row, MAX_EVIDENCE_ROW_BYTES)),
    0,
  );
  const documentBytes = documents.reduce(
    (sum, row) => checkedAdd(sum, storedRowSize(row, MAX_DOCUMENT_ROW_BYTES)),
    0,
  );
  const chunkBytes = chunks.reduce(
    (sum, row) => checkedAdd(sum, storedRowSize(row, MAX_CHUNK_ROW_BYTES)),
    0,
  );
  if (
    pageBytes !== stage.pageBytes ||
    evidenceBytes !== stage.evidenceBytes ||
    documentBytes !== stage.documentBytes ||
    chunkBytes !== stage.chunkBytes
  )
    throw workerProtocolError("scan_conflict");
  const chunkDigestRows = [] as unknown[];
  for (const row of chunks)
    chunkDigestRows.push([
      row.documentId,
      row.ordinal,
      row.start,
      row.end,
      await sha256Utf8(row.text),
      row.evidenceSpanIds,
    ]);
  const manifest = {
    spaceId: stage.spaceId,
    sourceAccountId: stage.sourceAccountId,
    sourceItemId: stage.sourceItemId,
    sourceRevisionId: stage.sourceRevisionId,
    sourceTextVersionId: stage.sourceTextVersionId,
    parserArtifactId: stage.parserArtifactId,
    processingGenerationId: stage.processingGenerationId,
    archiveSetDigest: stage.archiveSetDigest,
    normalizedBundleDigest: stage.normalizedBundleDigest,
    mappingManifestHash: stage.mappingManifestHash,
    pageIds: stage.pageIds,
    evidenceSpanIds: stage.evidenceSpanIds,
    documentIds: stage.documentIds,
    chunkIds: stage.chunkIds,
    pageCount: pages.length,
    evidenceSpanCount: spans.length,
    documentCount: documents.length,
    chunkCount: chunks.length,
    pageBytes,
    evidenceBytes,
    documentBytes,
    chunkBytes,
    pageDigest: await digestRows(
      "parsed-pages:v1",
      pageInputs.map(({ ordinal, start, end, textHash }) => [
        ordinal,
        start,
        end,
        textHash,
      ]),
    ),
    evidenceDigest: await digestRows(
      "parsed-evidence:v1",
      canonicalParsedMappingManifestInput([], evidenceInputs)[2] as unknown[],
    ),
    documentDigest: await digestRows(
      "parsed-documents:v1",
      documents.map((row) => [
        row.documentKey,
        row.title,
        row.docType,
        row.capturedAt,
        row.evidenceSpanIds,
      ]),
    ),
    chunkDigest: await digestRows("parsed-chunks:v1", chunkDigestRows),
    retainedTextHash: textHash,
    retainedTextUtf8Length: textBytes,
    retainedTextUtf16Length: completeText.length,
    manifestVersion: "parsed_payload_v1" as const,
    createdAt: now,
  };
  rowSize(manifest, MAX_MANIFEST_BYTES);
  const manifestId = await ctx.db.insert(
    "processingGenerationPayloadManifests",
    manifest,
  );
  await ctx.db.patch(stage.sourceTextVersionId, {
    evidenceSealed: true,
    textHashAuthority: "server_verified_retained_text",
  });
  await ctx.db.patch(stage.processingGenerationId, {
    state: "staged",
    actualPageCount: pages.length,
    actualEvidenceSpanCount: spans.length,
    actualDocumentCount: documents.length,
    actualChunkCount: chunks.length,
    actualEventCount: 0,
    actualObservationCount: 0,
    payloadManifestId: manifestId,
  });
  await ctx.db.patch(stage.ingestJobId, { state: "staged" });
  await ctx.db.patch(stage._id, {
    phase: "staged",
    payloadManifestId: manifestId,
    updatedAt: now,
  });
  return {
    manifestId,
    pageCount: pages.length,
    evidenceSpanCount: spans.length,
    documentCount: documents.length,
    chunkCount: chunks.length,
  };
}

export async function verifySealedParsedPayload(
  ctx: MutationCtx,
  generation: Doc<"processingGenerations">,
  outerBudget?: PayloadReadBudget,
) {
  if (
    !generation.payloadManifestId ||
    !generation.sourceTextVersionId ||
    !generation.parserArtifactId
  )
    throw workerProtocolError("scan_conflict");
  const budget = outerBudget ?? new PayloadReadBudget(ctx);
  const manifest = await budget.read(
    generation.payloadManifestId,
    MAX_MANIFEST_BYTES,
  );
  const text = await budget.read(generation.sourceTextVersionId, MAX_ROW_BYTES);
  if (
    !manifest ||
    !text ||
    manifest.processingGenerationId !== generation._id ||
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
    throw workerProtocolError("scan_conflict");
  const collected = await collectPayloadRows(
    ctx,
    budget,
    text._id,
    generation._id,
  );
  if (
    collected.eventVersions.length !== 0 ||
    collected.observations.length !== 0 ||
    !exactIdSet(
      manifest.pageIds,
      collected.pages.map((row) => row._id),
    ) ||
    !exactIdSet(
      manifest.evidenceSpanIds,
      collected.spans.map((row) => row._id),
    ) ||
    !exactIdSet(
      manifest.documentIds,
      collected.documents.map((row) => row._id),
    ) ||
    !exactIdSet(
      manifest.chunkIds,
      collected.chunks.map((row) => row._id),
    ) ||
    collected.pages.length !== manifest.pageCount ||
    collected.spans.length !== manifest.evidenceSpanCount ||
    collected.documents.length !== manifest.documentCount ||
    collected.chunks.length !== manifest.chunkCount ||
    collected.pages.length !== generation.expectedPageCount ||
    collected.spans.length !== generation.expectedEvidenceSpanCount ||
    collected.documents.length !== generation.expectedDocumentCount ||
    collected.chunks.length !== generation.expectedChunkCount
  )
    throw workerProtocolError("scan_conflict");
  const pages = orderRowsByIds(manifest.pageIds, collected.pages);
  const spans = orderRowsByIds(manifest.evidenceSpanIds, collected.spans);
  const documents = orderRowsByIds(manifest.documentIds, collected.documents);
  const chunks = orderRowsByIds(manifest.chunkIds, collected.chunks);
  let completeText = "";
  const pageInputs: ParsedPageInput[] = [];
  for (let ordinal = 0; ordinal < pages.length; ordinal += 1) {
    const page = pages[ordinal]!;
    if (
      page.ordinal !== ordinal ||
      page.spaceId !== generation.spaceId ||
      page.sourceTextVersionId !== text._id ||
      page.start !== completeText.length ||
      page.end !== page.start + page.text.length ||
      (await sha256Utf8(page.text)) !== page.textHash
    )
      throw workerProtocolError("scan_conflict");
    completeText += page.text;
    pageInputs.push({
      ordinal,
      start: page.start,
      end: page.end,
      text: page.text,
      textHash: page.textHash,
    });
  }
  const pageById = new Map(pages.map((row) => [row._id, row]));
  const evidenceInputs: ParsedEvidenceInput[] = [];
  for (let ordinal = 0; ordinal < spans.length; ordinal += 1) {
    const span = spans[ordinal]!;
    const page = pageById.get(span.sourcePageId);
    const locator = span.locator;
    if (
      !page ||
      span.ordinal !== ordinal ||
      span.spaceId !== generation.spaceId ||
      span.sourceRevisionId !== generation.sourceRevisionId ||
      span.sourceTextVersionId !== text._id ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > page.text.length ||
      !locator ||
      (locator.kind !== "parser_item_v1" &&
        locator.kind !== "parser_table_row_v1") ||
      locator.parserArtifactId !== generation.parserArtifactId ||
      (await sha256Utf8(page.text.slice(span.start, span.end))) !==
        span.quoteHash
    )
      throw workerProtocolError("scan_conflict");
    evidenceInputs.push({
      ordinal,
      pageOrdinal: page.ordinal,
      start: span.start,
      end: span.end,
      quoteHash: span.quoteHash,
      locator: strippedLocator(locator),
    });
  }
  const textBytes = new TextEncoder().encode(completeText).byteLength;
  if (
    textBytes > MAX_RETAINED_TEXT_BYTES ||
    text.textHash !== (await sha256Utf8(completeText)) ||
    text.byteLength !== textBytes ||
    text.utf16Length !== completeText.length ||
    text.pageCount !== pages.length ||
    (await digestParsedMappingManifest(pageInputs, evidenceInputs)) !==
      manifest.mappingManifestHash
  )
    throw workerProtocolError("scan_conflict");
  const spanIds = new Set(spans.map((row) => row._id));
  const documentById = new Map(documents.map((row) => [row._id, row]));
  const expectedPublicationState =
    generation.state === "staged"
      ? "staged"
      : generation.state === "ready" && generation.deactivatedAt === undefined
        ? "active"
        : generation.state === "ready" && generation.deactivatedAt !== undefined
          ? "historical"
          : undefined;
  if (!expectedPublicationState) throw workerProtocolError("scan_conflict");
  const documentKeys = new Set<string>();
  for (const document of documents) {
    if (
      document.spaceId !== generation.spaceId ||
      document.processingGenerationId !== generation._id ||
      document.sourceItemId !== generation.sourceItemId ||
      document.sourceRevisionId !== generation.sourceRevisionId ||
      document.sourceTextVersionId !== text._id ||
      document.publicationState !== expectedPublicationState ||
      new Set(document.evidenceSpanIds).size !==
        document.evidenceSpanIds.length ||
      document.evidenceSpanIds.some((id) => !spanIds.has(id))
    )
      throw workerProtocolError("scan_conflict");
    if (documentKeys.has(document.documentKey))
      throw workerProtocolError("scan_conflict");
    documentKeys.add(document.documentKey);
  }
  let chunkTextBytes = 0;
  const coverage: Array<readonly [number, number]> = [];
  const chunkDigestRows: unknown[] = [];
  const chunkOrdinals = new Map<string, number[]>();
  for (const chunk of chunks) {
    const document = documentById.get(chunk.documentId);
    if (
      !document ||
      chunk.spaceId !== generation.spaceId ||
      chunk.processingGenerationId !== generation._id ||
      chunk.sourceTextVersionId !== text._id ||
      !Number.isSafeInteger(chunk.ordinal) ||
      chunk.ordinal < 0 ||
      !Number.isSafeInteger(chunk.start) ||
      !Number.isSafeInteger(chunk.end) ||
      chunk.start === undefined ||
      chunk.end === undefined ||
      chunk.start < 0 ||
      chunk.end <= chunk.start ||
      chunk.end > completeText.length ||
      completeText.slice(chunk.start, chunk.end) !== chunk.text ||
      chunk.publicationState !== expectedPublicationState ||
      new Set(chunk.evidenceSpanIds).size !== chunk.evidenceSpanIds.length ||
      chunk.evidenceSpanIds.some((id) => !document.evidenceSpanIds.includes(id))
    )
      throw workerProtocolError("scan_conflict");
    chunkTextBytes = checkedAdd(
      chunkTextBytes,
      new TextEncoder().encode(chunk.text).byteLength,
    );
    coverage.push([chunk.start, chunk.end]);
    const ordinals = chunkOrdinals.get(chunk.documentId) ?? [];
    ordinals.push(chunk.ordinal);
    chunkOrdinals.set(chunk.documentId, ordinals);
    chunkDigestRows.push([
      chunk.documentId,
      chunk.ordinal,
      chunk.start,
      chunk.end,
      await sha256Utf8(chunk.text),
      chunk.evidenceSpanIds,
    ]);
  }
  coverage.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cursor = 0;
  for (const [start, end] of coverage) {
    if (start > cursor) throw workerProtocolError("scan_conflict");
    cursor = Math.max(cursor, end);
  }
  if (
    cursor !== completeText.length ||
    chunkTextBytes > MAX_RETAINED_TEXT_BYTES
  )
    throw workerProtocolError("scan_conflict");
  for (const ordinals of chunkOrdinals.values()) {
    ordinals.sort((left, right) => left - right);
    if (ordinals.some((value, index) => value !== index))
      throw workerProtocolError("scan_conflict");
  }
  const pageBytes = pages.reduce(
    (sum, row) => checkedAdd(sum, storedRowSize(row, MAX_PAGE_ROW_BYTES)),
    0,
  );
  const evidenceBytes = spans.reduce(
    (sum, row) => checkedAdd(sum, storedRowSize(row, MAX_EVIDENCE_ROW_BYTES)),
    0,
  );
  const documentBytes = documents.reduce(
    (sum, row) =>
      checkedAdd(
        sum,
        storedRowSize(
          { ...row, publicationState: "staged" },
          MAX_DOCUMENT_ROW_BYTES,
        ),
      ),
    0,
  );
  const chunkBytes = chunks.reduce(
    (sum, row) =>
      checkedAdd(
        sum,
        storedRowSize(
          { ...row, publicationState: "staged" },
          MAX_CHUNK_ROW_BYTES,
        ),
      ),
    0,
  );
  if (
    manifest.pageBytes !== pageBytes ||
    manifest.evidenceBytes !== evidenceBytes ||
    manifest.documentBytes !== documentBytes ||
    manifest.chunkBytes !== chunkBytes ||
    manifest.pageDigest !==
      (await digestRows(
        "parsed-pages:v1",
        pageInputs.map(({ ordinal, start, end, textHash }) => [
          ordinal,
          start,
          end,
          textHash,
        ]),
      )) ||
    manifest.evidenceDigest !==
      (await digestRows(
        "parsed-evidence:v1",
        canonicalParsedMappingManifestInput([], evidenceInputs)[2] as unknown[],
      )) ||
    manifest.documentDigest !==
      (await digestRows(
        "parsed-documents:v1",
        documents.map((row) => [
          row.documentKey,
          row.title,
          row.docType,
          row.capturedAt,
          row.evidenceSpanIds,
        ]),
      )) ||
    manifest.chunkDigest !==
      (await digestRows("parsed-chunks:v1", chunkDigestRows)) ||
    manifest.retainedTextHash !== text.textHash ||
    manifest.retainedTextUtf8Length !== textBytes ||
    manifest.retainedTextUtf16Length !== completeText.length
  )
    throw workerProtocolError("scan_conflict");
  if (!outerBudget) await budget.finish();
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
