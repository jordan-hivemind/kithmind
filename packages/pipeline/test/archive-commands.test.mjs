import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import {
  ArchiveCommandError,
  assessLocalBackupBoundary,
  backupResticObject,
  encryptAgeObject,
  forgetResticBackupExact,
  probeArchiveTools,
  probeResticRepository,
  publishAgeObject,
  readbackResticObject,
  recoverPublishedAgeObject,
  recoverResticBackup,
  removePublishedAgeObjectExact,
} from "../dist/archiveCommands.js";

const RECIPIENT = `age1pq1${"q".repeat(60)}`;
const SNAPSHOT = "a".repeat(64);
const REPOSITORY = "b".repeat(64);
const SECRET_SENTINEL = "must-not-appear-in-arguments-or-errors";

function digest(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  };
}

const configIdentity = (path, remoteName) =>
  createHash("sha256")
    .update(`dropbox-config:v1\0${JSON.stringify([path, remoteName, "dropbox"])}`)
    .digest("hex");

function limits(overrides = {}) {
  return {
    deadlineMs: 2_000,
    maxOutputBytes: 16 * 1024,
    maxSourceBytes: 64 * 1024,
    maxCipherBytes: 66 * 1024,
    ...overrides,
  };
}

async function executable(path, source) {
  await writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function ageProgram(mode = "normal", marker = "") {
  return `
if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(mode === "wrong-version" ? "v1.3.1\n" : "v1.3.2\n")});
  process.exit(0);
}
if (${JSON.stringify(mode)} === "descendant") {
  const { spawn } = await import("node:child_process");
  spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 300); setTimeout(() => {}, 1000);`)}], {
    stdio: ["ignore", process.stdout, process.stderr]
  });
  process.exit(0);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
if (${JSON.stringify(mode)} === "flood") {
  process.stdout.write(Buffer.alloc(4096, 1));
} else {
  process.stdout.write(Buffer.concat([Buffer.from("AGE"), ...chunks]));
}
`;
}

function resticProgram(mode = "normal", remoteRepository = "") {
  return `
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv[2] === "version") {
  process.stdout.write(${JSON.stringify(mode === "wrong-version" ? "restic 0.18.0 compiled with go1.25.1 on darwin/arm64\n" : "restic 0.19.1 compiled with go1.25.1 on darwin/arm64\n")});
  process.exit(0);
}
const args = process.argv.slice(2);
const repoArg = args[args.indexOf("--repo") + 1];
const repo = repoArg.startsWith("rclone:") ? ${JSON.stringify(remoteRepository)} : repoArg;
const passwordCommand = args[args.indexOf("--password-command") + 1];
const command = args.find((value) => ["backup", "dump", "snapshots", "forget", "prune"].includes(value));
const statePath = join(repo, "snapshots.json");
const defaultRows = [{
  id: ${JSON.stringify(SNAPSHOT)},
  hostname: "kith-original-archive",
  tags: ["operation_1"],
  paths: [join(repo, "private-prefix", "opaque.age")]
}];
const loadRows = () => {
  if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, "utf8"));
  if (${JSON.stringify(mode)} === "missing-snapshot") return [];
  if (${JSON.stringify(mode)} === "duplicate-snapshot") {
    return [...defaultRows, { ...defaultRows[0], id: "c".repeat(64) }];
  }
  return defaultRows;
};
const saveRows = (rows) => writeFileSync(statePath, JSON.stringify(rows), { mode: 0o600 });
if (args.includes("cat") && args.includes("config")) {
  process.stdout.write(JSON.stringify({ version: 2, id: ${JSON.stringify(REPOSITORY)} }));
  process.exit(0);
}
if (command === "backup") {
  const objectName = args.at(-1);
  const source = join(process.cwd(), objectName);
  const bytes = readFileSync(source);
  copyFileSync(source, join(repo, "stored.age"));
  chmodSync(join(repo, "stored.age"), 0o600);
  saveRows([{
    id: ${JSON.stringify(SNAPSHOT)},
    hostname: args[args.indexOf("--host") + 1],
    tags: [args[args.indexOf("--tag") + 1]],
    paths: [join(repo, "private-prefix", objectName)]
  }]);
  writeFileSync(join(repo, "captured.json"), JSON.stringify({ args, passwordCommand }), { mode: 0o600 });
  if (${JSON.stringify(mode)} === "error-secret") {
    process.stderr.write(${JSON.stringify(SECRET_SENTINEL)});
    process.exit(3);
  }
  if (${JSON.stringify(mode)} === "flood") {
    process.stdout.write("x".repeat(65536));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ message_type: "status", percent_done: 1 }) + "\\n");
  process.stdout.write(JSON.stringify({
    message_type: "summary",
    total_files_processed: ${JSON.stringify(mode === "bad-summary" ? 2 : 1)},
    total_bytes_processed: bytes.length,
    snapshot_id: ${JSON.stringify(SNAPSHOT)}
  }) + "\\n");
  process.exit(0);
}
if (command === "dump") {
  const bytes = readFileSync(join(repo, "stored.age"));
  process.stdout.write(${JSON.stringify(mode)} === "bad-readback" ? Buffer.concat([bytes, Buffer.from("x")]) : bytes);
  process.exit(0);
}
if (command === "snapshots") {
  let rows = loadRows();
  const hostIndex = args.indexOf("--host");
  const tagIndex = args.indexOf("--tag");
  if (hostIndex >= 0) rows = rows.filter((row) => row.hostname === args[hostIndex + 1]);
  if (tagIndex >= 0) rows = rows.filter((row) => row.tags.includes(args[tagIndex + 1]));
  const selector = args.find((value) => /^[a-f0-9]{64}$/.test(value));
  if (selector) rows = rows.filter((row) => row.id === selector);
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (command === "forget") {
  const snapshot = args[args.indexOf("forget") + 1];
  saveRows(loadRows().filter((row) => row.id !== snapshot));
  writeFileSync(join(repo, "prune-ran"), "forget-prune", { mode: 0o600 });
  process.exit(0);
}
if (command === "prune") {
  writeFileSync(join(repo, "prune-ran"), "prune", { mode: 0o600 });
  process.exit(0);
}
process.exit(2);
`;
}

async function setup(options = {}) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "pipeline-archive-test-")),
  );
  await chmod(base, 0o700);
  const tools = join(base, "tools");
  const sourceRoot = join(base, "source");
  const archiveRoot = join(base, "archive");
  const repository = join(base, "repository");
  await Promise.all(
    [tools, sourceRoot, archiveRoot, repository].map(async (path) => {
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );
  const ageBinary = await executable(
    join(tools, "age"),
    ageProgram(options.ageMode, options.marker),
  );
  const resticBinary = await executable(
    join(tools, "restic"),
    resticProgram(options.resticMode, repository),
  );
  const directoryId = "id:dropbox-directory-id";
  const rcloneBinary = await executable(
    join(tools, "rclone"),
    `
if (process.argv[2] === "version") {
  process.stdout.write("rclone v1.74.4\\n");
  process.exit(0);
}
if (process.argv[2] === "config" && process.argv[3] === "redacted") {
  process.stdout.write("[kithmind_dropbox]\\ntype = dropbox\\ntoken = XXX\\n");
  process.exit(0);
}
if (process.argv[2] === "lsjson") {
  process.stdout.write(JSON.stringify([{Path:"Processing",Name:"Processing",Size:-1,ModTime:"",IsDir:true,ID:${JSON.stringify(directoryId)}}]));
  process.exit(0);
}
process.exit(2);
`,
  );
  const rcloneConfig = join(base, "rclone.conf");
  await writeFile(rcloneConfig, `[kithmind_dropbox]\ntype = dropbox\ntoken = ${JSON.stringify({ access_token: "synthetic-token", token_type: "bearer" })}\n`, { mode: 0o600 });
  const passwordExecutable = await executable(
    join(tools, "password-command"),
    `process.stdout.write("synthetic-password\\n");`,
  );
  return {
    base,
    tools,
    sourceRoot,
    archiveRoot,
    repository,
    ageBinary,
    resticBinary,
    rcloneBinary,
    rcloneConfig,
    directoryIdHash: createHash("sha256").update(directoryId).digest("hex"),
    passwordCommand: {
      executable: passwordExecutable,
      publicArgs: ["service with space", "owner's selector"],
    },
  };
}

async function preparedFixture(
  fixture,
  bytes = Buffer.from("synthetic bytes"),
) {
  const sourcePath = join(fixture.sourceRoot, "input.pdf");
  const tempOutputPath = join(fixture.archiveRoot, "archive.tmp");
  await writeFile(sourcePath, bytes, { mode: 0o600 });
  const prepared = await encryptAgeObject({
    ageBinary: fixture.ageBinary,
    sourcePath,
    tempOutputPath,
    recipient: RECIPIENT,
    expectedSource: digest(bytes),
    limits: limits(),
  });
  return { prepared, sourcePath, tempOutputPath, bytes };
}

test("probes only the pinned age and restic versions with total limits", async () => {
  const fixture = await setup();
  assert.deepEqual(
    await probeArchiveTools(
      { ageBinary: fixture.ageBinary, resticBinary: fixture.resticBinary },
      limits(),
    ),
    { age: "v1.3.2", restic: "0.19.1" },
  );
  await assert.rejects(
    () =>
      probeArchiveTools(
        { ageBinary: fixture.ageBinary, resticBinary: fixture.resticBinary },
        {},
      ),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "invalid_input",
  );
  const wrong = await setup({ ageMode: "wrong-version" });
  await assert.rejects(
    () =>
      probeArchiveTools(
        { ageBinary: wrong.ageBinary, resticBinary: wrong.resticBinary },
        limits(),
      ),
    (error) =>
      error instanceof ArchiveCommandError &&
      error.code === "tool_version_mismatch",
  );
});

test("encrypts one captured source to a prepared object and publishes no-clobber", async () => {
  const fixture = await setup();
  const { prepared, tempOutputPath, bytes } = await preparedFixture(fixture);
  const ciphertext = Buffer.concat([Buffer.from("AGE"), bytes]);
  assert.deepEqual(prepared.source, digest(bytes));
  assert.deepEqual(prepared.ciphertext, digest(ciphertext));
  assert.equal((await stat(tempOutputPath)).mode & 0o777, 0o600);

  const finalPath = join(fixture.archiveRoot, "opaque.age");
  const published = await publishAgeObject(prepared, finalPath, limits());
  assert.equal(published.state, "published");
  assert.deepEqual(await readFile(finalPath), ciphertext);
  await assert.rejects(() => stat(tempOutputPath), { code: "ENOENT" });

  const second = await preparedFixture(fixture, Buffer.from("second bytes"));
  const sentinel = Buffer.from("existing immutable object");
  const existing = join(fixture.archiveRoot, "existing.age");
  await writeFile(existing, sentinel, { mode: 0o600 });
  await assert.rejects(
    () => publishAgeObject(second.prepared, existing, limits()),
    (error) =>
      error instanceof ArchiveCommandError &&
      error.code === "destination_exists",
  );
  assert.deepEqual(await readFile(existing), sentinel);
  assert.equal((await stat(second.tempOutputPath)).isFile(), true);
});

test("recovers only the exact cataloged published age object after its temp hardlink is gone", async () => {
  const fixture = await setup();
  const { prepared, bytes } = await preparedFixture(fixture);
  const finalPath = join(fixture.archiveRoot, "recoverable.age");
  await publishAgeObject(prepared, finalPath, limits());
  await assert.rejects(() => stat(prepared.tempPath), { code: "ENOENT" });
  await recoverPublishedAgeObject(prepared, finalPath, limits());

  const unrelated = join(fixture.archiveRoot, "unrelated.age");
  await writeFile(unrelated, "unrelated immutable object", { mode: 0o600 });

  await rename(finalPath, join(fixture.archiveRoot, "retained-original.age"));
  await writeFile(finalPath, Buffer.concat([Buffer.from("AGE"), bytes]), {
    mode: 0o600,
  });
  await assert.rejects(
    () => recoverPublishedAgeObject(prepared, finalPath, limits()),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "digest_mismatch",
  );
  assert.equal((await stat(unrelated)).isFile(), true);

  await unlink(finalPath);
  await writeFile(finalPath, "wrong ciphertext", { mode: 0o600 });
  await assert.rejects(
    () => recoverPublishedAgeObject(prepared, finalPath, limits()),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "digest_mismatch",
  );
  assert.equal((await stat(unrelated)).isFile(), true);
});

test("published age recovery rejects missing, linked, and insecure paths without mutation", async () => {
  const fixture = await setup();
  const { prepared } = await preparedFixture(fixture);
  const finalPath = join(fixture.archiveRoot, "guarded.age");
  await publishAgeObject(prepared, finalPath, limits());
  const unrelated = join(fixture.archiveRoot, "unrelated.age");
  await writeFile(unrelated, "keep me", { mode: 0o600 });

  await chmod(fixture.archiveRoot, 0o777);
  await assert.rejects(
    () => recoverPublishedAgeObject(prepared, finalPath, limits()),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "unsafe_path",
  );
  await chmod(fixture.archiveRoot, 0o700);

  const displacedArchive = join(fixture.base, "displaced-archive");
  const ciphertext = await readFile(finalPath);
  await rename(fixture.archiveRoot, displacedArchive);
  await mkdir(fixture.archiveRoot, { mode: 0o700 });
  await chmod(fixture.archiveRoot, 0o700);
  await writeFile(finalPath, ciphertext, { mode: 0o600 });
  const replacementUnrelated = join(fixture.archiveRoot, "replacement.age");
  await writeFile(replacementUnrelated, "also keep me", { mode: 0o600 });
  await assert.rejects(
    () => recoverPublishedAgeObject(prepared, finalPath, limits()),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "unsafe_path",
  );
  assert.equal(
    await readFile(join(displacedArchive, "unrelated.age"), "utf8"),
    "keep me",
  );
  assert.equal(await readFile(replacementUnrelated, "utf8"), "also keep me");

  await rename(fixture.archiveRoot, join(fixture.base, "replacement-archive"));
  await rename(displacedArchive, fixture.archiveRoot);

  await unlink(finalPath);
  await symlink(unrelated, finalPath);
  await assert.rejects(
    () => recoverPublishedAgeObject(prepared, finalPath, limits()),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "unsafe_path",
  );
  await unlink(finalPath);
  await assert.rejects(
    () => recoverPublishedAgeObject(prepared, finalPath, limits()),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "unsafe_path",
  );
  assert.equal(await readFile(unrelated, "utf8"), "keep me");
});

test("publication never cleans up a replacement inserted immediately after its link", async () => {
  const fixture = await setup();
  const { prepared } = await preparedFixture(fixture);
  const finalPath = join(fixture.archiveRoot, "raced.age");
  const originalLink = fsPromises.link;
  fsPromises.link = async (from, to) => {
    await originalLink(from, to);
    if (to === finalPath) {
      await rename(to, join(fixture.archiveRoot, "retained-raced.age"));
      await writeFile(to, "unrelated replacement", { mode: 0o600 });
    }
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => publishAgeObject(prepared, finalPath, limits()),
      (error) =>
        error instanceof ArchiveCommandError && error.code === "unsafe_path",
    );
    assert.equal(await readFile(finalPath, "utf8"), "unrelated replacement");
    assert.equal((await stat(prepared.tempPath)).isFile(), true);
  } finally {
    fsPromises.link = originalLink;
    syncBuiltinESMExports();
  }
});

test("publication cleanup preserves a replacement at the temporary name", async () => {
  const fixture = await setup();
  const { prepared } = await preparedFixture(fixture);
  const finalPath = join(fixture.archiveRoot, "temp-race.age");
  const originalOpen = fsPromises.open;
  let replaced = false;
  fsPromises.open = async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (path === fixture.archiveRoot && !replaced) {
      replaced = true;
      await rename(
        prepared.tempPath,
        join(fixture.archiveRoot, "retained-temp.age"),
      );
      await writeFile(prepared.tempPath, "unrelated temporary replacement", {
        mode: 0o600,
      });
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await publishAgeObject(prepared, finalPath, limits());
    assert.equal(replaced, true);
    assert.equal(
      await readFile(prepared.tempPath, "utf8"),
      "unrelated temporary replacement",
    );
    await recoverPublishedAgeObject(prepared, finalPath, limits());
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("publication does not clean a replaced directory even with the prepared inode", async () => {
  for (const failRead of [false, true]) {
    const fixture = await setup();
    const { prepared } = await preparedFixture(fixture);
    const finalPath = join(fixture.archiveRoot, "directory-race.age");
    const retainedDirectory = join(fixture.base, "retained-archive");
    const originalOpen = fsPromises.open;
    let replaced = false;
    fsPromises.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (path === finalPath && !replaced) {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          await originalClose();
          await rename(fixture.archiveRoot, retainedDirectory);
          await mkdir(fixture.archiveRoot, { mode: 0o700 });
          await fsPromises.link(
            join(retainedDirectory, "directory-race.age"),
            finalPath,
          );
          replaced = true;
        };
        if (failRead) {
          handle.read = async () => {
            throw new Error("synthetic read failure");
          };
        }
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => publishAgeObject(prepared, finalPath, limits()),
        (error) => error instanceof ArchiveCommandError,
      );
      assert.equal(replaced, true);
      assert.equal((await stat(finalPath)).ino, prepared.ciphertextInode);
      assert.deepEqual(digest(await readFile(finalPath)), prepared.ciphertext);
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
    }
  }
});

test("an existing age temporary path is preserved on exclusive-create failure", async () => {
  const fixture = await setup();
  const source = Buffer.from("source");
  const sourcePath = join(fixture.sourceRoot, "source.pdf");
  const output = join(fixture.archiveRoot, "existing.tmp");
  const sentinel = Buffer.from("do not delete");
  await writeFile(sourcePath, source, { mode: 0o600 });
  await writeFile(output, sentinel, { mode: 0o600 });
  await assert.rejects(
    () =>
      encryptAgeObject({
        ageBinary: fixture.ageBinary,
        sourcePath,
        tempOutputPath: output,
        recipient: RECIPIENT,
        expectedSource: digest(source),
        limits: limits(),
      }),
    (error) =>
      error instanceof ArchiveCommandError &&
      error.code === "destination_exists",
  );
  assert.deepEqual(await readFile(output), sentinel);
});

test("rejects non-native recipients, digest mismatch, symlinks, and unsafe tool parents", async () => {
  const fixture = await setup();
  const source = Buffer.from("source");
  const sourcePath = join(fixture.sourceRoot, "source.pdf");
  await writeFile(sourcePath, source, { mode: 0o600 });
  for (const recipient of [
    "ssh-ed25519 AAAA",
    "AGE-PLUGIN-X-1ABC",
    "age1bad",
  ]) {
    await assert.rejects(
      () =>
        encryptAgeObject({
          ageBinary: fixture.ageBinary,
          sourcePath,
          tempOutputPath: join(fixture.archiveRoot, `${recipient.length}.tmp`),
          recipient,
          expectedSource: digest(source),
          limits: limits(),
        }),
      (error) =>
        error instanceof ArchiveCommandError && error.code === "invalid_input",
    );
  }
  await assert.rejects(
    () =>
      encryptAgeObject({
        ageBinary: fixture.ageBinary,
        sourcePath,
        tempOutputPath: join(fixture.archiveRoot, "mismatch.tmp"),
        recipient: RECIPIENT,
        expectedSource: digest(Buffer.from("different")),
        limits: limits(),
      }),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "digest_mismatch",
  );
  const sourceLink = join(fixture.sourceRoot, "source-link.pdf");
  await symlink(sourcePath, sourceLink);
  await assert.rejects(
    () =>
      encryptAgeObject({
        ageBinary: fixture.ageBinary,
        sourcePath: sourceLink,
        tempOutputPath: join(fixture.archiveRoot, "link.tmp"),
        recipient: RECIPIENT,
        expectedSource: digest(source),
        limits: limits(),
      }),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "unsafe_path",
  );

  const unsafeTools = join(fixture.base, "unsafe-tools");
  await mkdir(unsafeTools, { mode: 0o777 });
  await chmod(unsafeTools, 0o777);
  const unsafeAge = await executable(
    join(unsafeTools, "age"),
    ageProgram("normal"),
  );
  await assert.rejects(
    () =>
      probeArchiveTools(
        { ageBinary: unsafeAge, resticBinary: fixture.resticBinary },
        limits(),
      ),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "unsafe_path",
  );
});

test("a protected tool directory cannot sit inside a replaceable ancestor", async () => {
  const fixture = await setup();
  const ancestor = join(fixture.base, "replaceable");
  await mkdir(ancestor, { mode: 0o777 });
  await chmod(ancestor, 0o777);
  const protectedParent = join(ancestor, "protected-tools");
  await mkdir(protectedParent, { mode: 0o700 });
  const ageBinary = await executable(
    join(protectedParent, "age"),
    ageProgram("normal"),
  );
  await assert.rejects(
    () =>
      probeArchiveTools(
        { ageBinary, resticBinary: fixture.resticBinary },
        limits(),
      ),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "unsafe_path",
  );
});

test("deadline kills a descendant that retains the tool pipes after its leader exits", async () => {
  const markerBase = await realpath(
    await mkdtemp(join(tmpdir(), "pipeline-archive-marker-")),
  );
  await chmod(markerBase, 0o700);
  const marker = join(markerBase, "late-write");
  const fixture = await setup({ ageMode: "descendant", marker });
  const source = Buffer.from("source");
  const sourcePath = join(fixture.sourceRoot, "source.pdf");
  await writeFile(sourcePath, source, { mode: 0o600 });
  await assert.rejects(
    () =>
      encryptAgeObject({
        ageBinary: fixture.ageBinary,
        sourcePath,
        tempOutputPath: join(fixture.archiveRoot, "timeout.tmp"),
        recipient: RECIPIENT,
        expectedSource: digest(source),
        limits: limits({ deadlineMs: 75 }),
      }),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "process_timeout",
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(() => stat(marker), { code: "ENOENT" });
});

test("age ciphertext is capped while streaming and failed output is removed", async () => {
  const fixture = await setup({ ageMode: "flood" });
  const source = Buffer.from("small");
  const sourcePath = join(fixture.sourceRoot, "source.pdf");
  const output = join(fixture.archiveRoot, "too-large.tmp");
  await writeFile(sourcePath, source, { mode: 0o600 });
  await assert.rejects(
    () =>
      encryptAgeObject({
        ageBinary: fixture.ageBinary,
        sourcePath,
        tempOutputPath: output,
        recipient: RECIPIENT,
        expectedSource: digest(source),
        limits: limits({ maxSourceBytes: 16, maxCipherBytes: 32 }),
      }),
    (error) =>
      error instanceof ArchiveCommandError &&
      error.code === "output_limit_exceeded",
  );
  await assert.rejects(() => stat(output), { code: "ENOENT" });
});

test("restic backup requires a closed summary and verifies destination ciphertext by bounded dump", async () => {
  const fixture = await setup();
  const bytes = Buffer.from("AGE ciphertext");
  const ciphertextPath = join(fixture.archiveRoot, "opaque.age");
  await writeFile(ciphertextPath, bytes, { mode: 0o600 });
  assert.deepEqual(
    await probeResticRepository({
      resticBinary: fixture.resticBinary,
      repositoryPath: fixture.repository,
      passwordCommand: fixture.passwordCommand,
      limits: limits(),
    }),
    { repositoryId: REPOSITORY, repositoryVersion: 2 },
  );
  const result = await backupResticObject({
    resticBinary: fixture.resticBinary,
    repositoryPath: fixture.repository,
    expectedRepositoryId: REPOSITORY,
    passwordCommand: fixture.passwordCommand,
    operationId: "operation_1",
    host: "kith-original-archive",
    ciphertextPath,
    expectedCiphertext: digest(bytes),
    primaryArchiveRoot: fixture.archiveRoot,
    backupMode: "synthetic",
    limits: limits(),
  });
  assert.deepEqual(result, {
    operationId: "operation_1",
    snapshotId: SNAPSHOT,
    objectName: "opaque.age",
    ciphertext: digest(bytes),
    resticVersion: "0.19.1",
    repositoryId: REPOSITORY,
    verification: "destination_ciphertext_readback",
    boundary: {
      mode: "synthetic",
      readiness: "synthetic_only",
      primaryDevice: result.boundary.primaryDevice,
      backupDevice: result.boundary.backupDevice,
    },
  });
  const captured = JSON.parse(
    await readFile(join(fixture.repository, "captured.json"), "utf8"),
  );
  assert.equal(captured.args.includes(SECRET_SENTINEL), false);
  assert.equal(captured.passwordCommand.includes(SECRET_SENTINEL), false);
  assert.match(captured.passwordCommand, /service with space/);

  assert.deepEqual(
    await readbackResticObject({
      resticBinary: fixture.resticBinary,
      repositoryPath: fixture.repository,
      expectedRepositoryId: REPOSITORY,
      passwordCommand: fixture.passwordCommand,
      snapshotId: SNAPSHOT,
      objectName: "opaque.age",
      expectedCiphertext: digest(bytes),
      limits: limits(),
    }),
    {
      snapshotId: SNAPSHOT,
      objectName: "opaque.age",
      ciphertext: digest(bytes),
      resticVersion: "0.19.1",
      repositoryId: REPOSITORY,
      verification: "destination_ciphertext_readback",
    },
  );

  assert.deepEqual(
    await recoverResticBackup({
      resticBinary: fixture.resticBinary,
      repositoryPath: fixture.repository,
      expectedRepositoryId: REPOSITORY,
      passwordCommand: fixture.passwordCommand,
      operationId: "operation_1",
      host: "kith-original-archive",
      objectName: "opaque.age",
      expectedCiphertext: digest(bytes),
      limits: limits(),
    }),
    {
      operationId: "operation_1",
      snapshotId: SNAPSHOT,
      matchingSnapshotCount: 1,
      objectName: "opaque.age",
      ciphertext: digest(bytes),
      resticVersion: "0.19.1",
      repositoryId: REPOSITORY,
      verification: "destination_ciphertext_readback",
    },
  );
});

test("rclone Dropbox repository binds the real directory and performs a separate remote dump", async () => {
  const fixture = await setup();
  const bytes = Buffer.from("remote AGE ciphertext");
  const ciphertextPath = join(fixture.archiveRoot, "remote.age");
  await writeFile(ciphertextPath, bytes, { mode: 0o600 });
  const repository = {
    kind: "rclone_dropbox_v1",
    remoteName: "kithmind_dropbox",
    rootPath: "Kith Mind Backups/Processing",
    rcloneBinary: fixture.rcloneBinary,
    configPath: fixture.rcloneConfig,
    configIdentityFingerprint: configIdentity(fixture.rcloneConfig, "kithmind_dropbox"),
    expectedRootDirectoryIdHash: fixture.directoryIdHash,
  };
  const result = await backupResticObject({
    resticBinary: fixture.resticBinary,
    repository,
    expectedRepositoryId: REPOSITORY,
    passwordCommand: fixture.passwordCommand,
    operationId: "operation_1",
    host: "kith-original-archive",
    ciphertextPath,
    expectedCiphertext: digest(bytes),
    primaryArchiveRoot: fixture.archiveRoot,
    backupMode: "independent_backup",
    limits: limits(),
  });
  assert.equal(result.boundary.backend, "rclone_dropbox_v1");
  assert.equal(result.boundary.rootDirectoryIdHash, fixture.directoryIdHash);
  assert.equal(result.boundary.repositoryId, REPOSITORY);
  const recovered = await recoverResticBackup({
    resticBinary: fixture.resticBinary,
    repository,
    expectedRepositoryId: REPOSITORY,
    passwordCommand: fixture.passwordCommand,
    operationId: "operation_1",
    host: "kith-original-archive",
    objectName: "remote.age",
    expectedCiphertext: digest(bytes),
    limits: limits(),
  });
  assert.equal(recovered.snapshotId, SNAPSHOT);
  assert.deepEqual(recovered.boundary, result.boundary);
  assert.deepEqual(
    await readbackResticObject({
      resticBinary: fixture.resticBinary,
      repository,
      expectedRepositoryId: REPOSITORY,
      passwordCommand: fixture.passwordCommand,
      snapshotId: SNAPSHOT,
      objectName: "remote.age",
      expectedCiphertext: digest(bytes),
      limits: limits(),
    }),
    {
      snapshotId: SNAPSHOT,
      objectName: "remote.age",
      ciphertext: digest(bytes),
      resticVersion: "0.19.1",
      repositoryId: REPOSITORY,
      verification: "destination_ciphertext_readback",
    },
  );
  await assert.rejects(
    () => probeResticRepository({
      resticBinary: fixture.resticBinary,
      repository: { ...repository, expectedRootDirectoryIdHash: "f".repeat(64) },
      passwordCommand: fixture.passwordCommand,
      limits: limits(),
    }),
    (error) => error instanceof ArchiveCommandError && error.code === "digest_mismatch",
  );
  assert.equal(
    (await forgetResticBackupExact({
      resticBinary: fixture.resticBinary,
      repository,
      expectedRepositoryId: REPOSITORY,
      passwordCommand: fixture.passwordCommand,
      operationId: "operation_1",
      host: "kith-original-archive",
      snapshotId: SNAPSHOT,
      objectName: "remote.age",
      expectedCiphertext: digest(bytes),
      limits: limits(),
    })).outcome,
    "deleted",
  );
});

test("same-device development is synthetic and cannot claim independent backup", async () => {
  const fixture = await setup();
  const synthetic = await assessLocalBackupBoundary(
    fixture.archiveRoot,
    fixture.repository,
    "synthetic",
  );
  assert.equal(synthetic.readiness, "synthetic_only");
  await assert.rejects(
    () =>
      assessLocalBackupBoundary(
        fixture.archiveRoot,
        fixture.repository,
        "independent_backup",
      ),
    (error) =>
      error instanceof ArchiveCommandError &&
      error.code === "backup_not_independent",
  );
});

test("lost-summary recovery rejects zero and ambiguous operation matches", async () => {
  for (const [mode, code] of [
    ["missing-snapshot", "not_found"],
    ["duplicate-snapshot", "invalid_tool_result"],
  ]) {
    const fixture = await setup({ resticMode: mode });
    const bytes = Buffer.from("AGE ciphertext");
    await writeFile(join(fixture.repository, "stored.age"), bytes, {
      mode: 0o600,
    });
    await assert.rejects(
      () =>
        recoverResticBackup({
          resticBinary: fixture.resticBinary,
          repositoryPath: fixture.repository,
          expectedRepositoryId: REPOSITORY,
          passwordCommand: fixture.passwordCommand,
          operationId: "operation_1",
          host: "kith-original-archive",
          objectName: "opaque.age",
          expectedCiphertext: digest(bytes),
          limits: limits(),
        }),
      (error) => error instanceof ArchiveCommandError && error.code === code,
    );
  }
});

test("restic malformed summaries, readback mismatch, output flood, and stderr secrets fail safely", async () => {
  for (const mode of ["bad-summary", "bad-readback", "flood", "error-secret"]) {
    const fixture = await setup({ resticMode: mode });
    const bytes = Buffer.from("AGE ciphertext");
    const ciphertextPath = join(fixture.archiveRoot, "opaque.age");
    await writeFile(ciphertextPath, bytes, { mode: 0o600 });
    let caught;
    try {
      await backupResticObject({
        resticBinary: fixture.resticBinary,
        repositoryPath: fixture.repository,
        expectedRepositoryId: REPOSITORY,
        passwordCommand: fixture.passwordCommand,
        operationId: "operation_1",
        host: "kith-original-archive",
        ciphertextPath,
        expectedCiphertext: digest(bytes),
        primaryArchiveRoot: fixture.archiveRoot,
        backupMode: "synthetic",
        limits: limits(),
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ArchiveCommandError, mode);
    assert.equal(caught.message.includes(SECRET_SENTINEL), false, mode);
  }
});

test("removes one exact age object idempotently and preserves replacements", async () => {
  const fixture = await setup();
  const { prepared } = await preparedFixture(fixture);
  const objectPath = join(fixture.archiveRoot, "opaque.age");
  await publishAgeObject(prepared, objectPath, limits());
  const input = {
    objectPath,
    expectedDirectory: {
      device: prepared.archiveDirectoryDevice,
      inode: prepared.archiveDirectoryInode,
    },
    expectedFile: {
      device: prepared.ciphertextDevice,
      inode: prepared.ciphertextInode,
      ...prepared.ciphertext,
    },
    limits: limits(),
  };
  assert.deepEqual(await removePublishedAgeObjectExact(input), {
    outcome: "deleted",
    verification: "exact_path_absence",
  });
  assert.deepEqual(await removePublishedAgeObjectExact(input), {
    outcome: "already_missing",
    verification: "exact_path_absence",
  });

  await writeFile(objectPath, "replacement", { mode: 0o600 });
  await assert.rejects(
    () => removePublishedAgeObjectExact(input),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "digest_mismatch",
  );
  assert.equal(await readFile(objectPath, "utf8"), "replacement");
});

test("age removal rejects a replaced directory even when it contains the original inode", async () => {
  const fixture = await setup();
  const { prepared } = await preparedFixture(fixture);
  const objectPath = join(fixture.archiveRoot, "opaque.age");
  await publishAgeObject(prepared, objectPath, limits());
  const displaced = `${fixture.archiveRoot}-displaced`;
  await rename(fixture.archiveRoot, displaced);
  await mkdir(fixture.archiveRoot, { mode: 0o700 });
  await chmod(fixture.archiveRoot, 0o700);
  await link(join(displaced, "opaque.age"), objectPath);
  await assert.rejects(
    () =>
      removePublishedAgeObjectExact({
        objectPath,
        expectedDirectory: {
          device: prepared.archiveDirectoryDevice,
          inode: prepared.archiveDirectoryInode,
        },
        expectedFile: {
          device: prepared.ciphertextDevice,
          inode: prepared.ciphertextInode,
          ...prepared.ciphertext,
        },
        limits: limits(),
      }),
    (error) =>
      error instanceof ArchiveCommandError && error.code === "unsafe_path",
  );
  assert.equal((await stat(objectPath)).ino, prepared.ciphertextInode);
  assert.equal(
    (await stat(join(displaced, "opaque.age"))).ino,
    prepared.ciphertextInode,
  );
});

test("forgets one exact restic snapshot, prunes, and preserves other snapshots", async () => {
  const fixture = await setup();
  const bytes = Buffer.from("AGE ciphertext");
  await writeFile(join(fixture.repository, "stored.age"), bytes, {
    mode: 0o600,
  });
  const otherSnapshot = "d".repeat(64);
  await writeFile(
    join(fixture.repository, "snapshots.json"),
    JSON.stringify([
      {
        id: SNAPSHOT,
        hostname: "kith-original-archive",
        tags: ["operation_1"],
        paths: [join(fixture.repository, "private-prefix", "opaque.age")],
      },
      {
        id: otherSnapshot,
        hostname: "kith-original-archive",
        tags: ["operation_2"],
        paths: [join(fixture.repository, "private-prefix", "other.age")],
      },
    ]),
    { mode: 0o600 },
  );
  const input = {
    resticBinary: fixture.resticBinary,
    repositoryPath: fixture.repository,
    expectedRepositoryId: REPOSITORY,
    passwordCommand: fixture.passwordCommand,
    operationId: "operation_1",
    host: "kith-original-archive",
    snapshotId: SNAPSHOT,
    objectName: "opaque.age",
    expectedCiphertext: digest(bytes),
    limits: limits(),
  };
  assert.deepEqual(await forgetResticBackupExact(input), {
    outcome: "deleted",
    snapshotId: SNAPSHOT,
    repositoryId: REPOSITORY,
    verification: "snapshot_absence_after_forget_prune",
  });
  assert.deepEqual(
    JSON.parse(
      await readFile(join(fixture.repository, "snapshots.json"), "utf8"),
    ).map((row) => row.id),
    [otherSnapshot],
  );
  assert.equal(
    await readFile(join(fixture.repository, "prune-ran"), "utf8"),
    "forget-prune",
  );
  assert.deepEqual(await forgetResticBackupExact(input), {
    outcome: "already_missing",
    snapshotId: SNAPSHOT,
    repositoryId: REPOSITORY,
    verification: "snapshot_absence_after_forget_prune",
  });
  assert.deepEqual(
    JSON.parse(
      await readFile(join(fixture.repository, "snapshots.json"), "utf8"),
    ).map((row) => row.id),
    [otherSnapshot],
  );
});

test("restic deletion checks the full snapshot ID when operation metadata changed", async () => {
  const fixture = await setup();
  const bytes = Buffer.from("AGE ciphertext");
  await writeFile(join(fixture.repository, "stored.age"), bytes, {
    mode: 0o600,
  });
  const statePath = join(fixture.repository, "snapshots.json");
  const row = {
    id: SNAPSHOT,
    hostname: "kith-original-archive",
    tags: ["changed_operation"],
    paths: [join(fixture.repository, "private-prefix", "opaque.age")],
  };
  await writeFile(statePath, JSON.stringify([row]), { mode: 0o600 });
  await assert.rejects(
    () =>
      forgetResticBackupExact({
        resticBinary: fixture.resticBinary,
        repositoryPath: fixture.repository,
        expectedRepositoryId: REPOSITORY,
        passwordCommand: fixture.passwordCommand,
        operationId: "operation_1",
        host: "kith-original-archive",
        snapshotId: SNAPSHOT,
        objectName: "opaque.age",
        expectedCiphertext: digest(bytes),
        limits: limits(),
      }),
    (error) =>
      error instanceof ArchiveCommandError &&
      error.code === "invalid_tool_result",
  );
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), [row]);
});

test("restic deletion preserves snapshots on readback mismatch or ambiguous operation", async () => {
  for (const mode of ["readback", "ambiguous"]) {
    const fixture = await setup();
    const bytes = Buffer.from("AGE ciphertext");
    await writeFile(join(fixture.repository, "stored.age"), bytes, {
      mode: 0o600,
    });
    const statePath = join(fixture.repository, "snapshots.json");
    const rows = [
      {
        id: SNAPSHOT,
        hostname: "kith-original-archive",
        tags: ["operation_1"],
        paths: [join(fixture.repository, "private-prefix", "opaque.age")],
      },
      ...(mode === "ambiguous"
        ? [
            {
              id: "d".repeat(64),
              hostname: "kith-original-archive",
              tags: ["operation_1"],
              paths: [join(fixture.repository, "private-prefix", "opaque.age")],
            },
          ]
        : []),
    ];
    await writeFile(statePath, JSON.stringify(rows), { mode: 0o600 });
    await assert.rejects(
      () =>
        forgetResticBackupExact({
          resticBinary: fixture.resticBinary,
          repositoryPath: fixture.repository,
          expectedRepositoryId: REPOSITORY,
          passwordCommand: fixture.passwordCommand,
          operationId: "operation_1",
          host: "kith-original-archive",
          snapshotId: SNAPSHOT,
          objectName: "opaque.age",
          expectedCiphertext:
            mode === "readback"
              ? digest(Buffer.from("different bytes"))
              : digest(bytes),
          limits: limits(),
        }),
      (error) =>
        error instanceof ArchiveCommandError &&
        (error.code === "readback_failed" ||
          error.code === "invalid_tool_result"),
    );
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), rows);
  }
});
