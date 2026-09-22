// Synthetic-fixture unit tests for title.ts's `buildTitle`: a detected kind
// plus a detected tax year composes `<kind label> <taxYear> · <filename>`
// (extension kept); with no tax year, the title stays the filename with its
// extension stripped, exactly as before this module existed.

import assert from "node:assert/strict";
import test from "node:test";

import { buildTitle } from "../dist/title.js";

test("buildTitle composes '<kind label> <taxYear> · <filename>' when a tax year is detected", () => {
  assert.equal(
    buildTitle("2018-1040.pdf", "tax_return", 2018),
    "Tax return 2018 · 2018-1040.pdf",
  );
  assert.equal(
    buildTitle("Taxes/K-1s/acme-partners.pdf", "k1", 2021),
    "K-1 2021 · acme-partners.pdf",
  );
  assert.equal(
    buildTitle("W-2 2019.pdf", "tax_support", 2019),
    "Tax support 2019 · W-2 2019.pdf",
  );
  assert.equal(
    buildTitle("statement.pdf", "statement", 2020),
    "Statement 2020 · statement.pdf",
  );
  assert.equal(
    buildTitle("note.pdf", "other", 2015),
    "Other 2015 · note.pdf",
  );
});

test("buildTitle keeps the filename's extension in the composed form", () => {
  assert.match(buildTitle("Statements/2021/january.pdf", "statement", 2021), /january\.pdf$/);
});

test("buildTitle falls back to the extension-stripped filename with no tax year", () => {
  assert.equal(buildTitle("statement.pdf", "statement", undefined), "statement");
  assert.equal(buildTitle("Statements/2021/january.pdf", "other", undefined), "january");
  assert.equal(buildTitle("note", "other", undefined), "note");
});
