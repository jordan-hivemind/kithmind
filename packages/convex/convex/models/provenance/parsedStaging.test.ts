import { describe, expect, test } from "vitest";

import {
  isParsedChunkTextWithinLimits,
  isParsedProfileWithinLimits,
  isParsedStoredPayloadWithinLimit,
  MAX_PARSED_STORED_PAYLOAD_BYTES,
  requirePageChunkProfile,
} from "./parsedStaging";
import { sha256Utf8 } from "./model";

describe("parsed stored payload budget", () => {
  test("accepts the exact aggregate boundary and rejects overflow", () => {
    expect(
      isParsedStoredPayloadWithinLimit(
        1_024 * 1_024,
        128 * 1_024,
        16 * 1_024,
        2_816 * 1_024,
        16 * 1_024,
      ),
    ).toBe(true);
    expect(
      isParsedStoredPayloadWithinLimit(
        MAX_PARSED_STORED_PAYLOAD_BYTES,
        1,
      ),
    ).toBe(false);
    expect(isParsedStoredPayloadWithinLimit(-1)).toBe(false);
    expect(isParsedStoredPayloadWithinLimit(Number.MAX_SAFE_INTEGER, 1)).toBe(
      false,
    );
  });

  test("keeps expanded counts exclusive to the page profile", () => {
    const expanded = {
      pageCount: 64,
      retainedTextBytes: 1_024 * 1_024,
      evidenceSpanCount: 256,
      chunkCount: 256,
    };
    expect(
      isParsedProfileWithinLimits({
        usesPageLocators: true,
        ...expanded,
      }),
    ).toBe(true);
    expect(
      isParsedProfileWithinLimits({
        usesPageLocators: false,
        ...expanded,
      }),
    ).toBe(false);
    expect(
      isParsedProfileWithinLimits({
        usesPageLocators: false,
        pageCount: 32,
        retainedTextBytes: 256 * 1_024,
        evidenceSpanCount: 128,
        chunkCount: 128,
      }),
    ).toBe(true);
    expect(isParsedChunkTextWithinLimits(false, 256 * 1_024)).toBe(true);
    expect(isParsedChunkTextWithinLimits(false, 256 * 1_024 + 1)).toBe(false);
    expect(isParsedChunkTextWithinLimits(true, 1_024 * 1_024)).toBe(true);
  });
});

describe("parsed page chunk profile", () => {
  async function fixture() {
    const aHash = await sha256Utf8("a");
    const bHash = await sha256Utf8("b");
    const pages = [
      { _id: "page-a", start: 0, end: 1, text: "a" },
      { _id: "page-b", start: 1, end: 2, text: "b" },
    ];
    const spans = [
      {
        _id: "span-a",
        sourcePageId: "page-a",
        start: 0,
        end: 1,
        quoteHash: aHash,
      },
      {
        _id: "span-b",
        sourcePageId: "page-b",
        start: 0,
        end: 1,
        quoteHash: bHash,
      },
    ];
    const documents = [
      {
        _id: "document-main",
        documentKey: "main",
        evidenceSpanIds: ["span-a", "span-b"],
      },
    ];
    const chunks = [
      {
        documentId: "document-main",
        start: 0,
        end: 1,
        text: "a",
        evidenceSpanIds: ["span-a"],
      },
      {
        documentId: "document-main",
        start: 1,
        end: 2,
        text: "b",
        evidenceSpanIds: ["span-b"],
      },
    ];
    return { pages, spans, documents, chunks };
  }

  test("accepts one page-local evidence span per chunk", async () => {
    const value = await fixture();
    await expect(
      requirePageChunkProfile(
        value.pages as never,
        value.spans as never,
        value.documents as never,
        value.chunks as never,
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects a chunk bound to the wrong page span", async () => {
    const value = await fixture();
    value.chunks[0]!.evidenceSpanIds = ["span-b"];
    await expect(
      requirePageChunkProfile(
        value.pages as never,
        value.spans as never,
        value.documents as never,
        value.chunks as never,
      ),
    ).rejects.toThrow();
  });

  test("rejects a chunk whose range crosses its evidence page", async () => {
    const value = await fixture();
    value.chunks[0] = {
      ...value.chunks[0]!,
      end: 2,
      text: "ab",
    };
    await expect(
      requirePageChunkProfile(
        value.pages as never,
        value.spans as never,
        value.documents as never,
        value.chunks as never,
      ),
    ).rejects.toThrow();
  });

  test("rejects reuse of one evidence span by multiple chunks", async () => {
    const value = await fixture();
    value.chunks[1]!.evidenceSpanIds = ["span-a"];
    await expect(
      requirePageChunkProfile(
        value.pages as never,
        value.spans as never,
        value.documents as never,
        value.chunks as never,
      ),
    ).rejects.toThrow();
  });
});
