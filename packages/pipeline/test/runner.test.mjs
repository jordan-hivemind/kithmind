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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal, JournalLockedError } from "../dist/journal.js";
import {
  ADMISSION_BLOCK_CODES,
  ArchiveCatalogError,
  MAX_ADMISSION_BLOCK_ATTEMPTS,
  openArchiveCatalog,
} from "../dist/archiveCatalog.js";
import { digestArchiveIntent } from "../dist/archivedRequestMapping.js";
import {
  initialCheckpoint,
  journalCodec,
  PipelineRunner,
} from "../dist/runner.js";
import { ParserProcessError } from "../dist/parserProcess.js";
import { persistProviderBinding } from "../dist/providerRegistry.js";
import {
  reconcileReceiptsFromPath,
  runReconcileReceipts,
} from "../dist/reconcileReceipts.js";
import { parseRunnerCheckpoint } from "../dist/runnerState.js";

const HASH = "a".repeat(64);

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
      cloud.operations.filter((operation) => operation === "scan.begin")
        .length,
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
    assert.deepEqual(operations, ["source.status"]);
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

test("a cached provider preflight is revalidated and revoked authority prevents locator side effects", async () => {
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
    preflightAction: "provider_verify",
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
    await runner.driveArchivedPreflight();
    assert.equal(published, 0);
    assert.deepEqual(sent, [body]);
    assert.equal(journal.pending, undefined);
    assert.equal(journal.checkpoint.phase, "terminal");
    assert.equal(journal.checkpoint.code, "not_authorized");
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

test("provider verification projects the full verifier result into the closed catalog shape", async () => {
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
  const persisted = await persistProviderBinding({
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
    const next = await runner.driveProviderOriginal(
      checkpoint,
      original,
      processing,
      join(setup.root, plan.relativePath),
      "provider_verify",
    );
    assert.equal(next.step, "parser_archive");
    assert.equal(next.expectedOriginalRevision, 2);
    assert.deepEqual(catalog.listOriginals()[0].providerOriginal.verified, {
      providerAccountIdHash: metadata.providerAccountIdHash,
      providerRootDirectoryIdHash: metadata.providerRootDirectoryIdHash,
      providerFileIdHash: metadata.providerFileIdHash,
      providerRevision: metadata.providerRevision,
      providerContentHash: metadata.providerContentHash,
      sourceContentHash: metadata.sourceContentHash,
      sourceByteLength: metadata.sourceByteLength,
      verifiedAt: metadata.verifiedAt,
      manifestFingerprint: persisted.manifestFingerprint,
      manifestByteLength: persisted.manifestByteLength,
    });
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
      // The real catalog writes the note once and bumps the revision only when
      // the row actually changed, so a repeat call is free.
      const changed =
        cloud !== undefined ||
        row.receiptReconcile === undefined ||
        Object.values(row.copies).some((copy) => copy.cloudReceipt);
      write({
        ...rows,
        [key]: {
          ...withoutCloud,
          copies,
          rowRevision: row.rowRevision + (changed ? 1 : 0),
          receiptReconcile: row.receiptReconcile ?? {
            code: "original_receipt_unknown_to_server",
            clearedAt: args.clearedAt,
          },
        },
      });
      return read()[key];
    },
  };
}

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
    assert.equal(
      rows.original.receiptReconcile.code,
      "original_receipt_unknown_to_server",
    );
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
  runner.archiveCatalog = admissionCatalog(() => rows, (next) => (rows = next));
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
  runner.archiveCatalog = admissionCatalog(() => rows, (next) => (rows = next));
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
    assert.equal(
      current.original.receiptReconcile.code,
      "original_receipt_unknown_to_server",
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
      (error) =>
        error.code === "provider_locator_recovery_review_required",
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
