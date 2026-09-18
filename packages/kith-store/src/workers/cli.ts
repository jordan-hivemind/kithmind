#!/usr/bin/env node
// `kith-discovery-reset`: the operator route out of the discovery attempt cap.
//
// Use it when a pass reports `lease_conflict` on an item and the item's work row
// has reached `MAX_WORKER_DISCOVERY_ATTEMPTS`. Both reserve paths refuse at the
// cap and nothing in the protocol lowers the counter, so a document whose
// attempts were spent on a client defect stays unreachable after the defect is
// fixed. `resetExhaustedDiscoveryWork` beside this file is what it calls.
//
//   kith-discovery-reset                         count every space, write nothing
//   kith-discovery-reset --space <id>            count one space
//   kith-discovery-reset --space <id> --apply    reset that space's counted rows
//
// A dry run may sweep every space, because counting has no consequence. A write
// may not: `--apply` requires `--space`, so the operator names the space they
// read a count for. Nothing here reports which rows it would touch, so a
// repository-wide write would be one nobody could have reviewed first.
//
// Argument shape follows `../embeddings/cli.ts`, which follows
// `packages/pipeline/src/cli.ts`: explicit flags and a `usage()` that exits, no
// library. `KITH_STORE_DATABASE_URL` is required and is never printed. One JSON
// line per space goes to standard output carrying the space id and two counts:
// no titles, uris, hashes or connection string.
//
// One `SERIALIZABLE` transaction per space, as `db.ts` requires of everything
// that touches these rows: the rows a call counts are the rows it resets.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { KITH_ID } from "../ids.js";
import { createKithPool, withKithTransaction } from "../schema.js";
import {
  resetExhaustedDiscoveryWork,
  spacesWithExhaustedDiscoveryWork,
} from "./exhaustedWork.js";

function usage(): never {
  process.stderr.write(
    "Usage: kith-discovery-reset [--space <id>] [--apply]\n" +
      "       --apply requires --space\n",
  );
  process.exit(2);
}

export type Parsed = { spaceId: string | null; apply: boolean };

export function argumentsFor(argv: string[]): Parsed {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
  let spaceId: string | null = null;
  let apply = false;
  for (let index = 0; index < forwarded.length; index += 1) {
    const flag = forwarded[index];
    if (flag === "--apply") {
      apply = true;
    } else if (flag === "--space") {
      const value = forwarded[index + 1];
      if (value === undefined || !KITH_ID.test(value)) {
        process.stderr.write("--space requires a space id\n");
        usage();
      }
      spaceId = value;
      index += 1;
    } else {
      usage();
    }
  }
  if (apply && spaceId === null) {
    process.stderr.write("--apply requires --space\n");
    usage();
  }
  return { spaceId, apply };
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
    const spaceIds = parsed.spaceId
      ? [parsed.spaceId]
      : await withKithTransaction(pool, (client) =>
          spacesWithExhaustedDiscoveryWork(client),
        );
    for (const spaceId of spaceIds) {
      const result = await withKithTransaction(pool, (client) =>
        resetExhaustedDiscoveryWork(client, {
          spaceId,
          apply: parsed.apply,
          now: Date.now(),
        }),
      );
      process.stdout.write(
        `${JSON.stringify({
          spaceId: result.spaceId,
          eligible: result.eligible,
          reset: result.reset,
          applied: parsed.apply,
        })}\n`,
      );
    }
    return 0;
  } finally {
    await pool.end();
  }
}

function errorMessage(error: unknown): string {
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
