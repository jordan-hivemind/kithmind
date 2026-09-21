import assert from "node:assert/strict";
import test from "node:test";

import { FEDERAL_INDIVIDUAL_RETURN, FEDERAL_TAX_STARTER_CATALOG } from "../dist/extraction/taxCatalog.js";

const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SCHEDULE_PREFIX = /^schedule_(1|2|3|a|d|e)_/;

test("federal tax starter catalog is one valid, stable form kind", () => {
  assert.deepEqual(FEDERAL_TAX_STARTER_CATALOG, [FEDERAL_INDIVIDUAL_RETURN]);
  assert.equal(FEDERAL_INDIVIDUAL_RETURN.kind, "tax_return_1040");
  assert.equal(FEDERAL_INDIVIDUAL_RETURN.area, "tax");
  assert.equal(FEDERAL_INDIVIDUAL_RETURN.sensitivity, "restricted");

  const names = new Set();
  for (const field of FEDERAL_INDIVIDUAL_RETURN.fields) {
    assert.match(field.name, FIELD_NAME);
    assert.equal(names.has(field.name), false, `duplicate field ${field.name}`);
    names.add(field.name);
    assert.ok(["text", "money", "number"].includes(field.valueType));
    assert.ok(["on_page", "exact"].includes(field.check));
    assert.equal(field.name.includes("line"), false);
    if (SCHEDULE_PREFIX.test(field.name)) assert.match(field.name, SCHEDULE_PREFIX);
  }

  assert.equal(names.has("tax_year"), true);
  assert.equal(names.has("jurisdiction"), true);
  assert.equal(FEDERAL_INDIVIDUAL_RETURN.fields.find((field) => field.name === "tax_year").required, true);
  assert.equal(FEDERAL_INDIVIDUAL_RETURN.fields.find((field) => field.name === "tax_year").valueType, "number");
  assert.equal(FEDERAL_INDIVIDUAL_RETURN.fields.filter((field) => field.name.startsWith("schedule")).every((field) => field.valueType === "money"), true);
});

test("the starter catalog includes the planned front form and schedule total families", () => {
  const names = new Set(FEDERAL_INDIVIDUAL_RETURN.fields.map((field) => field.name));
  for (const name of [
    "total_income",
    "agi",
    "total_tax",
    "total_payments",
    "amount_owed",
    "schedule1_total_additional_income",
    "schedule2_total",
    "schedule3_total",
    "schedule_a_total_itemized_deductions",
    "schedule_d_net_capital_gain_or_loss",
    "schedule_e_total_supplemental_income_or_loss",
  ]) {
    assert.equal(names.has(name), true, `missing semantic key ${name}`);
  }
});
