#!/usr/bin/env node
// `kith-plaid-feed link | pull`. See README.md for setup and the two
// commands; see docs/plans/2026-09-22-simplification-and-feeds.md for why
// this package exists.

import process from "node:process";

import { DEFAULT_LINK_PORT } from "./config.js";
import { runLinkServer } from "./link.js";
import { pullAll } from "./pull.js";

function usage(): never {
  process.stderr.write(
    "Usage: kith-plaid-feed link [--port N] | pull\n",
  );
  process.exit(2);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "link") {
    let port = DEFAULT_LINK_PORT;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === "--port") {
        const value = Number(rest[index + 1]);
        if (!Number.isInteger(value) || value <= 0) usage();
        port = value;
        index += 1;
      } else {
        usage();
      }
    }
    await runLinkServer(port);
    return;
  }
  if (command === "pull") {
    if (rest.length > 0) usage();
    const { anyFailed } = await pullAll();
    if (anyFailed) process.exitCode = 1;
    return;
  }
  usage();
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`kith-plaid-feed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
