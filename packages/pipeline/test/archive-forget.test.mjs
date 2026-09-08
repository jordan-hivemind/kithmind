import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openArchiveCatalog } from "../dist/archiveCatalog.js";
import { runArchiveForget } from "../dist/archiveForget.js";
import { Journal } from "../dist/journal.js";

const hash = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const repeatedHash = (value) => value.repeat(64);
const codec = {
  parseCheckpoint(value) {
    if (value?.version !== 1 || value.phase !== "idle") throw new Error("bad");
    return value;
  },
  parseResult() {
    throw new Error("unused");
  },
};

function config(directory) {
  const digest = repeatedHash("a");
  const identity = {
    archiveProfileFingerprint: digest,
    archiveIdentityFingerprint: digest,
    recipientFingerprint: digest,
    repositoryKeyDomainFingerprint: digest,
    storageFailureDomainFingerprint: digest,
  };
  return {
    protocolVersion: 1,
    endpoint: "https://worker.example/api/worker",
    spaceId: "space_1",
    sourceAccountId: "source_1",
    credentialEnv: "TEST_KEY",
    roots: [{ alias: "root", path: join(directory, "root") }],
    journalDir: directory,
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
    pdfDocQa: {
      captureDirectory: join(directory, "captures"),
      parserOutputRoot: join(directory, "parser"),
      spoolDirectory: join(directory, "spool"),
      parser: {
        pythonExecutable: "/tools/python",
        expectedPythonSha256: digest,
        launcherPath: "/tools/launcher.py",
        expectedLauncherSha256: digest,
        packageRoot: "/tools/package",
        modelAssetsPath: "/tools/models",
        modelLockPath: "/tools/model-lock.json",
        expectedModelLockSha256: digest,
      },
      profile: {
        parserProfileId: "pdf_docqa_v1",
        parserFingerprint: digest,
        extractionConfigurationFingerprint: digest,
        extractorFingerprint: "extractor",
        recordSchemaFingerprint: "records-disabled",
        normalizationFingerprint: "normalizer",
        chunkerFingerprint: digest,
        correctionRevision: "correction",
      },
      archive: {
        ageBinary: "/tools/age",
        primary: {
          directory: join(directory, "primary"),
          recipient: `age1${"q".repeat(40)}`,
          ...identity,
        },
        independentBackup: {
          directory: join(directory, "backup"),
          recipient: `age1${"p".repeat(40)}`,
          resticBinary: "/tools/restic",
          repositoryPath: join(directory, "repository"),
          expectedRepositoryId: "repository_1",
          passwordCommand: { executable: "/tools/password" },
          host: "worker_host",
          ...identity,
        },
      },
    },
  };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "archive-forget-"));
  const cfg = config(directory);
  const journal = await Journal.open({
    directory,
    binding: {
      protocolVersion: 1,
      endpoint: cfg.endpoint,
      spaceId: cfg.spaceId,
      sourceAccountId: cfg.sourceAccountId,
      configFingerprint: repeatedHash("f"),
      credentialSlot: cfg.credentialEnv,
    },
    credential: "synthetic_high_entropy_credential",
    initialCheckpoint: { version: 1, phase: "idle" },
    codec,
  });
  return {
    directory,
    config: cfg,
    journal,
    catalog: await openArchiveCatalog({ journal }),
  };
}

function copy(role, seed) {
  const archiveObjectId = randomUUID();
  return {
    role,
    clientReceiptId: randomUUID(),
    archiveObjectId,
    objectName: `${archiveObjectId}.age`,
    archiveIdentityFingerprint: repeatedHash(seed),
    archiveProfileFingerprint: repeatedHash(seed),
    recipientFingerprint: repeatedHash(seed),
    repositoryKeyDomainFingerprint: repeatedHash(seed),
    storageFailureDomainFingerprint: repeatedHash(seed),
    ...(role === "independent_backup"
      ? {
          restic: {
            operationId: randomUUID(),
            host: "worker_host",
            repositoryId: "repository_1",
          },
        }
      : {}),
  };
}

async function createOriginal(catalog, sourceExternalId) {
  return await catalog.createOriginalIntent({
    originalCatalogId: randomUUID(),
    sourceExternalId,
    origin: {
      scanId: "scan_1",
      observationEpoch: 1,
      sha256: repeatedHash("1"),
      byteLength: 100,
      mediaType: "application/pdf",
    },
    copies: {
      primary: copy("primary", "2"),
      independent_backup: copy("independent_backup", "3"),
    },
    createdAt: 1,
  });
}

async function publishOriginal(catalog, row, withReceipts) {
  for (const role of ["primary", "independent_backup"]) {
    const cipher = {
      sha256: repeatedHash(role === "primary" ? "4" : "5"),
      byteLength: 200,
    };
    row = await catalog.recordArchivePreparationIntent({
      subject: "original_bytes",
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      role,
      tempName: `${row.copies[role].archiveObjectId}.tmp`,
    });
    row = await catalog.recordArchivePrepared({
      subject: "original_bytes",
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      role,
      prepared: {
        state: "prepared",
        tempName: row.copies[role].preparationIntent.tempName,
        source: {
          sha256: row.origin.sha256,
          byteLength: row.origin.byteLength,
        },
        ciphertext: cipher,
        ciphertextDevice: 10,
        ciphertextInode: role === "primary" ? 11 : 12,
        archiveDirectoryDevice: 10,
        archiveDirectoryInode: role === "primary" ? 13 : 14,
        ageVersion: "v1.3.2",
      },
    });
    row = await catalog.recordArchivePublished({
      subject: "original_bytes",
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      role,
      published: {
        state: "published",
        source: row.copies[role].prepared.source,
        ciphertext: cipher,
        ciphertextDevice: row.copies[role].prepared.ciphertextDevice,
        ciphertextInode: row.copies[role].prepared.ciphertextInode,
        ageVersion: "v1.3.2",
      },
      ...(role === "primary" ? { readbackVerifiedAt: 2 } : {}),
    });
    if (role === "independent_backup") {
      row = await catalog.recordResticBackup({
        subject: "original_bytes",
        catalogId: row.originalCatalogId,
        expectedRevision: row.rowRevision,
        role,
        backup: {
          operationId: row.copies[role].restic.operationId,
          snapshotId: repeatedHash("6"),
          objectName: row.copies[role].objectName,
          ciphertext: cipher,
          resticVersion: "0.19.1",
          repositoryId: row.copies[role].restic.repositoryId,
          verification: "destination_ciphertext_readback",
          boundary: {
            mode: "synthetic",
            readiness: "synthetic_only",
            primaryDevice: 10,
            backupDevice: 11,
          },
        },
        readbackVerifiedAt: 2,
      });
    }
    if (withReceipts) {
      row = await catalog.recordCloudReceipt({
        subject: "original_bytes",
        catalogId: row.originalCatalogId,
        expectedRevision: row.rowRevision,
        role,
        receiptId: `receipt_${role}`,
        requestDigest: repeatedHash(role === "primary" ? "7" : "8"),
        recordedAt: 2,
      });
    }
  }
  return row;
}

function cloudTargets(row, epoch, acks = new Map()) {
  return ["primary", "independent_backup"].map((role) => {
    const copy = row.copies[role];
    return {
      receiptId: copy.cloudReceipt.receiptId,
      clientReceiptId: copy.clientReceiptId,
      receiptRequestDigest: repeatedHash(role === "primary" ? "9" : "a"),
      subjectKind: "original_bytes",
      copyRole: role,
      archiveIdentityFingerprint: copy.archiveIdentityFingerprint,
      archiveObjectId: copy.archiveObjectId,
      ciphertextHash: copy.published.ciphertext.sha256,
      ciphertextByteLength: copy.published.ciphertext.byteLength,
      forgetEpoch: epoch,
      ...(acks.has(copy.cloudReceipt.receiptId)
        ? { ack: acks.get(copy.cloudReceipt.receiptId) }
        : {}),
    };
  });
}

function commands(catalog, calls) {
  return {
    async removeAge(input) {
      calls.push(["age", input]);
      const rows = catalog.listOriginals();
      assert.ok(
        rows.some((row) =>
          Object.values(row.copies).some(
            (value) =>
              value.deletion?.state === "pending" &&
              (value.cloudReceipt === undefined ||
                value.deletion.receiptRequestDigest),
          ),
        ),
      );
      return { outcome: "deleted", verification: "exact_path_absence" };
    },
    async forgetBackup(input) {
      calls.push(["backup", input]);
      return {
        outcome: "deleted",
        snapshotId: input.snapshotId,
        repositoryId: input.expectedRepositoryId,
        verification: "snapshot_absence_after_forget_prune",
      };
    },
    async removeCapture(input) {
      calls.push(["capture", input]);
      return { state: "removed" };
    },
    async inspectCaptureIntent(input) {
      calls.push(["inspect-capture", input]);
      return { state: "absent" };
    },
    async removeParserOutput(input) {
      calls.push(["parser", input]);
      return { state: "removed" };
    },
    async inspectParserIntent(input) {
      calls.push(["inspect-parser", input]);
      const row = catalog
        .listProcessings()
        .find((value) => value.parserIntent.outputId === input.outputId);
      return row.parserIntent;
    },
    async inspectSpoolIntent(input) {
      calls.push(["inspect-spool", input]);
      return { state: "absent" };
    },
    async removeSpool(input) {
      calls.push(["spool", input]);
      return { state: "removed" };
    },
  };
}

function transport({
  catalog,
  sourceExternalId,
  sourceItemId,
  epoch,
  targets,
}) {
  const acks = new Map();
  const requests = [];
  return {
    requests,
    async call(request) {
      requests.push(structuredClone(request));
      if (request.operation === "archive.forgetTargets") {
        return {
          operation: request.operation,
          sourceItemId,
          sourceExternalIdHash: hash(sourceExternalId),
          forgetEpoch: epoch,
          targets: targets().map((target) => ({
            ...target,
            ...(acks.has(target.receiptId)
              ? { ack: acks.get(target.receiptId) }
              : {}),
          })),
          isDone: true,
          continueCursor: "done",
        };
      }
      const rows = catalog.listOriginals();
      const copy = rows
        .flatMap((row) => Object.values(row.copies))
        .find((value) => value.cloudReceipt?.receiptId === request.receiptId);
      assert.equal(copy.deletion.state, "complete");
      assert.equal(request.requestId, copy.deletion.deletionId);
      const ack = {
        deletionId: request.deletionId,
        receiptId: request.receiptId,
        forgetEpoch: request.expectedForgetEpoch,
        objectOutcome: request.objectOutcome,
        ...(request.backupOutcome === undefined
          ? {}
          : { backupOutcome: request.backupOutcome }),
        absenceAuthority: "worker_asserted_physical_absence",
        completedAt: 10,
      };
      acks.set(request.receiptId, ack);
      return { operation: request.operation, ...ack, reused: false };
    },
  };
}

test("persists exact physical deletion before acknowledging every cloud receipt", async () => {
  const f = await setup();
  try {
    const sourceExternalId = randomUUID();
    const sourceItemId = "source_item";
    let row = await createOriginal(f.catalog, sourceExternalId);
    row = await publishOriginal(f.catalog, row, true);
    row = await f.catalog.recordOriginalCloud({
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      cloud: {
        sourceItemId,
        sourceRevisionId: "revision_1",
        primaryReceiptId: row.copies.primary.cloudReceipt.receiptId,
        backupReceiptId: row.copies.independent_backup.cloudReceipt.receiptId,
        admittedAt: 3,
      },
    });
    const calls = [];
    const targets = cloudTargets(row, 7);
    const worker = transport({
      catalog: f.catalog,
      sourceExternalId,
      sourceItemId,
      epoch: 7,
      targets: () => targets,
    });
    const result = await runArchiveForget({
      config: f.config,
      catalog: f.catalog,
      transport: worker,
      sourceItemId,
      sourceExternalId,
      forgetEpoch: 7,
      commands: commands(f.catalog, calls),
      now: () => 5,
    });
    assert.deepEqual(result, {
      state: "owner_finalization_required",
      sourceItemId,
      forgetEpoch: 7,
      receiptCount: 2,
      acknowledgedCount: 2,
      localCopyCount: 2,
      nextAction: "run_authenticated_owner_continue_forget",
    });
    assert.equal(calls.filter(([kind]) => kind === "age").length, 2);
    assert.equal(calls.filter(([kind]) => kind === "backup").length, 1);
    const ackRequests = worker.requests.filter(
      (request) => request.operation === "archive.ackDeletion",
    );
    assert.equal(ackRequests.length, 2);
    assert.ok(
      ackRequests.every((request) => request.requestId === request.deletionId),
    );
    assert.notEqual(
      targets[0].receiptRequestDigest,
      row.copies.primary.cloudReceipt.requestDigest,
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("zero cloud receipts still clean durable pre-admission artifacts", async () => {
  const f = await setup();
  try {
    const sourceExternalId = randomUUID();
    let original = await createOriginal(f.catalog, sourceExternalId);
    original = await publishOriginal(f.catalog, original, false);
    let processing = await f.catalog.createProcessingIntent({
      processingCatalogId: randomUUID(),
      originalCatalogId: original.originalCatalogId,
      currentObservation: {
        scanId: "scan_1",
        observationEpoch: 1,
        processingEpoch: 1,
      },
      fingerprints: {
        parserFingerprint: repeatedHash("a"),
        extractionConfigurationFingerprint: repeatedHash("b"),
        discoveryProfileFingerprint: repeatedHash("c"),
        processingPolicyFingerprint: repeatedHash("d"),
        correctionFingerprint: repeatedHash("e"),
      },
      captureIntent: {
        captureId: randomUUID(),
        directory: { device: 20, inode: 21 },
      },
      parserIntent: {
        outputId: randomUUID(),
        outputRoot: { device: 20, inode: 22 },
        outputDirectory: { device: 20, inode: 23 },
        parserArtifactClientId: randomUUID(),
      },
      spoolIntent: {
        spoolId: randomUUID(),
        root: { device: 20, inode: 24 },
      },
      copies: {
        primary: copy("primary", "b"),
        independent_backup: copy("independent_backup", "c"),
      },
      createdAt: 2,
    });
    processing = await f.catalog.recordCapture({
      catalogId: processing.processingCatalogId,
      expectedRevision: processing.rowRevision,
      capture: {
        opaqueName: processing.captureIntent.captureId,
        device: 20,
        inode: 25,
        sha256: original.origin.sha256,
        byteLength: original.origin.byteLength,
        sourceModifiedAt: 2,
        directory: processing.captureIntent.directory,
      },
    });
    const calls = [];
    const worker = transport({
      catalog: f.catalog,
      sourceExternalId,
      sourceItemId: "source_item",
      epoch: 9,
      targets: () => [],
    });
    const result = await runArchiveForget({
      config: f.config,
      catalog: f.catalog,
      transport: worker,
      sourceItemId: "source_item",
      sourceExternalId,
      forgetEpoch: 9,
      commands: commands(f.catalog, calls),
      now: () => 5,
    });
    assert.equal(
      result.state,
      "owner_finalization_required",
      JSON.stringify(result),
    );
    assert.equal(result.receiptCount, 0);
    assert.equal(result.localCopyCount, 2);
    assert.equal(calls.filter(([kind]) => kind === "capture").length, 1);
    assert.equal(calls.filter(([kind]) => kind === "inspect-parser").length, 2);
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a cloud and local external identity mismatch causes no deletion", async () => {
  const f = await setup();
  try {
    const sourceExternalId = randomUUID();
    let row = await createOriginal(f.catalog, sourceExternalId);
    row = await publishOriginal(f.catalog, row, false);
    const calls = [];
    const worker = transport({
      catalog: f.catalog,
      sourceExternalId: randomUUID(),
      sourceItemId: "source_item",
      epoch: 3,
      targets: () => [],
    });
    const result = await runArchiveForget({
      config: f.config,
      catalog: f.catalog,
      transport: worker,
      sourceItemId: "source_item",
      sourceExternalId,
      forgetEpoch: 3,
      commands: commands(f.catalog, calls),
    });
    assert.deepEqual(result, {
      state: "needs_review",
      code: "source_identity_conflict",
    });
    assert.equal(calls.length, 0);
    assert.ok(
      f.catalog.listOriginals()[0].copies.primary.deletion === undefined,
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("an unrecorded capture result blocks zero-receipt finalization", async () => {
  const f = await setup();
  try {
    const sourceExternalId = randomUUID();
    const original = await createOriginal(f.catalog, sourceExternalId);
    const processing = await f.catalog.createProcessingIntent({
      processingCatalogId: randomUUID(),
      originalCatalogId: original.originalCatalogId,
      currentObservation: {
        scanId: "scan_1",
        observationEpoch: 1,
        processingEpoch: 1,
      },
      fingerprints: {
        parserFingerprint: repeatedHash("a"),
        extractionConfigurationFingerprint: repeatedHash("b"),
        discoveryProfileFingerprint: repeatedHash("c"),
        processingPolicyFingerprint: repeatedHash("d"),
        correctionFingerprint: repeatedHash("e"),
      },
      captureIntent: {
        captureId: randomUUID(),
        directory: { device: 20, inode: 21 },
      },
      parserIntent: {
        outputId: randomUUID(),
        outputRoot: { device: 20, inode: 22 },
        outputDirectory: { device: 20, inode: 23 },
        parserArtifactClientId: randomUUID(),
      },
      spoolIntent: {
        spoolId: randomUUID(),
        root: { device: 20, inode: 24 },
      },
      copies: {
        primary: copy("primary", "b"),
        independent_backup: copy("independent_backup", "c"),
      },
      createdAt: 2,
    });
    const calls = [];
    const injected = commands(f.catalog, calls);
    injected.inspectCaptureIntent = async () => ({
      state: "present_unowned",
    });
    const result = await runArchiveForget({
      config: f.config,
      catalog: f.catalog,
      transport: transport({
        catalog: f.catalog,
        sourceExternalId,
        sourceItemId: "source_item",
        epoch: 3,
        targets: () => [],
      }),
      sourceItemId: "source_item",
      sourceExternalId,
      forgetEpoch: 3,
      commands: injected,
    });
    assert.deepEqual(result, {
      state: "needs_review",
      code: "lost_capture_result",
    });
    assert.equal(processing.capture, undefined);
    assert.equal(
      calls.some(([kind]) => kind === "age"),
      false,
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a cloud acknowledgement without its local durable deletion blocks before deletion", async () => {
  const f = await setup();
  try {
    const sourceExternalId = randomUUID();
    let row = await createOriginal(f.catalog, sourceExternalId);
    row = await publishOriginal(f.catalog, row, true);
    const targets = cloudTargets(row, 6);
    targets[0].ack = {
      deletionId: randomUUID(),
      receiptId: targets[0].receiptId,
      forgetEpoch: 6,
      objectOutcome: "deleted",
      absenceAuthority: "worker_asserted_physical_absence",
      completedAt: 10,
    };
    const calls = [];
    const result = await runArchiveForget({
      config: f.config,
      catalog: f.catalog,
      transport: {
        async call(request) {
          assert.equal(request.operation, "archive.forgetTargets");
          return {
            operation: request.operation,
            sourceItemId: "source_item",
            sourceExternalIdHash: hash(sourceExternalId),
            forgetEpoch: 6,
            targets,
            isDone: true,
            continueCursor: "done",
          };
        },
      },
      sourceItemId: "source_item",
      sourceExternalId,
      forgetEpoch: 6,
      commands: commands(f.catalog, calls),
    });
    assert.deepEqual(result, {
      state: "needs_review",
      code: "ack_identity_mismatch",
    });
    assert.equal(calls.length, 0);
    assert.equal(
      f.catalog.listOriginals()[0].copies.primary.deletion,
      undefined,
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("revocation after planning stops before the next physical deletion", async () => {
  const f = await setup();
  try {
    const sourceExternalId = randomUUID();
    let row = await createOriginal(f.catalog, sourceExternalId);
    row = await publishOriginal(f.catalog, row, false);
    let callsToCloud = 0;
    const calls = [];
    const result = await runArchiveForget({
      config: f.config,
      catalog: f.catalog,
      transport: {
        async call(request) {
          callsToCloud += 1;
          if (callsToCloud > 1) return { error: { code: "not_authorized" } };
          return {
            operation: request.operation,
            sourceItemId: "source_item",
            sourceExternalIdHash: hash(sourceExternalId),
            forgetEpoch: 12,
            targets: [],
            isDone: true,
            continueCursor: "done",
          };
        },
      },
      sourceItemId: "source_item",
      sourceExternalId,
      forgetEpoch: 12,
      commands: commands(f.catalog, calls),
      now: () => 5,
    });
    assert.deepEqual(result, { state: "failed", code: "not_authorized" });
    assert.equal(calls.length, 0);
    assert.equal(
      f.catalog.listOriginals()[0].copies.primary.deletion.state,
      "pending",
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a lost acknowledgement response resumes from the durable deletion identity", async () => {
  const f = await setup();
  try {
    const sourceExternalId = randomUUID();
    const sourceItemId = "source_item";
    let row = await createOriginal(f.catalog, sourceExternalId);
    row = await publishOriginal(f.catalog, row, true);
    const targets = cloudTargets(row, 11);
    const worker = transport({
      catalog: f.catalog,
      sourceExternalId,
      sourceItemId,
      epoch: 11,
      targets: () => targets,
    });
    let lost = false;
    const flaky = {
      async call(request) {
        const response = await worker.call(request);
        if (!lost && request.operation === "archive.ackDeletion") {
          lost = true;
          throw new Error("synthetic lost response");
        }
        return response;
      },
    };
    const calls = [];
    const first = await runArchiveForget({
      config: f.config,
      catalog: f.catalog,
      transport: flaky,
      sourceItemId,
      sourceExternalId,
      forgetEpoch: 11,
      commands: commands(f.catalog, calls),
      now: () => 5,
    });
    assert.deepEqual(first, { state: "failed", code: "operation_failed" });
    const deletionIds = f.catalog.listOriginals()[0].copies;
    assert.equal(deletionIds.primary.deletion.state, "complete");
    assert.equal(deletionIds.independent_backup.deletion.state, "complete");
    const ageCalls = calls.filter(([kind]) => kind === "age").length;
    const second = await runArchiveForget({
      config: f.config,
      catalog: f.catalog,
      transport: worker,
      sourceItemId,
      sourceExternalId,
      forgetEpoch: 11,
      commands: commands(f.catalog, calls),
      now: () => 6,
    });
    assert.equal(second.state, "owner_finalization_required");
    assert.equal(calls.filter(([kind]) => kind === "age").length, ageCalls);
    const ackRequests = worker.requests.filter(
      (request) => request.operation === "archive.ackDeletion",
    );
    assert.equal(
      ackRequests[0].requestId,
      deletionIds.primary.deletion.deletionId,
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
