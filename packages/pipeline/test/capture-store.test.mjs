import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  capturePdfFile,
  CaptureStoreError,
  inspectCapturedPdf,
  removeCapturedPdfExact,
} from "../dist/captureStore.js";
import { canonicalRoots } from "../dist/filesystem.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "capture-store-")));
  const root = join(base, "root");
  const journal = join(base, "journal");
  const captures = join(base, "captures");
  await Promise.all(
    [root, journal, captures].map(async (path) => {
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );
  const config = {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space",
    sourceAccountId: "source",
    credentialEnv: "TOKEN",
    roots: [{ alias: "docs", path: root }],
    journalDir: journal,
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
  };
  const [safeRoot] = await canonicalRoots(config);
  return { base, root, captures, safeRoot };
}

async function observed(path, bytes) {
  const entry = await stat(path);
  return {
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    sourceModifiedAt: Math.trunc(entry.mtimeMs),
  };
}

test("captures one descriptor-bound PDF and removes only its exact inode", async () => {
  const f = await fixture();
  const bytes = Buffer.from("%PDF-1.7\nsynthetic capture\n%%EOF\n");
  const source = join(f.root, "report.pdf");
  await writeFile(source, bytes);
  const captureId = randomUUID();
  const expected = await observed(source, bytes);
  const captured = await capturePdfFile({
    root: f.safeRoot,
    relativePath: "report.pdf",
    captureDirectory: f.captures,
    captureId,
    expected,
  });
  assert.deepEqual(await readFile(captured.path), bytes);
  assert.equal((await lstat(captured.path)).mode & 0o777, 0o600);
  assert.deepEqual(
    await inspectCapturedPdf({
      captureDirectory: f.captures,
      captureId,
      expected,
      expectedDirectory: captured.captureDirectory,
    }),
    captured,
  );
  assert.deepEqual(await removeCapturedPdfExact(captured), {
    state: "removed",
  });
  assert.deepEqual(await removeCapturedPdfExact(captured), {
    state: "already_missing",
  });
  await assert.rejects(() => stat(captured.path), { code: "ENOENT" });
});

test("rejects changed observations and leaves no capture", async () => {
  const f = await fixture();
  const bytes = Buffer.from("%PDF-1.7\nsource\n");
  const source = join(f.root, "changed.pdf");
  await writeFile(source, bytes);
  const captureId = randomUUID();
  const expected = await observed(source, bytes);
  await assert.rejects(
    () =>
      capturePdfFile({
        root: f.safeRoot,
        relativePath: "changed.pdf",
        captureDirectory: f.captures,
        captureId,
        expected: { ...expected, sha256: "0".repeat(64) },
      }),
    (error) =>
      error instanceof CaptureStoreError && error.code === "digest_mismatch",
  );
  await assert.rejects(() => stat(join(f.captures, `${captureId}.pdf`)), {
    code: "ENOENT",
  });
});

test("rejects source symlinks and capture directories inside the source root", async () => {
  const f = await fixture();
  const bytes = Buffer.from("%PDF-1.7\nsource\n");
  const source = join(f.root, "source.pdf");
  await writeFile(source, bytes);
  const expected = await observed(source, bytes);
  await symlink(source, join(f.root, "link.pdf"));
  await assert.rejects(
    () =>
      capturePdfFile({
        root: f.safeRoot,
        relativePath: "link.pdf",
        captureDirectory: f.captures,
        captureId: randomUUID(),
        expected,
      }),
    (error) =>
      error instanceof CaptureStoreError && error.code === "unsafe_path",
  );
  const nested = join(f.root, "captures");
  await mkdir(nested, { mode: 0o700 });
  await chmod(nested, 0o700);
  await assert.rejects(
    () =>
      capturePdfFile({
        root: f.safeRoot,
        relativePath: "source.pdf",
        captureDirectory: nested,
        captureId: randomUUID(),
        expected,
      }),
    (error) =>
      error instanceof CaptureStoreError && error.code === "unsafe_path",
  );
});

test("no-clobber publication preserves an existing capture name", async () => {
  const f = await fixture();
  const bytes = Buffer.from("%PDF-1.7\nsource\n");
  const source = join(f.root, "source.pdf");
  await writeFile(source, bytes);
  const expected = await observed(source, bytes);
  const captureId = randomUUID();
  const finalPath = join(f.captures, `${captureId}.pdf`);
  const sentinel = Buffer.from("pre-existing sentinel");
  await writeFile(finalPath, sentinel, { mode: 0o600 });
  await assert.rejects(
    () =>
      capturePdfFile({
        root: f.safeRoot,
        relativePath: "source.pdf",
        captureDirectory: f.captures,
        captureId,
        expected,
      }),
    (error) =>
      error instanceof CaptureStoreError && error.code === "destination_exists",
  );
  assert.deepEqual(await readFile(finalPath), sentinel);
});

test("exact removal refuses a replacement and preserves it", async () => {
  const f = await fixture();
  const bytes = Buffer.from("%PDF-1.7\nsource\n");
  const source = join(f.root, "source.pdf");
  await writeFile(source, bytes);
  const expected = await observed(source, bytes);
  const captured = await capturePdfFile({
    root: f.safeRoot,
    relativePath: "source.pdf",
    captureDirectory: f.captures,
    captureId: randomUUID(),
    expected,
  });
  const old = join(f.captures, "old.pdf");
  await rename(captured.path, old);
  const replacement = Buffer.from("%PDF-1.7\nreplacement\n");
  await writeFile(captured.path, replacement, { mode: 0o600 });
  await assert.rejects(
    () => removeCapturedPdfExact(captured),
    (error) =>
      error instanceof CaptureStoreError &&
      ["source_changed", "digest_mismatch"].includes(error.code),
  );
  assert.deepEqual(await readFile(captured.path), replacement);
});

test("permission changes block inspection and deletion without removing content", async () => {
  const f = await fixture();
  const bytes = Buffer.from("%PDF-1.7\nsource\n");
  const source = join(f.root, "source.pdf");
  await writeFile(source, bytes);
  const expected = await observed(source, bytes);
  const captured = await capturePdfFile({
    root: f.safeRoot,
    relativePath: "source.pdf",
    captureDirectory: f.captures,
    captureId: randomUUID(),
    expected,
  });
  await chmod(f.captures, 0o750);
  await assert.rejects(
    () => removeCapturedPdfExact(captured),
    (error) =>
      error instanceof CaptureStoreError && error.code === "unsafe_path",
  );
  assert.deepEqual(await readFile(captured.path), bytes);
});

test("rejects a protected capture directory below a writable ancestor", async () => {
  const f = await fixture();
  const bytes = Buffer.from("%PDF-1.7\nsource\n");
  const source = join(f.root, "source.pdf");
  await writeFile(source, bytes);
  const expected = await observed(source, bytes);
  await chmod(f.base, 0o777);
  await assert.rejects(
    () =>
      capturePdfFile({
        root: f.safeRoot,
        relativePath: "source.pdf",
        captureDirectory: f.captures,
        captureId: randomUUID(),
        expected,
      }),
    (error) =>
      error instanceof CaptureStoreError && error.code === "unsafe_path",
  );
});

test("directory identity prevents deleting a hard-linked capture from a replacement directory", async () => {
  const f = await fixture();
  const bytes = Buffer.from("%PDF-1.7\nsource\n");
  const source = join(f.root, "source.pdf");
  await writeFile(source, bytes);
  const expected = await observed(source, bytes);
  const captured = await capturePdfFile({
    root: f.safeRoot,
    relativePath: "source.pdf",
    captureDirectory: f.captures,
    captureId: randomUUID(),
    expected,
  });
  const oldDirectory = join(f.base, "old-captures");
  await rename(f.captures, oldDirectory);
  await mkdir(f.captures, { mode: 0o700 });
  await chmod(f.captures, 0o700);
  const replacementPath = join(f.captures, `${captured.captureId}.pdf`);
  await link(join(oldDirectory, `${captured.captureId}.pdf`), replacementPath);
  await assert.rejects(
    () => removeCapturedPdfExact(captured),
    (error) =>
      error instanceof CaptureStoreError && error.code === "unsafe_path",
  );
  assert.deepEqual(await readFile(replacementPath), bytes);
});
