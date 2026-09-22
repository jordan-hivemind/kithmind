import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal } from "../dist/journal.js";
import {
  adoptMetadataFirstJournal,
  metadataFirstIdentity,
} from "../dist/metadataFirst.js";
import { PipelineRunner, journalCodec } from "../dist/runner.js";
import { ParserProcessError } from "../dist/parserProcess.js";
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

test("adoption accepts an empty selection without weakening reprioritize manifests", async () => {
  const current = plan("empty-current", "1");
  const future = plan("empty-future", "2");
  const initial = parseRunnerCheckpoint({
    ...checkpoint([current, future], 0),
    step: "intent",
    metadataFirst: undefined,
  });
  assert.throws(
    () =>
      parsePriorityManifest({
        version: 1,
        reason: "active_goal",
        targets: [],
      }),
    /manifest_invalid/,
  );
  const empty = parsePriorityManifest(
    { version: 1, reason: "active_goal", targets: [] },
    { allowEmptyTargets: true },
  );
  const state = await fixture(initial);
  try {
    const result = await adoptMetadataFirstJournal({
      journal: state.journal,
      manifest: empty,
      manifestSha256: "a".repeat(64),
      settleAnsweredArchivedRequest: async () => assert.fail("no pending"),
    });
    assert.deepEqual(result, {
      state: "adopted",
      manifestSha256: "a".repeat(64),
      selectedCount: 0,
      previewedCount: 0,
      deferredCount: 0,
    });
    assert.equal(state.journal.checkpoint.pdfIndex, 0);
    assert.equal(state.journal.checkpoint.step, "intent");
    assert.equal(state.journal.checkpoint.metadataFirst.triageStartIndex, 1);
    assert.deepEqual(state.journal.checkpoint.metadataFirst.selected, []);
    assert.deepEqual(
      state.journal.checkpoint.metadataFirst.selectionReceipts,
      [],
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

test("adoption settles one answered archived request before preserving the new current", async () => {
  const current = plan("pending-current", "1");
  const selected = plan("pending-selected", "2");
  const initial = parseRunnerCheckpoint({
    ...checkpoint([current, selected], 0),
    step: "lookup_original",
    metadataFirst: undefined,
    originalCatalogId: randomUUID(),
    expectedOriginalRevision: 1,
    processingCatalogId: randomUUID(),
    expectedProcessingRevision: 1,
  });
  const state = await fixture(initial);
  const requestId = randomUUID();
  try {
    await state.journal.planRequest({
      operation: "discovery.lookupArchivedAdmission",
      requestId,
      requestBody: JSON.stringify({
        protocolVersion: 1,
        operation: "discovery.lookupArchivedAdmission",
        spaceId: "space",
        sourceAccountId: "source",
        requestId,
      }),
      createdAt: 1,
    });
    await state.journal.recordValidatedResult(
      {
        operation: "discovery.lookupArchivedAdmission",
        mode: "original",
        found: false,
      },
      2,
    );
    let settlements = 0;
    const result = await adoptMetadataFirstJournal({
      journal: state.journal,
      manifest: manifest([selected]),
      manifestSha256: "7".repeat(64),
      settleAnsweredArchivedRequest: async () => {
        settlements += 1;
        await state.journal.commitResult({
          checkpoint: { ...initial, step: "capture" },
          credentialSessionActive: true,
        });
      },
    });
    assert.equal(result.state, "adopted");
    assert.equal(settlements, 1);
    assert.equal(state.journal.pending, undefined);
    assert.equal(state.journal.checkpoint.pdfIndex, 0);
    assert.equal(state.journal.checkpoint.step, "capture");
    assert.deepEqual(state.journal.checkpoint.metadataFirst.selected, [
      metadataFirstIdentity(selected),
    ]);
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
    assert.deepEqual(windows, [{ startPage: 1, pageCount: 2 }]);
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

test("a queued selected PDF is consumed after publication and cleanup across restart", async () => {
  const selected = plan("selected-queued", "2");
  const deferred = plan("deferred-after-selected", "3");
  const routing = {
    version: 1,
    triageStartIndex: 0,
    refreshReady: false,
    selected: [metadataFirstIdentity(selected)],
    previewed: [],
    selectionReceipts: [],
  };
  const state = await fixture(
    checkpoint([selected, deferred], 0, { metadataFirst: routing }),
  );
  const captureDirectory = join(state.directory, "captures");
  const parserOutputRoot = join(state.directory, "outputs");
  const spoolDirectory = join(state.directory, "spool");
  await Promise.all(
    [captureDirectory, parserOutputRoot, spoolDirectory].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );
  const config = {
    spaceId: "space",
    sourceAccountId: "source",
    pdfDocQa: { captureDirectory, parserOutputRoot, spoolDirectory },
  };
  const requests = [];
  const call = async (request) => {
    requests.push(structuredClone(request));
    if (request.operation === "discovery.recordPreview") {
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
    assert.equal(request.operation, "jobs.activateParsed");
    return {
      operation: "jobs.activateParsed",
      jobId: request.jobId,
      state: "ready",
      activatedAt: 10,
      reused: false,
    };
  };
  let original;
  let processing;
  const catalog = {
    findOriginalExact(probe) {
      return probe.sourceExternalId === selected.externalId &&
        probe.sha256 === selected.sha256 &&
        probe.byteLength === selected.byteLength
        ? original
        : undefined;
    },
    listOriginals() {
      return original ? [original] : [];
    },
    listProcessings() {
      return processing ? [processing] : [];
    },
    async recordActivation(args) {
      assert.equal(args.catalogId, processing.processingCatalogId);
      assert.equal(args.expectedRevision, processing.rowRevision);
      processing = {
        ...processing,
        rowRevision: processing.rowRevision + 1,
        activation: args.activation,
      };
      return processing;
    },
  };
  const configure = (journal) => {
    const worker = runner(
      config,
      journal,
      { call },
      async (item) => previewFor(item),
    );
    worker.archiveCatalog = catalog;
    return worker;
  };
  let worker = configure(state.journal);
  try {
    // The selected item is a real queued discovery result. Preview promotes it
    // into the existing full archived lane before publication.
    await worker.driveArchived();
    assert.equal(state.journal.checkpoint.step, "intent");
    assert.equal(state.journal.checkpoint.pdfIndex, 0);
    assert.equal(await worker.pdfNeedsArchivedWork(selected), true);

    const originalCatalogId = randomUUID();
    const processingCatalogId = randomUUID();
    const jobId = "job-selected-queued";
    const generationId = "generation-selected-queued";
    const captureId = randomUUID();
    original = {
      originalCatalogId,
      rowRevision: 1,
      origin: {
        sha256: selected.sha256,
        byteLength: selected.byteLength,
      },
    };
    processing = {
      processingCatalogId,
      originalCatalogId,
      rowRevision: 1,
      currentObservation: {
        scanId: "scan-1",
        observationEpoch: selected.observationEpoch,
        processingEpoch: selected.processingEpoch,
      },
      fingerprints: worker.processingFingerprints(selected),
      captureIntent: { captureId },
      capture: {},
      parserIntent: { outputId: randomUUID() },
      parserOutput: {},
      spool: { opaqueName: `${randomUUID()}.json` },
      cloud: {
        sourceItemId: selected.sourceItemId,
        ingestJobId: jobId,
        processingGenerationId: generationId,
      },
    };
    await state.journal.transitionCheckpoint({
      checkpoint: parseRunnerCheckpoint({
        ...state.journal.checkpoint,
        step: "parsed_activate",
        originalCatalogId,
        expectedOriginalRevision: 1,
        processingCatalogId,
        expectedProcessingRevision: 1,
        jobLease: {
          jobId,
          workId: "work-selected-queued",
          sourceItemId: selected.sourceItemId,
          observationEpoch: selected.observationEpoch,
          processingEpoch: selected.processingEpoch,
          state: "staged",
          leaseEpoch: 1,
          leaseToken: "a".repeat(64),
          leaseExpiresAt: Date.now() + 60_000,
        },
        stageId: "stage-selected-queued",
        stagePhase: "staged",
        stageOrdinal: 0,
      }),
      credentialSessionActive: true,
    });
    await worker.driveParsedActivate();
    assert.equal(state.journal.checkpoint.step, "cleanup");
    assert.equal(processing.activation.state, "ready");
    await writeFile(join(captureDirectory, `${captureId}.pdf`), "synthetic");
    assert.equal(
      await worker.pdfNeedsArchivedWork(selected),
      true,
      "an activated queued item with retained artifacts must resume cleanup",
    );
    await rm(join(captureDirectory, `${captureId}.pdf`));

    // This is the scheduler boundary reached after exact local cleanup. The
    // local artifact paths intentionally do not exist, which is the durable
    // evidence that cleanup completed. A static `queued` discovery state must
    // not send this activated identity through publication again.
    await state.journal.transitionCheckpoint({
      checkpoint: await worker.afterArchivedItem(
        state.journal.checkpoint,
        1,
      ),
      credentialSessionActive: true,
    });
    assert.equal(state.journal.checkpoint.pdfIndex, 1);
    assert.equal(state.journal.checkpoint.step, "preview");
    assert.equal(state.journal.checkpoint.archivedPublished, 5);
    assert.equal(
      requests.filter((request) => request.operation === "jobs.activateParsed")
        .length,
      1,
    );

    // Restart from the next-item checkpoint. The selected identity remains
    // queued in the immutable scan plan, but exact catalog activation plus
    // absent cleanup artifacts keeps it consumed.
    await state.journal.close();
    state.journal = await Journal.open({
      directory: state.directory,
      binding: binding(),
      credential: "credential",
      initialCheckpoint: { version: 1, phase: "idle" },
      codec: journalCodec,
    });
    worker = configure(state.journal);
    await worker.driveArchived();
    assert.equal(state.journal.checkpoint.phase, "discovery_reserve");
    assert.equal(state.journal.checkpoint.archivedPublished, 5);
    assert.equal(
      requests.filter((request) => request.operation === "jobs.activateParsed")
        .length,
      1,
    );
    assert.deepEqual(
      requests
        .filter((request) => request.operation === "discovery.recordPreview")
        .map((request) => request.identity.sourceItemId),
      [selected.sourceItemId, deferred.sourceItemId],
    );
  } finally {
    await state.journal.close().catch(() => undefined);
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

test("the bounded opening window recognizes a return behind a cover page", async () => {
  const item = plan("covered-return", "5");
  const state = await fixture(checkpoint([item], 0));
  let windows;
  const worker = runner(
    { spaceId: "space", sourceAccountId: "source" },
    state.journal,
    transport([]),
    async (_item, selectedWindows) => {
      windows = selectedWindows;
      return {
        ...previewFor(item),
        inspectedOriginalUnits: [1, 2],
        unitStates: ["text_available", "text_available"],
        unitTexts: [
          "Synthetic cover letter",
          "Form 1040 U.S. Individual Income Tax Return",
        ],
        unitTextTruncated: [false, false],
      };
    },
  );
  try {
    await worker.driveArchived();
    assert.deepEqual(windows, [{ startPage: 1, pageCount: 2 }]);
    assert.equal(state.journal.checkpoint.step, "intent");
    assert.equal(
      state.journal.checkpoint.metadataFirst.selectionReceipts[0].reason,
      "automatic_policy",
    );
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("a document-specific preview refusal is surfaced and the next item advances", async () => {
  const invalid = {
    ...plan("invalid-workbook", "4"),
    parserProfileId: "spreadsheet_v1",
  };
  const valid = plan("valid-after-gap", "5");
  const state = await fixture(checkpoint([invalid, valid], 0));
  const requests = [];
  const worker = runner(
    { spaceId: "space", sourceAccountId: "source" },
    state.journal,
    transport(requests),
    async (item) => {
      if (item.sourceItemId === invalid.sourceItemId) {
        throw new ParserProcessError("workbook_invalid", "synthetic refusal");
      }
      return previewFor(item);
    },
  );
  worker.preparePdfProfile = async () => {};
  worker.sourceStatus = async () => ({ sourceAccountId: "source" });
  worker.driveDiscoveryReserve = async () => {
    const current = state.journal.checkpoint;
    assert.equal(current.phase, "discovery_reserve");
    await state.journal.transitionCheckpoint({
      checkpoint: checkpoint([invalid, valid], 0, {
        step: "deferred_idle",
        archivedPublished: current.archivedPublished,
        metadataFirst: current.metadataFirstCarry,
      }),
      credentialSessionActive: true,
    });
  };
  try {
    const result = await worker.runPass();
    assert.deepEqual(result, {
      state: "incomplete",
      code: "metadata_only_deferred",
      scanned: 2,
      published: 4,
      previewGaps: 1,
      previewGapCodes: ["workbook_invalid"],
    });
    assert.deepEqual(
      state.journal.checkpoint.metadataFirst.previewGaps.map((gap) => ({
        sourceItemId: gap.sourceItemId,
        code: gap.code,
      })),
      [{ sourceItemId: invalid.sourceItemId, code: "workbook_invalid" }],
    );
    assert.deepEqual(state.journal.checkpoint.metadataFirst.previewed, [
      metadataFirstIdentity(valid),
    ]);
    assert.deepEqual(
      requests.map((request) => request.identity.sourceItemId),
      [valid.sourceItemId],
    );
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("answered preview replay does not rerun the executor before discovery drain", async () => {
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
    assert.equal(state.journal.checkpoint.phase, "discovery_reserve");
    assert.deepEqual(state.journal.checkpoint.metadataFirstCarry.previewed, [
      metadataFirstIdentity(item),
    ]);
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
    assert.equal(state.journal.checkpoint.phase, "discovery_reserve");
    assert.deepEqual(
      requests.map((request) => request.identity.sourceItemId),
      [changed.sourceItemId, added.sourceItemId],
    );
    assert.equal(
      state.journal.checkpoint.metadataFirstCarry.previewed.some(
        (identity) => identity.sha256 === oldChanged.sha256,
      ),
      false,
    );
    await state.journal.transitionCheckpoint({
      checkpoint: checkpoint([unchanged, changed, added], 0, {
        step: "deferred_idle",
        archivedPublished: 0,
        metadataFirst: state.journal.checkpoint.metadataFirstCarry,
      }),
      credentialSessionActive: true,
    });
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

test("a serialized legacy reconcile keeps deep intent without an adoption marker", async () => {
  const item = plan("legacy-active-scan", "6");
  const initial = parseRunnerCheckpoint({
    version: 1,
    phase: "reconcile",
    mode: "normal",
    scanId: "legacy-scan",
    inventoryEpoch: 3,
    manifestVersion: 4,
    missingBindings: [],
    files: [item],
    ordinal: 0,
    reviewSeen: false,
  });
  const state = await fixture(initial);
  const worker = runner(
    { spaceId: "space", sourceAccountId: "source" },
    state.journal,
    {
      async call(request) {
        assert.equal(request.operation, "scan.reconcile");
        return {
          operation: "scan.reconcile",
          scanId: initial.scanId,
          state: "enumerated",
          inspected: 1,
          unavailable: 0,
          done: true,
          reused: false,
        };
      },
    },
    async () => assert.fail("legacy scan must not preview"),
  );
  worker.nextPdfWorkIndex = async () => 0;
  try {
    await worker.driveReconcile();
    assert.equal(state.journal.checkpoint.phase, "archived");
    assert.equal(state.journal.checkpoint.step, "intent");
    assert.equal(state.journal.checkpoint.metadataFirst, undefined);
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});
