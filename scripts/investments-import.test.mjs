// `investments-import.mjs`'s own surface: argument parsing, and that a dry
// run against the real sheet's fixture actually reuses
// `apps/web/src/lib/kith/investment-import.ts` end to end (the parse, the
// accounting-format fixes, the reconciliation and the plan) rather than some
// stale or duplicated copy of it.
//
// `--apply` is not exercised here: it is thin wiring over
// `@repo/kith-store`'s `listInvestments` / `createInvestment` /
// `createInvestmentEntry`, which have their own tests, and over `runImport`,
// which is unit-tested in `investment-import.test.ts` against a fake writer.
// A database-backed test of the wiring itself belongs beside those, not
// duplicated here without a live Postgres.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { argumentsFor } from "./investments-import.mjs";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/investments-import.mjs");
const fixturesDir = join(
  root,
  "apps/web/src/lib/kith/investment-import-fixtures",
);
const summaryCsv = join(fixturesDir, "summary.csv");
const ledgerCsv = join(fixturesDir, "ledger.csv");

test("argumentsFor reads --summary, --ledger and --apply's own two flags", () => {
  assert.deepEqual(
    argumentsFor(["--summary", "s.csv", "--ledger", "l.csv"]),
    { summary: "s.csv", ledger: "l.csv", apply: false, spaceId: null, userId: null },
  );
  assert.deepEqual(
    argumentsFor([
      "--summary",
      "s.csv",
      "--ledger",
      "l.csv",
      "--apply",
      "--space",
      "space-1",
      "--user",
      "user-1",
    ]),
    {
      summary: "s.csv",
      ledger: "l.csv",
      apply: true,
      spaceId: "space-1",
      userId: "user-1",
    },
  );
});

test("--summary and --ledger are required", async () => {
  const result = await execFileAsync(process.execPath, [script]).catch(
    (error) => error,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--summary and --ledger are both required/);
});

test("--apply without --space and --user is refused before anything runs", async () => {
  const result = await execFileAsync(process.execPath, [
    script,
    "--summary",
    summaryCsv,
    "--ledger",
    ledgerCsv,
    "--apply",
  ]).catch((error) => error);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--apply requires --space and --user/);
});

test("a dry run against the real sheet's fixture reuses investment-import.ts end to end", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    script,
    "--summary",
    summaryCsv,
    "--ledger",
    ledgerCsv,
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.dryRun, true);
  // Four investments, not five: the sheet's own Total row is used for the
  // top-line check, not imported as a fifth investment.
  assert.equal(report.counts.investments, 4);
  assert.equal(report.counts.ledgerOnlyInvestments, 1);
  assert.equal(report.counts.sentWithNoLedgerRows, 1);
  // The typo'd year (`2/6/0206`) is reported, not imported.
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /outside a plausible range/);
  // Tanager (off by $1.50) is the one investment that does not reconcile
  // within a dollar; Angel Startup's Sent has no Ledger rows to reconcile
  // against at all.
  assert.equal(report.reconciliation.length, 2);
  assert.equal(report.topLineCheck.committed.totalRow, "185000.00");
  assert.equal(report.topLineCheck.committed.difference, "0.00");
  // Angel Startup's commitment is the one row genuinely left for the owner.
  assert.equal(report.invalid.length, 1);
  assert.match(report.invalid[0].reason, /no Ledger rows to estimate/);
});
