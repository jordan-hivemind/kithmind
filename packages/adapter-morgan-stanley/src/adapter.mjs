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
// Every account this adapter has seen is USD-based; structured_api rows
// spell the base currency "-" (see resolveRowCurrency). tabular_export and
// pdf_statement/trade_confirmation have no confirmed per-row currency source
// and default to this.
const BASE_CURRENCY = "USD";
const MS_DESCRIPTION_SEPARATOR = "<br/>";
const MAX_ACTIVITY_PAGES_PER_PULL = 50;
const MS_DOCUMENTS_PAGE_SIZE = 50; // the listing paginates at roughly 50 rows
const MAX_DOCUMENTS_PAGES_PER_TYPE = 200;
// Every document tier this adapter acquires is served as a PDF; see assertPdfBytes.
const PDF_MAGIC = "%PDF";

// --- Unconfirmed institution response shapes --------------------------------
//
// The activity envelope is confirmed against a live response: `Result`
// carries `postedActivityCount`/`pendingActivityCount`, and the rows array is
// `Result.postedActivities`. The documents and accounts envelopes remain this
// adapter's working assumption -- only their *request* shapes are known so
// far, never a confirmed response envelope. Confirm each remaining one on the
// first real discover()/acquire() run (README, "Operator runbook") rather
// than trusting the guess silently:
//   - MS_ACCOUNTS_ITEMS_KEY: discover() throws a "missing <key> array" error
//     naming the response's actual top-level keys if the guess is wrong (see
//     fetchAccountsFromEndpoint). The accounts endpoint itself is currently
//     unreliable (see fetchAccountsFromActivityFallback) so this may go
//     unconfirmed for a while longer.
//   - MS_DOCUMENTS_ITEMS_KEY / MS_DOCUMENTS_TOTAL_KEY: same "missing <key>
//     array" pattern, but discover() also tolerates the documents pull
//     failing outright (e.g. the bridge has not captured the app's bearer
//     because its Documents page was never opened in the tab, see
//     fetchDocumentsForType) and returns an incompleteListing with the
//     reason instead of throwing. The per-item field names below are read
//     straight off each row and are unconfirmed for the same reason.
const MS_ACTIVITY_ROWS_KEY = "postedActivities";
const MS_DOCUMENTS_ITEMS_KEY = "documents";
const MS_DOCUMENTS_TOTAL_KEY = "totalCount";
// The list is `Result.Accounts`.
const MS_ACCOUNTS_ITEMS_KEY = "Accounts";

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

// Signed direction for this institution's unsigned `quantity` magnitude.
// Every taxonomy entry with `movesQuantity: true` must appear here, because a
// value missing from this table resolves to `quantity: null` -- so declaring a
// type as quantity-moving without a sign here would drop the quantity from
// the position gate silently, which is worse than not declaring it at all.
//
// Grows by review, never by pattern-matching the description text (README,
// "Parsing"). An activity value not in this table with a non-zero quantity
// routes to `quantity: null` -> review_items rather than a guess.
const ACTIVITY_SIGN_TABLE = new Map([
  // Trades.
  ["Bought", 1],
  ["Buy", 1],
  ["Sold", -1],
  ["Sell", -1],
  ["Security Sold", -1],
  // A dividend reinvestment's purchase leg acquires shares.
  ["Dividend Reinvestment", 1],
  // A redemption retires the position it pays out.
  ["Redemption", -1],
  // In-kind movement between accounts, one direction each.
  ["Exchange Deliver Out", -1],
  ["Exchange Received In", 1],
  // An expiring contract leaves the position.
  ["Option Expired", -1],
  // Shares paid as the dividend itself.
  ["Dividend Stock", 1],
]);

// `InstitutionCapabilities.activityTaxonomy`, declared from the activity
// values the first live pull actually produced (F1-19). Every entry here is
// its own reviewed decision about what that value does to cash and to a
// position; values the pull produced but that are not reviewed below stay out
// of this table on purpose, so they keep opening `undeclared_activity_type`
// review items instead of being counted on a guess (README, "Activity
// taxonomy"). See the README table for the per-value rationale.
//
// One shape assumption is load-bearing and stated here as well as in the
// README: the site books a reinvested dividend as two rows -- the credit
// under `Dividend`/`Qualified Dividend`, then `Dividend Reinvestment` as the
// purchase leg carrying a negative amount and a positive quantity, exactly
// like `Bought`. If a later pull shows it as one row crediting the dividend
// and delivering the shares together, `movesCash: true` here would have the
// cash gate count a credit that never changed the balance, and this entry
// has to be revisited rather than the gate loosened.
const ACTIVITY_TAXONOMY = {
  // --- trades and other quantity movement --------------------------------
  Bought: { movesCash: true, movesQuantity: true, quantitySign: "positive" },
  Buy: { movesCash: true, movesQuantity: true, quantitySign: "positive" },
  Sold: { movesCash: true, movesQuantity: true, quantitySign: "negative" },
  Sell: { movesCash: true, movesQuantity: true, quantitySign: "negative" },
  "Security Sold": { movesCash: true, movesQuantity: true, quantitySign: "negative" },
  "Dividend Reinvestment": { movesCash: true, movesQuantity: true, quantitySign: "positive" },
  Redemption: { movesCash: true, movesQuantity: true, quantitySign: "negative" },
  // In-kind: the position moves, no cash crosses the account boundary.
  "Exchange Deliver Out": { movesCash: false, movesQuantity: true, quantitySign: "negative" },
  "Exchange Received In": { movesCash: false, movesQuantity: true, quantitySign: "positive" },
  "Option Expired": { movesCash: false, movesQuantity: true, quantitySign: "negative" },
  "Dividend Stock": { movesCash: false, movesQuantity: true, quantitySign: "positive" },

  // --- cash only ----------------------------------------------------------
  Dividend: { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "Qualified Dividend": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "Tax Exempt Dividend": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "Interest Income": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "Tax Exempt Interest Income": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "Return of Capital": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "Cash in Lieu": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "Service Fee": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "CASH TRANSFER": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "Funds Transferred": { movesCash: true, movesQuantity: false, quantitySign: "none" },
  Withdrawal: { movesCash: true, movesQuantity: false, quantitySign: "none" },
  Contribution: { movesCash: true, movesQuantity: false, quantitySign: "none" },
  "Automated Payment": { movesCash: true, movesQuantity: false, quantitySign: "none" },
};

// --- retention ------------------------------------------------------

/**
 * Every path the parser actually reads from one activity page, plus the
 * fields review and dedupe need. `accountName` is deliberately excluded: it
 * can carry a person's name, and `keyAccount` already identifies the
 * account. `runningBalances` is confirmed as a scalar (a JSON number), so it
 * is retained directly.
 */
const ACTIVITY_RETENTION = {
  kind: "json_allowlist",
  version: "ms-activity-2",
  fields: [
    "pages.*.Result.postedActivityCount",
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.activityId`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.transactionSequenceNumber`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.CCY`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.processDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.activityDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.tradeDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.settlementDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.keyAccount`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.activity`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.trnType`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.category`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.subCategory`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.description`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.amount`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.quantity`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.price`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.runningBalances`,
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
    "the download-control export is an Excel workbook produced for a person to open, not " +
    "an addressable payload; it is retained whole because there is nothing to project",
};

export { ACTIVITY_RETENTION, DOCUMENT_RETENTION, TABULAR_RETENTION };

// --- shared helpers ----------------------------------------------------------

/** Activity dates are US "MM/DD/YYYY"; the archive wants ISO "YYYY-MM-DD".
 * Anything else passes through untouched so the importer's own date check
 * routes it to review rather than a guess. */
export function normalizeActivityDate(value) {
  if (typeof value !== "string") return value ?? null;
  const t = value.trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : t;
}

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
 * The per-row `CCY` field, normalized to an uppercase three-letter code.
 * `ParsedRow.currency` is a required string (not nullable), so a missing or
 * non-three-letter value cannot itself become null -- instead this reports a
 * problem the caller routes through the same review-style null-with-a-note
 * path `resolveAmount` already uses for ambiguous money (ground rule 5),
 * carrying the raw value through as-is so nothing is lost.
 */
export function resolveRowCurrency(rawCcy) {
  const normalized = typeof rawCcy === "string" ? rawCcy.trim().toUpperCase() : "";
  // CCY is "-" on the large majority of rows and carries an ISO code only on
  // foreign-currency rows (e.g. CAD, GBP, EUR, CHF). The dash is the
  // institution's spelling of "the account's base currency", which is USD
  // for every account this adapter has seen. Values also carry a trailing
  // newline, hence the trim.
  if (normalized === "-") return { currency: BASE_CURRENCY, currencyProblem: null };
  if (/^[A-Z]{3}$/.test(normalized)) return { currency: normalized, currencyProblem: null };
  // ParsedRow.currency must be a valid code, so the row carries the base
  // currency with its amount nulled and the problem noted: no money value is
  // asserted under a currency the row did not state.
  return {
    currency: BASE_CURRENCY,
    currencyProblem: `missing or non-three-letter CCY: ${JSON.stringify(rawCcy)}`,
  };
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
  if (t.includes("other loans") || t.includes("loan")) return "credit_line";
  if (t.includes("bank") || t.includes("checking") || t.includes("savings") || t.includes("cash management")) return "bank";
  if (t.includes("brokerage") || t.includes("advisory") || t.includes("managed") || t.includes("investments")) return "brokerage";
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

/**
 * Documents tier tolerance: the documents-list request needs the app's own
 * Authorization bearer, which the bridge captures page-side only once the
 * app's Documents page has loaded in the tab (README, "Operator runbook"), so
 * a real pull can still fail outright, not just report a missing key.
 * Catching that here, per document type, is what lets an activity-only
 * bounded pull proceed instead of discover() rejecting entirely.
 */
async function fetchDocumentsForType(session, docType, kind) {
  try {
    return await fetchDocumentsPages(session, docType, kind);
  } catch (error) {
    return {
      docType,
      items: [],
      providerTotal: null,
      reason: `documents pull for docType=${docType} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function fetchDocumentsPages(session, docType, kind) {
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

/** The status code out of a bridge-thrown "request failed: <status> ..."
 * error (see src/bridge.mjs's pageFetchExpression), or null when the error
 * does not carry one (a thrown-before-fetch error, e.g. no headers captured
 * yet). */
function httpStatusOf(error) {
  const match = /request failed: (\d{3})\b/.exec(error instanceof Error ? error.message : String(error));
  return match ? Number(match[1]) : null;
}

async function fetchAccountsFromEndpoint(session) {
  const text = await session.fetchText("/accounts", {});
  const parsed = JSON.parse(text);
  const items = parsed?.Result?.[MS_ACCOUNTS_ITEMS_KEY];
  if (!Array.isArray(items)) {
    throw new Error(
      `accounts response has no "Result.${MS_ACCOUNTS_ITEMS_KEY}" array; top-level keys: ` +
        `${Object.keys(parsed ?? {}).join(", ") || "(none)"}; Result keys: ` +
        `${Object.keys(parsed?.Result ?? {}).join(", ") || "(none)"} ` +
        "(see the \"Unconfirmed institution response shapes\" comment in src/adapter.mjs)",
    );
  }
  // Field names: Id (opaque string), Name (a nickname, which can carry a
  // person's name and is therefore never used), Category (the site's own
  // grouping, e.g. Investments, Trust, Retirement Accounts, Cash Management,
  // Mortgage Loans, Other Loans), AccountType, IsExternal (an aggregated
  // outside-institution account, not held here, excluded).
  return items
    .filter((raw) => raw?.IsExternal !== true && typeof raw?.Id === "string" && raw.Id.length > 0)
    .map((raw) => ({
      externalKey: raw.Id,
      label: [raw.Category, raw.AccountType].filter(Boolean).join(": ") || "account",
      last4: raw.Id.slice(-4),
      kind: mapAccountKind(`${raw.Category ?? ""} ${raw.AccountType ?? ""}`),
    }));
}

/**
 * A page-context fetch to the accounts endpoint returns 403 even with the
 * app's own exact URL, the captured XSRF header and a permissive Accept
 * header, so it cannot be relied on today. Falls back to the one endpoint
 * already known to work: one activity pull over the trailing 30 days,
 * deriving one `DiscoveredAccount` per unique `keyAccount` seen there. `kind`
 * is "other" (not `mapAccountKind`'s guess) because this path never sees
 * `accountType`. This only lists accounts with activity in the last 30 days
 * -- the full pull must revisit the real accounts endpoint once its response
 * envelope is confirmed (README quirks).
 */
async function fetchAccountsFromActivityFallback(session) {
  const pageText = await session.fetchText("/activity", {
    page: "1",
    pageSize: "500",
    dateRangeType: "Last30Days",
  });
  const page = JSON.parse(pageText);
  const rows = page?.Result?.[MS_ACTIVITY_ROWS_KEY];
  if (!Array.isArray(rows)) {
    throw new Error(
      `accounts fallback: activity response has no Result.${MS_ACTIVITY_ROWS_KEY} array`,
    );
  }
  const keys = [...new Set(rows.map((row) => row.keyAccount))];
  return keys.map((keyAccount) => ({
    externalKey: keyAccount,
    label: keyAccount,
    last4: String(keyAccount).slice(-4),
    kind: "other",
  }));
}

async function fetchAccounts(session) {
  try {
    return await fetchAccountsFromEndpoint(session);
  } catch (error) {
    const status = httpStatusOf(error);
    if (status !== 403 && status !== 404) throw error;
    return fetchAccountsFromActivityFallback(session);
  }
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

/**
 * /generateexcel produces an Excel workbook (binary zip), not delimited
 * text, so this reads it the same way acquireDocument reads a PDF --
 * fetchBytes, not fetchText -- and retains it opaque. See parse()'s
 * tabular_export case: this tier is acquire-only in v1.
 */
async function acquireTabularExport(selection) {
  const bytes = await selection.session.fetchBytes("/export/tabular", {
    periodStart: selection.periodStart,
    periodEnd: selection.periodEnd,
  });
  const retained = retainPayload(TABULAR_RETENTION, bytes, "tabular_export");
  return {
    bytes: retained.bytes,
    retention: retained.record,
    manifest: {
      kind: "tabular_export",
      periodStart: selection.periodStart,
      periodEnd: selection.periodEnd,
      capturedAt: new Date().toISOString(),
      contentHash: retained.sha256,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // Documented quirk: the download-control export states no row count.
      reportedRowCount: null,
      gaps: [],
    },
  };
}

/**
 * The per-document download path is unconfirmed (MS_DOCUMENT_DOWNLOAD_PATH_PREFIX,
 * see src/bridge.mjs), and a signed-out or wrong-path download answers with an
 * HTML login or error page at HTTP 200. Retaining that would archive a page
 * that says nothing under a statement's content hash, so the bytes are checked
 * for the PDF magic number before they are retained.
 */
function assertPdfBytes(bytes, docId) {
  const header = String.fromCharCode(...bytes.slice(0, PDF_MAGIC.length));
  if (header === PDF_MAGIC) return;
  throw new Error(
    `document download for ${docId} did not return a PDF (it starts ${JSON.stringify(header)}, ` +
      `not ${JSON.stringify(PDF_MAGIC)}) -- an HTML login or error page is the usual cause. ` +
      "Check the signed-in tab and MS_DOCUMENT_DOWNLOAD_PATH_PREFIX (README, 'Environment').",
  );
}

async function acquireDocument(selection) {
  const { docId, keyAccount, periodStart, periodEnd } = decodeDocumentExternalId(selection.externalId);
  const bytes = await selection.session.fetchBytes(`/documents/${docId}::${keyAccount}`);
  assertPdfBytes(bytes, docId);
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
      // Live rows carry trailing newlines on scalar strings.
      for (const k of ["amount", "quantity", "price", "activity", "symbol", "cusip", "tradeDate", "processDate", "settlementDate", "activityDate"]) {
        if (typeof item[k] === "string") item[k] = item[k].trim();
      }
      for (const k of ["tradeDate", "processDate", "settlementDate", "activityDate"]) {
        item[k] = normalizeActivityDate(item[k]);
      }
      let parsedAmount = resolveAmount(String(item.amount));
      const { currency, currencyProblem } = resolveRowCurrency(item.CCY);
      // A currency problem routes the row to review the same way an
      // unparseable amount already does (ground rule 5): only when the
      // amount itself was otherwise readable, so one row never reports two
      // conflicting reasons for its own null amount.
      if (currencyProblem !== null && parsedAmount.amount !== null) {
        parsedAmount = { amount: null, amountNote: currencyProblem };
      }
      const rawExternalId = item.activityId ?? item.transactionSequenceNumber ?? null;

      rows.push({
        sourceDocument,
        externalId: rawExternalId === null ? null : String(rawExternalId),
        accountExternalKey: rowAccountExternalKey(item.keyAccount),
        tradeDate: item.tradeDate ?? null,
        processDate: item.processDate,
        settleDate: item.settlementDate ?? null,
        datePrecision: "day",
        activityType: item.activity,
        description: splitDescription(item.description),
        instrument: instrumentFromSymbol(item.symbol, item.cusip),
        quantity: resolveSignedQuantity(item.activity, item.quantity ?? null),
        price: item.price === null || item.price === undefined ? null : canonicalizeDecimal(String(item.price)),
        currency,
        // runningBalances is retained in the raw bytes (ACTIVITY_RETENTION)
        // now that it is confirmed a scalar, but not yet surfaced as
        // ParsedRow.runningBalance in v1 -- deferred, not blocked.
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
      // The export is an Excel workbook (see acquireTabularExport), not
      // delimited text. Acquire-only until an xlsx reader is chosen (no new
      // dependency added for this); zero rows is the honest answer for
      // "nothing here has been read yet," not a missing source.
      return { activity: [], holdings: EMPTY_HOLDINGS };
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
      "Activity API rows do carry a provider row id (activityId, falling back to " +
        "transactionSequenceNumber) and it is used as ParsedRow.externalId. Page-overlap " +
        "dedupe still uses occurrence ordinals, unchanged.",
      "The activity JSON envelope is confirmed live (Result.postedActivities, " +
        "postedActivityCount). The documents-list and accounts JSON envelopes remain this " +
        "adapter's working assumption -- see the \"Unconfirmed institution response shapes\" " +
        "comment in src/adapter.mjs.",
      "The documents-list request needs the app's own Authorization bearer. The session bridge " +
        "captures it page-side alongside the XSRF and footprint headers, but only once the app's " +
        "Documents page has loaded in the signed-in tab; until then the documents endpoints " +
        "refuse by name. discover() catches that per document type and returns an " +
        "incompleteListing with the reason instead of failing the whole pull, so an " +
        "activity-only bounded pull can still proceed.",
      "The documents-list request path, query and body keys are confirmed live " +
        "(POST searchItems; endDate, pageNum, filters[DocType/DocSubType/KeyAccountNo], sortBy, " +
        "startDate, TimeFrame). Which values TimeFrame accepts, the response envelope, the " +
        "per-item field names and the per-document download path are not; a download that " +
        "answers with an HTML login or error page instead of a PDF is refused by name rather " +
        "than retained.",
      "The accounts endpoint (confirmed request shape) returns 403 from a page-context fetch " +
        "even with the captured XSRF header and a permissive Accept header, so it cannot be " +
        "relied on today. discover() falls back to deriving accounts from one activity pull " +
        "over the trailing 30 days (unique keyAccount values, kind \"other\"), so an account " +
        "with no activity in that window is not listed; the full pull must revisit the real " +
        "accounts endpoint once its response envelope is confirmed.",
      "runningBalances is confirmed as a scalar and is retained in the allowlist, but not yet " +
        "surfaced as ParsedRow.runningBalance (always null for structured_api rows in v1).",
      "General correspondence and tax documents are visible in the site's documents list but " +
        "have no capability tier in this interface; v1 does not acquire them.",
      "The documents list paginates at roughly 50 rows with no total shown on screen; this " +
        "adapter always paginates to the underlying POST's stated total or returns an " +
        "incomplete listing, never concludes absence from one page.",
      "Whether trade confirmations' FINRA Rule 2232 markup is separately fielded is not " +
        "confirmed; markup stays embedded in description text in v1.",
      "exportRanges.earliest for structured_api and tabular_export is an approximation (start " +
        "of last calendar year), not a provider-confirmed bound.",
      "structured_api rows carry a per-row CCY currency field, used as " +
        "ParsedRow.currency (a missing or non-three-letter value routes the row to review the " +
        "same way an unparseable amount does). tabular_export and pdf_statement/" +
        "trade_confirmation still have no confirmed per-row currency source and default to " +
        "the base currency.",
      "The activity export (tabular_export) is generated by /generateexcel and is an Excel " +
        "workbook, not delimited text. v1 acquires it opaque and does not parse it -- parse() " +
        "returns zero rows for this tier until an xlsx reader is chosen.",
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
