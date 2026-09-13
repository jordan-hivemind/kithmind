import { inflateRawSync } from "node:zlib";

import {
  renderSheetPage,
  sheetCellText,
  SHEET_PAGE_RENDERING_VERSION,
  SPREADSHEET_V1_BOUNDS,
} from "@repo/worker-protocol";

/**
 * P2-70i: spreadsheet text extraction for the document-cards plan, sections
 * 4.2 and 4.3 of docs/plans/2026-09-12-document-cards.md.
 *
 * An `.xlsx` workbook is a ZIP of XML parts, so this reads one with the two
 * things Node already ships: `zlib.inflateRawSync` and string handling. No
 * dependency is added to a package that has none, and no native binary is
 * introduced into the worker. The docling worker was considered first and
 * does not serve here: it is pinned to `InputFormat.PDF`, it runs a separate
 * Python process with hashed model assets, and its output is a layout
 * document rather than the exact tab-separated grid a cell locator has to
 * resolve into.
 *
 * `.xls` (the pre-2007 binary BIFF container) is deliberately not read. It is
 * not a ZIP, so nothing here applies to it, and decoding BIFF would be its
 * own body of work rather than a flag on this one.
 *
 * What this produces is one page per sheet under the shared
 * `SHEET_PAGE_RENDERING_VERSION` rule, plus the page-to-sheet map that says
 * which sheet each page ordinal is.
 */

export type SpreadsheetErrorCode =
  /** Not a ZIP, or a ZIP with no `xl/workbook.xml`. */
  | "not_a_workbook"
  /** An OLE compound file: a password-protected workbook. */
  | "encrypted"
  /** A shape this reader does not decode: ZIP64, an unknown compression. */
  | "unsupported"
  /**
   * Past a declared `spreadsheet_v1` bound: the workbook's own bytes, its
   * sheet count, a row or column index, one sheet's page characters, or the
   * total rendered text a parsed text version could hold.
   */
  | "oversized";

export class SpreadsheetError extends Error {
  constructor(readonly code: SpreadsheetErrorCode) {
    super(`Spreadsheet could not be read: ${code}`);
    this.name = "SpreadsheetError";
  }
}

function fail(code: SpreadsheetErrorCode): never {
  throw new SpreadsheetError(code);
}

/**
 * The `spreadsheet_v1` class's measured bounds, stated once in the protocol
 * both sides read. `MAX_SHEETS` equals the parsed text version's page ceiling
 * and `MAX_SHEET_PAGE_CHARS` the parsed-page validator's own text bound.
 */
export const {
  maxSheets: MAX_SHEETS,
  maxSheetPageChars: MAX_SHEET_PAGE_CHARS,
  maxWorkbookBytes: MAX_WORKBOOK_BYTES,
  maxRenderedBytes: MAX_RENDERED_BYTES,
  maxRowsPerSheet: MAX_SHEET_ROWS,
  maxColumnsPerSheet: MAX_SHEET_COLUMNS,
} = SPREADSHEET_V1_BOUNDS;

/** Per XML part, inflated. A workbook part past this is refused, not grown. */
const MAX_PART_BYTES = 8 * 1_024 * 1_024;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL = 0xffffffff;
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

type ZipEntry = { method: number; offset: number; compressedSize: number };

/**
 * Indexes a ZIP's central directory without inflating anything. Parts are
 * inflated on demand, so a workbook with a large unused part costs nothing.
 *
 * ponytail: no ZIP64 and no encrypted-entry support. The ceiling is a
 * workbook above 4 GiB or with more than 65,535 parts, which is refused as
 * `unsupported` rather than misread. Widen only if one is ever observed.
 */
function indexZip(bytes: Buffer): Map<string, ZipEntry> {
  if (bytes.subarray(0, 4).equals(OLE_SIGNATURE)) fail("encrypted");
  if (bytes.length < 22) fail("not_a_workbook");
  let eocd = -1;
  const floor = Math.max(0, bytes.length - (0xffff + 22));
  for (let index = bytes.length - 22; index >= floor; index -= 1) {
    if (bytes.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) fail("not_a_workbook");
  const count = bytes.readUInt16LE(eocd + 10);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (directoryOffset === ZIP64_SENTINEL || count === 0xffff) {
    fail("unsupported");
  }
  const entries = new Map<string, ZipEntry>();
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (
      cursor + 46 > bytes.length ||
      bytes.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE
    ) {
      fail("not_a_workbook");
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (compressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      fail("unsupported");
    }
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    entries.set(name, { method, offset: localOffset, compressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readPart(
  bytes: Buffer,
  entries: Map<string, ZipEntry>,
  name: string,
): string | undefined {
  const entry = entries.get(name);
  if (!entry) return undefined;
  const header = entry.offset;
  if (
    header + 30 > bytes.length ||
    bytes.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE
  ) {
    fail("not_a_workbook");
  }
  const start =
    header +
    30 +
    bytes.readUInt16LE(header + 26) +
    bytes.readUInt16LE(header + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) fail("not_a_workbook");
  const payload = bytes.subarray(start, end);
  if (entry.method === 0) {
    if (payload.length > MAX_PART_BYTES) fail("oversized");
    return payload.toString("utf8");
  }
  if (entry.method !== 8) fail("unsupported");
  try {
    return inflateRawSync(payload, {
      maxOutputLength: MAX_PART_BYTES,
    }).toString("utf8");
  } catch {
    fail("oversized");
  }
}

// --- the smallest XML reading that these parts need -----------------------

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/gu,
    (match, ref) => {
      const name = ref as string;
      if (name.startsWith("#x") || name.startsWith("#X")) {
        const code = Number.parseInt(name.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (name.startsWith("#")) {
        const code = Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return XML_ENTITIES[name] ?? match;
    },
  );
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "u").exec(tag);
  return match ? decodeXml(match[1]!) : undefined;
}

/** Every `<name ...>…</name>` and `<name ... />` element, in document order. */
function elements(xml: string, name: string): string[] {
  const pattern = new RegExp(
    `<${name}\\b[^>]*/>|<${name}\\b[^>]*>[\\s\\S]*?</${name}>`,
    "gu",
  );
  return xml.match(pattern) ?? [];
}

function innerText(element: string, name: string): string {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*)</${name}>$`, "u").exec(
    element,
  );
  return match ? decodeXml(match[1]!) : "";
}

/** The concatenated `<t>` runs of one rich-text element. */
function runs(element: string): string {
  let text = "";
  for (const run of elements(element, "t")) {
    if (run.endsWith("/>")) continue;
    text += innerText(run, "t");
  }
  return text;
}

// --- the workbook ---------------------------------------------------------

export type SheetFormula = { row: number; column: number; formula: string };

export type SpreadsheetPage = {
  /** The page ordinal this sheet becomes. Zero-based, workbook order. */
  ordinal: number;
  sheetName: string;
  rowCount: number;
  columnCount: number;
  /** Row 0 rendered cell by cell. Empty when the sheet has no rows. */
  headers: string[];
  /** The retained page text, under `SHEET_PAGE_RENDERING_VERSION`. */
  text: string;
  /**
   * The side channel of section 4.2: a formula cell's page text is its cached
   * value, because that is the figure a card cites and the only one the file
   * actually states. The formula itself is kept here, cited by nothing.
   */
  formulas: SheetFormula[];
};

export type Workbook = {
  renderingVersion: typeof SHEET_PAGE_RENDERING_VERSION;
  /** The page-to-sheet map: index is the page ordinal, in workbook order. */
  pages: SpreadsheetPage[];
};

export const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function columnIndex(reference: string): number {
  const match = /^([A-Z]+)([0-9]+)$/u.exec(reference);
  if (!match) fail("not_a_workbook");
  let column = 0;
  for (const character of match[1]!) {
    column = column * 26 + (character.charCodeAt(0) - 64);
  }
  return column - 1;
}

function rowIndex(reference: string): number {
  const match = /^([A-Z]+)([0-9]+)$/u.exec(reference);
  if (!match) fail("not_a_workbook");
  return Number.parseInt(match[2]!, 10) - 1;
}

/**
 * The rendered text of one cell. A cached value is taken exactly as the file
 * stores it: no number formatting, no locale, no date reconstruction.
 *
 * ponytail: a date-formatted cell therefore renders as its serial number,
 * because the serial is what the file states and a reconstruction would be a
 * guess about the workbook's 1900/1904 epoch and the cell's format. Upgrade
 * to reading `cellXfs` number formats only if a card field needs a date out
 * of a spreadsheet.
 */
function cellText(cell: string, shared: readonly string[]): string {
  const type = attribute(cell, "t") ?? "n";
  if (type === "inlineStr") {
    const is = elements(cell, "is")[0];
    return is ? runs(is) : "";
  }
  const value = elements(cell, "v")[0];
  const raw = value && !value.endsWith("/>") ? innerText(value, "v") : "";
  if (type === "s") {
    const index = Number.parseInt(raw, 10);
    return shared[index] ?? "";
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
}

function sheetTargets(
  workbook: string,
  rels: string,
): Array<{
  name: string;
  part: string;
}> {
  const targets = new Map<string, string>();
  for (const relationship of elements(rels, "Relationship")) {
    const id = attribute(relationship, "Id");
    const target = attribute(relationship, "Target");
    if (id && target) targets.set(id, target);
  }
  const sheets: Array<{ name: string; part: string }> = [];
  for (const sheet of elements(workbook, "sheet")) {
    const name = attribute(sheet, "name");
    const id = attribute(sheet, "r:id") ?? attribute(sheet, "id");
    if (name === undefined || id === undefined) fail("not_a_workbook");
    const target = targets.get(id);
    if (target === undefined) fail("not_a_workbook");
    const relative = target.replace(/^\/xl\//u, "").replace(/^\.\//u, "");
    sheets.push({
      name,
      part: target.startsWith("/") ? target.slice(1) : `xl/${relative}`,
    });
  }
  return sheets;
}

/**
 * Reads an `.xlsx` workbook into one retained page per sheet.
 *
 * The rendering is deterministic: the same bytes always produce the same page
 * text, cell for cell, because nothing here depends on a locale, a clock, a
 * style, or the order a map was built in.
 */
export function readWorkbook(bytes: Buffer): Workbook {
  if (bytes.length > MAX_WORKBOOK_BYTES) fail("oversized");
  const entries = indexZip(bytes);
  const workbookXml = readPart(bytes, entries, "xl/workbook.xml");
  const relsXml = readPart(bytes, entries, "xl/_rels/workbook.xml.rels");
  if (workbookXml === undefined || relsXml === undefined) {
    fail("not_a_workbook");
  }
  const sharedXml = readPart(bytes, entries, "xl/sharedStrings.xml");
  const shared = sharedXml
    ? elements(sharedXml, "si").map((si) => runs(si))
    : [];

  const sheets = sheetTargets(workbookXml, relsXml);
  if (sheets.length === 0) fail("not_a_workbook");
  if (sheets.length > MAX_SHEETS) fail("oversized");

  const pages: SpreadsheetPage[] = [];
  let renderedBytes = 0;
  for (const [ordinal, sheet] of sheets.entries()) {
    const sheetXml = readPart(bytes, entries, sheet.part);
    if (sheetXml === undefined) fail("not_a_workbook");
    const rows: string[][] = [];
    const formulas: SheetFormula[] = [];
    let columnCount = 0;
    for (const cell of elements(sheetXml, "c")) {
      const reference = attribute(cell, "r");
      if (reference === undefined) fail("not_a_workbook");
      const row = rowIndex(reference);
      const column = columnIndex(reference);
      if (row >= MAX_SHEET_ROWS || column >= MAX_SHEET_COLUMNS) {
        fail("oversized");
      }
      const text = sheetCellText(cellText(cell, shared));
      const formula = elements(cell, "f")[0];
      if (formula && !formula.endsWith("/>")) {
        formulas.push({ row, column, formula: innerText(formula, "f") });
      }
      if (text.length === 0) continue;
      while (rows.length <= row) rows.push([]);
      const target = rows[row]!;
      while (target.length <= column) target.push("");
      target[column] = text;
      if (column + 1 > columnCount) columnCount = column + 1;
    }
    const text = renderSheetPage({ name: sheet.name, rows, columnCount });
    if (text.length > MAX_SHEET_PAGE_CHARS) fail("oversized");
    // A workbook whose sheets each fit but whose total does not cannot be
    // sealed as one parsed text version, so it is refused here rather than
    // rendered and then rejected by the seal.
    renderedBytes += Buffer.byteLength(text, "utf8");
    if (renderedBytes > MAX_RENDERED_BYTES) fail("oversized");
    pages.push({
      ordinal,
      sheetName: sheetCellText(sheet.name),
      rowCount: rows.length,
      columnCount,
      headers: (rows[0] ?? []).slice(0, columnCount).map((cell) => cell ?? ""),
      text,
      formulas,
    });
  }
  return { renderingVersion: SHEET_PAGE_RENDERING_VERSION, pages };
}
