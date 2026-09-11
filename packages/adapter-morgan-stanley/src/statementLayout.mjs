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

import { canonicalizeDecimal, negateDecimal, EMPTY_HOLDINGS } from "@repo/finance-archive";
import { PAGE_SEPARATOR } from "./pdfText.mjs";

const BASE_CURRENCY = "USD";
/** The provider's own account key, as printed on every page. */
const ACCOUNT_NUMBER = /\b\d{3}-\d{6}-\d{3}\b/g;
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

/** One line's cells, each with the character offsets it occupies. */
function splitCells(text) {
  const cells = [];
  let offset = 0;
  for (const part of text.split(CELL_GAP)) {
    const start = text.indexOf(part, offset);
    if (part.trim() === "") continue;
    cells.push({ text: part.trim(), start, end: start + part.length });
    offset = start + part.length;
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

/** Lines with the page they came from, 1-based, as FieldLocator.index wants. */
function pagedLines(text) {
  const out = [];
  text.split(PAGE_SEPARATOR).forEach((page, pageIndex) => {
    page.split("\n").forEach((line) => {
      if (line.trim() !== "") out.push({ page: pageIndex + 1, text: line });
    });
  });
  return out;
}

function locator(kind, page, field) {
  return { source: kind, index: page, field };
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
 */
function parseBalanceSheet(lines, anchorIndex, kind) {
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
  for (const { text } of block) {
    for (const [name, pattern] of Object.entries(BALANCE_ROWS)) {
      if (rows[name] !== undefined) continue;
      const trimmed = text.trim();
      if (!pattern.test(trimmed)) continue;
      rows[name] = bindRow(text, columns).bound;
    }
  }
  if (rows.totalValue === undefined) return null;

  const read = (row, column) =>
    row === undefined || !row.has(column)
      ? { value: null, note: "row or column not printed on this statement" }
      : resolveStatementMoney(row.get(column).text);

  const total = read(rows.totalValue, "thisPeriod");
  const opening = read(rows.totalValue, "lastPeriod");
  const cash = read(rows.cash, "thisPeriod");
  const asOf = resolveAsOf(columns[1].text);
  const rowLocator = locator(kind, page, "BALANCE SHEET / TOTAL VALUE");

  const balance = {
    sourceDocument: "statement",
    asOf,
    totalValue: total.value,
    totalValueNote: total.note,
    cash: cash.value,
    currency: BASE_CURRENCY,
    periodStartValue: opening.value,
    periodEndValue: total.value,
    locators:
      total.value === null
        ? { row: rowLocator, totalValue: rowLocator }
        : { row: rowLocator },
  };

  const liabilities = [];
  const liability = read(rows.liabilities, "thisPeriod");
  // The em dash means "no liability on this statement", which is a different
  // fact from a zero balance and is not recorded as one.
  if (liability.value !== null) {
    const liabilityLocator = locator(kind, page, "BALANCE SHEET / Total Liabilities");
    liabilities.push({
      sourceDocument: "statement",
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
      locators: { row: liabilityLocator },
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
  // Fill only from rows that agree: a column several rows state differently
  // (a per-lot cost, say) stays unfilled rather than taking one lot's number
  // as the whole position's.
  const merged = new Map(row.bound);
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
      if (value !== null) stated.set(value, cell.text);
    }
    if (stated.size === 1) merged.set(name, { text: [...stated.values()][0] });
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
  const cell = (name) => (statesValue(merged.get(name)) ? merged.get(name).text : null);
  const marketValue = resolveStatementMoney(merged.get("marketValue")?.text ?? "");
  const quantity = cell("quantity") === null ? null : resolveStatementMoney(cell("quantity"));
  const price = cell("price") === null ? null : resolveStatementMoney(cell("price"));
  const costBasis = cell("costBasis") === null ? null : resolveStatementMoney(cell("costBasis"));
  const unrealized = cell("unrealized") === null ? null : resolveStatementMoney(cell("unrealized"));
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
      locators:
        marketValue.value === null
          ? { row: rowLocator, marketValue: rowLocator }
          : { row: rowLocator },
    },
    reason: null,
  };
}

/** Every holdings table in the document -> positions, plus the blocks that
 * could not be read, counted for the parse note. */
function parseHoldings(lines, kind, asOf) {
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

    let block = [];
    let description = null;
    const flush = () => {
      if (block.length === 0) return;
      const { position, reason } = positionFromBlock(block, columns, {
        kind,
        asOf,
        section,
        description,
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
      block.push({ bound, page: lines[j].page });
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
 * The real layout -> ParsedPull. A consolidated statement covering more than
 * one account is refused rather than guessed at: ParsedPosition,
 * ParsedBalance and ParsedLiability carry no account key (only ParsedRow
 * does), so every holding in a multi-account document would be imported under
 * whichever account the pull names. That is a wrong answer, not a partial
 * one, so the document is recorded unparsed with the reason and its retained
 * text is kept for a later slice that can attribute per account.
 */
export function parseRealStatement(text, kind) {
  const lines = pagedLines(text);
  const accountKeys = new Set();
  for (const { text: line } of lines) {
    for (const match of line.matchAll(ACCOUNT_NUMBER)) accountKeys.add(match[0]);
  }
  if (accountKeys.size !== 1) {
    return {
      activity: [],
      holdings: EMPTY_HOLDINGS,
      parseNote:
        `not parsed: this statement prints ${accountKeys.size} account numbers, and a holding ` +
        "on this contract carries no account key of its own, so every position would be " +
        "imported under the account the pull names (README, 'Consolidated statements')",
    };
  }

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

  const anchorIndex = lines.findIndex(({ text: line }) => BALANCE_SHEET_ANCHOR.test(line));
  const sheet = anchorIndex < 0 ? null : parseBalanceSheet(lines, anchorIndex, kind);
  const { positions, skipped } = parseHoldings(lines, kind, period.end);

  const notes = [];
  if (sheet === null) {
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
      balances: sheet === null ? [] : [sheet.balance],
      liabilities: sheet === null ? [] : sheet.liabilities,
    },
    ...(notes.length > 0 ? { parseNote: `partially parsed: ${notes.join("; ")}` } : {}),
  };
}
