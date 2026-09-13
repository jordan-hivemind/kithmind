import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import { readWorkbook, SpreadsheetError } from "../dist/spreadsheet.js";
import {
  mapSpreadsheetWorkbook,
  SPREADSHEET_CHUNKING_FINGERPRINT,
} from "../dist/parsedBundleMapping.js";
import { resolveSheetCell, SPREADSHEET_V1_BOUNDS } from "@repo/worker-protocol";

/**
 * P2-70i. The workbook is generated here, in the test, from the OOXML parts a
 * real spreadsheet writes. No sample file enters the repository and nothing
 * here describes a real account, balance or person.
 */

// --- the smallest ZIP writer that produces a real .xlsx -------------------

function zip(parts) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const raw = Buffer.from(content, "utf8");
    const deflated = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + deflated.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function sheetXml(rows) {
  const cells = rows
    .map(
      (row, index) =>
        `<row r="${index + 1}">${row
          .map((cell) => (cell === null ? "" : cellXml(cell)))
          .join("")}</row>`,
    )
    .join("");
  return `<?xml version="1.0"?><worksheet><sheetData>${cells}</sheetData></worksheet>`;
}

function cellXml(cell) {
  const formula = cell.formula ? `<f>${cell.formula}</f>` : "";
  if (cell.shared !== undefined) {
    return `<c r="${cell.r}" t="s">${formula}<v>${cell.shared}</v></c>`;
  }
  return `<c r="${cell.r}">${formula}<v>${cell.value}</v></c>`;
}

/**
 * Two sheets, a header row, a totals row, an empty cell (Q2 on the second
 * row of `Revenue`) and a formula whose cached value is what the page shows.
 */
const SHARED = [
  "Quarter",
  "Region",
  "Amount",
  "Q1",
  "North",
  "Q2",
  "Total",
  "Line",
  "Note",
  "Paper &amp; ink",
];

function workbookBytes() {
  const revenue = sheetXml([
    [
      { r: "A1", shared: 0 },
      { r: "B1", shared: 1 },
      { r: "C1", shared: 2 },
    ],
    [
      { r: "A2", shared: 3 },
      { r: "B2", shared: 4 },
      { r: "C2", value: "1250.00" },
    ],
    // B3 is absent entirely: an empty cell stays empty and shifts nothing.
    [
      { r: "A3", shared: 5 },
      { r: "C3", value: "980.50" },
    ],
    [
      { r: "A4", shared: 6 },
      { r: "C4", value: "2230.50", formula: "SUM(C2:C3)" },
    ],
  ]);
  const notes = sheetXml([
    [
      { r: "A1", shared: 7 },
      { r: "B1", shared: 8 },
    ],
    [
      { r: "A2", value: "1" },
      { r: "B2", shared: 9 },
    ],
  ]);
  return zip([
    [
      "xl/workbook.xml",
      `<?xml version="1.0"?><workbook><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
    ],
    [
      "xl/sharedStrings.xml",
      `<?xml version="1.0"?><sst>${SHARED.map((value) => `<si><t>${value}</t></si>`).join("")}</sst>`,
    ],
    ["xl/worksheets/sheet1.xml", revenue],
    ["xl/worksheets/sheet2.xml", notes],
  ]);
}

const REVENUE_PAGE = [
  "Revenue",
  "Quarter\tRegion\tAmount",
  "Q1\tNorth\t1250.00",
  "Q2\t\t980.50",
  "Total\t\t2230.50",
].join("\n");

const NOTES_PAGE = ["Notes", "Line\tNote", "1\tPaper & ink"].join("\n");

test("a workbook extracts to one page per sheet, with exact text", () => {
  const workbook = readWorkbook(workbookBytes());

  assert.equal(workbook.pages.length, 2);
  assert.deepEqual(
    workbook.pages.map((page) => [page.ordinal, page.sheetName]),
    [
      [0, "Revenue"],
      [1, "Notes"],
    ],
  );

  const [revenue, notes] = workbook.pages;
  assert.equal(revenue.text, REVENUE_PAGE);
  assert.equal(notes.text, NOTES_PAGE);
  assert.equal(revenue.rowCount, 4);
  assert.equal(revenue.columnCount, 3);
  assert.deepEqual(revenue.headers, ["Quarter", "Region", "Amount"]);
  assert.deepEqual(notes.headers, ["Line", "Note"]);

  // The formula's page text is its cached value; the formula is kept beside
  // the page, cited by nothing.
  assert.deepEqual(revenue.formulas, [
    { row: 3, column: 2, formula: "SUM(C2:C3)" },
  ]);
  assert.ok(!revenue.text.includes("SUM("));
});

test("the rendering is deterministic over the same bytes", () => {
  const bytes = workbookBytes();
  assert.deepEqual(readWorkbook(bytes), readWorkbook(workbookBytes()));
  assert.deepEqual(readWorkbook(bytes), readWorkbook(bytes));
});

test("a cell locator resolves to the exact slice of its page", () => {
  const [revenue, notes] = readWorkbook(workbookBytes()).pages;

  const total = resolveSheetCell(revenue.text, {
    sheet: "Revenue",
    row: 3,
    column: 2,
  });
  assert.ok(total);
  assert.equal(revenue.text.slice(total.start, total.end), "2230.50");

  const header = resolveSheetCell(revenue.text, {
    sheet: "Revenue",
    row: 0,
    column: 0,
  });
  assert.equal(revenue.text.slice(header.start, header.end), "Quarter");

  // The decoded entity is one cell, not two, and its slice is exact.
  const note = resolveSheetCell(notes.text, {
    sheet: "Notes",
    row: 1,
    column: 1,
  });
  assert.equal(notes.text.slice(note.start, note.end), "Paper & ink");
});

test("an out-of-range or empty cell resolves to nothing", () => {
  const [revenue] = readWorkbook(workbookBytes()).pages;
  const page = revenue.text;
  assert.equal(
    resolveSheetCell(page, { sheet: "Revenue", row: 9, column: 0 }),
    null,
  );
  assert.equal(
    resolveSheetCell(page, { sheet: "Revenue", row: 0, column: 9 }),
    null,
  );
  assert.equal(
    resolveSheetCell(page, { sheet: "Notes", row: 0, column: 0 }),
    null,
  );
  assert.equal(
    resolveSheetCell(page, { sheet: "Revenue", row: -1, column: 0 }),
    null,
  );
  // The empty B3 cell: a zero-length range proves nothing, so it is not one.
  assert.equal(
    resolveSheetCell(page, { sheet: "Revenue", row: 2, column: 1 }),
    null,
  );
});

test("a password-protected workbook is reported as encrypted", () => {
  const ole = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0]).copy(ole, 0);
  assert.throws(
    () => readWorkbook(ole),
    (error) => {
      assert.ok(error instanceof SpreadsheetError);
      assert.equal(error.code, "encrypted");
      return true;
    },
  );
});

test("a zip that is not a workbook is refused", () => {
  const bytes = zip([["mimetype", "application/epub+zip"]]);
  assert.throws(
    () => readWorkbook(bytes),
    (error) => {
      assert.equal(error.code, "not_a_workbook");
      return true;
    },
  );
  assert.throws(
    () => readWorkbook(Buffer.from("not a zip at all")),
    (error) => {
      assert.equal(error.code, "not_a_workbook");
      return true;
    },
  );
});

// --- the measured `spreadsheet_v1` bounds ---------------------------------

/**
 * P2-70i2: acceptance at each declared bound and refusal past it, with the
 * named failure code. Every workbook below is generated at a size the bound
 * names, so the test fails if a bound moves without the measurement being
 * redone.
 */

const COLUMN_NAME = (index) => {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
};

function gridSheetXml(rows, columns, cellValue) {
  let xml = '<?xml version="1.0"?><worksheet><sheetData>';
  for (let row = 0; row < rows; row += 1) {
    xml += `<row r="${row + 1}">`;
    for (let column = 0; column < columns; column += 1) {
      xml += `<c r="${COLUMN_NAME(column)}${row + 1}"><v>${cellValue(row, column)}</v></c>`;
    }
    xml += "</row>";
  }
  return `${xml}</sheetData></worksheet>`;
}

/** `sheetParts` is a list of `{ name, xml }`; `extraParts` are raw ZIP parts. */
function workbookOf(sheetParts, extraParts = []) {
  return zip([
    [
      "xl/workbook.xml",
      `<?xml version="1.0"?><workbook><sheets>${sheetParts
        .map(
          (sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
        )
        .join("")}</sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0"?><Relationships>${sheetParts
        .map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    ],
    ...sheetParts.map((sheet, index) => [
      `xl/worksheets/sheet${index + 1}.xml`,
      sheet.xml,
    ]),
    ...extraParts,
  ]);
}

/** The failure code, or "accepted" when the reader read the workbook. */
function refusal(bytes) {
  try {
    readWorkbook(bytes);
  } catch (error) {
    assert.ok(error instanceof SpreadsheetError);
    return error.code;
  }
  return "accepted";
}

/**
 * Every cell is exactly 12 characters, so a rendered row is
 * `columns * 12 + (columns - 1)` characters and the page is the sheet name plus
 * one newline and one row per row. That is what makes "at the bound" exact.
 */
const CELL_CHARS = 12;
const ROW_CHARS = (columns) => columns * CELL_CHARS + (columns - 1);
const paddedCell = (row, column) =>
  String(row * 64 + column).padStart(CELL_CHARS, "0");
const pageChars = (name, rows, columns) =>
  name.length + rows * (ROW_CHARS(columns) + 1);

function gridSheets(count, rows, columns) {
  return Array.from({ length: count }, (_, index) => ({
    name: `S${index}`,
    xml: gridSheetXml(rows, columns, paddedCell),
  }));
}

test("the sheet count bound accepts 64 sheets and refuses 65", () => {
  const { maxSheets } = SPREADSHEET_V1_BOUNDS;
  const accepted = readWorkbook(workbookOf(gridSheets(maxSheets, 4, 4)));
  assert.equal(accepted.pages.length, maxSheets);
  assert.equal(accepted.pages.at(-1).ordinal, maxSheets - 1);
  assert.equal(
    refusal(workbookOf(gridSheets(maxSheets + 1, 4, 4))),
    "oversized",
  );
});

test("one sheet's page is accepted at its character bound and refused past it", () => {
  const { maxSheetPageChars } = SPREADSHEET_V1_BOUNDS;
  const build = (rows) => workbookOf(gridSheets(1, rows, 8));
  const rows = Math.floor((maxSheetPageChars - 2) / (ROW_CHARS(8) + 1));
  const atBound = readWorkbook(build(rows));
  assert.equal(atBound.pages[0].text.length, pageChars("S0", rows, 8));
  assert.ok(atBound.pages[0].text.length <= maxSheetPageChars);
  assert.ok(
    atBound.pages[0].text.length > maxSheetPageChars - (ROW_CHARS(8) + 1),
    "the accepted page is at the bound, not comfortably below it",
  );
  assert.equal(refusal(build(rows + 1)), "oversized");
});

test("a row or column index past its bound is refused", () => {
  const { maxRowsPerSheet, maxColumnsPerSheet } = SPREADSHEET_V1_BOUNDS;
  const oneCell = (reference) =>
    workbookOf([
      {
        name: "S",
        xml: `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="${reference}"><v>1</v></c></row></sheetData></worksheet>`,
      },
    ]);
  assert.equal(refusal(oneCell(`A${maxRowsPerSheet + 1}`)), "oversized");
  assert.equal(
    refusal(oneCell(`${COLUMN_NAME(maxColumnsPerSheet)}1`)),
    "oversized",
  );
  // The last addressable column is still read. There is no matching case for
  // the last addressable row: a sheet with 65,536 rendered rows is past the
  // page character bound whatever its cells hold, so the row index bound only
  // ever refuses a corrupt reference, which is what it is there for.
  assert.equal(
    readWorkbook(oneCell(`${COLUMN_NAME(maxColumnsPerSheet - 1)}1`)).pages[0]
      .columnCount,
    maxColumnsPerSheet,
  );
});

test("the total rendered text bound refuses what no text version could hold", () => {
  const { maxRenderedBytes, maxSheetPageChars } = SPREADSHEET_V1_BOUNDS;
  // Each sheet renders about 10.4 KiB, so 64 of them stay under the bound.
  // Raising every sheet to 80 rows takes the workbook past it even though no
  // single sheet is anywhere near its own page bound.
  const totalChars = (rows) =>
    gridSheets(64, rows, 16).reduce(
      (total, sheet) => total + pageChars(sheet.name, rows, 16),
      0,
    );
  const under = readWorkbook(workbookOf(gridSheets(64, 50, 16)));
  const rendered = under.pages.reduce(
    (total, page) => total + Buffer.byteLength(page.text, "utf8"),
    0,
  );
  assert.equal(rendered, totalChars(50));
  assert.ok(rendered < maxRenderedBytes);
  assert.ok(rendered > maxRenderedBytes / 2);
  for (const page of under.pages) {
    assert.ok(
      page.text.length < maxSheetPageChars / 4,
      "no single sheet is near its own page bound",
    );
  }
  assert.ok(totalChars(80) > maxRenderedBytes);
  assert.equal(refusal(workbookOf(gridSheets(64, 80, 16))), "oversized");
});

test("a workbook past the class's byte bound is refused before it is read", () => {
  // Incompressible bytes take the ZIP past 8 MiB while every sheet stays tiny,
  // so only the workbook's own size can refuse it.
  const bytes = workbookOf(gridSheets(1, 2, 2), [
    [
      "xl/media/image1.bin",
      randomBytes(SPREADSHEET_V1_BOUNDS.maxWorkbookBytes + 64 * 1_024),
    ],
  ]);
  assert.ok(bytes.length > SPREADSHEET_V1_BOUNDS.maxWorkbookBytes);
  assert.equal(refusal(bytes), "oversized");
});

test("an XML part that inflates past the per-part cap is refused, not grown", () => {
  const bytes = workbookOf([{ name: "S", xml: " ".repeat(9 * 1_024 * 1_024) }]);
  assert.ok(bytes.length < SPREADSHEET_V1_BOUNDS.maxWorkbookBytes);
  assert.equal(refusal(bytes), "oversized");
});

test("a .docx is a ZIP and stays unsupported rather than being misread", () => {
  const bytes = zip([
    ["[Content_Types].xml", `<?xml version="1.0"?><Types/>`],
    ["word/document.xml", `<?xml version="1.0"?><document/>`],
  ]);
  assert.equal(refusal(bytes), "not_a_workbook");
});

// --- the parsed mapping a workbook's pages become -------------------------

test("a workbook maps to one retained page per sheet with page evidence", async () => {
  const workbook = readWorkbook(workbookBytes());
  const mapping = await mapSpreadsheetWorkbook({
    pages: workbook.pages,
    title: "quarterly.xlsx",
    capturedAt: 1_700_000_000_000,
    chunkingFingerprint: SPREADSHEET_CHUNKING_FINGERPRINT,
  });

  assert.deepEqual(
    mapping.pages.map((page) => page.text),
    [REVENUE_PAGE, NOTES_PAGE],
  );
  // Pages concatenate in workbook order and every offset is into that text.
  assert.equal(mapping.pages[0].start, 0);
  assert.equal(mapping.pages[1].start, REVENUE_PAGE.length);
  assert.equal(
    mapping.textUtf16Length,
    REVENUE_PAGE.length + NOTES_PAGE.length,
  );
  assert.equal(mapping.documents.length, 1);
  assert.equal(mapping.documents[0].docType, "spreadsheet");
  // One evidence span per chunk, each a `parser_page_v1` locator over its page.
  assert.equal(mapping.evidence.length, mapping.chunks.length);
  for (const span of mapping.evidence) {
    assert.equal(span.locator.kind, "parser_page_v1");
    assert.equal(
      span.locator.pageTextHash,
      mapping.pages[span.pageOrdinal].textHash,
    );
  }
  assert.match(mapping.mappingManifestHash, /^[0-9a-f]{64}$/u);

  // A cited cell resolves into the mapped page, and the mapped page is the
  // text a generation seals: scan -> parse -> retained page -> cell evidence.
  const total = resolveSheetCell(mapping.pages[0].text, {
    sheet: "Revenue",
    row: 3,
    column: 2,
  });
  assert.ok(total);
  assert.equal(mapping.pages[0].text.slice(total.start, total.end), "2230.50");
});

test("the spreadsheet mapping refuses another class's chunking policy", async () => {
  await assert.rejects(() =>
    mapSpreadsheetWorkbook({
      pages: readWorkbook(workbookBytes()).pages,
      title: "quarterly.xlsx",
      capturedAt: 1_700_000_000_000,
      chunkingFingerprint: "0".repeat(64),
    }),
  );
});
