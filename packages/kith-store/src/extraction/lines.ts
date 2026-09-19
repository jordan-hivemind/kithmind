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

/** How many lines one citation may name. A label, its amount and one more is
 * as much as a single value ever needs; beyond that it is a region, not a
 * citation. */
export const MAX_CITED_LINES = 3;

/**
 * How long a citable unit may be before it is split.
 *
 * The live page statistics are lopsided: a receipt's median line is 7
 * characters and its longest is over 300, and some pages carry a single line
 * of about 2,000. A 2,000-character line is a poor citation -- it holds dozens
 * of numbers, so "the value appears in the cited text" stops meaning much, and
 * every one of those numbers would satisfy a check meant for one of them.
 *
 * So a long line becomes several citable sub-lines, cut at whitespace. The
 * offsets stay exact and adjacent pieces stay contiguous, so a span is still a
 * real range of the sealed text and citing two pieces gives exactly their
 * union.
 */
export const MAX_LINE_CHARS = 240;

/** How far back from the bound to look for a space before giving up and
 * cutting mid-word. A line with no whitespace at all is a barcode or a hash,
 * and cutting it anywhere is as good as anywhere. */
const SPLIT_LOOKBACK = 80;

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
    for (const piece of splitLongLine(text, start, end)) {
      lines.push({ id, ...piece, text: text.slice(piece.start, piece.end) });
      id += 1;
    }
    if (brk < 0) break;
    start = brk + 1;
  }
  return lines;
}

/** One physical line as one or more citable pieces, cut at whitespace when it
 * is longer than {@link MAX_LINE_CHARS}. Pieces are contiguous and cover the
 * line exactly, so nothing is lost and no offset moves. */
function splitLongLine(
  text: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  if (end - start <= MAX_LINE_CHARS) return [{ start, end }];
  const pieces: Array<{ start: number; end: number }> = [];
  let at = start;
  while (end - at > MAX_LINE_CHARS) {
    const bound = at + MAX_LINE_CHARS;
    let cut = -1;
    for (let probe = bound; probe > bound - SPLIT_LOOKBACK && probe > at; probe -= 1) {
      if (/\s/.test(text[probe - 1]!)) {
        cut = probe;
        break;
      }
    }
    if (cut <= at) cut = bound;
    pieces.push({ start: at, end: cut });
    at = cut;
  }
  if (at < end) pieces.push({ start: at, end });
  return pieces;
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
 * The lines one citation names, in id order, or null when it names something
 * the page does not have.
 *
 * **Not contiguous.** The first version of this required the ids to be
 * adjacent, because the quote was built as the range covering them and a
 * non-adjacent pair silently dragged in the lines between -- on a receipt,
 * another item's amount, which is enough to satisfy a check the citation did
 * not support. Requiring adjacency closed that hole and opened a bigger one:
 * a column receipt prints "Subtotal / Tax / Total" on lines 8 to 10 and their
 * amounts on 15 to 17, so the only honest citation of a total is two lines
 * seven apart. Every money field on the owner's receipt failed as
 * `citation_out_of_range`.
 *
 * The rule that keeps both: cite up to three lines wherever they are, and
 * check the value against **each cited line on its own**. A line between two
 * cited ones is never part of the text a value is checked against, so it can
 * never support anything; the reviewer's property holds without adjacency.
 * The caller owns that half -- see `candidatesFor` in `./gate.ts`.
 */
export function citedLines(
  lines: readonly PageLine[],
  ids: readonly number[],
): PageLine[] | null {
  if (ids.length === 0 || ids.length > 3) return null;
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 1 || id > lines.length) return null;
    seen.add(id);
  }
  return [...seen].sort((left, right) => left - right).map((id) => lines[id - 1]!);
}

/** Whether the ids run consecutively. Reported by the diagnostic, not enforced. */
export function areContiguous(ids: readonly number[]): boolean {
  const unique = [...new Set(ids)].sort((left, right) => left - right);
  if (unique.length === 0) return false;
  return unique[unique.length - 1]! - unique[0]! + 1 === unique.length;
}
