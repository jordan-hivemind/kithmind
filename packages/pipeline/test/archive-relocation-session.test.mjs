import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  access,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openArchiveCatalog } from "../dist/archiveCatalog.js";
import {
  fingerprintLegacyDatabaseBackupReceipt,
  relocationIntentFromRecipe,
} from "../dist/archiveRelocationRecipe.js";
import {
  prepareRecipeArchiveRelocationSession,
  resumeRecipeArchiveRelocationSession,
} from "../dist/archiveRelocationRecipeSession.js";
import { prepareArchiveRelocationRebind } from "../dist/archiveRelocationRebind.js";
import {
  ArchiveRelocationSession,
  ArchiveRelocationSessionError,
  ProtectedArchiveRelocationStore,
} from "../dist/archiveRelocationSession.js";
import { ArchiveRelocationWorkflow } from "../dist/archiveRelocationWorkflow.js";
import { journalBindingForConfig, parseConfig } from "../dist/config.js";
import {
  Journal,
  JournalCredentialChangedError,
  JournalLockedError,
  JournalSafetyError,
} from "../dist/journal.js";
import { PDF_DOCQA_CHUNKING_FINGERPRINT } from "../dist/parsedBundleMapping.js";

const codec = {
  parseCheckpoint(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.version !== 1 ||
      typeof value.phase !== "string"
    )
      throw new Error("bad checkpoint");
    return { version: 1, phase: value.phase };
  },
  parseResult(_operation, value) {
    return value;
  },
};

function config(base, rootPath, identity) {
  const digest = "a".repeat(64);
  const archiveIdentity = {
    archiveProfileFingerprint: digest,
    archiveIdentityFingerprint: digest,
    recipientFingerprint: digest,
    repositoryKeyDomainFingerprint: digest,
    storageFailureDomainFingerprint: digest,
  };
  return parseConfig({
    protocolVersion: 1,
    endpoint: "https://worker.example/api/worker",
    spaceId: identity.spaceId,
    sourceAccountId: identity.sourceAccountId,
    credentialEnv: "PIPELINE_TOKEN",
    roots: [{ alias: "notes", path: join(base, "source") }],
    journalDir: join(base, "journal"),
    pdfDocQa: {
      captureDirectory: join(base, "captures"),
      parserOutputRoot: join(base, "outputs"),
      spoolDirectory: join(base, "spool"),
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
          ...archiveIdentity,
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
            configIdentityFingerprint: "b".repeat(64),
            expectedRootDirectoryIdHash: "c".repeat(64),
          },
          expectedRepositoryId: "d".repeat(64),
          passwordCommand: {
            executable: "/tools/password",
            publicArgs: ["selector"],
          },
          host: "worker_host",
          ...archiveIdentity,
        },
      },
    },
  });
}

function remoteBoundary(rootPath) {
  return {
    mode: "independent_backup",
    readiness: "remote_repository_verified",
    backend: "rclone_dropbox_v1",
    remoteName: "test_dropbox",
    rootPath,
    rootDirectoryIdHash: "c".repeat(64),
    configIdentityFingerprint: "b".repeat(64),
    repositoryId: "d".repeat(64),
    resticVersion: "0.19.1",
    rcloneVersion: "v1.74.4",
  };
}

async function fixture(t, options = { recordMapping: true }) {
  const base = await mkdtemp(join(homedir(), ".kithmind-session-test-"));
  await chmod(base, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));
  const identity = {
    spaceId: `space_${randomUUID()}`,
    sourceAccountId: `source_${randomUUID()}`,
  };
  const previous = config(
    base,
    "Kith Mind Backups/processing-artifacts/restic-v1",
    identity,
  );
  const proposed = config(
    base,
    "Kith Mind/backups/processing-artifacts/restic-v1",
    identity,
  );
  const configPath = join(base, "pipeline.json");
  const proposedConfigPath = join(base, "proposed.json");
  await writeFile(configPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
  await writeFile(proposedConfigPath, `${JSON.stringify(proposed)}\n`, {
    mode: 0o600,
  });
  const journal = await Journal.open({
    directory: previous.journalDir,
    binding: journalBindingForConfig(previous),
    credential: "credential",
    initialCheckpoint: { version: 1, phase: "idle" },
    codec,
  });
  const catalog = await openArchiveCatalog({ journal });
  const archiveObjectId = randomUUID();
  const primaryArchiveObjectId = randomUUID();
  const original = await catalog.createOriginalIntent({
    originalCatalogId: randomUUID(),
    sourceExternalId: randomUUID(),
    origin: {
      scanId: "scan_1",
      observationEpoch: 1,
      sha256: "1".repeat(64),
      byteLength: 100,
      mediaType: "application/pdf",
    },
    copies: {
      primary: {
        role: "primary",
        clientReceiptId: randomUUID(),
        archiveObjectId: primaryArchiveObjectId,
        objectName: `${primaryArchiveObjectId}.age`,
        archiveIdentityFingerprint: "3".repeat(64),
        archiveProfileFingerprint: "3".repeat(64),
        recipientFingerprint: "3".repeat(64),
        repositoryKeyDomainFingerprint: "3".repeat(64),
        storageFailureDomainFingerprint: "3".repeat(64),
      },
      independent_backup: {
        role: "independent_backup",
        clientReceiptId: randomUUID(),
        archiveObjectId,
        objectName: `${archiveObjectId}.age`,
        archiveIdentityFingerprint: "2".repeat(64),
        archiveProfileFingerprint: "2".repeat(64),
        recipientFingerprint: "2".repeat(64),
        repositoryKeyDomainFingerprint: "2".repeat(64),
        storageFailureDomainFingerprint: "2".repeat(64),
        restic: {
          operationId: randomUUID(),
          host: "worker_host",
          repositoryId: "d".repeat(64),
        },
      },
    },
    createdAt: 1,
  });
  let row = await catalog.recordArchivePreparationIntent({
    subject: "original_bytes",
    catalogId: original.originalCatalogId,
    expectedRevision: original.rowRevision,
    role: "independent_backup",
    tempName: `${archiveObjectId}.tmp`,
  });
  const ciphertext = { sha256: "f".repeat(64), byteLength: 10 };
  row = await catalog.recordArchivePrepared({
    subject: "original_bytes",
    catalogId: row.originalCatalogId,
    expectedRevision: row.rowRevision,
    role: "independent_backup",
    prepared: {
      state: "prepared",
      tempName: row.copies.independent_backup.preparationIntent.tempName,
      source: { sha256: row.origin.sha256, byteLength: 100 },
      ciphertext,
      ciphertextDevice: 10,
      ciphertextInode: 11,
      archiveDirectoryDevice: 10,
      archiveDirectoryInode: 12,
      ageVersion: "v1.3.2",
    },
  });
  row = await catalog.recordArchivePublished({
    subject: "original_bytes",
    catalogId: row.originalCatalogId,
    expectedRevision: row.rowRevision,
    role: "independent_backup",
    published: {
      state: "published",
      source: row.copies.independent_backup.prepared.source,
      ciphertext,
      ciphertextDevice: 10,
      ciphertextInode: 11,
      ageVersion: "v1.3.2",
    },
  });
  row = await catalog.recordResticBackup({
    subject: "original_bytes",
    catalogId: row.originalCatalogId,
    expectedRevision: row.rowRevision,
    role: "independent_backup",
    backup: {
      operationId: row.copies.independent_backup.restic.operationId,
      snapshotId: "e".repeat(64),
      objectName: row.copies.independent_backup.objectName,
      ciphertext,
      resticVersion: "0.19.1",
      repositoryId: "d".repeat(64),
      verification: "destination_ciphertext_readback",
      boundary: remoteBoundary(
        previous.pdfDocQa.archive.independentBackup.repository.rootPath,
      ),
    },
    readbackVerifiedAt: 5,
  });
  const catalogRelocationId = randomUUID();
  const mapping = {
    relocationId: catalogRelocationId,
    oldBoundary: remoteBoundary(
      previous.pdfDocQa.archive.independentBackup.repository.rootPath,
    ),
    newBoundary: remoteBoundary(
      proposed.pdfDocQa.archive.independentBackup.repository.rootPath,
    ),
    artifacts: [
      {
        snapshotId: "e".repeat(64),
        objectName: row.copies.independent_backup.objectName,
        ciphertextSha256: ciphertext.sha256,
        ciphertextByteLength: ciphertext.byteLength,
      },
    ],
    verifiedAt: 10,
  };
  if (options.recordMapping) await catalog.recordBoundaryRelocation(mapping);
  return {
    base,
    previous,
    proposed,
    configPath,
    proposedConfigPath,
    journal,
    catalog,
    archivedOriginal: row,
    mapping,
    workflowRelocationId: randomUUID(),
  };
}

function preparedState(relocationId) {
  return {
    version: 1,
    phase: "prepared",
    intent: {
      relocationId,
      sourceId: "source-folder",
      sourceParentId: "old-parent",
      destinationParentId: "new-parent",
      destinationName: "backups",
      oldBoundary: { rootPath: "/Kith Mind Backups", rootId: "source-folder" },
      newRootPath: "/Kith Mind/backups",
    },
  };
}

function databaseBoundary(rootPath) {
  return {
    ...remoteBoundary(rootPath),
    rootDirectoryIdHash: "f".repeat(64),
    repositoryId: "9".repeat(64),
  };
}

function recipeDraft(f) {
  const receipt = {
    kind: "native_database_backup_receipt_v1",
    status: "passed",
    repositoryId: "9".repeat(64),
    rootDirectoryIdHash: "f".repeat(64),
    snapshotId: "8".repeat(64),
    snapshotTag: "synthetic-native",
    objectPath: "/database/synthetic.age",
    ciphertextHash: "7".repeat(64),
    ciphertextByteLength: 1_000,
    payloadHash: "6".repeat(64),
    nativeZipHash: "5".repeat(64),
    remoteReadback: true,
    exactDecryption: true,
    schemaRestore: "Historical synthetic result",
    sourcePDFsCopied: false,
  };
  const receiptFingerprint = fingerprintLegacyDatabaseBackupReceipt(receipt);
  const copy = f.archivedOriginal.copies.independent_backup;
  const artifact = {
    snapshotId: copy.backup.snapshotId,
    objectName: copy.backup.objectName,
    ciphertextSha256: copy.backup.ciphertext.sha256,
    ciphertextByteLength: copy.backup.ciphertext.byteLength,
  };
  const previousConfigText = `${JSON.stringify(f.previous)}\n`;
  const proposedConfigText = `${JSON.stringify(f.proposed)}\n`;
  return {
    version: 1,
    wholeRoot: {
      sourceId: "source-folder",
      sourceParentId: "old-parent",
      destinationParentId: "new-parent",
      destinationName: "backups",
      oldBoundary: {
        rootPath: "/Kith Mind Backups",
        rootId: "source-folder",
      },
      newRootPath: "/Kith Mind/backups",
    },
    processing: {
      repositoryRelativePath: "processing-artifacts/restic-v1",
      oldBoundary: remoteBoundary(
        f.previous.pdfDocQa.archive.independentBackup.repository.rootPath,
      ),
      newBoundary: remoteBoundary(
        f.proposed.pdfDocQa.archive.independentBackup.repository.rootPath,
      ),
      artifacts: [artifact],
      artifactBindings: [
        {
          kind: "original_backup",
          catalogId: f.archivedOriginal.originalCatalogId,
          ...artifact,
          plaintextSha256: copy.published.source.sha256,
          plaintextByteLength: copy.published.source.byteLength,
        },
      ],
    },
    database: {
      repositoryRelativePath: "database/restic-v1",
      oldBoundary: databaseBoundary("Kith Mind Backups/database/restic-v1"),
      newBoundary: databaseBoundary("Kith Mind/backups/database/restic-v1"),
      receipts: [{ receiptFingerprint, receipt }],
      selectedNativeRestoreReceiptFingerprint: receiptFingerprint,
    },
    localBindings: {
      previousConfigPath: f.configPath,
      proposedConfigPath: f.proposedConfigPath,
      previousConfigText,
      proposedConfigText,
      previousConfigSha256: createHash("sha256")
        .update(previousConfigText)
        .digest("hex"),
      proposedConfigSha256: createHash("sha256")
        .update(proposedConfigText)
        .digest("hex"),
      databaseReceiptPaths: [
        { receiptFingerprint, path: join(f.base, "database-receipt.json") },
      ],
      credentialReferenceFingerprint: "4".repeat(64),
    },
  };
}

test("recipe-aware preparation persists identity before workflow state", async (t) => {
  const f = await fixture(t, { recordMapping: false });
  await f.journal.close();
  const recipeDirectory = join(f.base, "recipes");
  await mkdir(recipeDirectory, { mode: 0o700 });
  const prepared = await prepareRecipeArchiveRelocationSession({
    draft: recipeDraft(f),
    recipeDirectory,
    credential: "credential",
    codec,
  });
  try {
    assert.equal(await prepared.session.store.read(), undefined);
    assert.deepEqual(
      JSON.parse(await readFile(prepared.recipePath, "utf8")),
      prepared.recipe,
    );
  } finally {
    await prepared.session.close();
  }
});

test("recipe-aware preparation rejects changed protected config bytes", async (t) => {
  const f = await fixture(t, { recordMapping: false });
  await f.journal.close();
  const recipeDirectory = join(f.base, "recipes");
  await mkdir(recipeDirectory, { mode: 0o700 });
  await writeFile(f.configPath, `${JSON.stringify(f.proposed)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    prepareRecipeArchiveRelocationSession({
      draft: recipeDraft(f),
      recipeDirectory,
      credential: "credential",
      codec,
    }),
    /config_conflict/,
  );
  assert.deepEqual(await readdir(recipeDirectory), []);
});

test("recipe-aware resume rejects a stale pre-move catalog", async (t) => {
  const f = await fixture(t, { recordMapping: false });
  await f.journal.close();
  const recipeDirectory = join(f.base, "recipes");
  await mkdir(recipeDirectory, { mode: 0o700 });
  const prepared = await prepareRecipeArchiveRelocationSession({
    draft: recipeDraft(f),
    recipeDirectory,
    credential: "credential",
    codec,
  });
  await prepared.session.store.write(
    preparedState(prepared.recipe.workflowRelocationId),
  );
  const original = prepared.session.catalog.listOriginals()[0];
  await prepared.session.catalog.recordArchivePreparationIntent({
    subject: "original_bytes",
    catalogId: original.originalCatalogId,
    expectedRevision: original.rowRevision,
    role: "primary",
    tempName: `${original.copies.primary.archiveObjectId}.tmp`,
  });
  await prepared.session.close();
  await assert.rejects(
    resumeRecipeArchiveRelocationSession({
      recipeDirectory,
      workflowRelocationId: prepared.recipe.workflowRelocationId,
      expectedRecipeHash: prepared.recipe.recipeHash,
      credential: "credential",
      codec,
    }),
    /baseline_changed/,
  );
});

test("recipe-aware resume rejects changed workflow intent before recovery", async (t) => {
  const f = await fixture(t, { recordMapping: false });
  await f.journal.close();
  const recipeDirectory = join(f.base, "recipes");
  await mkdir(recipeDirectory, { mode: 0o700 });
  const prepared = await prepareRecipeArchiveRelocationSession({
    draft: recipeDraft(f),
    recipeDirectory,
    credential: "credential",
    codec,
  });
  const changed = preparedState(prepared.recipe.workflowRelocationId);
  changed.intent.sourceParentId = "different-parent";
  await prepared.session.store.write(changed);
  await prepared.session.close();
  await assert.rejects(
    resumeRecipeArchiveRelocationSession({
      recipeDirectory,
      workflowRelocationId: prepared.recipe.workflowRelocationId,
      expectedRecipeHash: prepared.recipe.recipeHash,
      credential: "credential",
      codec,
    }),
    /phase_conflict/,
  );
});

test("recipe-aware resume accepts exact verified mapping and paired rebind", async (t) => {
  const f = await fixture(t, { recordMapping: false });
  await f.journal.close();
  const recipeDirectory = join(f.base, "recipes");
  await mkdir(recipeDirectory, { mode: 0o700 });
  const prepared = await prepareRecipeArchiveRelocationSession({
    draft: recipeDraft(f),
    recipeDirectory,
    credential: "credential",
    codec,
  });
  const verifiedAt = 50;
  const intent = relocationIntentFromRecipe(prepared.recipe);
  await prepared.session.store.write({
    version: 1,
    phase: "verified",
    intent,
    preMoveVerifiedAt: 20,
    preMoveVerifiedArtifacts: prepared.recipe.body.processing.artifacts,
    destinationId: intent.sourceId,
    newBoundary: {
      rootPath: intent.newRootPath,
      rootId: intent.sourceId,
    },
    movedAt: 30,
    verifiedAt,
    verifiedArtifacts: prepared.recipe.body.processing.artifacts,
  });
  await prepared.session.catalog.recordBoundaryRelocation({
    relocationId: prepared.recipe.catalogRelocationId,
    oldBoundary: prepared.recipe.body.processing.oldBoundary,
    newBoundary: prepared.recipe.body.processing.newBoundary,
    artifacts: prepared.recipe.body.processing.artifacts,
    verifiedAt,
  });
  await prepared.session.close();
  const resumed = await resumeRecipeArchiveRelocationSession({
    recipeDirectory,
    workflowRelocationId: prepared.recipe.workflowRelocationId,
    expectedRecipeHash: prepared.recipe.recipeHash,
    credential: "credential",
    codec,
  });
  try {
    assert.equal(resumed.state.phase, "verified");
    assert.equal(
      (
        await resumed.session.journal.archiveRelocationRebindStatus({
          previousConfig: f.previous,
          proposedConfig: f.proposed,
        })
      ).state,
      "proposed",
    );
    assert.equal(
      await readFile(f.configPath, "utf8"),
      `${JSON.stringify(f.proposed)}\n`,
    );
  } finally {
    await resumed.session.close();
  }
});

test("recipe-aware resume will not repair a premature later-phase rebind", async (t) => {
  const f = await fixture(t, { recordMapping: false });
  await f.journal.close();
  const recipeDirectory = join(f.base, "recipes");
  await mkdir(recipeDirectory, { mode: 0o700 });
  const prepared = await prepareRecipeArchiveRelocationSession({
    draft: recipeDraft(f),
    recipeDirectory,
    credential: "credential",
    codec,
  });
  const verifiedAt = 50;
  const intent = relocationIntentFromRecipe(prepared.recipe);
  await prepared.session.store.write({
    version: 1,
    phase: "rebound",
    intent,
    preMoveVerifiedAt: 20,
    preMoveVerifiedArtifacts: prepared.recipe.body.processing.artifacts,
    destinationId: intent.sourceId,
    newBoundary: {
      rootPath: intent.newRootPath,
      rootId: intent.sourceId,
    },
    movedAt: 30,
    verifiedAt,
    verifiedArtifacts: prepared.recipe.body.processing.artifacts,
  });
  await prepared.session.catalog.recordBoundaryRelocation({
    relocationId: prepared.recipe.catalogRelocationId,
    oldBoundary: prepared.recipe.body.processing.oldBoundary,
    newBoundary: prepared.recipe.body.processing.newBoundary,
    artifacts: prepared.recipe.body.processing.artifacts,
    verifiedAt,
  });
  await prepared.session.close();
  await assert.rejects(
    resumeRecipeArchiveRelocationSession({
      recipeDirectory,
      workflowRelocationId: prepared.recipe.workflowRelocationId,
      expectedRecipeHash: prepared.recipe.recipeHash,
      credential: "credential",
      codec,
    }),
    /phase_conflict/,
  );
  assert.equal(
    await readFile(f.configPath, "utf8"),
    `${JSON.stringify(f.previous)}\n`,
  );
});

test("protected store persists with CAS and recovers only its exact next transition", async (t) => {
  const f = await fixture(t);
  const path = join(
    f.previous.journalDir,
    `archive-relocation-${f.workflowRelocationId}.json`,
  );
  const store = await ProtectedArchiveRelocationStore.open({
    path,
    relocationId: f.workflowRelocationId,
    journal: f.journal,
  });
  assert.equal(await store.read(), undefined);
  const first = preparedState(f.workflowRelocationId);
  await store.write(first);
  assert.deepEqual(await store.read(), first);

  const savedText = await readFile(path, "utf8");
  const saved = JSON.parse(savedText);
  const next = {
    ...saved,
    revision: 2,
    previousFileSha256: (await import("node:crypto"))
      .createHash("sha256")
      .update(savedText)
      .digest("hex"),
    state: {
      ...first,
      phase: "source_verified",
      preMoveVerifiedAt: 10,
      preMoveVerifiedArtifacts: [
        {
          snapshotId: "a".repeat(64),
          objectName: "state-object.age",
          ciphertextSha256: "b".repeat(64),
          ciphertextByteLength: 10,
        },
      ],
    },
  };
  const temp = `${path}.${f.workflowRelocationId}.tmp`;
  await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  const recovered = await ProtectedArchiveRelocationStore.open({
    path,
    relocationId: f.workflowRelocationId,
    journal: f.journal,
  });
  assert.equal((await recovered.read()).phase, "source_verified");

  const conflicting = {
    ...next,
    revision: 3,
    previousFileSha256: "0".repeat(64),
    state: { ...next.state, phase: "move_requested" },
  };
  await writeFile(temp, `${JSON.stringify(conflicting)}\n`, { mode: 0o600 });
  await assert.rejects(
    ProtectedArchiveRelocationStore.open({
      path,
      relocationId: f.workflowRelocationId,
      journal: f.journal,
    }),
    (error) =>
      error instanceof ArchiveRelocationSessionError &&
      error.code === "store_conflict",
  );
  await access(temp);
  await rm(temp);

  const currentText = await readFile(path, "utf8");
  const malformed = {
    ...next,
    revision: 3,
    previousFileSha256: (await import("node:crypto"))
      .createHash("sha256")
      .update(currentText)
      .digest("hex"),
    state: { ...first, phase: "moved" },
  };
  await writeFile(temp, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
  await assert.rejects(
    ProtectedArchiveRelocationStore.open({
      path,
      relocationId: f.workflowRelocationId,
      journal: f.journal,
    }),
    (error) =>
      error instanceof ArchiveRelocationSessionError &&
      error.code === "invalid_input",
  );
  await access(temp);
  await rm(temp);

  await chmod(f.previous.journalDir, 0o770);
  await assert.rejects(
    recovered.read(),
    (error) =>
      error instanceof ArchiveRelocationSessionError &&
      error.code === "unsafe_store",
  );
  await chmod(f.previous.journalDir, 0o700);

  await recovered.read();
  await writeFile(path, `${JSON.stringify({ changed: true })}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    recovered.write(first),
    (error) =>
      error instanceof ArchiveRelocationSessionError &&
      error.code === "store_conflict",
  );
  await f.journal.close();
  await assert.rejects(recovered.read(), JournalSafetyError);
});

test("session never initializes an absent journal and rejects non-idle or wrong-credential state", async (t) => {
  const base = await mkdtemp(join(homedir(), ".kithmind-session-open-test-"));
  await chmod(base, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));
  const identity = {
    spaceId: `space_${randomUUID()}`,
    sourceAccountId: `source_${randomUUID()}`,
  };
  const previous = config(base, "Old/processing-artifacts/restic-v1", identity);
  const proposed = config(base, "New/processing-artifacts/restic-v1", identity);
  const workflowRelocationId = randomUUID();
  const common = {
    previousConfig: previous,
    proposedConfig: proposed,
    configPath: join(base, "pipeline.json"),
    proposedConfigPath: join(base, "proposed.json"),
    intentPath: join(previous.journalDir, "archive-rebind-intent.json"),
    statePath: join(
      previous.journalDir,
      `archive-relocation-${workflowRelocationId}.json`,
    ),
    workflowRelocationId,
    catalogRelocationId: randomUUID(),
    repositoryRelativePath: "processing-artifacts/restic-v1",
    credential: "credential",
    codec,
  };
  await assert.rejects(
    ArchiveRelocationSession.open(common),
    JournalSafetyError,
  );

  const journal = await Journal.open({
    directory: previous.journalDir,
    binding: journalBindingForConfig(previous),
    credential: "credential",
    initialCheckpoint: { version: 1, phase: "idle" },
    codec,
  });
  await journal.transitionCheckpoint({
    checkpoint: { version: 1, phase: "scanned" },
    credentialSessionActive: false,
  });
  await journal.close();
  await assert.rejects(
    ArchiveRelocationSession.open(common),
    JournalSafetyError,
  );

  const idleBase = await mkdtemp(
    join(homedir(), ".kithmind-session-credential-test-"),
  );
  await chmod(idleBase, 0o700);
  t.after(() => rm(idleBase, { recursive: true, force: true }));
  const idlePrevious = config(
    idleBase,
    "Old/processing-artifacts/restic-v1",
    identity,
  );
  const idleProposed = config(
    idleBase,
    "New/processing-artifacts/restic-v1",
    identity,
  );
  const idle = await Journal.open({
    directory: idlePrevious.journalDir,
    binding: journalBindingForConfig(idlePrevious),
    credential: "credential",
    initialCheckpoint: { version: 1, phase: "idle" },
    codec,
  });
  await idle.close();
  await assert.rejects(
    ArchiveRelocationSession.open({
      ...common,
      previousConfig: idlePrevious,
      proposedConfig: idleProposed,
      configPath: join(idleBase, "pipeline.json"),
      proposedConfigPath: join(idleBase, "proposed.json"),
      intentPath: join(idlePrevious.journalDir, "archive-rebind-intent.json"),
      statePath: join(
        idlePrevious.journalDir,
        `archive-relocation-${common.workflowRelocationId}.json`,
      ),
      credential: "wrong",
    }),
    JournalCredentialChangedError,
  );
});

test("one session holds locks through the complete workflow and journal transfer", async (t) => {
  const f = await fixture(t);
  const oldWatcherId = f.journal.watcherId;
  await f.journal.close();
  const intentPath = join(f.previous.journalDir, "archive-rebind-intent.json");
  const session = await ArchiveRelocationSession.open({
    previousConfig: f.previous,
    proposedConfig: f.proposed,
    configPath: f.configPath,
    proposedConfigPath: f.proposedConfigPath,
    intentPath,
    statePath: join(
      f.previous.journalDir,
      `archive-relocation-${f.workflowRelocationId}.json`,
    ),
    workflowRelocationId: f.workflowRelocationId,
    catalogRelocationId: f.mapping.relocationId,
    repositoryRelativePath: "processing-artifacts/restic-v1",
    credential: "credential",
    codec,
  });
  await assert.rejects(
    Journal.openExistingForArchiveRebind({
      directory: f.previous.journalDir,
      previousConfig: f.previous,
      proposedConfig: f.proposed,
      credential: "credential",
      codec,
    }),
    JournalLockedError,
  );

  let moved = false;
  const artifact = {
    snapshotId: f.mapping.artifacts[0].snapshotId,
    objectName: f.mapping.artifacts[0].objectName,
    ciphertextSha256: f.mapping.artifacts[0].ciphertextSha256,
    ciphertextByteLength: f.mapping.artifacts[0].ciphertextByteLength,
  };
  const folder = (id, parentId, name, path) => ({ id, parentId, name, path });
  const provider = {
    async getFolder(id) {
      if (id === "old-parent")
        return folder(id, "root", "Kith Mind Backups", "/");
      if (id === "new-parent")
        return folder(id, "root", "Kith Mind", "/Kith Mind");
      if (id === "source-folder")
        return moved
          ? folder(id, "new-parent", "backups", "/Kith Mind/backups")
          : folder(id, "old-parent", "Kith Mind Backups", "/Kith Mind Backups");
    },
    async getChild(parentId, name) {
      return moved && parentId === "new-parent" && name === "backups"
        ? folder("source-folder", parentId, name, "/Kith Mind/backups")
        : undefined;
    },
    async moveFolder() {
      moved = true;
      return folder(
        "source-folder",
        "new-parent",
        "backups",
        "/Kith Mind/backups",
      );
    },
  };
  let scanResumed = false;
  const workflow = new ArchiveRelocationWorkflow(
    session.store,
    provider,
    {
      async requireQuiescent() {},
      async verifySourceInventory() {
        return [artifact];
      },
      async verifyRelocatedInventory() {
        return [artifact];
      },
      async rebindRootPath(evidence) {
        await session.rebindRootPath(evidence);
      },
      async resumeUnchangedScan() {
        scanResumed = true;
      },
    },
    () => 20,
  );
  await workflow.prepare(preparedState(f.workflowRelocationId).intent);
  const final = await workflow.resume();
  assert.equal(final.phase, "resumed");
  assert.equal(scanResumed, true);
  assert.notEqual(session.journal.watcherId, oldWatcherId);
  assert.deepEqual(
    session.journal.binding,
    journalBindingForConfig(f.proposed),
  );
  assert.equal(
    JSON.parse(await readFile(f.configPath, "utf8")).pdfDocQa.archive
      .independentBackup.repository.rootPath,
    "Kith Mind/backups/processing-artifacts/restic-v1",
  );
  await assert.rejects(
    Journal.openExistingForArchiveRebind({
      directory: f.previous.journalDir,
      previousConfig: f.previous,
      proposedConfig: f.proposed,
      credential: "credential",
      codec,
    }),
    JournalLockedError,
  );
  await session.close();
  const reopened = await Journal.openExistingForArchiveRebind({
    directory: f.previous.journalDir,
    previousConfig: f.previous,
    proposedConfig: f.proposed,
    credential: "credential",
    codec,
  });
  await reopened.close();
});

test("session rejects a workflow root that does not contain the persisted catalog leaf", async (t) => {
  const f = await fixture(t);
  await f.journal.close();
  const session = await ArchiveRelocationSession.open({
    previousConfig: f.previous,
    proposedConfig: f.proposed,
    configPath: f.configPath,
    proposedConfigPath: f.proposedConfigPath,
    intentPath: join(f.previous.journalDir, "archive-rebind-intent.json"),
    statePath: join(
      f.previous.journalDir,
      `archive-relocation-${f.workflowRelocationId}.json`,
    ),
    workflowRelocationId: f.workflowRelocationId,
    catalogRelocationId: f.mapping.relocationId,
    repositoryRelativePath: "processing-artifacts/restic-v1",
    credential: "credential",
    codec,
  });
  await assert.rejects(
    session.rebindRootPath({
      relocationId: f.workflowRelocationId,
      oldBoundary: { rootPath: "/Wrong", rootId: "source-folder" },
      newBoundary: { rootPath: "/Kith Mind/backups", rootId: "source-folder" },
      movedAt: 10,
      verifiedAt: 20,
      verifiedArtifacts: [],
    }),
    (error) =>
      error instanceof ArchiveRelocationSessionError &&
      error.code === "invalid_input",
  );
  await session.close();
});

test("session recovers config-new journal-old without releasing the held locks", async (t) => {
  const f = await fixture(t);
  const intentPath = join(f.previous.journalDir, "archive-rebind-intent.json");
  await prepareArchiveRelocationRebind({
    journal: f.journal,
    configPath: f.configPath,
    proposedConfigPath: f.proposedConfigPath,
    intentPath,
    relocationId: f.mapping.relocationId,
    now: () => 20,
  });
  const interruptedIntentTemp = `${intentPath}.prepared.tmp`;
  await link(intentPath, interruptedIntentTemp);
  // The durable config rename completed, then the process died before the
  // journal binding transfer. This is the only manually constructed crash
  // point in this test; it is not presented as a process-death test.
  await writeFile(f.configPath, `${JSON.stringify(f.proposed)}\n`, {
    mode: 0o600,
  });
  await f.journal.close();

  const session = await ArchiveRelocationSession.open({
    previousConfig: f.previous,
    proposedConfig: f.proposed,
    configPath: f.configPath,
    proposedConfigPath: f.proposedConfigPath,
    intentPath,
    statePath: join(
      f.previous.journalDir,
      `archive-relocation-${f.workflowRelocationId}.json`,
    ),
    workflowRelocationId: f.workflowRelocationId,
    catalogRelocationId: f.mapping.relocationId,
    repositoryRelativePath: "processing-artifacts/restic-v1",
    credential: "credential",
    codec,
  });
  await session.rebindRootPath({
    relocationId: f.workflowRelocationId,
    oldBoundary: { rootPath: "/Kith Mind Backups", rootId: "source-folder" },
    newBoundary: { rootPath: "/Kith Mind/backups", rootId: "source-folder" },
    movedAt: 10,
    verifiedAt: 20,
    verifiedArtifacts: [],
  });
  assert.deepEqual(
    session.journal.binding,
    journalBindingForConfig(f.proposed),
  );
  await assert.rejects(access(interruptedIntentTemp), { code: "ENOENT" });
  await assert.rejects(
    Journal.openExistingForArchiveRebind({
      directory: f.previous.journalDir,
      previousConfig: f.previous,
      proposedConfig: f.proposed,
      credential: "credential",
      codec,
    }),
    JournalLockedError,
  );
  await session.close();
});
