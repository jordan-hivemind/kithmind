import {
  CARD_SCHEMAS,
  type CardFieldSchema,
  type CardNormalizerId,
  type CardRecordKind,
  cardObservationKey,
} from "./cardSchemas";
import {
  canonicalizeDecimal,
  canonicalizeObservationValue,
  validateCurrencyCode,
  validateUnitCode,
} from "./values";
import type { ObservationValue } from "./values";

/**
 * Section 5.2 of docs/plans/2026-09-12-document-cards.md: the gate decides,
 * not the model. Every function in this file is pure and synchronous. No
 * model is asked whether an extraction is correct and no self-reported
 * confidence is read: a field is storable only when the sealed span text,
 * run through the field's declared normalizer, reproduces the proposed value.
 *
 * Rule 1 (the span resolves in the sealed retained text and its recomputed
 * `quoteHash` matches) is proved by `probeFieldEvidence`, which already
 * recomputes the page hash, the page-relative UTF-16 range and the quote
 * hash against the generation's text chain. Its outcome enters this module as
 * `evidenceFailure` so the closed code is reported in one place. Rules 2
 * through 7 are applied here.
 */

/**
 * Bumped whenever a normalizer, the date format list, the negation marker
 * list or the currency symbol table changes. Section 4.6 puts it in the card
 * extraction fingerprint, so a gate change is a new generation rather than a
 * silent revaluation of a stored card.
 */
export const CARD_GATE_VERSION = "card-gate-v4";

/** The declared, versioned format list of rule 4. */
export const CARD_DATE_FORMAT_LIST_VERSION = "card-date-formats-v2";

/** The declared, versioned marker list of rule 7. */
export const CARD_NEGATION_MARKER_LIST_VERSION = "card-negations-v1";

/**
 * The closed failure set. A field either passes or carries exactly one of
 * these, so a review surface can count causes without reading any value.
 */
export const CARD_GATE_FAILURE_CODES = [
  /** Rule 1: no span was cited, or too many, or duplicates. */
  "evidence_missing",
  /** Rule 1: the span does not resolve in the sealed retained text. */
  "span_unresolved",
  /** Rule 1: the recomputed quote hash does not match the stored one. */
  "quote_hash_mismatch",
  /** Rules 2, 6 and 7: the span text does not reproduce the stored value. */
  "value_not_in_span",
  /** Rules 2 to 5: the span text does not pass the declared normalizer. */
  "value_not_normalizable",
  /** Rule 3: unsupported currency, or one the span does not carry. */
  "currency_mismatch",
  /** Rule 4: the span reads as two different dates under the format list. */
  "date_ambiguous",
  /** Rule 5: the unit code is absent, unsupported, or not the span's unit. */
  "unit_code_invalid",
  /** Rule 7: the span neither asserts nor explicitly negates the clause. */
  "boolean_unsupported_span",
  /** The field, its value type or its observation key is not declared. */
  "field_not_declared",
  /** A declared required field has no candidate at all. */
  "required_field_absent",
  /** An `entity` value: binding is P2-70l, the gate proves literal names. */
  "entity_value_unsupported",
  /** A declared `maxChars` field's value is longer than the limit allows. */
  "value_too_long",
] as const;

export type CardGateFailureCode = (typeof CARD_GATE_FAILURE_CODES)[number];

export type CardGateCandidate = {
  field: string;
  ordinal?: number;
  value: ObservationValue;
  /** Sealed span texts, already proved under rule 1. */
  spanTexts: readonly string[];
  /** Set when rule 1 failed; rules 2 to 7 are then not reached. */
  evidenceFailure?: CardGateFailureCode;
};

export type CardGateFieldResult = {
  /** The observation key: `<field>` or `<field>:<ordinal>`. */
  key: string;
  field: string;
  required: boolean;
} & ({ status: "pass" } | { status: "fail"; code: CardGateFailureCode });

export type CardGateReport = {
  results: CardGateFieldResult[];
  /** Keys that may be staged. Empty when a required field failed. */
  passedKeys: string[];
  /** Optional-field failures. Empty when a required field failed. */
  dropped: Array<{ key: string; code: CardGateFailureCode }>;
  /** Every failure, required or not. */
  failed: Array<{ key: string; code: CardGateFailureCode }>;
  requiredFailed: boolean;
  gateVersion: string;
};

// --- shared text handling -------------------------------------------------

/** The only text transform a normalizer may apply before comparing. */
function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function fold(value: string): string {
  return collapse(value).toLowerCase();
}

/** Grouping separators. The full stop is deliberately absent: it is a radix
 * point in the formats this registry accepts, and guessing between the two is
 * exactly the ambiguity rule 4 refuses elsewhere. */
const GROUPING_SEPARATORS = /[,\s_]/gu;

function stripGrouping(value: string): string {
  return value.replace(GROUPING_SEPARATORS, "");
}

/**
 * Rule 3 and rule 5: every numeral crosses into a value through
 * `canonicalizeDecimal`, which parses base-10 strings with BigInt. No value
 * passes through a JavaScript number at any point in this file.
 */
function canonicalOrNull(value: string): string | null {
  try {
    return canonicalizeDecimal(value);
  } catch {
    return null;
  }
}

// --- rule 4: the declared date format list --------------------------------

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

function monthNumber(name: string): string | null {
  const folded = name.toLowerCase().replace(/\.$/u, "");
  const index = MONTH_NAMES.findIndex(
    (month) => month === folded || month.slice(0, 3) === folded,
  );
  return index < 0 ? null : String(index + 1).padStart(2, "0");
}

function pad(value: string): string {
  return value.padStart(2, "0");
}

/**
 * A bare two-digit year is unambiguous only relative to a fixed pivot, never
 * the clock: reading it against today's date would make the same span parse
 * to a different year depending on when the gate happens to run, which is
 * exactly the kind of impurity this file's rules forbid. `strptime`'s own
 * `%y` convention is the fixed pivot used here: 00-68 is 2000-2068, 69-99 is
 * 1969-1999.
 */
function expandTwoDigitYear(twoDigits: string): string {
  const year = Number(twoDigits);
  return String(year <= 68 ? 2000 + year : 1900 + year);
}

type CardDateFormat = {
  id: string;
  parse: (text: string) => string | null;
};

/**
 * Rule 4. Two formats in this list can match one span, and when they produce
 * different dates the field fails rather than picking one. `mdy_slash` and
 * `dmy_slash` are both here on purpose: that is the pair that makes
 * `03/04/2025` ambiguous instead of silently American.
 */
export const CARD_DATE_FORMATS: readonly CardDateFormat[] = [
  {
    id: "iso_ymd",
    parse: (text) => {
      const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(text);
      return match ? `${match[1]}-${pad(match[2]!)}-${pad(match[3]!)}` : null;
    },
  },
  {
    id: "mdy_slash",
    parse: (text) => {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(text);
      return match ? `${match[3]}-${pad(match[1]!)}-${pad(match[2]!)}` : null;
    },
  },
  {
    id: "dmy_slash",
    parse: (text) => {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(text);
      return match ? `${match[3]}-${pad(match[2]!)}-${pad(match[1]!)}` : null;
    },
  },
  {
    id: "month_name_mdy",
    parse: (text) => {
      const match = /^([A-Za-z.]+) (\d{1,2}),? (\d{4})$/u.exec(text);
      if (!match) return null;
      const month = monthNumber(match[1]!);
      return month ? `${match[3]}-${month}-${pad(match[2]!)}` : null;
    },
  },
  {
    id: "month_name_dmy",
    parse: (text) => {
      const match = /^(\d{1,2}) ([A-Za-z.]+),? (\d{4})$/u.exec(text);
      if (!match) return null;
      const month = monthNumber(match[2]!);
      return month ? `${match[3]}-${month}-${pad(match[1]!)}` : null;
    },
  },
  /**
   * P2-82: an ISO date with a trailing time and, optionally, a timezone
   * offset. Only the date portion is read; the time is not a second
   * candidate, since rule 4 is about which calendar date a span states, not
   * about the time of day.
   */
  {
    id: "iso_ymd_datetime",
    parse: (text) => {
      const match = /^(\d{4})-(\d{1,2})-(\d{1,2})T.+$/u.exec(text);
      return match ? `${match[1]}-${pad(match[2]!)}-${pad(match[3]!)}` : null;
    },
  },
  /**
   * P2-82: a two-digit year, expanded through `expandTwoDigitYear`'s fixed
   * pivot. Declared as a slash pair exactly like `mdy_slash`/`dmy_slash`, so
   * the same ambiguity Set that already refuses `03/04/2025` also refuses a
   * two-digit-year span that reads as two different real calendar dates,
   * rather than a special case picking one.
   */
  {
    id: "mdy_slash_2digit",
    parse: (text) => {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/u.exec(text);
      if (!match) return null;
      const year = expandTwoDigitYear(match[3]!);
      return `${year}-${pad(match[1]!)}-${pad(match[2]!)}`;
    },
  },
  {
    id: "dmy_slash_2digit",
    parse: (text) => {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/u.exec(text);
      if (!match) return null;
      const year = expandTwoDigitYear(match[3]!);
      return `${year}-${pad(match[2]!)}-${pad(match[1]!)}`;
    },
  },
];

/** A candidate that is not a real calendar date is not a candidate. */
function realCalendarDate(candidate: string): boolean {
  try {
    canonicalizeObservationValue({ type: "date", value: candidate });
    return true;
  } catch {
    return false;
  }
}

// --- rule 3: the currency indicators the span may carry -------------------

/**
 * A symbol narrows the currency to a set; it never picks one. The proposed
 * currency must be in the set the span's indicator allows, which is what
 * keeps `$1,000` from proving `EUR` without letting it prove `CAD` over
 * `USD` either.
 */
const CURRENCY_SYMBOLS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["US$", ["USD"]],
  ["CA$", ["CAD"]],
  ["A$", ["AUD"]],
  ["NZ$", ["NZD"]],
  ["HK$", ["HKD"]],
  ["S$", ["SGD"]],
  ["€", ["EUR"]],
  ["£", ["GBP"]],
  ["₹", ["INR"]],
  ["₩", ["KRW"]],
  ["¥", ["JPY", "CNY"]],
  ["kr", ["SEK"]],
  ["$", ["USD", "CAD", "AUD", "HKD", "MXN", "NZD", "SGD"]],
];

function isIsoCode(token: string): boolean {
  if (!/^[A-Z]{3}$/u.test(token)) return false;
  try {
    validateCurrencyCode(token);
    return true;
  } catch {
    return false;
  }
}

/** Strips one currency indicator and reports which currencies it allows. */
function splitCurrency(text: string): {
  rest: string;
  allowed: readonly string[] | undefined;
} {
  const trailing = /^(.*?)\s*([A-Za-z]{3})$/u.exec(text);
  if (trailing && isIsoCode(trailing[2]!)) {
    return { rest: trailing[1]!.trim(), allowed: [trailing[2]!] };
  }
  const leading = /^([A-Za-z]{3})\s*(.*)$/u.exec(text);
  if (leading && isIsoCode(leading[1]!)) {
    return { rest: leading[2]!.trim(), allowed: [leading[1]!] };
  }
  for (const [symbol, allowed] of CURRENCY_SYMBOLS) {
    if (text.startsWith(symbol)) {
      return { rest: text.slice(symbol.length).trim(), allowed };
    }
    if (text.endsWith(symbol)) {
      return { rest: text.slice(0, -symbol.length).trim(), allowed };
    }
  }
  return { rest: text, allowed: undefined };
}

// --- rule 7: the declared negation marker list ----------------------------

/**
 * ponytail: span-scope negation. A marker anywhere in the cited span negates
 * the clause, with no syntactic scope analysis. The span is a tight quote of
 * the clause, so this holds for the spans the gate accepts; a clause whose
 * span mixes an assertion and an unrelated negation reads as negated, which
 * fails closed. Upgrade path is a parsed scope, and it would bump
 * CARD_NEGATION_MARKER_LIST_VERSION and the gate version with it.
 */
export const CARD_NEGATION_MARKERS: readonly string[] = [
  "no ",
  "not ",
  "never ",
  "without ",
  "none ",
  "excluded",
  "shall have no",
  "does not have",
];

// --- the normalizer registry ----------------------------------------------

type NormalizerResult = CardGateFailureCode | null;

type Normalizer = (
  spanText: string,
  value: ObservationValue,
  field: CardFieldSchema,
) => NormalizerResult;

/**
 * Shared by `money_v1` and `money_usd_default_v1`. `defaultCurrency` is
 * consulted only when the span carries no indicator at all; a span that does
 * carry one is held to it exactly the same way for both normalizers.
 */
function matchMoney(
  spanText: string,
  value: ObservationValue,
  defaultCurrency?: string,
): NormalizerResult {
  if (value.type !== "money") return "field_not_declared";
  try {
    validateCurrencyCode(value.currency);
  } catch {
    return "currency_mismatch";
  }
  // The sign, the accounting parentheses and the currency indicator can
  // wrap each other in either order: `($1,250.00)` and `$(1,250.00)` are
  // the same amount. Peel one layer at a time rather than guessing.
  let numeral = collapse(spanText);
  let negative = false;
  let allowed: readonly string[] | undefined;
  for (let layer = 0; layer < 3; layer += 1) {
    const parenthesized = /^\((.*)\)$/u.exec(numeral);
    if (parenthesized) {
      negative = !negative;
      numeral = parenthesized[1]!.trim();
      continue;
    }
    if (numeral.startsWith("-")) {
      negative = !negative;
      numeral = numeral.slice(1).trim();
      continue;
    }
    if (!allowed) {
      const split = splitCurrency(numeral);
      if (split.allowed) {
        allowed = split.allowed;
        numeral = split.rest;
        continue;
      }
    }
    break;
  }
  if (!allowed && defaultCurrency) allowed = [defaultCurrency];
  if (!allowed || !allowed.includes(value.currency)) {
    return "currency_mismatch";
  }
  numeral = stripGrouping(numeral);
  const spanAmount = canonicalOrNull(`${negative ? "-" : ""}${numeral}`);
  const storedAmount = canonicalOrNull(value.amount);
  if (spanAmount === null) return "value_not_normalizable";
  if (storedAmount === null) return "value_not_normalizable";
  return spanAmount === storedAmount ? null : "value_not_in_span";
}

/**
 * Rule 5: a percentage or rate canonicalizes to a decimal carrying the unit
 * the span states. `20%` proves `20` with unit `%` and never `0.2` with unit
 * `1`: the registry declares no implicit conversions. Shared by `rate_v1` and
 * by the decimal half of `money_or_number_v1`.
 */
function matchRate(
  spanText: string,
  value: ObservationValue,
): NormalizerResult {
  if (value.type !== "decimal") return "field_not_declared";
  let text = collapse(spanText);
  const percent = text.endsWith("%");
  if (percent) text = text.slice(0, -1).trim();
  const spanUnit = percent ? "%" : "1";
  try {
    validateUnitCode(value.unitCode);
  } catch {
    return "unit_code_invalid";
  }
  if (value.unitCode !== spanUnit) return "unit_code_invalid";
  const spanValue = canonicalOrNull(stripGrouping(text));
  const storedValue = canonicalOrNull(value.value);
  if (spanValue === null || storedValue === null) {
    return "value_not_normalizable";
  }
  return spanValue === storedValue ? null : "value_not_in_span";
}

/**
 * One normalizer per declared field type, each versioned in its own id so a
 * change to one is visible in the fingerprint through CARD_GATE_VERSION.
 * Every field of every card kind names exactly one of these in CARD_SCHEMAS.
 */
export const CARD_NORMALIZERS = {
  /** Rule 2, verbatim: the span text is the value, whitespace collapsed. */
  text_v1: (spanText, value) => {
    if (value.type !== "text") return "field_not_declared";
    return collapse(spanText) === collapse(value.value)
      ? null
      : "value_not_in_span";
  },

  /** Rule 6: the literal name must appear inside the span. */
  name_v1: (spanText, value) => {
    if (value.type === "entity") return "entity_value_unsupported";
    if (value.type !== "text") return "field_not_declared";
    const needle = collapse(value.value);
    if (!needle) return "value_not_in_span";
    return collapse(spanText).includes(needle) ? null : "value_not_in_span";
  },

  /**
   * Rule 3: grouping separators and one currency symbol are stripped, the
   * remainder canonicalizes through `canonicalizeDecimal`, and the currency
   * validates and agrees with the indicator the span actually carries.
   */
  money_v1: (spanText, value) => matchMoney(spanText, value),

  /**
   * Section 5.2's per-kind default currency: US tax forms print a bare
   * amount with no currency symbol or code at all. Declared only for money
   * fields of `tax_return_card`, `k1_card` and `brokerage_tax_package_card`,
   * so the default applies only to those kinds' cards; every other kind
   * still requires an indicator through `money_v1`. Identical to `money_v1`
   * except that a span with no indicator is read as USD instead of failing
   * `currency_mismatch`; a span that does carry an indicator is held to it
   * exactly as `money_v1` holds it.
   */
  money_usd_default_v1: (spanText, value) => matchMoney(spanText, value, "USD"),

  /**
   * P2-70i: a spreadsheet cell states a figure, and whether that figure is
   * money depends on the cell, not on the field. A cell carrying a currency
   * indicator proves a `money` value through `money_v1`'s rules exactly; a
   * bare figure proves a `decimal` through `rate_v1`'s, which means unit code
   * `1` for a plain number and `%` for one the cell ends with. Neither branch
   * guesses: a bare figure never becomes money, and a currency indicator
   * never becomes a bare number.
   */
  money_or_number_v1: (spanText, value) =>
    value.type === "money"
      ? matchMoney(spanText, value)
      : matchRate(spanText, value),

  /**
   * Rule 4: every declared format is tried. Two formats that read the span as
   * two different real dates fail the field; they never pick one.
   */
  date_v1: (spanText, value) => {
    if (value.type !== "date") return "field_not_declared";
    const text = collapse(spanText);
    const candidates = new Set<string>();
    for (const format of CARD_DATE_FORMATS) {
      const candidate = format.parse(text);
      if (candidate && realCalendarDate(candidate)) candidates.add(candidate);
    }
    if (candidates.size > 1) return "date_ambiguous";
    const only = [...candidates][0];
    if (!only) return "value_not_normalizable";
    return only === value.value ? null : "value_not_in_span";
  },

  /**
   * Rule 5: a percentage or rate canonicalizes to a decimal carrying the unit
   * the span states. `20%` proves `20` with unit `%` and never `0.2` with
   * unit `1`: the registry declares no implicit conversions.
   */
  rate_v1: matchRate,

  /** Rule 2 for a whole number: grouping separators, then the same parser. */
  integer_v1: (spanText, value) => {
    if (value.type !== "integer") return "field_not_declared";
    const text = stripGrouping(collapse(spanText));
    if (!/^-?\d+$/u.test(text)) return "value_not_normalizable";
    const spanValue = canonicalOrNull(text);
    const storedValue = canonicalOrNull(value.value);
    if (spanValue === null || storedValue === null) {
      return "value_not_normalizable";
    }
    return spanValue === storedValue ? null : "value_not_in_span";
  },

  /**
   * A closed-set text field, extractive rather than free text: the value must
   * be one of the field's declared `enumValues`, and the cited span must
   * equal it verbatim, exactly as `text_v1` requires for any other span.
   */
  enum_v1: (spanText, value, field) => {
    if (value.type !== "text") return "field_not_declared";
    if (!(field.enumValues ?? []).includes(value.value)) {
      return "value_not_normalizable";
    }
    return collapse(spanText) === collapse(value.value)
      ? null
      : "value_not_in_span";
  },

  /**
   * Rule 7: true only from a span asserting the clause, false only from a
   * span explicitly negating it. A span that does neither stores nothing, and
   * a field with no span at all never reaches a normalizer, so absence stays
   * absence rather than becoming false.
   */
  clause_boolean_v1: (spanText, value, field) => {
    if (value.type !== "boolean") return "field_not_declared";
    const haystack = fold(spanText);
    const asserts = (field.clauseTerms ?? []).some((term) =>
      haystack.includes(term),
    );
    if (!asserts) return "boolean_unsupported_span";
    const negated = CARD_NEGATION_MARKERS.some((marker) =>
      haystack.includes(marker),
    );
    return value.value === !negated ? null : "value_not_in_span";
  },

  /**
   * Section 4.2, decision 1 (P2-82): `card_kind` is a classification proven
   * by the card's own anchor, never by a span of its own. `gateOneField`
   * dispatches this field to a closed-set check before it ever looks at
   * `spanTexts`, so this function is never actually called; it exists only
   * to satisfy the registry's one-normalizer-per-id contract.
   */
  anchor_enum_v1: (_spanText, value, field) => {
    if (value.type !== "text") return "field_not_declared";
    return (field.enumValues ?? []).includes(value.value)
      ? null
      : "value_not_normalizable";
  },
} satisfies Record<CardNormalizerId, Normalizer>;

// --- the gate -------------------------------------------------------------

function gateOneField(
  candidate: CardGateCandidate,
  field: CardFieldSchema,
): CardGateFailureCode | null {
  if (candidate.evidenceFailure) return candidate.evidenceFailure;
  if (!(field.valueTypes as readonly string[]).includes(candidate.value.type)) {
    return "field_not_declared";
  }
  if ((candidate.ordinal === undefined) === Boolean(field.repeated)) {
    return "field_not_declared";
  }
  if (
    field.maxChars !== undefined &&
    candidate.value.type === "text" &&
    candidate.value.value.length > field.maxChars
  ) {
    return "value_too_long";
  }
  if (field.normalizer === "anchor_enum_v1") {
    // Decision 1 of P2-82: proven by the card's own anchor, which has
    // already resolved by the time this candidate reaches the gate (an
    // unresolved anchor refuses the whole card before any field is gated).
    // No span is required or read for this field.
    return candidate.value.type !== "text"
      ? "field_not_declared"
      : (field.enumValues ?? []).includes(candidate.value.value)
        ? null
        : "value_not_normalizable";
  }
  if (candidate.spanTexts.length === 0) return "evidence_missing";
  const normalizer = CARD_NORMALIZERS[field.normalizer];
  let firstFailure: CardGateFailureCode | null = null;
  for (const spanText of candidate.spanTexts) {
    const failure = normalizer(spanText, candidate.value, field);
    if (failure === null) return null;
    firstFailure ??= failure;
  }
  return firstFailure ?? "value_not_in_span";
}

/**
 * Runs rules 1 to 7 over one candidate card. Pure: no database, no network,
 * no model, no clock. The caller decides what to do with the report; the
 * escalation ladder that reads `requiredFailed` is P2-70e.
 */
export function gateCard(input: {
  recordKind: CardRecordKind;
  fields: readonly CardGateCandidate[];
}): CardGateReport {
  const schema = CARD_SCHEMAS[input.recordKind];
  const results: CardGateFieldResult[] = [];
  const seen = new Set<string>();

  for (const candidate of input.fields) {
    const key = cardObservationKey(candidate.field, candidate.ordinal);
    const field = schema.fields[candidate.field];
    if (!field) {
      results.push({
        key,
        field: candidate.field,
        required: false,
        status: "fail",
        code: "field_not_declared",
      });
      continue;
    }
    seen.add(candidate.field);
    const code = gateOneField(candidate, field);
    results.push({
      key,
      field: candidate.field,
      required: field.required === true,
      ...(code === null
        ? ({ status: "pass" } as const)
        : ({ status: "fail", code } as const)),
    });
  }

  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.required === true && !seen.has(name)) {
      results.push({
        key: name,
        field: name,
        required: true,
        status: "fail",
        code: "required_field_absent",
      });
    }
  }

  const failed = results.flatMap((result) =>
    result.status === "fail" ? [{ key: result.key, code: result.code }] : [],
  );
  const requiredFailed = results.some(
    (result) => result.status === "fail" && result.required,
  );
  return {
    results,
    // A required failure stages nothing from this tier, so no optional field
    // is dropped either: the whole candidate card is refused.
    passedKeys: requiredFailed
      ? []
      : results.flatMap((result) =>
          result.status === "pass" ? [result.key] : [],
        ),
    dropped: requiredFailed
      ? []
      : results.flatMap((result) =>
          result.status === "fail"
            ? [{ key: result.key, code: result.code }]
            : [],
        ),
    failed,
    requiredFailed,
    gateVersion: CARD_GATE_VERSION,
  };
}
