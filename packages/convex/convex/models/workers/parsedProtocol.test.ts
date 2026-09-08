import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PARSED_MAPPING_DOMAIN,
  canonicalParsedMappingManifestInput,
  digestParsedMappingManifest,
  parseParsedChunkInput,
  parseParsedLocator,
  parseParsedPageInput,
} from "./parsedProtocol";

describe("parsed worker protocol", () => {
  const pages = [
    { ordinal: 1, start: 2, end: 4, text: "😀", textHash: "b".repeat(64) },
    { ordinal: 0, start: 0, end: 2, text: "Aé", textHash: "a".repeat(64) },
  ];
  const evidence = [
    {
      ordinal: 1,
      pageOrdinal: 1,
      start: 0,
      end: 2,
      quoteHash: "d".repeat(64),
      locator: {
        kind: "parser_table_row_v1" as const,
        pageNumber: 2,
        tableRef: "表:0",
        sourceRowOffset: 4,
        bbox: [0, 1.25, 2, 3] as [number, number, number, number],
        cells: [
          {
            column: 0,
            rowSpan: 1,
            columnSpan: 2,
            textHash: "e".repeat(64),
          },
        ],
      },
    },
    {
      ordinal: 0,
      pageOrdinal: 0,
      start: 0,
      end: 1,
      quoteHash: "c".repeat(64),
      locator: {
        kind: "parser_item_v1" as const,
        pageNumber: 1,
        itemRef: "#/texts/0",
        sourceCharStart: 0,
        sourceCharEnd: 1,
      },
    },
  ];

  it("uses the fixed array-only manifest preimage and digest", async () => {
    const canonical = canonicalParsedMappingManifestInput(pages, evidence);
    expect(canonical).toEqual([
      1,
      [
        [0, 0, 2, "a".repeat(64)],
        [1, 2, 4, "b".repeat(64)],
      ],
      [
        [
          0,
          0,
          0,
          1,
          "c".repeat(64),
          ["parser_item_v1", 1, "#/texts/0", 0, 1, null],
        ],
        [
          1,
          1,
          0,
          2,
          "d".repeat(64),
          [
            "parser_table_row_v1",
            2,
            "表:0",
            4,
            [0, 1.25, 2, 3],
            [[0, 1, 2, "e".repeat(64), null]],
          ],
        ],
      ],
    ]);
    const expected = createHash("sha256")
      .update(PARSED_MAPPING_DOMAIN + JSON.stringify(canonical))
      .digest("hex");
    expect(await digestParsedMappingManifest(pages, evidence)).toBe(expected);
  });

  it("rejects unknown, non-NFC, nonfinite, and malformed locator values", () => {
    expect(() =>
      parseParsedLocator({ kind: "future", pageNumber: 1 }),
    ).toThrow();
    expect(() =>
      parseParsedLocator({
        kind: "parser_item_v1",
        pageNumber: 1,
        itemRef: "e\u0301",
        sourceCharStart: 0,
        sourceCharEnd: 1,
      }),
    ).toThrow();
    expect(() =>
      parseParsedLocator({
        kind: "parser_item_v1",
        pageNumber: 1,
        itemRef: "x",
        sourceCharStart: 0,
        sourceCharEnd: 1,
        bbox: [0, 1, Infinity, 2],
      }),
    ).toThrow();
    expect(() =>
      parseParsedLocator({
        kind: "parser_table_row_v1",
        pageNumber: 1,
        tableRef: "t",
        sourceRowOffset: 0,
        cells: [
          { column: 0, rowSpan: 1, columnSpan: 1, textHash: "a".repeat(64) },
          { column: 0, rowSpan: 1, columnSpan: 1, textHash: "b".repeat(64) },
        ],
      }),
    ).toThrow();
  });

  it("accepts only exact page locators within the parsed profile", () => {
    expect(
      parseParsedLocator({
        kind: "parser_page_v1",
        pageNumber: 64,
        pageTextHash: "a".repeat(64),
      }),
    ).toEqual({
      kind: "parser_page_v1",
      pageNumber: 64,
      pageTextHash: "a".repeat(64),
    });
    expect(() =>
      parseParsedLocator({
        kind: "parser_page_v1",
        pageNumber: 65,
        pageTextHash: "a".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      parseParsedLocator({
        kind: "parser_page_v1",
        pageNumber: 1,
        pageTextHash: "A".repeat(64),
      }),
    ).toThrow();
  });

  it("enforces UTF-16 ranges and exact closed row shapes", () => {
    expect(
      parseParsedPageInput({
        ordinal: 0,
        start: 0,
        end: 2,
        text: "😀",
        textHash: "a".repeat(64),
      }).end,
    ).toBe(2);
    expect(() =>
      parseParsedPageInput({
        ordinal: 0,
        start: 0,
        end: 1,
        text: "😀",
        textHash: "a".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      parseParsedChunkInput({
        documentKey: "d",
        ordinal: 0,
        start: 0,
        end: 1,
        text: "x",
        evidence: [],
        extra: true,
      }),
    ).toThrow();
  });
});
