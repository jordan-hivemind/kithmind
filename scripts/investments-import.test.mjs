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

import { argumentsFor, SpaceAccessDenied, storeWriter } from "./investments-import.mjs";

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

// ---------------------------------------------------------------------------
// Independent review of #309 found `storeWriter` reading `--space` with no
// access check (review #3) and creating investments in a way that fails a
// whole investment's entries on a whitespace-only name collision (review #4).
// `storeWriter` takes the store's own functions as arguments, so both are
// testable here with fakes and no live Postgres.
// ---------------------------------------------------------------------------

function fakeAdmin({ investments = [], findOrCreateResult } = {}) {
  const calls = { listInvestments: [], findOrCreateInvestment: [] };
  return {
    calls,
    listInvestments: async (ctx, spaceIds, opts) => {
      calls.listInvestments.push({ ctx, spaceIds, opts });
      return investments;
    },
    findOrCreateInvestment: async (ctx, args) => {
      calls.findOrCreateInvestment.push({ ctx, args });
      return findOrCreateResult ?? { id: "investment-1", created: true };
    },
  };
}

// A fake `withKithTransaction` that just runs the work against a marker
// "client": `storeWriter`'s own logic, not a real transaction, is what these
// tests check.
const fakeTransaction = (pool, work) => work({ fakeClient: true });
const fakeIdentityCtx = (client) => ({ ctx: true, client });

test("storeWriter checks --user against --space before listing investments, and refuses named and clean when denied (review #3)", async () => {
  const admin = fakeAdmin();
  const accessChecks = [];
  const requireSpaceAccess = async (ctx, principal, spaceId, operation) => {
    accessChecks.push({ principal, spaceId, operation });
    throw new Error("Space not found");
  };
  await assert.rejects(
    () =>
      storeWriter({
        pool: {},
        spaceId: "wrong-space",
        principal: { userId: "user-1" },
        admin,
        identityCtx: fakeIdentityCtx,
        withKithTransaction: fakeTransaction,
        requireSpaceAccess,
      }),
    (error) => {
      assert.ok(error instanceof SpaceAccessDenied);
      assert.match(error.message, /user-1/);
      assert.match(error.message, /wrong-space/);
      return true;
    },
  );
  // The access check ran with the write capability the import needs, and
  // named the right space and user -- and `listInvestments` never ran at
  // all, so a mistyped --space never gets its investment names read out.
  assert.deepEqual(accessChecks, [
    { principal: { userId: "user-1" }, spaceId: "wrong-space", operation: "write" },
  ]);
  assert.equal(admin.calls.listInvestments.length, 0);
});

test("storeWriter lists investments only after access is granted", async () => {
  const admin = fakeAdmin({ investments: [{ id: "inv-1", name: "Alpha" }] });
  const requireSpaceAccess = async () => ({ role: "owner" });
  const writer = await storeWriter({
    pool: {},
    spaceId: "space-1",
    principal: { userId: "user-1" },
    admin,
    identityCtx: fakeIdentityCtx,
    withKithTransaction: fakeTransaction,
    requireSpaceAccess,
  });
  assert.equal(admin.calls.listInvestments.length, 1);
  assert.deepEqual(admin.calls.listInvestments[0].spaceIds, ["space-1"]);
  assert.deepEqual(admin.calls.listInvestments[0].opts, { includeArchived: true });
  assert.equal(writer.existing.get("alpha"), "inv-1");
});

test("storeWriter's createInvestment uses findOrCreateInvestment and carries its created flag through (review #4)", async () => {
  // `created: false`: the store found this by its own normalized-name match
  // rather than inserting a duplicate -- exactly the case the plain
  // `createInvestment` would have thrown a duplicate error for, failing this
  // investment and, since `runImport`'s `ensure` never gets an id back,
  // every entry that names it too.
  const admin = fakeAdmin({
    findOrCreateResult: { id: "investment-9", created: false },
  });
  const requireSpaceAccess = async () => ({ role: "owner" });
  const writer = await storeWriter({
    pool: {},
    spaceId: "space-1",
    principal: { userId: "user-1" },
    admin,
    identityCtx: fakeIdentityCtx,
    withKithTransaction: fakeTransaction,
    requireSpaceAccess,
  });
  const result = await writer.createInvestment({ name: "Bramble Fund I " });
  assert.deepEqual(result, { id: "investment-9", created: false });
  assert.equal(admin.calls.findOrCreateInvestment.length, 1);
  assert.equal(admin.calls.findOrCreateInvestment[0].args.name, "Bramble Fund I ");
  assert.equal(admin.calls.findOrCreateInvestment[0].args.spaceId, "space-1");
  assert.equal(admin.calls.findOrCreateInvestment[0].args.principal.userId, "user-1");
});
