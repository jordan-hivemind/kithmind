import { deleteGenerationRecordsBatch } from "../records/model";
import { invalidateRecordQueriesForForget } from "../records/querySessions";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { deleteChunkEmbeddingVectors } from "../embeddings/model";
import {
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
  requireInlineSourceRevision,
  requireInlineSourceTextVersion,
} from "./representations";
import { loadArchiveDeletionAck } from "./archiveDeletion";

export const MAX_SOURCE_INLINE_UTF8_BYTES = 65_536;
export const MAX_SOURCE_PAGES = 32;
const MAX_PARSED_SOURCE_PAGES = 64;
export const MAX_EVIDENCE_SPANS = 128;
export const MAX_GENERATION_DOCUMENTS = 16;
export const MAX_GENERATION_CHUNKS = 128;
const MAX_PARSED_GENERATION_CHUNKS = 256;
const MAX_PARSED_GENERATION_CHUNK_TEXT_UTF8_BYTES = 1_024 * 1_024;
const MAX_PARSED_TRANSITION_BYTES = 2 * 1_024 * 1_024;
export const MAX_CHUNK_TEXT_UTF8_BYTES = 16 * 1_024;
export const MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES = 256 * 1_024;
export const MAX_STAGING_ROWS = 25;
export const MAX_STAGING_TEXT_UTF8_BYTES = 128 * 1_024;
export const MAX_PROVENANCE_CLEANUP_ROWS = 25;

const MAX_EXTERNAL_ID_BYTES = 4_096;
const MAX_TITLE_CHARS = 1_000;
const MAX_DOC_TYPE_CHARS = 128;
const MAX_URI_BYTES = 8_192;
const MAX_FINGERPRINT_BYTES = 1_024;
const MAX_MEDIA_TYPE_CHARS = 255;
const MAX_ARCHIVE_REF_BYTES = 8_192;
const MAX_DOCUMENT_KEY_BYTES = 1_024;
const MAX_LOCATOR_TEXT_CHARS = 1_000;

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type EvidenceLocator = Doc<"evidenceSpans">["locator"];

export type SourceItemInput = {
  spaceId: Id<"spaces">;
  sourceAccountId: Id<"sourceAccounts">;
  externalId: string;
  title?: string;
  docType?: string;
  uri?: string;
};

export type SourceRevisionInput = {
  spaceId: Id<"spaces">;
  sourceItemId: Id<"sourceItems">;
  mediaType: string;
  inlineText: string;
  capturedAt: number;
  userId: Id<"users">;
  archiveRef?: string;
};

export type SourceTextVersionInput = {
  spaceId: Id<"spaces">;
  sourceRevisionId: Id<"sourceRevisions">;
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
  sourcePageId: Id<"sourcePages">;
  ordinal: number;
  start: number;
  end: number;
  locator?: EvidenceLocator;
};

export type DocumentInput = {
  documentKey: string;
  title: string;
  docType: string;
  capturedAt: number;
  evidenceSpanIds: Id<"evidenceSpans">[];
};

export type ChunkInput = {
  documentId: Id<"documents">;
  ordinal: number;
  text: string;
  evidenceSpanIds: Id<"evidenceSpans">[];
};

export type GenerationPayloadSummary = {
  pageOrdinals: number[];
  evidenceSpanOrdinalsByPage: Array<{
    sourcePageId: Id<"sourcePages">;
    ordinals: number[];
  }>;
  documentKeys: string[];
  chunkOrdinalsByDocument: Array<{
    documentId: Id<"documents">;
    ordinals: number[];
  }>;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function requireFiniteTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite timestamp`);
  }
}

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

function requireUtf16Boundary(
  text: string,
  offset: number,
  label: string,
): void {
  requireIntegerInRange(offset, label, 0, text.length);
  if (offset === 0 || offset === text.length) return;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  if (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  ) {
    throw new Error(`${label} splits a UTF-16 surrogate pair`);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

function sameLocator(left: EvidenceLocator, right: EvidenceLocator): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "page" && right.kind === "page")
    return left.label === right.label;
  if (left.kind === "section" && right.kind === "section") {
    return left.heading === right.heading;
  }
  if (left.kind === "sheet" && right.kind === "sheet") {
    return left.sheet === right.sheet && left.range === right.range;
  }
  if (left.kind === "parser_page_v1" && right.kind === "parser_page_v1") {
    return (
      left.parserArtifactId === right.parserArtifactId &&
      left.pageNumber === right.pageNumber &&
      left.pageTextHash === right.pageTextHash
    );
  }
  if (left.kind !== "pdf" || right.kind !== "pdf") return false;
  if (left.pageNumber !== right.pageNumber) return false;
  if (left.boundingBox === undefined || right.boundingBox === undefined) {
    return left.boundingBox === right.boundingBox;
  }
  return (
    left.boundingBox.left === right.boundingBox.left &&
    left.boundingBox.top === right.boundingBox.top &&
    left.boundingBox.right === right.boundingBox.right &&
    left.boundingBox.bottom === right.boundingBox.bottom
  );
}

function requireUniqueIds(
  ids: readonly string[],
  label: string,
  maximum: number,
): void {
  if (ids.length > maximum)
    throw new Error(`${label} exceeds the limit of ${maximum}`);
  if (new Set(ids).size !== ids.length)
    throw new Error(`${label} contains duplicates`);
}

function requireBatchBounds(
  rowCount: number,
  textValues: readonly string[],
  resourceMaximum: number,
  label: string,
): void {
  if (rowCount === 0) throw new Error(`${label} must contain at least one row`);
  if (rowCount > MAX_STAGING_ROWS) {
    throw new Error(
      `${label} exceeds the per-call row limit of ${MAX_STAGING_ROWS}`,
    );
  }
  if (rowCount > resourceMaximum) {
    throw new Error(
      `${label} exceeds the resource limit of ${resourceMaximum}`,
    );
  }
  const bytes = textValues.reduce(
    (total, value) => total + utf8Length(value),
    0,
  );
  if (bytes > MAX_STAGING_TEXT_UTF8_BYTES) {
    throw new Error(
      `${label} exceeds the per-call text limit of ${MAX_STAGING_TEXT_UTF8_BYTES} UTF-8 bytes`,
    );
  }
}

function requireLocator(locator: EvidenceLocator): void {
  if (locator === undefined) return;
  if (locator.kind === "page") {
    requireOptionalBoundedString(
      locator.label,
      "Page locator label",
      MAX_LOCATOR_TEXT_CHARS,
    );
    return;
  }
  if (locator.kind === "section") {
    requireBoundedString(
      locator.heading,
      "Section locator heading",
      MAX_LOCATOR_TEXT_CHARS,
    );
    return;
  }
  if (locator.kind === "sheet") {
    requireBoundedString(
      locator.sheet,
      "Sheet locator name",
      MAX_LOCATOR_TEXT_CHARS,
    );
    requireBoundedString(locator.range, "Sheet locator range", 128);
    return;
  }
  if (locator.kind === "parser_item_v1") {
    requireIntegerInRange(
      locator.pageNumber,
      "Parser page number",
      1,
      1_000_000,
    );
    requireBoundedString(
      locator.itemRef,
      "Parser item reference",
      MAX_LOCATOR_TEXT_CHARS,
    );
    requireIntegerInRange(
      locator.sourceCharStart,
      "Parser source start",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    requireIntegerInRange(
      locator.sourceCharEnd,
      "Parser source end",
      locator.sourceCharStart,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      locator.bbox &&
      (locator.bbox.length !== 4 || !locator.bbox.every(Number.isFinite))
    )
      throw new Error("Parser bounding box is invalid");
    return;
  }
  if (locator.kind === "parser_page_v1") {
    requireIntegerInRange(
      locator.pageNumber,
      "Parser page number",
      1,
      MAX_PARSED_SOURCE_PAGES,
    );
    if (!/^[a-f0-9]{64}$/.test(locator.pageTextHash))
      throw new Error("Parser page text hash is invalid");
    return;
  }
  if (locator.kind === "parser_table_row_v1") {
    requireIntegerInRange(
      locator.pageNumber,
      "Parser table page number",
      1,
      1_000_000,
    );
    requireBoundedString(
      locator.tableRef,
      "Parser table reference",
      MAX_LOCATOR_TEXT_CHARS,
    );
    requireIntegerInRange(
      locator.sourceRowOffset,
      "Parser row offset",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      locator.bbox &&
      (locator.bbox.length !== 4 || !locator.bbox.every(Number.isFinite))
    )
      throw new Error("Parser table bounding box is invalid");
    return;
  }
  requireIntegerInRange(locator.pageNumber, "PDF page number", 1, 1_000_000);
  if (locator.boundingBox) {
    const { left, top, right, bottom } = locator.boundingBox;
    if (![left, top, right, bottom].every(Number.isFinite)) {
      throw new Error("PDF bounding box coordinates must be finite");
    }
    if (right <= left || bottom <= top) {
      throw new Error("PDF bounding box must have positive width and height");
    }
  }
}

async function requireSourceAccount(
  ctx: ReadCtx,
  sourceAccountId: Id<"sourceAccounts">,
  spaceId: Id<"spaces">,
): Promise<Doc<"sourceAccounts">> {
  const account = await ctx.db.get(sourceAccountId);
  if (!account) throw new Error("Source account does not exist");
  if (account.spaceId !== spaceId)
    throw new Error("Source account belongs to another space");
  return account;
}

async function requireSourceItem(
  ctx: ReadCtx,
  sourceItemId: Id<"sourceItems">,
  spaceId: Id<"spaces">,
): Promise<Doc<"sourceItems">> {
  const item = await ctx.db.get(sourceItemId);
  if (!item) throw new Error("Source item does not exist");
  if (item.spaceId !== spaceId)
    throw new Error("Source item belongs to another space");
  return item;
}

async function requireSourceRevision(
  ctx: ReadCtx,
  sourceRevisionId: Id<"sourceRevisions">,
  spaceId: Id<"spaces">,
): Promise<Doc<"sourceRevisions">> {
  const revision = await ctx.db.get(sourceRevisionId);
  if (!revision) throw new Error("Source revision does not exist");
  if (revision.spaceId !== spaceId)
    throw new Error("Source revision belongs to another space");
  parseSourceRevisionRepresentation(revision);
  return revision;
}

async function requireTextVersion(
  ctx: ReadCtx,
  sourceTextVersionId: Id<"sourceTextVersions">,
  spaceId: Id<"spaces">,
): Promise<Doc<"sourceTextVersions">> {
  const textVersion = await ctx.db.get(sourceTextVersionId);
  if (!textVersion) throw new Error("Source text version does not exist");
  if (textVersion.spaceId !== spaceId) {
    throw new Error("Source text version belongs to another space");
  }
  parseSourceTextRepresentation(textVersion);
  return textVersion;
}

async function requireGeneration(
  ctx: ReadCtx,
  processingGenerationId: Id<"processingGenerations">,
  spaceId: Id<"spaces">,
): Promise<Doc<"processingGenerations">> {
  const generation = await ctx.db.get(processingGenerationId);
  if (!generation) throw new Error("Processing generation does not exist");
  if (generation.spaceId !== spaceId) {
    throw new Error("Processing generation belongs to another space");
  }
  return generation;
}

export async function createOrGetSourceItem(
  ctx: MutationCtx,
  input: SourceItemInput,
): Promise<Doc<"sourceItems">> {
  await requireSourceAccount(ctx, input.sourceAccountId, input.spaceId);
  requireBoundedUtf8(
    input.externalId,
    "External source ID",
    MAX_EXTERNAL_ID_BYTES,
  );
  requireOptionalBoundedString(input.title, "Source title", MAX_TITLE_CHARS);
  requireOptionalBoundedString(
    input.docType,
    "Source document type",
    MAX_DOC_TYPE_CHARS,
  );
  requireOptionalBoundedUtf8(input.uri, "Source URI", MAX_URI_BYTES);
  const externalIdHash = await sha256Utf8(input.externalId);
  const matches = await ctx.db
    .query("sourceItems")
    .withIndex("by_sourceAccountId_and_externalIdHash", (q) =>
      q
        .eq("sourceAccountId", input.sourceAccountId)
        .eq("externalIdHash", externalIdHash),
    )
    .take(2);
  if (matches.length > 1) throw new Error("Source item identity is not unique");
  const existing = matches[0];
  if (existing) {
    if (existing.spaceId !== input.spaceId) {
      throw new Error("Source item identity crosses spaces");
    }
    if (
      existing.lifecycle === "forgetting" ||
      existing.lifecycle === "forgotten"
    ) {
      throw new Error(`Source item is ${existing.lifecycle}`);
    }
    if (existing.externalId !== input.externalId) {
      throw new Error(
        "Source identity hash collision or damaged live identity",
      );
    }
    return existing;
  }
  const id = await ctx.db.insert("sourceItems", {
    spaceId: input.spaceId,
    sourceAccountId: input.sourceAccountId,
    externalIdHash,
    externalId: input.externalId,
    title: input.title,
    docType: input.docType,
    uri: input.uri,
    lifecycle: "available",
    originalLinkAvailable: input.uri !== undefined,
    desiredProcessingEpoch: 0,
  });
  return (await ctx.db.get(id))!;
}

export async function createOrGetRevision(
  ctx: MutationCtx,
  input: SourceRevisionInput,
): Promise<Doc<"sourceRevisions">> {
  const item = await requireSourceItem(ctx, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  requireBoundedString(
    input.mediaType,
    "Source media type",
    MAX_MEDIA_TYPE_CHARS,
  );
  requireFiniteTimestamp(input.capturedAt, "Capture time");
  requireOptionalBoundedUtf8(
    input.archiveRef,
    "Archive reference",
    MAX_ARCHIVE_REF_BYTES,
  );
  const byteLength = requireBoundedUtf8(
    input.inlineText,
    "Inline source text",
    MAX_SOURCE_INLINE_UTF8_BYTES,
    true,
  );
  const contentHash = await sha256Utf8(input.inlineText);
  const matches = await ctx.db
    .query("sourceRevisions")
    .withIndex("by_sourceItemId_and_contentHash", (q) =>
      q.eq("sourceItemId", input.sourceItemId).eq("contentHash", contentHash),
    )
    .take(2);
  if (matches.length > 1)
    throw new Error("Source revision identity is not unique");
  const existing = matches[0];
  if (existing) {
    let isInlineUtf8 = false;
    try {
      const parsed = parseSourceRevisionRepresentation(existing);
      isInlineUtf8 = parsed.kind === "inline_utf8_v1";
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
      existing.capturedAt !== input.capturedAt ||
      existing.userId !== input.userId ||
      existing.archiveRef !== input.archiveRef
    ) {
      throw new Error("Conflicting immutable source revision");
    }
    return existing;
  }
  const id = await ctx.db.insert("sourceRevisions", {
    spaceId: input.spaceId,
    sourceItemId: input.sourceItemId,
    contentHash,
    byteLength,
    mediaType: input.mediaType,
    inlineText: input.inlineText,
    capturedAt: input.capturedAt,
    userId: input.userId,
    archiveRef: input.archiveRef,
  });
  return (await ctx.db.get(id))!;
}

export async function refreshAvailableSourceItem(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceItemId: Id<"sourceItems">;
    title?: string;
    docType?: string;
    uri?: string;
  },
): Promise<void> {
  const item = await requireSourceItem(ctx, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  requireOptionalBoundedString(input.title, "Source title", MAX_TITLE_CHARS);
  requireOptionalBoundedString(
    input.docType,
    "Source document type",
    MAX_DOC_TYPE_CHARS,
  );
  requireOptionalBoundedUtf8(input.uri, "Source URI", MAX_URI_BYTES);
  await ctx.db.patch(item._id, {
    title: input.title,
    docType: input.docType,
    uri: input.uri,
    lifecycle: "available",
    originalLinkAvailable: input.uri !== undefined,
  });
}

export async function createOrGetTextVersion(
  ctx: MutationCtx,
  input: SourceTextVersionInput,
): Promise<Doc<"sourceTextVersions">> {
  const revision = await requireSourceRevision(
    ctx,
    input.sourceRevisionId,
    input.spaceId,
  );
  requireInlineSourceRevision(revision);
  requireBoundedUtf8(
    input.extractionFingerprint,
    "Extraction fingerprint",
    MAX_FINGERPRINT_BYTES,
  );
  const byteLength = requireBoundedUtf8(
    input.text,
    "Extracted source text",
    MAX_SOURCE_INLINE_UTF8_BYTES,
    true,
  );
  const textHash = await sha256Utf8(input.text);
  const matches = await ctx.db
    .query("sourceTextVersions")
    .withIndex("by_sourceRevisionId_and_extractionFingerprint", (q) =>
      q
        .eq("sourceRevisionId", input.sourceRevisionId)
        .eq("extractionFingerprint", input.extractionFingerprint),
    )
    .take(2);
  if (matches.length > 1)
    throw new Error("Source text version identity is not unique");
  const existing = matches[0];
  if (existing) {
    let isInlineText = false;
    try {
      const parsed = parseSourceTextRepresentation(existing);
      isInlineText = parsed.kind === "inline_text_v1";
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
  const id = await ctx.db.insert("sourceTextVersions", {
    spaceId: input.spaceId,
    sourceRevisionId: input.sourceRevisionId,
    extractionFingerprint: input.extractionFingerprint,
    text: input.text,
    textHash,
    byteLength,
    evidenceSealed: false,
  });
  return (await ctx.db.get(id))!;
}

export async function stagePages(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceTextVersionId: Id<"sourceTextVersions">;
    pages: SourcePageInput[];
  },
): Promise<Doc<"sourcePages">[]> {
  requireBatchBounds(
    input.pages.length,
    input.pages.map((page) => page.text),
    MAX_SOURCE_PAGES,
    "Pages",
  );
  const textVersion = await requireTextVersion(
    ctx,
    input.sourceTextVersionId,
    input.spaceId,
  );
  const inlineTextVersion = requireInlineSourceTextVersion(textVersion);
  const existingTotal = await ctx.db
    .query("sourcePages")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", input.sourceTextVersionId),
    )
    .take(MAX_SOURCE_PAGES + 1);
  if (existingTotal.length > MAX_SOURCE_PAGES) {
    throw new Error(`Source text version exceeds ${MAX_SOURCE_PAGES} pages`);
  }
  const existingOrdinals = new Set(existingTotal.map((page) => page.ordinal));
  const newOrdinals = new Set<number>();
  const results: Doc<"sourcePages">[] = [];
  for (const page of input.pages) {
    requireIntegerInRange(
      page.ordinal,
      "Page ordinal",
      0,
      MAX_SOURCE_PAGES - 1,
    );
    if (newOrdinals.has(page.ordinal))
      throw new Error("Page batch contains duplicate ordinals");
    newOrdinals.add(page.ordinal);
    requireUtf16Boundary(inlineTextVersion.text, page.start, "Page start");
    requireUtf16Boundary(inlineTextVersion.text, page.end, "Page end");
    if (page.end < page.start)
      throw new Error("Page end must be at or after page start");
    if (inlineTextVersion.text.slice(page.start, page.end) !== page.text) {
      throw new Error("Page text does not match its full-text UTF-16 range");
    }
    const textHash = await sha256Utf8(page.text);
    const matches = await ctx.db
      .query("sourcePages")
      .withIndex("by_sourceTextVersionId_and_ordinal", (q) =>
        q
          .eq("sourceTextVersionId", input.sourceTextVersionId)
          .eq("ordinal", page.ordinal),
      )
      .take(2);
    if (matches.length > 1)
      throw new Error("Source page identity is not unique");
    const existing = matches[0];
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
    if (
      !existingOrdinals.has(page.ordinal) &&
      existingOrdinals.size >= MAX_SOURCE_PAGES
    ) {
      throw new Error(`Source text version exceeds ${MAX_SOURCE_PAGES} pages`);
    }
    existingOrdinals.add(page.ordinal);
    const id = await ctx.db.insert("sourcePages", {
      spaceId: input.spaceId,
      sourceTextVersionId: input.sourceTextVersionId,
      ordinal: page.ordinal,
      start: page.start,
      end: page.end,
      text: page.text,
      textHash,
    });
    results.push((await ctx.db.get(id))!);
  }
  return results;
}

export async function stageEvidenceSpans(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceRevisionId: Id<"sourceRevisions">;
    sourceTextVersionId: Id<"sourceTextVersions">;
    spans: EvidenceSpanInput[];
  },
): Promise<Doc<"evidenceSpans">[]> {
  requireBatchBounds(
    input.spans.length,
    [],
    MAX_EVIDENCE_SPANS,
    "Evidence spans",
  );
  const [revision, textVersion] = await Promise.all([
    requireSourceRevision(ctx, input.sourceRevisionId, input.spaceId),
    requireTextVersion(ctx, input.sourceTextVersionId, input.spaceId),
  ]);
  if (textVersion.sourceRevisionId !== revision._id) {
    throw new Error(
      "Source text version does not belong to the source revision",
    );
  }
  const existingTotal = await ctx.db
    .query("evidenceSpans")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", input.sourceTextVersionId),
    )
    .take(MAX_EVIDENCE_SPANS + 1);
  if (existingTotal.length > MAX_EVIDENCE_SPANS) {
    throw new Error(
      `Source text version exceeds ${MAX_EVIDENCE_SPANS} evidence spans`,
    );
  }
  const newIdentities = new Set<string>();
  let total = existingTotal.length;
  const results: Doc<"evidenceSpans">[] = [];
  for (const span of input.spans) {
    const page = await ctx.db.get(span.sourcePageId);
    if (!page) throw new Error("Evidence source page does not exist");
    if (
      page.spaceId !== input.spaceId ||
      page.sourceTextVersionId !== textVersion._id
    ) {
      throw new Error("Evidence source page belongs to another parent chain");
    }
    requireIntegerInRange(
      span.ordinal,
      "Evidence span ordinal",
      0,
      MAX_EVIDENCE_SPANS - 1,
    );
    const identity = `${span.sourcePageId}:${span.ordinal}`;
    if (newIdentities.has(identity))
      throw new Error("Evidence batch contains duplicate identities");
    newIdentities.add(identity);
    requireUtf16Boundary(page.text, span.start, "Evidence span start");
    requireUtf16Boundary(page.text, span.end, "Evidence span end");
    if (span.end <= span.start)
      throw new Error(
        "Evidence span must contain at least one UTF-16 code unit",
      );
    requireLocator(span.locator);
    const quoteHash = await sha256Utf8(page.text.slice(span.start, span.end));
    const matches = await ctx.db
      .query("evidenceSpans")
      .withIndex("by_sourcePageId_and_ordinal", (q) =>
        q.eq("sourcePageId", span.sourcePageId).eq("ordinal", span.ordinal),
      )
      .take(2);
    if (matches.length > 1)
      throw new Error("Evidence span identity is not unique");
    const existing = matches[0];
    if (existing) {
      if (
        existing.spaceId !== input.spaceId ||
        existing.sourceRevisionId !== revision._id ||
        existing.sourceTextVersionId !== textVersion._id ||
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
      throw new Error(
        `Source text version exceeds ${MAX_EVIDENCE_SPANS} evidence spans`,
      );
    }
    total += 1;
    const id = await ctx.db.insert("evidenceSpans", {
      spaceId: input.spaceId,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      sourcePageId: page._id,
      ordinal: span.ordinal,
      start: span.start,
      end: span.end,
      quoteHash,
      locator: span.locator,
    });
    results.push((await ctx.db.get(id))!);
  }
  return results;
}

export async function stageDocuments(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    processingGenerationId: Id<"processingGenerations">;
    sourceItemId: Id<"sourceItems">;
    sourceRevisionId: Id<"sourceRevisions">;
    sourceTextVersionId: Id<"sourceTextVersions">;
    documents: DocumentInput[];
  },
): Promise<Doc<"documents">[]> {
  requireBatchBounds(
    input.documents.length,
    input.documents.map((doc) => doc.title),
    MAX_GENERATION_DOCUMENTS,
    "Documents",
  );
  const [generation, item, revision, textVersion] = await Promise.all([
    requireGeneration(ctx, input.processingGenerationId, input.spaceId),
    requireSourceItem(ctx, input.sourceItemId, input.spaceId),
    requireSourceRevision(ctx, input.sourceRevisionId, input.spaceId),
    requireTextVersion(ctx, input.sourceTextVersionId, input.spaceId),
  ]);
  if (
    revision.sourceItemId !== item._id ||
    textVersion.sourceRevisionId !== revision._id ||
    generation.sourceItemId !== item._id ||
    generation.sourceAccountId !== item.sourceAccountId ||
    generation.sourceRevisionId !== revision._id ||
    generation.sourceTextVersionId !== textVersion._id
  ) {
    throw new Error(
      "Document parent chain does not match its processing generation",
    );
  }
  const existingTotal = await ctx.db
    .query("documents")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", generation._id),
    )
    .take(MAX_GENERATION_DOCUMENTS + 1);
  if (existingTotal.length > MAX_GENERATION_DOCUMENTS) {
    throw new Error(
      `Processing generation exceeds ${MAX_GENERATION_DOCUMENTS} documents`,
    );
  }
  const existingKeys = new Set(existingTotal.map((doc) => doc.documentKey));
  const newKeys = new Set<string>();
  const results: Doc<"documents">[] = [];
  for (const document of input.documents) {
    requireBoundedUtf8(
      document.documentKey,
      "Document key",
      MAX_DOCUMENT_KEY_BYTES,
    );
    requireBoundedString(document.title, "Document title", MAX_TITLE_CHARS);
    requireBoundedString(document.docType, "Document type", MAX_DOC_TYPE_CHARS);
    requireFiniteTimestamp(document.capturedAt, "Document capture time");
    requireUniqueIds(
      document.evidenceSpanIds,
      "Document evidence span IDs",
      MAX_EVIDENCE_SPANS,
    );
    if (newKeys.has(document.documentKey))
      throw new Error("Document batch contains duplicate keys");
    newKeys.add(document.documentKey);
    for (const spanId of document.evidenceSpanIds) {
      const span = await ctx.db.get(spanId);
      if (
        !span ||
        span.spaceId !== input.spaceId ||
        span.sourceRevisionId !== revision._id ||
        span.sourceTextVersionId !== textVersion._id
      ) {
        throw new Error(
          "Document evidence span belongs to another parent chain",
        );
      }
    }
    const matches = await ctx.db
      .query("documents")
      .withIndex("by_processingGenerationId_and_documentKey", (q) =>
        q
          .eq("processingGenerationId", generation._id)
          .eq("documentKey", document.documentKey),
      )
      .take(2);
    if (matches.length > 1) throw new Error("Document identity is not unique");
    const existing = matches[0];
    if (existing) {
      if (
        existing.spaceId !== input.spaceId ||
        existing.sourceItemId !== item._id ||
        existing.sourceRevisionId !== revision._id ||
        existing.sourceTextVersionId !== textVersion._id ||
        existing.title !== document.title ||
        existing.docType !== document.docType ||
        existing.capturedAt !== document.capturedAt ||
        !sameIds(existing.evidenceSpanIds, document.evidenceSpanIds)
      ) {
        throw new Error("Conflicting immutable document");
      }
      results.push(existing);
      continue;
    }
    if (
      !existingKeys.has(document.documentKey) &&
      existingKeys.size >= MAX_GENERATION_DOCUMENTS
    ) {
      throw new Error(
        `Processing generation exceeds ${MAX_GENERATION_DOCUMENTS} documents`,
      );
    }
    existingKeys.add(document.documentKey);
    const id = await ctx.db.insert("documents", {
      spaceId: input.spaceId,
      processingGenerationId: generation._id,
      sourceItemId: item._id,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      documentKey: document.documentKey,
      title: document.title,
      docType: document.docType,
      capturedAt: document.capturedAt,
      evidenceSpanIds: document.evidenceSpanIds,
      publicationState: "staged",
    });
    results.push((await ctx.db.get(id))!);
  }
  return results;
}

export async function stageChunks(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    processingGenerationId: Id<"processingGenerations">;
    chunks: ChunkInput[];
  },
): Promise<Doc<"chunks">[]> {
  requireBatchBounds(
    input.chunks.length,
    input.chunks.map((chunk) => chunk.text),
    MAX_GENERATION_CHUNKS,
    "Chunks",
  );
  const generation = await requireGeneration(
    ctx,
    input.processingGenerationId,
    input.spaceId,
  );
  const existingTotal = await ctx.db
    .query("chunks")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", generation._id),
    )
    .take(MAX_GENERATION_CHUNKS + 1);
  if (existingTotal.length > MAX_GENERATION_CHUNKS) {
    throw new Error(
      `Processing generation exceeds ${MAX_GENERATION_CHUNKS} chunks`,
    );
  }
  let total = existingTotal.length;
  let totalTextBytes = existingTotal.reduce(
    (bytes, chunk) => bytes + utf8Length(chunk.text),
    0,
  );
  if (totalTextBytes > MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES) {
    throw new Error(
      `Processing generation exceeds ${MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES} chunk text bytes`,
    );
  }
  const newIdentities = new Set<string>();
  const evidenceById = new Map<string, Doc<"evidenceSpans">>();
  const results: Doc<"chunks">[] = [];
  for (const chunk of input.chunks) {
    requireIntegerInRange(
      chunk.ordinal,
      "Chunk ordinal",
      0,
      MAX_GENERATION_CHUNKS - 1,
    );
    const chunkTextBytes = requireBoundedUtf8(
      chunk.text,
      "Chunk text",
      MAX_CHUNK_TEXT_UTF8_BYTES,
    );
    requireUniqueIds(
      chunk.evidenceSpanIds,
      "Chunk evidence span IDs",
      MAX_EVIDENCE_SPANS,
    );
    const identity = `${chunk.documentId}:${chunk.ordinal}`;
    if (newIdentities.has(identity))
      throw new Error("Chunk batch contains duplicate identities");
    newIdentities.add(identity);
    const document = await ctx.db.get(chunk.documentId);
    if (
      !document ||
      document.spaceId !== input.spaceId ||
      document.processingGenerationId !== generation._id
    ) {
      throw new Error("Chunk document belongs to another generation or space");
    }
    const documentEvidence = new Set<string>(document.evidenceSpanIds);
    for (const spanId of chunk.evidenceSpanIds) {
      if (!documentEvidence.has(spanId)) {
        throw new Error(
          "Chunk evidence must be included in its document evidence",
        );
      }
      let span = evidenceById.get(spanId);
      if (!span) {
        span = (await ctx.db.get(spanId)) ?? undefined;
        if (span) evidenceById.set(spanId, span);
      }
      if (!span || span.spaceId !== input.spaceId) {
        throw new Error("Chunk evidence span belongs to another space");
      }
    }
    const matches = await ctx.db
      .query("chunks")
      .withIndex("by_documentId_and_ordinal", (q) =>
        q.eq("documentId", document._id).eq("ordinal", chunk.ordinal),
      )
      .take(2);
    if (matches.length > 1) throw new Error("Chunk identity is not unique");
    const existing = matches[0];
    if (existing) {
      if (
        existing.spaceId !== input.spaceId ||
        existing.processingGenerationId !== generation._id ||
        existing.text !== chunk.text ||
        !sameIds(existing.evidenceSpanIds, chunk.evidenceSpanIds)
      ) {
        throw new Error("Conflicting immutable chunk");
      }
      results.push(existing);
      continue;
    }
    if (total >= MAX_GENERATION_CHUNKS) {
      throw new Error(
        `Processing generation exceeds ${MAX_GENERATION_CHUNKS} chunks`,
      );
    }
    if (
      totalTextBytes + chunkTextBytes >
      MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES
    ) {
      throw new Error(
        `Processing generation exceeds ${MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES} chunk text bytes`,
      );
    }
    total += 1;
    totalTextBytes += chunkTextBytes;
    const id = await ctx.db.insert("chunks", {
      spaceId: input.spaceId,
      processingGenerationId: generation._id,
      documentId: document._id,
      ordinal: chunk.ordinal,
      text: chunk.text,
      evidenceSpanIds: chunk.evidenceSpanIds,
      publicationState: "staged",
    });
    results.push((await ctx.db.get(id))!);
  }
  return results;
}

export async function setDesiredSourceRevision(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceItemId: Id<"sourceItems">;
    desiredRevisionId: Id<"sourceRevisions">;
    expectedDesiredProcessingEpoch: number;
  },
): Promise<number> {
  const [item, revision] = await Promise.all([
    requireSourceItem(ctx, input.sourceItemId, input.spaceId),
    requireSourceRevision(ctx, input.desiredRevisionId, input.spaceId),
  ]);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  if (revision.sourceItemId !== item._id) {
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
  await ctx.db.patch(item._id, {
    desiredRevisionId: revision._id,
    desiredProcessingEpoch,
    lifecycle: "available",
    lastFailure: undefined,
  });
  return desiredProcessingEpoch;
}

export async function activateSourceItemGeneration(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceItemId: Id<"sourceItems">;
    sourceRevisionId: Id<"sourceRevisions">;
    processingGenerationId: Id<"processingGenerations">;
    expectedPreviousGenerationId?: Id<"processingGenerations">;
    expectedDesiredProcessingEpoch: number;
    verifiedPayload?: {
      documents: Doc<"documents">[];
      chunks: Doc<"chunks">[];
    };
    payloadReadBudget?: {
      measureRow: (
        row: Record<string, unknown>,
        maximumBytes: number,
      ) => number;
      finish: () => Promise<unknown>;
    };
  },
): Promise<{ previousGenerationId?: Id<"processingGenerations"> }> {
  if (
    (input.verifiedPayload === undefined) !==
    (input.payloadReadBudget === undefined)
  ) {
    throw new Error(
      "Verified activation payload and its read budget must be provided together",
    );
  }
  const [item, revision, generation] = await Promise.all([
    requireSourceItem(ctx, input.sourceItemId, input.spaceId),
    requireSourceRevision(ctx, input.sourceRevisionId, input.spaceId),
    requireGeneration(ctx, input.processingGenerationId, input.spaceId),
  ]);
  if (item.lifecycle !== "available")
    throw new Error("Only available source items can activate");
  if (item.activeGenerationId !== input.expectedPreviousGenerationId) {
    throw new Error("Source item active generation changed before activation");
  }
  if (
    item.desiredProcessingEpoch !== input.expectedDesiredProcessingEpoch ||
    item.desiredRevisionId !== revision._id
  ) {
    throw new Error("Processing generation is obsolete for the source item");
  }
  if (
    revision.sourceItemId !== item._id ||
    generation.sourceItemId !== item._id ||
    generation.sourceAccountId !== item.sourceAccountId ||
    generation.sourceRevisionId !== revision._id ||
    generation.desiredProcessingEpoch !== input.expectedDesiredProcessingEpoch
  ) {
    throw new Error("Active generation parent chain or epoch does not match");
  }
  if (!generation.sourceTextVersionId) {
    throw new Error("Active generation must have a source text version");
  }
  const generationTextVersion = await requireTextVersion(
    ctx,
    generation.sourceTextVersionId,
    input.spaceId,
  );
  if (generationTextVersion.sourceRevisionId !== revision._id) {
    throw new Error(
      "Active generation text version belongs to another revision",
    );
  }
  const nextDocuments =
    input.verifiedPayload?.documents ??
    (await ctx.db
      .query("documents")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(MAX_GENERATION_DOCUMENTS + 1));
  const chunkLimit = input.verifiedPayload
    ? MAX_PARSED_GENERATION_CHUNKS
    : MAX_GENERATION_CHUNKS;
  const nextChunks =
    input.verifiedPayload?.chunks ??
    (await ctx.db
      .query("chunks")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(chunkLimit + 1));
  if (
    nextDocuments.length > MAX_GENERATION_DOCUMENTS ||
    nextChunks.length > chunkLimit
  ) {
    throw new Error("Generation payload exceeds activation bounds");
  }
  if (
    nextDocuments.some(
      (row) =>
        row.spaceId !== input.spaceId ||
        row.processingGenerationId !== generation._id,
    ) ||
    nextChunks.some(
      (row) =>
        row.spaceId !== input.spaceId ||
        row.processingGenerationId !== generation._id,
    )
  )
    throw new Error("Generation payload has invalid parents");
  const nextChunkTextBytes = nextChunks.reduce(
    (bytes, chunk) => bytes + utf8Length(chunk.text),
    0,
  );
  const chunkTextLimit = input.verifiedPayload
    ? MAX_PARSED_GENERATION_CHUNK_TEXT_UTF8_BYTES
    : MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES;
  if (nextChunkTextBytes > chunkTextLimit) {
    throw new Error(`Generation exceeds ${chunkTextLimit} chunk text bytes`);
  }
  const previousGenerationId = item.activeGenerationId;
  if (previousGenerationId && previousGenerationId !== generation._id) {
    const previousGeneration = await requireGeneration(
      ctx,
      previousGenerationId,
      input.spaceId,
    );
    if (previousGeneration.sourceItemId !== item._id) {
      throw new Error(
        "Previous active generation belongs to another source item",
      );
    }
    const previousChunkLimit = previousGeneration.parserArtifactId
      ? MAX_PARSED_GENERATION_CHUNKS
      : MAX_GENERATION_CHUNKS;
    const previousChunkTextLimit = previousGeneration.parserArtifactId
      ? MAX_PARSED_GENERATION_CHUNK_TEXT_UTF8_BYTES
      : MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES;
    let previousDocuments: Doc<"documents">[];
    let previousChunks: Doc<"chunks">[];
    if (input.payloadReadBudget) {
      previousDocuments = [];
      previousChunks = [];
      let transitionBytes = 0;
      await input.payloadReadBudget.finish();
      for await (const row of ctx.db
        .query("documents")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq("processingGenerationId", previousGenerationId),
        )) {
        transitionBytes += input.payloadReadBudget.measureRow(row, 16 * 1024);
        if (
          !Number.isSafeInteger(transitionBytes) ||
          transitionBytes > MAX_PARSED_TRANSITION_BYTES ||
          previousDocuments.length >= MAX_GENERATION_DOCUMENTS
        )
          throw new Error(
            "Previous generation payload exceeds activation bounds",
          );
        previousDocuments.push(row);
        await input.payloadReadBudget.finish();
      }
      for await (const row of ctx.db
        .query("chunks")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq("processingGenerationId", previousGenerationId),
        )) {
        transitionBytes += input.payloadReadBudget.measureRow(row, 24 * 1024);
        if (
          !Number.isSafeInteger(transitionBytes) ||
          transitionBytes > MAX_PARSED_TRANSITION_BYTES ||
          previousChunks.length >= previousChunkLimit
        )
          throw new Error(
            "Previous generation payload exceeds activation bounds",
          );
        previousChunks.push(row);
        await input.payloadReadBudget.finish();
      }
    } else {
      previousDocuments = await ctx.db
        .query("documents")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq("processingGenerationId", previousGenerationId),
        )
        .take(MAX_GENERATION_DOCUMENTS + 1);
      previousChunks = await ctx.db
        .query("chunks")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq("processingGenerationId", previousGenerationId),
        )
        .take(previousChunkLimit + 1);
    }
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
      throw new Error(
        `Previous generation exceeds ${previousChunkTextLimit} chunk text bytes`,
      );
    }
    for (const document of previousDocuments) {
      await ctx.db.patch(document._id, { publicationState: "historical" });
    }
    for (const chunk of previousChunks) {
      await ctx.db.patch(chunk._id, { publicationState: "historical" });
    }
  }
  for (const document of nextDocuments) {
    if (document.publicationState === "historical") {
      throw new Error("A historical generation cannot be reactivated");
    }
    await ctx.db.patch(document._id, { publicationState: "active" });
  }
  for (const chunk of nextChunks) {
    if (chunk.publicationState === "historical") {
      throw new Error("A historical generation cannot be reactivated");
    }
    await ctx.db.patch(chunk._id, { publicationState: "active" });
  }
  if (!generationTextVersion.evidenceSealed) {
    await ctx.db.patch(generationTextVersion._id, { evidenceSealed: true });
  }
  await ctx.db.patch(item._id, {
    activeRevisionId: revision._id,
    activeGenerationId: generation._id,
    lastFailure: undefined,
  });
  return { previousGenerationId };
}

export async function markSourceItemUnavailable(
  ctx: MutationCtx,
  input: { spaceId: Id<"spaces">; sourceItemId: Id<"sourceItems"> },
): Promise<void> {
  const item = await requireSourceItem(ctx, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  await ctx.db.patch(item._id, {
    lifecycle: "unavailable",
    originalLinkAvailable: false,
  });
}

export async function beginSourceItemForget(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceItemId: Id<"sourceItems">;
    forgottenAt: number;
    forgottenBy: Id<"users">;
  },
): Promise<number> {
  const item = await requireSourceItem(ctx, input.sourceItemId, input.spaceId);
  requireFiniteTimestamp(input.forgottenAt, "Forgotten time");
  if (item.lifecycle === "forgotten" || item.lifecycle === "forgetting") {
    return item.desiredProcessingEpoch;
  }
  if (item.desiredProcessingEpoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Source item processing epoch is exhausted");
  }
  const desiredProcessingEpoch = item.desiredProcessingEpoch + 1;
  await invalidateRecordQueriesForForget(ctx, {
    spaceId: input.spaceId,
    now: input.forgottenAt,
  });
  await ctx.db.patch(item._id, {
    lifecycle: "forgetting",
    originalLinkAvailable: false,
    desiredRevisionId: undefined,
    desiredProcessingEpoch,
    activeRevisionId: undefined,
    activeGenerationId: undefined,
    activeCardGenerationId: undefined,
    lastFailure: undefined,
    forgottenAt: input.forgottenAt,
    forgottenBy: input.forgottenBy,
    archiveDeletionForgetEpoch: desiredProcessingEpoch,
    archiveDeletionReceiptCount: 0,
    archiveDeletionCompletedAt: undefined,
  });
  return desiredProcessingEpoch;
}

export async function setSourceItemFailure(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceItemId: Id<"sourceItems">;
    code: string;
    message: string;
    at: number;
  },
): Promise<void> {
  const item = await requireSourceItem(ctx, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error(`Source item is ${item.lifecycle}`);
  }
  requireBoundedString(input.code, "Failure code", 100);
  requireBoundedString(input.message, "Failure message", 2_000);
  requireFiniteTimestamp(input.at, "Failure time");
  await ctx.db.patch(item._id, {
    lastFailure: { code: input.code, message: input.message, at: input.at },
  });
}

export async function inspectGenerationPayload(
  ctx: ReadCtx,
  input: {
    spaceId: Id<"spaces">;
    processingGenerationId: Id<"processingGenerations">;
    sourceTextVersionId: Id<"sourceTextVersions">;
    expectedPublicationState?: "staged" | "active" | "historical";
  },
): Promise<GenerationPayloadSummary> {
  const [generation, textVersion] = await Promise.all([
    requireGeneration(ctx, input.processingGenerationId, input.spaceId),
    requireTextVersion(ctx, input.sourceTextVersionId, input.spaceId),
  ]);
  if (generation.sourceTextVersionId !== textVersion._id) {
    throw new Error("Generation does not use the supplied source text version");
  }
  const revision = await requireSourceRevision(
    ctx,
    generation.sourceRevisionId,
    input.spaceId,
  );
  const item = await requireSourceItem(
    ctx,
    generation.sourceItemId,
    input.spaceId,
  );
  await requireSourceAccount(ctx, generation.sourceAccountId, input.spaceId);
  if (
    textVersion.sourceRevisionId !== revision._id ||
    revision.sourceItemId !== item._id ||
    generation.sourceAccountId !== item.sourceAccountId
  ) {
    throw new Error("Generation source parent chain is invalid");
  }
  const inlineRevision = requireInlineSourceRevision(revision);
  const inlineTextVersion = requireInlineSourceTextVersion(textVersion);
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
  const [pages, spans, documents, chunks] = await Promise.all([
    ctx.db
      .query("sourcePages")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", textVersion._id),
      )
      .take(MAX_SOURCE_PAGES + 1),
    ctx.db
      .query("evidenceSpans")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", textVersion._id),
      )
      .take(MAX_EVIDENCE_SPANS + 1),
    ctx.db
      .query("documents")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(MAX_GENERATION_DOCUMENTS + 1),
    ctx.db
      .query("chunks")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(MAX_GENERATION_CHUNKS + 1),
  ]);
  if (
    pages.length > MAX_SOURCE_PAGES ||
    spans.length > MAX_EVIDENCE_SPANS ||
    documents.length > MAX_GENERATION_DOCUMENTS ||
    chunks.length > MAX_GENERATION_CHUNKS
  ) {
    throw new Error("Generation payload exceeds configured bounds");
  }
  const generationChunkTextBytes = chunks.reduce(
    (bytes, chunk) => bytes + utf8Length(chunk.text),
    0,
  );
  if (generationChunkTextBytes > MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES) {
    throw new Error(
      `Generation exceeds ${MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES} chunk text bytes`,
    );
  }
  const orderedPages = [...pages].sort((a, b) => a.ordinal - b.ordinal);
  let expectedStart = 0;
  for (const [index, page] of orderedPages.entries()) {
    if (
      page.spaceId !== input.spaceId ||
      page.sourceTextVersionId !== textVersion._id
    ) {
      throw new Error("Generation page belongs to another parent chain");
    }
    if (page.ordinal !== index) {
      throw new Error("Generation page ordinals must be contiguous from zero");
    }
    requireUtf16Boundary(inlineTextVersion.text, page.start, "Page start");
    requireUtf16Boundary(inlineTextVersion.text, page.end, "Page end");
    if (page.end < page.start) throw new Error("Page end precedes page start");
    if (page.start !== expectedStart) {
      throw new Error(
        "Generation pages do not contiguously cover extracted text",
      );
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
  const pageIds = new Set(pages.map((page) => page._id));
  const pagesById = new Map(pages.map((page) => [page._id, page]));
  const spanOrdinalsByPage = new Map<string, number[]>();
  for (const span of spans) {
    if (
      span.spaceId !== input.spaceId ||
      span.sourceRevisionId !== generation.sourceRevisionId ||
      span.sourceTextVersionId !== textVersion._id ||
      !pageIds.has(span.sourcePageId)
    ) {
      throw new Error(
        "Generation contains evidence with an invalid parent chain",
      );
    }
    const page = pagesById.get(span.sourcePageId)!;
    requireUtf16Boundary(page.text, span.start, "Evidence span start");
    requireUtf16Boundary(page.text, span.end, "Evidence span end");
    if (span.end <= span.start) {
      throw new Error("Generation evidence span is empty or reversed");
    }
    if (
      span.quoteHash !==
      (await sha256Utf8(page.text.slice(span.start, span.end)))
    ) {
      throw new Error("Generation evidence quote hash is invalid");
    }
    requireLocator(span.locator);
    const ordinals = spanOrdinalsByPage.get(span.sourcePageId) ?? [];
    ordinals.push(span.ordinal);
    spanOrdinalsByPage.set(span.sourcePageId, ordinals);
  }
  for (const ordinals of spanOrdinalsByPage.values()) {
    ordinals.sort((a, b) => a - b);
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      throw new Error(
        "Generation evidence ordinals must be contiguous from zero per page",
      );
    }
  }
  const spansById = new Map(spans.map((span) => [span._id, span]));
  const documentKeys = new Set<string>();
  for (const document of documents) {
    if (
      document.spaceId !== input.spaceId ||
      document.sourceItemId !== generation.sourceItemId ||
      document.sourceRevisionId !== generation.sourceRevisionId ||
      document.sourceTextVersionId !== textVersion._id
    ) {
      throw new Error(
        "Generation contains a document with an invalid parent chain",
      );
    }
    if (
      input.expectedPublicationState !== undefined &&
      document.publicationState !== input.expectedPublicationState
    ) {
      throw new Error("Document publication state does not match expectation");
    }
    requireUniqueIds(
      document.evidenceSpanIds,
      "Document evidence span IDs",
      MAX_EVIDENCE_SPANS,
    );
    if (document.evidenceSpanIds.some((spanId) => !spansById.has(spanId))) {
      throw new Error("Document references evidence outside its text version");
    }
    if (documentKeys.has(document.documentKey)) {
      throw new Error("Generation document keys must be unique");
    }
    documentKeys.add(document.documentKey);
  }
  const documentsById = new Map(
    documents.map((document) => [document._id, document]),
  );
  for (const chunk of chunks) {
    if (
      chunk.spaceId !== input.spaceId ||
      chunk.processingGenerationId !== generation._id ||
      !documentsById.has(chunk.documentId)
    ) {
      throw new Error(
        "Generation contains a chunk with an invalid document parent",
      );
    }
    if (
      input.expectedPublicationState !== undefined &&
      chunk.publicationState !== input.expectedPublicationState
    ) {
      throw new Error("Chunk publication state does not match expectation");
    }
    requireBoundedUtf8(chunk.text, "Chunk text", MAX_CHUNK_TEXT_UTF8_BYTES);
    requireUniqueIds(
      chunk.evidenceSpanIds,
      "Chunk evidence span IDs",
      MAX_EVIDENCE_SPANS,
    );
    const document = documentsById.get(chunk.documentId)!;
    const documentEvidence = new Set<string>(document.evidenceSpanIds);
    if (
      chunk.evidenceSpanIds.some(
        (spanId) => !documentEvidence.has(spanId) || !spansById.has(spanId),
      )
    ) {
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
      throw new Error(
        "Generation chunk ordinals must be contiguous from zero per document",
      );
    }
  }
  return {
    pageOrdinals: pages.map((page) => page.ordinal).sort((a, b) => a - b),
    evidenceSpanOrdinalsByPage: [...spansByPage].map(
      ([sourcePageId, ordinals]) => ({
        sourcePageId: sourcePageId as Id<"sourcePages">,
        ordinals: ordinals.sort((a, b) => a - b),
      }),
    ),
    documentKeys: documents.map((document) => document.documentKey).sort(),
    chunkOrdinalsByDocument: [...chunksByDocument].map(
      ([documentId, ordinals]) => ({
        documentId: documentId as Id<"documents">,
        ordinals: ordinals.sort((a, b) => a - b),
      }),
    ),
  };
}

export async function deleteGenerationPayloadBatch(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    processingGenerationId: Id<"processingGenerations">;
    limit?: number;
  },
): Promise<{ deleted: number; done: boolean }> {
  const generation = await requireGeneration(
    ctx,
    input.processingGenerationId,
    input.spaceId,
  );
  if (generation.archiveSetDigest !== undefined) {
    throw new Error("archive_cleanup_required");
  }
  if (generation.state === "ready" || generation.activatedAt !== undefined) {
    const item = await requireSourceItem(
      ctx,
      generation.sourceItemId,
      input.spaceId,
    );
    if (item.lifecycle !== "forgetting") {
      throw new Error(
        "Published generation cleanup requires the forget workflow",
      );
    }
  }
  const limit = input.limit ?? MAX_PROVENANCE_CLEANUP_ROWS;
  requireIntegerInRange(limit, "Cleanup limit", 1, MAX_PROVENANCE_CLEANUP_ROWS);
  const records = await deleteGenerationRecordsBatch(ctx, {
    spaceId: input.spaceId,
    processingGenerationId: input.processingGenerationId,
    limit,
  });
  if (records.deleted > 0 || !records.done) return { ...records, done: false };
  const chunks = await ctx.db
    .query("chunks")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", input.processingGenerationId),
    )
    .take(limit);
  let deleted = 0;
  for (const chunk of chunks) {
    if (deleted === limit) break;
    const vectors = await deleteChunkEmbeddingVectors(ctx, {
      spaceId: input.spaceId,
      chunkId: chunk._id,
      limit: limit - deleted,
    });
    deleted += vectors.deleted;
    if (!vectors.done || deleted === limit) break;
    await ctx.db.delete(chunk._id);
    deleted += 1;
  }
  if (chunks.length > 0) return { deleted, done: false };
  const documents = await ctx.db
    .query("documents")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", input.processingGenerationId),
    )
    .take(limit);
  for (const document of documents) await ctx.db.delete(document._id);
  if (documents.length > 0) return { deleted: documents.length, done: false };
  return { deleted: 0, done: true };
}

export async function deleteSourceItemProvenanceBatch(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceItemId: Id<"sourceItems">;
    limit?: number;
  },
): Promise<{ deleted: number; phase: string; done: boolean }> {
  const item = await requireSourceItem(ctx, input.sourceItemId, input.spaceId);
  if (item.lifecycle !== "forgetting") {
    throw new Error("Source item must be forgetting before provenance cleanup");
  }
  const limit = input.limit ?? MAX_PROVENANCE_CLEANUP_ROWS;
  requireIntegerInRange(limit, "Cleanup limit", 1, MAX_PROVENANCE_CLEANUP_ROWS);
  const deletionCount = item.archiveDeletionReceiptCount ?? 0;
  const deletionEpoch =
    item.archiveDeletionForgetEpoch ?? item.desiredProcessingEpoch;
  if (
    deletionEpoch !== item.desiredProcessingEpoch ||
    !Number.isSafeInteger(deletionCount) ||
    deletionCount < 0 ||
    (item.archiveDeletionCompletedAt !== undefined &&
      (!Number.isSafeInteger(item.archiveDeletionCompletedAt) ||
        item.archiveDeletionCompletedAt < 0))
  ) {
    throw new Error("Archive deletion summary is invalid");
  }
  const archived = await ctx.db
    .query("sourceArtifactArchiveReceipts")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(1);
  const archiveReceipt = archived[0];
  if (archiveReceipt) {
    if (
      archiveReceipt.spaceId !== item.spaceId ||
      archiveReceipt.sourceAccountId !== item.sourceAccountId
    )
      throw new Error("Archive receipt parent chain is invalid");
    const ack = await loadArchiveDeletionAck(
      ctx,
      archiveReceipt,
      item,
      item.desiredProcessingEpoch,
    );
    if (!ack) {
      return { deleted: 0, phase: "archive_cleanup_required", done: false };
    }
    const bindings = await ctx.db
      .query("sourceArtifactArchiveBindings")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", archiveReceipt._id))
      .take(2);
    if (
      bindings.length > 1 ||
      bindings.some(
        (binding) =>
          binding.spaceId !== item.spaceId ||
          binding.sourceAccountId !== item.sourceAccountId ||
          binding.sourceItemId !== item._id ||
          binding.sourceRevisionId !== archiveReceipt.sourceRevisionId ||
          binding.parserArtifactId !== archiveReceipt.parserArtifactId ||
          binding.subjectKind !== archiveReceipt.subjectKind ||
          binding.copyRole !== archiveReceipt.copyRole ||
          binding.archiveIdentityFingerprint !==
            archiveReceipt.archiveIdentityFingerprint,
      )
    )
      throw new Error("Archive receipt binding is incoherent");
    const binding = bindings[0];
    if (binding) {
      await ctx.db.delete(binding._id);
      if (limit === 1) {
        return { deleted: 1, phase: "archiveBindings", done: false };
      }
    }
    if (deletionCount >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Archive deletion receipt count is exhausted");
    }
    await ctx.db.delete(archiveReceipt._id);
    await ctx.db.patch(item._id, {
      archiveDeletionForgetEpoch: item.desiredProcessingEpoch,
      archiveDeletionReceiptCount: deletionCount + 1,
    });
    return {
      deleted: bindings.length + 1,
      phase: "archiveReceipts",
      done: false,
    };
  }
  const orphanedBindings = await ctx.db
    .query("sourceArtifactArchiveBindings")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(1);
  if (orphanedBindings.length !== 0) {
    throw new Error("Archive binding is missing its immutable receipt");
  }
  const providerReferences = await ctx.db
    .query("sourceProviderOriginalReferences")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(1);
  const providerReference = providerReferences[0];
  if (providerReference) {
    if (
      providerReference.spaceId !== item.spaceId ||
      providerReference.sourceAccountId !== item.sourceAccountId
    )
      throw new Error("Provider original reference parent chain is invalid");
    const detachAcks = await ctx.db
      .query("sourceProviderOriginalDetachAcks")
      .withIndex("by_referenceId_and_forgetEpoch", (q) =>
        q
          .eq("referenceId", providerReference._id)
          .eq("forgetEpoch", item.desiredProcessingEpoch),
      )
      .take(2);
    const detachAck = detachAcks[0];
    if (detachAcks.length !== 1 || !detachAck) {
      return {
        deleted: 0,
        phase: "provider_original_cleanup_required",
        done: false,
      };
    }
    if (
      detachAck.ackVersion !== "provider_original_detach_ack_v1" ||
      detachAck.spaceId !== item.spaceId ||
      detachAck.sourceAccountId !== item.sourceAccountId ||
      detachAck.sourceItemId !== item._id ||
      detachAck.sourceRevisionId !== providerReference.sourceRevisionId ||
      detachAck.referenceFingerprint !==
        providerReference.referenceFingerprint ||
      !/^[a-f0-9]{64}$/.test(detachAck.requestDigest) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        detachAck.detachId,
      ) ||
      detachAck.locatorBindingId !== providerReference.locatorBindingId ||
      detachAck.locatorRepositoryId !== providerReference.locatorRepositoryId ||
      detachAck.locatorSnapshotId !== providerReference.locatorSnapshotId ||
      detachAck.locatorObjectName !== providerReference.locatorObjectName ||
      (detachAck.referenceOutcome !== "detached" &&
        detachAck.referenceOutcome !== "already_detached") ||
      (detachAck.locatorBundleOutcome !== "deleted" &&
        detachAck.locatorBundleOutcome !== "already_missing") ||
      detachAck.locatorAbsenceAuthority !==
        "worker_asserted_live_repository_absence" ||
      detachAck.retentionDisclosure !==
        "provider_retained_deleted_history_possible" ||
      detachAck.providerSourceOutcome !== "retained_unchanged"
    )
      throw new Error("Provider original detach acknowledgement is invalid");
    const providerBindings = await ctx.db
      .query("sourceProviderOriginalBindings")
      .withIndex("by_referenceId", (q) =>
        q.eq("referenceId", providerReference._id),
      )
      .take(2);
    if (
      providerBindings.length > 1 ||
      providerBindings.some(
        (binding) =>
          binding.spaceId !== item.spaceId ||
          binding.sourceAccountId !== item.sourceAccountId ||
          binding.sourceItemId !== item._id ||
          binding.sourceRevisionId !== providerReference.sourceRevisionId,
      )
    )
      throw new Error("Provider original binding is incoherent");
    if (providerBindings[0]) {
      await ctx.db.delete(providerBindings[0]._id);
      return {
        deleted: 1,
        phase: "providerOriginalBindings",
        done: false,
      };
    }
    await ctx.db.delete(providerReference._id);
    return {
      deleted: 1,
      phase: "providerOriginalReferences",
      done: false,
    };
  }
  const orphanedProviderBindings = await ctx.db
    .query("sourceProviderOriginalBindings")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(1);
  if (orphanedProviderBindings.length !== 0)
    throw new Error("Provider original binding is missing its reference");
  if (item.archiveDeletionCompletedAt === undefined) {
    await ctx.db.patch(item._id, {
      archiveDeletionForgetEpoch: item.desiredProcessingEpoch,
      archiveDeletionReceiptCount: deletionCount,
      archiveDeletionCompletedAt: Date.now(),
    });
    return { deleted: 0, phase: "archiveDeletionSummary", done: false };
  }
  const documents = await ctx.db
    .query("documents")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(limit);
  for (const document of documents) {
    const chunks = await ctx.db
      .query("chunks")
      .withIndex("by_documentId", (q) => q.eq("documentId", document._id))
      .take(limit);
    let deleted = 0;
    for (const chunk of chunks) {
      if (deleted === limit) break;
      const vectors = await deleteChunkEmbeddingVectors(ctx, {
        spaceId: input.spaceId,
        chunkId: chunk._id,
        limit: limit - deleted,
      });
      deleted += vectors.deleted;
      if (!vectors.done || deleted === limit) break;
      await ctx.db.delete(chunk._id);
      deleted += 1;
    }
    if (chunks.length > 0) return { deleted, phase: "chunks", done: false };
  }
  for (const document of documents) await ctx.db.delete(document._id);
  if (documents.length > 0)
    return { deleted: documents.length, phase: "documents", done: false };

  const revisions = await ctx.db
    .query("sourceRevisions")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(1);
  const revision = revisions[0];
  if (revision) {
    const textVersions = await ctx.db
      .query("sourceTextVersions")
      .withIndex("by_sourceRevisionId", (q) =>
        q.eq("sourceRevisionId", revision._id),
      )
      .take(1);
    const textVersion = textVersions[0];
    if (textVersion) {
      const spans = await ctx.db
        .query("evidenceSpans")
        .withIndex("by_sourceTextVersionId", (q) =>
          q.eq("sourceTextVersionId", textVersion._id),
        )
        .take(limit);
      for (const span of spans) await ctx.db.delete(span._id);
      if (spans.length > 0)
        return { deleted: spans.length, phase: "evidenceSpans", done: false };
      const pages = await ctx.db
        .query("sourcePages")
        .withIndex("by_sourceTextVersionId", (q) =>
          q.eq("sourceTextVersionId", textVersion._id),
        )
        .take(limit);
      for (const page of pages) await ctx.db.delete(page._id);
      if (pages.length > 0)
        return { deleted: pages.length, phase: "sourcePages", done: false };
      await ctx.db.delete(textVersion._id);
      return { deleted: 1, phase: "sourceTextVersions", done: false };
    }
    const parserArtifacts = await ctx.db
      .query("sourceParserArtifacts")
      .withIndex("by_sourceRevisionId", (q) =>
        q.eq("sourceRevisionId", revision._id),
      )
      .take(limit);
    for (const artifact of parserArtifacts) {
      if (
        artifact.spaceId !== item.spaceId ||
        artifact.sourceAccountId !== item.sourceAccountId ||
        artifact.sourceItemId !== item._id
      )
        throw new Error("Parser artifact parent chain is invalid");
      await ctx.db.delete(artifact._id);
    }
    if (parserArtifacts.length > 0) {
      return {
        deleted: parserArtifacts.length,
        phase: "sourceParserArtifacts",
        done: false,
      };
    }
    await ctx.db.delete(revision._id);
    return { deleted: 1, phase: "sourceRevisions", done: false };
  }
  return { deleted: 0, phase: "complete", done: true };
}

export async function finalizeSourceItemTombstone(
  ctx: MutationCtx,
  input: { spaceId: Id<"spaces">; sourceItemId: Id<"sourceItems"> },
): Promise<void> {
  const item = await requireSourceItem(ctx, input.sourceItemId, input.spaceId);
  if (item.lifecycle === "forgotten") return;
  if (item.lifecycle !== "forgetting") {
    throw new Error(
      "Source item must be forgetting before finalizing its tombstone",
    );
  }
  if (
    item.archiveDeletionForgetEpoch !== item.desiredProcessingEpoch ||
    !Number.isSafeInteger(item.archiveDeletionReceiptCount) ||
    (item.archiveDeletionReceiptCount ?? -1) < 0 ||
    !Number.isSafeInteger(item.archiveDeletionCompletedAt) ||
    (item.archiveDeletionCompletedAt ?? -1) < 0
  ) {
    throw new Error("Archive deletion summary is incomplete");
  }
  const remainingRevisions = await ctx.db
    .query("sourceRevisions")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(1);
  const remainingDocuments = await ctx.db
    .query("documents")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(1);
  const remainingRecords = await Promise.all([
    ctx.db
      .query("events")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("eventVersions")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("observations")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("sourceArtifactArchiveReceipts")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("sourceArtifactArchiveBindings")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("sourceArtifactDeletionAcks")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("sourceProviderOriginalReferences")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("sourceProviderOriginalBindings")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("sourceProviderOriginalDetachAcks")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("workerBinaryOperationReceipts")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("workerParsedStages")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
    ctx.db
      .query("processingGenerationPayloadManifests")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .first(),
  ]);
  if (
    remainingRevisions.length > 0 ||
    remainingDocuments.length > 0 ||
    remainingRecords.some(Boolean)
  ) {
    throw new Error("Source item provenance cleanup is incomplete");
  }
  await ctx.db.patch(item._id, {
    externalId: undefined,
    title: undefined,
    docType: undefined,
    uri: undefined,
    lifecycle: "forgotten",
    originalLinkAvailable: false,
    desiredRevisionId: undefined,
    activeRevisionId: undefined,
    activeGenerationId: undefined,
    activeCardGenerationId: undefined,
    lastFailure: undefined,
    workerObservationEpoch: undefined,
    workerProcessingEpoch: undefined,
    workerInventoryMetadataDigest: undefined,
    workerProcessingIdentityDigest: undefined,
    workerContentHash: undefined,
    workerSourceModifiedAt: undefined,
    workerProfileId: undefined,
    workerLastSeenInventoryEpoch: undefined,
  });
}
