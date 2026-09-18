// `kith-discovery-reset`'s argument parser (`src/workers/cli.ts`). It needs no
// database, so it runs in every clone, the same reasoning `deferredCli.test.mjs`
// gives for its own parser tests. The reset itself is proved against a real
// server in `workerFoundation.test.mjs`.
//
// The default matters more than usual here: this command writes to the queue
// that decides what gets ingested, so a bare invocation must count and stop.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import { argumentsFor } from "../dist/workers/cli.js";

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

test("no flags is every space, dry run", () => {
  assert.deepEqual(argumentsFor([]), { spaceId: null, apply: false });
});

test("--apply writes, --space narrows to one space", () => {
  const spaceId = newKithId();
  assert.deepEqual(argumentsFor(["--apply"]), { spaceId: null, apply: true });
  assert.deepEqual(argumentsFor(["--space", spaceId, "--apply"]), {
    spaceId,
    apply: true,
  });
  assert.deepEqual(argumentsFor(["--", "--space", spaceId]), {
    spaceId,
    apply: false,
  });
});

test("a missing or malformed space id exits rather than sweeping every space", () => {
  for (const argv of [["--space"], ["--space", "not-a-space-id"]]) {
    assert.equal(exitCodeOf(() => argumentsFor(argv)), 2, argv.join(" "));
  }
});

test("an unknown flag exits", () => {
  assert.equal(exitCodeOf(() => argumentsFor(["--all"])), 2);
});
