// Ported from packages/convex/convex/models/provenance/parsedStaging.test.ts
// (P2-39d2): the pure helper functions, no database needed.

import assert from "node:assert/strict";
import test from "node:test";

import {
  isParsedChunkTextWithinLimits,
  isParsedProfileWithinLimits,
  isParsedStoredPayloadWithinLimit,
  MAX_PARSED_STORED_PAYLOAD_BYTES,
  requirePageChunkProfile,
} from "../dist/provenance/index.js";
import { sha256Utf8 } from "../dist/provenance/sql.js";

test("accepts the exact aggregate boundary and rejects overflow", () => {
  assert.equal(
    isParsedStoredPayloadWithinLimit(1_024 * 1_024, 128 * 1_024, 16 * 1_024, 2_816 * 1_024, 16 * 1_024),
    true,
  );
  assert.equal(isParsedStoredPayloadWithinLimit(MAX_PARSED_STORED_PAYLOAD_BYTES, 1), false);
  assert.equal(isParsedStoredPayloadWithinLimit(-1), false);
  assert.equal(isParsedStoredPayloadWithinLimit(Number.MAX_SAFE_INTEGER, 1), false);
});

test("keeps expanded counts exclusive to the page profile", () => {
  const expanded = {
    pageCount: 64,
    retainedTextBytes: 1_024 * 1_024,
    evidenceSpanCount: 256,
    chunkCount: 256,
  };
  assert.equal(isParsedProfileWithinLimits({ usesPageLocators: true, ...expanded }), true);
  assert.equal(isParsedProfileWithinLimits({ usesPageLocators: false, ...expanded }), false);
  assert.equal(
    isParsedProfileWithinLimits({
      usesPageLocators: false,
      pageCount: 32,
      retainedTextBytes: 256 * 1_024,
      evidenceSpanCount: 128,
      chunkCount: 128,
    }),
    true,
  );
  assert.equal(isParsedChunkTextWithinLimits(false, 256 * 1_024), true);
  assert.equal(isParsedChunkTextWithinLimits(false, 256 * 1_024 + 1), false);
  assert.equal(isParsedChunkTextWithinLimits(true, 1_024 * 1_024), true);
});

async function pageChunkFixture() {
  const aHash = await sha256Utf8("a");
  const bHash = await sha256Utf8("b");
  const pages = [
    { id: "page-a", start: 0, end: 1, text: "a" },
    { id: "page-b", start: 1, end: 2, text: "b" },
  ];
  const spans = [
    { id: "span-a", sourcePageId: "page-a", start: 0, end: 1, quoteHash: aHash },
    { id: "span-b", sourcePageId: "page-b", start: 0, end: 1, quoteHash: bHash },
  ];
  const documents = [
    { id: "document-main", documentKey: "main", evidenceSpanIds: ["span-a", "span-b"] },
  ];
  const chunks = [
    { documentId: "document-main", start: 0, end: 1, text: "a", evidenceSpanIds: ["span-a"] },
    { documentId: "document-main", start: 1, end: 2, text: "b", evidenceSpanIds: ["span-b"] },
  ];
  return { pages, spans, documents, chunks };
}

test("accepts one page-local evidence span per chunk", async () => {
  const value = await pageChunkFixture();
  await assert.doesNotReject(
    requirePageChunkProfile(value.pages, value.spans, value.documents, value.chunks),
  );
});

test("rejects a chunk bound to the wrong page span", async () => {
  const value = await pageChunkFixture();
  value.chunks[0].evidenceSpanIds = ["span-b"];
  await assert.rejects(
    requirePageChunkProfile(value.pages, value.spans, value.documents, value.chunks),
  );
});

test("rejects a chunk whose range crosses its evidence page", async () => {
  const value = await pageChunkFixture();
  value.chunks[0] = { ...value.chunks[0], end: 2, text: "ab" };
  await assert.rejects(
    requirePageChunkProfile(value.pages, value.spans, value.documents, value.chunks),
  );
});

test("rejects reuse of one evidence span by multiple chunks", async () => {
  const value = await pageChunkFixture();
  value.chunks[1].evidenceSpanIds = ["span-a"];
  await assert.rejects(
    requirePageChunkProfile(value.pages, value.spans, value.documents, value.chunks),
  );
});
