// `kith-investment-link-backfill`'s argument parser
// (`src/admin/investmentLinkCli.ts`). It needs no database, so it runs in
// every clone, the same reasoning `deferredCli.test.mjs` gives for its own
// parser tests. What the backfill actually enqueues is proved against a real
// server in `investmentLinkWork.test.mjs`.
//
// The default matters more than usual here: this command writes to the queue
// the daemon drains, so a bare invocation must count and stop.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import { argumentsFor } from "../dist/admin/investmentLinkCli.js";

/**
 * `argumentsFor` rejects a bad flag through `usage()`, which writes to stderr
 * and calls `process.exit(2)`. This observes that instead of tearing down the
 * test runner, and returns the exit code, or null if none was triggered.
 */
function exitCodeOf(fn) {
  const originalExit = process.exit;
  const originalWrite = process.stderr.write;
  let code = null;
  process.exit = (status) => {
    code = status;
    throw new Error(`process.exit(${status})`);
  };
  process.stderr.write = () => true;
  try {
    fn();
    return null;
  } catch {
    return code;
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalWrite;
  }
}

test("no flags is every space, every matchable kind, dry run", () => {
  assert.deepEqual(argumentsFor([]), {
    spaceId: null,
    kind: null,
    limit: null,
    apply: false,
  });
});

test("the flags narrow the run, and -- is forwarded past", () => {
  const spaceId = newKithId();
  assert.deepEqual(
    argumentsFor([
      "--",
      "--space",
      spaceId,
      "--kind",
      "capital_call_notice",
      "--limit",
      "50",
      "--apply",
    ]),
    { spaceId, kind: "capital_call_notice", limit: 50, apply: true },
  );
});

test("a kind the scorer has no rules for is refused by name", () => {
  // Not discovered at drain time as a queue full of `kind_not_matchable`:
  // the command knows the closed set, so it says so here.
  assert.equal(exitCodeOf(() => argumentsFor(["--kind", "receipt"])), 2);
  assert.equal(exitCodeOf(() => argumentsFor(["--kind"])), 2);
  assert.equal(
    argumentsFor(["--kind", "schedule_k1"]).kind,
    "schedule_k1",
  );
  // The investment-level catch-all kinds are selectable too (2026-09-26).
  for (const kind of ["letter_or_notice", "other", "investment_agreement"]) {
    assert.equal(argumentsFor(["--kind", kind]).kind, kind);
  }
});

test("a malformed space, limit or flag exits 2 rather than guessing", () => {
  for (const argv of [
    ["--space"],
    ["--space", "not-an-id"],
    ["--limit"],
    ["--limit", "0"],
    ["--limit", "two"],
    ["--everything"],
    [newKithId()],
  ]) {
    assert.equal(exitCodeOf(() => argumentsFor(argv)), 2, argv.join(" "));
  }
});
