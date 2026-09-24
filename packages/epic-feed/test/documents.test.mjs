import assert from "node:assert/strict";
import test from "node:test";

import {
  extractsText,
  extractText,
  isFetchableContentType,
  storageFileName,
  stripHtml,
} from "../dist/index.js";

test("isFetchableContentType accepts exactly the task's four content types", () => {
  assert.equal(isFetchableContentType("text/plain"), true);
  assert.equal(isFetchableContentType("text/html; charset=utf-8"), true);
  assert.equal(isFetchableContentType("application/rtf"), true);
  assert.equal(isFetchableContentType("text/rtf"), true);
  assert.equal(isFetchableContentType("application/pdf"), true);
  assert.equal(isFetchableContentType("image/jpeg"), false);
});

test("extractsText is true only for text and HTML", () => {
  assert.equal(extractsText("text/plain"), true);
  assert.equal(extractsText("text/html"), true);
  assert.equal(extractsText("application/pdf"), false);
  assert.equal(extractsText("application/rtf"), false);
});

test("stripHtml removes tags, scripts and decodes common entities", () => {
  const html = "<html><body><script>evil()</script><p>Hello &amp; welcome</p></body></html>";
  assert.equal(stripHtml(html), "Hello & welcome");
});

test("extractText decodes plain text and strips HTML", () => {
  assert.equal(extractText("text/plain", Buffer.from("Note text")), "Note text");
  assert.equal(
    extractText("text/html", Buffer.from("<p>Note <b>text</b></p>")),
    "Note text",
  );
  assert.equal(extractText("application/pdf", Buffer.from("%PDF-1.4")), null);
});

test("storageFileName picks the right extension per content type", () => {
  assert.equal(storageFileName("doc-1", "application/pdf"), "doc-1.pdf");
  assert.equal(storageFileName("doc-2", "application/rtf"), "doc-2.rtf");
  assert.equal(storageFileName("doc-3", "text/rtf"), "doc-3.rtf");
});
