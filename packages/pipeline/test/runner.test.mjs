import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal } from "../dist/journal.js";
import {
  initialCheckpoint,
  journalCodec,
  PipelineRunner,
} from "../dist/runner.js";

const TOKEN = "a".repeat(64);

function config(root, journalDir) {
  return {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
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

function binding() {
  return {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
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
    binding: binding(),
    credential: "test-credential",
    initialCheckpoint: checkpoint,
    codec: journalCodec,
  });
}

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
