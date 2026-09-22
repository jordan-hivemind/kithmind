// The pure matching and boundary rules `import-archive` uses, tested with
// synthetic rows -- no database, no archive connection. `importArchive`
// itself (the orchestration, including the `kith.fin_transactions` upsert
// that has to see a real `min(date)` for the boundary rule to matter) is
// covered by packages/kith-store/test/finLedger.test.mjs instead, against a
// throwaway Postgres.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  bestIdentifier,
  buildHoldingsProfiles,
  earlierDate,
  isBeforeArchiveCutoff,
  mapArchiveActivityKind,
  matchArchiveAccount,
  matchArchiveInstrument,
  matchByBalance,
  matchByHoldingsOverlap,
  planArchiveAccountLink,
} from "../dist/index.js";

test("matchArchiveAccount matches by institution and mask first", () => {
  const archive = {
    id: "arch-1",
    institutionName: "Morgan Stanley",
    mask: "4321",
    name: "Individual Brokerage",
  };
  const candidates = [
    { id: "fin-1", institutionName: "Morgan Stanley", mask: "4321", name: "Different name entirely", plaidAccountId: "plaid-1" },
    { id: "fin-2", institutionName: "Morgan Stanley", mask: "9999", name: "Individual Brokerage", plaidAccountId: "plaid-2" },
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
    { id: "fin-1", institutionName: "Morgan Stanley", mask: null, name: "individual brokerage", plaidAccountId: "plaid-1" },
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
    { id: "fin-1", institutionName: "Vanguard", mask: "4321", name: "Individual Brokerage", plaidAccountId: "plaid-1" },
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

// FIN-3 regression: the owner's live-database audit found 12 brokerage
// archive accounts at one institution, all with a null display_name (so all
// fall back to archiveReader's "Unlabeled account" placeholder), collapsed
// onto one kith.fin_accounts row. matchArchiveAccount must never treat that
// placeholder -- or any other archive-only row -- as real match evidence.
test("matchArchiveAccount never matches on the null-display-name placeholder, even against an identical placeholder", () => {
  const archive = {
    id: "arch-2",
    institutionName: "Morgan Stanley",
    mask: "2222",
    name: "Unlabeled account",
  };
  // An archive-only row a previous archive account's own "create" left
  // behind: same placeholder name, no plaidAccountId. Before the fix, this
  // is exactly the kind of row matchArchiveAccount's name check could
  // collide two different archive accounts onto.
  const candidates = [
    { id: "fin-archive-only", institutionName: "Morgan Stanley", mask: "1111", name: "Unlabeled account", plaidAccountId: null },
  ];
  assert.equal(
    matchArchiveAccount(archive, candidates),
    null,
    "a placeholder name must never match, and an archive-only row (no plaidAccountId) must never be a match target",
  );
});

test("matchArchiveAccount never matches a real feed account by a placeholder name", () => {
  const archive = {
    id: "arch-3",
    institutionName: "Morgan Stanley",
    mask: null,
    name: "Unlabeled account",
  };
  const candidates = [
    { id: "fin-1", institutionName: "Morgan Stanley", mask: null, name: "Unlabeled account", plaidAccountId: "plaid-1" },
  ];
  assert.equal(matchArchiveAccount(archive, candidates), null, "neither side's placeholder name is usable evidence");
});

test("matchArchiveAccount ignores an archive-only candidate for mask matching too, not only name", () => {
  const archive = {
    id: "arch-4",
    institutionName: "Morgan Stanley",
    mask: "5555",
    name: "Something Real",
  };
  const candidates = [
    { id: "fin-archive-only", institutionName: "Morgan Stanley", mask: "5555", name: "Coincidence", plaidAccountId: null },
  ];
  assert.equal(matchArchiveAccount(archive, candidates), null);
});

// FIN-3 collapse repro: three archive accounts, same institution, same
// account_type, all with a null display_name (so all three share the exact
// same placeholder name), and no Plaid accounts to match against at all --
// the shape the owner's audit reported for the 12-brokerage-accounts bucket.
// Run purely through the two pure functions import-archive's per-account
// loop actually calls, in sequence, updating the in-memory candidate list
// exactly the way importArchive.ts does after each decision -- this must
// produce three distinct fin_accounts rows, never a collapse.
test("collapse repro: three same-institution, same-type archive accounts with a null display name each get their own row", () => {
  const archives = [
    { id: "arch-a", institutionName: "Morgan Stanley", mask: "1111", name: "Unlabeled account", accountType: "brokerage" },
    { id: "arch-b", institutionName: "Morgan Stanley", mask: "2222", name: "Unlabeled account", accountType: "brokerage" },
    { id: "arch-c", institutionName: "Morgan Stanley", mask: "3333", name: "Unlabeled account", accountType: "brokerage" },
  ];
  const candidates = [];
  const finAccountIdByArchiveId = new Map();
  let nextId = 0;
  for (const archive of archives) {
    const plan = planArchiveAccountLink(archive, candidates);
    assert.equal(plan.kind, "create", `${archive.id} should find no valid match target`);
    const id = `fin-${(nextId += 1)}`;
    candidates.push({
      id,
      institutionName: archive.institutionName,
      mask: archive.mask,
      name: archive.name,
      plaidAccountId: null,
      archiveAccountId: archive.id,
    });
    finAccountIdByArchiveId.set(archive.id, id);
  }
  assert.equal(new Set(finAccountIdByArchiveId.values()).size, 3, "three archive accounts, three distinct fin_accounts rows");
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

// earlierDate: what archive_coverage_through records -- the more
// conservative (earlier) of the transaction and snapshot boundaries.
test("earlierDate picks the earlier of two dates", () => {
  assert.equal(earlierDate("2026-01-01", "2026-06-01"), "2026-01-01");
  assert.equal(earlierDate("2026-06-01", "2026-01-01"), "2026-01-01");
});

test("earlierDate treats null as no bound, so the other side always wins", () => {
  assert.equal(earlierDate(null, "2026-06-01"), "2026-06-01");
  assert.equal(earlierDate("2026-06-01", null), "2026-06-01");
});

test("earlierDate is null only when both sides are null", () => {
  assert.equal(earlierDate(null, null), null);
});

// planArchiveAccountLink: the merge-into-feed-row decision, with synthetic
// fin_accounts rows -- no database. See importArchive.ts's own doc comment
// for the four outcomes this decides between.

const archive1 = {
  id: "arch-1",
  institutionName: "Morgan Stanley",
  mask: "4321",
  name: "Individual Brokerage",
};

test("planArchiveAccountLink: no existing link, matches an unclaimed feed row by mask", () => {
  const candidates = [
    {
      id: "fin-1",
      institutionName: "Morgan Stanley",
      mask: "4321",
      name: "Different name",
      plaidAccountId: "plaid-1",
      archiveAccountId: null,
    },
  ];
  assert.deepEqual(planArchiveAccountLink(archive1, candidates), {
    kind: "match",
    finAccountId: "fin-1",
    method: "mask",
  });
});

test("planArchiveAccountLink: no existing link and nothing matches creates a new archive-only row", () => {
  assert.deepEqual(planArchiveAccountLink(archive1, []), { kind: "create" });
});

test("planArchiveAccountLink: already linked to a row that also has a plaid_account_id reuses it, no write", () => {
  const candidates = [
    {
      id: "fin-1",
      institutionName: "Morgan Stanley",
      mask: "4321",
      name: "Individual Brokerage",
      plaidAccountId: "plaid-1",
      archiveAccountId: "arch-1",
    },
  ];
  assert.deepEqual(planArchiveAccountLink(archive1, candidates), {
    kind: "already-linked",
    finAccountId: "fin-1",
  });
});

test("planArchiveAccountLink: already linked to an archive-only row with no feed match yet stays archive-only", () => {
  const candidates = [
    {
      id: "fin-archive-only",
      institutionName: "Morgan Stanley",
      mask: "4321",
      name: "Individual Brokerage",
      plaidAccountId: null,
      archiveAccountId: "arch-1",
    },
  ];
  assert.deepEqual(planArchiveAccountLink(archive1, candidates), {
    kind: "already-linked",
    finAccountId: "fin-archive-only",
  });
});

test("planArchiveAccountLink: already linked to an archive-only row, and a feed row now matches, merges", () => {
  const candidates = [
    {
      id: "fin-archive-only",
      institutionName: "Morgan Stanley",
      mask: "4321",
      name: "Individual Brokerage",
      plaidAccountId: null,
      archiveAccountId: "arch-1",
    },
    {
      id: "fin-feed",
      institutionName: "Morgan Stanley",
      mask: "4321",
      name: "Brokerage (Plaid)",
      plaidAccountId: "plaid-1",
      archiveAccountId: null,
    },
  ];
  assert.deepEqual(planArchiveAccountLink(archive1, candidates), {
    kind: "merge",
    archiveOnlyFinAccountId: "fin-archive-only",
    feedFinAccountId: "fin-feed",
    method: "mask",
  });
});

test("planArchiveAccountLink: never re-matches by name onto a row already claimed by a different archive account", () => {
  const archive2 = {
    id: "arch-2",
    institutionName: "Morgan Stanley",
    mask: null,
    name: "Brokerage",
  };
  const candidates = [
    {
      id: "fin-1",
      institutionName: "Morgan Stanley",
      mask: "1111",
      name: "Brokerage",
      plaidAccountId: "plaid-1",
      // Already claimed by a different archive account this run.
      archiveAccountId: "arch-1",
    },
  ];
  assert.deepEqual(planArchiveAccountLink(archive2, candidates), { kind: "create" });
});

test("planArchiveAccountLink: a manual override wins even when mask/name would have picked a different row", () => {
  const candidates = [
    {
      id: "fin-mask-match",
      institutionName: "Morgan Stanley",
      mask: "4321",
      name: "Individual Brokerage",
      plaidAccountId: "plaid-mask-match",
      archiveAccountId: null,
    },
    {
      id: "fin-manual-target",
      institutionName: "Morgan Stanley",
      mask: "9999",
      name: "Something Else",
      plaidAccountId: "plaid-manual-target",
      archiveAccountId: null,
    },
  ];
  const plan = planArchiveAccountLink(archive1, candidates, { manualTarget: "plaid-manual-target" });
  assert.deepEqual(plan, { kind: "match", finAccountId: "fin-manual-target", method: "manual" });
});

test("planArchiveAccountLink: an explicit unlink (manualTarget null) never auto-matches", () => {
  const candidates = [
    {
      id: "fin-1",
      institutionName: "Morgan Stanley",
      mask: "4321",
      name: "Individual Brokerage",
      plaidAccountId: "plaid-1",
      archiveAccountId: null,
    },
  ];
  assert.deepEqual(planArchiveAccountLink(archive1, candidates, { manualTarget: null }), { kind: "create" });
});

test("planArchiveAccountLink: a precomputed holdings/balance match is used before the mask/name fallback", () => {
  const candidates = [
    {
      id: "fin-precomputed",
      institutionName: "Morgan Stanley",
      mask: "9999",
      name: "Something Else",
      plaidAccountId: "plaid-precomputed",
      archiveAccountId: null,
    },
  ];
  const plan = planArchiveAccountLink(archive1, candidates, {
    precomputed: { finAccountId: "fin-precomputed", method: "holdings" },
  });
  assert.deepEqual(plan, { kind: "match", finAccountId: "fin-precomputed", method: "holdings" });
});

// -- Holdings-overlap and balance matching -----------------------------------

test("bestIdentifier prefers CUSIP, then ISIN, then ticker, and prefixes each kind so they never collide", () => {
  assert.equal(bestIdentifier("037833100", "US0378331005", "AAPL"), "cusip:037833100");
  assert.equal(bestIdentifier(null, "US0378331005", "AAPL"), "isin:US0378331005");
  assert.equal(bestIdentifier(null, null, "aapl"), "ticker:AAPL");
  assert.equal(bestIdentifier(null, null, null), null);
  assert.equal(bestIdentifier("", "", ""), null, "blank strings are not usable identifiers");
});

test("buildHoldingsProfiles keeps only each account's latest as_of and sums repeated identifiers there", () => {
  const profiles = buildHoldingsProfiles([
    { accountId: "a", asOf: "2024-01-01", identifier: "cusip:1", quantity: 100 },
    { accountId: "a", asOf: "2024-06-01", identifier: "cusip:1", quantity: 5 },
    { accountId: "a", asOf: "2024-06-01", identifier: "cusip:1", quantity: 3 },
    { accountId: "a", asOf: "2024-06-01", identifier: "cusip:2", quantity: 10 },
  ]);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].accountId, "a");
  assert.equal(profiles[0].identifiers.get("cusip:1"), 8, "the stale 2024-01-01 row is dropped, and the two latest-date rows for the same identifier are summed");
  assert.equal(profiles[0].identifiers.get("cusip:2"), 10);
});

test("matchByHoldingsOverlap links each archive account to its correct Plaid account by shared holdings, even with masks that would suggest the opposite pairing", () => {
  const archiveProfiles = [
    { accountId: "arch-1", identifiers: new Map([["cusip:AAA", 10], ["cusip:BBB", 20], ["cusip:CCC", 30]]) },
    { accountId: "arch-2", identifiers: new Map([["cusip:XXX", 5], ["cusip:YYY", 7]]) },
  ];
  const candidateProfiles = [
    { accountId: "fin-1", identifiers: new Map([["cusip:XXX", 5], ["cusip:YYY", 7]]) },
    { accountId: "fin-2", identifiers: new Map([["cusip:AAA", 10], ["cusip:BBB", 20], ["cusip:CCC", 30]]) },
  ];
  const matches = matchByHoldingsOverlap(archiveProfiles, candidateProfiles);
  assert.deepEqual(
    matches.sort((a, b) => a.archiveAccountId.localeCompare(b.archiveAccountId)),
    [
      { archiveAccountId: "arch-1", finAccountId: "fin-2", method: "holdings" },
      { archiveAccountId: "arch-2", finAccountId: "fin-1", method: "holdings" },
    ],
  );
});

test("matchByHoldingsOverlap requires at least 2 shared identifiers and 0.6 Jaccard, and never double-books a candidate", () => {
  const archiveProfiles = [
    { accountId: "arch-1", identifiers: new Map([["cusip:AAA", 1]]) },
    { accountId: "arch-2", identifiers: new Map([["cusip:BBB", 1], ["cusip:CCC", 1], ["cusip:DDD", 1], ["cusip:EEE", 1]]) },
  ];
  const candidateProfiles = [
    { accountId: "fin-1", identifiers: new Map([["cusip:AAA", 1], ["cusip:BBB", 1]]) },
    { accountId: "fin-2", identifiers: new Map([["cusip:BBB", 1], ["cusip:CCC", 1], ["cusip:DDD", 1]]) },
  ];
  const matches = matchByHoldingsOverlap(archiveProfiles, candidateProfiles);
  // arch-1 shares only 1 identifier with fin-1 (below minShared) -- no match.
  // arch-2 shares 3 of 4 with fin-2 (jaccard 3/5 = 0.6) -- matches, and fin-1
  // (already not a candidate for arch-2) is left unused.
  assert.deepEqual(matches, [{ archiveAccountId: "arch-2", finAccountId: "fin-2", method: "holdings" }]);
});

test("matchByBalance links a loan by balance equality within tolerance and a nearby date", () => {
  const archiveProfiles = [{ accountId: "arch-loan", asOf: "2024-03-01", value: -12000 }];
  const candidateProfiles = [
    { accountId: "fin-unrelated", asOf: "2024-03-05", value: -500 },
    { accountId: "fin-loan", asOf: "2024-03-10", value: -12050 },
  ];
  const matches = matchByBalance(archiveProfiles, candidateProfiles);
  assert.deepEqual(matches, [{ archiveAccountId: "arch-loan", finAccountId: "fin-loan", method: "balance" }]);
});

test("matchByBalance rejects a match past the day-gap window or the tolerance", () => {
  const tooFar = matchByBalance(
    [{ accountId: "arch-1", asOf: "2024-01-01", value: 1000 }],
    [{ accountId: "fin-1", asOf: "2024-04-01", value: 1000 }],
  );
  assert.deepEqual(tooFar, [], "91 days apart is outside the default 45-day window");

  const tooDifferent = matchByBalance(
    [{ accountId: "arch-2", asOf: "2024-01-01", value: 1000 }],
    [{ accountId: "fin-2", asOf: "2024-01-10", value: 1200 }],
  );
  assert.deepEqual(tooDifferent, [], "20% apart is outside the default 1% tolerance");
});

// Regression guard: every archive query in `archiveReader` schema-qualifies
// its tables (`${schema}.accounts`, not a bare `accounts`) rather than
// relying only on the connection's `search_path` pin. Reads the TypeScript
// source directly -- a query never becomes a shared constant, so there is
// nothing to import and assert on at runtime; the source text is the
// closest thing to "the module's query constants" this module has.
test("archiveReader's SQL always schema-qualifies the archive's tables, never a bare table name", () => {
  const sourcePath = fileURLToPath(new URL("../src/importArchive.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");
  const readerSource = source.slice(
    source.indexOf("export function archiveReader"),
    source.indexOf("export async function assertArchiveSchemaReady"),
  );
  assert.ok(readerSource.length > 0, "archiveReader's own source slice should not be empty");

  const archiveTables = ["accounts", "institutions", "instruments", "transactions", "positions", "balances"];

  // No bare "FROM accounts" / "JOIN institutions" etc. -- a regression back
  // to an unqualified reference would match this and fail the test.
  const bareReference = new RegExp(`\\b(FROM|JOIN)\\s+(${archiveTables.join("|")})\\b`);
  assert.equal(
    bareReference.test(readerSource),
    false,
    "found a bare (unqualified) reference to an archive table",
  );

  // Every one of the six tables is actually read, schema-qualified.
  for (const table of archiveTables) {
    assert.ok(
      readerSource.includes(`\${schema}.${table}`),
      `expected a schema-qualified reference to ${table}`,
    );
  }
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
