import assert from "node:assert/strict";
import test from "node:test";

import {
  valuationNoteComparisonKey,
  valuationNotesEquivalent,
} from "../dist/valuationNote.js";

const BOND = "Market Value column of the BONDS holdings table";
const GOVERNMENT =
  "Market Value column of the GOVERNMENT/SECURITIES holdings table";

test("generated valuation note comparison removes only the section provenance", () => {
  assert.equal(valuationNotesEquivalent(BOND, GOVERNMENT), true);
  assert.equal(
    valuationNotesEquivalent(
      `${BOND}; summed from 2 dated lots without a printed Total row`,
      `${GOVERNMENT}; summed from 2 dated lots without a printed Total row`,
    ),
    true,
  );
  assert.notEqual(valuationNoteComparisonKey(BOND), BOND);

  for (const other of [
    null,
    "NAV column of the GOVERNMENT/SECURITIES holdings table",
    `${GOVERNMENT}; summed from 3 dated lots without a printed Total row`,
    `${GOVERNMENT}; summed from 2 dated lots without printed Total row`,
    "Statement says market value is estimated.",
    "Market Value column of the Mixed Case holdings table",
  ]) {
    assert.equal(valuationNotesEquivalent(BOND, other), false, String(other));
  }
  assert.equal(
    valuationNotesEquivalent(
      "Statement says market value is estimated.",
      "Statement says market value is estimated.",
    ),
    true,
  );
});
