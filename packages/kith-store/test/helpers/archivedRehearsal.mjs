// P2-104d. The archived (binary) lane driven end to end: the real
// `PipelineRunner` with its real `Journal` and `ArchiveCatalog` on a temp
// directory, against the real kith-store worker handlers dispatched in process
// (see `inProcessWorker.mjs`) over a real PostgreSQL.
//
// Two things are stood in for, and only two, because the real ones need
// external binaries this test cannot have:
//
//   the parser    a sandboxed Python process. The stand-in writes the artifact
//                 pair the parser would have written into the output directory
//                 the catalog already reserved, and then hands control to the
//                 real `driveArchivedParse`, which finds the output present and
//                 validates and records it through the real validator. Nothing
//                 downstream is faked: the spool, the mapping, the archive and
//                 the admission are the shipping code.
//   age/restic    fake executables (see `archiveTools.mjs`); the archive
//                 commands that drive them are the real ones. The one policy
//                 a temp directory cannot honour is the local backup
//                 repository's device independence, so a caller points both
//                 subjects at the fake remote repository.
//
// Everything here is synthetic. No real document, account, key or path.
//
// This lane is macOS-only (`requiredPlatform` in the pipeline's
// `parserProcess.ts`), so a caller must gate on `process.platform === "darwin"`
// as well as on a database.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openArchiveCatalog } from "../../../pipeline/dist/archiveCatalog.js";
import { Journal } from "../../../pipeline/dist/journal.js";
import { PDF_DOCQA_CHUNKING_FINGERPRINT } from "../../../pipeline/dist/parsedBundleMapping.js";
import {
  initialCheckpoint,
  journalCodec,
  PipelineRunner,
} from "../../../pipeline/dist/runner.js";
import {
  doclingArtifactBytes,
  writeDoclingArtifacts,
} from "../../../pipeline/test/syntheticDoclingOutput.mjs";
import { archiveConfig, archiveTools } from "./archiveTools.mjs";

// P2-104e. The owner's source keeps its originals in Dropbox: a
// `provider_original_v1` reference stands where the original's independent
// backup receipt would. Synthetic ids; the API is a stub on `fetch`.
const PROVIDER_ACCOUNT_ID = "dbid:synthetic_rehearsal_account";
const PROVIDER_ROOT_ID = "id:synthetic_rehearsal_root";
const PROVIDER_ROOT_PATH = "/rehearsal root";
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Stands in for the two Dropbox API routes `verifyDropboxOriginal` and
 * `lookupDropboxFileIds` read, and nothing else: the worker transport here is
 * in process and never fetches. Every rehearsal file is far below one 4 MiB
 * block, so the Dropbox content hash is the hash of the one block hash.
 *
 * The returned handle renames a file the way the provider does: a new path,
 * the same id. ADM-4a is exactly the claim that the watcher follows the id.
 */
export function installFakeDropbox(t, workspace) {
  const files = workspace.files.map((file, index) => ({
    ".tag": "file",
    id: `id:synthetic_rehearsal_file_${index}`,
    rev: `rev${index}`,
    size: file.byteLength,
    content_hash: sha256Hex(Buffer.from(file.sha256, "hex")),
    path_lower: `${PROVIDER_ROOT_PATH}/${file.relativePath}`,
  }));
  const root = {
    ".tag": "folder",
    id: PROVIDER_ROOT_ID,
    path_lower: PROVIDER_ROOT_PATH,
  };
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body ?? "null");
    const found = `${url}`.endsWith("/users/get_current_account")
      ? { account_id: PROVIDER_ACCOUNT_ID, disabled: false }
      : [root, ...files].find(
          (row) =>
            row.id === body.path ||
            row.path_lower === `${body.path}`.toLowerCase(),
        );
    return new Response(JSON.stringify(found ?? { error: "not_found" }), {
      status: found ? 200 : 409,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    rename(fromRelativePath, toRelativePath) {
      const file = files.find(
        (row) => row.path_lower === `${PROVIDER_ROOT_PATH}/${fromRelativePath}`,
      );
      if (!file) throw new Error(`no fake provider file ${fromRelativePath}`);
      file.path_lower = `${PROVIDER_ROOT_PATH}/${toRelativePath}`;
    },
  };
}

/** The synthetic PDF every rehearsal document is a copy of, bar its text. */
function pdfBytes(index) {
  return Buffer.from(`%PDF-1.7\nsynthetic document ${index}\n%%EOF\n`);
}

/**
 * One parser runtime, as the owner's private configuration names it. `mapping`
 * is the extraction configuration's mapping format and `manifest` stands for
 * the parser build: the first moves the extraction configuration fingerprint
 * alone, the second moves the parser fingerprint.
 */
export function rehearsalProfile({
  mapping = "docling_utf16_pages_v3",
  manifest = "3".repeat(64),
  pageTexts,
} = {}) {
  const sample = doclingArtifactBytes({
    capture: { sha256: "0".repeat(64) },
    mappingFormat: mapping,
    modelManifestSha256: manifest,
    ...(pageTexts === undefined ? {} : { pageTexts }),
  });
  return {
    mapping,
    manifest,
    ...(pageTexts === undefined ? {} : { pageTexts }),
    profile: {
      parserProfileId: "pdf_docqa_v1",
      parserFingerprint: sample.parserFingerprint,
      extractionConfigurationFingerprint:
        sample.extractionConfigurationFingerprint,
      extractorFingerprint: "extractor-v1",
      recordSchemaFingerprint: "records-disabled-v1",
      normalizationFingerprint: "normalization-v1",
      chunkerFingerprint: PDF_DOCQA_CHUNKING_FINGERPRINT,
      correctionRevision: "correction-v1",
    },
  };
}

/**
 * Temp directories, the fake archive tools, and `documents` synthetic PDFs in
 * the scanned root. The tools live outside every private directory, which is
 * what the shipping config parser requires of them.
 */
export async function rehearsalWorkspace(t, { documents = 3 } = {}) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "kith-archived-rehearsal-")),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const paths = {
    base,
    root: join(base, "root"),
    journalDir: join(base, "journal"),
    captureDirectory: join(base, "captures"),
    parserOutputRoot: join(base, "outputs"),
    spoolDirectory: join(base, "spool"),
    registryDirectory: join(base, "registry"),
  };
  for (const path of Object.values(paths)) {
    if (path === base) continue;
    await mkdir(path, { mode: 0o700 });
  }
  const files = [];
  for (let index = 0; index < documents; index += 1) {
    const bytes = pdfBytes(index);
    const relativePath = `document-${index}.pdf`;
    await writeFile(join(paths.root, relativePath), bytes, { mode: 0o600 });
    files.push({
      relativePath,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  // The tools keep their own base: an executable inside a private directory
  // is what the shipping config parser refuses.
  return { ...paths, files, tools: await archiveTools(t) };
}

export function rehearsalConfig({
  endpoint,
  spaceId,
  sourceAccountId,
  workspace,
  runtime,
  provider = false,
}) {
  return {
    protocolVersion: 1,
    endpoint,
    spaceId,
    sourceAccountId,
    credentialEnv: "SYNTHETIC_WORKER_TOKEN",
    roots: [{ alias: "fixture", path: workspace.root }],
    journalDir: workspace.journalDir,
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
    pdfDocQa: {
      captureDirectory: workspace.captureDirectory,
      parserOutputRoot: workspace.parserOutputRoot,
      spoolDirectory: workspace.spoolDirectory,
      parser: {
        pythonExecutable: join(workspace.tools.tools, "python"),
        expectedPythonSha256: "1".repeat(64),
        launcherPath: join(workspace.tools.tools, "launcher.py"),
        expectedLauncherSha256: "2".repeat(64),
        packageRoot: join(workspace.tools.tools, "package"),
        modelAssetsPath: join(workspace.tools.tools, "models"),
        modelLockPath: join(workspace.tools.tools, "model-lock.json"),
        expectedModelLockSha256: runtime.manifest,
      },
      profile: runtime.profile,
      archive: archiveConfig(workspace.tools),
      ...(provider
        ? {
            providerOriginal: {
              rootAlias: "fixture",
              providerRootDirectoryId: PROVIDER_ROOT_ID,
              providerAccountIdHash: sha256Hex(PROVIDER_ACCOUNT_ID),
              providerRootDirectoryIdHash: sha256Hex(PROVIDER_ROOT_ID),
              refreshPath: "Processing",
              registryDirectory: workspace.registryDirectory,
            },
          }
        : {}),
    },
  };
}

/**
 * Stands in for the sandboxed parser by writing what it would have written,
 * then defers to the real step. The output directory is the one the catalog
 * reserved when it created the processing row, so the real step's intent check
 * and its validator both run against exactly the bytes a parser run produces.
 */
function stubParser(runner, runtime) {
  const real = Object.getPrototypeOf(runner).driveArchivedParse;
  runner.driveArchivedParse = async function stubbed() {
    const checkpoint = this.journal.checkpoint;
    const { original, processing } = this.archivedRows(checkpoint);
    if (!processing.parserOutput) {
      await writeDoclingArtifacts(
        join(
          this.requirePdfConfig().parserOutputRoot,
          processing.parserIntent.outputId,
        ),
        doclingArtifactBytes({
          capture: { sha256: original.origin.sha256 },
          mappingFormat: runtime.mapping,
          modelManifestSha256: runtime.manifest,
          ...(runtime.pageTexts === undefined
            ? {}
            : { pageTexts: runtime.pageTexts }),
        }),
      );
    }
    return await real.call(this);
  };
}

/**
 * One pass, opening and closing the journal around it exactly as the worker
 * does. `inspect` sees the runner before it runs, for a test that needs to
 * reach into the catalog.
 */
export async function rehearsalPass({
  config,
  credential,
  transport,
  runtime,
  inspect,
}) {
  const journal = await Journal.open({
    directory: config.journalDir,
    binding: {
      protocolVersion: 1,
      endpoint: config.endpoint,
      spaceId: config.spaceId,
      sourceAccountId: config.sourceAccountId,
      configFingerprint: "b".repeat(64),
      credentialSlot: "SYNTHETIC_WORKER_TOKEN",
    },
    credential,
    initialCheckpoint,
    codec: journalCodec,
  });
  try {
    const runner = new PipelineRunner(config, journal, transport);
    // The profile preparation this stands in for probes the real Python
    // runtime and model lock, and it runs on every pass. Only the manifest
    // digest is read afterwards, by the parser recovery path, and it must be
    // the one the artifacts name.
    runner.preparePdfProfile = async () => {
      runner.preparedPdfProfile = {
        modelManifestSha256: runtime.manifest,
        parserFingerprint: runtime.profile.parserFingerprint,
        extractionConfigurationFingerprint:
          runtime.profile.extractionConfigurationFingerprint,
      };
    };
    stubParser(runner, runtime);
    // The one archive policy this rehearsal cannot honour. A local restic
    // repository must be on a different device from the primary archive
    // (`assessLocalBackupBoundary`), which no temp directory can be, so both
    // subjects go to the fake remote repository. The runner refuses a remote
    // repository for original bytes on purpose -- that is the rule that a
    // provider original, not the backup repository, holds the original -- and
    // that refusal is not what this rehearsal is about. Everything the
    // commands themselves do is real.
    runner.resticLocation = () => ({
      repository: config.pdfDocQa.archive.independentBackup.repository,
    });
    const result = await runner.run();
    if (inspect) await inspect(runner);
    return result;
  } finally {
    await journal.close();
  }
}

/**
 * Opens the local archive catalog between passes, the way an operator tool
 * would. The journal lock is exclusive, so nothing else may hold it.
 */
export async function withRehearsalCatalog(config, credential, work) {
  const journal = await Journal.open({
    directory: config.journalDir,
    binding: {
      protocolVersion: 1,
      endpoint: config.endpoint,
      spaceId: config.spaceId,
      sourceAccountId: config.sourceAccountId,
      configFingerprint: "b".repeat(64),
      credentialSlot: "SYNTHETIC_WORKER_TOKEN",
    },
    credential,
    initialCheckpoint,
    codec: journalCodec,
  });
  try {
    return await work(await openArchiveCatalog({ journal }));
  } finally {
    await journal.close();
  }
}

/**
 * Runs passes until the pass result stops changing the world: a `complete`
 * pass that published nothing is the terminal answer, and a bounded number of
 * passes is part of what the rehearsal asserts.
 */
export async function rehearsalUntilSettled(options, maximumPasses = 6) {
  const results = [];
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    const result = await rehearsalPass(options);
    results.push(result);
    if (result.state === "complete" && result.published === 0) return results;
    if (result.state === "failed") return results;
  }
  return results;
}
