#!/usr/bin/env node
// `kith-extraction-diagnose`: why extractions are failing, in numbers.
//
// The operator half of `./diagnose.ts`. It exists because the people debugging
// extraction are not allowed to read the documents it extracts, and two live
// trials in a row stalled on exactly that: a queue full of
// `value_not_in_quote` and no way to tell a model citing the wrong line from a
// page layout the reader cannot handle.
//
//   kith-extraction-diagnose                  the most recent extractions
//   kith-extraction-diagnose --kind receipt   one kind
//   kith-extraction-diagnose --limit 50       how many documents (default 20)
//
// Argument shape follows `./cli.ts` beside it: explicit flags and a `usage()`
// that exits, no library. `KITH_STORE_DATABASE_URL` is required and is never
// printed. One JSON object on standard output.
//
// **Every value it prints is a number, a boolean, an enum reason or a field
// name.** The closest thing to content is `signature`, which folds every
// letter to `a` and every digit to `9`; see `valueSignature` in
// `./diagnose.ts` for what that can and cannot carry. Nothing reaching
// standard output holds a vendor, an amount, a date or a line of a page.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { createKithPool, withKithReadTransaction } from "../schema.js";
import { diagnoseExtractions } from "./diagnose.js";

function usage(): never {
  process.stderr.write(
    "Usage: kith-extraction-diagnose [--kind <kind>] [--limit N]\n",
  );
  process.exit(2);
}

type Parsed = { kind?: string; limit?: number };

export function argumentsFor(argv: string[]): Parsed {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
  const parsed: Parsed = {};
  for (let index = 0; index < forwarded.length; index += 1) {
    const flag = forwarded[index];
    if (flag === "--kind") {
      const value = forwarded[index + 1];
      // A kind is an identifier. Checked at the edge so a malformed flag
      // fails here rather than as a query that matches nothing.
      if (!value || !/^[a-z][a-z0-9_]{0,99}$/.test(value)) usage();
      parsed.kind = value;
      index += 1;
    } else if (flag === "--limit") {
      const value = forwarded[index + 1];
      if (!value || !/^[1-9][0-9]{0,2}$/.test(value)) usage();
      parsed.limit = Number(value);
      index += 1;
    } else {
      usage();
    }
  }
  return parsed;
}

function requireDatabaseUrl(): string {
  const url = process.env.KITH_STORE_DATABASE_URL;
  if (!url) {
    process.stderr.write(
      "KITH_STORE_DATABASE_URL must be set to the brain's PostgreSQL endpoint.\n",
    );
    process.exit(2);
  }
  return url;
}

export async function main(argv: string[]): Promise<number> {
  const parsed = argumentsFor(argv);
  const pool = createKithPool(requireDatabaseUrl());
  try {
    const summary = await withKithReadTransaction(pool, (client) =>
      diagnoseExtractions(client, parsed),
    );
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // The error's name, not its message: a thrown query error carries the
      // statement and its parameters, and a parameter here is a space id.
      process.stderr.write(
        `${error instanceof Error ? error.name : "Error"}\n`,
      );
      process.exit(1);
    },
  );
}
