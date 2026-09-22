import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal, JournalLockedError } from "../dist/journal.js";
import {
  ADMISSION_BLOCK_CODES,
  admissionBlockEscalated,
  ArchiveCatalogError,
  MAX_ADMISSION_BLOCK_ATTEMPTS,
  openArchiveCatalog,
} from "../dist/archiveCatalog.js";
import { digestArchiveIntent } from "../dist/archivedRequestMapping.js";
import {
  archivedCheckpointIdentity,
  initialCheckpoint,
  journalCodec,
  PipelineRunner,
  providerCatalogVerification,
} from "../dist/runner.js";
import { ParserProcessError } from "../dist/parserProcess.js";
import { canonicalRoots, discoverFiles, toFsUri } from "../dist/filesystem.js";
import { persistProviderBinding } from "../dist/providerRegistry.js";
import {
  formatReconcileResult,
  reconcileReceiptsFromPath,
  runReconcileReceipts,
} from "../dist/reconcileReceipts.js";
import { parseRunnerCheckpoint } from "../dist/runnerState.js";
import { MAX_WORKER_SCAN_PAGES } from "@repo/worker-protocol/request";

const HASH = "a".repeat(64);

test("provider verification projects only the archive catalog closed shape", () => {
  const projected = providerCatalogVerification(
    {
      metadata: {
        referenceVersion: "provider_original_v1",
        providerKind: "dropbox_v1",
        providerAccountIdHash: "1".repeat(64),
        providerRootDirectoryIdHash: "2".repeat(64),
        providerFileIdHash: "3".repeat(64),
        providerRevision: "rev1",
        providerContentHash: "4".repeat(64),
        sourceContentHash: "5".repeat(64),
        sourceByteLength: 100,
        verifiedAt: 10,
      },
      binding: {
        bindingId: randomUUID(),
        providerAccountId: "dbid:account",
        providerRootDirectoryId: "id:root",
        providerFileId: "id:file",
        providerRevision: "rev1",
        relativePath: "Folder/file.pdf",
      },
    },
    {
      bindingId: randomUUID(),
      manifestPath: "/protected/provider.json",
      manifestFingerprint: "6".repeat(64),
      manifestByteLength: 512,
    },
  );
  assert.deepEqual(Object.keys(projected).sort(), [
    "manifestByteLength",
    "manifestFingerprint",
    "providerAccountIdHash",
    "providerContentHash",
    "providerFileIdHash",
    "providerRevision",
    "providerRootDirectoryIdHash",
    "sourceByteLength",
    "sourceContentHash",
    "verifiedAt",
  ]);
  assert.equal("referenceVersion" in projected, false);
  assert.equal("providerKind" in projected, false);
});

function pdfPlan(overrides = {}) {
  return {
    rootAlias: "fixture",
    relativePath: "document.pdf",
    sourceModifiedAt: 1,
    kind: "pdf",
    sha256: HASH,
    byteLength: 100,
    parserProfileId: "pdf_docqa_v1",
    parserFingerprint: HASH,
    extractionConfigurationFingerprint: HASH,
    extractorFingerprint: "extractor-v1",
    recordSchemaFingerprint: "records-disabled-v1",
    normalizationFingerprint: "normalization-v1",
    chunkerFingerprint: HASH,
    correctionRevision: "correction-v1",
    externalId: randomUUID(),
    sourceItemId: "source-item",
    observationEpoch: 1,
    processingEpoch: 1,
    discoveryState: "queued",
    ...overrides,
  };
}

function archivedCheckpoint(plan, overrides = {}) {
  return parseRunnerCheckpoint({
    version: 1,
    phase: "archived",
    mode: "normal",
    scanId: "scan-1",
    inventoryEpoch: 1,
    manifestVersion: 1,
    missingBindings: [],
    files: [plan],
    pdfIndex: 0,
    step: "preflight",
    reservationRound: 0,
    archivedPublished: 0,
    originalCatalogId: randomUUID(),
    expectedOriginalRevision: 1,
    processingCatalogId: randomUUID(),
    expectedProcessingRevision: 1,
    preflightAction: "original_primary_publish",
    ...overrides,
  });
}

const TOKEN = "a".repeat(64);

function fixtureEndpoint(journalDir) {
  const digest = createHash("sha256").update(journalDir).digest("hex");
  return `https://runner-${digest.slice(0, 32)}.invalid/api/worker`;
}

function config(root, journalDir) {
  return {
    protocolVersion: 1,
    endpoint: fixtureEndpoint(journalDir),
    spaceId: "space",
    sourceAccountId: "source",
    credentialEnv: "PIPELINE_TOKEN",
    roots: [{ alias: "fixture", path: root }],
    journalDir,
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
  };
}

function binding(endpoint) {
  return {
    protocolVersion: 1,
    endpoint,
    spaceId: "space",
    sourceAccountId: "source",
    configFingerprint: "b".repeat(64),
    credentialSlot: "PIPELINE_TOKEN",
  };
}

const fixtureJournalAllocations = new Map();

async function fixture(fileCount = 1) {
  const base = await mkdtemp(join(tmpdir(), "kithmind-runner-test-"));
  const root = join(base, "root");
  const journalDir = join(base, "journal");
  await mkdir(root, { mode: 0o700 });
  await mkdir(journalDir, { mode: 0o700 });
  await chmod(root, 0o700);
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(join(root, `file-${index}.txt`), `synthetic-${index}`, {
      mode: 0o600,
    });
  }
  const setup = {
    base,
    root,
    journalDir,
    config: config(root, journalDir),
  };
  const allocation = { setup, opened: false, attempt: 0 };
  fixtureJournalAllocations.set(journalDir, allocation);
  return setup;
}

async function openJournal(
  directory,
  checkpoint = initialCheckpoint,
  open = (args) => Journal.open(args),
) {
  const allocation = fixtureJournalAllocations.get(directory);
  if (!allocation || allocation.opened) {
    return await open({
      directory,
      binding: binding(
        allocation?.setup.config.endpoint ?? fixtureEndpoint(directory),
      ),
      credential: "test-credential",
      initialCheckpoint: checkpoint,
      codec: journalCodec,
    });
  }
  for (;;) {
    const candidate = allocation.setup.journalDir;
    try {
      const journal = await open({
        directory: candidate,
        binding: binding(allocation.setup.config.endpoint),
        credential: "test-credential",
        initialCheckpoint: checkpoint,
        codec: journalCodec,
      });
      allocation.opened = true;
      return journal;
    } catch (error) {
      if (!(error instanceof JournalLockedError) || allocation.attempt >= 4)
        throw error;
      if ((await readdir(candidate)).length !== 0) throw error;
      fixtureJournalAllocations.delete(candidate);
      allocation.attempt += 1;
      const next = join(
        allocation.setup.base,
        `journal-${allocation.attempt}-${randomUUID()}`,
      );
      await mkdir(next, { mode: 0o700 });
      allocation.setup.journalDir = next;
      allocation.setup.config.journalDir = next;
      allocation.setup.config.endpoint = fixtureEndpoint(next);
      fixtureJournalAllocations.set(next, allocation);
    }
  }
}

async function fixtureWithJournal(fileCount, checkpoint) {
  const setup = await fixture(fileCount);
  const journal = await openJournal(setup.journalDir, checkpoint);
  return { ...setup, journal };
}

test("fixture lock retries rotate only the initial synthetic binding", async () => {
  const setup = await fixture(0);
  const initialDirectory = setup.journalDir;
  const attemptedEndpoints = [];
  const journal = await openJournal(
    setup.journalDir,
    initialCheckpoint,
    async (args) => {
      attemptedEndpoints.push(args.binding.endpoint);
      if (attemptedEndpoints.length === 1) throw new JournalLockedError();
      return await Journal.open(args);
    },
  );
  try {
    assert.notEqual(setup.journalDir, initialDirectory);
    assert.ok(attemptedEndpoints.length >= 2);
    assert.ok(attemptedEndpoints.length <= 5);
    assert.equal(new Set(attemptedEndpoints).size, attemptedEndpoints.length);
    assert.equal(setup.config.endpoint, attemptedEndpoints.at(-1));
    await assert.rejects(
      () => openJournal(setup.journalDir),
      JournalLockedError,
    );
  } finally {
    await journal.close();
  }
  const reopened = await openJournal(setup.journalDir);
  try {
    assert.equal(reopened.binding.endpoint, attemptedEndpoints.at(-1));
  } finally {
    await reopened.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("version-1 checkpoints accept only closed PDF and safe-gap scan plans", () => {
  const digest = "a".repeat(64);
  const checkpoint = parseRunnerCheckpoint({
    version: 1,
    phase: "scan_begin",
    mode: "normal",
    expectedInventoryEpoch: 1,
    missingBindings: [],
    files: [
      {
        rootAlias: "fixture",
        relativePath: "legacy.txt",
        sourceModifiedAt: 1,
        sha256: digest,
        byteLength: 1,
      },
      {
        rootAlias: "fixture",
        relativePath: "document.pdf",
        sourceModifiedAt: 1,
        kind: "pdf",
        sha256: digest,
        byteLength: 65_537,
        parserProfileId: "pdf_docqa_v1",
        parserFingerprint: digest,
        extractionConfigurationFingerprint: digest,
        extractorFingerprint: "extractor-v1",
        recordSchemaFingerprint: "records-disabled-v1",
        normalizationFingerprint: "normalization-v1",
        chunkerFingerprint: digest,
        correctionRevision: "correction-v1",
      },
      {
        rootAlias: "fixture",
        relativePath: "unsupported.bin",
        sourceModifiedAt: 1,
        kind: "gap",
        code: "unsupported",
      },
    ],
  });
  assert.equal(checkpoint.phase, "scan_begin");
  assert.throws(() =>
    parseRunnerCheckpoint({
      ...checkpoint,
      files: [
        {
          ...checkpoint.files[1],
          kind: "pdf",
          byteLength: 16 * 1024 * 1024 + 1,
        },
      ],
    }),
  );
  assert.throws(() =>
    parseRunnerCheckpoint({
      ...checkpoint,
      files: [
        {
          ...checkpoint.files[2],
          kind: "gap",
          code: "unstable",
        },
      ],
    }),
  );
});

test("append serializes PDF and safe leaf gaps without changing UTF-8 entries", async () => {
  const digest = "a".repeat(64);
  const checkpoint = parseRunnerCheckpoint({
    version: 1,
    phase: "append",
    mode: "normal",
    scanId: "scan",
    inventoryEpoch: 1,
    manifestVersion: 1,
    missingBindings: [],
    identities: [],
    nextOrdinal: 0,
    reviewSeen: false,
    files: [
      {
        rootAlias: "fixture",
        relativePath: "file-0.txt",
        sourceModifiedAt: 1,
        sha256: digest,
        byteLength: 1,
        externalId: randomUUID(),
      },
      {
        rootAlias: "fixture",
        relativePath: "document.pdf",
        sourceModifiedAt: 1,
        kind: "pdf",
        sha256: digest,
        byteLength: 65_537,
        parserProfileId: "pdf_docqa_v1",
        parserFingerprint: digest,
        extractionConfigurationFingerprint: digest,
        extractorFingerprint: "extractor-v1",
        recordSchemaFingerprint: "records-disabled-v1",
        normalizationFingerprint: "normalization-v1",
        chunkerFingerprint: digest,
        correctionRevision: "correction-v1",
        externalId: randomUUID(),
      },
      {
        rootAlias: "fixture",
        relativePath: "unsupported.bin",
        sourceModifiedAt: 1,
        kind: "gap",
        code: "unsupported",
        externalId: randomUUID(),
      },
    ],
  });
  const {
    base,
    root,
    journalDir,
    config: localConfig,
    journal,
  } = await fixtureWithJournal(1, checkpoint);
  const calls = [];
  const transport = {
    async call(request) {
      calls.push(request);
      if (request.operation === "source.status") {
        return { operation: "source.status", sourceAccountId: "source" };
      }
      assert.equal(request.operation, "scan.appendPage");
      return { error: { code: "rate_limited" } };
    },
  };
  try {
    const result = await new PipelineRunner(localConfig, journal, transport, {
      windowMs: 10,
      maxAttempts: 2,
    }).run();
    assert.equal(result.state, "failed");
    assert.equal(result.code, "rate_limited");
    const append = calls.find((call) => call.operation === "scan.appendPage");
    assert.deepEqual(
      append.entries.map((entry) => entry.content.status),
      ["ready", "ready_binary_v1", "gap"],
    );
    assert.equal(append.entries[0].content.sha256, digest);
    assert.deepEqual(append.entries[2].content, {
      status: "gap",
      code: "unsupported",
    });
  } finally {
    await journal.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("cached forgotten PDF disposition resumes without archival work or invented epochs", async () => {
  const forgotten = pdfPlan({ relativePath: "forgotten.pdf" });
  const unchanged = pdfPlan({ relativePath: "unchanged.pdf" });
  const review = pdfPlan({ relativePath: "review.pdf" });
  const checkpoint = parseRunnerCheckpoint({
    version: 1,
    phase: "append",
    mode: "normal",
    scanId: "scan",
    inventoryEpoch: 1,
    manifestVersion: 1,
    missingBindings: [],
    identities: [],
    nextOrdinal: 0,
    reviewSeen: false,
    files: [forgotten, unchanged, review],
  });
  const setup = await fixtureWithJournal(0, checkpoint);
  let journal = setup.journal;
  try {
    journal.commitResult = async () => {
      throw new Error("interrupted commit");
    };
    const first = new PipelineRunner(setup.config, journal, {
      async call() {
        return {
          operation: "scan.appendPage",
          scanId: "scan",
          ordinal: 0,
          reused: false,
          entries: [
            { state: "ignored_forgotten", sourceItemId: "forgotten-item" },
            {
              state: "unchanged",
              sourceItemId: "unchanged-item",
              observationEpoch: 2,
              processingEpoch: 3,
            },
            { state: "needs_review", sourceItemId: "review-item" },
          ],
        };
      },
    });
    await assert.rejects(() => first.driveAppend(), /interrupted commit/);
    assert.ok(journal.pending?.result);
    await journal.close();
    journal = await openJournal(setup.journalDir);
    const resumed = new PipelineRunner(setup.config, journal, {
      async call() {
        throw new Error("cached result must not use transport");
      },
    });
    await resumed.driveAppend();
    assert.equal(journal.pending, undefined);
    assert.equal(journal.checkpoint.phase, "seal_check");
    assert.equal(journal.checkpoint.reviewSeen, true);
    const [forgottenAfter, unchangedAfter, reviewAfter] =
      journal.checkpoint.files;
    for (const entry of [forgottenAfter, reviewAfter]) {
      for (const key of [
        "sourceItemId",
        "observationEpoch",
        "processingEpoch",
        "discoveryState",
      ])
        assert.equal(entry[key], undefined);
      assert.equal(await resumed.pdfNeedsArchivedWork(entry), false);
    }
    assert.equal(forgottenAfter.externalId, forgotten.externalId);
    assert.equal(reviewAfter.externalId, undefined);
    assert.equal(unchangedAfter.sourceItemId, "unchanged-item");
    assert.equal(unchangedAfter.observationEpoch, 2);
    assert.equal(unchangedAfter.processingEpoch, 3);
    assert.equal(unchangedAfter.discoveryState, "unchanged");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("PDF seal recheck ignores server identity and disposition fields", async () => {
  const setup = await fixture(0);
  const path = join(setup.root, "document.pdf");
  const bytes = Buffer.from("%PDF-1.7\nsynthetic\n%%EOF\n");
  await writeFile(path, bytes, { mode: 0o600 });
  const entry = await lstat(path);
  const plan = pdfPlan({
    relativePath: "document.pdf",
    sourceModifiedAt: Math.trunc(entry.mtimeMs),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  });
  const journal = await openJournal(setup.journalDir);
  const localConfig = {
    ...setup.config,
    pdfDocQa: {
      profile: {
        parserProfileId: plan.parserProfileId,
        parserFingerprint: plan.parserFingerprint,
        extractionConfigurationFingerprint:
          plan.extractionConfigurationFingerprint,
        extractorFingerprint: plan.extractorFingerprint,
        recordSchemaFingerprint: plan.recordSchemaFingerprint,
        normalizationFingerprint: plan.normalizationFingerprint,
        chunkerFingerprint: plan.chunkerFingerprint,
        correctionRevision: plan.correctionRevision,
      },
    },
  };
  const runner = new PipelineRunner(localConfig, journal, {
    async call() {
      throw new Error("network is not used");
    },
  });
  runner.preparedPdfProfile = {};
  try {
    const canonicalRoot = await realpath(setup.root);
    const rootEntry = await lstat(canonicalRoot);
    assert.equal(
      await runner.sameDiscoveredSnapshot(
        [
          {
            alias: "fixture",
            path: canonicalRoot,
            canonicalPath: canonicalRoot,
            device: rootEntry.dev,
            inode: rootEntry.ino,
          },
        ],
        [plan],
      ),
      true,
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

function assessmentCounts(ready, overrides = {}) {
  return {
    items: {
      ready,
      pending: 0,
      failed: 0,
      parked: 0,
      needsReview: 0,
      explicitGap: 0,
      unavailable: 0,
      ignoredForgotten: 0,
      ...overrides,
    },
    unresolvedEntries: { needsReview: 0, ignoredForgotten: 0 },
  };
}

function assessPageCheckpoint(overrides = {}) {
  return parseRunnerCheckpoint({
    version: 1,
    phase: "assess_page",
    scanId: "scan_1",
    scanned: 1,
    published: 1,
    bindings: [],
    assessmentId: "assessment_1",
    ordinal: 0,
    pageCount: 0,
    ...overrides,
  });
}

function assessPageResponse(ordinal, state = "running", countsOverrides) {
  const complete = state === "complete";
  return {
    operation: "processing.assessPage",
    assessmentId: "assessment_1",
    state,
    phase: complete ? "done" : "items",
    ordinal,
    inspected: 1,
    nextOrdinal: ordinal + 1,
    reused: false,
    ...(complete
      ? {
          counts: assessmentCounts(1, countsOverrides),
          completedAt: Date.now(),
        }
      : {}),
  };
}

class CompleteCloud {
  constructor(options = {}) {
    this.failFirstStage = options.failFirstStage ?? false;
    this.stageFailed = false;
    this.failAppendOnce = options.failAppendOnce ?? false;
    this.appendAttempts = 0;
    this.scanId = "scan_1";
    this.inventoryEpoch = 0;
    this.manifestVersion = 0;
    this.enumerated = false;
    this.discoveryQueue = [];
    this.jobQueue = [];
    this.admitted = new Set();
    this.activated = new Set();
    this.stageBodies = [];
    this.operations = [];
  }

  status() {
    return {
      operation: "source.status",
      sourceAccountId: "source",
      inventoryEpoch: this.inventoryEpoch,
      completedInventoryEpoch: this.enumerated ? this.inventoryEpoch : 0,
      manifestVersion: this.manifestVersion,
      enumeration: this.enumerated
        ? { state: "complete", scanId: this.scanId, completedAt: 10 }
        : { state: "never" },
      processing: { state: "not_assessed" },
      recordCoverage: "not_established",
    };
  }

  async call(request) {
    this.operations.push(request.operation);
    switch (request.operation) {
      case "source.status":
        return this.status();
      case "scan.begin":
        assert.equal(request.mode, "normal");
        this.inventoryEpoch = 1;
        this.manifestVersion = 1;
        return {
          operation: "scan.begin",
          scanId: this.scanId,
          inventoryEpoch: 1,
          manifestVersion: 1,
          state: "open",
          reused: false,
        };
      case "scan.appendPage": {
        if (this.failAppendOnce) {
          this.appendAttempts += 1;
          if (this.appendAttempts === 1) {
            throw new Error("lost response after remote append commit");
          }
          if (this.appendAttempts === 2) {
            return { error: { code: "scan_not_ready" } };
          }
        }
        const entries = request.entries.map((entry, index) => {
          assert.match(entry.externalId, /^[0-9a-f-]{36}$/);
          const item = `item_${request.ordinal}_${index}`;
          const work = `work_${request.ordinal}_${index}`;
          const job = `job_${request.ordinal}_${index}`;
          this.discoveryQueue.push({
            workId: work,
            jobId: job,
            sourceItemId: item,
            uri: entry.uri,
            contentHash: entry.content.sha256,
            byteLength: entry.content.byteLength,
          });
          return {
            state: "queued",
            sourceItemId: item,
            observationEpoch: 1,
            processingEpoch: 1,
          };
        });
        return {
          operation: "scan.appendPage",
          scanId: this.scanId,
          ordinal: request.ordinal,
          reused: false,
          entries,
        };
      }
      case "scan.seal":
        return {
          operation: "scan.seal",
          scanId: this.scanId,
          state: "sealed",
          reused: false,
        };
      case "scan.reconcile":
        this.enumerated = true;
        return {
          operation: "scan.reconcile",
          scanId: this.scanId,
          state: "enumerated",
          inspected: 0,
          unavailable: 0,
          done: true,
          reused: false,
        };
      case "discovery.reserve": {
        const targets = this.discoveryQueue
          .filter((row) => !this.admitted.has(row.workId))
          .slice(0, 4)
          .map((row) => ({
            workId: row.workId,
            sourceItemId: row.sourceItemId,
            observationEpoch: 1,
            processingEpoch: 1,
            leaseEpoch: 1,
            leaseToken: TOKEN,
            leaseExpiresAt: Date.now() + 300_000,
            uri: row.uri,
            contentHash: row.contentHash,
            byteLength: row.byteLength,
          }));
        return {
          operation: "discovery.reserve",
          receiptId: randomUUID(),
          expiresAt: Date.now() + 300_000,
          reused: false,
          targets,
        };
      }
      case "discovery.admitUtf8": {
        const row = this.discoveryQueue.find(
          (candidate) => candidate.workId === request.workId,
        );
        assert.ok(row);
        assert.equal(
          createHash("sha256").update(Buffer.from(request.text)).digest("hex"),
          row.contentHash,
        );
        this.admitted.add(row.workId);
        this.jobQueue.push(row);
        return {
          operation: "discovery.admitUtf8",
          workId: row.workId,
          sourceItemId: row.sourceItemId,
          sourceRevisionId: `revision_${row.workId}`,
          processingGenerationId: `generation_${row.workId}`,
          ingestJobId: row.jobId,
          desiredProcessingEpoch: 1,
          state: "admitted",
          reused: false,
        };
      }
      case "jobs.reserve": {
        const targets = this.jobQueue
          .filter((row) => !this.activated.has(row.jobId))
          .slice(0, 4)
          .map((row) => ({
            jobId: row.jobId,
            workId: row.workId,
            sourceItemId: row.sourceItemId,
            observationEpoch: 1,
            processingEpoch: 1,
            state: "processing",
            leaseEpoch: 1,
            leaseToken: TOKEN,
            leaseExpiresAt: Date.now() + 300_000,
          }));
        return {
          operation: "jobs.reserve",
          receiptId: randomUUID(),
          expiresAt: Date.now() + 300_000,
          reused: false,
          targets,
        };
      }
      case "jobs.renew":
        return {
          operation: "jobs.renew",
          jobId: request.jobId,
          state: "processing",
          leaseExpiresAt: Date.now() + 300_000,
          reused: false,
        };
      case "jobs.stageUtf8": {
        const body = JSON.stringify(request);
        this.stageBodies.push(body);
        if (this.failFirstStage && !this.stageFailed) {
          this.stageFailed = true;
          throw new Error("lost response after remote stage commit");
        }
        return {
          operation: "jobs.stageUtf8",
          jobId: request.jobId,
          state: "staged",
          actualPageCount: 1,
          actualEvidenceSpanCount: 1,
          actualDocumentCount: 1,
          actualChunkCount: 1,
          reused: this.stageFailed,
        };
      }
      case "jobs.activate":
        this.activated.add(request.jobId);
        return {
          operation: "jobs.activate",
          jobId: request.jobId,
          state: "ready",
          activatedAt: Date.now(),
          reused: false,
        };
      case "processing.assessBegin":
        return {
          operation: "processing.assessBegin",
          assessmentId: "assessment_1",
          scanId: this.scanId,
          inventoryEpoch: this.inventoryEpoch,
          manifestVersion: this.manifestVersion,
          state: "running",
          nextOrdinal: 0,
          reused: false,
        };
      case "processing.assessPage":
        return {
          operation: "processing.assessPage",
          assessmentId: "assessment_1",
          state: "complete",
          phase: "done",
          ordinal: request.ordinal,
          inspected: 1,
          nextOrdinal: request.ordinal + 1,
          counts: assessmentCounts(this.activated.size),
          completedAt: Date.now(),
          reused: false,
        };
      default:
        throw new Error(`unexpected operation ${request.operation}`);
    }
  }
}

test("preserves an allowlisted parser failure through the safe runner boundary", async () => {
  const setup = await fixture();
  const journal = await openJournal(setup.journalDir);
  try {
    const runner = new PipelineRunner(
      setup.config,
      journal,
      new CompleteCloud(),
    );
    runner.run = async () => {
      throw new ParserProcessError(
        "page_limit_exceeded",
        "parser reported a bounded failure",
      );
    };
    assert.deepEqual(await runner.runSafely(), {
      state: "failed",
      code: "page_limit_exceeded",
    });
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a document-level parser failure is recorded against that document and the pass continues", async () => {
  const setup = await fixture(0);
  const plans = [0, 1, 2].map((index) =>
    pdfPlan({ relativePath: `document-${index}.pdf` }),
  );
  const checkpoint = archivedCheckpoint(plans[1], {
    files: plans,
    pdfIndex: 1,
    step: "parse",
    archivedPublished: 1,
    preflightAction: undefined,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const recordedFailures = [];
  const submittedFailures = [];
  try {
    const runner = new PipelineRunner(setup.config, journal, {
      async call(request) {
        if (request.operation === "source.status") {
          return { operation: "source.status", sourceAccountId: "source" };
        }
        if (request.operation === "discovery.failArchived") {
          submittedFailures.push(request);
          return {
            operation: "discovery.failArchived",
            sourceItemId: request.identity.sourceItemId,
            workId: "work-1",
            state: "failed",
            retryable: true,
            failureCode: request.failureCode,
          };
        }
        throw new Error(`unexpected operation ${request.operation}`);
      },
    });
    runner.archiveCatalog = {
      findOriginalExact() {
        return undefined;
      },
      listOriginals() {
        return [
          { originalCatalogId: checkpoint.originalCatalogId, rowRevision: 1 },
        ];
      },
      listProcessings() {
        return [
          {
            processingCatalogId: checkpoint.processingCatalogId,
            originalCatalogId: checkpoint.originalCatalogId,
            rowRevision: 1,
          },
        ];
      },
      async recordParseFailure(args) {
        recordedFailures.push(args);
        return { parseFailure: { code: args.code, attempts: 1, failedAt: 1 } };
      },
    };
    let calls = 0;
    runner.driveCheckpoint = async () => {
      calls += 1;
      // Stand in for the second of three documents: the first call is where
      // `driveArchivedParse` would have raised a document-level failure
      // (conversion_failed) while converting document-1; the run's own loop
      // must catch it, record it, and keep going rather than end the pass.
      if (calls === 1) {
        throw new ParserProcessError(
          "conversion_failed",
          "docling could not convert page 1",
        );
      }
      return { state: "complete", scanned: 3, published: 2 };
    };
    const result = await runner.run();
    assert.equal(calls, 2);
    assert.equal(recordedFailures.length, 1);
    assert.equal(recordedFailures[0].code, "conversion_failed");
    assert.equal(recordedFailures[0].catalogId, checkpoint.processingCatalogId);
    assert.deepEqual(result, { state: "complete", scanned: 3, published: 2 });
    // The failed document (index 1) is skipped, not retried in this pass;
    // the run moves on to the next one (index 2) and nothing extra is
    // counted as published for the failure.
    assert.equal(journal.checkpoint.phase, "archived");
    assert.equal(journal.checkpoint.pdfIndex, 2);
    assert.equal(journal.checkpoint.step, "intent");
    assert.equal(journal.checkpoint.archivedPublished, 1);
    // The failure is also reported to the server (discovery.failArchived),
    // so the file's sourceInventory row can be marked parse_failed with the
    // failure class: without this, list_review_queue would have no way to
    // know why the file is not indexed.
    assert.equal(submittedFailures.length, 1);
    assert.equal(submittedFailures[0].failureCode, "conversion_failed");
    assert.equal(
      submittedFailures[0].identity.sourceItemId,
      plans[1].sourceItemId,
    );
    assert.equal(
      submittedFailures[0].identity.observationEpoch,
      plans[1].observationEpoch,
    );
    assert.equal(
      submittedFailures[0].identity.processingEpoch,
      plans[1].processingEpoch,
    );
    // The local budget is not spent yet (attempt 1 of MAX_PARSE_ATTEMPTS), so
    // the report leaves the server free to keep the work retryable.
    assert.equal(submittedFailures[0].exhausted, undefined);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a lost discovery.failArchived report does not block the pass from continuing", async () => {
  const setup = await fixture(0);
  const plans = [0, 1].map((index) =>
    pdfPlan({ relativePath: `document-${index}.pdf` }),
  );
  const checkpoint = archivedCheckpoint(plans[1], {
    files: plans,
    pdfIndex: 1,
    step: "parse",
    archivedPublished: 0,
    preflightAction: undefined,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  try {
    const runner = new PipelineRunner(setup.config, journal, {
      async call(request) {
        if (request.operation === "source.status") {
          return { operation: "source.status", sourceAccountId: "source" };
        }
        // The server-side inventory report is best-effort: losing it must
        // not turn back into a run-fatal error.
        throw new Error("network unreachable");
      },
    });
    runner.archiveCatalog = {
      findOriginalExact() {
        return undefined;
      },
      listOriginals() {
        return [
          { originalCatalogId: checkpoint.originalCatalogId, rowRevision: 1 },
        ];
      },
      listProcessings() {
        return [
          {
            processingCatalogId: checkpoint.processingCatalogId,
            originalCatalogId: checkpoint.originalCatalogId,
            rowRevision: 1,
          },
        ];
      },
      async recordParseFailure() {
        return {};
      },
    };
    runner.driveCheckpoint = async () => {
      if (journal.checkpoint.pdfIndex === 1) {
        throw new ParserProcessError("page_limit_exceeded", "too many pages");
      }
      return { state: "complete", scanned: 2, published: 1 };
    };
    const result = await runner.run();
    assert.deepEqual(result, { state: "complete", scanned: 2, published: 1 });
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

// P2-80g2: the server's attempt bound (8) is larger than the client's parse
// budget (MAX_PARSE_ATTEMPTS, 2), so the client tells the server when its own
// budget is spent. The budget belongs to the document, not to one catalog row:
// each pass probes `findProcessingExact` with its own scanId and a re-queued
// document lands on a brand new row, so a per-row count stayed at 1 forever,
// `exhausted` was never sent, and the same PDFs were re-parsed every pass.
test("the same document failing in two passes reports the second as exhausted", async () => {
  const plan = pdfPlan({ relativePath: "document-0.pdf" });
  const original = { originalCatalogId: randomUUID(), rowRevision: 1 };
  // One durable catalog across both passes. Every pass records its failure
  // against a fresh processing row for the same document identity, which is
  // exactly what `createArchivedIntents` does for a re-queued entry.
  const rows = [];
  // A fresh journal per pass, as a real pass has: only the durable archive
  // catalog carries over.
  async function pass(processingCatalogId) {
    const setup = await fixture(0);
    const checkpoint = archivedCheckpoint(plan, {
      files: [plan],
      pdfIndex: 0,
      step: "parse",
      archivedPublished: 0,
      preflightAction: undefined,
      originalCatalogId: original.originalCatalogId,
      processingCatalogId,
    });
    const journal = await openJournal(setup.journalDir, checkpoint);
    const submitted = [];
    try {
      const runner = new PipelineRunner(setup.config, journal, {
        async call(request) {
          if (request.operation === "source.status") {
            return { operation: "source.status", sourceAccountId: "source" };
          }
          if (request.operation === "discovery.failArchived") {
            submitted.push(request);
            return {
              operation: "discovery.failArchived",
              sourceItemId: request.identity.sourceItemId,
              workId: "work-1",
              state: "failed",
              retryable: request.exhausted !== true,
              failureCode: request.failureCode,
            };
          }
          throw new Error(`unexpected operation ${request.operation}`);
        },
      });
      const fingerprints = runner.processingFingerprints(plan);
      rows.push({
        processingCatalogId,
        originalCatalogId: original.originalCatalogId,
        rowRevision: 1,
        currentObservation: {
          scanId: `scan-${processingCatalogId}`,
          observationEpoch: plan.observationEpoch,
          processingEpoch: plan.processingEpoch,
        },
        fingerprints,
      });
      runner.archiveCatalog = {
        findOriginalExact() {
          return original;
        },
        listOriginals() {
          return [original];
        },
        listProcessings() {
          return rows;
        },
        async recordParseFailure(args) {
          const row = rows.find(
            (candidate) => candidate.processingCatalogId === args.catalogId,
          );
          row.parseFailure = {
            code: args.code,
            attempts: Math.min((row.parseFailure?.attempts ?? 0) + 1, 2),
            failedAt: args.now,
          };
          return row;
        },
      };
      let calls = 0;
      runner.driveCheckpoint = async () => {
        calls += 1;
        // Stands in for `driveArchivedParse` raising a document-level failure
        // while converting this PDF; the run's own loop records it and moves on.
        if (calls === 1) {
          throw new ParserProcessError("conversion_failed", "cannot convert");
        }
        return { state: "complete", scanned: 1, published: 0 };
      };
      assert.deepEqual(await runner.run(), {
        state: "complete",
        scanned: 1,
        published: 0,
      });
      return submitted;
    } finally {
      await journal.close();
      await rm(setup.base, { recursive: true, force: true });
    }
  }
  const first = await pass("11111111-1111-4111-8111-111111111111");
  assert.equal(first.length, 1);
  assert.equal(first[0].exhausted, undefined);
  const second = await pass("22222222-2222-4222-8222-222222222222");
  assert.equal(second.length, 1);
  assert.equal(second[0].failureCode, "conversion_failed");
  // Two rows, one attempt each: the document has spent its budget even though
  // no single row ever reached it.
  assert.equal(second[0].exhausted, true);

  // The server keeps the discovery disposition that produced the work row.
  // After the exhausted report that is still `queued`, but the metadata-first
  // scheduler must consume the durable local budget and walk on to a sibling
  // rather than issuing a third preflight for the failed selection.
  const setup = await fixture(0);
  const sibling = pdfPlan({
    relativePath: "sibling.pdf",
    sourceItemId: "sibling-item",
    sha256: "b".repeat(64),
  });
  const routing = {
    version: 1,
    triageStartIndex: 0,
    refreshReady: false,
    selected: [
      {
        sourceItemId: plan.sourceItemId,
        observationEpoch: plan.observationEpoch,
        processingEpoch: plan.processingEpoch,
        sha256: plan.sha256,
      },
    ],
    previewed: [],
    previewGaps: [],
    selectionReceipts: [],
  };
  const checkpoint = archivedCheckpoint(plan, {
    files: [plan, sibling],
    metadataFirst: routing,
    step: "preview",
    originalCatalogId: undefined,
    expectedOriginalRevision: undefined,
    processingCatalogId: undefined,
    expectedProcessingRevision: undefined,
    preflightAction: undefined,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const operations = [];
  try {
    const runner = new PipelineRunner(setup.config, journal, {
      async call(request) {
        operations.push(request.operation);
        throw new Error("scheduler must not call the server");
      },
    });
    runner.archiveCatalog = {
      findOriginalExact(identity) {
        return identity.sourceExternalId === plan.externalId
          ? original
          : undefined;
      },
      listOriginals() {
        return [original];
      },
      listProcessings() {
        return rows;
      },
    };
    const next = await runner.nextMetadataCheckpoint(checkpoint, routing, 0);
    assert.equal(next.phase, "archived");
    assert.equal(next.pdfIndex, 1);
    assert.equal(next.step, "preview");
    assert.deepEqual(next.metadataFirst.selected, routing.selected);
    assert.deepEqual(operations, []);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a document stops being selected for archived work once its local parse attempts are exhausted", async () => {
  async function reconcile(processingRows) {
    const setup = await fixture(0);
    const plan = pdfPlan({ discoveryState: "unchanged" });
    const checkpoint = parseRunnerCheckpoint({
      version: 1,
      phase: "reconcile",
      mode: "normal",
      scanId: `scan-${randomUUID()}`,
      inventoryEpoch: 1,
      manifestVersion: 1,
      missingBindings: [],
      files: [plan],
      ordinal: 0,
      reviewSeen: false,
    });
    const journal = await openJournal(setup.journalDir, checkpoint);
    const original = { originalCatalogId: randomUUID(), rowRevision: 1 };
    const runner = new PipelineRunner(setup.config, journal, {
      async call() {
        return {
          operation: "scan.reconcile",
          scanId: checkpoint.scanId,
          done: true,
          state: "enumerated",
          inspected: 0,
          unavailable: 0,
          reused: false,
        };
      },
    });
    const fingerprints = runner.processingFingerprints(plan);
    runner.archiveCatalog = {
      findOriginalExact() {
        return original;
      },
      listOriginals() {
        return [original];
      },
      async recordAdmissionBlock() {
        return original;
      },
      listProcessings() {
        return processingRows.map((row) => ({
          originalCatalogId: original.originalCatalogId,
          currentObservation: {
            scanId: "prior-scan",
            observationEpoch: plan.observationEpoch,
            processingEpoch: plan.processingEpoch,
          },
          fingerprints,
          ...row,
        }));
      },
    };
    try {
      await runner.driveReconcile();
      return journal.checkpoint;
    } finally {
      await journal.close();
      await rm(setup.base, { recursive: true, force: true });
    }
  }

  // One prior failure: still below the bound, a rerun tries again.
  assert.equal(
    (
      await reconcile([
        {
          activation: undefined,
          parseFailure: { code: "conversion_failed", attempts: 1, failedAt: 1 },
        },
      ])
    ).phase,
    "archived",
  );
  // Two prior failures (the bound): a rerun leaves it `parse_failed` and
  // moves straight past the archived phase without retrying it.
  assert.equal(
    (
      await reconcile([
        {
          activation: undefined,
          parseFailure: { code: "conversion_failed", attempts: 2, failedAt: 1 },
        },
      ])
    ).phase,
    "discovery_reserve",
  );
});

test("publishes a bounded multi-page scan and stores only metadata after completion", async () => {
  const setup = await fixture(9);
  const cloud = new CompleteCloud();
  const journal = await openJournal(setup.journalDir);
  try {
    const result = await new PipelineRunner(setup.config, journal, cloud).run();
    assert.equal(result.state, "complete");
    assert.equal(result.scanned, 9);
    assert.equal(result.published, 9);
    assert.equal(journal.pending, undefined);
    assert.equal(journal.checkpoint.phase, "terminal");
    assert.equal(journal.checkpoint.bindings.length, 9);
    const stored = await readFile(join(setup.journalDir, "state.json"), "utf8");
    assert.equal(stored.includes("synthetic-"), false);
    assert.equal(stored.includes(setup.root), false);
    assert.equal(
      cloud.operations.filter((operation) => operation === "scan.appendPage")
        .length,
      3,
    );
    assert.equal(
      cloud.operations.filter((operation) => operation === "jobs.activate")
        .length,
      9,
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a deferred PDF still lets a UTF-8 sibling publish before the parked result", async () => {
  const setup = await fixture(1);
  const utfPath = join(setup.root, "file-0.txt");
  const bytes = await readFile(utfPath);
  const entry = await lstat(utfPath);
  const utf = {
    rootAlias: "fixture",
    relativePath: "file-0.txt",
    sourceModifiedAt: Math.trunc(entry.mtimeMs),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    externalId: randomUUID(),
  };
  const pdf = pdfPlan({
    relativePath: "unknown.pdf",
    sourceItemId: "source-pdf",
    observationEpoch: 1,
    processingEpoch: 1,
    discoveryState: "queued",
  });
  const checkpoint = parseRunnerCheckpoint({
    version: 1,
    phase: "archived",
    mode: "normal",
    scanId: "scan_1",
    inventoryEpoch: 1,
    manifestVersion: 1,
    missingBindings: [],
    files: [pdf, utf],
    pdfIndex: 0,
    step: "preview",
    reservationRound: 0,
    archivedPublished: 0,
    metadataFirst: {
      version: 1,
      triageStartIndex: 0,
      refreshReady: false,
      selected: [],
      previewed: [],
      selectionReceipts: [],
    },
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const cloud = new CompleteCloud();
  cloud.scanId = "scan_1";
  cloud.inventoryEpoch = 1;
  cloud.manifestVersion = 1;
  cloud.enumerated = true;
  cloud.discoveryQueue.push({
    workId: "work-utf8",
    jobId: "job-utf8",
    sourceItemId: "source-utf8",
    uri: toFsUri(utf.rootAlias, utf.relativePath),
    contentHash: utf.sha256,
    byteLength: utf.byteLength,
  });
  const transport = {
    async call(request) {
      if (request.operation === "discovery.recordPreview") {
        cloud.operations.push(request.operation);
        return {
          operation: "discovery.recordPreview",
          previewId: randomUUID(),
          sourceItemId: request.identity.sourceItemId,
          observedContentHash: request.identity.contentHash,
          previewFingerprint: request.preview.previewFingerprint,
          state: "provisional",
          reused: false,
        };
      }
      return await cloud.call(request);
    },
  };
  const runner = new PipelineRunner(
    setup.config,
    journal,
    transport,
    undefined,
    undefined,
    undefined,
    async () => ({
      sourceSha256: pdf.sha256,
      mediaType: "application/pdf",
      sourceUnitCount: 3,
      inspectedOriginalUnits: [1, 2],
      unitStates: ["text_available", "text_available"],
      unitTexts: ["Synthetic cover", "Synthetic unknown document"],
      unitTextTruncated: [false, false],
      method: "pdf_native_text_v1",
      methodFingerprint: "e".repeat(64),
    }),
  );
  try {
    let result;
    for (let step = 0; step < 40 && !result; step += 1) {
      result = await runner.driveCheckpoint();
    }
    assert.deepEqual(result, {
      state: "incomplete",
      code: "metadata_only_deferred",
      scanned: 2,
      published: 1,
    });
    assert.equal(journal.checkpoint.phase, "archived");
    assert.equal(journal.checkpoint.step, "deferred_idle");
    assert.equal(journal.checkpoint.metadataFirst.refreshReady, true);
    const stored = JSON.parse(
      await readFile(join(setup.journalDir, "state.json"), "utf8"),
    );
    assert.equal(stored.pending, undefined);
    assert.equal(stored.credentialSessionActive, false);
    assert.ok(cloud.operations.includes("discovery.admitUtf8"));
    assert.ok(cloud.operations.includes("jobs.activate"));
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

// P2-80h: a settled parse failure is parked, not a reason to keep reporting
// `incomplete`. The pass ends `complete` with no code, so a scheduled watcher
// stops rerunning the same documents. `PipelineRunResult` carries no counts, so
// the parked count is read from the assessment result and `doctor`, not here.
test("a complete assessment with parked documents ends the pass complete", async () => {
  const setup = await fixture(0);
  const journal = await openJournal(setup.journalDir, assessPageCheckpoint());
  try {
    const runner = new PipelineRunner(setup.config, journal, {
      async call(request) {
        if (request.operation === "source.status") {
          return { operation: "source.status", sourceAccountId: "source" };
        }
        assert.equal(request.operation, "processing.assessPage");
        return assessPageResponse(request.ordinal, "complete", {
          parked: 7,
          explicitGap: 24,
        });
      },
    });
    const result = await runner.run();
    assert.equal(result.state, "complete");
    assert.equal(result.code, undefined);
    assert.equal(journal.pending, undefined);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("an assess_page rate limit retries with backoff and completes", async () => {
  const setup = await fixture(0);
  const checkpoint = assessPageCheckpoint();
  const journal = await openJournal(setup.journalDir, checkpoint);
  let assessPageCalls = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const runner = new PipelineRunner(
      setup.config,
      journal,
      {
        async call(request) {
          if (request.operation === "source.status") {
            return { operation: "source.status", sourceAccountId: "source" };
          }
          assert.equal(request.operation, "processing.assessPage");
          assessPageCalls += 1;
          if (assessPageCalls <= 2) {
            return { error: { code: "rate_limited" } };
          }
          return assessPageResponse(request.ordinal, "complete");
        },
      },
      { windowMs: 30, maxAttempts: 8 },
    );
    const result = await runner.run();
    assert.equal(result.state, "complete");
    assert.equal(assessPageCalls, 3);
    assert.equal(journal.pending, undefined);
    assert.equal(
      warnings.filter((line) => line.includes("retrying in")).length,
      2,
    );
  } finally {
    console.warn = originalWarn;
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("an assess_page rate limit that never clears fails cleanly and leaves the journal safe to resume", async () => {
  const setup = await fixture(0);
  const checkpoint = assessPageCheckpoint();
  const journal = await openJournal(setup.journalDir, checkpoint);
  let assessPageCalls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const runner = new PipelineRunner(
      setup.config,
      journal,
      {
        async call(request) {
          if (request.operation === "source.status") {
            return { operation: "source.status", sourceAccountId: "source" };
          }
          assert.equal(request.operation, "processing.assessPage");
          assessPageCalls += 1;
          return { error: { code: "rate_limited" } };
        },
      },
      { windowMs: 20, maxAttempts: 4 },
    );
    const result = await runner.runSafely();
    assert.deepEqual(result, { state: "failed", code: "rate_limited" });
    assert.equal(assessPageCalls, 4);
    assert.equal(journal.pending, undefined);
    assert.equal(journal.checkpoint.phase, "terminal");
    assert.equal(journal.checkpoint.code, "rate_limited");
  } finally {
    console.warn = originalWarn;
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("assessmentPacingMs paces consecutive assess_page mutations", async () => {
  const setup = await fixture(0);
  const checkpoint = assessPageCheckpoint();
  const journal = await openJournal(setup.journalDir, checkpoint);
  const callTimes = [];
  try {
    const runner = new PipelineRunner(
      { ...setup.config, assessmentPacingMs: 150 },
      journal,
      {
        async call(request) {
          if (request.operation === "source.status") {
            return { operation: "source.status", sourceAccountId: "source" };
          }
          assert.equal(request.operation, "processing.assessPage");
          callTimes.push(Date.now());
          return assessPageResponse(
            request.ordinal,
            request.ordinal >= 1 ? "complete" : "running",
          );
        },
      },
    );
    const result = await runner.run();
    assert.equal(result.state, "complete");
    assert.equal(callTimes.length, 2);
    assert.ok(
      callTimes[1] - callTimes[0] >= 140,
      `expected consecutive assess_page calls to be paced by ~150ms, got ${callTimes[1] - callTimes[0]}ms`,
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a config that omits assessmentPacingMs still paces consecutive assess_page mutations by default (P2-80k)", async () => {
  const setup = await fixture(0);
  const checkpoint = assessPageCheckpoint();
  const journal = await openJournal(setup.journalDir, checkpoint);
  const callTimes = [];
  try {
    assert.equal(setup.config.assessmentPacingMs, undefined);
    const runner = new PipelineRunner(setup.config, journal, {
      async call(request) {
        if (request.operation === "source.status") {
          return { operation: "source.status", sourceAccountId: "source" };
        }
        assert.equal(request.operation, "processing.assessPage");
        callTimes.push(Date.now());
        return assessPageResponse(
          request.ordinal,
          request.ordinal >= 1 ? "complete" : "running",
        );
      },
    });
    const result = await runner.run();
    assert.equal(result.state, "complete");
    assert.equal(callTimes.length, 2);
    assert.ok(
      callTimes[1] - callTimes[0] >= 190,
      `expected the default assessment pacing (~200ms) to apply when the config omits assessmentPacingMs, got ${callTimes[1] - callTimes[0]}ms`,
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("replays an exact lost stage response and finishes while the root is offline", async () => {
  const setup = await fixture();
  const cloud = new CompleteCloud({ failFirstStage: true });
  let journal = await openJournal(setup.journalDir);
  const first = await new PipelineRunner(
    setup.config,
    journal,
    cloud,
  ).runSafely();
  assert.equal(first.state, "failed");
  assert.equal(journal.pending?.operation, "jobs.stageUtf8");
  const exactPending = journal.pending.requestBody;
  await journal.close();

  const offlineRoot = join(setup.base, "offline-root");
  await rename(setup.root, offlineRoot);
  journal = await openJournal(setup.journalDir);
  try {
    const second = await new PipelineRunner(setup.config, journal, cloud).run();
    assert.equal(second.state, "complete");
    assert.equal(second.published, 1);
    assert.equal(cloud.stageBodies.length, 2);
    assert.equal(cloud.stageBodies[0], exactPending);
    assert.equal(cloud.stageBodies[1], exactPending);
    assert.equal(
      cloud.operations.filter((operation) => operation === "jobs.activate")
        .length,
      1,
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("abandons a scan_not_ready replay and starts a fresh scan in the same run", async () => {
  const setup = await fixture(1);
  const cloud = new CompleteCloud({ failAppendOnce: true });
  let journal = await openJournal(setup.journalDir);
  const first = await new PipelineRunner(
    setup.config,
    journal,
    cloud,
  ).runSafely();
  assert.equal(first.state, "failed");
  assert.equal(journal.pending?.operation, "scan.appendPage");
  await journal.close();

  journal = await openJournal(setup.journalDir);
  try {
    const second = await new PipelineRunner(setup.config, journal, cloud).run();
    assert.equal(second.state, "complete");
    assert.equal(second.published, 1);
    assert.equal(journal.pending, undefined);
    assert.equal(
      cloud.operations.filter((operation) => operation === "scan.begin").length,
      2,
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("rejects a phase-parent-tampered pending call before transport", async () => {
  const setup = await fixture();
  const cloud = new CompleteCloud({ failFirstStage: true });
  let journal = await openJournal(setup.journalDir);
  const first = await new PipelineRunner(
    setup.config,
    journal,
    cloud,
  ).runSafely();
  assert.equal(first.state, "failed");
  await journal.close();

  const statePath = join(setup.journalDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const body = JSON.parse(state.pending.requestBody);
  body.jobId = "different_job";
  state.pending.requestBody = JSON.stringify(body);
  state.pending.requestDigest = createHash("sha256")
    .update(state.pending.requestBody)
    .digest("hex");
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

  journal = await openJournal(setup.journalDir);
  try {
    const before = cloud.stageBodies.length;
    const second = await new PipelineRunner(
      setup.config,
      journal,
      cloud,
    ).runSafely();
    assert.equal(second.state, "failed");
    assert.equal(second.code, "journal_phase_conflict");
    assert.equal(cloud.stageBodies.length, before);
    assert.equal(journal.pending.requestBody, state.pending.requestBody);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("an intact-journal rename stops for identity review without reconciling absence", async () => {
  const setup = await fixture(0);
  const oldPath = "fixture.txt";
  const newPath = "renamed.txt";
  const externalId = randomUUID();
  await writeFile(join(setup.root, newPath), "renamed synthetic");
  const initial = {
    version: 1,
    phase: "terminal",
    outcome: "complete",
    credentialSessionActive: false,
    bindings: [{ rootAlias: "fixture", relativePath: oldPath, externalId }],
    scanned: 1,
    published: 1,
  };
  const operations = [];
  const transport = {
    async call(request) {
      operations.push(request.operation);
      if (request.operation === "source.status") {
        return {
          operation: "source.status",
          sourceAccountId: "source",
          inventoryEpoch: 1,
          completedInventoryEpoch: 1,
          manifestVersion: 1,
          enumeration: {
            state: "complete",
            scanId: "old_scan",
            completedAt: 1,
          },
          processing: { state: "not_assessed" },
          recordCoverage: "not_established",
        };
      }
      if (request.operation === "scan.begin") {
        assert.equal(request.mode, "identity_recovery");
        return {
          operation: "scan.begin",
          scanId: "recovery_scan",
          inventoryEpoch: 2,
          manifestVersion: 2,
          state: "open",
          reused: false,
        };
      }
      if (request.operation === "source.inventoryPage") {
        return {
          operation: "source.inventoryPage",
          page: [
            {
              lifecycle: "available",
              sourceItemId: "old_item",
              externalId,
              uri: "fs://fixture/fixture.txt",
              observationEpoch: 1,
              processingEpoch: 1,
            },
          ],
          isDone: true,
          continueCursor: "done",
        };
      }
      if (request.operation === "scan.appendPage") {
        assert.equal(request.entries.length, 1);
        assert.equal(request.entries[0].externalId, undefined);
        return {
          operation: "scan.appendPage",
          scanId: "recovery_scan",
          ordinal: 0,
          reused: false,
          entries: [{ state: "needs_review" }],
        };
      }
      if (request.operation === "scan.seal") {
        return {
          operation: "scan.seal",
          scanId: "recovery_scan",
          state: "needs_review",
          reused: false,
        };
      }
      throw new Error(`unexpected operation ${request.operation}`);
    },
  };
  const journal = await openJournal(setup.journalDir, initial);
  try {
    const result = await new PipelineRunner(
      setup.config,
      journal,
      transport,
    ).run();
    assert.deepEqual(result, {
      state: "incomplete",
      code: "identity_review_required",
      scanned: 1,
      published: 0,
    });
    assert.equal(operations.includes("scan.reconcile"), false);
    assert.deepEqual(journal.checkpoint.bindings, initial.bindings);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a missing known root fails before any mutating request", async () => {
  const setup = await fixture();
  const initial = {
    version: 1,
    phase: "terminal",
    outcome: "complete",
    credentialSessionActive: false,
    bindings: [
      {
        rootAlias: "fixture",
        relativePath: "file-0.txt",
        externalId: randomUUID(),
      },
    ],
    scanned: 1,
    published: 1,
  };
  await rename(setup.root, join(setup.base, "offline"));
  const operations = [];
  const transport = {
    async call(request) {
      operations.push(request.operation);
      return {
        operation: "source.status",
        sourceAccountId: "source",
        inventoryEpoch: 1,
        completedInventoryEpoch: 1,
        manifestVersion: 1,
        enumeration: { state: "complete", completedAt: 1 },
        processing: { state: "not_assessed" },
        recordCoverage: "not_established",
      };
    },
  };
  const journal = await openJournal(setup.journalDir, initial);
  try {
    const result = await new PipelineRunner(
      setup.config,
      journal,
      transport,
    ).runSafely();
    assert.equal(result.state, "failed");
    // Nothing that could change what the server holds about this account. The
    // report of how the pass ended (ADM-9) is the one write, and it is sent
    // after the pass is already decided; the scan, the inventory and the
    // reconcile are all untouched.
    assert.deepEqual(operations, ["source.status", "diagnostics.passOutcome"]);
    assert.equal(journal.checkpoint.phase, "terminal");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

function archiveCopy(role) {
  const archiveObjectId = randomUUID();
  return {
    role,
    clientReceiptId: randomUUID(),
    archiveObjectId,
    objectName: `${archiveObjectId}.age`,
    archiveIdentityFingerprint: HASH,
    archiveProfileFingerprint: HASH,
    recipientFingerprint: HASH,
    repositoryKeyDomainFingerprint: HASH,
    storageFailureDomainFingerprint: HASH,
    ...(role === "independent_backup"
      ? {
          restic: {
            operationId: randomUUID(),
            host: "test-host",
            repositoryId: HASH,
          },
        }
      : {}),
  };
}

async function replayableArchiveCopy(directory, role, readbackVerifiedAt) {
  const copy = archiveCopy(role);
  const bytes = Buffer.from(`ciphertext-${role}`);
  const objectPath = join(directory, copy.objectName);
  await writeFile(objectPath, bytes, { mode: 0o600 });
  const [file, root] = await Promise.all([lstat(objectPath), lstat(directory)]);
  const source = { sha256: HASH, byteLength: 10 };
  const ciphertext = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  };
  return {
    ...copy,
    preparationIntent: { tempName: `${copy.archiveObjectId}.tmp` },
    prepared: {
      state: "prepared",
      tempName: `${copy.archiveObjectId}.tmp`,
      source,
      ciphertext,
      ciphertextDevice: file.dev,
      ciphertextInode: file.ino,
      archiveDirectoryDevice: root.dev,
      archiveDirectoryInode: root.ino,
      ageVersion: "v1.3.2",
    },
    published: {
      state: "published",
      source,
      ciphertext,
      ciphertextDevice: file.dev,
      ciphertextInode: file.ino,
      ageVersion: "v1.3.2",
    },
    readbackVerifiedAt,
  };
}

test("primary publish replay reuses cataloged readback time after checkpoint loss", async () => {
  const setup = await fixture(0);
  const requestedPrimaryDirectory = join(setup.base, "primary");
  const requestedBackupDirectory = join(setup.base, "backup");
  await Promise.all(
    [requestedPrimaryDirectory, requestedBackupDirectory].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );
  const [primaryDirectory, backupDirectory] = await Promise.all([
    realpath(requestedPrimaryDirectory),
    realpath(requestedBackupDirectory),
  ]);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  const primary = await replayableArchiveCopy(primaryDirectory, "primary", 25);
  const original = {
    originalCatalogId: checkpoint.originalCatalogId,
    rowRevision: 8,
    copies: {
      primary,
      independent_backup: archiveCopy("independent_backup"),
    },
  };
  const runner = new PipelineRunner(
    {
      ...setup.config,
      pdfDocQa: {
        archive: {
          primary: { directory: primaryDirectory },
          independentBackup: { directory: backupDirectory },
        },
      },
    },
    journal,
    { async call() {} },
  );
  runner.archivedRows = () => ({ original, processing: {} });
  runner.archiveCatalog = {
    async recordArchivePublished(args) {
      assert.equal(args.readbackVerifiedAt, primary.readbackVerifiedAt);
      assert.deepEqual(args.published, primary.published);
      return { ...original, rowRevision: original.rowRevision + 1 };
    },
  };
  try {
    const next = await runner.recordArchiveAction(
      checkpoint,
      "original_primary_publish",
    );
    assert.equal(next.step, "original_archive");
    assert.equal(next.expectedOriginalRevision, original.rowRevision + 1);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("backup snapshot replay reuses cataloged result and readback time", async () => {
  const setup = await fixture(0);
  const requestedPrimaryDirectory = join(setup.base, "primary");
  const requestedBackupDirectory = join(setup.base, "backup");
  await Promise.all(
    [requestedPrimaryDirectory, requestedBackupDirectory].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );
  const [primaryDirectory, backupDirectory] = await Promise.all([
    realpath(requestedPrimaryDirectory),
    realpath(requestedBackupDirectory),
  ]);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    preflightAction: "original_backup_snapshot",
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const backup = await replayableArchiveCopy(
    backupDirectory,
    "independent_backup",
    26,
  );
  backup.backup = {
    operationId: backup.restic.operationId,
    snapshotId: "snapshot-existing",
    objectName: backup.objectName,
    ciphertext: backup.published.ciphertext,
    resticVersion: "0.19.1",
    repositoryId: backup.restic.repositoryId,
    verification: "destination_ciphertext_readback",
    boundary: {
      mode: "synthetic",
      readiness: "synthetic_only",
      primaryDevice: 1,
      backupDevice: 2,
    },
  };
  const recovered = {
    operationId: backup.restic.operationId,
    snapshotId: "snapshot-existing",
    matchingSnapshotCount: 1,
    objectName: backup.objectName,
    ciphertext: backup.published.ciphertext,
    resticVersion: "0.19.1",
    repositoryId: backup.restic.repositoryId,
    verification: "destination_ciphertext_readback",
  };
  const original = {
    originalCatalogId: checkpoint.originalCatalogId,
    rowRevision: 9,
    copies: { primary: archiveCopy("primary"), independent_backup: backup },
  };
  const runner = new PipelineRunner(
    {
      ...setup.config,
      pdfDocQa: {
        archive: {
          primary: { directory: primaryDirectory },
          independentBackup: { directory: backupDirectory },
        },
      },
    },
    journal,
    { async call() {} },
  );
  runner.archivedRows = () => ({ original, processing: {} });
  runner.archiveCatalog = {
    async recordResticBackup(args) {
      assert.equal(args.readbackVerifiedAt, backup.readbackVerifiedAt);
      assert.deepEqual(args.backup, backup.backup);
      return { ...original, rowRevision: original.rowRevision + 1 };
    },
  };
  try {
    const next = await runner.recordArchiveAction(
      checkpoint,
      "original_backup_snapshot",
      recovered,
    );
    assert.equal(next.step, "original_archive");
    assert.equal(next.expectedOriginalRevision, original.rowRevision + 1);
    await assert.rejects(
      () =>
        runner.recordArchiveAction(checkpoint, "original_backup_snapshot", {
          ...recovered,
          snapshotId: "snapshot-replacement",
        }),
      (error) => error.code === "archive_backup_recovery_conflict",
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("backup replay accepts a changed remote root only for the cataloged artifact relocation", async () => {
  const setup = await fixture(0);
  const requestedPrimaryDirectory = join(setup.base, "primary");
  const requestedBackupDirectory = join(setup.base, "backup");
  await Promise.all(
    [requestedPrimaryDirectory, requestedBackupDirectory].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );
  const [primaryDirectory, backupDirectory] = await Promise.all([
    realpath(requestedPrimaryDirectory),
    realpath(requestedBackupDirectory),
  ]);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    preflightAction: "original_backup_snapshot",
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const backup = await replayableArchiveCopy(
    backupDirectory,
    "independent_backup",
    26,
  );
  const oldBoundary = {
    mode: "independent_backup",
    readiness: "remote_repository_verified",
    backend: "rclone_dropbox_v1",
    remoteName: "kithmind_dropbox",
    rootPath: "Kith Mind Backups/processing-artifacts/restic-v1",
    rootDirectoryIdHash: "b".repeat(64),
    configIdentityFingerprint: "c".repeat(64),
    repositoryId: "d".repeat(64),
    resticVersion: "0.19.1",
    rcloneVersion: "v1.74.4",
  };
  const newBoundary = {
    ...oldBoundary,
    rootPath: "Kith Mind/backups/processing-artifacts/restic-v1",
  };
  backup.restic.repositoryId = oldBoundary.repositoryId;
  backup.backup = {
    operationId: backup.restic.operationId,
    snapshotId: "e".repeat(64),
    objectName: backup.objectName,
    ciphertext: backup.published.ciphertext,
    resticVersion: "0.19.1",
    repositoryId: oldBoundary.repositoryId,
    verification: "destination_ciphertext_readback",
    boundary: oldBoundary,
  };
  const recovered = {
    operationId: backup.restic.operationId,
    snapshotId: backup.backup.snapshotId,
    matchingSnapshotCount: 1,
    objectName: backup.objectName,
    ciphertext: backup.published.ciphertext,
    resticVersion: "0.19.1",
    repositoryId: oldBoundary.repositoryId,
    verification: "destination_ciphertext_readback",
    boundary: newBoundary,
  };
  const original = {
    originalCatalogId: checkpoint.originalCatalogId,
    rowRevision: 9,
    copies: { primary: archiveCopy("primary"), independent_backup: backup },
  };
  let allow = true;
  const runner = new PipelineRunner(
    {
      ...setup.config,
      pdfDocQa: {
        archive: {
          primary: { directory: primaryDirectory },
          independentBackup: { directory: backupDirectory },
        },
      },
    },
    journal,
    { async call() {} },
  );
  runner.archivedRows = () => ({ original, processing: {} });
  runner.archiveCatalog = {
    resolvesBoundaryRelocation(args) {
      assert.deepEqual(args, {
        oldBoundary,
        newBoundary,
        artifact: {
          snapshotId: backup.backup.snapshotId,
          objectName: backup.backup.objectName,
          ciphertextSha256: backup.backup.ciphertext.sha256,
          ciphertextByteLength: backup.backup.ciphertext.byteLength,
        },
      });
      return allow;
    },
    async recordResticBackup() {
      return { ...original, rowRevision: original.rowRevision + 1 };
    },
  };
  try {
    const next = await runner.recordArchiveAction(
      checkpoint,
      "original_backup_snapshot",
      recovered,
    );
    assert.equal(next.step, "original_archive");
    allow = false;
    await assert.rejects(
      () =>
        runner.recordArchiveAction(
          checkpoint,
          "original_backup_snapshot",
          recovered,
        ),
      (error) => error.code === "archive_backup_recovery_conflict",
    );
    await assert.rejects(
      () =>
        runner.recordArchiveAction(checkpoint, "original_backup_snapshot", {
          ...recovered,
          boundary: undefined,
        }),
      (error) => error.code === "archive_backup_recovery_conflict",
      "a remote historical receipt cannot replay without a remote boundary",
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("ordinary replay refuses an answered legacy locator action without invoking backup work", async () => {
  const setup = await fixture(0);
  const age = join(setup.base, "age");
  const restic = join(setup.base, "restic");
  await writeFile(age, "#!/bin/sh\nprintf 'v1.3.2\\n'\n", { mode: 0o700 });
  await writeFile(
    restic,
    "#!/bin/sh\nprintf 'restic 0.19.1 compiled with go1.25 on darwin/arm64\\n'\n",
    { mode: 0o700 },
  );
  const canonicalAge = await realpath(age);
  const canonicalRestic = await realpath(restic);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    preflightAction: "provider_locator_snapshot",
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const original = {
    originalCatalogId: checkpoint.originalCatalogId,
    copies: { primary: archiveCopy("primary") },
    providerOriginal: {
      clientReferenceId: randomUUID(),
      bindingId: randomUUID(),
      locator: archiveCopy("independent_backup"),
    },
  };
  const processing = {
    processingCatalogId: checkpoint.processingCatalogId,
    copies: {
      primary: archiveCopy("primary"),
      independent_backup: archiveCopy("independent_backup"),
    },
  };
  const identity = {
    sourceItemId: plan.sourceItemId,
    scanId: checkpoint.scanId,
    observationEpoch: plan.observationEpoch,
    processingEpoch: plan.processingEpoch,
    contentHash: plan.sha256,
    byteLength: plan.byteLength,
    mediaType: "application/pdf",
    parserProfileId: plan.parserProfileId,
    parserFingerprint: plan.parserFingerprint,
    extractionConfigurationFingerprint: plan.extractionConfigurationFingerprint,
    extractorFingerprint: plan.extractorFingerprint,
    recordSchemaFingerprint: plan.recordSchemaFingerprint,
    normalizationFingerprint: plan.normalizationFingerprint,
    chunkerFingerprint: plan.chunkerFingerprint,
    correctionRevision: plan.correctionRevision,
  };
  const requestId = randomUUID();
  const body = {
    protocolVersion: 1,
    operation: "discovery.preflightArchived",
    spaceId: "space",
    sourceAccountId: "source",
    requestId,
    identity,
    archiveIntentDigest: digestArchiveIntent({
      identity,
      original,
      processing,
    }),
  };
  await journal.planRequest({
    operation: body.operation,
    requestId,
    requestBody: JSON.stringify(body),
    createdAt: 1,
  });
  await journal.recordValidatedResult(
    {
      operation: body.operation,
      sourceItemId: plan.sourceItemId,
      workId: "work",
      expectedDesiredProcessingEpoch: plan.processingEpoch,
      archiveIntentDigest: body.archiveIntentDigest,
    },
    2,
  );
  const sent = [];
  const runner = new PipelineRunner(
    {
      ...setup.config,
      pdfDocQa: {
        archive: {
          ageBinary: canonicalAge,
          independentBackup: { resticBinary: canonicalRestic },
        },
      },
    },
    journal,
    {
      async call(request) {
        sent.push(request);
        return { error: { code: "not_authorized" } };
      },
    },
  );
  let published = 0;
  runner.archivedRows = () => ({ original, processing });
  runner.recordArchiveAction = async () => {
    published += 1;
    throw new Error("provider side effect must not run");
  };
  try {
    await assert.rejects(
      () => runner.settleAnsweredArchivedRequest(),
      (error) => error.code === "provider_v2_transition_required",
    );
    assert.equal(published, 0);
    assert.deepEqual(sent, []);
    assert.ok(journal.pending?.result);
    assert.equal(journal.checkpoint.phase, "archived");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("provider v2 transition restarts after catalog persistence without weakening pending-body validation", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    preflightAction: "provider_locator_snapshot",
  });
  let journal = await openJournal(setup.journalDir, checkpoint);
  const catalog = await openArchiveCatalog({ journal });
  const originalInput = {
    originalCatalogId: checkpoint.originalCatalogId,
    sourceExternalId: plan.externalId,
    origin: {
      scanId: checkpoint.scanId,
      observationEpoch: plan.observationEpoch,
      sha256: plan.sha256,
      byteLength: plan.byteLength,
      mediaType: "application/pdf",
    },
    copies: { primary: archiveCopy("primary") },
    providerOriginal: {
      clientReferenceId: randomUUID(),
      bindingId: randomUUID(),
      locator: archiveCopy("independent_backup"),
    },
    createdAt: 1,
  };
  const original = await catalog.createOriginalIntent(originalInput);
  const parserBackup = archiveCopy("independent_backup");
  for (const field of [
    "archiveIdentityFingerprint",
    "archiveProfileFingerprint",
    "recipientFingerprint",
    "repositoryKeyDomainFingerprint",
    "storageFailureDomainFingerprint",
  ])
    parserBackup[field] = "b".repeat(64);
  const processing = await catalog.createProcessingIntent({
    processingCatalogId: checkpoint.processingCatalogId,
    originalCatalogId: checkpoint.originalCatalogId,
    currentObservation: {
      scanId: checkpoint.scanId,
      observationEpoch: plan.observationEpoch,
      processingEpoch: plan.processingEpoch,
    },
    fingerprints: {
      parserFingerprint: plan.parserFingerprint,
      extractionConfigurationFingerprint:
        plan.extractionConfigurationFingerprint,
      discoveryProfileFingerprint: "b".repeat(64),
      processingPolicyFingerprint: "c".repeat(64),
      correctionFingerprint: "d".repeat(64),
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
      primary: archiveCopy("primary"),
      independent_backup: parserBackup,
    },
    createdAt: 1,
  });
  const identity = archivedCheckpointIdentity(checkpoint, plan);
  const requestId = randomUUID();
  const body = {
    protocolVersion: 1,
    operation: "discovery.preflightArchived",
    spaceId: "space",
    sourceAccountId: "source",
    requestId,
    identity,
    archiveIntentDigest: digestArchiveIntent({
      identity,
      original,
      processing,
    }),
  };
  await journal.planRequest({
    operation: body.operation,
    requestId,
    requestBody: JSON.stringify(body),
    createdAt: 1,
  });
  await journal.recordValidatedResult(
    {
      operation: body.operation,
      sourceItemId: plan.sourceItemId,
      workId: "work",
      expectedDesiredProcessingEpoch: plan.processingEpoch - 1,
      archiveIntentDigest: body.archiveIntentDigest,
    },
    2,
  );
  const noTransport = {
    async call() {
      throw new Error("transition must not call the server");
    },
  };
  try {
    const first = await new PipelineRunner(
      setup.config,
      journal,
      noTransport,
    ).prepareProviderV2Transition();
    assert.equal(first.step, "parser_archive");
    assert.ok(
      journal.pending?.result,
      "journal half was intentionally not committed",
    );
    const converted = await openArchiveCatalog({ journal });
    const convertedOriginal = converted.listOriginals()[0];
    const convertedProcessing = converted.listProcessings()[0];
    assert.equal(
      convertedOriginal.providerOriginal.referenceVersion,
      "provider_original_v2",
    );
    assert.deepEqual(
      convertedOriginal.providerOriginal.legacyPrimary,
      original.copies.primary,
    );
    assert.deepEqual(
      convertedOriginal.providerOriginal.legacyLocator,
      original.providerOriginal.locator,
    );
    assert.deepEqual(
      convertedProcessing.legacyIndependentBackup,
      processing.copies.independent_backup,
    );
    assert.deepEqual(Object.keys(convertedOriginal.copies), []);
    assert.deepEqual(Object.keys(convertedProcessing.copies), ["primary"]);

    await journal.close();
    journal = await openJournal(setup.journalDir);
    const restarted = await new PipelineRunner(
      setup.config,
      journal,
      noTransport,
    ).prepareProviderV2Transition();
    assert.deepEqual(restarted, first);

    const changedBody = JSON.parse(journal.pending.requestBody);
    changedBody.archiveIntentDigest = "f".repeat(64);
    const saved = journal.pending.requestBody;
    journal.state.pending.requestBody = JSON.stringify(changedBody);
    await assert.rejects(
      () =>
        new PipelineRunner(
          setup.config,
          journal,
          noTransport,
        ).prepareProviderV2Transition(),
      (error) => error.code === "journal_phase_conflict",
    );
    journal.state.pending.requestBody = saved;
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a durable provider admission replay does not expire its persisted declaration", async () => {
  const setup = await fixture(0);
  const journal = await openJournal(setup.journalDir);
  const runner = new PipelineRunner(setup.config, journal, {
    async call() {
      throw new Error("unused");
    },
  });
  const locator = archiveCopy("independent_backup");
  locator.published = {
    state: "published",
    source: { sha256: HASH, byteLength: 100 },
    ciphertext: { sha256: "b".repeat(64), byteLength: 200 },
    ciphertextDevice: 1,
    ciphertextInode: 2,
    ageVersion: "v1.3.2",
  };
  locator.backup = {
    operationId: locator.restic.operationId,
    snapshotId: "c".repeat(64),
    objectName: locator.objectName,
    ciphertext: locator.published.ciphertext,
    resticVersion: "0.19.1",
    repositoryId: locator.restic.repositoryId,
    verification: "destination_ciphertext_readback",
  };
  locator.readbackVerifiedAt = 1;
  const row = {
    createdAt: 1,
    providerOriginal: {
      clientReferenceId: randomUUID(),
      bindingId: randomUUID(),
      locator,
      verified: {
        providerAccountIdHash: "1".repeat(64),
        providerRootDirectoryIdHash: "2".repeat(64),
        providerFileIdHash: "3".repeat(64),
        providerRevision: "rev1",
        providerContentHash: "4".repeat(64),
        sourceContentHash: HASH,
        sourceByteLength: 100,
        verifiedAt: 1,
        manifestFingerprint: "5".repeat(64),
        manifestByteLength: 300,
      },
    },
  };
  try {
    assert.throws(
      () => runner.providerDeclaration(row),
      (error) => error.code === "provider_verification_stale_review_required",
    );
    assert.equal(
      runner.providerDeclaration(row, false).locatorBundle.snapshotId,
      locator.backup.snapshotId,
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("legacy provider verification cannot bypass the explicit v2 transition", async () => {
  const setup = await fixture(0);
  const registryPath = join(setup.base, "provider-registry");
  await mkdir(registryPath, { mode: 0o700 });
  const registryDirectory = await realpath(registryPath);
  await chmod(registryDirectory, 0o700);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    preflightAction: "provider_verify",
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const bindingId = randomUUID();
  const metadata = {
    referenceVersion: "provider_original_v1",
    providerKind: "dropbox_v1",
    providerAccountIdHash: createHash("sha256")
      .update("dbid:account")
      .digest("hex"),
    providerRootDirectoryIdHash: createHash("sha256")
      .update("id:root")
      .digest("hex"),
    providerFileIdHash: createHash("sha256").update("id:file").digest("hex"),
    providerRevision: "rev1",
    providerContentHash: "4".repeat(64),
    sourceContentHash: plan.sha256,
    sourceByteLength: plan.byteLength,
    verifiedAt: Date.now(),
  };
  await persistProviderBinding({
    registryDirectory,
    verified: {
      metadata,
      binding: {
        bindingId,
        providerAccountId: "dbid:account",
        providerRootDirectoryId: "id:root",
        providerFileId: "id:file",
        providerRevision: metadata.providerRevision,
        relativePath: plan.relativePath,
      },
    },
  });
  const catalog = await openArchiveCatalog({ journal });
  const original = await catalog.createOriginalIntent({
    originalCatalogId: checkpoint.originalCatalogId,
    sourceExternalId: randomUUID(),
    origin: {
      scanId: checkpoint.scanId,
      observationEpoch: plan.observationEpoch,
      sha256: plan.sha256,
      byteLength: plan.byteLength,
      mediaType: "application/pdf",
    },
    copies: { primary: archiveCopy("primary") },
    providerOriginal: {
      clientReferenceId: randomUUID(),
      bindingId,
      locator: archiveCopy("independent_backup"),
    },
    createdAt: Date.now(),
  });
  const processing = {
    processingCatalogId: checkpoint.processingCatalogId,
    copies: {
      primary: archiveCopy("primary"),
      independent_backup: archiveCopy("independent_backup"),
    },
  };
  const runner = new PipelineRunner(
    {
      ...setup.config,
      pdfDocQa: {
        archive: {
          independentBackup: { repository: {} },
        },
        providerOriginal: {
          registryDirectory,
          rootAlias: plan.rootAlias,
          providerAccountIdHash: metadata.providerAccountIdHash,
          providerRootDirectoryIdHash: metadata.providerRootDirectoryIdHash,
          providerRootDirectoryId: "id:root",
        },
      },
    },
    journal,
    { async call() {} },
  );
  runner.archiveCatalog = catalog;
  try {
    await assert.rejects(
      () =>
        runner.driveProviderOriginal(
          checkpoint,
          original,
          processing,
          join(setup.root, plan.relativePath),
          "provider_verify",
        ),
      (error) => error.code === "provider_v2_transition_required",
    );
    assert.equal(
      catalog.listOriginals()[0].providerOriginal.verified,
      undefined,
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("provider admission sends three recovery selections and persists the provider branch", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const lease = {
    workId: "work",
    sourceItemId: plan.sourceItemId,
    observationEpoch: 1,
    processingEpoch: 1,
    leaseEpoch: 1,
    leaseToken: TOKEN,
    leaseExpiresAt: Date.now() + 60_000,
  };
  const checkpoint = archivedCheckpoint(plan, {
    step: "admit",
    preflightAction: undefined,
    discoveryLease: lease,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const durable = (role, seed) => {
    const value = archiveCopy(role);
    value.published = {
      state: "published",
      source: { sha256: HASH, byteLength: 100 },
      ciphertext: { sha256: seed.repeat(64), byteLength: 200 },
      ciphertextDevice: 1,
      ciphertextInode: 2,
      ageVersion: "v1.3.2",
    };
    value.readbackVerifiedAt = Date.now();
    if (role === "independent_backup")
      value.backup = {
        operationId: value.restic.operationId,
        snapshotId: `${seed}`.repeat(64),
        objectName: value.objectName,
        ciphertext: value.published.ciphertext,
        resticVersion: "0.19.1",
        repositoryId: value.restic.repositoryId,
        verification: "destination_ciphertext_readback",
      };
    return value;
  };
  const locator = durable("independent_backup", "4");
  let original = {
    originalCatalogId: checkpoint.originalCatalogId,
    rowRevision: 1,
    createdAt: 1,
    copies: { primary: durable("primary", "1") },
    providerOriginal: {
      clientReferenceId: randomUUID(),
      bindingId: randomUUID(),
      locator,
      verified: {
        providerAccountIdHash: "1".repeat(64),
        providerRootDirectoryIdHash: "2".repeat(64),
        providerFileIdHash: "3".repeat(64),
        providerRevision: "rev1",
        providerContentHash: "4".repeat(64),
        sourceContentHash: HASH,
        sourceByteLength: 100,
        verifiedAt: Date.now(),
        manifestFingerprint: "5".repeat(64),
        manifestByteLength: 300,
      },
    },
  };
  let processing = {
    processingCatalogId: checkpoint.processingCatalogId,
    rowRevision: 1,
    createdAt: 1,
    copies: {
      primary: durable("primary", "2"),
      independent_backup: durable("independent_backup", "3"),
    },
    parserIntent: { parserArtifactClientId: randomUUID() },
    parserOutput: {
      rawArtifact: {
        sha256: HASH,
        byteLength: 100,
        mediaType: "application/vnd.docling+json",
      },
      extractionFingerprint: HASH,
    },
  };
  const declaration = {
    extractionFingerprint: HASH,
    textHash: HASH,
    byteLength: 10,
    utf16Length: 10,
    pageCount: 1,
    mappingManifestHash: HASH,
    normalizedBundleDigest: HASH,
    expectedEvidenceSpanCount: 1,
    expectedDocumentCount: 1,
    expectedChunkCount: 1,
  };
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request);
      return {
        operation: "discovery.admitArchived",
        workId: lease.workId,
        sourceItemId: lease.sourceItemId,
        sourceRevisionId: "revision",
        parserArtifactId: "artifact",
        sourceTextVersionId: "text",
        processingGenerationId: "generation",
        ingestJobId: "job",
        desiredProcessingEpoch: 1,
        archiveSetDigest: HASH,
        originalPrimaryReceiptId: "original-primary",
        originalPrimaryBindingEpoch: 0,
        originalProviderReferenceId: "provider-reference",
        originalProviderBindingEpoch: 1,
        parserPrimaryReceiptId: "parser-primary",
        parserPrimaryBindingEpoch: 0,
        parserBackupReceiptId: "parser-backup",
        parserBackupBindingEpoch: 0,
        state: "admitted",
        reused: false,
      };
    },
  });
  runner.archivedRows = () => ({ original, processing });
  runner.mappedProcessing = async () => ({ original, processing, declaration });
  runner.archiveCatalog = {
    async recordCloudReceipt(args) {
      const row = args.subject === "original_bytes" ? original : processing;
      const updated = {
        ...row,
        rowRevision: row.rowRevision + 1,
        copies: {
          ...row.copies,
          [args.role]: {
            ...row.copies[args.role],
            cloudReceipt: {
              receiptId: args.receiptId,
              requestDigest: args.requestDigest,
              recordedAt: args.recordedAt,
            },
          },
        },
      };
      if (args.subject === "original_bytes") original = updated;
      else processing = updated;
      return updated;
    },
    async recordOriginalCloud(args) {
      original = {
        ...original,
        rowRevision: original.rowRevision + 1,
        cloud: args.cloud,
      };
      return original;
    },
    async recordProcessingCloud(args) {
      processing = {
        ...processing,
        rowRevision: processing.rowRevision + 1,
        cloud: args.cloud,
      };
      return processing;
    },
  };
  try {
    await runner.driveArchivedAdmit();
    assert.equal(sent.length, 1);
    assert.deepEqual(
      sent[0].archives.map(
        ({ subjectKind, copyRole }) => `${subjectKind}:${copyRole}`,
      ),
      [
        "original_bytes:primary",
        "parser_output:primary",
        "parser_output:independent_backup",
      ],
    );
    assert.equal(
      sent[0].providerOriginal.clientReferenceId,
      original.providerOriginal.clientReferenceId,
    );
    assert.equal("originalBackupReceiptId" in original.cloud, false);
    assert.equal(original.cloud.providerReferenceId, "provider-reference");
    assert.equal(journal.checkpoint.step, "parsed_reserve");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

/**
 * An original whose locator is durable but never admitted, with both proof
 * timestamps set to `verifiedAt` (P2-31a).
 */
function durableProviderRows(checkpoint, verifiedAt) {
  const durable = (role, seed) => {
    const value = archiveCopy(role);
    value.preparationIntent = { tempName: `${value.archiveObjectId}.tmp` };
    value.prepared = {
      state: "prepared",
      tempName: value.preparationIntent.tempName,
      source: { sha256: HASH, byteLength: 100 },
      ciphertext: { sha256: seed.repeat(64), byteLength: 200 },
      ciphertextDevice: 1,
      ciphertextInode: 2,
      archiveDirectoryDevice: 1,
      archiveDirectoryInode: 3,
      ageVersion: "v1.3.2",
    };
    value.published = {
      state: "published",
      source: { sha256: HASH, byteLength: 100 },
      ciphertext: { sha256: seed.repeat(64), byteLength: 200 },
      ciphertextDevice: 1,
      ciphertextInode: 2,
      ageVersion: "v1.3.2",
    };
    value.readbackVerifiedAt = verifiedAt;
    if (role === "independent_backup")
      value.backup = {
        operationId: value.restic.operationId,
        snapshotId: `${seed}`.repeat(64),
        objectName: value.objectName,
        ciphertext: value.published.ciphertext,
        resticVersion: "0.19.1",
        repositoryId: value.restic.repositoryId,
        verification: "destination_ciphertext_readback",
      };
    return value;
  };
  return {
    original: {
      originalCatalogId: checkpoint.originalCatalogId,
      rowRevision: 1,
      createdAt: 1,
      origin: { sha256: HASH, byteLength: 100 },
      copies: { primary: durable("primary", "1") },
      providerOriginal: {
        clientReferenceId: randomUUID(),
        bindingId: randomUUID(),
        locator: durable("independent_backup", "4"),
        verified: {
          providerAccountIdHash: "1".repeat(64),
          providerRootDirectoryIdHash: "2".repeat(64),
          providerFileIdHash: "3".repeat(64),
          providerRevision: "rev1",
          providerContentHash: "4".repeat(64),
          sourceContentHash: HASH,
          sourceByteLength: 100,
          verifiedAt,
          manifestFingerprint: "5".repeat(64),
          manifestByteLength: 300,
        },
      },
    },
    processing: {
      processingCatalogId: checkpoint.processingCatalogId,
      rowRevision: 1,
      createdAt: 1,
      copies: {
        primary: durable("primary", "2"),
        independent_backup: durable("independent_backup", "3"),
      },
      parserIntent: { parserArtifactClientId: randomUUID() },
      parserOutput: {
        rawArtifact: {
          sha256: HASH,
          byteLength: 100,
          mediaType: "application/vnd.docling+json",
        },
        extractionFingerprint: HASH,
      },
    },
  };
}

function admitCheckpoint(plan) {
  return archivedCheckpoint(plan, {
    step: "admit",
    preflightAction: undefined,
    discoveryLease: {
      workId: "work",
      sourceItemId: plan.sourceItemId,
      observationEpoch: 1,
      processingEpoch: 1,
      leaseEpoch: 1,
      leaseToken: TOKEN,
      leaseExpiresAt: Date.now() + 60_000,
    },
  });
}

function parsedDeclaration() {
  return {
    extractionFingerprint: HASH,
    textHash: HASH,
    byteLength: 10,
    utf16Length: 10,
    pageCount: 1,
    mappingManifestHash: HASH,
    normalizedBundleDigest: HASH,
    expectedEvidenceSpanCount: 1,
    expectedDocumentCount: 1,
    expectedChunkCount: 1,
  };
}

function admittedResponse(plan) {
  return {
    operation: "discovery.admitArchived",
    workId: "work",
    sourceItemId: plan.sourceItemId,
    sourceRevisionId: "revision",
    parserArtifactId: "artifact",
    sourceTextVersionId: "text",
    processingGenerationId: "generation",
    ingestJobId: "job",
    desiredProcessingEpoch: 1,
    archiveSetDigest: HASH,
    originalPrimaryReceiptId: "original-primary",
    originalPrimaryBindingEpoch: 0,
    originalProviderReferenceId: "provider-reference",
    originalProviderBindingEpoch: 1,
    parserPrimaryReceiptId: "parser-primary",
    parserPrimaryBindingEpoch: 0,
    parserBackupReceiptId: "parser-backup",
    parserBackupBindingEpoch: 0,
    state: "admitted",
    reused: false,
  };
}

/** Both proof timestamps advanced, as a completed refresh leaves them. */
function freshenProviderProof(rows) {
  const provider = rows.original.providerOriginal;
  return {
    ...rows,
    original: {
      ...rows.original,
      rowRevision: rows.original.rowRevision + 1,
      providerOriginal: {
        ...provider,
        locator: { ...provider.locator, readbackVerifiedAt: Date.now() },
        verified: { ...provider.verified, verifiedAt: Date.now() },
      },
    },
  };
}

function admissionCatalog(read, write) {
  return {
    async recordCloudReceipt(args) {
      const rows = read();
      const key = args.subject === "original_bytes" ? "original" : "processing";
      const row = rows[key];
      write({
        ...rows,
        [key]: {
          ...row,
          rowRevision: row.rowRevision + 1,
          copies: {
            ...row.copies,
            [args.role]: {
              ...row.copies[args.role],
              cloudReceipt: {
                receiptId: args.receiptId,
                requestDigest: args.requestDigest,
                recordedAt: args.recordedAt,
              },
            },
          },
        },
      });
      return read()[key];
    },
    async recordOriginalCloud(args) {
      const rows = read();
      write({
        ...rows,
        original: {
          ...rows.original,
          rowRevision: rows.original.rowRevision + 1,
          cloud: args.cloud,
        },
      });
      return read().original;
    },
    async recordProcessingCloud(args) {
      const rows = read();
      write({
        ...rows,
        processing: {
          ...rows.processing,
          rowRevision: rows.processing.rowRevision + 1,
          cloud: args.cloud,
        },
      });
      return read().processing;
    },
    listOriginals() {
      return [read().original];
    },
    listProcessings() {
      return [read().processing];
    },
    async clearVoidAdmission(args) {
      const rows = read();
      const key = args.subject === "original_bytes" ? "original" : "processing";
      const row = rows[key];
      const copies = Object.fromEntries(
        Object.entries(row.copies).map(([role, copy]) => {
          const { cloudReceipt, ...rest } = copy;
          return [role, rest];
        }),
      );
      const { cloud, ...withoutCloud } = row;
      // P2-31f: the real catalog appends a note whenever the row still held a
      // receipt, and bumps the revision only when the row actually changed, so
      // a repeat call on an already cleared row is free.
      const held =
        cloud !== undefined ||
        Object.values(row.copies).some((copy) => copy.cloudReceipt);
      const changed = held || row.receiptReconcile === undefined;
      write({
        ...rows,
        [key]: {
          ...withoutCloud,
          copies,
          rowRevision: row.rowRevision + (changed ? 1 : 0),
          receiptReconcile:
            !held && row.receiptReconcile !== undefined
              ? row.receiptReconcile
              : [
                  ...(row.receiptReconcile ?? []),
                  {
                    code: "original_receipt_unknown_to_server",
                    clearedAt: args.clearedAt,
                    ...(args.by === undefined ? {} : { by: args.by }),
                  },
                ],
        },
      });
      return read()[key];
    },
  };
}

test("provider v2 admission replay carries only the parser primary artifact", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = admitCheckpoint(plan);
  checkpoint.discoveryLease.leaseExpiresAt = Date.now() + 5 * 60_000;
  let journal = await openJournal(setup.journalDir, checkpoint);
  let rows = durableProviderRows(checkpoint, Date.now());
  const v1 = rows.original.providerOriginal;
  rows = {
    original: {
      ...rows.original,
      copies: {},
      providerOriginal: {
        referenceVersion: "provider_original_v2",
        clientReferenceId: v1.clientReferenceId,
        bindingId: v1.bindingId,
        verified: v1.verified,
        legacyPrimary: rows.original.copies.primary,
        legacyLocator: v1.locator,
      },
    },
    processing: {
      ...rows.processing,
      copies: { primary: rows.processing.copies.primary },
      legacyIndependentBackup: rows.processing.copies.independent_backup,
    },
  };
  const declaration = parsedDeclaration();
  const configure = (transport) => {
    const runner = new PipelineRunner(setup.config, journal, transport);
    runner.archivedRows = () => rows;
    runner.mappedProcessing = async () => ({ ...rows, declaration });
    runner.archiveCatalog = admissionCatalog(
      () => rows,
      (value) => {
        rows = value;
      },
    );
    runner.recordArchiveAction = async () => {
      throw new Error("v2 must not execute archive copy or backup actions");
    };
    return runner;
  };
  const builder = configure({
    async call() {
      throw new Error("unused");
    },
  });
  const provider = builder.admissionProvider(checkpoint, rows.original, false);
  const selections = builder.admissionSelections(
    checkpoint,
    rows,
    provider.providerOriginal,
  );
  assert.deepEqual(
    selections.archives.map(({ subjectKind, copyRole }) => [
      subjectKind,
      copyRole,
    ]),
    [["parser_output", "primary"]],
  );
  assert.equal(
    provider.providerOriginal.referenceVersion,
    "provider_original_v2",
  );
  assert.equal("locatorBundle" in provider.providerOriginal, false);
  const requestId = randomUUID();
  const body = {
    protocolVersion: 1,
    operation: "discovery.admitArchived",
    spaceId: "space",
    sourceAccountId: "source",
    requestId,
    workId: checkpoint.discoveryLease.workId,
    leaseEpoch: checkpoint.discoveryLease.leaseEpoch,
    leaseToken: checkpoint.discoveryLease.leaseToken,
    ...selections,
    ...provider,
    parsedText: declaration,
  };
  await journal.planRequest({
    operation: body.operation,
    requestId,
    requestBody: JSON.stringify(body),
    createdAt: Date.now(),
  });
  await journal.close();
  journal = await openJournal(setup.journalDir);
  const sent = [];
  const response = admittedResponse(plan);
  delete response.originalPrimaryReceiptId;
  delete response.originalPrimaryBindingEpoch;
  delete response.parserBackupReceiptId;
  delete response.parserBackupBindingEpoch;
  try {
    await configure({
      async call(value) {
        sent.push(structuredClone(value));
        return response;
      },
    }).driveArchivedAdmit();
    assert.deepEqual(sent, [body]);
    assert.equal(journal.pending, undefined);
    assert.equal(journal.checkpoint.step, "parsed_reserve");
    assert.deepEqual(Object.keys(rows.original.copies), []);
    assert.deepEqual(Object.keys(rows.processing.copies), ["primary"]);
    assert.equal(rows.original.cloud.primaryReceiptId, undefined);
    assert.equal(rows.original.cloud.backupReceiptId, undefined);
    assert.equal(rows.original.cloud.providerReferenceId, "provider-reference");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

/** The 2026-09-18 receipt: ids from a deployment that no longer serves this account. */
function voidReceiptRows(checkpoint, admittedAt) {
  const rows = durableProviderRows(checkpoint, admittedAt);
  const plan = checkpoint.files[checkpoint.pdfIndex];
  rows.processing.currentObservation = {
    scanId: checkpoint.scanId,
    observationEpoch: plan.observationEpoch,
    processingEpoch: plan.processingEpoch,
  };
  rows.original.copies.primary.cloudReceipt = {
    receiptId: "original-primary",
    requestDigest: HASH,
    recordedAt: admittedAt,
  };
  rows.original.cloud = {
    sourceItemId: "item-from-the-other-backend",
    sourceRevisionId: "revision-from-the-other-backend",
    primaryReceiptId: "original-primary",
    providerReferenceId: "provider-reference",
    providerBindingEpoch: 0,
    admittedAt,
  };
  return rows;
}

/** The live checkpoint: resumed at admit, question asked, lease long dead. */
function voidReceiptCheckpoint(plan) {
  return archivedCheckpoint(plan, {
    step: "admit",
    preflightAction: undefined,
    receiptChecked: true,
    discoveryLease: {
      workId: "work",
      sourceItemId: plan.sourceItemId,
      observationEpoch: 1,
      processingEpoch: 1,
      leaseEpoch: 9,
      leaseToken: TOKEN,
      leaseExpiresAt: Date.now() - 60 * 60_000,
    },
  });
}

function lookupResponse(found) {
  return {
    operation: "discovery.lookupArchivedAdmission",
    mode: "original",
    found,
    ...(found
      ? {
          sourceRevisionId: "revision",
          originalPrimaryReceiptId: "original-primary",
          originalProviderReferenceId: "provider-reference",
          originalProviderBindingEpoch: 0,
        }
      : {}),
  };
}

test("an operator reconcile clears a void receipt and the next pass admits exactly once", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = voidReceiptCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  let rows = voidReceiptRows(checkpoint, Date.now() - 120 * 60_000);
  const locator = rows.original.providerOriginal.locator;
  const before = {
    published: structuredClone(rows.original.copies.primary.published),
    locator: structuredClone(locator),
    verified: structuredClone(rows.original.providerOriginal.verified),
  };
  const catalog = admissionCatalog(
    () => rows,
    (next) => (rows = next),
  );
  const sent = [];
  const transport = {
    async call(request) {
      sent.push(request.operation);
      if (request.operation === "discovery.lookupArchivedAdmission")
        return lookupResponse(false);
      if (request.operation === "discovery.reserveArchived")
        return {
          operation: "discovery.reserveArchived",
          workId: "work",
          sourceItemId: plan.sourceItemId,
          observationEpoch: plan.observationEpoch,
          processingEpoch: plan.processingEpoch,
          leaseEpoch: 2,
          leaseToken: TOKEN,
          leaseExpiresAt: Date.now() + 60_000,
          reused: false,
        };
      if (request.operation === "jobs.reserveParsed")
        return {
          operation: "jobs.reserveParsed",
          receiptId: randomUUID(),
          expiresAt: Date.now() + 60_000,
          reused: false,
          targets: [
            {
              jobId: "job",
              workId: "work",
              sourceItemId: plan.sourceItemId,
              observationEpoch: plan.observationEpoch,
              processingEpoch: plan.processingEpoch,
              state: "processing",
              leaseEpoch: 1,
              leaseToken: TOKEN,
              leaseExpiresAt: Date.now() + 60_000,
            },
          ],
        };
      return admittedResponse(plan);
    },
  };
  const runner = new PipelineRunner(setup.config, journal, transport);
  runner.archivedRows = () => rows;
  runner.mappedProcessing = async () => ({
    original: rows.original,
    processing: rows.processing,
    declaration: parsedDeclaration(),
  });
  runner.archiveCatalog = catalog;
  let refreshes = 0;
  runner.refreshProviderProof = async (current) => {
    refreshes += 1;
    rows = freshenProviderProof(rows);
    await journal.transitionCheckpoint({
      checkpoint: parseRunnerCheckpoint({ ...current }),
      credentialSessionActive: true,
    });
  };
  try {
    const result = await runReconcileReceipts({
      config: setup.config,
      journal,
      catalog,
      transport,
      apply: true,
    });
    assert.deepEqual(result, {
      state: "reconciled",
      scope: "checkpoint_original",
      applied: true,
      originalsWithReceipts: 1,
      parkedOriginals: 0,
      parkedCodes: [],
      receiptsChecked: 1,
      receiptsConfirmed: 0,
      receiptsUnknown: 1,
    });
    assert.deepEqual(sent, ["discovery.lookupArchivedAdmission"]);
    // Everything a fresh admission must rewrite is gone.
    assert.equal(rows.original.cloud, undefined);
    assert.equal(rows.original.copies.primary.cloudReceipt, undefined);
    assert.equal(rows.processing.cloud, undefined);
    assert.equal(rows.processing.copies.primary.cloudReceipt, undefined);
    assert.equal(
      rows.processing.copies.independent_backup.cloudReceipt,
      undefined,
    );
    assert.deepEqual(rows.original.receiptReconcile, [
      {
        code: "original_receipt_unknown_to_server",
        clearedAt: rows.original.receiptReconcile[0].clearedAt,
        by: "operator",
      },
    ]);
    // The bytes stay archived. Only the server-side receipt was void.
    assert.deepEqual(rows.original.copies.primary.published, before.published);
    assert.deepEqual(rows.original.providerOriginal.locator, before.locator);
    assert.deepEqual(rows.original.providerOriginal.verified, before.verified);
    // The checkpoint rewinds to the read-only lookup with the question
    // unasked, the dead lease dropped and both revisions in step.
    assert.equal(journal.checkpoint.step, "lookup_original");
    assert.equal(journal.checkpoint.receiptChecked, undefined);
    assert.equal(journal.checkpoint.discoveryLease, undefined);
    assert.equal(
      journal.checkpoint.expectedOriginalRevision,
      rows.original.rowRevision,
    );
    assert.equal(
      journal.checkpoint.expectedProcessingRevision,
      rows.processing.rowRevision,
    );

    // The next normal pass. The same not-found answer is now the ordinary
    // "never admitted" one, because no local receipt contradicts it.
    await runner.driveArchivedLookupOriginal();
    assert.equal(journal.checkpoint.step, "capture");
    // Capture, parse and archive rebuild the durable rows unchanged; the
    // reconcile touched none of them. The pass arrives at `reserve`.
    await journal.transitionCheckpoint({
      checkpoint: parseRunnerCheckpoint({
        ...journal.checkpoint,
        step: "reserve",
      }),
      credentialSessionActive: true,
    });
    await runner.driveArchivedReserve();
    assert.equal(journal.checkpoint.step, "admit");
    // The proof is two hours old, so P2-31a refreshes it in place first.
    await runner.driveArchivedAdmit();
    assert.equal(refreshes, 1);
    assert.equal(journal.checkpoint.step, "admit");
    await runner.driveArchivedAdmit();
    assert.equal(journal.checkpoint.step, "parsed_reserve");
    await runner.driveParsedReserve();
    assert.equal(journal.checkpoint.step, "parsed_begin");
    assert.deepEqual(sent, [
      "discovery.lookupArchivedAdmission",
      "discovery.lookupArchivedAdmission",
      "discovery.reserveArchived",
      "discovery.admitArchived",
      "jobs.reserveParsed",
    ]);
    assert.equal(rows.original.cloud.sourceItemId, plan.sourceItemId);
    assert.equal(rows.original.cloud.providerReferenceId, "provider-reference");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a reconcile dry run counts the void receipt and writes nothing", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = voidReceiptCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  let rows = voidReceiptRows(checkpoint, Date.now() - 120 * 60_000);
  const before = structuredClone(rows);
  try {
    const result = await runReconcileReceipts({
      config: setup.config,
      journal,
      catalog: admissionCatalog(
        () => rows,
        (next) => (rows = next),
      ),
      transport: {
        async call() {
          return lookupResponse(false);
        },
      },
      apply: false,
    });
    assert.deepEqual(result, {
      state: "unknown_receipt_found",
      scope: "checkpoint_original",
      applied: false,
      originalsWithReceipts: 1,
      parkedOriginals: 0,
      parkedCodes: [],
      receiptsChecked: 1,
      receiptsConfirmed: 0,
      receiptsUnknown: 1,
    });
    assert.deepEqual(rows, before);
    assert.deepEqual(journal.checkpoint, checkpoint);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a receipt the server confirms is never cleared, even under --apply", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = voidReceiptCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  let rows = voidReceiptRows(checkpoint, Date.now() - 120 * 60_000);
  const before = structuredClone(rows);
  try {
    const result = await runReconcileReceipts({
      config: setup.config,
      journal,
      catalog: admissionCatalog(
        () => rows,
        (next) => (rows = next),
      ),
      transport: {
        async call() {
          return lookupResponse(true);
        },
      },
      apply: true,
    });
    assert.deepEqual(result, {
      state: "clean",
      scope: "checkpoint_original",
      applied: false,
      originalsWithReceipts: 1,
      parkedOriginals: 0,
      parkedCodes: [],
      receiptsChecked: 1,
      receiptsConfirmed: 1,
      receiptsUnknown: 0,
    });
    assert.deepEqual(rows, before);
    assert.deepEqual(journal.checkpoint, checkpoint);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a reconcile interrupted before its checkpoint move finishes on the rerun", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = voidReceiptCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  // The crash window: both catalog writes committed, the checkpoint did not.
  let rows = voidReceiptRows(checkpoint, Date.now() - 120 * 60_000);
  const catalog = admissionCatalog(
    () => rows,
    (next) => (rows = next),
  );
  const clearedAt = Date.now();
  for (const subject of ["parser_output", "original_bytes"])
    await catalog.clearVoidAdmission({
      subject,
      catalogId:
        subject === "original_bytes"
          ? rows.original.originalCatalogId
          : rows.processing.processingCatalogId,
      expectedRevision: 1,
      clearedAt,
    });
  const committed = structuredClone(rows);
  const sent = [];
  const transport = {
    async call(request) {
      sent.push(request.operation);
      throw new Error("a cleared row has nothing left to ask about");
    },
  };
  try {
    const first = await runReconcileReceipts({
      config: setup.config,
      journal,
      catalog,
      transport,
      apply: true,
    });
    assert.equal(first.state, "reconciled");
    assert.equal(first.originalsWithReceipts, 0);
    assert.deepEqual(sent, [], "the answer is already recorded in the note");
    assert.deepEqual(rows, committed, "the catalog writes are not repeated");
    assert.equal(journal.checkpoint.step, "lookup_original");
    assert.equal(journal.checkpoint.discoveryLease, undefined);
    // Idempotent: nothing is left to reconcile.
    const second = await runReconcileReceipts({
      config: setup.config,
      journal,
      catalog,
      transport,
      apply: true,
    });
    assert.deepEqual(second, {
      state: "clean",
      scope: "checkpoint_original",
      applied: false,
      originalsWithReceipts: 0,
      parkedOriginals: 0,
      parkedCodes: [],
      receiptsChecked: 0,
      receiptsConfirmed: 0,
      receiptsUnknown: 0,
    });
    assert.deepEqual(rows, committed);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a reconcile refuses a journal the watcher still holds", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const journal = await openJournal(
    setup.journalDir,
    voidReceiptCheckpoint(plan),
  );
  const configPath = join(setup.base, "pipeline.json");
  await writeFile(configPath, JSON.stringify(setup.config), { mode: 0o600 });
  const previous = process.env.PIPELINE_TOKEN;
  process.env.PIPELINE_TOKEN = "test-credential";
  try {
    const result = await reconcileReceiptsFromPath(configPath, true, () => ({
      async call() {
        throw new Error("a contended journal is never read");
      },
    }));
    assert.deepEqual(result, {
      state: "refused",
      scope: "checkpoint_original",
      applied: false,
      originalsWithReceipts: 0,
      parkedOriginals: 0,
      parkedCodes: [],
      receiptsChecked: 0,
      receiptsConfirmed: 0,
      receiptsUnknown: 0,
      code: "journal_contended",
    });
  } finally {
    if (previous === undefined) delete process.env.PIPELINE_TOKEN;
    else process.env.PIPELINE_TOKEN = previous;
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("the live mid-flight shape repairs itself in one pass and leaves the reconcile nothing to do", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  // The true live shape: resumed at admit, the receipt question never asked.
  const checkpoint = archivedCheckpoint(plan, {
    step: "admit",
    preflightAction: undefined,
    discoveryLease: {
      workId: "work",
      sourceItemId: plan.sourceItemId,
      observationEpoch: 1,
      processingEpoch: 1,
      leaseEpoch: 9,
      leaseToken: TOKEN,
      leaseExpiresAt: Date.now() - 60 * 60_000,
    },
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  let rows = voidReceiptRows(checkpoint, Date.now() - 120 * 60_000);
  const catalog = admissionCatalog(
    () => rows,
    (next) => (rows = next),
  );
  const sent = [];
  const transport = {
    async call(request) {
      sent.push(request.operation);
      return lookupResponse(false);
    },
  };
  const runner = new PipelineRunner(setup.config, journal, transport);
  runner.archivedRows = () => rows;
  runner.mappedProcessing = async () => ({
    original: rows.original,
    processing: rows.processing,
    declaration: parsedDeclaration(),
  });
  runner.archiveCatalog = catalog;
  try {
    // A real pass reaches the contradiction, exactly as P2-31c intends.
    await runner.driveArchivedAdmit();
    assert.equal(journal.checkpoint.step, "lookup_original");
    // P2-31f. The pass repairs it in place instead of throwing. The lookup is
    // settled, the void receipt is retired under the same narrow conditions
    // the operator command enforces, and the document continues to capture.
    await runner.driveArchivedLookupOriginal();
    assert.equal(journal.checkpoint.step, "capture");
    assert.equal(journal.pending, undefined);
    assert.deepEqual(sent, ["discovery.lookupArchivedAdmission"]);
    assert.equal(rows.original.cloud, undefined);
    assert.equal(rows.original.copies.primary.cloudReceipt, undefined);
    // Nothing was parked: the repair is what a park is for, when it is safe.
    assert.equal(rows.original.admissionBlock, undefined);

    // The operator command still works and now finds nothing to clear.
    const result = await runReconcileReceipts({
      config: setup.config,
      journal,
      catalog,
      transport,
      apply: false,
    });
    assert.equal(result.state, "clean");
    assert.equal(result.receiptsUnknown, 0);
    assert.deepEqual(
      sent,
      ["discovery.lookupArchivedAdmission"],
      "no second round trip",
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a reconcile dry run refuses a processing receipt naming another revision", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = voidReceiptCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  let rows = voidReceiptRows(checkpoint, Date.now() - 120 * 60_000);
  rows.processing.cloud = {
    sourceItemId: "item-from-the-other-backend",
    sourceRevisionId: "a-revision-the-original-never-named",
    parserArtifactId: "artifact",
    sourceTextVersionId: "text",
    processingGenerationId: "generation",
    ingestJobId: "job",
    processingFingerprint: HASH,
    admissionRequestDigest: HASH,
    admittedAt: 1,
  };
  const before = structuredClone(rows);
  try {
    // The dry run must name it too: an operator reading a count has to see
    // what `--apply` would have hit.
    for (const apply of [false, true]) {
      const result = await runReconcileReceipts({
        config: setup.config,
        journal,
        catalog: admissionCatalog(
          () => rows,
          (next) => (rows = next),
        ),
        transport: {
          async call() {
            return lookupResponse(false);
          },
        },
        apply,
      });
      assert.equal(result.state, "refused");
      assert.equal(result.code, "processing_receipt_conflict");
      assert.deepEqual(rows, before);
      assert.deepEqual(journal.checkpoint, checkpoint);
    }
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a reconcile refuses an activated processing row", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = voidReceiptCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  let rows = voidReceiptRows(checkpoint, Date.now() - 120 * 60_000);
  // A live generation server side. Retiring its receipt is P2-31's work.
  rows.processing.activation = {
    requestId: randomUUID(),
    requestDigest: HASH,
    jobId: "job",
    processingGenerationId: "generation",
    state: "ready",
    activatedAt: 1,
    reused: false,
  };
  const before = structuredClone(rows);
  try {
    for (const apply of [false, true]) {
      const result = await runReconcileReceipts({
        config: setup.config,
        journal,
        catalog: admissionCatalog(
          () => rows,
          (next) => (rows = next),
        ),
        transport: {
          async call() {
            return lookupResponse(false);
          },
        },
        apply,
      });
      assert.equal(result.state, "refused");
      assert.equal(result.code, "processing_already_activated");
      assert.deepEqual(rows, before);
      assert.deepEqual(journal.checkpoint, checkpoint);
    }
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

/**
 * The 2026-09-18 aftermath. One original with eight processing rows: six the
 * wedged passes left never admitted, and two activated, each internally
 * coherent. One was activated against the decommissioned backend during the
 * misrouted window, the other by the pass that followed the receipt reconcile.
 */
function twoActivatedFamily(runner, plan, originalCatalogId) {
  const fingerprints = runner.processingFingerprints(plan);
  const row = (revision) => ({
    processingCatalogId: randomUUID(),
    originalCatalogId,
    rowRevision: 1,
    createdAt: 1,
    currentObservation: {
      scanId: "scan-0",
      observationEpoch: plan.observationEpoch,
      processingEpoch: plan.processingEpoch,
    },
    fingerprints,
    copies: {
      primary: archiveCopy("primary"),
      independent_backup: archiveCopy("independent_backup"),
    },
    ...(revision === undefined
      ? {}
      : {
          cloud: {
            sourceItemId: plan.sourceItemId,
            sourceRevisionId: revision,
            parserArtifactId: "artifact",
            sourceTextVersionId: "text",
            processingGenerationId: `generation-${revision}`,
            ingestJobId: `job-${revision}`,
            processingFingerprint: HASH,
            admissionRequestDigest: HASH,
            admittedAt: 1,
          },
          activation: {
            requestId: randomUUID(),
            requestDigest: HASH,
            jobId: `job-${revision}`,
            processingGenerationId: `generation-${revision}`,
            state: "ready",
            activatedAt: 1,
            reused: false,
          },
        }),
  });
  return [
    row("revision"),
    row("revision-from-the-other-backend"),
    ...Array.from({ length: 6 }, () => row(undefined)),
  ];
}

function familyOriginal(plan, originalCatalogId, sourceRevisionId) {
  return {
    originalCatalogId,
    sourceExternalId: plan.externalId,
    rowRevision: 1,
    createdAt: 1,
    origin: {
      scanId: "scan-0",
      observationEpoch: plan.observationEpoch,
      sha256: plan.sha256,
      byteLength: plan.byteLength,
      mediaType: "application/pdf",
    },
    copies: { primary: archiveCopy("primary") },
    ...(sourceRevisionId === undefined
      ? {}
      : {
          cloud: {
            sourceItemId: plan.sourceItemId,
            sourceRevisionId,
            primaryReceiptId: "original-primary",
            providerReferenceId: "provider-reference",
            providerBindingEpoch: 0,
            admittedAt: 1,
          },
        }),
  };
}

function reconcileResponse(scanId) {
  return {
    operation: "scan.reconcile",
    scanId,
    state: "enumerated",
    inspected: 0,
    unavailable: 0,
    done: true,
    reused: false,
  };
}

function reconcileCheckpoint(plan) {
  return parseRunnerCheckpoint({
    version: 1,
    phase: "reconcile",
    mode: "normal",
    scanId: "scan-1",
    inventoryEpoch: 1,
    manifestVersion: 1,
    missingBindings: [],
    files: [plan],
    ordinal: 0,
    reviewSeen: false,
  });
}

/** The live journal: an answered reconcile page the old build left unresolved. */
async function plantReconcilePage(journal, config, checkpoint) {
  const requestId = randomUUID();
  await journal.planRequest({
    operation: "scan.reconcile",
    requestId,
    requestBody: JSON.stringify({
      protocolVersion: 1,
      operation: "scan.reconcile",
      spaceId: config.spaceId,
      sourceAccountId: config.sourceAccountId,
      scanId: checkpoint.scanId,
      requestId,
      expectedInventoryEpoch: checkpoint.inventoryEpoch,
      ordinal: checkpoint.ordinal,
      maxItems: 50,
    }),
    createdAt: Date.now(),
  });
  await journal.recordValidatedResult(
    reconcileResponse(checkpoint.scanId),
    Date.now(),
  );
}

async function reconcileFixture(sourceRevisionId, family) {
  const setup = await fixture(0);
  const plan = pdfPlan({ discoveryState: "unchanged" });
  const checkpoint = reconcileCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  const originalCatalogId = randomUUID();
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request.operation);
      return reconcileResponse(checkpoint.scanId);
    },
  });
  const original = familyOriginal(plan, originalCatalogId, sourceRevisionId);
  const rows = (family ?? twoActivatedFamily)(runner, plan, originalCatalogId);
  const parked = [];
  runner.archiveCatalog = {
    listOriginals: () => [original],
    listProcessings: () => rows,
    findOriginalExact: () => original,
    async recordAdmissionBlock(args) {
      parked.push(args);
      original.rowRevision += 1;
      original.admissionBlock = {
        code: args.code,
        blockedAt: args.now,
        runnerCapability: args.runnerCapability,
        attempts: 1,
      };
      return original;
    },
  };
  runner.processingArtifactsPresent = async () => false;
  await plantReconcilePage(journal, setup.config, checkpoint);
  return {
    setup,
    plan,
    checkpoint,
    journal,
    runner,
    rows,
    original,
    sent,
    parked,
  };
}

test("the original settles two activated rows and the answered page resolves", async () => {
  // The live state. The original was re-admitted by the pass that followed the
  // receipt reconcile, so it names the live revision and exactly one of the two
  // activations agrees with it. Six never-admitted rows sit alongside them.
  const f = await reconcileFixture("revision");
  try {
    await f.runner.driveReconcile();
    assert.equal(f.journal.pending, undefined, "the answer is not left owing");
    assert.equal(f.journal.checkpoint.phase, "discovery_reserve");
    assert.deepEqual(f.sent, [], "the recorded page answer is reused");
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

test("a dead activation is never reused for an original the server re-admitted", async () => {
  // The original names the revision the server is serving, and the only
  // activated row names the dead one. Selecting it would send a document the
  // server is still waiting for to cleanup, and it would never publish.
  const f = await reconcileFixture(
    "revision-the-server-serves",
    (runner, plan, id) => twoActivatedFamily(runner, plan, id).slice(1),
  );
  try {
    await f.runner.driveReconcile();
    assert.equal(f.journal.pending, undefined);
    assert.equal(
      f.journal.checkpoint.phase,
      "archived",
      "the document is treated as needing work, not as published",
    );
    assert.equal(f.journal.checkpoint.step, "intent");
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

test("an ambiguity the original cannot settle parks that document, not the scan", async () => {
  // No receipt on the original, so nothing narrows the two activations. That is
  // a genuinely ambiguous history and it is still not judged. P2-31e stopped it
  // wedging the journal by ending the scan; P2-31f keeps the answer settled and
  // parks the one document instead, so the scan runs on for every other file.
  const f = await reconcileFixture(undefined);
  try {
    await f.runner.driveReconcile();
    assert.equal(f.journal.pending, undefined, "the answer is not left owing");
    assert.equal(
      f.journal.checkpoint.phase,
      "discovery_reserve",
      "the pass carries on past the parked document",
    );
    assert.deepEqual(f.sent, []);
    assert.equal(f.parked.length, 1);
    assert.equal(f.parked[0].code, "archive_catalog_revision_conflict");
    assert.equal(f.original.admissionBlock.attempts, 1);
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

test("no activated row at all parks the same ambiguous history", async () => {
  const f = await reconcileFixture("revision", (runner, plan, id) =>
    twoActivatedFamily(runner, plan, id).slice(2),
  );
  try {
    await f.runner.driveReconcile();
    assert.equal(f.journal.checkpoint.phase, "discovery_reserve");
    assert.deepEqual(
      f.parked.map((entry) => entry.code),
      ["archive_catalog_revision_conflict"],
    );
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P2-31f. Parking one item instead of failing the pass.
// ---------------------------------------------------------------------------

/** A catalog stub that records parks and releases against one original row. */
function parkingCatalog(original, processings = []) {
  const parked = [];
  const cleared = [];
  return {
    parked,
    cleared,
    catalog: {
      listOriginals: () => [original],
      listProcessings: () => processings,
      findOriginalExact: (probe) =>
        probe.sha256 === original.origin.sha256 &&
        probe.byteLength === original.origin.byteLength
          ? original
          : undefined,
      async recordAdmissionBlock(args) {
        parked.push(args);
        original.rowRevision += 1;
        original.admissionBlock = {
          code: args.code,
          blockedAt: args.now,
          runnerCapability: args.runnerCapability,
          attempts: Math.min(
            (original.admissionBlock?.attempts ?? 0) + 1,
            MAX_ADMISSION_BLOCK_ATTEMPTS,
          ),
        };
        return original;
      },
      async clearAdmissionBlock(args) {
        cleared.push(args);
        delete original.admissionBlock;
        return original;
      },
    },
  };
}

test("a parked document lets the next file publish in the same pass, with no request owing and no attempt spent", async () => {
  const setup = await fixture(0);
  // Two files. The first has the ambiguous history nothing can judge; the
  // second is ordinary work that the old behaviour would never have reached.
  const stuck = pdfPlan({ discoveryState: "unchanged" });
  const healthy = pdfPlan({
    discoveryState: "unchanged",
    relativePath: "second.pdf",
    sha256: "b".repeat(64),
  });
  const checkpoint = parseRunnerCheckpoint({
    ...reconcileCheckpoint(stuck),
    files: [stuck, healthy],
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request.operation);
      return reconcileResponse(checkpoint.scanId);
    },
  });
  const original = familyOriginal(stuck, randomUUID(), undefined);
  const stub = parkingCatalog(
    original,
    twoActivatedFamily(runner, stuck, original.originalCatalogId),
  );
  runner.archiveCatalog = stub.catalog;
  await plantReconcilePage(journal, setup.config, checkpoint);
  try {
    await runner.driveReconcile();
    assert.deepEqual(
      stub.parked.map((entry) => entry.code),
      ["archive_catalog_revision_conflict"],
    );
    // The pass walks straight on to the second file.
    assert.equal(journal.checkpoint.phase, "archived");
    assert.equal(journal.checkpoint.pdfIndex, 1);
    assert.equal(journal.checkpoint.step, "intent");
    // PR 277's lesson: the answered page is settled, not left owing.
    assert.equal(journal.pending, undefined);
    // Nothing was sent, so no discovery attempt was spent on the parked file.
    assert.deepEqual(sent, []);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a parked document is offered again only when its revision, the build, or an operator releases it", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan({ discoveryState: "unchanged" });
  const journal = await openJournal(
    setup.journalDir,
    reconcileCheckpoint(plan),
  );
  const runner = new PipelineRunner(setup.config, journal, {
    async call() {
      throw new Error("the release rules ask the server nothing");
    },
  });
  const original = familyOriginal(plan, randomUUID(), "revision");
  const stub = parkingCatalog(original);
  runner.archiveCatalog = stub.catalog;
  const capability = "0".repeat(16);
  try {
    // The list is closed on purpose: nothing global may be parked. A code
    // added here must be a per-item condition and nothing else.
    assert.deepEqual(ADMISSION_BLOCK_CODES, [
      "archive_catalog_revision_conflict",
      "catalog_conflict",
      "original_receipt_revision_conflict",
      "original_receipt_unknown_to_server",
      "provider_original_reference_already_bound",
      "provider_verification_stale_review_required",
      "receipt_clear_refused_by_safety_limit",
    ]);
    await runner.parkPlan(plan, "original_receipt_revision_conflict");
    const parkedWith = original.admissionBlock.runnerCapability;
    // Parked and inside the backoff window: not offered.
    assert.equal(await runner.pdfNeedsArchivedWork(plan), false);
    // Restart idempotence: asking again changes nothing and parks nothing
    // more, so a pass that restarts leaves the same one attempt recorded.
    assert.equal(await runner.pdfNeedsArchivedWork(plan), false);
    assert.equal(stub.parked.length, 1);
    assert.equal(original.admissionBlock.attempts, 1);

    // Released by the bounded backoff once the window has passed.
    original.admissionBlock.blockedAt = Date.now() - 7 * 60 * 60_000;
    assert.equal(await runner.pdfNeedsArchivedWork(plan), true);
    // ...but not past the attempt bound: then it waits for a person.
    original.admissionBlock.attempts = MAX_ADMISSION_BLOCK_ATTEMPTS;
    assert.equal(await runner.pdfNeedsArchivedWork(plan), false);

    // Released by a build that handles these codes differently.
    original.admissionBlock.runnerCapability = capability;
    assert.notEqual(parkedWith, capability);
    assert.equal(await runner.pdfNeedsArchivedWork(plan), true);
    original.admissionBlock.runnerCapability = parkedWith;

    // Released by new bytes: the marker lives on a content-keyed row, so a
    // changed file finds no row of its own and nothing to skip.
    assert.equal(
      await runner.pdfNeedsArchivedWork(
        pdfPlan({ discoveryState: "unchanged", sha256: "c".repeat(64) }),
      ),
      true,
    );

    // Released by the operator flag, and only by it.
    await runner.clearParkedItems();
    assert.deepEqual(stub.cleared, []);
    assert.notEqual(original.admissionBlock, undefined);
    const releasing = new PipelineRunner(
      setup.config,
      journal,
      runner.transport,
      undefined,
      { retryParked: true },
    );
    releasing.archiveCatalog = stub.catalog;
    await releasing.clearParkedItems();
    assert.equal(stub.cleared.length, 1);
    assert.equal(original.admissionBlock, undefined);
    assert.equal(await runner.pdfNeedsArchivedWork(plan), true);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a global failure still fails the pass, and a parkable code never parks over an unresolved request", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan({ discoveryState: "unchanged" });
  const checkpoint = archivedCheckpoint(plan, {
    step: "capture",
    preflightAction: undefined,
  });
  async function runWith(failure, wedged = false) {
    const journal = await openJournal(setup.journalDir, checkpoint);
    const runner = new PipelineRunner(setup.config, journal, {
      async call() {
        throw new Error("no request is sent");
      },
    });
    const original = familyOriginal(plan, randomUUID(), "revision");
    const stub = parkingCatalog(original);
    // `run` opens the real catalog, so the stub is pinned past that write.
    Object.defineProperty(runner, "archiveCatalog", {
      configurable: true,
      get: () => stub.catalog,
      set: () => undefined,
    });
    runner.preparePdfProfile = async () => undefined;
    runner.sourceStatus = async () => ({
      sourceAccountId: setup.config.sourceAccountId,
    });
    // The journal starts settled, so the pass reaches its driving loop; the
    // wedged case leaves a request unresolved exactly as a throw from inside a
    // journaled transition does.
    let pending = false;
    Object.defineProperty(journal, "pending", {
      configurable: true,
      get: () => (pending ? { operation: "scan.reconcile" } : undefined),
    });
    runner.driveCheckpoint = async () => {
      pending = wedged;
      throw failure;
    };
    try {
      return { result: await runner.runSafely(), parked: stub.parked };
    } finally {
      pending = false;
      await journal.close();
    }
  }
  try {
    // A credential problem is about the whole run, not one file: it is not on
    // the parkable list and still ends the pass.
    // Not on the parkable list: it says nothing about one file, so the pass
    // ends exactly as it did before.
    const global = await runWith(new ArchiveCatalogError("durability_failed"));
    assert.equal(global.result.state, "failed");
    assert.deepEqual(global.parked, []);
    assert.equal(global.result.parked, undefined);

    // The same code, settled journal: parked, and the pass carries on.
    const parking = await runWith(new ArchiveCatalogError("catalog_conflict"));
    assert.deepEqual(
      parking.parked.map((entry) => entry.code),
      ["catalog_conflict"],
    );
    assert.equal(parking.result.parked, 1);
    assert.deepEqual(parking.result.parkedCodes, ["catalog_conflict"]);
    assert.equal(typeof parking.result.parkedOldestAgeMs, "number");

    // A parkable code raised with a journaled request still unresolved is not
    // parked either: committing a move over an unsettled call is what wedged
    // the journal in PR 277.
    const wedging = await runWith(
      new ArchiveCatalogError("catalog_conflict"),
      true,
    );
    assert.equal(wedging.result.state, "failed");
    assert.deepEqual(wedging.parked, []);
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

/** The catalog requires the two roles to be separated in every dimension. */
function distinctCopy(copy) {
  return {
    ...copy,
    archiveIdentityFingerprint: "b".repeat(64),
    recipientFingerprint: "c".repeat(64),
    repositoryKeyDomainFingerprint: "d".repeat(64),
    storageFailureDomainFingerprint: "e".repeat(64),
  };
}

/**
 * P2-31f. The circuit breaker on the automatic receipt clear. A catalog of
 * `count` in-flight originals, a server that answers not found to every one of
 * them, and the pass resumed on the first.
 */
async function voidBackendFixture(count) {
  const setup = await fixture(0);
  const plans = Array.from({ length: count }, (_, index) =>
    pdfPlan({
      discoveryState: "unchanged",
      relativePath: `document-${index}.pdf`,
      sha256: `${index}`.repeat(64),
    }),
  );
  const checkpoint = parseRunnerCheckpoint({
    ...archivedCheckpoint(plans[0], {
      step: "lookup_original",
      preflightAction: undefined,
      receiptChecked: true,
    }),
    files: plans,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request.operation);
      return lookupResponse(false);
    },
  });
  // Every original is admitted against the backend that no longer answers.
  const originals = plans.map((plan, index) => {
    const row = familyOriginal(
      plan,
      index === 0 ? checkpoint.originalCatalogId : randomUUID(),
      "revision-from-the-other-backend",
    );
    row.origin.sha256 = plan.sha256;
    row.origin.byteLength = plan.byteLength;
    return row;
  });
  const processing = {
    processingCatalogId: checkpoint.processingCatalogId,
    originalCatalogId: originals[0].originalCatalogId,
    rowRevision: 1,
    copies: {
      primary: archiveCopy("primary"),
      independent_backup: archiveCopy("independent_backup"),
    },
  };
  const processings = [processing];
  const cleared = [];
  const parked = [];
  runner.archivedRows = () => ({ original: originals[0], processing });
  runner.archiveCatalog = {
    listOriginals: () => originals,
    listProcessings: () => processings,
    findOriginalExact: (probe) =>
      originals.find((row) => row.origin.sha256 === probe.sha256),
    async clearVoidAdmission(args) {
      cleared.push(args);
      const row = args.subject === "original_bytes" ? originals[0] : processing;
      delete row.cloud;
      row.receiptReconcile = [
        ...(row.receiptReconcile ?? []),
        {
          code: "original_receipt_unknown_to_server",
          clearedAt: args.clearedAt,
          by: args.by,
        },
      ];
      row.rowRevision += 1;
      return row;
    },
    async recordAdmissionBlock(args) {
      parked.push(args);
      originals[0].rowRevision += 1;
      originals[0].admissionBlock = {
        code: args.code,
        blockedAt: args.now,
        runnerCapability: args.runnerCapability,
        attempts: 1,
      };
      return originals[0];
    },
  };
  return {
    setup,
    journal,
    runner,
    originals,
    processing,
    processings,
    cleared,
    parked,
    sent,
  };
}

test("a backend that has lost every receipt clears nothing and parks on the safety limit", async () => {
  // The 2026-09-18 failure, but worse: three originals in flight and a server
  // that answers not found to all of them. The operator's dry-run count is
  // what used to stand between that and three re-admissions on the wrong
  // backend, and a pass does not read counts. The positive control does.
  const f = await voidBackendFixture(3);
  try {
    await f.runner.driveArchivedLookupOriginal();
    assert.deepEqual(f.cleared, [], "not one receipt is retired");
    assert.deepEqual(
      f.parked.map((entry) => entry.code),
      ["receipt_clear_refused_by_safety_limit"],
    );
    assert.equal(f.journal.pending, undefined, "the answer is settled");
    // Only the item's own read-only lookup. Nothing else is asked, because
    // there is nothing this worker can ask mid pass that would settle whether
    // the server or the document is at fault.
    assert.deepEqual(f.sent, ["discovery.lookupArchivedAdmission"]);
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

test("the automatic clear refuses a second time on the same row, a recent clear elsewhere, and a live sibling", async () => {
  for (const [name, mutate, expected] of [
    [
      "already cleared once",
      (f) => {
        f.originals[0].receiptReconcile = [
          {
            code: "original_receipt_unknown_to_server",
            clearedAt: Date.now() - 400 * 60 * 60_000,
            by: "pass",
          },
        ];
      },
      "original_receipt_unknown_to_server",
    ],
    [
      "another row cleared today",
      (f) => {
        f.originals[1].receiptReconcile = [
          {
            code: "original_receipt_unknown_to_server",
            clearedAt: Date.now() - 60_000,
            by: "pass",
          },
        ];
      },
      "receipt_clear_refused_by_safety_limit",
    ],
    [
      "a sibling processing row is activated",
      (f) => {
        f.processings.push({
          processingCatalogId: randomUUID(),
          originalCatalogId: f.originals[0].originalCatalogId,
          rowRevision: 1,
          activation: { state: "ready" },
        });
      },
      "original_receipt_unknown_to_server",
    ],
    [
      "this processing row is activated",
      (f) => {
        f.processing.activation = { state: "ready" };
      },
      "original_receipt_unknown_to_server",
    ],
    [
      "a processing receipt names another revision",
      (f) => {
        f.processing.cloud = { sourceRevisionId: "some-other-revision" };
      },
      "original_receipt_unknown_to_server",
    ],
  ]) {
    const f = await voidBackendFixture(2);
    mutate(f);
    try {
      await f.runner.driveArchivedLookupOriginal();
      assert.deepEqual(f.cleared, [], `${name}: nothing is cleared`);
      assert.deepEqual(
        f.parked.map((entry) => entry.code),
        [expected],
        name,
      );
    } finally {
      await f.journal.close();
      await rm(f.setup.base, { recursive: true, force: true });
    }
  }
});

test("the automatic clear proceeds only when this receipt is the only one in the catalog", async () => {
  // The one case a pass can settle alone: with no other receipt, there is
  // nothing a wider failure could be hiding, so the not-found answer can only
  // be about this document.
  const f = await voidBackendFixture(1);
  try {
    await f.runner.driveArchivedLookupOriginal();
    assert.deepEqual(
      f.cleared.map((entry) => `${entry.subject}:${entry.by}`),
      ["parser_output:pass", "original_bytes:pass"],
    );
    assert.deepEqual(f.parked, []);
    assert.equal(f.journal.checkpoint.step, "capture");
    assert.equal(f.journal.pending, undefined);
    assert.deepEqual(f.sent, ["discovery.lookupArchivedAdmission"]);
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

test("the reconcile command reports parked documents it cannot itself reach", async () => {
  // The pass walks past a parked document, so the checkpoint is no longer on
  // it and this command cannot address it. Saying so, with the count and the
  // codes, is what makes this the dry run for the operator route.
  const setup = await fixture(0);
  const journal = await openJournal(setup.journalDir, {
    version: 1,
    phase: "idle",
  });
  const original = familyOriginal(pdfPlan(), randomUUID(), "revision");
  original.admissionBlock = {
    code: "receipt_clear_refused_by_safety_limit",
    blockedAt: Date.now(),
    runnerCapability: "0".repeat(16),
    attempts: 1,
  };
  try {
    const result = await runReconcileReceipts({
      config: setup.config,
      journal,
      catalog: {
        listOriginals: () => [original],
        listProcessings: () => [],
      },
      transport: {
        async call() {
          throw new Error("a dry run outside the archived phase asks nothing");
        },
      },
      apply: false,
    });
    assert.equal(result.state, "refused");
    assert.equal(result.code, "checkpoint_not_archived");
    assert.equal(result.parkedOriginals, 1);
    assert.deepEqual(result.parkedCodes, [
      "receipt_clear_refused_by_safety_limit",
    ]);
    const text = formatReconcileResult(result);
    assert.match(text, /parked=1/);
    assert.match(text, /run --retry-parked --operator-clear/);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a pass that meets a void backend parks all three documents and ends needing attention", async () => {
  // The whole pass, not one document. Every original in flight is denied, so
  // every one parks, nothing is cleared, and the pass does not report itself
  // complete with the count buried in it.
  const f = await voidBackendFixture(3);
  try {
    for (let index = 0; index < 3; index += 1) {
      // Each document in turn, exactly as the pass walks them: park, move to
      // the next, ask again.
      f.runner.archivedRows = () => ({
        original: f.originals[index],
        processing: { ...f.processing, rowRevision: 1 },
      });
      f.runner.archiveCatalog.recordAdmissionBlock = async (args) => {
        f.parked.push(args);
        f.originals[index].admissionBlock = {
          code: args.code,
          blockedAt: args.now,
          runnerCapability: args.runnerCapability,
          attempts: 1,
        };
        f.originals[index].rowRevision += 1;
        return f.originals[index];
      };
      await f.journal.transitionCheckpoint({
        checkpoint: parseRunnerCheckpoint({
          ...f.journal.checkpoint,
          version: 1,
          phase: "archived",
          pdfIndex: index,
          step: "lookup_original",
          receiptChecked: true,
          originalCatalogId: f.originals[index].originalCatalogId,
          expectedOriginalRevision: 1,
          processingCatalogId: f.processing.processingCatalogId,
          expectedProcessingRevision: 1,
          reservationRound: 0,
          archivedPublished: 0,
        }),
        credentialSessionActive: true,
      });
      await f.runner.driveArchivedLookupOriginal();
    }
    assert.deepEqual(f.cleared, [], "not one receipt is retired");
    assert.equal(f.parked.length, 3);
    assert.deepEqual(
      new Set(f.parked.map((entry) => entry.code)),
      new Set(["receipt_clear_refused_by_safety_limit"]),
    );
    assert.equal(f.journal.pending, undefined);

    // The pass result an operator and a monitor read.
    const summarized = f.runner.withParked({ state: "complete", scanned: 3 });
    assert.equal(summarized.parked, 3);
    assert.equal(summarized.parkedEscalated, 3);
    assert.deepEqual(summarized.parkedCodes, [
      "receipt_clear_refused_by_safety_limit",
    ]);
    // `cli.ts` sets a nonzero exit for any state but `complete`, so this is
    // the exit status as well as the report.
    assert.equal(summarized.state, "incomplete");
    assert.equal(summarized.code, "items_need_attention");

    // A document still inside its retry budget is counted and leaves the pass
    // exactly as it was.
    for (const original of f.originals)
      original.admissionBlock = {
        ...original.admissionBlock,
        code: "catalog_conflict",
      };
    const retrying = f.runner.withParked({ state: "complete", scanned: 3 });
    assert.equal(retrying.state, "complete");
    assert.equal(retrying.code, undefined);
    assert.equal(retrying.parked, 3);
    assert.equal(retrying.parkedEscalated, 0);
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

test("the operator route repairs a receipt the automatic route would not touch", async () => {
  // The same catalog the automatic route parks: other receipts present, so it
  // cannot tell the server from the document. An operator who has read the dry
  // run has, so `--operator-clear` keeps only the conditions about the
  // document itself.
  const f = await voidBackendFixture(3);
  f.runner.options = { retryParked: true, operatorClear: true, maxClears: 5 };
  try {
    await f.runner.driveArchivedLookupOriginal();
    assert.deepEqual(
      f.cleared.map((entry) => `${entry.subject}:${entry.by}`),
      ["parser_output:operator", "original_bytes:operator"],
    );
    assert.deepEqual(f.parked, []);
    assert.equal(f.journal.checkpoint.step, "capture");
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

test("the operator clear stops at the number the operator authorized", async () => {
  // The relaxed rules reach every document whose own lookup comes back not
  // found, which is not the same set as the parked ones, so the cap is what
  // bounds the damage against a backend that is simply the wrong one.
  const f = await voidBackendFixture(3);
  f.runner.options = { retryParked: true, operatorClear: true, maxClears: 1 };
  try {
    for (let index = 0; index < 3; index += 1) {
      f.runner.archivedRows = () => ({
        original: f.originals[index],
        processing: { ...f.processing, rowRevision: 1 },
      });
      f.runner.archiveCatalog.recordAdmissionBlock = async (args) => {
        f.parked.push(args);
        f.originals[index].admissionBlock = {
          code: args.code,
          blockedAt: args.now,
          runnerCapability: args.runnerCapability,
          attempts: 1,
        };
        f.originals[index].rowRevision += 1;
        return f.originals[index];
      };
      await f.journal.transitionCheckpoint({
        checkpoint: parseRunnerCheckpoint({
          ...f.journal.checkpoint,
          version: 1,
          phase: "archived",
          pdfIndex: index,
          step: "lookup_original",
          receiptChecked: true,
          originalCatalogId: f.originals[index].originalCatalogId,
          expectedOriginalRevision: 1,
          processingCatalogId: f.processing.processingCatalogId,
          expectedProcessingRevision: 1,
          reservationRound: 0,
          archivedPublished: 0,
        }),
        credentialSessionActive: true,
      });
      await f.runner.driveArchivedLookupOriginal();
    }
    // One document repaired, the other two parked rather than swept along.
    assert.deepEqual(
      f.cleared.map((entry) => entry.subject),
      ["parser_output", "original_bytes"],
    );
    assert.deepEqual(
      f.parked.map((entry) => entry.code),
      [
        "receipt_clear_refused_by_safety_limit",
        "receipt_clear_refused_by_safety_limit",
      ],
    );
    const summarized = f.runner.withParked({ state: "complete", scanned: 3 });
    assert.equal(summarized.operatorClears, 1);
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

test("an operator clear pass that cannot ask the server clears nothing", async () => {
  // A refused or unanswered lookup is not a not-found answer. Neither shape
  // may retire a receipt, whoever started the pass.
  for (const respond of [
    async () => ({ error: { code: "source_unavailable" } }),
    async () => {
      throw new Error("timed out");
    },
  ]) {
    const f = await voidBackendFixture(2);
    f.runner.options = { retryParked: true, operatorClear: true, maxClears: 5 };
    f.runner.transport = { call: respond };
    try {
      await f.runner.driveArchivedLookupOriginal().catch(() => undefined);
      assert.deepEqual(f.cleared, []);
      assert.deepEqual(f.parked, []);
      assert.equal(
        f.runner.withParked({ state: "complete" }).operatorClears,
        undefined,
      );
    } finally {
      await f.journal.close();
      await rm(f.setup.base, { recursive: true, force: true });
    }
  }
});

test("the operator route still refuses what no route may repair", async () => {
  for (const mutate of [
    (f) => {
      f.processing.activation = { state: "ready" };
    },
    (f) => {
      f.processings.push({
        processingCatalogId: randomUUID(),
        originalCatalogId: f.originals[0].originalCatalogId,
        rowRevision: 1,
        activation: { state: "ready" },
      });
    },
    (f) => {
      f.processing.cloud = { sourceRevisionId: "some-other-revision" };
    },
  ]) {
    const f = await voidBackendFixture(2);
    f.runner.options = { retryParked: true, operatorClear: true, maxClears: 5 };
    mutate(f);
    try {
      await f.runner.driveArchivedLookupOriginal();
      assert.deepEqual(f.cleared, []);
      assert.deepEqual(
        f.parked.map((entry) => entry.code),
        ["original_receipt_unknown_to_server"],
      );
    } finally {
      await f.journal.close();
      await rm(f.setup.base, { recursive: true, force: true });
    }
  }
});

test("parking through the real catalog counts attempts across codes and escalates at the cap", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan({ discoveryState: "unchanged" });
  const journal = await openJournal(
    setup.journalDir,
    reconcileCheckpoint(plan),
  );
  const runner = new PipelineRunner(setup.config, journal, {
    async call() {
      throw new Error("parking asks the server nothing");
    },
  });
  const catalog = await openArchiveCatalog({ journal });
  runner.archiveCatalog = catalog;
  try {
    const original = await catalog.createOriginalIntent({
      originalCatalogId: randomUUID(),
      sourceExternalId: plan.externalId,
      origin: {
        scanId: "scan-1",
        observationEpoch: plan.observationEpoch,
        sha256: plan.sha256,
        byteLength: plan.byteLength,
        mediaType: "application/pdf",
      },
      copies: {
        primary: archiveCopy("primary"),
        independent_backup: distinctCopy(archiveCopy("independent_backup")),
      },
      createdAt: 1,
    });
    assert.equal(original.admissionBlock, undefined);
    // Alternating codes used to reset the count, so the document retried every
    // six hours for ever and never reached the cap.
    const codes = [
      "catalog_conflict",
      "provider_verification_stale_review_required",
      "catalog_conflict",
    ];
    for (const [index, code] of codes.entries()) {
      await runner.parkPlan(plan, code);
      const [row] = catalog.listOriginals();
      assert.equal(row.admissionBlock.code, code);
      assert.equal(row.admissionBlock.attempts, index + 1);
    }
    const [row] = catalog.listOriginals();
    assert.equal(row.admissionBlock.attempts, MAX_ADMISSION_BLOCK_ATTEMPTS);
    assert.equal(admissionBlockEscalated(row.admissionBlock), true);
    // Escalated, so the retry window no longer releases it.
    assert.equal(await runner.pdfNeedsArchivedWork(plan), false);
    // A code that never recovers escalates on its first park instead.
    assert.equal(
      admissionBlockEscalated({
        code: "original_receipt_revision_conflict",
        attempts: 1,
      }),
      true,
    );
    assert.equal(
      admissionBlockEscalated({ code: "catalog_conflict", attempts: 1 }),
      false,
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a reconcile still drains a lookup left answered and pending by an older build", async () => {
  // P2-31c's wedge: the throw happened inside the journaled transition, so the
  // answered lookup stayed unresolved and every later pass replayed it into
  // the same throw. This build repairs the state before it can happen, but a
  // journal written by the build that could is exactly what an operator
  // upgrading arrives with, so the command must still drain it.
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    step: "lookup_original",
    preflightAction: undefined,
    receiptChecked: true,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  let rows = voidReceiptRows(checkpoint, Date.now() - 120 * 60_000);
  const catalog = admissionCatalog(
    () => rows,
    (next) => (rows = next),
  );
  const sent = [];
  const transport = {
    async call(request) {
      sent.push(request.operation);
      throw new Error("the recorded answer is reused");
    },
  };
  // The exact leftover: the request recorded, the server's not-found answer
  // recorded with it, and no checkpoint move.
  const requestId = randomUUID();
  await journal.planRequest({
    operation: "discovery.lookupArchivedAdmission",
    requestId,
    requestBody: JSON.stringify({
      protocolVersion: 1,
      operation: "discovery.lookupArchivedAdmission",
      spaceId: setup.config.spaceId,
      sourceAccountId: setup.config.sourceAccountId,
      requestId,
      identity: archivedCheckpointIdentity(checkpoint),
      lookup: { mode: "original" },
    }),
    createdAt: Date.now(),
  });
  await journal.recordValidatedResult(lookupResponse(false), Date.now());
  try {
    assert.equal(
      journal.pending.operation,
      "discovery.lookupArchivedAdmission",
    );
    const result = await runReconcileReceipts({
      config: setup.config,
      journal,
      catalog,
      transport,
      apply: true,
    });
    assert.equal(result.state, "reconciled");
    assert.equal(result.receiptsUnknown, 1);
    assert.deepEqual(sent, [], "the recorded answer stands in for the call");
    assert.equal(rows.original.cloud, undefined);
    assert.deepEqual(
      rows.original.receiptReconcile.map((note) => note.by),
      ["operator"],
    );
    // The checkpoint is left alone: a transition refuses while a request is
    // unresolved, and the pending replay makes the same move by itself.
    assert.equal(journal.checkpoint.step, "lookup_original");
    assert.notEqual(journal.pending, undefined);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a server answer that renames an admitted revision parks that document", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    step: "lookup_original",
    preflightAction: undefined,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const rows = durableProviderRows(checkpoint, Date.now());
  rows.original.cloud = {
    sourceItemId: plan.sourceItemId,
    sourceRevisionId: "revision",
    primaryReceiptId: "original-primary",
    providerReferenceId: "provider-reference",
    providerBindingEpoch: 0,
    admittedAt: 1,
  };
  const runner = new PipelineRunner(setup.config, journal, {
    async call() {
      return {
        operation: "discovery.lookupArchivedAdmission",
        mode: "original",
        found: true,
        // A revision is immutable once admitted, so this cannot be both true
        // and the receipt the catalog holds. Reaching it means one of the two
        // beliefs is wrong, and nothing downstream may read either as a fact.
        sourceRevisionId: "a-revision-the-catalog-never-recorded",
        originalPrimaryReceiptId: "original-primary",
        originalPrimaryBindingEpoch: 0,
        originalProviderReferenceId: "provider-reference",
        originalProviderBindingEpoch: 0,
      };
    },
  });
  runner.archivedRows = () => rows;
  const parked = [];
  runner.archiveCatalog = {
    listOriginals: () => [rows.original],
    listProcessings: () => [rows.processing],
    findOriginalExact: () => rows.original,
    async recordAdmissionBlock(args) {
      parked.push(args);
      return rows.original;
    },
  };
  try {
    await runner.driveArchivedLookupOriginal();
    assert.equal(journal.pending, undefined, "the answer is not left owing");
    // P2-31f: the disagreement is about this one document, so it is parked and
    // the pass walks on rather than every other file paying for it.
    assert.equal(journal.checkpoint.phase, "discovery_reserve");
    assert.deepEqual(
      parked.map((entry) => entry.code),
      ["original_receipt_revision_conflict"],
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a stale proof refreshes before any new lease and the recovery pass reserves once", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    step: "admit",
    preflightAction: undefined,
    discoveryLease: {
      workId: "work",
      sourceItemId: plan.sourceItemId,
      observationEpoch: 1,
      processingEpoch: 1,
      leaseEpoch: 1,
      leaseToken: TOKEN,
      // The wedged row's lease expired many passes ago.
      leaseExpiresAt: Date.now() - 60 * 60_000,
    },
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  let rows = durableProviderRows(checkpoint, Date.now() - 45 * 60_000);
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request.operation);
      if (request.operation === "discovery.reserveArchived")
        return {
          operation: "discovery.reserveArchived",
          workId: "work",
          sourceItemId: plan.sourceItemId,
          observationEpoch: plan.observationEpoch,
          processingEpoch: plan.processingEpoch,
          leaseEpoch: 2,
          leaseToken: TOKEN,
          leaseExpiresAt: Date.now() + 60_000,
          reused: false,
        };
      return admittedResponse(plan);
    },
  });
  runner.archivedRows = () => rows;
  runner.mappedProcessing = async () => ({
    original: rows.original,
    processing: rows.processing,
    declaration: parsedDeclaration(),
  });
  runner.archiveCatalog = admissionCatalog(
    () => rows,
    (next) => (rows = next),
  );
  let refreshes = 0;
  runner.refreshProviderProof = async (current) => {
    refreshes += 1;
    // The real method reads the provider and the snapshot again, then commits
    // the two timestamps before the checkpoint.
    rows = freshenProviderProof(rows);
    await journal.transitionCheckpoint({
      checkpoint: parseRunnerCheckpoint({ ...current }),
      credentialSessionActive: true,
    });
  };
  try {
    // The expired lease must not be renewed before the proof is refreshed.
    // Every reserve spends one of the row's bounded discovery attempts, and a
    // lease taken here would sit idle across two provider round trips.
    await runner.driveArchivedAdmit();
    assert.equal(refreshes, 1);
    assert.deepEqual(sent, []);
    assert.equal(journal.checkpoint.step, "admit");
    // The refreshed pass then takes exactly one lease and admits under it.
    await runner.driveArchivedAdmit();
    assert.equal(journal.checkpoint.step, "reserve");
    await runner.driveArchivedReserve();
    assert.equal(journal.checkpoint.step, "admit");
    await runner.driveArchivedAdmit();
    assert.equal(refreshes, 1);
    assert.deepEqual(sent, [
      "discovery.reserveArchived",
      "discovery.admitArchived",
    ]);
    assert.equal(rows.original.cloud.providerReferenceId, "provider-reference");
    assert.equal(journal.checkpoint.step, "parsed_reserve");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a refresh whose catalog write already committed is not repeated on the next pass", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = admitCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  // A crash between the refresh's catalog write and its checkpoint commit
  // leaves a fresh proof behind. The next pass must admit under it, not read
  // the provider and the snapshot again.
  let rows = durableProviderRows(checkpoint, Date.now());
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request.operation);
      return admittedResponse(plan);
    },
  });
  runner.archivedRows = () => rows;
  runner.mappedProcessing = async () => ({
    original: rows.original,
    processing: rows.processing,
    declaration: parsedDeclaration(),
  });
  runner.archiveCatalog = admissionCatalog(
    () => rows,
    (next) => (rows = next),
  );
  runner.refreshProviderProof = async () => {
    throw new Error("a fresh proof must not be refreshed again");
  };
  try {
    await runner.driveArchivedAdmit();
    assert.deepEqual(sent, ["discovery.admitArchived"]);
    assert.equal(journal.checkpoint.step, "parsed_reserve");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a receipt the server does not know is named for what it is, not as a provider fault", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  // The live 2026-09-18 state. A misrouted web build admitted this original
  // against a backend that no longer serves the account, so the catalog holds a
  // receipt whose ids the authoritative server has never seen. The proof is two
  // hours old, the lease expired, and the checkpoint resumes straight at admit.
  const checkpoint = archivedCheckpoint(plan, {
    step: "admit",
    preflightAction: undefined,
    discoveryLease: {
      workId: "work",
      sourceItemId: plan.sourceItemId,
      observationEpoch: 1,
      processingEpoch: 1,
      leaseEpoch: 9,
      leaseToken: TOKEN,
      leaseExpiresAt: Date.now() - 60 * 60_000,
    },
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const rows = durableProviderRows(checkpoint, Date.now() - 120 * 60_000);
  rows.original.cloud = {
    sourceItemId: "item-from-the-other-backend",
    sourceRevisionId: "revision-from-the-other-backend",
    primaryReceiptId: "original-primary",
    providerReferenceId: "provider-reference",
    providerBindingEpoch: 0,
    admittedAt: Date.now() - 120 * 60_000,
  };
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request.operation);
      return {
        operation: "discovery.lookupArchivedAdmission",
        mode: "original",
        found: false,
      };
    },
  });
  runner.archivedRows = () => rows;
  runner.mappedProcessing = async () => ({
    ...rows,
    declaration: parsedDeclaration(),
  });
  runner.refreshProviderProof = async () => {
    throw new Error("a receipt question must be settled before any refresh");
  };
  let current = rows;
  runner.archiveCatalog = admissionCatalog(
    () => current,
    (next) => (current = next),
  );
  runner.archivedRows = () => current;
  try {
    // The admit asks the server instead of refusing blind, and drops the dead
    // lease rather than renewing it.
    await runner.driveArchivedAdmit();
    assert.deepEqual(sent, []);
    assert.equal(journal.checkpoint.step, "lookup_original");
    assert.equal(journal.checkpoint.receiptChecked, true);
    assert.equal(journal.checkpoint.discoveryLease, undefined);
    // P2-31f. The server says it has never seen this revision and the catalog
    // says it was admitted. P2-31d proved which narrow conditions make
    // retiring that receipt safe, and they hold here, so the pass runs the
    // same clear itself and carries straight on to capture. No throw, no
    // wedged journal, and no operator command.
    await runner.driveArchivedLookupOriginal();
    assert.deepEqual(sent, ["discovery.lookupArchivedAdmission"]);
    assert.equal(journal.checkpoint.step, "capture");
    assert.equal(journal.pending, undefined);
    assert.equal(current.original.cloud, undefined);
    assert.equal(current.original.copies.primary.cloudReceipt, undefined);
    assert.deepEqual(
      current.original.receiptReconcile.map((note) => note.by),
      ["pass"],
    );
    assert.equal(current.original.admissionBlock, undefined);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a receipt the server does confirm still refuses at admit, and asks only once", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    step: "admit",
    preflightAction: undefined,
    receiptChecked: true,
    discoveryLease: {
      workId: "work",
      sourceItemId: plan.sourceItemId,
      observationEpoch: 1,
      processingEpoch: 1,
      leaseEpoch: 9,
      leaseToken: TOKEN,
      leaseExpiresAt: Date.now() - 60 * 60_000,
    },
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const rows = durableProviderRows(checkpoint, Date.now() - 120 * 60_000);
  rows.original.cloud = {
    sourceItemId: plan.sourceItemId,
    sourceRevisionId: "revision",
    primaryReceiptId: "original-primary",
    providerReferenceId: "provider-reference",
    providerBindingEpoch: 0,
    admittedAt: 1,
  };
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request.operation);
      throw new Error("the question has already been asked this cycle");
    },
  });
  runner.archivedRows = () => rows;
  runner.mappedProcessing = async () => ({
    ...rows,
    declaration: parsedDeclaration(),
  });
  try {
    await assert.rejects(
      () => runner.driveArchivedAdmit(),
      (error) => error.code === "provider_original_reference_already_bound",
    );
    assert.deepEqual(sent, [], "no attempt and no round trip on the retry");
    assert.equal(journal.checkpoint.step, "admit");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("an already bound provider reference stops the admit before it spends a lease", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  // The live P2-31b shape: the server already recorded this original's provider
  // reference (`driveArchivedLookupOriginal` wrote `cloud` from a `found`
  // lookup), the processing leg was never admitted, the proof aged out long
  // ago, and the lease expired several passes back.
  const checkpoint = archivedCheckpoint(plan, {
    step: "admit",
    preflightAction: undefined,
    discoveryLease: {
      workId: "work",
      sourceItemId: plan.sourceItemId,
      observationEpoch: 1,
      processingEpoch: 1,
      leaseEpoch: 1,
      leaseToken: TOKEN,
      leaseExpiresAt: Date.now() - 60 * 60_000,
    },
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const rows = durableProviderRows(checkpoint, Date.now() - 45 * 60_000);
  rows.original.cloud = {
    sourceItemId: plan.sourceItemId,
    sourceRevisionId: "revision",
    primaryReceiptId: "original-primary",
    providerReferenceId: "provider-reference",
    providerBindingEpoch: 0,
    admittedAt: 1,
  };
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request.operation);
      throw new Error("a bound reference must not be re-declared");
    },
  });
  runner.archivedRows = () => rows;
  runner.mappedProcessing = async () => ({
    ...rows,
    declaration: parsedDeclaration(),
  });
  runner.refreshProviderProof = async () => {
    throw new Error("an admitted original must not be refreshed");
  };
  try {
    // Pass one. Before this fix the expired lease sent the pass to `reserve`,
    // which spent one of the row's eight discovery attempts, and only then did
    // `providerDeclaration` throw a stale-proof code for a row whose proof was
    // never the problem. Now the receipt question is asked first (P2-31c) and
    // the dead lease is dropped rather than renewed.
    await runner.driveArchivedAdmit();
    assert.deepEqual(sent, [], "no attempt is spent on an unadmittable row");
    assert.equal(journal.checkpoint.step, "lookup_original");
    assert.equal(journal.checkpoint.discoveryLease, undefined);
    // Once the question has been asked, the refusal stands and stays free.
    await journal.transitionCheckpoint({
      checkpoint: parseRunnerCheckpoint({
        ...journal.checkpoint,
        step: "admit",
        discoveryLease: {
          workId: "work",
          sourceItemId: plan.sourceItemId,
          observationEpoch: 1,
          processingEpoch: 1,
          leaseEpoch: 1,
          leaseToken: TOKEN,
          leaseExpiresAt: Date.now() - 60 * 60_000,
        },
      }),
      credentialSessionActive: true,
    });
    await assert.rejects(
      () => runner.driveArchivedAdmit(),
      (error) => error.code === "provider_original_reference_already_bound",
    );
    assert.deepEqual(sent, []);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a durable admit replay keeps its persisted declaration instead of refreshing", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = admitCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  const rows = durableProviderRows(checkpoint, Date.now() - 45 * 60_000);
  const runner = new PipelineRunner(setup.config, journal, {
    async call() {
      throw new Error("unused");
    },
  });
  runner.archivedRows = () => rows;
  runner.mappedProcessing = async () => ({
    ...rows,
    declaration: parsedDeclaration(),
  });
  runner.refreshProviderProof = async () => {
    throw new Error("a replayed admission must not be refreshed");
  };
  let requireFresh;
  runner.providerDeclaration = (_row, fresh) => {
    requireFresh = fresh;
    throw new Error("declaration reached");
  };
  const requestId = randomUUID();
  await journal.planRequest({
    operation: "discovery.admitArchived",
    requestId,
    requestBody: JSON.stringify({
      protocolVersion: 1,
      operation: "discovery.admitArchived",
      spaceId: "space",
      sourceAccountId: "source",
      requestId,
    }),
    createdAt: 1,
  });
  try {
    // A replayed call reuses its journaled body, so it must not be rerouted
    // into a refresh that would abandon the request the server may have run.
    await assert.rejects(
      () => runner.driveArchivedAdmit(),
      /declaration reached/,
    );
    assert.equal(requireFresh, false);
    assert.equal(journal.checkpoint.step, "admit");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a provider proof refresh fails closed before reading the provider", async () => {
  const setup = await fixture(0);
  const registryPath = join(setup.base, "provider-registry");
  await mkdir(registryPath, { mode: 0o700 });
  const registryDirectory = await realpath(registryPath);
  await chmod(registryDirectory, 0o700);
  const plan = pdfPlan();
  const checkpoint = admitCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  const rows = durableProviderRows(checkpoint, Date.now() - 45 * 60_000);
  rows.processing.captureIntent = {
    captureId: randomUUID(),
    directory: { device: 1, inode: 2 },
  };
  rows.processing.capture = {
    sourceModifiedAt: 1,
    device: 1,
    inode: 2,
    mode: 0o600,
  };
  const providerConfig = {
    registryDirectory,
    rootAlias: plan.rootAlias,
    providerAccountIdHash: "1".repeat(64),
    providerRootDirectoryIdHash: "2".repeat(64),
    providerRootDirectoryId: "id:root",
  };
  const pdfDocQa = {
    captureDirectory: setup.root,
    archive: { independentBackup: { repository: {} } },
    providerOriginal: providerConfig,
  };
  const runner = new PipelineRunner({ ...setup.config, pdfDocQa }, journal, {
    async call() {
      throw new Error("a refresh must not call the transport");
    },
  });
  runner.archivedRows = () => rows;
  try {
    // No registry manifest backs the recorded fingerprint, so the refresh stops
    // before it reads Dropbox or the snapshot.
    await assert.rejects(
      () => runner.refreshProviderProof(checkpoint),
      (error) => error.code === "provider_locator_registry_missing",
    );
    // A root the configuration no longer binds stops it even earlier.
    runner.config.pdfDocQa.providerOriginal = {
      ...providerConfig,
      rootAlias: "other",
    };
    await assert.rejects(
      () => runner.refreshProviderProof(checkpoint),
      (error) => error.code === "provider_original_root_mismatch",
    );
    // So does a locator already held for replacement review.
    runner.config.pdfDocQa.providerOriginal = providerConfig;
    rows.original.providerOriginal.locator.reviewCode = "replacement_detected";
    await assert.rejects(
      () => runner.refreshProviderProof(checkpoint),
      (error) => error.code === "provider_locator_recovery_review_required",
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("archived pending bodies are rebuilt from catalog and spool state", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan);
  const journal = await openJournal(setup.journalDir, checkpoint);
  const original = {
    originalCatalogId: checkpoint.originalCatalogId,
    copies: {
      primary: archiveCopy("primary"),
      independent_backup: archiveCopy("independent_backup"),
    },
  };
  const processing = {
    processingCatalogId: checkpoint.processingCatalogId,
    copies: {
      primary: archiveCopy("primary"),
      independent_backup: archiveCopy("independent_backup"),
    },
  };
  const identity = {
    sourceItemId: plan.sourceItemId,
    scanId: checkpoint.scanId,
    observationEpoch: plan.observationEpoch,
    processingEpoch: plan.processingEpoch,
    contentHash: plan.sha256,
    byteLength: plan.byteLength,
    mediaType: "application/pdf",
    parserProfileId: plan.parserProfileId,
    parserFingerprint: plan.parserFingerprint,
    extractionConfigurationFingerprint: plan.extractionConfigurationFingerprint,
    extractorFingerprint: plan.extractorFingerprint,
    recordSchemaFingerprint: plan.recordSchemaFingerprint,
    normalizationFingerprint: plan.normalizationFingerprint,
    chunkerFingerprint: plan.chunkerFingerprint,
    correctionRevision: plan.correctionRevision,
  };
  const runner = new PipelineRunner(setup.config, journal, {
    async call() {
      throw new Error("tampered request must not reach transport");
    },
  });
  runner.archivedRows = () => ({ original, processing });
  try {
    await assert.rejects(
      () =>
        runner.validatePendingBody("discovery.preflightArchived", {
          protocolVersion: 1,
          operation: "discovery.preflightArchived",
          spaceId: "space",
          sourceAccountId: "source",
          requestId: randomUUID(),
          identity,
          archiveIntentDigest: "b".repeat(64),
        }),
      (error) => error.code === "journal_phase_conflict",
    );

    const lease = {
      jobId: "parsed-job",
      workId: "archived-work",
      sourceItemId: plan.sourceItemId,
      observationEpoch: plan.observationEpoch,
      processingEpoch: plan.processingEpoch,
      state: "processing",
      leaseEpoch: 1,
      leaseToken: TOKEN,
      leaseExpiresAt: Date.now() + 60_000,
    };
    await journal.transitionCheckpoint({
      checkpoint: archivedCheckpoint(plan, {
        step: "parsed_begin",
        preflightAction: undefined,
        jobLease: lease,
      }),
      credentialSessionActive: true,
    });
    const declaration = {
      extractionFingerprint: HASH,
      textHash: HASH,
      byteLength: 10,
      utf16Length: 10,
      pageCount: 1,
      mappingManifestHash: HASH,
      normalizedBundleDigest: HASH,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
    };
    runner.mappedProcessing = async () => ({ declaration });
    await assert.rejects(
      () =>
        runner.validatePendingBody("jobs.stageParsedBegin", {
          protocolVersion: 1,
          operation: "jobs.stageParsedBegin",
          spaceId: "space",
          sourceAccountId: "source",
          requestId: randomUUID(),
          jobId: lease.jobId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
          extractionFingerprint: declaration.extractionFingerprint,
          mappingManifestHash: declaration.mappingManifestHash,
          normalizedBundleDigest: declaration.normalizedBundleDigest,
          expectedPageCount: 2,
          expectedEvidenceSpanCount: declaration.expectedEvidenceSpanCount,
          expectedDocumentCount: declaration.expectedDocumentCount,
          expectedChunkCount: declaration.expectedChunkCount,
        }),
      (error) => error.code === "journal_phase_conflict",
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("successive PDF reconciles skip activated unchanged work and resume incomplete work", async () => {
  async function reconcile(discoveryState, processingRows) {
    const setup = await fixture(0);
    const plan = pdfPlan({ discoveryState });
    const checkpoint = parseRunnerCheckpoint({
      version: 1,
      phase: "reconcile",
      mode: "normal",
      scanId: `scan-${randomUUID()}`,
      inventoryEpoch: 1,
      manifestVersion: 1,
      missingBindings: [],
      files: [plan],
      ordinal: 0,
      reviewSeen: false,
    });
    const journal = await openJournal(setup.journalDir, checkpoint);
    const original = { originalCatalogId: randomUUID(), rowRevision: 1 };
    const runner = new PipelineRunner(setup.config, journal, {
      async call() {
        return {
          operation: "scan.reconcile",
          scanId: checkpoint.scanId,
          done: true,
          state: "enumerated",
          inspected: 0,
          unavailable: 0,
          reused: false,
        };
      },
    });
    const fingerprints = runner.processingFingerprints(plan);
    runner.archiveCatalog = {
      findOriginalExact() {
        return original;
      },
      listOriginals() {
        return [original];
      },
      async recordAdmissionBlock() {
        return original;
      },
      listProcessings() {
        return processingRows.map((row) => ({
          originalCatalogId: original.originalCatalogId,
          currentObservation: {
            scanId: "prior-scan",
            observationEpoch: plan.observationEpoch,
            processingEpoch: plan.processingEpoch,
          },
          fingerprints,
          ...row,
        }));
      },
    };
    try {
      await runner.driveReconcile();
      return journal.checkpoint;
    } finally {
      await journal.close();
      await rm(setup.base, { recursive: true, force: true });
    }
  }

  function readyRow(suffix) {
    return {
      processingCatalogId: `processing-${suffix}`,
      cloud: {
        ingestJobId: `job-${suffix}`,
        processingGenerationId: `generation-${suffix}`,
      },
      activation: {
        state: "ready",
        jobId: `job-${suffix}`,
        processingGenerationId: `generation-${suffix}`,
      },
    };
  }

  assert.equal((await reconcile("queued", [])).phase, "archived");
  assert.equal(
    (await reconcile("unchanged", [{ activation: { state: "ready" } }])).phase,
    "discovery_reserve",
  );
  assert.equal(
    (await reconcile("unchanged", [{ activation: undefined }])).phase,
    "archived",
  );
  assert.equal(
    (
      await reconcile("unchanged", [
        { processingCatalogId: "incomplete" },
        readyRow("published"),
      ])
    ).phase,
    "discovery_reserve",
  );
  // P2-31e settled the answered page instead of throwing out of the journaled
  // transition. P2-31f goes one step further: neither history is judged, but
  // the refusal is now per document, so the scan moves on with that one parked.
  for (const rows of [
    [readyRow("first"), readyRow("second")],
    [{ processingCatalogId: "first" }, { processingCatalogId: "second" }],
  ]) {
    const checkpoint = await reconcile("unchanged", rows);
    assert.equal(checkpoint.phase, "discovery_reserve");
  }
  const incoherent = await reconcile("unchanged", [
    { processingCatalogId: "incomplete" },
    {
      ...readyRow("incoherent"),
      cloud: {
        ingestJobId: "different-job",
        processingGenerationId: "generation-incoherent",
      },
    },
  ]);
  assert.equal(incoherent.phase, "discovery_reserve");
});

test("journal loss after activation routes retained plaintext to cleanup only", async () => {
  const setup = await fixture(0);
  const captures = join(setup.base, "retained-captures");
  const outputs = join(setup.base, "retained-outputs");
  const spool = join(setup.base, "retained-spool");
  await Promise.all(
    [captures, outputs, spool].map((path) => mkdir(path, { mode: 0o700 })),
  );
  const plan = pdfPlan({ discoveryState: "unchanged" });
  const checkpoint = archivedCheckpoint(plan, {
    step: "intent",
    preflightAction: undefined,
    originalCatalogId: undefined,
    expectedOriginalRevision: undefined,
    processingCatalogId: undefined,
    expectedProcessingRevision: undefined,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const original = { originalCatalogId: randomUUID() };
  const runner = new PipelineRunner(
    {
      ...setup.config,
      pdfDocQa: {
        captureDirectory: captures,
        parserOutputRoot: outputs,
        spoolDirectory: spool,
      },
    },
    journal,
    {
      async call() {
        throw new Error("network is not used");
      },
    },
  );
  const fingerprints = runner.processingFingerprints(plan);
  const captureId = randomUUID();
  await writeFile(join(captures, `${captureId}.pdf`), "retained", {
    mode: 0o600,
  });
  const processing = {
    processingCatalogId: randomUUID(),
    originalCatalogId: original.originalCatalogId,
    rowRevision: 9,
    currentObservation: {
      scanId: "lost-journal-scan",
      observationEpoch: plan.observationEpoch,
      processingEpoch: plan.processingEpoch,
    },
    fingerprints,
    captureIntent: { captureId },
    capture: {},
    parserIntent: { outputId: randomUUID() },
    parserOutput: {},
    spool: { opaqueName: `${randomUUID()}.json` },
    cloud: {
      ingestJobId: "published-job",
      processingGenerationId: "published-generation",
    },
    activation: {
      state: "ready",
      jobId: "published-job",
      processingGenerationId: "published-generation",
    },
  };
  const incomplete = {
    ...processing,
    processingCatalogId: randomUUID(),
    currentObservation: {
      ...processing.currentObservation,
      scanId: "interrupted-prior-scan",
    },
    captureIntent: { captureId: randomUUID() },
    capture: {},
    cloud: undefined,
    activation: undefined,
  };
  runner.archiveCatalog = {
    findOriginalExact() {
      return original;
    },
    findProcessingExact() {
      return undefined;
    },
    listProcessings() {
      return [incomplete, processing];
    },
  };
  try {
    assert.equal(await runner.pdfNeedsArchivedWork(plan), true);
    const resumed = await runner.createArchivedIntents(checkpoint);
    assert.equal(resumed.step, "cleanup");
    assert.equal(resumed.countPublication, false);
    assert.equal(resumed.processingCatalogId, processing.processingCatalogId);
    assert.equal(resumed.expectedProcessingRevision, processing.rowRevision);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a lost parsed-stage request that expires is consumed before a fresh reservation", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const lease = {
    jobId: "parsed-job",
    workId: "archived-work",
    sourceItemId: plan.sourceItemId,
    observationEpoch: plan.observationEpoch,
    processingEpoch: plan.processingEpoch,
    state: "processing",
    leaseEpoch: 1,
    leaseToken: TOKEN,
    leaseExpiresAt: 1,
  };
  const checkpoint = archivedCheckpoint(plan, {
    step: "parsed_begin",
    preflightAction: undefined,
    jobLease: lease,
  });
  const declaration = {
    extractionFingerprint: HASH,
    textHash: HASH,
    byteLength: 10,
    utf16Length: 10,
    pageCount: 1,
    mappingManifestHash: HASH,
    normalizedBundleDigest: HASH,
    expectedEvidenceSpanCount: 1,
    expectedDocumentCount: 1,
    expectedChunkCount: 1,
  };
  const requestId = randomUUID();
  const body = {
    protocolVersion: 1,
    operation: "jobs.stageParsedBegin",
    spaceId: "space",
    sourceAccountId: "source",
    requestId,
    jobId: lease.jobId,
    leaseEpoch: lease.leaseEpoch,
    leaseToken: lease.leaseToken,
    extractionFingerprint: declaration.extractionFingerprint,
    mappingManifestHash: declaration.mappingManifestHash,
    normalizedBundleDigest: declaration.normalizedBundleDigest,
    expectedPageCount: declaration.pageCount,
    expectedEvidenceSpanCount: declaration.expectedEvidenceSpanCount,
    expectedDocumentCount: declaration.expectedDocumentCount,
    expectedChunkCount: declaration.expectedChunkCount,
  };
  const journal = await openJournal(setup.journalDir, checkpoint);
  await journal.planRequest({
    operation: body.operation,
    requestId,
    requestBody: JSON.stringify(body),
    createdAt: 1,
  });
  const sent = [];
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      sent.push(request);
      return { error: { code: "reservation_expired" } };
    },
  });
  runner.mappedProcessing = async () => ({ declaration });
  try {
    await runner.driveParsedBegin();
    assert.deepEqual(sent, [body]);
    assert.equal(journal.pending, undefined);
    assert.equal(journal.checkpoint.phase, "archived");
    assert.equal(journal.checkpoint.step, "parsed_reserve");
    assert.equal(journal.checkpoint.jobLease, undefined);
    assert.equal(journal.checkpoint.stageId, undefined);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("parsed reservation targets only the admitted job and waits without leasing backlog", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const checkpoint = archivedCheckpoint(plan, {
    step: "parsed_reserve",
    preflightAction: undefined,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const processing = {
    processingCatalogId: checkpoint.processingCatalogId,
    currentObservation: {
      scanId: checkpoint.scanId,
      observationEpoch: plan.observationEpoch,
      processingEpoch: plan.processingEpoch,
    },
    cloud: {
      ingestJobId: "exact-parsed-job",
      sourceItemId: plan.sourceItemId,
    },
  };
  const requests = [];
  let attempt = 0;
  const runner = new PipelineRunner(setup.config, journal, {
    async call(body) {
      requests.push(body);
      attempt += 1;
      return {
        operation: "jobs.reserveParsed",
        receiptId: randomUUID(),
        expiresAt: Date.now() + 60_000,
        reused: false,
        targets:
          attempt === 1
            ? []
            : [
                {
                  jobId: processing.cloud.ingestJobId,
                  workId: "archived-work",
                  sourceItemId: plan.sourceItemId,
                  observationEpoch: plan.observationEpoch,
                  processingEpoch: plan.processingEpoch,
                  state: "processing",
                  leaseEpoch: 1,
                  leaseToken: TOKEN,
                  leaseExpiresAt: Date.now() + 60_000,
                },
              ],
      };
    },
  });
  runner.archivedRows = () => ({ original: {}, processing });
  try {
    await assert.rejects(
      () => runner.driveParsedReserve(),
      (error) => error.code === "parsed_job_deferred",
    );
    assert.equal(requests.length, 1);
    assert.equal(journal.checkpoint.step, "parsed_reserve");
    assert.equal(journal.checkpoint.reservationRound, 1);

    await runner.driveParsedReserve();
    assert.equal(journal.checkpoint.step, "parsed_begin");
    assert.equal(
      journal.checkpoint.jobLease.jobId,
      processing.cloud.ingestJobId,
    );
    assert.equal(requests.length, 2);
    for (const body of requests) {
      assert.equal(body.maxItems, 1);
      assert.equal(body.jobId, processing.cloud.ingestJobId);
    }

    await journal.transitionCheckpoint({
      checkpoint,
      credentialSessionActive: true,
    });
    await assert.rejects(
      () =>
        runner.validatePendingBody("jobs.reserveParsed", {
          ...requests[0],
          requestId: randomUUID(),
          jobId: "unrelated-parsed-job",
        }),
      (error) => error.code === "journal_phase_conflict",
    );
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test(
  "cleanup checkpoint replay succeeds after every exact local artifact is already absent",
  {
    skip:
      process.platform !== "darwin" &&
      "macOS is the supported cleanup boundary",
  },
  async () => {
    const plan = pdfPlan();
    const checkpoint = archivedCheckpoint(plan, {
      step: "cleanup",
      preflightAction: undefined,
    });
    const { journal, ...setup } = await fixtureWithJournal(0, checkpoint);
    const requestedCaptureDirectory = join(setup.base, "captures");
    const requestedParserOutputRoot = join(setup.base, "outputs");
    const requestedSpoolDirectory = join(setup.base, "spool");
    await Promise.all(
      [
        requestedCaptureDirectory,
        requestedParserOutputRoot,
        requestedSpoolDirectory,
      ].map((path) => mkdir(path, { mode: 0o700 })),
    );
    const [captureDirectory, parserOutputRoot, spoolDirectory] =
      await Promise.all(
        [
          requestedCaptureDirectory,
          requestedParserOutputRoot,
          requestedSpoolDirectory,
        ].map((path) => realpath(path)),
      );
    const [captureStat, outputStat, spoolStat] = await Promise.all(
      [captureDirectory, parserOutputRoot, spoolDirectory].map(lstat),
    );
    const captureId = randomUUID();
    const outputId = randomUUID();
    const spoolId = randomUUID();
    const original = {
      originalCatalogId: checkpoint.originalCatalogId,
      origin: { sha256: plan.sha256, byteLength: plan.byteLength },
    };
    const processing = {
      processingCatalogId: checkpoint.processingCatalogId,
      captureIntent: {
        captureId,
        directory: { device: captureStat.dev, inode: captureStat.ino },
      },
      capture: {
        opaqueName: captureId,
        device: 10,
        inode: 11,
        sha256: plan.sha256,
        byteLength: plan.byteLength,
        sourceModifiedAt: plan.sourceModifiedAt,
        directory: { device: captureStat.dev, inode: captureStat.ino },
      },
      parserIntent: {
        outputId,
        outputRoot: { device: outputStat.dev, inode: outputStat.ino },
        outputDirectory: { device: 10, inode: 12 },
        parserArtifactClientId: randomUUID(),
      },
      parserOutput: {
        outputId,
        outputRoot: { device: outputStat.dev, inode: outputStat.ino },
        outputDirectory: { device: 10, inode: 12 },
        rawArtifact: {
          opaqueName: "lossless.json",
          device: 10,
          inode: 13,
          sha256: HASH,
          byteLength: 10,
        },
        normalizedBundle: {
          opaqueName: "bundle.json",
          device: 10,
          inode: 14,
          sha256: HASH,
          byteLength: 10,
        },
      },
      spoolIntent: {
        spoolId,
        root: { device: spoolStat.dev, inode: spoolStat.ino },
      },
      spool: {
        opaqueName: `${spoolId}.json`,
        device: 10,
        inode: 15,
        sha256: HASH,
        byteLength: 10,
      },
    };
    const runner = new PipelineRunner(
      {
        ...setup.config,
        pdfDocQa: { captureDirectory, parserOutputRoot, spoolDirectory },
      },
      journal,
      {
        async call() {
          throw new Error("network is not used");
        },
      },
    );
    runner.archivedRows = () => ({ original, processing });
    runner.archiveCatalog = {
      requireProcessingActivation(id) {
        assert.equal(id, processing.processingCatalogId);
        return { state: "ready" };
      },
    };
    try {
      await runner.driveArchivedCleanup();
      assert.equal(journal.checkpoint.phase, "discovery_reserve");
      assert.equal(journal.checkpoint.archivedPublished, 1);
    } finally {
      await journal.close();
      await rm(setup.base, { recursive: true, force: true });
    }
  },
);

/**
 * P2-104b. After a parser upgrade the catalog holds an activated row from the
 * old parser and, once the document is re-parsed, an activated row from the
 * new one. Both are internally coherent and both answer to the same original
 * receipt revision, which is exactly the shape PR 277 taught
 * `reusableProcessingRow` to refuse.
 *
 * It must not refuse this one. `matchingProcessingRows` narrows on the whole
 * fingerprint tuple before `reusableProcessingRow` ever sees a row, so a row
 * produced by a different parser is not a competing answer about this
 * processing identity: it is a record of a previous one. If that narrowing
 * ever stops happening, every upgraded document parks on
 * `archive_catalog_revision_conflict` on the pass after the upgrade.
 */
function twoParserGenerations(runner, plan, originalCatalogId) {
  const current = runner.processingFingerprints(plan);
  const previous = { ...current, parserFingerprint: "9".repeat(64) };
  const row = (fingerprints) => ({
    processingCatalogId: randomUUID(),
    originalCatalogId,
    rowRevision: 1,
    createdAt: 1,
    currentObservation: {
      scanId: "scan-0",
      observationEpoch: plan.observationEpoch,
      processingEpoch: plan.processingEpoch,
    },
    fingerprints,
    copies: {
      primary: archiveCopy("primary"),
      independent_backup: archiveCopy("independent_backup"),
    },
    cloud: {
      sourceItemId: plan.sourceItemId,
      sourceRevisionId: "revision",
      parserArtifactId: "artifact",
      sourceTextVersionId: "text",
      processingGenerationId: "generation",
      ingestJobId: "job",
      processingFingerprint: HASH,
      admissionRequestDigest: HASH,
      admittedAt: 1,
    },
    activation: {
      requestId: randomUUID(),
      requestDigest: HASH,
      jobId: "job",
      processingGenerationId: "generation",
      state: "ready",
      activatedAt: 1,
      reused: false,
    },
  });
  return [row(previous), row(current)];
}

test("an activated row from the previous parser is history, not a conflicting answer", async () => {
  const f = await reconcileFixture("revision", twoParserGenerations);
  try {
    await f.runner.driveReconcile();
    assert.equal(f.journal.pending, undefined);
    assert.deepEqual(
      f.parked,
      [],
      "an upgraded document must not park on a revision conflict",
    );
    assert.equal(f.journal.checkpoint.phase, "discovery_reserve");
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

test("a plan under a new parser fingerprint needs work while old rows are retained", async () => {
  const f = await reconcileFixture("revision", twoParserGenerations);
  try {
    // The upgrade itself: the same document, now planned under a parser
    // fingerprint neither stored row carries.
    const upgraded = { ...f.plan, parserFingerprint: "7".repeat(64) };
    assert.deepEqual(
      f.runner.matchingProcessingRows(upgraded),
      [],
      "no prior row answers for the new parser",
    );
    assert.equal(
      await f.runner.pdfNeedsArchivedWork({
        ...upgraded,
        discoveryState: "unchanged",
      }),
      true,
      "so the document is re-parsed rather than treated as published",
    );
    assert.equal(
      f.rows.length,
      2,
      "and the rows from the previous parser are still in the catalog",
    );
  } finally {
    await f.journal.close();
    await rm(f.setup.base, { recursive: true, force: true });
  }
});

// ADM-4a. Identity by the provider's stable file id.
//
// The pass is driven only as far as it needs to be: `startCycle` has already
// decided every identity question by the time `scan.begin` is answered, and
// the entries the server would see are built one step later. Stopping at the
// chosen step keeps each case about identity and nothing else, and the
// terminal checkpoint still records the bindings the next pass would read.

function identityTransport({
  failAt,
  entries,
  requests,
  itemCounts,
  enumeration,
}) {
  return {
    async call(request) {
      requests.push(request);
      // ADM-6a. `itemCounts: undefined` is a server that predates the
      // operation: it throws the way this stub throws for anything it does not
      // know, which is what the deployed worker sees against an old server.
      if (request.operation === "source.itemCounts") {
        if (itemCounts === undefined) {
          throw new Error(`unexpected operation ${request.operation}`);
        }
        if (itemCounts === "refused") {
          return { error: { code: "invalid_request" } };
        }
        return {
          operation: "source.itemCounts",
          sourceAccountId: "source",
          liveItems: itemCounts.roots.reduce(
            (total, root) => total + root.liveItems,
            0,
          ),
          truncated: itemCounts.truncated ?? false,
          roots: itemCounts.roots,
        };
      }
      // ADM-9. Every pass reports how it ended, including the ones that never
      // open a scan. `failAt: "passOutcome"` is the server that refuses it --
      // an old one answering an unknown operation -- as the safe error
      // envelope a real server sends, which the transport returns rather than
      // throws.
      if (request.operation === "diagnostics.passOutcome") {
        if (failAt === "passOutcome") {
          return { error: { code: "invalid_request" } };
        }
        return {
          operation: "diagnostics.passOutcome",
          sourceAccountId: "source",
          watcherId: request.watcherId,
          finishedAt: request.finishedAt,
          unhealthySince:
            request.state === "complete" ? null : request.finishedAt,
        };
      }
      if (request.operation === "source.status") {
        return {
          operation: "source.status",
          sourceAccountId: "source",
          inventoryEpoch: 1,
          completedInventoryEpoch: 1,
          manifestVersion: 1,
          enumeration: enumeration ?? {
            state: "complete",
            scanId: "old_scan",
            completedAt: 1,
          },
          processing: { state: "not_assessed" },
          recordCoverage: "not_established",
        };
      }
      if (request.operation === "scan.begin") {
        if (failAt === "begin")
          return { error: { code: "source_unavailable" } };
        return {
          operation: "scan.begin",
          scanId: "scan_identity",
          inventoryEpoch: 2,
          manifestVersion: 2,
          state: "open",
          reused: false,
        };
      }
      if (request.operation === "scan.appendPage") {
        entries.push(...request.entries);
        return { error: { code: "source_unavailable" } };
      }
      throw new Error(`unexpected operation ${request.operation}`);
    },
  };
}

function terminalCheckpoint(bindings) {
  return {
    version: 1,
    phase: "terminal",
    outcome: "complete",
    credentialSessionActive: false,
    bindings,
    scanned: bindings.length,
    published: bindings.length,
  };
}

/**
 * One pass over `setup`'s root with a stubbed provider. `ids` maps a relative
 * path to the id the provider answers with; `lookupFailure` makes the provider
 * unreachable instead. `asked` records exactly which paths were looked up, so
 * a test can assert that a steady pass asks nothing.
 */
async function identityPass({
  setup,
  bindings,
  ids = {},
  lookupFailure,
  failAt = "append",
  // ADM-4c: extra watched roots, and per-root provider stubs. `ids` and
  // `lookupFailure` stay the single-root spelling every existing case uses.
  roots = [],
  overrides = {},
  acceptRetirement,
  // ADM-6a. What the server says it holds, and how it says the source was
  // last enumerated. Both default to the pre-ADM-6a stub: a server that does
  // not know `source.itemCounts`, and a source enumerated once already.
  itemCounts,
  enumeration,
  checkpoint,
  providers = [
    { rootAlias: "fixture", ids, ...(lookupFailure ? { lookupFailure } : {}) },
  ],
}) {
  const entries = [];
  const requests = [];
  const asked = [];
  const askedByRoot = [];
  const journal = await openJournal(
    setup.journalDir,
    checkpoint ?? terminalCheckpoint(bindings),
  );
  try {
    const runner = new PipelineRunner(
      {
        ...setup.config,
        ...overrides,
        roots: [...setup.config.roots, ...roots],
      },
      journal,
      identityTransport({
        failAt,
        entries,
        requests,
        itemCounts,
        enumeration,
      }),
      undefined,
      acceptRetirement === undefined ? {} : { acceptRetirement },
      providers.map((provider) => ({
        rootAlias: provider.rootAlias,
        async lookup(relativePaths) {
          asked.push(...relativePaths);
          askedByRoot.push(
            ...relativePaths.map((path) => `${provider.rootAlias}/${path}`),
          );
          if (provider.lookupFailure) throw new Error(provider.lookupFailure);
          return new Map(
            relativePaths.flatMap((path) =>
              provider.ids?.[path] === undefined
                ? []
                : [[path, provider.ids[path]]],
            ),
          );
        },
      })),
    );
    // ADM-4c: the binary lane only runs behind a verified profile preparation.
    // A stub stands in for it so a discovery-classification case does not have
    // to launch a parser; nothing past discovery runs in these passes.
    if (overrides.pdfDocQa) {
      runner.preparePdfProfile = async () => {
        runner.preparedPdfProfile = {};
      };
    }
    const result = await runner.runSafely();
    const begin = requests.find((row) => row.operation === "scan.begin");
    return {
      result,
      mode: begin?.mode,
      entries,
      asked,
      askedByRoot,
      requests,
      bindings: journal.checkpoint.bindings ?? [],
    };
  } finally {
    await journal.close();
  }
}

function journalTerminal(bindings) {
  return { ...terminalCheckpoint(bindings), scanned: bindings.length };
}

/** The binding for one path, by path, for an assertion that names the path. */
function bindingAt(bindings, relativePath) {
  return bindings.find((row) => row.relativePath === relativePath);
}

test("a renamed file keeps its identity through the provider file id", async () => {
  const setup = await fixture(0);
  const externalId = randomUUID();
  await writeFile(join(setup.root, "renamed.txt"), "synthetic");
  try {
    const pass = await identityPass({
      setup,
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "original.txt",
          externalId,
          providerFileId: "id:file_a",
        },
      ],
      ids: { "renamed.txt": "id:file_a" },
    });
    assert.equal(pass.mode, "normal", "a rename is not an identity failure");
    assert.deepEqual(pass.asked, ["renamed.txt"], "only the unknown path");
    assert.equal(pass.entries.length, 1);
    assert.equal(pass.entries[0].externalId, externalId);
    assert.equal(pass.entries[0].uri, "fs://fixture/renamed.txt");
    assert.deepEqual(pass.bindings, [
      {
        rootAlias: "fixture",
        relativePath: "renamed.txt",
        externalId,
        providerFileId: "id:file_a",
      },
    ]);
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("renaming a parent folder moves every file under it without losing one", async () => {
  const setup = await fixture(0);
  const externalIds = [randomUUID(), randomUUID(), randomUUID()];
  await mkdir(join(setup.root, "statements 2026"), { mode: 0o700 });
  for (let index = 0; index < externalIds.length; index += 1) {
    await writeFile(
      join(setup.root, "statements 2026", `page-${index}.txt`),
      `synthetic-${index}`,
      { mode: 0o600 },
    );
  }
  try {
    const pass = await identityPass({
      setup,
      bindings: externalIds.map((externalId, index) => ({
        rootAlias: "fixture",
        relativePath: `statements/page-${index}.txt`,
        externalId,
        providerFileId: `id:file_${index}`,
      })),
      ids: Object.fromEntries(
        externalIds.map((_, index) => [
          `statements 2026/page-${index}.txt`,
          `id:file_${index}`,
        ]),
      ),
    });
    assert.equal(pass.mode, "normal");
    assert.deepEqual(
      pass.entries.map((entry) => entry.externalId),
      externalIds,
    );
    assert.deepEqual(
      pass.bindings.map((row) => row.relativePath),
      externalIds.map((_, index) => `statements 2026/page-${index}.txt`),
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a file moved between two subtrees of one root keeps its identity", async () => {
  const setup = await fixture(0);
  const moved = randomUUID();
  const stayed = randomUUID();
  await mkdir(join(setup.root, "inbox"), { mode: 0o700 });
  await mkdir(join(setup.root, "filed"), { mode: 0o700 });
  await writeFile(join(setup.root, "filed", "moved.txt"), "synthetic-moved");
  await writeFile(join(setup.root, "inbox", "stayed.txt"), "synthetic-stayed");
  try {
    const pass = await identityPass({
      setup,
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "inbox/moved.txt",
          externalId: moved,
          providerFileId: "id:moved",
        },
        {
          rootAlias: "fixture",
          relativePath: "inbox/stayed.txt",
          externalId: stayed,
          providerFileId: "id:stayed",
        },
      ],
      ids: { "filed/moved.txt": "id:moved" },
    });
    assert.equal(pass.mode, "normal");
    assert.deepEqual(
      pass.asked,
      ["filed/moved.txt"],
      "the file that did not move is not looked up again",
    );
    assert.equal(bindingAt(pass.bindings, "filed/moved.txt").externalId, moved);
    assert.equal(
      bindingAt(pass.bindings, "inbox/stayed.txt").externalId,
      stayed,
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a copy is a second item: same bytes, a different provider file id", async () => {
  const setup = await fixture(0);
  const externalId = randomUUID();
  await writeFile(join(setup.root, "original.txt"), "synthetic");
  await writeFile(join(setup.root, "copy.txt"), "synthetic");
  try {
    const pass = await identityPass({
      setup,
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "original.txt",
          externalId,
          providerFileId: "id:file_a",
        },
      ],
      ids: { "copy.txt": "id:file_b" },
    });
    assert.equal(pass.mode, "normal", "nothing went missing, so no recovery");
    assert.equal(pass.entries.length, 2);
    const [copy, original] = pass.entries;
    assert.equal(original.uri, "fs://fixture/original.txt");
    assert.equal(original.externalId, externalId);
    assert.equal(copy.uri, "fs://fixture/copy.txt");
    assert.notEqual(copy.externalId, externalId);
    assert.equal(
      copy.content.sha256,
      original.content.sha256,
      "the duplicate is a duplicate; joining the two is the UI's job",
    );
    assert.equal(pass.bindings.length, 2);
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("an unreachable provider falls back to path identity without failing the pass", async () => {
  const setup = await fixture(0);
  const externalId = randomUUID();
  await writeFile(join(setup.root, "renamed.txt"), "synthetic");
  try {
    const pass = await identityPass({
      setup,
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "original.txt",
          externalId,
          providerFileId: "id:file_a",
        },
      ],
      lookupFailure: "provider unreachable",
      failAt: "begin",
    });
    assert.equal(
      pass.mode,
      "identity_recovery",
      "with no id to go on, a rename is exactly what it was before",
    );
    assert.equal(pass.result.state, "failed");
    assert.equal(
      bindingAt(pass.bindings, "original.txt").externalId,
      externalId,
      "and nothing guessed a new identity for the remembered file",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a journal written before provider ids is upgraded in place, then survives a rename", async () => {
  const setup = await fixture(0);
  const externalId = randomUUID();
  await writeFile(join(setup.root, "original.txt"), "synthetic");
  try {
    const upgrade = await identityPass({
      setup,
      // The old shape: a path and an external id, and nothing else.
      bindings: [
        { rootAlias: "fixture", relativePath: "original.txt", externalId },
      ],
      ids: { "original.txt": "id:file_a" },
    });
    assert.equal(upgrade.mode, "normal", "an upgrade is not a re-ingest");
    assert.equal(upgrade.entries.length, 1);
    assert.equal(
      upgrade.entries[0].externalId,
      externalId,
      "the file keeps the identity it already had",
    );
    assert.deepEqual(upgrade.bindings, [
      {
        rootAlias: "fixture",
        relativePath: "original.txt",
        externalId,
        providerFileId: "id:file_a",
      },
    ]);

    // Nothing changed: the upgraded journal asks the provider nothing.
    const steady = await identityPass({
      setup,
      bindings: upgrade.bindings,
      ids: { "original.txt": "id:file_a" },
    });
    assert.deepEqual(steady.asked, []);

    // And now the rename the upgrade bought.
    await rename(
      join(setup.root, "original.txt"),
      join(setup.root, "renamed.txt"),
    );
    const renamed = await identityPass({
      setup,
      bindings: steady.bindings,
      ids: { "renamed.txt": "id:file_a" },
    });
    assert.equal(renamed.mode, "normal");
    assert.equal(renamed.entries[0].externalId, externalId);
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a file that took a renamed file's place does not inherit its identity", async () => {
  const setup = await fixture(0);
  const externalId = randomUUID();
  await writeFile(join(setup.root, "renamed.txt"), "synthetic");
  await writeFile(join(setup.root, "original.txt"), "a different document");
  try {
    const pass = await identityPass({
      setup,
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "original.txt",
          externalId,
          providerFileId: "id:file_a",
        },
      ],
      ids: { "renamed.txt": "id:file_a" },
    });
    assert.equal(
      bindingAt(pass.bindings, "renamed.txt").externalId,
      externalId,
      "the moved file is still itself",
    );
    const replacement = bindingAt(pass.bindings, "original.txt");
    assert.notEqual(replacement.externalId, externalId);
    assert.equal(
      replacement.providerFileId,
      undefined,
      "and the id the old path remembered went with the file, not the path",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("two watched paths that resolve to one provider file both keep path identity", async () => {
  const setup = await fixture(0);
  // A provider that normalizes or folds case answers for two watched paths
  // with one file id: the same name in NFC and NFD, or a case-only twin. This
  // filesystem collapses both of those into one file, so the collision is
  // staged with two plainly distinct paths instead. What is under test is the
  // runner's response to one id arriving on two plans, not how it arose.
  await mkdir(join(setup.root, "a"), { mode: 0o700 });
  await mkdir(join(setup.root, "b"), { mode: 0o700 });
  await writeFile(join(setup.root, "a", "statement.txt"), "synthetic-a");
  await writeFile(join(setup.root, "b", "statement.txt"), "synthetic-b");
  try {
    const pass = await identityPass({
      setup,
      bindings: [],
      ids: {
        "a/statement.txt": "id:one_file",
        "b/statement.txt": "id:one_file",
      },
    });
    assert.equal(
      pass.entries.length,
      2,
      "both files are still their own entry",
    );
    assert.notEqual(
      pass.entries[0].externalId,
      pass.entries[1].externalId,
      "and each one has its own identity",
    );
    for (const binding of pass.bindings) {
      assert.equal(
        binding.providerFileId,
        undefined,
        "an id neither path solely owns is kept by neither",
      );
    }
    // The journal has to accept what the pass wrote.
    assert.equal(
      parseRunnerCheckpoint(journalTerminal(pass.bindings)).bindings.length,
      2,
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a journal naming one provider file twice loads without its ids rather than refusing", async () => {
  const left = randomUUID();
  const right = randomUUID();
  const checkpoint = parseRunnerCheckpoint({
    version: 1,
    phase: "terminal",
    outcome: "complete",
    credentialSessionActive: false,
    scanned: 2,
    published: 2,
    bindings: [
      {
        rootAlias: "fixture",
        relativePath: "one.txt",
        externalId: left,
        providerFileId: "id:same",
      },
      {
        rootAlias: "fixture",
        relativePath: "two.txt",
        externalId: right,
        providerFileId: "id:same",
      },
    ],
  });
  assert.deepEqual(checkpoint.bindings, [
    { rootAlias: "fixture", relativePath: "one.txt", externalId: left },
    { rootAlias: "fixture", relativePath: "two.txt", externalId: right },
  ]);
  // The identity itself still fails closed.
  assert.throws(() =>
    parseRunnerCheckpoint({
      version: 1,
      phase: "terminal",
      outcome: "complete",
      credentialSessionActive: false,
      scanned: 2,
      published: 2,
      bindings: [
        { rootAlias: "fixture", relativePath: "one.txt", externalId: left },
        { rootAlias: "fixture", relativePath: "one.txt", externalId: right },
      ],
    }),
  );
});

test("a different file at a vacated path inherits it, exactly as path identity does", async () => {
  const setup = await fixture(0);
  const externalId = randomUUID();
  // The remembered file has moved out of every watched root, or has not synced
  // yet, so no lookup can see it. Something else now sits at its path.
  await writeFile(join(setup.root, "statement.txt"), "a different document");
  try {
    const pass = await identityPass({
      setup,
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "statement.txt",
          externalId,
          providerFileId: "id:moved_away",
        },
      ],
      // Even if the provider would answer for this path, it is not asked: the
      // path is remembered and already carries an id.
      ids: { "statement.txt": "id:the_newcomer" },
    });
    assert.deepEqual(pass.asked, []);
    assert.equal(pass.mode, "normal");
    assert.equal(
      pass.entries[0].externalId,
      externalId,
      // This is the documented limit of the fallback and it is unchanged from
      // path identity: the new bytes become a new revision of the same item
      // rather than a new item. Provider ids narrow this rather than widen it
      // -- see the test above, where the moved file is still inside the root
      // and the newcomer is therefore refused the identity.
      "the newcomer inherits the path's identity, as it does on the old build",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a folder rename larger than any batch resolves in one pass, upgrades last", async () => {
  const setup = await fixture(0);
  const count = 70;
  const moved = [];
  const settled = [];
  await mkdir(join(setup.root, "moved"), { mode: 0o700 });
  for (let index = 0; index < count; index += 1) {
    moved.push(randomUUID());
    await writeFile(
      join(setup.root, "moved", `page-${index}.txt`),
      `synthetic-${index}`,
      { mode: 0o600 },
    );
  }
  // Two files that did not move and have no id yet: the lazy upgrade, which
  // any later pass can finish and which must not be asked about first.
  for (let index = 0; index < 2; index += 1) {
    settled.push(randomUUID());
    await writeFile(join(setup.root, `settled-${index}.txt`), "synthetic", {
      mode: 0o600,
    });
  }
  try {
    const pass = await identityPass({
      setup,
      bindings: [
        ...moved.map((externalId, index) => ({
          rootAlias: "fixture",
          relativePath: `page-${index}.txt`,
          externalId,
          providerFileId: `id:file_${index}`,
        })),
        ...settled.map((externalId, index) => ({
          rootAlias: "fixture",
          relativePath: `settled-${index}.txt`,
          externalId,
        })),
      ],
      ids: {
        ...Object.fromEntries(
          moved.map((_, index) => [
            `moved/page-${index}.txt`,
            `id:file_${index}`,
          ]),
        ),
        ...Object.fromEntries(
          settled.map((_, index) => [
            `settled-${index}.txt`,
            `id:settled_${index}`,
          ]),
        ),
      },
    });
    assert.equal(
      pass.mode,
      "normal",
      "a rename bigger than one batch must not fall into identity recovery",
    );
    assert.deepEqual(
      pass.asked.slice(0, count).sort(),
      moved.map((_, index) => `moved/page-${index}.txt`).sort(),
      "every rename candidate is asked about before any lazy upgrade",
    );
    const after = pass.bindings.filter((row) =>
      row.relativePath.startsWith("moved/"),
    );
    assert.equal(after.length, count);
    assert.deepEqual(
      after.map((row) => row.externalId).sort(),
      [...moved].sort(),
      "and every one of them followed its identity in this one pass",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// ADM-4c. More than one watched root.

/** A second root beside `setup.root`, with `files` written into it. */
async function secondRoot(setup, alias, files) {
  const path = join(setup.base, alias);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(path, name), contents, { mode: 0o600 });
  }
  return { alias, path };
}

test("a root added mid life leaves the first root's items exactly where they were", async () => {
  const setup = await fixture(0);
  const kept = randomUUID();
  await writeFile(join(setup.root, "statement.txt"), "synthetic-first");
  const added = await secondRoot(setup, "investing", {
    "term-sheet.txt": "synthetic-second",
  });
  try {
    const pass = await identityPass({
      setup,
      roots: [added],
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "statement.txt",
          externalId: kept,
          providerFileId: "id:file_a",
        },
      ],
      providers: [
        { rootAlias: "fixture", ids: { "statement.txt": "id:file_a" } },
        { rootAlias: "investing", ids: { "term-sheet.txt": "id:file_b" } },
      ],
    });
    assert.equal(
      pass.mode,
      "normal",
      "a new root is new items, never an identity failure for the old ones",
    );
    assert.deepEqual(
      pass.askedByRoot,
      ["investing/term-sheet.txt"],
      "the first root is steady, so its provider is not asked anything",
    );
    assert.equal(
      bindingAt(pass.bindings, "statement.txt").externalId,
      kept,
      "the first root's document keeps the identity it published under",
    );
    const fresh = bindingAt(pass.bindings, "term-sheet.txt");
    assert.equal(fresh.rootAlias, "investing");
    assert.notEqual(fresh.externalId, kept);
    assert.equal(fresh.providerFileId, "id:file_b");
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("removing a root turns its items into ordinary gaps, not a failed pass", async () => {
  const setup = await fixture(0);
  const kept = randomUUID();
  const dropped = [randomUUID(), randomUUID()];
  await writeFile(join(setup.root, "statement.txt"), "synthetic-first");
  try {
    // The journal remembers a root the configuration no longer lists.
    const pass = await identityPass({
      setup,
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "statement.txt",
          externalId: kept,
          providerFileId: "id:file_a",
        },
        ...dropped.map((externalId, index) => ({
          rootAlias: "investing",
          relativePath: `gone-${index}.txt`,
          externalId,
          providerFileId: `id:gone_${index}`,
        })),
      ],
      providers: [
        { rootAlias: "fixture", ids: { "statement.txt": "id:file_a" } },
      ],
    });
    // Removing a root is a removal the owner has to mean: the breaker holds
    // the pass until they say so. See the escape-hatch cases below.
    assert.equal(pass.result.code, "root_selection_would_retire_items");
    assert.deepEqual(
      pass.bindings.map((row) => row.relativePath).sort(),
      ["gone-0.txt", "gone-1.txt", "statement.txt"],
      "and nothing was forgotten in the meantime",
    );

    const confirmed = await identityPass({
      setup,
      acceptRetirement: "root_selection_would_retire_items",
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "statement.txt",
          externalId: kept,
          providerFileId: "id:file_a",
        },
        ...dropped.map((externalId, index) => ({
          rootAlias: "investing",
          relativePath: `gone-${index}.txt`,
          externalId,
          providerFileId: `id:gone_${index}`,
        })),
      ],
      providers: [
        { rootAlias: "fixture", ids: { "statement.txt": "id:file_a" } },
      ],
    });
    assert.equal(
      confirmed.mode,
      "normal",
      "items that went away with their root are removals, not lost identities",
    );
    assert.equal(
      confirmed.entries.length,
      1,
      "the removed root contributes nothing to the scan",
    );
    assert.equal(confirmed.entries[0].uri, "fs://fixture/statement.txt");
    assert.equal(
      confirmed.result.code,
      "source_unavailable",
      "the only failure left is the one this transport injects at append",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a whole root's worth of vanished items does not exhaust binding capacity", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic-first");
  try {
    const pass = await identityPass({
      setup,
      // 600 files deleted from a root this pass still reads. Summed with the
      // surviving plan, that used to refuse the pass outright on capacity.
      // The collapse breaker would hold it too, so the operator confirms the
      // deletion; capacity is what is being measured here.
      acceptRetirement: "root_contents_collapsed",
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "statement.txt",
          externalId: randomUUID(),
        },
        ...Array.from({ length: 600 }, (_, index) => ({
          rootAlias: "fixture",
          relativePath: `gone-${index}.txt`,
          externalId: randomUUID(),
        })),
      ],
      providers: [],
    });
    assert.equal(pass.result.code, "source_unavailable");
    assert.notEqual(
      pass.mode,
      undefined,
      "the scan opened rather than failing",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("one root's provider being unreachable leaves the other root's ids intact", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic-first");
  const added = await secondRoot(setup, "investing", {
    "term-sheet.txt": "synthetic-second",
  });
  try {
    const pass = await identityPass({
      setup,
      roots: [added],
      bindings: [],
      providers: [
        { rootAlias: "fixture", lookupFailure: "provider unreachable" },
        { rootAlias: "investing", ids: { "term-sheet.txt": "id:file_b" } },
      ],
    });
    assert.equal(pass.mode, "normal");
    assert.equal(
      bindingAt(pass.bindings, "statement.txt").providerFileId,
      undefined,
      "the unreachable root falls back to path identity for this pass",
    );
    assert.equal(
      bindingAt(pass.bindings, "term-sheet.txt").providerFileId,
      "id:file_b",
      "and the reachable root still resolves its own ids",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("the provider lookup budget is the pass's, not each root's", async () => {
  const setup = await fixture(0);
  const perRoot = 200;
  for (let index = 0; index < perRoot; index += 1) {
    await writeFile(join(setup.root, `a-${index}.txt`), `synthetic-${index}`, {
      mode: 0o600,
    });
  }
  const files = {};
  for (let index = 0; index < perRoot; index += 1) {
    files[`b-${index}.txt`] = `synthetic-${index}`;
  }
  const added = await secondRoot(setup, "investing", files);
  try {
    const pass = await identityPass({
      setup,
      roots: [added],
      overrides: { maxFiles: 1024 },
      bindings: [],
      providers: [
        { rootAlias: "fixture", ids: {} },
        { rootAlias: "investing", ids: {} },
      ],
    });
    assert.equal(pass.mode, "normal");
    assert.equal(
      pass.askedByRoot.length,
      256,
      "two roots of 200 files ask 256 questions in one pass, not 400",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a 1024-file checkpoint with a full binding list round-trips through the journal", async () => {
  const setup = await fixture(0);
  const files = Array.from({ length: 1024 }, (_, index) =>
    pdfPlan({
      relativePath: `folder-${index % 20}/a reasonably long document name ${index}.pdf`,
      externalId: randomUUID(),
      sourceItemId: `source-item-${index}`,
      providerFileId: `id:AbCdEfGhIjKlMnOpQrStU${index}`,
    }),
  );
  const missingBindings = Array.from({ length: 4096 }, (_, index) => ({
    rootAlias: "fixture",
    relativePath: `retired/folder-${index % 20}/gone-${index}.pdf`,
    externalId: randomUUID(),
    providerFileId: `id:ZyXwVuTsRqPoNmLkJiHg${index}`,
  }));
  const checkpoint = archivedCheckpoint(files[0], { files, missingBindings });
  const checkpointBytes = Buffer.byteLength(JSON.stringify(checkpoint), "utf8");
  const journal = await openJournal(setup.journalDir, checkpoint);
  try {
    // The measurement this slice's ceiling rests on. It is asserted, not
    // printed, so a plan field added later fails here rather than in the field.
    assert.ok(
      checkpointBytes > 1_500_000 && checkpointBytes < 3 * 1024 * 1024,
      `checkpoint is ${checkpointBytes} bytes, outside the journal's bound`,
    );
    const stateBytes = (await lstat(join(setup.journalDir, "state.json"))).size;
    assert.ok(
      stateBytes < 6 * 1024 * 1024,
      `state file is ${stateBytes} bytes, outside the journal's bound`,
    );
    assert.equal(journal.checkpoint.files.length, 1024);
    assert.equal(journal.checkpoint.missingBindings.length, 4096);
    assert.deepEqual(parseRunnerCheckpoint(checkpoint), checkpoint);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a second root of files the PDF lane cannot read is skipped, never failed", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic-first");
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(2_048, 7),
  ]);
  const added = await secondRoot(setup, "investing", {
    "photo.jpg": jpeg,
    "large-photo.jpg": Buffer.concat([jpeg, Buffer.alloc(100_000, 7)]),
    "blank.pdf": Buffer.alloc(0),
  });
  try {
    const pass = await identityPass({
      setup,
      roots: [added],
      bindings: [],
      providers: [],
      overrides: {
        pdfDocQa: {
          profile: {
            parserProfileId: "pdf_docqa_v1",
            parserFingerprint: HASH,
            extractionConfigurationFingerprint: HASH,
            extractorFingerprint: "extractor-v1",
            recordSchemaFingerprint: "records-disabled-v1",
            normalizationFingerprint: "normalization-v1",
            chunkerFingerprint: HASH,
            correctionRevision: "correction-v1",
          },
        },
      },
    });
    assert.equal(pass.mode, "normal");
    const gaps = Object.fromEntries(
      pass.entries
        .filter((entry) => entry.content.status === "gap")
        .map((entry) => [entry.uri, entry.content.code]),
    );
    assert.deepEqual(gaps, {
      "fs://investing/blank.pdf": "empty",
      "fs://investing/large-photo.jpg": "oversized",
      "fs://investing/photo.jpg": "unsupported",
    });
    assert.equal(
      pass.result.code,
      "source_unavailable",
      "the only failure is the one this transport injects at append",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// ADM-4c. The server's watched-folder list, resolved on the host.
//
// The host's JSON config is the allow-list; a row selects a subtree inside it.
// These cases are the three steps the protocol contract requires of a client,
// run against a real directory rather than a mock filesystem, because the one
// they exist for -- a symbolic link inside an allowed root -- is invisible to
// anything that does not resolve paths.

async function resolvePass(setup, rows, extraRoots = []) {
  const journal = await openJournal(setup.journalDir, terminalCheckpoint([]));
  try {
    const runner = new PipelineRunner(
      { ...setup.config, roots: [...setup.config.roots, ...extraRoots] },
      journal,
      {
        async call() {
          throw new Error("no transport in this case");
        },
      },
    );
    const allowed = await canonicalRoots(runner.config);
    return await runner.resolveServerRoots(allowed, rows);
  } finally {
    await journal.close();
  }
}

function folderRow(overrides) {
  return {
    sourceRootId: randomUUID().replaceAll("-", ""),
    kind: "folder",
    state: "active",
    expectedTypes: [],
    ...overrides,
  };
}

test("a server row narrows an allow-listed root to a subtree, keeping its alias", async () => {
  const setup = await fixture(0);
  await mkdir(join(setup.root, "investing"), { mode: 0o700 });
  await mkdir(join(setup.root, "elsewhere"), { mode: 0o700 });
  await writeFile(join(setup.root, "investing", "term-sheet.txt"), "synthetic");
  await writeFile(join(setup.root, "elsewhere", "other.txt"), "synthetic");
  try {
    const row = folderRow({ rootAlias: "fixture", relativePath: "investing" });
    const plan = await resolvePass(setup, [row]);
    assert.deepEqual(plan.reports, [
      {
        sourceRootId: row.sourceRootId,
        state: "ok",
        rootAlias: "fixture",
        relativePath: "investing",
      },
    ]);
    assert.equal(plan.roots.length, 1);
    assert.deepEqual(plan.roots[0].includePrefixes, ["investing"]);
    assert.equal(
      plan.roots[0].alias,
      "fixture",
      "the alias stays the host's, so item URIs keep joining",
    );
    // And the narrowing is real: only the chosen subtree is read.
    const observed = await discoverFiles(setup.config, plan.roots);
    assert.deepEqual(
      observed.map((file) => file.uri),
      ["fs://fixture/investing/term-sheet.txt"],
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("an alias the host does not allow-list is skipped and reported missing", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  try {
    const row = folderRow({ rootAlias: "not-a-host-root" });
    const plan = await resolvePass(setup, [row]);
    assert.deepEqual(plan.reports, [
      { sourceRootId: row.sourceRootId, state: "missing" },
    ]);
    assert.deepEqual(
      plan.roots.map((root) => root.alias),
      ["fixture"],
      "reading nothing would retire the source, so the allow-list stands",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a stored relative path is re-checked as text, decoding nothing", async () => {
  const setup = await fixture(0);
  await mkdir(join(setup.root, "investing"), { mode: 0o700 });
  try {
    for (const relativePath of [
      "/etc",
      "..",
      "investing/../../etc",
      "investing/./notes",
      "investing//notes",
      "investing\\notes",
      `investing/notes${String.fromCharCode(0)}`,
      " investing",
      "investing ",
      // Not decoded before the check: an encoded traversal stays text and
      // simply names a directory that is not there.
      "%2e%2e/%2e%2e/etc",
    ]) {
      const row = folderRow({ rootAlias: "fixture", relativePath });
      const plan = await resolvePass(setup, [row]);
      assert.equal(
        plan.reports[0].state,
        "missing",
        `${JSON.stringify(relativePath)} must not resolve to a watched root`,
      );
      assert.deepEqual(
        plan.roots.map((root) => root.includePrefixes),
        [undefined],
      );
    }
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a symlink inside an allowed root cannot point the watcher out of it", async () => {
  const setup = await fixture(0);
  const outside = join(setup.base, "outside");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, "secret.txt"), "synthetic");
  await symlink(outside, join(setup.root, "escape"));
  // The sibling a prefix comparison alone would let through.
  await mkdir(`${setup.root}-evil`, { mode: 0o700 });
  await symlink(`${setup.root}-evil`, join(setup.root, "sibling"));
  try {
    for (const relativePath of ["escape", "sibling"]) {
      const row = folderRow({ rootAlias: "fixture", relativePath });
      const plan = await resolvePass(setup, [row]);
      assert.deepEqual(plan.reports, [
        { sourceRootId: row.sourceRootId, state: "unreadable" },
      ]);
      assert.deepEqual(
        plan.roots.map((root) => root.includePrefixes),
        [undefined],
        "and the pass falls back to the whole allow-listed root",
      );
    }
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a subtree that is gone or is not a directory is reported, not failed", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  try {
    const gone = folderRow({ rootAlias: "fixture", relativePath: "gone" });
    assert.equal(
      (await resolvePass(setup, [gone])).reports[0].state,
      "missing",
    );
    const file = folderRow({
      rootAlias: "fixture",
      relativePath: "statement.txt",
    });
    assert.equal(
      (await resolvePass(setup, [file])).reports[0].state,
      "unreadable",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a paused root keeps its subtree selected; only its state is reported", async () => {
  const setup = await fixture(0);
  await mkdir(join(setup.root, "investing"), { mode: 0o700 });
  await mkdir(join(setup.root, "medical"), { mode: 0o700 });
  try {
    const active = folderRow({
      rootAlias: "fixture",
      relativePath: "investing",
    });
    const paused = folderRow({
      rootAlias: "fixture",
      relativePath: "medical",
      state: "paused",
    });
    const plan = await resolvePass(setup, [active, paused]);
    assert.deepEqual(
      plan.reports.map((report) => report.state),
      ["ok", "ok"],
      "a paused root is reported on, not hidden",
    );
    // The review's finding 2: leaving the paused subtree out of the selection
    // takes its items out of the scan, and the server's reconcile marks
    // anything not in the scan unavailable. Pausing must not read as deleting.
    assert.deepEqual(plan.roots[0].includePrefixes, ["investing", "medical"]);
    const onlyPaused = await resolvePass(setup, [paused]);
    assert.equal(onlyPaused.reports[0].state, "ok");
    assert.deepEqual(onlyPaused.roots[0].includePrefixes, ["medical"]);
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// Review finding 1. The admin API cannot create a whole-root row at all
// (`assertSourceRootLocation` refuses an empty path, and migration 028's CHECK
// requires length >= 1), so the owner's existing root can never be named by a
// row. Dropping unnamed roots therefore meant the first pass after adding one
// folder in the UI would take every existing document out of the scan, and
// `reconcileWorkerScan` is account-wide.
test("a root no server row names is watched whole, not dropped", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  const added = await secondRoot(setup, "investing", {
    "term-sheet.txt": "synthetic",
  });
  await mkdir(join(added.path, "2026"), { mode: 0o700 });
  await writeFile(join(added.path, "2026", "call.txt"), "synthetic");
  try {
    // The only row the UI can write: a subtree of the new root.
    const row = folderRow({ rootAlias: "investing", relativePath: "2026" });
    const plan = await resolvePass(setup, [row], [added]);
    assert.deepEqual(
      plan.roots.map((root) => [root.alias, root.includePrefixes]),
      [
        ["fixture", undefined],
        ["investing", ["2026"]],
      ],
      "the named root narrows; the unnamed one is read exactly as before",
    );
    const observed = await discoverFiles(
      { ...setup.config, roots: [] },
      plan.roots,
    );
    assert.deepEqual(
      observed.map((file) => file.uri).sort(),
      ["fs://fixture/statement.txt", "fs://investing/2026/call.txt"],
      "so the first root's items are still in the scan",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("the prefix is the path the host has, not the row's spelling of it", async () => {
  const setup = await fixture(0);
  await mkdir(join(setup.root, "Investing"), { mode: 0o700 });
  await writeFile(join(setup.root, "Investing", "note.txt"), "synthetic");
  try {
    // On a case-insensitive filesystem `realpath` resolves "investing" to the
    // directory spelled "Investing", and discovery only ever produces the
    // on-disk spelling. A raw-text prefix would match no file at all, which
    // reads as every document under the root vanishing at once.
    const row = folderRow({ rootAlias: "fixture", relativePath: "investing" });
    const plan = await resolvePass(setup, [row]);
    if (plan.reports[0].state !== "ok") {
      // A case-sensitive filesystem: the row names nothing, which is the other
      // correct answer, and the root is still watched whole.
      assert.equal(plan.reports[0].state, "missing");
      assert.deepEqual(plan.roots[0].includePrefixes, undefined);
      return;
    }
    assert.deepEqual(plan.roots[0].includePrefixes, ["Investing"]);
    assert.equal(plan.reports[0].relativePath, "Investing");
    const observed = await discoverFiles(
      { ...setup.config, roots: [] },
      plan.roots,
    );
    assert.deepEqual(
      observed.map((file) => file.uri),
      ["fs://fixture/Investing/note.txt"],
      "and the subtree is actually read",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("no server rows means the host's allow-listed roots, exactly as before", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  try {
    const plan = await resolvePass(setup, []);
    assert.deepEqual(plan.reports, []);
    assert.deepEqual(
      plan.roots.map((root) => [root.alias, root.includePrefixes]),
      [["fixture", undefined]],
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// Review finding 1, second half. Whatever the root-selection logic does, a
// pass that would take a large share of the account out of the scan refuses
// instead. `reconcileWorkerScan` marks everything not in the scan unavailable,
// so a config or server mistake would otherwise look exactly like the owner's
// documents being deleted.
test("a pass that would retire most of the account refuses to scan", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  try {
    const remembered = [
      {
        rootAlias: "fixture",
        relativePath: "statement.txt",
        externalId: randomUUID(),
      },
      // Forty items under a root this config no longer lists.
      ...Array.from({ length: 40 }, (_, index) => ({
        rootAlias: "investing",
        relativePath: `gone-${index}.txt`,
        externalId: randomUUID(),
      })),
    ];
    const pass = await identityPass({
      setup,
      bindings: remembered,
      providers: [],
    });
    assert.equal(pass.result.state, "incomplete");
    assert.equal(pass.result.code, "root_selection_would_retire_items");
    assert.equal(pass.mode, undefined, "the scan never opened");
    assert.deepEqual(
      pass.bindings.map((row) => row.externalId).sort(),
      remembered.map((row) => row.externalId).sort(),
      "and nothing was forgotten: the next pass sees the same journal",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// Second review, blocker 1. `watchedLocation` only catches a root leaving the
// list. A root that is still listed, still resolves and is simply empty --
// a disk that did not mount, a Dropbox folder mid-sync on a host the watcher
// has just moved to -- gives `retiring = 0`, and every document under it is
// retired by an account-wide reconcile. That is the scenario this project is
// about to run into, so it gets its own refusal.
test("a root that is still watched but has lost its contents refuses", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  try {
    const pass = await identityPass({
      setup,
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "statement.txt",
          externalId: randomUUID(),
        },
        ...Array.from({ length: 40 }, (_, index) => ({
          rootAlias: "fixture",
          relativePath: `gone-${index}.txt`,
          externalId: randomUUID(),
        })),
      ],
      providers: [],
    });
    assert.equal(pass.result.state, "incomplete");
    assert.equal(pass.result.code, "root_contents_collapsed");
    assert.equal(pass.mode, undefined, "the scan never opened");
    assert.equal(pass.bindings.length, 41, "and nothing was forgotten");
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// ADM-9. A refused pass writes no scan and so no processing assessment, and
// those are the only two things the health screen reads about a watcher
// besides the heartbeat. So the refusal has to travel on its own, or a watcher
// that refuses every pass keeps heartbeating and reads as healthy.
test("a refused pass tells the server how it ended", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  const remembered = [
    {
      rootAlias: "fixture",
      relativePath: "statement.txt",
      externalId: randomUUID(),
    },
    ...Array.from({ length: 40 }, (_, index) => ({
      rootAlias: "fixture",
      relativePath: `gone-${index}.txt`,
      externalId: randomUUID(),
    })),
  ];
  try {
    const pass = await identityPass({
      setup,
      bindings: remembered,
      providers: [],
    });
    assert.equal(pass.result.code, "root_contents_collapsed");
    assert.equal(pass.mode, undefined, "the scan never opened");
    const reported = pass.requests.filter(
      (row) => row.operation === "diagnostics.passOutcome",
    );
    assert.equal(reported.length, 1);
    assert.equal(reported[0].state, "incomplete");
    assert.equal(reported[0].code, "root_contents_collapsed");
    assert.equal(reported[0].scanned, 0);
    assert.equal(reported[0].published, 0);
    assert.equal(typeof reported[0].finishedAt, "number");
    assert.equal(reported[0].spaceId, setup.config.spaceId);
    assert.equal(reported[0].sourceAccountId, setup.config.sourceAccountId);

    // And a server that refuses the report -- an old one that has never heard
    // of the operation, or one that is simply unreachable -- leaves the pass
    // exactly as it was. The owner's watcher runs behind on purpose, so this
    // is the ordinary case and not an error.
    //
    // It is also said once per process and not once per pass (first review,
    // finding 4): a server that will never accept the operation refuses every
    // report there will ever be, and a five-minute watch loop would write the
    // same line forever. The assertion is about the *second* refusal rather
    // than a count from zero, because any earlier test in this file may
    // already have latched the warning.
    // Only this warning: a refused pass writes two of its own, about the
    // folder list and about the refusal itself, and both are meant to repeat.
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      const line = args.join(" ");
      if (line.includes("pass outcome could not be reported"))
        warnings.push(line);
    };
    let refusedReport;
    let repeated;
    try {
      refusedReport = await identityPass({
        setup,
        bindings: remembered,
        providers: [],
        failAt: "passOutcome",
      });
      const afterFirst = warnings.length;
      assert.ok(
        afterFirst <= 1,
        "a refused report says so at most once per process",
      );
      repeated = await identityPass({
        setup,
        bindings: remembered,
        providers: [],
        failAt: "passOutcome",
      });
      assert.equal(
        warnings.length,
        afterFirst,
        "and says nothing at all on the refusals after it",
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(refusedReport.result, pass.result);
    assert.deepEqual(repeated.result, pass.result);
    assert.deepEqual(
      refusedReport.bindings.map((row) => row.externalId).sort(),
      remembered.map((row) => row.externalId).sort(),
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a watched root that has gone completely empty refuses", async () => {
  const setup = await fixture(0);
  try {
    // Four remembered items, nothing on disk. This is the half-synced host.
    const pass = await identityPass({
      setup,
      bindings: Array.from({ length: 4 }, (_, index) => ({
        rootAlias: "fixture",
        relativePath: `document-${index}.pdf`,
        externalId: randomUUID(),
      })),
      providers: [],
    });
    assert.equal(pass.result.code, "root_contents_collapsed");
    assert.equal(pass.bindings.length, 4);
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a root that loses two of ten proceeds: that is an ordinary edit", async () => {
  const setup = await fixture(0);
  for (let index = 0; index < 8; index += 1) {
    await writeFile(join(setup.root, `kept-${index}.txt`), "synthetic");
  }
  try {
    const pass = await identityPass({
      setup,
      bindings: [
        ...Array.from({ length: 8 }, (_, index) => ({
          rootAlias: "fixture",
          relativePath: `kept-${index}.txt`,
          externalId: randomUUID(),
        })),
        ...Array.from({ length: 2 }, (_, index) => ({
          rootAlias: "fixture",
          relativePath: `gone-${index}.txt`,
          externalId: randomUUID(),
        })),
      ],
      providers: [],
    });
    assert.equal(
      pass.result.code,
      "source_unavailable",
      "the only failure is the one this transport injects at append",
    );
    assert.equal(pass.mode, "normal");
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a brand-new empty root is a folder with nothing in it yet, not a collapse", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  const added = await secondRoot(setup, "investing", {});
  try {
    const pass = await identityPass({
      setup,
      roots: [added],
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "statement.txt",
          externalId: randomUUID(),
        },
      ],
      providers: [],
    });
    assert.equal(pass.result.code, "source_unavailable");
    assert.equal(pass.mode, "normal", "there was nothing there to lose");
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// Second review, blocker 2. The floor of ten could never trip for an account
// of ten items or fewer, which is the owner's account today and exactly when
// a mistake is least recoverable.
test("a small source is not exempt: one item of four leaving refuses", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  try {
    const bindings = [
      {
        rootAlias: "fixture",
        relativePath: "statement.txt",
        externalId: randomUUID(),
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        rootAlias: "investing",
        relativePath: `gone-${index}.txt`,
        externalId: randomUUID(),
      })),
    ];
    const pass = await identityPass({ setup, bindings, providers: [] });
    assert.equal(pass.result.code, "root_selection_would_retire_items");

    // And the way through, which must name the exact code it is accepting.
    const wrongCode = await identityPass({
      setup,
      bindings,
      providers: [],
      acceptRetirement: "root_contents_collapsed",
    });
    assert.equal(
      wrongCode.result.code,
      "root_selection_would_retire_items",
      "confirming one kind of removal never confirms the other",
    );
    const confirmed = await identityPass({
      setup,
      bindings,
      providers: [],
      acceptRetirement: "root_selection_would_retire_items",
    });
    assert.equal(confirmed.result.code, "source_unavailable");
    assert.equal(confirmed.mode, "normal", "the scan opened");
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a subtree selection that watches nothing it used to also refuses", async () => {
  const setup = await fixture(0);
  await mkdir(join(setup.root, "investing"), { mode: 0o700 });
  await writeFile(join(setup.root, "investing", "kept.txt"), "synthetic");
  for (let index = 0; index < 40; index += 1) {
    await writeFile(join(setup.root, `loose-${index}.txt`), "synthetic");
  }
  try {
    const row = folderRow({ rootAlias: "fixture", relativePath: "investing" });
    const journal = await openJournal(
      setup.journalDir,
      terminalCheckpoint([
        {
          rootAlias: "fixture",
          relativePath: "investing/kept.txt",
          externalId: randomUUID(),
        },
        ...Array.from({ length: 40 }, (_, index) => ({
          rootAlias: "fixture",
          relativePath: `loose-${index}.txt`,
          externalId: randomUUID(),
        })),
      ]),
    );
    try {
      const runner = new PipelineRunner(
        setup.config,
        journal,
        identityTransport({ failAt: "append", entries: [], requests: [] }),
      );
      const allowed = await canonicalRoots(setup.config);
      const plan = await runner.resolveServerRoots(allowed, [row]);
      await runner.startCycle(plan.roots, { inventoryEpoch: 1 });
      assert.equal(journal.checkpoint.phase, "terminal");
      assert.equal(journal.checkpoint.outcome, "incomplete");
      assert.equal(
        journal.checkpoint.code,
        "root_selection_would_retire_items",
        "narrowing a root away from where the items are is the same mistake",
      );
    } finally {
      await journal.close();
    }
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// ADM-6a. The host-move rehearsal, and the third breaker it asked for.
//
// Both ADM-4c breakers take the journal's word for what this source holds, so
// neither can see a journal that is not this source's journal. The rehearsal
// started a watcher with a stale copy: it remembered a handful of items where
// the server held two hundred for the same source. Every remembered item was
// still on disk, so nothing was missing and nothing had collapsed; the rest of
// the disk was minted as fresh identities, and the server's account-wide
// reconcile marked the items it already had -- the same documents -- as
// unavailable.

const REHEARSAL_FILES = 200;
const REHEARSAL_REMEMBERED = 6;

function rehearsalBindings() {
  return Array.from({ length: REHEARSAL_REMEMBERED }, (_, index) => ({
    rootAlias: "fixture",
    relativePath: `file-${index}.txt`,
    externalId: randomUUID(),
  }));
}

test("a journal that remembers a fraction of what the server holds would mint the rest as new identities", async () => {
  const setup = await fixture(REHEARSAL_FILES);
  try {
    const bindings = rehearsalBindings();
    const remembered = new Set(bindings.map((row) => row.externalId));
    // No `itemCounts`: the server predates the operation, which is where this
    // began and is what a watcher of this build still has to survive.
    const pass = await identityPass({ setup, bindings, providers: [] });
    assert.equal(pass.mode, "normal", "the scan opened");
    const minted = pass.bindings.filter(
      (row) => !remembered.has(row.externalId),
    );
    assert.equal(
      minted.length,
      REHEARSAL_FILES - REHEARSAL_REMEMBERED,
      "every file the stale journal had forgotten took a brand-new identity, and the server's own items for those same documents are what its reconcile then retires",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a journal that remembers a fraction of what the server holds refuses the pass before the scan opens", async () => {
  const setup = await fixture(REHEARSAL_FILES);
  try {
    const bindings = rehearsalBindings();
    const pass = await identityPass({
      setup,
      bindings,
      providers: [],
      itemCounts: {
        roots: [{ rootAlias: "fixture", liveItems: REHEARSAL_FILES }],
      },
    });
    assert.equal(pass.result.state, "incomplete");
    assert.equal(pass.result.code, "journal_behind_server");
    assert.equal(pass.mode, undefined, "the scan never opened");
    assert.deepEqual(
      pass.bindings.map((row) => row.externalId).sort(),
      bindings.map((row) => row.externalId).sort(),
      "and nothing was minted or forgotten: the next pass sees the same journal",
    );
    assert.equal(
      pass.requests.some((row) => row.operation === "scan.begin"),
      false,
      "nothing reached the server that could lead to a reconcile",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// ADM-6a review. The way out, and the one the refusal is allowed to name.
//
// The first draft refused this code without appeal and told the operator to
// remove the journal directory instead. Rehearsed, that directory also holds
// the archive catalog and the scan cache, and the four passes after it ended
// `failed / stale_observation`; removing only the state file left a source
// with unavailable items ending `identity_review_required` four passes running.
// So the refusal names the remedy that works, and takes the same per-pass,
// explicitly-named override the other two codes take.

const REHEARSAL_COUNTS = {
  roots: [{ rootAlias: "fixture", liveItems: REHEARSAL_FILES }],
};

/** Runs `attempt` with `console.warn` collected rather than printed. */
async function withWarnings(attempt) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const value = await attempt();
    return { value, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("the refusal names a remedy the operator can carry out, and never a deletion", async () => {
  const setup = await fixture(REHEARSAL_FILES);
  try {
    const { value: pass, warnings } = await withWarnings(() =>
      identityPass({
        setup,
        bindings: rehearsalBindings(),
        providers: [],
        itemCounts: REHEARSAL_COUNTS,
      }),
    );
    assert.equal(pass.result.code, "journal_behind_server");
    const refusal = warnings.find((line) => line.includes("refusing the scan"));
    assert.ok(refusal, "a refused pass says why on the way out");
    assert.match(
      refusal,
      /start the worker with this source's own, current journal/i,
      "the one remedy that recovers a stale copy",
    );
    assert.match(
      refusal,
      /--accept-retirement journal_behind_server/,
      "and the override, named exactly",
    );
    // Asserted on the string, because this is the sentence an operator acts
    // on at two in the morning. Every one of these was in the first draft or
    // one keystroke from it, and each one loses the archive catalog, the scan
    // cache, or both.
    for (const advice of [
      "remove",
      "delete",
      "rm ",
      "state.json",
      "journal directory",
      "journaldir",
      "wipe",
      "erase",
    ]) {
      assert.equal(
        refusal.toLowerCase().includes(advice),
        false,
        `the refusal must not tell the operator to ${advice.trim()} anything`,
      );
    }
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("an operator who names this code proceeds, for that one pass only", async () => {
  const setup = await fixture(REHEARSAL_FILES);
  try {
    const bindings = rehearsalBindings();
    const remembered = new Set(bindings.map((row) => row.externalId));
    const { value: accepted, warnings } = await withWarnings(() =>
      identityPass({
        setup,
        bindings,
        providers: [],
        acceptRetirement: "journal_behind_server",
        itemCounts: REHEARSAL_COUNTS,
      }),
    );
    assert.notEqual(accepted.result.code, "journal_behind_server");
    assert.equal(accepted.mode, "normal", "the scan opened");
    assert.equal(
      accepted.bindings.filter((row) => !remembered.has(row.externalId)).length,
      REHEARSAL_FILES - REHEARSAL_REMEMBERED,
      "the pass the operator asked for is the pass they get, in full",
    );
    const log = warnings.find((line) =>
      line.includes("operator accepted journal_behind_server"),
    );
    assert.ok(
      log,
      "an override nobody can check afterwards is not an override",
    );
    assert.match(
      log,
      new RegExp(
        `fixture: server ${REHEARSAL_FILES}, journal ${REHEARSAL_REMEMBERED}`,
      ),
      "with the per-root counts it overrode",
    );
    // Per pass, and nowhere else. The flag is not written to the journal and
    // not a setting, so the same worker, the same stale journal and the same
    // server refuse again on the next pass that does not name it. A second
    // fixture because the accepted pass has already moved the first journal
    // on: that is the point of accepting it.
    const again = await fixture(REHEARSAL_FILES);
    try {
      const next = await identityPass({
        setup: again,
        bindings: rehearsalBindings(),
        providers: [],
        itemCounts: REHEARSAL_COUNTS,
      });
      assert.equal(next.result.code, "journal_behind_server");
      assert.equal(next.mode, undefined, "the scan never opened");
    } finally {
      await rm(again.base, { recursive: true, force: true });
    }
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("an accepted retirement of another code does not unlock this one", async () => {
  const setup = await fixture(REHEARSAL_FILES);
  try {
    for (const acceptRetirement of [
      "root_selection_would_retire_items",
      "root_contents_collapsed",
    ]) {
      const pass = await identityPass({
        setup,
        bindings: rehearsalBindings(),
        providers: [],
        acceptRetirement,
        itemCounts: REHEARSAL_COUNTS,
      });
      assert.equal(
        pass.result.code,
        "journal_behind_server",
        `${acceptRetirement} is a different question, answered elsewhere`,
      );
      assert.equal(pass.mode, undefined, "the scan never opened");
    }
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// The refusal has to be narrow, or it becomes a watcher that never runs. Each
// of these is a shape a healthy host produces, and each one of them is a pass
// that must go on to open its scan.
test("a journal that is not behind the server runs the pass", async () => {
  const setup = await fixture(10);
  const remembered = Array.from({ length: 10 }, (_, index) => ({
    rootAlias: "fixture",
    relativePath: `file-${index}.txt`,
    externalId: randomUUID(),
  }));
  try {
    const cases = [
      [
        "the server holds exactly what the journal remembers",
        { roots: [{ rootAlias: "fixture", liveItems: 10 }] },
      ],
      [
        // Ordinary. A forgotten item keeps its binding and stops being live,
        // and so does one retired in an earlier pass.
        "the journal knows more than the server",
        { roots: [{ rootAlias: "fixture", liveItems: 1 }] },
      ],
      [
        // Two more than remembered, on ten. Under the floor of three: a
        // standing refusal for two items would be a watcher that refuses on
        // noise.
        "the server is ahead by less than the breaker's floor",
        { roots: [{ rootAlias: "fixture", liveItems: 12 }] },
      ],
      [
        // Unknown is not zero, and it is not a number to compare against
        // either. The guard abstains rather than guesses.
        "the root is missing from a truncated list",
        {
          truncated: true,
          roots: [{ rootAlias: "investing", liveItems: 900 }],
        },
      ],
      [
        // An old server answering an operation it does not know. The watcher
        // that ships with this change still runs against it.
        "the server refuses the operation",
        "refused",
      ],
    ];
    for (const [reason, itemCounts] of cases) {
      const pass = await identityPass({
        setup,
        bindings: remembered,
        providers: [],
        itemCounts,
      });
      assert.notEqual(pass.result.code, "journal_behind_server", reason);
      assert.equal(pass.mode, "normal", reason);
    }
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// ADM-6a review. The threshold, at both of its edges.
//
// The share was a quarter, and 687 items against 600 fit through it: 87
// documents minted fresh, 87 of the server's own retired, and neither ADM-4c
// breaker saw anything either, because the journal that remembers 600 of 687
// files finds every one of them on disk. A twentieth refuses it. The floor of
// three is unchanged, so a small root still cannot stand on one or two items.

const MOVED_SOURCE_FILES = 687;

/**
 * One pass over its own fixture: `files` on disk, `remembered` of them in the
 * journal, `held` of them live on the server. A fixture each, because a pass
 * that is not refused writes its own bindings into the journal and the next
 * open reads those, not the ones a case asks for.
 */
async function thresholdPass({ files, remembered, held }) {
  const setup = await fixture(files);
  try {
    return await identityPass({
      setup,
      providers: [],
      overrides: { maxFiles: 1_024 },
      bindings: Array.from({ length: remembered }, (_, index) => ({
        rootAlias: "fixture",
        relativePath: `file-${index}.txt`,
        externalId: randomUUID(),
      })),
      itemCounts: { roots: [{ rootAlias: "fixture", liveItems: held }] },
    });
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
}

test("the server-ahead share refuses at its edge and not below it", async () => {
  // `Math.ceil(687 / 20)` is 35, so 652 refuses and 653 does not.
  for (const [remembered, refused, reason] of [
    [600, true, "the numbers that got through a quarter"],
    [652, true, "the share exactly, which is a refusal"],
    [653, false, "one item under the share, and the pass runs"],
  ]) {
    const pass = await thresholdPass({
      files: MOVED_SOURCE_FILES,
      remembered,
      held: MOVED_SOURCE_FILES,
    });
    assert.equal(pass.result.code === "journal_behind_server", refused, reason);
    assert.equal(pass.mode, refused ? undefined : "normal", reason);
  }
});

test("the floor of three is what decides a small root", async () => {
  // A twentieth of thirteen is one. On a root this small the floor is the
  // whole rule, which is why it is a floor and not a share.
  for (const [held, refused] of [
    [13, true],
    [12, false],
  ]) {
    const pass = await thresholdPass({ files: 10, remembered: 10, held });
    assert.equal(
      pass.result.code === "journal_behind_server",
      refused,
      `the server holds ${held} where the journal remembers 10`,
    );
    assert.equal(pass.mode, refused ? undefined : "normal");
  }
});

// The asymmetry the rule rests on, re-run at the sharper threshold: a narrowed
// root counts every binding under its alias, not only the ones inside the
// current prefixes. Counting only the narrowed ones would read a healthy
// narrowed root as a journal that had forgotten the rest -- five items here,
// which a twentieth of thirty refuses.
test("narrowing a watched root does not read as a journal behind the server", async () => {
  const setup = await fixture(0);
  await mkdir(join(setup.root, "investing"), { mode: 0o700 });
  for (let index = 0; index < 25; index += 1) {
    await writeFile(
      join(setup.root, "investing", `kept-${index}.txt`),
      "synthetic",
    );
  }
  for (let index = 0; index < 5; index += 1) {
    await writeFile(join(setup.root, `loose-${index}.txt`), "synthetic");
  }
  try {
    const row = folderRow({ rootAlias: "fixture", relativePath: "investing" });
    const journal = await openJournal(
      setup.journalDir,
      terminalCheckpoint([
        ...Array.from({ length: 25 }, (_, index) => ({
          rootAlias: "fixture",
          relativePath: `investing/kept-${index}.txt`,
          externalId: randomUUID(),
        })),
        ...Array.from({ length: 5 }, (_, index) => ({
          rootAlias: "fixture",
          relativePath: `loose-${index}.txt`,
          externalId: randomUUID(),
        })),
      ]),
    );
    try {
      const runner = new PipelineRunner(
        setup.config,
        journal,
        identityTransport({
          failAt: "append",
          entries: [],
          requests: [],
          itemCounts: { roots: [{ rootAlias: "fixture", liveItems: 30 }] },
        }),
      );
      const allowed = await canonicalRoots(setup.config);
      const plan = await runner.resolveServerRoots(allowed, [row]);
      await runner.startCycle(plan.roots, { inventoryEpoch: 1 });
      assert.equal(
        journal.checkpoint.phase,
        "scan_begin",
        "the pass opened its scan",
      );
      assert.equal(journal.checkpoint.mode, "normal");
    } finally {
      await journal.close();
    }
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// The owner adds a folder. Nothing is in it yet and the server has nothing
// under it, so both sides are zero and neither the new root nor the old one
// may be read as a journal that has fallen behind.
test("adding a root the server has never held does not refuse the pass", async () => {
  const setup = await fixture(0);
  await writeFile(join(setup.root, "statement.txt"), "synthetic");
  const added = await secondRoot(setup, "investing", {});
  try {
    const pass = await identityPass({
      setup,
      roots: [added],
      providers: [],
      bindings: [
        {
          rootAlias: "fixture",
          relativePath: "statement.txt",
          externalId: randomUUID(),
        },
      ],
      itemCounts: { roots: [{ rootAlias: "fixture", liveItems: 1 }] },
    });
    assert.notEqual(pass.result.code, "journal_behind_server");
    assert.equal(pass.mode, "normal", "the scan opened");
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("the first enumeration of a new source does not refuse the pass", async () => {
  const setup = await fixture(5);
  try {
    const pass = await identityPass({
      setup,
      bindings: [],
      providers: [],
      checkpoint: initialCheckpoint,
      enumeration: { state: "never" },
      itemCounts: { roots: [] },
    });
    assert.notEqual(pass.result.code, "journal_behind_server");
    assert.equal(pass.mode, "normal", "the scan opened");
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// A watcher with no journal against an enumerated source is the remedy this
// refusal points at, so it must not be the thing the refusal fires on. It
// cannot be: an identity-recovery pass reconciles to `needs_review` and
// retires nothing, so the guard is never asked.
test("identity recovery with a fresh journal never asks the server what it holds", async () => {
  const setup = await fixture(REHEARSAL_FILES);
  try {
    const pass = await identityPass({
      setup,
      bindings: [],
      providers: [],
      checkpoint: initialCheckpoint,
      itemCounts: {
        roots: [{ rootAlias: "fixture", liveItems: REHEARSAL_FILES }],
      },
    });
    assert.equal(pass.mode, "identity_recovery");
    assert.notEqual(pass.result.code, "journal_behind_server");
    assert.equal(
      pass.requests.some((row) => row.operation === "source.itemCounts"),
      false,
      "a pass that cannot retire anything does not need the count",
    );
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

// Second review, item 6. The two bounds the round-one work moved that had no
// test of their own.

test("the checkpoint accepts every page ordinal the protocol allows, and no more", () => {
  const plan = pdfPlan();
  const base = {
    version: 1,
    phase: "append",
    mode: "normal",
    scanId: "scan-1",
    inventoryEpoch: 1,
    manifestVersion: 1,
    missingBindings: [],
    files: [plan],
    identities: [],
    reviewSeen: false,
  };
  // 64 was hardcoded here while the protocol allowed 64 pages. Raising the
  // protocol without this made a scan past 256 files write a checkpoint its
  // own validator then refused, mid-pass, with nothing to clear it.
  assert.equal(
    parseRunnerCheckpoint({ ...base, nextOrdinal: 80 }).nextOrdinal,
    80,
    "80 pages is 320 files, which the old bound refused",
  );
  assert.equal(
    parseRunnerCheckpoint({ ...base, nextOrdinal: MAX_WORKER_SCAN_PAGES })
      .nextOrdinal,
    MAX_WORKER_SCAN_PAGES,
  );
  assert.throws(() =>
    parseRunnerCheckpoint({ ...base, nextOrdinal: MAX_WORKER_SCAN_PAGES + 1 }),
  );
});

test("the seal check re-enumerates from the same roots the scan was planned from", async () => {
  const setup = await fixture(0);
  await mkdir(join(setup.root, "investing"), { mode: 0o700 });
  await writeFile(join(setup.root, "investing", "kept.txt"), "synthetic");
  await writeFile(join(setup.root, "outside.txt"), "synthetic");
  try {
    const row = folderRow({ rootAlias: "fixture", relativePath: "investing" });
    const journal = await openJournal(setup.journalDir, terminalCheckpoint([]));
    try {
      let rootsCalls = 0;
      const runner = new PipelineRunner(setup.config, journal, {
        async call(request) {
          if (request.operation === "source.roots") {
            rootsCalls += 1;
            return {
              operation: "source.roots",
              sourceAccountId: "source",
              roots: [row],
            };
          }
          throw new Error(`unexpected operation ${request.operation}`);
        },
      });
      const first = await runner.currentRoots();
      assert.deepEqual(first[0].includePrefixes, ["investing"]);
      // The seal check calls this again. Given the allow-list instead of the
      // selection it would find `outside.txt`, disagree with the sealed
      // manifest, and end the scan `unstable` -- on every pass, forever.
      const second = await runner.currentRoots();
      assert.equal(second, first, "resolved once, reused");
      assert.equal(rootsCalls, 1, "and the server is asked once per pass");
    } finally {
      await journal.close();
    }
  } finally {
    await rm(setup.base, { recursive: true, force: true });
  }
});

for (const parserProfileId of ["pdf_docqa_v1", "spreadsheet_v1"]) {
  test(`new ${parserProfileId} intents use worker time while retaining future source metadata`, async () => {
    const setup = await fixture(0);
    const future = Date.UTC(2036, 0, 1);
    const plan = pdfPlan({ sourceModifiedAt: future, parserProfileId });
    const checkpoint = archivedCheckpoint(plan, {
      step: "intent",
      preflightAction: undefined,
      originalCatalogId: undefined,
      expectedOriginalRevision: undefined,
      processingCatalogId: undefined,
      expectedProcessingRevision: undefined,
    });
    const journal = await openJournal(setup.journalDir, checkpoint);
    let dirs = ["capture", "output", "spool"].map((name) =>
      join(setup.base, name),
    );
    await Promise.all(dirs.map((path) => mkdir(path, { mode: 0o700 })));
    dirs = await Promise.all(dirs.map((path) => realpath(path)));
    const runner = new PipelineRunner(
      {
        ...setup.config,
        pdfDocQa: {
          captureDirectory: dirs[0],
          parserOutputRoot: dirs[1],
          spoolDirectory: dirs[2],
          archive: { primary: {}, independentBackup: {} },
        },
      },
      journal,
      {
        async call() {
          throw new Error("no transport for intents");
        },
      },
    );
    const stored = [];
    runner.archiveCatalog = {
      findOriginalExact() {},
      findProcessingExact() {},
      async createOriginalIntent(row) {
        stored.push(row);
        return { ...row, rowRevision: 1 };
      },
      async createProcessingIntent(row) {
        stored.push(row);
        return { ...row, rowRevision: 1 };
      },
    };
    try {
      const before = Date.now();
      const next = await runner.createArchivedIntents(checkpoint);
      const after = Date.now();
      assert.equal(stored.length, 2);
      for (const row of stored)
        assert.ok(row.createdAt >= before && row.createdAt <= after);
      assert.equal(stored[0].createdAt, stored[1].createdAt);
      assert.equal(next.files[0].sourceModifiedAt, future);
      assert.equal(next.step, "preflight");
    } finally {
      await journal.close();
      await rm(setup.base, { recursive: true, force: true });
    }
  });
}

test("a selected K-1 creates one sparse primary-only batch with grounded closure", async () => {
  const setup = await fixture(0);
  const [captures, outputs, spool] = await Promise.all(
    ["targeted-captures", "targeted-outputs", "targeted-spool"].map(
      async (name) => {
        const path = join(setup.base, name);
        await mkdir(path, { mode: 0o700 });
        return await realpath(path);
      },
    ),
  );
  const plan = pdfPlan({ discoveryState: "queued" });
  const identity = {
    sourceItemId: plan.sourceItemId,
    observationEpoch: plan.observationEpoch,
    processingEpoch: plan.processingEpoch,
    sha256: plan.sha256,
  };
  const checkpoint = archivedCheckpoint(plan, {
    step: "intent",
    preflightAction: undefined,
    originalCatalogId: undefined,
    expectedOriginalRevision: undefined,
    processingCatalogId: undefined,
    expectedProcessingRevision: undefined,
    metadataFirst: {
      version: 1,
      triageStartIndex: 0,
      refreshReady: false,
      selected: [identity],
      previewed: [identity],
      previewGaps: [],
      targetedTax: [
        {
          ...identity,
          goalKind: "schedule_k1_key_fields_v1",
          sourcePageCount: 140,
        },
      ],
      targetedTaxClassified: [identity],
      selectionReceipts: [],
    },
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const original = {
    originalCatalogId: randomUUID(),
    rowRevision: 1,
    origin: {
      scanId: checkpoint.scanId,
      observationEpoch: plan.observationEpoch,
      sha256: plan.sha256,
      byteLength: plan.byteLength,
      mediaType: "application/pdf",
    },
    copies: {},
    providerOriginal: {
      referenceVersion: "provider_original_v2",
      clientReferenceId: randomUUID(),
      bindingId: randomUUID(),
    },
  };
  let created;
  const runner = new PipelineRunner(
    {
      ...setup.config,
      pdfDocQa: {
        captureDirectory: captures,
        parserOutputRoot: outputs,
        spoolDirectory: spool,
        archive: { primary: {} },
        providerOriginal: { rootAlias: "fixture" },
      },
    },
    journal,
    {
      async call() {
        throw new Error("network is not used");
      },
    },
  );
  runner.copyIntent = (subject, role) => ({
    role,
    clientReceiptId: randomUUID(),
    archiveObjectId: randomUUID(),
    objectName: `${randomUUID()}.age`,
  });
  runner.executeMetadataPreview = async (_item, windows) => {
    const inspectedOriginalUnits = windows.flatMap(({ startPage, pageCount }) =>
      Array.from({ length: pageCount }, (_, index) => startPage + index),
    );
    return {
      sourceSha256: plan.sha256,
      mediaType: "application/pdf",
      sourceUnitCount: 140,
      inspectedOriginalUnits,
      unitStates: inspectedOriginalUnits.map(() => "text_available"),
      unitTexts: inspectedOriginalUnits.map((page) =>
        page === 137
          ? "Schedule K-1 (Form 1065) Box 1 Ordinary business income. See attached statement"
          : page === 138
            ? "Schedule K-1 (Form 1065) continued"
            : page === 139
              ? "Schedule K-1 statement detail"
              : page === 140
                ? "Form 1099 supporting attachment"
                : `cover or index page ${page}`,
      ),
      unitTextTruncated: inspectedOriginalUnits.map(() => false),
      method: "pdf_native_text_v1",
      methodFingerprint: HASH,
    };
  };
  runner.archiveCatalog = {
    findOriginalExact() {
      return original;
    },
    findProcessingExact() {},
    async createProcessingIntent(value) {
      created = value;
      return { ...value, rowRevision: 1 };
    },
  };
  try {
    const next = await runner.createArchivedIntents(checkpoint);
    assert.deepEqual(next.targetedTaxRun.plannedPages, [137, 138, 139]);
    assert.equal(next.targetedTaxRun.requestedRegionsClosed, true);
    assert.equal(next.targetedTaxRun.continuationsClosed, true);
    assert.deepEqual(created.targetedBatch.originalPages, [137, 138, 139]);
    assert.deepEqual(Object.keys(created.copies), ["primary"]);
    assert.equal(next.step, "preflight");
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a sparse target begins, appends its first batch, and plans only the missing continuation", async () => {
  const setup = await fixture(0);
  const [captures, outputs, spool] = await Promise.all(
    ["target-flow-captures", "target-flow-outputs", "target-flow-spool"].map(
      async (name) => {
        const path = join(setup.base, name);
        await mkdir(path, { mode: 0o700 });
        return await realpath(path);
      },
    ),
  );
  const plan = pdfPlan();
  const processingCatalogId = randomUUID();
  const originalCatalogId = randomUUID();
  const targetId = "target-synthetic";
  const firstPages = Array.from({ length: 12 }, (_, index) => index + 1);
  const targetedTaxRun = {
    goalKind: "schedule_k1_key_fields_v1",
    sourcePageCount: 20,
    plannedPages: [...firstPages, 13],
    requestedRegionsClosed: true,
    continuationsClosed: true,
    batchOrdinal: 0,
    processingCatalogIds: [processingCatalogId],
  };
  const checkpoint = archivedCheckpoint(plan, {
    step: "targeted_begin",
    preflightAction: undefined,
    originalCatalogId,
    expectedOriginalRevision: 1,
    processingCatalogId,
    expectedProcessingRevision: 1,
    targetedTaxRun,
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const original = {
    originalCatalogId,
    rowRevision: 1,
    origin: {
      scanId: checkpoint.scanId,
      observationEpoch: plan.observationEpoch,
      sha256: plan.sha256,
      byteLength: plan.byteLength,
      mediaType: "application/pdf",
    },
    copies: {},
    providerOriginal: { referenceVersion: "provider_original_v2" },
    cloud: {
      sourceItemId: plan.sourceItemId,
      sourceRevisionId: "revision-synthetic",
      providerReferenceId: "provider-synthetic",
      providerBindingEpoch: 1,
    },
  };
  const selectiveOutput = {
    artifactKind: "selective_pdf_pages_v1",
    sourceSha256: plan.sha256,
    parserFingerprint: plan.parserFingerprint,
    extractionConfigurationFingerprint: plan.extractionConfigurationFingerprint,
    extractionFingerprint: HASH,
    coverage: {
      schemaVersion: 1,
      sourceSha256: plan.sha256,
      selectedPdfSha256: "b".repeat(64),
      sourcePageCount: 20,
      originalPages: firstPages,
      fingerprint: "c".repeat(64),
    },
    artifactFingerprint: "d".repeat(64),
  };
  let processing = {
    processingCatalogId,
    originalCatalogId,
    rowRevision: 1,
    currentObservation: {
      scanId: checkpoint.scanId,
      observationEpoch: plan.observationEpoch,
      processingEpoch: plan.processingEpoch,
    },
    fingerprints: {},
    targetedBatch: {
      goalKind: targetedTaxRun.goalKind,
      batchOrdinal: 0,
      sourcePageCount: 20,
      originalPages: firstPages,
    },
    parserOutput: selectiveOutput,
    cloud: {
      sourceItemId: plan.sourceItemId,
      sourceRevisionId: original.cloud.sourceRevisionId,
      parserArtifactId: "artifact-synthetic",
      sourceTextVersionId: "text-synthetic",
      processingGenerationId: "generation-synthetic",
      ingestJobId: "job-synthetic",
    },
  };
  const processings = [processing];
  const requests = [];
  const runner = new PipelineRunner(
    {
      ...setup.config,
      pdfDocQa: {
        captureDirectory: captures,
        parserOutputRoot: outputs,
        spoolDirectory: spool,
        archive: { primary: {} },
        providerOriginal: { rootAlias: "fixture" },
      },
    },
    journal,
    {
      async call(request) {
        requests.push(structuredClone(request));
        if (request.operation === "extraction.beginTargetedTax")
          return {
            operation: request.operation,
            targetId,
            sourceItemId: plan.sourceItemId,
            sourceRevisionId: original.cloud.sourceRevisionId,
            goalKind: targetedTaxRun.goalKind,
            status: "awaiting_pages",
            inspectedOriginalPages: [],
            unresolvedFields: request.requiredFields,
            reused: false,
          };
        if (request.operation === "extraction.appendTargetedTaxBatch")
          return {
            operation: request.operation,
            targetId,
            sourceItemId: plan.sourceItemId,
            sourceRevisionId: original.cloud.sourceRevisionId,
            goalKind: targetedTaxRun.goalKind,
            status: "running",
            inspectedOriginalPages: firstPages,
            unresolvedFields: [],
            reused: false,
          };
        if (request.operation === "extraction.targetedTaxStatus")
          return {
            operation: request.operation,
            targetId,
            sourceItemId: plan.sourceItemId,
            sourceRevisionId: original.cloud.sourceRevisionId,
            goalKind: targetedTaxRun.goalKind,
            status: "incomplete_resumable",
            inspectedOriginalPages: firstPages,
            unresolvedFields: ["box_20_other_information"],
            reused: true,
          };
        throw new Error(`unexpected operation ${request.operation}`);
      },
    },
  );
  runner.copyIntent = (_subject, role) => ({
    role,
    clientReceiptId: randomUUID(),
    archiveObjectId: randomUUID(),
    objectName: `${randomUUID()}.age`,
  });
  runner.mappedProcessing = async () => ({
    original,
    processing,
    declaration: {},
    mapping: {
      pages: firstPages.map((ordinal) => ({
        ordinal: ordinal - 1,
        textHash: String(ordinal).padStart(64, "0"),
      })),
      evidence: [],
      documents: [],
      chunks: [],
    },
  });
  runner.archiveCatalog = {
    listOriginals() {
      return [original];
    },
    listProcessings() {
      return processings;
    },
    findProcessingExact() {},
    async createProcessingIntent(value) {
      const created = { ...value, rowRevision: 1 };
      processings.push(created);
      return created;
    },
  };
  try {
    await runner.driveTargetedBegin();
    assert.equal(journal.checkpoint.step, "parsed_reserve");
    assert.equal(journal.checkpoint.targetedTaxRun.targetId, targetId);
    await journal.transitionCheckpoint({
      checkpoint: parseRunnerCheckpoint({
        ...journal.checkpoint,
        step: "targeted_append",
      }),
      credentialSessionActive: true,
    });
    await runner.driveTargetedAppend();
    assert.equal(journal.checkpoint.step, "targeted_status");
    assert.equal(
      requests.find(
        (request) => request.operation === "extraction.appendTargetedTaxBatch",
      ).coverage.requestedRegionsClosed,
      false,
      "the first transport batch cannot claim final goal coverage",
    );
    await runner.driveTargetedStatus();
    assert.equal(journal.checkpoint.step, "capture");
    assert.equal(journal.checkpoint.targetedTaxRun.batchOrdinal, 1);
    assert.deepEqual(processings[1].targetedBatch.originalPages, [13]);
    assert.deepEqual(Object.keys(processings[1].copies), ["primary"]);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("a targeted status from another source cannot complete or clean up the batch", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const processingCatalogId = randomUUID();
  const originalCatalogId = randomUUID();
  const checkpoint = archivedCheckpoint(plan, {
    step: "targeted_status",
    preflightAction: undefined,
    originalCatalogId,
    expectedOriginalRevision: 1,
    processingCatalogId,
    expectedProcessingRevision: 1,
    targetedTaxRun: {
      goalKind: "form_1040_totals_v1",
      sourcePageCount: 2,
      plannedPages: [1, 2],
      requestedRegionsClosed: true,
      continuationsClosed: true,
      batchOrdinal: 0,
      processingCatalogIds: [processingCatalogId],
      targetId: "target-synthetic",
      priorProcessingGenerationId: "generation-synthetic",
    },
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const original = { originalCatalogId, rowRevision: 1 };
  const processing = {
    processingCatalogId,
    originalCatalogId,
    rowRevision: 1,
    cloud: {
      sourceItemId: plan.sourceItemId,
      sourceRevisionId: "revision-synthetic",
    },
  };
  let completed = false;
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      assert.equal(request.operation, "extraction.targetedTaxStatus");
      return {
        operation: request.operation,
        targetId: checkpoint.targetedTaxRun.targetId,
        sourceItemId: "another-source",
        sourceRevisionId: "another-revision",
        goalKind: checkpoint.targetedTaxRun.goalKind,
        status: "complete",
        inspectedOriginalPages: [1, 2],
        unresolvedFields: [],
        reused: true,
      };
    },
  });
  runner.archiveCatalog = {
    listOriginals() {
      return [original];
    },
    listProcessings() {
      return [processing];
    },
    async recordTargetedCompletion() {
      completed = true;
      assert.fail("a foreign status must not be persisted");
    },
  };
  try {
    await assert.rejects(
      () => runner.driveTargetedStatus(),
      (error) => error.code === "targeted_tax_parent_conflict",
    );
    assert.equal(journal.checkpoint.step, "targeted_status");
    assert.equal(completed, false);
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("an answered targeted completion replays the same durable catalog timestamp", async () => {
  const setup = await fixture(0);
  const plan = pdfPlan();
  const processingCatalogId = randomUUID();
  const originalCatalogId = randomUUID();
  const targetId = "target-replay";
  const checkpoint = archivedCheckpoint(plan, {
    step: "targeted_status",
    preflightAction: undefined,
    originalCatalogId,
    expectedOriginalRevision: 1,
    processingCatalogId,
    expectedProcessingRevision: 1,
    targetedTaxRun: {
      goalKind: "form_1040_totals_v1",
      sourcePageCount: 2,
      plannedPages: [1, 2],
      requestedRegionsClosed: true,
      continuationsClosed: true,
      batchOrdinal: 0,
      processingCatalogIds: [processingCatalogId],
      targetId,
      priorProcessingGenerationId: "generation-replay",
    },
  });
  const journal = await openJournal(setup.journalDir, checkpoint);
  const original = { originalCatalogId, rowRevision: 1 };
  let processing = {
    processingCatalogId,
    originalCatalogId,
    rowRevision: 1,
    targetedBatch: { batchOrdinal: 0 },
    cloud: {
      sourceItemId: plan.sourceItemId,
      sourceRevisionId: "revision-replay",
    },
  };
  let transportCalls = 0;
  let completionWrites = 0;
  const runner = new PipelineRunner(setup.config, journal, {
    async call(request) {
      transportCalls += 1;
      return {
        operation: request.operation,
        targetId,
        sourceItemId: processing.cloud.sourceItemId,
        sourceRevisionId: processing.cloud.sourceRevisionId,
        goalKind: checkpoint.targetedTaxRun.goalKind,
        status: "complete",
        inspectedOriginalPages: [1, 2],
        unresolvedFields: [],
        reused: false,
      };
    },
  });
  runner.archiveCatalog = {
    listOriginals() {
      return [original];
    },
    listProcessings() {
      return [processing];
    },
    async recordTargetedCompletion(args) {
      completionWrites += 1;
      if (processing.targetedCompletion) {
        assert.deepEqual(args.completion, processing.targetedCompletion);
        return processing;
      }
      processing = {
        ...processing,
        rowRevision: processing.rowRevision + 1,
        targetedCompletion: structuredClone(args.completion),
      };
      return processing;
    },
  };
  const commit = journal.commitResult.bind(journal);
  let interrupted = false;
  journal.commitResult = async () => {
    interrupted = true;
    throw new Error("synthetic crash after catalog completion");
  };
  try {
    await assert.rejects(
      () => runner.driveTargetedStatus(),
      /synthetic crash after catalog completion/,
    );
    assert.equal(interrupted, true);
    assert.equal(journal.checkpoint.step, "targeted_status");
    assert.equal(completionWrites, 1);
    journal.commitResult = commit;
    await runner.driveTargetedStatus();
    assert.equal(journal.checkpoint.step, "cleanup");
    assert.equal(completionWrites, 2);
    assert.equal(transportCalls, 1, "the answered status is not sent again");
  } finally {
    journal.commitResult = commit;
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});

test("legacy future admission replays exactly, then renews and admits without repeating archive work", async () => {
  const setup = await fixture(0);
  const future = Date.UTC(2036, 0, 1);
  const plan = pdfPlan({ sourceModifiedAt: future });
  const checkpoint = admitCheckpoint(plan);
  checkpoint.discoveryLease.leaseExpiresAt = 1;
  let journal = await openJournal(setup.journalDir, checkpoint);
  let rows = durableProviderRows(checkpoint, Date.now());
  rows.original.createdAt = future;
  rows.processing.createdAt = future;
  const originalBefore = structuredClone(rows.original);
  const processingBefore = structuredClone(rows.processing);
  const sent = [];
  const transport = {
    async call(body) {
      sent.push(structuredClone(body));
      if (sent.length === 1) return { error: { code: "lease_conflict" } };
      if (body.operation === "discovery.reserveArchived")
        return {
          operation: body.operation,
          ...checkpoint.discoveryLease,
          reused: false,
          leaseEpoch: 2,
          leaseExpiresAt: Date.now() + 60_000,
        };
      assert.equal(body.operation, "discovery.admitArchived");
      return admittedResponse(plan);
    },
  };
  const configure = () => {
    const r = new PipelineRunner(setup.config, journal, transport);
    r.archivedRows = () => rows;
    r.mappedProcessing = async () => ({
      ...rows,
      declaration: parsedDeclaration(),
    });
    r.archiveCatalog = admissionCatalog(
      () => rows,
      (value) => {
        rows = value;
      },
    );
    r.recordArchiveAction = async () => {
      throw new Error("must not repeat archive work");
    };
    return r;
  };
  let runner = configure();
  const provider = runner.admissionProvider(checkpoint, rows.original, false);
  const selections = runner.admissionSelections(
    checkpoint,
    rows,
    provider.providerOriginal,
  );
  const legacy = {
    protocolVersion: 1,
    operation: "discovery.admitArchived",
    spaceId: "space",
    sourceAccountId: "source",
    requestId: randomUUID(),
    workId: checkpoint.discoveryLease.workId,
    leaseEpoch: 1,
    leaseToken: TOKEN,
    parserArtifact: { ...selections.parserArtifact, createdAt: future },
    archives: selections.archives.map((value) => ({
      ...value,
      createdAt: future,
    })),
    providerOriginal: { ...provider.providerOriginal, createdAt: future },
    parsedText: parsedDeclaration(),
  };
  await journal.planRequest({
    operation: legacy.operation,
    requestId: legacy.requestId,
    requestBody: JSON.stringify(legacy),
    createdAt: Date.now(),
  });
  await journal.close();
  journal = await openJournal(setup.journalDir);
  runner = configure();
  try {
    for (const tampered of [
      {
        ...legacy,
        providerOriginal: { ...legacy.providerOriginal, createdAt: future - 1 },
      },
      {
        ...legacy,
        parserArtifact: {
          ...legacy.parserArtifact,
          outputHash: "b".repeat(64),
        },
      },
      {
        ...legacy,
        archives: legacy.archives.map((a, i) =>
          i === 0 ? { ...a, createdAt: future - 1 } : a,
        ),
      },
    ])
      await assert.rejects(
        () => runner.validatePendingBody(legacy.operation, tampered),
        (error) => error.code === "journal_phase_conflict",
      );
    await runner.driveArchivedAdmit();
    assert.deepEqual(sent, [legacy]);
    assert.equal(journal.pending, undefined);
    assert.equal(journal.checkpoint.step, "reserve");
    await runner.driveArchivedReserve();
    await runner.driveArchivedAdmit();
    assert.equal(sent.length, 3);
    const fresh = sent[2];
    assert.notEqual(fresh.requestId, legacy.requestId);
    assert.equal(fresh.leaseEpoch, 2);
    assert.ok(
      fresh.providerOriginal.createdAt <= fresh.providerOriginal.verifiedAt,
    );
    assert.ok(
      fresh.providerOriginal.createdAt <=
        fresh.providerOriginal.locatorBundle.readbackVerifiedAt,
    );
    for (const receipt of fresh.archives) {
      assert.ok(receipt.createdAt <= receipt.readbackVerifiedAt);
      if (receipt.subjectKind === "parser_output")
        assert.ok(fresh.parserArtifact.createdAt <= receipt.readbackVerifiedAt);
    }
    assert.equal(journal.pending, undefined);
    assert.equal(journal.checkpoint.step, "parsed_reserve");
    assert.equal(rows.original.createdAt, future);
    assert.equal(rows.processing.createdAt, future);
    assert.deepEqual(
      rows.original.providerOriginal,
      originalBefore.providerOriginal,
    );
    assert.equal(
      rows.original.originalCatalogId,
      originalBefore.originalCatalogId,
    );
    assert.equal(
      rows.processing.processingCatalogId,
      processingBefore.processingCatalogId,
    );
    for (const [name, before] of [
      ["original", originalBefore],
      ["processing", processingBefore],
    ]) {
      for (const [role, copy] of Object.entries(before.copies)) {
        const { cloudReceipt, ...remaining } = rows[name].copies[role];
        assert.ok(cloudReceipt);
        assert.deepEqual(remaining, copy);
      }
    }
  } finally {
    await journal.close();
    await rm(setup.base, { recursive: true, force: true });
  }
});
