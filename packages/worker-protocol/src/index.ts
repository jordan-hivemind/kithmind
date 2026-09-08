export const PARSED_MAPPING_DOMAIN = "kith-parsed-cloud-mapping:v1\0";
export const MAX_PARSED_REQUEST_BYTES = 128 * 1024;
export const MAX_PARSED_PAGE_BATCH = 8;
export const MAX_PARSED_ROW_BATCH = 25;

export type ParsedBox = [number, number, number, number];

export type ParserItemLocator = {
  kind: "parser_item_v1";
  pageNumber: number;
  itemRef: string;
  sourceCharStart: number;
  sourceCharEnd: number;
  bbox?: ParsedBox;
};

export type ParserTableCell = {
  column: number;
  rowSpan: number;
  columnSpan: number;
  textHash: string;
  bbox?: ParsedBox;
};

export type ParserTableRowLocator = {
  kind: "parser_table_row_v1";
  pageNumber: number;
  tableRef: string;
  sourceRowOffset: number;
  bbox?: ParsedBox;
  cells: ParserTableCell[];
};

export type ParsedLocator = ParserItemLocator | ParserTableRowLocator;

export type ParsedPageInput = {
  ordinal: number;
  start: number;
  end: number;
  text: string;
  textHash: string;
};

export type ParsedEvidenceInput = {
  ordinal: number;
  pageOrdinal: number;
  start: number;
  end: number;
  quoteHash: string;
  locator: ParsedLocator;
};

export type ParsedEvidenceRef = {
  pageOrdinal: number;
  evidenceOrdinal: number;
};

export type ParsedDocumentInput = {
  documentKey: string;
  title: string;
  docType: string;
  capturedAt: number;
  evidence: ParsedEvidenceRef[];
};

export type ParsedChunkInput = {
  documentKey: string;
  ordinal: number;
  start: number;
  end: number;
  text: string;
  evidence: ParsedEvidenceRef[];
};

export type ParsedStagePhase =
  "pages" | "evidence" | "documents" | "chunks" | "seal" | "staged";

const SHA256 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function invalid(): never {
  throw new Error("Invalid parsed worker input");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid();
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    invalid();
}

function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    invalid();
  return value as number;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  return Object.is(value, -0) ? 0 : value;
}

function text(value: unknown, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0))
    invalid();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  if (
    value.normalize("NFC") !== value ||
    encoder.encode(value).byteLength > maxBytes
  )
    invalid();
  return value;
}

function hash(value: unknown): string {
  const result = text(value, 64);
  if (!SHA256.test(result)) invalid();
  return result;
}

function box(value: unknown): ParsedBox | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4) invalid();
  return [
    finite(value[0]),
    finite(value[1]),
    finite(value[2]),
    finite(value[3]),
  ];
}

export function parseParsedLocator(value: unknown): ParsedLocator {
  const input = record(value);
  if (input.kind === "parser_item_v1") {
    keys(
      input,
      ["kind", "pageNumber", "itemRef", "sourceCharStart", "sourceCharEnd"],
      ["bbox"],
    );
    const start = integer(input.sourceCharStart, 0);
    const end = integer(input.sourceCharEnd, start);
    return {
      kind: "parser_item_v1",
      pageNumber: integer(input.pageNumber, 1, 32),
      itemRef: text(input.itemRef, 1024),
      sourceCharStart: start,
      sourceCharEnd: end,
      ...(input.bbox === undefined ? {} : { bbox: box(input.bbox)! }),
    };
  }
  if (input.kind !== "parser_table_row_v1") invalid();
  keys(
    input,
    ["kind", "pageNumber", "tableRef", "sourceRowOffset", "cells"],
    ["bbox"],
  );
  if (
    !Array.isArray(input.cells) ||
    input.cells.length < 1 ||
    input.cells.length > 64
  )
    invalid();
  let previous = -1;
  const cells = input.cells.map((value) => {
    const cell = record(value);
    keys(cell, ["column", "rowSpan", "columnSpan", "textHash"], ["bbox"]);
    const column = integer(cell.column, 0, 255);
    if (column <= previous) invalid();
    previous = column;
    return {
      column,
      rowSpan: integer(cell.rowSpan, 1, 256),
      columnSpan: integer(cell.columnSpan, 1, 256),
      textHash: hash(cell.textHash),
      ...(cell.bbox === undefined ? {} : { bbox: box(cell.bbox)! }),
    };
  });
  return {
    kind: "parser_table_row_v1",
    pageNumber: integer(input.pageNumber, 1, 32),
    tableRef: text(input.tableRef, 1024),
    sourceRowOffset: integer(input.sourceRowOffset, 0, 1_000_000),
    ...(input.bbox === undefined ? {} : { bbox: box(input.bbox)! }),
    cells,
  };
}

export function parseParsedPageInput(value: unknown): ParsedPageInput {
  const input = record(value);
  keys(input, ["ordinal", "start", "end", "text", "textHash"]);
  const start = integer(input.start, 0, 262_144);
  const end = integer(input.end, start, 262_144);
  const parsedText = text(input.text, 65_536, true);
  if (parsedText.length !== end - start) invalid();
  return {
    ordinal: integer(input.ordinal, 0, 31),
    start,
    end,
    text: parsedText,
    textHash: hash(input.textHash),
  };
}

export function parseParsedEvidenceInput(value: unknown): ParsedEvidenceInput {
  const input = record(value);
  keys(input, [
    "ordinal",
    "pageOrdinal",
    "start",
    "end",
    "quoteHash",
    "locator",
  ]);
  const pageOrdinal = integer(input.pageOrdinal, 0, 31);
  const locator = parseParsedLocator(input.locator);
  if (locator.pageNumber !== pageOrdinal + 1) invalid();
  const start = integer(input.start, 0, 65_536);
  return {
    ordinal: integer(input.ordinal, 0, 127),
    pageOrdinal,
    start,
    end: integer(input.end, start, 65_536),
    quoteHash: hash(input.quoteHash),
    locator,
  };
}

function evidenceRefs(value: unknown): ParsedEvidenceRef[] {
  if (!Array.isArray(value) || value.length > 128) invalid();
  return value.map((entry) => {
    const input = record(entry);
    keys(input, ["pageOrdinal", "evidenceOrdinal"]);
    return {
      pageOrdinal: integer(input.pageOrdinal, 0, 31),
      evidenceOrdinal: integer(input.evidenceOrdinal, 0, 127),
    };
  });
}

export function parseParsedDocumentInput(value: unknown): ParsedDocumentInput {
  const input = record(value);
  keys(input, ["documentKey", "title", "docType", "capturedAt", "evidence"]);
  return {
    documentKey: text(input.documentKey, 256),
    title: text(input.title, 1024),
    docType: text(input.docType, 256),
    capturedAt: integer(input.capturedAt, 0),
    evidence: evidenceRefs(input.evidence),
  };
}

export function parseParsedChunkInput(value: unknown): ParsedChunkInput {
  const input = record(value);
  keys(input, ["documentKey", "ordinal", "start", "end", "text", "evidence"]);
  const start = integer(input.start, 0, 262_144);
  const end = integer(input.end, start, 262_144);
  const parsedText = text(input.text, 65_536, true);
  if (parsedText.length !== end - start) invalid();
  return {
    documentKey: text(input.documentKey, 256),
    ordinal: integer(input.ordinal, 0, 127),
    start,
    end,
    text: parsedText,
    evidence: evidenceRefs(input.evidence),
  };
}

function canonicalBox(value: ParsedBox | undefined): ParsedBox | null {
  return value ?? null;
}

export function canonicalParsedLocator(locator: ParsedLocator): unknown[] {
  const parsed = parseParsedLocator(locator);
  return parsed.kind === "parser_item_v1"
    ? [
        parsed.kind,
        parsed.pageNumber,
        parsed.itemRef,
        parsed.sourceCharStart,
        parsed.sourceCharEnd,
        canonicalBox(parsed.bbox),
      ]
    : [
        parsed.kind,
        parsed.pageNumber,
        parsed.tableRef,
        parsed.sourceRowOffset,
        canonicalBox(parsed.bbox),
        parsed.cells.map((cell) => [
          cell.column,
          cell.rowSpan,
          cell.columnSpan,
          cell.textHash,
          canonicalBox(cell.bbox),
        ]),
      ];
}

export function canonicalParsedMappingManifestInput(
  pages: readonly ParsedPageInput[],
  evidence: readonly ParsedEvidenceInput[],
): unknown[] {
  const parsedPages = pages
    .map(parseParsedPageInput)
    .sort((a, b) => a.ordinal - b.ordinal);
  const parsedEvidence = evidence
    .map(parseParsedEvidenceInput)
    .sort((a, b) => a.pageOrdinal - b.pageOrdinal || a.ordinal - b.ordinal);
  return [
    1,
    parsedPages.map((page) => [
      page.ordinal,
      page.start,
      page.end,
      page.textHash,
    ]),
    parsedEvidence.map((span) => [
      span.pageOrdinal,
      span.ordinal,
      span.start,
      span.end,
      span.quoteHash,
      canonicalParsedLocator(span.locator),
    ]),
  ];
}

export async function digestParsedMappingManifest(
  pages: readonly ParsedPageInput[],
  evidence: readonly ParsedEvidenceInput[],
): Promise<string> {
  const bytes = encoder.encode(
    PARSED_MAPPING_DOMAIN +
      JSON.stringify(canonicalParsedMappingManifestInput(pages, evidence)),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function assertParsedRequestSize(value: unknown): void {
  if (
    encoder.encode(JSON.stringify(value)).byteLength > MAX_PARSED_REQUEST_BYTES
  )
    invalid();
}

export type ArchivedWorkIdentity = {
  sourceItemId: string;
  scanId: string;
  observationEpoch: number;
  processingEpoch: number;
  contentHash: string;
  byteLength: number;
  mediaType: "application/pdf";
  parserProfileId: "pdf_docqa_v1";
  parserFingerprint: string;
  extractionConfigurationFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  correctionRevision: string;
};

export type ParserArtifactSelection =
  | {
      kind: "create";
      clientArtifactId: string;
      outputHash: string;
      outputByteLength: number;
      outputMediaType: "application/vnd.docling+json";
      createdAt: number;
    }
  | { kind: "existing"; parserArtifactId: string };

export type ArchiveReceiptSelection =
  | {
      kind: "create";
      subjectKind: "original_bytes" | "parser_output";
      copyRole: "primary" | "independent_backup";
      clientReceiptId: string;
      archiveProfileFingerprint: string;
      archiveIdentityFingerprint: string;
      recipientFingerprint: string;
      repositoryKeyDomainFingerprint: string;
      storageFailureDomainFingerprint: string;
      archiveObjectId: string;
      ciphertextHash: string;
      ciphertextByteLength: number;
      readbackVerifiedAt: number;
      createdAt: number;
    }
  | {
      kind: "existing";
      subjectKind: "original_bytes" | "parser_output";
      copyRole: "primary" | "independent_backup";
      receiptId: string;
      bindingEpoch: number;
    };

export type ParsedTextDeclaration = {
  extractionFingerprint: string;
  textHash: string;
  byteLength: number;
  utf16Length: number;
  pageCount: number;
  mappingManifestHash: string;
  normalizedBundleDigest: string;
  expectedEvidenceSpanCount: number;
  expectedDocumentCount: number;
  expectedChunkCount: number;
};
