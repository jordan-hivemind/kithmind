#!/usr/bin/env node
// `kith-extraction-classification-upgrade`: version corrected starter guidance.
//
// Dry-run is the default. Output contains space ids, versions and status only,
// never document metadata or extracted values.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { KITH_ID } from "../ids.js";
import { createKithPool, withKithTransaction } from "../schema.js";
import { workerCtx } from "../workers/db.js";
import { upgradeInvestmentAgreementClassification } from "./classificationUpgrade.js";

function usage(): never {
  process.stderr.write(
    "Usage: kith-extraction-classification-upgrade [--space <id>] [--apply]\n",
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
      : (
          await pool.query<{ id: string }>(
            `SELECT id FROM kith.spaces ORDER BY created_at, id`,
          )
        ).rows.map((space) => space.id);
    for (const spaceId of spaceIds) {
      const result = await withKithTransaction(pool, (client) =>
        upgradeInvestmentAgreementClassification(
          workerCtx(client, Date.now()),
          {
            spaceId,
            apply: parsed.apply,
          },
        ),
      );
      process.stdout.write(
        `${JSON.stringify({ spaceId, ...result, apply: parsed.apply })}\n`,
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
