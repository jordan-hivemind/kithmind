import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArchiveCommandError,
  assessLocalBackupBoundary,
  backupResticObject,
  encryptAgeObject,
  probeArchiveTools,
  probeResticRepository,
  publishAgeObject,
  readbackResticObject,
  recoverResticBackup,
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

function resticProgram(mode = "normal") {
  return `
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv[2] === "version") {
  process.stdout.write(${JSON.stringify(mode === "wrong-version" ? "restic 0.18.0 compiled with go1.25.1 on darwin/arm64\n" : "restic 0.19.1 compiled with go1.25.1 on darwin/arm64\n")});
  process.exit(0);
}
const args = process.argv.slice(2);
const repo = args[args.indexOf("--repo") + 1];
const passwordCommand = args[args.indexOf("--password-command") + 1];
const command = args.find((value) => value === "backup" || value === "dump" || value === "snapshots");
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
  const rows = [{
    id: ${JSON.stringify(SNAPSHOT)},
    hostname: "kith-original-archive",
    tags: ["operation_1"],
    paths: [join(repo, "private-prefix", "opaque.age")]
  }];
  if (${JSON.stringify(mode)} === "missing-snapshot") rows.length = 0;
  if (${JSON.stringify(mode)} === "duplicate-snapshot") rows.push({ ...rows[0], id: "c".repeat(64) });
  process.stdout.write(JSON.stringify(rows));
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
    resticProgram(options.resticMode),
  );
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
