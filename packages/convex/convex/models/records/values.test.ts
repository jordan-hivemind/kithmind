import { describe, expect, test } from "vitest";

import type { Occurrence } from "./values";
import {
  MAX_DECIMAL_DIGITS,
  MAX_DECIMAL_SCALE,
  addDecimals,
  canonicalizeDecimal,
  canonicalizeObservationValue,
  compareDecimals,
  compareOccurrences,
  compareOccurrencesDeterministically,
  occurrenceCalendarDate,
  selectLatestOccurrences,
  validateOccurrence,
} from "./values";

describe("exact decimal values", () => {
  test("canonicalizes without floating-point coercion", () => {
    expect(canonicalizeDecimal("000123.45000")).toBe("123.45");
    expect(canonicalizeDecimal("-000.000")).toBe("0");
    expect(canonicalizeDecimal("0.000000000000000001")).toBe(
      "0.000000000000000001",
    );
  });

  test("adds and compares exactly beyond Number safe integer precision", () => {
    expect(addDecimals("9007199254740993.01", "0.09")).toBe(
      "9007199254740993.1",
    );
    expect(addDecimals("19.95", "19.95")).toBe("39.9");
    expect(addDecimals("-1.2", "0.2")).toBe("-1");
    expect(compareDecimals("9007199254740993", "9007199254740992.999")).toBe(1);
    expect(compareDecimals("01.230", "1.23")).toBe(0);
  });

  test("rejects lossy notation and enforces digit and scale bounds", () => {
    for (const invalid of ["", " 1", "1 ", "+1", ".5", "1.", "1e3", "NaN"]) {
      expect(() => canonicalizeDecimal(invalid)).toThrow();
    }
    expect(() =>
      canonicalizeDecimal(`1.${"0".repeat(MAX_DECIMAL_SCALE)}1`),
    ).toThrow(/scale/);
    expect(() =>
      canonicalizeDecimal("9".repeat(MAX_DECIMAL_DIGITS + 1)),
    ).toThrow(/digits/);
    expect(() => addDecimals("9".repeat(MAX_DECIMAL_DIGITS), "1")).toThrow(
      /digits/,
    );
  });
});

describe("observation values", () => {
  test("canonicalizes supported money, decimals, integers, and dates", () => {
    expect(
      canonicalizeObservationValue({
        type: "money",
        amount: "0019.950",
        currency: "USD",
      }),
    ).toEqual({ type: "money", amount: "19.95", currency: "USD" });
    expect(
      canonicalizeObservationValue({
        type: "decimal",
        value: "005.400",
        unitCode: "mg/dL",
        originalUnit: "mg per dL",
      }),
    ).toEqual({
      type: "decimal",
      value: "5.4",
      unitCode: "mg/dL",
      originalUnit: "mg per dL",
    });
    expect(
      canonicalizeObservationValue({
        type: "integer",
        value: "0012040",
        unitCode: "[mi_i]",
      }),
    ).toEqual({ type: "integer", value: "12040", unitCode: "[mi_i]" });
    expect(
      canonicalizeObservationValue({ type: "date", value: "2024-02-29" }),
    ).toEqual({ type: "date", value: "2024-02-29" });
  });

  test("rejects unsupported registry codes and invalid calendar dates", () => {
    expect(() =>
      canonicalizeObservationValue({
        type: "money",
        amount: "1",
        currency: "usd",
      }),
    ).toThrow(/Unsupported ISO 4217 currency/);
    expect(() =>
      canonicalizeObservationValue({
        type: "decimal",
        value: "1",
        unitCode: "miles",
      }),
    ).toThrow(/Unsupported UCUM unit/);
    expect(() =>
      canonicalizeObservationValue({
        type: "decimal",
        value: "1",
        unitCode: "IU\/L",
      }),
    ).toThrow(/Unsupported UCUM unit/);
    expect(
      canonicalizeObservationValue({
        type: "decimal",
        value: "1",
        unitCode: "m[IU]\/L",
      }),
    ).toMatchObject({ unitCode: "m[IU]/L" });
    expect(() =>
      canonicalizeObservationValue({ type: "date", value: "2023-02-29" }),
    ).toThrow(/real calendar date/);
  });
});

describe("occurrence precision", () => {
  test("validates real dates, finite instants, and RFC 3339 offsets", () => {
    expect(
      validateOccurrence({ precision: "date", date: "2000-02-29" }),
    ).toEqual({ precision: "date", date: "2000-02-29" });
    expect(() =>
      validateOccurrence({ precision: "date", date: "1900-02-29" }),
    ).toThrow(/real calendar date/);
    expect(() =>
      validateOccurrence({
        precision: "datetime",
        instant: 1.5,
        originalOffset: "Z",
      }),
    ).toThrow(/safe-integer/);
    expect(() =>
      validateOccurrence({
        precision: "datetime",
        instant: 0,
        originalOffset: "+24:00",
      }),
    ).toThrow(/offset/);
    expect(() =>
      validateOccurrence({
        precision: "datetime",
        instant: 0,
        originalOffset: "-00:00",
      }),
    ).toThrow(/known/);
  });

  test("derives the calendar date using the retained original offset", () => {
    const instant = Date.parse("2024-04-02T00:30:00Z");
    expect(
      occurrenceCalendarDate({
        precision: "datetime",
        instant,
        originalOffset: "-01:00",
      }),
    ).toBe("2024-04-01");
    expect(
      occurrenceCalendarDate({
        precision: "datetime",
        instant,
        originalOffset: "+02:00",
      }),
    ).toBe("2024-04-02");
  });

  test("compares datetimes by instant even when local-day order is opposite", () => {
    const laterInstantEarlierLocalDay: Occurrence = {
      precision: "datetime",
      instant: Date.parse("2024-04-02T12:00:00Z"),
      originalOffset: "-14:00",
    };
    const earlierInstantLaterLocalDay: Occurrence = {
      precision: "datetime",
      instant: Date.parse("2024-04-02T11:00:00Z"),
      originalOffset: "+14:00",
    };
    expect(occurrenceCalendarDate(laterInstantEarlierLocalDay)).toBe(
      "2024-04-01",
    );
    expect(occurrenceCalendarDate(earlierInstantLaterLocalDay)).toBe(
      "2024-04-03",
    );
    expect(
      compareOccurrences(
        laterInstantEarlierLocalDay,
        earlierInstantLaterLocalDay,
      ),
    ).toBe("after");
  });

  test("reports mixed precision on the same local day as ambiguous", () => {
    const date: Occurrence = { precision: "date", date: "2024-04-02" };
    const datetime: Occurrence = {
      precision: "datetime",
      instant: Date.parse("2024-04-02T23:00:00Z"),
      originalOffset: "Z",
    };
    expect(compareOccurrences(date, datetime)).toBe("ambiguous");
    expect(compareOccurrences(datetime, date)).toBe("ambiguous");
    expect(compareOccurrences({ precision: "unknown" }, date)).toBe("unknown");
  });

  test("uses a conservative date interval for mixed precision", () => {
    const date: Occurrence = { precision: "date", date: "2024-04-02" };
    const adjacentDay: Occurrence = {
      precision: "datetime",
      instant: Date.parse("2024-04-03T01:00:00Z"),
      originalOffset: "+14:00",
    };
    const definitelyLater: Occurrence = {
      precision: "datetime",
      instant: Date.parse("2024-04-04T00:00:00Z"),
      originalOffset: "-14:00",
    };
    expect(compareOccurrences(date, adjacentDay)).toBe("ambiguous");
    expect(compareOccurrences(adjacentDay, date)).toBe("ambiguous");
    expect(compareOccurrences(date, definitelyLater)).toBe("before");
    expect(compareOccurrences(definitelyLater, date)).toBe("after");
  });

  test("selects all mixed-precision latest candidates and reports undated rows", () => {
    const rows: Array<{ id: string; occurrence: Occurrence }> = [
      {
        id: "older-datetime",
        occurrence: {
          precision: "datetime",
          instant: Date.parse("2024-04-02T08:00:00Z"),
          originalOffset: "Z",
        },
      },
      {
        id: "latest-datetime",
        occurrence: {
          precision: "datetime",
          instant: Date.parse("2024-04-02T16:00:00Z"),
          originalOffset: "Z",
        },
      },
      {
        id: "same-day-date",
        occurrence: { precision: "date", date: "2024-04-02" },
      },
      { id: "undated", occurrence: { precision: "unknown" } },
    ];
    const result = selectLatestOccurrences(
      rows,
      (row) => row.occurrence,
      (row) => row.id,
    );
    expect(result.candidates.map((row) => row.id)).toEqual([
      "same-day-date",
      "latest-datetime",
    ]);
    expect(result.undatedCount).toBe(1);
  });

  test("uses stable IDs only to make traversal deterministic", () => {
    const sameDate: Occurrence = { precision: "date", date: "2024-04-02" };
    expect(
      compareOccurrencesDeterministically(
        sameDate,
        sameDate,
        "event:a",
        "event:b",
      ),
    ).toBe(-1);
    expect(compareOccurrences(sameDate, sameDate)).toBe("same");
  });

  test("traversal order stays transitive when local day opposes instant", () => {
    const localSecondInstantFirst: Occurrence = {
      precision: "datetime",
      instant: Date.parse("2024-04-01T10:00:00Z"),
      originalOffset: "+14:00",
    };
    const localFirstInstantSecond: Occurrence = {
      precision: "datetime",
      instant: Date.parse("2024-04-01T20:00:00Z"),
      originalOffset: "-14:00",
    };
    const date: Occurrence = { precision: "date", date: "2024-04-01" };
    const ordered = [
      localSecondInstantFirst,
      date,
      localFirstInstantSecond,
    ].sort((left, right) =>
      compareOccurrencesDeterministically(
        left,
        right,
        JSON.stringify(left),
        JSON.stringify(right),
      ),
    );
    expect(ordered).toEqual([
      date,
      localFirstInstantSecond,
      localSecondInstantFirst,
    ]);
  });
});
