// P2-104b. Switching production to a new parser edits `pdfDocQa.parser` paths
// and `pdfDocQa.profile` fingerprints. `journalBindingForConfig` hashes the
// whole `pdfDocQa` block into `configFingerprint`, so that edit produced a
// binding the journal refused, and the journal directory also holds the
// archive catalog, so there was nowhere else to go: the watcher stayed down
// until the old config was restored.
//
// These are the two halves of the transition. The journal must reopen under
// the new configuration, and the catalog must then treat the document as
// needing fresh work without judging its history ambiguous.

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { journalBindingForConfig, parseConfig } from "../dist/config.js";
import { Journal, JournalLockedError } from "../dist/journal.js";
import { PDF_DOCQA_CHUNKING_FINGERPRINT } from "../dist/parsedBundleMapping.js";

const codec = {
  parseCheckpoint: (value) => value,
  parseResult: (_operation, value) => value,
};
const DIGEST = "a".repeat(64);

/**
 * `parser` and `profile` are the only things a parser upgrade changes. Both
 * live under `pdfDocQa`, so both move `configFingerprint`.
 */
function config(base, identity, parser = {}) {
  const archiveIdentity = {
    archiveProfileFingerprint: DIGEST,
    archiveIdentityFingerprint: DIGEST,
    recipientFingerprint: DIGEST,
    repositoryKeyDomainFingerprint: DIGEST,
    storageFailureDomainFingerprint: DIGEST,
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
        pythonExecutable: parser.pythonExecutable ?? "/old/parser/python",
        expectedPythonSha256: parser.expectedPythonSha256 ?? DIGEST,
        launcherPath: parser.launcherPath ?? "/old/parser/launcher.py",
        expectedLauncherSha256: parser.expectedLauncherSha256 ?? DIGEST,
        packageRoot: parser.packageRoot ?? "/old/parser/src",
        modelAssetsPath: parser.modelAssetsPath ?? "/old/parser/models",
        modelLockPath: parser.modelLockPath ?? "/old/parser/lock.json",
        expectedModelLockSha256: parser.expectedModelLockSha256 ?? DIGEST,
      },
      profile: {
        parserProfileId: "pdf_docqa_v1",
        parserFingerprint: parser.parserFingerprint ?? DIGEST,
        extractionConfigurationFingerprint:
          parser.extractionConfigurationFingerprint ?? DIGEST,
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
          repositoryPath: join(base, "restic"),
          expectedRepositoryId: "d".repeat(64),
          passwordCommand: { executable: "/tools/password" },
          host: "worker_host",
          ...archiveIdentity,
        },
      },
    },
  });
}

/** The parser upgrade: new checkout paths and the fingerprints it computes. */
const UPGRADED = {
  pythonExecutable: "/new/parser/python",
  expectedPythonSha256: "b".repeat(64),
  launcherPath: "/new/parser/launcher.py",
  expectedLauncherSha256: "c".repeat(64),
  packageRoot: "/new/parser/src",
  modelAssetsPath: "/new/parser/models",
  modelLockPath: "/new/parser/lock.json",
  expectedModelLockSha256: "e".repeat(64),
  parserFingerprint: "f".repeat(64),
  extractionConfigurationFingerprint: "1".repeat(64),
};

async function fixture(attempt = 0) {
  const base = await mkdtemp(join(homedir(), ".kithmind-parser-rebind-"));
  await chmod(base, 0o700);
  const identity = {
    spaceId: `space_${randomUUID()}`,
    sourceAccountId: `source_${randomUUID()}`,
  };
  const previous = config(base, identity);
  const upgraded = config(base, identity, UPGRADED);
  try {
    const journal = await Journal.open({
      directory: previous.journalDir,
      binding: journalBindingForConfig(previous),
      credential: "km_synthetic_high_entropy_credential",
      initialCheckpoint: { version: 1, phase: "idle" },
      codec,
    });
    return { base, previous, upgraded, journal };
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    // Unrelated authority/path hashes can share bounded local lock ports.
    if (error instanceof JournalLockedError && attempt < 4) {
      return fixture(attempt + 1);
    }
    throw error;
  }
}

test("a parser upgrade moves the config fingerprint but not the worker identity", () => {
  const identity = {
    spaceId: `space_${randomUUID()}`,
    sourceAccountId: `source_${randomUUID()}`,
  };
  const before = journalBindingForConfig(config("/base", identity));
  const after = journalBindingForConfig(config("/base", identity, UPGRADED));
  assert.notEqual(
    before.configFingerprint,
    after.configFingerprint,
    "this is the change that used to lock the journal out",
  );
  for (const field of [
    "endpoint",
    "spaceId",
    "sourceAccountId",
    "credentialSlot",
    "protocolVersion",
  ]) {
    assert.deepEqual(before[field], after[field], field);
  }
});

test("the journal written under the old parser config reopens under the new one", async () => {
  const f = await fixture();
  try {
    await f.journal.transitionCheckpoint({
      checkpoint: { version: 1, phase: "idle", scans: 7 },
      credentialSessionActive: false,
    });
    await f.journal.close();

    const reopened = await Journal.open({
      directory: f.upgraded.journalDir,
      binding: journalBindingForConfig(f.upgraded),
      credential: "km_synthetic_high_entropy_credential",
      initialCheckpoint: { version: 1, phase: "idle" },
      codec,
    });
    try {
      assert.equal(
        reopened.checkpoint.scans,
        7,
        "the journal is continued, not restarted",
      );
      assert.deepEqual(
        reopened.binding,
        journalBindingForConfig(f.upgraded),
        "the new binding is in force",
      );
    } finally {
      await reopened.close();
    }

    const stored = JSON.parse(
      await readFile(join(f.upgraded.journalDir, "state.json"), "utf8"),
    );
    assert.equal(
      stored.binding.configFingerprint,
      journalBindingForConfig(f.upgraded).configFingerprint,
      "the adoption is durable",
    );
    assert.equal(stored.checkpoint.scans, 7);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
