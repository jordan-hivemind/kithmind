import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal } from "../dist/journal.js";
import { openArchiveCatalog } from "../dist/archiveCatalog.js";
import { digestArchiveIntent } from "../dist/archivedRequestMapping.js";
import {
  initialCheckpoint,
  journalCodec,
  PipelineRunner,
} from "../dist/runner.js";
import { ParserProcessError } from "../dist/parserProcess.js";
import { persistProviderBinding } from "../dist/providerRegistry.js";
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

function binding(journalDir) {
  return {
    protocolVersion: 1,
    endpoint: fixtureEndpoint(journalDir),
    spaceId: "space",
    sourceAccountId: "source",
    configFingerprint: "b".repeat(64),
    credentialSlot: "PIPELINE_TOKEN",
  };
}

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
  return { base, root, journalDir, config: config(root, journalDir) };
}

async function openJournal(directory, checkpoint = initialCheckpoint) {
  return await Journal.open({
    directory,
    binding: binding(directory),
    credential: "test-credential",
    initialCheckpoint: checkpoint,
    codec: journalCodec,
  });
}

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
  const { base, root, journalDir, config: localConfig } = await fixture();
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
  const journal = await openJournal(journalDir, checkpoint);
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
    await assert.rejects(() =>
      new PipelineRunner(localConfig, journal, transport).run(),
    );
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
  const setup = await fixture(0);
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
  let journal = await openJournal(setup.journalDir, checkpoint);
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
  const journal = await openJournal(setup.journalDir);
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

function assessmentCounts(ready) {
  return {
    items: {
      ready,
      pending: 0,
      failed: 0,
      needsReview: 0,
      explicitGap: 0,
      unavailable: 0,
      ignoredForgotten: 0,
    },
    unresolvedEntries: { needsReview: 0, ignoredForgotten: 0 },
  };
}

class CompleteCloud {
  constructor(options = {}) {
    this.failFirstStage = options.failFirstStage ?? false;
    this.stageFailed = false;
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
      rawArtifact: { sha256: HASH, byteLength: 100 },
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
    const original = { originalCatalogId: randomUUID() };
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

  assert.equal((await reconcile("queued", [])).phase, "archived");
  assert.equal(
    (await reconcile("unchanged", [{ activation: { state: "ready" } }])).phase,
    "discovery_reserve",
  );
  assert.equal(
    (await reconcile("unchanged", [{ activation: undefined }])).phase,
    "archived",
  );
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
    activation: { state: "ready" },
  };
  runner.archiveCatalog = {
    findOriginalExact() {
      return original;
    },
    findProcessingExact() {
      return undefined;
    },
    listProcessings() {
      return [processing];
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
    const setup = await fixture(0);
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
    const plan = pdfPlan();
    const checkpoint = archivedCheckpoint(plan, {
      step: "cleanup",
      preflightAction: undefined,
    });
    const journal = await openJournal(setup.journalDir, checkpoint);
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
