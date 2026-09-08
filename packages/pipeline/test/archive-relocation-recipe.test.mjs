import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openArchiveCatalog } from "../dist/archiveCatalog.js";
import {
  fingerprintLegacyDatabaseBackupReceipt,
  OWNER_ARCHIVE_RELOCATION_NAMESPACE,
  parseOwnerArchiveRelocationRecipe,
  prepareOwnerArchiveRelocationRecipe,
  relocationIntentFromRecipe,
} from "../dist/archiveRelocationRecipe.js";
import { journalBindingForConfig, parseConfig } from "../dist/config.js";
import { Journal } from "../dist/journal.js";
import { PDF_DOCQA_CHUNKING_FINGERPRINT } from "../dist/parsedBundleMapping.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const digest = (character) => character.repeat(64);
const codec = {
  parseCheckpoint(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.version !== 1 ||
      value.phase !== "idle"
    )
      throw new Error("bad checkpoint");
    return { version: 1, phase: "idle" };
  },
  parseResult(_operation, value) {
    return value;
  },
};

function config(base, rootPath) {
  const identity = {
    archiveProfileFingerprint: digest("1"),
    archiveIdentityFingerprint: digest("2"),
    recipientFingerprint: digest("3"),
    repositoryKeyDomainFingerprint: digest("4"),
    storageFailureDomainFingerprint: digest("5"),
  };
  return parseConfig({
    protocolVersion: 1,
    endpoint: "https://worker.example/api/worker",
    spaceId: `space_${sha(base).slice(0, 16)}`,
    sourceAccountId: `source_${sha(base).slice(0, 16)}`,
    credentialEnv: "PIPELINE_TOKEN",
    roots: [{ alias: "notes", path: join(base, "source") }],
    journalDir: join(base, "journal"),
    pdfDocQa: {
      captureDirectory: join(base, "captures"),
      parserOutputRoot: join(base, "outputs"),
      spoolDirectory: join(base, "spool"),
      parser: {
        pythonExecutable: "/tools/python",
        expectedPythonSha256: digest("6"),
        launcherPath: "/tools/launcher.py",
        expectedLauncherSha256: digest("7"),
        packageRoot: "/tools/package",
        modelAssetsPath: "/tools/models",
        modelLockPath: "/tools/model-lock.json",
        expectedModelLockSha256: digest("8"),
      },
      profile: {
        parserProfileId: "pdf_docqa_v1",
        parserFingerprint: digest("9"),
        extractionConfigurationFingerprint: digest("a"),
        extractorFingerprint: "extractor-v1",
        recordSchemaFingerprint: "records-disabled-v1",
        normalizationFingerprint: "normalization-v1",
        chunkerFingerprint: PDF_DOCQA_CHUNKING_FINGERPRINT,
        correctionRevision: "correction-v1",
      },
      archive: {
        ageBinary: "/tools/age",
        primary: {
          directory: join(base, "primary"),
          recipient: `age1pq1${"q".repeat(40)}`,
          ...identity,
        },
        independentBackup: {
          directory: join(base, "backup"),
          recipient: `age1pq1${"p".repeat(40)}`,
          resticBinary: "/tools/restic",
          repository: {
            kind: "rclone_dropbox_v1",
            remoteName: "test_dropbox",
            rootPath,
            rcloneBinary: "/tools/rclone",
            configPath: "/credentials/rclone.conf",
            configIdentityFingerprint: digest("b"),
            expectedRootDirectoryIdHash: digest("c"),
          },
          expectedRepositoryId: digest("d"),
          passwordCommand: {
            executable: "/tools/password",
            publicArgs: ["selector"],
          },
          host: "worker_host",
          ...identity,
        },
      },
    },
  });
}

function remoteBoundary(rootPath, repositoryId, rootDirectoryIdHash) {
  return {
    mode: "independent_backup",
    readiness: "remote_repository_verified",
    backend: "rclone_dropbox_v1",
    remoteName: "test_dropbox",
    rootPath,
    rootDirectoryIdHash,
    configIdentityFingerprint: digest("b"),
    repositoryId,
    resticVersion: "0.19.1",
    rcloneVersion: "v1.74.4",
  };
}

function receipt(index) {
  return {
    kind: "native_database_backup_receipt_v1",
    status: "passed",
    repositoryId: digest("e"),
    rootDirectoryIdHash: digest("f"),
    snapshotId: index === 1 ? digest("1") : digest("2"),
    snapshotTag: `kithmind-native-${index}`,
    objectPath: `/synthetic/database/snapshot-${index}.age`,
    ciphertextHash: index === 1 ? digest("3") : digest("4"),
    ciphertextByteLength: 1_000 + index,
    payloadHash: index === 1 ? digest("5") : digest("6"),
    nativeZipHash: index === 1 ? digest("7") : digest("8"),
    remoteReadback: true,
    exactDecryption: true,
    schemaRestore: `Historical synthetic restore note ${index}`,
    sourcePDFsCopied: false,
  };
}

async function fixture(t) {
  const base = await mkdtemp(join(homedir(), ".kithmind-recipe-test-"));
  await chmod(base, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const directory of [
    "source",
    "journal",
    "captures",
    "outputs",
    "spool",
    "primary",
    "backup",
  ])
    await mkdir(join(base, directory), { mode: 0o700 });
  const previous = config(
    base,
    "Kith Mind Backups/processing-artifacts/restic-v1",
  );
  const proposed = config(
    base,
    "Kith Mind/backups/processing-artifacts/restic-v1",
  );
  const previousConfigText = `${JSON.stringify(previous)}\n`;
  const proposedConfigText = `${JSON.stringify(proposed)}\n`;
  const journal = await Journal.open({
    directory: previous.journalDir,
    binding: journalBindingForConfig(previous),
    credential: "credential",
    initialCheckpoint: { version: 1, phase: "idle" },
    codec,
  });
  t.after(() => journal.close());
  const catalog = await openArchiveCatalog({ journal });
  const archiveObjectId = randomUUID();
  const primaryArchiveObjectId = randomUUID();
  let original = await catalog.createOriginalIntent({
    originalCatalogId: randomUUID(),
    sourceExternalId: randomUUID(),
    origin: {
      scanId: "scan_1",
      observationEpoch: 1,
      sha256: digest("8"),
      byteLength: 1_500,
      mediaType: "application/pdf",
    },
    copies: {
      primary: {
        role: "primary",
        clientReceiptId: randomUUID(),
        archiveObjectId: primaryArchiveObjectId,
        objectName: `${primaryArchiveObjectId}.age`,
        archiveIdentityFingerprint: digest("3"),
        archiveProfileFingerprint: digest("3"),
        recipientFingerprint: digest("3"),
        repositoryKeyDomainFingerprint: digest("3"),
        storageFailureDomainFingerprint: digest("3"),
      },
      independent_backup: {
        role: "independent_backup",
        clientReceiptId: randomUUID(),
        archiveObjectId,
        objectName: `${archiveObjectId}.age`,
        archiveIdentityFingerprint: digest("2"),
        archiveProfileFingerprint: digest("2"),
        recipientFingerprint: digest("2"),
        repositoryKeyDomainFingerprint: digest("2"),
        storageFailureDomainFingerprint: digest("2"),
        restic: {
          operationId: randomUUID(),
          host: "worker_host",
          repositoryId: digest("d"),
        },
      },
    },
    createdAt: 1,
  });
  original = await catalog.recordArchivePreparationIntent({
    subject: "original_bytes",
    catalogId: original.originalCatalogId,
    expectedRevision: original.rowRevision,
    role: "independent_backup",
    tempName: `${archiveObjectId}.tmp`,
  });
  const ciphertext = { sha256: digest("9"), byteLength: 2_000 };
  original = await catalog.recordArchivePrepared({
    subject: "original_bytes",
    catalogId: original.originalCatalogId,
    expectedRevision: original.rowRevision,
    role: "independent_backup",
    prepared: {
      state: "prepared",
      tempName: original.copies.independent_backup.preparationIntent.tempName,
      source: { sha256: digest("8"), byteLength: 1_500 },
      ciphertext,
      ciphertextDevice: 10,
      ciphertextInode: 11,
      archiveDirectoryDevice: 10,
      archiveDirectoryInode: 12,
      ageVersion: "v1.3.2",
    },
  });
  original = await catalog.recordArchivePublished({
    subject: "original_bytes",
    catalogId: original.originalCatalogId,
    expectedRevision: original.rowRevision,
    role: "independent_backup",
    published: {
      state: "published",
      source: original.copies.independent_backup.prepared.source,
      ciphertext,
      ciphertextDevice: 10,
      ciphertextInode: 11,
      ageVersion: "v1.3.2",
    },
  });
  original = await catalog.recordResticBackup({
    subject: "original_bytes",
    catalogId: original.originalCatalogId,
    expectedRevision: original.rowRevision,
    role: "independent_backup",
    backup: {
      operationId: original.copies.independent_backup.restic.operationId,
      snapshotId: digest("a"),
      objectName: original.copies.independent_backup.objectName,
      ciphertext,
      resticVersion: "0.19.1",
      repositoryId: digest("d"),
      verification: "destination_ciphertext_readback",
      boundary: remoteBoundary(
        previous.pdfDocQa.archive.independentBackup.repository.rootPath,
        digest("d"),
        digest("c"),
      ),
    },
    readbackVerifiedAt: 5,
  });
  const receipts = [receipt(1), receipt(2)].map((value, index) => ({
    receiptFingerprint: fingerprintLegacyDatabaseBackupReceipt(value),
    receipt: value,
    path: join(base, `receipt-${index + 1}.json`),
  }));
  const artifact = {
    snapshotId: digest("a"),
    objectName: original.copies.independent_backup.objectName,
    ciphertextSha256: ciphertext.sha256,
    ciphertextByteLength: ciphertext.byteLength,
  };
  const draft = {
    version: 1,
    wholeRoot: {
      sourceId: "id:legacy-root",
      sourceParentId: "id:root-parent",
      destinationParentId: "id:managed-parent",
      destinationName: "backups",
      oldBoundary: {
        rootPath: "/Kith Mind Backups",
        rootId: "id:legacy-root",
      },
      newRootPath: "/Kith Mind/backups",
    },
    processing: {
      repositoryRelativePath: "processing-artifacts/restic-v1",
      oldBoundary: remoteBoundary(
        "Kith Mind Backups/processing-artifacts/restic-v1",
        digest("d"),
        digest("c"),
      ),
      newBoundary: remoteBoundary(
        "Kith Mind/backups/processing-artifacts/restic-v1",
        digest("d"),
        digest("c"),
      ),
      artifacts: [artifact],
      artifactBindings: [
        {
          kind: "original_backup",
          catalogId: original.originalCatalogId,
          ...artifact,
          plaintextSha256: digest("8"),
          plaintextByteLength: 1_500,
        },
      ],
    },
    database: {
      repositoryRelativePath: "database/restic-v1",
      oldBoundary: remoteBoundary(
        "Kith Mind Backups/database/restic-v1",
        digest("e"),
        digest("f"),
      ),
      newBoundary: remoteBoundary(
        "Kith Mind/backups/database/restic-v1",
        digest("e"),
        digest("f"),
      ),
      receipts: receipts.map(({ path: _path, ...value }) => value),
      selectedNativeRestoreReceiptFingerprint: receipts[1].receiptFingerprint,
    },
    localBindings: {
      previousConfigPath: join(base, "previous.json"),
      proposedConfigPath: join(base, "proposed.json"),
      previousConfigText,
      proposedConfigText,
      previousConfigSha256: sha(previousConfigText),
      proposedConfigSha256: sha(proposedConfigText),
      databaseReceiptPaths: receipts.map(({ receiptFingerprint, path }) => ({
        receiptFingerprint,
        path,
      })),
      credentialReferenceFingerprint: digest("7"),
    },
  };
  return { draft, journal, catalog };
}

async function prepare(f, draft = f.draft) {
  return await prepareOwnerArchiveRelocationRecipe(draft, {
    journal: f.journal,
    catalog: f.catalog,
  });
}

test("held catalog and journal derive a stable complete recipe", async (t) => {
  const f = await fixture(t);
  const created = await prepare(f);
  assert.match(created.recipeHash, /^[a-f0-9]{64}$/);
  for (const value of [
    created.workflowRelocationId,
    created.catalogRelocationId,
    created.watcherResetRequestId,
  ])
    assert.match(
      value,
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  assert.equal(OWNER_ARCHIVE_RELOCATION_NAMESPACE.length, 36);
  assert.ok(created.body.processing.catalogRevision > 0);
  assert.equal(
    created.body.localBindings.previousWatcherId,
    f.journal.watcherId,
  );
  assert.deepEqual(parseOwnerArchiveRelocationRecipe(created), created);
  assert.deepEqual(relocationIntentFromRecipe(created), {
    relocationId: created.workflowRelocationId,
    ...created.body.wholeRoot,
  });

  await f.catalog.recordBoundaryRelocation({
    relocationId: created.catalogRelocationId,
    oldBoundary: created.body.processing.oldBoundary,
    newBoundary: created.body.processing.newBoundary,
    artifacts: created.body.processing.artifacts,
    verifiedAt: 200,
  });
  assert.deepEqual(parseOwnerArchiveRelocationRecipe(created), created);

  const reordered = structuredClone(f.draft);
  reordered.database.receipts.reverse();
  reordered.localBindings.databaseReceiptPaths.reverse();
  await assert.rejects(
    () => prepare(f, reordered),
    /Owner archive relocation recipe failed/,
  );
});

test("exact config bytes and explicit restore selection change recipe identity", async (t) => {
  const f = await fixture(t);
  const first = await prepare(f);
  const changed = structuredClone(f.draft);
  changed.localBindings.previousConfigText = ` ${changed.localBindings.previousConfigText}`;
  changed.localBindings.previousConfigSha256 = sha(
    changed.localBindings.previousConfigText,
  );
  const second = await prepare(f, changed);
  assert.notEqual(first.recipeHash, second.recipeHash);
  assert.notEqual(first.workflowRelocationId, second.workflowRelocationId);

  const selected = structuredClone(f.draft);
  selected.database.selectedNativeRestoreReceiptFingerprint =
    selected.database.receipts[0].receiptFingerprint;
  const third = await prepare(f, selected);
  assert.notEqual(first.workflowRelocationId, third.workflowRelocationId);

  const stale = structuredClone(first);
  stale.body.localBindings.previousConfigText = ` ${stale.body.localBindings.previousConfigText}`;
  assert.throws(
    () => parseOwnerArchiveRelocationRecipe(stale),
    /identity_conflict/,
  );
});

test("historical receipt claims are identity rather than fresh verification", async (t) => {
  const f = await fixture(t);
  const changed = structuredClone(f.draft);
  const receiptValue = changed.database.receipts[0].receipt;
  receiptValue.remoteReadback = false;
  receiptValue.exactDecryption = false;
  receiptValue.sourcePDFsCopied = true;
  receiptValue.schemaRestore =
    "Historical claim only; fresh gates are still required.";
  changed.database.receipts[0].receiptFingerprint =
    fingerprintLegacyDatabaseBackupReceipt(receiptValue);
  changed.localBindings.databaseReceiptPaths[0].receiptFingerprint =
    changed.database.receipts[0].receiptFingerprint;
  const parsed = await prepare(f, changed);
  const retained = parsed.body.database.receipts.find(
    ({ receiptFingerprint }) =>
      receiptFingerprint === changed.database.receipts[0].receiptFingerprint,
  );
  assert.equal(retained.receipt.remoteReadback, false);
});

test("prepare rejects incomplete or conflicting catalog and database identity", async (t) => {
  const f = await fixture(t);
  const cases = [
    (body) => body.processing.artifactBindings.pop(),
    (body) => {
      body.processing.artifactBindings[0].plaintextSha256 = digest("1");
    },
    (body) => {
      body.processing.artifactBindings[0].ciphertextSha256 = digest("1");
      body.processing.artifacts[0].ciphertextSha256 = digest("1");
    },
    (body) => {
      body.processing.newBoundary.repositoryId = digest("1");
    },
    (body) => {
      body.database.newBoundary.rootPath =
        "Kith Mind/backups/elsewhere/restic-v1";
    },
    (body) => {
      body.database.oldBoundary.remoteName = "different_dropbox";
      body.database.newBoundary.remoteName = "different_dropbox";
    },
    (body) => {
      body.database.oldBoundary.configIdentityFingerprint = digest("0");
      body.database.newBoundary.configIdentityFingerprint = digest("0");
    },
    (body) => body.database.receipts.push(body.database.receipts[0]),
    (body) => {
      body.database.selectedNativeRestoreReceiptFingerprint = digest("0");
    },
    (body) => {
      body.database.receipts[0].receipt.objectPath = "/synthetic/../escape.age";
    },
    (body) => {
      body.localBindings.databaseReceiptPaths[1].path =
        body.localBindings.databaseReceiptPaths[0].path;
    },
    (body) => {
      body.extra = true;
    },
  ];
  for (const mutate of cases) {
    const draft = structuredClone(f.draft);
    mutate(draft);
    await assert.rejects(
      () => prepare(f, draft),
      /Owner archive relocation recipe failed/,
    );
  }
});

test("pure resume parsing rejects every derived identity change", async (t) => {
  const f = await fixture(t);
  const recipe = await prepare(f);
  for (const mutate of [
    (value) => (value.recipeHash = digest("0")),
    (value) => (value.workflowRelocationId = randomUUID()),
    (value) => (value.catalogRelocationId = randomUUID()),
    (value) => (value.watcherResetRequestId = randomUUID()),
    (value) =>
      (value.body.localBindings.credentialReferenceFingerprint = digest("1")),
  ]) {
    const changed = structuredClone(recipe);
    mutate(changed);
    assert.throws(
      () => parseOwnerArchiveRelocationRecipe(changed),
      /identity_conflict/,
    );
  }
});
