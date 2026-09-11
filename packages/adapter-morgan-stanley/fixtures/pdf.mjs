// A minimal, dependency-free PDF writer for test fixtures only: pages of
// Helvetica text, one `(...) Tj` per line, with the content stream either
// left uncompressed or deflated. Exists so src/pdfText.mjs has real (if tiny)
// PDFs to run against: the uncompressed ones are what the dependency-free
// `Tj` fallback reads, and the deflated ones are what only pdfjs-dist can
// read -- which is exactly the difference the live statements exposed.
// ponytail: produces what this test suite needs, not a general-purpose PDF
// writer.

import { deflateSync } from "node:zlib";

function escapePdfString(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const FONT_SIZE = 8;
const LEADING = 12;
const MARGIN = 50;
/** Points per character column. Matches src/pdfText.mjs's own figure, so a
 * line written at character column N comes back at character column N. */
const POINTS_PER_COLUMN = 4.5;

/**
 * One line -> its content operators. Each run of non-space characters is
 * placed at its own x, the way a real statement's generator places a cell,
 * rather than padded with space glyphs: a proportional font makes a
 * space-padded line look aligned by character count and ragged by geometry,
 * and geometry is what any reader (this one included) sees.
 */
function lineOperators(line, y) {
  const operators = [];
  for (const match of line.matchAll(/\S+(?: \S+)*?(?=\s{2,}|$)/g)) {
    const x = MARGIN + match.index * POINTS_PER_COLUMN;
    operators.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfString(match[0])}) Tj`);
  }
  return operators;
}

/**
 * `pages` is an array of pages, each an array of lines; a plain array of
 * lines is taken as a single page. A line is written at the character columns
 * it occupies, so a fixture reproduces the fixed-pitch column layout of a
 * real statement and reads back at the same columns.
 *
 * `compress` deflates each content stream, the way a real statement does.
 *
 * The page is sized to its content rather than fixed at US Letter: a PDF
 * reader clips glyphs that fall outside the MediaBox, so a fixture with a
 * line wider than the page would lose its tail and the test would assert
 * against text no reader can see.
 */
export function buildMinimalPdf(pages, { compress = false } = {}) {
  const sheets = Array.isArray(pages[0]) ? pages : [pages];
  const longest = sheets.flat().reduce((max, line) => Math.max(max, line.length), 0);
  const tallest = sheets.reduce((max, lines) => Math.max(max, lines.length), 0);
  const width = Math.ceil(MARGIN * 2 + (longest + 2) * POINTS_PER_COLUMN);
  const height = Math.ceil(MARGIN * 2 + (tallest + 1) * LEADING);

  const objects = [];
  /** 1: catalog, 2: pages, 3: font, then a page and a stream per sheet. */
  const firstPageObject = 4;
  const pageIds = sheets.map((_, i) => firstPageObject + i * 2);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${sheets.length} >>`,
  );
  // WinAnsiEncoding, not the default: under a Type 1 font's StandardEncoding
  // byte 0x27 is the right single quote, so an apostrophe written here would
  // read back as U+2019 and the fixture would not be the text it declares.
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  const streams = [];
  sheets.forEach((lines, i) => {
    const pageId = pageIds[i];
    objects.push(
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> ` +
        `/MediaBox [0 0 ${width} ${height}] /Contents ${pageId + 1} 0 R >>`,
    );
    const content =
      `BT /F1 ${FONT_SIZE} Tf\n` +
      lines
        .flatMap((line, row) => lineOperators(line, height - MARGIN - row * LEADING))
        .join("\n") +
      "\nET";
    const raw = Buffer.from(content, "latin1");
    const body = compress ? deflateSync(raw) : raw;
    objects.push(null); // placeholder, filled from `streams` below
    streams.push({ index: objects.length - 1, body, compress });
  });

  // Objects are written as latin1 text except the stream bodies, which are
  // binary when deflated; assemble as buffers so no byte is reinterpreted.
  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((bodyText, i) => {
    offsets.push(length);
    const stream = streams.find((s) => s.index === i);
    let objectChunks;
    if (stream === undefined) {
      objectChunks = [Buffer.from(`${i + 1} 0 obj\n${bodyText}\nendobj\n`, "latin1")];
    } else {
      const filter = stream.compress ? " /Filter /FlateDecode" : "";
      objectChunks = [
        Buffer.from(`${i + 1} 0 obj\n<< /Length ${stream.body.length}${filter} >>\nstream\n`, "latin1"),
        stream.body,
        Buffer.from("\nendstream\nendobj\n", "latin1"),
      ];
    }
    for (const chunk of objectChunks) {
      chunks.push(chunk);
      length += chunk.length;
    }
  });
  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}
