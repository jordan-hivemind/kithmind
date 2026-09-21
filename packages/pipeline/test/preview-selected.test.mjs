import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal } from "../dist/journal.js";
import { journalCodec } from "../dist/runner.js";
import { parseRunnerCheckpoint } from "../dist/runnerState.js";
import {
  parsePreviewManifest,
  previewSelectedJournal,
} from "../dist/previewSelected.js";

function plan(name, seed, profile = "pdf_docqa_v1") {
  return {
    rootAlias: "fixture",
    relativePath: `${name}.${profile === "pdf_docqa_v1" ? "pdf" : "xlsx"}`,
    sourceModifiedAt: 1,
    kind: "pdf",
    sha256: seed.repeat(64),
    byteLength: 100,
    parserProfileId: profile,
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

function checkpoint(files) {
  return parseRunnerCheckpoint({
    version: 1,
    phase: "archived",
    mode: "normal",
    scanId: "scan-1",
    inventoryEpoch: 1,
    manifestVersion: 1,
    missingBindings: [],
    files,
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

function binding() {
  return {
    protocolVersion: 1,
    endpoint: "https://preview.invalid/api/worker",
    spaceId: "space",
    sourceAccountId: "source",
    configFingerprint: "d".repeat(64),
    credentialSlot: "TOKEN",
  };
}

async function fixture(initial) {
  const directory = await mkdtemp(join(tmpdir(), "kith-preview-selected-"));
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

function manifest(targets) {
  return parsePreviewManifest({
    version: 1,
    targets: targets.map(({ plan, windows }) => ({
      rootAlias: plan.rootAlias,
      relativePath: plan.relativePath,
      revisionHash: plan.sha256,
      ...(windows === undefined ? {} : { windows }),
    })),
  });
}

function previewFor(item, windows) {
  const pdf = item.parserProfileId === "pdf_docqa_v1";
  return {
    sourceSha256: item.sha256,
    mediaType: pdf
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sourceUnitCount: pdf ? 90 : 2,
    inspectedOriginalUnits: pdf
      ? windows.flatMap(({ startPage, pageCount }) =>
          Array.from({ length: pageCount }, (_, index) => startPage + index),
        )
      : [1, 2],
    unitStates: pdf ? ["text_available", "image_only"] : [],
    method: pdf ? "pdf_native_text_v1" : "spreadsheet_manifest_v1",
    methodFingerprint: pdf ? "e".repeat(64) : "f".repeat(64),
  };
}

function persistedFingerprint(method, methodFingerprint, units) {
  return createHash("sha256")
    .update("kithmind-triage-preview:v1\0")
    .update(JSON.stringify([method, methodFingerprint, units]))
    .digest("hex");
}

test("records bounded PDF and spreadsheet previews without changing the active checkpoint", async () => {
  const current = plan("current", "1");
  const pdf = plan("tax", "2");
  const workbook = plan("ledger", "3", "spreadsheet_v1");
  const initial = checkpoint([current, pdf, workbook]);
  const state = await fixture(initial);
  const requests = [];
  const selected = manifest([
    {
      plan: pdf,
      windows: [
        { startPage: 1, pageCount: 1 },
        { startPage: 90, pageCount: 1 },
      ],
    },
    { plan: workbook },
  ]);
  const transport = {
    async call(request) {
      requests.push(structuredClone(request));
      return {
        operation: "discovery.recordPreview",
        previewId: randomUUID(),
        sourceItemId: request.identity.sourceItemId,
        observedContentHash: request.identity.contentHash,
        previewFingerprint: request.preview.previewFingerprint,
        state: "provisional",
        reused: requests.length > 2,
      };
    },
  };
  try {
    const before = JSON.stringify(state.journal.checkpoint);
    const first = await previewSelectedJournal({
      journal: state.journal,
      config: {
        protocolVersion: 1,
        endpoint: "https://preview.invalid/api/worker",
        spaceId: "space",
        sourceAccountId: "source",
      },
      manifest: selected,
      manifestSha256: "9".repeat(64),
      transport,
      executePreview: async (item, windows) => previewFor(item, windows),
    });
    assert.deepEqual(first, {
      state: "previewed",
      manifestSha256: "9".repeat(64),
      selectedCount: 2,
      recordedCount: 2,
      reusedCount: 0,
    });
    assert.equal(JSON.stringify(state.journal.checkpoint), before);
    assert.equal(state.journal.pending, undefined);
    assert.deepEqual(requests[0].preview, {
      previewFingerprint: persistedFingerprint(
        "pdf_native_text_v1",
        "e".repeat(64),
        [1, 90],
      ),
      previewMethod: "pdf_native_text_v1",
      sourceFormat: "pdf",
      sourceUnitCount: 90,
      inspectedOriginalUnits: [1, 90],
      provisionalMetadata: { uncertaintyCodes: ["image_only"] },
      confidence: null,
    });
    assert.deepEqual(requests[1].preview, {
      previewFingerprint: persistedFingerprint(
        "spreadsheet_manifest_v1",
        "f".repeat(64),
        [1, 2],
      ),
      previewMethod: "spreadsheet_manifest_v1",
      sourceFormat: "spreadsheet",
      sourceUnitCount: 2,
      inspectedOriginalUnits: [1, 2],
      provisionalMetadata: { documentKind: "spreadsheet" },
      confidence: null,
    });
    assert.equal(JSON.stringify(requests).includes("relativePath"), false);
    const second = await previewSelectedJournal({
      journal: state.journal,
      config: { spaceId: "space", sourceAccountId: "source" },
      manifest: selected,
      manifestSha256: "9".repeat(64),
      transport,
      executePreview: async (item, windows) => previewFor(item, windows),
    });
    assert.equal(second.reusedCount, 2);
    assert.equal(requests[0].requestId, requests[2].requestId);
    assert.equal(requests[1].requestId, requests[3].requestId);
    await previewSelectedJournal({
      journal: state.journal,
      config: { spaceId: "space", sourceAccountId: "source" },
      manifest: manifest([
        { plan: pdf, windows: [{ startPage: 2, pageCount: 2 }] },
      ]),
      manifestSha256: "8".repeat(64),
      transport,
      executePreview: async (item, windows) => previewFor(item, windows),
    });
    assert.notEqual(
      requests[0].preview.previewFingerprint,
      requests[4].preview.previewFingerprint,
    );
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("refuses current, stale, malformed-window, unsafe-phase, and pending selections", async () => {
  const current = plan("current", "1");
  const later = plan("later", "2");
  const initial = checkpoint([current, later]);
  for (const selected of [
    manifest([{ plan: current, windows: [{ startPage: 1, pageCount: 1 }] }]),
    manifest([
      {
        plan: { ...later, sha256: "3".repeat(64) },
        windows: [{ startPage: 1, pageCount: 1 }],
      },
    ]),
  ]) {
    const state = await fixture(initial);
    try {
      await assert.rejects(
        () =>
          previewSelectedJournal({
            journal: state.journal,
            config: {},
            manifest: selected,
            manifestSha256: "9".repeat(64),
            transport: {
              async call() {
                throw new Error("unused");
              },
            },
            executePreview: async () => {
              throw new Error("unused");
            },
          }),
        (error) => error.message === "target_missing_or_stale",
      );
      assert.deepEqual(state.journal.checkpoint, initial);
    } finally {
      await state.journal.close();
      await rm(state.directory, { recursive: true, force: true });
    }
  }
  for (const invalid of [
    { version: 1, targets: [] },
    {
      version: 1,
      targets: [
        {
          rootAlias: "fixture",
          relativePath: "later.pdf",
          revisionHash: later.sha256,
          windows: [
            { startPage: 3, pageCount: 1 },
            { startPage: 2, pageCount: 1 },
          ],
        },
      ],
    },
  ])
    assert.throws(() => parsePreviewManifest(invalid));

  await assert.rejects(
    () =>
      previewSelectedJournal({
        journal: { checkpoint: { version: 1, phase: "idle" } },
        config: {},
        manifest: manifest([
          { plan: later, windows: [{ startPage: 1, pageCount: 1 }] },
        ]),
        manifestSha256: "9".repeat(64),
        transport: {},
        executePreview: async () => {},
      }),
    (error) => error.message === "phase_unsafe",
  );
  await assert.rejects(
    () =>
      previewSelectedJournal({
        journal: { checkpoint: initial, pending: { operation: "anything" } },
        config: {},
        manifest: manifest([
          { plan: later, windows: [{ startPage: 1, pageCount: 1 }] },
        ]),
        manifestSha256: "9".repeat(64),
        transport: {},
        executePreview: async () => {},
      }),
    (error) => error.message === "pending_unsafe",
  );
});

test("partial transport failure is safely retryable with deterministic request IDs", async () => {
  const current = plan("current", "1");
  const first = plan("first", "2");
  const second = plan("second", "3");
  const initial = checkpoint([current, first, second]);
  const state = await fixture(initial);
  const requestIds = [];
  try {
    await assert.rejects(
      () =>
        previewSelectedJournal({
          journal: state.journal,
          config: { spaceId: "space", sourceAccountId: "source" },
          manifest: manifest(
            [first, second].map((item) => ({
              plan: item,
              windows: [{ startPage: 1, pageCount: 2 }],
            })),
          ),
          manifestSha256: "9".repeat(64),
          executePreview: async (item, windows) => previewFor(item, windows),
          transport: {
            async call(request) {
              requestIds.push(request.requestId);
              if (requestIds.length === 2) throw new Error("lost response");
              return {
                operation: "discovery.recordPreview",
                sourceItemId: request.identity.sourceItemId,
                observedContentHash: request.identity.contentHash,
                previewFingerprint: request.preview.previewFingerprint,
                state: "provisional",
                reused: false,
              };
            },
          },
        }),
      (error) =>
        error.message === "server_refused" && error.recordedCount === 1,
    );
    assert.deepEqual(state.journal.checkpoint, initial);
  } finally {
    await state.journal.close();
    await rm(state.directory, { recursive: true, force: true });
  }
});
