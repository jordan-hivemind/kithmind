// A reference implementation of InstitutionAdapter against the fixtures in
// ./fixtures.ts. This is what a real adapter follows: it knows Thistlebrook
// Trust (an invented institution) and nothing about the store, imports no
// schema, and never sees a credential. Its only job is to prove the
// interface in adapter.ts is enough to build against.

import {
  canonicalizeDecimal,
} from "../../decimal.js";
import {
  exhaustiveListing,
  incompleteListing,
  sha256Hex,
  type AcquiredDocument,
  type AcquireSelection,
  type AdapterSession,
  type DiscoverResult,
  type FieldLocator,
  type InstitutionAdapter,
  type InstitutionCapabilities,
  type ParsedAmount,
  type ParsedInstrument,
  type ParsedRow,
  type RawFile,
} from "../../adapter.js";
import {
  buildTabularExportCsv,
  DOCUMENTS,
  generateActivityRows,
  INSTITUTION_NAME,
  INSTITUTION_SLUG,
  INSTRUMENTS,
  paginateWithOverlap,
  type ActivityRow,
} from "./fixtures.js";

export { INSTITUTION_NAME, INSTITUTION_SLUG } from "./fixtures.js";

const ACTIVITY_ROWS = generateActivityRows(24);
const ACTIVITY_PAGES = paginateWithOverlap(ACTIVITY_ROWS, 10);
const MAX_ACTIVITY_PAGES_PER_PULL = 50;

/**
 * Both this fixture's CSV and its pipe-delimited statement text use the same
 * eight fields in the same order. Splitting is validated here once, with a
 * runtime check, rather than trusting `noUncheckedIndexedAccess` away at
 * each call site.
 */
function splitEightFields(
  line: string,
  separator: string,
): [string, string, string, string, string, string, string, string] {
  const fields = line.split(separator);
  if (fields.length !== 8) {
    throw new Error(`expected 8 fields, got ${fields.length}: ${JSON.stringify(line)}`);
  }
  return fields as [string, string, string, string, string, string, string, string];
}

function instrumentBySymbol(symbol: string): ParsedInstrument {
  return (
    INSTRUMENTS.find((instrument) => instrument.symbol === symbol) ?? {
      symbol,
      cusip: null,
      isin: null,
      name: null,
    }
  );
}

type ActivityLikeRow = {
  readonly externalId: string | null;
  readonly date: string;
  readonly activityType: string;
  readonly description: string;
  readonly instrument: ParsedInstrument | null;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly amount: string;
  readonly currency: string;
};

function activityRowToParsedRow(
  row: ActivityLikeRow,
  locator: FieldLocator,
  sourceDocument: string,
): ParsedRow {
  return {
    sourceDocument,
    externalId: row.externalId,
    tradeDate: null,
    processDate: row.date,
    settleDate: null,
    datePrecision: "day",
    activityType: row.activityType,
    description: row.description,
    instrument: row.instrument,
    quantity: row.quantity,
    price: row.price,
    amount: row.amount,
    amountNote: null,
    currency: row.currency,
    runningBalance: null,
    locators: { row: locator },
  };
}

// --- session -----------------------------------------------------------

/**
 * Test knobs, not institution behavior: a real session never needs to be
 * told to withhold a total or fail a page. This lets the suite exercise the
 * exhaustive/incomplete listing split and gap recording without a live
 * provider.
 */
export type SyntheticSessionOptions = {
  /** Serve only the first N documents even though more exist. */
  readonly documentsLimit?: number;
  /** Omit the document total entirely, as some providers do. */
  readonly omitDocumentsTotal?: boolean;
  /** Fail the activity request for this page number, simulating an outage mid-pull. */
  readonly activityFailAtPage?: number;
};

/**
 * A session standing in for a browser a person has already authenticated.
 * It exposes only logical fetches by path; there is nothing here shaped
 * like a header, a cookie or a token for an adapter to hold onto.
 */
export function createSyntheticSession(
  options: SyntheticSessionOptions = {},
): AdapterSession {
  const documentSummaries = DOCUMENTS.map((doc) => ({
    externalId: doc.externalId,
    kind: doc.kind,
    periodStart: doc.periodStart,
    periodEnd: doc.periodEnd,
    label: doc.label,
  }));

  async function fetchText(
    path: string,
    query: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    if (path === "/documents") {
      const documents =
        options.documentsLimit === undefined
          ? documentSummaries
          : documentSummaries.slice(0, options.documentsLimit);
      const totalCount = options.omitDocumentsTotal ? null : documentSummaries.length;
      return JSON.stringify({ documents, totalCount });
    }
    if (path === "/activity/meta") {
      return JSON.stringify({
        earliest: ACTIVITY_ROWS[0]?.date ?? null,
        latest: ACTIVITY_ROWS.at(-1)?.date ?? null,
      });
    }
    if (path === "/activity") {
      const pageNumber = Number(query.page ?? "1");
      if (pageNumber === options.activityFailAtPage) {
        throw new Error(`synthetic outage on page ${pageNumber}`);
      }
      const page = ACTIVITY_PAGES[pageNumber - 1];
      if (!page) {
        throw new RangeError(`synthetic session: no activity page ${pageNumber}`);
      }
      return JSON.stringify(page);
    }
    if (path === "/export/tabular") {
      return buildTabularExportCsv(ACTIVITY_ROWS);
    }
    throw new RangeError(`synthetic session: unknown path ${path}`);
  }

  async function fetchBytes(
    path: string,
    query: Readonly<Record<string, string>> = {},
  ): Promise<Uint8Array> {
    if (path.startsWith("/documents/")) {
      const externalId = path.slice("/documents/".length);
      const doc = DOCUMENTS.find((candidate) => candidate.externalId === externalId);
      if (!doc) {
        throw new RangeError(`synthetic session: unknown document ${externalId}`);
      }
      return new TextEncoder().encode(doc.text());
    }
    return new TextEncoder().encode(await fetchText(path, query));
  }

  return { institutionSlug: INSTITUTION_SLUG, fetchText, fetchBytes };
}

// --- discover ------------------------------------------------------------

async function discover(session: AdapterSession): Promise<DiscoverResult> {
  const documentsResponse = JSON.parse(await session.fetchText("/documents")) as {
    documents: DiscoverResult["documents"]["items"];
    totalCount: number | null;
  };
  const { documents: items, totalCount } = documentsResponse;
  const documents =
    totalCount === null
      ? incompleteListing(items, null, "provider does not report a document total")
      : items.length === totalCount
        ? exhaustiveListing(items, totalCount)
        : incompleteListing(
            items,
            totalCount,
            `provider reports ${totalCount} document(s) but this pull returned ${items.length}`,
          );

  const meta = JSON.parse(await session.fetchText("/activity/meta")) as {
    earliest: string;
    latest: string;
  };
  return {
    documents,
    exportRanges: [
      {
        kind: "structured_api",
        earliest: meta.earliest,
        latest: meta.latest,
        reportedRowCount: ACTIVITY_ROWS.length,
      },
      {
        kind: "tabular_export",
        earliest: meta.earliest,
        latest: meta.latest,
        // Documented quirk: the tabular export never states a row count.
        reportedRowCount: null,
      },
    ],
  };
}

// --- acquire ---------------------------------------------------------------

async function acquireStructuredApi(selection: {
  readonly session: AdapterSession;
  readonly periodStart: string;
  readonly periodEnd: string;
}): Promise<AcquiredDocument> {
  const rawPages: unknown[] = [];
  let reportedRowCount: number | null = null;
  let failure: { atPage: number; message: string } | null = null;
  let pageNumber = 1;
  for (;;) {
    let pageText: string;
    try {
      pageText = await selection.session.fetchText("/activity", { page: String(pageNumber) });
    } catch (error) {
      failure = {
        atPage: pageNumber,
        message: error instanceof Error ? error.message : String(error),
      };
      break;
    }
    const page = JSON.parse(pageText) as {
      totalCount: number;
      hasMore: boolean;
      items: readonly ActivityRow[];
    };
    rawPages.push(page);
    reportedRowCount = page.totalCount;
    if (!page.hasMore) break;
    pageNumber += 1;
    if (pageNumber > MAX_ACTIVITY_PAGES_PER_PULL) {
      failure = { atPage: pageNumber, message: "exceeded the safety page cap" };
      break;
    }
  }

  const bytes = new TextEncoder().encode(JSON.stringify({ pages: rawPages }));
  const gaps = failure
    ? [
        {
          periodStart:
            (rawPages.at(-1) as { items: readonly ActivityRow[] } | undefined)?.items.at(-1)
              ?.date ?? selection.periodStart,
          periodEnd: selection.periodEnd,
          reason: `activity pull stopped before page ${failure.atPage}: ${failure.message}`,
        },
      ]
    : [];

  return {
    bytes,
    manifest: {
      kind: "structured_api",
      periodStart: selection.periodStart,
      periodEnd: selection.periodEnd,
      capturedAt: new Date().toISOString(),
      contentHash: sha256Hex(bytes),
      reportedRowCount,
      gaps,
    },
  };
}

async function acquireTabularExport(selection: {
  readonly session: AdapterSession;
  readonly periodStart: string;
  readonly periodEnd: string;
}): Promise<AcquiredDocument> {
  const text = await selection.session.fetchText("/export/tabular", {
    periodStart: selection.periodStart,
    periodEnd: selection.periodEnd,
  });
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    manifest: {
      kind: "tabular_export",
      periodStart: selection.periodStart,
      periodEnd: selection.periodEnd,
      capturedAt: new Date().toISOString(),
      contentHash: sha256Hex(bytes),
      // Documented quirk: this institution's tabular export states no row count.
      reportedRowCount: null,
      gaps: [],
    },
  };
}

async function acquireDocument(selection: {
  readonly session: AdapterSession;
  readonly externalId: string;
}): Promise<AcquiredDocument> {
  const doc = DOCUMENTS.find((candidate) => candidate.externalId === selection.externalId);
  if (!doc) {
    throw new RangeError(`unknown document ${selection.externalId}`);
  }
  const bytes = await selection.session.fetchBytes(`/documents/${doc.externalId}`);
  return {
    bytes,
    manifest: {
      kind: doc.kind,
      periodStart: doc.periodStart,
      periodEnd: doc.periodEnd,
      capturedAt: new Date().toISOString(),
      contentHash: sha256Hex(bytes),
      reportedRowCount: null,
      gaps: [],
    },
  };
}

async function acquire(selection: AcquireSelection): Promise<AcquiredDocument> {
  switch (selection.kind) {
    case "structured_api":
      return acquireStructuredApi(selection);
    case "tabular_export":
      return acquireTabularExport(selection);
    case "pdf_statement":
    case "trade_confirmation":
      return acquireDocument(selection);
  }
}

// --- parse -------------------------------------------------------------

function parseStructuredApi(bytes: Uint8Array): readonly ParsedRow[] {
  const { pages } = JSON.parse(new TextDecoder().decode(bytes)) as {
    pages: ReadonlyArray<{ page: number; items: readonly ActivityRow[] }>;
  };
  const rows: ParsedRow[] = [];
  let index = 0;
  for (const page of pages) {
    // Each page is its own document for occurrence-ordinal purposes, even
    // though the whole pull was captured as one RawFile: see ParsedRow's
    // sourceDocument doc comment.
    const sourceDocument = `structured-api-page-${page.page}`;
    for (const item of page.items) {
      rows.push(
        activityRowToParsedRow(
          item,
          { source: "structured_api", index, field: `page ${page.page}` },
          sourceDocument,
        ),
      );
      index += 1;
    }
  }
  return rows;
}

function parseTabularExport(bytes: Uint8Array): readonly ParsedRow[] {
  const [, ...dataLines] = new TextDecoder().decode(bytes).split("\n");
  return dataLines
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const [date, activityType, description, symbol, quantity, price, amount, currency] =
        splitEightFields(line, ",");
      return activityRowToParsedRow(
        {
          // Documented quirk: this export carries no provider row id.
          externalId: null,
          date,
          activityType,
          description,
          instrument: symbol === "-" ? null : instrumentBySymbol(symbol),
          quantity: quantity === "-" ? null : quantity,
          price: price === "-" ? null : price,
          amount,
          currency,
        },
        { source: "tabular_export", index },
        // No pagination on this tier: one parse() call is one document.
        "tabular-export",
      );
    });
}

function resolveAmount(text: string): ParsedAmount {
  try {
    return { amount: canonicalizeDecimal(text), amountNote: null };
  } catch {
    return {
      amount: null,
      amountNote: `statement text has an unparseable amount: ${JSON.stringify(text)}`,
    };
  }
}

function parseStatementText(
  bytes: Uint8Array,
  kind: "pdf_statement" | "trade_confirmation",
): readonly ParsedRow[] {
  const rows: ParsedRow[] = [];
  let page = 1;
  let index = 0;
  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const pageMatch = /^PAGE (\d+)$/.exec(line);
    if (pageMatch) {
      page = Number(pageMatch[1]);
      continue;
    }
    const [date, activityType, description, symbol, quantity, price, amountText, currency] =
      splitEightFields(line, "|");
    const rowLocator: FieldLocator = { source: kind, index: page, field: `line ${index}` };
    const parsedAmount = resolveAmount(amountText);
    rows.push({
      // One PDF/confirmation file is one document regardless of how many
      // printed pages it has; PAGE markers here are only a locator detail.
      sourceDocument: kind,
      externalId: null,
      tradeDate: null,
      processDate: date,
      settleDate: null,
      datePrecision: "day",
      activityType,
      description,
      instrument: symbol === "-" ? null : instrumentBySymbol(symbol),
      quantity: quantity === "-" ? null : canonicalizeDecimal(quantity),
      price: price === "-" ? null : canonicalizeDecimal(price),
      currency,
      runningBalance: null,
      locators:
        parsedAmount.amount === null
          ? { row: rowLocator, amount: rowLocator }
          : { row: rowLocator },
      ...parsedAmount,
    });
    index += 1;
  }
  return rows;
}

async function parse(rawFile: RawFile): Promise<readonly ParsedRow[]> {
  switch (rawFile.kind) {
    case "structured_api":
      return parseStructuredApi(rawFile.bytes);
    case "tabular_export":
      return parseTabularExport(rawFile.bytes);
    case "pdf_statement":
    case "trade_confirmation":
      return parseStatementText(rawFile.bytes, rawFile.kind);
  }
}

// --- capabilities --------------------------------------------------------

function capabilities(): InstitutionCapabilities {
  return {
    institutionSlug: INSTITUTION_SLUG,
    institutionName: INSTITUTION_NAME,
    tiers: ["structured_api", "tabular_export", "pdf_statement", "trade_confirmation"],
    retentionWindow: {
      earliest: "2020-01-01",
      note:
        "Structured API and tabular export cover the trailing 24 months; PDF statements " +
        "and trade confirmations are retained back to account opening (synthetic fixture).",
    },
    quirks: [
      "Structured activity API pages overlap by one row at each page boundary; dedupe by row hash, not by page arithmetic.",
      "Tabular export carries no provider row id and states no total row count.",
      "PDF statement text occasionally has an unparseable amount; such rows must enter review rather than being guessed.",
    ],
  };
}

export const syntheticAdapter: InstitutionAdapter = {
  institutionSlug: INSTITUTION_SLUG,
  discover,
  acquire,
  parse,
  capabilities,
};
