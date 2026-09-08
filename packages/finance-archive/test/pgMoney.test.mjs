// Money under Postgres NUMERIC, with no database required.
//
// Everything here is pure logic on purpose: input validation, driver decoding
// and the deduplication preimage are the three places this port can go
// quietly wrong, and none of them needs a server to prove.

import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  archiveDatabaseUrl,
  contentKey,
  contentKeyV2,
  decodesAsText,
  fromNumericText,
  NUMERIC_MAX_DIGITS,
  NUMERIC_MAX_SCALE,
  PINNED_TEXT_OIDS,
  ROW_HASH_DOMAIN,
  ROW_HASH_DOMAIN_V2,
  rowHash,
  rowHashV2,
  toNumericText,
  fromMinorUnits,
  toMinorUnits,
} from "../dist/index.js";

// --- input validation ------------------------------------------------------

test("a stated decimal is validated as text and stored in one spelling", () => {
  assert.equal(toNumericText("+1.50"), "1.5");
  assert.equal(toNumericText("007"), "7");
  assert.equal(toNumericText(".5"), "0.5");
  assert.equal(toNumericText("-0.000"), "0");
  assert.equal(toNumericText("1.00"), "1");
  assert.equal(toNumericText("-12.34"), "-12.34");
});

test("a JavaScript number is refused rather than stringified", () => {
  // By the time a money value is a number the digits are already gone, so
  // this is the storage-class CHECK the SQLite schema used to carry, moved to
  // the only place that can still see the difference.
  assert.throws(() => toNumericText(0.1 + 0.2), TypeError);
  assert.throws(() => toNumericText(1234), TypeError);
  assert.throws(() => toNumericText(null), TypeError);
});

test("non-finite and exponent spellings are refused", () => {
  for (const bad of ["NaN", "nan", "Infinity", "-Infinity", "1e5", "1E-5"]) {
    assert.throws(() => toNumericText(bad), { name: "TypeError" });
  }
});

test("NUMERIC stores faithfully what was already damaged, so validation is not a precision guarantee", () => {
  // 0.1 + 0.2 stringified is a legal decimal. NUMERIC would store it exactly,
  // damage included. Nothing downstream may assume otherwise.
  assert.equal(toNumericText(String(0.1 + 0.2)), "0.30000000000000004");
});

test("a value past the typed boundary is an explicit rejection, never a rounding", () => {
  const tooPrecise = `0.${"1".repeat(NUMERIC_MAX_SCALE + 1)}`;
  assert.throws(() => toNumericText(tooPrecise), RangeError);
  assert.equal(
    toNumericText(`0.${"1".repeat(NUMERIC_MAX_SCALE)}`),
    `0.${"1".repeat(NUMERIC_MAX_SCALE)}`,
  );

  const tooWide = "9".repeat(NUMERIC_MAX_DIGITS + 1);
  assert.throws(() => toNumericText(tooWide), RangeError);
  assert.equal(
    toNumericText("9".repeat(NUMERIC_MAX_DIGITS)),
    "9".repeat(NUMERIC_MAX_DIGITS),
  );

  // Significant digits count across the point, not per side.
  const split = `${"9".repeat(NUMERIC_MAX_DIGITS - NUMERIC_MAX_SCALE + 1)}.${"9".repeat(NUMERIC_MAX_SCALE)}`;
  assert.throws(() => toNumericText(split), RangeError);
});

// --- driver decoding -------------------------------------------------------

test("NUMERIC decoding is pinned to text, so it can never arrive as a float", () => {
  for (const oid of PINNED_TEXT_OIDS) {
    assert.equal(decodesAsText(oid), true);
  }
  const decode = pg.types.getTypeParser(pg.types.builtins.NUMERIC);
  // A parser that went through parseFloat would return a number here, and
  // would have already lost these digits.
  for (const wire of [
    "0.30000000000000004",
    "9007199254740993",
    "12345678901234567890.123456789012345678",
    "1.00",
    "-0.000000000000000001",
  ]) {
    const decoded = decode(wire);
    assert.equal(typeof decoded, "string");
    assert.equal(decoded, wire);
  }
});

test("INT8 decoding is pinned too, because counts cross 2^53", () => {
  const decode = pg.types.getTypeParser(pg.types.builtins.INT8);
  assert.equal(decode("9007199254740993"), "9007199254740993");
  assert.equal(typeof decode("1"), "string");
});

test("DATE decoding is pinned too, because a Date object shifts the day", () => {
  // The driver's default builds a JavaScript Date at local midnight, so
  // reading the day back out of one lands on the previous day west of UTC.
  // Every date in this archive is ISO text end to end: it is what the gates
  // pair periods on and what a locator cites.
  const decode = pg.types.getTypeParser(pg.types.builtins.DATE);
  assert.equal(decode("2026-03-01"), "2026-03-01");
  assert.equal(typeof decode("2026-03-01"), "string");
});

test("a NUMERIC that came back as a number is a hard error, not something to coerce", () => {
  assert.throws(() => fromNumericText(0.3), TypeError);
  assert.throws(() => fromNumericText(1234), TypeError);
});

test("Postgres's own NaN for NUMERIC is refused on the way out", () => {
  assert.throws(() => fromNumericText("NaN"), RangeError);
  assert.equal(fromNumericText("12.3400"), "12.34");
  assert.equal(fromNumericText("0.30000000000000004"), "0.30000000000000004");
});

test("the connection string has no default and names itself when missing", () => {
  assert.throws(
    () => archiveDatabaseUrl({}),
    /FINANCE_ARCHIVE_DATABASE_URL is not set/,
  );
  assert.equal(
    archiveDatabaseUrl({ FINANCE_ARCHIVE_DATABASE_URL: "postgres://x/y" }),
    "postgres://x/y",
  );
});

// --- the versioned deduplication preimage ----------------------------------

const BASE = {
  accountId: "acct-synthetic-1",
  processDate: "2026-03-04",
  activityType: "Dividend",
  description: "quarterly distribution",
  quantity: null,
  currency: "USD",
  occurrence: 1,
};

test("the preimage version is bumped, not quietly changed", () => {
  assert.equal(ROW_HASH_DOMAIN, "kith-finance-row:v1\0");
  assert.equal(ROW_HASH_DOMAIN_V2, "kith-finance-row:v2\0");
  // The same logical row hashes differently under the two versions, so a v1
  // hash is never mistaken for a v2 one.
  assert.notEqual(
    rowHash({ ...BASE, amount: 1234n }),
    rowHashV2({ ...BASE, amount: "12.34" }),
  );
});

test("1, 1.0 and 1.00 are one identity under the decimal representation", () => {
  // This is the defect that makes an archive double-count: three spellings of
  // one amount acquiring three identities.
  const hashes = new Set(
    ["1", "1.0", "1.00", "+1", "01.000"].map((amount) =>
      rowHashV2({ ...BASE, amount }),
    ),
  );
  assert.equal(hashes.size, 1);
  // And genuinely different amounts stay different.
  assert.equal(
    new Set(
      ["1", "10", "0.1", "-1"].map((a) => rowHashV2({ ...BASE, amount: a })),
    ).size,
    4,
  );
});

test("minor units map to decimal without changing which rows are the same row", () => {
  // A synthetic row set covering a zero-exponent currency (JPY), a
  // three-place one (KWD), repeated content at different ordinals, an
  // ambiguous amount under review, and three spellings of one amount.
  const rows = [
    { currency: "USD", amount: "12.34", occurrence: 1 },
    { currency: "USD", amount: "12.340", occurrence: 1 },
    { currency: "USD", amount: "12.34", occurrence: 2 },
    { currency: "USD", amount: "0", occurrence: 1 },
    { currency: "USD", amount: "-0.00", occurrence: 1 },
    { currency: "USD", amount: "-12.34", occurrence: 1 },
    { currency: "JPY", amount: "1250", occurrence: 1 },
    { currency: "JPY", amount: "1250.0", occurrence: 1 },
    { currency: "JPY", amount: "1250", occurrence: 2 },
    { currency: "KWD", amount: "1.234", occurrence: 1 },
    { currency: "KWD", amount: "1.2340", occurrence: 1 },
    { currency: "USD", amount: null, occurrence: 1 },
    { currency: "USD", amount: null, occurrence: 2 },
  ].map((row) => ({ ...BASE, ...row }));

  // Under the old representation the amount field is minor units; under the
  // new one it is the stated decimal. fromMinorUnits is the mapping between
  // them, and it is what the port applies.
  const classesV1 = new Map();
  const classesV2 = new Map();
  rows.forEach((row, index) => {
    const minor =
      row.amount === null ? null : toMinorUnits(row.amount, row.currency);
    const v1 = rowHash({ ...row, amount: minor });
    const converted =
      minor === null ? null : fromMinorUnits(minor, row.currency);
    const v2 = rowHashV2({ ...row, amount: converted });
    classesV1.set(v1, [...(classesV1.get(v1) ?? []), index]);
    classesV2.set(v2, [...(classesV2.get(v2) ?? []), index]);
  });

  const partition = (classes) =>
    JSON.stringify([...classes.values()].map((g) => g.join(",")).sort());

  // The identities are the same set of rows before and after the move: same
  // number of distinct hashes, same rows collapsing together.
  assert.equal(classesV1.size, classesV2.size);
  assert.equal(partition(classesV1), partition(classesV2));
  // And the set really does collapse spellings rather than being all
  // singletons, which would make the assertion above vacuous.
  assert.ok(classesV2.size < rows.length);
  assert.equal(classesV2.size, 9);
});

test("the content key and the hash agree about what the same content is", () => {
  // The occurrence ordinal is counted over the content key and then hashed
  // into the row hash. If the two disagreed about which rows are the same
  // content -- one version's key with the other version's hash, say -- the
  // ordinals would be assigned against one partition and hashed against
  // another, and deduplication would break silently. So the key's partition
  // is asserted to be the hash's partition, over the same synthetic row set
  // the identity test above uses.
  const rows = [
    { currency: "USD", amount: "12.34" },
    { currency: "USD", amount: "12.340" },
    { currency: "USD", amount: "0" },
    { currency: "USD", amount: "-0.00" },
    { currency: "JPY", amount: "1250" },
    { currency: "KWD", amount: "1.2340" },
    { currency: "USD", amount: null },
  ].map((row) => ({ ...BASE, ...row }));

  const group = (keyOf) => {
    const classes = new Map();
    rows.forEach((row, index) => {
      const key = keyOf(row);
      classes.set(key, [...(classes.get(key) ?? []), index]);
    });
    return JSON.stringify([...classes.values()].map((g) => g.join(",")).sort());
  };

  const byKey = group((row) => contentKeyV2(row));
  const byHash = group((row) => rowHashV2(row));
  assert.equal(byKey, byHash);
  // And it is not the trivial all-singletons partition: two spellings of one
  // amount and two spellings of zero each collapse to one class.
  assert.equal(new Set(rows.map((row) => contentKeyV2(row))).size, 5);

  // The v1 pair partitions the same rows the same way, which is what makes
  // the ordinals a row was assigned under v1 still the ordinals it gets
  // under v2.
  const v1 = rows.map((row) => ({
    ...row,
    amount: row.amount === null ? null : toMinorUnits(row.amount, row.currency),
  }));
  const groupV1 = (keyOf) => {
    const classes = new Map();
    v1.forEach((row, index) => {
      const key = keyOf(row);
      classes.set(key, [...(classes.get(key) ?? []), index]);
    });
    return JSON.stringify([...classes.values()].map((g) => g.join(",")).sort());
  };
  assert.equal(
    groupV1((row) => contentKey(row)),
    byKey,
  );
});

test("the occurrence ordinal survives the version bump, validation included", () => {
  const first = rowHashV2({ ...BASE, amount: "12.34", occurrence: 1 });
  const second = rowHashV2({ ...BASE, amount: "12.34", occurrence: 2 });
  assert.notEqual(first, second);
  for (const bad of [0, -1, 1.5, undefined, null]) {
    assert.throws(
      () => rowHashV2({ ...BASE, amount: "12.34", occurrence: bad }),
      RangeError,
    );
  }
});

test("an amount is canonicalized and range-checked before it is hashed", () => {
  assert.throws(() => rowHashV2({ ...BASE, amount: 12.34 }), TypeError);
  assert.throws(() => rowHashV2({ ...BASE, amount: "NaN" }), TypeError);
  assert.throws(
    () =>
      rowHashV2({ ...BASE, amount: `0.${"1".repeat(NUMERIC_MAX_SCALE + 1)}` }),
    RangeError,
  );
});
