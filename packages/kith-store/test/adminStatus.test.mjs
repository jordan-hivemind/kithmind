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
    // ADM-9. A watcher whose last pass finished cleanly.
    lastPassState: "complete",
    lastPassCode: null,
    lastPassAt: NOW - MINUTE,
    unhealthySince: null,
    // ADM-10 review. Null unless two live hosts have been seen.
    splitBrainAt: null,
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

// ADM-9 follow-up, from the hosted incident: a watcher whose heartbeat has
// been refused for 16 hours while its passes kept completing. The pass pill
// reads `complete` and every other fact about it is healthy, so this is the
// one case where a green pass must not be allowed to speak for the host.
test("a stale heartbeat is a problem however well the passes are going", () => {
  const stale = deriveHealthChecks(
    facts({
      watchers: [
        watcher({
          lastSeenAt: NOW - 17 * HOUR,
          nextExpectedAt: NOW - 17 * HOUR + 3 * MINUTE,
          lastPassState: "complete",
          lastPassAt: NOW - MINUTE,
          unhealthySince: null,
        }),
      ],
    }),
    NOW,
  );
  const check = checkById(stale, "documents_watcher");
  assert.equal(check.status, "problem");
  assert.match(check.detail, /1 overdue/);
  assert.equal(check.detail.includes("stuck"), false);
  assert.deepEqual(check.pass, {
    state: "complete",
    code: null,
    problem: false,
  });
});

// ADM-9. The gap PR #313 opened: a pass that trips a circuit breaker writes
// no scan and so no assessment, and the heartbeat keeps arriving, so before
// this the whole screen read `ok` while the watcher ingested nothing.
test("a refused pass is a problem even while the heartbeat is current", () => {
  for (const code of [
    "root_selection_would_retire_items",
    "root_contents_collapsed",
  ]) {
    const checks = deriveHealthChecks(
      facts({
        watchers: [
          watcher({
            lastPassState: "incomplete",
            lastPassCode: code,
            // A breaker is a problem on sight, on the very first pass that
            // trips it: no waiting, no duration.
            unhealthySince: NOW - MINUTE,
          }),
        ],
      }),
      NOW,
    );
    const check = checkById(checks, "documents_watcher");
    assert.equal(check.status, "problem", `${code} must count as a problem`);
    assert.match(check.detail, /1 stuck/);
    assert.equal(check.detail.includes("overdue"), false);
    assert.deepEqual(check.pass, {
      state: "incomplete",
      code,
      problem: true,
    });
  }
});

// First review, finding 5. `enumeration_not_complete` and
// `processing_incomplete` are what a healthy watcher reports while it chews
// through a first ingest of several hundred documents. Counting two in a row
// as a fault would paint the screen red for the whole first day, so an
// ordinary `incomplete` is shown and not counted until it stops ending.
test("a failed pass is a problem; an ordinary incomplete one is not until it lasts a day", () => {
  const status = (overrides) =>
    checkById(
      deriveHealthChecks(facts({ watchers: [watcher(overrides)] }), NOW),
      "documents_watcher",
    );
  assert.equal(
    status({ lastPassState: "failed", unhealthySince: NOW - MINUTE }).status,
    "problem",
  );
  const backlog = {
    lastPassState: "incomplete",
    lastPassCode: "processing_incomplete",
  };
  // Hours of backlog passes: shown on the pill, not a fault.
  for (const since of [NOW - MINUTE, NOW - 6 * HOUR, NOW - 23 * HOUR]) {
    const check = status({ ...backlog, unhealthySince: since });
    assert.equal(check.status, "ok", `${since} must not be a fault yet`);
    assert.deepEqual(check.pass, {
      state: "incomplete",
      code: "processing_incomplete",
      problem: false,
    });
    assert.equal(check.detail.includes("stuck"), false);
  }
  // A day of them and nothing finishing is a different thing.
  const stuck = status({ ...backlog, unhealthySince: NOW - DAY - MINUTE });
  assert.equal(stuck.status, "problem");
  assert.equal(stuck.pass.problem, true);
  assert.match(stuck.detail, /1 stuck/);
  // A pass that completed clears the run, whatever came before it.
  assert.equal(
    status({ lastPassState: "complete", lastPassCode: null, unhealthySince: null })
      .status,
    "ok",
  );
  // Nothing reported yet is not a pill and not a failure.
  const never = status({
    lastPassState: null,
    lastPassCode: null,
    lastPassAt: null,
  });
  assert.equal(never.status, "ok");
  assert.equal(never.pass, undefined);
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

// ADM-10. A refused heartbeat and an absent one are the same silence on this
// row, and the screen has to tell them apart: one needs the host looked at,
// the other needs "Re-register watcher" clicked.
//
// What separates them is work the refused host still does. A heartbeat carries
// a `watcherId` and is refused; a processing assessment carries none and
// lands. So an assessment newer than the heartbeat deadline the watcher missed
// means a host that is up, reachable and authorized, talking to this server
// under an identity it does not recognise.

test("a heartbeat that is refused reads differently from one that stopped", () => {
  // The owner's case: the heartbeat froze seventeen hours ago and the passes
  // never stopped.
  const refused = checkById(
    deriveHealthChecks(
      facts({
        watchers: [
          watcher({
            lastSeenAt: NOW - 17 * HOUR,
            nextExpectedAt: NOW - 17 * HOUR + 3 * MINUTE,
            assessmentAt: NOW - 4 * MINUTE,
          }),
        ],
      }),
      NOW,
    ),
    "documents_watcher",
  );
  assert.equal(refused.status, "problem");
  assert.deepEqual(refused.watcher, {
    stuck: ["src-1"],
    identity: true,
    splitBrain: false,
  });

  // A host that is simply switched off: nothing has arrived from it at all.
  const silent = checkById(
    deriveHealthChecks(
      facts({
        watchers: [
          watcher({
            lastSeenAt: NOW - 17 * HOUR,
            nextExpectedAt: NOW - 17 * HOUR + 3 * MINUTE,
            assessmentAt: NOW - 17 * HOUR,
          }),
        ],
      }),
      NOW,
    ),
    "documents_watcher",
  );
  assert.equal(silent.status, "problem");
  assert.deepEqual(silent.watcher, {
    stuck: ["src-1"],
    identity: false,
    splitBrain: false,
  });

  // An assessment written in the same pass as the last accepted ping proves
  // nothing about the window since, so it must not read as a refusal.
  const borderline = checkById(
    deriveHealthChecks(
      facts({
        watchers: [
          watcher({
            lastSeenAt: NOW - 17 * HOUR,
            nextExpectedAt: NOW - 17 * HOUR + 3 * MINUTE,
            assessmentAt: NOW - 17 * HOUR + MINUTE,
          }),
        ],
      }),
      NOW,
    ),
    "documents_watcher",
  );
  assert.equal(borderline.watcher.identity, false);
});

test("a healthy watcher offers nothing to re-register", () => {
  // The kebab is hidden on an empty `stuck`, so a registration that is working
  // cannot be cleared by a slip of the mouse.
  const healthy = checkById(
    deriveHealthChecks(facts({ watchers: [watcher()] }), NOW),
    "documents_watcher",
  );
  assert.equal(healthy.status, "ok");
  assert.equal(healthy.watcher, undefined);

  // Nor can a disabled source's, which is not supposed to be watched at all.
  const disabled = checkById(
    deriveHealthChecks(
      facts({
        watchers: [watcher({ enabled: false, nextExpectedAt: NOW - DAY })],
      }),
      NOW,
    ),
    "documents_watcher",
  );
  assert.equal(disabled.watcher, undefined);

  // Two sources, one of them stuck: only the stuck one is offered.
  const mixed = checkById(
    deriveHealthChecks(
      facts({
        watchers: [
          watcher(),
          watcher({ sourceAccountId: "src-2", nextExpectedAt: NOW - MINUTE }),
        ],
      }),
      NOW,
    ),
    "documents_watcher",
  );
  assert.deepEqual(mixed.watcher.stuck, ["src-2"]);
});

// ADM-10 review, finding 4. The derived `identity` state needs both a missed
// deadline and a newer assessment, so a quiet source whose heartbeat is being
// refused reads as plain `overdue` and never earns the pill. That is fine
// precisely because the kebab does not wait for the pill.
test("a plainly overdue watcher can still be re-registered", () => {
  const check = checkById(
    deriveHealthChecks(
      facts({
        watchers: [
          watcher({
            lastSeenAt: NOW - 17 * HOUR,
            nextExpectedAt: NOW - 17 * HOUR + 3 * MINUTE,
            // No assessment since the heartbeat stopped: from here this is
            // indistinguishable from a host that was switched off, which is
            // exactly the case the pill cannot diagnose.
            assessmentAt: NOW - 17 * HOUR,
          }),
        ],
      }),
      NOW,
    ),
    "documents_watcher",
  );
  assert.equal(check.status, "problem");
  assert.equal(check.watcher.identity, false, "no pill");
  assert.equal(check.watcher.splitBrain, false);
  assert.deepEqual(
    check.watcher.stuck,
    ["src-1"],
    "but the action is offered, which is what the owner actually needs",
  );
});

// ADM-10 review, finding 1. Two live hosts heartbeating as one watcher: the
// opposite failure from the other two, because the heartbeat is arriving.
test("a split brain is a problem even while the heartbeat is current", () => {
  const split = checkById(
    deriveHealthChecks(
      facts({ watchers: [watcher({ splitBrainAt: NOW - MINUTE })] }),
      NOW,
    ),
    "documents_watcher",
  );
  // Without this it would read `ok`: the watcher is current, its passes are
  // completing, and every other check on this row is satisfied.
  assert.equal(split.status, "problem");
  assert.equal(split.watcher.splitBrain, true);
  assert.match(split.detail, /2 hosts/);
  // Nothing to re-register: both hosts are the registered watcher, and the
  // fix is to stop one of them.
  assert.deepEqual(split.watcher.stuck, []);
  assert.equal(split.watcher.identity, false);
});
