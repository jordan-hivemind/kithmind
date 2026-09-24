#!/usr/bin/env node
// `kith-epic-feed authorize --person <id-or-name> [--org "<health system>"]
// [--sandbox] | pull | check [--org "<health system>"] [--sandbox]`. See
// README.md for setup and the commands; see
// docs/plans/2026-09-22-simplification-and-feeds.md for why this package
// exists (order of work items 4 and 5).

import process from "node:process";

import { runAuthorize, type AuthorizeArgs } from "./authorize.js";
import { runCheck, type CheckArgs } from "./check.js";
import { loadDatabaseUrl } from "./config.js";
import { openPool } from "./db.js";
import { pullAll } from "./pull.js";

function usage(): never {
  process.stderr.write(
    "Usage: kith-epic-feed authorize --person <id-or-name> " +
      '[--org "<health system name>"] [--sandbox] | pull | ' +
      'check [--org "<health system name>"] [--sandbox]\n',
  );
  process.exit(2);
}

function parseAuthorizeArgs(rest: string[]): AuthorizeArgs {
  let personSelector: string | undefined;
  let org: string | undefined;
  let sandbox = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--person") {
      personSelector = rest[index + 1];
      index += 1;
    } else if (arg === "--org") {
      org = rest[index + 1];
      index += 1;
    } else if (arg === "--sandbox") {
      sandbox = true;
    } else {
      usage();
    }
  }
  if (personSelector === undefined || personSelector === "") usage();
  return { personSelector, org, sandbox };
}

async function authorizeCommand(rest: string[]): Promise<void> {
  const args = parseAuthorizeArgs(rest);
  const databaseUrl = await loadDatabaseUrl();
  const pool = openPool(databaseUrl);
  try {
    await runAuthorize(args, { pool });
  } finally {
    await pool.end();
  }
}

function parseCheckArgs(rest: string[]): CheckArgs {
  let org: string | undefined;
  let sandbox = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--org") {
      org = rest[index + 1];
      index += 1;
    } else if (arg === "--sandbox") {
      sandbox = true;
    } else {
      usage();
    }
  }
  return { org, sandbox };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "authorize") {
    await authorizeCommand(rest);
    return;
  }
  if (command === "pull") {
    if (rest.length > 0) usage();
    const { anyFailed } = await pullAll();
    if (anyFailed) process.exitCode = 1;
    return;
  }
  if (command === "check") {
    await runCheck(parseCheckArgs(rest));
    return;
  }
  usage();
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`kith-epic-feed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
