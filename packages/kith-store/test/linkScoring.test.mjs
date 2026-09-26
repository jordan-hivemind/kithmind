// The deterministic scorer (ADM-8b, slice 1), on its own.
//
// No database. `src/admin/linkScoring.ts` is pure by construction, and these
// tests are what that buys: every threshold is exercised at its boundary on
// both sides, the exact-decimal comparison is checked a cent either side of
// the tolerance, and a partial date is checked to score nothing anywhere.
//
// Every fixture below is synthetic. No real fund, no real amount.

import assert from "node:assert/strict";
import test from "node:test";

import {
  amountMatches,
  calendarDays,
  dateInWindow,
  decideInvestmentLevelLinks,
  decideLinks,
  isInvestmentLevelKind,
  LINK_AUTO_POINTS,
  LINK_SIGNAL_POINTS,
  LINK_SUGGEST_POINTS,
  LINK_TIE_MARGIN_POINTS,
  matchableKind,
  MATCHABLE_DOCUMENT_KINDS,
  normalizeMatchName,
  organizationMatchKey,
  pathNamesFromUri,
  rateToleranceCents,
  RATE_TOLERANCE_FLOOR_CENTS,
  RATE_TOLERANCE_FRACTION,
  scoreCandidate,
  scoreInvestmentLevel,
} from "../dist/admin/index.js";
import { normalizeEntityName } from "../dist/memory/index.js";

const CALL = matchableKind("capital_call_notice");
const AGREEMENT = matchableKind("investment_agreement");
const K1 = matchableKind("schedule_k1");

function statement(field, valueType, value, suffix = "1") {
  return {
    field,
    valueType,
    observationKey: field,
    evidenceSpanId: `span${suffix}`.padEnd(20, "0"),
    value,
  };
}

const FUND = statement("fund", "organization", {
  type: "text",
  value: "Synthetic Growth Partners III",
});

function called(amount, currency = "USD") {
  return statement("amount_called", "money", { type: "money", amount, currency }, "2");
}

function due(value, precision) {
  return statement(
    "due_date",
    "date",
    precision === undefined
      ? { type: "date", value }
      : { type: "date", value, precision },
    "3",
  );
}

const INVESTMENT = {
  id: "investment0000000001",
  normalizedNames: ["synthetic growth partners iii", "sgp iii"],
  signedOn: null,
};

function entry(overrides = {}) {
  return {
    id: "entry000000000000001",
    investmentId: INVESTMENT.id,
    entryType: "capital_call_paid",
    entryDate: "2026-03-10",
    amount: "25000.00",
    currency: "USD",
    exchangeRate: null,
    dateIsEstimated: false,
    hasLiveLink: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The constants themselves
// ---------------------------------------------------------------------------

test("the points and thresholds are section 2's, exactly", () => {
  assert.deepEqual(LINK_SIGNAL_POINTS, {
    party: 4,
    amount: 4,
    date: 2,
    path: 1,
  });
  assert.equal(LINK_AUTO_POINTS, 10);
  assert.equal(LINK_SUGGEST_POINTS, 4);
  assert.equal(LINK_TIE_MARGIN_POINTS, 2);
  // The importer's own rule, not a second one invented here: the larger of
  // 1% or $1.00 (`investment-import.ts`).
  assert.equal(RATE_TOLERANCE_FRACTION, 100n);
  assert.equal(RATE_TOLERANCE_FLOOR_CENTS, 100n);
});

test("only the three payment kinds may ever auto-link", () => {
  const autoLinkable = MATCHABLE_DOCUMENT_KINDS.filter((kind) => kind.autoLinkable)
    .map((kind) => kind.kind)
    .sort();
  assert.deepEqual(autoLinkable, [
    "capital_call_notice",
    "distribution_notice",
    "wire_confirmation",
  ]);
});

test("a kind this scorer has no rules for produces nothing", () => {
  assert.equal(matchableKind("brokerage_statement"), null);
  assert.equal(matchableKind("receipt"), null);
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test("the scorer's fold is the entity store's fold", () => {
  // The aliases this scorer matches against were written by
  // `normalizeEntityName`. Two different folds would never meet.
  for (const name of [
    "Synthetic Growth Partners III",
    "  SYNTHETIC   growth-partners_III ",
    "Ålborg Ventures",
    "a".repeat(200),
  ]) {
    assert.equal(normalizeMatchName(name), normalizeEntityName(name), name);
  }
});

test("the scorer's fold refuses what the entity store's throws on", () => {
  assert.throws(() => normalizeEntityName(""));
  assert.equal(normalizeMatchName(""), "");
  assert.equal(normalizeMatchName("a".repeat(201)), "");
  assert.equal(normalizeMatchName(null), "");
  assert.equal(normalizeMatchName("with\0null"), "");
});

test("a uri offers its folders and its file stem, never its root alias", () => {
  assert.deepEqual(
    pathNamesFromUri(
      "fs://archive/Investments/Synthetic%20Growth%20Partners%20III/call-2026-03.pdf",
    ),
    ["investments", "synthetic growth partners iii", "call 2026 03.pdf", "call 2026 03"],
  );
  assert.deepEqual(pathNamesFromUri(null), []);
  assert.deepEqual(pathNamesFromUri(""), []);
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test("same-currency amounts match exactly and with no tolerance at all", () => {
  const same = (documentAmount, entryAmount) =>
    amountMatches({
      documentAmount,
      documentCurrency: "USD",
      entryAmount,
      entryCurrency: "USD",
      entryExchangeRate: null,
    }).matched;
  assert.equal(same("25000.00", "25000.00"), true);
  // Trailing zeros are not a difference of fact; a cent is.
  assert.equal(same("25000", "25000.000000"), true);
  assert.equal(same("25000.01", "25000.00"), false);
  assert.equal(same("24999.99", "25000.00"), false);
  // A reduced commitment is a negative entry against a document that states
  // the magnitude.
  assert.equal(same("50000.00", "-50000.00"), true);
});

test("the cross-currency tolerance is the larger of 1% and $1.00", () => {
  // 1% of $50 is 50 cents, under the floor.
  assert.equal(rateToleranceCents(5_000n), RATE_TOLERANCE_FLOOR_CENTS);
  // 1% of $1,000 is $10, over it.
  assert.equal(rateToleranceCents(100_000n), 1_000n);
  // Exactly at the crossover: 1% of $100 is $1.00, which is not GREATER than
  // the floor, so the floor is used. Same number either way.
  assert.equal(rateToleranceCents(10_000n), RATE_TOLERANCE_FLOOR_CENTS);
});

test("a USD document scores against a GBP entry through the entry's own rate", () => {
  // 10,000 GBP at 1.2734 is 12,734.00 USD, and the tolerance is 1% OF THE
  // DOCUMENT'S own stated amount -- the importer's rule, measured against the
  // independently stated figure rather than the converted one. That is why
  // the two edges are not symmetric about 12,734.00.
  const at = (documentAmount) =>
    amountMatches({
      documentAmount,
      documentCurrency: "USD",
      entryAmount: "10000.00",
      entryCurrency: "GBP",
      entryExchangeRate: "1.2734",
    }).matched;
  assert.equal(at("12734.00"), true);
  assert.equal(at("12862.62"), true, "exactly at the tolerance");
  assert.equal(at("12862.63"), false, "one cent past it");
  assert.equal(at("12607.93"), true, "exactly at the tolerance, below");
  assert.equal(at("12607.92"), false, "one cent past it, below");
});

test("a non-USD document against a USD entry scores nothing, because no rate exists", () => {
  // The rate lives on the entry. A USD entry has none, and inventing one is
  // the fabrication this design refuses; the cost is a suggestion instead of
  // an auto-link, never a wrong link.
  assert.equal(
    amountMatches({
      documentAmount: "10000.00",
      documentCurrency: "GBP",
      entryAmount: "12734.00",
      entryCurrency: "USD",
      entryExchangeRate: null,
    }).matched,
    false,
  );
});

test("a non-USD entry with no recorded rate scores nothing", () => {
  assert.equal(
    amountMatches({
      documentAmount: "12734.00",
      documentCurrency: "USD",
      entryAmount: "10000.00",
      entryCurrency: "GBP",
      entryExchangeRate: null,
    }).matched,
    false,
  );
});

test("a malformed amount is refused rather than coerced", () => {
  assert.equal(
    amountMatches({
      documentAmount: "25,000.00",
      documentCurrency: "USD",
      entryAmount: "25000.00",
      entryCurrency: "USD",
      entryExchangeRate: null,
    }).matched,
    false,
  );
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test("a date that is not a date is not a date", () => {
  assert.equal(calendarDays("2026-02-31"), null);
  assert.equal(calendarDays("2026-3-1"), null);
  assert.equal(calendarDays("2026-03-01"), 20513);
});

test("the window is inclusive at exactly its edge and closed one day past it", () => {
  const at = (documentDate) =>
    dateInWindow({
      documentDate,
      precision: "day",
      window: { anchor: "entry", days: 30 },
      entryDate: "2026-03-10",
      investmentSignedOn: null,
    });
  assert.equal(at("2026-03-10"), true);
  assert.equal(at("2026-04-09"), true, "exactly 30 days after");
  assert.equal(at("2026-04-10"), false, "31 days after");
  assert.equal(at("2026-02-08"), true, "exactly 30 days before");
  assert.equal(at("2026-02-07"), false, "31 days before");
});

test("a year or month precision date never satisfies a window", () => {
  const at = (precision, documentDate) =>
    dateInWindow({
      documentDate,
      precision,
      window: { anchor: "entry", days: 30 },
      entryDate: "2026-03-10",
      investmentSignedOn: null,
    });
  assert.equal(at("day", "2026-03-11"), true);
  assert.equal(at("month", "2026-03"), false);
  assert.equal(at("year", "2026"), false);
  // Even a full ISO date carrying a partial precision is refused: the
  // precision is the claim, not the string's shape.
  assert.equal(at("month", "2026-03-11"), false);
});

test("the agreement window uses signed_on, and the entry date when there is none", () => {
  const window = { anchor: "investmentSignedOnElseEntry", days: 90 };
  assert.equal(
    dateInWindow({
      documentDate: "2024-01-15",
      precision: "day",
      window,
      entryDate: "2026-03-10",
      investmentSignedOn: "2024-02-01",
    }),
    true,
  );
  // Without the fallback this would be false, and the fallback is exactly the
  // case the date rule exists for: an imported commitment has no signed_on.
  assert.equal(
    dateInWindow({
      documentDate: "2026-02-01",
      precision: "day",
      window,
      entryDate: "2026-03-10",
      investmentSignedOn: null,
    }),
    true,
  );
});

test("a kind with no date window never scores a date", () => {
  assert.equal(
    dateInWindow({
      documentDate: "2026-03-10",
      precision: "day",
      window: K1.dateWindow,
      entryDate: "2026-03-10",
      investmentSignedOn: null,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Scoring one candidate
// ---------------------------------------------------------------------------

function score(statements, overrides = {}, pathNames = []) {
  return scoreCandidate({
    kind: CALL,
    statements,
    investment: INVESTMENT,
    entry: entry(overrides),
    pathNames,
  });
}

test("each signal scores what section 2 says it scores", () => {
  assert.equal(score([FUND]).score, 4);
  assert.equal(score([called("25000.00")]).score, 4);
  assert.equal(score([due("2026-03-12")]).score, 2);
  assert.equal(score([], {}, ["synthetic growth partners iii"]).score, 1);
  const all = score([FUND, called("25000.00"), due("2026-03-12")], {}, ["sgp iii"]);
  assert.equal(all.score, 11);
  assert.equal(all.reason, "party+amount+date+path");
});

test("a link cites the statements it was decided from, and only those", () => {
  const scored = score([FUND, called("25000.00"), due("2026-03-12")]);
  assert.deepEqual(
    scored.evidence.map((item) => item.field),
    ["fund", "amount_called", "due_date"],
  );
  for (const cited of scored.evidence) {
    assert.equal(typeof cited.observationKey, "string");
    assert.match(cited.evidenceSpanId, /^span/);
  }
});

test("the path signal cites nothing, because a folder name is not a statement", () => {
  const scored = score([], {}, ["sgp iii"]);
  assert.equal(scored.score, 1);
  assert.deepEqual(scored.evidence, []);
});

test("a money field this kind does not name is not an amount match", () => {
  // A capital call notice states `total_commitment` beside the amount it is
  // actually calling. Matching on that would link a notice to a commitment.
  const commitment = statement(
    "total_commitment",
    "money",
    { type: "money", amount: "25000.00", currency: "USD" },
    "9",
  );
  assert.equal(score([commitment]).score, 0);
});

test("an organization value that names a different fund scores nothing", () => {
  const other = statement("fund", "organization", {
    type: "text",
    value: "Other Synthetic Fund",
  });
  assert.equal(score([other]).score, 0);
});

test("an investment-level candidate scores party and path only", () => {
  const scored = scoreCandidate({
    kind: K1,
    statements: [
      statement("partnership", "organization", {
        type: "text",
        value: "SGP III",
      }),
      statement("capital_gain", "money", {
        type: "money",
        amount: "25000.00",
        currency: "USD",
      }),
    ],
    investment: INVESTMENT,
    entry: null,
    pathNames: [],
  });
  assert.equal(scored.score, 4);
  assert.equal(scored.entryId, null);
  assert.equal(scored.dateReplacement, null);
});

test("a date replacement is offered only from a field the kind may date from", () => {
  const withDue = score([FUND, called("25000.00"), due("2026-03-12")]);
  assert.deepEqual(withDue.dateReplacement, {
    field: "due_date",
    date: "2026-03-12",
    observationKey: "due_date",
    evidenceSpanId: "span3000000000000000",
  });
  // `notice_date` satisfies the window but is not a replacement field: a call
  // is paid on the day the money moved, not on the day it was announced.
  const noticeOnly = score([
    FUND,
    statement("notice_date", "date", { type: "date", value: "2026-03-12" }, "4"),
  ]);
  assert.equal(noticeOnly.fired.date, true);
  assert.equal(noticeOnly.dateReplacement, null);
});

test("a month-precision date offers no replacement, because it has no day", () => {
  const scored = score([FUND, called("25000.00"), due("2026-03", "month")]);
  assert.equal(scored.fired.date, false);
  assert.equal(scored.dateReplacement, null);
  assert.equal(scored.score, 8);
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function candidate(overrides) {
  return {
    investmentId: INVESTMENT.id,
    entryId: "entry000000000000001",
    score: 10,
    signals: [],
    evidence: [{ field: "fund", observationKey: "fund", evidenceSpanId: "s" }],
    fired: { party: true, amount: true, date: true, path: false },
    reason: "party+amount+date",
    dateReplacement: null,
    entryHasLiveLink: false,
    ...overrides,
  };
}

function decide(candidates, kind = CALL) {
  return decideLinks({ kind, candidates, maxSuggestions: 10 });
}

test("below the suggest threshold, nothing is written at all", () => {
  const three = candidate({
    score: 3,
    fired: { party: false, amount: false, date: true, path: true },
  });
  const decision = decide([three]);
  assert.equal(decision.autoLink, null);
  assert.deepEqual(decision.suggestions, []);
});

test("exactly at the suggest threshold, it is offered", () => {
  const four = candidate({
    score: 4,
    fired: { party: true, amount: false, date: false, path: false },
  });
  const decision = decide([four]);
  assert.equal(decision.autoLink, null);
  assert.equal(decision.suggestions.length, 1);
  assert.equal(decision.noAutoLinkReason, "no_qualifying_candidate");
});

test("one candidate on party, amount and date auto-links", () => {
  const decision = decide([candidate({})]);
  assert.equal(decision.autoLink?.score, 10);
  assert.deepEqual(decision.suggestions, []);
  assert.equal(decision.noAutoLinkReason, null);
});

test("a runner-up within the tie margin links nothing and suggests both", () => {
  const best = candidate({ entryId: "entry000000000000001" });
  const close = candidate({
    entryId: "entry000000000000002",
    score: 8,
    fired: { party: true, amount: true, date: false, path: false },
  });
  const decision = decide([best, close]);
  assert.equal(decision.autoLink, null);
  assert.equal(decision.noAutoLinkReason, "tie_within_margin");
  assert.equal(decision.suggestions.length, 2);
});

test("a runner-up one point further away does not stop the auto-link", () => {
  const best = candidate({ entryId: "entry000000000000001" });
  const far = candidate({
    entryId: "entry000000000000002",
    score: 7,
    fired: { party: true, amount: false, date: true, path: true },
  });
  const decision = decide([best, far]);
  assert.equal(decision.autoLink?.entryId, "entry000000000000001");
  assert.equal(decision.suggestions.length, 1);
});

test("two entries that both qualify link nothing -- the identical-calls case", () => {
  const decision = decide([
    candidate({ entryId: "entry000000000000001" }),
    candidate({ entryId: "entry000000000000002" }),
  ]);
  assert.equal(decision.autoLink, null);
  assert.equal(decision.noAutoLinkReason, "two_candidates_qualify");
  assert.equal(decision.suggestions.length, 2);
});

test("an entry that already cites a document is never auto-linked over", () => {
  const decision = decide([candidate({ entryHasLiveLink: true })]);
  assert.equal(decision.autoLink, null);
  assert.equal(decision.noAutoLinkReason, "entry_already_linked");
  assert.equal(decision.suggestions.length, 1);
});

test("a kind outside the three is suggested, never auto-linked", () => {
  const decision = decide([candidate({})], AGREEMENT);
  assert.equal(decision.autoLink, null);
  assert.equal(decision.noAutoLinkReason, "kind_not_auto_linkable");
  assert.equal(decision.suggestions.length, 1);
});

test("an investment-level candidate is never auto-linked", () => {
  const decision = decide([candidate({ entryId: null })]);
  assert.equal(decision.autoLink, null);
  assert.equal(decision.noAutoLinkReason, "no_qualifying_candidate");
});

test("the same inputs in a different order produce the same decision", () => {
  const a = candidate({ entryId: "entry000000000000001", score: 10 });
  const b = candidate({
    entryId: "entry000000000000002",
    score: 6,
    fired: { party: true, amount: false, date: true, path: false },
  });
  const forward = decide([a, b]);
  const backward = decide([b, a]);
  assert.equal(forward.autoLink?.entryId, backward.autoLink?.entryId);
  assert.deepEqual(
    forward.suggestions.map((item) => item.entryId),
    backward.suggestions.map((item) => item.entryId),
  );
});

// ---------------------------------------------------------------------------
// Investment-level links (owner decision, 2026-09-26)
// ---------------------------------------------------------------------------

test("agreements, letters, K-1s and unclassified pages are investment-level kinds", () => {
  for (const kind of [
    "investment_agreement",
    "letter_or_notice",
    "other",
    "schedule_k1",
    "capital_account_statement",
  ]) {
    assert.equal(isInvestmentLevelKind(matchableKind(kind)), true, kind);
  }
  for (const kind of ["capital_call_notice", "wire_confirmation", "distribution_notice"]) {
    assert.equal(isInvestmentLevelKind(matchableKind(kind)), false, kind);
  }
  assert.deepEqual(AGREEMENT.entryTypes, [], "no longer scored against commitments");
});

test("the organization key drops trailing legal-form words and nothing else", () => {
  assert.equal(organizationMatchKey("Synthetic Robotics, Inc."), "synthetic robotics");
  assert.equal(organizationMatchKey("Synthetic Fund II, L.P."), "synthetic fund ii");
  assert.equal(organizationMatchKey("Synthetic Holdings LLC"), "synthetic holdings");
  assert.equal(organizationMatchKey("Synthetic Co"), "synthetic");
  assert.equal(organizationMatchKey("Co"), "co", "the last token always stays");
  // Fund numbering and partnership words are identity, not form.
  assert.notEqual(
    organizationMatchKey("Synthetic Fund II"),
    organizationMatchKey("Synthetic Fund III"),
  );
  assert.notEqual(
    organizationMatchKey("Synthetic"),
    organizationMatchKey("Synthetic Partners"),
  );
  assert.equal(organizationMatchKey(""), "");
  assert.equal(organizationMatchKey(null), "");
});

function investmentLevel(id, names, statements, pathNames = []) {
  return scoreInvestmentLevel({
    statements,
    investment: { id, normalizedNames: names, signedOn: null },
    pathNames,
  });
}

const ROBOTICS = ["investment0000000001", ["synthetic robotics"]];
const ORCHARDS = ["investment0000000002", ["synthetic orchards"]];
const COMPANY = statement("company", "organization", {
  type: "text",
  value: "Synthetic Robotics, Inc.",
});

function decideLevel(candidates, hasConfirmedInvestmentLink = false) {
  return decideInvestmentLevelLinks({
    candidates,
    hasConfirmedInvestmentLink,
    maxSuggestions: 10,
  });
}

test("a unique party match is an investment-level auto-link citing its statement", () => {
  const robotics = investmentLevel(...ROBOTICS, [COMPANY]);
  const orchards = investmentLevel(...ORCHARDS, [COMPANY]);
  assert.equal(robotics.fired.party, true);
  assert.equal(robotics.entryId, null);
  assert.deepEqual(robotics.evidence, [
    { field: "company", observationKey: "company", evidenceSpanId: COMPANY.evidenceSpanId },
  ]);
  const decision = decideLevel([robotics, orchards]);
  assert.equal(decision.autoLink?.investmentId, ROBOTICS[0]);
  assert.deepEqual(decision.suggestions, []);
});

test("a unique path match cites the segment, with no invented span", () => {
  const robotics = investmentLevel(...ROBOTICS, [], ["synthetic robotics", "scan"]);
  assert.equal(robotics.reason, "path");
  assert.deepEqual(robotics.evidence, [
    { field: "source_path", pathSegment: "synthetic robotics" },
  ]);
  assert.equal(decideLevel([robotics]).autoLink?.investmentId, ROBOTICS[0]);
});

test("several matches, or a party and a folder that disagree, link nothing", () => {
  const both = [
    investmentLevel("investment0000000001", ["synthetic robotics"], [COMPANY]),
    investmentLevel("investment0000000003", ["synthetic robotics llc"], [COMPANY]),
  ];
  const several = decideLevel(both);
  assert.equal(several.autoLink, null);
  assert.equal(several.noAutoLinkReason, "several_investments_match");
  assert.equal(several.suggestions.length, 2);

  const disagree = decideLevel([
    investmentLevel(...ROBOTICS, [COMPANY], ["synthetic orchards"]),
    investmentLevel(...ORCHARDS, [COMPANY], ["synthetic orchards"]),
  ]);
  assert.equal(disagree.autoLink, null);
  assert.equal(disagree.noAutoLinkReason, "party_and_path_disagree");
  assert.equal(disagree.suggestions.length, 2);

  const twoFolders = decideLevel([
    investmentLevel(...ROBOTICS, [], ["synthetic robotics", "synthetic orchards"]),
    investmentLevel(...ORCHARDS, [], ["synthetic robotics", "synthetic orchards"]),
  ]);
  assert.equal(twoFolders.autoLink, null);
  assert.equal(twoFolders.suggestions.length, 2);
});

test("a party match in its own folder still auto-links", () => {
  const decision = decideLevel([
    investmentLevel(...ROBOTICS, [COMPANY], ["synthetic robotics"]),
    investmentLevel(...ORCHARDS, [COMPANY], ["synthetic robotics"]),
  ]);
  assert.equal(decision.autoLink?.investmentId, ROBOTICS[0]);
  assert.equal(decision.autoLink?.reason, "party+path");
});

test("an owner-confirmed investment link stops further auto-links", () => {
  const decision = decideLevel([investmentLevel(...ROBOTICS, [COMPANY])], true);
  assert.equal(decision.autoLink, null);
  assert.equal(decision.noAutoLinkReason, "investment_already_confirmed");
  assert.equal(decision.suggestions.length, 1);
});

test("nothing fired is nothing written", () => {
  const decision = decideLevel([investmentLevel(...ORCHARDS, [COMPANY])]);
  assert.equal(decision.autoLink, null);
  assert.deepEqual(decision.suggestions, []);
});
