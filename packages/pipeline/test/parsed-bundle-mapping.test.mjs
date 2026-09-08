import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  mapParsedBundle,
  ParsedBundleMappingError,
  PDF_DOCQA_CHUNKING_FINGERPRINT,
  PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT,
} from "../dist/parsedBundleMapping.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const box = { l: 0, t: 0, r: 1, b: 1, coord_origin: "TOPLEFT" };

function item(text, page, id, ref = `#/texts/${id}`) {
  return {
    id: `item-${id}`,
    text,
    citable: true,
    locator: {
      kind: "docling_item",
      itemRef: ref,
      provenance: { page_no: page, charspan: [0, [...text].length], bbox: box },
      doclingCharspanSemantics: "item_local_python_codepoints_not_evidence",
    },
  };
}

function fixture(pageSegments) {
  const resolvedLocators = {};
  const pages = pageSegments.map((segments, index) => {
    let cursor = 0;
    for (const segment of segments) {
      segment.startUtf16 = cursor;
      segment.endUtf16 = cursor + segment.text.length;
      cursor = segment.endUtf16 + 1;
      resolvedLocators[segment.id] =
        segment.locator.kind === "docling_item"
          ? { kind: "item", ref: segment.locator.itemRef }
          : { kind: "table", ref: "#/tables/7" };
    }
    return {
      page: index + 1,
      text: segments.map((segment) => segment.text).join("\n"),
      segments,
    };
  });
  return {
    bundle: { pages, mappingGaps: [] },
    resolvedLocators,
    title: "Synthetic pilot report",
    capturedAt: 1_800_000_000_000,
    chunkingFingerprint: PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT,
  };
}

function cell(text, row = 0, column = 0) {
  return {
    text,
    start_row_offset_idx: row,
    end_row_offset_idx: row + 1,
    start_col_offset_idx: column,
    end_col_offset_idx: column + 1,
    row_span: 1,
    col_span: 1,
    bbox: box,
  };
}

function table(text, page, row, cells = [cell(text, row)]) {
  return {
    id: `docling-table-${page}-0-row-${row}`,
    text,
    citable: true,
    locator: {
      kind: "docling_table_row",
      tableProvenance: { page_no: page, charspan: [0, 0], bbox: box },
      cells,
    },
  };
}

async function rejected(input, code) {
  await assert.rejects(mapParsedBundle(input), (error) => {
    assert.ok(error instanceof ParsedBundleMappingError);
    if (code) assert.equal(error.code, code);
    assert.ok(!error.message.includes("Synthetic pilot report"));
    return true;
  });
}

test("maps direct page concatenation, exact Unicode quotes and separate source offsets", async () => {
  const input = fixture([
    [item("🧪", 1, 0), item("Café lab result", 1, 1)],
    [],
    [item("Oil changed", 3, 2)],
  ]);
  const result = await mapParsedBundle(input);
  assert.deepEqual(
    result.pages.map(({ start, end }) => [start, end]),
    [
      [0, 18],
      [18, 18],
      [18, 29],
    ],
  );
  const complete = input.bundle.pages.map((page) => page.text).join("");
  assert.equal(result.textHash, hash(complete));
  assert.equal(result.textUtf8Length, Buffer.byteLength(complete));
  assert.equal(result.textUtf16Length, complete.length);
  assert.equal(result.evidence[0].end, 2);
  assert.equal(result.evidence[0].locator.sourceCharEnd, 1);
  assert.equal(result.evidence[0].quoteHash, hash("🧪"));
  assert.equal(result.evidence[2].pageOrdinal, 2);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].evidence.length, 3);
  assert.equal(result.chunks.map((chunk) => chunk.text).join(""), complete);
  assert.match(result.mappingManifestHash, /^[a-f0-9]{64}$/);
  assert.equal(
    result.chunkingFingerprint,
    PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT,
  );
  assert.deepEqual(await mapParsedBundle(structuredClone(input)), result);
});

test("current profile emits one page-bound evidence span per 8 KiB scalar-safe chunk", async () => {
  const pageText = "a".repeat(8191) + "🧪" + "界".repeat(3000);
  const input = fixture([[item(pageText, 1, 0)]]);
  input.chunkingFingerprint = PDF_DOCQA_CHUNKING_FINGERPRINT;
  const result = await mapParsedBundle(input);
  assert.ok(result.chunks.length > 1);
  assert.equal(result.chunks.length, result.evidence.length);
  assert.equal(result.chunks.map((chunk) => chunk.text).join(""), pageText);
  for (const [index, chunk] of result.chunks.entries()) {
    assert.ok(Buffer.byteLength(chunk.text, "utf8") <= 8192);
    assert.deepEqual(chunk.evidence, [
      { pageOrdinal: 0, evidenceOrdinal: index },
    ]);
    const span = result.evidence[index];
    assert.equal(span.start, chunk.start);
    assert.equal(span.end, chunk.end);
    assert.deepEqual(span.locator, {
      kind: "parser_page_v1",
      pageNumber: 1,
      pageTextHash: hash(pageText),
    });
  }
});

test("current profile maps the exact 64-page and 1 MiB retained-text boundary", async () => {
  const pageText = "x".repeat(16 * 1024);
  const input = fixture(
    Array.from({ length: 64 }, (_, index) => [
      item(pageText, index + 1, index),
    ]),
  );
  input.chunkingFingerprint = PDF_DOCQA_CHUNKING_FINGERPRINT;
  const result = await mapParsedBundle(input);
  assert.equal(result.pages.length, 64);
  assert.equal(result.textUtf8Length, 1024 * 1024);
  assert.equal(result.chunks.length, 128);
  assert.equal(result.evidence.length, 128);

  const tooManyPages = fixture(
    Array.from({ length: 65 }, (_, index) => [item("x", index + 1, index)]),
  );
  tooManyPages.chunkingFingerprint = PDF_DOCQA_CHUNKING_FINGERPRINT;
  await rejected(tooManyPages, "mapping_limit");

  const tooManyBytes = fixture(
    Array.from({ length: 17 }, (_, index) => [
      item("x".repeat(64 * 1024), index + 1, index),
    ]),
  );
  tooManyBytes.chunkingFingerprint = PDF_DOCQA_CHUNKING_FINGERPRINT;
  await rejected(tooManyBytes, "mapping_limit");
});

test("maps Unicode same-page multi-span item to its codepoint source envelope", async () => {
  const segment = item("🧪 alpha β", 1, 0);
  segment.locator.provenance = [
    { page_no: 1, charspan: [0, 1], bbox: box },
    { page_no: 1, charspan: [2, 7], bbox: box },
    { page_no: 1, charspan: [8, 9], bbox: box },
  ];
  const input = fixture([[segment]]);
  const result = await mapParsedBundle(input);
  assert.equal(result.evidence[0].locator.sourceCharStart, 0);
  assert.equal(result.evidence[0].locator.sourceCharEnd, 9);

  const singletonArray = structuredClone(input);
  singletonArray.bundle.pages[0].segments[0].locator.provenance = [
    { page_no: 1, charspan: [0, 9], bbox: box },
  ];
  await rejected(singletonArray);

  const crossPage = structuredClone(input);
  crossPage.bundle.pages[0].segments[0].locator.provenance[1].page_no = 2;
  await rejected(crossPage);
  const overlapping = structuredClone(input);
  overlapping.bundle.pages[0].segments[0].locator.provenance[1].charspan = [
    4, 10,
  ];
  await rejected(overlapping);
});

test("maps page-local slices of one cross-page raw item", async () => {
  const provenance = [
    { page_no: 1, charspan: [0, 5], bbox: box },
    { page_no: 2, charspan: [6, 7], bbox: box },
    { page_no: 2, charspan: [8, 12], bbox: box },
  ];
  const slice = (text, page, id, indexes, charspan) => ({
    id,
    text,
    citable: true,
    locator: {
      kind: "docling_item_slice",
      itemRef: "#/texts/0",
      provenance,
      provenanceIndexes: indexes,
      itemTextCharspan: charspan,
      doclingCharspanSemantics: "item_local_python_codepoints",
    },
  });
  const input = fixture([
    [slice("Alpha ", 1, "slice-0", [0, 1], [0, 6])],
    [slice("🧪 beta", 2, "slice-1", [1, 3], [6, 12])],
  ]);
  input.resolvedLocators["slice-0"] = { kind: "item", ref: "#/texts/0" };
  input.resolvedLocators["slice-1"] = { kind: "item", ref: "#/texts/0" };
  const result = await mapParsedBundle(input);
  assert.deepEqual(
    result.evidence.map((entry) => [
      entry.pageOrdinal,
      entry.locator.sourceCharStart,
      entry.locator.sourceCharEnd,
    ]),
    [
      [0, 0, 6],
      [1, 6, 12],
    ],
  );

  const wrongSelection = structuredClone(input);
  wrongSelection.bundle.pages[1].segments[0].locator.provenanceIndexes = [0, 3];
  await rejected(wrongSelection);
});

test("uses raw-resolved table references and exact cell hashes, never page-local table ordinal", async () => {
  const input = fixture([
    [item("First page", 1, 0)],
    [table("Café", 2, 0, [cell("Cafe\u0301")]), table("Café", 2, 1)],
  ]);
  const result = await mapParsedBundle(input);
  const first = result.evidence[1];
  const second = result.evidence[2];
  assert.equal(first.locator.tableRef, "#/tables/7");
  assert.equal(first.locator.sourceRowOffset, 0);
  assert.equal(second.locator.sourceRowOffset, 1);
  assert.equal(first.quoteHash, second.quoteHash);
  assert.equal(first.locator.cells[0].textHash, hash("Cafe\u0301"));
  assert.notEqual(first.locator.cells[0].textHash, first.quoteHash);
  assert.ok(!("bbox" in first.locator));
  assert.ok(!("bbox" in first.locator.cells[0]));
});

test("chunking preserves all bytes and UTF-16 boundaries without crossing pages", async () => {
  const first = "a".repeat(8191) + "🧪" + "界".repeat(6000);
  const second = "Second page " + "🧪".repeat(3000);
  const result = await mapParsedBundle(
    fixture([[item(first, 1, 0)], [item(second, 2, 1)]]),
  );
  assert.ok(result.chunks.length > 3);
  assert.equal(
    result.chunks.map((chunk) => chunk.text).join(""),
    first + second,
  );
  let cursor = 0;
  for (const [ordinal, chunk] of result.chunks.entries()) {
    assert.equal(chunk.ordinal, ordinal);
    assert.equal(chunk.start, cursor);
    assert.equal(chunk.end - chunk.start, chunk.text.length);
    assert.ok(chunk.text.isWellFormed());
    assert.ok(Buffer.byteLength(chunk.text) <= 8193);
    assert.equal(chunk.evidence.length, 1);
    assert.ok(chunk.end <= first.length || chunk.start >= first.length);
    cursor = chunk.end;
  }
  assert.equal(cursor, first.length + second.length);
});

test("mapping gaps and incomplete or contradictory resolved references stop publication", async () => {
  const original = fixture([[item("Result", 1, 0)]]);
  const gap = structuredClone(original);
  gap.bundle.mappingGaps.push({ kind: "ambiguous_text_provenance", item: 2 });
  await rejected(gap, "mapping_gap");
  const missing = structuredClone(original);
  delete missing.resolvedLocators["item-0"];
  await rejected(missing);
  const extra = structuredClone(original);
  extra.resolvedLocators.extra = { kind: "item", ref: "#/texts/8" };
  await rejected(extra);
  const different = structuredClone(original);
  different.resolvedLocators["item-0"].ref = "#/texts/8";
  await rejected(different);
  const kind = structuredClone(original);
  kind.resolvedLocators["item-0"].kind = "table";
  await rejected(kind);
  const offset = structuredClone(original);
  offset.bundle.pages[0].segments[0].startUtf16 = 1;
  await rejected(offset);
  const duplicate = fixture([[item("Result", 1, 0), item("Result", 1, 0)]]);
  await rejected(duplicate);
});

test("fails closed on supported graph and table bounds", async () => {
  await rejected(fixture([[item("x".repeat(65_537), 1, 0)]]), "mapping_limit");
  await rejected(
    fixture(
      Array.from({ length: 5 }, (_, index) => [
        item("x".repeat(60_000), index + 1, index),
      ]),
    ),
    "mapping_limit",
  );
  await rejected(
    fixture([Array.from({ length: 129 }, (_, index) => item("x", 1, index))]),
  );
  const badCell = fixture([[table("Value", 1, 0)]]);
  badCell.bundle.pages[0].segments[0].locator.cells[0].col_span = 2;
  await rejected(badCell);
  const repeatColumn = fixture([
    [table("A | B", 1, 0, [cell("A"), cell("B")])],
  ]);
  await rejected(repeatColumn);
  await rejected(fixture([[]]));
  await rejected(fixture([[item("\ud800", 1, 0)]]));
});
