import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  canonicalRoots,
  discoverFiles,
  discoverSourceObservations,
  FilesystemFailure,
  MAX_DISCOVERED_PDF_BYTES,
  readPdfFile,
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

test("exact-file roots traverse selected ancestors and observe only exact leaves", async () => {
  const { root, journal } = await setup();
  await mkdir(join(root, "reports"));
  await mkdir(join(root, "excluded"));
  await writeFile(join(root, "reports", "first.txt"), "first synthetic");
  await writeFile(join(root, "reports", "second.txt"), "second synthetic");
  await writeFile(join(root, "reports", "excluded.txt"), "excluded");
  await writeFile(join(root, "excluded", "ignored.txt"), "ignored");
  await symlink(
    join(root, "reports", "first.txt"),
    join(root, "excluded-link"),
  );
  const localConfig = config(root, journal, {
    roots: [
      {
        alias: "test",
        path: root,
        includeFiles: ["reports/second.txt", "reports/first.txt"],
      },
    ],
  });
  const roots = await canonicalRoots(localConfig);
  const files = await discoverFiles(localConfig, roots);
  assert.deepEqual(
    files.map((file) => [file.relativePath, file.text]),
    [
      ["reports/first.txt", "first synthetic"],
      ["reports/second.txt", "second synthetic"],
    ],
  );
});

test("exact-file roots fail closed for missing or unsafe selected paths", async () => {
  for (const kind of [
    "missing",
    "symlink",
    "directory",
    "fifo",
    "ancestor-file",
    "ancestor-symlink",
    "unsafe-ancestor",
  ]) {
    const { root, journal } = await setup();
    await mkdir(join(root, "reports"));
    await writeFile(join(root, "safe.txt"), "synthetic");
    let includeFiles;
    if (kind === "missing") {
      includeFiles = ["reports/missing.txt"];
    } else if (kind === "symlink") {
      await symlink(join(root, "safe.txt"), join(root, "reports", "item.txt"));
      includeFiles = ["reports/item.txt"];
    } else if (kind === "directory") {
      await mkdir(join(root, "reports", "item.txt"));
      includeFiles = ["reports/item.txt"];
    } else if (kind === "fifo") {
      await execFileAsync("mkfifo", [join(root, "reports", "item.txt")]);
      includeFiles = ["reports/item.txt"];
    } else if (kind === "ancestor-file") {
      await writeFile(join(root, "ancestor"), "synthetic");
      includeFiles = ["ancestor/item.txt"];
    } else if (kind === "ancestor-symlink") {
      await symlink(join(root, "reports"), join(root, "ancestor"));
      includeFiles = ["ancestor/item.txt"];
    } else {
      await mkdir(join(root, "unsafe"), { mode: 0o770 });
      await chmod(join(root, "unsafe"), 0o770);
      await writeFile(join(root, "unsafe", "item.txt"), "synthetic");
      includeFiles = ["unsafe/item.txt"];
    }
    const localConfig = config(root, journal, {
      roots: [{ alias: "test", path: root, includeFiles }],
    });
    const roots = await canonicalRoots(localConfig);
    await assert.rejects(
      () => discoverFiles(localConfig, roots),
      (error) =>
        error instanceof FilesystemFailure &&
        (kind === "missing" || kind === "symlink" || kind === "ancestor-symlink"
          ? error.code === "unstable"
          : kind === "unsafe-ancestor"
            ? error.code === "permission_denied"
            : error.code === "unsupported"),
      kind,
    );
  }
});

test("exact-file roots retain independent depth and file-count bounds", async () => {
  const { root, journal } = await setup();
  await mkdir(join(root, "nested"));
  await mkdir(join(root, "nested", "deeper"));
  await writeFile(join(root, "nested", "first.txt"), "first");
  await writeFile(join(root, "nested", "second.txt"), "second");
  await writeFile(join(root, "nested", "deeper", "third.txt"), "third");
  const selectedRoots = [
    {
      alias: "test",
      path: root,
      includeFiles: ["nested/first.txt", "nested/second.txt"],
    },
  ];
  const fileLimited = config(root, journal, {
    roots: selectedRoots,
    maxFiles: 1,
  });
  const fileLimitedRoots = await canonicalRoots(fileLimited);
  await assert.rejects(
    () => discoverFiles(fileLimited, fileLimitedRoots),
    (error) => error instanceof FilesystemFailure && error.code === "oversized",
  );
  const depthLimited = config(root, journal, {
    roots: [
      {
        alias: "test",
        path: root,
        includeFiles: ["nested/deeper/third.txt"],
      },
    ],
    maxDepth: 1,
  });
  const depthLimitedRoots = await canonicalRoots(depthLimited);
  await assert.rejects(
    () => discoverFiles(depthLimited, depthLimitedRoots),
    (error) => error instanceof FilesystemFailure && error.code === "oversized",
  );
});

test("exact-file source observations retain selected PDF provenance", async () => {
  const { root, journal } = await setup();
  await mkdir(join(root, "reports"));
  await writeFile(join(root, "reports", "selected.pdf"), "%PDF-1.7\nselected");
  await writeFile(join(root, "reports", "excluded.pdf"), "%PDF-1.7\nexcluded");
  const localConfig = config(root, journal, {
    roots: [
      {
        alias: "test",
        path: root,
        includeFiles: ["reports/selected.pdf"],
      },
    ],
  });
  const observations = await discoverSourceObservations(
    localConfig,
    await canonicalRoots(localConfig),
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].kind, "pdf");
  assert.equal(observations[0].file.relativePath, "reports/selected.pdf");
  assert.equal(observations[0].file.uri, "fs://test/reports/selected.pdf");
});

test("ignores Finder metadata after regular-file safety checks", async () => {
  const { root, journal } = await setup();
  for (let i = 0; i < 9; i += 1) await writeFile(join(root, `file-${i}.txt`), "synthetic");
  await writeFile(join(root, ".DS_Store"), "synthetic Finder metadata");
  const localConfig = config(root, journal, { maxFiles: 9 });
  const roots = await canonicalRoots(localConfig);
  const observations = await discoverSourceObservations(localConfig, roots);
  assert.equal(observations.length, 9);
  assert.ok(observations.every((observation) => observation.kind === "utf8"));
  await writeFile(join(root, ".hidden.txt"), "ordinary hidden file");
  assert.equal((await discoverSourceObservations(config(root, journal, { maxFiles: 10 }), roots)).length, 10);
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

test("PDF observations use a bounded binary descriptor without text admission", async () => {
  const { root, journal } = await setup();
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.alloc(70 * 1024, 0),
  ]);
  await writeFile(join(root, "document.pdf"), bytes);
  await writeFile(join(root, "large-not-pdf.bin"), Buffer.alloc(70 * 1024));
  await writeFile(join(root, "note.txt"), "synthetic text");
  const localConfig = config(root, journal);
  const [safeRoot] = await canonicalRoots(localConfig);
  const pdf = await readPdfFile(safeRoot, "document.pdf");
  assert.equal(pdf.mediaType, "application/pdf");
  assert.equal(pdf.byteLength, bytes.byteLength);
  assert.equal(pdf.sha256, createHash("sha256").update(bytes).digest("hex"));
  await assert.rejects(
    () => readUtf8File(safeRoot, "document.pdf", 65_536),
    (error) => error instanceof FilesystemFailure && error.code === "oversized",
  );
  const observations = await discoverSourceObservations(localConfig, [
    safeRoot,
  ]);
  assert.deepEqual(
    observations.map((observation) => observation.kind),
    ["pdf", "gap", "utf8"],
  );
  const binary = observations.find((observation) => observation.kind === "pdf");
  assert.ok(binary && binary.kind === "pdf");
  assert.equal(binary.file.uri, "fs://test/document.pdf");
  assert.equal("text" in binary.file, false);
  const oversized = observations.find(
    (observation) => observation.kind === "gap",
  );
  assert.ok(oversized && oversized.kind === "gap");
  assert.deepEqual(oversized.gap.code, "oversized");
  assert.equal(oversized.gap.uri, "fs://test/large-not-pdf.bin");
});

test("PDF descriptor scan rejects non-PDF, hard-linked, and oversized files", async () => {
  const { root, journal } = await setup();
  const [safeRoot] = await canonicalRoots(config(root, journal));
  await writeFile(join(root, "not-a-pdf"), "synthetic text");
  await assert.rejects(
    () => readPdfFile(safeRoot, "not-a-pdf"),
    (error) =>
      error instanceof FilesystemFailure && error.code === "unsupported",
  );
  await writeFile(join(root, "original.pdf"), "%PDF-1.7\nsynthetic");
  await link(join(root, "original.pdf"), join(root, "linked.pdf"));
  await assert.rejects(
    () => readPdfFile(safeRoot, "original.pdf"),
    (error) => error instanceof FilesystemFailure && error.code === "unstable",
  );
  await writeFile(
    join(root, "oversized.pdf"),
    Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(MAX_DISCOVERED_PDF_BYTES),
    ]),
  );
  await assert.rejects(
    () => readPdfFile(safeRoot, "oversized.pdf"),
    (error) => error instanceof FilesystemFailure && error.code === "oversized",
  );
});

test("source observation gaps are leaf-only and do not hide unsafe entries", async () => {
  const { root, journal } = await setup();
  await writeFile(join(root, "invalid.bin"), Buffer.from([0xc3, 0x28]));
  await writeFile(
    join(root, "too-large.pdf"),
    Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(MAX_DISCOVERED_PDF_BYTES),
    ]),
  );
  const localConfig = config(root, journal);
  const [safeRoot] = await canonicalRoots(localConfig);
  const observations = await discoverSourceObservations(localConfig, [
    safeRoot,
  ]);
  assert.deepEqual(
    observations.map((observation) =>
      observation.kind === "gap" ? observation.gap.code : observation.kind,
    ),
    ["unsupported", "oversized"],
  );
  await symlink(join(root, "invalid.bin"), join(root, "unsafe-link"));
  await assert.rejects(
    () => discoverSourceObservations(localConfig, [safeRoot]),
    (error) => error instanceof FilesystemFailure && error.code === "unstable",
  );
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
