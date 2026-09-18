#!/usr/bin/env node
// `kith-reembed`: cutover step 8 of docs/plans/2026-09-12-postgres-consolidation.md.
//
// Section 5.2 re-derives embedding vectors after cutover instead of migrating
// them, but `kith-migrate` still carries `covered_fingerprint`, so a migrated
// space claims coverage no vector row backs and the provider fill skips those
// targets forever. `recoverEmbeddingCoverage` puts them back on the owed index
// and queues the fill; this is the operator's way to call it.
//
//   kith-reembed                   count per space, write nothing
//   kith-reembed --apply           invalidate and queue the fill
//   kith-reembed --space <id>      one space instead of every space
//
// Argument shape follows `../deferred/cli.ts`, which follows
// `packages/pipeline/src/cli.ts`: explicit flags and a `usage()` that exits,
// no library. `KITH_STORE_DATABASE_URL` is required and is never printed.
// One JSON line per space goes to standard output, carrying counts and the
// space id only: no target text and no connection string.
//
// One `SERIALIZABLE` transaction per space, because the counter delta and the
// queued fill have to commit with the targets they describe or not at all. The
// fill itself is the daemon's (`kith-deferred-work drain`), which is where the
// provider call belongs.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { identityCtx } from "../identity/db.js";
import { KITH_ID } from "../ids.js";
import { createKithPool, withKithTransaction } from "../schema.js";
import { recoverEmbeddingCoverage } from "./build.js";

function usage(): never {
  process.stderr.write("Usage: kith-reembed [--space <id>] [--apply]\n");
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
    // Only a space with an active index can owe anything; the rest have no
    // fingerprint to be uncovered under.
    const spaceIds = parsed.spaceId
      ? [parsed.spaceId]
      : (
          await pool.query<{ space_id: string }>(
            `SELECT space_id FROM kith.space_embedding_states
              WHERE active_fingerprint IS NOT NULL ORDER BY created_at, id`,
          )
        ).rows.map((row) => row.space_id);
    for (const spaceId of spaceIds) {
      const result = await withKithTransaction(pool, (client) =>
        recoverEmbeddingCoverage(identityCtx(client, Date.now()), {
          spaceId,
          apply: parsed.apply,
        }),
      );
      process.stdout.write(
        `${JSON.stringify({
          spaceId: result.spaceId,
          vectorless: result.vectorless,
          invalidated: result.invalidated,
          complete: result.complete,
          scheduled: result.scheduled,
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
