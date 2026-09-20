#!/usr/bin/env node
// Adopt every already-attached document as an investment document link
// (ADM-8b, second review, B1).
//
// Migration 033 runs this same statement as it applies. The reason it is also
// a command is timing: the orchestrator applies the schema FIRST and deploys
// the new build afterwards, and in that window the OLD build is still
// answering requests and still writing bare `investment_entries.document_id`
// values with no link behind them. An entry in that state reads to the
// matcher as an entry with no document, so the next notice that scores ten
// points auto-links straight over the owner's own choice.
//
// So: run the migration, deploy, then run this once more. It is idempotent --
// the link's id is derived from the entry id, so a second run conflicts with
// the first run's own row and does nothing -- and running it a third time is
// free.
//
// Dry run is the default and prints counts. `--apply` performs it.
//
// Usage:
//   node scripts/investment-links-adopt.mjs
//   node scripts/investment-links-adopt.mjs --apply
//   node scripts/investment-links-adopt.mjs --space <id> [--apply]
//
// KITH_STORE_DATABASE_URL must point at the brain's PostgreSQL endpoint.
//
// COUNTS ONLY. This prints how many rows were adopted and how many could not
// be, and nothing else. An operator running a backfill has no need to read a
// document title, an investment name or an amount, and the rule in AGENTS.md
// is that an agent does not read the owner's data.

import process from "node:process";

function usage() {
  process.stderr.write(
    "Usage: investment-links-adopt [--space <id>] [--apply]\n",
  );
  process.exit(2);
}

export function argumentsFor(argv) {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
  let apply = false;
  let spaceId = null;
  for (let index = 0; index < forwarded.length; index += 1) {
    const flag = forwarded[index];
    if (flag === "--apply") {
      apply = true;
    } else if (flag === "--space") {
      const value = forwarded[index + 1];
      if (value === undefined) {
        process.stderr.write("--space requires a value\n");
        usage();
      }
      spaceId = value;
      index += 1;
    } else {
      usage();
    }
  }
  return { apply, spaceId };
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

const KITH_STORE_INDEX_URL = new URL(
  "../packages/kith-store/dist/index.js",
  import.meta.url,
).href;
const KITH_STORE_IDENTITY_URL = new URL(
  "../packages/kith-store/dist/identity/index.js",
  import.meta.url,
).href;
const KITH_STORE_ADMIN_URL = new URL(
  "../packages/kith-store/dist/admin/index.js",
  import.meta.url,
).href;

export async function main(argv) {
  const args = argumentsFor(argv);
  const url = requireDatabaseUrl();
  const { createKithPool, withKithTransaction } = await import(
    KITH_STORE_INDEX_URL
  );
  const { identityCtx } = await import(KITH_STORE_IDENTITY_URL);
  const { adoptLegacyEntryDocuments } = await import(KITH_STORE_ADMIN_URL);

  const pool = createKithPool(url, 1);
  try {
    const counts = await withKithTransaction(pool, (client) =>
      adoptLegacyEntryDocuments(identityCtx(client), {
        ...(args.spaceId === null ? {} : { spaceIds: [args.spaceId] }),
        apply: args.apply,
      }),
    );
    process.stdout.write(
      `${JSON.stringify({ mode: args.apply ? "apply" : "dry-run", ...counts }, null, 2)}\n`,
    );
    if (!args.apply && counts.pending > 0) {
      process.stdout.write("Re-run with --apply to write these links.\n");
    }
    if (counts.unadoptable > 0) {
      process.stdout.write(
        "Entries counted as unadoptable keep their document; no link was invented for them.\n",
      );
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
