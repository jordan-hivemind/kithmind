// F1-66. scripts/backfillRetainedTexts.mjs against a real, throwaway archive
// and a synthetic raw tree: it must find every retained text the raw tree
// already holds, insert the rows the archive is missing, be idempotent on a
// second pass, write nothing on a dry run, and refuse a file whose bytes no
// longer hash to the name it sits under rather than store it under a hash it
// does not have.
//
// The raw tree here is written by `writeRetainedText` itself, so the layout
// under test is the real one rather than a spelling this file invented.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveRawTreeRoot,
  sha256HexOf,
  textRelativePath,
  writeRetainedText,
} from "../dist/index.js";

import { backfillRetainedTexts } from "../scripts/backfillRetainedTexts.mjs";

import { all, archive, count, one, skip } from "./helpers/pgArchive.mjs";

const SPACE_ID = "space_synthetic_backfill";

/** Two synthetic retained texts, written into a throwaway raw tree exactly
 * the way an import writes them. No real statement text anywhere. */
const TEXTS = [
  "HOLDINGS\nSynthetic Neutral Fund   10.000   $1,000.00   Cost 900.00\n",
  "ACTIVITY\n2026-03-04  Dividend  Synthetic Neutral Fund   $12.34\n",
];

function rawTree(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-backfill-raw-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return resolveRawTreeRoot({
    FINANCE_ARCHIVE_RAW_TREE_ROOT: directory,
    FINANCE_ARCHIVE_SPACE_ID: SPACE_ID,
  });
}

test(
  "backfillRetainedTexts inserts every retained text the raw tree holds, and a second pass inserts nothing",
  { skip },
  async (t) => {
    const client = await archive(t);
    const root = rawTree(t);
    for (const text of TEXTS) writeRetainedText(root, text);

    const dry = await backfillRetainedTexts(client, root, { dryRun: true });
    assert.deepEqual(dry, {
      scanned: 2,
      inserted: 2,
      alreadyPresent: 0,
      mismatched: [],
    });
    assert.equal(await count(client, "retained_texts"), 0, "a dry run writes nothing");

    const first = await backfillRetainedTexts(client, root);
    assert.deepEqual(first, {
      scanned: 2,
      inserted: 2,
      alreadyPresent: 0,
      mismatched: [],
    });

    for (const text of TEXTS) {
      const sha256 = sha256HexOf(Buffer.from(text, "utf8"));
      const row = await one(
        client,
        "SELECT byte_length::text AS byte_length, codepoint_length::text AS codepoint_length, content FROM retained_texts WHERE sha256 = $1",
        [sha256],
      );
      assert.ok(row, `the text at ${textRelativePath(sha256)} reached the archive`);
      assert.equal(row.content.toString("utf8"), text);
      assert.equal(Number(row.byte_length), Buffer.byteLength(text, "utf8"));
      assert.equal(Number(row.codepoint_length), Array.from(text).length);
    }

    // Idempotent by content addressing, not by a flag: nothing new to insert
    // and nothing to conflict with.
    const second = await backfillRetainedTexts(client, root);
    assert.deepEqual(second, {
      scanned: 2,
      inserted: 0,
      alreadyPresent: 2,
      mismatched: [],
    });
    assert.equal(await count(client, "retained_texts"), 2);

    // And a dry run over an already-backfilled tree reports the same.
    const dryAgain = await backfillRetainedTexts(client, root, { dryRun: true });
    assert.equal(dryAgain.inserted, 0);
    assert.equal(dryAgain.alreadyPresent, 2);
  },
);

test(
  "backfillRetainedTexts skips a file whose bytes no longer hash to the name it is stored under, and still lands the rest",
  { skip },
  async (t) => {
    const client = await archive(t);
    const root = rawTree(t);
    const good = writeRetainedText(root, TEXTS[0]);
    const corrupt = writeRetainedText(root, TEXTS[1]);
    // Raw-tree corruption: the content-addressed path now holds other bytes.
    writeFileSync(corrupt.path, "not the text this path names\n");

    const report = await backfillRetainedTexts(client, root);
    assert.equal(report.scanned, 2);
    assert.equal(report.inserted, 1);
    assert.deepEqual(report.mismatched, [
      textRelativePath(corrupt.sha256).slice("text/".length),
    ]);

    const rows = await all(client, "SELECT sha256 FROM retained_texts");
    assert.deepEqual(
      rows.map((row) => row.sha256),
      [good.sha256],
      "nothing was stored under a hash it does not have",
    );
  },
);

test(
  "backfillRetainedTexts over a raw tree that has retained no text at all is an empty pass, not a failure",
  { skip },
  async (t) => {
    const client = await archive(t);
    const report = await backfillRetainedTexts(client, rawTree(t));
    assert.deepEqual(report, {
      scanned: 0,
      inserted: 0,
      alreadyPresent: 0,
      mismatched: [],
    });
  },
);
