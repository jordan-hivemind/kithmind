#!/usr/bin/env node
// `kith-plaid-feed link | pull | import-archive`. See README.md for setup
// and the commands; see docs/plans/2026-09-22-simplification-and-feeds.md
// for why this package exists.

import process from "node:process";

import { createArchiveClient } from "@repo/finance-archive/store";

import { loadArchiveReaderDatabaseUrl, loadDatabaseUrl } from "./config.js";
import { openPool } from "./db.js";
import {
  archiveReader,
  assertArchiveSchemaReady,
  importArchive,
  summarizeImportArchive,
} from "./importArchive.js";
import { DEFAULT_LINK_TIMEOUT_MS, runLink } from "./link.js";
import { pullAll } from "./pull.js";

function usage(): never {
  process.stderr.write(
    "Usage: kith-plaid-feed link [--timeout MINUTES] | pull | import-archive\n",
  );
  process.exit(2);
}

async function importArchiveCommand(): Promise<void> {
  const [archiveUrl, databaseUrl] = await Promise.all([
    Promise.resolve(loadArchiveReaderDatabaseUrl()),
    loadDatabaseUrl(),
  ]);
  // `createArchiveClient` pins `search_path=finance` and the archive's own
  // NUMERIC-as-text decoding (`ARCHIVE_TYPES`), the same connection shape
  // every other archive reader in this repository uses.
  const archiveClient = createArchiveClient(archiveUrl);
  const pool = openPool(databaseUrl);
  await archiveClient.connect();
  try {
    await assertArchiveSchemaReady(archiveClient);
    const result = await importArchive(archiveReader(archiveClient), pool);
    process.stdout.write(`${summarizeImportArchive(result)}\n`);
  } finally {
    await archiveClient.end();
    await pool.end();
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "link") {
    let timeoutMs = DEFAULT_LINK_TIMEOUT_MS;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === "--timeout") {
        const minutes = Number(rest[index + 1]);
        if (!Number.isFinite(minutes) || minutes <= 0) usage();
        timeoutMs = minutes * 60_000;
        index += 1;
      } else {
        usage();
      }
    }
    const outcome = await runLink(timeoutMs);
    if (outcome.status !== "linked") process.exitCode = 1;
    return;
  }
  if (command === "pull") {
    if (rest.length > 0) usage();
    const { anyFailed } = await pullAll();
    if (anyFailed) process.exitCode = 1;
    return;
  }
  if (command === "import-archive") {
    if (rest.length > 0) usage();
    await importArchiveCommand();
    return;
  }
  usage();
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`kith-plaid-feed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  // Plaid returns its diagnosis in the HTTP body; axios hides it behind
  // "Request failed with status code 400". Surface it so the operator sees
  // the actual cause without a debugger.
  const data = (error as { response?: { data?: Record<string, unknown> } })
    ?.response?.data;
  if (data && typeof data === "object") {
    const code = data.error_code;
    const message = data.error_message;
    const type = data.error_type;
    if (typeof code === "string" || typeof message === "string") {
      return `Plaid ${String(type ?? "error")} ${String(code ?? "")}: ${String(message ?? "")}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
