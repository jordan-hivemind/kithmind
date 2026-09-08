import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArchiveCatalogError,
  openArchiveCatalog,
} from "../dist/archiveCatalog.js";
import { Journal, JournalLockedError } from "../dist/journal.js";
import {
  captureCatalogRecord,
  parserOutputCatalogRecord,
  parserOutputIntentCore,
  preparedArchiveCatalogRecord,
  publishedArchiveCatalogRecord,
} from "../dist/runner.js";

const hash = (character) => character.repeat(64);
const codec = {
  parseCheckpoint(value) {
    if (value?.version !== 1 || value?.phase !== "idle") throw new Error("bad");
    return { version: 1, phase: "idle" };
  },
  parseResult() {
    throw new Error("unused");
  },
};

function binding() {
  return {
    protocolVersion: 1,
    endpoint: "https://worker.example/api/worker",
    spaceId: `space_${randomUUID()}`,
    sourceAccountId: `source_${randomUUID()}`,
    configFingerprint: hash("a"),
    credentialSlot: "KITHMIND_WORKER_KEY",
  };
}

async function setup() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const directory = await mkdtemp(join(tmpdir(), "archive-catalog-"));
    const authority = binding();
    let journal;
    try {
      journal = await Journal.open({
        directory,
        binding: authority,
        credential: "km_synthetic_high_entropy_credential",
        initialCheckpoint: { version: 1, phase: "idle" },
        codec,
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      // Unrelated authority/path hashes can share bounded local lock ports.
      if (error instanceof JournalLockedError && attempt < 4) continue;
      throw error;
    }
    try {
      const catalog = await openArchiveCatalog({ journal });
      return { directory, authority, journal, catalog };
    } catch (error) {
      await journal.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

function copy(role, seed) {
  const archiveObjectId = randomUUID();
  return {
    role,
    clientReceiptId: randomUUID(),
    archiveObjectId,
    objectName: `${archiveObjectId}.age`,
    archiveIdentityFingerprint: hash(seed),
    archiveProfileFingerprint: hash(seed),
    recipientFingerprint: hash(seed),
    repositoryKeyDomainFingerprint: hash(seed),
    storageFailureDomainFingerprint: hash(seed),
    ...(role === "independent_backup"
      ? {
          restic: {
            operationId: randomUUID(),
            host: `host_${seed}`,
            repositoryId: `repository_${seed}`,
          },
        }
      : {}),
  };
}

function original({
  id = randomUUID(),
  source = randomUUID(),
  seed = "1",
  scan = "scan_1",
} = {}) {
  return {
    originalCatalogId: id,
    sourceExternalId: source,
    origin: {
      scanId: scan,
      observationEpoch: 1,
      sha256: hash(seed),
      byteLength: 100,
      mediaType: "application/pdf",
    },
    copies: {
      primary: copy("primary", seed),
      independent_backup: copy("independent_backup", String(Number(seed) + 1)),
    },
    createdAt: 1,
  };
}

function processing(originalCatalogId, overrides = {}) {
  return {
    processingCatalogId: overrides.id ?? randomUUID(),
    originalCatalogId,
    currentObservation: {
      scanId: overrides.scan ?? "scan_1",
      observationEpoch: overrides.observationEpoch ?? 1,
      processingEpoch: overrides.processingEpoch ?? 1,
    },
    fingerprints: {
      parserFingerprint: hash("a"),
      extractionConfigurationFingerprint: hash("b"),
      discoveryProfileFingerprint: hash("c"),
      processingPolicyFingerprint: hash("d"),
      correctionFingerprint: hash("e"),
    },
    captureIntent: {
      captureId: randomUUID(),
      directory: { device: 1, inode: 2 },
    },
    parserIntent: {
      outputId: randomUUID(),
      outputRoot: { device: 1, inode: 3 },
      outputDirectory: { device: 1, inode: 4 },
      parserArtifactClientId: randomUUID(),
    },
    spoolIntent: {
      spoolId: randomUUID(),
      root: { device: 1, inode: 5 },
    },
    copies: {
      primary: copy("primary", "6"),
      independent_backup: copy("independent_backup", "7"),
    },
    createdAt: 2,
  };
}

test("runner filesystem results project to strict catalog records", async () => {
  const f = await setup();
  try {
    const originalRow = await f.catalog.createOriginalIntent(original());
    let row = await f.catalog.createProcessingIntent(
      processing(originalRow.originalCatalogId),
    );
    const capture = {
      version: 1,
      captureId: row.captureIntent.captureId,
      captureDirectory: {
        path: "/private/captures",
        ...row.captureIntent.directory,
      },
      path: `/private/captures/${row.captureIntent.captureId}.pdf`,
      sha256: originalRow.origin.sha256,
      byteLength: originalRow.origin.byteLength,
      sourceModifiedAt: 20,
      device: 10,
      inode: 11,
    };
    row = await f.catalog.recordCapture({
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      capture: captureCatalogRecord(capture),
    });
    assert.equal("path" in row.capture, false);
    assert.equal("directory" in row.capture, false);
    assert.deepEqual(parserOutputIntentCore(row.parserIntent), {
      outputId: row.parserIntent.outputId,
      outputRoot: row.parserIntent.outputRoot,
      outputDirectory: row.parserIntent.outputDirectory,
    });

    row = await f.catalog.recordParserOutput({
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      output: parserOutputCatalogRecord({
        outputId: row.parserIntent.outputId,
        outputRoot: row.parserIntent.outputRoot,
        outputDirectory: row.parserIntent.outputDirectory,
        sourceSha256: originalRow.origin.sha256,
        rawArtifact: {
          path: "/private/output/lossless.json",
          device: 10,
          inode: 12,
          sha256: hash("8"),
          byteLength: 200,
          mediaType: "application/vnd.docling+json",
        },
        normalizedBundle: {
          path: "/private/output/bundle.json",
          device: 10,
          inode: 13,
          sha256: hash("9"),
          byteLength: 150,
          mediaType: "application/json",
        },
        parserFingerprint: row.fingerprints.parserFingerprint,
        extractionConfigurationFingerprint:
          row.fingerprints.extractionConfigurationFingerprint,
        extractionFingerprint: hash("a"),
        modelManifestSha256: hash("b"),
        pageCount: 64,
      }),
    });
    assert.equal("path" in row.parserOutput.rawArtifact, false);
    assert.equal("path" in row.parserOutput.normalizedBundle, false);
    assert.equal(row.parserOutput.pageCount, 64);
    await assert.rejects(
      () =>
        f.catalog.recordParserOutput({
          catalogId: row.processingCatalogId,
          expectedRevision: row.rowRevision,
          output: { ...row.parserOutput, pageCount: 65 },
        }),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "catalog_invalid",
    );

    const primary = row.copies.primary;
    row = await f.catalog.recordArchivePreparationIntent({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      role: "primary",
      tempName: `${primary.archiveObjectId}.tmp`,
    });
    const prepared = {
      state: "prepared",
      tempPath: `/private/archive/${primary.archiveObjectId}.tmp`,
      source: {
        sha256: row.parserOutput.rawArtifact.sha256,
        byteLength: row.parserOutput.rawArtifact.byteLength,
      },
      ciphertext: { sha256: hash("c"), byteLength: 300 },
      ciphertextDevice: 20,
      ciphertextInode: 21,
      archiveDirectoryDevice: 20,
      archiveDirectoryInode: 22,
      ageVersion: "v1.3.2",
    };
    row = await f.catalog.recordArchivePrepared({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      role: "primary",
      prepared: preparedArchiveCatalogRecord(prepared),
    });
    assert.equal("tempPath" in row.copies.primary.prepared, false);
    const published = {
      state: "published",
      objectPath: `/private/archive/${primary.objectName}`,
      source: prepared.source,
      ciphertext: prepared.ciphertext,
      ciphertextDevice: prepared.ciphertextDevice,
      ciphertextInode: prepared.ciphertextInode,
      ageVersion: "v1.3.2",
    };
    row = await f.catalog.recordArchivePublished({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      role: "primary",
      published: publishedArchiveCatalogRecord(published),
      readbackVerifiedAt: 25,
    });
    assert.equal("objectPath" in row.copies.primary.published, false);
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

async function completeProcessingAdmission(catalog, row, originalRow) {
  row = await catalog.recordCapture({
    catalogId: row.processingCatalogId,
    expectedRevision: row.rowRevision,
    capture: {
      opaqueName: row.captureIntent.captureId,
      device: 10,
      inode: 11,
      sha256: originalRow.origin.sha256,
      byteLength: originalRow.origin.byteLength,
      sourceModifiedAt: 20,
      directory: row.captureIntent.directory,
    },
  });
  row = await catalog.recordParserOutput({
    catalogId: row.processingCatalogId,
    expectedRevision: row.rowRevision,
    output: {
      outputId: row.parserIntent.outputId,
      outputRoot: row.parserIntent.outputRoot,
      outputDirectory: row.parserIntent.outputDirectory,
      sourceSha256: originalRow.origin.sha256,
      rawArtifact: {
        opaqueName: "lossless.json",
        device: 10,
        inode: 12,
        sha256: hash("8"),
        byteLength: 200,
        mediaType: "application/vnd.docling+json",
      },
      normalizedBundle: {
        opaqueName: "bundle.json",
        device: 10,
        inode: 13,
        sha256: hash("9"),
        byteLength: 150,
        mediaType: "application/json",
      },
      parserFingerprint: row.fingerprints.parserFingerprint,
      extractionConfigurationFingerprint:
        row.fingerprints.extractionConfigurationFingerprint,
      extractionFingerprint: hash("a"),
      modelManifestSha256: hash("b"),
      pageCount: 1,
    },
  });
  const preparedName = `.${row.spoolIntent.spoolId}.${randomUUID()}.tmp`;
  row = await catalog.recordSpoolPrepared({
    catalogId: row.processingCatalogId,
    expectedRevision: row.rowRevision,
    prepared: {
      opaqueName: preparedName,
      device: 10,
      inode: 14,
      sha256: row.parserOutput.normalizedBundle.sha256,
      byteLength: row.parserOutput.normalizedBundle.byteLength,
    },
  });
  row = await catalog.recordSpool({
    catalogId: row.processingCatalogId,
    expectedRevision: row.rowRevision,
    spool: {
      opaqueName: `${row.spoolIntent.spoolId}.json`,
      device: 10,
      inode: 14,
      sha256: row.parserOutput.normalizedBundle.sha256,
      byteLength: row.parserOutput.normalizedBundle.byteLength,
    },
  });
  for (const role of ["primary", "independent_backup"]) {
    const ciphertext = {
      sha256: role === "primary" ? hash("c") : hash("d"),
      byteLength: 300,
    };
    row = await catalog.recordArchivePreparationIntent({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      role,
      tempName: `${row.copies[role].archiveObjectId}.tmp`,
    });
    row = await catalog.recordArchivePrepared({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      role,
      prepared: {
        state: "prepared",
        tempName: row.copies[role].preparationIntent.tempName,
        source: {
          sha256: row.parserOutput.rawArtifact.sha256,
          byteLength: row.parserOutput.rawArtifact.byteLength,
        },
        ciphertext,
        ciphertextDevice: 20,
        ciphertextInode: role === "primary" ? 21 : 22,
        archiveDirectoryDevice: 20,
        archiveDirectoryInode: role === "primary" ? 23 : 24,
        ageVersion: "v1.3.2",
      },
    });
    row = await catalog.recordArchivePublished({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      role,
      published: {
        state: "published",
        source: row.copies[role].prepared.source,
        ciphertext,
        ciphertextDevice: row.copies[role].prepared.ciphertextDevice,
        ciphertextInode: row.copies[role].prepared.ciphertextInode,
        ageVersion: "v1.3.2",
      },
      ...(role === "primary" ? { readbackVerifiedAt: 25 } : {}),
    });
    if (role === "independent_backup") {
      row = await catalog.recordResticBackup({
        subject: "parser_output",
        catalogId: row.processingCatalogId,
        expectedRevision: row.rowRevision,
        role,
        backup: {
          operationId: row.copies[role].restic.operationId,
          snapshotId: "snapshot_1",
          objectName: row.copies[role].objectName,
          ciphertext,
          resticVersion: "0.19.1",
          repositoryId: row.copies[role].restic.repositoryId,
          verification: "destination_ciphertext_readback",
          boundary: {
            mode: "independent_backup",
            readiness: "remote_repository_verified",
            backend: "rclone_dropbox_v1",
            remoteName: "kithmind_dropbox",
            rootPath: "Kith Mind Backups/Processing",
            rootDirectoryIdHash: hash("d"),
            configIdentityFingerprint: hash("c"),
            repositoryId: row.copies[role].restic.repositoryId,
            resticVersion: "0.19.1",
            rcloneVersion: "v1.74.4",
          },
        },
        readbackVerifiedAt: 26,
      });
    }
    row = await catalog.recordCloudReceipt({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      role,
      receiptId: `receipt_${role}`,
      requestDigest: hash(role === "primary" ? "e" : "f"),
      recordedAt: 30,
    });
  }
  row = await catalog.recordProcessingCloud({
    catalogId: row.processingCatalogId,
    expectedRevision: row.rowRevision,
    cloud: {
      sourceItemId: "source_item",
      sourceRevisionId: "source_revision",
      parserArtifactId: "parser_artifact",
      sourceTextVersionId: "source_text",
      processingGenerationId: "generation_1",
      ingestJobId: "job_1",
      processingFingerprint: hash("1"),
      admissionRequestDigest: hash("2"),
      admittedAt: 40,
    },
  });
  return row;
}

test("reuses one catalog instance and durable original identity across scans", async () => {
  const f = await setup();
  try {
    assert.strictEqual(
      f.catalog,
      await openArchiveCatalog({ journal: f.journal }),
    );
    const source = randomUUID();
    const first = await f.catalog.createOriginalIntent(original({ source }));
    const replay = await f.catalog.createOriginalIntent(
      original({ source, scan: "scan_2" }),
    );
    assert.equal(replay.originalCatalogId, first.originalCatalogId);
    assert.equal(replay.origin.scanId, "scan_1");
    assert.equal(f.catalog.listOriginals().length, 1);
    assert.ok(
      !(
        await readFile(join(f.directory, "archive-catalog.json"), "utf8")
      ).includes("km_synthetic"),
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a stable catalog ID cannot be redirected to another existing identity", async () => {
  const f = await setup();
  try {
    const firstInput = original({ seed: "1" });
    const secondInput = original({ seed: "3" });
    const first = await f.catalog.createOriginalIntent(firstInput);
    const second = await f.catalog.createOriginalIntent(secondInput);
    await assert.rejects(
      () =>
        f.catalog.createOriginalIntent({
          ...secondInput,
          originalCatalogId: first.originalCatalogId,
        }),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "catalog_conflict",
    );
    const firstProcessingInput = processing(first.originalCatalogId);
    const secondProcessingInput = processing(second.originalCatalogId, {
      processingEpoch: 2,
    });
    const firstProcessing =
      await f.catalog.createProcessingIntent(firstProcessingInput);
    await f.catalog.createProcessingIntent(secondProcessingInput);
    await assert.rejects(
      () =>
        f.catalog.createProcessingIntent({
          ...secondProcessingInput,
          processingCatalogId: firstProcessing.processingCatalogId,
        }),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "catalog_conflict",
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("detects a replaced catalog before mutation and preserves the replacement", async () => {
  const f = await setup();
  try {
    await f.catalog.createOriginalIntent(original());
    const target = join(f.directory, "archive-catalog.json");
    const replacement = join(f.directory, "replacement.json");
    const sentinel = Buffer.from('{"replacement":true}\n');
    await writeFile(replacement, sentinel, { mode: 0o600 });
    await rename(replacement, target);
    await assert.rejects(
      () => f.catalog.createOriginalIntent(original({ seed: "4" })),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "durability_failed",
    );
    assert.deepEqual(await readFile(target), sentinel);
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("retains processing capture identity across journal restart", async () => {
  const f = await setup();
  let journal = f.journal;
  try {
    const originalRow = await f.catalog.createOriginalIntent(original());
    const processingInput = processing(originalRow.originalCatalogId);
    const processingRow =
      await f.catalog.createProcessingIntent(processingInput);
    const captured = await f.catalog.recordCapture({
      catalogId: processingRow.processingCatalogId,
      expectedRevision: processingRow.rowRevision,
      capture: {
        opaqueName: processingInput.captureIntent.captureId,
        device: 10,
        inode: 11,
        sha256: originalRow.origin.sha256,
        byteLength: originalRow.origin.byteLength,
        sourceModifiedAt: 20,
        directory: processingInput.captureIntent.directory,
      },
    });
    await journal.close();
    journal = await Journal.open({
      directory: f.directory,
      binding: f.authority,
      credential: "km_synthetic_high_entropy_credential",
      initialCheckpoint: { version: 1, phase: "idle" },
      codec,
    });
    const reopened = await openArchiveCatalog({ journal });
    assert.deepEqual(reopened.listProcessings()[0].capture, captured.capture);
  } finally {
    await journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("persists and replays an initial provider binding epoch of zero", async () => {
  const f = await setup();
  try {
    const input = original();
    input.copies = { primary: input.copies.primary };
    input.providerOriginal = {
      clientReferenceId: randomUUID(),
      bindingId: randomUUID(),
      locator: copy("independent_backup", "3"),
    };
    let row = await f.catalog.createOriginalIntent(input);
    row = await f.catalog.recordProviderVerified({
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      verified: {
        providerAccountIdHash: hash("1"),
        providerRootDirectoryIdHash: hash("2"),
        providerFileIdHash: hash("3"),
        providerRevision: "rev1",
        providerContentHash: hash("4"),
        sourceContentHash: row.origin.sha256,
        sourceByteLength: row.origin.byteLength,
        verifiedAt: 20,
        manifestFingerprint: hash("5"),
        manifestByteLength: 200,
      },
    });
    row = await f.catalog.recordArchivePreparationIntent({
      subject: "original_bytes",
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      role: "primary",
      tempName: `${row.copies.primary.archiveObjectId}.tmp`,
    });
    row = await f.catalog.recordArchivePrepared({
      subject: "original_bytes",
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      role: "primary",
      prepared: {
        state: "prepared",
        tempName: row.copies.primary.preparationIntent.tempName,
        source: {
          sha256: row.origin.sha256,
          byteLength: row.origin.byteLength,
        },
        ciphertext: { sha256: hash("6"), byteLength: 300 },
        ciphertextDevice: 20,
        ciphertextInode: 21,
        archiveDirectoryDevice: 20,
        archiveDirectoryInode: 22,
        ageVersion: "v1.3.2",
      },
    });
    row = await f.catalog.recordArchivePublished({
      subject: "original_bytes",
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      role: "primary",
      published: {
        state: "published",
        source: row.copies.primary.prepared.source,
        ciphertext: row.copies.primary.prepared.ciphertext,
        ciphertextDevice: row.copies.primary.prepared.ciphertextDevice,
        ciphertextInode: row.copies.primary.prepared.ciphertextInode,
        ageVersion: "v1.3.2",
      },
      readbackVerifiedAt: 21,
    });
    row = await f.catalog.recordCloudReceipt({
      subject: "original_bytes",
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      role: "primary",
      receiptId: "receipt_primary",
      requestDigest: hash("7"),
      recordedAt: 22,
    });
    row = await f.catalog.updateProviderLocator({
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      update(locator) {
        locator.preparationIntent = {
          tempName: `${locator.archiveObjectId}.tmp`,
        };
        locator.prepared = {
          state: "prepared",
          tempName: locator.preparationIntent.tempName,
          source: { sha256: hash("5"), byteLength: 200 },
          ciphertext: { sha256: hash("8"), byteLength: 400 },
          ciphertextDevice: 30,
          ciphertextInode: 31,
          archiveDirectoryDevice: 30,
          archiveDirectoryInode: 32,
          ageVersion: "v1.3.2",
        };
        locator.published = {
          state: "published",
          source: locator.prepared.source,
          ciphertext: locator.prepared.ciphertext,
          ciphertextDevice: locator.prepared.ciphertextDevice,
          ciphertextInode: locator.prepared.ciphertextInode,
          ageVersion: "v1.3.2",
        };
        locator.backup = {
          operationId: locator.restic.operationId,
          snapshotId: hash("9"),
          objectName: locator.objectName,
          ciphertext: locator.published.ciphertext,
          resticVersion: "0.19.1",
          repositoryId: locator.restic.repositoryId,
          verification: "destination_ciphertext_readback",
          boundary: {
            mode: "independent_backup",
            readiness: "remote_repository_verified",
            backend: "rclone_dropbox_v1",
            remoteName: "kithmind_dropbox",
            rootPath: "Kith Mind Backups/Processing",
            rootDirectoryIdHash: hash("a"),
            configIdentityFingerprint: hash("b"),
            repositoryId: locator.restic.repositoryId,
            resticVersion: "0.19.1",
            rcloneVersion: "v1.74.4",
          },
        };
        locator.readbackVerifiedAt = 23;
      },
    });
    const expectedRevision = row.rowRevision;
    const cloud = {
      sourceItemId: "source_item",
      sourceRevisionId: "source_revision",
      primaryReceiptId: row.copies.primary.cloudReceipt.receiptId,
      providerReferenceId: "provider_reference",
      providerBindingEpoch: 0,
      admittedAt: 24,
    };
    const admitted = await f.catalog.recordOriginalCloud({
      catalogId: row.originalCatalogId,
      expectedRevision,
      cloud,
    });
    assert.equal(admitted.cloud.providerBindingEpoch, 0);
    assert.deepEqual(
      await f.catalog.recordOriginalCloud({
        catalogId: row.originalCatalogId,
        expectedRevision,
        cloud,
      }),
      admitted,
    );
    for (const providerBindingEpoch of [-1, 0.5]) {
      await assert.rejects(
        () =>
          f.catalog.recordOriginalCloud({
            catalogId: row.originalCatalogId,
            expectedRevision: admitted.rowRevision,
            cloud: { ...cloud, providerBindingEpoch },
          }),
        (error) =>
          error instanceof ArchiveCatalogError &&
          error.code === "catalog_invalid",
      );
    }
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("persists archive preparation intent before encryption result", async () => {
  const f = await setup();
  let journal = f.journal;
  try {
    const row = await f.catalog.createOriginalIntent(original());
    await assert.rejects(
      () =>
        f.catalog.recordArchivePrepared({
          subject: "original_bytes",
          catalogId: row.originalCatalogId,
          expectedRevision: row.rowRevision,
          role: "primary",
          prepared: {
            state: "prepared",
            tempName: `${row.copies.primary.archiveObjectId}.tmp`,
            source: {
              sha256: row.origin.sha256,
              byteLength: row.origin.byteLength,
            },
            ciphertext: { sha256: hash("f"), byteLength: 200 },
            ciphertextDevice: 1,
            ciphertextInode: 2,
            archiveDirectoryDevice: 1,
            archiveDirectoryInode: 3,
            ageVersion: "v1.3.2",
          },
        }),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "catalog_conflict",
    );
    const intended = await f.catalog.recordArchivePreparationIntent({
      subject: "original_bytes",
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      role: "primary",
      tempName: `${row.copies.primary.archiveObjectId}.tmp`,
    });
    await journal.close();
    journal = await Journal.open({
      directory: f.directory,
      binding: f.authority,
      credential: "km_synthetic_high_entropy_credential",
      initialCheckpoint: { version: 1, phase: "idle" },
      codec,
    });
    const reopened = await openArchiveCatalog({ journal });
    assert.deepEqual(
      reopened.listOriginals()[0].copies.primary.preparationIntent,
      intended.copies.primary.preparationIntent,
    );
    await assert.rejects(
      () =>
        reopened.recordArchivePreparationIntent({
          subject: "original_bytes",
          catalogId: row.originalCatalogId,
          expectedRevision: intended.rowRevision,
          role: "primary",
          tempName: `${randomUUID()}.tmp`,
        }),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "catalog_conflict",
    );
  } finally {
    await journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("requires an exact durable activation before successful cleanup", async () => {
  const f = await setup();
  try {
    const originalRow = await f.catalog.createOriginalIntent(original());
    let row = await f.catalog.createProcessingIntent(
      processing(originalRow.originalCatalogId),
    );
    assert.throws(
      () => f.catalog.requireProcessingActivation(row.processingCatalogId),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "invalid_transition",
    );
    row = await completeProcessingAdmission(f.catalog, row, originalRow);
    assert.throws(
      () => f.catalog.requireProcessingActivation(row.processingCatalogId),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "invalid_transition",
    );
    const activation = {
      requestId: "activation_request",
      requestDigest: hash("3"),
      jobId: row.cloud.ingestJobId,
      processingGenerationId: row.cloud.processingGenerationId,
      state: "ready",
      activatedAt: 50,
      reused: false,
    };
    const activated = await f.catalog.recordActivation({
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      activation,
    });
    assert.deepEqual(
      f.catalog.requireProcessingActivation(row.processingCatalogId),
      activation,
    );
    const replay = await f.catalog.recordActivation({
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      activation,
    });
    assert.equal(replay.rowRevision, activated.rowRevision);
    await assert.rejects(
      () =>
        f.catalog.recordActivation({
          catalogId: row.processingCatalogId,
          expectedRevision: activated.rowRevision,
          activation: { ...activation, processingGenerationId: "generation_2" },
        }),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "catalog_conflict",
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("binds forget deletion targets and results to the exact epoch", async () => {
  const f = await setup();
  try {
    const originalRow = await f.catalog.createOriginalIntent(original());
    let row = await f.catalog.createProcessingIntent(
      processing(originalRow.originalCatalogId),
    );
    row = await completeProcessingAdmission(f.catalog, row, originalRow);
    await assert.rejects(
      () =>
        f.catalog.planDeletion({
          subject: "parser_output",
          catalogId: row.processingCatalogId,
          expectedRevision: row.rowRevision,
          role: "primary",
          deletionId: randomUUID(),
          reason: "forget",
          plannedAt: 50,
        }),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "catalog_invalid",
    );
    await assert.rejects(
      () =>
        f.catalog.planDeletion({
          subject: "parser_output",
          catalogId: row.processingCatalogId,
          expectedRevision: row.rowRevision,
          role: "primary",
          deletionId: randomUUID(),
          reason: "verified_orphan",
          plannedAt: 50,
          forgetEpoch: 7,
        }),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "catalog_invalid",
    );

    const deletionId = randomUUID();
    const serverReceiptDigest = hash("a");
    const planned = await f.catalog.planDeletion({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: row.rowRevision,
      role: "primary",
      deletionId,
      reason: "forget",
      plannedAt: 50,
      forgetEpoch: 7,
      receiptRequestDigest: serverReceiptDigest,
    });
    const bothPlanned = await f.catalog.planDeletion({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: planned.rowRevision,
      role: "independent_backup",
      deletionId: randomUUID(),
      reason: "forget",
      plannedAt: 50,
      forgetEpoch: 7,
    });
    const target = f.catalog.nextDeletionTarget(
      "parser_output",
      row.processingCatalogId,
    );
    assert.deepEqual(target, {
      catalogId: row.processingCatalogId,
      subject: "parser_output",
      role: "primary",
      expectedRowRevision: bothPlanned.rowRevision,
      deletionId,
      reason: "forget",
      forgetEpoch: 7,
      clientReceiptId: planned.copies.primary.clientReceiptId,
      archiveIdentityFingerprint:
        planned.copies.primary.archiveIdentityFingerprint,
      archiveObjectId: planned.copies.primary.archiveObjectId,
      objectName: planned.copies.primary.objectName,
      ciphertextSha256: planned.copies.primary.published.ciphertext.sha256,
      ciphertextByteLength:
        planned.copies.primary.published.ciphertext.byteLength,
      ciphertextDevice: planned.copies.primary.published.ciphertextDevice,
      ciphertextInode: planned.copies.primary.published.ciphertextInode,
      archiveDirectoryDevice:
        planned.copies.primary.prepared.archiveDirectoryDevice,
      archiveDirectoryInode:
        planned.copies.primary.prepared.archiveDirectoryInode,
      cloudReceiptId: planned.copies.primary.cloudReceipt.receiptId,
      receiptRequestDigest: serverReceiptDigest,
    });
    await assert.rejects(
      () =>
        f.catalog.recordDeletionResult({
          subject: "parser_output",
          catalogId: row.processingCatalogId,
          expectedRevision: bothPlanned.rowRevision,
          role: "primary",
          deletionId,
          forgetEpoch: 8,
          completedAt: 60,
          object: "deleted",
        }),
      (error) =>
        error instanceof ArchiveCatalogError &&
        error.code === "catalog_conflict",
    );
    const completed = await f.catalog.recordDeletionResult({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: bothPlanned.rowRevision,
      role: "primary",
      deletionId,
      forgetEpoch: 7,
      completedAt: 60,
      object: "deleted",
    });
    const replay = await f.catalog.recordDeletionResult({
      subject: "parser_output",
      catalogId: row.processingCatalogId,
      expectedRevision: bothPlanned.rowRevision,
      role: "primary",
      deletionId,
      forgetEpoch: 7,
      completedAt: 60,
      object: "deleted",
    });
    assert.equal(replay.rowRevision, completed.rowRevision);
    assert.equal(
      f.catalog.nextDeletionTarget("parser_output", row.processingCatalogId)
        ?.role,
      "independent_backup",
    );
  } finally {
    await f.journal.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
