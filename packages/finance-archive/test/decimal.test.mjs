import assert from "node:assert/strict";
import test from "node:test";

import {
  addDecimal,
  canonicalizeDecimal,
  compareDecimal,
  isCanonicalDecimal,
  multiplyDecimal,
  negateDecimal,
  subtractDecimal,
} from "../dist/index.js";

test("canonical form has one spelling per number", () => {
  assert.equal(canonicalizeDecimal("+1.50"), "1.5");
  assert.equal(canonicalizeDecimal("007"), "7");
  assert.equal(canonicalizeDecimal(".5"), "0.5");
  assert.equal(canonicalizeDecimal("1."), "1");
  assert.equal(canonicalizeDecimal("-0.000"), "0");
  assert.equal(canonicalizeDecimal("-00.250"), "-0.25");
  assert.equal(canonicalizeDecimal("0.000001"), "0.000001");
});

test("canonical form is recognizable and non-canonical spellings are not", () => {
  for (const value of ["0", "-0.25", "7", "1234.5678"]) {
    assert.equal(isCanonicalDecimal(value), true, value);
  }
  for (const value of ["+1", "-0", "01", ".5", "1.", "1.50", "1e3"]) {
    assert.equal(isCanonicalDecimal(value), false, value);
  }
});

test("input that is not a base-10 number is rejected, never coerced", () => {
  for (const value of [
    "",
    "1e3",
    "1,000",
    "$4.00",
    "abc",
    " 1",
    "1 2",
    "--1",
  ]) {
    assert.throws(() => canonicalizeDecimal(value), value);
  }
});

test("addition is exact where an IEEE double is not", () => {
  assert.equal(addDecimal("0.1", "0.2"), "0.3");
  assert.equal(addDecimal("0.1", "0.7"), "0.8");
  assert.equal(subtractDecimal("1.1", "1"), "0.1");
});

test("addition and subtraction hold above 2 to the 53", () => {
  // 90071992547409.93 exceeds 2^53 minor units; as a double it cannot be added
  // to a cent without moving.
  assert.equal(addDecimal("90071992547409.93", "0.01"), "90071992547409.94");
  assert.equal(
    subtractDecimal("90071992547409.94", "90071992547409.93"),
    "0.01",
  );
  assert.equal(
    addDecimal("123456789012345678901234567890", "1"),
    "123456789012345678901234567891",
  );
});

test("differing scales add, subtract and compare by value", () => {
  assert.equal(addDecimal("1.5", "2.25"), "3.75");
  assert.equal(subtractDecimal("1.000", "0.999"), "0.001");
  assert.equal(compareDecimal("1.10", "1.1"), 0);
  assert.equal(compareDecimal("1.1", "1.100001"), -1);
  assert.equal(compareDecimal("2", "1.999999"), 1);
});

test("negatives keep their sign through arithmetic", () => {
  assert.equal(addDecimal("-1.25", "0.25"), "-1");
  assert.equal(subtractDecimal("-1.25", "-1.25"), "0");
  assert.equal(negateDecimal("-0.75"), "0.75");
  assert.equal(negateDecimal("0"), "0");
  assert.equal(compareDecimal("-2", "-10"), 1);
});

test("quantity times price keeps full precision", () => {
  assert.equal(multiplyDecimal("12.5", "104.375"), "1304.6875");
  assert.equal(multiplyDecimal("-3.2", "0.125"), "-0.4");
  assert.equal(multiplyDecimal("0.1", "0.2"), "0.02");
  assert.equal(multiplyDecimal("1000000", "0"), "0");
});
