// InstitutionAdapter for Morgan Stanley, against the public
// contract in @repo/finance-archive (src/adapter.ts). No login and no
// request to the institution: every byte this file reads in tests comes from
// ../fixtures. AdapterSession (src/bridge.mjs) is
// the only thing that ever talks to a real signed-in tab.
//
// Money is never a float: amount/quantity/price are canonical decimal text
// end to end, read through the same source-text JSON reviver retention.ts
// uses so a provider's exact digits survive parsing.

import {
  EMPTY_HOLDINGS,
  canonicalizeDecimal,
  exhaustiveListing,
  incompleteListing,
  negateDecimal,
  retainPayload,
} from "@repo/finance-archive";

export const INSTITUTION_SLUG = "morgan-stanley";
export const INSTITUTION_NAME = "Morgan Stanley";
const CURRENCY = "USD"; // documented quirk: no per-row currency field is known to exist.
const MS_DESCRIPTION_SEPARATOR = "<br/>";
const MAX_ACTIVITY_PAGES_PER_PULL = 50;
const MS_DOCUMENTS_PAGE_SIZE = 50; // the listing paginates at roughly 50 rows
const MAX_DOCUMENTS_PAGES_PER_TYPE = 200;

// --- Unconfirmed institution response shapes --------------------------------
//
// Only the *request* shapes are known (the activity POST body, the documents
// `filters` array) along with the activity endpoint's *row field* names. No
// full response envelope has been observed. Each constant below is this adapter's
// working assumption for a JSON key this v1 has never seen a live response
// for. Confirm each one on the first real discover()/acquire() run
// (README, "Operator runbook") rather than trusting the guess silently:
//   - MS_ACTIVITY_ROWS_KEY: read the resulting RetentionRecord.droppedPaths
//     If it lists activity rows dropped under a different key than
//     declared here, rename this constant and bump ACTIVITY_RETENTION.version.
//   - The rest: discover()/acquire() throw a named "missing <key> array"
//     error against a real response if the guess is wrong. Fix the constant
//     here, not in a downstream caller.
const MS_ACTIVITY_ROWS_KEY = "activityDetails";
const MS_DOCUMENTS_ITEMS_KEY = "documents";
const MS_DOCUMENTS_TOTAL_KEY = "totalCount";
const MS_ACCOUNTS_ITEMS_KEY = "accounts";

export {
  MS_ACTIVITY_ROWS_KEY,
  MS_DOCUMENTS_ITEMS_KEY,
  MS_DOCUMENTS_TOTAL_KEY,
  MS_ACCOUNTS_ITEMS_KEY,
  ACTIVITY_SIGN_TABLE,
  ACTIVITY_TAXONOMY,
};

// The two document tiers this adapter acquires. General correspondence and
// tax documents are visible in the site's documents list but have no
// CapabilityTier in the public interface; v1 does not invent one (see
// capabilities().quirks).
const DOCUMENT_TYPES = [
  { docType: "Statements", kind: "pdf_statement" },
  { docType: "Trade confirmations", kind: "trade_confirmation" },
];

// Bought/Sold are the only activity values this table has been reviewed for.
// Grows by review, never by pattern-matching the description text (README,
// "Parsing"). An activity value not in this table with a non-zero
// quantity routes to `quantity: null` -> review_items rather than a guess.
const ACTIVITY_SIGN_TABLE = new Map([
  ["Bought", 1],
  ["Buy", 1],
  ["Sold", -1],
  ["Sell", -1],
]);

// `InstitutionCapabilities.activityTaxonomy`: declared only
// for the activity values ACTIVITY_SIGN_TABLE already knows -- growing this
// by pattern-matching an unreviewed value would be the same guess the sign
// table above already refuses. A real run's `undeclared_activity_type`
// review items are the list to grow it from; each addition is its own
// reviewed decision (README, "Operator runbook").
const ACTIVITY_TAXONOMY = {
  Bought: { movesCash: true, movesQuantity: true, quantitySign: "positive" },
  Buy: { movesCash: true, movesQuantity: true, quantitySign: "positive" },
  Sold: { movesCash: true, movesQuantity: true, quantitySign: "negative" },
  Sell: { movesCash: true, movesQuantity: true, quantitySign: "negative" },
};

// --- retention ------------------------------------------------------

/**
 * Every path the parser actually reads from one activity page. `accountName`
 * is deliberately excluded: it can carry a person's name, and `keyAccount`
 * already identifies the account. `runningBalances` is also excluded for v1:
 * its leaf field names are unknown, and a
 * json_allowlist path must terminate on a scalar, so guessing a leaf name
 * here would be the exact silent guess the design forbids. It shows up
 * whole in RetentionRecord.droppedPaths on the first real pull; add its
 * leaves individually once that path is read, and bump `version`.
 */
const ACTIVITY_RETENTION = {
  kind: "json_allowlist",
  version: "ms-activity-1",
  fields: [
    "pages.*.Result.postedActivityCount",
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.processDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.activityDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.tradeDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.settlementDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.keyAccount`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.activity`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.description`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.amount`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.quantity`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.price`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.symbol`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.cusip`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.checkNumber`,
  ],
};

/** A statement, confirmation or download-control export is a rendered
 * document with no addressable fields; retained whole. */
const DOCUMENT_RETENTION = {
  kind: "opaque",
  version: "ms-document-1",
  note:
    "a statement or trade confirmation is a rendered PDF with no addressable fields; " +
    "it is retained whole because there is nothing to project",
};

const TABULAR_RETENTION = {
  kind: "opaque",
  version: "ms-tabular-1",
  note:
    "the download-control export is delimited text produced for a person to open, not " +
    "an addressable payload; it is retained whole because there is nothing to project",
};

export { ACTIVITY_RETENTION, DOCUMENT_RETENTION, TABULAR_RETENTION };

// --- shared helpers ----------------------------------------------------------

/** Splits an embedded `<br/>`-delimited description into newline-joined text,
 * keeping every segment (README, "Parsing"). A no-op when the
 * separator is absent, so it is safe to apply uniformly across tiers. */
export function splitDescription(raw) {
  return raw.split(MS_DESCRIPTION_SEPARATOR).join("\n");
}

/** Ground rule 5: ambiguous money is null with a note, never inferred. */
export function resolveAmount(text) {
  try {
    return { amount: canonicalizeDecimal(text), amountNote: null };
  } catch {
    return { amount: null, amountNote: `unparseable amount: ${JSON.stringify(text)}` };
  }
}

/**
 * Signed, positive for an acquisition and negative for a disposal
 * (ParsedRow.quantity's contract). `rawQuantity` is this institution's
 * unsigned magnitude; `activityType` selects the sign from
 * ACTIVITY_SIGN_TABLE. Null quantity stays null. A non-zero quantity whose
 * activity value is not in the table returns null so the importer routes it
 * to review rather than guessing (ground rule 5).
 */
export function resolveSignedQuantity(activityType, rawQuantity) {
  if (rawQuantity === null || rawQuantity === undefined) return null;
  const magnitude = canonicalizeDecimal(String(rawQuantity));
  if (magnitude === "0") return magnitude;
  const sign = ACTIVITY_SIGN_TABLE.get(activityType);
  if (sign === undefined) return null;
  return sign < 0 ? negateDecimal(magnitude) : magnitude;
}

/** A Treasury row carries a CUSIP with no ticker symbol; collapsing straight
 * to null on a missing symbol would silently drop it. Null only when neither
 * identifier is present. */
function instrumentFromSymbol(symbol, cusip) {
  const sym = symbol && symbol !== "-" ? symbol : null;
  const cus = cusip && cusip !== "-" ? cusip : null;
  if (sym === null && cus === null) return null;
  return { symbol: sym, cusip: cus, isin: null, name: null };
}

/** The date-range value covering [periodStart, periodEnd] with the fewest
 * extra rows, per the "smallest native DateRangeType" rule. A window
 * this can't cover in one call (more than a year) is the caller's job to
 * split into several acquisitions, one per year (README,
 * "acquire selections") -- this function only picks the range for one call. */
export function selectDateRangeType(periodStart, periodEnd) {
  const days = Math.round(
    (new Date(`${periodEnd}T00:00:00Z`) - new Date(`${periodStart}T00:00:00Z`)) / 86_400_000,
  );
  if (days <= 30) return "Last30Days";
  if (days <= 90) return "Last90Days";
  return "YearToDate";
}

/** DateRangeType offers no explicit earliest bound (iterate
 * `LastYear` "per prior year where the site allows"). This is therefore an
 * approximation, not a provider-confirmed value -- see capabilities().quirks. */
export function approximateActivityRange(now = new Date()) {
  return {
    earliest: `${now.getUTCFullYear() - 1}-01-01`,
    latest: now.toISOString().slice(0, 10),
  };
}

/** A canonical string over exactly the fields ACTIVITY_RETENTION retains,
 * used only to decide when pagination has covered every unique row (README,
 * section 1: "Uniqueness is computed over the retained row fields only, and
 * only to decide when to stop"). No row is ever dropped from the capture on
 * account of this: every page is appended to `pages` verbatim regardless. */
function rowFingerprint(row) {
  return JSON.stringify([
    row.processDate,
    row.activityDate,
    row.tradeDate,
    row.settlementDate,
    row.keyAccount,
    row.activity,
    row.description,
    row.amount,
    row.quantity,
    row.price,
    row.symbol,
    row.cusip,
    row.checkNumber,
  ]);
}

/**
 * The account a row belongs to, as `ParsedRow.accountExternalKey`. The
 * activity POST sends `AccountInformation.Grouping: "All"`, and the tabular
 * export carries an account column, so both tiers return rows for every
 * account in one pull. Each row is attributed by its own key rather than by
 * the pull's account.
 *
 * The value is the same `keyAccount` discover() reports as
 * `DiscoveredAccount.externalKey`, so it resolves against the map run.ts
 * builds. Anything that is not a non-empty string yields undefined, which
 * means "this pull's own account" and is the behavior from before the field
 * existed. Returning an empty string instead would open an
 * `unknown_account_key` review item for a key the provider never sent.
 */
function rowAccountExternalKey(rawKeyAccount) {
  return typeof rawKeyAccount === "string" && rawKeyAccount.length > 0 ? rawKeyAccount : undefined;
}

function mapAccountKind(rawType) {
  const t = String(rawType ?? "").toLowerCase();
  if (t.includes("ira") || t.includes("retirement")) return "retirement";
  if (t.includes("trust")) return "trust";
  if (t.includes("line of credit") || t.includes("sbloc")) return "credit_line";
  if (t.includes("mortgage")) return "mortgage";
  if (t.includes("bank") || t.includes("checking") || t.includes("savings")) return "bank";
  if (t.includes("brokerage") || t.includes("advisory") || t.includes("managed")) return "brokerage";
  return "other";
}

/**
 * Encodes everything acquireDocument needs into the one opaque id the public
 * interface hands back to it (DiscoveredDocument.externalId ->
 * AcquireSelection.externalId, with no period fields alongside it). The
 * interface calls externalId "opaque, institution-defined", so folding the
 * account key and period into it -- rather than re-querying the documents
 * list at acquire time to recover them -- stays inside that contract while
 * keeping acquireDocument a single fetch.
 */
function encodeDocumentExternalId(docId, keyAccount, periodStart, periodEnd) {
  return [docId, keyAccount, periodStart, periodEnd].join("::");
}

function decodeDocumentExternalId(externalId) {
  const parts = String(externalId).split("::");
  if (parts.length !== 4 || parts.some((p) => p.length === 0)) {
    throw new RangeError(`malformed document externalId: ${JSON.stringify(externalId)}`);
  }
  const [docId, keyAccount, periodStart, periodEnd] = parts;
  return { docId, keyAccount, periodStart, periodEnd };
}

// --- discover ----------------------------------------------------------------

async function fetchDocumentsForType(session, docType, kind) {
  const items = [];
  let providerTotal = null;
  let pageNumber = 1;
  for (;;) {
    const pageText = await session.fetchText("/documents", {
      docType,
      timeFrame: "All",
      page: String(pageNumber),
    });
    const page = JSON.parse(pageText);
    const pageItems = page?.[MS_DOCUMENTS_ITEMS_KEY];
    if (!Array.isArray(pageItems)) {
      throw new Error(
        `documents response for docType=${docType} has no "${MS_DOCUMENTS_ITEMS_KEY}" array ` +
          "(see the \"Unconfirmed institution response shapes\" comment in src/adapter.mjs)",
      );
    }
    const total = page?.[MS_DOCUMENTS_TOTAL_KEY];
    if (typeof total === "number") providerTotal = total;
    for (const raw of pageItems) {
      items.push({
        externalId: encodeDocumentExternalId(raw.externalId, raw.keyAccount, raw.periodStart, raw.periodEnd),
        kind,
        periodStart: raw.periodStart,
        periodEnd: raw.periodEnd,
        label: raw.label,
      });
    }
    if (providerTotal !== null && items.length >= providerTotal) break;
    if (providerTotal === null && pageItems.length < MS_DOCUMENTS_PAGE_SIZE) break;
    pageNumber += 1;
    if (pageNumber > MAX_DOCUMENTS_PAGES_PER_TYPE) {
      return {
        docType,
        items,
        providerTotal,
        reason: `documents pull for docType=${docType} stopped: exceeded the safety page cap of ${MAX_DOCUMENTS_PAGES_PER_TYPE}`,
      };
    }
  }
  return { docType, items, providerTotal, reason: null };
}

async function fetchAccounts(session) {
  const text = await session.fetchText("/accounts", {});
  const parsed = JSON.parse(text);
  const items = parsed?.[MS_ACCOUNTS_ITEMS_KEY];
  if (!Array.isArray(items)) {
    throw new Error(
      `accounts response has no "${MS_ACCOUNTS_ITEMS_KEY}" array ` +
        "(see the \"Unconfirmed institution response shapes\" comment in src/adapter.mjs)",
    );
  }
  return items.map((raw) => ({
    externalKey: raw.keyAccount,
    label: raw.label,
    last4: raw.last4,
    kind: mapAccountKind(raw.accountType),
  }));
}

async function discover(session) {
  const [results, accounts] = await Promise.all([
    Promise.all(DOCUMENT_TYPES.map(({ docType, kind }) => fetchDocumentsForType(session, docType, kind))),
    fetchAccounts(session),
  ]);
  const allItems = results.flatMap((r) => r.items);
  const problems = [];
  for (const r of results) {
    if (r.reason) problems.push(r.reason);
    else if (r.providerTotal === null) problems.push(`docType=${r.docType} reports no document total`);
  }

  let documents;
  if (problems.length > 0) {
    const knownTotal = results.every((r) => r.providerTotal !== null)
      ? results.reduce((sum, r) => sum + r.providerTotal, 0)
      : null;
    documents = incompleteListing(allItems, knownTotal, problems.join("; "));
  } else {
    const combinedTotal = results.reduce((sum, r) => sum + r.providerTotal, 0);
    documents =
      allItems.length === combinedTotal
        ? exhaustiveListing(allItems, combinedTotal)
        : incompleteListing(
            allItems,
            combinedTotal,
            `provider reports ${combinedTotal} document(s) across types but this pull returned ${allItems.length}`,
          );
  }

  const { earliest, latest } = approximateActivityRange();
  return {
    documents,
    exportRanges: [
      // Documented quirk: neither tier states an upfront row count ahead of a
      // specific pull (structured_api reports postedActivityCount only once
      // a pull is underway; the tabular export never reports one at all).
      { kind: "structured_api", earliest, latest, reportedRowCount: null },
      { kind: "tabular_export", earliest, latest, reportedRowCount: null },
    ],
    accounts,
  };
}

// --- acquire -------------------------------------------------------------

async function acquireStructuredApi(selection) {
  const rawPages = [];
  const uniqueRows = new Set();
  let reportedRowCount = null;
  let gapReason = null;
  let pageNumber = 1;
  let consecutiveNoNewRows = 0;
  const dateRangeType = selectDateRangeType(selection.periodStart, selection.periodEnd);

  for (;;) {
    let pageText;
    try {
      pageText = await selection.session.fetchText("/activity", {
        page: String(pageNumber),
        dateRangeType,
        startDate: selection.periodStart,
        endDate: selection.periodEnd,
      });
    } catch (error) {
      gapReason = `activity pull stopped before page ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    const page = JSON.parse(pageText);
    const rows = page?.Result?.[MS_ACTIVITY_ROWS_KEY];
    if (!Array.isArray(rows)) {
      throw new Error(
        `activity response has no Result.${MS_ACTIVITY_ROWS_KEY} array (page ${pageNumber}); ` +
          "see the \"Unconfirmed institution response shapes\" comment in src/adapter.mjs",
      );
    }
    rawPages.push(page);
    reportedRowCount = page.Result.postedActivityCount;

    const before = uniqueRows.size;
    for (const row of rows) uniqueRows.add(rowFingerprint(row));
    if (uniqueRows.size > reportedRowCount) {
      throw new Error(
        `activity pull defect: captured ${uniqueRows.size} unique row(s) but the provider ` +
          `stated postedActivityCount=${reportedRowCount}`,
      );
    }
    if (uniqueRows.size === before) {
      consecutiveNoNewRows += 1;
      if (consecutiveNoNewRows >= 2) {
        gapReason = `activity pull stopped at page ${pageNumber}: two consecutive pages added no new unique rows`;
        break;
      }
    } else {
      consecutiveNoNewRows = 0;
    }
    if (uniqueRows.size >= reportedRowCount) break;

    pageNumber += 1;
    if (pageNumber > MAX_ACTIVITY_PAGES_PER_PULL) {
      gapReason = `activity pull stopped: exceeded the safety page cap of ${MAX_ACTIVITY_PAGES_PER_PULL}`;
      break;
    }
  }

  const retained = retainPayload(
    ACTIVITY_RETENTION,
    new TextEncoder().encode(JSON.stringify({ pages: rawPages })),
    "structured_api",
  );
  const gaps = gapReason
    ? [{ periodStart: selection.periodStart, periodEnd: selection.periodEnd, reason: gapReason }]
    : [];

  return {
    bytes: retained.bytes,
    retention: retained.record,
    manifest: {
      kind: "structured_api",
      periodStart: selection.periodStart,
      periodEnd: selection.periodEnd,
      capturedAt: new Date().toISOString(),
      contentHash: retained.sha256,
      mediaType: "application/json",
      reportedRowCount,
      gaps,
    },
  };
}

async function acquireTabularExport(selection) {
  const text = await selection.session.fetchText("/export/tabular", {
    periodStart: selection.periodStart,
    periodEnd: selection.periodEnd,
  });
  const retained = retainPayload(TABULAR_RETENTION, new TextEncoder().encode(text), "tabular_export");
  return {
    bytes: retained.bytes,
    retention: retained.record,
    manifest: {
      kind: "tabular_export",
      periodStart: selection.periodStart,
      periodEnd: selection.periodEnd,
      capturedAt: new Date().toISOString(),
      contentHash: retained.sha256,
      mediaType: "text/csv; charset=utf-8",
      // Documented quirk: the download-control export states no row count.
      reportedRowCount: null,
      gaps: [],
    },
  };
}

async function acquireDocument(selection) {
  const { docId, keyAccount, periodStart, periodEnd } = decodeDocumentExternalId(selection.externalId);
  const bytes = await selection.session.fetchBytes(`/documents/${docId}::${keyAccount}`);
  const retained = retainPayload(DOCUMENT_RETENTION, bytes, selection.kind);
  return {
    bytes: retained.bytes,
    retention: retained.record,
    manifest: {
      kind: selection.kind,
      periodStart,
      periodEnd,
      capturedAt: new Date().toISOString(),
      contentHash: retained.sha256,
      // Declared, not inferred from the tier: this is what the site actually
      // serves for both statements and confirmations.
      mediaType: "application/pdf",
      reportedRowCount: null,
      gaps: [],
    },
  };
}

async function acquire(selection) {
  switch (selection.kind) {
    case "structured_api":
      return acquireStructuredApi(selection);
    case "tabular_export":
      return acquireTabularExport(selection);
    case "pdf_statement":
    case "trade_confirmation":
      return acquireDocument(selection);
    default:
      throw new RangeError(`unknown selection.kind ${selection.kind}`);
  }
}

// --- parse -------------------------------------------------------------------

/** Node 22+'s JSON.parse reviver context, the same technique retention.ts
 * uses: every primitive comes back as its own literal source text instead of
 * a decoded value, so a leaf can be read back out by exact position. */
function parseSourceTokens(text) {
  return JSON.parse(text, (_key, value, context) =>
    context?.source === undefined ? value : context.source,
  );
}

function parseStructuredApi(bytes) {
  const text = new TextDecoder().decode(bytes);
  const { pages } = JSON.parse(text);
  const sourceTokens = parseSourceTokens(text);
  const rows = [];
  let flatIndex = 0;

  pages.forEach((page, pageArrayIndex) => {
    const items = page.Result[MS_ACTIVITY_ROWS_KEY];
    // Each provider page is its own document for occurrence-ordinal dedupe
    // purposes, even though the whole pull is one RawFile (ParsedRow's
    // sourceDocument doc comment); "activity-page-N" uses the position in
    // `pages`, not any provider-issued page number.
    const sourceDocument = `activity-page-${pageArrayIndex + 1}`;

    items.forEach((item, itemArrayIndex) => {
      const rawAmountToken =
        sourceTokens?.pages?.[pageArrayIndex]?.Result?.[MS_ACTIVITY_ROWS_KEY]?.[itemArrayIndex]?.amount;
      if (typeof rawAmountToken !== "string") {
        throw new Error(
          `structured_api parse: no amount source token at pages/${pageArrayIndex}/Result/` +
            `${MS_ACTIVITY_ROWS_KEY}/${itemArrayIndex}`,
        );
      }
      const binding = {
        format: "json_pointer_v1",
        pointer: `/pages/${pageArrayIndex}/Result/${MS_ACTIVITY_ROWS_KEY}/${itemArrayIndex}/amount`,
        rawValue: rawAmountToken,
      };
      const rowLocator = {
        source: "structured_api",
        index: flatIndex,
        field: `page ${pageArrayIndex + 1}`,
        binding,
      };
      const parsedAmount = resolveAmount(String(item.amount));

      rows.push({
        sourceDocument,
        accountExternalKey: rowAccountExternalKey(item.keyAccount),
        // Documented quirk: the activity API carries no provider-issued
        // per-row id; overlap dedupe relies on occurrence ordinals instead.
        externalId: null,
        tradeDate: item.tradeDate ?? null,
        processDate: item.processDate,
        settleDate: item.settlementDate ?? null,
        datePrecision: "day",
        activityType: item.activity,
        description: splitDescription(item.description),
        instrument: instrumentFromSymbol(item.symbol, item.cusip),
        quantity: resolveSignedQuantity(item.activity, item.quantity ?? null),
        price: item.price === null || item.price === undefined ? null : canonicalizeDecimal(String(item.price)),
        currency: CURRENCY,
        // Leaf field names inside runningBalances are unknown and not
        // retained in v1 (see ACTIVITY_RETENTION's doc comment).
        runningBalance: null,
        locators:
          parsedAmount.amount === null ? { row: rowLocator, amount: rowLocator } : { row: rowLocator },
        ...parsedAmount,
      });
      flatIndex += 1;
    });
  });
  return rows;
}

function splitEightFields(line, separator) {
  const fields = line.split(separator);
  if (fields.length !== 8) {
    throw new Error(`expected 8 fields, got ${fields.length}: ${JSON.stringify(line)}`);
  }
  return fields;
}

function parseTabularExport(bytes) {
  const [, ...rest] = new TextDecoder().decode(bytes).split("\n");
  // One trailing record separator at end of file does not create a final
  // record: drop that one blank tail entry, but no others, so `rowIndex`
  // below is the physical data-record position (applied
  // here from the start rather than repeated as a later bug).
  const dataLines = rest.length > 0 && rest.at(-1) === "" ? rest.slice(0, -1) : rest;

  return dataLines.map((line, rowIndex) => {
    const [date, activityType, description, symbol, quantity, price, amount, keyAccount] = splitEightFields(
      line,
      ",",
    );
    const binding = {
      format: "delimited_row_v1",
      encoding: "utf-8",
      delimiter: ",",
      quote: "none",
      headerRows: 1,
      recordSeparator: "lf",
      rowIndex,
      columnIndex: 6,
      columnName: "Amount",
      rawValue: amount,
    };
    const parsedAmount = resolveAmount(amount);
    const rowLocator = { source: "tabular_export", index: rowIndex, binding };
    return {
      sourceDocument: "tabular-export",
      accountExternalKey: rowAccountExternalKey(keyAccount),
      externalId: null,
      tradeDate: null,
      processDate: date,
      settleDate: null,
      datePrecision: "day",
      activityType,
      description: splitDescription(description),
      instrument: instrumentFromSymbol(symbol, null),
      quantity: resolveSignedQuantity(activityType, quantity === "-" ? null : quantity),
      price: price === "-" ? null : canonicalizeDecimal(price),
      currency: CURRENCY,
      runningBalance: null,
      locators: parsedAmount.amount === null ? { row: rowLocator, amount: rowLocator } : { row: rowLocator },
      ...parsedAmount,
    };
  });
}

function splitPositionFields(line) {
  const fields = line.split("|");
  if (fields.length !== 12) throw new Error(`expected 12 fields, got ${fields.length}: ${JSON.stringify(line)}`);
  return fields;
}
function splitBalanceFields(line) {
  const fields = line.split("|");
  if (fields.length !== 7) throw new Error(`expected 7 fields, got ${fields.length}: ${JSON.stringify(line)}`);
  return fields;
}
function splitLiabilityFields(line) {
  const fields = line.split("|");
  if (fields.length !== 8) throw new Error(`expected 8 fields, got ${fields.length}: ${JSON.stringify(line)}`);
  return fields;
}

/**
 * A PDF (statement or confirmation)'s extracted text, line by line. No
 * binding on any row: the PDF tier declines one, and
 * section 3 ("Locators") only defines json_pointer_v1 and delimited_row_v1
 * for the two API-shaped tiers. `kind` selects whether a "HOLDINGS" section
 * is meaningful; a trade confirmation never emits one and so always returns
 * EMPTY_HOLDINGS, honestly rather than by omission.
 *
 * No row here sets `accountExternalKey`. A statement and a confirmation are
 * each one account's document, acquired by an externalId that already names
 * that account, so the pull's own account is the right one.
 */
export function parseStatementLines(text, kind) {
  const activity = [];
  const positions = [];
  const balances = [];
  const liabilities = [];
  let page = 1;
  let index = 0;
  let inHoldings = false;
  let holdingsIndex = 0;

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (line === "HOLDINGS") {
      inHoldings = true;
      continue;
    }
    const pageMatch = /^PAGE (\d+)$/.exec(line);
    if (pageMatch) {
      page = Number(pageMatch[1]);
      continue;
    }

    if (inHoldings) {
      const holdingLocator = { source: kind, index: page, field: `holdings line ${holdingsIndex}` };
      holdingsIndex += 1;
      if (line.startsWith("POSITION|")) {
        const [, asOf, symbol, name, quantity, price, marketValueText, costBasis, unrealized, currency, valuationBasis, valuationNote] =
          splitPositionFields(line);
        const parsedMarketValue = resolveAmount(marketValueText);
        positions.push({
          sourceDocument: kind,
          asOf,
          instrument:
            symbol === "-" && name === "-"
              ? null
              : { symbol: symbol === "-" ? null : symbol, cusip: null, isin: null, name: name === "-" ? null : name },
          quantity: quantity === "-" ? null : quantity,
          price: price === "-" ? null : price,
          marketValue: parsedMarketValue.amount,
          marketValueNote: parsedMarketValue.amountNote,
          costBasis: costBasis === "-" ? null : costBasis,
          unrealized: unrealized === "-" ? null : unrealized,
          currency,
          valuationBasis: valuationBasis === "-" ? null : valuationBasis,
          valuationNote,
          locators:
            parsedMarketValue.amount === null
              ? { row: holdingLocator, marketValue: holdingLocator }
              : { row: holdingLocator },
        });
      } else if (line.startsWith("BALANCE|")) {
        const [, asOf, totalValue, cash, currency, periodStartValue, periodEndValue] = splitBalanceFields(line);
        balances.push({
          sourceDocument: kind,
          asOf,
          totalValue,
          totalValueNote: null,
          cash,
          currency,
          periodStartValue,
          periodEndValue,
          locators: { row: holdingLocator },
        });
      } else if (line.startsWith("LIABILITY|")) {
        const [, liabilityKind, displayName, balance, currency, rate, asOf, collateralNote] =
          splitLiabilityFields(line);
        liabilities.push({
          sourceDocument: kind,
          kind: liabilityKind,
          displayName,
          balance,
          balanceNote: null,
          currency,
          rate,
          asOf,
          collateralNote,
          locators: { row: holdingLocator },
        });
      }
      continue;
    }

    const [date, activityType, description, symbol, quantity, price, amountText, currency] = splitEightFields(
      line,
      "|",
    );
    const rowLocator = { source: kind, index: page, field: `line ${index}` };
    const parsedAmount = resolveAmount(amountText);
    activity.push({
      // One PDF/confirmation file is one document regardless of printed page
      // count; PAGE markers are a locator detail only.
      sourceDocument: kind,
      externalId: null,
      tradeDate: null,
      processDate: date,
      settleDate: null,
      datePrecision: "day",
      activityType,
      description: splitDescription(description),
      instrument: instrumentFromSymbol(symbol, null),
      quantity: resolveSignedQuantity(activityType, quantity === "-" ? null : canonicalizeDecimal(quantity)),
      price: price === "-" ? null : canonicalizeDecimal(price),
      currency,
      runningBalance: null,
      locators: parsedAmount.amount === null ? { row: rowLocator, amount: rowLocator } : { row: rowLocator },
      ...parsedAmount,
    });
    index += 1;
  }
  return { activity, holdings: { positions, balances, liabilities } };
}

/**
 * Bytes -> text for the PDF tier. ponytail: only reads literal-string `Tj`
 * operators inside an uncompressed content stream -- exactly what
 * fixtures/pdf.mjs's generator produces -- and falls back to decoding the
 * bytes directly as UTF-8 when they are not a PDF at all. A real Morgan
 * Stanley statement may use compressed streams (`/Filter /FlateDecode`) or
 * embedded/CID fonts this does not decode. Upgrade path: swap in a real PDF
 * text-extraction dependency once acquired against a real statement;
 * parseStatementLines' text-based signature does not need to change.
 */
export function extractStatementText(bytes) {
  const latin1 = Buffer.from(bytes).toString("latin1");
  if (!latin1.startsWith("%PDF-")) {
    return new TextDecoder().decode(bytes);
  }
  const lines = [];
  const tjPattern = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  let match;
  while ((match = tjPattern.exec(latin1)) !== null) {
    lines.push(match[1].replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\"));
  }
  if (lines.length === 0) {
    throw new Error("extractStatementText: found a PDF but no Tj text operators in it");
  }
  return lines.join("\n");
}

async function parse(rawFile) {
  switch (rawFile.kind) {
    case "structured_api":
      return { activity: parseStructuredApi(rawFile.bytes), holdings: EMPTY_HOLDINGS };
    case "tabular_export":
      return { activity: parseTabularExport(rawFile.bytes), holdings: EMPTY_HOLDINGS };
    case "pdf_statement":
    case "trade_confirmation":
      return parseStatementLines(extractStatementText(rawFile.bytes), rawFile.kind);
    default:
      throw new RangeError(`unknown rawFile.kind ${rawFile.kind}`);
  }
}

// --- capabilities --------------------------------------------------------

function capabilities() {
  return {
    institutionSlug: INSTITUTION_SLUG,
    institutionName: INSTITUTION_NAME,
    tiers: ["structured_api", "tabular_export", "pdf_statement", "trade_confirmation"],
    retentionWindow: {
      earliest: null,
      note:
        "Documents (statements, confirmations) are retained seven years by the provider " +
        "The structured activity API and tabular export do not state how far " +
        "back they serve; neither is a multi-year source.",
    },
    quirks: [
      "Activity API rows carry no provider-issued row id; page overlap is deduped by " +
        "occurrence ordinal within each page's sourceDocument, not by an externalId.",
      "The activity JSON's row-array key and the documents-list JSON's item/total keys are " +
        "this adapter's working assumption, unconfirmed against a live response -- see the " +
        "\"Unconfirmed institution response shapes\" comment in src/adapter.mjs.",
      "runningBalances is a nested object whose leaf field names are unknown; it is dropped " +
        "by the retention allowlist in v1 and ParsedRow.runningBalance is always null for " +
        "structured_api rows.",
      "General correspondence and tax documents are visible in the site's documents list but " +
        "have no capability tier in this interface; v1 does not acquire them.",
      "The documents list paginates at roughly 50 rows with no total shown on screen; this " +
        "adapter always paginates to the underlying POST's stated total or returns an " +
        "incomplete listing, and never concludes absence from a single page.",
      "Whether the tabular export carries a price column, and whether trade confirmations' " +
        "FINRA Rule 2232 markup is separately fielded, are not confirmed; markup stays " +
        "embedded in description text in v1.",
      "exportRanges.earliest for structured_api and tabular_export is an approximation (start " +
        "of last calendar year), not a provider-confirmed bound.",
      "All money is assumed USD; no per-row currency field is known to exist for the " +
        "activity API or the tabular export.",
    ],
    activityTaxonomy: ACTIVITY_TAXONOMY,
  };
}

const morganStanleyAdapter = {
  institutionSlug: INSTITUTION_SLUG,
  discover,
  acquire,
  parse,
  capabilities,
};

export default morganStanleyAdapter;
export { morganStanleyAdapter };
