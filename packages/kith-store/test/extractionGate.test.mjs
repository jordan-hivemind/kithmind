// The gate, on its own. No database and no model: these are the rules that
// decide whether a reading may be stored as fact, and every one of them is a
// pure function of the statement and the page it cites.

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkValue,
  currencyOnPage,
  itemsSumToTotal,
  parseAmount,
  seedDocumentTypes,
  STARTER_DOCUMENT_TYPES,
} from "../dist/extraction/index.js";

const PAGE = "Acme Hardware\nTotal $15.50 paid on 2026-09-01\n";

function gate(overrides) {
  return checkValue({
    valueType: "text",
    value: "Acme Hardware",
    quote: "Acme Hardware",
    pageText: PAGE,
    defaultCurrency: "USD",
    ...overrides,
  });
}

test("money parses exactly, in the shapes a document actually prints", () => {
  assert.equal(parseAmount("$15.50"), "15.5");
  assert.equal(parseAmount("1,234,567.89"), "1234567.89");
  assert.equal(parseAmount("(250.00)"), "-250");
  assert.equal(parseAmount("250.00-"), "-250");
  assert.equal(parseAmount("1.234.567,89"), "1234567.89");
  assert.equal(parseAmount("USD 42"), "42");
  // Nothing that would need a guess.
  assert.equal(parseAmount("1.2e3"), undefined);
  assert.equal(parseAmount("about ten dollars"), undefined);
  assert.equal(parseAmount(""), undefined);
});

test("a money value keeps its currency and flags an assumed one", () => {
  const stated = gate({ valueType: "money", value: "$15.50", quote: "Total $15.50" });
  assert.equal(stated.ok, true);
  assert.deepEqual(stated.values, [
    { type: "money", amount: "15.5", currency: "USD" },
  ]);
  assert.equal(stated.currencyAssumed, undefined);

  const bare = checkValue({
    valueType: "money",
    value: "15.50",
    quote: "Total 15.50",
    pageText: "Total 15.50\n",
    defaultCurrency: "USD",
  });
  assert.equal(bare.ok, true);
  assert.equal(bare.currencyAssumed, true);
  assert.equal(bare.values[0].currency, "USD");

  const unparsable = gate({
    valueType: "money",
    value: "fifteen fifty",
    quote: "Total $15.50",
  });
  assert.deepEqual(unparsable, { ok: false, reason: "money_unparsable" });
});

test("a page stating two currencies states neither", () => {
  assert.equal(currencyOnPage("Total USD 5"), "USD");
  assert.equal(currencyOnPage("Total $5"), "USD");
  assert.equal(currencyOnPage("USD 5 or EUR 4"), undefined);
  assert.equal(currencyOnPage("Total 5"), undefined);
});

test("dates must be real ISO calendar dates", () => {
  assert.deepEqual(gate({ valueType: "date", value: "2026-09-01" }), {
    ok: true,
    values: [{ type: "date", value: "2026-09-01" }],
  });
  for (const bad of ["09/01/2026", "2026-02-30", "September 1, 2026", "2026-9-1"]) {
    assert.deepEqual(gate({ valueType: "date", value: bad }), {
      ok: false,
      reason: "date_unparsable",
    });
  }
});

test("numbers parse exactly and carry the dimensionless unit", () => {
  assert.deepEqual(gate({ valueType: "number", value: "81,204" }), {
    ok: true,
    values: [{ type: "decimal", value: "81204", unitCode: "1" }],
  });
  assert.deepEqual(gate({ valueType: "number", value: "many" }), {
    ok: false,
    reason: "number_unparsable",
  });
});

test("a name must appear inside the quote that supports it", () => {
  assert.equal(gate({ valueType: "organization" }).ok, true);
  assert.deepEqual(
    gate({ valueType: "organization", value: "Other Vendor Inc" }),
    { ok: false, reason: "value_not_in_quote" },
  );
  // Whitespace shape is not a difference; the quote locator folds it too.
  assert.equal(
    gate({ valueType: "organization", value: "Acme  Hardware" }).ok,
    true,
  );
});

test("line items become one money value each and carry their own sum", () => {
  const result = gate({
    valueType: "line_item_list",
    value: [
      { description: "Hammer", amount: "$10.00" },
      { description: "Nails", amount: "$5.50" },
    ],
    quote: "Hammer $10.00 Nails $5.50",
  });
  assert.equal(result.ok, true);
  assert.equal(result.values.length, 2);
  assert.equal(result.itemsTotal, "15.5");
  assert.equal(itemsSumToTotal(result.itemsTotal, "15.50"), true);
  // The canonical form drops a trailing zero; the comparison is by value.
  assert.equal(itemsSumToTotal(result.itemsTotal, "15.5"), true);
  // Tolerance zero, by design.
  assert.equal(itemsSumToTotal(result.itemsTotal, "15.51"), false);

  assert.deepEqual(
    gate({ valueType: "line_item_list", value: "Hammer, Nails" }),
    { ok: false, reason: "malformed_statement" },
  );
  assert.deepEqual(
    gate({
      valueType: "line_item_list",
      value: [{ description: "Hammer", amount: "ten" }],
    }),
    { ok: false, reason: "money_unparsable" },
  );
});

test("the starter set is well formed and every field name is usable", () => {
  // `seedDocumentTypes` is the writer; this asserts the data it writes, which
  // is the half that cannot be checked without a database.
  assert.ok(STARTER_DOCUMENT_TYPES.length >= 12);
  assert.equal(typeof seedDocumentTypes, "function");
  const kinds = new Set();
  for (const type of STARTER_DOCUMENT_TYPES) {
    assert.equal(kinds.has(type.kind), false);
    kinds.add(type.kind);
    assert.ok(type.guidance.length > 0 && type.guidance.length < 400);
    assert.ok(type.fields.length > 0);
    for (const field of type.fields) {
      assert.match(field.name, /^[a-z][a-z0-9_]{0,63}$/);
    }
  }
  assert.ok(kinds.has("receipt"));
  assert.ok(kinds.has("schedule_k1"));
});
