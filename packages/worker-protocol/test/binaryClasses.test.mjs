import assert from "node:assert/strict";
import test from "node:test";

import {
  BINARY_CLASSES,
  BINARY_PARSER_PROFILE_IDS,
  binaryMediaType,
  isBinaryClass,
  isBinaryParserOutputMediaType,
  isBinaryParserProfileId,
  SPREADSHEET_V1_BOUNDS,
} from "../dist/index.js";

/**
 * P2-70i2. The closed set is the whole point: a class pairs one parser profile
 * with one media type and one parser output media type, and nothing may cross
 * those pairings.
 */

test("the binary class set is exactly the two audited classes", () => {
  assert.deepEqual([...BINARY_PARSER_PROFILE_IDS].sort(), [
    "pdf_docqa_v1",
    "spreadsheet_v1",
  ]);
  assert.equal(binaryMediaType("pdf_docqa_v1"), "application/pdf");
  assert.equal(
    binaryMediaType("spreadsheet_v1"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
});

test("a class pairing cannot be crossed", () => {
  assert.ok(isBinaryClass("pdf_docqa_v1", "application/pdf"));
  assert.ok(
    isBinaryClass(
      "spreadsheet_v1",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
  );
  // A workbook declared as a PDF, and a PDF declared as a workbook.
  assert.ok(
    !isBinaryClass(
      "pdf_docqa_v1",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
  );
  assert.ok(!isBinaryClass("spreadsheet_v1", "application/pdf"));
  // A media type with no class, and a profile with no class.
  assert.ok(!isBinaryClass("pdf_docqa_v1", "application/msword"));
  assert.ok(!isBinaryClass("docx_v1", "application/pdf"));
  assert.ok(!isBinaryClass(undefined, undefined));
  assert.ok(!isBinaryParserProfileId("constructor"));
  assert.ok(!isBinaryParserProfileId("toString"));
});

test("each class owns its parser output media type", () => {
  const outputs = BINARY_PARSER_PROFILE_IDS.map(
    (profileId) => BINARY_CLASSES[profileId].parserOutputMediaType,
  );
  assert.equal(new Set(outputs).size, outputs.length);
  for (const output of outputs) {
    assert.ok(isBinaryParserOutputMediaType(output));
  }
  assert.ok(!isBinaryParserOutputMediaType("application/json"));
  assert.ok(!isBinaryParserOutputMediaType("application/pdf"));
});

test("the spreadsheet bounds are the ones the class declares", () => {
  assert.equal(
    SPREADSHEET_V1_BOUNDS.maxWorkbookBytes,
    BINARY_CLASSES.spreadsheet_v1.maxOriginalBytes,
  );
  // The sheet ceiling is the parsed text version's page ceiling, and the
  // rendered-text ceiling is what a parsed text version can hold. A workbook
  // at both at once would be 64 pages of 16 KiB, not 64 pages of 64 KiB.
  assert.equal(SPREADSHEET_V1_BOUNDS.maxSheets, 64);
  assert.equal(SPREADSHEET_V1_BOUNDS.maxRenderedBytes, 1_024 * 1_024);
  assert.equal(SPREADSHEET_V1_BOUNDS.maxSheetPageChars, 65_536);
  assert.ok(
    SPREADSHEET_V1_BOUNDS.maxWorkbookBytes <
      BINARY_CLASSES.pdf_docqa_v1.maxOriginalBytes,
  );
});
