// The deterministic scorer: which document goes with which investment entry.
//
// Section 2 of docs/plans/2026-09-19-investment-document-matching.md, slice 1.
// Every function in this file is PURE. Same inputs, same decision, every time,
// with the reason and the features it used recorded on the way out. Nothing
// here opens a connection, reads a clock, or calls a model.
//
// That is not a style preference. "Silent wrong data is the one unacceptable
// failure" is the owner's line, and the only way to keep a matcher honest is
// to be able to replay its decision from what it was given. `investmentLinks.ts`
// does the reading and the writing; this file does the deciding, and its tests
// need no database at all.
//
// Three rules the rest of the file is built to keep:
//
//   * MONEY IS EXACT. Every amount is a decimal string and every comparison
//     is BigInt arithmetic. There is not a single `Number` applied to money
//     below, because a float comparison of the owner's capital call is a
//     wrong link waiting for a rounding error.
//   * A DATE IS A DATE. Windows are computed in whole UTC days from calendar
//     dates. Nothing here builds a `Date` from a timestamp and compares
//     instants, because "same day" in one zone is "the day before" in another.
//   * A PARTIAL DATE IS NOT A DAY. Extraction stores `precision: "year"` for a
//     tax letter's "2024" and `"month"` for "March 2024" rather than padding
//     them (`src/records/values.ts`). Neither satisfies a window here and
//     neither may replace an estimated date, because the only way to use one
//     would be to invent the day the page does not print.

import type { DatePrecision, ObservationValue } from "../records/values.js";
import { compareDecimals } from "../records/values.js";
import type { InvestmentEntryType } from "./model.js";

// ---------------------------------------------------------------------------
// The points, the thresholds, and the kinds. Named constants, tested at every
// boundary in `test/linkScoring.test.mjs`.
// ---------------------------------------------------------------------------

/** Section 2's table of signals, as points. */
export const LINK_SIGNAL_POINTS = {
  /** A document organization value naming this investment. */
  party: 4,
  /** A document money value equal to the entry's amount. */
  amount: 4,
  /** The document's own date inside the kind's window. */
  date: 2,
  /** A folder or file name segment naming this investment. */
  path: 1,
} as const;

export type LinkSignal = keyof typeof LINK_SIGNAL_POINTS;

/** Party, amount and date together. The only score that can auto-link. */
export const LINK_AUTO_POINTS =
  LINK_SIGNAL_POINTS.party + LINK_SIGNAL_POINTS.amount + LINK_SIGNAL_POINTS.date;

/** At or above this, a candidate is offered to the owner. Below it, nothing
 * is written at all -- a suggestion nobody would act on is noise, and noise
 * is a defect. */
export const LINK_SUGGEST_POINTS = 4;

/**
 * A second candidate this close to the best is a tie, and a tie links nothing.
 *
 * The plan's words: "a best two within 2 points, link nothing and suggest
 * both. A tie is the shape of two identical capital calls in one month, which
 * is where a guess goes wrong." So an auto-link needs the best to lead by
 * MORE than this -- a three point gap, which no single signal but `party` or
 * `amount` can close on its own.
 */
export const LINK_TIE_MARGIN_POINTS = 2;

/**
 * The cross-currency tolerance, taken from the importer rather than invented:
 * `RATE_TOLERANCE_FRACTION` and `RATE_TOLERANCE_FLOOR_CENTS` in
 * `apps/web/src/lib/kith/investment-import.ts`, which is the rule the owner
 * already accepted his GBP rows under. The larger of 1% or $1.00.
 *
 * The two copies exist because that module is loaded into the browser bundle
 * and cannot import `@repo/kith-store`; `test/linkScoring.test.mjs` pins the
 * numbers here so a change to either is a visible change to both.
 */
export const RATE_TOLERANCE_FRACTION = 100n;
export const RATE_TOLERANCE_FLOOR_CENTS = 100n;

/** Where a kind's date window is measured from. */
export type DateWindow =
  /** Around the entry's own date. The three payment kinds. */
  | { anchor: "entry"; days: number }
  /**
   * Around the investment's `signed_on`, falling back to the entry's date
   * when the investment has none.
   *
   * The fallback is this file's decision, not the plan's, and it is load
   * bearing: an imported commitment's date is estimated EXACTLY when the
   * sheet had no Docs Signed date, which is exactly when `signed_on` is null.
   * Anchoring only on `signed_on` would make the agreement window unavailable
   * in the one case the date replacement rule exists for.
   */
  | { anchor: "investmentSignedOnElseEntry"; days: number }
  /** No date signal. An investment-level kind with no day to compare. */
  | { anchor: "none" };

/**
 * One document kind this scorer knows how to match, and how.
 *
 * A kind that is not in this table produces no candidates at all. That is the
 * quiet direction: an unknown kind is not scored on "any money value that
 * happens to be equal", which is how a capital call notice's
 * `total_commitment` would link itself to a commitment entry.
 */
export type MatchableKind = {
  kind: string;
  /**
   * The one money field whose value may match an entry's amount. One field,
   * not "any money on the page": a notice states its `total_commitment` and
   * its `remaining_commitment` beside the amount it is actually calling, and
   * either of those equalling some entry is a coincidence, not a match.
   */
  amountField: string | null;
  /** The date fields that may satisfy the window, in preference order. */
  dateFields: readonly string[];
  /** The window those dates are measured against. */
  dateWindow: DateWindow;
  /**
   * The entry types this kind may link to. Empty means the kind only ever
   * links at the investment level (`entry_id` null): a K-1 or a capital
   * account statement is about the investment, not about one payment.
   */
  entryTypes: readonly InvestmentEntryType[];
  /** Section 2's decision table: only these three may ever auto-link. */
  autoLinkable: boolean;
  /**
   * The date field whose value may replace an ESTIMATED entry date, in
   * preference order (section 3, "Estimated dates"). Empty means this kind
   * never moves a date.
   */
  dateReplacementFields: readonly string[];
};

/**
 * Section 2's windows and section 3's replacement table as one piece of data.
 *
 * `wire_confirmation` and `capital_account_statement` are section 1's document
 * kinds, which are seeded with the slice that teaches extraction to read them.
 * Naming them here now costs nothing -- a kind no document carries simply
 * never appears -- and means the scorer needs no change on the day they do.
 */
export const MATCHABLE_DOCUMENT_KINDS: readonly MatchableKind[] = Object.freeze([
  {
    kind: "capital_call_notice",
    amountField: "amount_called",
    dateFields: ["due_date", "notice_date"],
    dateWindow: { anchor: "entry", days: 30 },
    entryTypes: ["capital_call_paid"],
    autoLinkable: true,
    // The notice's due date is the weaker of the two sources the plan names
    // for a paid call, which is why a wire confirmation is preferred over it
    // (`investmentLinks.ts`): a call is paid on the day the money moved, not
    // on the day it was due.
    dateReplacementFields: ["due_date"],
  },
  {
    kind: "wire_confirmation",
    amountField: "amount_sent",
    dateFields: ["value_date"],
    dateWindow: { anchor: "entry", days: 30 },
    entryTypes: ["capital_call_paid"],
    autoLinkable: true,
    dateReplacementFields: ["value_date"],
  },
  {
    kind: "distribution_notice",
    amountField: "amount_distributed",
    dateFields: ["distribution_date"],
    dateWindow: { anchor: "entry", days: 30 },
    entryTypes: ["distribution"],
    autoLinkable: true,
    dateReplacementFields: ["distribution_date"],
  },
  {
    kind: "investment_agreement",
    amountField: "amount_committed",
    dateFields: ["date_signed"],
    dateWindow: { anchor: "investmentSignedOnElseEntry", days: 90 },
    entryTypes: ["commitment", "commitment_change"],
    // Not auto-linkable: section 2's decision table names only the three
    // payment kinds, and an agreement's amount is a commitment that a later
    // `commitment_change` may have moved away from.
    autoLinkable: false,
    dateReplacementFields: ["date_signed"],
  },
  {
    kind: "schedule_k1",
    // `tax_year` is a number field, not a date (`src/extraction/seed.ts`), so
    // a K-1 has no date to put in a window and no amount that means "this
    // payment". It links at the investment level on its party alone.
    amountField: null,
    dateFields: [],
    dateWindow: { anchor: "none" },
    entryTypes: [],
    autoLinkable: false,
    dateReplacementFields: [],
  },
  {
    kind: "capital_account_statement",
    amountField: null,
    dateFields: [],
    dateWindow: { anchor: "none" },
    entryTypes: [],
    autoLinkable: false,
    dateReplacementFields: [],
  },
]);

const KINDS_BY_NAME = new Map(
  MATCHABLE_DOCUMENT_KINDS.map((kind) => [kind.kind, kind]),
);

/** The kind's matching rules, or null when this scorer has none for it. */
export function matchableKind(kind: string): MatchableKind | null {
  return KINDS_BY_NAME.get(kind) ?? null;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A name as the scorer compares it.
 *
 * Character for character the transformation `normalizeEntityName` in
 * `src/memory/entities.ts` applies, because `entities.normalized_aliases` --
 * the alias list this scorer matches against -- was written by that function
 * and two different folds would never meet. It is copied rather than imported
 * for one reason: that one throws on an empty or over-long name, and a
 * document's organization value and a folder segment are untrusted input that
 * a scorer must be able to reject quietly rather than fail on.
 * `test/linkScoring.test.mjs` asserts the two agree.
 */
export function normalizeMatchName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || trimmed.includes("\0")) return "";
  return trimmed
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

/**
 * The name-shaped segments of a source item's URI.
 *
 * Every path segment and, for the last one, the stem without its extension.
 * `fs://archive/Investments/Acme Fund III/call-2026-03.pdf` therefore offers
 * "investments", "acme fund iii" and "call 2026 03". The scheme and host are
 * dropped: a root alias is not evidence about an investment.
 */
export function pathNamesFromUri(uri: unknown): string[] {
  if (typeof uri !== "string" || !uri) return [];
  const withoutScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const segments = withoutScheme.split("/").filter(Boolean);
  // The first segment of `fs://<alias>/<path>` is the root alias.
  const named = segments.slice(1);
  const names = new Set<string>();
  named.forEach((segment, index) => {
    const decoded = safeDecode(segment);
    const normalized = normalizeMatchName(decoded);
    if (normalized) names.add(normalized);
    if (index === named.length - 1) {
      const stem = normalizeMatchName(decoded.replace(/\.[a-z0-9]{1,8}$/i, ""));
      if (stem) names.add(stem);
    }
  });
  return [...names];
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Exact decimal arithmetic. BigInt only.
// ---------------------------------------------------------------------------

/** An exact decimal string, `units`-style: the value in 10^-scale units,
 * half-up on the first dropped digit. Mirrors the importer's own `units`. */
function unitsAtScale(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^[-+]/, "").split(".");
  const padded = `${fraction}${"0".repeat(scale + 1)}`;
  const kept = BigInt(`${whole}${padded.slice(0, scale)}`);
  const next = padded.charCodeAt(scale) - 48;
  const rounded = next >= 5 ? kept + 1n : kept;
  return negative ? -rounded : rounded;
}

const MONEY_SCALE = 6;
const RATE_SCALE = 10;
const CENTS = 2;

/** `amount * rate`, in cents, half-up. The importer's `multiplyDecimals` with
 * `scale = 2`, said in BigInt without the string round trip. */
function multiplyToCents(amount: string, rate: string): bigint {
  const product = unitsAtScale(amount, MONEY_SCALE) * unitsAtScale(rate, RATE_SCALE);
  const divisor = 10n ** BigInt(MONEY_SCALE + RATE_SCALE - CENTS);
  const half = divisor / 2n;
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const scaled = (magnitude + half) / divisor;
  return negative ? -scaled : scaled;
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * The importer's rate tolerance, in cents: the larger of 1% of the target and
 * $1.00. Exported so a test can pin both sides of the boundary.
 */
export function rateToleranceCents(targetCents: bigint): bigint {
  const fraction = absoluteBigInt(targetCents) / RATE_TOLERANCE_FRACTION;
  return fraction > RATE_TOLERANCE_FLOOR_CENTS
    ? fraction
    : RATE_TOLERANCE_FLOOR_CENTS;
}

const DECIMAL = /^-?\d{1,20}(\.\d{1,18})?$/;

/**
 * Whether a document's money value is this entry's amount.
 *
 * Same currency is an EXACT comparison with no tolerance, which is what the
 * plan asks for: `compareDecimals` over the two decimal strings.
 *
 * Different currencies use the entry's own recorded `exchange_rate` (the rate
 * to USD, migration 025) and the importer's tolerance, per the owner's
 * decision of 2026-09-19. That conversion is only possible in one direction:
 * the rate lives on the entry, so a non-USD ENTRY can be compared with a USD
 * document. A non-USD DOCUMENT against a USD entry has no recorded rate to
 * convert with, and inventing one -- a market rate, another entry's rate --
 * is exactly the fabrication this whole design refuses. It therefore scores
 * no amount point, which costs a suggestion its auto-link and never produces
 * a wrong one.
 */
export function amountMatches(input: {
  documentAmount: string;
  documentCurrency: string;
  entryAmount: string;
  entryCurrency: string;
  entryExchangeRate: string | null;
}): { matched: boolean; converted?: { entryUsdCents: string; toleranceCents: string } } {
  const { documentAmount, entryAmount } = input;
  if (!DECIMAL.test(documentAmount) || !DECIMAL.test(entryAmount)) {
    return { matched: false };
  }
  // A document never states a negative amount for money that moved; an entry
  // may (a reduced `commitment_change`). Compare magnitudes, so a reduction
  // of 50,000 still recognises the agreement that states 50,000.
  const documentMagnitude = documentAmount.replace(/^-/, "");
  const entryMagnitude = entryAmount.replace(/^-/, "");
  if (input.documentCurrency === input.entryCurrency) {
    return { matched: compareDecimals(documentMagnitude, entryMagnitude) === 0 };
  }
  if (input.documentCurrency !== "USD") return { matched: false };
  if (input.entryExchangeRate === null) return { matched: false };
  if (!DECIMAL.test(input.entryExchangeRate)) return { matched: false };
  const entryUsdCents = multiplyToCents(entryMagnitude, input.entryExchangeRate);
  const documentCents = unitsAtScale(documentMagnitude, CENTS);
  const tolerance = rateToleranceCents(entryUsdCents);
  return {
    matched: absoluteBigInt(documentCents - entryUsdCents) <= tolerance,
    converted: {
      entryUsdCents: entryUsdCents.toString(),
      toleranceCents: tolerance.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date as whole UTC days since the epoch, or null when it is not
 * a real date. `2026-02-31` matches the pattern and is not a date. */
export function calendarDays(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  if (!new Date(parsed).toISOString().startsWith(value)) return null;
  return Math.round(parsed / 86_400_000);
}

/**
 * Whether a document's date falls in the kind's window.
 *
 * A date with a precision of `year` or `month` NEVER satisfies a window, at
 * any kind, and this is the file's most important line. The alternative --
 * treating "March 2024" as some day in March -- is a fabricated day, and a
 * fabricated day is what would then go on to replace an estimated entry date
 * and be read back as fact. Losing the two date points costs a candidate its
 * auto-link and leaves it a suggestion, which is the safe direction.
 */
export function dateInWindow(input: {
  documentDate: string;
  precision: DatePrecision | undefined;
  window: DateWindow;
  entryDate: string | null;
  investmentSignedOn: string | null;
}): boolean {
  if ((input.precision ?? "day") !== "day") return false;
  if (input.window.anchor === "none") return false;
  const document = calendarDays(input.documentDate);
  if (document === null) return false;
  const anchorDate =
    input.window.anchor === "entry"
      ? input.entryDate
      : (input.investmentSignedOn ?? input.entryDate);
  if (anchorDate === null) return false;
  const anchor = calendarDays(anchorDate);
  if (anchor === null) return false;
  return Math.abs(document - anchor) <= input.window.days;
}

// ---------------------------------------------------------------------------
// Scoring one candidate
// ---------------------------------------------------------------------------

/** One statement of a document's extraction, as the scorer reads it: the
 * current observation value, with the citation that proves it. */
export type ScorableStatement = {
  field: string;
  valueType: string;
  observationKey: string;
  evidenceSpanId: string;
  value: ObservationValue | null;
};

/** What a link cites: one statement of one document. */
export type LinkEvidence = {
  field: string;
  observationKey: string;
  evidenceSpanId: string;
};

/** One signal that fired, with what it was computed from. */
export type LinkSignalRecord = {
  signal: LinkSignal;
  points: number;
  detail: Record<string, string>;
};

export type ScorableInvestment = {
  id: string;
  /** The investment's own name and every alias of its entity, normalized. */
  normalizedNames: readonly string[];
  signedOn: string | null;
};

export type ScorableEntry = {
  id: string;
  investmentId: string;
  entryType: InvestmentEntryType;
  entryDate: string;
  amount: string;
  currency: string;
  exchangeRate: string | null;
  dateIsEstimated: boolean;
  /** True when this entry already carries an `auto_linked` or `confirmed`
   * link. Section 2's auto-link condition reads it. */
  hasLiveLink: boolean;
};

/** The whole result of scoring one (investment, entry?) pair. */
export type ScoredCandidate = {
  investmentId: string;
  entryId: string | null;
  score: number;
  signals: LinkSignalRecord[];
  evidence: LinkEvidence[];
  /** Which signals fired, for the decision below to read without re-deriving. */
  fired: Record<LinkSignal, boolean>;
  /** `party+amount+date`, in signal order. `none` when nothing fired. */
  reason: string;
  /** The date statement that fired, when one did and its field may replace an
   * estimated date. Null otherwise. */
  dateReplacement: {
    field: string;
    date: string;
    observationKey: string;
    evidenceSpanId: string;
  } | null;
  entryHasLiveLink: boolean;
};

function statementDate(
  statement: ScorableStatement,
): { value: string; precision: DatePrecision | undefined } | null {
  const value = statement.value;
  if (!value || value.type !== "date") return null;
  return { value: value.value, precision: value.precision };
}

/**
 * Score one (investment, entry) pair against one document.
 *
 * `entry` null scores an investment-level link: party and path only, because
 * there is no amount and no date to compare against.
 */
export function scoreCandidate(input: {
  kind: MatchableKind;
  statements: readonly ScorableStatement[];
  investment: ScorableInvestment;
  entry: ScorableEntry | null;
  /** Normalized path names from `source_items.uri`. */
  pathNames: readonly string[];
}): ScoredCandidate {
  const names = new Set(input.investment.normalizedNames);
  const signals: LinkSignalRecord[] = [];
  const evidence: LinkEvidence[] = [];
  const fired: Record<LinkSignal, boolean> = {
    party: false,
    amount: false,
    date: false,
    path: false,
  };

  // Party. Any organization-typed statement naming this investment. Matching
  // on the VALUE TYPE rather than on the plan's list of field names (`fund`,
  // `company`, `partnership`, `issuer`, `platform`, `sender`) covers all six
  // and every organization field a future kind declares, and it cannot be
  // fooled by a text field that happens to be called `fund`.
  for (const statement of input.statements) {
    if (statement.valueType !== "organization") continue;
    const value = statement.value;
    const text =
      value && value.type === "text"
        ? value.value
        : value && value.type === "entity"
          ? null
          : null;
    const normalized = normalizeMatchName(text);
    if (!normalized || !names.has(normalized)) continue;
    fired.party = true;
    signals.push({
      signal: "party",
      points: LINK_SIGNAL_POINTS.party,
      detail: { field: statement.field, name: normalized },
    });
    evidence.push({
      field: statement.field,
      observationKey: statement.observationKey,
      evidenceSpanId: statement.evidenceSpanId,
    });
    break;
  }

  // Path.
  for (const name of input.pathNames) {
    if (!names.has(name)) continue;
    fired.path = true;
    signals.push({
      signal: "path",
      points: LINK_SIGNAL_POINTS.path,
      detail: { segment: name },
    });
    break;
  }

  let dateReplacement: ScoredCandidate["dateReplacement"] = null;
  if (input.entry) {
    const entry = input.entry;
    // Amount, from the kind's one money field.
    if (input.kind.amountField !== null) {
      for (const statement of input.statements) {
        if (statement.field !== input.kind.amountField) continue;
        const value = statement.value;
        if (!value || value.type !== "money") continue;
        const match = amountMatches({
          documentAmount: value.amount,
          documentCurrency: value.currency,
          entryAmount: entry.amount,
          entryCurrency: entry.currency,
          entryExchangeRate: entry.exchangeRate,
        });
        if (!match.matched) continue;
        fired.amount = true;
        signals.push({
          signal: "amount",
          points: LINK_SIGNAL_POINTS.amount,
          detail: {
            field: statement.field,
            amount: value.amount,
            currency: value.currency,
            ...(match.converted
              ? {
                  entryUsdCents: match.converted.entryUsdCents,
                  toleranceCents: match.converted.toleranceCents,
                }
              : {}),
          },
        });
        evidence.push({
          field: statement.field,
          observationKey: statement.observationKey,
          evidenceSpanId: statement.evidenceSpanId,
        });
        break;
      }
    }

    // Date, from the kind's date fields in preference order.
    for (const field of input.kind.dateFields) {
      const statement = input.statements.find((item) => item.field === field);
      if (!statement) continue;
      const date = statementDate(statement);
      if (!date) continue;
      if (
        !dateInWindow({
          documentDate: date.value,
          precision: date.precision,
          window: input.kind.dateWindow,
          entryDate: entry.entryDate,
          investmentSignedOn: input.investment.signedOn,
        })
      ) {
        continue;
      }
      fired.date = true;
      signals.push({
        signal: "date",
        points: LINK_SIGNAL_POINTS.date,
        detail: { field: statement.field, date: date.value },
      });
      evidence.push({
        field: statement.field,
        observationKey: statement.observationKey,
        evidenceSpanId: statement.evidenceSpanId,
      });
      if (input.kind.dateReplacementFields.includes(field)) {
        dateReplacement = {
          field,
          date: date.value,
          observationKey: statement.observationKey,
          evidenceSpanId: statement.evidenceSpanId,
        };
      }
      break;
    }
  }

  const score = signals.reduce((total, signal) => total + signal.points, 0);
  const order: LinkSignal[] = ["party", "amount", "date", "path"];
  const reason = order.filter((signal) => fired[signal]).join("+") || "none";
  return {
    investmentId: input.investment.id,
    entryId: input.entry?.id ?? null,
    score,
    signals,
    evidence,
    fired,
    reason,
    dateReplacement,
    entryHasLiveLink: input.entry?.hasLiveLink ?? false,
  };
}

// ---------------------------------------------------------------------------
// Deciding over a document's candidates
// ---------------------------------------------------------------------------

/** Why nothing was auto-linked. One closed word, stored on every row. */
export type NoAutoLinkReason =
  | "kind_not_auto_linkable"
  | "no_qualifying_candidate"
  | "two_candidates_qualify"
  | "tie_within_margin"
  | "entry_already_linked";

export type LinkDecision = {
  /** The one candidate to write as `auto_linked`, or null. */
  autoLink: ScoredCandidate | null;
  /** Every candidate at or above the suggest threshold, best first. Excludes
   * `autoLink` when there is one. */
  suggestions: ScoredCandidate[];
  /** Present when nothing was auto-linked, which is the usual case. */
  noAutoLinkReason: NoAutoLinkReason | null;
};

/**
 * Deterministic order: best score first, then investment, then entry. Two
 * candidates with the same score must never swap between runs, or the "best
 * two" test below would decide differently on identical inputs.
 */
function byRank(left: ScoredCandidate, right: ScoredCandidate): number {
  return (
    right.score - left.score ||
    left.investmentId.localeCompare(right.investmentId) ||
    (left.entryId ?? "").localeCompare(right.entryId ?? "")
  );
}

/**
 * Section 2's decision table, over one document's scored candidates.
 *
 * Auto-link needs all of: the kind is one of the three payment kinds; party,
 * amount and date all fired; exactly one candidate qualifies that way; the
 * entry has no live link already; and no other candidate is within
 * `LINK_TIE_MARGIN_POINTS` of it.
 */
export function decideLinks(input: {
  kind: MatchableKind;
  candidates: readonly ScoredCandidate[];
  /** How many suggestions one document may offer. */
  maxSuggestions: number;
}): LinkDecision {
  const ranked = [...input.candidates]
    .filter((candidate) => candidate.score >= LINK_SUGGEST_POINTS)
    .sort(byRank);
  const suggestOnly = (reason: NoAutoLinkReason): LinkDecision => ({
    autoLink: null,
    suggestions: ranked.slice(0, input.maxSuggestions),
    noAutoLinkReason: reason,
  });

  if (!input.kind.autoLinkable) return suggestOnly("kind_not_auto_linkable");
  const qualifying = ranked.filter(
    (candidate) =>
      candidate.entryId !== null &&
      candidate.fired.party &&
      candidate.fired.amount &&
      candidate.fired.date,
  );
  if (qualifying.length === 0) return suggestOnly("no_qualifying_candidate");
  // Two entries that both match on party, amount and date is the shape of two
  // identical capital calls in one month. Suggest both, link neither.
  if (qualifying.length > 1) return suggestOnly("two_candidates_qualify");
  const best = qualifying[0]!;
  if (best.entryHasLiveLink) return suggestOnly("entry_already_linked");
  const runnerUp = ranked.find((candidate) => candidate !== best);
  if (runnerUp && best.score - runnerUp.score <= LINK_TIE_MARGIN_POINTS) {
    return suggestOnly("tie_within_margin");
  }
  return {
    autoLink: best,
    suggestions: ranked
      .filter((candidate) => candidate !== best)
      .slice(0, input.maxSuggestions),
    noAutoLinkReason: null,
  };
}
