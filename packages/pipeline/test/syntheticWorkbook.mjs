/**
 * P2-70i / P2-70i3: the synthetic workbook every spreadsheet test reads.
 *
 * The workbook is generated here, from the OOXML parts a real spreadsheet
 * writes. No sample file enters the repository and nothing here describes a
 * real account, balance or person.
 */

import { crc32, deflateRawSync } from "node:zlib";

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

function workbookBytes(extraParts = []) {
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
    ...extraParts,
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

export { zip, sheetXml, workbookBytes, REVENUE_PAGE, NOTES_PAGE };
