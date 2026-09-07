import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  canonicalRoots,
  discoverFiles,
  FilesystemFailure,
  readUtf8File,
} from "../dist/filesystem.js";

const execFileAsync = promisify(execFile);

function config(root, journal, overrides = {}) {
  return {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space",
    sourceAccountId: "source",
    credentialEnv: "TOKEN",
    roots: [{ alias: "test", path: root }],
    journalDir: journal,
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
    ...overrides,
  };
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "pipeline-fs-test-"));
  const root = join(base, "root");
  const journal = join(base, "journal");
  await mkdir(root, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(journal, 0o700);
  return { base, root, journal };
}

test("unsupported filesystem nodes fail the whole discovery", async () => {
  const { root, journal } = await setup();
  await writeFile(join(root, "note.txt"), "synthetic");
  const roots = await canonicalRoots(config(root, journal));
  const files = await discoverFiles(config(root, journal), roots);
  assert.equal(files.length, 1);
  await symlink(join(root, "note.txt"), join(root, "link-not-text"));
  await assert.rejects(
    () => discoverFiles(config(root, journal), roots),
    (error) => error instanceof FilesystemFailure && error.code === "unstable",
  );
});

test("BOM-prefixed UTF-8 preserves byte identity through text admission", async () => {
  const { root, journal } = await setup();
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]);
  await writeFile(join(root, "bom.txt"), bytes);
  const [safeRoot] = await canonicalRoots(config(root, journal));
  const result = await readUtf8File(safeRoot, "bom.txt", 65_536);
  assert.deepEqual(Buffer.from(result.text, "utf8"), bytes);
  assert.equal(result.byteLength, bytes.byteLength);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("empty, oversized, malformed UTF-8, and FIFO entries fail closed", async () => {
  for (const kind of ["empty", "oversized", "utf8", "fifo"]) {
    const { root, journal } = await setup();
    const path = join(root, "candidate.txt");
    if (kind === "empty") await writeFile(path, Buffer.alloc(0));
    else if (kind === "oversized") await writeFile(path, Buffer.alloc(9));
    else if (kind === "utf8") await writeFile(path, Buffer.from([0xc3, 0x28]));
    else await execFileAsync("mkfifo", [path]);
    const localConfig = config(root, journal, { maxFileBytes: 8 });
    const roots = await canonicalRoots(localConfig);
    await assert.rejects(
      () => discoverFiles(localConfig, roots),
      (error) =>
        error instanceof FilesystemFailure &&
        ["empty", "oversized", "unsupported"].includes(error.code),
    );
  }
});

test("unsafe ownership boundaries and root or journal overlap are rejected", async () => {
  const { root, journal } = await setup();
  await chmod(root, 0o770);
  await assert.rejects(
    () => canonicalRoots(config(root, journal)),
    (error) =>
      error instanceof FilesystemFailure && error.code === "permission_denied",
  );
  await chmod(root, 0o700);
  const child = join(root, "child");
  await mkdir(child, { mode: 0o700 });
  await assert.rejects(
    () =>
      canonicalRoots(
        config(root, journal, {
          roots: [
            { alias: "first", path: root },
            { alias: "second", path: child },
          ],
        }),
      ),
    (error) => error instanceof FilesystemFailure && error.code === "unstable",
  );
  await assert.rejects(
    () => canonicalRoots(config(root, child)),
    (error) => error instanceof FilesystemFailure && error.code === "unstable",
  );
});

test("filesystem traversal has a hard node bound separate from file count", async () => {
  const { root, journal } = await setup();
  await Promise.all(
    Array.from({ length: 4_097 }, (_, index) =>
      mkdir(join(root, `d-${index.toString().padStart(4, "0")}`)),
    ),
  );
  const roots = await canonicalRoots(config(root, journal));
  await assert.rejects(
    () => discoverFiles(config(root, journal), roots),
    (error) => error instanceof FilesystemFailure && error.code === "oversized",
  );
});
