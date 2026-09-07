import type { Infer } from "convex/values";

import {
  observationValueValidator,
  occurrenceValidator,
} from "./valueValidators";

export type Occurrence = Infer<typeof occurrenceValidator>;
export type ObservationValue = Infer<typeof observationValueValidator>;
export type OccurrenceComparison =
  "before" | "same" | "after" | "ambiguous" | "unknown";

export const MAX_DECIMAL_DIGITS = 38;
export const MAX_DECIMAL_SCALE = 18;
export const MAX_DATETIME_OFFSET_MINUTES = 14 * 60;
const MAX_DECIMAL_INPUT_CHARS = 80;
const MAX_TEXT_CHARS = 1_000;
const MAX_ORIGINAL_UNIT_CHARS = 80;

/**
 * This is a deliberately bounded Phase 1 subset of the current ISO 4217
 * currency list, not a claim that every ISO currency is supported.
 * Source: ISO 4217 Maintenance Agency, SIX, List One.
 * https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html
 */
export const CURRENCY_REGISTRY_VERSION = "iso-4217-six-list-one-2026-01-p1";
export const CURRENCY_REGISTRY_SOURCE =
  "https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml";
export const SUPPORTED_CURRENCIES = [
  "AUD",
  "CAD",
  "CHF",
  "CNY",
  "EUR",
  "GBP",
  "HKD",
  "INR",
  "JPY",
  "KRW",
  "MXN",
  "NZD",
  "SEK",
  "SGD",
  "USD",
] as const;

/**
 * This registry is a controlled Phase 1 subset of case-sensitive UCUM 2.2
 * codes used by the lab and vehicle-service schemas. It defines no implicit
 * conversions. New codes require a reviewed registry-version change.
 * Sources: the pinned UCUM 2.2 developer essence and common-unit table.
 * https://github.com/ucum-org/ucum/blob/v2.2/ucum-essence.xml
 * https://github.com/ucum-org/ucum/blob/v2.2/common-units/TableOfExampleUcumCodesForElectronicMessaging.xlsx
 */
export const UNIT_REGISTRY_VERSION = "ucum-2.2-p1";
export const UNIT_REGISTRY_SOURCE =
  "https://github.com/ucum-org/ucum/blob/v2.2/common-units/TableOfExampleUcumCodesForElectronicMessaging.xlsx";
export const SUPPORTED_UNIT_CODES = [
  "%",
  "1",
  "/min",
  "10*3/uL",
  "10*6/uL",
  "Cel",
  "K",
  "L",
  "U/L",
  "[IU]/L",
  "[degF]",
  "[ft_i]",
  "[in_i]",
  "[lb_av]",
  "[mi_i]",
  "[mi_i]/h",
  "[oz_av]",
  "cm",
  "d",
  "g",
  "g/dL",
  "h",
  "kg",
  "km",
  "km/h",
  "m",
  "m/s",
  "m[IU]/L",
  "mL",
  "mg",
  "mg/dL",
  "min",
  "mm",
  "mm[Hg]",
  "mmol/L",
  "ng/mL",
  "pg/mL",
  "s",
  "ug",
  "ug/dL",
  "umol/L",
] as const;

const supportedCurrencies = new Set<string>(SUPPORTED_CURRENCIES);
const supportedUnitCodes = new Set<string>(SUPPORTED_UNIT_CODES);

type ParsedDecimal = {
  coefficient: bigint;
  scale: number;
  canonical: string;
};

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function boundedPreservedText(
  value: string,
  label: string,
  maxChars: number,
): string {
  if (!value.trim() || countCharacters(value) > maxChars) {
    throw new Error(`${label} must contain 1-${maxChars} characters`);
  }
  return value;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validateIsoCalendarDate(value: string, label = "Date"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) {
    throw new Error(`${label} is not a real calendar date`);
  }
  return value;
}

function parseDecimal(value: string): ParsedDecimal {
  if (value.length === 0 || value.length > MAX_DECIMAL_INPUT_CHARS) {
    throw new Error(
      `Decimal must contain 1-${MAX_DECIMAL_INPUT_CHARS} ASCII characters`,
    );
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new Error(
      "Decimal must be a base-10 string without whitespace, exponent, or plus sign",
    );
  }

  const negative = match[1] === "-";
  const integer = match[2]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const scale = fraction.length;
  if (scale > MAX_DECIMAL_SCALE) {
    throw new Error(`Decimal scale must not exceed ${MAX_DECIMAL_SCALE}`);
  }

  const unsignedDigits = `${integer}${fraction}`.replace(/^0+/, "") || "0";
  if (unsignedDigits.length > MAX_DECIMAL_DIGITS) {
    throw new Error(`Decimal must not exceed ${MAX_DECIMAL_DIGITS} digits`);
  }

  const zero = unsignedDigits === "0";
  const canonical = `${negative && !zero ? "-" : ""}${integer}${
    fraction ? `.${fraction}` : ""
  }`;
  const coefficient = BigInt(
    `${negative && !zero ? "-" : ""}${integer}${fraction}`,
  );
  return { coefficient, scale, canonical };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function formatDecimal(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const unsigned = (negative ? -coefficient : coefficient).toString();
  if (scale === 0) {
    return canonicalizeDecimal(`${negative ? "-" : ""}${unsigned}`);
  }
  const padded = unsigned.padStart(scale + 1, "0");
  const split = padded.length - scale;
  return canonicalizeDecimal(
    `${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`,
  );
}

export function canonicalizeDecimal(value: string): string {
  return parseDecimal(value).canonical;
}

export function addDecimals(left: string, right: string): string {
  const leftValue = parseDecimal(left);
  const rightValue = parseDecimal(right);
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const coefficient =
    leftValue.coefficient * powerOfTen(scale - leftValue.scale) +
    rightValue.coefficient * powerOfTen(scale - rightValue.scale);
  return formatDecimal(coefficient, scale);
}

export function compareDecimals(left: string, right: string): -1 | 0 | 1 {
  const leftValue = parseDecimal(left);
  const rightValue = parseDecimal(right);
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const leftCoefficient =
    leftValue.coefficient * powerOfTen(scale - leftValue.scale);
  const rightCoefficient =
    rightValue.coefficient * powerOfTen(scale - rightValue.scale);
  return leftCoefficient < rightCoefficient
    ? -1
    : leftCoefficient > rightCoefficient
      ? 1
      : 0;
}

export function validateCurrencyCode(currency: string): string {
  if (!supportedCurrencies.has(currency)) {
    throw new Error(
      `Unsupported ISO 4217 currency ${JSON.stringify(currency)} for registry ${CURRENCY_REGISTRY_VERSION}`,
    );
  }
  return currency;
}

export function validateUnitCode(unitCode: string): string {
  if (!supportedUnitCodes.has(unitCode)) {
    throw new Error(
      `Unsupported UCUM unit ${JSON.stringify(unitCode)} for registry ${UNIT_REGISTRY_VERSION}`,
    );
  }
  return unitCode;
}

function canonicalizeInteger(value: string): string {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(
      "Integer must be a base-10 string without whitespace, decimal point, exponent, or plus sign",
    );
  }
  return canonicalizeDecimal(value);
}

export function canonicalizeObservationValue(
  value: ObservationValue,
): ObservationValue {
  switch (value.type) {
    case "decimal":
      return {
        type: "decimal",
        value: canonicalizeDecimal(value.value),
        unitCode: validateUnitCode(value.unitCode),
        ...(value.originalUnit === undefined
          ? {}
          : {
              originalUnit: boundedPreservedText(
                value.originalUnit,
                "Original unit",
                MAX_ORIGINAL_UNIT_CHARS,
              ),
            }),
      };
    case "money":
      return {
        type: "money",
        amount: canonicalizeDecimal(value.amount),
        currency: validateCurrencyCode(value.currency),
      };
    case "integer":
      return {
        type: "integer",
        value: canonicalizeInteger(value.value),
        ...(value.unitCode === undefined
          ? {}
          : { unitCode: validateUnitCode(value.unitCode) }),
      };
    case "text":
      return {
        type: "text",
        value: boundedPreservedText(value.value, "Text value", MAX_TEXT_CHARS),
      };
    case "boolean":
      return value;
    case "date":
      return {
        type: "date",
        value: validateIsoCalendarDate(value.value, "Observation date"),
      };
    case "entity":
      return value;
  }
}

function parseOffsetMinutes(originalOffset: string): number {
  if (originalOffset === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(originalOffset);
  if (!match) {
    throw new Error("Datetime offset must be Z or an RFC 3339 numeric offset");
  }
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const absoluteMinutes = hours * 60 + minutes;
  if (
    minutes > 59 ||
    absoluteMinutes > MAX_DATETIME_OFFSET_MINUTES ||
    originalOffset === "-00:00"
  ) {
    throw new Error(
      "Datetime offset must be known and within the supported range -14:00 through +14:00",
    );
  }
  return match[1] === "-" ? -absoluteMinutes : absoluteMinutes;
}

function datetimeCalendarDate(instant: number, originalOffset: string): string {
  const offsetMinutes = parseOffsetMinutes(originalOffset);
  const localInstant = instant + offsetMinutes * 60_000;
  const date = new Date(localInstant);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Datetime instant is outside the supported calendar range");
  }
  const iso = date.toISOString();
  const calendarDate = iso.slice(0, 10);
  return validateIsoCalendarDate(calendarDate, "Datetime local date");
}

export function validateOccurrence(occurrence: Occurrence): Occurrence {
  switch (occurrence.precision) {
    case "unknown":
      return occurrence;
    case "date":
      return {
        precision: "date",
        date: validateIsoCalendarDate(occurrence.date, "Occurrence date"),
      };
    case "datetime":
      if (!Number.isSafeInteger(occurrence.instant)) {
        throw new Error(
          "Datetime instant must be a finite safe-integer Unix millisecond",
        );
      }
      datetimeCalendarDate(occurrence.instant, occurrence.originalOffset);
      return occurrence;
  }
}

export function occurrenceCalendarDate(
  occurrence: Occurrence,
): string | undefined {
  const valid = validateOccurrence(occurrence);
  switch (valid.precision) {
    case "unknown":
      return undefined;
    case "date":
      return valid.date;
    case "datetime":
      return datetimeCalendarDate(valid.instant, valid.originalOffset);
  }
}

function calendarDateInstantBounds(date: string): {
  earliest: number;
  latestExclusive: number;
} {
  const validDate = validateIsoCalendarDate(date, "Occurrence date");
  const utcStart = Date.parse(`${validDate}T00:00:00Z`);
  if (!Number.isFinite(utcStart)) {
    throw new Error("Occurrence date is outside the supported calendar range");
  }
  const offsetRangeMs = MAX_DATETIME_OFFSET_MINUTES * 60_000;
  return {
    earliest: utcStart - offsetRangeMs,
    latestExclusive: utcStart + 24 * 60 * 60_000 + offsetRangeMs,
  };
}

function compareDateWithInstant(
  date: string,
  instant: number,
): Exclude<OccurrenceComparison, "same" | "unknown"> {
  const bounds = calendarDateInstantBounds(date);
  if (instant < bounds.earliest) return "after";
  if (instant >= bounds.latestExclusive) return "before";
  return "ambiguous";
}

/**
 * Semantic occurrence comparison. Datetimes always compare by their finite
 * instant, even when their original offsets give the opposite calendar-day
 * order. Date-only values compare by date. A date-only value spans its entire
 * local day across every supported offset (-14:00 through +14:00). Mixed
 * values compare only when the datetime falls wholly outside that interval;
 * otherwise they are ambiguous. This avoids manufacturing a timezone or time
 * and keeps strict comparisons transitive across offset boundaries.
 */
export function compareOccurrences(
  left: Occurrence,
  right: Occurrence,
): OccurrenceComparison {
  const validLeft = validateOccurrence(left);
  const validRight = validateOccurrence(right);
  if (validLeft.precision === "unknown" || validRight.precision === "unknown") {
    return "unknown";
  }
  if (
    validLeft.precision === "datetime" &&
    validRight.precision === "datetime"
  ) {
    return validLeft.instant < validRight.instant
      ? "before"
      : validLeft.instant > validRight.instant
        ? "after"
        : "same";
  }

  if (validLeft.precision === "date" && validRight.precision === "date") {
    return validLeft.date < validRight.date
      ? "before"
      : validLeft.date > validRight.date
        ? "after"
        : "same";
  }
  if (validLeft.precision === "date" && validRight.precision === "datetime") {
    return compareDateWithInstant(validLeft.date, validRight.instant);
  }
  if (validLeft.precision === "datetime" && validRight.precision === "date") {
    const comparison = compareDateWithInstant(
      validRight.date,
      validLeft.instant,
    );
    return comparison === "before"
      ? "after"
      : comparison === "after"
        ? "before"
        : "ambiguous";
  }
  throw new Error("Unsupported occurrence comparison");
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Total ordering for stable traversal and cursors. It must not be interpreted
 * as semantic recency when `compareOccurrences` reports ambiguity or unknown.
 */
export function compareOccurrencesDeterministically(
  left: Occurrence,
  right: Occurrence,
  leftStableId: string,
  rightStableId: string,
): -1 | 0 | 1 {
  const validLeft = validateOccurrence(left);
  const validRight = validateOccurrence(right);
  if (validLeft.precision === "unknown") {
    return validRight.precision === "unknown"
      ? compareStrings(leftStableId, rightStableId)
      : -1;
  }
  if (validRight.precision === "unknown") return 1;

  const leftDate = occurrenceCalendarDate(validLeft)!;
  const rightDate = occurrenceCalendarDate(validRight)!;
  const dateOrder = compareStrings(leftDate, rightDate);
  if (dateOrder !== 0) return dateOrder;
  if (validLeft.precision !== validRight.precision) {
    return validLeft.precision === "date" ? -1 : 1;
  }
  if (
    validLeft.precision === "datetime" &&
    validRight.precision === "datetime" &&
    validLeft.instant !== validRight.instant
  ) {
    return validLeft.instant < validRight.instant ? -1 : 1;
  }
  return compareStrings(leftStableId, rightStableId);
}

/**
 * Selects semantic latest candidates without allowing a deterministic cursor
 * fallback to break a real mixed-precision tie. Known precision is resolved
 * first: latest date-only date and latest datetime instant. Their leaders are
 * then compared using the date-only interval, returning both groups if the
 * mixed comparison is ambiguous.
 */
export function selectLatestOccurrences<T>(
  items: readonly T[],
  occurrenceOf: (item: T) => Occurrence,
  stableIdOf: (item: T) => string,
): { candidates: T[]; undatedCount: number } {
  const dated: T[] = [];
  let undatedCount = 0;
  for (const item of items) {
    const occurrence = validateOccurrence(occurrenceOf(item));
    if (occurrence.precision === "unknown") undatedCount += 1;
    else dated.push(item);
  }

  let latestDates: T[] = [];
  let latestDatetimes: T[] = [];
  for (const item of dated) {
    const occurrence = occurrenceOf(item);
    if (occurrence.precision === "date") {
      if (latestDates.length === 0) {
        latestDates = [item];
      } else {
        const comparison = compareOccurrences(
          occurrence,
          occurrenceOf(latestDates[0]!),
        );
        if (comparison === "after") latestDates = [item];
        else if (comparison === "same") latestDates.push(item);
      }
    } else if (occurrence.precision === "datetime") {
      if (latestDatetimes.length === 0) {
        latestDatetimes = [item];
      } else {
        const comparison = compareOccurrences(
          occurrence,
          occurrenceOf(latestDatetimes[0]!),
        );
        if (comparison === "after") latestDatetimes = [item];
        else if (comparison === "same") latestDatetimes.push(item);
      }
    }
  }

  let candidates: T[];
  if (latestDates.length === 0) candidates = latestDatetimes;
  else if (latestDatetimes.length === 0) candidates = latestDates;
  else {
    const comparison = compareOccurrences(
      occurrenceOf(latestDates[0]!),
      occurrenceOf(latestDatetimes[0]!),
    );
    candidates =
      comparison === "after"
        ? latestDates
        : comparison === "before"
          ? latestDatetimes
          : [...latestDates, ...latestDatetimes];
  }

  candidates.sort((left, right) =>
    compareOccurrencesDeterministically(
      occurrenceOf(left),
      occurrenceOf(right),
      stableIdOf(left),
      stableIdOf(right),
    ),
  );
  return { candidates, undatedCount };
}
