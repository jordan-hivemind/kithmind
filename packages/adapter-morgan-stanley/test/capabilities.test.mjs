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

// F1-8d. The delivery and receipt sides of one in-kind journal between two
// accounts, synthetic: invented key accounts, an invented instrument, invented
// amounts. The site states the value journalled and no quantity, so the two
// rows' amounts are equal and opposite across the two accounts and neither one
// ever reached the stated cash balance. Summing them as cash was the whole of
// 17 failing cash-gate periods, so what this asserts is the pair of facts that
// keeps them out of the sum: parse preserves the stated amount (nothing is
// dropped at the adapter), and the taxonomy declares the type non-cash (so
// adapterImport nulls the amount, opens cash_on_noncash_activity, and the cash
// gate excludes the row).
const ROWAN_IN_KIND_JOURNAL = {
  pages: [
    {
      Result: {
        postedActivityCount: 2,
        postedActivities: [
          {
            activityId: "ACT-ROWAN-000001",
            CCY: "-",
            processDate: "04/18/2025",
            activityDate: "04/18/2025",
            tradeDate: "04/18/2025",
            settlementDate: "04/18/2025",
            keyAccount: "MS-ACCT-ROWAN-1",
            activity: "Transfer out of Account",
            description: "JOURNAL OUT<br/>ROWAN GROWTH FUND",
            amount: -41250.75,
            quantity: null,
            price: 0,
            symbol: "RWNGX",
            cusip: "00000RWN1",
          },
          {
            activityId: "ACT-ROWAN-000002",
            CCY: "-",
            processDate: "04/18/2025",
            activityDate: "04/18/2025",
            tradeDate: "04/18/2025",
            settlementDate: "04/18/2025",
            keyAccount: "MS-ACCT-ROWAN-2",
            activity: "Transfer into Account",
            description: "JOURNAL IN<br/>ROWAN GROWTH FUND",
            amount: 41250.75,
            quantity: null,
            price: 0,
            symbol: "RWNGX",
            cusip: "00000RWN1",
          },
        ],
      },
    },
  ],
};

test("an in-kind journal between two accounts is declared non-cash, amount and all", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(ROWAN_IN_KIND_JOURNAL));
  const parsed = await adapter.parse({ kind: "structured_api", bytes });

  const out = parsed.activity.find((r) => r.activityType === "Transfer out of Account");
  const into = parsed.activity.find((r) => r.activityType === "Transfer into Account");

  // Nothing is dropped at the adapter: the stated value survives parse, and
  // the two sides are equal and opposite on two different accounts.
  assert.equal(out.amount, "-41250.75");
  assert.equal(into.amount, "41250.75");
  assert.notEqual(out.accountExternalKey, into.accountExternalKey);
  assert.equal(out.quantity, null, "the site states no quantity on these rows");
  assert.equal(into.quantity, null);

  // And the declaration is what keeps that value out of the cash gate's sum.
  for (const row of [out, into]) {
    assert.equal(
      ACTIVITY_TAXONOMY[row.activityType].movesCash,
      false,
      `${row.activityType} must stay movesCash: false; declaring it cash-moving ` +
        "makes the cash gate charge a journalled value the stated balance never saw",
    );
  }
});
