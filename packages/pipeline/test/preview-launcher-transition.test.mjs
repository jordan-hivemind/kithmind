import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { journalBindingForConfig, loadPipelineConfig } from "../dist/config.js";
import { Journal } from "../dist/journal.js";
import {
  transitionPreviewLauncherFromPaths,
  validatePreviewLauncherTransition,
} from "../dist/previewLauncherTransition.js";
import { journalCodec } from "../dist/runner.js";
import { parseRunnerCheckpoint } from "../dist/runnerState.js";
import { PDF_DOCQA_CHUNKING_FINGERPRINT } from "../dist/parsedBundleMapping.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const TOKEN = "synthetic-preview-transition-token";

function pdfPlan() {
  return {
    rootAlias: "fixture",
    relativePath: "selected.pdf",
    sourceModifiedAt: 1,
    kind: "pdf",
    sha256: "1".repeat(64),
    byteLength: 100,
    parserProfileId: "pdf_docqa_v1",
    parserFingerprint: "2".repeat(64),
    extractionConfigurationFingerprint: "3".repeat(64),
    extractorFingerprint: "extractor-v1",
    recordSchemaFingerprint: "records-disabled-v1",
    normalizationFingerprint: "normalization-v1",
    chunkerFingerprint: "4".repeat(64),
    correctionRevision: "correction-v1",
    externalId: randomUUID(),
    sourceItemId: "source-selected",
    observationEpoch: 1,
    processingEpoch: 1,
    discoveryState: "queued",
  };
}

function archived() {
  return parseRunnerCheckpoint({
    version: 1,
    phase: "archived",
    mode: "normal",
    scanId: "scan-1",
    inventoryEpoch: 1,
    manifestVersion: 1,
    missingBindings: [],
    files: [pdfPlan()],
    pdfIndex: 0,
    step: "lookup_original",
    reservationRound: 0,
    archivedPublished: 0,
    originalCatalogId: randomUUID(),
    expectedOriginalRevision: 1,
    processingCatalogId: randomUUID(),
    expectedProcessingRevision: 1,
  });
}

async function setup() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "preview-launcher-transition-")),
  );
  await chmod(base, 0o700);
  const paths = {};
  for (const name of [
    "root",
    "journal",
    "capture",
    "output",
    "spool",
    "primary",
    "tools",
    "package",
    "models",
    "registry",
  ]) {
    paths[name] = join(base, name);
    await mkdir(paths[name], { mode: 0o700 });
  }
  const launcherPath = join(paths.package, "launcher.py");
  const launcherBytes = Buffer.from("# bounded preview launcher\n", "utf8");
  await writeFile(launcherPath, launcherBytes, { mode: 0o500 });
  const rcloneConfigPath = join(paths.tools, "rclone.conf");
  await writeFile(rcloneConfigPath, "[fixture]\ntype = dropbox\n", {
    mode: 0o600,
  });
  const common = {
    protocolVersion: 1,
    endpoint: `https://${digest(base).slice(0, 32)}.example/api/worker`,
    spaceId: "space",
    sourceAccountId: "source",
    credentialEnv: "PREVIEW_TRANSITION_TOKEN",
    roots: [{ alias: "fixture", path: paths.root }],
    journalDir: paths.journal,
    pdfDocQa: {
      captureDirectory: paths.capture,
      parserOutputRoot: paths.output,
      spoolDirectory: paths.spool,
      parser: {
        pythonExecutable: "/usr/bin/python3",
        expectedPythonSha256: "5".repeat(64),
        launcherPath,
        expectedLauncherSha256: "6".repeat(64),
        packageRoot: paths.package,
        modelAssetsPath: paths.models,
        modelLockPath: join(paths.tools, "model-lock.json"),
        expectedModelLockSha256: "7".repeat(64),
      },
      profile: {
        parserProfileId: "pdf_docqa_v1",
        parserFingerprint: "8".repeat(64),
        extractionConfigurationFingerprint: "9".repeat(64),
        extractorFingerprint: "extractor-v1",
        recordSchemaFingerprint: "records-disabled-v1",
        normalizationFingerprint: "normalization-v1",
        chunkerFingerprint: PDF_DOCQA_CHUNKING_FINGERPRINT,
        correctionRevision: "correction-v1",
      },
      providerOriginal: {
        providerAccountIdHash: digest("dbid:account"),
        remoteName: "fixture",
        rcloneBinary: "/usr/bin/true",
        configPath: rcloneConfigPath,
        configIdentityFingerprint: "0".repeat(64),
        refreshPath: "Folder",
        registryDirectory: paths.registry,
        roots: [
          {
            rootAlias: "fixture",
            providerRootDirectoryId: "id:root",
            providerRootDirectoryIdHash: digest("id:root"),
          },
        ],
      },
      archive: {
        ageBinary: "/usr/bin/age",
        primary: {
          directory: paths.primary,
          recipient: `age1pq1${"q".repeat(40)}`,
          archiveProfileFingerprint: "b".repeat(64),
          archiveIdentityFingerprint: "c".repeat(64),
          recipientFingerprint: "d".repeat(64),
          repositoryKeyDomainFingerprint: "e".repeat(64),
          storageFailureDomainFingerprint: "f".repeat(64),
        },
      },
    },
  };
  const previousPath = join(base, "previous.json");
  const proposedPath = join(base, "proposed.json");
  const proposed = structuredClone(common);
  proposed.pdfDocQa.parser.expectedLauncherSha256 = digest(launcherBytes);
  await writeFile(previousPath, JSON.stringify(common), { mode: 0o600 });
  await writeFile(proposedPath, JSON.stringify(proposed), { mode: 0o600 });
  return { base, previousPath, proposedPath, common, proposed };
}

test("adopts only the installed preview launcher hash and preserves an archived checkpoint", async () => {
  const fixture = await setup();
  process.env.PREVIEW_TRANSITION_TOKEN = TOKEN;
  let journal;
  try {
    const previous = await loadPipelineConfig(fixture.previousPath);
    const proposed = await loadPipelineConfig(fixture.proposedPath);
    const checkpoint = archived();
    journal = await Journal.open({
      directory: previous.journalDir,
      binding: journalBindingForConfig(previous),
      credential: TOKEN,
      initialCheckpoint: checkpoint,
      codec: journalCodec,
    });
    await journal.close();
    journal = undefined;
    const first = await transitionPreviewLauncherFromPaths({
      previousConfigPath: fixture.previousPath,
      proposedConfigPath: fixture.proposedPath,
    });
    assert.equal(first.state, "transitioned");
    journal = await Journal.open({
      directory: proposed.journalDir,
      binding: journalBindingForConfig(proposed),
      credential: TOKEN,
      initialCheckpoint: checkpoint,
      codec: journalCodec,
    });
    assert.deepEqual(journal.checkpoint, checkpoint);
    await journal.close();
    journal = undefined;
    const replay = await transitionPreviewLauncherFromPaths({
      previousConfigPath: fixture.previousPath,
      proposedConfigPath: fixture.proposedPath,
    });
    assert.equal(replay.state, "already_transitioned");
    assert.equal(
      JSON.parse(await readFile(fixture.proposedPath, "utf8")).pdfDocQa.parser
        .expectedLauncherSha256,
      fixture.proposed.pdfDocQa.parser.expectedLauncherSha256,
    );
  } finally {
    await journal?.close();
    delete process.env.PREVIEW_TRANSITION_TOKEN;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("preview launcher adoption rejects any adjacent config change", async () => {
  const fixture = await setup();
  try {
    const previous = await loadPipelineConfig(fixture.previousPath);
    const proposed = await loadPipelineConfig(fixture.proposedPath);
    validatePreviewLauncherTransition(previous, proposed);
    assert.throws(() =>
      validatePreviewLauncherTransition(previous, {
        ...proposed,
        sourceAccountId: "changed",
      }),
    );
    assert.throws(() => validatePreviewLauncherTransition(proposed, proposed));
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
