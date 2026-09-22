// Exercises `EncryptedPdfError` / `--pdf-password` end to end against a fake
// `pdftotext`/`pdfinfo` placed first on `PATH` for the duration of these
// tests. No PDF-encryption tool (`qpdf`, `pdftk`) is available in this
// environment to build a real password-protected PDF fixture, so this fakes
// poppler's own CLI contract closely enough for convert.ts to drive it
// unmodified: `-upw <password>` and poppler's own "Command Line Error:
// Incorrect password" stderr text and non-zero exit on a wrong or missing
// one. `isIncorrectPasswordStderr` is also covered directly against real
// poppler error text, per the fallback the task allows when no encryption
// tool is available.

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { convertFile, convertFilePage1, EncryptedPdfError, isIncorrectPasswordStderr } from "../dist/convert.js";

const PAGE_ONE = "This is page one of an encrypted synthetic document, well over forty characters.";
const PAGE_TWO = "This is page two of the same encrypted synthetic document, also well over forty.";
const REAL_PASSWORD = "correct-horse-battery-staple";

// Both fakes read the fixture file's first line as "the password this
// document requires" (empty means "no password needed") -- a convention only
// these tests and the fixtures below share, not a real PDF format detail.
const PDFTOTEXT_FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-v")) {
  process.stderr.write("pdftotext version 99.0.0 (fake, test-only)\\n");
  process.exit(1);
}
const path = args[args.length - 2];
const expected = fs.readFileSync(path, "utf8").split("\\n")[0].trim();
const upwIndex = args.indexOf("-upw");
const provided = upwIndex >= 0 ? args[upwIndex + 1] : undefined;
if (expected && provided !== expected) {
  process.stderr.write("Command Line Error: Incorrect password\\n");
  process.exit(1);
}
const page1Only = args.includes("-f");
process.stdout.write(page1Only ? ${JSON.stringify(PAGE_ONE)} : ${JSON.stringify(PAGE_ONE)} + "\\f" + ${JSON.stringify(PAGE_TWO)});
`;

const PDFINFO_FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const path = args[args.length - 1];
const expected = fs.readFileSync(path, "utf8").split("\\n")[0].trim();
const upwIndex = args.indexOf("-upw");
const provided = upwIndex >= 0 ? args[upwIndex + 1] : undefined;
if (expected && provided !== expected) {
  process.stderr.write("Command Line Error: Incorrect password\\n");
  process.exit(1);
}
process.stdout.write("Pages: 2\\n");
`;

/** Prepends a temp directory holding the fakes above to `PATH` for the
 * duration of one test, restoring it in `t.after`. Real poppler stays later
 * on `PATH` behind the fakes (unused here -- OCR/`pdftoppm` is never reached
 * because every fixture's page text clears the non-whitespace threshold). */
async function withFakePoppler(t) {
  const dir = await mkdtemp(join(tmpdir(), "ingest-simple-fake-poppler-"));
  const pdftotextPath = join(dir, "pdftotext");
  const pdfinfoPath = join(dir, "pdfinfo");
  await writeFile(pdftotextPath, PDFTOTEXT_FAKE, "utf8");
  await writeFile(pdfinfoPath, PDFINFO_FAKE, "utf8");
  await chmod(pdftotextPath, 0o755);
  await chmod(pdfinfoPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
  t.after(async () => {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });
}

async function encryptedFixture(t, password) {
  const dir = await mkdtemp(join(tmpdir(), "ingest-simple-encrypted-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "encrypted.pdf");
  // First line is the fake pdftotext/pdfinfo's "required password" -- not
  // real PDF bytes, since the fakes never parse the file as a PDF.
  await writeFile(path, `${password}\nfake pdf body\n`, "utf8");
  return path;
}

test("convertFilePage1 throws EncryptedPdfError when no password opens the PDF", async (t) => {
  await withFakePoppler(t);
  const path = await encryptedFixture(t, REAL_PASSWORD);
  await assert.rejects(
    () => convertFilePage1(path, ".pdf"),
    (error) => {
      assert.ok(error instanceof EncryptedPdfError);
      assert.equal(error.message, "PDF is password protected and no configured password opened it");
      return true;
    },
  );
});

test("convertFilePage1 throws EncryptedPdfError when configured passwords are all wrong", async (t) => {
  await withFakePoppler(t);
  const path = await encryptedFixture(t, REAL_PASSWORD);
  await assert.rejects(
    () => convertFilePage1(path, ".pdf", { pdfPasswords: ["nope", "still-nope"] }),
    EncryptedPdfError,
  );
});

test("convertFilePage1 opens the PDF when the correct password is among the candidates", async (t) => {
  await withFakePoppler(t);
  const path = await encryptedFixture(t, REAL_PASSWORD);
  const page1 = await convertFilePage1(path, ".pdf", { pdfPasswords: ["wrong-one", REAL_PASSWORD] });
  assert.equal(page1.pageText, PAGE_ONE);
  assert.equal(page1.totalPageCount, 2);
});

test("convertFile (full depth) opens the PDF when the correct password is among the candidates", async (t) => {
  await withFakePoppler(t);
  const path = await encryptedFixture(t, REAL_PASSWORD);
  const converted = await convertFile(path, ".pdf", { pdfPasswords: [REAL_PASSWORD] });
  assert.deepEqual(converted.pages, [PAGE_ONE, PAGE_TWO]);
});

test("convertFilePage1 tries no password first, so an unencrypted PDF ignores configured passwords", async (t) => {
  await withFakePoppler(t);
  const path = await encryptedFixture(t, ""); // empty first line: the fakes require no password
  const page1 = await convertFilePage1(path, ".pdf", { pdfPasswords: ["irrelevant"] });
  assert.equal(page1.pageText, PAGE_ONE);
});

test("isIncorrectPasswordStderr classifies poppler's own incorrect-password message", () => {
  assert.equal(isIncorrectPasswordStderr("Command Line Error: Incorrect password\n"), true);
  assert.equal(isIncorrectPasswordStderr("Incorrect password\n"), true);
  assert.equal(isIncorrectPasswordStderr("incorrect password\n"), true);
});

test("isIncorrectPasswordStderr does not misclassify an unrelated poppler error", () => {
  assert.equal(isIncorrectPasswordStderr("Syntax Error: Couldn't find trailer dictionary\n"), false);
  assert.equal(isIncorrectPasswordStderr(""), false);
  assert.equal(isIncorrectPasswordStderr("pdftotext version 25.09.0\n"), false);
});
