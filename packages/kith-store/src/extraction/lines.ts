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

import { SUPPORTED_CURRENCIES } from "../records/values.js";

/** One line of a page, with the offsets its text occupies in that page. */
export type PageLine = {
  /** 1-based, because it is shown to a model and counting from one is what a
   * reader of a numbered list expects. */
  id: number;
  start: number;
  end: number;
  text: string;
  /** True when this piece's left edge is a cut {@link splitLongLine} made
   * inside a longer line, rather than a newline or the start of the page.
   * The amount finder treats a cut edge as *unknown*: whatever stood beyond
   * it -- a magnitude letter, a `CR`, an open parenthesis, the rest of a
   * number -- is no longer visible, so an amount touching it is refused. */
  cutStart: boolean;
  /** The same for the right edge. */
  cutEnd: boolean;
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
    const pieces = splitLongLine(text, start, end);
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index]!;
      lines.push({
        id,
        ...piece,
        text: text.slice(piece.start, piece.end),
        cutStart: index > 0,
        cutEnd: index < pieces.length - 1,
      });
      id += 1;
    }
    if (brk < 0) break;
    start = brk + 1;
  }
  return lines;
}

/** How far past the bound a piece may run rather than cut a token in half.
 * A cut inside a number is not a smaller piece, it is a different number. */
const MAX_LINE_OVERFLOW = 64;

/** The characters a number or a date is made of. A cut with one of these on
 * both sides is a cut through the middle of a value. */
const TOKEN_CHAR = /[0-9.,:/'-]/;

/** Whitespace, and the zero-width characters that are not whitespace and are
 * not a boundary either. The amount grammar removes them outright, so a cut
 * that treats one as a gap cuts a token the grammar sees as whole. */
const GAP_CHAR = /[\s\u200b\u200c\u200d\u2060\ufeff]/;

/** What may stand immediately before a number and belong to it. Separating
 * `(` from its digits turns a credit into a charge. */
const OPENERS = new Set(["(", "$", "\u20ac", "\u00a3", "\u00a5", "\u20b9", "\u20a9", "+", "-"]);

/** The currency symbols the amount grammar knows. Cutting one away from its
 * digits loses the marker that decides whether `$2.5M` scales at all. */
const CURRENCY_MARKS = new Set([
  "$",
  "\u20ac",
  "\u00a3",
  "\u00a5",
  "\u20b9",
  "\u20a9",
]);

/** Words that sign or scale the number they stand beside, so a cut must never
 * fall between them and it. `CR` and `DR` are the sign; the rest are the
 * magnitude, in every spelling the grammar reads. */
const MODIFIER_WORDS =
  /^(cr|dr|k|m|b|mm|mn|bn|mil|mio|thousand|thousands|million|millions|billion|billions)$/i;

/** ISO codes the store supports, which mark the digits beside them as money
 * exactly as a symbol does. */
const CURRENCY_CODES = new Set<string>(SUPPORTED_CURRENCIES);

/**
 * Positions covered by filler rather than by a value.
 *
 * A dot leader (`Consulting services .......... 1,234.56`) is made of the same
 * characters a number is, so without this every leader would read as one
 * enormous token and no line with one could ever be split. Three or more
 * identical punctuation characters in a row are a rule, not a number.
 */
function fillerPositions(text: string, from: number, to: number): Set<number> {
  const filler = new Set<number>();
  let runStart = from;
  for (let at = from + 1; at <= to; at += 1) {
    if (at === to || text[at] !== text[runStart]) {
      const unit = text[runStart]!;
      if (at - runStart >= 3 && /[^\w\s]/.test(unit)) {
        for (let index = runStart; index < at; index += 1) filler.add(index);
      }
      runStart = at;
    }
  }
  return filler;
}

/**
 * One physical line as one or more citable pieces, cut at whitespace when it
 * is longer than {@link MAX_LINE_CHARS}.
 *
 * Pieces are contiguous and cover the line exactly, so nothing is lost and no
 * offset moves. **And no cut falls inside a number or a date.** The first
 * version of this cut at the bound whenever the lookback found no space, which
 * split `1,234.56` into `1,` and `234.56` -- and the second piece is then
 * shown to the model as a line of its own, cited in good faith, and stored as
 * 234.56 with a valid span on a document that says 1,234.56. A fabricated
 * value with a real citation is the one outcome this whole gate exists to
 * prevent, and it shipped.
 *
 * So a cut that would land inside a token walks forward past the whole token,
 * including a closing parenthesis or a trailing `CR`. The bound softens by up
 * to {@link MAX_LINE_OVERFLOW}; a single token longer than that leaves the
 * line unsplit, because one long citation is a weak check and a wrong number
 * is a wrong number.
 *
 * ADM-5g widens "inside a token" to look **through the gap**. The fourth
 * review cut `...$2.5 million` down to `$2.5`, `( 1,234 )` down to
 * `( 1,234`, `45.00 CR` down to `45.00` and `$1 000 000` down to `$1 000`,
 * and every survivor read as a number the page does not print: a magnitude
 * lost, a sign lost, a digit group lost. Whitespace between the two halves
 * changed none of that, so the whitespace is looked through, and a cut beside
 * a digit, a currency mark, a parenthesis, a sign, a magnitude word or a
 * `CR`/`DR` is treated exactly like a cut through the middle of `1,234.56`.
 *
 * Where a cut is made anyway, the piece carries it: see `cutStart`/`cutEnd`
 * on {@link PageLine}. Avoiding the cut is what keeps the amount readable;
 * marking it is what keeps a bad cut from ever being read.
 */
function splitLongLine(
  text: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  if (end - start <= MAX_LINE_CHARS) return [{ start, end }];
  const filler = fillerPositions(text, start, end);
  const tokenAt = (at: number): boolean =>
    at >= start && at < end && TOKEN_CHAR.test(text[at]!) && !filler.has(at);

  /** The nearest non-space position before `cut`, and at or after it. A cut
   * lands between two tokens as often as inside one, and the whitespace
   * between them is exactly what hides the fact. */
  const backOf = (cut: number): number => {
    let at = cut - 1;
    while (at >= start && GAP_CHAR.test(text[at]!)) at -= 1;
    return at;
  };
  const forwardOf = (cut: number): number => {
    let at = cut;
    while (at < end && GAP_CHAR.test(text[at]!)) at += 1;
    return at;
  };

  /** The word that begins at `at`, if any. */
  const wordAt = (at: number): string => {
    const word = /^[A-Za-z]+/.exec(text.slice(at, Math.min(end, at + 12)));
    return word ? word[0] : "";
  };
  /** The word that ends at `at` (exclusive), if any. */
  const wordEndingAt = (at: number): string => {
    let from = at;
    while (from > start && /[A-Za-z]/.test(text[from - 1]!)) from -= 1;
    return text.slice(from, at);
  };

  /** Something a number *before* the cut would take as its own. */
  const modifiesLeft = (at: number): boolean => {
    if (at >= end) return false;
    const unit = text[at]!;
    if (unit === "-" || unit === "+" || unit === "%" || unit === ")") return true;
    if (CURRENCY_MARKS.has(unit)) return true;
    const word = wordAt(at);
    return (
      word.length > 0 &&
      (MODIFIER_WORDS.test(word) || CURRENCY_CODES.has(word.toUpperCase()))
    );
  };
  /** Something a number *after* the cut would take as its own. */
  const modifiesRight = (at: number): boolean => {
    if (at < start) return false;
    const unit = text[at]!;
    if (unit === "(" || unit === "-" || unit === "+") return true;
    if (CURRENCY_MARKS.has(unit)) return true;
    const word = wordEndingAt(at + 1);
    return (
      word.length > 0 &&
      (MODIFIER_WORDS.test(word) || CURRENCY_CODES.has(word.toUpperCase()))
    );
  };

  /**
   * Whether a cut here would separate a value from part of itself.
   *
   * Adjacency is the old half: `1,234.56` cut into `1,` and `234.56` is the
   * fabricated value this file was written to stop. The rest is ADM-5g's:
   * the fourth review cut `...$2.5 million` down to `$2.5`, `( 1,234 )` down
   * to `( 1,234` and `45.00 CR` down to `45.00`, and each survivor read as a
   * number the page did not print. Whitespace between the two halves changed
   * nothing about that, so the gap is looked through here.
   */
  const insideToken = (cut: number): boolean => {
    if (cut <= start || cut >= end) return false;
    const before = text[cut - 1]!;
    if (tokenAt(cut - 1) && tokenAt(cut)) return true;
    if (OPENERS.has(before) && tokenAt(cut)) return true;
    if (tokenAt(cut - 1) && text[cut] === ")") return true;
    const back = backOf(cut);
    const forward = forwardOf(cut);
    // Never inside a word: splitting `CR` into `C` and `R` leaves a credit
    // marker that is a magnitude letter instead, and splitting `million`
    // leaves an amount that reads a millionth of what the line says. Looked
    // at through the zero-width characters a text layer sprinkles between
    // letters, which is how `mill<U+FEFF>ion` was cut in half.
    if (
      back >= start &&
      /[A-Za-z]/.test(text[back]!) &&
      forward < end &&
      /[A-Za-z]/.test(text[forward]!) &&
      !/\s/.test(text.slice(back, forward + 1))
    ) {
      return true;
    }
    if (back >= start && /[\d)]/.test(text[back]!) && modifiesLeft(forward)) {
      return true;
    }
    if (
      forward < end &&
      /[\d(]/.test(text[forward]!) &&
      modifiesRight(back)
    ) {
      return true;
    }
    return false;
  };

  /** The first cut at or after this one that is not inside a token. */
  const clear = (cut: number): number => {
    let at = cut;
    while (at < end && insideToken(at)) at += 1;
    return at;
  };

  const pieces: Array<{ start: number; end: number }> = [];
  let at = start;
  while (end - at > MAX_LINE_CHARS) {
    const bound = at + MAX_LINE_CHARS;
    let cut = -1;
    for (
      let probe = bound;
      probe > bound - SPLIT_LOOKBACK && probe > at;
      probe -= 1
    ) {
      if (/\s/.test(text[probe - 1]!)) {
        cut = probe;
        break;
      }
    }
    if (cut <= at) cut = bound;
    if (insideToken(cut)) {
      // Backwards first: the start of the token is a cut that splits nothing
      // and keeps the piece under the bound. Forwards only when the token
      // begins at or before where this piece does.
      let back = cut;
      while (back > at && insideToken(back)) back -= 1;
      cut = back > at ? back : clear(cut);
    }
    // One token wider than the allowance: leave the line whole rather than
    // cut it somewhere that changes what it says.
    if (cut > bound + MAX_LINE_OVERFLOW) return [{ start, end }];
    if (cut <= at || cut >= end) break;
    pieces.push({ start: at, end: cut });
    at = cut;
  }
  if (at < end) pieces.push({ start: at, end });
  return pieces.length > 0 ? pieces : [{ start, end }];
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
