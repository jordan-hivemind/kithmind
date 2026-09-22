import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { digestParsedMappingManifest } from "@repo/worker-protocol";
import {
  createKithPool,
  newKithId,
  sha256,
  withKithTransaction,
} from "../dist/index.js";
import { runTargetedTaxExtractionJob } from "../dist/extraction/index.js";
import {
  WorkerProtocolError,
  activateParsedJob,
  admitArchivedDiscovery,
  admitTargetedTaxBatch,
  appendTargetedTaxBatch,
  appendWorkerScanPage,
  artifactBoundExtractionFingerprint,
  beginTargetedTaxExtraction,
  beginWorkerScan,
  reconcileWorkerScan,
  reserveArchivedDiscovery,
  reserveParsedJobs,
  sealWorkerScan,
  stageParsedBatch,
  beginParsedStage,
  sealParsedStage,
  workerCtx,
} from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const SOURCE_PAGE_COUNT = 500;

const expectProtocolCode = (code) => (error) =>
  error instanceof WorkerProtocolError && error.data.code === code;

function archiveReceipt(offset) {
  return {
    kind: "create",
    subjectKind: "parser_output",
    copyRole: "primary",
    clientReceiptId: randomUUID(),
    archiveProfileFingerprint: sha256(`archive-profile:${offset}`),
    archiveIdentityFingerprint: sha256(`archive-identity:${offset}`),
    recipientFingerprint: sha256(`recipient:${offset}`),
    repositoryKeyDomainFingerprint: sha256(`repository:${offset}`),
    storageFailureDomainFingerprint: sha256(`failure-domain:${offset}`),
    archiveObjectId: randomUUID(),
    ciphertextHash: sha256(`ciphertext:${offset}`),
    ciphertextByteLength: 64,
    readbackVerifiedAt: NOW,
    createdAt: NOW,
  };
}

function artifactFor(f, ordinal, originalPage, outputHash, extractionFingerprint) {
  return {
    artifactKind: "selective_pdf_pages_v1",
    sourceSha256: f.contentHash,
    selectedPdfSha256: outputHash,
    sourcePageCount: SOURCE_PAGE_COUNT,
    originalPages: [originalPage],
    coverageFingerprint: sha256(`coverage:${ordinal}`),
    artifactFingerprint: sha256(`artifact:${ordinal}`),
    parserFingerprint: f.parserFingerprint,
    extractionFingerprint,
  };
}

async function stageTargetedBatch(f, admitted, text, requestPrefix) {
  const textHash = sha256(text);
  const page = { ordinal: 0, start: 0, end: text.length, text, textHash };
  const evidence = {
    ordinal: 0,
    pageOrdinal: 0,
    start: 0,
    end: text.length,
    quoteHash: textHash,
    locator: {
      kind: "parser_page_v1",
      pageNumber: 1,
      pageTextHash: textHash,
    },
  };
  const mappingManifestHash = await digestParsedMappingManifest([page], [evidence]);
  const reserved = await f.run((ctx) =>
    reserveParsedJobs(
      ctx,
      f.principal,
      {
        ...f.common,
        operation: "jobs.reserveParsed",
        requestId: `${requestPrefix}-reserve`,
        maxItems: 1,
        jobId: admitted.ingestJobId,
      },
      [sha256(`${requestPrefix}-lease`)],
    ),
  );
  const lease = reserved.targets[0];
  assert.ok(lease);
  const base = {
    ...f.common,
    jobId: lease.jobId,
    leaseEpoch: lease.leaseEpoch,
    leaseToken: lease.leaseToken,
  };
  const staged = await f.run((ctx) =>
    beginParsedStage(ctx, f.principal, {
      ...base,
      operation: "jobs.stageParsedBegin",
      requestId: `${requestPrefix}-stage-begin`,
      extractionFingerprint: f.batchDeclarations.get(admitted.processingGenerationId).artifact.extractionFingerprint,
      mappingManifestHash,
      normalizedBundleDigest: f.batchDeclarations.get(admitted.processingGenerationId).normalizedBundleDigest,
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
    }),
  );
  const batch = (phase, rows) =>
    f.run((ctx) =>
      stageParsedBatch(ctx, f.principal, {
        ...base,
        operation: "jobs.stageParsedBatch",
        requestId: `${requestPrefix}-${phase}`,
        stageId: staged.stageId,
        phase,
        ordinal: 0,
        rows,
      }),
    );
  await batch("pages", [page]);
  await batch("evidence", [evidence]);
  await batch("documents", [
    {
      documentKey: `${requestPrefix}-document`,
      title: "Synthetic selected tax pages",
      docType: "pdf",
      capturedAt: NOW,
      evidence: [{ pageOrdinal: 0, evidenceOrdinal: 0 }],
    },
  ]);
  await batch("chunks", [
    {
      documentKey: `${requestPrefix}-document`,
      ordinal: 0,
      start: 0,
      end: text.length,
      text,
      evidence: [{ pageOrdinal: 0, evidenceOrdinal: 0 }],
    },
  ]);
  await f.run((ctx) =>
    sealParsedStage(ctx, f.principal, {
      ...base,
      operation: "jobs.stageParsedSeal",
      requestId: `${requestPrefix}-seal`,
      stageId: staged.stageId,
      normalizedBundleDigest: f.batchDeclarations.get(admitted.processingGenerationId).normalizedBundleDigest,
    }),
  );
  await assert.rejects(
    f.run((ctx) =>
      activateParsedJob(ctx, f.principal, {
        ...base,
        operation: "jobs.activateParsed",
        requestId: `${requestPrefix}-activate-refused`,
      }),
    ),
    expectProtocolCode("scan_conflict"),
  );
  return { ...admitted, text, textHash };
}

async function fixture(t, firstText, externalId, firstOriginalPage = 137) {
  const database = await identityDatabase(t);
  const identity = database.ctx(NOW);
  const userId = await makeUser(identity, { name: "Synthetic owner" });
  const spaceId = await makeSpace(identity, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const sourceAccountId = newKithId();
  const parserFingerprint = sha256("selective-parser-v1");
  const extractionConfigurationFingerprint = sha256("selective-config-v1");
  await database.client.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, inventory_epoch, completed_inventory_epoch,
        manifest_version, created_by, binary_profile_ids,
        binary_profile_audit_digest, binary_profile_enabled_at)
     VALUES ($1,$2,transaction_timestamp(),'fs','targeted-tax-test',
             'Targeted tax test',true,0,60000,0,0,0,$3,$4,$5,transaction_timestamp())`,
    [sourceAccountId, spaceId, userId, JSON.stringify(["pdf_docqa_v1"]), parserFingerprint],
  );
  const credential = await makeApiKey(identity, {
    userId,
    capabilities: ["read", "write", "ingest"],
    spaceIds: [spaceId],
    sourceAccountIds: [sourceAccountId],
  });
  const principal = { userId, credentialId: credential.id };
  const pool = createKithPool(database.databaseUrl, 5);
  pool.on("error", () => {});
  t.after(() => pool.end());
  const run = (work, at = NOW) =>
    withKithTransaction(pool, (client) => work(workerCtx(client, at)));
  const common = { protocolVersion: 1, spaceId, sourceAccountId };
  const contentHash = sha256(`source:${externalId}`);
  const begun = await run((ctx) =>
    beginWorkerScan(ctx, principal, {
      ...common,
      operation: "scan.begin",
      requestId: `${externalId}-scan-begin`,
      watcherId: "targeted-test",
      connectorVersion: "fs-v1",
      mode: "normal",
      expectedInventoryEpoch: 0,
    }),
  );
  await run((ctx) =>
    appendWorkerScanPage(ctx, principal, {
      ...common,
      operation: "scan.appendPage",
      scanId: begun.scanId,
      requestId: `${externalId}-scan-page`,
      ordinal: 0,
      entries: [
        {
          externalId: randomUUID(),
          uri: `fs://synthetic/${externalId}.pdf`,
          title: "Synthetic tax form",
          docType: "pdf",
          sourceModifiedAt: NOW - 1000,
          content: {
            status: "ready_binary_v1",
            sha256: contentHash,
            byteLength: 1000,
            mediaType: "application/pdf",
            parserProfileId: "pdf_docqa_v1",
            parserFingerprint,
            extractionConfigurationFingerprint,
            extractorFingerprint: "targeted-tax-extractor:v1",
            recordSchemaFingerprint: "targeted-tax-records:v1",
            normalizationFingerprint: "targeted-tax-pages:v1",
            chunkerFingerprint: "targeted-tax-chunks:v1",
            correctionRevision: "targeted-tax:v1",
          },
        },
      ],
    }),
  );
  await run((ctx) =>
    sealWorkerScan(ctx, principal, {
      ...common,
      operation: "scan.seal",
      scanId: begun.scanId,
      requestId: `${externalId}-scan-seal`,
      expectedPageCount: 1,
      health: { status: "healthy" },
    }),
  );
  await run((ctx) =>
    reconcileWorkerScan(ctx, principal, {
      ...common,
      operation: "scan.reconcile",
      scanId: begun.scanId,
      requestId: `${externalId}-scan-reconcile`,
      expectedInventoryEpoch: 1,
      ordinal: 0,
      maxItems: 10,
    }),
  );
  const work = (
    await database.client.query(
      "SELECT * FROM kith.worker_discovery_work WHERE source_account_id=$1",
      [sourceAccountId],
    )
  ).rows[0];
  const identityRequest = {
    sourceItemId: work.source_item_id,
    scanId: begun.scanId,
    observationEpoch: Number(work.observation_epoch),
    processingEpoch: Number(work.processing_epoch),
    contentHash,
    byteLength: 1000,
    mediaType: "application/pdf",
    parserProfileId: "pdf_docqa_v1",
    parserFingerprint,
    extractionConfigurationFingerprint,
    extractorFingerprint: "targeted-tax-extractor:v1",
    recordSchemaFingerprint: "targeted-tax-records:v1",
    normalizationFingerprint: "targeted-tax-pages:v1",
    chunkerFingerprint: "targeted-tax-chunks:v1",
    correctionRevision: "targeted-tax:v1",
  };
  const leased = await run((ctx) =>
    reserveArchivedDiscovery(
      ctx,
      principal,
      {
        ...common,
        operation: "discovery.reserveArchived",
        requestId: `${externalId}-reserve`,
        identity: identityRequest,
      },
      sha256(`${externalId}-archive-lease`),
    ),
  );
  const selectedPdfSha256 = sha256(`selected:0:${externalId}`);
  const extractionFingerprint = await artifactBoundExtractionFingerprint(
    parserFingerprint,
    selectedPdfSha256,
    extractionConfigurationFingerprint,
  );
  const f = {
    ...database,
    pool,
    run,
    common,
    principal,
    spaceId,
    sourceAccountId,
    sourceItemId: work.source_item_id,
    contentHash,
    parserFingerprint,
    extractionConfigurationFingerprint,
    batchDeclarations: new Map(),
  };
  const artifact = artifactFor(f, 0, firstOriginalPage, selectedPdfSha256, extractionFingerprint);
  const firstTextHash = sha256(firstText);
  const page = { ordinal: 0, start: 0, end: firstText.length, text: firstText, textHash: firstTextHash };
  const evidence = {
    ordinal: 0,
    pageOrdinal: 0,
    start: 0,
    end: firstText.length,
    quoteHash: firstTextHash,
    locator: { kind: "parser_page_v1", pageNumber: 1, pageTextHash: firstTextHash },
  };
  const mappingManifestHash = await digestParsedMappingManifest([page], [evidence]);
  const normalizedBundleDigest = sha256(`bundle:0:${externalId}`);
  const admitted = await run((ctx) =>
    admitArchivedDiscovery(ctx, principal, {
      ...common,
      operation: "discovery.admitArchived",
      requestId: `${externalId}-admit`,
      workId: leased.workId,
      leaseEpoch: leased.leaseEpoch,
      leaseToken: leased.leaseToken,
      parserArtifact: {
        kind: "create",
        clientArtifactId: randomUUID(),
        outputHash: selectedPdfSha256,
        outputByteLength: 200,
        outputMediaType: "application/vnd.docling+json",
        createdAt: NOW,
      },
      archives: [archiveReceipt(0)],
      providerOriginal: {
        referenceVersion: "provider_original_v2",
        providerKind: "dropbox_v1",
        clientReferenceId: randomUUID(),
        sourceContentHash: contentHash,
        sourceByteLength: 1000,
        providerAccountIdHash: sha256("provider-account"),
        providerRootDirectoryIdHash: sha256("provider-root"),
        providerFileIdHash: sha256(`provider-file:${externalId}`),
        providerRevision: `rev-${externalId}`,
        providerContentHash: sha256(`provider-content:${externalId}`),
        verifiedAt: NOW,
        createdAt: NOW,
      },
      parsedText: {
        representation: "targeted_pages_v1",
        targetedCoverage: {
          sourceSha256: contentHash,
          selectedPdfSha256,
          sourcePageCount: SOURCE_PAGE_COUNT,
          originalPages: [firstOriginalPage],
          coverageFingerprint: artifact.coverageFingerprint,
          artifactFingerprint: artifact.artifactFingerprint,
        },
        extractionFingerprint,
        textHash: firstTextHash,
        byteLength: Buffer.byteLength(firstText, "utf8"),
        utf16Length: firstText.length,
        pageCount: 1,
        mappingManifestHash,
        normalizedBundleDigest,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 1,
        expectedChunkCount: 1,
      },
    }),
  );
  f.batchDeclarations.set(admitted.processingGenerationId, { artifact, normalizedBundleDigest });
  f.firstBatch = await stageTargetedBatch(f, admitted, firstText, `${externalId}-first`);
  f.sourceRevisionId = admitted.sourceRevisionId;
  const recovery = (
    await database.client.query(
      `SELECT original_provider_reference_id, original_provider_binding_epoch
         FROM kith.processing_generations WHERE id=$1`,
      [admitted.processingGenerationId],
    )
  ).rows[0];
  f.providerReferenceId = recovery.original_provider_reference_id;
  f.providerBindingEpoch = Number(recovery.original_provider_binding_epoch);
  return f;
}

function beginRequest(f, overrides = {}) {
  const request = {
    ...f.common,
    operation: "extraction.beginTargetedTax",
    requestId: "target-begin",
    sourceItemId: f.sourceItemId,
    sourceRevisionId: f.sourceRevisionId,
    observedContentHash: f.contentHash,
    goalKind: "form_1040_totals_v1",
    instanceKey: "1040:2025",
    requiredFields: ["tax_year", "return_version", "total_tax"],
    optionalFields: [],
    sourcePageCount: SOURCE_PAGE_COUNT,
    ...overrides,
  };
  request.requestDigest = sha256(
    `kith-targeted-tax-goal:v1\0${JSON.stringify([
      request.sourceItemId,
      request.sourceRevisionId,
      request.observedContentHash,
      request.goalKind,
      request.instanceKey,
      request.requiredFields,
      request.optionalFields,
      request.sourcePageCount,
    ])}`,
  );
  return request;
}

function appendRequest(f, targetId, ordinal, batch, coverage, overrides = {}) {
  return {
    ...f.common,
    operation: "extraction.appendTargetedTaxBatch",
    requestId: `target-append-${ordinal}`,
    targetId,
    sourceRevisionId: f.sourceRevisionId,
    batchOrdinal: ordinal,
    sourceTextVersionId: batch.sourceTextVersionId,
    processingGenerationId: batch.processingGenerationId,
    artifact: f.batchDeclarations.get(batch.processingGenerationId).artifact,
    pages: [{
      originalPage: f.batchDeclarations.get(batch.processingGenerationId).artifact.originalPages[0],
      textHash: batch.textHash,
    }],
    coverage,
    ...overrides,
  };
}

async function continuation(f, targetId, ordinal, originalPage, text, priorGenerationId) {
  const outputHash = sha256(`selected:${ordinal}:${targetId}`);
  const extractionFingerprint = await artifactBoundExtractionFingerprint(
    f.parserFingerprint,
    outputHash,
    f.extractionConfigurationFingerprint,
  );
  const artifact = artifactFor(f, ordinal, originalPage, outputHash, extractionFingerprint);
  const textHash = sha256(text);
  const page = { ordinal: 0, start: 0, end: text.length, text, textHash };
  const evidence = {
    ordinal: 0,
    pageOrdinal: 0,
    start: 0,
    end: text.length,
    quoteHash: textHash,
    locator: { kind: "parser_page_v1", pageNumber: 1, pageTextHash: textHash },
  };
  const mappingManifestHash = await digestParsedMappingManifest([page], [evidence]);
  const normalizedBundleDigest = sha256(`bundle:${ordinal}:${targetId}`);
  const request = {
    ...f.common,
    operation: "extraction.admitTargetedTaxBatch",
    requestId: `target-admit-${ordinal}`,
    targetId,
    sourceRevisionId: f.sourceRevisionId,
    batchOrdinal: ordinal,
    priorProcessingGenerationId: priorGenerationId,
    artifact,
    extractionConfigurationFingerprint: f.extractionConfigurationFingerprint,
    parserArtifact: {
      kind: "create",
      clientArtifactId: randomUUID(),
      outputHash,
      outputByteLength: 200,
      outputMediaType: "application/vnd.docling+json",
      createdAt: NOW,
    },
    archives: [archiveReceipt(ordinal)],
    parsedText: {
      representation: "targeted_pages_v1",
      targetedCoverage: {
        sourceSha256: f.contentHash,
        selectedPdfSha256: outputHash,
        sourcePageCount: SOURCE_PAGE_COUNT,
        originalPages: [originalPage],
        coverageFingerprint: artifact.coverageFingerprint,
        artifactFingerprint: artifact.artifactFingerprint,
      },
      extractionFingerprint,
      textHash,
      byteLength: Buffer.byteLength(text, "utf8"),
      utf16Length: text.length,
      pageCount: 1,
      mappingManifestHash,
      normalizedBundleDigest,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
    },
    existingProviderOriginal: {
      referenceVersion: "provider_original_v2",
      referenceId: f.providerReferenceId,
      bindingEpoch: f.providerBindingEpoch,
    },
  };
  const admitted = await f.run((ctx) => admitTargetedTaxBatch(ctx, f.principal, request));
  const replay = await f.run((ctx) => admitTargetedTaxBatch(ctx, f.principal, request));
  assert.equal(replay.reused, true);
  assert.deepEqual({ ...replay, reused: false }, admitted);
  f.batchDeclarations.set(admitted.processingGenerationId, { artifact, normalizedBundleDigest });
  return stageTargetedBatch(f, admitted, text, `target-${ordinal}`);
}

function model(reading, before) {
  return {
    name: "synthetic-targeted-tax",
    async read() {
      if (before) await before();
      return { summary: "", unnamed: 0, ...reading };
    },
  };
}

async function runBatch(f, targetId, ordinal, reading, before) {
  await runTargetedTaxExtractionJob(
    f.pool,
    { spaceId: f.spaceId, targetId, batchOrdinal: ordinal },
    { spaceId: f.spaceId, payload: {} },
    model(reading, before),
  );
  return (
    await f.client.query(
      `SELECT * FROM kith.document_targeted_extractions WHERE id=$1`,
      [targetId],
    )
  ).rows[0];
}

const closed1040 = {
  formFamily: "form_1040",
  requestedRegionsClosed: true,
  continuationsClosed: true,
};

test("targeted discovery and continuation preserve original-page evidence and competing readings", { skip }, async (t) => {
  const page1 = [
    "Form 1040 U.S. Individual Income Tax Return",
    "Tax year 2025",
    "Return version 2025",
    "Total tax $123.00",
  ].join("\r\n");
  const f = await fixture(t, page1, "tax-conflict", 137);
  const begun = await f.run((ctx) =>
    beginTargetedTaxExtraction(ctx, f.principal, beginRequest(f, {
      requiredFields: ["tax_year", "return_version", "total_tax", "total_payments"],
    })),
  );
  await f.run((ctx) =>
    appendTargetedTaxBatch(
      ctx,
      f.principal,
      appendRequest(f, begun.targetId, 0, f.firstBatch, closed1040),
    ),
  );
  let row = await runBatch(f, begun.targetId, 0, {
    kind: "tax_return_1040",
    statements: [
      { field: "tax_year", value: "2025", page: 137, lines: [2], quote: "" },
      { field: "return_version", value: "2025", page: 137, lines: [3], quote: "" },
      { field: "total_tax", value: "$123.00", page: 137, lines: [4], quote: "" },
      { field: "total_payments", value: "$999.00", page: 137, lines: [4], quote: "" },
    ],
  });
  assert.equal(row.status, "incomplete_resumable");
  assert.equal(row.outcomes.some((outcome) => outcome.field === "total_payments"), false);
  assert.equal(row.outcomes.find((outcome) => outcome.field === "total_tax").readings[0].citations[0].originalPage, 137);

  const second = await continuation(f, begun.targetId, 1, 138, "Total tax $124.00", f.firstBatch.processingGenerationId);
  await f.run((ctx) =>
    appendTargetedTaxBatch(
      ctx,
      f.principal,
      appendRequest(f, begun.targetId, 1, second, closed1040),
    ),
  );
  row = await runBatch(f, begun.targetId, 1, {
    kind: "tax_return_1040",
    statements: [
      { field: "total_tax", value: "$124.00", page: 138, lines: [1], quote: "" },
    ],
  });
  assert.equal(row.status, "conflict");
  const total = row.outcomes.find((outcome) => outcome.field === "total_tax");
  assert.equal(total.status, "conflict");
  assert.deepEqual(total.readings.map((reading) => reading.value.amount).sort(), ["123", "124"]);
  assert.deepEqual(
    total.readings.map((reading) => reading.citations[0].originalPage).sort(),
    [137, 138],
  );
});

test("ordinal-zero append rejects a changed admitted page map", { skip }, async (t) => {
  const text = "Form 1040\nTax year 2025";
  const f = await fixture(t, text, "tax-map", 137);
  const begun = await f.run((ctx) => beginTargetedTaxExtraction(ctx, f.principal, beginRequest(f)));
  const changed = appendRequest(f, begun.targetId, 0, f.firstBatch, closed1040);
  changed.artifact = {
    ...changed.artifact,
    originalPages: [138],
    coverageFingerprint: sha256("changed-coverage"),
    artifactFingerprint: sha256("changed-artifact"),
  };
  changed.pages = [{ originalPage: 138, textHash: f.firstBatch.textHash }];
  await assert.rejects(
    f.run((ctx) => appendTargetedTaxBatch(ctx, f.principal, changed)),
    expectProtocolCode("request_conflict"),
  );
});

test("targeted tax commit refuses a revision changed during the model call", { skip }, async (t) => {
  const page = "Form 1040 U.S. Individual Income Tax Return\nTax year 2025";
  const f = await fixture(t, page, "tax-race", 137);
  const begun = await f.run((ctx) => beginTargetedTaxExtraction(ctx, f.principal, beginRequest(f)));
  await f.run((ctx) =>
    appendTargetedTaxBatch(ctx, f.principal, appendRequest(f, begun.targetId, 0, f.firstBatch, closed1040)),
  );
  const row = await runBatch(
    f,
    begun.targetId,
    0,
    {
      kind: "tax_return_1040",
      statements: [{ field: "tax_year", value: "2025", page: 137, lines: [2], quote: "" }],
    },
    () => f.client.query(`UPDATE kith.source_items SET desired_revision_id=NULL WHERE id=$1`, [f.sourceItemId]),
  );
  assert.equal(row.status, "running");
  assert.equal(row.batches[0].state, "pending");
  assert.deepEqual(row.outcomes, []);
});

test("a first-page-only K-1 cannot complete without key-region and continuation closure", { skip }, async (t) => {
  const text = "Schedule K-1 (Form 1065)\nTax year 2025\nPartnership Synthetic LP";
  const f = await fixture(t, text, "k1-open", 137);
  const begun = await f.run((ctx) =>
    beginTargetedTaxExtraction(ctx, f.principal, beginRequest(f, {
      goalKind: "schedule_k1_key_fields_v1",
      instanceKey: "k1:2025:synthetic",
      requiredFields: ["tax_year", "form_family", "partnership_name"],
      optionalFields: ["box_1_ordinary_business_income"],
    })),
  );
  await f.run((ctx) =>
    appendTargetedTaxBatch(ctx, f.principal, appendRequest(f, begun.targetId, 0, f.firstBatch, {
      formFamily: "schedule_k1_1065",
      requestedRegionsClosed: false,
      continuationsClosed: false,
    })),
  );
  const row = await runBatch(f, begun.targetId, 0, {
    kind: "schedule_k1_1065",
    statements: [
      { field: "form_family", value: "1065", page: 137, lines: [1], quote: "" },
      { field: "tax_year", value: "2025", page: 137, lines: [2], quote: "" },
      { field: "partnership_name", value: "Synthetic LP", page: 137, lines: [3], quote: "" },
    ],
  });
  assert.equal(row.status, "incomplete_resumable");
  assert.ok(row.unresolved_codes.includes("requested_regions_open"));
  assert.ok(row.unresolved_codes.includes("continuations_open"));
});
