import assert from "node:assert/strict";
import test from "node:test";

import { validateOwnerCorrectionValue } from "../dist/extraction/index.js";

test("owner corrections reject malformed decimal and calendar values", () => {
  assert.throws(
    () =>
      validateOwnerCorrectionValue({
        type: "money",
        amount: "twelve dollars",
        currency: "USD",
      }),
    /Corrected value is invalid/,
  );
  assert.throws(
    () =>
      validateOwnerCorrectionValue({
        type: "date",
        value: "2026-99-99",
        precision: "day",
      }),
    /Corrected value is invalid/,
  );
});

test("owner corrections canonicalize valid typed values", () => {
  assert.deepEqual(
    validateOwnerCorrectionValue({
      type: "money",
      amount: "001250.5000",
      currency: "USD",
    }),
    { type: "money", amount: "1250.5", currency: "USD" },
  );
  assert.deepEqual(
    validateOwnerCorrectionValue({
      type: "date",
      value: "2026-09-20",
      precision: "day",
    }),
    { type: "date", value: "2026-09-20" },
  );
});
