import { createHash } from "node:crypto";
import {
  digestParsedMappingManifest,
  parseParsedChunkInput,
  parseParsedDocumentInput,
  parseParsedEvidenceInput,
  parseParsedPageInput,
  type ParsedChunkInput,
  type ParsedEvidenceInput,
  type ParsedEvidenceRef,
  type ParsedLocator,
  type ParsedPageInput,
} from "@repo/worker-protocol";

const CHUNK_TARGET_BYTES = 8_192;
const LEGACY_MAX_TEXT_BYTES = 262_144;
const MAX_TEXT_BYTES = 1024 * 1024;
const DOCUMENT_KEY = "pdf:primary";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A bounded initial policy, not a claim of optimal retrieval quality. */
export const PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT = sha256(
  JSON.stringify([
    "pdf_docqa_chunks_v1",
    CHUNK_TARGET_BYTES,
    "page_local_nonoverlapping_unicode_scalars",
    "direct_page_concatenation",
    "merge_uncited_separator_tail",
  ]),
);

export const PDF_DOCQA_CHUNKING_FINGERPRINT = sha256(
  JSON.stringify([
    "pdf_docqa_page_chunks_v2",
    CHUNK_TARGET_BYTES,
    "page_local_nonoverlapping_unicode_scalars",
    "one_parser_page_evidence_per_chunk",
    64,
    MAX_TEXT_BYTES,
    256,
  ]),
);

export class ParsedBundleMappingError extends Error {
  constructor(
    readonly code: "invalid_mapping" | "mapping_gap" | "mapping_limit",
  ) {
    super(`Parsed document mapping failed: ${code}`);
    this.name = "ParsedBundleMappingError";
  }
}

function fail(
  code: ParsedBundleMappingError["code"] = "invalid_mapping",
): never {
  throw new ParsedBundleMappingError(code);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function number(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail();
  return value as number;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !wellFormed(value) ||
    value.normalize("NFC") !== value
  )
    fail();
  return value;
}

export type ResolvedParserLocator = { kind: "item" | "table"; ref: string };

function locator(
  input: Record<string, unknown>,
  resolved: ResolvedParserLocator,
  pageNumber: number,
): ParsedLocator {
  // The source bounding box remains in the raw artifact. Do not discard its
  // coordinate-origin metadata by forwarding four numbers as an ambiguous box.
  if (input.kind === "docling_item") {
    const provenanceValue = input.provenance;
    const multiple = Array.isArray(provenanceValue);
    const provenance = multiple
      ? provenanceValue.map(object)
      : [object(provenanceValue)];
    if (
      resolved.kind !== "item" ||
      input.itemRef !== resolved.ref ||
      provenance.length < (multiple ? 2 : 1) ||
      provenance.length > 256 ||
      input.doclingCharspanSemantics !==
        "item_local_python_codepoints_not_evidence"
    )
      fail();
    let previousEnd = -1;
    let sourceStart = -1;
    for (const [index, span] of provenance.entries()) {
      if (
        span.page_no !== pageNumber ||
        !Array.isArray(span.charspan) ||
        span.charspan.length !== 2 ||
        !span.charspan.every(
          (offset: unknown) => Number.isInteger(offset) && Number(offset) >= 0,
        ) ||
        Number(span.charspan[0]) >= Number(span.charspan[1]) ||
        Number(span.charspan[0]) < previousEnd
      )
        fail();
      if (index === 0) sourceStart = Number(span.charspan[0]);
      previousEnd = Number(span.charspan[1]);
    }
    return {
      kind: "parser_item_v1",
      pageNumber,
      itemRef: resolved.ref,
      sourceCharStart: sourceStart,
      sourceCharEnd: previousEnd,
    };
  }
  if (input.kind === "docling_item_slice") {
    if (
      resolved.kind !== "item" ||
      input.itemRef !== resolved.ref ||
      input.doclingCharspanSemantics !== "item_local_python_codepoints" ||
      !Array.isArray(input.provenance) ||
      input.provenance.length < 2 ||
      input.provenance.length > 256 ||
      !Array.isArray(input.provenanceIndexes) ||
      input.provenanceIndexes.length !== 2 ||
      !Array.isArray(input.itemTextCharspan) ||
      input.itemTextCharspan.length !== 2
    )
      fail();
    const provenance = input.provenance.map(object);
    const provenanceStart = Number(input.provenanceIndexes[0]);
    const provenanceEnd = Number(input.provenanceIndexes[1]);
    const sourceStart = Number(input.itemTextCharspan[0]);
    const sourceEnd = Number(input.itemTextCharspan[1]);
    if (
      !Number.isInteger(provenanceStart) ||
      !Number.isInteger(provenanceEnd) ||
      provenanceStart < 0 ||
      provenanceEnd <= provenanceStart ||
      provenanceEnd > provenance.length ||
      !Number.isInteger(sourceStart) ||
      !Number.isInteger(sourceEnd) ||
      sourceStart < 0 ||
      sourceEnd <= sourceStart
    )
      fail();
    let priorEnd = -1;
    let priorPage = 0;
    for (const [index, span] of provenance.entries()) {
      if (
        !Number.isInteger(span.page_no) ||
        Number(span.page_no) < priorPage ||
        !Array.isArray(span.charspan) ||
        span.charspan.length !== 2 ||
        !span.charspan.every(
          (offset: unknown) => Number.isInteger(offset) && Number(offset) >= 0,
        ) ||
        Number(span.charspan[0]) >= Number(span.charspan[1]) ||
        Number(span.charspan[0]) < priorEnd ||
        (index >= provenanceStart && index < provenanceEnd) !==
          (span.page_no === pageNumber)
      )
        fail();
      priorEnd = Number(span.charspan[1]);
      priorPage = Number(span.page_no);
    }
    return {
      kind: "parser_item_v1",
      pageNumber,
      itemRef: resolved.ref,
      sourceCharStart: sourceStart,
      sourceCharEnd: sourceEnd,
    };
  }
  if (input.kind !== "docling_table_row" || resolved.kind !== "table") fail();
  if (
    object(input.tableProvenance).page_no !== pageNumber ||
    !Array.isArray(input.cells) ||
    input.cells.length === 0
  )
    fail();
  if (input.cells.length > 64) fail("mapping_limit");
  const cells = input.cells
    .map(object)
    .sort(
      (a, b) => number(a.start_col_offset_idx) - number(b.start_col_offset_idx),
    );
  const sourceRowOffset = number(cells[0]!.start_row_offset_idx);
  return {
    kind: "parser_table_row_v1",
    pageNumber,
    tableRef: resolved.ref,
    sourceRowOffset,
    cells: cells.map((cell) => {
      const column = number(cell.start_col_offset_idx);
      const rowSpan = number(cell.row_span, 1);
      const columnSpan = number(cell.col_span, 1);
      if (
        number(cell.start_row_offset_idx) !== sourceRowOffset ||
        number(cell.end_row_offset_idx) !== sourceRowOffset + rowSpan ||
        number(cell.end_col_offset_idx) !== column + columnSpan ||
        typeof cell.text !== "string" ||
        !wellFormed(cell.text)
      )
        fail();
      // Cell hashes identify exact raw parser cell text, not the normalized
      // page quote. Those two hashes can legitimately differ.
      return { column, rowSpan, columnSpan, textHash: sha256(cell.text) };
    }),
  };
}

function references(
  evidence: ParsedEvidenceInput[],
  page: ParsedPageInput,
  start: number,
  end: number,
): ParsedEvidenceRef[] {
  return evidence
    .filter(
      (span) =>
        span.pageOrdinal === page.ordinal &&
        page.start + span.start < end &&
        page.start + span.end > start,
    )
    .map((span) => ({
      pageOrdinal: page.ordinal,
      evidenceOrdinal: span.ordinal,
    }));
}

function pageChunkRanges(page: ParsedPageInput) {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  let end = 0;
  let bytes = 0;
  for (const scalar of page.text) {
    const length = Buffer.byteLength(scalar, "utf8");
    if (bytes + length > CHUNK_TARGET_BYTES) {
      ranges.push({ start, end });
      start = end;
      bytes = 0;
    }
    end += scalar.length;
    bytes += length;
  }
  if (end > start) ranges.push({ start, end });
  return ranges;
}

function legacyPageChunks(
  page: ParsedPageInput,
  evidence: ParsedEvidenceInput[],
): ParsedChunkInput[] {
  const ranges = pageChunkRanges(page);
  const last = ranges.at(-1);
  if (
    last &&
    ranges.length > 1 &&
    references(evidence, page, page.start + last.start, page.start + last.end)
      .length === 0
  ) {
    if (page.text.slice(last.start, last.end) !== "\n") fail();
    ranges[ranges.length - 2]!.end = last.end;
    ranges.pop();
  }
  return ranges.map((range) => {
    const start = page.start + range.start;
    const end = page.start + range.end;
    const refs = references(evidence, page, start, end);
    if (!refs.length) fail();
    return {
      documentKey: DOCUMENT_KEY,
      ordinal: 0,
      start,
      end,
      text: page.text.slice(range.start, range.end),
      evidence: refs,
    };
  });
}

/**
 * Consume the parser/spool inspector's raw-artifact-validated bundle and refs.
 * This pure mapper does not attest a file digest or validate parser runtime
 * fingerprints. Callers must retain that preceding validation on every reopen.
 */
export async function mapParsedBundle(input: {
  bundle: unknown;
  resolvedLocators: Record<string, ResolvedParserLocator>;
  title: string;
  capturedAt: number;
  chunkingFingerprint: string;
}) {
  try {
    const legacy =
      input.chunkingFingerprint === PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT;
    if (!legacy && input.chunkingFingerprint !== PDF_DOCQA_CHUNKING_FINGERPRINT)
      fail();
    const bundle = object(input.bundle);
    if (!Array.isArray(bundle.pages) || !Array.isArray(bundle.mappingGaps))
      fail();
    if (bundle.mappingGaps.length) fail("mapping_gap");
    if (!bundle.pages.length || bundle.pages.length > (legacy ? 32 : 64))
      fail("mapping_limit");
    const pages: ParsedPageInput[] = [];
    const evidence: ParsedEvidenceInput[] = [];
    const seen = new Set<string>();
    let completeText = "";
    let textBytes = 0;
    for (const value of bundle.pages) {
      const page = object(value);
      const pageText = text(page.text);
      const ordinal = pages.length;
      if (page.page !== ordinal + 1 || !Array.isArray(page.segments)) fail();
      textBytes += Buffer.byteLength(pageText, "utf8");
      if (
        textBytes > (legacy ? LEGACY_MAX_TEXT_BYTES : MAX_TEXT_BYTES) ||
        Buffer.byteLength(pageText, "utf8") > 65_536
      )
        fail("mapping_limit");
      const mappedPage = parseParsedPageInput({
        ordinal,
        start: completeText.length,
        end: completeText.length + pageText.length,
        text: pageText,
        textHash: sha256(pageText),
      });
      pages.push(mappedPage);
      completeText += pageText;
      let expectedStart = 0;
      const segmentTexts: string[] = [];
      for (const value of page.segments) {
        const segment = object(value);
        const id = text(segment.id);
        const segmentText = text(segment.text);
        if (
          !id ||
          seen.has(id) ||
          segment.citable !== true ||
          !segmentText ||
          segment.startUtf16 !== expectedStart ||
          segment.endUtf16 !== expectedStart + segmentText.length ||
          pageText.slice(expectedStart, expectedStart + segmentText.length) !==
            segmentText ||
          !Object.hasOwn(input.resolvedLocators, id)
        )
          fail();
        seen.add(id);
        const resolved = input.resolvedLocators[id]!;
        if (
          !resolved ||
          !resolved.ref ||
          (resolved.kind !== "item" && resolved.kind !== "table")
        )
          fail();
        const sourceLocator = locator(
          object(segment.locator),
          resolved,
          ordinal + 1,
        );
        if (legacy) {
          evidence.push(
            parseParsedEvidenceInput({
              ordinal: evidence.length,
              pageOrdinal: ordinal,
              start: expectedStart,
              end: expectedStart + segmentText.length,
              quoteHash: sha256(segmentText),
              locator: sourceLocator,
            }),
          );
          if (evidence.length > 128) fail("mapping_limit");
        }
        expectedStart += segmentText.length + 1;
        segmentTexts.push(segmentText);
      }
      if (segmentTexts.join("\n") !== pageText) fail();
    }
    if (
      Object.keys(input.resolvedLocators).length !== seen.size ||
      !completeText ||
      (legacy && !evidence.length)
    )
      fail();
    let chunks: ParsedChunkInput[];
    if (legacy) {
      chunks = pages
        .flatMap((page) => legacyPageChunks(page, evidence))
        .map((chunk, ordinal) => parseParsedChunkInput({ ...chunk, ordinal }));
    } else {
      const pendingChunks: ParsedChunkInput[] = [];
      for (const page of pages) {
        for (const range of pageChunkRanges(page)) {
          const chunkText = page.text.slice(range.start, range.end);
          const evidenceOrdinal = evidence.length;
          evidence.push(
            parseParsedEvidenceInput({
              ordinal: evidenceOrdinal,
              pageOrdinal: page.ordinal,
              start: range.start,
              end: range.end,
              quoteHash: sha256(chunkText),
              locator: {
                kind: "parser_page_v1",
                pageNumber: page.ordinal + 1,
                pageTextHash: page.textHash,
              },
            }),
          );
          pendingChunks.push(
            parseParsedChunkInput({
              documentKey: DOCUMENT_KEY,
              ordinal: pendingChunks.length,
              start: page.start + range.start,
              end: page.start + range.end,
              text: chunkText,
              evidence: [
                { pageOrdinal: page.ordinal, evidenceOrdinal },
              ],
            }),
          );
        }
      }
      chunks = pendingChunks;
    }
    const countLimit = legacy ? 128 : 256;
    if (
      !chunks.length ||
      chunks.length > countLimit ||
      !evidence.length ||
      evidence.length > countLimit
    )
      fail("mapping_limit");
    const documents = [
      parseParsedDocumentInput({
        documentKey: DOCUMENT_KEY,
        title: input.title,
        docType: "pdf",
        capturedAt: input.capturedAt,
        evidence: evidence.map((span) => ({
          pageOrdinal: span.pageOrdinal,
          evidenceOrdinal: span.ordinal,
        })),
      }),
    ];
    return {
      pages,
      evidence,
      documents,
      chunks,
      mappingManifestHash: await digestParsedMappingManifest(pages, evidence),
      textHash: sha256(completeText),
      textUtf8Length: textBytes,
      textUtf16Length: completeText.length,
      chunkingFingerprint: input.chunkingFingerprint,
    };
  } catch (error) {
    if (error instanceof ParsedBundleMappingError) throw error;
    throw new ParsedBundleMappingError("invalid_mapping");
  }
}
