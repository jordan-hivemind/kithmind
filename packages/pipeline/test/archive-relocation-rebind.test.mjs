import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareArchiveRelocationRebind,
  recoverArchiveRelocationRebind,
  resumeArchiveRelocationRebind,
} from "../dist/archiveRelocationRebind.js";
import { openArchiveCatalog } from "../dist/archiveCatalog.js";
import { journalBindingForConfig, parseConfig } from "../dist/config.js";
import { Journal, JournalSafetyError } from "../dist/journal.js";
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
    return structuredClone(value);
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

function relocation() {
  return {
    relocationId: randomUUID(),
    oldBoundary: {
      mode: "independent_backup",
      readiness: "remote_repository_verified",
      backend: "rclone_dropbox_v1",
      remoteName: "test_dropbox",
      rootPath: "Legacy/backups",
      rootDirectoryIdHash: "c".repeat(64),
      configIdentityFingerprint: "b".repeat(64),
      repositoryId: "d".repeat(64),
      resticVersion: "0.19.1",
      rcloneVersion: "v1.74.4",
    },
    newBoundary: {
      mode: "independent_backup",
      readiness: "remote_repository_verified",
      backend: "rclone_dropbox_v1",
      remoteName: "test_dropbox",
      rootPath: "Managed/backups",
      rootDirectoryIdHash: "c".repeat(64),
      configIdentityFingerprint: "b".repeat(64),
      repositoryId: "d".repeat(64),
      resticVersion: "0.19.1",
      rcloneVersion: "v1.74.4",
    },
    artifacts: [
      {
        snapshotId: "e".repeat(64),
        objectName: "object.age",
        ciphertextSha256: "f".repeat(64),
        ciphertextByteLength: 10,
      },
    ],
    verifiedAt: 10,
  };
}

async function fixture({
  previousRoot = "Legacy/backups",
  proposedRoot = "Managed/backups",
  initialCheckpoint = { version: 1, phase: "idle" },
} = {}) {
  const base = await mkdtemp(join(homedir(), ".kithmind-rebind-test-"));
  await chmod(base, 0o700);
  const identity = {
    spaceId: `space_${randomUUID()}`,
    sourceAccountId: `source_${randomUUID()}`,
  };
  const previous = config(base, previousRoot, identity);
  const proposed = config(base, proposedRoot, identity);
  const configPath = join(base, "pipeline.json");
  const proposedPath = join(base, "proposed.json");
  const intentPath = join(previous.journalDir, "archive-rebind-intent.json");
  await writeFile(configPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
  await writeFile(proposedPath, `${JSON.stringify(proposed)}\n`, {
    mode: 0o600,
  });
  const journal = await Journal.open({
    directory: previous.journalDir,
    binding: journalBindingForConfig(previous),
    credential: "credential",
    initialCheckpoint,
    codec,
  });
  const mapping = relocation();
  const catalog = await openArchiveCatalog({ journal });
  const archiveObjectId = randomUUID();
  const primaryArchiveObjectId = randomUUID();
  let original = await catalog.createOriginalIntent({
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
  original = await catalog.recordArchivePreparationIntent({
    subject: "original_bytes",
    catalogId: original.originalCatalogId,
    expectedRevision: original.rowRevision,
    role: "independent_backup",
    tempName: `${archiveObjectId}.tmp`,
  });
  const ciphertext = { sha256: "f".repeat(64), byteLength: 10 };
  original = await catalog.recordArchivePrepared({
    subject: "original_bytes",
    catalogId: original.originalCatalogId,
    expectedRevision: original.rowRevision,
    role: "independent_backup",
    prepared: {
      state: "prepared",
      tempName: original.copies.independent_backup.preparationIntent.tempName,
      source: { sha256: original.origin.sha256, byteLength: 100 },
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
      snapshotId: "e".repeat(64),
      objectName: original.copies.independent_backup.objectName,
      ciphertext,
      resticVersion: "0.19.1",
      repositoryId: "d".repeat(64),
      verification: "destination_ciphertext_readback",
      boundary: mapping.oldBoundary,
    },
    readbackVerifiedAt: 5,
  });
  mapping.artifacts[0].objectName =
    original.copies.independent_backup.objectName;
  await catalog.recordBoundaryRelocation(mapping);
  const resolved = await catalog.requireBoundaryRelocation(
    mapping.relocationId,
  );
  assert.equal(resolved.catalogRevision, catalog.revision);
  return {
    base,
    previous,
    proposed,
    configPath,
    proposedPath,
    intentPath,
    journal,
    catalog,
    mapping,
  };
}

async function prepare(f) {
  await prepareArchiveRelocationRebind({
    journal: f.journal,
    configPath: f.configPath,
    proposedConfigPath: f.proposedPath,
    intentPath: f.intentPath,
    relocationId: f.mapping.relocationId,
    now: () => 20,
  });
}

test("paired rebind preserves journal state and rotates heartbeat identity", async () => {
  const f = await fixture();
  let journal = f.journal;
  try {
    const before = JSON.parse(
      await readFile(join(f.previous.journalDir, "state.json"), "utf8"),
    );
    await prepare(f);
    const result = await resumeArchiveRelocationRebind({
      journal,
      configPath: f.configPath,
      intentPath: f.intentPath,
    });
    journal = result.journal;
    assert.equal(result.watcherIdentityChanged, true);
    assert.notEqual(result.previousWatcherId, result.currentWatcherId);
    assert.deepEqual(journal.binding, journalBindingForConfig(f.proposed));
    assert.deepEqual(journal.checkpoint, { version: 1, phase: "idle" });
    const after = JSON.parse(
      await readFile(join(f.previous.journalDir, "state.json"), "utf8"),
    );
    assert.equal(after.credentialSalt, before.credentialSalt);
    assert.equal(after.credentialFingerprint, before.credentialFingerprint);
    assert.deepEqual(after.checkpoint, before.checkpoint);
    assert.deepEqual(
      parseConfig(JSON.parse(await readFile(f.configPath, "utf8"))),
      f.proposed,
    );
    assert.throws(() => f.journal.checkpoint, JournalSafetyError);
  } finally {
    await journal.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("paired rebind preserves a quiescent terminal checkpoint", async () => {
  const terminal = {
    version: 1,
    phase: "terminal",
    outcome: "complete",
    credentialSessionActive: false,
    bindings: [
      {
        rootAlias: "notes",
        relativePath: "note.txt",
        sourceExternalId: "source_external_1",
        sourceItemId: "source_item_1",
      },
    ],
    scanned: 1,
    published: 0,
  };
  const f = await fixture({ initialCheckpoint: terminal });
  let journal = f.journal;
  try {
    await prepare(f);
    const result = await resumeArchiveRelocationRebind({
      journal,
      configPath: f.configPath,
      intentPath: f.intentPath,
    });
    journal = result.journal;
    assert.deepEqual(journal.checkpoint, terminal);
    const reopenedCheckpoint = journal.checkpoint;
    await journal.close();
    journal = await Journal.openExistingForArchiveRebind({
      directory: f.proposed.journalDir,
      previousConfig: f.previous,
      proposedConfig: f.proposed,
      credential: "credential",
      codec,
    });
    assert.deepEqual(journal.checkpoint, reopenedCheckpoint);
  } finally {
    await journal.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("recovery completes config-temp and either half-written pair with exact replay", async () => {
  for (const half of ["config_temp", "config", "journal"]) {
    const f = await fixture();
    let journal = f.journal;
    try {
      await prepare(f);
      if (half === "config_temp") {
        await writeFile(
          `${f.configPath}.${f.mapping.relocationId}.rebind.tmp`,
          `${JSON.stringify(f.proposed)}\n`,
          { mode: 0o600 },
        );
      } else if (half === "config") {
        await writeFile(f.configPath, `${JSON.stringify(f.proposed)}\n`, {
          mode: 0o600,
        });
      } else {
        journal = await journal.rebindForArchiveRelocation({
          previousConfig: f.previous,
          proposedConfig: f.proposed,
        });
      }
      const result = await resumeArchiveRelocationRebind({
        journal,
        configPath: f.configPath,
        intentPath: f.intentPath,
      });
      journal = result.journal;
      assert.deepEqual(journal.binding, journalBindingForConfig(f.proposed));
      const replay = await resumeArchiveRelocationRebind({
        journal,
        configPath: f.configPath,
        intentPath: f.intentPath,
      });
      journal = replay.journal;
      assert.equal(replay.currentWatcherId, result.currentWatcherId);
    } finally {
      await journal.close();
      await rm(f.base, { recursive: true, force: true });
    }
  }
});

test("static production recovery reopens the real catalog after either half-write", async () => {
  for (const half of ["config", "journal"]) {
    const f = await fixture();
    let journal = f.journal;
    try {
      await prepare(f);
      if (half === "config") {
        await writeFile(f.configPath, `${JSON.stringify(f.proposed)}\n`, {
          mode: 0o600,
        });
      } else {
        journal = await journal.rebindForArchiveRelocation({
          previousConfig: f.previous,
          proposedConfig: f.proposed,
        });
      }
      await journal.close();
      const recovered = await recoverArchiveRelocationRebind({
        configPath: f.configPath,
        intentPath: f.intentPath,
        credential: "credential",
        codec,
      });
      assert.equal(recovered.state, "rebound");
      assert.equal(recovered.relocationId, f.mapping.relocationId);
      assert.equal(recovered.watcherIdentityChanged, true);
      const reopened = await Journal.open({
        directory: f.proposed.journalDir,
        binding: journalBindingForConfig(f.proposed),
        credential: "credential",
        initialCheckpoint: { version: 1, phase: "idle" },
        codec,
      });
      const catalog = await openArchiveCatalog({ journal: reopened });
      assert.equal(
        (await catalog.requireBoundaryRelocation(f.mapping.relocationId))
          .relocation.relocationId,
        f.mapping.relocationId,
      );
      await reopened.close();
    } finally {
      await journal.close();
      await rm(f.base, { recursive: true, force: true });
    }
  }
});

test("a conflicting exact config temporary is preserved for review", async () => {
  const f = await fixture();
  const temp = `${f.configPath}.${f.mapping.relocationId}.rebind.tmp`;
  try {
    await prepare(f);
    await writeFile(temp, "{}\n", { mode: 0o600 });
    await assert.rejects(
      () =>
        resumeArchiveRelocationRebind({
          journal: f.journal,
          configPath: f.configPath,
          intentPath: f.intentPath,
        }),
      /config_conflict/,
    );
    assert.equal(await readFile(temp, "utf8"), "{}\n");
    assert.deepEqual(
      parseConfig(JSON.parse(await readFile(f.configPath, "utf8"))),
      f.previous,
    );
  } finally {
    await f.journal.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("prepare retry reuses the immutable timestamp and rejects a mapping for another repository", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const before = await readFile(f.intentPath, "utf8");
    await prepareArchiveRelocationRebind({
      journal: f.journal,
      configPath: f.configPath,
      proposedConfigPath: f.proposedPath,
      intentPath: f.intentPath,
      relocationId: f.mapping.relocationId,
      now: () => 999,
    });
    assert.equal(await readFile(f.intentPath, "utf8"), before);
  } finally {
    await f.journal.close();
    await rm(f.base, { recursive: true, force: true });
  }

  const wrong = await fixture({
    previousRoot: "OtherLegacy/backups",
    proposedRoot: "OtherManaged/backups",
  });
  try {
    await assert.rejects(() => prepare(wrong), /catalog_conflict/);
  } finally {
    await wrong.journal.close();
    await rm(wrong.base, { recursive: true, force: true });
  }
});

test("prepare recovers an exact hardlink publication interruption", async () => {
  const f = await fixture();
  const temporary = `${f.intentPath}.prepared.tmp`;
  try {
    await prepare(f);
    await link(f.intentPath, temporary);
    assert.equal((await stat(f.intentPath)).nlink, 2);
    await prepare(f);
    assert.equal((await stat(f.intentPath)).nlink, 1);
    await assert.rejects(() => stat(temporary), { code: "ENOENT" });
  } finally {
    await f.journal.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("rebind rejects non-idle state, changed config, and catalog drift", async () => {
  const nonIdle = await fixture();
  try {
    await nonIdle.journal.transitionCheckpoint({
      checkpoint: { version: 1, phase: "complete" },
      credentialSessionActive: false,
    });
    await assert.rejects(() => prepare(nonIdle), /rebind_failed/);
  } finally {
    await nonIdle.journal.close();
    await rm(nonIdle.base, { recursive: true, force: true });
  }

  const changed = await fixture();
  try {
    await prepare(changed);
    await writeFile(changed.configPath, "{}\n", { mode: 0o600 });
    await assert.rejects(
      () =>
        resumeArchiveRelocationRebind({
          journal: changed.journal,
          configPath: changed.configPath,
          intentPath: changed.intentPath,
        }),
      /config_conflict/,
    );
  } finally {
    await changed.journal.close();
    await rm(changed.base, { recursive: true, force: true });
  }

  const changedJournal = await fixture();
  try {
    await prepare(changedJournal);
    const beforeConfig = await readFile(changedJournal.configPath, "utf8");
    await changedJournal.journal.transitionCheckpoint({
      checkpoint: { version: 1, phase: "complete" },
      credentialSessionActive: false,
    });
    await assert.rejects(
      () =>
        resumeArchiveRelocationRebind({
          journal: changedJournal.journal,
          configPath: changedJournal.configPath,
          intentPath: changedJournal.intentPath,
        }),
      /rebind_failed|journal is unsafe/,
    );
    assert.equal(
      await readFile(changedJournal.configPath, "utf8"),
      beforeConfig,
    );
  } finally {
    await changedJournal.journal.close();
    await rm(changedJournal.base, { recursive: true, force: true });
  }
});

test("a post-write journal readback failure poisons the old instance", async () => {
  const f = await fixture();
  await f.journal.close();
  let parses = 0;
  const failingCodec = {
    ...codec,
    parseCheckpoint(value) {
      parses += 1;
      if (parses === 3) throw new Error("injected readback failure");
      return codec.parseCheckpoint(value);
    },
  };
  const journal = await Journal.open({
    directory: f.previous.journalDir,
    binding: journalBindingForConfig(f.previous),
    credential: "credential",
    initialCheckpoint: { version: 1, phase: "idle" },
    codec: failingCodec,
  });
  try {
    await assert.rejects(
      () =>
        journal.rebindForArchiveRelocation({
          previousConfig: f.previous,
          proposedConfig: f.proposed,
        }),
      JournalSafetyError,
    );
    assert.throws(() => journal.checkpoint, JournalSafetyError);
  } finally {
    await journal.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("post-transfer verification failure releases the transferred locks", async () => {
  const f = await fixture();
  const hidden = `${f.configPath}.hidden`;
  try {
    await prepare(f);
    await assert.rejects(
      () =>
        resumeArchiveRelocationRebind({
          journal: f.journal,
          configPath: f.configPath,
          intentPath: f.intentPath,
          afterJournalTransfer: async () => {
            await writeFile(hidden, await readFile(f.configPath), {
              mode: 0o600,
            });
            await rm(f.configPath);
          },
        }),
      /unsafe_store/,
    );
    await writeFile(f.configPath, await readFile(hidden), { mode: 0o600 });
    const reopened = await Journal.open({
      directory: f.proposed.journalDir,
      binding: journalBindingForConfig(f.proposed),
      credential: "credential",
      initialCheckpoint: { version: 1, phase: "idle" },
      codec,
    });
    await reopened.close();
  } finally {
    await f.journal.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("static recovery never initializes a missing journal", async () => {
  const f = await fixture();
  await f.journal.close();
  await rm(f.previous.journalDir, { recursive: true, force: true });
  await assert.rejects(
    () =>
      Journal.openExistingForArchiveRebind({
        directory: f.previous.journalDir,
        previousConfig: f.previous,
        proposedConfig: f.proposed,
        credential: "credential",
        codec,
      }),
    JournalSafetyError,
  );
  await rm(f.base, { recursive: true, force: true });
});
