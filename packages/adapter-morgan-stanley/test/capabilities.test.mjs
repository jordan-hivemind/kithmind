import { test } from "node:test";
import assert from "node:assert/strict";
import adapter, { ACTIVITY_SIGN_TABLE, ACTIVITY_TAXONOMY } from "../src/adapter.mjs";

test("activityTaxonomy agrees with ACTIVITY_SIGN_TABLE on every activity type they share", () => {
  const shared = new Set([...ACTIVITY_SIGN_TABLE.keys(), ...Object.keys(ACTIVITY_TAXONOMY)]);
  assert.ok(shared.size > 0);
  for (const activityType of shared) {
    const sign = ACTIVITY_SIGN_TABLE.get(activityType);
    const entry = ACTIVITY_TAXONOMY[activityType];
    assert.ok(sign !== undefined, `${activityType} is in activityTaxonomy but not ACTIVITY_SIGN_TABLE`);
    assert.ok(entry !== undefined, `${activityType} is in ACTIVITY_SIGN_TABLE but not activityTaxonomy`);
    assert.equal(entry.movesQuantity, true);
    assert.equal(entry.quantitySign, sign > 0 ? "positive" : "negative");
  }
  assert.deepEqual(adapter.capabilities().activityTaxonomy, ACTIVITY_TAXONOMY);
});
