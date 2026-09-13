#!/usr/bin/env node
// Operator export for P2-39l. Writes one JSONL file per retiring table for a
// space and prints only counts on stdout. Run this before the pull request that
// drops `lists`, `listItems`, `reports` and `insights` is merged.
//
//   node scripts/export-retiring-tables.mjs --space <SPACE_ID> --out <DIR> --prod
//
// Unrecognised arguments are passed through to `convex run`, which is how the
// deployment is selected (`--prod`, `--deployment <name>`).
import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const RETIRING_TABLES = ["lists", "listItems", "reports", "insights"];
const CONVEX_FUNCTION = "models/retirement/jsonlExport:exportPage";
const USAGE =
  "Usage: node scripts/export-retiring-tables.mjs --space <spaceId> --out <directory> [--batch <rows>] [convex run flags]";

export function parseArguments(argv) {
  const passthrough = [];
  let spaceId;
  let outDir;
  let batchSize;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      return { help: true };
    }
    if (argument === "--space" || argument === "--out" || argument === "--batch") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--space") spaceId = value;
      else if (argument === "--out") outDir = value;
      else batchSize = Number(value);
      index += 1;
      continue;
    }
    passthrough.push(argument);
  }

  if (!spaceId) throw new Error("--space <spaceId> is required");
  if (!outDir) throw new Error("--out <directory> is required");
  if (
    batchSize !== undefined &&
    (!Number.isInteger(batchSize) || batchSize < 1)
  ) {
    throw new Error("--batch must be a positive integer");
  }
  return { spaceId, outDir, batchSize, passthrough };
}

/**
 * Pages every retiring table into `<outDir>/<table>.jsonl` and returns the
 * counts. `runPage` takes the query arguments and returns the page, so the
 * paging and file writing are testable without a deployment.
 */
export async function exportTables({ spaceId, outDir, batchSize, runPage }) {
  await mkdir(outDir, { recursive: true });
  const counts = [];

  for (const table of RETIRING_TABLES) {
    const file = join(outDir, `${table}.jsonl`);
    await writeFile(file, "");
    let cursor = null;
    let exported = 0;
    let scanned = 0;

    for (;;) {
      const page = await runPage({ spaceId, table, cursor, batchSize });
      scanned += page.scanned;
      exported += page.rows.length;
      if (page.rows.length > 0) {
        await appendFile(
          file,
          `${page.rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        );
      }
      if (page.isDone) break;
      if (page.cursor === null || page.cursor === cursor) {
        throw new Error(`${table} paging did not advance`);
      }
      cursor = page.cursor;
    }

    counts.push({ table, exported, scanned });
  }

  return counts;
}

const execFileAsync = promisify(execFile);
const convexDirectory = fileURLToPath(new URL("../packages/convex", import.meta.url));

async function runPageViaConvexCli(passthrough, args) {
  const { stdout } = await execFileAsync(
    "npx",
    ["convex", "run", CONVEX_FUNCTION, JSON.stringify(args), ...passthrough],
    { cwd: convexDirectory, maxBuffer: 64 * 1024 * 1024 },
  );
  // ponytail: takes the CLI result as everything from the first "{". Convex
  // prints function logs before the result; revisit if that ever changes.
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`${CONVEX_FUNCTION} returned no result`);
  return JSON.parse(stdout.slice(start));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const counts = await exportTables({
    ...options,
    runPage: (args) => runPageViaConvexCli(options.passthrough, args),
  });
  for (const { table, exported, scanned } of counts) {
    process.stdout.write(`${table} exported=${exported} scanned=${scanned}\n`);
  }
}
