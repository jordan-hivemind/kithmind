import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OWNER_ARCHIVE_RELOCATION_NAMESPACE,
  fingerprintLegacyDatabaseBackupReceipt,
  parseOwnerArchiveRelocationRecipe,
} from "../dist/archiveRelocationRecipe.js";
import {
  persistOwnerArchiveRelocationRecipe,
  readOwnerArchiveRelocationRecipe,
} from "../dist/archiveRelocationRecipeStore.js";
import { parseConfig } from "../dist/config.js";
import { PDF_DOCQA_CHUNKING_FINGERPRINT } from "../dist/parsedBundleMapping.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (character) => character.repeat(64);

function uuidV5(namespace, name) {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const bytes = createHash("sha1")
    .update(namespaceBytes)
    .update(name, "utf8")
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
    spaceId: `space_${hash(base).slice(0, 16)}`,
    sourceAccountId: `source_${hash(base).slice(0, 16)}`,
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

function boundary(rootPath, repositoryId, rootDirectoryIdHash) {
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

function recipe(base) {
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
  const receipt = {
    kind: "native_database_backup_receipt_v1",
    status: "passed",
    repositoryId: digest("e"),
    rootDirectoryIdHash: digest("f"),
    snapshotId: digest("1"),
    snapshotTag: "kithmind-native-1",
    objectPath: "/synthetic/database/snapshot-1.age",
    ciphertextHash: digest("2"),
    ciphertextByteLength: 1_001,
    payloadHash: digest("3"),
    nativeZipHash: digest("4"),
    remoteReadback: true,
    exactDecryption: true,
    schemaRestore: "Historical synthetic restore note",
    sourcePDFsCopied: false,
  };
  const receiptFingerprint = fingerprintLegacyDatabaseBackupReceipt(receipt);
  const artifact = {
    snapshotId: digest("5"),
    objectName: "synthetic.age",
    ciphertextSha256: digest("6"),
    ciphertextByteLength: 2_000,
  };
  const body = {
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
      catalogAuthorityDigest: digest("7"),
      catalogRevision: 1,
      oldBoundary: boundary(
        "Kith Mind Backups/processing-artifacts/restic-v1",
        digest("d"),
        digest("c"),
      ),
      newBoundary: boundary(
        "Kith Mind/backups/processing-artifacts/restic-v1",
        digest("d"),
        digest("c"),
      ),
      artifacts: [artifact],
      artifactBindings: [
        {
          kind: "parser_backup",
          catalogId: "10000000-0000-4000-8000-000000000001",
          ...artifact,
          plaintextSha256: digest("8"),
          plaintextByteLength: 1_500,
        },
      ],
    },
    database: {
      repositoryRelativePath: "database/restic-v1",
      oldBoundary: boundary(
        "Kith Mind Backups/database/restic-v1",
        digest("e"),
        digest("f"),
      ),
      newBoundary: boundary(
        "Kith Mind/backups/database/restic-v1",
        digest("e"),
        digest("f"),
      ),
      receipts: [{ receiptFingerprint, receipt }],
      selectedNativeRestoreReceiptFingerprint: receiptFingerprint,
    },
    localBindings: {
      previousConfigPath: join(base, "previous.json"),
      proposedConfigPath: join(base, "proposed.json"),
      previousConfigText,
      proposedConfigText,
      previousConfigSha256: hash(previousConfigText),
      proposedConfigSha256: hash(proposedConfigText),
      previousWatcherId: "10000000-0000-4000-8000-000000000002",
      previousJournalStateSha256: digest("9"),
      databaseReceiptPaths: [
        { receiptFingerprint, path: join(base, "receipt.json") },
      ],
      credentialReferenceFingerprint: digest("a"),
    },
  };
  const recipeHash = hash(
    Buffer.concat([
      Buffer.from("owner-archive-relocation-recipe:v1\0", "utf8"),
      Buffer.from(JSON.stringify(body), "utf8"),
    ]),
  );
  return parseOwnerArchiveRelocationRecipe({
    recipeHash,
    workflowRelocationId: uuidV5(
      OWNER_ARCHIVE_RELOCATION_NAMESPACE,
      `${recipeHash}:whole-root-workflow`,
    ),
    catalogRelocationId: uuidV5(
      OWNER_ARCHIVE_RELOCATION_NAMESPACE,
      `${recipeHash}:processing-catalog-relocation`,
    ),
    watcherResetRequestId: uuidV5(
      OWNER_ARCHIVE_RELOCATION_NAMESPACE,
      `${recipeHash}:owner-watcher-reset`,
    ),
    body,
  });
}

async function fixture(t) {
  const base = await mkdtemp(join(homedir(), ".kithmind-recipe-store-test-"));
  await chmod(base, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "recipes");
  await mkdir(directory, { mode: 0o700 });
  return { base, directory, recipe: recipe(base) };
}

function paths(directory, recipeValue) {
  const path = join(
    directory,
    `archive-relocation-recipe-${recipeValue.workflowRelocationId}.json`,
  );
  return { path, temp: `${path}.prepared.tmp` };
}

test("creates, reads, and replays one immutable canonical recipe", async (t) => {
  const f = await fixture(t);
  const first = await persistOwnerArchiveRelocationRecipe({
    directory: f.directory,
    recipe: f.recipe,
  });
  assert.equal(first.reused, false);
  assert.deepEqual(first.recipe, f.recipe);
  assert.equal((await lstat(first.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(first.path)).nlink, 1);
  const replay = await persistOwnerArchiveRelocationRecipe({
    directory: f.directory,
    recipe: structuredClone(f.recipe),
  });
  assert.equal(replay.reused, true);
  assert.deepEqual(
    await readOwnerArchiveRelocationRecipe({
      directory: f.directory,
      workflowRelocationId: f.recipe.workflowRelocationId,
      expectedRecipeHash: f.recipe.recipeHash,
    }),
    { path: first.path, recipe: f.recipe },
  );
});

test("recovers exact temp-only and published-hardlink interruptions", async (t) => {
  const f = await fixture(t);
  const { path, temp } = paths(f.directory, f.recipe);
  const encoded = `${JSON.stringify(f.recipe)}\n`;
  await writeFile(temp, encoded, { mode: 0o600, flag: "wx" });
  const recovered = await readOwnerArchiveRelocationRecipe({
    directory: f.directory,
    workflowRelocationId: f.recipe.workflowRelocationId,
    expectedRecipeHash: f.recipe.recipeHash,
  });
  assert.deepEqual(recovered.recipe, f.recipe);
  await assert.rejects(lstat(temp), { code: "ENOENT" });
  await link(path, temp);
  assert.equal((await lstat(path)).nlink, 2);
  await readOwnerArchiveRelocationRecipe({
    directory: f.directory,
    workflowRelocationId: f.recipe.workflowRelocationId,
    expectedRecipeHash: f.recipe.recipeHash,
  });
  assert.equal((await lstat(path)).nlink, 1);
  await assert.rejects(lstat(temp), { code: "ENOENT" });
});

test("preserves conflicting files and rejects hashes, links, and unsafe roots", async (t) => {
  const f = await fixture(t);
  const { path, temp } = paths(f.directory, f.recipe);
  await persistOwnerArchiveRelocationRecipe({
    directory: f.directory,
    recipe: f.recipe,
  });
  await assert.rejects(
    readOwnerArchiveRelocationRecipe({
      directory: f.directory,
      workflowRelocationId: f.recipe.workflowRelocationId,
      expectedRecipeHash: digest("0"),
    }),
    /recipe_conflict/,
  );
  await writeFile(temp, `${JSON.stringify(f.recipe)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await assert.rejects(
    readOwnerArchiveRelocationRecipe({
      directory: f.directory,
      workflowRelocationId: f.recipe.workflowRelocationId,
      expectedRecipeHash: f.recipe.recipeHash,
    }),
    /recipe_conflict/,
  );
  assert.equal((await lstat(temp)).nlink, 1);

  const linkedDirectory = join(f.base, "linked-recipes");
  await symlink(f.directory, linkedDirectory);
  await assert.rejects(
    readOwnerArchiveRelocationRecipe({
      directory: linkedDirectory,
      workflowRelocationId: f.recipe.workflowRelocationId,
      expectedRecipeHash: f.recipe.recipeHash,
    }),
    /unsafe_store/,
  );

  const unsafeDirectory = join(f.base, "unsafe", "recipes");
  await mkdir(unsafeDirectory, { recursive: true, mode: 0o700 });
  await chmod(join(f.base, "unsafe"), 0o770);
  await assert.rejects(
    persistOwnerArchiveRelocationRecipe({
      directory: unsafeDirectory,
      recipe: f.recipe,
    }),
    /unsafe_store/,
  );
  assert.equal(await readFile(path, "utf8"), `${JSON.stringify(f.recipe)}\n`);
});

test("rejects a symlink or oversized file at the fixed recipe path", async (t) => {
  const first = await fixture(t);
  const firstPaths = paths(first.directory, first.recipe);
  const target = join(first.base, "target.json");
  await writeFile(target, `${JSON.stringify(first.recipe)}\n`, { mode: 0o600 });
  await symlink(target, firstPaths.path);
  await assert.rejects(
    readOwnerArchiveRelocationRecipe({
      directory: first.directory,
      workflowRelocationId: first.recipe.workflowRelocationId,
      expectedRecipeHash: first.recipe.recipeHash,
    }),
    /unsafe_store/,
  );

  const second = await fixture(t);
  const secondPaths = paths(second.directory, second.recipe);
  await writeFile(secondPaths.path, Buffer.alloc(2 * 1024 * 1024 + 1), {
    mode: 0o600,
  });
  await assert.rejects(
    readOwnerArchiveRelocationRecipe({
      directory: second.directory,
      workflowRelocationId: second.recipe.workflowRelocationId,
      expectedRecipeHash: second.recipe.recipeHash,
    }),
    /unsafe_store/,
  );
});
