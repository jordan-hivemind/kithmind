// Synthetic-fixture unit tests for the walker: dotfiles, archive/backup
// subtrees and unsupported extensions are all skipped and counted, and only
// the four supported extensions are returned as files to ingest.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isSkippedSegment, walkRoot } from "../dist/walk.js";

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "ingest-simple-walk-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("isSkippedSegment flags dotfiles and archive/backup names", () => {
  assert.equal(isSkippedSegment(".DS_Store"), true);
  assert.equal(isSkippedSegment(".dropbox"), true);
  assert.equal(isSkippedSegment("Archive"), true);
  assert.equal(isSkippedSegment("old-backups"), true);
  assert.equal(isSkippedSegment("Statements"), false);
  assert.equal(isSkippedSegment("2024"), false);
});

test("walkRoot returns supported files and counts the rest", async (t) => {
  const root = await tempRoot(t);
  await writeFile(join(root, "note.txt"), "hello");
  await writeFile(join(root, "record.csv"), "a,b\n1,2\n");
  await writeFile(join(root, "readme.md"), "# hi");
  await writeFile(join(root, "statement.pdf"), "%PDF-1.4\n");
  await writeFile(join(root, "photo.jpg"), "not a photo");
  await writeFile(join(root, ".hidden.txt"), "skip me");

  await mkdir(join(root, "Archive"), { recursive: true });
  await writeFile(join(root, "Archive", "old.txt"), "skip me too");

  await mkdir(join(root, "Sub"), { recursive: true });
  await writeFile(join(root, "Sub", "nested.md"), "nested");

  const result = await walkRoot(root);

  const relativePaths = result.files.map((f) => f.relativePath).sort();
  assert.deepEqual(relativePaths, [
    "Sub/nested.md",
    "note.txt",
    "readme.md",
    "record.csv",
    "statement.pdf",
  ]);

  const extensions = new Map(result.files.map((f) => [f.relativePath, f.extension]));
  assert.equal(extensions.get("statement.pdf"), ".pdf");
  assert.equal(extensions.get("note.txt"), ".txt");
  assert.equal(extensions.get("readme.md"), ".md");
  assert.equal(extensions.get("record.csv"), ".csv");

  assert.equal(result.skippedExtension.get(".jpg"), 1);
  // Archive/ itself and the hidden file both count as skipped segments, not
  // extensions: the directory is never descended into.
  assert.equal(result.skippedDotOrArchive >= 2, true);
});

test("walkRoot never descends into an archive or backup subtree", async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, "Backups", "2023"), { recursive: true });
  await writeFile(join(root, "Backups", "2023", "old.pdf"), "%PDF-1.4\n");
  await writeFile(join(root, "current.pdf"), "%PDF-1.4\n");

  const result = await walkRoot(root);
  assert.deepEqual(
    result.files.map((f) => f.relativePath),
    ["current.pdf"],
  );
});
