import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ArchiveRelocationOwnerResumeError,
  __testOnlyVerifyArchiveRelocationOwnerResume,
} from "../dist/archiveRelocationOwnerResume.js";
import { relocationIntentFromRecipe } from "../dist/archiveRelocationRecipe.js";
import { parseConfig } from "../dist/config.js";
import { toFsUri } from "../dist/filesystem.js";

const fixture = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/archive-relocation-inventory-recipe.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const watcherId = "20000000-0000-4000-8000-000000000002";

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function observation(text = "unchanged synthetic note") {
  return [
    {
      kind: "utf8",
      file: {
        rootAlias: "notes",
        relativePath: "note.txt",
        uri: toFsUri("notes", "note.txt"),
        sourceModifiedAt: 1_789_000_000_000,
        sha256: sha(text),
        byteLength: Buffer.byteLength(text),
        text,
      },
    },
  ];
}

function doctorResult() {
  return {
    version: 2,
    state: "degraded",
    checks: [
      { id: "config", state: "pass", code: "valid" },
      { id: "credential", state: "pass", code: "authorized" },
      { id: "deployment", state: "pass", code: "available" },
      { id: "heartbeat", state: "warn", code: "awaiting_heartbeat" },
      { id: "roots", state: "pass", code: "safe" },
      { id: "journal", state: "warn", code: "contended" },
    ],
    source: {
      enumeration: "complete",
      processing: "complete",
      recordCoverage: "not_established",
      counts: {
        items: {
          ready: 1,
          pending: 0,
          failed: 0,
          needsReview: 0,
          explicitGap: 0,
          unavailable: 0,
          ignoredForgotten: 0,
        },
        unresolvedEntries: { needsReview: 0, ignoredForgotten: 0 },
      },
      warnings: ["record_coverage_not_established"],
    },
    capabilities: { embeddings: "unverified", daemon: "unverified" },
  };
}

function reserve(operation, targets = []) {
  return {
    operation,
    receiptId: `${operation.replace(".", "-")}-receipt`,
    expiresAt: 1_789_000_060_000,
    reused: false,
    targets,
  };
}

function discoveryTarget() {
  return {
    workId: "work_1",
    sourceItemId: "source_item_1",
    observationEpoch: 1,
    processingEpoch: 1,
    leaseEpoch: 1,
    leaseToken: "a".repeat(64),
    leaseExpiresAt: 1_789_000_060_000,
    uri: toFsUri("notes", "note.txt"),
    contentHash: sha("unchanged synthetic note"),
    byteLength: Buffer.byteLength("unchanged synthetic note"),
  };
}

function jobTarget() {
  return {
    jobId: "job_1",
    workId: "work_1",
    sourceItemId: "source_item_1",
    observationEpoch: 1,
    processingEpoch: 1,
    state: "processing",
    leaseEpoch: 1,
    leaseToken: "b".repeat(64),
    leaseExpiresAt: 1_789_000_060_000,
  };
}

function setup(options = {}) {
  const recipe = structuredClone(fixture);
  const config = parseConfig(
    JSON.parse(recipe.body.localBindings.proposedConfigText),
  );
  const existingBindings = options.terminalCheckpoint
    ? [
        {
          rootAlias: "notes",
          relativePath: "note.txt",
          sourceExternalId: "source_external_1",
          sourceItemId: "source_item_1",
        },
      ]
    : [];
  let checkpoint = options.terminalCheckpoint
    ? {
        version: 1,
        phase: "terminal",
        outcome: "complete",
        credentialSessionActive: false,
        bindings: existingBindings,
        scanned: 1,
        published: 0,
      }
    : { version: 1, phase: "idle" };
  const journal = {
    directory: config.journalDir,
    watcherId,
    credentialStatus: "current",
    pending: undefined,
    get checkpoint() {
      return structuredClone(checkpoint);
    },
    archiveRelocationRebindStatus: async () => ({
      state: "proposed",
      stateSha256: "1".repeat(64),
      previousStateSha256: "2".repeat(64),
      proposedStateSha256: "1".repeat(64),
    }),
  };
  const verifiedAt = 1_789_000_000_500;
  const relocationState = {
    version: 1,
    phase: options.workflowPhase ?? "rebound",
    intent: relocationIntentFromRecipe(recipe),
    preMoveVerifiedAt: 1_789_000_000_000,
    preMoveVerifiedArtifacts: recipe.body.processing.artifacts,
    destinationId: recipe.body.wholeRoot.sourceId,
    newBoundary: {
      rootPath: recipe.body.wholeRoot.newRootPath,
      rootId: recipe.body.wholeRoot.sourceId,
    },
    movedAt: 1_789_000_000_250,
    verifiedAt,
    verifiedArtifacts: recipe.body.processing.artifacts,
  };
  if (options.wrongWorkflowIntent)
    relocationState.intent = {
      ...relocationState.intent,
      relocationId: "30000000-0000-4000-8000-000000000003",
    };
  const persistedRelocation = {
    relocationId: recipe.catalogRelocationId,
    oldBoundary: recipe.body.processing.oldBoundary,
    newBoundary: recipe.body.processing.newBoundary,
    artifacts: recipe.body.processing.artifacts,
    verifiedAt: options.mappingVerifiedAtMismatch ? verifiedAt + 1 : verifiedAt,
  };
  const session = {
    journal,
    store: { read: async () => structuredClone(relocationState) },
    catalog: {
      requireBoundaryRelocation: async () => ({
        catalogRevision: recipe.body.processing.catalogRevision + 1,
        relocation: structuredClone(persistedRelocation),
      }),
    },
  };
  const baseline = observation();
  const operations = [];
  let observationCall = 0;
  let resetInput;
  const underlying = {
    call: async (request) => {
      operations.push(request.operation);
      if (request.operation === "discovery.reserve") {
        return reserve(
          request.operation,
          options.nonemptyDiscovery ? [discoveryTarget()] : [],
        );
      }
      if (request.operation === "jobs.reserve") {
        return reserve(
          request.operation,
          options.nonemptyJobs ? [jobTarget()] : [],
        );
      }
      if (request.operation === "scan.appendPage") {
        return {
          operation: request.operation,
          scanId: "scan_1",
          ordinal: 0,
          reused: false,
          entries: [
            options.queuedAppend
              ? {
                  state: "queued",
                  sourceItemId: "source_item_1",
                  observationEpoch: 1,
                  processingEpoch: 1,
                }
              : {
                  state: "unchanged",
                  sourceItemId: "source_item_1",
                  observationEpoch: 1,
                  processingEpoch: 1,
                },
          ],
        };
      }
      if (request.operation === "diagnostics.heartbeat") {
        return {
          operation: request.operation,
          sourceAccountId: config.sourceAccountId,
          watcherId,
          receivedAt: 1_789_000_000_000,
          nextExpectedAt: 1_789_000_180_000,
        };
      }
      return { operation: request.operation };
    },
  };
  const catalog = {
    revision: 7,
    originals: [{ originalCatalogId: "synthetic-original" }],
    processings: [{ processingCatalogId: "synthetic-processing" }],
  };
  let catalogCall = 0;
  const adapters = {
    loadConfig: async () => config,
    observations: async () => {
      observationCall += 1;
      if (options.changeAfter && observationCall > 1)
        return observation("changed synthetic note");
      if (options.changeBefore) return observation("changed synthetic note");
      return structuredClone(baseline);
    },
    catalogSnapshot: async () => {
      catalogCall += 1;
      const current = structuredClone(catalog);
      if (options.changeCatalogAfter && catalogCall > 1) current.revision += 1;
      return { ...current, sha256: sha(JSON.stringify(current)) };
    },
    transport: () => underlying,
    doctor: async () => doctorResult(),
    run: async (_config, _session, transport) => {
      await transport.call({ operation: "source.status" });
      await transport.call({ operation: "scan.begin" });
      await transport.call({ operation: "scan.appendPage" });
      if (options.queuedAppend) {
        await transport.call({ operation: "scan.seal" });
      }
      await transport.call({ operation: "discovery.reserve" });
      if (options.nonemptyDiscovery) {
        await transport.call({ operation: "discovery.admitUtf8" });
      }
      await transport.call({ operation: "jobs.reserve" });
      if (options.nonemptyJobs) {
        await transport.call({ operation: "jobs.renew" });
      }
      await transport.call({ operation: "processing.assessBegin" });
      checkpoint = {
        version: 1,
        phase: "terminal",
        outcome: "complete",
        credentialSessionActive: false,
        bindings: existingBindings,
        scanned: baseline.length,
        published: 0,
      };
      return { state: "complete", scanned: baseline.length, published: 0 };
    },
    now: () => 1_789_000_001_000,
  };
  const ownerReset = async (input) => {
    resetInput = structuredClone(input);
    return {
      sourceAccountId: config.sourceAccountId,
      watcherId,
      reused: false,
      changedAt: 1_789_000_000_000,
      ...(options.malformedReset ? { extra: true } : {}),
    };
  };
  return {
    input: {
      recipe,
      session,
      credential: "synthetic-credential",
      filesystemBaseline: baseline,
      ownerReset,
    },
    adapters,
    operations,
    resetInput: () => resetInput,
  };
}

test("completes one unchanged held-session scan and accepts the rebound heartbeat", async () => {
  const f = setup();
  const proof = await __testOnlyVerifyArchiveRelocationOwnerResume(
    f.input,
    f.adapters,
  );
  assert.equal(proof.version, 1);
  assert.equal(proof.currentWatcherId, watcherId);
  assert.deepEqual(proof.scan, {
    state: "complete",
    scanned: 1,
    published: 0,
  });
  assert.equal(proof.filesystem.observationCount, 1);
  assert.equal(proof.doctor.checks[5].code, "contended");
  assert.deepEqual(f.resetInput(), {
    sourceAccountId: proof.sourceAccountId,
    requestId: fixture.watcherResetRequestId,
    expectedWatcherId: fixture.body.localBindings.previousWatcherId,
    nextWatcherId: watcherId,
  });
  assert.deepEqual(f.operations, [
    "source.status",
    "scan.begin",
    "scan.appendPage",
    "discovery.reserve",
    "jobs.reserve",
    "processing.assessBegin",
    "diagnostics.heartbeat",
  ]);
});

test("preserves a quiescent terminal checkpoint's source bindings", async () => {
  const f = setup({ terminalCheckpoint: true });
  await __testOnlyVerifyArchiveRelocationOwnerResume(f.input, f.adapters);
  assert.deepEqual(f.input.session.journal.checkpoint.bindings, [
    {
      rootAlias: "notes",
      relativePath: "note.txt",
      sourceExternalId: "source_external_1",
      sourceItemId: "source_item_1",
    },
  ]);
});

test("rejects a wrong workflow intent or catalog mapping before owner reset", async () => {
  for (const options of [
    { wrongWorkflowIntent: true },
    { workflowPhase: "verified" },
    { mappingVerifiedAtMismatch: true },
  ]) {
    const f = setup(options);
    await assert.rejects(
      () => __testOnlyVerifyArchiveRelocationOwnerResume(f.input, f.adapters),
      (error) =>
        error instanceof ArchiveRelocationOwnerResumeError &&
        error.code === "session_not_ready",
    );
    assert.equal(f.resetInput(), undefined);
    assert.deepEqual(f.operations, []);
  }
});

test("rejects a changed complete filesystem before owner reset", async () => {
  const f = setup({ changeBefore: true });
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationOwnerResume(f.input, f.adapters),
    (error) =>
      error instanceof ArchiveRelocationOwnerResumeError &&
      error.code === "baseline_changed",
  );
  assert.equal(f.resetInput(), undefined);
  assert.deepEqual(f.operations, []);
});

test("rejects filesystem change after scan before heartbeat", async () => {
  const f = setup({ changeAfter: true });
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationOwnerResume(f.input, f.adapters),
    (error) =>
      error instanceof ArchiveRelocationOwnerResumeError &&
      error.code === "baseline_changed",
  );
  assert.equal(f.operations.includes("diagnostics.heartbeat"), false);
});

test("rejects catalog mutation after scan before heartbeat", async () => {
  const f = setup({ changeCatalogAfter: true });
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationOwnerResume(f.input, f.adapters),
    (error) =>
      error instanceof ArchiveRelocationOwnerResumeError &&
      error.code === "baseline_changed",
  );
  assert.equal(f.operations.includes("diagnostics.heartbeat"), false);
});

test("nonempty reserve cannot reach admission or publication", async () => {
  const f = setup({ nonemptyDiscovery: true });
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationOwnerResume(f.input, f.adapters),
    (error) =>
      error instanceof ArchiveRelocationOwnerResumeError &&
      error.code === "unexpected_work",
  );
  assert.deepEqual(f.operations, [
    "source.status",
    "scan.begin",
    "scan.appendPage",
    "discovery.reserve",
  ]);
  assert.equal(
    f.operations.some((operation) => operation.startsWith("jobs.")),
    false,
  );
});

test("queued append is stopped before archive or publication work", async () => {
  const f = setup({ queuedAppend: true });
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationOwnerResume(f.input, f.adapters),
    (error) =>
      error instanceof ArchiveRelocationOwnerResumeError &&
      error.code === "unexpected_work",
  );
  assert.deepEqual(f.operations, [
    "source.status",
    "scan.begin",
    "scan.appendPage",
  ]);
});

test("nonempty job reserve cannot reach renewal or publication", async () => {
  const f = setup({ nonemptyJobs: true });
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationOwnerResume(f.input, f.adapters),
    (error) =>
      error instanceof ArchiveRelocationOwnerResumeError &&
      error.code === "unexpected_work",
  );
  assert.deepEqual(f.operations, [
    "source.status",
    "scan.begin",
    "scan.appendPage",
    "discovery.reserve",
    "jobs.reserve",
  ]);
});

test("rejects a non-closed owner reset result", async () => {
  const f = setup({ malformedReset: true });
  await assert.rejects(
    () => __testOnlyVerifyArchiveRelocationOwnerResume(f.input, f.adapters),
    (error) =>
      error instanceof ArchiveRelocationOwnerResumeError &&
      error.code === "watcher_reset_failed",
  );
  assert.deepEqual(f.operations, []);
});
