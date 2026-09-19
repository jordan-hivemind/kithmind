#!/usr/bin/env node
// The operator's route for the one-time investments sheet import (ADM-3b).
//
// The owner cannot sign in to the admin panel, so the browser drawer
// (`apps/web/src/components/admin/investment-import-drawer.tsx`) is not how
// this import happens. This script is: it takes the same two CSV exports and
// runs them through the exact same `buildPreview` / `planImport` / `runImport`
// the drawer calls, from `apps/web/src/lib/kith/investment-import.ts` --
// imported unmodified (see `investments-import-resolve-hook.mjs`) rather than
// re-implemented, because a second copy of the sign-and-currency rule is a
// second place for it to disagree with the first about the owner's money.
//
// Dry run is the default and prints the preview as JSON: counts, the
// reconciliation, invalid rows and the sheet's own Total-row check, so the
// operator can read the whole thing before anything is written. `--apply`
// performs it, through a writer backed directly by `@repo/kith-store`'s
// investment functions against `KITH_STORE_DATABASE_URL` -- the same three
// operations (`existing`, `createInvestment`, `createEntry`) the drawer's own
// writer gives `runImport`, here calling the store instead of `fetch`.
// Idempotent through the entries' existing import keys: running the same two
// files twice creates nothing the second time.
//
// Usage:
//   node scripts/investments-import.mjs --summary <csv> --ledger <csv>
//   node scripts/investments-import.mjs --summary <csv> --ledger <csv> \
//     --apply --space <id> --user <id>
//
// KITH_STORE_DATABASE_URL must be set for --apply, and only then; a dry run
// never opens a connection.

import { readFileSync } from "node:fs";
import { register } from "node:module";
import process from "node:process";
import { pathToFileURL } from "node:url";

function usage() {
  process.stderr.write(
    "Usage: investments-import --summary <csv> --ledger <csv> " +
      "[--apply --space <id> --user <id>]\n",
  );
  process.exit(2);
}

export function argumentsFor(argv) {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
  let summary = null;
  let ledger = null;
  let apply = false;
  let spaceId = null;
  let userId = null;
  for (let index = 0; index < forwarded.length; index += 1) {
    const flag = forwarded[index];
    if (flag === "--apply") {
      apply = true;
    } else if (flag === "--summary" || flag === "--ledger" || flag === "--space" || flag === "--user") {
      const value = forwarded[index + 1];
      if (value === undefined) {
        process.stderr.write(`${flag} requires a value\n`);
        usage();
      }
      if (flag === "--summary") summary = value;
      else if (flag === "--ledger") ledger = value;
      else if (flag === "--space") spaceId = value;
      else userId = value;
      index += 1;
    } else {
      usage();
    }
  }
  if (summary === null || ledger === null) {
    process.stderr.write("--summary and --ledger are both required\n");
    usage();
  }
  if (apply && (spaceId === null || userId === null)) {
    process.stderr.write("--apply requires --space and --user\n");
    usage();
  }
  return { summary, ledger, apply, spaceId, userId };
}

function requireDatabaseUrl() {
  const url = process.env.KITH_STORE_DATABASE_URL;
  if (!url) {
    process.stderr.write(
      "KITH_STORE_DATABASE_URL must be set to the brain's PostgreSQL endpoint.\n",
    );
    process.exit(2);
  }
  return url;
}

const WEB_LIB_URL = new URL(
  "../apps/web/src/lib/kith/investment-import.ts",
  import.meta.url,
).href;
const KITH_STORE_INDEX_URL = new URL(
  "../packages/kith-store/dist/index.js",
  import.meta.url,
).href;
const KITH_STORE_IDENTITY_URL = new URL(
  "../packages/kith-store/dist/identity/index.js",
  import.meta.url,
).href;

/** The preview and plan, shaped for the operator to read as JSON rather than
 * scroll through the full drafts arrays a browser session would keep. */
function reportOf(preview, plan) {
  return {
    counts: {
      investments: preview.summary.length,
      entries: plan.operations.filter((op) => op.kind === "entry").length,
      notRead: preview.skipped.length,
      cannotImport: plan.invalid.length,
      differences: preview.reconciliation.length,
      rateLooksWrong: preview.suspectRates.length,
      ledgerOnlyInvestments: preview.ledgerOnlyInvestments.length,
      sentWithNoLedgerRows: preview.sentWithNoLedgerRows.length,
    },
    topLineCheck: preview.topLineCheck,
    reconciliation: preview.reconciliation,
    suspectRates: preview.suspectRates,
    invalid: plan.invalid,
    skipped: preview.skipped,
    ledgerOnlyInvestments: preview.ledgerOnlyInvestments,
    sentWithNoLedgerRows: preview.sentWithNoLedgerRows,
  };
}

/** Thrown when `--user` may not write `--space`, so `main` can print one
 * clear line instead of a stack trace through three transactions. Exported
 * for the test, which checks the access check runs -- and refuses -- before
 * any read of the space's investments. */
export class SpaceAccessDenied extends Error {
  constructor(spaceId, userId) {
    super(`--user ${userId} may not write --space ${spaceId}`);
    this.name = "SpaceAccessDenied";
  }
}

/** The three operations `runImport` needs, backed by the store directly
 * instead of by `fetch`: one `withKithTransaction` per write, the same "one
 * operation is one transaction" rule every other CLI in this package follows.
 * Exported for the test, which passes fakes for everything but the shape of
 * the calls. */
export async function storeWriter({
  pool,
  spaceId,
  principal,
  admin,
  identityCtx,
  withKithTransaction,
  requireSpaceAccess,
}) {
  const existingInvestments = await withKithTransaction(pool, async (client) => {
    const ctx = identityCtx(client);
    // In the same transaction as the read that follows, and before it: a
    // mistyped --space otherwise lets `listInvestments` read (and this script
    // print) another space's investment names, with nothing wrong noticed
    // until the first write hits its own access check deep inside `runImport`
    // and is merely recorded as one failed row among many.
    try {
      await requireSpaceAccess(ctx, principal, spaceId, "write");
    } catch (error) {
      if (error instanceof Error && error.message === "Space not found") {
        throw new SpaceAccessDenied(spaceId, principal.userId);
      }
      throw error;
    }
    return admin.listInvestments(ctx, [spaceId], { includeArchived: true });
  });
  return {
    existing: new Map(
      existingInvestments.map((investment) => [
        investment.name.toLowerCase(),
        investment.id,
      ]),
    ),
    // `findOrCreateInvestment`, not the plain `createInvestment`: the
    // `existing` map above is built from one `listInvestments` read and does
    // not re-check on every row, so a name differing from a row already in
    // the database only by whitespace or case (which `existing`'s own
    // `.toLowerCase()` key does not normalize the same way the database's
    // `lower(btrim(name))` uniqueness does) would otherwise throw a duplicate
    // error here -- failing not just this investment but, since `ensure`
    // never gets an id to reuse, every entry that names it too.
    createInvestment: (fields) =>
      withKithTransaction(pool, (client) =>
        admin.findOrCreateInvestment(identityCtx(client), {
          principal,
          spaceId,
          ...fields,
        }),
      ),
    createEntry: (investmentId, body) =>
      withKithTransaction(pool, (client) =>
        admin.createInvestmentEntry(identityCtx(client), {
          principal,
          investmentId,
          ...body,
        }),
      ),
  };
}

export async function main(argv) {
  const args = argumentsFor(argv);

  // Registered before the dynamic import below, which is the whole reason
  // that import is dynamic: a static import is hoisted ahead of this call.
  register("./investments-import-resolve-hook.mjs", import.meta.url);
  const { buildPreview, planImport, runImport } = await import(WEB_LIB_URL);

  const summaryCsv = readFileSync(args.summary, "utf8");
  const ledgerCsv = readFileSync(args.ledger, "utf8");
  const preview = buildPreview(summaryCsv, ledgerCsv);
  const plan = planImport(preview);
  const report = reportOf(preview, plan);

  if (!args.apply) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, ...report }, null, 2)}\n`);
    return 0;
  }

  const { admin, createKithPool, withKithTransaction } = await import(
    KITH_STORE_INDEX_URL
  );
  const { identityCtx, requireSpaceAccess, webPrincipal } = await import(
    KITH_STORE_IDENTITY_URL
  );
  const pool = createKithPool(requireDatabaseUrl());
  try {
    const writer = await storeWriter({
      pool,
      spaceId: args.spaceId,
      principal: webPrincipal(args.userId),
      admin,
      identityCtx,
      withKithTransaction,
      requireSpaceAccess,
    });
    const outcome = await runImport(plan, writer);
    process.stdout.write(
      `${JSON.stringify({ dryRun: false, ...report, outcome }, null, 2)}\n`,
    );
    return outcome.failed.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof SpaceAccessDenied) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
