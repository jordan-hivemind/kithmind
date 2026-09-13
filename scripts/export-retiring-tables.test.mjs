import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RETIRING_TABLES,
  exportTables,
  parseArguments,
} from "./export-retiring-tables.mjs";

test("requires a space and an output directory", () => {
  assert.throws(() => parseArguments(["--out", "/tmp/x"]), /--space/u);
  assert.throws(() => parseArguments(["--space", "s1"]), /--out/u);
  assert.throws(
    () => parseArguments(["--space", "s1", "--out", "/tmp/x", "--batch", "0"]),
    /--batch/u,
  );
});

test("passes unrecognised arguments through to convex run", () => {
  const options = parseArguments([
    "--space",
    "s1",
    "--out",
    "/tmp/x",
    "--prod",
  ]);
  assert.deepEqual(options.passthrough, ["--prod"]);
  assert.equal(options.spaceId, "s1");
});

test("writes one JSONL line per row across pages and reports counts", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "retiring-export-"));
  try {
    const counts = await exportTables({
      spaceId: "s1",
      outDir,
      runPage: ({ table, cursor }) =>
        cursor === null
          ? {
              rows: [{ _id: `${table}-1` }],
              scanned: 2,
              cursor: "page2",
              isDone: false,
            }
          : { rows: [{ _id: `${table}-2` }], scanned: 1, cursor: null, isDone: true },
    });

    assert.deepEqual(
      counts,
      RETIRING_TABLES.map((table) => ({ table, exported: 2, scanned: 3 })),
    );
    for (const table of RETIRING_TABLES) {
      const lines = readFileSync(join(outDir, `${table}.jsonl`), "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(lines, [{ _id: `${table}-1` }, { _id: `${table}-2` }]);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("fails loudly rather than looping when a cursor does not advance", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "retiring-export-"));
  try {
    await assert.rejects(
      exportTables({
        spaceId: "s1",
        outDir,
        runPage: () => ({
          rows: [],
          scanned: 0,
          cursor: null,
          isDone: false,
        }),
      }),
      /paging did not advance/u,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
