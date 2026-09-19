// Citing a page by line number instead of by copied text.
//
// The live trial of the previous round is the whole argument for this file. A
// till receipt's money fields all failed, and every one of them failed on the
// citation rather than on the value: `quote_not_found` on subtotal, tax and
// total. Precision was intact and recall on amounts was close to zero.
//
// The cause is in how a parsed page reads. A receipt prints a label and an
// amount on one visual line, but the text that comes out puts runs of spaces
// between them, or -- when the amounts sit in a right-hand column -- emits the
// labels together and then the amounts together, so the page says
// "Subtotal Tax Total" and then "10.00 0.80 10.80". A model asked to copy a
// quote writes back what it sees, "Subtotal 10.00", which is not a substring
// of the page in any order. `locateCardQuote` folds whitespace, so the runs of
// spaces were never the problem; the *order* was, and folding cannot fix an
// order.
//
// There is a second failure underneath the first, and it is worse because it
// is silent. `locateUnique` (provenance/model.ts) requires the folded needle
// to appear exactly once. On a receipt "10.80" appears twice -- once in the
// column and once in "Total due $10.80" -- so even a quote the model copies
// perfectly can be refused for being ambiguous.
//
// So this round stops asking the model to reproduce text at all. Each page is
// presented as numbered lines, a statement cites `page` plus one to three line
// ids, and the server builds the quote from its own text. A citation is then
// either in range or it is not; `quote_not_found` cannot happen for a valid
// one, and the value-in-quote gates run unchanged against text the server
// itself produced.
//
// The old `quote` shape still reads, because the non-schema fallback path has
// no way to require the new one.

/** One line of a page, with the offsets its text occupies in that page. */
export type PageLine = {
  /** 1-based, because it is shown to a model and counting from one is what a
   * reader of a numbered list expects. */
  id: number;
  start: number;
  end: number;
  text: string;
};

/** How many lines one citation may cover between its lowest and highest id.
 * Three ids are allowed; a label and its amount two lines apart is ordinary,
 * a citation spanning half a page is not a citation. */
export const MAX_CITATION_SPAN = 4;

/** Lines shown per page. A page past this is presented truncated, and the ids
 * still address the page's real lines -- so a citation into the unshown tail
 * resolves correctly if the model somehow makes one. The document is marked
 * partially read either way; see `linesTruncated` in `./model.ts`. */
export const MAX_PAGE_LINES = 400;

/**
 * Splits a page into its lines, keeping each one's offsets.
 *
 * `\n` only: `source_pages.text` is retained text the parser produced and the
 * store hashes it byte for byte, so splitting on anything else would make a
 * span's offsets disagree with the column they index into.
 */
export function pageLines(text: string): PageLine[] {
  const lines: PageLine[] = [];
  let start = 0;
  let id = 1;
  for (;;) {
    const brk = text.indexOf("\n", start);
    const end = brk < 0 ? text.length : brk;
    lines.push({ id, start, end, text: text.slice(start, end) });
    if (brk < 0) break;
    start = brk + 1;
    id += 1;
  }
  return lines;
}

/** How the page is shown to the model: one line per line, its id in front. */
export function numberedPage(lines: readonly PageLine[]): string {
  return lines
    .slice(0, MAX_PAGE_LINES)
    .map((line) => `${line.id}| ${line.text}`)
    .join("\n");
}

export type CitationRange = { start: number; end: number };

/**
 * The offsets one citation covers, or null when it cites nothing real.
 *
 * The range runs from the first character of the lowest cited line to the last
 * of the highest, so two ids that are not adjacent take the line between them
 * with them. That is deliberate: an evidence span is one contiguous range of
 * the sealed text, and a citation that skipped a line would either need two
 * spans or a quote that does not appear on the page -- which is the thing this
 * whole file exists to stop.
 */
export function citationRange(
  lines: readonly PageLine[],
  ids: readonly number[],
): CitationRange | null {
  if (ids.length === 0 || ids.length > 3) return null;
  const unique = new Set<number>();
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 1 || id > lines.length) return null;
    unique.add(id);
    if (id < lowest) lowest = id;
    if (id > highest) highest = id;
  }
  if (highest - lowest + 1 > MAX_CITATION_SPAN) return null;
  // Contiguous, or it is not a citation.
  //
  // The range covers everything between the lowest and highest id, so lines
  // [2, 5] would hand the value gates lines 3 and 4 as well -- and a receipt's
  // line 3 holds a different item's amount, which is enough to satisfy a check
  // the cited lines do not. Requiring the ids to be adjacent makes the quote
  // exactly what was cited. A model that means two separate places says so in
  // two statements.
  if (highest - lowest + 1 !== unique.size) return null;
  const first = lines[lowest - 1]!;
  const last = lines[highest - 1]!;
  if (last.end <= first.start) return null;
  return { start: first.start, end: last.end };
}
