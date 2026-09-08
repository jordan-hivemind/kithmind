import assert from "node:assert/strict";
import test from "node:test";

import {
  currencyExponent,
  fromMinorUnits,
  roundToMinorUnits,
  sumMinorUnits,
  toMinorUnits,
} from "../dist/index.js";

test("minor units use the currency exponent, not a hardcoded two", () => {
  assert.equal(currencyExponent("USD"), 2);
  assert.equal(currencyExponent("JPY"), 0);
  assert.equal(currencyExponent("KWD"), 3);
  assert.equal(toMinorUnits("12.34", "USD"), 1234n);
  assert.equal(toMinorUnits("12.3", "USD"), 1230n);
  assert.equal(toMinorUnits("1250", "JPY"), 1250n);
  assert.equal(toMinorUnits("-0.05", "USD"), -5n);
  assert.equal(toMinorUnits("1.234", "KWD"), 1234n);
});

test("minor units round-trip back to the stated decimal", () => {
  assert.equal(fromMinorUnits(1234n, "USD"), "12.34");
  assert.equal(fromMinorUnits(1250n, "JPY"), "1250");
  assert.equal(fromMinorUnits(-5n, "USD"), "-0.05");
  assert.equal(fromMinorUnits(0n, "USD"), "0");
});

test("a value too precise for its currency is an error, never a rounded guess", () => {
  assert.throws(() => toMinorUnits("12.345", "USD"), /rounding/);
  assert.throws(() => toMinorUnits("12.5", "JPY"), /rounding/);
});

test("an unknown currency is an error rather than an assumed exponent", () => {
  assert.throws(() => currencyExponent("ZZZ"), /unknown currency/);
  assert.throws(() => toMinorUnits("1.00", "usd"), /unknown currency/);
});

test("a derived value rounds half to even under a stated rule", () => {
  assert.equal(roundToMinorUnits("1.005", "USD"), 100n);
  assert.equal(roundToMinorUnits("1.015", "USD"), 102n);
  assert.equal(roundToMinorUnits("-1.005", "USD"), -100n);
  assert.equal(roundToMinorUnits("-1.015", "USD"), -102n);
  assert.equal(roundToMinorUnits("2.6751", "USD"), 268n);
  assert.equal(roundToMinorUnits("1250.4", "JPY"), 1250n);
  assert.throws(() => roundToMinorUnits("1.005", "USD", "none"), /rounding/);
});

test("a total never silently crosses currencies", () => {
  assert.deepEqual(
    sumMinorUnits([
      { amount: 1234n, currency: "USD" },
      { amount: -34n, currency: "USD" },
    ]),
    { amount: 1200n, currency: "USD" },
  );
  assert.throws(
    () =>
      sumMinorUnits([
        { amount: 1234n, currency: "USD" },
        { amount: 1250n, currency: "JPY" },
      ]),
    /group by currency/,
  );
  assert.throws(() => sumMinorUnits([]), /at least one amount/);
});

test("totals stay exact above 2 to the 53 minor units", () => {
  const total = sumMinorUnits([
    { amount: 9007199254740993n, currency: "USD" },
    { amount: 1n, currency: "USD" },
    { amount: 2n, currency: "USD" },
  ]);
  assert.equal(total.amount, 9007199254740996n);
  assert.equal(fromMinorUnits(total.amount, "USD"), "90071992547409.96");
});
