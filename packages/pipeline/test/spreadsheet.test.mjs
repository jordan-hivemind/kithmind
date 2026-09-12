import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import { readWorkbook, SpreadsheetError } from "../dist/spreadsheet.js";
import { resolveSheetCell } from "@repo/worker-protocol";

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
