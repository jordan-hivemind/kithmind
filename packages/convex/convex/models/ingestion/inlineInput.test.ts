import { describe, expect, test } from "vitest";

import {
  MAX_INLINE_ACCOUNT_ID_UTF8_BYTES,
  MAX_INLINE_DOC_TYPE_LENGTH,
  MAX_INLINE_EXTERNAL_ID_UTF8_BYTES,
  MAX_INLINE_REQUEST_ID_UTF8_BYTES,
  MAX_INLINE_TITLE_LENGTH,
  MAX_INLINE_URI_UTF8_BYTES,
  prepareInlineInput,
  type InlineIngestInput,
} from "./inlineInput";

function input(overrides: Partial<InlineIngestInput> = {}): InlineIngestInput {
  return {
    requestId: "request-1",
    expectedDesiredProcessingEpoch: 0,
    source: {
      connector: "mcp-client",
      accountId: "account-1",
      externalId: "message-1",
      uri: "mcp://message/1",
      capturedAt: "2026-09-06T12:34:56.789-07:00",
    },
    title: "Synthetic note",
    text: "Exact synthetic text",
    docType: "note",
    ...overrides,
  };
}

describe("inline input", () => {
  test("accepts exact public boundaries and preserves text", () => {
    const exact = input({
      requestId: "r".repeat(MAX_INLINE_REQUEST_ID_UTF8_BYTES),
      source: {
        connector: "mcp-client",
        accountId: "a".repeat(MAX_INLINE_ACCOUNT_ID_UTF8_BYTES),
        externalId: "e".repeat(MAX_INLINE_EXTERNAL_ID_UTF8_BYTES),
        uri: "u".repeat(MAX_INLINE_URI_UTF8_BYTES),
        capturedAt: "2026-09-06T19:34:56.001Z",
      },
      title: "t".repeat(MAX_INLINE_TITLE_LENGTH),
      docType: "d".repeat(MAX_INLINE_DOC_TYPE_LENGTH),
      text: "line one\r\nline two",
    });
    const prepared = prepareInlineInput(exact);
    expect(prepared.plan.text).toBe("line one\r\nline two");
    expect(prepared.capturedAt).toBe(Date.parse(exact.source.capturedAt));
  });

  test("rejects UTF-8 byte overflow, whitespace, and malformed UTF-16", () => {
    expect(() =>
      prepareInlineInput(input({ requestId: "é".repeat(65) })),
    ).toThrow("requestId is invalid");
    expect(() =>
      prepareInlineInput(
        input({
          source: { ...input().source, accountId: " \t " },
        }),
      ),
    ).toThrow("source.accountId is invalid");
    expect(() => prepareInlineInput(input({ title: "bad\ud800" }))).toThrow(
      "title contains malformed UTF-16",
    );
    expect(() =>
      prepareInlineInput(
        input({ source: { ...input().source, uri: "bad\udc00" } }),
      ),
    ).toThrow("source.uri contains malformed UTF-16");
  });

  test("requires a precise RFC3339 instant with a known offset", () => {
    for (const capturedAt of [
      "2026-09-06",
      "2026-02-30T01:02:03Z",
      "2026-09-06T01:02:03.1234Z",
      "2026-09-06T01:02:03-00:00",
      "2026-09-06T01:02:03+14:01",
    ]) {
      expect(() =>
        prepareInlineInput(
          input({ source: { ...input().source, capturedAt } }),
        ),
      ).toThrow("source.capturedAt must be an RFC3339 instant");
    }
  });
});
