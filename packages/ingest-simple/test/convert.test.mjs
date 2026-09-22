// Synthetic-fixture unit tests for file-to-pages conversion: text/markdown/
// CSV are one page each, a real (hand-built, see test/helpers/pdf.mjs)
// multi-page PDF splits on poppler's form feed, and a low-text page falls
// back to OCR through an injected `fetchImpl` -- no network, no real
// provider, no real vendor SDK.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { convertFile } from "../dist/convert.js";
import { buildPdf } from "./helpers/pdf.mjs";

async function tempFile(t, name, bytes) {
  const dir = await mkdtemp(join(tmpdir(), "ingest-simple-convert-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

test("convertFile reads text/markdown/csv as one UTF-8 page", async (t) => {
  const textPath = await tempFile(t, "note.txt", "Plain text note.\nSecond line.\n");
  const text = await convertFile(textPath, ".txt");
  assert.deepEqual(text.pages, ["Plain text note.\nSecond line.\n"]);
  assert.equal(text.mediaType, "text/plain");
  assert.equal(text.ocrPagesUsed, 0);

  const mdPath = await tempFile(t, "readme.md", "# Title\n\nBody.\n");
  const md = await convertFile(mdPath, ".md");
  assert.deepEqual(md.pages, ["# Title\n\nBody.\n"]);
  assert.equal(md.mediaType, "text/markdown");

  const csvPath = await tempFile(t, "data.csv", "a,b\n1,2\n");
  const csv = await convertFile(csvPath, ".csv");
  assert.deepEqual(csv.pages, ["a,b\n1,2\n"]);
  assert.equal(csv.mediaType, "text/csv");
});

test("convertFile splits a real PDF into one page per poppler form feed", async (t) => {
  const pdfPath = await tempFile(
    t,
    "statement.pdf",
    buildPdf([
      "This page has more than forty non whitespace characters on it, easily.",
      "This page also comfortably clears the forty character threshold too.",
    ]),
  );
  const converted = await convertFile(pdfPath, ".pdf");
  assert.equal(converted.pages.length, 2);
  assert.match(converted.pages[0], /This page has more than forty/);
  assert.match(converted.pages[1], /This page also comfortably/);
  assert.equal(converted.mediaType, "application/pdf");
  assert.equal(converted.ocrPagesUsed, 0);
  assert.match(converted.converterFingerprint, /^pdftotext-poppler@/);
});

test("convertFile OCRs a page under the non-whitespace threshold and records it in the fingerprint", async (t) => {
  const pdfPath = await tempFile(
    t,
    "scan.pdf",
    buildPdf([
      "This first page has plenty of real extracted text, well over forty characters.",
      "hi",
    ]),
  );
  let ocrRequests = 0;
  const fetchImpl = async () => {
    ocrRequests += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Transcribed scan text" } }] }),
      { status: 200 },
    );
  };
  const converted = await convertFile(pdfPath, ".pdf", {
    env: { KITH_EXTRACT_ENDPOINT: "https://localhost/fake", KITH_EXTRACT_API_KEY: "test" },
    fetchImpl,
  });
  assert.equal(ocrRequests, 1, "only the low-text page should be OCR'd");
  assert.equal(converted.pages.length, 2);
  assert.match(converted.pages[0], /plenty of real extracted text/);
  assert.equal(converted.pages[1], "Transcribed scan text");
  assert.equal(converted.ocrPagesUsed, 1);
  assert.match(converted.converterFingerprint, /\+ocr-vision:/);
});

test("convertFile leaves a low-text page as-is and warns once when OCR is unconfigured", async (t) => {
  const pdfPath = await tempFile(t, "scan.pdf", buildPdf(["ok", "also short"]));
  let warnings = 0;
  const converted = await convertFile(pdfPath, ".pdf", {
    env: {},
    onOcrUnconfigured: () => {
      warnings += 1;
    },
  });
  assert.equal(warnings, 1, "warns once for the whole file, not once per page");
  assert.equal(converted.ocrPagesUsed, 0);
});
