#!/usr/bin/env node
// `kith-ingest-simple --root <dir> --source-account <id> [--space <id>] [--limit N]
// [--dry-run] [--concurrency N]`. See README.md.

import process from "node:process";

import { createKithPool } from "@repo/kith-store";

import { loadDatabaseUrl } from "./config.js";
import { runIngest, type IngestOptions } from "./ingest.js";

const DEFAULT_CONCURRENCY = 2;

function usage(): never {
  process.stderr.write(
    "Usage: kith-ingest-simple --root <dir> --source-account <id> " +
      "[--space <id>] [--limit N] [--dry-run] [--concurrency N]\n",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): IngestOptions {
  let root: string | undefined;
  let sourceAccountId: string | undefined;
  let spaceId: string | undefined;
  let limit: number | undefined;
  let dryRun = false;
  let concurrency = DEFAULT_CONCURRENCY;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--root":
        root = argv[++index];
        break;
      case "--source-account":
        sourceAccountId = argv[++index];
        break;
      case "--space":
        spaceId = argv[++index];
        break;
      case "--limit": {
        const value = Number(argv[++index]);
        if (!Number.isInteger(value) || value <= 0) usage();
        limit = value;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--concurrency": {
        const value = Number(argv[++index]);
        if (!Number.isInteger(value) || value <= 0) usage();
        concurrency = value;
        break;
      }
      default:
        usage();
    }
  }
  if (!root || !sourceAccountId) usage();
  return {
    root,
    sourceAccountId,
    ...(spaceId ? { spaceId } : {}),
    ...(limit ? { limit } : {}),
    dryRun,
    concurrency,
  };
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const databaseUrl = await loadDatabaseUrl();
  const pool = createKithPool(databaseUrl, Math.max(2, options.concurrency));
  try {
    const summary = await runIngest(pool, options, (message) => {
      process.stderr.write(`${message}\n`);
    });
    const extensionLines = [...summary.extension.entries()]
      .map(([ext, counts]) => `${ext} seen ${counts.seen} new ${counts.newCount}`)
      .join(", ");
    const skippedExtLines = [...summary.skippedExtension.entries()]
      .map(([ext, count]) => `${ext} ${count}`)
      .join(", ");
    process.stdout.write(
      [
        `seen ${summary.seen}`,
        `new ${summary.newCount}`,
        `skipped-unchanged ${summary.skippedUnchanged}`,
        `skipped-dot-or-archive ${summary.skippedDotOrArchive}`,
        `failed ${summary.failed}`,
        extensionLines ? `by-extension: ${extensionLines}` : undefined,
        skippedExtLines ? `unsupported extensions skipped: ${skippedExtLines}` : undefined,
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`kith-ingest-simple: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
