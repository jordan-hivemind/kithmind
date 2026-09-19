// The pure half of the health and coverage screens (ADM-2).
//
// No database: every rule here is a function of the facts plus a `now`, which
// is the whole reason `src/admin/status.ts` is a separate file from the reads.

import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_CHECK,
  countsLine,
  coverageStatus,
  deriveHealthChecks,
  financeFreshnessCheck,
  humanAge,
  worstStatus,
} from "../dist/admin/index.js";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function facts(overrides = {}) {
  return {
    watchers: [],
    index: { eligible: 0, covered: 0, owed: 0 },
    jobs: { overdueQueued: 0, failed: 0, failedKinds: {} },
    review: { pendingBindings: 0, fieldDrops: 0 },
    ...overrides,
  };
}

function watcher(overrides = {}) {
  return {
    sourceAccountId: "src-1",
    name: "Provider folder",
    enabled: true,
    watcherState: "active",
    lastSeenAt: NOW - MINUTE,
    nextExpectedAt: NOW + MINUTE,
    assessmentState: "complete",
    assessmentAt: NOW - MINUTE,
    notReadyReasons: {},
    ...overrides,
  };
}

const checkById = (checks, id) => checks.find((check) => check.id === id);

test("ages read coarsely", () => {
  assert.equal(humanAge(30_000), "just now");
  assert.equal(humanAge(4 * MINUTE), "4m");
  assert.equal(humanAge(3 * HOUR), "3h");
  assert.equal(humanAge(2 * DAY), "2d");
});

test("the worst status wins, and ok is the floor", () => {
  assert.equal(worstStatus([]), "ok");
  assert.equal(worstStatus(["ok", "attention"]), "attention");
  assert.equal(worstStatus(["attention", "problem", "ok"]), "problem");
  // `unknown` is not a failure and must not outrank one.
  assert.equal(worstStatus(["unknown", "problem"]), "problem");
  assert.equal(worstStatus(["unknown", "ok"]), "unknown");
});

test("counts read biggest first", () => {
  assert.equal(countsLine({}), "");
  assert.equal(countsLine({ a: 0 }), "");
  assert.equal(countsLine({ a: 1, b: 5 }), "b 5, a 1");
});

test("the watcher check reports the pass, and the reasons in the tooltip", () => {
  const checks = deriveHealthChecks(
    facts({
      watchers: [
        watcher({ lastSeenAt: NOW - 4 * MINUTE }),
        watcher({
          sourceAccountId: "src-2",
          name: "Receipts",
          notReadyReasons: { item_state: 2 },
          assessmentState: "incomplete",
        }),
      ],
    }),
    NOW,
  );
  const check = checkById(checks, "documents_watcher");
  assert.equal(check.status, "ok");
  assert.equal(check.detail, "last pass 1m ago, 2 watched");
  assert.equal(check.lastCheckedAt, NOW - MINUTE);
  assert.match(check.tooltip, /Receipts: incomplete \(item_state 2\)/);
});

test("an overdue watcher is a problem and a disabled source is not", () => {
  const overdue = deriveHealthChecks(
    facts({ watchers: [watcher({ nextExpectedAt: NOW - MINUTE })] }),
    NOW,
  );
  const check = checkById(overdue, "documents_watcher");
  assert.equal(check.status, "problem");
  assert.match(check.detail, /1 overdue/);

  const disabled = deriveHealthChecks(
    facts({ watchers: [watcher({ enabled: false, nextExpectedAt: NOW - DAY })] }),
    NOW,
  );
  assert.equal(
    checkById(disabled, "documents_watcher").status,
    "not_configured",
  );

  // A host that has registered but never reported is pending, not failing.
  const awaiting = deriveHealthChecks(
    facts({
      watchers: [
        watcher({ watcherState: "awaiting_heartbeat", nextExpectedAt: null }),
      ],
    }),
    NOW,
  );
  assert.equal(checkById(awaiting, "documents_watcher").status, "unknown");
});

test("the index check escalates only when it owes more than it covers", () => {
  const at = (index) =>
    checkById(deriveHealthChecks(facts({ index }), NOW), "search_index");
  assert.equal(at({ eligible: 0, covered: 0, owed: 0 }).status, "unknown");
  assert.equal(at({ eligible: 10, covered: 10, owed: 0 }).status, "ok");
  assert.equal(at({ eligible: 10, covered: 8, owed: 2 }).status, "attention");
  assert.equal(at({ eligible: 10, covered: 2, owed: 8 }).status, "problem");
  assert.equal(
    at({ eligible: 10, covered: 8, owed: 2 }).detail,
    "8 of 10 embedded, 2 owed",
  );
});

test("a failed job is a problem, an overdue one is attention, review is neither", () => {
  const jobs = (overrides) =>
    checkById(
      deriveHealthChecks(
        facts({ jobs: { overdueQueued: 0, failed: 0, failedKinds: {}, ...overrides } }),
        NOW,
      ),
      "background_jobs",
    );
  assert.equal(jobs({}).status, "ok");
  assert.equal(jobs({ overdueQueued: 3 }).status, "attention");
  const failed = jobs({ failed: 1, failedKinds: { embedding_fill: 1 } });
  assert.equal(failed.status, "problem");
  assert.equal(failed.tooltip, "failed: embedding_fill 1");

  // Queued review is work waiting for a person, never a fault.
  const review = checkById(
    deriveHealthChecks(
      facts({ review: { pendingBindings: 2, fieldDrops: 1 } }),
      NOW,
    ),
    "review_queue",
  );
  assert.equal(review.status, "attention");
  assert.equal(review.detail, "3 open");
  assert.match(review.tooltip, /entity bindings 2/);
});

test("the backup check has no data and says so rather than claiming ok", () => {
  assert.equal(BACKUP_CHECK.status, "unknown");
  assert.equal(BACKUP_CHECK.detail, "reported by the daily check");
});

test("an unconfigured archive is not an empty one", () => {
  assert.equal(financeFreshnessCheck(null, NOW, false).status, "not_configured");
  assert.equal(financeFreshnessCheck(null, NOW, false).detail, "not configured");
  // Configured, but with nothing in it yet.
  assert.equal(financeFreshnessCheck(null, NOW).status, "unknown");
  assert.equal(financeFreshnessCheck("2026-09-01", NOW).status, "ok");
  assert.equal(financeFreshnessCheck("2026-07-01", NOW).status, "attention");
  assert.equal(financeFreshnessCheck("2026-01-01", NOW).status, "problem");
  assert.match(
    financeFreshnessCheck("2026-09-01", NOW).detail,
    /latest snapshot 2026-09-01/,
  );
});

test("an area with configuration and no contents is still empty", () => {
  const area = (overrides) =>
    coverageStatus({
      area: "taxes",
      sources: 0,
      documents: 0,
      records: 0,
      from: null,
      to: null,
      gaps: 0,
      gapReasons: {},
      status: "empty",
      ...overrides,
    });
  assert.equal(area({}), "empty");
  // A source configured and nothing ingested through it: still empty. What
  // the screen answers is what the system holds, not what was intended.
  assert.equal(area({ sources: 1 }), "empty");
  assert.equal(area({ sources: 1, documents: 4 }), "covered");
  assert.equal(area({ documents: 4, gaps: 1 }), "gaps");
});
