#!/usr/bin/env node
// Backfills `retained_texts` (F1-66, pgSchema.ts migration version 9) from an
// existing raw tree. Every retained text written before that migration exists
// only as a file under the raw tree's `text/` namespace, and a hosted read
// surface has no raw tree: until its bytes are in the archive, every
// `retained_text_span_v1` citation over that text verifies on the owner's
// machine and answers `retained_evidence_unavailable` from the gateway.
//
// Walks `<raw tree root>/text/**/*.txt` -- the layout `textRelativePath`
// (rawTree.ts) defines and `writeRetainedText` writes -- and inserts the rows
// the archive is missing, keyed on each text's own sha256.
//
// Idempotent, by content addressing rather than by a flag: a text already on
// file is a no-op (`ON CONFLICT (sha256) DO NOTHING`), so a second run, or a
// run against a partially backfilled archive, writes nothing new and reports
// the rows as already present.
//
// Refuses rather than guesses, per file: a file whose bytes no longer hash to
// the name it sits under is raw-tree corruption, and storing it would store
// it under a hash it does not have. Those are counted, named and skipped; the
// rest of the walk still lands.
//
// Takes no archive write lock, unlike scripts/backfillHoldingRowHash.mjs.
// These rows are immutable and content addressed, so there is nothing for a
// concurrent import to disagree with, and holding the import lock across a
// walk of a thousand documents would block imports for the duration.
//
// Usage (development-first: point this at a throwaway database before a
// hosted one, same as scripts/backfillHoldingRowHash.mjs):
//
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//   FINANCE_ARCHIVE_RAW_TREE_ROOT=/path/to/managed/root \
//   FINANCE_ARCHIVE_SPACE_ID=<space id> \
//     node scripts/backfillRetainedTexts.mjs [--dry-run]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
} from "../dist/pgStore.js";
import {
  resolveRawTreeRoot,
  sha256HexOf,
  textRelativePath,
} from "../dist/rawTree.js";
import { storeRetainedTextBytes } from "../dist/retainedTexts.js";

/**
 * Backfills every retained text under `rawTreeRoot` into an already-connected
 * archive client. Returns counts, plus the relative path of every file whose
 * content no longer matches the hash it is stored under.
 *
 * `dryRun` reads and hashes every file exactly as a real run does and reports
 * what it would insert, without writing.
 *
 * Exported so `test/backfillRetainedTexts.test.mjs` can drive it against a
 * throwaway schema and a synthetic raw tree instead of shelling out here.
 */
export async function backfillRetainedTexts(
  client,
  rawTreeRoot,
  { dryRun = false } = {},
) {
  const report = { scanned: 0, inserted: 0, alreadyPresent: 0, mismatched: [] };
  const textRoot = join(rawTreeRoot, "text");

  let entries;
  try {
    entries = readdirSync(textRoot, { recursive: true });
  } catch (error) {
    // A raw tree that has never retained any text has no `text/` directory at
    // all, which is an empty backfill and not a failure.
    if (error.code === "ENOENT") return report;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".txt")) continue;
    report.scanned += 1;
    const content = readFileSync(join(textRoot, entry));
    const sha256 = sha256HexOf(content);
    if (join("text", entry) !== textRelativePath(sha256)) {
      report.mismatched.push(entry);
      continue;
    }
    if (dryRun) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time, on
      // purpose: a thousand statements' text is not a single round trip's
      // worth of memory.
      const present = await client.query(
        "SELECT 1 FROM retained_texts WHERE sha256 = $1",
        [sha256],
      );
      if (present.rowCount) report.alreadyPresent += 1;
      else report.inserted += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const written = await storeRetainedTextBytes(client, content);
    if (written.inserted) report.inserted += 1;
    else report.alreadyPresent += 1;
  }

  return report;
}

async function main() {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean", default: false } },
  });
  const dryRun = values["dry-run"] === true;
  // Both hard error when unset, naming exactly what is missing.
  const rawTreeRoot = resolveRawTreeRoot();
  const client = createArchiveClient(archiveDatabaseUrl(), archiveSchemaName());
  await client.connect();
  try {
    const report = await backfillRetainedTexts(client, rawTreeRoot, { dryRun });
    console.log(`mode: backfillRetainedTexts${dryRun ? " (dry run)" : ""}`);
    console.log(`retained text files scanned: ${report.scanned}`);
    console.log(
      `rows ${dryRun ? "that would be inserted" : "inserted"}: ${report.inserted}`,
    );
    console.log(`already on file: ${report.alreadyPresent}`);
    console.log(`hash mismatches skipped: ${report.mismatched.length}`);
    for (const path of report.mismatched) {
      console.log(`  text/${path} no longer hashes to the name it is stored under`);
    }
    if (report.mismatched.length > 0) {
      console.log(
        "\nThose files are raw-tree corruption, not a backfill problem: nothing " +
          "was written for them. Investigate before re-running.",
      );
      process.exitCode = 1;
    } else if (dryRun) {
      console.log("\nre-run without --dry-run to insert these rows");
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
