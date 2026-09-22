import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal } from "../dist/journal.js";
import {
  adoptMetadataFirstJournal,
  metadataFirstIdentity,
} from "../dist/metadataFirst.js";
import { PipelineRunner, journalCodec } from "../dist/runner.js";
import { parseRunnerCheckpoint } from "../dist/runnerState.js";
import { parsePriorityManifest } from "../dist/reprioritize.js";
import {
  automaticPreviewRoute,
  previewDeclaration,
} from "../dist/previewMetadata.js";

function plan(name, seed) {
  return {
    rootAlias: "fixture",
    relativePath: `${name}.pdf`,
    sourceModifiedAt: 1,
    kind: "pdf",
    sha256: seed.repeat(64),
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
    observationEpoch: 2,
    processingEpoch: 3,
    discoveryState: "queued",
  };
}

function checkpoint(files, pdfIndex, overrides = {}) {
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
    step: "preview",
    reservationRound: 0,
    archivedPublished: 4,
    metadataFirst: {
      version: 1,
      triageStartIndex: pdfIndex,
      refreshReady: false,
      selected: [],
      previewed: [],
      selectionReceipts: [],
    },
    ...overrides,
  });
}

function binding() {
  return {
    protocolVersion: 1,
    endpoint: "https://metadata-first.invalid/api/worker",
    spaceId: "space",
    sourceAccountId: "source",
    configFingerprint: "d".repeat(64),
    credentialSlot: "TOKEN",
  };
}

async function fixture(initial) {
  const directory = await mkdtemp(join(tmpdir(), "kith-metadata-first-"));
  await chmod(directory, 0o700);
  const journal = await Journal.open({
    directory,
    binding: binding(),
    credential: "credential",
    initialCheckpoint: initial,
    codec: journalCodec,
  });
  return { directory, journal };
}

function manifest(items, reason = "active_goal") {
  return parsePriorityManifest({
    version: 1,
    reason,
    targets: items.map((item) => ({
      rootAlias: item.rootAlias,
      relativePath: item.relativePath,
      revisionHash: item.sha256,
    })),
  });
}

function previewFor(item, text = "Synthetic unknown document") {
  return {
    sourceSha256: item.sha256,
    mediaType: "application/pdf",
    sourceUnitCount: 90,
    inspectedOriginalUnits: [1],
    unitStates: ["text_available"],
    unitTexts: [text],
    unitTextTruncated: [false],
    method: "pdf_native_text_v1",
    methodFingerprint: "e".repeat(64),
  };
}

function declaration(text) {
  return previewDeclaration(previewFor(plan("matrix", "8"), text));
}

test("automatic routing requires strong tax and bulk-history evidence", () => {
  for (const text of [
    "Form 1040 U.S. Individual Income Tax Return",
    "Schedule K-1 Partner's Share of Income",
  ]) {
    const preview = declaration(text);
    assert.equal(preview.provisionalMetadata.documentKind, "tax_return");
    assert.equal(automaticPreviewRoute(preview), "deep_priority");
  }
  assert.equal(
    automaticPreviewRoute(declaration("Please see Form 1040 in the appendix")),
    "defer",
  );
  const history = declaration(
    "Morgan Stanley report of all trades for the period",
  );
  assert.equal(history.provisionalMetadata.title, "Brokerage trade history");
  assert.equal(automaticPreviewRoute(history), "metadata_only");
  const confirmation = declaration("Morgan Stanley trade confirmation");
  assert.equal(confirmation.provisionalMetadata.title, "Trade confirmation");
  assert.equal(automaticPreviewRoute(confirmation), "metadata_only");
  for (const text of [
    "Morgan Stanley portfolio statement and holdings all-trades report",
    "Morgan Stanley annual 1099 tax reporting statement all-trades report",
  ]) {
    const preview = declaration(text);
    assert.notEqual(
      preview.provisionalMetadata.title,
      "Brokerage trade history",
    );
    assert.notEqual(automaticPreviewRoute(preview), "deep_priority");
  }
});

function transport(requests) {
  return {
    async call(request) {
      requests.push(structuredClone(request));
      return {
        operation: "discovery.recordPreview",
        previewId: randomUUID(),
        sourceItemId: request.identity.sourceItemId,
        observedContentHash: request.identity.contentHash,
        previewFingerprint: request.preview.previewFingerprint,
        state: "provisional",
        reused: false,
      };
    },
  };
}

function runner(config, journal, worker, executePreview) {
  return new PipelineRunner(
    config,
    journal,
    worker,
    undefined,
    undefined,
    undefined,
    executePreview,
  );
}

test("adoption preserves the completed prefix/current and selects active suffix FIFO", async () => {
  const prefix = plan("prefix", "1");
  const current = plan("current", "2");
  const background = plan("background", "3");
  const selectedA = plan("selected-a", "4");
  const selectedB = plan("selected-b", "5");
  const initial = parseRunnerCheckpoint({
    ...checkpoint([prefix, current, background, selectedA, selectedB], 1),
    step: "lookup_original",
    metadataFirst: undefined,
    originalCatalogId: randomUUID(),
    expectedOriginalRevision: 1,
    processingCatalogId: randomUUID(),
    expectedProcessingRevision: 1,
  });
  const refused = await fixture(initial);
  try {
    await assert.rejects(
      () =>
        adoptMetadataFirstJournal({
          journal: refused.journal,
          manifest: manifest([current]),
          manifestSha256: "e".repeat(64),
          settleAnsweredArchivedRequest: async () => {},
        }),
      /target_missing_or_stale/,
    );
    assert.deepEqual(refused.journal.checkpoint, initial);
  } finally {
    await refused.journal.close();
    await rm(refused.directory, { recursive: true, force: true });
  }
  const state = await fixture(initial);
  try {
    const result = await adoptMetadataFirstJournal({
      journal: state.journal,
      manifest: manifest([selectedB, selectedA]),
      manifestSha256: "f".repeat(64),
      settleAnsweredArchivedRequest: async () => assert.fail("no pending"),
    });
    assert.equal(result.state, "adopted");
    assert.equal(state.journal.checkpoint.pdfIndex, 1);
    assert.equal(state.journal.checkpoint.step, "lookup_original");
    assert.deepEqual(state.journal.checkpoint.files, initial.files);
    assert.deepEqual(state.journal.checkpoint.metadataFirst.selected, [
      metadataFirstIdentity(selectedA),
      metadataFirstIdentity(selectedB),
    ]);
    assert.equal(state.journal.checkpoint.metadataFirst.triageStartIndex, 2);
    await assert.rejects(
      () =>
        adoptMetadataFirstJournal({
          journal: state.journal,
          manifest: manifest([current]),
          manifestSha256: "e".repeat(64),
          settleAnsweredArchivedRequest: async () => {},
        }),
      /phase_unsafe/,
    );
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("an empty new scan can bootstrap selected work before background preview", async () => {
  const first = plan("first", "1");
  const background = plan("background", "2");
  const selected = plan("selected", "3");
  const state = await fixture(checkpoint([first, background, selected], 0));
  try {
    const result = await adoptMetadataFirstJournal({
      journal: state.journal,
      manifest: manifest([selected], "code_acceptance"),
      manifestSha256: "d".repeat(64),
      settleAnsweredArchivedRequest: async () => assert.fail("no pending"),
    });
    assert.equal(result.state, "selected");
    assert.equal(state.journal.checkpoint.pdfIndex, 2);
    assert.equal(state.journal.checkpoint.step, "preview");
    assert.equal(state.journal.checkpoint.metadataFirst.triageStartIndex, 0);
    assert.deepEqual(state.journal.checkpoint.metadataFirst.previewed, []);
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("selected preview enters deep intent while FIFO routing precedes background triage", async () => {
  const background = plan("background", "1");
  const selectedA = plan("selected-a", "2");
  const selectedB = plan("selected-b", "3");
  const routing = {
    version: 1,
    triageStartIndex: 0,
    refreshReady: false,
    selected: [
      metadataFirstIdentity(selectedA),
      metadataFirstIdentity(selectedB),
    ],
    previewed: [],
    selectionReceipts: [
      {
        selectorSha256: "f".repeat(64),
        reason: "active_goal",
        selectedCount: 2,
        selectedIdentitySha256: "e".repeat(64),
      },
    ],
  };
  const state = await fixture(
    checkpoint([background, selectedA, selectedB], 1, {
      metadataFirst: routing,
    }),
  );
  const requests = [];
  let windows;
  const worker = runner(
    { spaceId: "space", sourceAccountId: "source" },
    state.journal,
    transport(requests),
    async (item, selectedWindows) => {
      windows = selectedWindows;
      return previewFor(item, "Form 1040 U.S. Individual Income Tax Return");
    },
  );
  try {
    await worker.driveArchived();
    assert.deepEqual(windows, [{ startPage: 1, pageCount: 1 }]);
    assert.equal(state.journal.checkpoint.step, "intent");
    assert.equal(state.journal.checkpoint.pdfIndex, 1);
    assert.equal(JSON.stringify(requests).includes("Form 1040"), false);

    worker.pdfNeedsArchivedWork = async (item) =>
      item.relativePath === selectedA.relativePath ||
      item.relativePath === selectedB.relativePath;
    let next = await worker.afterArchivedItem(
      { ...state.journal.checkpoint, step: "preview" },
      1,
    );
    assert.equal(next.pdfIndex, 1);
    assert.equal(next.step, "intent");
    worker.pdfNeedsArchivedWork = async (item) =>
      item.relativePath === selectedB.relativePath;
    next = await worker.afterArchivedItem(next, 0);
    assert.equal(next.pdfIndex, 2);
    assert.equal(next.step, "preview");
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("a positive tax heading durably auto-selects its exact revision", async () => {
  const item = plan("automatic-tax", "6");
  const state = await fixture(checkpoint([item], 0));
  const requests = [];
  const worker = runner(
    { spaceId: "space", sourceAccountId: "source" },
    state.journal,
    transport(requests),
    async () => previewFor(item, "Schedule K-1 Partner's Share of Income"),
  );
  try {
    await worker.driveArchived();
    assert.equal(state.journal.checkpoint.step, "intent");
    assert.deepEqual(state.journal.checkpoint.metadataFirst.selected, [
      metadataFirstIdentity(item),
    ]);
    assert.equal(
      state.journal.checkpoint.metadataFirst.selectionReceipts[0].reason,
      "automatic_policy",
    );
    assert.equal(
      state.journal.checkpoint.metadataFirst.selectionReceipts[0].selectedCount,
      1,
    );
    assert.equal(JSON.stringify(requests).includes("Schedule K-1"), false);
    assert.equal(JSON.stringify(requests).includes("relativePath"), false);
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("answered preview replay does not rerun the executor and ends metadata_only_deferred", async () => {
  const item = plan("deferred", "7");
  const initial = checkpoint([item], 0);
  const state = await fixture(initial);
  const requests = [];
  const first = runner(
    { spaceId: "space", sourceAccountId: "source" },
    state.journal,
    transport(requests),
    async () => previewFor(item),
  );
  const commit = state.journal.commitResult.bind(state.journal);
  state.journal.commitResult = async () => {
    throw new Error("synthetic interrupted commit");
  };
  try {
    await assert.rejects(
      () => first.driveArchived(),
      /synthetic interrupted commit/,
    );
    assert.ok(state.journal.pending?.result);
    assert.equal(requests.length, 1);
    state.journal.commitResult = commit;
    await state.journal.close();
    state.journal = await Journal.open({
      directory: state.directory,
      binding: binding(),
      credential: "credential",
      initialCheckpoint: { version: 1, phase: "idle" },
      codec: journalCodec,
    });
    const resumed = runner(
      { spaceId: "space", sourceAccountId: "source" },
      state.journal,
      {
        async call() {
          assert.fail("cached answer must not call transport");
        },
      },
      async () => assert.fail("cached answer must not rerun preview"),
    );
    await resumed.driveArchived();
    assert.equal(state.journal.pending, undefined);
    assert.equal(state.journal.checkpoint.step, "deferred_idle");
    assert.deepEqual(await resumed.driveCheckpoint(), {
      state: "incomplete",
      code: "metadata_only_deferred",
      scanned: 1,
      published: 4,
    });
  } finally {
    await state.journal.close().catch(() => undefined);
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("later selection promotes only an exact already-previewed identity", async () => {
  const first = plan("first", "1");
  const deferred = plan("deferred", "2");
  const routing = {
    version: 1,
    triageStartIndex: 0,
    refreshReady: false,
    selected: [],
    previewed: [metadataFirstIdentity(first), metadataFirstIdentity(deferred)],
    selectionReceipts: [],
  };
  const state = await fixture(
    checkpoint([first, deferred], 1, {
      step: "deferred_idle",
      metadataFirst: routing,
    }),
  );
  try {
    const result = await adoptMetadataFirstJournal({
      journal: state.journal,
      manifest: manifest([deferred], "explicit_user_request"),
      manifestSha256: "9".repeat(64),
      settleAnsweredArchivedRequest: async () => assert.fail("no pending"),
    });
    assert.equal(result.state, "selected");
    assert.equal(state.journal.checkpoint.step, "intent");
    assert.equal(state.journal.checkpoint.pdfIndex, 1);
    assert.deepEqual(
      state.journal.checkpoint.metadataFirst.previewed,
      routing.previewed,
    );
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("refresh reuses unchanged previews, previews changed/new identities, and promotes only selected", async () => {
  const unchanged = plan("unchanged", "1");
  const oldChanged = plan("changed", "2");
  const changed = {
    ...oldChanged,
    sha256: "3".repeat(64),
    observationEpoch: 4,
    processingEpoch: 5,
  };
  const added = plan("new", "4");
  const carry = {
    version: 1,
    triageStartIndex: 0,
    refreshReady: true,
    selected: [],
    previewed: [
      metadataFirstIdentity(unchanged),
      metadataFirstIdentity(oldChanged),
    ],
    selectionReceipts: [],
  };
  const initial = parseRunnerCheckpoint({
    version: 1,
    phase: "reconcile",
    mode: "normal",
    scanId: "scan-refresh",
    inventoryEpoch: 2,
    manifestVersion: 2,
    missingBindings: [],
    files: [unchanged, changed, added],
    ordinal: 0,
    reviewSeen: false,
    metadataFirstCarry: carry,
  });
  const state = await fixture(initial);
  const requests = [];
  const worker = runner(
    { spaceId: "space", sourceAccountId: "source" },
    state.journal,
    {
      async call(request) {
        if (request.operation === "scan.reconcile") {
          return {
            operation: "scan.reconcile",
            scanId: "scan-refresh",
            state: "enumerated",
            inspected: 3,
            unavailable: 0,
            done: true,
            reused: false,
          };
        }
        return await transport(requests).call(request);
      },
    },
    async (item) => previewFor(item),
  );
  worker.pdfNeedsArchivedWork = async () => true;
  try {
    await worker.driveReconcile();
    assert.equal(state.journal.checkpoint.step, "preview");
    assert.equal(state.journal.checkpoint.pdfIndex, 1);
    assert.deepEqual(state.journal.checkpoint.metadataFirst.previewed, [
      metadataFirstIdentity(unchanged),
    ]);
    await worker.driveArchived();
    assert.equal(state.journal.checkpoint.pdfIndex, 2);
    await worker.driveArchived();
    assert.equal(state.journal.checkpoint.step, "deferred_idle");
    assert.deepEqual(
      requests.map((request) => request.identity.sourceItemId),
      [changed.sourceItemId, added.sourceItemId],
    );
    assert.equal(
      state.journal.checkpoint.metadataFirst.previewed.some(
        (identity) => identity.sha256 === oldChanged.sha256,
      ),
      false,
    );
    const result = await adoptMetadataFirstJournal({
      journal: state.journal,
      manifest: manifest([unchanged], "explicit_user_request"),
      manifestSha256: "8".repeat(64),
      settleAnsweredArchivedRequest: async () => assert.fail("no pending"),
    });
    assert.equal(result.state, "selected");
    assert.equal(state.journal.checkpoint.step, "intent");
    assert.equal(state.journal.checkpoint.pdfIndex, 0);
    assert.deepEqual(state.journal.checkpoint.metadataFirst.selected, [
      metadataFirstIdentity(unchanged),
    ]);
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});
