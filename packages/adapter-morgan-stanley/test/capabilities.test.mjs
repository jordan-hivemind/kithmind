import { test } from "node:test";
import assert from "node:assert/strict";
import adapter, { ACTIVITY_SIGN_TABLE, ACTIVITY_TAXONOMY } from "../src/adapter.mjs";

test("every quantity-moving activity type has a sign, and every sign has a declaration", () => {
  assert.ok(Object.keys(ACTIVITY_TAXONOMY).length > 0);

  for (const [activityType, entry] of Object.entries(ACTIVITY_TAXONOMY)) {
    const sign = ACTIVITY_SIGN_TABLE.get(activityType);
    if (entry.movesQuantity) {
      // Without a sign, resolveSignedQuantity returns null and the position
      // gate loses the row with no review item to explain it -- the silent
      // failure this pairing exists to prevent.
      assert.ok(
        sign !== undefined,
        `${activityType} declares movesQuantity: true but has no ACTIVITY_SIGN_TABLE sign`,
      );
      assert.equal(
        entry.quantitySign,
        sign > 0 ? "positive" : "negative",
        `${activityType} disagrees with its ACTIVITY_SIGN_TABLE sign`,
      );
    } else {
      assert.equal(
        sign,
        undefined,
        `${activityType} declares movesQuantity: false but has an ACTIVITY_SIGN_TABLE sign`,
      );
      assert.equal(entry.quantitySign, "none");
    }
  }

  for (const activityType of ACTIVITY_SIGN_TABLE.keys()) {
    assert.ok(
      ACTIVITY_TAXONOMY[activityType] !== undefined,
      `${activityType} is in ACTIVITY_SIGN_TABLE but not activityTaxonomy`,
    );
  }

  assert.deepEqual(adapter.capabilities().activityTaxonomy, ACTIVITY_TAXONOMY);
});
