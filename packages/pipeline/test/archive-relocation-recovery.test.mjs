import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import test from "node:test";

import {
  ArchiveRelocationRecoveryError,
  __testOnlyVerifyArchiveRelocationRecovery,
} from "../dist/archiveRelocationRecovery.js";
import { fingerprintLegacyDatabaseBackupReceipt } from "../dist/archiveRelocationRecipe.js";

const fixture = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/archive-relocation-inventory-recipe.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const namespace = "84baabd3-0c79-528f-81ac-4e059454e4f3";
const processingCipher = Buffer.from("processing ciphertext", "utf8");
const processingPlain = Buffer.from("processing plaintext", "utf8");
const databaseCipher = Buffer.from("database ciphertext", "utf8");
const databasePayload = Buffer.from(
  "closed synthetic database payload",
  "utf8",
);
const nativeZip = Buffer.from("PK\x03\x04synthetic native zip", "binary");

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uuidBytes(value) {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function uuidV5(name) {
  const digest = createHash("sha1")
    .update(uuidBytes(namespace))
    .update(name, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function recipe() {
  const value = structuredClone(fixture);
  const artifact = value.body.processing.artifacts[0];
  const binding = value.body.processing.artifactBindings[0];
  artifact.ciphertextSha256 = binding.ciphertextSha256 = sha(processingCipher);
  artifact.ciphertextByteLength = binding.ciphertextByteLength =
    processingCipher.length;
  binding.plaintextSha256 = sha(processingPlain);
  binding.plaintextByteLength = processingPlain.length;
  const receipt = value.body.database.receipts[0].receipt;
  receipt.ciphertextHash = sha(databaseCipher);
  receipt.ciphertextByteLength = databaseCipher.length;
  receipt.payloadHash = sha(databasePayload);
  receipt.nativeZipHash = sha(nativeZip);
  const receiptFingerprint = fingerprintLegacyDatabaseBackupReceipt(receipt);
  value.body.database.receipts[0].receiptFingerprint = receiptFingerprint;
  value.body.database.selectedNativeRestoreReceiptFingerprint =
    receiptFingerprint;
  value.body.localBindings.databaseReceiptPaths[0].receiptFingerprint =
    receiptFingerprint;
  const bodyBytes = Buffer.from(JSON.stringify(value.body), "utf8");
  value.recipeHash = sha(
    Buffer.concat([
      Buffer.from("owner-archive-relocation-recipe:v1\0", "utf8"),
      bodyBytes,
    ]),
  );
  value.workflowRelocationId = uuidV5(
    `${value.recipeHash}:whole-root-workflow`,
  );
  value.catalogRelocationId = uuidV5(
    `${value.recipeHash}:processing-catalog-relocation`,
  );
  value.watcherResetRequestId = uuidV5(
    `${value.recipeHash}:owner-watcher-reset`,
  );
  return value;
}

function boundary(value, domain, phase) {
  return value.body[domain][phase === "old" ? "oldBoundary" : "newBoundary"];
}

function inventories(value, phase) {
  const processingBinding = value.body.processing.artifactBindings[0];
  const databaseReceipt = value.body.database.receipts[0].receipt;
  const processingBoundary = boundary(value, "processing", phase);
  const databaseBoundary = boundary(value, "database", phase);
  const snapshots = (repositoryBoundary, row) => ({
    repositoryId: repositoryBoundary.repositoryId,
    resticVersion: "0.19.1",
    boundary: structuredClone(repositoryBoundary),
    snapshots: [row],
    verification: "unfiltered_snapshot_inventory",
  });
  const tree = (repositoryBoundary, snapshotId, entries, treeId) => ({
    repositoryId: repositoryBoundary.repositoryId,
    resticVersion: "0.19.1",
    boundary: structuredClone(repositoryBoundary),
    snapshotId,
    treeId,
    entries,
    verification: "exact_snapshot_tree_inventory",
  });
  return {
    processing: {
      snapshots: snapshots(processingBoundary, {
        snapshotId: processingBinding.snapshotId,
        hostname: "synthetic-host",
        tags: [],
        paths: [`/input/${processingBinding.objectName}`],
      }),
      tree: tree(
        processingBoundary,
        processingBinding.snapshotId,
        [
          {
            type: "file",
            name: processingBinding.objectName,
            path: `/${processingBinding.objectName}`,
            byteLength: processingBinding.ciphertextByteLength,
          },
        ],
        "a".repeat(64),
      ),
    },
    database: {
      snapshots: snapshots(databaseBoundary, {
        snapshotId: databaseReceipt.snapshotId,
        hostname: "synthetic-host",
        tags: [databaseReceipt.snapshotTag],
        paths: [databaseReceipt.objectPath],
      }),
      tree: tree(
        databaseBoundary,
        databaseReceipt.snapshotId,
        [
          { type: "dir", name: "synthetic", path: "/synthetic" },
          { type: "dir", name: "database", path: "/synthetic/database" },
          {
            type: "file",
            name: "snapshot-1.age",
            path: databaseReceipt.objectPath,
            byteLength: databaseReceipt.ciphertextByteLength,
          },
        ],
        "b".repeat(64),
      ),
    },
  };
}

async function setup(t, options = {}) {
  const value = recipe();
  const rows = inventories(value, "old");
  const root = await mkdtemp(join(homedir(), ".archive-recovery-test-"));
  await stat(root)
    .then((entry) => entry.mode & 0o777)
    .then((mode) => assert.equal(mode, 0o700));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptDirectory = join(root, "attempt-1");
  const events = [];
  let activeTrees = 0;
  let maxActiveTrees = 0;
  let returnedNativeZip;
  const adapters = {
    inventorySnapshots: async (input) => {
      events.push(`snapshots:${input.expectedRepositoryId}`);
      return input.expectedRepositoryId ===
        rows.processing.snapshots.repositoryId
        ? rows.processing.snapshots
        : rows.database.snapshots;
    },
    inventoryTree: async (input) => {
      activeTrees += 1;
      maxActiveTrees = Math.max(maxActiveTrees, activeTrees);
      await new Promise((resolve) => setImmediate(resolve));
      events.push(`tree:${input.snapshotId}`);
      const result =
        input.snapshotId === rows.processing.tree.snapshotId
          ? rows.processing.tree
          : rows.database.tree;
      activeTrees -= 1;
      return result;
    },
    restoreObject: async (input) => {
      events.push("restore:processing");
      return {
        destinationPath: input.destinationPath,
        snapshotId: input.snapshotId,
        objectName: options.wrongRestoreLocator
          ? "wrong.age"
          : input.objectName,
        ciphertext: input.expectedCiphertext,
        resticVersion: "0.19.1",
        repositoryId: input.expectedRepositoryId,
        verification: "exact_ciphertext_restore",
      };
    },
    restoreSnapshotPath: async (input) => {
      events.push("restore:database");
      return {
        destinationPath: input.destinationPath,
        snapshotId: input.snapshotId,
        objectPath: input.objectPath,
        ciphertext: input.expectedCiphertext,
        resticVersion: "0.19.1",
        repositoryId: input.expectedRepositoryId,
        verification: "exact_ciphertext_restore",
      };
    },
    decrypt: async (input) => {
      const processing = input.expectedPlaintextSha256 === sha(processingPlain);
      events.push(`decrypt:${processing ? "processing" : "database"}`);
      let fileIdentity;
      if (!processing && options.realPayloadRead) {
        await writeFile(input.outputPath, databasePayload, { mode: 0o600 });
        fileIdentity = await stat(input.outputPath);
      }
      return {
        outputPath: input.outputPath,
        plaintext: {
          sha256: input.expectedPlaintextSha256,
          byteLength: processing
            ? (options.processingPlaintextLength ?? processingPlain.length)
            : databasePayload.length,
        },
        plaintextDevice: fileIdentity?.dev ?? 1,
        plaintextInode:
          fileIdentity === undefined
            ? processing
              ? 2
              : 3
            : fileIdentity.ino + (options.payloadIdentityMismatch ? 1 : 0),
        ageVersion: options.wrongAgeVersion ? "v0" : "v1.3.2",
        verification: "decrypted_plaintext_hash",
      };
    },
    readPayload: async () => Buffer.from(databasePayload),
    decodeNativePayload: () => {
      returnedNativeZip = Buffer.from(nativeZip);
      const manifest = {
        kind: "native_convex_snapshot_v1",
        deployment: "synthetic:test",
        createdAt: "2026-09-08T23:30:00.123456+00:00",
        includeFileStorage: true,
        byteLength: nativeZip.length,
        sha256: sha(nativeZip),
        sourceCommit: "c".repeat(40),
      };
      if (options.malformedDecodedManifest) manifest.extra = true;
      return {
        nativeZip: returnedNativeZip,
        manifest,
      };
    },
    now: () => 1_789_000_000_000,
  };
  if (options.realPayloadRead) delete adapters.readPayload;
  const config = (repositoryBoundary) => ({
    resticBinary: "/synthetic/restic",
    repository: {
      kind: "rclone_dropbox_v1",
      remoteName: repositoryBoundary.remoteName,
      rootPath: repositoryBoundary.rootPath,
      rcloneBinary: "/synthetic/rclone",
      configPath: "/synthetic/rclone.conf",
      configIdentityFingerprint: repositoryBoundary.configIdentityFingerprint,
      expectedRootDirectoryIdHash: repositoryBoundary.rootDirectoryIdHash,
    },
    expectedRepositoryId: repositoryBoundary.repositoryId,
    passwordCommand: { executable: "/synthetic/password" },
    ageBinary: "/synthetic/age",
    identityPath: "/synthetic/identity",
  });
  const nativeVerifier = async (input) => {
    events.push("verify:native");
    await assert.rejects(() => stat(input.outputDirectory), { code: "ENOENT" });
    await mkdir(input.outputDirectory, { mode: 0o700 });
    const output = await stat(input.outputDirectory);
    return {
      passed: true,
      nativeZipSha256:
        options.nativeResultSha256 ??
        value.body.database.receipts[0].receipt.nativeZipHash,
      backendSha256: "d".repeat(64),
      verificationResultSha256: "e".repeat(64),
      outputDirectory: input.outputDirectory,
      outputDirectoryDevice: output.dev,
      outputDirectoryInode: output.ino,
    };
  };
  return {
    value,
    rows,
    attemptDirectory,
    events,
    adapters,
    nativeVerifier,
    returnedNativeZip: () => returnedNativeZip,
    maxActiveTrees: () => maxActiveTrees,
    input: {
      recipe: value,
      phase: "old",
      attemptDirectory,
      processing: config(boundary(value, "processing", "old")),
      database: config(boundary(value, "database", "old")),
      nativeVerifier,
    },
  };
}

test("verifies complete inventories before exact content recovery", async (t) => {
  const f = await setup(t);
  const proof = await __testOnlyVerifyArchiveRelocationRecovery(
    f.input,
    f.adapters,
  );
  assert.equal(proof.version, 1);
  assert.equal(proof.objects.length, 2);
  assert.equal(proof.objects[0].domain, "processing");
  assert.equal(proof.objects[1].domain, "database");
  assert.equal(proof.nativeVerification.passed, true);
  assert.equal(proof.workflowArtifacts.length, 2);
  assert.equal(f.maxActiveTrees(), 1);
  assert.equal(proof.completedAt, 1_789_000_000_000);
  const firstRead = f.events.findIndex((event) => event.startsWith("restore:"));
  assert.equal(
    f.events
      .slice(0, firstRead)
      .filter((event) => event.startsWith("snapshots:")).length,
    2,
  );
  assert.equal(
    f.events.slice(0, firstRead).filter((event) => event.startsWith("tree:"))
      .length,
    2,
  );
  assert.deepEqual(f.returnedNativeZip(), Buffer.alloc(nativeZip.length));
});

test("rejects incomplete inventory before any content read", async (t) => {
  const f = await setup(t);
  f.rows.processing.snapshots.snapshots.push({
    ...structuredClone(f.rows.processing.snapshots.snapshots[0]),
    snapshotId: "f".repeat(64),
  });
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationRecovery(f.input, f.adapters),
    /verification_failed/,
  );
  assert.equal(
    f.events.some((event) => event.startsWith("tree:")),
    false,
  );
  assert.equal(
    f.events.some((event) => event.startsWith("restore:")),
    false,
  );
  assert.equal((await stat(f.attemptDirectory)).isDirectory(), true);
});

test("rejects wrong processing length and closed native result", async (t) => {
  const length = await setup(t, {
    processingPlaintextLength: processingPlain.length + 1,
  });
  await assert.rejects(
    () =>
      __testOnlyVerifyArchiveRelocationRecovery(length.input, length.adapters),
    (error) =>
      error instanceof ArchiveRelocationRecoveryError &&
      error.code === "verification_failed",
  );

  const native = await setup(t, { nativeResultSha256: "f".repeat(64) });
  await assert.rejects(
    () =>
      __testOnlyVerifyArchiveRelocationRecovery(native.input, native.adapters),
    (error) =>
      error instanceof ArchiveRelocationRecoveryError &&
      error.code === "verification_failed",
  );
  assert.deepEqual(native.returnedNativeZip(), Buffer.alloc(nativeZip.length));
});

test("requires a fresh no-clobber attempt directory", async (t) => {
  const f = await setup(t);
  await __testOnlyVerifyArchiveRelocationRecovery(f.input, f.adapters);
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationRecovery(f.input, f.adapters),
    (error) =>
      error instanceof ArchiveRelocationRecoveryError &&
      error.code === "unsafe_path",
  );
});

test("rejects malformed helper identity results", async (t) => {
  for (const options of [
    { wrongRestoreLocator: true },
    { wrongAgeVersion: true },
    { malformedDecodedManifest: true },
  ]) {
    const f = await setup(t, options);
    await assert.rejects(
      () => __testOnlyVerifyArchiveRelocationRecovery(f.input, f.adapters),
      (error) =>
        error instanceof ArchiveRelocationRecoveryError &&
        error.code === "verification_failed",
    );
  }
});

test("binds the opened database payload to the decrypt result inode", async (t) => {
  const f = await setup(t, {
    realPayloadRead: true,
    payloadIdentityMismatch: true,
  });
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationRecovery(f.input, f.adapters),
    (error) =>
      error instanceof ArchiveRelocationRecoveryError &&
      error.code === "unsafe_path",
  );
});
