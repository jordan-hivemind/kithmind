// The pure matching and boundary rules `import-archive` uses, tested with
// synthetic rows -- no database, no archive connection. `importArchive`
// itself (the orchestration, including the `kith.fin_transactions` upsert
// that has to see a real `min(date)` for the boundary rule to matter) is
// covered by packages/kith-store/test/finLedger.test.mjs instead, against a
// throwaway Postgres.

import assert from "node:assert/strict";
import test from "node:test";

import {
  isBeforeArchiveCutoff,
  mapArchiveActivityKind,
  matchArchiveAccount,
  matchArchiveInstrument,
} from "../dist/index.js";

test("matchArchiveAccount matches by institution and mask first", () => {
  const archive = {
    id: "arch-1",
    institutionName: "Morgan Stanley",
    mask: "4321",
    name: "Individual Brokerage",
  };
  const candidates = [
    { id: "fin-1", institutionName: "Morgan Stanley", mask: "4321", name: "Different name entirely" },
    { id: "fin-2", institutionName: "Morgan Stanley", mask: "9999", name: "Individual Brokerage" },
  ];
  assert.deepEqual(matchArchiveAccount(archive, candidates), { id: "fin-1", method: "mask" });
});

test("matchArchiveAccount falls back to institution and name when the mask does not match", () => {
  const archive = {
    id: "arch-1",
    institutionName: "Morgan Stanley",
    mask: "4321",
    name: "Individual Brokerage",
  };
  const candidates = [
    { id: "fin-1", institutionName: "Morgan Stanley", mask: null, name: "individual brokerage" },
  ];
  assert.deepEqual(matchArchiveAccount(archive, candidates), { id: "fin-1", method: "name" });
});

test("matchArchiveAccount never matches across institutions", () => {
  const archive = {
    id: "arch-1",
    institutionName: "Morgan Stanley",
    mask: "4321",
    name: "Individual Brokerage",
  };
  const candidates = [
    { id: "fin-1", institutionName: "Vanguard", mask: "4321", name: "Individual Brokerage" },
  ];
  assert.equal(matchArchiveAccount(archive, candidates), null);
});

test("matchArchiveAccount returns null when nothing matches, so the caller creates a new account", () => {
  const archive = {
    id: "arch-1",
    institutionName: "Morgan Stanley",
    mask: "4321",
    name: "Individual Brokerage",
  };
  assert.equal(matchArchiveAccount(archive, []), null);
});

test("matchArchiveInstrument matches by ticker, then CUSIP, then ISIN", () => {
  const byTicker = matchArchiveInstrument(
    { id: "i-1", symbol: "VTSAX", cusip: null, isin: null, name: null, kind: null },
    [{ id: "s-1", ticker: "vtsax", cusip: null, isin: null }],
  );
  assert.equal(byTicker, "s-1");

  const byCusip = matchArchiveInstrument(
    { id: "i-2", symbol: null, cusip: "037833100", isin: null, name: null, kind: null },
    [{ id: "s-2", ticker: null, cusip: "037833100", isin: null }],
  );
  assert.equal(byCusip, "s-2");

  const byIsin = matchArchiveInstrument(
    { id: "i-3", symbol: null, cusip: null, isin: "US0378331005", name: null, kind: null },
    [{ id: "s-3", ticker: null, cusip: null, isin: "US0378331005" }],
  );
  assert.equal(byIsin, "s-3");

  const noMatch = matchArchiveInstrument(
    { id: "i-4", symbol: "UNKNOWN", cusip: null, isin: null, name: null, kind: null },
    [{ id: "s-4", ticker: "OTHER", cusip: null, isin: null }],
  );
  assert.equal(noMatch, null);
});

// The date-boundary rule: an account with Plaid transactions already in the
// ledger only gets archive transactions strictly before the earliest one;
// an account with none gets its whole archive history.
test("isBeforeArchiveCutoff: strictly before the cutoff when the account has Plaid data", () => {
  assert.equal(isBeforeArchiveCutoff("2026-01-01", "2026-06-01"), true);
  assert.equal(isBeforeArchiveCutoff("2026-06-01", "2026-06-01"), false, "the boundary date itself is not imported");
  assert.equal(isBeforeArchiveCutoff("2026-09-01", "2026-06-01"), false);
});

test("isBeforeArchiveCutoff: everything passes when the account has no Plaid data yet", () => {
  assert.equal(isBeforeArchiveCutoff("2020-01-01", null), true);
  assert.equal(isBeforeArchiveCutoff("2026-09-22", null), true);
});

test("mapArchiveActivityKind maps the archive's free-text activity_type onto the shared kind vocabulary", () => {
  assert.equal(mapArchiveActivityKind("Dividend Received"), "dividend");
  assert.equal(mapArchiveActivityKind("Margin Interest"), "interest");
  assert.equal(mapArchiveActivityKind("Buy"), "buy");
  assert.equal(mapArchiveActivityKind("Sell to Close"), "sell");
  assert.equal(mapArchiveActivityKind("Advisory Fee"), "fee");
  assert.equal(mapArchiveActivityKind("Wire Transfer"), "transfer");
  assert.equal(mapArchiveActivityKind("Cash Deposit"), "deposit");
  assert.equal(mapArchiveActivityKind("Withdrawal"), "withdrawal");
  assert.equal(mapArchiveActivityKind("Bill Payment"), "payment");
  assert.equal(mapArchiveActivityKind("Something Unrecognized"), "other");
});
