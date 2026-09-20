// The gate, on its own. No database and no model: these are the rules that
// decide whether a reading may be stored as fact, and every one of them is a
// pure function of the statement and the page it cites.

import assert from "node:assert/strict";
import test from "node:test";

import {
  amountsInText,
  checkLineItem,
  readLineItems,
  checkValue,
  currencyOnPage,
  itemsSumToTotal,
  pageLines,
  parseAmount,
  seedDocumentTypes,
  STARTER_DOCUMENT_TYPES,
} from "../dist/extraction/index.js";

const PAGE = "Acme Hardware\nTotal $15.50 paid on 2026-09-01\n";

function gate(overrides) {
  const { quote = "Acme Hardware", ...rest } = overrides ?? {};
  return checkValue({
    valueType: "text",
    value: "Acme Hardware",
    candidates: asCandidates(quote),
    pageText: PAGE,
    defaultCurrency: "USD",
    ...rest,
  });
}
/** The gate takes cited lines now, not one quote. A test that names a quote
 * means one cited line, so this is the same claim said the new way. */
function asCandidates(quote) {
  return [{ text: quote, start: 0, end: quote.length }];
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
  // A document uses a hyphen as a separator far more often than as a sign --
  // and a dash a gap away from the digits could be either, so ADM-5g's fifth
  // round offers neither reading. Both of these open a correction row now.
  for (const quote of ["Total - 42.00", "Item 1 - 42.00"]) {
    for (const value of ["-42.00", "42.00"]) {
      assert.deepEqual(
        gate({ valueType: "money", value, quote }),
        { ok: false, reason: "value_not_in_quote" },
        `${quote} / ${value}`,
      );
    }
  }
  // Pressed against the digits, it still is a sign.
  assert.deepEqual(amountsInText("-$42.00"), ["-42"]);
  assert.deepEqual(amountsInText("$-42.00"), ["-42"]);
  assert.deepEqual(amountsInText("USD 42.00-"), ["-42"]);
  assert.deepEqual(amountsInText("Refund -42.00"), ["-42"]);
  // And a separator is not, from either side. ADM-5g: nor is the number
  // beside it, because a dash is exactly as likely to be its sign.
  assert.deepEqual(amountsInText("Total - 42.00"), []);
  assert.deepEqual(amountsInText("Item 1 - 42.00"), []);
  // ADM-5g: a hyphen with digits on both sides of it and no space is neither.
  // "12-42.00" is one token -- a reference, a range, a phone number -- and
  // one token that does not parse offers nothing at all, in either sign.
  for (const value of ["42.00", "-42.00", "12"]) {
    assert.deepEqual(
      gate({ valueType: "money", value, quote: "Invoice 12-42.00" }),
      { ok: false, reason: "value_not_in_quote" },
      value,
    );
  }
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
    support: [0],
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
    candidates: asCandidates("Total 15.50"),
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
    support: [0],
  });
  // ADM-5d: a printed form the cited text also carries is normalized rather
  // than refused. The prompt now asks the model to copy a date as printed,
  // so converting it is the server's job.
  for (const printed of ["September 1, 2026", "2026-9-1"]) {
    assert.deepEqual(gate({ valueType: "date", value: printed, quote }), {
      ok: true,
      values: [{ type: "date", value: "2026-09-01" }],
      support: [0],
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
    { ok: true, values: [{ type: "date", value: "2026-09-01" }], support: [0] },
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
      support: [0],
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

/** One cited line, as the per-item gate takes them. */
function citedLine(id, text) {
  return { id, text, start: 0, end: text.length };
}

test("a line item is gated on its own citation", () => {
  const page = "Hammer\n  $10.00\nNails\n  $5.50";
  const item = (description, amount, lines) => ({
    item: { description, amount, lines: [] },
    cited: lines,
    pageText: page,
    defaultCurrency: "USD",
  });
  // The amount on one cited line, the description on another: both are
  // checked, and the span is the line that prints the amount.
  const hammer = checkLineItem(
    item("Hammer", "$10.00", [citedLine(1, "Hammer"), citedLine(2, "  $10.00")]),
  );
  assert.equal(hammer.ok, true);
  assert.equal(hammer.amount, "10");
  assert.equal(hammer.span.text, "  $10.00");

  // ADM-5g: a trailing tax or status letter is a flag, not a digit.
  for (const printed of ["12.99T", "12.99 A", "1,234.56F"]) {
    const flagged = checkLineItem(
      item("Widget", printed, [citedLine(1, `Widget ${printed}`)]),
    );
    assert.equal(flagged.ok, true, printed);
  }
  assert.equal(
    checkLineItem(item("Widget", "12.99T", [citedLine(1, "Widget 12.99T")]))
      .amount,
    "12.99",
  );
  // But an amount with its decimal point dropped is that number, not cents.
  assert.deepEqual(
    checkLineItem(item("Widget", "1299", [citedLine(1, "Widget 12.99")])),
    { ok: false, reason: "value_not_in_quote" },
  );
  assert.equal(
    checkLineItem(item("Widget", "1299", [citedLine(1, "Widget 1299")])).amount,
    "1299",
  );

  // A description the cited lines do not print is refused, like any name.
  assert.deepEqual(
    checkLineItem(item("Chisel", "$10.00", [citedLine(2, "  $10.00")])),
    { ok: false, reason: "value_not_in_quote" },
  );
  // An unparsable amount is its own reason.
  assert.deepEqual(
    checkLineItem(item("Hammer", "ten", [citedLine(1, "Hammer ten")])),
    { ok: false, reason: "money_unparsable" },
  );
  // And an entry that cites nothing says so.
  assert.deepEqual(checkLineItem(item("Hammer", "$10.00", [])), {
    ok: false,
    reason: "citation_missing",
  });
});

test("one bad entry does not take the list down", () => {
  // `readLineItems` reads per entry, so a garbled line is one refused line.
  const read = readLineItems([
    { description: "Hammer", amount: "10.00", lines: [1] },
    "Nails 5.50",
    { description: "", amount: "5.50", lines: [2] },
    { description: "Screws", amount: 7.25, lines: [3] },
  ]);
  assert.equal(read.length, 4);
  assert.deepEqual(
    read.map((entry) => entry.ok),
    [true, false, false, true],
  );
  assert.deepEqual(read[0].item, {
    description: "Hammer",
    amount: "10.00",
    lines: [1],
  });
  // A number amount is read as its decimal string, not rounded.
  assert.equal(read[3].item.amount, "7.25");
  // The whole value being the wrong shape is still the whole list failing.
  assert.equal(readLineItems("Hammer, Nails"), undefined);
  assert.equal(readLineItems([]), undefined);
});

test("the sum of the entries still has zero tolerance", () => {
  assert.equal(itemsSumToTotal("15.5", "15.50"), true);
  assert.equal(itemsSumToTotal("15.5", "15.5"), true);
  assert.equal(itemsSumToTotal("15.5", "15.51"), false);
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

// ---------------------------------------------------------------------------
// The amount grammar, as one table.
//
// Every adversarial input the reviews of #298, #312, #320 and #323 turned up,
// with what it must read as or that it must refuse. This table is the spec:
// a change to `parseAmount` that moves a row here is a change to what the
// system believes a document says, and should be argued for as one.
// ---------------------------------------------------------------------------

/**
 * `undefined` means the grammar must refuse the input.
 *
 * A third element is what `amountsInText` must offer for the same input when
 * that is *not* simply `[value]` or `[]` -- the only places the finder and
 * the scanner are allowed to differ, each one a rule the finder has and the
 * scanner cannot: a sign printed beside the number rather than in it, a
 * separator that is prose, or a line that holds two tokens rather than one.
 * Every other row is checked both ways by the property test below, so the
 * two can never drift apart unnoticed.
 */
const AMOUNT_SPEC = [
  // Plain amounts.
  ["12.99", "12.99"],
  ["1,234.56", "1234.56"],
  ["1,234,567.89", "1234567.89"],
  ["USD 42", "42"],
  ["USD13.20", "13.2"],
  ["13.20 USD", "13.2"],
  ["15.50 CHF", "15.5"],
  ["42", "42"],
  ["-0.00", "0"],

  // Signs, in every shape a ledger prints one.
  ["-12.00", "-12"],
  ["-$42.00", "-42"],
  ["$-42.00", "-42"],
  ["250.00-", "-250"],
  ["5USD-", "-5"],
  ["(250.00)", "-250"],
  ["(1,234.56)", "-1234.56"],
  ["(-5)", undefined],
  ["(+5)", undefined],
  // Parentheses printed a space away from the digits are still parentheses.
  // This one used to lose the sign: the finder offered a positive 250 for a
  // line the scanner read as minus 250.
  ["( 250.00 )", "-250"],
  // Every character a document prints as a minus is a minus. U+2212 is what
  // a PDF's text layer carries; an en or em dash is what an export leaves.
  ["−$5.00", "-5"],
  ["–$5.00", "-5"],
  ["—$5.00", "-5"],
  ["5.00−", "-5"],
  // A dash between two numbers is a range, whichever character it is.
  ["5-10", undefined],
  ["5–10", undefined],
  ["$5.00–$10.00", undefined],
  ["2026–2027", undefined],
  // One sign. Two is not a second negation, in either order.
  ["--5", undefined],
  ["−−5", undefined],
  ["-+5", undefined],
  ["+-5", undefined],
  // `CR` and `DR` are signs the *line* prints beside the number, so they are
  // the finder's to read and not part of any value.
  ["12.00 CR", undefined, ["-12"]],
  ["12.00 DR", undefined, ["12"]],
  ["$2.5M CR", undefined, ["-2500000"]],

  // Grouping. A single dot group is a decimal point; two or more, or a
  // decimal comma after them, make it grouping.
  ["3.499", "3.499"],
  ["$3.499", "3.499"],
  ["0.125", "0.125"],
  ["1.075", "1.075"],
  ["1.234.567", "1234567"],
  ["1.234.567,89", "1234567.89"],
  ["178,20", "178.2"],
  // Grouping this grammar does not claim to read, refused rather than guessed.
  ["1,23,456.00", undefined],
  [".5", undefined],
  // ADM-5h: a whole dollar printed with the point still there and no cents
  // after it. A tax form prints every box this way, and both sides read it
  // now -- the finder already dropped the trailing separator as punctuation,
  // and the scanner no longer refuses the value the model copies off the
  // page.
  ["5.", "5"],
  ["12,345.", "12345"],
  ["-9,999.", "-9999"],
  ["(12,345.)", "-12345"],
  ["$12,345.", "12345"],
  ["12,345. USD", "12345"],
  ["0.", "0"],
  // A sentence's full stop is the same character in the same place, and the
  // number before it reads the same way.
  ["42.00.", "42"],
  // A point with digits after it is a decimal point, however wide the gap:
  // the column artifact rule (`$ 165 .00`) owns this shape and reads one
  // value, so the trailing-dot rule never sees it. The *finder* offers
  // neither number, because a line printing this says 5.25 as readily as it
  // says 5 and 25.
  ["5. 25", "5.25", []],
  ["12,345. 80", "12345.8", []],
  ["١٫٥", undefined],
  ["１２．９９", "12.99"],
  ["＄12.99", "12.99"],
  ["1" + "0".repeat(40), undefined],
  // Four or more digits before a comma are not a group, and three after one
  // are not a decimal: `1000,000` is a thousand and a million at once.
  ["1000,000", undefined],
  ["12345,67", "12345.67"],
  // A zero in front of more digits is padding, and padding is an identifier:
  // a check number, an invoice number, the `000123` in a wire reference.
  ["0012", undefined],
  ["000123", undefined],
  ["00.50", undefined],
  ["0.50", "0.5"],
  ["0", "0"],

  // Whitespace inside one value is a rendering artifact of its column.
  ["$ 165 .00", "165"],
  ["$ 10 .80", "10.8"],
  ["USD 13 .20", "13.2"],
  ["$1 000 000", "1000000"],
  // Without a currency marker the same six characters are one number or two,
  // and the finder cannot tell `1 000 000` from `APPLES 12 990`. The scanner
  // is reading one value and has no such doubt; the finder offers nothing.
  ["1 000 000", "1000000", []],

  // A digit run tied to another by a hyphen or a slash is an identifier, a
  // date or a range -- one token, and not an amount.
  ["INV-0012", undefined],
  ["20260918-000123", undefined],
  ["(206) 555-0134", undefined],
  ["1234-5678-9012-3456", undefined],
  ["09/01/2026", undefined],
  ["2026-09-01", undefined],
  ["1/2", undefined],
  ["#1234", undefined],
  // A fraction after the digits makes them a whole part: "101 1/2" is a bond
  // price and a hundred and one is the wrong number.
  ["101 1/2", undefined],

  // What NFKC folds. A superscript is a footnote marker or a unit, never a
  // digit: `12.99²` is not 12.992 and `$2.5m²` is not two and a half
  // million. `½` folds to `1⁄2`, which is not 121 and 2 either.
  ["$2.5m²", undefined],
  ["12.99²", undefined],
  ["12½", undefined],
  ["$2.5㎡", undefined],
  ["$1M1", undefined],
  ["$1MM1", undefined],
  ["$1M2.5", undefined],

  // A magnitude abbreviation scales only beside a currency marker, and only
  // pressed against the digits.
  ["$2.5M", "2500000"],
  ["USD 2.5M", "2500000"],
  ["2.5M USD", "2500000"],
  ["£1.2k", "1200"],
  ["($2.5M)", "-2500000"],
  ["$2.5MM", "2500000"],
  ["$1,250K", "1250000"],
  ["$0.75bn", "750000000"],
  ["$1.2345M", "1234500"],
  ["$3.4B", "3400000000"],
  ["$2.5mn", "2500000"],
  // Without a currency marker it is a plan name, a form name, a unit or a
  // room. Not an amount at all -- and not the bare number either, or "401K"
  // would quietly become 401.
  ["2.5M", undefined],
  ["401K", undefined],
  ["10K", undefined],
  ["5K run", undefined],
  ["12.99 mm", undefined],
  ["2024 M", undefined],
  ["1.5Kg", undefined],
  ["2.5Mbps", undefined],
  ["1.2345678M", undefined],
  ["-2.5M-", undefined],
  // An abbreviation a space away is not a magnitude even with a currency --
  // and it is not the mantissa either. Each of these offered the unscaled
  // number, which is the 10^6 error this whole line of work exists to stop.
  ["$2.5 M", undefined],
  ["2.5 mil", undefined],
  ["$2.5 bn", undefined],
  ["$3 k", undefined],
  ["EUR 4 m", undefined],
  ["$2.5 MM", undefined],
  // A symbol with a letter glued in front of it is not a currency marker
  // this grammar knows. Refused, rather than read without the letter.
  ["C$2.5M", undefined],
  ["A$1.2k", undefined],
  ["US$2.5M", undefined],
  // Words are unambiguous and scale with or without a currency marker.
  ["2.5 million", "2500000"],
  ["3 billion", "3000000000"],
  ["40 thousand", "40000"],
  ["1.5 billions", "1500000000"],
  ["$2.5billion", "2500000000"],

  // A tax or status flag: an allowed letter, exactly two decimals, and
  // nothing after it.
  ["12.99T", "12.99"],
  ["12.99 A", "12.99"],
  ["1,234.56F", "1234.56"],
  ["0.50X", "0.5"],
  ["9.00N", "9"],
  ["12.5T", undefined],
  ["1299T", undefined],
  ["12.99TX", undefined],
  // A flag a space away belongs to the token, so the finder reads the flagged
  // price and stops; the 3.00 past it has a lone letter on its left and is
  // refused.
  ["12.99 T 3.00", undefined, ["12.99"]],
  ["2024A", undefined],
  // A lone C is a credit marker. Dropping it would lose a sign.
  ["45.00 C", undefined],
  // Any other single letter beside a number is prose, and the number reads.
  ["42.00 a month", undefined, ["42"]],
  // ADM-5g: a single letter beside a number is a magnitude, a credit marker
  // or a flag at least as often as it is prose, and the finder cannot tell.
  // `5 x` is not a flagged price (a flag has two decimals) and the 3.00 has
  // the same lone letter on its left, so the line offers nothing.
  ["5 x 3.00", undefined, []],

  // Letters glued to digits are a currency this grammar knows, a magnitude,
  // or a flag -- or the token is not an amount. `[A-Z]{3}` under an `i` flag
  // matched any three letters, and each of these read as a number.
  ["qty3", undefined],
  ["abc12.00", undefined],
  ["Tax12.99", undefined],
  ["xyz2.5M", undefined],
  ["1099-K", undefined],
  ["1E5", undefined],
  ["12.99E5", undefined],
  ["12.99Total", undefined],
  ["12.99kg", undefined],
  ["12.99x2", undefined],
  // A percentage is a number the line prints, and `number` values reach the
  // gate as "3,5%". The sign of the percentage is the `%`, not part of it.
  // A percent sign scales what it follows, so it is not neutral beside a
  // money amount. The `number` value type passes `percentIsNeutral`, because
  // a `number` is dimensionless and can never be money; see the gate test
  // "a percentage keeps its decimal comma".
  ["12.99%", undefined, []],
  ["A12.99", undefined],
  ["1.2e3", undefined],
  ["about ten dollars", undefined],
  ["", undefined],
];

test("the amount grammar reads exactly what the table says", () => {
  for (const [input, expected] of AMOUNT_SPEC) {
    assert.equal(
      parseAmount(input),
      expected,
      JSON.stringify(input) +
        " must " +
        (expected === undefined ? "refuse" : "read as " + expected),
    );
  }
});

// ---------------------------------------------------------------------------
// ADM-5g: the finder and the scanner are one grammar.
//
// `amountsInText` used to carry a second implementation of this table, and
// the two disagreed: `$2.5M CR` read as -2500000 on one side and refused on
// the other, `$1 000 000` offered ["1","0","0"] where the scanner read a
// million. A disagreement here is not a style question -- the finder is the
// whitelist the gate matches the model's value against, so a token it reads
// differently is a wrong number stored under a citation that looks right.
//
// The finder now delegates every span to the scanner, so the only rows that
// may differ are the ones that carry a third element, each of which is a
// rule about the *line* rather than the number.
// ---------------------------------------------------------------------------
test("the finder offers exactly what the scanner reads, and nothing else", () => {
  for (const [input, expected, line] of AMOUNT_SPEC) {
    const offered = line ?? (expected === undefined ? [] : [expected]);
    assert.deepEqual(
      amountsInText(" " + input + " "),
      offered,
      JSON.stringify(input) + ", on its own",
    );
    assert.deepEqual(
      amountsInText("Line total " + input + " on the statement"),
      offered,
      JSON.stringify(input) + ", in a sentence",
    );
  }
});

/** What a page line must offer, and must not. */
const QUOTE_SPEC = [
  // A magnitude token has exactly one value, the scaled one.
  ["Fund size $2.5M", ["2500000"]],
  ["$2.5M", ["2500000"]],
  ["Committed $1.2K total", ["1200"]],
  ["Raised 40 million", ["40000000"]],
  ["Loss ($2.5M)", ["-2500000"]],
  // ADM-5g: a magnitude letter a space away from the digits offers *nothing*,
  // with or without a currency marker. These five rows used to offer the bare
  // number, and the finder cannot tell "Room 12 B" from a printed "$12 B":
  // the room number is worth less than a billion-dollar reading is dangerous.
  ["Room 12 B suite", []],
  ["Apt 4 B rent 1,200.00", ["1200"]],
  ["Suite 3 K", []],
  ["2 m cable $19.99", ["19.99"]],
  ["Serving 250 m l", []],
  ["Fund size $2.5 M", []],
  ["Raised 2.5 mil", []],
  ["Committed $3 k", []],
  ["EUR 4 m committed", []],
  ["Fund size $2.5 MM", []],
  ["Fund C$2.5M", []],
  ["Fund A$1.2k", []],
  ["Fund US$2.5M", []],
  ["401K plan balance $12,345.67", ["12345.67"]],
  ["1099-K box 1a 12,345.67", ["12345.67"]],
  ["Line qty3 total 3.00", ["3"]],
  // A credit marker belongs to the amount beside it, not to a column to its
  // right -- and it says the amount is a credit, not that its sign flips, so
  // a line that prints the sign twice still means it once.
  ["Balance 21.60 CR", ["-21.6"]],
  // ADM-5g: a far `CR` now makes the finder refuse both sides. ADM-5f made
  // the wide gap mean "the marker is not mine", which read the 12.00 as a
  // charge on a line that may well have printed a credit; and the 45.00 has
  // a `CR` on its *left*, which is how a prefix-CR ledger signs a credit.
  ["Item 12.00          CR 45.00", []],
  ["Item 12.00 CR 45.00", ["-12"]],
  ["CR 12.00", []],
  ["DR 12.00", []],
  ["Balance $2.5M CR", ["-2500000"]],
  ["Credit (1,234.56) CR", ["-1234.56"]],
  ["Total 42.00 DR", ["42"]],
  // Every character a document prints as a minus, and the one place a dash
  // between two numbers can only be a range.
  ["Refund −$5.00", ["-5"]],
  ["Refund –$5.00", ["-5"]],
  ["Band $5.00–$10.00", []],
  ["Term 2026–2027", []],
  ["Refund ( 250.00 )", ["-250"]],
  // An identifier, a date, a phone number and an account number are each one
  // token that is not an amount. Every one of these used to offer a number
  // that competed with the line's real total, several of them negative.
  ["Ref INV-0012 total 42.00", ["42"]],
  ["Wire 20260918-000123 amount 42.00", ["42"]],
  ["Call (206) 555-0134 for $12.00", ["12"]],
  ["Invoice 12-42.00", []],
  ["Order #1234 $9.99", ["9.99"]],
  ["Check 000123 for 45.00", ["45"]],
  ["Paid 09/01/2026 $42.00", ["42"]],
  ["Due 2026-11-02", []],
  ["Acct 1234-5678-9012-3456 balance $50.00", ["50"]],
  // A gap inside a number, and the same gap between two of them.
  ["Total $1 000 000", ["1000000"]],
  ["Total 1 000 000", []],
  ["APPLES 12 990", []],
  ["Bond at 101 1/2", []],
  // What NFKC folds: a footnote marker, a unit, a vulgar fraction.
  ["Note 12.99² in the margin", []],
  ["Area $2.5m²", []],
  ["Half 12½", []],
  ["Lot $1M1", []],
  // Three capitals are a word far more often than a currency, so only a code
  // this store supports takes the digits beside it.
  ["TAX 1.30", ["1.3"]],
  ["ABC 42.00", ["42"]],
  ["Tax 13.20 USD", ["13.2"]],
  // A percentage is a number the line prints.
  ["Rate 12.99% on $1,000.00", ["1000"]],
  // Prose beside an amount leaves it alone.
  ["Paid 42.00 a month", ["42"]],
  ["Total 42.00 i owe", []],
  ["Qty 5 x 3.00", []],
  ["Refund 45.00 C", []],
  // The column artifacts ADM-5f closed, unchanged.
  ["Subtotal $ 165 .00", ["165"]],
  // ADM-5g: the ".99" is a fragment, not ninety-nine.
  // ADM-5g: each of these four is a pair the separator between them joins
  // into one readable amount -- 12.99, 1,234, 3.12, 10.80 -- so neither side
  // is offered. The receipt column below is the mirror case: nothing joins
  // `20.00` to `1.60`, so all three read, which is the recall this rule had
  // to keep.
  ["APPLES   12    .99", []],
  ["Invoice refs 1, 234, 567", []],
  ["3. 12 Pack Soda   5.99", ["5.99"]],
  ["Total 10. 80", []],
  ["20.00      1.60   21.60", ["20", "1.6", "21.6"]],
  ["Total 12.99", ["12.99"]],

  // ADM-5h: whole dollars printed with a trailing point, as a tax form
  // prints every box. The line reads the number when nothing digit-like
  // follows the point, and offers nothing at all when something does --
  // across any gap, because `12,345.      80` is one amount to one reader
  // and two cells to another and the page does not say which.
  // The box number is a number the line prints, so the finder offers it too.
  // The gate is a whitelist: an extra candidate on the line costs nothing,
  // and the model's value still has to be one of them.
  ["Box 1 ordinary business income 12,345.", ["1", "12345"]],
  ["Ordinary business income 12,345.", ["12345"]],
  ["Net rental real estate income 5.", ["5"]],
  ["Paid 42.00.", ["42"]],
  ["Refund (9,999.)", ["-9999"]],
  ["Box 1 12,345. 80", []],
  ["Box 1 12,345.      80", []],
  ["Item 5. 25 units", []],
  ["Total 5. 25", []],

  // ADM-5h review: the column-gap rule closes a one-space gap beside a
  // currency mark only before **exactly two digits**, because cents are two
  // digits and nothing else is. Without that, a trailing point made
  // `$82. 129961.-` read as minus 82.129961 and `$94. 504. billion` as
  // ninety-four and a half billion, and the page prints neither.
  ["$82. 129961.-", []],
  ["$94. 504. billion", []],
  ["$ 165 .00", ["165"]],
  // ADM-5k: and the cents may not be followed by a gap and a lowercase word.
  // `We paid $500. 25 people` is prose with a full stop in it, and the rule
  // closed the gap and offered 500.25 -- a number no reader of that sentence
  // would say. A receipt cell and a sentence are the same shape here, so both
  // readings are refused and these two rows lose their amount with it.
  ["We paid $500. 25 people", []],
  ["$82. 12 due", []],
  ["$94. 50 total", []],
  ["$82. 12 DUE", ["82.12"]],
  // ADM-5k: and the marker has to be a currency this store prices. Three
  // capitals are a word far more often than a code everywhere else in this
  // file, and the gap-closing rule was reading any of them.
  ["FEE 162. 95", []],
  ["QTY 12. 34", []],
  ["USD 162. 95", ["162.95"]],
  // ADM-5h re-review: and the cents have to end there. A letter after them
  // makes the run a box label or a magnitude, a second point makes it the
  // first half of something longer, and a sign makes it a ledger's own.
  // `$6. 25a` read as 6.25, `$5. 25b` as five and a quarter billion, and
  // `€642. 73.-` as a credit of 642.73; the page prints none of them.
  ["$6. 25a", []],
  ["$5. 25b", []],
  ["€642. 73.-", []],
  ["$5. 25-", []],
  // The extended fuzz found the rest of that class on its own: a point
  // pressed against a whole dollar, with a digit reachable through it, is a
  // decimal point as readily as a full stop -- whether or not the run beyond
  // it can be priced. `$780. 554a` offered 780 for a line that may well
  // print 780.554, and `USD 6. 9a` offered 6.
  ["$780. 554a", []],
  ["USD 6. 9a", []],
  ["£792354. 586a", []],
  // A gap, the end of the line, or a mark that cannot be part of a number
  // still closes the gap, because that is the column artifact the rule is
  // for.
  ["$6. 25", ["6.25"]],
  ["Total $6. 25, paid", ["6.25"]],
  ["| $6. 25 |", ["6.25"]],

  // A list ordinal counts nothing and is worth nothing. Digits at the very
  // start of a line, then `.` or `)`, then a space and a word, are a bullet,
  // and a bullet that can be stored as a money field is a number on the page
  // that nobody wrote as one.
  ["1. Rent 500.00", ["500"]],
  ["3) Repairs 42.00", ["42"]],
  ["10. Interest 5.", ["5"]],
  ["12. Nothing else", []],
  ["2. 50", []],
  // Without the mark after the digits, a leading number is a quantity as
  // often as a bullet -- "12 Mill Lane", "5 units of stock" -- so the rule
  // stops where its own shape stops and a K-1's box number is still offered.
  // The gate is a whitelist and an extra candidate on the line costs nothing:
  // the model's value still has to be one the line prints, and a bare run of
  // digits can never repair a citation onto a money field (`repairTarget`).
  ["1 Ordinary business income 12,345.", ["1", "12345"]],
  // ADM-5k, second round: a Capitalized word followed by another Capitalized
  // word is a name, so the street reads again while `$2.5 mill` still
  // refuses. The first round refused both and the confirmation review
  // measured what that cost.
  ["12 Mill Lane", ["12"]],

  // -------------------------------------------------------------------------
  // ADM-5g round five: every counterexample the four reviews produced.
  //
  // Each of these was an input where the finder offered a number the document
  // does not print, and each of them died to the same change: the finder no
  // longer enumerates the surroundings that make a number unreadable, it
  // requires both neighbours to be provably harmless. The comment on each
  // group names the review finding it came from.
  // -------------------------------------------------------------------------

  // Fourth review 1: only a single U+0020 counted as the gap, so every one of
  // these dropped its suffix or its sign and offered the bare number. The
  // span now extends across the whole gap run and `parseAmount` decides.
  ["Fund size $2.5  million", ["2500000"]],
  ["Fund size $2.5\tmillion", ["2500000"]],
  ["Fund size $2.5  million", ["2500000"]],
  ["Fund size $2.5 million", ["2500000"]],
  ["Fund size $2.5 ⁠ million", ["2500000"]],
  ["Fund size $2.5  M", []],
  ["Fund size $3  k", []],
  ["Fund size $2.5  bn", []],
  ["Balance 45.00  CR", []],
  ["Balance 45.00 CR", ["-45"]],
  ["Credit (   1,234)", ["-1234"]],
  ["Credit (1,234  )", ["-1234"]],
  // A grouping separator is one space wide. Two is a column, and a column of
  // three-digit cells is not one number, so the region offers nothing rather
  // than the leading 1 the fourth review found.
  ["Total $1  000  000", []],
  ["Total $1 000 000", ["1000000"]],
  // A zero-width space is invisible, so the page prints "$2.5million".
  ["Fund size $2.5​million", ["2500000"]],

  // Fourth review 3: a sign-bearing close after a spaced symbol or flag.
  ["Credit (5,79 €)", ["-5.79"]],
  ["Balance 0,64 € CR", ["-0.64"]],
  ["Line (0.51 A)", ["-0.51"]],
  ["Line 12.99 T CR", ["-12.99"]],
  ["Line 4.56 T-", []],
  ["Rate (12.5%)", []],

  // Fourth review 4: the Unicode dashes that were not folded. The first five
  // offered a positive number for a printed minus; the rest re-opened the
  // identifier and range holes the ASCII hyphen rules had closed.
  ["Refund ‐1,234", ["-1234"]],
  ["Refund ‑1,234", ["-1234"]],
  ["Refund ‒1,234", ["-1234"]],
  ["Refund ―1,234", ["-1234"]],
  ["Refund ˗1,234", ["-1234"]],
  ["Refund －1,234", ["-1234"]],
  ["Refund ﹣1,234", ["-1234"]],
  ["Form 1099‐K box 1a", []],
  ["Range 5‑10", []],
  ["Due 2026‒11‒02", []],

  // Fourth review 5: fragments across other joiners, and digits that are not
  // digits until NFKC makes them look like one.
  ["Amount CHF 1'234.56", []],
  ["Meeting at 12:30", []],
  ["Line 45.00(1)", []],
  ["Plan 401(k) balance", []],
  ["Line ①250.00", []],
  ["Line 250.00①", []],
  ["Line ⒈250", []],
  ["Line \u{1F100}250", []],
  // A zero-width character has no width, so the page prints "1234.56" and
  // that is what reads. Treating it as a boundary instead offered the two
  // fragments the review found and, far worse, hid a zero-width space inside
  // the word `million` from the magnitude rule, which would have offered a
  // millionth of the truth.
  ["Line 1​234.56", ["1234.56"]],
  ["Fund size $2.5 mill​ion", ["2500000"]],
  // A label's colon is not a joiner, and the amount still reads. Nor is the
  // bar of a pipe-rendered table, which is how several parsed receipts here
  // print a column.
  ["Subtotal: 42.00", ["42"]],
  ["Total | 21.60", ["21.6"]],
  ["Chisel | 12.00 | 1.20", ["12", "1.2"]],

  // Fourth review 6 and its residues: the grouping a currency's own locale
  // reads the other way, and the parentheses that never closed.
  ["Total 12.345 €", []],
  ["Total €12.345", []],
  ["Total 12,345 €", []],
  ["Total 12.345 EUR", []],
  ["Total $12.345", ["12.345"]],
  ["Total $1,234", ["1234"]],
  ["Holding $5 250 shares", []],
  ["Credit (250.00", []],
  ["Credit 250.00)", []],

  // Recall-only rows from the same review: nothing wrong is offered, and an
  // amount the page states is simply not read. `(3) 45.00` still is: a
  // closing parenthesis on the left is a footnote marker or an unbalanced
  // accounting one, and telling the two apart is a judgment this grammar
  // does not make.
  ["Note (3) 45.00", []],
  ["Total 1 234,56 €", []],
  // ADM-5k recovers this one, and only this one, because it is mechanical
  // rather than a judgment: the `USD` has a number after it, so it leads that
  // number and can say nothing about the twelve behind it. Twelve Canadian
  // dollars is what the line prints either way. The 15 stays unread -- a code
  // standing between two numbers provably leads neither, from its left.
  ["Column CAD 12 USD 15", ["12"]],

  // -------------------------------------------------------------------------
  // ADM-5k: the nine follow-ups the ADM-5g review left open.
  // -------------------------------------------------------------------------

  // 1. Scale and unit words are a rule now, not a deny-list. A scale word is
  // read when it spells one number and nothing else, and refuses the whole
  // token when it does not -- never the bare mantissa, which is the number
  // the page did not print.
  ["Raised $2.5 trillion", ["2500000000000"]],
  ["Raised 2.5 trillions", ["2500000000000"]],
  ["Raised ₹2.5 lakh", ["250000"]],
  ["Raised ₹2.5 crore", ["25000000"]],
  ["Raised 7 lakh", ["700000"]],
  ["Raised 3 crores", ["30000000"]],
  ["Raised $2.5M", ["2500000"]],
  ["Raised $2.5 mln", []],
  ["Raised $2.5 mill", []],
  ["Raised $3 thou", []],
  ["Raised $2.5 grand", []],
  ["Raised $2.5 bill", []],
  ["Raised $2.5 bil", []],
  ["Raised $2.5 tn", []],
  ["Raised $2.5 trn", []],
  ["Raised $2.5 lac", []],
  ["Raised $2.5tn", []],
  // A unit changes what the number measures, so a money field may not read
  // it. `45 cents` is not forty-five dollars and `45.00 percent` is not
  // forty-five of anything a money field stores.
  ["Paid 45 cents", []],
  ["Paid 45 cent", []],
  ["Rate 45.00 percent", []],
  ["Rate 100.00 percent", []],
  ["Rate 45.00 pct", []],
  ["Rate 45 bps", []],
  ["Rate 45 basis points", []],
  ["Holding 100 shares", []],
  ["Holding 12 units", []],
  // ADM-5k, second round: a rate is still the printed dollars. The gate's
  // claim is that the cited text prints the value, not that the value is a
  // total, so `per` and `each` are neutral for money again.
  ["Price $5.00 per", ["5"]],
  ["Price $5.00 each", ["5"]],
  ["Price 2 ea", ["2"]],
  ["Rent $2,000.00 per month", ["2000"]],
  ["Dividend $0.52 per share 100 shares $52.00", ["0.52", "52"]],
  // Only directly after the amount, which is the one place a unit can stand.
  // A unit word in front of a number is that number's label.
  ["Cost basis 1,234.56", ["1234.56"]],
  ["Per diem 45.00", ["45"]],
  ["Percent of total 12.50", ["12.5"]],
  ["Shares 100 at $5.00", ["100", "5"]],
  // A scale word is refused on both sides, which is the rule this grammar has
  // had since ADM-5g. `Grand Total` still reads, because the word next to the
  // amount is `Total`.
  ["Grand Total 1,234.56", ["1234.56"]],
  ["million 42.00", []],

  // 2. Neutral punctuation is not a wall. A bar or a semicolon cannot sign or
  // scale a number, and it cannot hide what does either. A pipe-rendered
  // table is how many of this store's parsed receipts print a column, so the
  // rows that print only a label and a value read exactly as they did.
  ["| Payment | 45.00 | CR |", []],
  ["| Payment | 45.00 ; CR", []],
  ["$45.00 | million", []],
  ["-| 45.00", []],
  ["45.00 | M", []],
  ["| 45.00 | (", []],
  ["| Total | 1,234.56 |", ["1234.56"]],
  ["| Item | 20.00 |", ["20"]],
  ["| Mallet | 8.00 | 0.80 |", ["8", "0.8"]],

  // 3. A digit a reader can read and this grammar cannot poisons its token,
  // by the property Unicode files it under rather than by a list of blocks.
  // The dingbat circled digits reached review unpoisoned.
  ["Line ❶250.00", []],
  ["Line 250.00❶", []],
  ["Line ➀250", []],
  ["Line ➓250", []],
  ["Total 12➓", []],
  ["Total 7.❶45", []],
  // And a run the poison cut in half is a fragment, not a separate token: the
  // finder read the `380` beside one as a line of its own.
  ["380 3१24.5", []],
  ["Total 380 12❶.5", []],

  // 4. The column-gap rule and the tokens beside it. `1, 234K` offered the
  // leading 1 because the joined reading refuses for want of a currency
  // marker -- which is a rule about `401K`, not a proof that the two runs are
  // separate.
  ["1, 234K", []],
  ["2. 5M", []],
  ["Refs 1, 234 m", []],

  // 5. A decimal head may never take space groups. `$12.99 100 200` offered
  // 12.991002, a number with the cents of one cell and the digits of two
  // more, because only the last character of the head was checked.
  ["$12.99 100 200", []],
  ["$12.99 100 200 300", []],
  ["$1,234 567 890", []],
  ["Total $1 000 000", ["1000000"]],

  // Known behaviour, documented rather than fixed. A single dot group is a
  // decimal point wherever the token does not carry a currency whose locale
  // says otherwise: `3.499` is three and a half here, and `Rp 12.000` is
  // twelve, because `Rp` is not a currency this grammar knows and nothing
  // else in the token settles the separator. Refusing these would mean
  // refusing `3.499`, `1.075` and `0.125` as well, which the table above has
  // asserted since the grammar was written.
  ["Total 3.499", ["3.499"]],
  ["Total Rp 12.000", ["12"]],

  // -------------------------------------------------------------------------
  // ADM-5k, second round. The confirmation review found no new wrong number
  // and measured the round losing about a third of the correct offers on the
  // owner's commonest shapes. Every row below is a relaxation, and every one
  // of them is mechanical; the guards under each are the closed cases the
  // relaxation may not reopen.
  // -------------------------------------------------------------------------

  // A cell past a rule is a neighbouring value, not a marker on this one. A
  // cell that reads as a whole amount, a lone currency code, a blank marker,
  // or a label with nothing in it that can sign or scale, all say nothing
  // about the amount on the other side of the bar.
  ["| Dividends | $12.50 | $150.00 |", ["12.5", "150"]],
  ["| (5.00) | (6.00) |", ["-5", "-6"]],
  ["| Net income (loss) | (12,500) | 3,200 |", ["-12500", "3200"]],
  ["| Check | 45.00 | -1,204.17 |", ["45", "-1204.17"]],
  ["| Gain | 2,500.00 | USD |", ["2500"]],
  ["| 45.00 | N/A |", ["45"]],
  ["| Opening | 1,000.00 | Closing | 1,250.00 |", ["1000", "1250"]],
  ["| $2.5M | $3.0M |", ["2500000", "3000000"]],
  ["| $2.5M | $3.0K |", ["2500000", "3000"]],
  // And the cells that still refuse, because each of them could sign, scale
  // or re-measure the amount beside it.
  ["| Payment | 45.00 | CR |", []],
  ["| 45.00 | million |", []],
  ["| 45.00 | % |", []],
  ["| 2.5 | M |", []],
  ["| 45.00 | CR 12.00 |", []],
  ["| 45.00 | (12.00 |", []],
  ["| 45.00 | - |", []],
  // A percent sign in the next cell measures the next cell. The bar is what
  // says so, and the 12.5 it does reach is refused on its own account.
  ["| 45.00 | 12.5% |", ["45"]],
  ["-| 45.00", []],

  // A scale word that is also an ordinary word or a name refuses only
  // directly after the amount, and never where it opens a name. In front of
  // the amount it is that amount's label.
  ["Water Bill $64.12", ["64.12"]],
  ["Bill 120.00", ["120"]],
  ["Nashville, TN $45.00", ["45"]],
  ["$1,250.00 Mill Creek Partners LP", ["1250"]],
  ["500.00 Grand Rapids", ["500"]],
  ["Grand total 1,234.56", ["1234.56"]],
  ["Raised $2.5 mill", []],
  ["Raised $2.5 grand", []],
  ["Raised $3 bill", []],
  ["Raised $2 tn", []],
  ["Raised $2.5 Mill", []],
  ["Raised $2.5 mill.", []],

  // A currency mark says the amount is money whatever noun follows it; a
  // bare count is still a count.
  ["Invested $50,000.00 Shares issued 5,000", ["50000", "5000"]],
  ["Holding 100 shares", []],
  ["Holding 12 units", []],
  ["Holding $100.00 shares", ["100"]],
  ["Rate 45.00 percent", []],
  ["Paid 45 cents", []],

  // A gap after the cents followed by a digit is the next cell, not the end
  // of this number: `$7. 42 849.70` offered 7.42 and 849.70 for a line that
  // may print either two cells or one number.
  ["$7. 42 849.70", []],
  ["$6. 25", ["6.25"]],
  ["$82. 12 DUE", ["82.12"]],

  // A compound amount is one number said the way a person says it. Two
  // scaled spans one space apart, the larger scale first, used to offer the
  // first of them whole -- short by whatever the second one adds.
  ["$3 million 2 thousand", []],
  ["1 crore 25 lakh", []],
  ["5 lakh 20 thousand", []],
  ["Raised $2.5 million", ["2500000"]],
  ["Raised 2.5 Million", ["2500000"]],

  // A Capitalized scale word followed by a Capitalized word is a place.
  ["45.00 Lakh Street", []],
  ["45.00 Thousand Oaks", []],
  ["Raised 45.00 thousand", ["45000"]],
];

test("a page line offers exactly the amounts the table says", () => {
  for (const [line, expected] of QUOTE_SPEC) {
    assert.deepEqual(amountsInText(line), expected, JSON.stringify(line));
  }
});

/**
 * What a page prints across a line break, and what the line below it may do
 * to the line above.
 *
 * ADM-5k. A line end is a real edge and was therefore a *known* one, so
 * nothing asked what stood past it: a letter printing `raised $2.5` with
 * `million` wrapped onto the next line offered two and a half, and a ledger
 * printing `CR` above its amount offered a charge. The wrap token is never
 * read as part of the amount -- assembling a number out of two lines is the
 * fabrication this gate exists to prevent -- it only has to be provably
 * unable to scale or sign it.
 *
 * Scale and sign, and deliberately nothing else. A column receipt prints one
 * amount per line and a form labels its boxes, so a digit or a word on the
 * next line is the ordinary case: refusing those would cost every receipt and
 * every K-1 in the store and catch nothing.
 *
 * Each row is the text, the wrap tokens `pageLines` carries for it, and what
 * the line may offer.
 */
const WRAP_SPEC = [
  // The wrap this rule exists for.
  ["raised $2.5", {}, { nextToken: "million" }, []],
  ["raised $2.5", {}, { nextToken: "MM" }, []],
  ["raised $2.5", {}, { nextToken: "M" }, []],
  ["raised $2.5", {}, { nextToken: "mil" }, []],
  ["raised $2.5", {}, { nextToken: "trillion" }, []],
  ["raised $2.5", {}, { nextToken: "per month" }, ["2.5"]],
  ["Balance 45.00", {}, { nextToken: "CR" }, []],
  ["Balance 45.00", {}, { nextToken: "USD" }, []],
  ["Balance 45.00", {}, { nextToken: "%" }, []],
  ["Balance 45.00", {}, { nextToken: ")" }, []],
  // And the mirror: a marker at the end of the line above.
  ["45.00", { previousToken: "CR" }, {}, []],
  ["45.00", { previousToken: "DR" }, {}, []],
  ["45.00", { previousToken: "-" }, {}, []],
  ["45.00", { previousToken: "(" }, {}, []],
  ["45.00", { previousToken: "$" }, {}, []],
  // The ordinary next line, which costs nothing. A column of amounts, a
  // label, a form's single-letter box name, a page that simply ends.
  ["Balance 45.00", {}, { nextToken: "1.60" }, ["45"]],
  ["Balance 45.00", {}, { nextToken: "Paid" }, ["45"]],
  ["Balance 45.00", {}, { nextToken: "Total" }, ["45"]],
  ["Balance 45.00", {}, {}, ["45"]],
  ["(9,999.)", {}, { nextToken: "L Ending capital account" }, ["-9999"]],
  ["1 Ordinary business income 12,345.", {}, { nextToken: "2" }, ["1", "12345"]],

  // ADM-5k, second round. A next line that reads as a whole amount is the
  // next cell of a column, not a marker on this one: refusing every line
  // whose neighbour opens with `$`, `(` or `-` cost an eighth of the correct
  // offers on amount columns.
  ["$20.00", {}, { nextToken: "$1.60" }, ["20"]],
  ["$1.60", { previousToken: "$20.00" }, { nextToken: "$21.60" }, ["1.6"]],
  ["$21.60", { previousToken: "Total" }, { nextToken: "$5.00" }, ["21.6"]],
  ["(5.00)", {}, { nextToken: "(6.00)" }, ["-5"]],
  ["45.00", {}, { nextToken: "-1,204.17" }, ["45"]],
  ["45.00", { previousToken: "(1,204.17)" }, {}, ["45"]],
  ["45.00", {}, { nextToken: "$12.00 Tax" }, ["45"]],
  // And a next line that is a marker still refuses, whatever it is dressed
  // in. A zero-width character and a soft hyphen are not characters a reader
  // sees, leading punctuation is stepped over, and a blank line is looked
  // past by `pageLines` before the token is ever cut.
  ["Balance 45.00", {}, { nextToken: "-" }, []],
  ["Balance 45.00", {}, { nextToken: "(credit)" }, []],
  ["Balance 45.00", {}, { nextToken: "*CR" }, []],
  ["Balance 45.00", {}, { nextToken: "[CR]" }, []],
  ["Balance 45.00", {}, { nextToken: "\u200bCR" }, []],
  ["raised $2.5", {}, { nextToken: ".million" }, []],
  ["raised $2.5", {}, { nextToken: ", million" }, []],
  ["raised $2.5", {}, { nextToken: "\u00admillion" }, []],

  // A form labels its rows with the letters a magnitude is written with, so
  // a single closing letter is a label when a word follows it and a
  // magnitude when nothing does.
  ["12,345.", {}, { nextToken: "K Net rental real estate income" }, ["12345"]],
  ["12,345.", {}, { nextToken: "M Section 179 deduction 500." }, ["12345"]],
  ["12,345.", {}, { nextToken: "D Nonqualified plans" }, ["12345"]],
  ["2.5", {}, { nextToken: "K" }, []],
  ["2.5", {}, { nextToken: "M" }, []],
  ["2.5", {}, { nextToken: "M." }, []],
  ["2.5", {}, { nextToken: "M 500" }, []],
  ["2.5", {}, { nextToken: "L Ending capital account" }, ["2.5"]],
  ["45.00", { previousToken: "Subtotal" }, {}, ["45"]],
  ["45.00", { previousToken: "20.00" }, {}, ["45"]],
  ["45.00", { previousToken: "|" }, {}, ["45"]],
  // A cut edge stays unknown whatever the wrap token says: a cut is not a
  // line break, and the character beyond it is still gone.
  ["raised $2.5", { cutStart: true }, {}, []],
  ["raised $2.5", {}, { cutEnd: true }, []],

  // Known behaviour, documented rather than fixed, and the mirror of the
  // locale rows above. A grouping separator at a line end with digits under
  // it could be one wrapped number: `Total $1,234,` over `567` offers 1,234.
  // Refusing every line-final separator with a digit on the next line would
  // refuse every K-1 box, whose trailing point sits above the next box's
  // number, and a PDF's text layer does not break a number in half.
  ["Total $1,234,", {}, { nextToken: "567" }, ["1234"]],
];

test("a wrap may not hide what scales or signs the line above it", () => {
  for (const [text, before, after, expected] of WRAP_SPEC) {
    assert.deepEqual(
      amountsInText(text, { ...before, ...after }),
      expected,
      `${JSON.stringify(text)} with ${JSON.stringify({ ...before, ...after })}`,
    );
  }
});

test("a page's lines carry the tokens their neighbours print", () => {
  const lines = pageLines("raised $2.5\nmillion from\n21.60");
  assert.deepEqual(
    lines.map((line) => [line.text, line.previousToken, line.nextToken]),
    [
      ["raised $2.5", undefined, "million from"],
      ["million from", "raised $2.5", "21.60"],
      ["21.60", "million from", undefined],
    ],
  );
  // ADM-5k, second round: a blank line is looked past, not stopped at, and
  // what a reader cannot see is taken out before the lead is cut. A page
  // printing `45.00`, a blank line and `CR` prints a credit.
  const spaced = pageLines("45.00\n   \n\nCR");
  assert.equal(spaced[0].nextToken, "CR");
  assert.equal(spaced[3].previousToken, "45.00");
  assert.equal(pageLines("45.00\n\u200bCR")[0].nextToken, "CR");
  assert.equal(pageLines("$2.5\n\u00admillion")[0].nextToken, "million");
  // A cut is not a line break, so a piece carries no wrap token across one.
  const long = pageLines(`${"word ".repeat(80)}$2.5 million`);
  assert.ok(long.length > 1, "the line was split");
  assert.equal(long[0].cutEnd, true);
  assert.equal(long[0].nextToken, undefined);
  assert.equal(long[1].previousToken, undefined);
});

test("the scaled value is the only one a citation supports", () => {
  const gateMoney = (value, quote) =>
    checkValue({
      valueType: "money",
      value,
      candidates: asCandidates(quote),
      pageText: quote,
      defaultCurrency: "USD",
    });
  // The mirror pair: neither reading may borrow the other's citation.
  assert.equal(gateMoney("2500000", "Fund size $2.5M").ok, true);
  assert.deepEqual(gateMoney("2.5", "Fund size $2.5M"), {
    ok: false,
    reason: "value_not_in_quote",
  });
  assert.equal(gateMoney("2.5", "Fund size $2.5").ok, true);
  assert.deepEqual(gateMoney("2500000", "Fund size $2.5"), {
    ok: false,
    reason: "value_not_in_quote",
  });
});
