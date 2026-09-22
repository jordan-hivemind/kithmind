// Synthetic-fixture unit tests for classify.ts: every pattern named in the
// depth-policy plan gets at least one filename-only and one page1-text-only
// case (the fields that feed `decideDepth`), plus the tax-year phrasing and
// bare-filename-year patterns.

import assert from "node:assert/strict";
import test from "node:test";

import { detectKind, detectTaxYear } from "../dist/classify.js";

test("detectKind: tax_return patterns", () => {
  assert.equal(detectKind("2022 Form 1040.pdf", ""), "tax_return");
  assert.equal(detectKind("return.pdf", "Form 1040-SR\nDepartment of the Treasury"), "tax_return");
  assert.equal(detectKind("return.pdf", "Form 1040-NR"), "tax_return");
  assert.equal(detectKind("return.pdf", "U.S. Individual Income Tax Return"), "tax_return");
  assert.equal(detectKind("ca-return.pdf", "California Resident Income Tax Return\nForm 540"), "tax_return");
  assert.equal(detectKind("ny-return.pdf", "Form IT-201 Resident Income Tax Return"), "tax_return");
  assert.equal(detectKind("complete package.pdf", "Your 2021 Tax Return"), "tax_return");
  assert.equal(detectKind("package.pdf", "2021 Individual Tax Return"), "tax_return");
});

test("detectKind: k1 patterns", () => {
  assert.equal(detectKind("k1.pdf", "Schedule K-1"), "k1");
  assert.equal(detectKind("k-1.pdf", "Schedule K1 (Form 1065)"), "k1");
  assert.equal(detectKind("statement.pdf", "Partner's Share of Income, Form 1065 Schedule K-1"), "k1");
  assert.equal(detectKind("estate-k1.pdf", "Form 1041 Schedule K-1 Beneficiary's Share"), "k1");
  assert.equal(detectKind("scorp-k1.pdf", "Schedule K-1 (Form 1120-S)"), "k1");
  // No "Schedule" wording at all -- only a bare "K-1" alongside the issuing
  // entity's own form number, in each order the second/third patterns cover.
  assert.equal(detectKind("k1-bare.pdf", "K-1 Form 1065 partner statement"), "k1");
  assert.equal(detectKind("k1-bare-reverse.pdf", "Form 1120-S K-1 shareholder statement"), "k1");
  assert.equal(detectKind("k1-1041.pdf", "K-1 Form 1041 beneficiary statement"), "k1");
});

test("detectKind: tax_support patterns", () => {
  assert.equal(detectKind("w2.pdf", "Form W-2 Wage and Tax Statement"), "tax_support");
  assert.equal(detectKind("div.pdf", "Form 1099-DIV"), "tax_support");
  assert.equal(detectKind("misc.pdf", "1099-MISC"), "tax_support");
  assert.equal(detectKind("mortgage.pdf", "Form 1098 Mortgage Interest Statement"), "tax_support");
  assert.equal(detectKind("mortgage-bare.pdf", "1098-E Student Loan Interest"), "tax_support");
  assert.equal(detectKind("health.pdf", "Form 1095-A"), "tax_support");
  assert.equal(detectKind("health-bare.pdf", "1095-B Health Coverage"), "tax_support");
  assert.equal(detectKind("organizer.pdf", "2022 Tax Organizer"), "tax_support");
  assert.equal(detectKind("worksheet.pdf", "Tax Worksheet: Charitable Contributions"), "tax_support");
  assert.equal(detectKind("preparer-letter.pdf", "Tax Letter from your preparer"), "tax_support");
  assert.equal(detectKind("goodwill.pdf", "Donation Receipt"), "tax_support");
});

test("detectKind: statement and other", () => {
  assert.equal(detectKind("statement.pdf", "Brokerage Account Statement"), "statement");
  assert.equal(detectKind("summary.pdf", "Account Summary"), "statement");
  assert.equal(detectKind("random.pdf", "A letter about nothing tax-related at all."), "other");
  assert.equal(detectKind("photo-notes.pdf", ""), "other");
});

test("detectKind: precedence -- a full return package naming a W-2 still classifies as the return", () => {
  assert.equal(
    detectKind("2022 tax return.pdf", "Form 1040\nU.S. Individual Income Tax Return\nForm W-2 attached"),
    "tax_return",
  );
});

test("detectTaxYear: phrased patterns in filename or page text", () => {
  assert.equal(detectTaxYear("return.pdf", "2021 Form 1040"), 2021);
  assert.equal(detectTaxYear("return.pdf", "Form 1040 for tax year 2019"), 2019);
  assert.equal(detectTaxYear("letter.pdf", "Tax Year 2020 summary"), 2020);
  assert.equal(detectTaxYear("letter.pdf", "prepared for the year 2018"), 2018);
  assert.equal(detectTaxYear("package.pdf", "2023 Individual Tax Return"), 2023);
});

test("detectTaxYear: bare four-digit year in the filename only, never from page text", () => {
  assert.equal(detectTaxYear("Statements/2021/january.pdf", ""), 2021);
  assert.equal(detectTaxYear("W-2 2019.pdf", ""), 2019);
  // A bare number that looks like a year in the page text, with no phrasing
  // and no filename year, must not be treated as a tax year -- it is far
  // more likely to be an account or dollar figure.
  assert.equal(detectTaxYear("statement.pdf", "Account 2021-4455-9"), undefined);
});

test("detectTaxYear: undefined when nothing matches", () => {
  assert.equal(detectTaxYear("note.pdf", "No date mentioned here."), undefined);
});
