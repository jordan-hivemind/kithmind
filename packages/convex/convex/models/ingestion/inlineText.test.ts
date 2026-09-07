import { describe, expect, test } from "vitest";

import {
  INLINE_TEXT_CHUNKER_FINGERPRINT,
  MAX_INLINE_TEXT_CHUNK_UTF8_BYTES,
  planInlineText,
} from "./inlineText";
import { MAX_INLINE_TEXT_BYTES } from "./limits";

const utf8Length = (text: string) => new TextEncoder().encode(text).byteLength;

describe("planInlineText", () => {
  test("preserves exact multilingual text and builds contiguous UTF-16 evidence ranges", () => {
    const text = "first line\r\n日本語 😀\nالعربية\tlast line";
    const plan = planInlineText(text);

    expect(plan.text).toBe(text);
    expect(plan.chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(plan.chunks).toEqual([
      { ordinal: 0, start: 0, end: text.length, text },
    ]);
    expect(plan).toMatchObject({
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      expectedEventCount: 0,
      expectedObservationCount: 0,
      chunkerFingerprint: INLINE_TEXT_CHUNKER_FINGERPRINT,
    });
  });

  test("chunks on code point boundaries at the UTF-8 byte limit", () => {
    const text = `${"a".repeat(MAX_INLINE_TEXT_CHUNK_UTF8_BYTES - 3)}😀尾`;
    const plan = planInlineText(text);

    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(plan.chunks.map((chunk) => utf8Length(chunk.text))).toEqual([
      MAX_INLINE_TEXT_CHUNK_UTF8_BYTES - 3,
      7,
    ]);
    expect(plan.chunks[0]!.end).toBe(MAX_INLINE_TEXT_CHUNK_UTF8_BYTES - 3);
    expect(plan.chunks[1]!.start).toBe(plan.chunks[0]!.end);
    expect(plan.chunks[1]!.text.startsWith("😀")).toBe(true);
  });

  test("is deterministic and has no environment-derived fingerprint", () => {
    const text = "x".repeat(2_100);
    expect(planInlineText(text)).toEqual(planInlineText(text));
    expect(INLINE_TEXT_CHUNKER_FINGERPRINT).toContain("2048");
    expect(INLINE_TEXT_CHUNKER_FINGERPRINT).toContain("v1");
  });

  test("enforces the exact input byte limit", () => {
    expect(() =>
      planInlineText("a".repeat(MAX_INLINE_TEXT_BYTES)),
    ).not.toThrow();
    expect(() => planInlineText("a".repeat(MAX_INLINE_TEXT_BYTES + 1))).toThrow(
      /65536-byte limit/,
    );
    expect(() => planInlineText("😀".repeat(16_385))).toThrow(
      /65536-byte limit/,
    );
  });

  test("rejects empty, whitespace-only, and malformed UTF-16 text", () => {
    expect(() => planInlineText("")).toThrow(/empty or whitespace-only/);
    expect(() => planInlineText(" \t\r\n")).toThrow(/empty or whitespace-only/);
    expect(() => planInlineText("before\ud800after")).toThrow(
      /unpaired high surrogate/,
    );
    expect(() => planInlineText("before\udc00after")).toThrow(
      /unpaired low surrogate/,
    );
  });
});

// A final high surrogate makes charCodeAt return NaN for the absent low unit.
test("rejects a trailing unpaired high surrogate", () => {
  expect(() => planInlineText("valid prefix\ud800")).toThrow(
    /unpaired high surrogate/,
  );
});
