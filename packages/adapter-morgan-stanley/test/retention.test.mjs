import { test } from "node:test";
import assert from "node:assert/strict";
import { retainPayload } from "@repo/finance-archive";
import { ACTIVITY_RETENTION } from "../src/adapter.mjs";
import { ACTIVITY_PAGE_WITH_CREDENTIAL_ECHO } from "../fixtures/activity.mjs";

test("json_allowlist drops credential-shaped and person-shaped fields, never copies them into the retained bytes", () => {
  const sourceBytes = new TextEncoder().encode(
    JSON.stringify({ pages: [ACTIVITY_PAGE_WITH_CREDENTIAL_ECHO] }),
  );
  const retained = retainPayload(ACTIVITY_RETENTION, sourceBytes, "structured_api");
  const retainedText = new TextDecoder().decode(retained.bytes);

  // The allowlist is built up, never stripped down: nothing named here
  // should appear in the output at all.
  assert.equal(retainedText.includes("eyFAKE.CREDENTIAL.TOKEN"), false);
  assert.equal(retainedText.includes("fp-fake-0000"), false);
  assert.equal(retainedText.includes("Sample Brokerage Account"), false);
  assert.equal(retainedText.includes("SessionToken"), false);
  assert.equal(retainedText.includes("DeviceFootprintEcho"), false);
  assert.equal(retainedText.includes("accountName"), false);
  assert.equal(retainedText.includes("Birthday gift for Sample Person"), false);
  assert.equal(retainedText.includes("4111-XXXX-XXXX-1234"), false);

  // The retained data everyone actually reads is still present.
  assert.equal(retainedText.includes("912796ZZ1"), true);
  assert.equal(retainedText.includes("TREASURY BILL PURCHASE"), true);

  // FX fields, payDate and referenceNumber are retained for evidence and
  // later use (README, "Retention"), even though parse() does not read them.
  assert.equal(retainedText.includes("2025-03-05"), true); // payDate
  assert.equal(retainedText.includes("REF-0001-000009"), true); // referenceNumber
  assert.equal(retainedText.includes("fxCurrency"), true);
  assert.equal(retainedText.includes("fxSourceCurrency"), true);
  assert.equal(retainedText.includes("fxSourceAmount"), true);
  assert.equal(retainedText.includes("fxLocalCurrency"), true);
  assert.equal(retainedText.includes("fxLocalAmount"), true);
  assert.equal(retainedText.includes("fxMarketRate"), true);
  assert.equal(retainedText.includes("fxType"), true);

  assert.deepEqual(
    [...retained.record.droppedPaths].sort(),
    [
      "pages.*.Result.DeviceFootprintEcho",
      "pages.*.Result.SessionToken",
      "pages.*.Result.postedActivities.*.accountName",
      "pages.*.Result.postedActivities.*.memo",
      "pages.*.Result.postedActivities.*.cardNumber",
    ].sort(),
  );
  assert.equal(retained.record.policy.version, "ms-activity-3");
});

test("a structured_api payload may never be retained opaque", () => {
  assert.throws(() => {
    retainPayload(
      { kind: "opaque", version: "x", note: "trying to skip the allowlist" },
      new TextEncoder().encode("{}"),
      "structured_api",
    );
  }, /structured_api payload may not be retained opaque/);
});
