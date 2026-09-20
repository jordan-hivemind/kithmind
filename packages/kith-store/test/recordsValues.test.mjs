import assert from "node:assert/strict";
import test from "node:test";
import { MAX_DECIMAL_DIGITS, MAX_DECIMAL_SCALE, addDecimals, canonicalizeDecimal, canonicalizeObservationValue, compareDecimals, compareOccurrences, compareOccurrencesDeterministically, occurrenceCalendarDate, selectLatestOccurrences, validateOccurrence } from "../dist/records/index.js";

test("exact decimal helpers match Convex vectors", () => {
  assert.equal(canonicalizeDecimal("000123.45000"), "123.45");
  assert.equal(canonicalizeDecimal("-000.000"), "0");
  assert.equal(addDecimals("9007199254740993.01", "0.09"), "9007199254740993.1");
  assert.equal(addDecimals("19.95", "19.95"), "39.9");
  assert.equal(addDecimals("-1.2", "0.2"), "-1");
  assert.equal(compareDecimals("9007199254740993", "9007199254740992.999"), 1);
  assert.equal(compareDecimals("01.230", "1.23"), 0);
  for (const value of ["", " 1", "1 ", "+1", ".5", "1.", "1e3", "NaN"]) assert.throws(() => canonicalizeDecimal(value));
  assert.throws(() => canonicalizeDecimal(`1.${"0".repeat(MAX_DECIMAL_SCALE)}1`), /scale/);
  assert.throws(() => canonicalizeDecimal("9".repeat(MAX_DECIMAL_DIGITS + 1)), /digits/);
});

test("observation values canonicalize and enforce registries", () => {
  assert.deepEqual(canonicalizeObservationValue({ type: "money", amount: "0019.950", currency: "USD" }), { type: "money", amount: "19.95", currency: "USD" });
  assert.deepEqual(canonicalizeObservationValue({ type: "decimal", value: "005.400", unitCode: "mg/dL", originalUnit: "mg per dL" }), { type: "decimal", value: "5.4", unitCode: "mg/dL", originalUnit: "mg per dL" });
  assert.deepEqual(canonicalizeObservationValue({ type: "integer", value: "0012040", unitCode: "[mi_i]" }), { type: "integer", value: "12040", unitCode: "[mi_i]" });
  assert.deepEqual(canonicalizeObservationValue({ type: "date", value: "2024-02-29" }), { type: "date", value: "2024-02-29" });
  assert.throws(() => canonicalizeObservationValue({ type: "money", amount: "1", currency: "usd" }), /Unsupported ISO 4217 currency/);
  assert.throws(() => canonicalizeObservationValue({ type: "decimal", value: "1", unitCode: "miles" }), /Unsupported UCUM unit/);
  assert.deepEqual(canonicalizeObservationValue({ type: "decimal", value: "1", unitCode: "m[IU]/L" }), { type: "decimal", value: "1", unitCode: "m[IU]/L" });
  assert.throws(() => canonicalizeObservationValue({ type: "date", value: "2023-02-29" }), /real calendar date/);
  // ADM-5h: a document that printed only a year, or only a month and a year,
  // stores what it printed and says so. A full day keeps the shape it always
  // had, with no `precision` key, so nothing already written changes.
  assert.deepEqual(canonicalizeObservationValue({ type: "date", value: "2024", precision: "year" }), { type: "date", value: "2024", precision: "year" });
  assert.deepEqual(canonicalizeObservationValue({ type: "date", value: "2024-03", precision: "month" }), { type: "date", value: "2024-03", precision: "month" });
  assert.deepEqual(canonicalizeObservationValue({ type: "date", value: "2024-02-29", precision: "day" }), { type: "date", value: "2024-02-29" });
  // One value, one shape. A year that claims to be a month, a month with a
  // day glued to it, and a month that is not a month are each refused rather
  // than trimmed into something storable.
  assert.throws(() => canonicalizeObservationValue({ type: "date", value: "2024-03", precision: "year" }), /YYYY/);
  assert.throws(() => canonicalizeObservationValue({ type: "date", value: "2024", precision: "month" }), /YYYY-MM/);
  assert.throws(() => canonicalizeObservationValue({ type: "date", value: "2024-03-18", precision: "month" }), /YYYY-MM/);
  assert.throws(() => canonicalizeObservationValue({ type: "date", value: "2024-13", precision: "month" }), /real month/);
  assert.throws(() => canonicalizeObservationValue({ type: "date", value: "2024", precision: "day" }), /Observation date/);
});

test("occurrence helpers preserve precision, offsets, ordering, and latest selection", () => {
  assert.deepEqual(validateOccurrence({ precision: "date", date: "2000-02-29" }), { precision: "date", date: "2000-02-29" });
  assert.throws(() => validateOccurrence({ precision: "date", date: "1900-02-29" }), /real calendar date/);
  assert.throws(() => validateOccurrence({ precision: "datetime", instant: 1.5, originalOffset: "Z" }), /safe-integer/);
  assert.throws(() => validateOccurrence({ precision: "datetime", instant: 0, originalOffset: "+24:00" }), /offset/);
  assert.throws(() => validateOccurrence({ precision: "datetime", instant: 0, originalOffset: "-00:00" }), /known/);
  assert.equal(occurrenceCalendarDate({ precision: "datetime", instant: Date.parse("2024-04-02T00:30:00Z"), originalOffset: "-01:00" }), "2024-04-01");
  const later = { precision: "datetime", instant: Date.parse("2024-04-02T12:00:00Z"), originalOffset: "-14:00" };
  const earlier = { precision: "datetime", instant: Date.parse("2024-04-02T11:00:00Z"), originalOffset: "+14:00" };
  assert.equal(compareOccurrences(later, earlier), "after");
  const date = { precision: "date", date: "2024-04-02" };
  assert.equal(compareOccurrences(date, { precision: "datetime", instant: Date.parse("2024-04-02T23:00:00Z"), originalOffset: "Z" }), "ambiguous");
  assert.equal(compareOccurrences({ precision: "unknown" }, date), "unknown");
  const rows = [{ id: "older", occurrence: { precision: "datetime", instant: Date.parse("2024-04-02T08:00:00Z"), originalOffset: "Z" } }, { id: "latest", occurrence: { precision: "datetime", instant: Date.parse("2024-04-02T16:00:00Z"), originalOffset: "Z" } }, { id: "same-day", occurrence: date }, { id: "unknown", occurrence: { precision: "unknown" } }];
  const result = selectLatestOccurrences(rows, (row) => row.occurrence, (row) => row.id);
  assert.deepEqual(result.candidates.map((row) => row.id), ["same-day", "latest"]);
  assert.equal(result.undatedCount, 1);
  assert.equal(compareOccurrencesDeterministically(date, date, "event:a", "event:b"), -1);
});
