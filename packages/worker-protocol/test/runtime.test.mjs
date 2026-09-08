import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalParsedMappingManifestInput,
  digestParsedMappingManifest,
  parseParsedChunkInput,
  parseParsedLocator,
  parseParsedPageInput,
} from "../dist/index.js";

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
      kind: "parser_table_row_v1",
      pageNumber: 2,
      tableRef: "表:0",
      sourceRowOffset: 4,
      bbox: [0, 1.25, 2, 3],
      cells: [
        { column: 0, rowSpan: 1, columnSpan: 2, textHash: "e".repeat(64) },
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
      kind: "parser_item_v1",
      pageNumber: 1,
      itemRef: "#/texts/0",
      sourceCharStart: 0,
      sourceCharEnd: 1,
    },
  },
];

test("emitted Node export preserves the B2 mapping golden vector", async () => {
  assert.deepEqual(canonicalParsedMappingManifestInput(pages, evidence), [
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
  assert.equal(
    await digestParsedMappingManifest(pages, evidence),
    "1f8431d9c1bab149cf34d395104362e8fe872e643075ed386b7b251c43abd732",
  );
  assert.equal(
    parseParsedPageInput({
      ordinal: 0,
      start: 0,
      end: 2,
      text: "😀",
      textHash: "a".repeat(64),
    }).end,
    2,
  );
});

test("accepts a closed page locator through page 64", () => {
  assert.deepEqual(
    parseParsedLocator({
      kind: "parser_page_v1",
      pageNumber: 64,
      pageTextHash: "a".repeat(64),
    }),
    {
      kind: "parser_page_v1",
      pageNumber: 64,
      pageTextHash: "a".repeat(64),
    },
  );
  assert.throws(() =>
    parseParsedLocator({
      kind: "parser_page_v1",
      pageNumber: 65,
      pageTextHash: "a".repeat(64),
    }),
  );
  assert.throws(() =>
    parseParsedLocator({
      kind: "parser_page_v1",
      pageNumber: 1,
      pageTextHash: "A".repeat(64),
    }),
  );
});

test("keeps historical parsed chunk wire rows above the current mapper target readable", () => {
  const historicalText = "x".repeat(20 * 1024);
  const parsed = parseParsedChunkInput({
    documentKey: "pdf:primary",
    ordinal: 0,
    start: 0,
    end: historicalText.length,
    text: historicalText,
    evidence: [{ pageOrdinal: 0, evidenceOrdinal: 0 }],
  });
  assert.equal(parsed.text.length, 20 * 1024);
  assert.throws(() =>
    parseParsedChunkInput({
      ...parsed,
      end: 65_537,
      text: "x".repeat(65_537),
    }),
  );
});
