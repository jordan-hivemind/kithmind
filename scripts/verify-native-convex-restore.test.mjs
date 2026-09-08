import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import {
  LIMITS,
  SANDBOX_PROFILE,
  assertNoAmbientConvex,
  captureChildSpawnError,
  compareSnapshotArchives,
  parseArguments,
  prepareOutputDirectory,
  readBoundedZip,
  validateAndStageBackend,
  waitForBackend,
} from "./verify-native-convex-restore.mjs";

const script = fileURLToPath(
  new URL("./verify-native-convex-restore.mjs", import.meta.url),
);
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  }
  return (value ^ 0xffffffff) >>> 0;
}

function privateTemporaryDirectory(prefix) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  chmodSync(directory, 0o700);
  return directory;
}

function syntheticZip(path, values) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, rawValue, compression] of values) {
    const nameBytes = Buffer.from(name);
    const value = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue);
    const method = compression === "deflate" ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(value) : value;
    const checksum = crc32(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(values.length, 8);
  end.writeUInt16LE(values.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  writeFileSync(path, Buffer.concat([...localParts, centralBytes, end]), {
    mode: 0o600,
  });
}

function validArguments() {
  return [
    "--repo",
    "/private/repository",
    "--snapshot",
    "/private/source.zip",
    "--backend",
    "/private/backend",
    "--backend-sha256",
    "a".repeat(64),
    "--backend-version",
    "local_backend unknown",
    "--output-dir",
    "/private/output",
    "--backend-port",
    "33232",
    "--site-port",
    "33233",
  ];
}

test("argument parser requires an explicit pinned backend and distinct loopback ports", () => {
  assert.deepEqual(parseArguments(validArguments()), {
    repo: "/private/repository",
    snapshot: "/private/source.zip",
    backend: "/private/backend",
    backendSha256: "a".repeat(64),
    backendVersion: "local_backend unknown",
    outputDir: "/private/output",
    backendPort: 33232,
    sitePort: 33233,
  });
  assert.throws(() => parseArguments(validArguments().slice(0, -2)), {
    message: "missing_option",
  });
  assert.throws(
    () =>
      parseArguments([...validArguments(), "--snapshot", "/private/other.zip"]),
    { message: "duplicate_option" },
  );
  const samePorts = validArguments();
  samePorts[samePorts.indexOf("33233")] = "33232";
  assert.throws(() => parseArguments(samePorts), {
    message: "ports_not_distinct",
  });
});

test("argument parser rejects unknown options, malformed hashes, and control characters", () => {
  assert.throws(() => parseArguments(["--private-owner-value", "secret"]), {
    message: "invalid_arguments",
  });
  const invalidHash = validArguments();
  invalidHash[invalidHash.indexOf("a".repeat(64))] = "A".repeat(64);
  assert.throws(() => parseArguments(invalidHash), {
    message: "invalid_backend_hash",
  });
  const invalidVersion = validArguments();
  invalidVersion[invalidVersion.indexOf("local_backend unknown")] =
    "local_backend unknown\nsecret";
  assert.throws(() => parseArguments(invalidVersion), {
    message: "invalid_backend_version",
  });
});

test("ambient Convex configuration is rejected even when its value is empty", () => {
  assert.doesNotThrow(() => assertNoAmbientConvex({ PATH: "/usr/bin" }));
  assert.throws(() => assertNoAmbientConvex({ CONVEX_DEPLOYMENT: "" }), {
    message: "ambient_convex_environment",
  });
  assert.throws(
    () => assertNoAmbientConvex({ CONVEX_SELF_HOSTED_ADMIN_KEY: "secret" }),
    { message: "ambient_convex_environment" },
  );
});

test("the generated sandbox profile is the fixed previously proven outbound deny", () => {
  assert.equal(
    SANDBOX_PROFILE,
    "(version 1)\n(allow default)\n(deny network-outbound)\n",
  );
  assert.doesNotMatch(SANDBOX_PROFILE, /subpath|literal|regex/u);
});

test("output directory must be new, canonical, owner-only, and under a protected parent", () => {
  const root = privateTemporaryDirectory("kithmind-restore-output-");
  try {
    const output = join(root, "evidence");
    assert.equal(prepareOutputDirectory(output), output);
    assert.equal(statSync(output).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output directory rejects existing targets, symlink parents, and writable parents", () => {
  const root = privateTemporaryDirectory("kithmind-restore-output-guards-");
  try {
    const existing = join(root, "existing");
    mkdirSync(existing, { mode: 0o700 });
    assert.throws(() => prepareOutputDirectory(existing), {
      message: "output_exists",
    });

    const actual = join(root, "actual");
    mkdirSync(actual, { mode: 0o700 });
    const link = join(root, "linked");
    symlinkSync(actual, link, "dir");
    assert.throws(() => prepareOutputDirectory(join(link, "output")), {
      message: "output_parent_symlink",
    });

    const writable = join(root, "writable");
    mkdirSync(writable, { mode: 0o700 });
    chmodSync(writable, 0o770);
    assert.throws(() => prepareOutputDirectory(join(writable, "output")), {
      message: "output_parent_not_protected",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backend staging requires both the exact executable hash and version output", () => {
  const root = privateTemporaryDirectory("kithmind-backend-pin-");
  try {
    const backend = join(root, "synthetic-backend");
    writeFileSync(backend, "#!/bin/sh\nprintf 'synthetic-backend 1.0\\n'\n", {
      mode: 0o700,
    });
    chmodSync(backend, 0o700);
    const expectedSha256 = createHash("sha256")
      .update(readFileSync(backend))
      .digest("hex");
    const output = join(root, "output");
    mkdirSync(output, { mode: 0o700 });
    assert.deepEqual(
      validateAndStageBackend({
        backend,
        expectedSha256,
        expectedVersion: "synthetic-backend 1.0",
        outputDirectory: output,
        environment: { PATH: "/usr/bin:/bin" },
      }),
      {
        path: join(output, "convex-local-backend"),
        sha256: expectedSha256,
        version: "synthetic-backend 1.0",
      },
    );

    const otherOutput = join(root, "other-output");
    mkdirSync(otherOutput, { mode: 0o700 });
    assert.throws(
      () =>
        validateAndStageBackend({
          backend,
          expectedSha256: "0".repeat(64),
          expectedVersion: "synthetic-backend 1.0",
          outputDirectory: otherOutput,
          environment: { PATH: "/usr/bin:/bin" },
        }),
      { message: "backend_hash_mismatch" },
    );

    const versionOutput = join(root, "version-output");
    mkdirSync(versionOutput, { mode: 0o700 });
    assert.throws(
      () =>
        validateAndStageBackend({
          backend,
          expectedSha256,
          expectedVersion: "synthetic-backend 2.0",
          outputDirectory: versionOutput,
          environment: { PATH: "/usr/bin:/bin" },
        }),
      { message: "backend_version_mismatch" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backend spawn errors become a bounded startup failure", async () => {
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  const getSpawnError = captureChildSpawnError(child);
  child.emit("error", new Error("private executable path"));
  assert.ok(getSpawnError() instanceof Error);
  await assert.rejects(waitForBackend(child, 33232, getSpawnError), {
    message: "backend_start_failed",
  });
});

test("snapshot comparison preserves application rows by ID, storage metadata, and file bytes", () => {
  const root = privateTemporaryDirectory("kithmind-roundtrip-");
  const source = join(root, "source.zip");
  const restored = join(root, "restored.zip");
  const sourceEntries = [
    [
      "users/documents.jsonl",
      '{"_id":"user-a","name":"alpha"}\n{"_id":"user-b","name":"βeta"}\n',
    ],
    ["_storage/documents.jsonl", '{"_id":"storage-a","size":4}\n'],
    ["_storage/storage-a", Buffer.from([0, 1, 2, 255])],
    ["generated_schema.jsonl", '{"schema":"synthetic"}\n'],
    ["_tables/documents.jsonl", '{"_id":"system-a","name":"before"}\n'],
  ];
  try {
    sourceEntries[0].push("deflate");
    syntheticZip(source, sourceEntries);
    syntheticZip(restored, [
      [
        "users/documents.jsonl",
        '{"_id":"user-b","name":"βeta"}\n{"_id":"user-a","name":"alpha"}\n',
        "deflate",
      ],
      ["_storage/documents.jsonl", '{"_id":"storage-a","size":4}\n'],
      ["_storage/storage-a", Buffer.from([0, 1, 2, 255])],
      ["generated_schema.jsonl", '{"schema":"synthetic"}\n'],
      ["_tables/documents.jsonl", '{"_id":"system-b","name":"after"}\n'],
    ]);
    assert.deepEqual(compareSnapshotArchives(source, restored), {
      entriesInInventory: 5,
      tablesCompared: 2,
      rowsCompared: 3,
      fileEntriesCompared: 2,
      storageMetadataRows: 1,
      storageObjectsCompared: 1,
      excludedSystemTables: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot comparison rejects row, file, inventory, and duplicate-entry changes", () => {
  const root = privateTemporaryDirectory("kithmind-roundtrip-guards-");
  const source = join(root, "source.zip");
  try {
    syntheticZip(source, [
      ["users/documents.jsonl", '{"_id":"user-a","value":1}\n'],
      ["_storage/file", "bytes"],
    ]);
    const rowMismatch = join(root, "row-mismatch.zip");
    syntheticZip(rowMismatch, [
      ["users/documents.jsonl", '{"_id":"user-a","value":2}\n'],
      ["_storage/file", "bytes"],
    ]);
    assert.throws(() => compareSnapshotArchives(source, rowMismatch), {
      message: "table_rows_mismatch",
    });

    const fileMismatch = join(root, "file-mismatch.zip");
    syntheticZip(fileMismatch, [
      ["users/documents.jsonl", '{"_id":"user-a","value":1}\n'],
      ["_storage/file", "changed"],
    ]);
    assert.throws(() => compareSnapshotArchives(source, fileMismatch), {
      message: "snapshot_file_mismatch",
    });

    const inventoryMismatch = join(root, "inventory-mismatch.zip");
    syntheticZip(inventoryMismatch, [
      ["users/documents.jsonl", '{"_id":"user-a","value":1}\n'],
    ]);
    assert.throws(() => compareSnapshotArchives(source, inventoryMismatch), {
      message: "snapshot_inventory_mismatch",
    });

    const duplicate = join(root, "duplicate.zip");
    syntheticZip(duplicate, [
      ["users/documents.jsonl", ""],
      ["users/documents.jsonl", ""],
    ]);
    assert.throws(() => readBoundedZip(duplicate), {
      message: "zip_duplicate_entry",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot archive input is bounded before inflation", () => {
  assert.equal(LIMITS.snapshotBytes, 64 * 1024 * 1024);
  assert.equal(LIMITS.inflatedEntryBytes, 32 * 1024 * 1024);
  assert.equal(LIMITS.inflatedTotalBytes, 128 * 1024 * 1024);
  assert.ok(LIMITS.zipEntries <= 10_000);
});

test("CLI failures emit one bounded object and never echo private arguments", () => {
  const privateValue = "/private/owner/secret-snapshot.zip";
  const result = spawnSync(
    process.execPath,
    [script, "--snapshot", privateValue, "--unknown", "secret"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    status: "failed",
    stage: "preflight",
    code: "invalid_arguments",
  });
  assert.equal(result.stderr, "native restore verification failed\n");
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /owner|secret-snapshot/u,
  );
});
