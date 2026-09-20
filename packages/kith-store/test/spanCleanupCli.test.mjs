// `kith-extraction-span-cleanup`'s failure report (ADM-5j second-model
// review, fix 3). It needs no database: `reportFailure` is a pure function of
// the error it is given and the two writers it calls, the same reasoning
// `discoveryResetCli.test.mjs` gives for its own parser tests. The cleanup
// itself, including a real `CleanupInterrupted` thrown mid-run, is proved
// against a real server in `parsedStagingAndDocuments.test.mjs`.
//
// Before this fix, a mid-run failure printed only `error.name`: whatever the
// run had already committed -- real deletes against a production database --
// was lost the moment the process reported it. `reportFailure` is what the
// CLI's top-level catch now calls, and this proves it writes the committed
// counts to stdout (numbers and booleans only, same shape as a clean run)
// before the error name goes to stderr, and always signals failure.

import assert from "node:assert/strict";
import test from "node:test";

import { CleanupInterrupted } from "../dist/extraction/index.js";
import { reportFailure } from "../dist/extraction/spanCleanupCli.js";

function capture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    writeStdout: (chunk) => stdout.push(chunk),
    writeStderr: (chunk) => stderr.push(chunk),
  };
}

test("a CleanupInterrupted prints its committed summary to stdout, the error name to stderr, and signals failure", () => {
  const summary = {
    applied: true,
    limit: 10,
    generationsScanned: 5,
    generationsAffected: 2,
    spans: 7,
  };
  const io = capture();
  const code = reportFailure(new CleanupInterrupted(new Error("boom"), summary), io.writeStdout, io.writeStderr);
  assert.equal(code, 1);
  assert.equal(io.stdout.join(""), `${JSON.stringify(summary, null, 2)}\n`);
  assert.equal(io.stderr.join(""), "CleanupInterrupted\n");
});

test("an ordinary failure before any generation committed prints only the error name, and still signals failure", () => {
  const io = capture();
  const code = reportFailure(new Error("connection refused"), io.writeStdout, io.writeStderr);
  assert.equal(code, 1);
  assert.equal(io.stdout.join(""), "");
  assert.equal(io.stderr.join(""), "Error\n");
});

test("a thrown non-Error value still signals failure without a summary", () => {
  const io = capture();
  const code = reportFailure("not an Error", io.writeStdout, io.writeStderr);
  assert.equal(code, 1);
  assert.equal(io.stdout.join(""), "");
  assert.equal(io.stderr.join(""), "Error\n");
});
