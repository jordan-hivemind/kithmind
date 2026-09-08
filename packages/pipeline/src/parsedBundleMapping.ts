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
const MAX_TEXT_BYTES = 262_144;
const DOCUMENT_KEY = "pdf:primary";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A bounded initial policy, not a claim of optimal retrieval quality. */
export const PDF_DOCQA_CHUNKING_FINGERPRINT = sha256(
  JSON.stringify([
    "pdf_docqa_chunks_v1",
    CHUNK_TARGET_BYTES,
    "page_local_nonoverlapping_unicode_scalars",
    "direct_page_concatenation",
    "merge_uncited_separator_tail",
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
    const provenance = object(input.provenance);
    if (
      resolved.kind !== "item" ||
      input.itemRef !== resolved.ref ||
      provenance.page_no !== pageNumber ||
      input.doclingCharspanSemantics !==
        "item_local_python_codepoints_not_evidence" ||
      !Array.isArray(provenance.charspan) ||
      provenance.charspan.length !== 2
    )
      fail();
    return {
      kind: "parser_item_v1",
      pageNumber,
      itemRef: resolved.ref,
      sourceCharStart: number(provenance.charspan[0]),
      sourceCharEnd: number(provenance.charspan[1]),
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

function pageChunks(
  page: ParsedPageInput,
  evidence: ParsedEvidenceInput[],
): ParsedChunkInput[] {
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
}) {
  try {
    const bundle = object(input.bundle);
    if (!Array.isArray(bundle.pages) || !Array.isArray(bundle.mappingGaps))
      fail();
    if (bundle.mappingGaps.length) fail("mapping_gap");
    if (!bundle.pages.length || bundle.pages.length > 32) fail("mapping_limit");
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
        textBytes > MAX_TEXT_BYTES ||
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
        evidence.push(
          parseParsedEvidenceInput({
            ordinal: evidence.length,
            pageOrdinal: ordinal,
            start: expectedStart,
            end: expectedStart + segmentText.length,
            quoteHash: sha256(segmentText),
            locator: locator(object(segment.locator), resolved, ordinal + 1),
          }),
        );
        if (evidence.length > 128) fail("mapping_limit");
        expectedStart += segmentText.length + 1;
        segmentTexts.push(segmentText);
      }
      if (segmentTexts.join("\n") !== pageText) fail();
    }
    if (
      Object.keys(input.resolvedLocators).length !== seen.size ||
      !completeText ||
      !evidence.length
    )
      fail();
    const chunks = pages
      .flatMap((page) => pageChunks(page, evidence))
      .map((chunk, ordinal) => parseParsedChunkInput({ ...chunk, ordinal }));
    if (!chunks.length || chunks.length > 128) fail("mapping_limit");
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
      chunkingFingerprint: PDF_DOCQA_CHUNKING_FINGERPRINT,
    };
  } catch (error) {
    if (error instanceof ParsedBundleMappingError) throw error;
    throw new ParsedBundleMappingError("invalid_mapping");
  }
}
