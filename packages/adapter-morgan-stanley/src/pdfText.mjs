// Bytes -> text for the PDF tier.
//
// Real Morgan Stanley statements put their content in compressed streams
// (`/Filter /FlateDecode`) with embedded fonts, so the dependency-free `Tj`
// scan below reads nothing from them: every live document landed with
// `parsed_ok` false and a `document_unparsed` review item (F1-43). This
// module adds a real extractor in front of that scan.
//
// pdfjs-dist is the dependency, pinned exact, legacy build: pure JavaScript,
// no native addon and no Python, and it runs under plain Node with no
// browser or DOM. It is also the only one of the candidates that reports a
// per-item transform, which is what makes the *layout* reconstruction below
// possible -- and layout is not a nicety here. A statement page carries two
// independent tables side by side (BALANCE SHEET on the left, CASH FLOW on
// the right, see README "Statement layout"), so text that keeps only reading
// order silently interleaves one table's numbers with the other's. Column
// position is the only thing that tells them apart.
//
// The output is therefore fixed-pitch: one line per visual line, each datum
// placed at the character column its x coordinate falls in, pages separated
// by a form feed. That is the same shape `pdftotext -layout` produces, which
// is the documented fallback if this dependency ever has to go (README).
// It is deterministic for the same bytes: nothing here reads a clock, a
// locale or a font from the host.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Points per character column in the reconstructed layout. Statements are
 * set in an 8pt face whose average advance is close to half its size; 4.5
 * puts a 612pt page on ~136 columns, which keeps adjacent columns apart
 * without splitting a single value across two of them. */
const POINTS_PER_COLUMN = 4.5;
/** Baselines within this many points are the same visual line. Sub/superscript
 * footnote marks sit further off than this and become their own line, which
 * is correct: they are not part of the row's values. */
const BASELINE_TOLERANCE = 0.5;
/** Separates pages in the extracted text, as `pdftotext` does. */
export const PAGE_SEPARATOR = "\f";

let pdfjsModule = null;

/** Loaded once, lazily: importing pdfjs costs real time and most parses in
 * the test suite never reach it. */
async function loadPdfjs() {
  if (pdfjsModule === null) {
    pdfjsModule = await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  }
  return pdfjsModule;
}

/** pdfjs ships the 14 standard font metrics as data files; without the path
 * it warns once per document and falls back to guessed metrics. */
function standardFontDataUrl() {
  return `${require.resolve("pdfjs-dist/package.json").replace(/package\.json$/, "")}standard_fonts/`;
}

/**
 * One page's items as visual lines, each line a fixed-pitch string.
 */
function renderPage(items) {
  const rows = new Map();
  for (const item of items) {
    if (typeof item.str !== "string" || item.str === "") continue;
    const x = item.transform[4];
    const y = item.transform[5];
    // Bucket by baseline. Rounding to the tolerance is what makes this
    // deterministic rather than dependent on which item was seen first.
    const key = Math.round(y / BASELINE_TOLERANCE) * BASELINE_TOLERANCE;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x, str: item.str });
  }
  const lines = [];
  // Top of the page first: PDF user space counts y upward.
  for (const [, cells] of [...rows.entries()].sort((a, b) => b[0] - a[0])) {
    cells.sort((a, b) => a.x - b.x || (a.str < b.str ? -1 : a.str > b.str ? 1 : 0));
    let line = "";
    for (const cell of cells) {
      const column = Math.max(
        line.length === 0 ? 0 : line.length + 1,
        Math.round(cell.x / POINTS_PER_COLUMN),
      );
      line = line.padEnd(column, " ") + cell.str;
    }
    const trimmed = line.trimEnd();
    if (trimmed.trim() !== "") lines.push(trimmed);
  }
  return lines;
}

/**
 * Real extraction. Returns null (rather than throwing) when the document
 * holds no text at all -- a scanned image, say -- so the caller can try the
 * dependency-free scan before giving up.
 */
export async function extractWithPdfjs(bytes) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    // pdfjs transfers (and so detaches) the buffer it is handed. The caller's
    // bytes are the retained archive object; handing them over would leave it
    // zero-length for every later reader, including the content hash check.
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      try {
        const content = await page.getTextContent();
        pages.push(renderPage(content.items).join("\n"));
      } finally {
        page.cleanup();
      }
    }
    const text = pages.join(`\n${PAGE_SEPARATOR}\n`);
    return text.trim() === "" ? null : text;
  } finally {
    await doc.destroy();
  }
}

/**
 * The original dependency-free reader, kept as the fallback: it reads literal
 * `(...) Tj` operators out of an uncompressed content stream, which is
 * exactly what fixtures/pdf.mjs generates. Returns null when it finds none.
 */
export function extractWithTjScan(bytes) {
  const latin1 = Buffer.from(bytes).toString("latin1");
  const lines = [];
  const tjPattern = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  let match;
  while ((match = tjPattern.exec(latin1)) !== null) {
    lines.push(match[1].replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\"));
  }
  return lines.length === 0 ? null : lines.join("\n");
}
