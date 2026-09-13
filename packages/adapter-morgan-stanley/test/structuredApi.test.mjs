import { test } from "node:test";
import assert from "node:assert/strict";
import adapter, { MS_ACTIVITY_ROWS_KEY } from "../src/adapter.mjs";
import { createFixtureSession } from "../fixtures/session.mjs";
import {
  POSTED_ACTIVITY_COUNT,
  ROW_8_MISSING_CURRENCY,
  ROW_9_FOREIGN_CURRENCY,
} from "../fixtures/activity.mjs";

const SELECTION = { kind: "structured_api", periodStart: "2025-01-01", periodEnd: "2025-02-28" };

/** Resolves a json_pointer_v1 pointer against the retained bytes the same
 * way a downstream reader would: by literal source text, not a re-decoded
 * value, so this proves the binding actually addresses what is on disk. */
function resolveJsonPointer(bytes, pointer) {
  const text = new TextDecoder().decode(bytes);
  const sourceTokens = JSON.parse(text, (_key, value, context) =>
    context?.source === undefined ? value : context.source,
  );
  const segments = pointer.split("/").filter((s) => s.length > 0);
  let node = sourceTokens;
  for (const segment of segments) {
    node = node[/^\d+$/.test(segment) ? Number(segment) : segment];
  }
  return node;
}

test("acquire paginates to the provider's postedActivityCount and retains every page verbatim", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });

  assert.equal(acquired.manifest.kind, "structured_api");
  assert.equal(acquired.manifest.reportedRowCount, POSTED_ACTIVITY_COUNT);
  assert.deepEqual(acquired.manifest.gaps, []);
  assert.equal(acquired.manifest.mediaType, "application/json");

  const retainedJson = JSON.parse(new TextDecoder().decode(acquired.bytes));
  assert.equal(retainedJson.pages.length, 3, "all three pages are captured, including the overlap page");
  const rowCounts = retainedJson.pages.map((p) => p.Result[MS_ACTIVITY_ROWS_KEY].length);
  assert.deepEqual(rowCounts, [3, 3, 2], "no row is ever dropped from the capture on account of the overlap");
});

test("acquire records an AcquisitionGap and never claims exhaustive coverage when a page fails", async () => {
  const session = createFixtureSession({ activityFailAtPage: 2 });
  const acquired = await adapter.acquire({ ...SELECTION, session });

  assert.equal(acquired.manifest.gaps.length, 1);
  assert.match(acquired.manifest.gaps[0].reason, /stopped before page 2/);
  const retainedJson = JSON.parse(new TextDecoder().decode(acquired.bytes));
  assert.equal(retainedJson.pages.length, 1, "only the pages that succeeded are captured");
});

test("parse returns one ParsedRow per row instance (dedupe is the importer's job, not parse's)", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "structured_api", bytes: acquired.bytes });

  assert.equal(parsed.activity.length, 8, "3 + 3 + 2 rows across the three pages, overlap included");
  assert.deepEqual(parsed.holdings, { positions: [], balances: [], liabilities: [] });

  const bySourceDoc = new Map();
  for (const row of parsed.activity) {
    bySourceDoc.set(row.sourceDocument, (bySourceDoc.get(row.sourceDocument) ?? 0) + 1);
  }
  assert.deepEqual(
    [...bySourceDoc.entries()].sort(),
    [
      ["activity-page-1", 3],
      ["activity-page-2", 3],
      ["activity-page-3", 2],
    ],
  );
});

test("money is exact decimal text, signed by the activity-to-sign table, never a float", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "structured_api", bytes: acquired.bytes });
  const byActivity = (type, description) =>
    parsed.activity.find((r) => r.activityType === type && r.description.startsWith(description));

  const treasury = byActivity("Bought", "TREASURY");
  assert.equal(treasury.amount, "-9875");
  assert.equal(treasury.quantity, "10000", "an acquisition is positive");
  assert.equal(treasury.price, "98.75");
  assert.equal(treasury.description, "TREASURY BILL PURCHASE\nRATE:4.500 DUE:2026-03-15");
  assert.deepEqual(treasury.instrument, { symbol: null, cusip: "912796ZZ1", isin: null, name: null });
  assert.equal(typeof treasury.amount, "string");
  assert.equal(typeof treasury.quantity, "string");

  const sell = byActivity("Sold", "EQUITY SALE");
  assert.equal(sell.quantity, "-25", "a disposal is negative");
  assert.equal(sell.amount, "5321.1");
  assert.equal(sell.price, "212.844");

  const payment = byActivity("ACH Disbursement", "AUTOMATED PAYMENT");
  assert.equal(payment.amount, "-150");
  assert.equal(payment.quantity, null);
  assert.equal(
    payment.description,
    "AUTOMATED PAYMENT\nPAYEE:Example Utility Co\nACCT:...4821",
  );

  const fee = byActivity("Fee", "ACCOUNT MAINTENANCE FEE");
  assert.equal(fee.amount, null);
  assert.match(fee.amountNote, /unparseable amount/);
  assert.ok(fee.locators.amount, "an ambiguous amount carries its own locator, per rule 5");

  const unknown = byActivity("Zzyzx Adjustment", "UNCLASSIFIED");
  assert.equal(
    unknown.quantity,
    null,
    "an unreviewed activity value with a non-zero quantity routes to review, never a guessed sign",
  );
});

test("the load-bearing amount carries a json_pointer_v1 binding that resolves against the retained bytes", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "structured_api", bytes: acquired.bytes });

  for (const row of parsed.activity) {
    const binding = row.locators.row.binding;
    assert.equal(binding.format, "json_pointer_v1");
    const resolved = resolveJsonPointer(acquired.bytes, binding.pointer);
    assert.equal(resolved, binding.rawValue, `pointer ${binding.pointer} must resolve to its own rawValue`);
  }
});

test("a pull that captures more unique rows than the provider stated is a defect, not a rounding error", async () => {
  // A minimal session whose page 1 alone already holds two unique rows while
  // the provider claims only one -- the shape ground rule 7 refuses to round off.
  const overclaimingSession = {
    institutionSlug: "morgan-stanley",
    async fetchText(path, query) {
      assert.equal(path, "/activity");
      assert.equal(query.page, "1");
      return JSON.stringify({
        Result: {
          postedActivityCount: 1,
          [MS_ACTIVITY_ROWS_KEY]: [
            { processDate: "2025-01-01", activity: "Bought", description: "A", amount: 1, quantity: null, price: null, symbol: "-", cusip: null, keyAccount: "MS-ACCT-0001", checkNumber: null },
            { processDate: "2025-01-02", activity: "Bought", description: "B", amount: 2, quantity: null, price: null, symbol: "-", cusip: null, keyAccount: "MS-ACCT-0001", checkNumber: null },
          ],
        },
      });
    },
    async fetchBytes() {
      throw new Error("not used");
    },
  };
  await assert.rejects(
    adapter.acquire({ ...SELECTION, session: overclaimingSession }),
    /activity pull defect: captured 2 unique row\(s\) but the provider stated postedActivityCount=1/,
  );
});

test("CCY becomes the row currency; a missing or non-three-letter CCY routes an otherwise-valid amount to review", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "structured_api", bytes: acquired.bytes });
  const treasury = parsed.activity.find((r) => r.description.startsWith("TREASURY"));
  assert.equal(treasury.currency, "USD");

  const missingCurrencySession = {
    institutionSlug: "morgan-stanley",
    async fetchText(path, query) {
      assert.equal(path, "/activity");
      assert.equal(query.page, "1");
      return JSON.stringify({
        Result: { postedActivityCount: 1, [MS_ACTIVITY_ROWS_KEY]: [ROW_8_MISSING_CURRENCY] },
      });
    },
    async fetchBytes() {
      throw new Error("not used");
    },
  };
  const acquired2 = await adapter.acquire({ ...SELECTION, session: missingCurrencySession });
  const parsed2 = await adapter.parse({ kind: "structured_api", bytes: acquired2.bytes });
  assert.equal(parsed2.activity.length, 1);
  assert.equal(parsed2.activity[0].amount, null, "a currency problem routes the row to review like an ambiguous amount");
  assert.match(parsed2.activity[0].amountNote, /missing or non-three-letter CCY/);
  assert.equal(parsed2.activity[0].currency, "USD", "the base currency is carried with the amount nulled, so no money is asserted under an unstated code");
});

test("live US dates normalize to ISO and anything else passes through for the importer to refuse", async () => {
  const { normalizeActivityDate } = await import("../src/adapter.mjs");
  assert.equal(normalizeActivityDate("09/10/2026\n"), "2026-09-10");
  assert.equal(normalizeActivityDate("2026-09-10"), "2026-09-10");
  assert.equal(normalizeActivityDate("10 Sep 2026"), "10 Sep 2026");
  assert.equal(normalizeActivityDate(null), null);
});

test("each row is attributed to its own account, so an institution-wide pull does not collapse", async () => {
  const session = createFixtureSession();
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "structured_api", bytes: acquired.bytes });

  // AccountInformation.Grouping is "All": one pull returns every account's
  // rows, each naming its own. Without accountExternalKey every row here
  // would import under whichever single account the selection named.
  const dividend = parsed.activity.find((r) => r.activityType === "Dividend Received");
  assert.equal(dividend.accountExternalKey, "MS-ACCT-0003");
  const treasury = parsed.activity.find((r) => r.description.startsWith("TREASURY"));
  assert.equal(treasury.accountExternalKey, "MS-ACCT-0001");
  assert.equal(new Set(parsed.activity.map((r) => r.accountExternalKey)).size, 2);
  assert.ok(parsed.activity.every((r) => typeof r.accountExternalKey === "string"));
});

test("every key a parsed row carries is one discover() reports, so it resolves downstream", async () => {
  const session = createFixtureSession();
  const { accounts } = await adapter.discover(session);
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "structured_api", bytes: acquired.bytes });

  // adapterImport resolves accountExternalKey against the map run.ts builds
  // from these same accounts. A key outside that set opens an
  // unknown_account_key review item instead of importing.
  const discovered = new Set(accounts.map((a) => a.externalKey));
  for (const row of parsed.activity) {
    assert.ok(discovered.has(row.accountExternalKey), `${row.accountExternalKey} is not a discovered account`);
  }
});

test("F1-8b/F1-38: a foreign-currency row's stated FX rate is carried onto ParsedRow.fxRate", async () => {
  const session = {
    institutionSlug: "morgan-stanley",
    async fetchText(path, query) {
      assert.equal(path, "/activity");
      assert.equal(query.page, "1");
      return JSON.stringify({
        Result: { postedActivityCount: 1, [MS_ACTIVITY_ROWS_KEY]: [ROW_9_FOREIGN_CURRENCY] },
      });
    },
    async fetchBytes() {
      throw new Error("not used");
    },
  };
  const acquired = await adapter.acquire({ ...SELECTION, session });
  const parsed = await adapter.parse({ kind: "structured_api", bytes: acquired.bytes });

  assert.equal(parsed.activity.length, 1);
  const [row] = parsed.activity;
  assert.equal(row.currency, "EUR");
  assert.equal(row.amount, "-100");
  // The rate, not the unsigned fxSourceAmount: see resolveFxRate's own doc
  // comment for why only the rate is safe to carry without inventing a sign.
  assert.equal(row.fxRate, "1.0835");
  assert.equal(row.amountBase, undefined);

  const { resolveFxRate } = await import("../src/adapter.mjs");
  // A rate stated for a currency this row is not denominated in is not this
  // row's rate: nothing is carried rather than applying it anyway.
  assert.equal(
    resolveFxRate({ ...ROW_9_FOREIGN_CURRENCY, fxLocalCurrency: "GBP" }, "EUR"),
    null,
  );
  // The account's own base currency never needs a conversion.
  assert.equal(resolveFxRate(ROW_9_FOREIGN_CURRENCY, "USD"), null);
});

test("a window before last year, or spanning years, is a Custom date-range pull", async () => {
  const { selectDateRangeType } = await import("../src/adapter.mjs");
  const y = new Date().getUTCFullYear();
  assert.equal(selectDateRangeType(`${y - 3}-01-01`, `${y - 3}-12-31`), "Custom");
  assert.equal(selectDateRangeType(`${y - 2}-06-01`, `${y - 1}-06-01`), "Custom");
  assert.equal(selectDateRangeType(`${y - 1}-01-01`, `${y - 1}-12-31`), "LastYear");
});
