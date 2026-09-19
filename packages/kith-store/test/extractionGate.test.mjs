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

test("the quote's sign has to agree with the value's", () => {
  // A refund read as a charge is the same class of error as a wrong digit and
  // harder to notice, so the sign is part of the claim.
  assert.deepEqual(
    gate({ valueType: "money", value: "-42.00", quote: "Payment 42.00" }),
    { ok: false, reason: "value_not_in_quote" },
  );
  assert.deepEqual(
    gate({ valueType: "money", value: "42.00", quote: "Credit (42.00)" }),
    { ok: false, reason: "value_not_in_quote" },
  );
  assert.equal(
    gate({ valueType: "money", value: "-42.00", quote: "Credit (42.00)" }).ok,
    true,
  );
  assert.equal(
    gate({ valueType: "money", value: "42.00", quote: "Payment 42.00" }).ok,
    true,
  );
  // The three shapes a document uses for a negative.
  assert.deepEqual(amountsInText("Balance (1,234.56)"), ["-1234.56"]);
  assert.deepEqual(amountsInText("Balance 1,234.56-"), ["-1234.56"]);
  assert.deepEqual(amountsInText("Balance 1,234.56 CR"), ["-1234.56"]);
  assert.deepEqual(amountsInText("Balance -$5.00"), ["-5"]);
  // Parentheses already say negative; a sign inside them is not a number.
  assert.equal(parseAmount("(-5)"), undefined);
  assert.equal(parseAmount("(+5)"), undefined);
});

test("a separator hyphen is not a minus sign", () => {
  // A document uses a hyphen as a separator far more often than as a sign.
  for (const quote of [
    "Total - 42.00",
    "Invoice 12-42.00",
    "Item 1 - 42.00",
  ]) {
    assert.deepEqual(
      gate({ valueType: "money", value: "-42.00", quote }),
      { ok: false, reason: "value_not_in_quote" },
      quote,
    );
    assert.equal(
      gate({ valueType: "money", value: "42.00", quote }).ok,
      true,
      quote,
    );
  }
  // Pressed against the digits, it still is a sign.
  assert.deepEqual(amountsInText("-$42.00"), ["-42"]);
  assert.deepEqual(amountsInText("$-42.00"), ["-42"]);
  assert.deepEqual(amountsInText("USD 42.00-"), ["-42"]);
  assert.deepEqual(amountsInText("Refund -42.00"), ["-42"]);
  // And a separator is not, from either side.
  assert.deepEqual(amountsInText("Total - 42.00"), ["42"]);
  assert.deepEqual(amountsInText("Item 1 - 42.00"), ["1", "42"]);
});

test("a date needs its month as well as its year and day", () => {
  const value = "2026-01-02";
  // Every one of these used to pass on the year and the day alone.
  for (const quote of [
    "Invoice date 15/03/2026 - 2 pages",
    "Due 2026-11-02",
    "Feb 2, 2026",
  ]) {
    assert.deepEqual(
      gate({ valueType: "date", value, quote }),
      { ok: false, reason: "value_not_in_quote" },
      quote,
    );
  }
  for (const quote of [
    "Dated 2026-01-02",
    "January 2, 2026",
    "Jan 2, 2026",
    "2 Jan 2026",
  ]) {
    assert.equal(gate({ valueType: "date", value, quote }).ok, true, quote);
  }
  // ADM-5d: "02/01/2026" is the second of January and the first of February,
  // and matching its runs in any order used to support both. It reads only
  // when the kind declares an order.
  assert.deepEqual(gate({ valueType: "date", value, quote: "02/01/2026" }), {
    ok: false,
    reason: "value_not_in_quote",
  });
  assert.equal(
    gate({ valueType: "date", value, quote: "02/01/2026", dateOrder: "DMY" })
      .ok,
    true,
  );
  assert.deepEqual(
    gate({ valueType: "date", value, quote: "02/01/2026", dateOrder: "MDY" }),
    { ok: false, reason: "value_not_in_quote" },
  );
  // A day and a month that are the same number need two runs of it, or the
  // month's name.
  assert.equal(
    gate({ valueType: "date", value: "2026-03-03", quote: "3/3/2026" }).ok,
    true,
  );
  assert.equal(
    gate({ valueType: "date", value: "2026-03-03", quote: "Mar 3, 2026" }).ok,
    true,
  );
  assert.deepEqual(
    gate({ valueType: "date", value: "2026-03-03", quote: "Line 3 of 2026" }),
    { ok: false, reason: "value_not_in_quote" },
  );
  // A word is not a month because it starts with the same three letters.
  assert.deepEqual(
    gate({ valueType: "date", value: "2026-03-04", quote: "4 Market St, 2026" }),
    { ok: false, reason: "value_not_in_quote" },
  );
});

test("a date's parts have to be written together as a date", () => {
  // Three digit runs scattered across a line are not a date.
  assert.deepEqual(
    gate({
      valueType: "date",
      value: "2026-01-02",
      quote: "Page 1 of 2 (c) 2026",
    }),
    { ok: false, reason: "value_not_in_quote" },
  );
  assert.deepEqual(
    gate({
      valueType: "date",
      value: "2026-01-02",
      quote: "Order 2 shipped in 1 box, warranty ends 2026",
    }),
    { ok: false, reason: "value_not_in_quote" },
  );
  // A month word only counts inside a date-shaped window, so prose does not.
  assert.deepEqual(
    gate({
      valueType: "date",
      value: "2026-05-02",
      quote: "delivery may be late; see item 2 of order 2026",
    }),
    { ok: false, reason: "value_not_in_quote" },
  );
  // The windows themselves still read. The two all-numeric ones are ambiguous,
  // so they need the kind's declared order; the named month does not.
  for (const quote of ["Invoiced 02.01.2026 in full", "Billed 1/2/2026"]) {
    assert.equal(
      gate({
        valueType: "date",
        value: "2026-01-02",
        quote,
        dateOrder: quote.includes("02.01") ? "DMY" : "MDY",
      }).ok,
      true,
      quote,
    );
  }
  assert.equal(
    gate({
      valueType: "date",
      value: "2026-05-02",
      quote: "Signed May 2, 2026 at noon",
    }).ok,
    true,
  );
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
  // ADM-5d: a printed form the cited text also carries is normalized rather
  // than refused. The prompt now asks the model to copy a date as printed,
  // so converting it is the server's job.
  for (const printed of ["September 1, 2026", "2026-9-1"]) {
    assert.deepEqual(gate({ valueType: "date", value: printed, quote }), {
      ok: true,
      values: [{ type: "date", value: "2026-09-01" }],
    });
  }
  // ADM-5d: an all-numeric one needs the kind to say which order it uses.
  assert.deepEqual(gate({ valueType: "date", value: "09/01/2026", quote }), {
    ok: false,
    reason: "date_ambiguous",
  });
  assert.deepEqual(
    gate({
      valueType: "date",
      value: "09/01/2026",
      quote,
      dateOrder: "MDY",
    }),
    { ok: true, values: [{ type: "date", value: "2026-09-01" }] },
  );
  // What is not a date is still not a date.
  for (const bad of ["2026-02-30", "sometime in September", "the 1st"]) {
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
