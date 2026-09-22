#!/usr/bin/env node
// `kith-ingest-simple --root <dir> --source-account <id> [--space <id>] [--limit N]
// [--dry-run] [--concurrency N] [--bindings <path> --root-alias <alias>]`. See README.md.

import process from "node:process";

import { createKithPool } from "@repo/kith-store";

import { loadBindings } from "./bindings.js";
import { loadDatabaseUrl } from "./config.js";
import { runIngest, type IngestOptions } from "./ingest.js";

const DEFAULT_CONCURRENCY = 2;

function usage(): never {
  process.stderr.write(
    "Usage: kith-ingest-simple --root <dir> --source-account <id> " +
      "[--space <id>] [--limit N] [--dry-run] [--concurrency N] " +
      "[--bindings <path> --root-alias <alias>]\n",
  );
  process.exit(2);
}

type ParsedArgs = Omit<IngestOptions, "externalIdBindings"> & {
  bindingsPath?: string;
  rootAlias?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  let root: string | undefined;
  let sourceAccountId: string | undefined;
  let spaceId: string | undefined;
  let limit: number | undefined;
  let dryRun = false;
  let concurrency = DEFAULT_CONCURRENCY;
  let bindingsPath: string | undefined;
  let rootAlias: string | undefined;
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
      case "--bindings":
        bindingsPath = argv[++index];
        break;
      case "--root-alias":
        rootAlias = argv[++index];
        break;
      default:
        usage();
    }
  }
  if (!root || !sourceAccountId) usage();
  // Both or neither: a bindings file with no root alias to filter it by (or
  // vice versa) cannot be resolved into a lookup, so it is a usage error
  // rather than a silent no-op.
  if ((bindingsPath === undefined) !== (rootAlias === undefined)) usage();
  return {
    root,
    sourceAccountId,
    ...(spaceId ? { spaceId } : {}),
    ...(limit ? { limit } : {}),
    dryRun,
    concurrency,
    ...(bindingsPath !== undefined ? { bindingsPath } : {}),
    ...(rootAlias !== undefined ? { rootAlias } : {}),
  };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  let externalIdBindings: Map<string, string> | undefined;
  let bindingsLoaded = 0;
  if (args.bindingsPath !== undefined && args.rootAlias !== undefined) {
    const result = await loadBindings(args.bindingsPath, args.rootAlias);
    externalIdBindings = result.map;
    bindingsLoaded = result.loaded;
  }
  const options: IngestOptions = {
    root: args.root,
    sourceAccountId: args.sourceAccountId,
    ...(args.spaceId ? { spaceId: args.spaceId } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
    dryRun: args.dryRun,
    concurrency: args.concurrency,
    ...(externalIdBindings ? { externalIdBindings } : {}),
  };

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
        externalIdBindings ? `bindings loaded ${bindingsLoaded}` : undefined,
        externalIdBindings ? `files matched by binding ${summary.matchedByBinding}` : undefined,
        externalIdBindings ? `files using path IDs ${summary.usingPathId}` : undefined,
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
