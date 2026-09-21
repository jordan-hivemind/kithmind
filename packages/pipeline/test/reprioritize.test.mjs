import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal } from "../dist/journal.js";
import { journalBindingForConfig } from "../dist/config.js";
import {
  archivedCheckpointIdentity,
  bindingsFromScan,
  findDiscoveryPlan,
  journalCodec,
} from "../dist/runner.js";
import { parseRunnerCheckpoint } from "../dist/runnerState.js";
import {
  parsePriorityManifest,
  reprioritizeFromPaths,
  reprioritizeJournal,
} from "../dist/reprioritize.js";

const TOKEN = "a".repeat(64);

function pdfPlan(name, hash, overrides = {}) {
  return {
    rootAlias: "fixture",
    relativePath: `${name}.pdf`,
    sourceModifiedAt: 1,
    kind: "pdf",
    sha256: hash.repeat(64),
    byteLength: 100,
    parserProfileId: "pdf_docqa_v1",
    parserFingerprint: "a".repeat(64),
    extractionConfigurationFingerprint: "b".repeat(64),
    extractorFingerprint: "extractor-v1",
    recordSchemaFingerprint: "records-disabled-v1",
    normalizationFingerprint: "normalization-v1",
    chunkerFingerprint: "c".repeat(64),
    correctionRevision: "correction-v1",
    externalId: randomUUID(),
    sourceItemId: `source-${name}`,
    observationEpoch: 1,
    processingEpoch: 1,
    discoveryState: "queued",
    ...overrides,
  };
}

function textPlan(name) {
  const bytes = Buffer.from(`synthetic ${name}`);
  return {
    rootAlias: "fixture",
    relativePath: `${name}.txt`,
    sourceModifiedAt: 1,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    externalId: randomUUID(),
  };
}

function checkpoint(files, pdfIndex = 1) {
  return parseRunnerCheckpoint({
    version: 1,
    phase: "archived",
    mode: "normal",
    scanId: "scan-1",
    inventoryEpoch: 1,
    manifestVersion: 1,
    missingBindings: [],
    files,
    pdfIndex,
    step: "lookup_original",
    reservationRound: 0,
    archivedPublished: 1,
    originalCatalogId: randomUUID(),
    expectedOriginalRevision: 2,
    processingCatalogId: randomUUID(),
    expectedProcessingRevision: 3,
    receiptChecked: true,
  });
}

function binding() {
  return {
    protocolVersion: 1,
    endpoint: "https://priority.invalid/api/worker",
    spaceId: "space",
    sourceAccountId: "source",
    configFingerprint: "d".repeat(64),
    credentialSlot: "PIPELINE_TOKEN",
  };
}

async function openFixture(initialCheckpoint) {
  const directory = await mkdtemp(join(tmpdir(), "kith-priority-"));
  await chmod(directory, 0o700);
  const authority = binding();
  const journal = await Journal.open({
    directory,
    binding: authority,
    credential: "test-credential",
    initialCheckpoint,
    codec: journalCodec,
  });
  return { directory, authority, journal };
}

function manifest(plans, reason = "active_goal") {
  return parsePriorityManifest({
    version: 1,
    reason,
    targets: plans.map((plan) => ({
      rootAlias: plan.rootAlias,
      relativePath: plan.relativePath,
      revisionHash: plan.sha256,
    })),
  });
}

test("priority manifests reject empty targets, extra fields, and unsupported reasons", () => {
  for (const value of [
    { version: 1, reason: "active_goal", targets: [] },
    { version: 1, reason: "tax", targets: [{}] },
    { version: 1, reason: "active_goal", targets: [], extra: true },
    {
      version: 1,
      reason: "active_goal",
      targets: [
        {
          rootAlias: "fixture",
          relativePath: "selected.pdf",
          revisionHash: "a".repeat(64),
          extra: true,
        },
      ],
    },
  ]) {
    assert.throws(
      () => parsePriorityManifest(value),
      (error) => error.message === "manifest_invalid",
    );
  }
});

async function cleanup(fixture) {
  await fixture.journal.close();
  await rm(fixture.directory, { recursive: true, force: true });
}

test("stable suffix priority preserves prefix, FIFO classes, restart state, and downstream lookups", async () => {
  const prefix = pdfPlan("prefix", "1");
  const current = pdfPlan("current", "2");
  const backgroundA = pdfPlan("background-a", "3");
  const selectedA = pdfPlan("selected-a", "4");
  const laterText = textPlan("later-text");
  const selectedB = pdfPlan("selected-b", "5");
  const backgroundB = pdfPlan("background-b", "6");
  const files = [
    prefix,
    current,
    backgroundA,
    selectedA,
    laterText,
    selectedB,
    backgroundB,
  ];
  const initial = checkpoint(files);
  const beforeBindings = bindingsFromScan(initial);
  const fixture = await openFixture(initial);
  const digest = "e".repeat(64);
  try {
    const result = await reprioritizeJournal({
      journal: fixture.journal,
      manifest: manifest([selectedB, selectedA]),
      manifestSha256: digest,
      settleAnsweredArchivedRequest: async () => {
        throw new Error("no pending request should be settled");
      },
    });
    assert.deepEqual(result, {
      state: "reprioritized",
      manifestSha256: digest,
      selectedCount: 2,
      remainingEntryCount: 3,
      prefixEntryCount: 1,
      totalEntryCount: 7,
    });
    const expected = [
      prefix,
      current,
      selectedA,
      selectedB,
      backgroundA,
      laterText,
      backgroundB,
    ];
    assert.deepEqual(fixture.journal.checkpoint.files, expected);
    assert.equal(fixture.journal.checkpoint.pdfIndex, 1);
    assert.equal(fixture.journal.checkpoint.step, "lookup_original");
    assert.equal(fixture.journal.checkpoint.expectedOriginalRevision, 2);
    assert.equal(fixture.journal.checkpoint.expectedProcessingRevision, 3);
    assert.equal(fixture.journal.checkpoint.receiptChecked, true);
    assert.deepEqual(
      bindingsFromScan(fixture.journal.checkpoint),
      beforeBindings,
    );
    const textUri = `fs://${laterText.rootAlias}/${laterText.relativePath}`;
    assert.deepEqual(
      findDiscoveryPlan(fixture.journal.checkpoint.files, textUri),
      laterText,
    );
    assert.deepEqual(fixture.journal.checkpoint.priorityReceipt, {
      version: 1,
      manifestSha256: digest,
      reason: "active_goal",
      selectedCount: 2,
      selectedIdentitySha256: createHash("sha256")
        .update(
          JSON.stringify(
            [selectedA, selectedB]
              .map((plan) => ({
                sourceItemId: plan.sourceItemId,
                sha256: plan.sha256,
              }))
              .sort((left, right) =>
                Buffer.compare(
                  Buffer.from(`${left.sourceItemId}\0${left.sha256}`),
                  Buffer.from(`${right.sourceItemId}\0${right.sha256}`),
                ),
              ),
          ),
        )
        .digest("hex"),
    });
    assert.equal(
      new Set(fixture.journal.checkpoint.files.map((plan) => plan.relativePath))
        .size,
      files.length,
    );
    await fixture.journal.close();
    fixture.journal = await Journal.open({
      directory: fixture.directory,
      binding: fixture.authority,
      credential: "test-credential",
      initialCheckpoint: { version: 1, phase: "idle" },
      codec: journalCodec,
    });
    assert.deepEqual(fixture.journal.checkpoint.files, expected);
    assert.equal(
      fixture.journal.checkpoint.priorityReceipt.reason,
      "active_goal",
    );
  } finally {
    await cleanup(fixture);
  }
});

async function plantLookup(journal, current) {
  const requestId = randomUUID();
  await journal.planRequest({
    operation: "discovery.lookupArchivedAdmission",
    requestId,
    requestBody: JSON.stringify({
      protocolVersion: 1,
      operation: "discovery.lookupArchivedAdmission",
      spaceId: "space",
      sourceAccountId: "source",
      requestId,
      identity: archivedCheckpointIdentity(current),
      lookup: { mode: "original" },
    }),
    createdAt: 1,
  });
}

test("an answered archived request settles once before the suffix transition", async () => {
  const current = pdfPlan("current", "a");
  const selected = pdfPlan("selected", "b");
  const background = pdfPlan("background", "c");
  const initial = checkpoint([current, selected, background], 0);
  const fixture = await openFixture(initial);
  try {
    await plantLookup(fixture.journal, initial);
    await fixture.journal.recordValidatedResult(
      {
        operation: "discovery.lookupArchivedAdmission",
        mode: "original",
        found: false,
      },
      2,
    );
    let settled = 0;
    await reprioritizeJournal({
      journal: fixture.journal,
      manifest: manifest([selected], "code_acceptance"),
      manifestSha256: "f".repeat(64),
      settleAnsweredArchivedRequest: async () => {
        settled += 1;
        await fixture.journal.commitResult({
          checkpoint: { ...fixture.journal.checkpoint, step: "capture" },
          credentialSessionActive: true,
        });
      },
    });
    assert.equal(settled, 1);
    assert.equal(fixture.journal.pending, undefined);
    assert.equal(fixture.journal.checkpoint.step, "capture");
    assert.deepEqual(fixture.journal.checkpoint.files, [
      current,
      selected,
      background,
    ]);
  } finally {
    await cleanup(fixture);
  }
});

test("stale, current, duplicate, unsafe-phase, and unanswered selections are refused unchanged", async () => {
  const current = pdfPlan("current", "a");
  const selected = pdfPlan("selected", "b");
  for (const invalidManifest of [
    manifest([{ ...selected, sha256: "c".repeat(64) }]),
    manifest([current]),
  ]) {
    const initial = checkpoint([current, selected], 0);
    const fixture = await openFixture(initial);
    try {
      await assert.rejects(
        () =>
          reprioritizeJournal({
            journal: fixture.journal,
            manifest: invalidManifest,
            manifestSha256: "d".repeat(64),
            settleAnsweredArchivedRequest: async () => {},
          }),
        (error) => error.message === "target_missing_or_stale",
      );
      assert.deepEqual(fixture.journal.checkpoint, initial);
    } finally {
      await cleanup(fixture);
    }
  }
  assert.throws(
    () =>
      parsePriorityManifest({
        version: 1,
        reason: "active_goal",
        targets: [
          {
            rootAlias: selected.rootAlias,
            relativePath: selected.relativePath,
            revisionHash: selected.sha256,
          },
          {
            rootAlias: selected.rootAlias,
            relativePath: selected.relativePath,
            revisionHash: selected.sha256,
          },
        ],
      }),
    (error) => error.message === "manifest_invalid",
  );

  const terminal = parseRunnerCheckpoint({
    version: 1,
    phase: "terminal",
    outcome: "failed",
    credentialSessionActive: false,
    bindings: [],
    scanned: 2,
    published: 0,
    code: "synthetic_failure",
  });
  const terminalFixture = await openFixture(terminal);
  try {
    await assert.rejects(
      () =>
        reprioritizeJournal({
          journal: terminalFixture.journal,
          manifest: manifest([selected]),
          manifestSha256: "d".repeat(64),
          settleAnsweredArchivedRequest: async () => {},
        }),
      (error) => error.message === "phase_unsafe",
    );
    assert.deepEqual(terminalFixture.journal.checkpoint, terminal);
  } finally {
    await cleanup(terminalFixture);
  }

  const pendingInitial = checkpoint([current, selected], 0);
  const pendingFixture = await openFixture(pendingInitial);
  try {
    await plantLookup(pendingFixture.journal, pendingInitial);
    await assert.rejects(
      () =>
        reprioritizeJournal({
          journal: pendingFixture.journal,
          manifest: manifest([selected]),
          manifestSha256: "d".repeat(64),
          settleAnsweredArchivedRequest: async () => {},
        }),
      (error) => error.message === "pending_unsafe",
    );
    assert.equal(pendingFixture.journal.pending.result, undefined);
    assert.deepEqual(pendingFixture.journal.checkpoint, pendingInitial);
  } finally {
    await cleanup(pendingFixture);
  }
});

test("a settled terminal failure remains terminal and is never reordered", async () => {
  const current = pdfPlan("current", "a");
  const selected = pdfPlan("selected", "b");
  const initial = checkpoint([current, selected], 0);
  const fixture = await openFixture(initial);
  try {
    await plantLookup(fixture.journal, initial);
    await fixture.journal.recordValidatedResult(
      {
        operation: "discovery.lookupArchivedAdmission",
        mode: "original",
        found: false,
      },
      2,
    );
    await assert.rejects(
      () =>
        reprioritizeJournal({
          journal: fixture.journal,
          manifest: manifest([selected]),
          manifestSha256: "d".repeat(64),
          settleAnsweredArchivedRequest: async () => {
            await fixture.journal.commitResult({
              checkpoint: {
                version: 1,
                phase: "terminal",
                outcome: "failed",
                credentialSessionActive: true,
                bindings: bindingsFromScan(initial),
                scanned: initial.files.length,
                published: initial.archivedPublished,
                code: "synthetic_failure",
                scanId: initial.scanId,
              },
              credentialSessionActive: true,
            });
          },
        }),
      (error) => error.message === "phase_unsafe",
    );
    assert.equal(fixture.journal.pending, undefined);
    assert.equal(fixture.journal.checkpoint.phase, "terminal");
    assert.equal(fixture.journal.checkpoint.code, "synthetic_failure");
  } finally {
    await cleanup(fixture);
  }
});

test("the command refuses journal lock contention without changing the active checkpoint", async () => {
  const current = pdfPlan("current", "a");
  const selected = pdfPlan("selected", "b");
  const initial = checkpoint([current, selected], 0);
  const base = await mkdtemp(join(tmpdir(), "kith-priority-command-"));
  const root = join(base, "root");
  const journalDir = join(base, "journal");
  const configPath = join(base, "config.json");
  const manifestPath = join(base, "priority.json");
  await mkdir(root, { mode: 0o700 });
  await mkdir(journalDir, { mode: 0o700 });
  const config = {
    protocolVersion: 1,
    endpoint: "https://priority-command.invalid/api/worker",
    spaceId: "space",
    sourceAccountId: "source",
    credentialEnv: "PRIORITY_TEST_TOKEN",
    roots: [{ alias: "fixture", path: root }],
    journalDir,
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
  };
  const manifestBytes = JSON.stringify({
    version: 1,
    reason: "active_goal",
    targets: [
      {
        rootAlias: selected.rootAlias,
        relativePath: selected.relativePath,
        revisionHash: selected.sha256,
      },
    ],
  });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const journal = await Journal.open({
    directory: journalDir,
    binding: journalBindingForConfig(config),
    credential: "test-credential",
    initialCheckpoint: initial,
    codec: journalCodec,
  });
  process.env.PRIORITY_TEST_TOKEN = "test-credential";
  try {
    assert.deepEqual(await reprioritizeFromPaths(configPath, manifestPath), {
      state: "refused",
      code: "journal_contended",
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    });
    assert.deepEqual(journal.checkpoint, initial);
  } finally {
    delete process.env.PRIORITY_TEST_TOKEN;
    await journal.close();
    await rm(base, { recursive: true, force: true });
  }
});
