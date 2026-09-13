import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal } from "../dist/journal.js";
import {
  canonicalRoots,
  discoverSourceObservations,
} from "../dist/filesystem.js";
import { SPREADSHEET_CHUNKING_FINGERPRINT } from "../dist/parsedBundleMapping.js";
import {
  journalCodec,
  parserOutputCatalogRecord,
  PipelineRunner,
} from "../dist/runner.js";
import { parseRunnerCheckpoint } from "../dist/runnerState.js";
import {
  SPREADSHEET_EXTRACTION_CONFIGURATION_FINGERPRINT,
  SPREADSHEET_PARSER_FINGERPRINT,
  XLSX_MEDIA_TYPE,
} from "../dist/spreadsheet.js";
import { resolveSheetCell } from "@repo/worker-protocol";

import { workbookBytes, zip } from "./syntheticWorkbook.mjs";

/**
 * P2-70i3: the client-side workbook lane, end to end over a workbook built in
 * the test: scanned as `spreadsheet_v1`, captured under the same encrypted
 * receipt-pair intents a PDF gets, parsed in process into the artifact pair,
 * spooled, and mapped into retained sheet pages a `cell_v1` locator resolves
 * into. No sample file enters the repository.
 */

const bases = [];
test.after(async () => {
  await Promise.all(
    bases.map((base) => rm(base, { recursive: true, force: true })),
  );
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const PROFILE = {
  parserProfileId: "pdf_docqa_v1",
  parserFingerprint: "a".repeat(64),
  extractionConfigurationFingerprint: "b".repeat(64),
  extractorFingerprint: "extractor-v1",
  recordSchemaFingerprint: "records-disabled-v1",
  normalizationFingerprint: "normalization-v1",
  chunkerFingerprint: "c".repeat(64),
  correctionRevision: "correction-v1",
};

async function fixture() {
  const created = await mkdtemp(join(tmpdir(), "kithmind-workbook-lane-"));
  bases.push(created);
  // The temporary directory is reached through a symlink on macOS, and every
  // protected directory check requires the canonical path.
  const base = await realpath(created);
  const root = join(base, "root");
  const journalDir = join(base, "journal");
  for (const path of [root, journalDir]) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  return {
    base,
    root,
    journalDir,
    config: {
      protocolVersion: 1,
      endpoint: `https://workbook-${sha256(Buffer.from(base)).slice(0, 32)}.invalid/api/worker`,
      spaceId: "space",
      sourceAccountId: "source",
      credentialEnv: "PIPELINE_TOKEN",
      roots: [{ alias: "fixture", path: root }],
      journalDir,
      watchIntervalMs: 1_000,
      maxFiles: 256,
      maxDepth: 16,
      maxFileBytes: 65_536,
      pdfDocQa: { profile: PROFILE },
    },
  };
}

test("a workbook is scanned as spreadsheet_v1 and a docx stays unsupported", async () => {
  const setup = await fixture();
  const bytes = workbookBytes();
  await writeFile(join(setup.root, "budget.xlsx"), bytes, { mode: 0o600 });
  await writeFile(
    join(setup.root, "letter.docx"),
    zip([["word/document.xml", "<document/>"]]),
    { mode: 0o600 },
  );
  const roots = await canonicalRoots(setup.config);
  const observations = await discoverSourceObservations(setup.config, roots);

  const workbook = observations.find(
    (observation) => observation.file?.relativePath === "budget.xlsx",
  );
  assert.ok(workbook);
  assert.equal(workbook.kind, "pdf");
  assert.equal(workbook.file.mediaType, XLSX_MEDIA_TYPE);
  assert.equal(workbook.file.sha256, sha256(bytes));
  assert.equal("text" in workbook.file, false);

  const document = observations.find(
    (observation) => observation.gap?.relativePath === "letter.docx",
  );
  assert.ok(document);
  assert.equal(document.gap.code, "unsupported");

  const runner = new PipelineRunner(setup.config, undefined, {
    async call() {
      throw new Error("network is not used");
    },
  });
  runner.preparedPdfProfile = {};
  const plans = await runner.discoverPlans(roots);
  const plan = plans.find((entry) => entry.relativePath === "budget.xlsx");
  assert.equal(plan.kind, "pdf");
  assert.equal(plan.parserProfileId, "spreadsheet_v1");
  assert.equal(plan.parserFingerprint, SPREADSHEET_PARSER_FINGERPRINT);
  assert.equal(
    plan.extractionConfigurationFingerprint,
    SPREADSHEET_EXTRACTION_CONFIGURATION_FINGERPRINT,
  );
  assert.equal(plan.chunkerFingerprint, SPREADSHEET_CHUNKING_FINGERPRINT);
  // The extraction fields stay the owner's configured ones, whatever parsed.
  assert.equal(plan.extractorFingerprint, PROFILE.extractorFingerprint);
  assert.equal(
    plans.find((entry) => entry.relativePath === "letter.docx").code,
    "unsupported",
  );
});

test(
  "a workbook captures, parses in process, spools and maps to sheet pages a cell cites",
  {
    skip:
      process.platform !== "darwin" &&
      "macOS is the supported local parser boundary",
  },
  async () => {
    const setup = await fixture();
    const bytes = workbookBytes();
    const sourcePath = join(setup.root, "budget.xlsx");
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    const source = await lstat(sourcePath);

    const [captureDirectory, parserOutputRoot, spoolDirectory] = [
      join(setup.base, "captures"),
      join(setup.base, "outputs"),
      join(setup.base, "spool"),
    ];
    for (const path of [captureDirectory, parserOutputRoot, spoolDirectory]) {
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o700);
    }
    const captureId = randomUUID();
    const outputId = randomUUID();
    const spoolId = randomUUID();
    const outputDirectory = join(parserOutputRoot, outputId);
    await mkdir(outputDirectory, { mode: 0o700 });
    await chmod(outputDirectory, 0o700);
    const [captureStat, outputRootStat, outputStat, spoolStat] =
      await Promise.all(
        [
          captureDirectory,
          parserOutputRoot,
          outputDirectory,
          spoolDirectory,
        ].map((path) => lstat(path)),
      );

    const plan = {
      rootAlias: "fixture",
      relativePath: "budget.xlsx",
      sourceModifiedAt: Math.trunc(source.mtimeMs),
      kind: "pdf",
      sha256: sha256(bytes),
      byteLength: bytes.length,
      parserProfileId: "spreadsheet_v1",
      parserFingerprint: SPREADSHEET_PARSER_FINGERPRINT,
      extractionConfigurationFingerprint:
        SPREADSHEET_EXTRACTION_CONFIGURATION_FINGERPRINT,
      extractorFingerprint: PROFILE.extractorFingerprint,
      recordSchemaFingerprint: PROFILE.recordSchemaFingerprint,
      normalizationFingerprint: PROFILE.normalizationFingerprint,
      chunkerFingerprint: SPREADSHEET_CHUNKING_FINGERPRINT,
      correctionRevision: PROFILE.correctionRevision,
      externalId: randomUUID(),
      sourceItemId: "source-item",
      observationEpoch: 1,
      processingEpoch: 1,
      discoveryState: "queued",
    };
    const checkpoint = parseRunnerCheckpoint({
      version: 1,
      phase: "archived",
      mode: "normal",
      scanId: "scan-1",
      inventoryEpoch: 1,
      manifestVersion: 1,
      missingBindings: [],
      files: [plan],
      pdfIndex: 0,
      step: "capture",
      reservationRound: 0,
      archivedPublished: 0,
      originalCatalogId: randomUUID(),
      expectedOriginalRevision: 1,
      processingCatalogId: randomUUID(),
      expectedProcessingRevision: 1,
    });
    const journal = await Journal.open({
      directory: setup.journalDir,
      binding: {
        protocolVersion: 1,
        endpoint: setup.config.endpoint,
        spaceId: "space",
        sourceAccountId: "source",
        configFingerprint: "b".repeat(64),
        credentialSlot: "PIPELINE_TOKEN",
      },
      credential: "test-credential",
      initialCheckpoint: checkpoint,
      codec: journalCodec,
    });

    const runner = new PipelineRunner(
      {
        ...setup.config,
        pdfDocQa: {
          ...setup.config.pdfDocQa,
          captureDirectory,
          parserOutputRoot,
          spoolDirectory,
        },
      },
      journal,
      {
        async call() {
          throw new Error("network is not used");
        },
      },
    );

    const original = {
      originalCatalogId: checkpoint.originalCatalogId,
      rowRevision: 1,
      createdAt: plan.sourceModifiedAt,
      origin: {
        scanId: "scan-1",
        observationEpoch: 1,
        sha256: plan.sha256,
        byteLength: plan.byteLength,
        // The archive receipt pair over the original workbook bytes is already
        // committed in this fixture, which is what routes capture to parse.
        mediaType: XLSX_MEDIA_TYPE,
      },
      cloud: { sourceItemId: "source-item" },
    };
    let processing = {
      processingCatalogId: checkpoint.processingCatalogId,
      originalCatalogId: original.originalCatalogId,
      rowRevision: 1,
      createdAt: plan.sourceModifiedAt,
      currentObservation: {
        scanId: "scan-1",
        observationEpoch: 1,
        processingEpoch: 1,
      },
      fingerprints: runner.processingFingerprints(plan),
      captureIntent: {
        captureId,
        directory: { device: captureStat.dev, inode: captureStat.ino },
      },
      parserIntent: {
        outputId,
        outputRoot: {
          device: outputRootStat.dev,
          inode: outputRootStat.ino,
        },
        outputDirectory: { device: outputStat.dev, inode: outputStat.ino },
        parserArtifactClientId: randomUUID(),
      },
      spoolIntent: {
        spoolId,
        root: { device: spoolStat.dev, inode: spoolStat.ino },
      },
    };
    runner.archivedRows = () => ({ original, processing });
    runner.archiveCatalog = {
      async recordCapture({ capture }) {
        processing = {
          ...processing,
          rowRevision: processing.rowRevision + 1,
          capture,
        };
        return processing;
      },
      async recordParserOutput({ output }) {
        processing = {
          ...processing,
          rowRevision: processing.rowRevision + 1,
          parserOutput: output,
        };
        return processing;
      },
      async recordSpoolPrepared({ prepared }) {
        processing = {
          ...processing,
          rowRevision: processing.rowRevision + 1,
          spoolPrepared: prepared,
        };
        return processing;
      },
      async recordSpool({ spool }) {
        processing = {
          ...processing,
          rowRevision: processing.rowRevision + 1,
          spool,
        };
        return processing;
      },
    };

    try {
      // Capture: the workbook lands beside a PDF's captures, under its own
      // extension, with its own magic bytes verified while it is copied.
      await runner.driveArchivedCapture();
      assert.equal(journal.checkpoint.step, "parse");
      const captured = await lstat(join(captureDirectory, `${captureId}.xlsx`));
      assert.equal(captured.size, bytes.length);
      assert.equal(processing.capture.sha256, plan.sha256);

      // Parse: the in-process reader writes the same durable artifact pair the
      // sandboxed lane writes, and records the class's parser output type.
      await runner.driveArchivedParse();
      assert.equal(journal.checkpoint.step, "spool");
      assert.equal(
        processing.parserOutput.rawArtifact.mediaType,
        "application/vnd.kithmind.sheetgrid+json",
      );
      assert.equal(
        processing.parserOutput.normalizedBundle.mediaType,
        "application/json",
      );
      assert.equal(processing.parserOutput.pageCount, 2);
      assert.equal(
        processing.parserOutput.parserFingerprint,
        SPREADSHEET_PARSER_FINGERPRINT,
      );
      for (const name of ["lossless.json", "bundle.json"]) {
        const entry = await lstat(join(outputDirectory, name));
        assert.equal(entry.mode & 0o777, 0o600);
      }
      // The catalog record is the shape an archive receipt pair is taken over.
      assert.equal(
        parserOutputCatalogRecord({
          ...processing.parserOutput,
          rawArtifact: {
            ...processing.parserOutput.rawArtifact,
            path: join(outputDirectory, "lossless.json"),
          },
          normalizedBundle: {
            ...processing.parserOutput.normalizedBundle,
            path: join(outputDirectory, "bundle.json"),
          },
        }).rawArtifact.opaqueName,
        "lossless.json",
      );

      // Spool: prepare, then publish, exactly as the PDF lane does.
      await runner.driveArchivedSpool();
      assert.ok(processing.spoolPrepared);
      await runner.driveArchivedSpool();
      assert.equal(journal.checkpoint.step, "lookup_processing");
      assert.equal(processing.spool.opaqueName, `${spoolId}.json`);

      // Staging: one retained page per sheet, page-local chunks with one
      // evidence span each, and one primary document row.
      const mapped = await runner.mappedProcessing(journal.checkpoint);
      assert.equal(mapped.mapping.pages.length, 2);
      assert.deepEqual(
        mapped.mapping.documents.map((document) => [
          document.documentKey,
          document.docType,
        ]),
        [["spreadsheet:primary", "spreadsheet"]],
      );
      assert.equal(mapped.declaration.pageCount, 2);
      assert.equal(
        mapped.declaration.expectedChunkCount,
        mapped.mapping.chunks.length,
      );
      assert.equal(
        mapped.declaration.normalizedBundleDigest,
        processing.spool.sha256,
      );
      assert.equal(
        mapped.declaration.extractionFingerprint,
        processing.parserOutput.extractionFingerprint,
      );

      // A `cell_v1` reference resolves into the page the card lane will cite:
      // the range is inside the sealed page, on its own cell, and the quote
      // hash a card would stage is the hash of that exact slice.
      const [revenue, notes] = mapped.mapping.pages;
      const total = resolveSheetCell(revenue.text, {
        sheet: "Revenue",
        row: 3,
        column: 2,
      });
      assert.ok(total);
      assert.ok(total.start >= 0 && total.end <= revenue.text.length);
      const quote = revenue.text.slice(total.start, total.end);
      assert.equal(quote, "2230.50");
      assert.equal(
        createHash("sha256").update(quote, "utf8").digest("hex"),
        createHash("sha256").update("2230.50", "utf8").digest("hex"),
      );
      // The page the span points into is the page whose hash is sealed.
      assert.equal(
        revenue.textHash,
        createHash("sha256").update(revenue.text, "utf8").digest("hex"),
      );
      // Line 0 names the sheet, which is what lets a cited cell prove which
      // sheet it came from with no page-to-sheet table to trust.
      assert.equal(revenue.text.split("\n")[0], "Revenue");
      assert.equal(notes.text.split("\n")[0], "Notes");
      // An empty cell is not a citation.
      assert.equal(
        resolveSheetCell(revenue.text, {
          sheet: "Revenue",
          row: 2,
          column: 1,
        }),
        null,
      );
    } finally {
      await journal.close();
    }
  },
);
