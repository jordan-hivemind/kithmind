// The amount finder against an oracle that does not know it exists.
//
// Four reviews of ADM-5g each found an input where `amountsInText` offered a
// number the document does not print, and each one was found by a person
// reading the code and thinking of a case it had not enumerated. A fifth
// reviewer would have found a sixth case. So this file replaces the reviewer
// with a generator and a check that runs on every suite.
//
// ## How it is independent
//
// Nothing here imports the grammar's rules. A case is built from *pieces* --
// a sign, a currency marker, digit groups, a separator, a magnitude, a flag,
// a credit marker, parentheses, gaps -- and the value it must have is
// computed from those pieces with `BigInt`, by moving a decimal point, in
// `truthOf` below. The generator is what printed the token, so it is the only
// thing in this repository that knows what the token says without asking the
// code under test.
//
// The three invariants, in the order they matter:
//
//   (a) **Never a number the page does not print.** Every value the finder
//       offers for a string must be the oracle's exact value of one whole
//       printed token in that string. A fragment, a dropped magnitude, a lost
//       sign and a swallowed digit group all fail this, because none of them
//       equals a whole token's value.
//   (b) **The finder and the scanner are one grammar.** For a string that is
//       exactly one printed token, the finder offers `[parseAmount(token)]`
//       or nothing. It may never offer a third thing.
//   (c) **Sign, scale and grouping.** No offered value may be the negation of
//       a token's value, that value times a power of ten, or that value with
//       a digit group added or dropped, unless it is itself some token's
//       exact value. This is (a) sharpened: it says *how* a wrong number
//       would be wrong, so a failure report names the fault.
//
// Refusing is always allowed. An empty result can never be a wrong number,
// and this file never asserts that anything *is* offered; the spec tables in
// `extractionGate.test.mjs` own recall.
//
// ## Running it harder
//
// The suite runs about 50,000 cases from a fixed seed, which is a few
// seconds. `KITH_AMOUNT_FUZZ_CASES` and `KITH_AMOUNT_FUZZ_SEEDS` (a
// comma-separated list) run millions locally:
//
//     KITH_AMOUNT_FUZZ_CASES=2000000 KITH_AMOUNT_FUZZ_SEEDS=1,2,3 \
//       node --test test/extractionAmountFuzz.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { amountsInText, parseAmount } from "../dist/extraction/index.js";
import { pageLines } from "../dist/extraction/lines.js";

// ---------------------------------------------------------------------------
// A pseudo-random generator, so a failure is a seed and a case number rather
// than a story. Mulberry32: thirty lines of arithmetic, no dependency, and
// the same sequence on every machine and every version of Node.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const next = mulberry32(seed);
  const random = {
    int: (bound) => Math.floor(next() * bound),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (odds) => next() < odds,
    digits: (count, leadingZero = false) => {
      let out = "";
      for (let at = 0; at < count; at += 1) {
        const low = at === 0 && !leadingZero ? 1 : 0;
        out += String(low + Math.floor(next() * (10 - low)));
      }
      return out;
    },
  };
  return random;
}

// ---------------------------------------------------------------------------
// The oracle. `coefficient` and `scale` are an exact decimal: the value is
// `coefficient / 10^scale`. A magnitude multiplies by a power of ten, which
// is done by moving the point -- subtracting from the scale and padding with
// zeros when it runs out -- never by multiplying a float.
// ---------------------------------------------------------------------------

/** The exact value of a printed token, as the canonical decimal string the
 * store keeps. Written from the pieces the generator chose, with no reference
 * to the grammar that has to read them back. */
function truthOf({ whole, fraction, magnitude, negative }) {
  let coefficient = BigInt(whole + fraction);
  let scale = fraction.length;
  if (magnitude > 0) {
    if (magnitude <= scale) {
      scale -= magnitude;
    } else {
      coefficient *= 10n ** BigInt(magnitude - scale);
      scale = 0;
    }
  }
  return formatDecimal(negative, coefficient, scale);
}

function formatDecimal(negative, coefficient, scale) {
  let digits = coefficient.toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    const head = digits.slice(0, digits.length - scale);
    const tail = digits.slice(digits.length - scale).replace(/0+$/, "");
    digits = tail.length > 0 ? `${head}.${tail}` : head;
  }
  digits = digits.replace(/^0+(?=\d)/, "");
  if (/^0(\.0*)?$/.test(digits)) return "0";
  return (negative ? "-" : "") + digits;
}

/** Ten to the power of `places`, as a decimal-shifting helper the invariants
 * use to name a wrong scale. */
function shiftedBy(value, places) {
  const negative = value.startsWith("-");
  const bare = negative ? value.slice(1) : value;
  const [head, tail = ""] = bare.split(".");
  const coefficient = BigInt(head + tail);
  const scale = tail.length - places;
  if (scale >= 0) return formatDecimal(negative, coefficient, scale);
  return formatDecimal(negative, coefficient * 10n ** BigInt(-scale), 0);
}

// ---------------------------------------------------------------------------
// The pieces a printed amount is made of.
// ---------------------------------------------------------------------------

/** Every gap a parsed page puts between two tokens, including the ones the
 * fourth review found were not treated as gaps at all. */
const GAPS = [
  " ",
  "  ",
  "   ",
  "      ",
  "\t",
  " \t ",
  "\u00a0",
  "\u00a0\u00a0",
  "\u2003",
  "\u202f",
  "\u205f",
  "\u3000",
  "\u2028",
];

/** Characters with no width at all, which a PDF's text layer emits freely. */
const ZERO_WIDTH = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"];

/** Currency markers, with the code each names. */
const SYMBOLS = [
  ["$", "USD"],
  ["\u00a3", "GBP"],
  ["\u00a5", "JPY"],
  ["\u20b9", "INR"],
  ["\u20a9", "KRW"],
  ["\u20ac", "EUR"],
];
const CODES = ["USD", "EUR", "GBP", "CAD", "CHF", "JPY", "AUD", "SEK"];

/** Magnitudes, as the letters and the words a document prints them with. */
const MAGNITUDE_LETTERS = [
  ["k", 3],
  ["K", 3],
  ["m", 6],
  ["M", 6],
  ["MM", 6],
  ["mm", 6],
  ["mn", 6],
  ["b", 9],
  ["B", 9],
  ["bn", 9],
];
const MAGNITUDE_WORDS = [
  ["thousand", 3],
  ["thousands", 3],
  ["million", 6],
  ["millions", 6],
  ["billion", 9],
  ["billions", 9],
  // ADM-5k. A trillion is a million million, a lakh is a hundred thousand
  // and a crore is ten million, wherever they are printed. These are claims
  // about the words, not about the code: the oracle shifts the point by the
  // places written here and the grammar has to agree.
  ["trillion", 12],
  ["trillions", 12],
  ["lakh", 5],
  ["lakhs", 5],
  ["crore", 7],
  ["crores", 7],
];

/** Every dash a document prints where it means a minus. */
const DASHES = [
  "-",
  "\u2010",
  "\u2011",
  "\u2012",
  "\u2013",
  "\u2014",
  "\u2015",
  "\u2212",
  "\u02d7",
  "\ufe58",
  "\ufe63",
  "\uff0d",
];

/** Words safe to stand beside an amount: two letters or more, and none of
 * them a magnitude, a credit marker or an ISO code. */
const WORDS = [
  "Total",
  "Subtotal",
  "Balance",
  "Paid",
  "Invoice",
  "Item",
  "Amount",
  "the",
  "statement",
  "and",
  "for",
  "Widget",
  "Consulting",
  "services",
  // ADM-5k: the fourteen above were the whole vocabulary, so a word was
  // never a surprise. These are ordinary English a receipt, a statement or a
  // letter prints, and not one of them measures or scales anything.
  "Reference",
  "Description",
  "Store",
  "Card",
  "Change",
  "Cash",
  "Account",
  "Order",
  "Customer",
  "Thank",
  "Receipt",
  "Terminal",
  "Merchant",
  "Approved",
  "Purchase",
  "Discount",
  "Delivery",
  "Shipping",
  "Handling",
  "Service",
  "Register",
  "Cashier",
  "Visit",
  "again",
  "please",
  "monthly",
  "annual",
  "opening",
  "closing",
];

/**
 * Words that make the amount **in front of them** unpriceable.
 *
 * Every one of these is a statement about English rather than about the
 * grammar under test: a line printing `2.5 mil` does not print two and a
 * half, `45 cents` is not forty-five of the units a money field stores,
 * `45.00 CR` is not a charge, and `2.5 M` beside a room number is not two and
 * a half million. Whether the page means the scaled reading, the other
 * reading, or something a reader would have to guess at, the one answer that
 * cannot be a wrong number is no answer at all -- so the oracle prices none
 * of them and the finder may offer nothing.
 *
 * In front of the amount instead, almost none of them binds: `million 42.00`
 * is forty-two to any reader and `Cost basis 1,234.56` is a money line with a
 * label on it. {@link SPOILING_BEFORE} holds the few that do.
 *
 * `per`, `each`, `ea` and `apiece` are not here either. A rate is still the
 * printed dollars: `Rent $2,000.00 per month` prints two thousand dollars,
 * and what the number is a rate *of* is a question about the field rather
 * than about the characters.
 *
 * An ISO currency code is not here at all. A code names the money and never
 * changes the number, on either side: `Tax 13.20 USD` is thirteen twenty.
 *
 * The generator does not say which of them the grammar reads and which it
 * refuses. It says only that it cannot price them, which is the claim that
 * makes an offer a counterexample.
 */
const SPOILING_AFTER = [
  // Scale, spelled a way no page settles. Lower case, and last on the line:
  // a Capitalized one followed by another Capitalized word is a place, which
  // {@link makeName} prints instead.
  "mil",
  "mill",
  "mills",
  "mln",
  "thou",
  "thous",
  "grand",
  "bill",
  "bil",
  "bills",
  "tn",
  "trn",
  "tril",
  "trill",
  "lac",
  "lacs",
  "mio",
  // Scale, as a single letter a room number wears just as well.
  "K",
  "M",
  "B",
  "k",
  "m",
  "b",
  "MM",
  "mm",
  "bn",
  "mn",
  // Not a sign: `CR` and `DR` one space after an amount are the documented
  // credit and debit markers, and the oracle prices those itself. In front of
  // the amount they are {@link SPOILING_BEFORE}.
  // Units, which measure something a money field does not store.
  "cents",
  "cent",
  "percent",
  "pct",
  "bps",
  "bp",
  "basis",
];

/**
 * Nouns that make a **bare** number a count rather than a sum.
 *
 * `100 shares` is a holding and forty-five dollars is not what it says. A
 * currency mark settles it the other way -- `$50,000.00 Shares issued` is
 * fifty thousand dollars however the sentence goes on -- so these spoil only
 * an amount that prints no marker, and {@link makeCountedUnit} is the shape
 * that prints one.
 */
const COUNT_UNITS = ["shares", "share", "units", "unit"];

/**
 * Words that make the amount **after** them unpriceable.
 *
 * Only a sign does that. A ledger that prints its credits with the marker in
 * front means minus forty-five by `CR 45.00`, and a ledger that does not
 * means forty-five; the characters are the same and the page does not say.
 * A scale or a unit binds backwards and cannot reach the number after it.
 */
const SPOILING_BEFORE = ["CR", "DR", "cr", "dr", "Cr", "Dr"];

/**
 * Tokens that are not amounts at all, printed on the same lines. Every one of
 * them is a shape one of the four reviews saw read as a number.
 *
 * Their oracle value is *nothing*: the finder may offer no value on their
 * account, so any value it does offer has to come from a real token beside
 * them, and a fragment of one of these fails invariant (a) outright.
 */
const HOSTILE = [
  "INV-0012",
  "1099-K",
  "20260918-000123",
  "#1234",
  "qty3",
  "abc12.00",
  "Tax12.99",
  "09/01/2026",
  "2026-11-02",
  "1.2.26",
  "5-10",
  "2026-2027",
  "(206) 555-0134",
  "12:30",
  "\u2460250.00",
  "12\u00bd",
  "12.99\u00b2",
  "\u2488250",
  "401K",
  "10K",
  "1'234.56",
  "12.99%",
  "45.00(1)",
  "401(k)",
  "1234-5678-9012-3456",
  "0012",
  "000123",
  "1,23,456.00",
  "$2.5m\u00b2",
  "\u0661\u066b\u0665",
];

/**
 * One printed amount, and the value it prints.
 *
 * Every choice is recorded in the returned record, so a failing case can be
 * read back rather than guessed at. Shapes the grammar is documented to
 * refuse -- a magnitude letter with no currency, a flag on a number that is
 * not two decimal places, a sign a gap away from its digits -- are generated
 * deliberately: the oracle still knows what they say, and refusing them is
 * always allowed, but *misreading* them is not.
 */
function makeAmount(random) {
  const wholeLength = 1 + random.int(7);
  let fractionLength = random.pick([0, 0, 0, 2, 2, 2, 1, 3, 4]);
  const whole = random.digits(wholeLength);
  let fraction = random.digits(fractionLength, true);

  // A currency marker, on either side, glued or a gap away.
  const wants = random.pick(["none", "none", "symbol", "symbol", "code"]);
  let symbol = "";
  let code = "";
  let currencyName;
  if (wants === "symbol") {
    const chosen = random.pick(SYMBOLS);
    symbol = chosen[0];
    currencyName = chosen[1];
  } else if (wants === "code") {
    code = random.pick(CODES);
    currencyName = code;
  }
  const marker = symbol || code;
  const markerSide = marker ? random.pick(["before", "before", "after"]) : "";
  let markerGap = marker ? random.pick(["", "", " ", random.pick(GAPS)]) : "";

  // Grouping and the decimal separator, in the two conventions the grammar
  // documents plus the space grouping a currency marker settles.
  let grouping = random.pick([
    "none",
    "none",
    "comma",
    "dot",
    "space",
    "commaDecimal",
  ]);
  if (grouping === "comma" && wholeLength < 4) grouping = "none";
  if (grouping === "dot" && wholeLength < 7) grouping = "none";
  if (grouping === "space" && wholeLength < 7) grouping = "none";
  let printedWhole = whole;
  let point = ".";
  if (grouping === "comma") printedWhole = groupFrom(whole, ",");
  else if (grouping === "dot") {
    printedWhole = groupFrom(whole, ".");
    point = ",";
  } else if (grouping === "space") printedWhole = groupFrom(whole, " ");
  else if (grouping === "commaDecimal") point = ",";
  // A decimal comma with exactly three digits after it is two readings a
  // thousand apart and nothing in the text settles either: `1000,000` is a
  // thousand and a million at once, and `123,456` is a hundred and
  // twenty-three thousand to an English reader and a hundred and twenty-three
  // and a bit to a German one. The fraction goes rather than the comma,
  // because moving the comma to a dot beside *dot* grouping would print a
  // fourth group and invent a different ambiguity.
  if (point === "," && fractionLength === 3) {
    fractionLength = 0;
    fraction = "";
  }
  const digits =
    fractionLength > 0 ? `${printedWhole}${point}${fraction}` : printedWhole;

  // A magnitude: a letter pressed against the digits, or a word that may be a
  // gap away.
  const magnitudeKind = random.pick([
    "none",
    "none",
    "none",
    "letter",
    "word",
  ]);
  let magnitude = 0;
  let suffix = "";
  let suffixGap = "";
  /** True when the printed token says something this generator cannot put a
   * number to, so the only value it may be offered is none. */
  let spoiled = false;
  if (magnitudeKind === "letter") {
    const [letters, places] = random.pick(MAGNITUDE_LETTERS);
    magnitude = places;
    suffix = letters;
    // ADM-5k: a magnitude letter a gap away from its digits. `$2.5 M` is two
    // and a half million, `Room 12 B` is a room, and `Serving 250 m l` is a
    // volume -- the same characters, and the page does not say which. The
    // generator prints it and prices nothing.
    if (random.chance(0.25)) {
      suffixGap = random.pick([" ", random.pick(GAPS)]);
      spoiled = true;
    }
  } else if (magnitudeKind === "word") {
    const [word, places] = random.pick(MAGNITUDE_WORDS);
    magnitude = places;
    suffix = word;
    suffixGap = random.pick(["", " ", random.pick(GAPS)]);
  }

  // A tax or status flag, which changes nothing about the value.
  const flag =
    magnitudeKind === "none" && random.chance(0.12)
      ? random.pick(["T", "A", "F", "N", "X"])
      : "";
  // A flag glued to a trailing currency code makes one word -- `CHFN`, `AUDA`
  // -- which is neither, so the token the oracle priced is not the token the
  // page prints.
  const flagGap = flag
    ? markerSide === "after"
      ? random.pick([" ", random.pick(GAPS)])
      : random.pick(["", " ", random.pick(GAPS)])
    : "";

  // ADM-5h: a whole dollar printed with the point still there and no cents
  // after it -- `5.`, `12,345.`, `(9,999.)`. Every box of a tax form prints
  // this way. The point is typography and not a fraction, so the value the
  // oracle computed above is the same with it or without it: `truthOf` is
  // never told about it, which is what makes this generated form a test of
  // the grammar rather than a copy of it.
  //
  // Only where the point can be the last character of the number. A
  // magnitude, a fraction or a flag after it would print a token no reader
  // would price the way the oracle does.
  const trailingDot =
    fractionLength === 0 &&
    magnitudeKind === "none" &&
    !flag &&
    random.chance(0.14);
  const printedDigits = trailingDot ? `${digits}.` : digits;

  // The sign, in every shape a ledger prints one.
  const signKind = random.pick([
    "none",
    "none",
    "none",
    "leading",
    "trailing",
    "parentheses",
    "credit",
    "debit",
    "gapped",
  ]);
  let negative = false;
  let before = "";
  let after = "";
  if (signKind === "leading") {
    negative = true;
    before = random.pick(DASHES);
  } else if (signKind === "gapped") {
    negative = true;
    before = random.pick(DASHES) + random.pick(GAPS);
  } else if (signKind === "trailing") {
    negative = true;
    after = random.pick(DASHES);
  } else if (signKind === "credit") {
    negative = true;
    after = `${random.pick([" ", " ", random.pick(GAPS)])}CR`;
  } else if (signKind === "debit") {
    after = `${random.pick([" ", random.pick(GAPS)])}DR`;
  }

  // A magnitude letter is pressed against the digits; a word may be a gap
  // away. Either way it is part of the number, and the currency marker goes
  // outside both.
  let core = printedDigits;
  if (magnitudeKind === "letter") core = `${digits}${suffixGap}${suffix}`;
  else if (magnitudeKind === "word") core = `${digits}${suffixGap}${suffix}`;
  // A magnitude word and a trailing currency code need something between
  // them. `millionsCAD` is one word to any reader and to the grammar, so the
  // oracle would be pricing a token nobody printed.
  if (suffixGap !== "" && markerSide === "after" && markerGap === "") {
    markerGap = " ";
  }
  let body =
    markerSide === "before"
      ? `${marker}${markerGap}${core}`
      : markerSide === "after"
        ? `${core}${markerGap}${marker}`
        : core;
  if (flag) body = `${body}${flagGap}${flag}`;
  let text = `${before}${body}${after}`;
  if (signKind === "parentheses") {
    negative = true;
    const inner = random.pick(["", " ", random.pick(GAPS)]);
    const outer = random.pick(["", " ", random.pick(GAPS)]);
    text = `(${inner}${text}${outer})`;
  }
  // Zero-width characters have no width, so they change nothing a reader sees.
  if (random.chance(0.12)) {
    const at = random.int(text.length + 1);
    text = text.slice(0, at) + random.pick(ZERO_WIDTH) + text.slice(at);
  }

  // ADM-5k. Three shapes the generator never printed, each of them a token a
  // reader cannot price either. A second sign is not a second negation and
  // not a positive: `--5` is not five and `-+5` is not anything. A
  // parenthesis with no partner is an accounting minus to one reader and a
  // footnote to another. And a digit from another script, or a circled one,
  // is a digit a reader reads and this grammar must not -- the number it
  // would make is a number nobody printed.
  const damage = random.int(40);
  if (damage === 0) {
    text = `${random.pick(DASHES)}${random.pick(["-", "+", ...DASHES])}${text}`;
    spoiled = true;
  } else if (damage === 1) {
    text = `${random.pick(DASHES)}${text}${random.pick(DASHES)}`;
    spoiled = true;
  } else if (damage === 2) {
    text = random.chance(0.5) ? `(${text}` : `${text})`;
    spoiled = true;
  } else if (damage === 3) {
    const digitAt = [...text].findIndex((unit) => /\d/.test(unit));
    if (digitAt >= 0) {
      text =
        text.slice(0, digitAt + 1) +
        random.pick(EXOTIC_DIGITS) +
        text.slice(digitAt + 1);
      spoiled = true;
    }
  }

  const value = spoiled
    ? undefined
    : truthOf({ whole, fraction, magnitude, negative });
  return {
    text,
    value,
    spoiled,
    currencyName,
    grouping,
    signKind,
    magnitudeKind,
    trailingDot,
  };
}

/**
 * Digits a reader reads and this grammar must not.
 *
 * Arabic-Indic and Devanagari are digits to Unicode; the circled, enclosed
 * and dingbat forms become ASCII digits under NFKC, which is how `①250.00`
 * once read as 1,250. One of them inside a number means the number a reader
 * sees is not the number the ASCII digits spell, so the generator prices
 * nothing for the whole token.
 */
const EXOTIC_DIGITS = [
  "\u0665",
  "\u0667",
  "\u0967",
  "\u096b",
  "\u2460",
  "\u2465",
  "\u2488",
  "\u2776",
  "\u277b",
  "\u2780",
  "\u2793",
  "\u00bd",
  "\u00b2",
];

/** `1234567` as `1,234,567`: the last groups are three digits and the first
 * is whatever is left. */
function groupFrom(whole, separator) {
  const head = whole.length % 3 === 0 ? 3 : whole.length % 3;
  const groups = [whole.slice(0, head)];
  for (let at = head; at < whole.length; at += 3) {
    groups.push(whole.slice(at, at + 3));
  }
  return groups.join(separator);
}

/** A token that is not an amount, and whose oracle value is nothing at all. */
function makeHostile(random) {
  return { text: random.pick(HOSTILE), value: undefined, signKind: "none" };
}

function makeToken(random) {
  return random.chance(0.18) ? makeHostile(random) : makeAmount(random);
}

// ---------------------------------------------------------------------------
// The contexts a token appears in.
// ---------------------------------------------------------------------------

function word(random) {
  return random.pick(WORDS);
}

/** One case: the string to scan, and every value it prints. */
function makeCase(random) {
  const shape = random.int(14);
  if (shape === 6) return makeCurrencyGap(random);
  if (shape === 7) return makeTrailingDotPair(random);
  if (shape === 8) return makeListOrdinal(random);
  if (shape === 9) return makeSpoiled(random);
  if (shape === 10) return makeDecimalHeadGroups(random);
  if (shape === 11) return makePipeRow(random);
  if (shape === 12) return makeMarked(random);
  if (shape === 13) return makeSpoiled(random);
  if (shape === 0) {
    const token = makeToken(random);
    return { text: token.text, tokens: [token], single: true };
  }
  if (shape === 1) {
    const token = makeToken(random);
    return {
      text: `${word(random)} ${token.text} ${word(random)} ${word(random)}`,
      tokens: [token],
    };
  }
  if (shape === 2) {
    // A receipt column: a label, a wide gap, and the amounts.
    const left = makeToken(random);
    const right = makeToken(random);
    return {
      text: `${word(random)}${columnGap(random)}${left.text}${columnGap(random)}${right.text}`,
      tokens: [left, right],
    };
  }
  if (shape === 3) {
    // Two tokens with a separator that may or may not join them.
    const left = makeToken(random);
    const right = makeToken(random);
    const joiner = joinerFor(random, left, right);
    return { text: `${left.text}${joiner}${right.text}`, tokens: [left, right] };
  }
  if (shape === 4) {
    // A sentence with the token buried in it.
    const token = makeToken(random);
    return {
      text: `${word(random)} ${word(random)}: ${token.text}, ${word(random)} ${word(random)}.`,
      tokens: [token],
    };
  }
  // A ledger row: description, then two columns.
  const left = makeToken(random);
  const right = makeToken(random);
  const trailing = random.chance(0.5)
    ? ""
    : `${columnGap(random)}${word(random)}`;
  return {
    text: `${word(random)} ${word(random)}${columnGap(random)}${left.text}${columnGap(random)}${right.text}${trailing}`,
    tokens: [left, right],
  };
}

/**
 * `$82. 129961`, `$ 165 .00`: a currency-marked number with a one-space gap
 * at its decimal point.
 *
 * A parsed receipt prints the gap and means nothing by it, so the grammar
 * closes it up -- and the width of what it closes decides what the line
 * says. The oracle's rule here is written from the pieces and owes the
 * implementation nothing: **cents are two digits and nothing else is.** Where
 * the right-hand run is two digits the line prints one number and the
 * generator knows which. Where it is not, the line prints something this
 * generator cannot price -- 82 and 129961 as two cells, or 82.129961 as one,
 * and the text does not say -- so the only answer that cannot be a wrong
 * number is no answer at all.
 *
 * ADM-5h review found both halves: `$82. 129961.-` read as minus 82.129961
 * and `$94. 504. billion` as ninety-four and a half billion. The re-review
 * found the third: two digits are cents only when the run ends there, so
 * `$6. 25a` is not 6.25 and `€642. 73.-` is not a credit of 642.73.
 */
function makeCurrencyGap(random) {
  const mark = random.pick([
    "$",
    "\u20ac",
    "\u00a3",
    "\u00a5",
    "\u20b9",
    "USD ",
    "EUR ",
  ]);
  const whole = random.digits(1 + random.int(6));
  const right = random.digits(1 + random.int(6), true);
  // The gap before the point. Nothing after the number that could sign or
  // scale it: a trailing minus and a magnitude word are both legitimate
  // readings of their own, and a generator that printed one would be pricing
  // a token it did not mean.
  if (random.chance(0.4)) {
    const tail = random.pick(["", " due", " total", "."]);
    const text = `${mark}${whole} .${right}${tail}`;
    const value =
      right.length === 2
        ? truthOf({ whole, fraction: right, magnitude: 0, negative: false })
        : undefined;
    return { text, tokens: [{ text, value, signKind: "none" }] };
  }
  // The gap after the point, where what follows the right-hand run decides
  // as much as its width does. Two digits are cents only when the run *ends*
  // there: a letter after them makes it a box label or a magnitude, a second
  // point makes it the first half of something longer, and a sign makes it a
  // ledger's own. `$6. 25a`, `$5. 25b` and `€642. 73.-` each read as a
  // number the page does not print, and the generator prices none of them --
  // the only reading that cannot be wrong is no reading at all.
  const tail = random.pick([
    "",
    " due",
    " total",
    " DUE",
    " TOTAL",
    " million",
    "a",
    "b",
    ".",
    ".-",
    "-",
    "+",
  ]);
  // ADM-5k: and a gap then a lowercase word is prose. `We paid $500. 25
  // people` is a sentence with a full stop in it, and the rule closed the gap
  // and priced 500.25 -- a number no reader of that sentence would say. A
  // receipt cell and a sentence print the same characters, so the generator
  // prices neither reading.
  const ends =
    tail === "" || (tail.startsWith(" ") && !/^ \p{Ll}/u.test(tail));
  const text = `${mark}${whole}. ${right}${tail}`;
  const value =
    right.length === 2 && ends
      ? truthOf({ whole, fraction: right, magnitude: 0, negative: false })
      : undefined;
  return { text, tokens: [{ text, value, signKind: "none" }] };
}

/**
 * `12,345. 80`, `5. 25`: a point with no cents after it, then another
 * number, and no currency marker to say the gap is inside one number.
 *
 * ADM-5h made a trailing point a whole dollar, which is what a tax form
 * prints. That reading stops exactly here: `12,345. 80` is twelve thousand
 * three hundred and forty-five point eight to one reader and two cells to
 * another, and nothing in the characters chooses. The oracle prices neither,
 * so the finder may offer neither.
 */
function makeTrailingDotPair(random) {
  const left = random.chance(0.5)
    ? groupFrom(random.digits(4 + random.int(3)), ",")
    : random.digits(1 + random.int(4));
  const right = random.digits(1 + random.int(4), true);
  const tail = random.pick(["", " units", " due", "."]);
  return {
    text: `${left}. ${right}${tail}`,
    tokens: [{ text: `${left}. ${right}`, value: undefined, signKind: "none" }],
  };
}

/**
 * `1. Rent 500.00`, `3) Repairs 42.00`: a numbered list.
 *
 * An ordinal is a position in a list. It is not a quantity, not a price and
 * not a count, and the line prints exactly one value: the token's. ADM-5h
 * review found the finder offering the bullet, and a bullet that can be
 * stored as a money field is a number on the page nobody wrote as one.
 */
function makeListOrdinal(random) {
  const ordinal = random.digits(1 + random.int(2));
  const mark = random.pick([".", ")"]);
  const token = makeToken(random);
  return {
    text: `${ordinal}${mark} ${word(random)} ${token.text}`,
    tokens: [token],
  };
}

/**
 * An amount with a word beside it that this generator cannot price it
 * through.
 *
 * `$2.5 mil`, `45 cents`, `2.5 M`, `CR 45.00`, `12 USD 15` -- each of them is
 * a line whose number depends on a word, and the word does not settle it.
 * The oracle prices nothing, so any value at all is a counterexample. Both
 * orders, because a marker in front of a number signs it on a ledger that
 * prints its credits that way.
 */
function makeSpoiled(random) {
  const token = makeAmount(random);
  const gap = random.pick([" ", " ", random.pick(GAPS)]);
  const text = random.chance(0.75)
    ? `${word(random)} ${token.text}${gap}${random.pick(SPOILING_AFTER)}`
    : `${word(random)} ${random.pick(SPOILING_BEFORE)}${gap}${token.text}`;
  return { text, tokens: [{ text, value: undefined, signKind: "none" }] };
}

/**
 * `$12.99 100 200`: a price, then two cells of three digits.
 *
 * A single space before a run of exactly three digits is a grouping separator
 * in `$1 000 000` and a column boundary in `$123 456   789`, and the finder
 * settles it on the currency marker and the width of the gap. What it may
 * never do is let a head that already has a decimal point take them: the
 * cents belong to the head, so the groups cannot be the same number's, and
 * `$12.99 100 200` offered 12.991002 -- a number with the cents of one cell
 * and the digits of two more. The oracle prices nothing here, because a
 * priced head beside three-digit cells says one thing to one reader and
 * another to the next.
 */
function makeDecimalHeadGroups(random) {
  const mark = random.pick(["$", "\u20ac", "\u00a3", "\u00a5", "USD ", "GBP "]);
  const head = random.digits(1 + random.int(4));
  const cents = random.digits(random.pick([1, 2, 2, 3]), true);
  const groups = [];
  for (let at = 0; at < 1 + random.int(3); at += 1) {
    groups.push(random.digits(3));
  }
  const text = `${mark}${head}.${cents} ${groups.join(" ")}`;
  return { text, tokens: [{ text, value: undefined, signKind: "none" }] };
}

/**
 * `| Total | 21.60 |`: the pipe-rendered table many of this store's parsed
 * receipts print.
 *
 * A bar cannot sign or scale a number, so the row's amount reads -- that is
 * real recall and it has to survive. What a bar may not do is hide the cell
 * behind it: `| Payment | 45.00 | CR |` prints a credit, and the finder
 * offered a charge because it stopped at the bar. When a marker cell is
 * printed the oracle prices nothing; when it is not, the amount is the
 * amount.
 */
function makePipeRow(random) {
  const token = makeToken(random);
  const spoiler = random.chance(0.5) ? random.pick(SPOILING_AFTER) : "";
  const cells = [word(random), token.text];
  if (spoiler) cells.push(spoiler);
  else if (random.chance(0.4)) cells.push(word(random));
  const bar = random.pick(["|", "\u00a6", "\u2502", "\u2551"]);
  const pad = random.pick([" ", " ", "  "]);
  const text = `${bar}${pad}${cells.join(`${pad}${bar}${pad}`)}${pad}${bar}`;
  if (spoiler) {
    return { text, tokens: [{ text, value: undefined, signKind: "none" }] };
  }
  return { text, tokens: [token] };
}

/**
 * An amount with a mark pressed against a word beside it.
 *
 * `joinerFor` kept the pair from fusing by choosing a different separator,
 * and because almost every generated token both starts and ends with a
 * digit, it chose one in about ninety-six cases in a hundred -- so `/`, `'`,
 * `-`, `%`, `(` and `)` were printed a few times in a million. A word on the
 * far side cannot fuse with a number, so the mark is printed as it stands and
 * the amount keeps its value: `$9.99/mo`, `Total-42.00` and `(42.00` each
 * either read the amount or read nothing, and never a third number.
 */
function makeMarked(random) {
  const token = makeAmount(random);
  // Never a parenthesis beside a token that already prints one. A token with
  // an unbalanced parenthesis is one the generator declared unpriceable, and
  // a partner supplied from outside would balance it back into an accounting
  // minus the grammar reads correctly and the oracle no longer knows about.
  const marks = /[()]/.test(token.text)
    ? ["/", "'", "-", "%", ":", "#", "\u2019"]
    : ["/", "'", "-", "%", "(", ")", ":", "#", "\u2019"];
  const mark = random.pick(marks);
  const other = word(random);
  const text = random.chance(0.5)
    ? `${other} ${token.text}${mark}${other}`
    : `${other}${mark}${token.text} ${other}`;
  // The mark can carry a sign or a scale of its own -- a parenthesis is an
  // accounting minus, a percent re-measures, a dash between two things is a
  // sign to one reader and a range to another -- and the generator prices
  // none of those. The rest group, time or identify, and every one of them
  // needs digits on both sides to do it: with a word on the far side they
  // cannot touch the number, so the amount is whatever it printed.
  const priced = ":#/'\u2019".includes(mark);
  return {
    text,
    tokens: [
      priced ? token : { text, value: undefined, signKind: "none" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Recall. A gate that refuses everything offers no wrong number, so the
// invariants above pass a grammar that is useless. These shapes are the
// owner's ordinary documents -- a pipe-rendered table, a column of amounts, a
// form's lettered rows, a place name beside a figure, a labelled total -- and
// on them the finder must offer **every** printed amount with its exact
// value. The first round of ADM-5k lost about a third of the correct offers
// on some of them and no invariant here noticed, which is what these are for.
// ---------------------------------------------------------------------------

/**
 * One amount with nothing ambiguous about it.
 *
 * Deliberately narrower than {@link makeAmount}: no magnitude, no flag, no
 * space grouping, no zero-width character, no damage. Every shape here is one
 * this grammar is documented to read, so "the finder offered it" is a fair
 * demand rather than a guess about what the page meant.
 */
function makePlainAmount(random) {
  const whole = random.digits(1 + random.int(7));
  const fraction = random.chance(0.6) ? random.digits(2, true) : "";
  const grouped =
    whole.length > 3 && random.chance(0.6) ? groupFrom(whole, ",") : whole;
  const digits = fraction ? `${grouped}.${fraction}` : grouped;
  // No euro sign. A euro amount refuses a single comma group outright --
  // `12,345 €` is twelve thousand to most of the people who print it and
  // twelve and a bit to the rest -- and that locale rule is documented
  // behaviour rather than a shape this grammar is meant to read.
  const marker = random.pick(["", "", "$", "$ ", "\u00a3", "\u00a3 "]);
  const trailing = marker === "" && random.chance(0.25) ? " USD" : "";
  const body = `${marker}${digits}${trailing}`;
  const sign = random.pick(["none", "none", "none", "minus", "parens", "cr"]);
  let text = body;
  let negative = false;
  if (sign === "minus") {
    negative = true;
    text = `-${body}`;
  } else if (sign === "parens") {
    negative = true;
    text = `(${body})`;
  } else if (sign === "cr") {
    negative = true;
    text = `${body} CR`;
  }
  return { text, value: truthOf({ whole, fraction, magnitude: 0, negative }) };
}

/** Place names and company names, which are two Capitalized words and never a
 * scale however they are spelled. */
const NAMES_AFTER = [
  "Mill Creek",
  "Grand Rapids",
  "Bill Jenkins",
  "Mill Lane",
  "Grand Avenue",
  "Bill Smith",
];

/** The same, opening with a word this grammar reads as a magnitude. These may
 * only stand in *front* of an amount: after one, a Capitalized magnitude is a
 * place to one reader and a scale to another, and the finder refuses both. */
const NAMES_BEFORE = [
  "Thousand Oaks",
  "Lakh Street",
  "Million Dollar Way",
  "Crore Road",
];

/** A form's row letters. A K-1 prints K and M, a W-2 prints D. */
const ROW_LETTERS = ["A", "B", "C", "D", "K", "L", "M", "N", "V", "Z"];

/** One recall case: the text, the values it prints, and the family it belongs
 * to. `lines` means the text is a page and each of its lines is scanned with
 * the wrap tokens `pageLines` gives it. */
function makeRecallCase(random) {
  const family = random.int(5);
  if (family === 0) return makePipeRecall(random);
  if (family === 1) return makeColumnRecall(random);
  if (family === 2) return makeLetteredRecall(random);
  if (family === 3) return makeNameRecall(random);
  return makeLabelRecall(random);
}

/** `| Total | 1,234.56 | (5.00) | $150.00 |`: two to six amount cells, with
 * label cells among them. */
function makePipeRecall(random) {
  const count = 2 + random.int(5);
  const cells = [];
  const values = [];
  if (random.chance(0.8)) cells.push(word(random));
  for (let at = 0; at < count; at += 1) {
    const amount = makePlainAmount(random);
    cells.push(amount.text);
    values.push(amount.value);
    if (random.chance(0.2)) cells.push(word(random));
  }
  const bar = random.pick(["|", "\u00a6", "\u2502", "\u2551"]);
  const pad = random.pick([" ", " ", "  "]);
  return {
    family: "pipe row",
    text: `${bar}${pad}${cells.join(`${pad}${bar}${pad}`)}${pad}${bar}`,
    values,
  };
}

/** A column of amounts, one to a line, the shape a till receipt parses to. */
function makeColumnRecall(random) {
  const count = 2 + random.int(4);
  const lines = [];
  const values = [];
  if (random.chance(0.5)) lines.push(word(random));
  for (let at = 0; at < count; at += 1) {
    const amount = makePlainAmount(random);
    lines.push(
      random.chance(0.4) ? `${word(random)} ${amount.text}` : amount.text,
    );
    values.push(amount.value);
  }
  if (random.chance(0.4)) lines.push(`${word(random)} ${word(random)}`);
  return { family: "amount column", lines: lines.join("\n"), values };
}

/** `K Net rental real estate income 12,345.56`: a form's lettered rows, one
 * under the next, which is what a K-1 and a W-2 both print. */
function makeLetteredRecall(random) {
  const count = 2 + random.int(3);
  const lines = [];
  const values = [];
  for (let at = 0; at < count; at += 1) {
    const amount = makePlainAmount(random);
    const letter = random.pick(ROW_LETTERS);
    lines.push(
      `${letter} ${word(random)} ${word(random)} ${word(random)} ${amount.text}`,
    );
    values.push(amount.value);
  }
  return { family: "lettered row", lines: lines.join("\n"), values };
}

/** A place or a company beside a figure, on either side of it. */
function makeNameRecall(random) {
  const amount = makePlainAmount(random);
  const text = random.chance(0.5)
    ? `${amount.text} ${random.pick(NAMES_AFTER)}`
    : `${random.pick([...NAMES_AFTER, ...NAMES_BEFORE])} ${amount.text}`;
  return { family: "name neighbour", text, values: [amount.value] };
}

/** `Subtotal 1,234.56`: the plainest line a receipt prints. */
function makeLabelRecall(random) {
  const amount = makePlainAmount(random);
  const shape = random.int(4);
  const text =
    shape === 0
      ? `${word(random)} ${amount.text}`
      : shape === 1
        ? `${word(random)}: ${amount.text}`
        : shape === 2
          ? `${word(random)} ${word(random)}${columnGap(random)}${amount.text}`
          : `${amount.text} ${word(random)}`;
  return { family: "plain label", text, values: [amount.value] };
}

/**
 * The gap between two cells of a column, which is never one space wide.
 *
 * A single space between two digit runs is a grouping separator as readily as
 * a column boundary -- `$1 234 567` and `$5 250` are the same shape and two
 * different readings -- so a generator that printed one would be printing a
 * token whose value it does not know. The spec table owns those rows by hand;
 * everything wider is unambiguously two cells and belongs here.
 */
function columnGap(random) {
  return random.pick(WIDE_GAPS);
}

/**
 * Gaps that are still wider than one space after NFKC.
 *
 * The no-break, em, narrow and ideographic spaces all fold to a single
 * U+0020, so a column printed with one of them is character for character a
 * grouping separator: `CHF 3 376 853` beside `375` is `CHF 3 376 853 375`,
 * which is one amount to any reader and to the grammar. The oracle cannot
 * price that, so the generator does not print it.
 */
const WIDE_GAPS = GAPS.filter((gap) => gap.normalize("NFKC") !== " ");

/**
 * A separator between two tokens, chosen so the pair cannot fuse into a third
 * printed number.
 *
 * `1, 234` is one thousand two hundred and thirty-four and also two
 * references; `10. 80` is ten point eight and also two numbers. Which one a
 * page means is exactly what the text does not say, so the oracle cannot
 * price the pair and the generator does not print it. Those joins are
 * asserted by hand in `extractionGate.test.mjs`, where each row carries the
 * reading it was given and why.
 */
function joinerFor(random, left, right) {
  // A parenthesis joiner is dropped when either token prints an unbalanced
  // one of its own, for the reason {@link makeMarked} gives: the pair would
  // read as an accounting minus the oracle does not know it printed.
  const safeParens = !unbalanced(left.text) && !unbalanced(right.text);
  const joiner = random.pick([
    " ",
    ", ",
    ". ",
    ": ",
    "/",
    "'",
    "-",
    " and ",
    " | ",
    "\t",
    "",
    "%",
    ...(safeParens ? [" (", ") "] : ["  ", "\t"]),
  ]);
  const before = visible(left.text);
  const after = visible(right.text);
  // A pair that would fuse keeps its joiner and gets a column-wide gap on the
  // side that fuses, rather than a different joiner altogether. Almost every
  // generated token both starts and ends with a digit, so replacing the
  // joiner printed `/`, `'`, `-`, `%`, `(` and `)` in about four cases in a
  // hundred and the six of them together in a few per million. A wide gap is
  // two cells to any reader, so the two tokens keep their values and the mark
  // between them is still printed.
  const leftFuses = FUSING_EDGE.test(before[before.length - 1] ?? "");
  const rightFuses = FUSING_EDGE.test(after[0] ?? "");
  if (!leftFuses || !rightFuses) return joiner;
  if (joiner.trim() === "") return random.pick(WIDE_GAPS);
  return `${random.pick(WIDE_GAPS)}${joiner.trim()}${random.pick(WIDE_GAPS)}`;
}

/** Whether a token's parentheses do not pair up, which is the damage
 * {@link makeAmount} prints deliberately and no context may undo. */
function unbalanced(text) {
  let depth = 0;
  for (const unit of text) {
    if (unit === "(") depth += 1;
    else if (unit === ")") depth -= 1;
    if (depth < 0) return true;
  }
  return depth !== 0;
}

/** The token as a reader sees it: the zero-width characters are not an edge,
 * because they are not anything. */
function visible(text) {
  return text.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "");
}

/** Any character a printed amount can carry at its edge. Two tokens that
 * touch through one of these are one token to a reader, whatever the
 * generator meant, and the oracle would be pricing a fiction. */
const FUSING_EDGE =
  /[\p{L}\d.,()%$\u00a3\u00a5\u20ac\u20b9\u20a9+'#:/\u2010-\u2015\u2212\u02d7\ufe58\ufe63\uff0d-]/u;

// ---------------------------------------------------------------------------
// The invariants.
// ---------------------------------------------------------------------------

/** Why one offered value is wrong, in the words of invariant (c), or null. */
function faultOf(offered, truths) {
  if (truths.has(offered)) return null;
  const negated = offered.startsWith("-") ? offered.slice(1) : `-${offered}`;
  if (truths.has(negated)) return "wrong sign";
  for (let places = -12; places <= 12; places += 1) {
    if (places === 0) continue;
    if (truths.has(shiftedBy(offered, places))) return `wrong by 10^${places}`;
  }
  for (const truth of truths) {
    const bare = truth.replace(/^-/, "").replace(".", "");
    const seen = offered.replace(/^-/, "").replace(".", "");
    if (bare.startsWith(seen) || bare.endsWith(seen)) {
      return "a fragment of a printed token";
    }
  }
  return "a number the text does not print";
}

function check(report, label, text, tokens, options) {
  const truths = new Set();
  for (const token of tokens) {
    if (token.value !== undefined) truths.add(token.value);
  }
  let offered;
  try {
    offered = amountsInText(text, options);
  } catch (error) {
    report.push({ label, text, failure: `threw ${String(error)}` });
    return;
  }
  for (const value of offered) {
    const fault = faultOf(value, truths);
    if (fault) {
      report.push({
        label,
        text,
        offered,
        truths: [...truths],
        failure: `${value} is ${fault}`,
      });
      return;
    }
  }
}

/**
 * The recall invariant: every printed value is offered, with its exact sign
 * and scale.
 *
 * The mirror of `check`, and the half the four wrong-number invariants cannot
 * see. A missing value is recorded against its family so a report says which
 * shape the round cost, not merely that something moved.
 */
function checkRecall(report, label, shaped, tally) {
  const seen = [];
  const texts = shaped.lines === undefined ? [shaped.text] : undefined;
  let offered = [];
  try {
    if (texts) {
      offered = amountsInText(shaped.text);
    } else {
      for (const line of pageLines(shaped.lines)) {
        offered = offered.concat(
          amountsInText(line.text, {
            cutStart: line.cutStart,
            cutEnd: line.cutEnd,
            ...(line.previousToken === undefined
              ? {}
              : { previousToken: line.previousToken }),
            ...(line.nextToken === undefined
              ? {}
              : { nextToken: line.nextToken }),
          }),
        );
      }
    }
  } catch (error) {
    report.push({ label, text: shaped.text ?? shaped.lines, failure: `threw ${String(error)}` });
    return;
  }
  const pool = [...offered];
  const missing = [];
  for (const value of shaped.values) {
    const at = pool.indexOf(value);
    if (at < 0) missing.push(value);
    else {
      pool.splice(at, 1);
      seen.push(value);
    }
  }
  const stat = tally.get(shaped.family) ?? { printed: 0, offered: 0, cases: 0 };
  stat.printed += shaped.values.length;
  stat.offered += seen.length;
  stat.cases += 1;
  tally.set(shaped.family, stat);
  if (missing.length > 0) {
    report.push({
      label,
      family: shaped.family,
      text: shaped.text ?? shaped.lines,
      offered,
      failure: `did not offer ${missing.join(", ")}`,
    });
  }
}

/** The long-line context. A cut edge is unknown, so no piece may offer a
 * value the whole line does not print either. */
function checkSplit(report, random, tokens) {
  const filler = `${word(random)} `.repeat(20 + random.int(40));
  const joined = tokens
    .map((token) => token.text)
    .join(`${columnGap(random)}${word(random)}${columnGap(random)}`);
  const tail = random.chance(0.5) ? "" : ` ${word(random)}`;
  const line = `${filler}${joined}${tail}`;
  const pieces = pageLines(line);
  const rebuilt = pieces.map((piece) => piece.text).join("");
  if (rebuilt !== line) {
    report.push({ label: "split", text: line, failure: "pieces do not cover the line" });
    return;
  }
  for (const piece of pieces) {
    if (line.slice(piece.start, piece.end) !== piece.text) {
      report.push({ label: "split", text: line, failure: "a piece's offsets moved" });
      return;
    }
    check(report, "split piece", piece.text, tokens, {
      cutStart: piece.cutStart,
      cutEnd: piece.cutEnd,
    });
  }
}

/**
 * The wrap. A printed sentence runs past the right-hand margin and carries
 * its next word onto the line below, and a line break is not a full stop:
 * `raised $2.5` with `million` under it prints two and a half million, and
 * the finder offered two and a half. A prefix-credit ledger breaks the other
 * way, with `CR` above its amount.
 *
 * Each line is scanned as the gate scans it -- with the wrap tokens
 * `pageLines` carries -- and the whole page's values are the truths, because
 * a line may print one number and the page beside it another. A spoiled wrap
 * prices nothing at all: what the two lines print together is exactly what
 * the break does not say.
 */
function checkWrapped(report, random, seed, at) {
  const token = makeAmount(random);
  const spoiled = random.chance(0.55);
  const tailWord = spoiled
    ? random.pick([
        ...SPOILING_AFTER,
        ...MAGNITUDE_WORDS.map(([one]) => one),
      ])
    : word(random);
  const head = `${word(random)} ${word(random)} ${token.text}`;
  // A single letter is a marker only where it stands alone. A form labels its
  // rows with exactly these letters -- a K-1 prints `K Net rental real estate
  // income`, a W-2 prints code `D` -- and a letter with a word after it is a
  // row label rather than a wrapped magnitude, which is what
  // `makeLetteredRecall` asserts from the other side.
  const alone = spoiled && tailWord.length === 1;
  const rest = alone
    ? tailWord
    : `${tailWord} ${word(random)} ${word(random)}`;
  const page = `${head}\n${rest}`;
  const truths = spoiled ? [] : [token];
  for (const line of pageLines(page)) {
    check(report, `seed ${seed} case ${at} wrap`, line.text, truths, {
      cutStart: line.cutStart,
      cutEnd: line.cutEnd,
      ...(line.previousToken === undefined
        ? {}
        : { previousToken: line.previousToken }),
      ...(line.nextToken === undefined ? {} : { nextToken: line.nextToken }),
    });
  }
  // And the mirror: a marker at the end of one line, its amount at the start
  // of the next.
  const above = `${word(random)} ${random.pick(SPOILING_BEFORE)}`;
  const below = `${token.text} ${word(random)}`;
  for (const line of pageLines(`${above}\n${below}`)) {
    check(report, `seed ${seed} case ${at} wrap back`, line.text, [], {
      cutStart: line.cutStart,
      cutEnd: line.cutEnd,
      ...(line.previousToken === undefined
        ? {}
        : { previousToken: line.previousToken }),
      ...(line.nextToken === undefined ? {} : { nextToken: line.nextToken }),
    });
  }
}

function run(seed, cases, tally = new Map()) {
  const random = makeRandom(seed);
  const report = [];
  for (let at = 0; at < cases && report.length < 8; at += 1) {
    if (at % 3 === 0) {
      checkRecall(
        report,
        `seed ${seed} case ${at} recall`,
        makeRecallCase(random),
        tally,
      );
    }
    const shaped = makeCase(random);
    check(report, `seed ${seed} case ${at}`, shaped.text, shaped.tokens);
    if (shaped.single && shaped.tokens[0].signKind !== "credit" &&
        shaped.tokens[0].signKind !== "debit") {
      // (b) One printed token: the finder offers what the scanner reads, or
      // nothing. A third answer means the two have drifted apart again.
      //
      // Against the token with its gap runs collapsed, because that is the
      // one difference the finder is allowed to have: it owns where a token
      // starts and ends on a *line*, and a line puts runs of spaces where a
      // value has one. `CR` and `DR` are excluded for the same reason from
      // the other side -- they are a sign the line prints beside the number
      // and the scanner never sees them.
      const collapsed = shaped.text
        .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "")
        .replace(/\s+/g, " ");
      const scanned = parseAmount(collapsed);
      const offered = amountsInText(shaped.text);
      const allowed =
        offered.length === 0 ||
        (offered.length === 1 &&
          scanned !== undefined &&
          offered[0] === scanned);
      if (!allowed) {
        report.push({
          label: `seed ${seed} case ${at}`,
          text: shaped.text,
          offered,
          failure: `the scanner reads ${String(scanned)} for ${JSON.stringify(collapsed)}`,
        });
      }
    }
    if (at % 8 === 0) {
      checkSplit(report, random, shaped.tokens);
    }
    if (at % 5 === 0) {
      checkWrapped(report, random, seed, at);
    }
  }
  return { report, tally };
}

const CASES = Number(process.env.KITH_AMOUNT_FUZZ_CASES ?? 50000);
const SEEDS = (process.env.KITH_AMOUNT_FUZZ_SEEDS ?? "20260920")
  .split(",")
  .map((seed) => Number(seed.trim()))
  .filter((seed) => Number.isFinite(seed));

test("no generated line ever offers a number it does not print", () => {
  const tally = new Map();
  for (const seed of SEEDS) {
    const { report } = run(seed, CASES, tally);
    assert.deepEqual(
      report,
      [],
      `seed ${seed}: ${report.length} wrong number(s) or missing offer(s)\n` +
        report.map((entry) => JSON.stringify(entry)).join("\n"),
    );
  }
  // And the other half of the claim. A gate that refuses everything offers no
  // wrong number, so recall is asserted here rather than measured elsewhere:
  // on these plain shapes every printed amount has to come back. The families
  // are listed so a failure names the document shape that broke.
  const families = [
    "pipe row",
    "amount column",
    "lettered row",
    "name neighbour",
    "plain label",
  ];
  for (const family of families) {
    const stat = tally.get(family);
    assert.ok(stat && stat.cases > 0, `${family}: nothing was generated`);
    assert.equal(
      stat.offered,
      stat.printed,
      `${family}: offered ${stat.offered} of ${stat.printed} printed amounts`,
    );
  }
  if (process.env.KITH_AMOUNT_FUZZ_RECALL === "1") {
    for (const [family, stat] of tally) {
      const rate = ((100 * stat.offered) / stat.printed).toFixed(2);
      console.log(
        `recall ${family}: ${stat.offered}/${stat.printed} (${rate}%) over ${stat.cases} cases`,
      );
    }
  }
});

test("the oracle is exact, and would notice if it were not", () => {
  // The oracle's own arithmetic, checked against hand-written answers. A
  // silent oracle is worse than no oracle: it would pass everything.
  assert.equal(
    truthOf({ whole: "2", fraction: "5", magnitude: 6, negative: false }),
    "2500000",
  );
  assert.equal(
    truthOf({ whole: "1", fraction: "2345", magnitude: 6, negative: false }),
    "1234500",
  );
  assert.equal(
    truthOf({ whole: "1234", fraction: "56", magnitude: 0, negative: true }),
    "-1234.56",
  );
  assert.equal(
    truthOf({ whole: "0", fraction: "00", magnitude: 0, negative: true }),
    "0",
  );
  assert.equal(
    truthOf({ whole: "13", fraction: "20", magnitude: 0, negative: false }),
    "13.2",
  );
  assert.equal(
    truthOf({ whole: "3", fraction: "4", magnitude: 9, negative: false }),
    "3400000000",
  );
  assert.equal(shiftedBy("2.5", 6), "2500000");
  assert.equal(shiftedBy("2500000", -6), "2.5");
  assert.equal(groupFrom("1234567", ","), "1,234,567");
  assert.equal(groupFrom("123456", " "), "123 456");
  // And the fault reporter names the fault rather than shrugging.
  assert.equal(faultOf("2.5", new Set(["2500000"])), "wrong by 10^6");
  assert.equal(faultOf("42", new Set(["-42"])), "wrong sign");
  assert.equal(faultOf("42", new Set(["42"])), null);
  assert.equal(faultOf("234", new Set(["1234"])), "a fragment of a printed token");
});
