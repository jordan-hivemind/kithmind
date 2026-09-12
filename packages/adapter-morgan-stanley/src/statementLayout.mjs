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
/** The one period spelling the corpus uses: "For the Period March 1-31, 2026". */
const PERIOD_LINE =
  /For the Period\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})-(\d{1,2}),\s*(\d{4})/;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
/** A cell boundary: the layout puts at least two spaces between columns. */
const CELL_GAP = /\s{2,}/;
/** How far a cell edge may sit from a header edge and still be that column. */
const EDGE_TOLERANCE = 3;
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
function bindColumn(cell, columns) {
  let best = null;
  for (const column of columns) {
    const error = Math.min(Math.abs(cell.end - column.end), Math.abs(cell.start - column.start));
    if (error > EDGE_TOLERANCE) continue;
    if (best === null || error < best.error) best = { column, error };
  }
  return best?.column ?? null;
}

/** A line's cells keyed by the column each one binds to. A cell that lines up
 * with no column is dropped: every column this parser reads is named in
 * HOLDINGS_COLUMNS, so a cell outside all of them is a column it does not
 * read (an Est Ann Income, a Yield %), not a value going missing. */
function bindRow(line, columns) {
  const bound = new Map();
  for (const cell of splitCells(line)) {
    const column = bindColumn(cell, columns);
    if (column !== null && !bound.has(column.name)) bound.set(column.name, cell);
  }
  return { bound };
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
    return { value: negative ? negateDecimal(canonical) : canonical, note: null };
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

/**
 * F1-46. Forward-fills every line with the account key of the nearest
 * preceding `BARE_ACCOUNT_LINE` -- the account whose own pages that line was
 * printed on. `null` for any line before the first such marker (the
 * household-wide summary pages a consolidated statement prints before its
 * first account's own pages; nothing this parser reads lives there). A
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
  return spanLocator(kind, line.page, "account number", textMeta, start, end, match[1]);
}

/** `{ accountExternalKey: key }` when non-null, else `{}` -- spread onto a
 * parsed holding so an unresolved account key (should never happen once a
 * statement's own `BARE_ACCOUNT_LINE` has appeared, but is possible before
 * the first one) leaves the field omitted rather than set to null, matching
 * every other adapter's "omitted means this pull's own account" contract. */
function accountKeyField(key) {
  return key === null ? {} : { accountExternalKey: key };
}

/** "December", "1", "31", "2025" -> ISO period bounds. */
function resolvePeriod(lines) {
  for (const { text } of lines) {
    const match = PERIOD_LINE.exec(text);
    if (match === null) continue;
    const month = String(MONTHS.indexOf(match[1]) + 1).padStart(2, "0");
    const first = match[2].padStart(2, "0");
    const last = match[3].padStart(2, "0");
    return { start: `${match[4]}-${month}-${first}`, end: `${match[4]}-${month}-${last}` };
  }
  return null;
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
function parseBalanceSheet(lines, anchorIndex, kind, accountKey, markerLines, textMeta) {
  const block = lines.slice(anchorIndex, anchorIndex + BALANCE_BLOCK_LINES);
  const headerLine = block.find(({ text }) => (text.match(AS_OF_HEADER) ?? []).length > 0);
  if (headerLine === undefined) return null;
  const asOfCells = splitCells(headerLine.text).filter((cell) => AS_OF_HEADER.test(cell.text));
  if (asOfCells.length !== 2) return null;
  // Printed left to right: last period, then this period.
  const columns = [
    { name: "lastPeriod", ...asOfCells[0] },
    { name: "thisPeriod", ...asOfCells[1] },
  ];
  const page = headerLine.page;
  const rows = {};
  for (const { text, start: lineStart } of block) {
    for (const [name, pattern] of Object.entries(BALANCE_ROWS)) {
      if (rows[name] !== undefined) continue;
      const trimmed = text.trim();
      if (!pattern.test(trimmed)) continue;
      rows[name] = { bound: bindRow(text, columns).bound, lineStart };
    }
  }
  if (rows.totalValue === undefined) return null;

  // F1-53. `span` is null exactly when there is no cell to cite (row or
  // column not printed); `resolveStatementMoney` failing to read a cell that
  // *is* printed still carries a span, over the unparseable text, so a
  // review item and an evidence-yielding parse are not mutually exclusive.
  const read = (row, column, fieldLabel) => {
    if (row === undefined || !row.bound.has(column)) {
      return { value: null, note: "row or column not printed on this statement", locator: null };
    }
    const cell = row.bound.get(column);
    const resolved = resolveStatementMoney(cell.text);
    const start = row.lineStart + cell.start;
    const end = row.lineStart + cell.end;
    return {
      ...resolved,
      locator: spanLocator(kind, page, fieldLabel, textMeta, start, end, cell.text),
    };
  };

  const total = read(rows.totalValue, "thisPeriod", "BALANCE SHEET / TOTAL VALUE");
  const opening = read(rows.totalValue, "lastPeriod", "BALANCE SHEET / TOTAL VALUE (last period)");
  const cash = read(rows.cash, "thisPeriod", "BALANCE SHEET / Cash");
  const asOf = resolveAsOf(columns[1].text);
  const rowLocator = locator(kind, page, "BALANCE SHEET / TOTAL VALUE");
  const accountLocator = accountSpanLocator(lines, markerLines, anchorIndex, kind, textMeta);

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
  const liability = read(rows.liabilities, "thisPeriod", "BALANCE SHEET / Total Liabilities");
  // The em dash means "no liability on this statement", which is a different
  // fact from a zero balance and is not recorded as one.
  if (liability.value !== null) {
    const liabilityLocator = locator(kind, page, "BALANCE SHEET / Total Liabilities");
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
  return { balance, liabilities };
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
/** A security's aggregate row, printed under its per-lot rows. */
const TOTAL_ROW = /^Total\b/;
/** Ends a holdings table. */
const TABLE_END = /^(TOTAL|Total Value|HOLDINGS|CASH FLOW|ACTIVITY|Page \d)/;
/** "Asset Class: Equities", printed under each security block. */
const ASSET_CLASS = /Asset Class:\s*(.+?)\s*$/;
/** "3M COMPANY (MMM)" -> name and symbol; anything else stays a name. */
const NAME_AND_SYMBOL = /^(.*?)\s*\(([A-Z0-9.]{1,8})\)$/;

const HOLDINGS_LABELS = [...HOLDINGS_COLUMNS.keys()].sort((a, b) => b.length - a.length);

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
      const label = HOLDINGS_LABELS.find((candidate) => cell.text.startsWith(candidate, offset));
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

/** "CUSIP 00000WNF1" on a bond's detail line. */
const CUSIP_LABEL = /\bCUSIP\s+([A-Z0-9]{9})\b/;

function resolveInstrument(description, detailText) {
  const labelled = CUSIP_LABEL.exec(detailText ?? "");
  const cusip = labelled === null ? null : labelled[1];
  if (description === null) {
    return cusip === null ? null : { symbol: null, cusip, isin: null, name: null };
  }
  const match = NAME_AND_SYMBOL.exec(description);
  if (match === null) return { symbol: null, cusip, isin: null, name: description };
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
 * Two block shapes occur. An equity or fund prints one row per tax lot and a
 * `Total` row carrying the aggregate; that row is the position. A bond prints
 * the security on one row and its market value on the detail row beneath it,
 * with no `Total`; there the block's own rows are merged, and a column the
 * position row does not state is filled from another row **only** where that
 * row states it numerically. Anything else -- several valued lots and no
 * `Total` -- is genuinely ambiguous and is refused.
 */
function positionCells(block) {
  const totalRow = block.find(
    ({ bound }) =>
      bound.has("description") === false && /^Total\b/.test(bound.get("tradeDate")?.text ?? ""),
  );
  const valueRows = block.filter(({ bound }) => statesValue(bound.get("marketValue")));
  const row = totalRow ?? (valueRows.length === 1 ? valueRows[0] : null);
  if (row === null) return null;
  // F1-53: every merged cell carries the line it actually came from
  // (`lineStart`/`page`), row or another line in the block, so a value this
  // position took from elsewhere still cites the line that stated it.
  const withLine = (cell, source) => ({ ...cell, lineStart: source.start, page: source.page });
  // Fill only from rows that agree: a column several rows state differently
  // (a per-lot cost, say) stays unfilled rather than taking one lot's number
  // as the whole position's.
  const merged = new Map(
    [...row.bound].map(([name, cell]) => [name, withLine(cell, row)]),
  );
  for (const name of ["quantity", "price", "costBasis", "unrealized", "marketValue"]) {
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

function positionFromBlock(block, columns, context) {
  const resolved = positionCells(block);
  if (resolved === null) {
    return {
      position: null,
      reason:
        `security block over ${block.length} line(s) states neither a Total row nor a single ` +
        "valued lot, so no one row is this security's position",
    };
  }
  const { row, merged } = resolved;
  const boundCell = (name) => (statesValue(merged.get(name)) ? merged.get(name) : null);
  const span = (name, fieldLabel) => {
    const c = boundCell(name);
    if (c === null) return null;
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
  const marketValue = resolveStatementMoney(boundCell("marketValue")?.text ?? "");
  const quantityCell = boundCell("quantity");
  const quantity = quantityCell === null ? null : resolveStatementMoney(quantityCell.text);
  const priceCell = boundCell("price");
  const price = priceCell === null ? null : resolveStatementMoney(priceCell.text);
  const costBasisCell = boundCell("costBasis");
  const costBasis = costBasisCell === null ? null : resolveStatementMoney(costBasisCell.text);
  const unrealizedCell = boundCell("unrealized");
  const unrealized = unrealizedCell === null ? null : resolveStatementMoney(unrealizedCell.text);
  const rowLocator = locator(context.kind, row.page, `${context.section} / ${context.description ?? "holding"}`);

  const hasMarketValueColumn = columns.some((column) => column.name === "marketValue");
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
      valuationNote,
      locators: {
        row: rowLocator,
        marketValue: marketValue.value === null ? rowLocator : span("marketValue", `${context.section} / Market Value`),
        ...(quantity?.value == null ? {} : { quantity: span("quantity", `${context.section} / Quantity`) }),
        ...(price?.value == null ? {} : { price: span("price", `${context.section} / Price`) }),
        ...(costBasis?.value == null ? {} : { costBasis: span("costBasis", `${context.section} / Cost Basis`) }),
        ...(context.accountLocator === null || context.accountLocator === undefined
          ? {}
          : { account: context.accountLocator }),
      },
    },
    reason: null,
  };
}

/** Every holdings table in the document -> positions, plus the blocks that
 * could not be read, counted for the parse note. `accountKeys` (F1-46) is
 * `accountKeysByLine`'s per-line array, so each table's positions are
 * attributed to the account whose pages that table was printed on. */
function parseHoldings(lines, kind, asOf, accountKeys, markerLines, textMeta) {
  const positions = [];
  const skipped = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!HOLDINGS_HEADER.test(lines[i].text)) continue;
    if (REALIZED_TABLE.test(lines[i].text)) continue;
    const columns = headerColumns(lines[i].text);
    if (!columns.some((column) => column.name === "description")) continue;
    // The section title is the nearest preceding all-caps line.
    const section =
      [...lines.slice(Math.max(0, i - 6), i)]
        .reverse()
        .map(({ text }) => text.trim())
        .find((text) => /^[A-Z][A-Z0-9 ,&%'/()+^-]{3,}$/.test(text)) ?? "HOLDINGS";
    const accountKey = accountKeys[i];
    // F1-53. One per table, not per position: every position under this
    // header shares the same account-number line.
    const accountLocator = accountSpanLocator(lines, markerLines, i, kind, textMeta);

    let block = [];
    let description = null;
    const flush = () => {
      if (block.length === 0) return;
      const { position, reason } = positionFromBlock(block, columns, {
        kind,
        asOf,
        section,
        description,
        accountKey,
        accountLocator,
        textMeta,
      });
      if (position === null) skipped.push(reason);
      else positions.push(position);
      block = [];
    };

    for (let j = i + 1; j < lines.length; j += 1) {
      const text = lines[j].text;
      const trimmed = text.trim();
      if (TABLE_END.test(trimmed) || HOLDINGS_HEADER.test(text)) break;
      if (ASSET_CLASS.test(trimmed)) continue;
      const { bound } = bindRow(text, columns);
      if (bound.size === 0) continue;
      // A line whose only cell is in the description column is an asset-class
      // heading or a footnote, not a row of the table.
      if (bound.size === 1 && bound.has("description")) continue;
      // A new security starts where a description and a trade date appear
      // together. A description alongside values but no trade date is the
      // detail line beneath the security it belongs to (coupon, maturity,
      // CUSIP) and continues the block it is under.
      if (bound.has("description") && bound.has("tradeDate")) {
        flush();
        description = bound.get("description").text;
      }
      block.push({ bound, page: lines[j].page, start: lines[j].start });
      i = j;
    }
    flush();
  }
  return { positions, skipped };
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

  const period = resolvePeriod(lines);
  if (period === null) {
    return {
      activity: [],
      holdings: EMPTY_HOLDINGS,
      parseNote:
        "not parsed: no 'For the Period <Month> D-DD, YYYY' line, so the statement's own " +
        "period is unknown and every as-of date on it would be a guess",
    };
  }

  // One BALANCE SHEET anchor per account (a consolidated statement repeats
  // it once per account's own first page); a false-positive match elsewhere
  // (disclosure text mentioning the phrase, say) has no TOTAL VALUE row
  // nearby and parseBalanceSheet returns null for it, contributing nothing.
  const sheets = [];
  lines.forEach(({ text: line }, anchorIndex) => {
    if (!BALANCE_SHEET_ANCHOR.test(line)) return;
    const sheet = parseBalanceSheet(
      lines,
      anchorIndex,
      kind,
      accountKeys[anchorIndex],
      markerLines,
      textMeta,
    );
    if (sheet !== null) sheets.push(sheet);
  });
  const { positions, skipped } = parseHoldings(
    lines,
    kind,
    period.end,
    accountKeys,
    markerLines,
    textMeta,
  );

  const notes = [];
  if (sheets.length === 0) {
    notes.push(
      "no readable BALANCE SHEET block, so no account total, cash or liability was recorded",
    );
  }
  if (skipped.length > 0) {
    notes.push(`${skipped.length} holdings block(s) left unparsed: ${skipped[0]}`);
  }

  return {
    activity: [],
    holdings: {
      positions,
      balances: sheets.map((sheet) => sheet.balance),
      liabilities: sheets.flatMap((sheet) => sheet.liabilities),
    },
    ...(notes.length > 0 ? { parseNote: `partially parsed: ${notes.join("; ")}` } : {}),
  };
}
