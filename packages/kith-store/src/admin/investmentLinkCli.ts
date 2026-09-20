#!/usr/bin/env node
// `kith-investment-link-backfill`: the operator route for ADM-8c.
//
// The three triggers (`investmentLinkWork.ts`) only ever fire on a write.
// Every document extracted before this slice existed -- the owner's 91 -- was
// therefore never offered to the matcher, and nothing would offer it until
// the document was re-extracted or an entry beside it was edited. This is how
// they are put in the queue once.
//
//   kith-investment-link-backfill                   count per space, write nothing
//   kith-investment-link-backfill --apply           enqueue the counted documents
//   kith-investment-link-backfill --space <id>      one space instead of every space
//   kith-investment-link-backfill --kind <kind>     one matchable kind
//   kith-investment-link-backfill --limit N         bound per space (default 200, max 1000)
//
// Argument shape follows `../extraction/cli.ts`, which this stands beside:
// explicit flags and a `usage()` that exits, no library.
// `KITH_STORE_DATABASE_URL` is required and is never printed.
//
// COUNTS ONLY. One JSON line per space carrying the space id and three
// numbers. No document title, no document id, no investment name, no amount:
// an operator running a backfill needs to know how much work it made, and
// nothing about whose paper it is.
//
// IT NEVER EVALUATES INLINE. It enqueues; the daemon drains. See
// `scheduleInvestmentLinkBackfill` for why.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { KITH_ID } from "../ids.js";
import { createKithPool, withKithTransaction } from "../schema.js";
import { workerCtx } from "../workers/db.js";
import {
  MATCHABLE_KIND_NAMES,
  scheduleInvestmentLinkBackfill,
} from "./investmentLinkWork.js";

function usage(): never {
  process.stderr.write(
    "Usage: kith-investment-link-backfill [--space <id>] [--kind <kind>] [--limit N] [--apply]\n",
  );
  process.exit(2);
}

export type Parsed = {
  spaceId: string | null;
  kind: string | null;
  limit: number | null;
  apply: boolean;
};

export function argumentsFor(argv: string[]): Parsed {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
  let spaceId: string | null = null;
  let kind: string | null = null;
  let limit: number | null = null;
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
    } else if (flag === "--kind") {
      const value = forwarded[index + 1];
      // A kind the scorer has no rules for would select documents that can
      // never produce a candidate, so the queue would fill with jobs that
      // return `kind_not_matchable`. Named here rather than discovered there.
      if (value === undefined || !MATCHABLE_KIND_NAMES.includes(value)) {
        process.stderr.write(
          `--kind must be one of: ${MATCHABLE_KIND_NAMES.join(", ")}\n`,
        );
        usage();
      }
      kind = value;
      index += 1;
    } else if (flag === "--limit") {
      const value = forwarded[index + 1];
      const parsedLimit = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        process.stderr.write("--limit requires a positive integer\n");
        usage();
      }
      limit = parsedLimit;
      index += 1;
    } else {
      usage();
    }
  }
  return { spaceId, kind, limit, apply };
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
      : (
          await pool.query<{ id: string }>(
            `SELECT id FROM kith.spaces ORDER BY created_at, id`,
          )
        ).rows.map((row) => row.id);
    for (const spaceId of spaceIds) {
      const result = await withKithTransaction(pool, (client) =>
        scheduleInvestmentLinkBackfill(workerCtx(client, Date.now()), {
          spaceId,
          ...(parsed.kind === null ? {} : { kind: parsed.kind }),
          ...(parsed.limit === null ? {} : { limit: parsed.limit }),
          apply: parsed.apply,
        }),
      );
      process.stdout.write(
        `${JSON.stringify({
          spaceId,
          considered: result.considered,
          enqueued: result.enqueued,
          alreadyQueued: result.alreadyQueued,
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
