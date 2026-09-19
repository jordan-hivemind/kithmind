// The gate, on its own. No database and no model: these are the rules that
// decide whether a reading may be stored as fact, and every one of them is a
// pure function of the statement and the page it cites.

import assert from "node:assert/strict";
import test from "node:test";

import {
  amountsInText,
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

test("a single dot group is a decimal point, not European grouping", () => {
  // The regression: `$3.499` was read as three thousand four hundred and
  // ninety-nine, and `$0.125` as a hundred and twenty-five.
  assert.equal(parseAmount("3.499"), "3.499");
  assert.equal(parseAmount("$3.499"), "3.499");
  assert.equal(parseAmount("0.125"), "0.125");
  assert.equal(parseAmount("1.075"), "1.075");
  assert.equal(parseAmount("-12.00"), "-12");
  // A dot is grouping only when the string proves it: a decimal comma after
  // the groups, or two or more groups.
  assert.equal(parseAmount("1.234.567,89"), "1234567.89");
  assert.equal(parseAmount("1.234.567"), "1234567");
  assert.equal(parseAmount("1,234.56"), "1234.56");
  assert.equal(parseAmount("(1,234.56)"), "-1234.56");
});

test("a parsed value must appear in the quote that cites it", () => {
  // The regression this closes: a value that parses, cited to a quote that
  // says something else, was stored as a fact with a contradicting citation.
  assert.deepEqual(
    gate({ valueType: "money", value: "1500.00", quote: "Total $15.50" }),
    { ok: false, reason: "value_not_in_quote" },
  );
  assert.equal(
    gate({ valueType: "money", value: "15.50", quote: "Total $15.50" }).ok,
    true,
  );
  // Sign is the reader's; the digits are the document's.
  assert.equal(
    gate({ valueType: "money", value: "-1234.56", quote: "Refund (1,234.56)" })
      .ok,
    true,
  );
  assert.deepEqual(
    gate({ valueType: "number", value: "99", quote: "Odometer 81,204 mi" }),
    { ok: false, reason: "value_not_in_quote" },
  );
  assert.equal(
    gate({ valueType: "number", value: "81204", quote: "Odometer 81,204 mi" })
      .ok,
    true,
  );
  // Dates: the year and the day of the month both have to be printed.
  assert.equal(
    gate({ valueType: "date", value: "2026-09-01", quote: "Sep 1, 2026" }).ok,
    true,
  );
  assert.deepEqual(
    gate({ valueType: "date", value: "2025-09-01", quote: "Sep 1, 2026" }),
    { ok: false, reason: "value_not_in_quote" },
  );
  assert.deepEqual(
    gate({ valueType: "date", value: "2026-09-14", quote: "Sep 1, 2026" }),
    { ok: false, reason: "value_not_in_quote" },
  );
  assert.deepEqual(amountsInText("Hammer 10.00 Nails 5.50"), ["10", "5.5"]);
});

test("a percentage keeps its decimal comma", () => {
  // `3,5%` is three and a half, not thirty-five.
  assert.deepEqual(gate({ valueType: "number", value: "3,5%", quote: "3,5%" }), {
    ok: true,
    values: [{ type: "decimal", value: "3.5", unitCode: "1" }],
  });
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

test("a bare ISO code is a word until it sits against a number", () => {
  assert.equal(currencyOnPage("Total USD 5"), "USD");
  assert.equal(currencyOnPage("Total 5 USD"), "USD");
  assert.equal(currencyOnPage("Total $5"), "USD");
  assert.equal(currencyOnPage("USD 5 or EUR 4"), undefined);
  assert.equal(currencyOnPage("Total 5"), undefined);
  // Three capitals are also a word.
  assert.equal(currencyOnPage("CAD drawing revision 3"), undefined);
  assert.equal(currencyOnPage("Prepared in CHF Tower, floor 3"), undefined);
  // A symbol beats a bare code: a symbol is only ever a currency.
  assert.equal(currencyOnPage("Invoice for CAD work: $5.00"), "USD");
});

test("dates must be real ISO calendar dates", () => {
  const quote = "paid on 2026-09-01";
  assert.deepEqual(gate({ valueType: "date", value: "2026-09-01", quote }), {
    ok: true,
    values: [{ type: "date", value: "2026-09-01" }],
  });
  for (const bad of ["09/01/2026", "2026-02-30", "September 1, 2026", "2026-9-1"]) {
    assert.deepEqual(gate({ valueType: "date", value: bad, quote }), {
      ok: false,
      reason: "date_unparsable",
    });
  }
});

test("numbers parse exactly and carry the dimensionless unit", () => {
  assert.deepEqual(
    gate({ valueType: "number", value: "81,204", quote: "Odometer 81,204" }),
    {
      ok: true,
      values: [{ type: "decimal", value: "81204", unitCode: "1" }],
    },
  );
  assert.deepEqual(
    gate({ valueType: "number", value: "many", quote: "Odometer 81,204" }),
    { ok: false, reason: "number_unparsable" },
  );
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
      quote: "Hammer ten",
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
