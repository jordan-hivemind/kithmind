// Parser for the real Morgan Stanley CLIENT STATEMENT layout, over the
// fixed-pitch text src/pdfText.mjs reconstructs. The vocabulary this file
// keys on -- section titles, column headers, row labels -- is written out in
// README, "Statement layout", so a third party can maintain it without a
// statement in front of them.
//
// Ground rule 5 runs through the whole file: a cell this parser cannot bind
// to a column, or a number it cannot canonicalize, becomes null with a note
// and routes to review. It never rounds, never infers a column from the
// neighbour that happened to parse, and never reads a number as a float.

import {
  addDecimal,
  canonicalizeDecimal,
  negateDecimal,
  EMPTY_HOLDINGS,
  sha256HexOf,
} from "@repo/finance-archive";
import { PAGE_SEPARATOR } from "./pdfText.mjs";

const BASE_CURRENCY = "USD";
/**
 * F1-46. The running per-page header a consolidated statement prints before
 * each account's own pages: a line whose only content is that account's
 * number, one line above a line reading "Account <name>" (README, "Statement
 * layout" / "Consolidated statements"). A single-account statement prints
 * the same line; there it is simply constant throughout the document.
 */
const BARE_ACCOUNT_LINE = /^\s*(\d{3}-\d{6}-\d{3})\s*$/;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_NAME = `(${MONTHS.join("|")})`;
/**
 * The two period spellings the corpus uses. The ordinary one names the month
 * once -- "For the Period March 1-31, 2026". F1-61: a period that opens
 * mid-month names it twice -- "For the Period November 26-December 31, 2021"
 * -- which older statements and a newly opened account both print, and which
 * the one-month spelling alone read as no period at all.
 */
const PERIOD_LINE = new RegExp(
  `For the Period\\s+${MONTH_NAME}\\s+(\\d{1,2})\\s*-\\s*(?:${MONTH_NAME}\\s+)?(\\d{1,2}),\\s*(\\d{4})`,
);
/**
 * F1-61. The cash activity summary this institution prints alongside the
 * statements: an `Activity Date` table and nothing else -- no period line, no
 * BALANCE SHEET and no holdings table. It is not a statement whose layout
 * this parser failed to read, so it does not say that it is.
 */
const ACTIVITY_DATE_COLUMN = /^\s*Activity Date\b/;
/** A cell boundary: the layout puts at least two spaces between columns. */
const CELL_GAP = /\s{2,}/;
/** How far a cell edge may sit from a header edge and still be that column. */
const EDGE_TOLERANCE = 3;
/**
 * F1-8c. The BALANCE SHEET's own two money columns ("Last Period (as of
 * ...)"/"This Period (as of ...)") are printed under a header cell whose own
 * text -- the parenthesised date -- is wider than most of the amounts bound
 * under it. A short figure (Cash, BDP, MMFs is usually far smaller than
 * TOTAL VALUE) right-aligns to the same print column but its far shorter
 * text starts well clear of the header's own start, so neither edge lands
 * within `EDGE_TOLERANCE` of the header cell -- the row still matches
 * (`BALANCE_ROWS.cash`), and the cell is visibly a number, but it binds to no
 * column, so `read()` reports "row or column not printed on this statement"
 * for a cash figure the statement did print. Measured against the hosted
 * archive's own BALANCE SHEET blocks, five character-widths covers every
 * cash cell TOTAL VALUE and Total Assets already bind at three or fewer.
 * The two BALANCE SHEET columns sit roughly twenty characters apart (see the
 * fixture layout below), so doubling the tolerance here still cannot cross-
 * bind Last Period and This Period into each other. Holdings columns run
 * much closer together and keep the tighter default.
 */
const BALANCE_SHEET_EDGE_TOLERANCE = 5;
/** "$1,234.56", "(1,234.56)", "1,234.56-" and the em dash for "none". */
const NO_VALUE = new Set(["", "—", "–", "-", "N/A", "NA"]);
/** A one- or two-letter footnote reference printed after a value. */
const FOOTNOTE_SUFFIX = /\s+[A-Za-z]{1,2}$/;

// --- cells and columns ------------------------------------------------------

/**
 * One line's cells, each with the character offsets it occupies. The
 * offsets bound exactly `cell.text` (the trimmed content) so that
 * `line.slice(cell.start, cell.end) === cell.text` always -- F1-53 turns
 * these into evidence spans, and a span that included a cell's un-trimmed
 * padding would not slice to its own quote.
 */
function splitCells(text) {
  const cells = [];
  let offset = 0;
  for (const part of text.split(CELL_GAP)) {
    if (part.trim() === "") continue;
    const rawStart = text.indexOf(part, offset);
    const leading = part.length - part.trimStart().length;
    const start = rawStart + leading;
    const trimmed = part.trim();
    cells.push({ text: trimmed, start, end: start + trimmed.length });
    offset = rawStart + part.length;
  }
  return cells;
}

/**
 * Binds a data cell to a header cell by whichever of its two edges lines up.
 * Numbers on this layout are right-aligned under a right-aligned header and
 * descriptions are left-aligned under a left-aligned one, so the smaller of
 * the two edge errors identifies the column and a long description that runs
 * under the next header does not get stolen by it.
 */
function bindColumn(cell, columns, tolerance = EDGE_TOLERANCE) {
  let best = null;
  for (const column of columns) {
    const error = Math.min(
      Math.abs(cell.end - column.end),
      Math.abs(cell.start - column.start),
    );
    if (error > tolerance) continue;
    if (best === null || error < best.error) best = { column, error };
  }
  return best?.column ?? null;
}

/** A line's cells keyed by the column each one binds to. A cell that lines up
 * with no column is dropped: every column this parser reads is named in
 * HOLDINGS_COLUMNS, so a cell outside all of them is a column it does not
 * read (an Est Ann Income, a Yield %), not a value going missing. `tolerance`
 * defaults to the tight holdings-table spacing; `parseBalanceSheet` passes
 * `BALANCE_SHEET_EDGE_TOLERANCE` for its own, much more widely spaced pair of
 * money columns (F1-8c). */
function bindRow(line, columns, tolerance = EDGE_TOLERANCE) {
  const bound = new Map();
  let conflictingCells = false;
  for (const cell of splitCells(line)) {
    const column = bindColumn(cell, columns, tolerance);
    if (column !== null && bound.has(column.name)) conflictingCells = true;
    if (column !== null && !bound.has(column.name))
      bound.set(column.name, cell);
  }
  return { bound, conflictingCells };
}

// --- money ------------------------------------------------------------------

/**
 * A statement money cell to canonical decimal text. `null` with a note for
 * anything this cannot read, including the em dash the statement prints for
 * "none": that is not the same fact as zero and is not recorded as one.
 */
export function resolveStatementMoney(raw) {
  const text = String(raw ?? "").trim();
  const withoutFootnote = text.replace(FOOTNOTE_SUFFIX, "").trim();
  if (NO_VALUE.has(withoutFootnote)) {
    return { value: null, note: `no value stated (${JSON.stringify(text)})` };
  }
  const negative = /^\(.*\)$/.test(withoutFootnote);
  const digits = withoutFootnote.replace(/^\(|\)$/g, "").replace(/[$,\s]/g, "");
  try {
    const canonical = canonicalizeDecimal(digits);
    return {
      value: negative ? negateDecimal(canonical) : canonical,
      note: null,
    };
  } catch {
    return { value: null, note: `unparseable amount: ${JSON.stringify(text)}` };
  }
}

// --- document shape ---------------------------------------------------------

/**
 * Lines with the page they came from, 1-based, as FieldLocator.index wants,
 * and each line's own start offset in `text` -- a single pass over the whole
 * string rather than a split-and-rejoin, so the offset is exact and the page
 * separator (`\f`, joined as `"\n" + PAGE_SEPARATOR + "\n"`, see pdfText.mjs)
 * always lands as its own clean line between two real ones. F1-53: this is
 * what lets every locator below carry an evidence span into `text` itself,
 * the exact string the archive retains at `documents.text_path`.
 */
function pagedLines(text) {
  const out = [];
  let page = 1;
  let offset = 0;
  for (const raw of text.split("\n")) {
    if (raw === PAGE_SEPARATOR) {
      page += 1;
    } else if (raw.trim() !== "") {
      out.push({ page, text: raw, start: offset });
    }
    offset += raw.length + 1;
  }
  return out;
}

function locator(kind, page, field) {
  return { source: kind, index: page, field };
}

/**
 * `textMeta` is the retained text's own identity, computed once per
 * document and carried onto every span this parser emits: `sha256HexOf`
 * matches exactly what `writeRetainedText` hashes the same string to, so
 * `textRelativePath(textSha256)` (rawTree.ts) names the real file a
 * consumer resolves the span from without either side knowing the raw tree
 * root.
 */
function textMetaOf(text) {
  return {
    sha256: sha256HexOf(Buffer.from(text, "utf8")),
    byteLength: Buffer.byteLength(text, "utf8"),
    codepointLength: Array.from(text).length,
  };
}

/**
 * A `FieldLocator` bound to an exact retained-text span: `start`/`end` are
 * unicode code point offsets into the retained text and `quote` is the exact
 * substring they name (`text.slice(start, end) === quote`, code points and
 * JS string indices coinciding here because statement text is ASCII).
 */
function spanLocator(kind, page, field, textMeta, start, end, quote) {
  return {
    source: kind,
    index: page,
    field,
    binding: {
      format: "retained_text_span_v1",
      textSha256: textMeta.sha256,
      textByteLength: textMeta.byteLength,
      textCodepointLength: textMeta.codepointLength,
      start,
      end,
      quote,
    },
  };
}

/** An exact retained-text span over one non-empty source line. */
function lineSpanLocator(line, kind, field, textMeta) {
  const quote = line.text.trim();
  const offset = line.text.indexOf(quote);
  return spanLocator(
    kind,
    line.page,
    field,
    textMeta,
    line.start + offset,
    line.start + offset + quote.length,
    quote,
  );
}

/**
 * F1-46. Forward-fills every line with the account key of the nearest
 * preceding `BARE_ACCOUNT_LINE` -- the account whose own pages that line was
 * printed on. `null` for any line before the first such marker (the
 * household-wide summary pages a consolidated statement prints before its
 * first account's own pages). F1-8l: something this parser reads does live
 * there -- a `Consolidated Summary` BALANCE SHEET stating the roll-up across
 * every account in the document -- and `parseRealStatement` refuses that
 * section rather than letting the importer attribute it to one account. A
 * single-account statement has exactly one marker, repeated on every page,
 * so every line resolves to that one account -- unchanged behavior.
 */
function accountKeysByLine(lines) {
  const keys = new Array(lines.length).fill(null);
  // F1-53: which line (an index into `lines`) stated the account number a
  // given line's key was forward-filled from, so a holding or balance can
  // also cite the exact account-number line its section came from, not just
  // carry the key as a string.
  const markerLines = new Array(lines.length).fill(null);
  let current = null;
  let currentMarkerLine = null;
  lines.forEach(({ text }, i) => {
    const match = BARE_ACCOUNT_LINE.exec(text);
    if (match !== null) {
      current = match[1];
      currentMarkerLine = i;
    }
    keys[i] = current;
    markerLines[i] = currentMarkerLine;
  });
  return { keys, markerLines };
}

/** The evidence span over the account-number line a section's `accountKey`
 * was forward-filled from, or null before the first such marker (see
 * `accountKeysByLine`). */
function accountSpanLocator(lines, markerLines, lineIndex, kind, textMeta) {
  const markerLine = markerLines[lineIndex];
  if (markerLine === null) return null;
  const line = lines[markerLine];
  const match = BARE_ACCOUNT_LINE.exec(line.text);
  if (match === null) return null;
  const matchStart = line.text.indexOf(match[1]);
  const start = line.start + matchStart;
  const end = start + match[1].length;
  return spanLocator(
    kind,
    line.page,
    "account number",
    textMeta,
    start,
    end,
    match[1],
  );
}

/** `{ accountExternalKey: key }` when non-null, else `{}` -- spread onto a
 * parsed holding so an unresolved account key (should never happen once a
 * statement's own `BARE_ACCOUNT_LINE` has appeared, but is possible before
 * the first one) leaves the field omitted rather than set to null, matching
 * every other adapter's "omitted means this pull's own account" contract. */
function accountKeyField(key) {
  return key === null ? {} : { accountExternalKey: key };
}

/**
 * "December", "1", "31", "2025" -> ISO period bounds, or `null` when the
 * document states no period this can read. A cross-month period states its
 * year once, at the end, so one that runs backwards through a year boundary
 * ("December 26-January 5, 2022") does not say which year it opened in; that
 * is refused rather than assumed, the same way every other unstated fact is.
 */
function resolvePeriod(lines) {
  for (const { text } of lines) {
    const match = PERIOD_LINE.exec(text);
    if (match === null) continue;
    const startMonth = MONTHS.indexOf(match[1]);
    const endMonth =
      match[3] === undefined ? startMonth : MONTHS.indexOf(match[3]);
    if (endMonth < startMonth) return null;
    const iso = (month, day) =>
      `${match[5]}-${String(month + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
    return { start: iso(startMonth, match[2]), end: iso(endMonth, match[4]) };
  }
  return null;
}

function statementPeriodLocator(lines, kind, textMeta) {
  const line = lines.find(({ text }) => PERIOD_LINE.test(text));
  return line === undefined
    ? null
    : lineSpanLocator(line, kind, "statement period", textMeta);
}

/** "(as of 03/31/26)" -> "2026-03-31". Two-digit years on this layout are
 * always 20xx: the provider retains seven years, so 19xx cannot occur. */
function resolveAsOf(text) {
  const match = /\(as of\s+(\d{1,2})\/(\d{1,2})\/(\d{2})\)/.exec(text);
  if (match === null) return null;
  return `20${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

// --- BALANCE SHEET ----------------------------------------------------------

const BALANCE_SHEET_ANCHOR = /\bBALANCE\s+SHEET\b/;
const AS_OF_HEADER = /\(as of\s+\d{1,2}\/\d{1,2}\/\d{2}\)/;
/** Row labels the balance sheet block is read by. */
const BALANCE_ROWS = {
  cash: /^Cash,\s/,
  totalValue: /^TOTAL VALUE\b/,
  liabilities: /^Total Liabilities\b/,
};
/** How far past the anchor the block's rows can run before the next section. */
const BALANCE_BLOCK_LINES = 40;
const BALANCE_SCOPE_BOUNDARY =
  /^\s*(?:HOLDINGS|ACTIVITY|Account Summary|CASH MANAGEMENT ACTIVITY)\b/i;

/**
 * Bound a balance block before looking for its rows. The former fixed-size
 * window remains the maximum, but it may no longer borrow a date or TOTAL
 * VALUE row from a following account, page, balance block, or section.
 * Account and section markers are also positive end evidence. A physical
 * page change clips parsing but is not by itself proof that the section was
 * complete.
 */
function balanceSheetWindow(lines, anchorIndex, kind, textMeta) {
  const anchorPage = lines[anchorIndex].page;
  const maximum = Math.min(lines.length, anchorIndex + BALANCE_BLOCK_LINES);
  for (let i = anchorIndex + 1; i < maximum; i += 1) {
    const line = lines[i];
    if (line.page !== anchorPage) {
      return {
        endExclusive: i,
        scopeEnd: null,
      };
    }
    const isAccount = BARE_ACCOUNT_LINE.test(line.text);
    const isBalance = BALANCE_SHEET_ANCHOR.test(line.text);
    const isSection = BALANCE_SCOPE_BOUNDARY.test(line.text);
    if (!isAccount && !isBalance && !isSection) continue;
    return {
      endExclusive: i,
      scopeEnd: {
        lineIndex: i,
        locator: lineSpanLocator(
          line,
          kind,
          isAccount
            ? "next account boundary"
            : isBalance
              ? "next balance sheet boundary"
              : "balance section boundary",
          textMeta,
        ),
      },
    };
  }
  return { endExclusive: maximum, scopeEnd: null };
}

function balanceEvidenceHasAnchoredPages(
  evidence,
  printedByPage,
  populatedPages,
) {
  return Object.values(evidence)
    .filter((entry) => entry !== undefined)
    .every((entry) =>
      printedPageSequenceIsAnchored(entry.index, printedByPage, populatedPages),
    );
}

/**
 * The per-account BALANCE SHEET: two columns, "Last Period (as of ...)" and
 * "This Period (as of ...)", printed to the left of an unrelated CASH FLOW
 * table on the same visual lines. The two are told apart by column position
 * alone, which is why the extractor keeps it.
 *
 * `accountKey` (F1-46) is this anchor's own account, from
 * `accountKeysByLine` -- the account whose `BALANCE SHEET` this is, which a
 * consolidated statement prints once per account.
 */
function parseBalanceSheet(
  lines,
  anchorIndex,
  kind,
  accountKey,
  markerLines,
  textMeta,
  printedByPage,
  populatedPages,
) {
  const window = balanceSheetWindow(lines, anchorIndex, kind, textMeta);
  const block = lines.slice(anchorIndex, window.endExclusive);
  const headerLine = block.find(
    ({ text }) => (text.match(AS_OF_HEADER) ?? []).length > 0,
  );
  if (headerLine === undefined) return { sheet: null, balanceScope: null };
  const asOfCells = splitCells(headerLine.text).filter((cell) =>
    AS_OF_HEADER.test(cell.text),
  );
  if (asOfCells.length !== 2) return { sheet: null, balanceScope: null };
  // Printed left to right: last period, then this period.
  const columns = [
    { name: "lastPeriod", ...asOfCells[0] },
    { name: "thisPeriod", ...asOfCells[1] },
  ];
  const page = headerLine.page;
  const rows = {};
  const rowCounts = {};
  for (const [blockIndex, { text, start: lineStart }] of block.entries()) {
    for (const [name, pattern] of Object.entries(BALANCE_ROWS)) {
      const trimmed = text.trim();
      if (!pattern.test(trimmed)) continue;
      rowCounts[name] = (rowCounts[name] ?? 0) + 1;
      if (rows[name] !== undefined) continue;
      rows[name] = {
        bound: bindRow(text, columns, BALANCE_SHEET_EDGE_TOLERANCE).bound,
        lineStart,
        lineIndex: anchorIndex + blockIndex,
      };
    }
  }
  if (rows.totalValue === undefined) return { sheet: null, balanceScope: null };

  // F1-53. `span` is null exactly when there is no cell to cite (row or
  // column not printed); `resolveStatementMoney` failing to read a cell that
  // *is* printed still carries a span, over the unparseable text, so a
  // review item and an evidence-yielding parse are not mutually exclusive.
  const read = (row, column, fieldLabel) => {
    if (row === undefined || !row.bound.has(column)) {
      return {
        value: null,
        note: "row or column not printed on this statement",
        locator: null,
      };
    }
    const cell = row.bound.get(column);
    const resolved = resolveStatementMoney(cell.text);
    const start = row.lineStart + cell.start;
    const end = row.lineStart + cell.end;
    return {
      ...resolved,
      locator: spanLocator(
        kind,
        page,
        fieldLabel,
        textMeta,
        start,
        end,
        cell.text,
      ),
    };
  };

  const total = read(
    rows.totalValue,
    "thisPeriod",
    "BALANCE SHEET / TOTAL VALUE",
  );
  const opening = read(
    rows.totalValue,
    "lastPeriod",
    "BALANCE SHEET / TOTAL VALUE (last period)",
  );
  const cash = read(rows.cash, "thisPeriod", "BALANCE SHEET / Cash");
  const asOf = resolveAsOf(columns[1].text);
  const asOfLocator = spanLocator(
    kind,
    headerLine.page,
    "BALANCE SHEET / This Period as of",
    textMeta,
    headerLine.start + columns[1].start,
    headerLine.start + columns[1].end,
    columns[1].text,
  );
  const rowLocator = locator(kind, page, "BALANCE SHEET / TOTAL VALUE");
  const accountLocator = accountSpanLocator(
    lines,
    markerLines,
    anchorIndex,
    kind,
    textMeta,
  );
  const headerLocator = lineSpanLocator(
    lines[anchorIndex],
    kind,
    "BALANCE SHEET header",
    textMeta,
  );
  const totalRowLocator = lineSpanLocator(
    lines[rows.totalValue.lineIndex],
    kind,
    "BALANCE SHEET / TOTAL VALUE row",
    textMeta,
  );
  // TOTAL VALUE is the provider's terminal balance row. Proving it terminal
  // still requires scanning the rest of this physical account section: a
  // later TOTAL VALUE or BALANCE SHEET must not disappear merely because row
  // parsing retains its historical fixed-size window.
  let laterTotalRows = 0;
  for (let i = rows.totalValue.lineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (
      line.page !== page ||
      BARE_ACCOUNT_LINE.test(line.text) ||
      BALANCE_SHEET_ANCHOR.test(line.text) ||
      BALANCE_SCOPE_BOUNDARY.test(line.text)
    ) {
      break;
    }
    if (BALANCE_ROWS.totalValue.test(line.text.trim())) laterTotalRows += 1;
  }
  const totalRowCount = (rowCounts.totalValue ?? 0) + laterTotalRows;
  const scopeEnd =
    total.value !== null && totalRowCount === 1
      ? { lineIndex: rows.totalValue.lineIndex, locator: totalRowLocator }
      : window.scopeEnd;

  const balance = {
    sourceDocument: "statement",
    ...accountKeyField(accountKey),
    asOf,
    totalValue: total.value,
    totalValueNote: total.note,
    cash: cash.value,
    currency: BASE_CURRENCY,
    periodStartValue: opening.value,
    periodEndValue: total.value,
    locators: {
      row: rowLocator,
      totalValue: total.value === null ? rowLocator : total.locator,
      ...(cash.value === null ? {} : { cash: cash.locator }),
      ...(accountLocator === null ? {} : { account: accountLocator }),
    },
  };

  const liabilities = [];
  const liability = read(
    rows.liabilities,
    "thisPeriod",
    "BALANCE SHEET / Total Liabilities",
  );
  // The em dash means "no liability on this statement", which is a different
  // fact from a zero balance and is not recorded as one.
  if (liability.value !== null) {
    const liabilityLocator = locator(
      kind,
      page,
      "BALANCE SHEET / Total Liabilities",
    );
    liabilities.push({
      sourceDocument: "statement",
      ...accountKeyField(accountKey),
      kind: "outstanding_balance",
      displayName: "Total Liabilities (outstanding balance)",
      balance: liability.value,
      balanceNote: null,
      currency: BASE_CURRENCY,
      rate: null,
      asOf,
      collateralNote:
        "the balance sheet states one combined liability total; the statement does not " +
        "break it into per-facility collateral on this line",
      locators: {
        row: liabilityLocator,
        balance: liability.locator,
        ...(accountLocator === null ? {} : { account: accountLocator }),
      },
    });
  }
  let balanceScope = null;
  if (accountKey !== null && accountLocator !== null && asOf !== null) {
    const evidence = {
      account: accountLocator,
      header: headerLocator,
      asOf: asOfLocator,
      row: totalRowLocator,
      ...(total.locator === null ? {} : { totalValue: total.locator }),
      ...(scopeEnd === null ? {} : { scopeEnd: scopeEnd.locator }),
    };
    const gapCodes = new Set();
    if (total.value === null) gapCodes.add("missing_total_value");
    if (totalRowCount !== 1) gapCodes.add("multiple_balance_rows");
    if (scopeEnd === null) gapCodes.add("unbounded_account_scope");
    if (
      !balanceEvidenceHasAnchoredPages(evidence, printedByPage, populatedPages)
    ) {
      gapCodes.add("page_sequence_gap");
    }
    balanceScope = {
      sourceDocument: "statement",
      accountExternalKey: accountKey,
      asOf,
      proofVersion: "balance_scope_v1",
      status: gapCodes.size === 0 ? "complete" : "partial",
      emittedBalanceCount: 1,
      gapCodes: [...gapCodes].sort(),
      evidence,
    };
  }
  return { sheet: { balance, liabilities }, balanceScope };
}

/**
 * F1-61. The cover page's own statement of the account total: a banner
 * reading `TOTAL VALUE OF <x> ACCOUNT` with the amount alone on one of the
 * next two lines, above an `Includes Accrued Interest` note.
 *
 * It is read only when the document prints no `BALANCE SHEET` block at all,
 * and only when it names one `ACCOUNT`: the plural `ACCOUNTS` banner on a
 * consolidated statement's cover is the household total across accounts, not
 * any one account's balance, and is never recorded as one.
 */
const TOTAL_VALUE_BANNER = /TOTAL VALUE OF\s+\S+\s+ACCOUNT\b/;

function balanceBannerScopeEnd(
  lines,
  rowIndex,
  kind,
  textMeta,
  printedByPage,
  populatedPages,
) {
  const page = lines[rowIndex].page;
  const maximum = Math.min(lines.length, rowIndex + BALANCE_BLOCK_LINES);
  for (let i = rowIndex + 1; i < maximum; i += 1) {
    const line = lines[i];
    if (line.page !== page) return null;
    const isAccount = BARE_ACCOUNT_LINE.test(line.text);
    const isBalance = BALANCE_SHEET_ANCHOR.test(line.text);
    const isSection = BALANCE_SCOPE_BOUNDARY.test(line.text);
    if (!isAccount && !isBalance && !isSection) continue;
    return {
      lineIndex: i,
      locator: lineSpanLocator(
        line,
        kind,
        isAccount
          ? "next account boundary"
          : isBalance
            ? "next balance sheet boundary"
            : "balance section boundary",
        textMeta,
      ),
    };
  }
  if (maximum !== lines.length) return null;
  const finalEvidence = finalPageEvidence(
    lines,
    kind,
    textMeta,
    printedByPage,
    populatedPages,
  );
  return finalEvidence !== null && finalEvidence.lineIndex >= rowIndex
    ? finalEvidence
    : null;
}

/**
 * `{ balance }` when the banner states an amount, `{ statedNone: true }` when
 * it states the em dash this layout prints for "none" (an account holding
 * nothing, which is a fact the statement states, not one it omits), and
 * `null` when there is no banner or nothing readable under it.
 */
function parseTotalValueBanner(
  lines,
  kind,
  asOf,
  accountKeys,
  markerLines,
  textMeta,
  periodLocator,
  printedByPage,
  populatedPages,
) {
  const anchor = lines.findIndex(({ text }) => TOTAL_VALUE_BANNER.test(text));
  if (anchor === -1) return null;
  const anchorPage = lines[anchor].page;
  const accountKey = accountKeys[anchor];
  for (let rowIndex = anchor + 1; rowIndex < anchor + 3; rowIndex += 1) {
    const line = lines[rowIndex];
    if (line === undefined) break;
    if (
      line.page !== anchorPage ||
      accountKeys[rowIndex] !== accountKey ||
      BARE_ACCOUNT_LINE.test(line.text) ||
      BALANCE_SHEET_ANCHOR.test(line.text) ||
      BALANCE_SCOPE_BOUNDARY.test(line.text)
    ) {
      break;
    }
    const cells = splitCells(line.text);
    if (cells.length !== 1) continue;
    const cell = cells[0];
    const accountLocator = accountSpanLocator(
      lines,
      markerLines,
      anchor,
      kind,
      textMeta,
    );
    const scopeEnd = balanceBannerScopeEnd(
      lines,
      rowIndex,
      kind,
      textMeta,
      printedByPage,
      populatedPages,
    );
    const scopeFor = ({ count, amountLocator, explicitNone = null }) => {
      if (accountKey === null || accountLocator === null) return null;
      const evidence = {
        account: accountLocator,
        header: lineSpanLocator(
          lines[anchor],
          kind,
          "TOTAL VALUE OF ACCOUNT header",
          textMeta,
        ),
        ...(periodLocator === null ? {} : { asOf: periodLocator }),
        row: lineSpanLocator(
          line,
          kind,
          "TOTAL VALUE OF ACCOUNT row",
          textMeta,
        ),
        ...(amountLocator === null ? {} : { totalValue: amountLocator }),
        ...(explicitNone === null ? {} : { explicitNone }),
        ...(scopeEnd === null ? {} : { scopeEnd: scopeEnd.locator }),
      };
      const gapCodes = new Set();
      if (periodLocator === null) gapCodes.add("unsupported_balance_header");
      if (scopeEnd === null) gapCodes.add("unbounded_account_scope");
      if (
        !balanceEvidenceHasAnchoredPages(
          evidence,
          printedByPage,
          populatedPages,
        )
      ) {
        gapCodes.add("page_sequence_gap");
      }
      return {
        sourceDocument: "statement",
        accountExternalKey: accountKey,
        asOf,
        proofVersion: "balance_scope_v1",
        status: gapCodes.size === 0 ? "complete" : "partial",
        emittedBalanceCount: count,
        gapCodes: [...gapCodes].sort(),
        ...(count === 0 ? { zeroBasis: "source_stated_none" } : {}),
        evidence,
      };
    };
    if (NO_VALUE.has(cell.text)) {
      const explicitNone = spanLocator(
        kind,
        line.page,
        "TOTAL VALUE OF ACCOUNT / explicit none",
        textMeta,
        line.start + cell.start,
        line.start + cell.end,
        cell.text,
      );
      return {
        statedNone: true,
        locator: explicitNone,
        balanceScope: scopeFor({
          count: 0,
          amountLocator: null,
          explicitNone,
        }),
      };
    }
    const { value } = resolveStatementMoney(cell.text);
    if (value === null) continue;
    const amountLocator = spanLocator(
      kind,
      line.page,
      "TOTAL VALUE OF ACCOUNT",
      textMeta,
      line.start + cell.start,
      line.start + cell.end,
      cell.text,
    );
    return {
      balance: {
        sourceDocument: "statement",
        ...accountKeyField(accountKeys[anchor]),
        asOf,
        totalValue: value,
        totalValueNote:
          "from the cover page's TOTAL VALUE OF ACCOUNT banner: this statement prints no " +
          "BALANCE SHEET block, so it states no cash, no liability and no opening value",
        cash: null,
        currency: BASE_CURRENCY,
        periodStartValue: null,
        periodEndValue: value,
        locators: {
          row: locator(kind, line.page, "TOTAL VALUE OF ACCOUNT"),
          totalValue: amountLocator,
          ...(accountLocator === null ? {} : { account: accountLocator }),
        },
      },
      balanceScope: scopeFor({ count: 1, amountLocator }),
    };
  }
  return null;
}

// --- HOLDINGS ---------------------------------------------------------------

/**
 * Every column label the holdings tables use, mapped to the field it fills.
 * Six header spellings appear across the corpus (equities, fixed income,
 * options, NAV-priced funds, aggregate private holdings, and the realized
 * gain/loss table); they share this vocabulary, so the parser reads whichever
 * labels a given table prints rather than keying on the table's identity.
 */
const HOLDINGS_COLUMNS = new Map([
  ["Security Description", "description"],
  ["Trade Date", "tradeDate"],
  ["Quantity", "quantity"],
  ["Face Value", "quantity"],
  ["Contracts", "quantity"],
  // Cost per unit is mapped but never read: `ParsedPosition.price` is the
  // market price, not what the lot cost. Mapping it anyway keeps its cells
  // bound to their own column instead of drifting onto a neighbouring one.
  ["Unit Cost", "unitCost"],
  ["Adj Unit Cost", "unitCost"],
  ["Share Price", "price"],
  ["Unit Price", "price"],
  ["Contract Price", "price"],
  ["NAV", "price"],
  ["Total Cost", "costBasis"],
  ["Adj Total Cost", "costBasis"],
  ["Market Value", "marketValue"],
  // F1-61. The NAV-priced fund table heads its value column `Value`, not
  // `Market Value` (README, "Statement layout"). Bound under its own name and
  // resolved per table by `resolveValueColumn`, because the same bare label
  // also heads the aggregate private-holdings table's `Value + Distributions`
  // column, which is not this holding's value.
  ["Value", "reportedValue"],
  ["Gain/(Loss)", "unrealized"],
]);
/** A cell states a value only if it carries a digit. Sub-headers reprinted
 * mid-table ("Percentage of Holdings", "Market Value") bind to a column like
 * any other cell; this is what keeps them from being read as one. */
function statesValue(cell) {
  return cell !== undefined && /\d/.test(cell.text);
}
/** The realized gain/loss table shares "Security Description" but states no
 * holding: it reports closed lots. Never a position. */
const REALIZED_TABLE = /\bAcquired\b.*\bSold\b.*\bProceeds\b/;
const HOLDINGS_HEADER = /^\s*Security Description\b/;
/** A table that is visibly security-shaped but whose description label is not
 * one this parser supports. It is still an observed account-scoped gap and
 * must not disappear merely because `headerColumns` cannot bind it. Requiring
 * a column-sized gap keeps a security name containing words such as
 * "Quantity" or "Value" from becoming a header. */
const POSSIBLE_HOLDINGS_HEADER =
  /^\s*Security\b.*?\s{2,}(?:Trade Date|Quantity|Face Value|Contracts|Market Value|NAV|Value)\b/;
function observedHoldingsHeader(text) {
  return HOLDINGS_HEADER.test(text) || POSSIBLE_HOLDINGS_HEADER.test(text);
}
/** A security's aggregate row, printed under its per-lot rows. */
const TOTAL_ROW = /^Total\b/;
/** Ends a holdings table. */
const TABLE_END = /^(TOTAL|Total Value|HOLDINGS|CASH FLOW|ACTIVITY|Page \d)/;
/**
 * F1-61. The page footer, the one `TABLE_END` that does not end the table:
 * a security's lots run past the bottom of a page and the rest of them,
 * including the `Total` row that states the position, are printed on the next
 * page under a reprint of the same header. `parseHoldings` carries the
 * interrupted block across to that reprint instead of refusing it.
 */
const PAGE_FOOTER = /^Page\s+\d+\s+of\s+\d+$/;

/**
 * The one consistent printed page declaration on each extracted page.
 * Statements can have an unnumbered cover, and consolidated statements can
 * restart numbering, so this deliberately does not require the document to
 * begin at printed page 1. A spanning table only needs the stronger local
 * fact that its two physical pages are adjacent and their printed numbers are
 * adjacent under the same declared total.
 */
function printedPages(lines) {
  const declarations = new Map();
  for (const line of lines) {
    const match = /^\s*Page\s+(\d+)\s+of\s+(\d+)\s*$/.exec(line.text);
    if (match === null) continue;
    const declaration = `${match[1]}/${match[2]}`;
    const seen = declarations.get(line.page) ?? new Set();
    seen.add(declaration);
    declarations.set(line.page, seen);
  }
  return new Map(
    [...declarations].map(([page, seen]) => {
      if (seen.size !== 1) return [page, null];
      const [declaration] = seen;
      const [number, total] = declaration.split("/").map(Number);
      if (
        !Number.isSafeInteger(number) ||
        !Number.isSafeInteger(total) ||
        number < 1 ||
        total < number
      )
        return [page, null];
      return [page, { number, total }];
    }),
  );
}

function continuesOnAdjacentPrintedPage(
  carried,
  headerLine,
  printedByPage,
  populatedPages,
) {
  if (headerLine.page !== carried.page + 1) return false;
  const before = printedByPage.get(carried.page);
  const after = printedByPage.get(headerLine.page);
  return (
    before !== null &&
    before !== undefined &&
    after !== null &&
    after !== undefined &&
    before.total === after.total &&
    before.number + 1 === after.number &&
    before.number < before.total &&
    after.number <= after.total &&
    printedPageSequenceIsAnchored(
      headerLine.page,
      printedByPage,
      populatedPages,
    )
  );
}

/** Trace a local printed-page run to positive evidence of its beginning. A
 * `Page 1` can begin an account-local run anywhere. An unnumbered cover is
 * also supported only when populated physical page 1 has no declaration and
 * physical page 2 says `Page 2`. A missing or contradictory predecessor later
 * in the document can never become a new anchor merely because its physical
 * and printed page numbers happen to agree. */
function printedPageSequenceIsAnchored(page, printedByPage, populatedPages) {
  let physicalPage = page;
  let declaration = printedByPage.get(physicalPage);
  if (declaration === null || declaration === undefined) return false;
  while (declaration.number > 1) {
    const previous = printedByPage.get(physicalPage - 1);
    if (
      previous === null ||
      previous === undefined ||
      previous.total !== declaration.total ||
      previous.number + 1 !== declaration.number
    ) {
      return (
        physicalPage === 2 &&
        declaration.number === 2 &&
        populatedPages.has(1) &&
        !printedByPage.has(1)
      );
    }
    physicalPage -= 1;
    declaration = previous;
  }
  return declaration.number === 1;
}

/** The declared run beginning on `startPage` reaches its own stated final
 * page at `endPage`, with every intervening physical page present. */
function printedPageRunEndsAt(
  startPage,
  endPage,
  printedByPage,
  populatedPages,
) {
  if (endPage < startPage) return false;
  const first = printedByPage.get(startPage);
  const last = printedByPage.get(endPage);
  if (
    first === null ||
    first === undefined ||
    last === null ||
    last === undefined ||
    first.total !== last.total ||
    last.number !== last.total ||
    last.number - first.number !== endPage - startPage ||
    !printedPageSequenceIsAnchored(endPage, printedByPage, populatedPages)
  ) {
    return false;
  }
  for (let page = startPage; page <= endPage; page += 1) {
    const declaration = printedByPage.get(page);
    if (
      declaration === null ||
      declaration === undefined ||
      declaration.total !== first.total ||
      declaration.number !== first.number + page - startPage
    ) {
      return false;
    }
  }
  return true;
}

/** Every physical page in one declared run from `startPage` through
 * `endPage` is present, even when `endPage` is not that run's final page. */
function printedPageRunContinuesThrough(
  startPage,
  endPage,
  printedByPage,
  populatedPages,
) {
  if (endPage < startPage) return false;
  const first = printedByPage.get(startPage);
  const last = printedByPage.get(endPage);
  if (
    first === null ||
    first === undefined ||
    last === null ||
    last === undefined ||
    first.total !== last.total ||
    last.number - first.number !== endPage - startPage ||
    !printedPageSequenceIsAnchored(endPage, printedByPage, populatedPages)
  ) {
    return false;
  }
  for (let page = startPage; page <= endPage; page += 1) {
    const declaration = printedByPage.get(page);
    if (
      declaration === null ||
      declaration === undefined ||
      declaration.total !== first.total ||
      declaration.number !== first.number + page - startPage
    ) {
      return false;
    }
  }
  return true;
}
/**
 * F1-61. The sub-header a table reprints above a section's own totals rows
 * ("Percentage of Holdings", then the value columns again). Everything from
 * it to the next security is that section's totals, which is not a holding
 * and -- read as one -- made the security above it look like a block with
 * several valued rows and no `Total`.
 */
const SECTION_SUMMARY = /^(Percentage\b|of Holdings\b)/;
/**
 * F1-61. A real trade date, which is how a security's own row is told from
 * the section-total row printed under a `SECTION_SUMMARY` sub-header: that
 * row states the section's name in the description column and its share of
 * holdings ("4.2%") where a lot would state the date it was bought.
 */
const TRADE_DATE_CELL = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
/** "Asset Class: Equities", printed under each security block. */
const ASSET_CLASS = /Asset Class:\s*(.+?)\s*$/;
/** "3M COMPANY (MMM)" -> name and symbol; anything else stays a name. */
const NAME_AND_SYMBOL = /^(.*?)\s*\(([A-Z0-9.]{1,8})\)$/;

const HOLDINGS_LABELS = [...HOLDINGS_COLUMNS.keys()].sort(
  (a, b) => b.length - a.length,
);

/**
 * The header line's column spans. Two headers printed a single space apart
 * ("Accrued Interest Yield %") arrive as one cell, so each cell is scanned
 * for the labels inside it rather than matched whole; a label's span is then
 * its own offsets, which is what a value has to line up with.
 */
function headerColumns(line) {
  const columns = [];
  for (const cell of splitCells(line)) {
    let offset = 0;
    while (offset < cell.text.length) {
      const label = HOLDINGS_LABELS.find((candidate) =>
        cell.text.startsWith(candidate, offset),
      );
      if (label === undefined) {
        offset += 1;
        continue;
      }
      columns.push({
        name: HOLDINGS_COLUMNS.get(label),
        text: label,
        start: cell.start + offset,
        end: cell.start + offset + label.length,
      });
      offset += label.length;
    }
  }
  return columns;
}

/**
 * F1-61. Resolves the bare `Value` column against the table it was printed
 * in. It is the holding's value only where the table also prices in `NAV`
 * (the NAV-priced fund table). The aggregate private-holdings table prints
 * the same label as part of `Value + Distributions` -- a value with
 * distributions added into it, which is not what this holding is worth -- so
 * there the column is dropped rather than read as a market value.
 */
function resolveValueColumn(columns) {
  const pricesInNav = columns.some((column) => column.text === "NAV");
  return columns.flatMap((column) => {
    if (column.name !== "reportedValue") return [column];
    return pricesInNav ? [{ ...column, name: "marketValue" }] : [];
  });
}

/** Offsets may shift when a table header is reprinted on the next page. The
 * ordered field/label pairs are its semantic identity; offsets remain local
 * to each page and are used only to bind that page's rows. */
function holdingsHeaderSignature(columns) {
  return JSON.stringify(columns.map(({ name, text }) => [name, text]));
}

// Table titles use the layout's all-caps heading grammar. Do not whitelist
// asset classes: a newly encountered explicit section must not silently
// become a continuation of the previous table. Only known running headings
// are ignored; an unknown title is conservatively a section boundary.
function explicitHoldingsSection(text) {
  const title = text.trim().replace(/\s+\(CONTINUED\)$/i, "");
  if (
    title === "HOLDINGS" ||
    title === "CLIENT STATEMENT" ||
    /^FOR THE PERIOD\b/.test(title)
  )
    return null;
  return /^[A-Z][A-Z0-9 ,&%'/()+^-]{3,}$/.test(title) ? title : null;
}

/** "CUSIP 00000WNF1" on a bond's detail line. */
const CUSIP_LABEL = /\bCUSIP\s+([A-Z0-9]{9})\b/;

function resolveInstrument(description, detailText) {
  const labelled = CUSIP_LABEL.exec(detailText ?? "");
  const cusip = labelled === null ? null : labelled[1];
  if (description === null) {
    return cusip === null
      ? null
      : { symbol: null, cusip, isin: null, name: null };
  }
  const match = NAME_AND_SYMBOL.exec(description);
  if (match === null)
    return { symbol: null, cusip, isin: null, name: description };
  const token = match[2];
  // A nine-character alphanumeric in that position is a CUSIP, not a ticker.
  const isCusip = token.length === 9;
  return {
    symbol: isCusip ? null : token,
    cusip: isCusip ? token : cusip,
    isin: null,
    name: match[1] === "" ? null : match[1],
  };
}

/**
 * One security's rows -> the one set of cells that is this security's
 * position, or null with a reason when the block does not state one
 * unambiguously.
 *
 * An equity or fund prints one row per tax lot and a
 * `Total` row carrying the aggregate; that row is the position. A bond prints
 * the security on one row and its market value on the detail row beneath it,
 * with no `Total`; there the block's own rows are merged, and a column the
 * position row does not state is filled from another row **only** where that
 * row states it numerically. Without a Total, complete dated lots can be
 * summed; undated value rows and interrupted blocks remain ambiguous.
 */
function positionCells(block, context) {
  const totalRow = block.find(
    ({ bound }) =>
      bound.has("description") === false &&
      /^Total\b/.test(bound.get("tradeDate")?.text ?? ""),
  );
  const valueRows = block.filter(({ bound }) =>
    statesValue(bound.get("marketValue")),
  );
  const datedRows = block.filter(({ bound }) =>
    TRADE_DATE_CELL.test(bound.get("tradeDate")?.text ?? ""),
  );
  if (
    totalRow === undefined &&
    (datedRows.length > 1 || valueRows.length > 1)
  ) {
    return aggregateLotCells(block, datedRows, context);
  }
  const row = totalRow ?? (valueRows.length === 1 ? valueRows[0] : null);
  if (row === null) return null;
  // F1-53: every merged cell carries the line it actually came from
  // (`lineStart`/`page`), row or another line in the block, so a value this
  // position took from elsewhere still cites the line that stated it.
  const withLine = (cell, source) => ({
    ...cell,
    lineStart: source.start,
    page: source.page,
  });
  // Fill only from rows that agree: a column several rows state differently
  // (a per-lot cost, say) stays unfilled rather than taking one lot's number
  // as the whole position's.
  const merged = new Map(
    [...row.bound].map(([name, cell]) => [name, withLine(cell, row)]),
  );
  for (const name of [
    "quantity",
    "price",
    "costBasis",
    "unrealized",
    "marketValue",
  ]) {
    if (statesValue(merged.get(name))) continue;
    const stated = new Map();
    for (const other of block) {
      if (other === row) continue;
      const cell = other.bound.get(name);
      if (!statesValue(cell)) continue;
      // Compared as numbers, not as text: the same price is printed "$318.400"
      // on a security's first lot and "318.400" on the rest.
      const { value } = resolveStatementMoney(cell.text);
      if (value !== null) stated.set(value, withLine(cell, other));
    }
    if (stated.size === 1) merged.set(name, [...stated.values()][0]);
    else merged.delete(name);
  }
  return { row, merged };
}

/** Only fully dated lot rows belong to this fallback. A detail/value row
 * without a date could be a subtotal, so it must not enter the sum. Missing
 * secondary fields stay null; every required cell and every price must be
 * readable, and prices must agree. No quantity-times-price inference. */
function aggregateLotCells(block, lots, context) {
  if (
    context.allowLotAggregation === false ||
    context.description === null ||
    lots.length < 2 ||
    lots.length !== block.length ||
    lots.some((row) => row.conflictingCells)
  )
    return null;

  const merged = new Map();
  for (const name of [
    "quantity",
    "marketValue",
    "price",
    "costBasis",
    "unrealized",
  ]) {
    const cells = lots.map((row) => {
      const cell = row.bound.get(name);
      return cell === undefined
        ? null
        : {
            ...cell,
            lineStart: row.start,
            page: row.page,
            value: resolveStatementMoney(cell.text).value,
          };
    });
    if (cells.some((cell) => cell?.value == null)) {
      if (["quantity", "marketValue", "price"].includes(name)) return null;
      continue;
    }
    if (name === "price") {
      if (new Set(cells.map((cell) => cell.value)).size !== 1) return null;
      merged.set(name, cells[0]);
      continue;
    }
    const sum = cells.reduce(
      (total, cell) => addDecimal(total, cell.value),
      "0",
    );
    // This text is calculated, never presented as a quote from one lot.
    merged.set(name, { text: sum, sources: cells });
  }
  return { row: lots[0], merged, lotCount: lots.length };
}

/** The label this table actually printed over the column the position's value
 * is read from: `Market Value`, or the NAV-priced fund table's bare `Value`
 * (F1-61). Used only to name the column in a note. */
function valueColumnLabel(columns) {
  return (
    columns.find((column) => column.name === "marketValue")?.text ??
    "Market Value"
  );
}

/**
 * F1-76. Why this position states no value, told apart. `boundCell` returns
 * null for a column no row of the block states a value in, and passing that
 * through `resolveStatementMoney("")` collapsed three different facts into
 * the one note `no value stated ("")`:
 *
 * - the statement printed its own "none" here (an em dash, an empty cell),
 * - this parser bound no cell under the column on any of the security's rows,
 * - the position's own row states none and the security's other rows do not
 *   agree on one, which `positionCells` already refused to choose between.
 *
 * Only the second is a parser gap a reviewer can do anything about, and
 * `importer.ts` carries this note verbatim as the `ambiguous_market_value`
 * item's reason, so the three have to read differently. None of them is a
 * value, and none is inferred into one: this only names the absence.
 */
function unstatedValue(block, name, label) {
  const printed = block.flatMap(({ bound }) => {
    const cell = bound.get(name);
    return cell === undefined ? [] : [cell];
  });
  if (printed.length === 0) {
    return {
      value: null,
      note: `no ${label} cell bound on this security's ${block.length} row(s)`,
    };
  }
  const blank = printed.find((cell) => !statesValue(cell));
  // Quoted exactly as the statement printed it, which is the evidence that
  // the source stated no value rather than that this parser found no cell.
  if (blank !== undefined) return resolveStatementMoney(blank.text);
  return {
    value: null,
    note:
      `this position's row states no ${label} and the security's other ${block.length - 1} ` +
      "row(s) do not agree on one, so none is read",
  };
}

function positionFromBlock(block, columns, context) {
  const resolved = positionCells(block, context);
  if (resolved === null) {
    // F1-61. Two different failures used to share one sentence. A table with
    // no value column this parser reads (the aggregate private-holdings
    // table, whose only value column is `Value + Distributions`) states no
    // value for any of its securities, which is not the same as a block whose
    // several valued lots disagree.
    return {
      position: null,
      gapCode: columns.some((column) => column.name === "marketValue")
        ? "unresolved_lots"
        : "unsupported_value_column",
      reason: columns.some((column) => column.name === "marketValue")
        ? `security block over ${block.length} line(s) states neither a Total row nor a single ` +
          "valued lot, and is not a complete set of dated lots with readable quantity, " +
          "market value and agreeing prices"
        : `the ${context.section} holdings table states no Market Value or NAV column this ` +
          `parser reads, so this security block over ${block.length} line(s) states no value ` +
          "to record",
    };
  }
  // A Total or dated lot at the top of a continuation page does not identify
  // a new security. Without the security start from this table (or a proven
  // carried block), retaining it as an anonymous position would publish a
  // fragment after rejecting the prefix. The original text remains retained.
  if (context.description === null) {
    return {
      position: null,
      gapCode: "missing_security_start",
      reason: "holding continuation has no proven security start",
    };
  }
  const { row, merged } = resolved;
  const boundCell = (name) =>
    statesValue(merged.get(name)) ? merged.get(name) : null;
  const span = (name, fieldLabel) => {
    const c = boundCell(name);
    if (c === null) return null;
    if (c.sources) {
      return {
        ...locator(
          context.kind,
          row.page,
          `${fieldLabel} / sum of ${resolved.lotCount} dated lots`,
        ),
        calculation: {
          format: "decimal_sum_v1",
          terms: c.sources.map(
            (source, index) =>
              spanLocator(
                context.kind,
                source.page,
                `${context.section} / ${name} / lot ${index + 1}`,
                context.textMeta,
                source.lineStart + source.start,
                source.lineStart + source.end,
                source.text,
              ).binding,
          ),
        },
      };
    }
    return spanLocator(
      context.kind,
      c.page,
      fieldLabel,
      context.textMeta,
      c.lineStart + c.start,
      c.lineStart + c.end,
      c.text,
    );
  };
  const marketValueCell = boundCell("marketValue");
  const marketValue =
    marketValueCell === null
      ? unstatedValue(block, "marketValue", valueColumnLabel(columns))
      : resolveStatementMoney(marketValueCell.text);
  const quantityCell = boundCell("quantity");
  const quantity =
    quantityCell === null ? null : resolveStatementMoney(quantityCell.text);
  const priceCell = boundCell("price");
  const price =
    priceCell === null ? null : resolveStatementMoney(priceCell.text);
  const costBasisCell = boundCell("costBasis");
  const costBasis =
    costBasisCell === null ? null : resolveStatementMoney(costBasisCell.text);
  const unrealizedCell = boundCell("unrealized");
  const unrealized =
    unrealizedCell === null ? null : resolveStatementMoney(unrealizedCell.text);
  const rowLocator = locator(
    context.kind,
    row.page,
    `${context.section} / ${context.description ?? "holding"}`,
  );
  const lotLocators = {};
  for (const [name, cell] of merged) {
    for (const [index, source] of (cell.sources ?? []).entries()) {
      lotLocators[`${name}.lot.${index + 1}`] = spanLocator(
        context.kind,
        source.page,
        `${context.section} / ${name} / lot ${index + 1}`,
        context.textMeta,
        source.lineStart + source.start,
        source.lineStart + source.end,
        source.text,
      );
    }
  }

  // Keyed on the printed label, not the resolved column name: F1-61's
  // NAV-priced fund table resolves its `Value` column to the market value
  // field, and the basis that value is carried at is still the reported NAV.
  const hasMarketValueColumn = columns.some(
    (column) => column.text === "Market Value",
  );
  const valuationBasis = hasMarketValueColumn
    ? "market_price"
    : columns.some((column) => column.text === "NAV")
      ? "reported_nav"
      : null;
  const valuationNote = hasMarketValueColumn
    ? `Market Value column of the ${context.section} holdings table`
    : valuationBasis === "reported_nav"
      ? `NAV column of the ${context.section} holdings table`
      : `the ${context.section} holdings table states no Market Value or NAV column, so the ` +
        "basis this value is carried at is not stated and is not inferred";

  return {
    position: {
      sourceDocument: "statement",
      ...accountKeyField(context.accountKey ?? null),
      asOf: context.asOf,
      instrument: resolveInstrument(
        context.description,
        block
          .map(({ bound }) => bound.get("description")?.text ?? "")
          .join(" "),
      ),
      quantity: quantity?.value ?? null,
      price: price?.value ?? null,
      marketValue: marketValue.value,
      marketValueNote: marketValue.note,
      costBasis: costBasis?.value ?? null,
      unrealized: unrealized?.value ?? null,
      currency: BASE_CURRENCY,
      valuationBasis,
      valuationNote: resolved.lotCount
        ? `${valuationNote}; summed from ${resolved.lotCount} dated lots without a printed Total row`
        : valuationNote,
      locators: {
        ...lotLocators,
        row: rowLocator,
        marketValue:
          marketValue.value === null
            ? rowLocator
            : span("marketValue", `${context.section} / Market Value`),
        ...(quantity?.value == null
          ? {}
          : { quantity: span("quantity", `${context.section} / Quantity`) }),
        ...(price?.value == null
          ? {}
          : { price: span("price", `${context.section} / Price`) }),
        ...(costBasis?.value == null
          ? {}
          : {
              costBasis: span("costBasis", `${context.section} / Cost Basis`),
            }),
        ...(context.accountLocator === null ||
        context.accountLocator === undefined
          ? {}
          : { account: context.accountLocator }),
      },
    },
    gapCode: null,
    reason: null,
  };
}

function finalPageEvidence(
  lines,
  kind,
  textMeta,
  printedByPage,
  populatedPages,
) {
  const lastPage = Math.max(...populatedPages);
  const declaration = printedByPage.get(lastPage);
  if (
    declaration === null ||
    declaration === undefined ||
    declaration.number !== declaration.total ||
    !printedPageSequenceIsAnchored(lastPage, printedByPage, populatedPages)
  ) {
    return null;
  }
  // The printed declaration proves which physical page is final. The evidence
  // boundary itself must follow everything parsed on that page; a `Page n of
  // n` line at the top cannot bound rows printed beneath it.
  const lineIndex = lines.findLastIndex((line) => line.page === lastPage);
  return lineIndex === -1
    ? null
    : {
        lineIndex,
        locator: lineSpanLocator(
          lines[lineIndex],
          kind,
          "verified end of retained statement",
          textMeta,
        ),
      };
}

function accountBoundaryAfter(lines, afterIndex, accountKey, kind, textMeta) {
  for (let i = afterIndex + 1; i < lines.length; i += 1) {
    const match = BARE_ACCOUNT_LINE.exec(lines[i].text);
    if (match !== null && match[1] !== accountKey) {
      return {
        lineIndex: i,
        locator: lineSpanLocator(
          lines[i],
          kind,
          "next account boundary",
          textMeta,
        ),
      };
    }
  }
  return null;
}

/**
 * Observe a holdings-shaped table the row parser does not support without
 * putting that table into the row parser's control flow. This separation is
 * deliberate: completeness metadata may become more conservative, but it
 * must not change which holdings the established parser emits.
 */
function unsupportedHoldingsTableObservations({
  lines,
  kind,
  accountKeys,
  markerLines,
  textMeta,
  printedByPage,
  populatedPages,
}) {
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (
      HOLDINGS_HEADER.test(lines[i].text) ||
      !POSSIBLE_HOLDINGS_HEADER.test(lines[i].text) ||
      REALIZED_TABLE.test(lines[i].text)
    ) {
      continue;
    }
    const columns = headerColumns(lines[i].text);
    if (
      columns.length < 2 ||
      columns.some((column) => column.name === "description")
    ) {
      continue;
    }
    const marker = markerLines[i];
    const hasExplicitSection = lines
      .slice(Math.max(0, i - 6, marker === null ? 0 : marker + 1), i)
      .filter((line) => line.page === lines[i].page)
      .some(({ text }) => explicitHoldingsSection(text) !== null);
    if (!hasExplicitSection) continue;

    let terminalIndex = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (
        TABLE_END.test(lines[j].text.trim()) ||
        observedHoldingsHeader(lines[j].text) ||
        BARE_ACCOUNT_LINE.test(lines[j].text)
      ) {
        terminalIndex = j;
        break;
      }
    }
    const finalEvidence = finalPageEvidence(
      lines,
      kind,
      textMeta,
      printedByPage,
      populatedPages,
    );
    const evidenceEnd =
      terminalIndex !== null
        ? {
            lineIndex: terminalIndex,
            locator: lineSpanLocator(
              lines[terminalIndex],
              kind,
              "unsupported holdings table end",
              textMeta,
            ),
          }
        : finalEvidence !== null && finalEvidence.lineIndex > i
          ? finalEvidence
          : null;
    tables.push({
      accountKey: accountKeys[i],
      accountLocator: accountSpanLocator(lines, markerLines, i, kind, textMeta),
      headers: [
        lineSpanLocator(
          lines[i],
          kind,
          "unsupported holdings table header",
          textMeta,
        ),
      ],
      end: evidenceEnd?.locator ?? null,
      gapCodes: new Set(["unsupported_table_header"]),
      emittedPositionCount: 0,
      firstLineIndex: i,
      lastLineIndex: evidenceEnd?.lineIndex ?? i,
    });
  }
  return tables;
}

function positionScopesFromTables({
  lines,
  kind,
  asOf,
  tables,
  namesAccounts,
  textMeta,
  printedByPage,
  populatedPages,
  explicitNone,
}) {
  const finalEvidence = finalPageEvidence(
    lines,
    kind,
    textMeta,
    printedByPage,
    populatedPages,
  );
  if (
    explicitNone !== null &&
    tables.length === 0 &&
    !namesAccounts &&
    finalEvidence !== null
  ) {
    return [
      {
        sourceDocument: "statement",
        asOf,
        proofVersion: "position_scope_v1",
        status: "complete",
        emittedPositionCount: 0,
        gapCodes: [],
        zeroBasis: "source_stated_none",
        evidence: {
          tables: [],
          scopeEnd: finalEvidence.locator,
          explicitNone,
        },
      },
    ];
  }

  const grouped = new Map();
  for (const table of tables) {
    // A table before the first account marker in a consolidated statement has
    // no safe account identity. Omitting a scope keeps the document-wide parse
    // note as the conservative signal; falling back to the pull account here
    // would turn a household section into one account's proof.
    if (namesAccounts && table.accountKey === null) continue;
    const key = table.accountKey ?? "";
    const group = grouped.get(key) ?? {
      accountKey: table.accountKey,
      accountLocator: table.accountLocator,
      tables: [],
      gapCodes: new Set(),
      emittedPositionCount: 0,
      lastLineIndex: table.lastLineIndex,
    };
    if (group.accountLocator === null && table.accountLocator !== null)
      group.accountLocator = table.accountLocator;
    group.tables.push(table);
    group.emittedPositionCount += table.emittedPositionCount;
    group.lastLineIndex = Math.max(group.lastLineIndex, table.lastLineIndex);
    for (const code of table.gapCodes) group.gapCodes.add(code);
    grouped.set(key, group);
  }

  const scopes = [];
  for (const group of grouped.values()) {
    const boundary =
      group.accountKey === null
        ? null
        : accountBoundaryAfter(
            lines,
            group.lastLineIndex,
            group.accountKey,
            kind,
            textMeta,
          );
    const scopeEnd = boundary ?? finalEvidence;
    if (scopeEnd === null) group.gapCodes.add("unbounded_account_scope");
    for (const table of group.tables) {
      if (
        table.end === null &&
        boundary !== null &&
        boundary.lineIndex > table.lastLineIndex
      ) {
        table.end = boundary.locator;
      } else if (
        table.end === null &&
        finalEvidence !== null &&
        finalEvidence.lineIndex > table.lastLineIndex
      ) {
        table.end = finalEvidence.locator;
      }
    }
    if (group.tables.some((table) => table.end === null))
      group.gapCodes.add("unbounded_account_scope");
    if (group.emittedPositionCount === 0) group.gapCodes.add("unproven_empty");

    const proofPages = [
      ...group.tables.flatMap((table) => [
        ...table.headers.map((header) => header.index),
        ...(table.end === null ? [] : [table.end.index]),
      ]),
      ...(scopeEnd === null ? [] : [scopeEnd.locator.index]),
    ];
    if (
      proofPages.some(
        (page) =>
          !printedPageSequenceIsAnchored(page, printedByPage, populatedPages),
      )
    ) {
      group.gapCodes.add("page_sequence_gap");
    }

    const gapCodes = [...group.gapCodes].sort();
    scopes.push({
      sourceDocument: "statement",
      ...(group.accountKey === null
        ? {}
        : { accountExternalKey: group.accountKey }),
      asOf,
      proofVersion: "position_scope_v1",
      status: gapCodes.length === 0 ? "complete" : "partial",
      emittedPositionCount: group.emittedPositionCount,
      gapCodes,
      evidence: {
        ...(group.accountLocator === null
          ? {}
          : { account: group.accountLocator }),
        tables: group.tables.map((table) => ({
          headers: table.headers,
          ...(table.end === null ? {} : { end: table.end }),
        })),
        ...(scopeEnd === null ? {} : { scopeEnd: scopeEnd.locator }),
      },
    });
  }
  return scopes;
}

/** Every holdings table in the document -> positions, plus both the legacy
 * document-wide skipped reasons and optional positive account/date proofs.
 * `accountKeys` is `accountKeysByLine`'s per-line array, so each observation
 * stays attributed to the account whose pages carried the table. */
function parseHoldings(
  lines,
  kind,
  asOf,
  accountKeys,
  markerLines,
  textMeta,
  namesAccounts,
  explicitNone,
) {
  const positions = [];
  const skipped = [];
  const tables = [];
  const printedByPage = printedPages(lines);
  const populatedPages = new Set(lines.map(({ page }) => page));
  const emit = (block, columns, context, table) => {
    if (block.length === 0) return;
    const { position, reason, gapCode } = positionFromBlock(
      block,
      columns,
      context,
    );
    if (position === null) {
      skipped.push(reason);
      table.gapCodes.add(gapCode);
    } else {
      positions.push(position);
      table.emittedPositionCount += 1;
    }
  };

  // F1-61. A security block a page footer interrupted, waiting for the same
  // table schema to be reprinted on the next page. The proof object travels
  // with the carried block, so a continuation cannot look like two complete
  // tables and a missing successor cannot look complete at all.
  let carried = null;
  const flushCarried = (
    nextAccountKey = null,
    nextMarker = null,
    nextHeaderIndex = null,
  ) => {
    if (carried === null) return;
    const independentlyComplete =
      positionFromBlock(carried.block, carried.columns, {
        ...carried.context,
        allowLotAggregation: false,
      }).position !== null;
    if (nextMarker !== null && nextAccountKey !== carried.context.accountKey) {
      carried.table.end = lineSpanLocator(
        lines[nextMarker],
        kind,
        "holdings table account boundary",
        textMeta,
      );
      const contiguousGlobalRun = printedPageRunContinuesThrough(
        carried.page,
        lines[nextMarker].page,
        printedByPage,
        populatedPages,
      );
      const priorAccountRunEnded = printedPageRunEndsAt(
        carried.page,
        lines[nextMarker].page - 1,
        printedByPage,
        populatedPages,
      );
      // A new account's own Page 1 can start a valid local run, but it cannot
      // prove that the prior account's declared successor page was retained.
      // A final declaration or a contiguous global run can.
      if (
        !carried.finalPageFooter &&
        !contiguousGlobalRun &&
        !priorAccountRunEnded
      ) {
        carried.table.gapCodes.add("page_sequence_gap");
      }
    } else if (nextHeaderIndex !== null) {
      // A different recognized table header closes a complete preceding
      // security block even when a leading page declaration caused the old
      // row parser to carry it until seeing this header. This affects proof
      // bounds only; `emit` below is the same established row path.
      if (independentlyComplete) {
        carried.table.end = lineSpanLocator(
          lines[nextHeaderIndex],
          kind,
          "next holdings table boundary",
          textMeta,
        );
      } else {
        carried.table.gapCodes.add("page_sequence_gap");
      }
    } else if (
      carried.finalPageFooter &&
      !lines.some(
        (line, index) =>
          index > carried.footerIndex && line.page === carried.footerPage,
      ) &&
      printedPageSequenceIsAnchored(
        carried.footerPage,
        printedByPage,
        populatedPages,
      )
    ) {
      carried.table.end = lineSpanLocator(
        lines[carried.footerIndex],
        kind,
        "holdings table end",
        textMeta,
      );
    } else {
      carried.table.gapCodes.add("page_sequence_gap");
    }
    emit(carried.block, carried.columns, carried.context, carried.table);
    carried = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (!HOLDINGS_HEADER.test(lines[i].text)) continue;
    if (REALIZED_TABLE.test(lines[i].text)) continue;
    const marker = markerLines[i];
    const accountKey = accountKeys[i];
    const accountLocator = accountSpanLocator(
      lines,
      markerLines,
      i,
      kind,
      textMeta,
    );
    const columns = resolveValueColumn(headerColumns(lines[i].text));
    if (!columns.some((column) => column.name === "description")) continue;
    const sectionLines = lines
      .slice(Math.max(0, i - 6, marker === null ? 0 : marker + 1), i)
      .filter((line) => line.page === lines[i].page);
    const explicitSection = sectionLines
      .map(({ text }) => explicitHoldingsSection(text))
      .findLast((title) => title !== null);
    let section = explicitSection ?? "HOLDINGS";
    const headerSignature = holdingsHeaderSignature(columns);
    const continues =
      carried !== null &&
      carried.headerSignature === headerSignature &&
      carried.context.accountKey === accountKey &&
      (explicitSection === undefined ||
        explicitSection === explicitHoldingsSection(carried.context.section)) &&
      continuesOnAdjacentPrintedPage(
        carried,
        lines[i],
        printedByPage,
        populatedPages,
      );

    let block = [];
    let description = null;
    let table;
    if (continues) {
      block = carried.block;
      description = carried.description;
      section = carried.context.section;
      table = carried.table;
      table.headers.push(
        lineSpanLocator(
          lines[i],
          kind,
          "continued holdings table header",
          textMeta,
        ),
      );
      table.lastLineIndex = i;
      carried = null;
    } else {
      flushCarried(accountKey, marker, i);
      table = {
        accountKey,
        accountLocator,
        headers: [
          lineSpanLocator(lines[i], kind, "holdings table header", textMeta),
        ],
        end: null,
        gapCodes: new Set(),
        emittedPositionCount: 0,
        firstLineIndex: i,
        lastLineIndex: i,
      };
      tables.push(table);
    }

    const context = {
      kind,
      asOf,
      section,
      accountKey,
      accountLocator,
      textMeta,
    };
    const flush = () => {
      emit(block, columns, { ...context, section, description }, table);
      block = [];
    };

    let inSummary = false;
    let interruptedByPageFooter = false;
    let finalPageFooter = false;
    let terminalIndex = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const text = lines[j].text;
      const trimmed = text.trim();
      if (TABLE_END.test(trimmed) || HOLDINGS_HEADER.test(text)) {
        terminalIndex = j;
        interruptedByPageFooter = PAGE_FOOTER.test(trimmed);
        break;
      }
      if (ASSET_CLASS.test(trimmed)) continue;
      if (SECTION_SUMMARY.test(trimmed)) {
        flush();
        inSummary = true;
        i = j;
        table.lastLineIndex = j;
        continue;
      }
      const { bound, conflictingCells } = bindRow(text, columns);
      if (bound.size === 0) continue;
      if (bound.size === 1 && bound.has("description")) continue;
      const startsSecurity =
        bound.has("description") &&
        bound.has("tradeDate") &&
        (!inSummary || TRADE_DATE_CELL.test(bound.get("tradeDate").text));
      if (inSummary && !startsSecurity) {
        i = j;
        table.lastLineIndex = j;
        continue;
      }
      if (startsSecurity) {
        inSummary = false;
        flush();
        description = bound.get("description").text;
      }
      block.push({
        bound,
        conflictingCells,
        page: lines[j].page,
        start: lines[j].start,
      });
      i = j;
      table.lastLineIndex = j;
    }
    if (terminalIndex !== null) table.lastLineIndex = terminalIndex;
    if (interruptedByPageFooter) {
      const contentPageDeclaration = printedByPage.get(lines[i].page);
      finalPageFooter =
        contentPageDeclaration !== null &&
        contentPageDeclaration !== undefined &&
        contentPageDeclaration.number === contentPageDeclaration.total;
      carried = {
        block,
        description,
        columns,
        context: {
          ...context,
          section,
          description,
          allowLotAggregation:
            finalPageFooter &&
            printedPageSequenceIsAnchored(
              lines[i].page,
              printedByPage,
              populatedPages,
            ),
        },
        headerSignature,
        // Parsing topology is based on the last content row's physical page.
        // The next printed `Page N` line is leading furniture on the next
        // physical page in retained extraction, not the page that was cut.
        page: lines[i].page,
        footerPage: lines[terminalIndex].page,
        footerIndex: terminalIndex,
        finalPageFooter,
        table,
      };
    } else {
      flush();
      if (terminalIndex !== null) {
        table.end = lineSpanLocator(
          lines[terminalIndex],
          kind,
          "holdings table end",
          textMeta,
        );
      } else {
        const finalEvidence = finalPageEvidence(
          lines,
          kind,
          textMeta,
          printedByPage,
          populatedPages,
        );
        if (finalEvidence === null) {
          table.gapCodes.add("unbounded_account_scope");
        } else {
          table.end = finalEvidence.locator;
          table.lastLineIndex = finalEvidence.lineIndex;
        }
      }
    }
  }
  flushCarried();
  tables.push(
    ...unsupportedHoldingsTableObservations({
      lines,
      kind,
      accountKeys,
      markerLines,
      textMeta,
      printedByPage,
      populatedPages,
    }),
  );
  tables.sort((left, right) => left.firstLineIndex - right.firstLineIndex);
  const positionScopes = positionScopesFromTables({
    lines,
    kind,
    asOf,
    tables,
    namesAccounts,
    textMeta,
    printedByPage,
    populatedPages,
    explicitNone,
  });
  return { positions, skipped, positionScopes };
}

// --- entry point ------------------------------------------------------------

/** True when this text is a real CLIENT STATEMENT rather than the synthetic
 * pipe-delimited fixture grammar. */
export function isRealStatementLayout(text) {
  return /^\s*CLIENT STATEMENT\b/m.test(text);
}

/**
 * The real layout -> ParsedPull. F1-46: a consolidated statement covering
 * several accounts is no longer refused. `ParsedPosition`, `ParsedBalance`
 * and `ParsedLiability` now carry the same optional `accountExternalKey`
 * `ParsedRow` always has, resolved per account section via
 * `accountKeysByLine` (README, "Statement layout" / "Consolidated
 * statements") -- one `BALANCE SHEET` anchor and one run of holdings tables
 * per account, each attributed to the account whose running page header
 * they were printed under. A single-account statement has exactly one such
 * header, constant throughout, so every holding still resolves to that one
 * account exactly as before this field existed.
 */
export function parseRealStatement(text, kind) {
  const lines = pagedLines(text);
  const { keys: accountKeys, markerLines } = accountKeysByLine(lines);
  // F1-53. The retained text's own identity, computed once from the exact
  // string the archive retains at `documents.text_path`, and carried onto
  // every evidence span this parse produces.
  const textMeta = textMetaOf(text);
  const periodLocator = statementPeriodLocator(lines, kind, textMeta);
  const printedByPage = printedPages(lines);
  const populatedPages = new Set(lines.map(({ page }) => page));

  const period = resolvePeriod(lines);
  if (period === null) {
    // F1-61. The cash activity summary is a different document, not a
    // statement this failed to read, and saying so is what keeps the review
    // queue about statements whose layout still needs work.
    const activityOnly =
      lines.some(({ text: line }) => ACTIVITY_DATE_COLUMN.test(line)) &&
      !lines.some(({ text: line }) => HOLDINGS_HEADER.test(line)) &&
      !lines.some(({ text: line }) => BALANCE_SHEET_ANCHOR.test(line));
    return {
      activity: [],
      holdings: EMPTY_HOLDINGS,
      parseNote: activityOnly
        ? "not parsed: this document is a cash activity summary, not a holdings statement: " +
          "it prints an Activity Date table and no period line, no BALANCE SHEET and no " +
          "holdings table. This institution's activity is read from the structured_api tier, " +
          "so there is nothing here for this parser to read"
        : "not parsed: no 'For the Period <Month> D-DD, YYYY' line, so the statement's own " +
          "period is unknown and every as-of date on it would be a guess",
    };
  }

  // One BALANCE SHEET anchor per account (a consolidated statement repeats
  // it once per account's own first page); a false-positive match elsewhere
  // (disclosure text mentioning the phrase, say) has no TOTAL VALUE row
  // nearby and parseBalanceSheet returns null for it, contributing nothing.
  const sheets = [];
  const observedBalanceScopes = [];
  const balanceObservationCounts = new Map();
  // F1-8l. A document that names accounts at all, and then prints a BALANCE
  // SHEET section under no account header of its own, is a consolidated
  // statement printing its `Consolidated Summary` roll-up: the household
  // total across every account in the PDF, not any one account's balance.
  // `accountKeysByLine` attributes that section to no account, which is
  // correct, and `finance-archive`'s importer then falls back to the
  // document's own account (`balance.accountId ?? document.accountId`) --
  // recording the roll-up as that one account's own stated balance, beside
  // that account's real section: two balances for one (account, as_of).
  // There is no household-level snapshot in the schema, so this section
  // is omitted and the parse note records the missing attribution.
  //
  // `namesAccounts` is what keeps this from swallowing the other reason a
  // section carries no account key: a document that names no account anywhere
  // states holdings for the one account the pull already named, which is the
  // adapter contract an omitted `accountExternalKey` has always meant.
  const namesAccounts = accountKeys.some((key) => key !== null);
  let unattributedSections = 0;
  lines.forEach(({ text: line }, anchorIndex) => {
    if (!BALANCE_SHEET_ANCHOR.test(line)) return;
    const accountKey = accountKeys[anchorIndex];
    if (accountKey !== null) {
      balanceObservationCounts.set(
        accountKey,
        (balanceObservationCounts.get(accountKey) ?? 0) + 1,
      );
    }
    const observed = parseBalanceSheet(
      lines,
      anchorIndex,
      kind,
      accountKeys[anchorIndex],
      markerLines,
      textMeta,
      printedByPage,
      populatedPages,
    );
    if (observed.balanceScope !== null)
      observedBalanceScopes.push(observed.balanceScope);
    if (observed.sheet === null) return;
    const sheet = observed.sheet;
    if (namesAccounts && sheet.balance.accountExternalKey === undefined) {
      unattributedSections += 1;
      return;
    }
    sheets.push(sheet);
  });
  // Banner parsing intentionally reads only the first matching source row.
  // Count every explicit-account banner independently so a second numeric,
  // empty, or malformed sibling cannot disappear and leave a unique proof.
  lines.forEach(({ text: line }, lineIndex) => {
    if (!TOTAL_VALUE_BANNER.test(line)) return;
    const accountKey = accountKeys[lineIndex];
    if (accountKey === null) return;
    balanceObservationCounts.set(
      accountKey,
      (balanceObservationCounts.get(accountKey) ?? 0) + 1,
    );
  });
  // F1-61. A statement with no BALANCE SHEET block still states its account
  // total on the cover page. The banner is read only here, as the fallback:
  // where a BALANCE SHEET exists it is the better source, stating the cash
  // and the liability too.
  const banner =
    sheets.length === 0
      ? parseTotalValueBanner(
          lines,
          kind,
          period.end,
          accountKeys,
          markerLines,
          textMeta,
          periodLocator,
          printedByPage,
          populatedPages,
        )
      : null;
  if (banner?.balanceScope !== null && banner?.balanceScope !== undefined)
    observedBalanceScopes.push(banner.balanceScope);
  if (banner?.balance !== undefined) {
    // The same rule as above: on a statement that does name accounts, a
    // banner printed before the first account header names none this parser
    // can bind it to, so it is not recorded against whichever account the
    // pull happened to name.
    if (namesAccounts && banner.balance.accountExternalKey === undefined) {
      unattributedSections += 1;
    } else {
      sheets.push({ balance: banner.balance, liabilities: [] });
    }
  }

  const { positions, skipped, positionScopes } = parseHoldings(
    lines,
    kind,
    period.end,
    accountKeys,
    markerLines,
    textMeta,
    namesAccounts,
    banner?.statedNone === true ? banner.locator : null,
  );
  // More than one emitted section for the same account/date cannot be a
  // one-row replacement proof. Omit that selector entirely so downstream
  // correction stays fail-closed rather than picking an arbitrary section.
  const balanceScopeCounts = new Map();
  for (const scope of observedBalanceScopes) {
    const key = `${scope.accountExternalKey}\0${scope.asOf}`;
    balanceScopeCounts.set(key, (balanceScopeCounts.get(key) ?? 0) + 1);
  }
  const balanceScopes = observedBalanceScopes.filter(
    (scope) =>
      balanceObservationCounts.get(scope.accountExternalKey) === 1 &&
      balanceScopeCounts.get(`${scope.accountExternalKey}\0${scope.asOf}`) ===
        1,
  );

  const notes = [];
  if (unattributedSections > 0) {
    notes.push(
      `${unattributedSections} BALANCE SHEET section(s) printed before any account header ` +
        "were not recorded: a consolidated statement's Consolidated Summary section states " +
        "the household roll-up across every account in the document, not any one account's " +
        "own balance, and this schema has no household-level snapshot to record it as",
    );
  }
  if (sheets.length === 0) {
    // The cover page stating the em dash is the statement saying this account
    // holds nothing, which -- with no holdings table either -- is a document
    // read in full, not one with a balance missing from it.
    if (!(banner?.statedNone === true && positions.length === 0)) {
      notes.push(
        "no readable BALANCE SHEET block, so no account total, cash or liability was recorded",
      );
    }
  }
  if (skipped.length > 0) {
    notes.push(
      `${skipped.length} holdings block(s) left unparsed: ${skipped[0]}`,
    );
  }

  return {
    activity: [],
    holdings: {
      positions,
      balances: sheets.map((sheet) => sheet.balance),
      liabilities: sheets.flatMap((sheet) => sheet.liabilities),
      ...(positionScopes.length === 0 ? {} : { positionScopes }),
      ...(balanceScopes.length === 0 ? {} : { balanceScopes }),
    },
    ...(notes.length > 0
      ? { parseNote: `partially parsed: ${notes.join("; ")}` }
      : {}),
  };
}
