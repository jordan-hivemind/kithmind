// `kith-deferred-work`'s argument parser (`src/deferred/cli.ts`). No database
// needed, so this runs in every clone including one with no Postgres
// configured -- the same reasoning `serializationBackoff.test.mjs` gives for
// its own database-free tests.

import assert from "node:assert/strict";
import test from "node:test";

import { argumentsFor } from "../dist/deferred/cli.js";

/**
 * `argumentsFor` rejects a bad flag through `usage()`, which writes to
 * stderr and calls `process.exit(2)` -- fine for the real CLI, fatal for a
 * test process. This runs `fn` with `process.exit` and `process.stderr.write`
 * replaced so the call is observed instead of actually tearing down the test
 * runner, and returns the exit code `fn` triggered, or `null` if it never
 * called `process.exit`.
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

test("once takes no flags", () => {
  assert.deepEqual(argumentsFor(["once"]), { command: "once" });
});

test("tick and drain default --interval-ms to null (run once)", () => {
  assert.deepEqual(argumentsFor(["tick"]), {
    command: "tick",
    intervalMs: null,
  });
  assert.deepEqual(argumentsFor(["drain"]), {
    command: "drain",
    intervalMs: null,
    maxJobs: null,
  });
});

test("--interval-ms accepts a value at or above the 1000ms floor", () => {
  assert.deepEqual(argumentsFor(["tick", "--interval-ms", "1000"]), {
    command: "tick",
    intervalMs: 1000,
  });
  assert.deepEqual(argumentsFor(["drain", "--interval-ms", "5000"]), {
    command: "drain",
    intervalMs: 5000,
    maxJobs: null,
  });
});

test("--interval-ms below the 1000ms floor exits rather than busy-looping the pool", () => {
  for (const value of ["1", "999"]) {
    const code = exitCodeOf(() =>
      argumentsFor(["tick", "--interval-ms", value]),
    );
    assert.equal(code, 2, `--interval-ms ${value} should exit(2)`);
  }
});

test("--max-jobs is unaffected by the --interval-ms floor", () => {
  assert.deepEqual(argumentsFor(["drain", "--max-jobs", "1"]), {
    command: "drain",
    intervalMs: null,
    maxJobs: 1,
  });
  // --max-jobs itself still has to be a positive integer, just not subject to
  // the 1000ms floor that only applies to --interval-ms.
  const code = exitCodeOf(() => argumentsFor(["drain", "--max-jobs", "0"]));
  assert.equal(code, 2);
});
