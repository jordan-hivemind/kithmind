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
import { extractWithPdfjs, extractWithTjScan } from "./pdfText.mjs";
import { isRealStatementLayout, parseRealStatement } from "./statementLayout.mjs";

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
const MS_DOCUMENTS_ITEMS_KEY = "defaultDocumentList"; // confirmed live 2026-09-11
const MS_DOCUMENTS_TOTAL_KEY = "numFound"; // confirmed live 2026-09-11 (a string)
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
  { docType: "ClientStatements", kind: "pdf_statement" },
  { docType: "TradeConfirmations", kind: "trade_confirmation" },
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
  // The same in-kind journal under the site's other wording (F1-8d).
  ["Transfer out of Account", -1],
  ["Transfer into Account", 1],
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
  // F1-8d. The same in-kind journal, spelled the site's other way. Every one
  // of these rows the owner's archive holds pairs with a row of the opposite
  // wording on a *different* account at the same date, instrument and
  // magnitude, and none pairs within one account: the position crosses an
  // account boundary and no cash crosses anything. The stated `amount` is the
  // value journalled, not a cash movement, which is why counting it as cash
  // was the whole of 17 failing cash-gate periods.
  "Transfer out of Account": { movesCash: false, movesQuantity: true, quantitySign: "negative" },
  "Transfer into Account": { movesCash: false, movesQuantity: true, quantitySign: "positive" },
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
 * fields review and dedupe need, plus a small set of fields retained for
 * evidence and later use but not yet parsed (README, "Retention"). Excluded
 * fields -- `accountName`, `memo`, card/check identifiers, and every envelope
 * field -- are listed with reasons in the README, not here: an allowlist is
 * built up, never explained by what's missing from it. `runningBalances` is
 * confirmed as a scalar (a JSON number), so it is retained directly.
 */
const ACTIVITY_RETENTION = {
  kind: "json_allowlist",
  version: "ms-activity-3",
  fields: [
    "pages.*.Result.postedActivityCount",
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.activityId`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.transactionSequenceNumber`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.CCY`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.processDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.activityDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.tradeDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.settlementDate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.payDate`,
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
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.referenceNumber`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.fxCurrency`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.fxSourceCurrency`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.fxSourceAmount`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.fxLocalCurrency`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.fxLocalAmount`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.fxMarketRate`,
    `pages.*.Result.${MS_ACTIVITY_ROWS_KEY}.*.fxType`,
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
  const thisYear = new Date().getUTCFullYear();
  if (periodEnd < `${thisYear}-01-01` && periodStart >= `${thisYear - 1}-01-01`) return "LastYear";
  // Confirmed live 2026-09-11: DateRangeType "Custom" honours StartDate and
  // EndDate (ISO accepted) for any window, and it is the only way to reach
  // years before last year. A window that ends before last year, or spans
  // more than one calendar year, is a Custom pull; the caller splits long
  // windows by year so each pull stays a bounded page walk.
  if (periodEnd < `${thisYear - 1}-01-01` || periodStart.slice(0, 4) !== periodEnd.slice(0, 4)) return "Custom";
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

/** Calendar years the documents service is asked for: seven years back through
 * this year. Confirmed live 2026-09-11 that TimeFrame accepts a year as a
 * string; there is no "all" value, so the window is covered year by year and
 * exhaustiveness is judged per year against that year's numFound. */
export function documentTimeFrames(now = new Date()) {
  // Confirmed live 2026-09-11: a prior calendar year is accepted as a string;
  // the current year is refused (400), and "Last12Months" covers it. The
  // overlap between "Last12Months" and the previous year is removed by
  // documentId when the listings are merged.
  const thisYear = now.getUTCFullYear();
  return [...Array.from({ length: 6 }, (_, i) => String(thisYear - 6 + i)), "Last12Months"];
}

function documentPeriod(kind, documentDate) {
  const day = String(documentDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { periodStart: day, periodEnd: day };
  if (kind === "pdf_statement") return { periodStart: `${day.slice(0, 7)}-01`, periodEnd: day };
  return { periodStart: day, periodEnd: day };
}


/** The documents service answers a transient 400 "Service Error" on the first
 * call or two after the app refreshes its bearer (seen live 2026-09-11, the
 * same request succeeding seconds later). Retry that exact failure a few
 * times with a short pause; anything else propagates unchanged. */
async function fetchWithServiceErrorRetry(call, attempts = 8) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/request failed: 400\b/.test(message) || !/Service Error/.test(message)) throw error;
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
    }
  }
  throw last;
}

// F1-70. The CDP call backing a page fetch can fail with "Inspected target
// navigated or closed" (JSON-RPC code -32000, see bridge.mjs's connectCdp)
// when the tab is mid-navigation the instant this page happens to be
// requested -- transient noise, not a real gap in the listing. Retried once
// after a short pause; a second failure (this one or any other shape) still
// propagates, and fetchDocumentsForType's own catch is what turns that into
// an incomplete listing.
const CDP_TARGET_GONE_RETRY_DELAY_MS = 1000;

function isCdpTargetGoneError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /"code":\s*-32000/.test(message);
}

async function fetchDocumentsPages(session, docType, kind) {
  const items = [];
  const seenIds = new Set();
  let providerTotal = 0;
  for (const timeFrame of documentTimeFrames()) {
    let pageNumber = 1;
    let yearTotal = null;
    let yearCount = 0;
    for (;;) {
      const fetchPage = () =>
        fetchWithServiceErrorRetry(() =>
          session.fetchText("/documents", { docType, timeFrame, page: String(pageNumber) }),
        );
      let pageText;
      try {
        pageText = await fetchPage();
      } catch (error) {
        if (!isCdpTargetGoneError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, CDP_TARGET_GONE_RETRY_DELAY_MS));
        pageText = await fetchPage();
      }
      const page = JSON.parse(pageText);
      const pageItems = page?.[MS_DOCUMENTS_ITEMS_KEY];
      if (!Array.isArray(pageItems)) {
        throw new Error(
          `documents response for docType=${docType} has no "${MS_DOCUMENTS_ITEMS_KEY}" array; ` +
            `top-level keys: ${Object.keys(page ?? {}).join(", ") || "(none)"}`,
        );
      }
      const total = Number(page?.[MS_DOCUMENTS_TOTAL_KEY]);
      if (Number.isFinite(total)) yearTotal = total;
      for (const raw of pageItems) {
        yearCount += 1;
        if (seenIds.has(raw.documentId)) continue; // overlap between Last12Months and the prior year
        seenIds.add(raw.documentId);
        const { periodStart, periodEnd } = documentPeriod(kind, raw.documentDate);
        const keyAccount = typeof raw.keyAccountNo === "string" ? raw.keyAccountNo : "";
        // F1-68. Same text `label` folds in below, just without the date --
        // safe for a run's start-of-pull preview to print on its own.
        const subType = String(raw.documentTypeName ?? docType);
        items.push({
          externalId: encodeDocumentExternalId(raw.documentId, keyAccount, periodStart, periodEnd),
          // F1-71. This document's identity inside the institution, apart
          // from the externalId that also carries the account key and period
          // acquireDocument needs. The site renders a fresh PDF on every
          // download, so content hash cannot answer "is this the same
          // document" and this is what does.
          providerDocumentId: String(raw.documentId),
          kind,
          periodStart,
          periodEnd,
          label: `${subType} ${periodEnd}`,
          accountExternalKey: rowAccountExternalKey(keyAccount),
          subType,
        });
      }
      if (yearTotal !== null && yearCount >= yearTotal) break;
      if (pageItems.length < MS_DOCUMENTS_PAGE_SIZE) break;
      pageNumber += 1;
      if (pageNumber > MAX_DOCUMENTS_PAGES_PER_TYPE) {
        return { docType, items, providerTotal: null, reason: `documents pull for docType=${docType} stopped: exceeded the safety page cap of ${MAX_DOCUMENTS_PAGES_PER_TYPE}` };
      }
    }
    if (yearTotal === null) return { docType, items, providerTotal: null, reason: `documents pull for docType=${docType} timeFrame=${timeFrame} reported no total` };
    providerTotal += yearTotal;
  }
  // providerTotal counts the Last12Months/prior-year overlap twice; the unique
  // item count is what the archive can acquire, so report that as the total
  // once every timeframe paged to its own stated count.
  return { docType, items, providerTotal: items.length, reason: null };
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

async function discover(session, kinds) {
  // Sequential on purpose: the documents service answers a transient 400 to
  // a noticeable share of concurrent calls from one session (seen live
  // 2026-09-11), so the listings run one after another, accounts first.
  const accounts = await fetchAccounts(session);
  // F1-70. `kinds`, when given, scopes the documents listing to the doc
  // types those kinds map to -- a failure listing TradeConfirmations must
  // not mark the combined result incomplete for a caller that only asked
  // discover() about pdf_statement. Omitted (or every DOCUMENT_TYPES kind
  // named), every doc type is still listed, unchanged.
  const wantedTypes = kinds ? DOCUMENT_TYPES.filter((t) => kinds.includes(t.kind)) : DOCUMENT_TYPES;
  const results = [];
  for (const { docType, kind } of wantedTypes) {
    results.push(await fetchDocumentsForType(session, docType, kind));
  }
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

  // F1-68. Each docType's own providerTotal (sum of numFound across every
  // time frame queried for it), keyed by kind, alongside wantedTypes' own
  // matching order (F1-70: only the kinds actually listed, so a skipped
  // kind is simply absent here rather than reporting a total for a listing
  // that never ran) -- documents above already merges every docType into
  // one combined listing, which is what a run needs to acquire, but a run's
  // start-of-pull preview wants the per-kind total this loses.
  const documentListingTotalsByKind = {};
  wantedTypes.forEach(({ kind }, index) => {
    documentListingTotalsByKind[kind] = results[index].providerTotal;
  });

  const { earliest, latest } = approximateActivityRange();
  return {
    documents,
    documentListingTotalsByKind,
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
      "Check the signed-in tab: the document endpoint answered with something that is not a PDF (README, 'Documents').",
  );
}

async function acquireDocument(selection) {
  const { docId, keyAccount, periodStart, periodEnd } = decodeDocumentExternalId(selection.externalId);
  // F1-62. The same transient 400 "Service Error" fetchDocumentsPages
  // already retries (discover()'s own comment: "the documents service
  // answers a transient 400 to a noticeable share of concurrent calls from
  // one session") lands on the per-document download too, and `--concurrency`
  // makes several of these calls concurrent by design -- so retry it here the
  // same way, rather than counting a transient service hiccup as a failed
  // document pull against the operator loop's consecutive-failure breaker.
  const bytes = await fetchWithServiceErrorRetry(() =>
    selection.session.fetchBytes(`/documents/${docId}::${keyAccount}`),
  );
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
  if (isRealStatementLayout(text)) return parseRealStatement(text, kind);
  if (isSyntheticStatementText(text)) return parseSyntheticStatementLines(text, kind);
  // Neither grammar. The bytes and their extracted text are retained either
  // way; the document routes to review rather than being fed to a parser that
  // would read a layout it has never seen (ground rule 5). This is the path a
  // real trade confirmation takes today: no confirmation has been acquired
  // yet, so its layout has never been studied (README, "Trade confirmations").
  return {
    activity: [],
    holdings: EMPTY_HOLDINGS,
    parseNote:
      `not parsed: text extracted (${text.length} characters) but it matches neither the ` +
      "CLIENT STATEMENT layout nor this adapter's delimited fixture grammar, so no field " +
      "map for it has been reviewed",
  };
}

/** The fixture grammar's own marker: a "PAGE n" line or a pipe-delimited row. */
function isSyntheticStatementText(text) {
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  return /^PAGE \d+$/.test(first.trim()) || first.includes("|");
}

/**
 * The synthetic fixture grammar: "PAGE n" markers, one pipe-delimited row per
 * line, a "HOLDINGS" marker, then POSITION/BALANCE/LIABILITY lines. Kept as
 * its own function now that the real layout has a parser of its own
 * (statementLayout.mjs), so neither grammar has to tolerate the other.
 */
export function parseSyntheticStatementLines(text, kind) {
  const activity = [];
  const positions = [];
  const balances = [];
  const liabilities = [];
  let page = 1;
  let index = 0;
  let inHoldings = false;
  let holdingsIndex = 0;

  // Trimmed per line: the real extractor lays text out at the character
  // column each datum sits in, so a fixture PDF's lines come back indented.
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
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
 * Bytes -> text for the PDF tier: UTF-8, one line per visual line, a form
 * feed between pages, deterministic for the same bytes (src/pdfText.mjs).
 *
 * pdfjs-dist is what reads the real statements. Their content streams are
 * compressed and their fonts embedded, which is exactly why the
 * dependency-free `Tj` scan read nothing from any of them and every live
 * document landed with `parsed_ok` false (F1-43). That scan is kept as the
 * fallback: it is what reads this package's generated fixture PDFs, and it
 * costs one regex to keep.
 *
 * Bytes that are not a PDF at all are decoded as UTF-8 unchanged, which is
 * how a text fixture reaches the parser directly.
 */
export async function extractStatementText(bytes) {
  const header = String.fromCharCode(...bytes.slice(0, PDF_MAGIC.length));
  if (header !== PDF_MAGIC) {
    return new TextDecoder().decode(bytes);
  }
  let pdfjsError = null;
  try {
    const extracted = await extractWithPdfjs(bytes);
    if (extracted !== null) return extracted;
  } catch (error) {
    pdfjsError = error instanceof Error ? error.message : String(error);
  }
  const scanned = extractWithTjScan(bytes);
  if (scanned !== null) return scanned;
  throw new Error(
    "extractStatementText: found a PDF with no readable text" +
      (pdfjsError === null
        ? " (pdfjs-dist read no text items, and there are no literal Tj operators either)"
        : ` (pdfjs-dist failed: ${pdfjsError})`) +
      " -- a scanned image with no text layer is the usual cause",
  );
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
    case "trade_confirmation": {
      // Real statements carry compressed content streams the dependency-free
      // extractor cannot read (seen live 2026-09-11). The bytes are retained
      // either way; the document is recorded as not parsed with the reason,
      // so a real extractor can revisit it rather than the archive losing it.
      let text;
      try {
        text = await extractStatementText(rawFile.bytes);
      } catch (error) {
        return {
          activity: [],
          holdings: EMPTY_HOLDINGS,
          parseNote: `not parsed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      // F1-44: the extracted text is returned whatever the parser makes of
      // it, so `persistAcquiredDocument` writes it as this document's
      // retained text artifact and hashes it. A later retained_text_span_v1
      // citation then has bytes to point at even for a document whose layout
      // this parser declines to read.
      return { ...parseStatementLines(text, rawFile.kind), extractedText: text };
    }
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
