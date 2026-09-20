#!/usr/bin/env node
// `kith-extraction-span-cleanup`: remove evidence spans nothing points at.
//
// The operator half of `./spanSweep.ts`. The extraction write path now sweeps
// what it strands, but the spans stranded before it did are still there, and
// each one fails its generation's parsed-payload seal
// (`payload_verify_error:id_sets`) and so keeps the owner's Health screen red.
//
//   kith-extraction-span-cleanup              DRY RUN: counts only
//   kith-extraction-span-cleanup --apply      delete them
//   kith-extraction-span-cleanup --limit 25   generations per run (default 100)
//
// Dry run is the default and `--apply` is the only way to delete. Both modes
// run the identical selection, so the dry run's count is the number
// `--apply` will remove.
//
// Argument shape follows `./cli.ts` and `./diagnoseCli.ts` beside it:
// explicit flags and a `usage()` that exits, no library.
// `KITH_STORE_DATABASE_URL` is required and is never printed.
//
// **Every value it prints is a number or a boolean.** No id, no space, no
// document and no line of a page reaches standard output.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { createKithPool } from "../schema.js";
import { CleanupInterrupted, cleanupOrphanedExtractionSpans } from "./spanSweep.js";

function usage(): never {
  process.stderr.write(
    "Usage: kith-extraction-span-cleanup [--apply] [--limit N]\n",
  );
  process.exit(2);
}

type Parsed = { apply: boolean; limit?: number };

export function argumentsFor(argv: string[]): Parsed {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
  const parsed: Parsed = { apply: false };
  for (let index = 0; index < forwarded.length; index += 1) {
    const flag = forwarded[index];
    if (flag === "--apply") {
      parsed.apply = true;
    } else if (flag === "--limit") {
      const value = forwarded[index + 1];
      if (!value || !/^[1-9][0-9]{0,3}$/.test(value)) usage();
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
    const summary = await cleanupOrphanedExtractionSpans(pool, {
      apply: parsed.apply,
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } finally {
    await pool.end();
  }
}

/**
 * A failed run's report: the counts already committed, if the failure
 * happened partway through (numbers and booleans only, same as a clean run),
 * then the error's name -- not its message, since a thrown query error
 * carries the statement and its parameters, and a parameter here is a space
 * id. Always signals failure. Takes the writers as arguments so this is
 * testable without a real stdout or process.exit.
 */
export function reportFailure(
  error: unknown,
  writeStdout: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk: string) => void = (chunk) => {
    process.stderr.write(chunk);
  },
): number {
  if (error instanceof CleanupInterrupted) {
    writeStdout(`${JSON.stringify(error.summary, null, 2)}\n`);
  }
  writeStderr(`${error instanceof Error ? error.name : "Error"}\n`);
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => process.exit(reportFailure(error)),
  );
}
