import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWorkerProtocolErrorData,
  parseWorkerRequest,
  WorkerProtocolParseError,
} from "@repo/worker-protocol/request";

const source = {
  protocolVersion: 1,
  spaceId: "j1234567890123456789012345678901",
  sourceAccountId: "j1234567890123456789012345678902",
};

test("the request subpath is a runtime export with the unchanged strict parser", () => {
  assert.deepEqual(
    parseWorkerRequest({ ...source, operation: "source.status" }),
    { ...source, operation: "source.status" },
  );
  assert.throws(
    () =>
      parseWorkerRequest({
        ...source,
        operation: "source.status",
        unexpected: true,
      }),
    WorkerProtocolParseError,
  );
  assert.deepEqual(
    parseWorkerProtocolErrorData({
      type: "worker_protocol_error",
      code: "lease_conflict",
    }),
    { type: "worker_protocol_error", code: "lease_conflict" },
  );
});

// ADM-4b. The two source-root operations, validated the way every other
// operation is: exact keys, a closed state and bounded sizes.
test("source.roots takes the envelope and nothing else", () => {
  assert.deepEqual(
    parseWorkerRequest({ ...source, operation: "source.roots" }),
    { ...source, operation: "source.roots" },
  );
  assert.throws(
    () =>
      parseWorkerRequest({
        ...source,
        operation: "source.roots",
        sourceRootId: "j1234567890123456789012345678903",
      }),
    WorkerProtocolParseError,
  );
});

// ADM-6a. The new read, and the half of its compatibility story that lives on
// the request side: an old server does not know the operation, and a parser
// that does not know an operation refuses it rather than guessing. That
// refusal is what the new watcher treats as "the server did not say", so this
// is the behaviour the watcher's fallback is built on.
test("source.itemCounts takes the envelope and nothing else, and an unknown operation is refused", () => {
  assert.deepEqual(
    parseWorkerRequest({ ...source, operation: "source.itemCounts" }),
    { ...source, operation: "source.itemCounts" },
  );
  for (const bad of [
    { ...source, operation: "source.itemCounts", rootAlias: "fixture" },
    { ...source, operation: "source.itemCounts", maxItems: 10 },
    // What an old server does with this request.
    { ...source, operation: "source.itemCountsX" },
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});

test("source.rootReport takes a closed state and a bounded count", () => {
  const report = {
    ...source,
    operation: "source.rootReport",
    sourceRootId: "j1234567890123456789012345678903",
    observedAt: 1_758_196_800_000,
    itemCount: 12,
    state: "ok",
  };
  assert.deepEqual(parseWorkerRequest(report), report);
  assert.deepEqual(
    parseWorkerRequest({ ...report, providerFolderId: "folder-9" }),
    { ...report, providerFolderId: "folder-9" },
  );
  const withoutState = { ...report };
  delete withoutState.state;
  for (const bad of [
    { ...report, state: "fine" },
    { ...report, state: "OK" },
    { ...report, itemCount: -1 },
    { ...report, itemCount: 1.5 },
    { ...report, itemCount: 100_000_001 },
    { ...report, observedAt: -1 },
    { ...report, providerFolderId: "" },
    { ...report, watcherId: "x" },
    withoutState,
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});

// ADM-9. The terminal outcome of one pass. Closed state, bounded counts, and a
// code that is a lower-case ASCII literal rather than free text -- the health
// screen renders it in a tooltip, so a path or a file name must be
// unrepresentable, not merely discouraged.
const outcome = {
  ...source,
  operation: "diagnostics.passOutcome",
  watcherId: "0f1e2d3c-4b5a-4968-8776-655443322110",
  state: "incomplete",
  scanned: 0,
  published: 0,
  finishedAt: 1_758_196_800_000,
};

test("diagnostics.passOutcome takes a closed state and a bounded code", () => {
  assert.deepEqual(parseWorkerRequest(outcome), outcome);
  const refused = { ...outcome, code: "root_contents_collapsed" };
  assert.deepEqual(parseWorkerRequest(refused), refused);
  const withoutState = { ...outcome };
  delete withoutState.state;
  const withoutScanned = { ...outcome };
  delete withoutScanned.scanned;
  for (const bad of [
    { ...outcome, state: "refused" },
    { ...outcome, state: "Complete" },
    // Never free text, never a path, never a file name.
    { ...outcome, code: "root contents collapsed" },
    { ...outcome, code: "/Users/someone/Finance/statement.pdf" },
    { ...outcome, code: "Statement.PDF" },
    { ...outcome, code: "a".repeat(65) },
    { ...outcome, code: "" },
    { ...outcome, scanned: -1 },
    { ...outcome, scanned: 1.5 },
    { ...outcome, published: 100_000_001 },
    { ...outcome, finishedAt: -1 },
    { ...outcome, watcherId: "not-a-uuid" },
    withoutState,
    withoutScanned,
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});

// Version skew, the half this package can assert. A new worker sends a field
// an old server has never heard of; that server's parser -- this one, with the
// operation's key list as it was -- refuses the whole request rather than
// ignoring the field, which is why the watcher's send is best-effort and its
// refusal never fails the pass.
test("an unknown field is refused rather than ignored, on every operation", () => {
  for (const request of [
    { ...source, operation: "source.status" },
    {
      ...source,
      operation: "diagnostics.heartbeat",
      watcherId: outcome.watcherId,
      connectorVersion: "1.2.3",
    },
    outcome,
  ]) {
    assert.deepEqual(parseWorkerRequest(request), request);
    assert.throws(
      () => parseWorkerRequest({ ...request, unexpectedFuture: 1 }),
      WorkerProtocolParseError,
    );
  }
  // And the other direction: an old worker that never sends the new operation
  // is parsed by the new server exactly as it was before.
  assert.deepEqual(
    parseWorkerRequest({ ...source, operation: "source.roots" }),
    { ...source, operation: "source.roots" },
  );
});

// ADM-10. `legacyWatcherId` on the heartbeat, and the skew it creates.
test("diagnostics.heartbeat takes an optional legacy watcher id", () => {
  const heartbeat = {
    ...source,
    operation: "diagnostics.heartbeat",
    watcherId: outcome.watcherId,
    connectorVersion: "1.2.3",
  };
  // Old worker to new server: the field is absent and nothing changes.
  assert.deepEqual(parseWorkerRequest(heartbeat), heartbeat);

  const withLegacy = {
    ...heartbeat,
    legacyWatcherId: "10000000-0000-4000-8000-000000000002",
  };
  assert.deepEqual(parseWorkerRequest(withLegacy), withLegacy);

  // Same shape rule as `watcherId`: a canonical UUID and nothing else, so it
  // can never smuggle a path or a host name into the column the health screen
  // renders.
  for (const bad of [
    { ...heartbeat, legacyWatcherId: "not-a-uuid" },
    { ...heartbeat, legacyWatcherId: "" },
    { ...heartbeat, legacyWatcherId: "/Users/someone/journal" },
    { ...heartbeat, legacyWatcherId: null },
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});

// ADM-10 review, finding 1. The per-process nonce that tells two live hosts
// sharing one copied journal apart.
test("diagnostics.heartbeat takes an optional per-process nonce", () => {
  const heartbeat = {
    ...source,
    operation: "diagnostics.heartbeat",
    watcherId: outcome.watcherId,
    connectorVersion: "1.2.3",
  };
  const withNonce = { ...heartbeat, heartbeatNonce: "a".repeat(32) };
  assert.deepEqual(parseWorkerRequest(withNonce), withNonce);

  // Both optional fields together, which is what a current worker sends.
  const both = {
    ...withNonce,
    legacyWatcherId: "10000000-0000-4000-8000-000000000002",
  };
  assert.deepEqual(parseWorkerRequest(both), both);

  // A closed shape, not a bounded string: the server stores it and it is one
  // join from the health screen, so a host name or a path must not fit.
  for (const bad of [
    { ...heartbeat, heartbeatNonce: "A".repeat(32) },
    { ...heartbeat, heartbeatNonce: "a".repeat(31) },
    { ...heartbeat, heartbeatNonce: "a".repeat(33) },
    { ...heartbeat, heartbeatNonce: "" },
    { ...heartbeat, heartbeatNonce: "worker-host.local".padEnd(32, "0") },
    { ...heartbeat, heartbeatNonce: null },
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});

test("diagnostics.heartbeat accepts only sorted unique allowed root aliases", () => {
  const heartbeat = {
    ...source,
    operation: "diagnostics.heartbeat",
    watcherId: outcome.watcherId,
    connectorVersion: "1.2.3",
  };
  const withAliases = {
    ...heartbeat,
    allowedRootAliases: ["documents", "photos"],
  };
  assert.deepEqual(parseWorkerRequest(withAliases), withAliases);

  for (const bad of [
    { ...heartbeat, allowedRootAliases: ["photos", "documents"] },
    { ...heartbeat, allowedRootAliases: ["documents", "documents"] },
    { ...heartbeat, allowedRootAliases: ["Documents"] },
    { ...heartbeat, allowedRootAliases: ["documents", "/private"] },
    { ...heartbeat, allowedRootAliases: null },
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});

const archivedIdentity = {
  sourceItemId: "j1234567890123456789012345678903",
  scanId: "j1234567890123456789012345678904",
  observationEpoch: 1,
  processingEpoch: 1,
  contentHash: "a".repeat(64),
  byteLength: 10,
  mediaType: "application/pdf",
  parserProfileId: "pdf_docqa_v1",
  parserFingerprint: "b".repeat(64),
  extractionConfigurationFingerprint: "c".repeat(64),
  extractorFingerprint: "docling-document-qa:v1",
  recordSchemaFingerprint: "no-records:v1",
  normalizationFingerprint: "docling-pages:v1",
  chunkerFingerprint: "page-aware:v1",
  correctionRevision: "correction:1",
};

test("discovery.recordPreview accepts bounded provisional metadata without a document page cap", () => {
  const request = {
    ...source,
    operation: "discovery.recordPreview",
    requestId: "preview-1",
    identity: archivedIdentity,
    preview: {
      previewFingerprint: "d".repeat(64),
      previewMethod: "pdf_native_text_v1",
      sourceFormat: "pdf",
      sourceUnitCount: 515,
      inspectedOriginalUnits: [1, 17, 515],
      provisionalMetadata: {
        title: "Synthetic tax bundle",
        documentKind: "tax_return",
        documentDate: { value: "2025", precision: "year" },
        uncertaintyCodes: ["cover_only", "mixed_bundle"],
      },
      confidence: 0.8,
    },
  };
  assert.deepEqual(parseWorkerRequest(request), request);
  const unknownUnits = {
    ...request,
    preview: {
      ...request.preview,
      previewMethod: "binary_metadata_v1",
      sourceFormat: "unknown",
      sourceUnitCount: null,
      inspectedOriginalUnits: [],
      provisionalMetadata: { uncertaintyCodes: ["unsupported"] },
      confidence: null,
    },
  };
  assert.deepEqual(parseWorkerRequest(unknownUnits), unknownUnits);
});

test("discovery.recordPreview rejects ambiguous unit coverage and open metadata", () => {
  const valid = {
    ...source,
    operation: "discovery.recordPreview",
    requestId: "preview-invalid",
    identity: archivedIdentity,
    preview: {
      previewFingerprint: "d".repeat(64),
      previewMethod: "pdf_native_text_v1",
      sourceFormat: "pdf",
      sourceUnitCount: 3,
      inspectedOriginalUnits: [1, 3],
      provisionalMetadata: { uncertaintyCodes: ["cover_only"] },
      confidence: 0.5,
    },
  };
  const previews = [
    { ...valid.preview, sourceUnitCount: null },
    { ...valid.preview, inspectedOriginalUnits: [3, 1] },
    { ...valid.preview, inspectedOriginalUnits: [1, 1] },
    { ...valid.preview, inspectedOriginalUnits: [1, 4] },
    {
      ...valid.preview,
      inspectedOriginalUnits: Array.from(
        { length: 257 },
        (_, index) => index + 1,
      ),
      sourceUnitCount: 257,
    },
    { ...valid.preview, confidence: 1.01 },
    {
      ...valid.preview,
      provisionalMetadata: { arbitraryModelOutput: "not allowed" },
    },
    {
      ...valid.preview,
      provisionalMetadata: {
        uncertaintyCodes: ["mixed_bundle", "cover_only"],
      },
    },
  ];
  for (const preview of previews) {
    assert.throws(
      () => parseWorkerRequest({ ...valid, preview }),
      WorkerProtocolParseError,
    );
  }
});

test("targeted tax batches are closed, original-page bound and transport bounded", () => {
  const begin = {
    ...source,
    operation: "extraction.beginTargetedTax",
    requestId: "target-begin",
    sourceItemId: "j1234567890123456789012345678903",
    sourceRevisionId: "j1234567890123456789012345678904",
    observedContentHash: "a".repeat(64),
    goalKind: "form_1040_totals_v1",
    instanceKey: "primary-return",
    requiredFields: ["tax_year", "total_tax"],
    optionalFields: ["amount_owed"],
    sourcePageCount: 500,
    requestDigest: "b".repeat(64),
  };
  assert.deepEqual(parseWorkerRequest(begin), begin);
  const artifact = {
    artifactKind: "selective_pdf_pages_v1",
    sourceSha256: "a".repeat(64),
    selectedPdfSha256: "c".repeat(64),
    sourcePageCount: 500,
    originalPages: [137, 138],
    coverageFingerprint: "d".repeat(64),
    artifactFingerprint: "e".repeat(64),
    parserFingerprint: "parser-v1",
    extractionFingerprint: "extract-v1",
  };
  const append = {
    ...source,
    operation: "extraction.appendTargetedTaxBatch",
    requestId: "target-append",
    targetId: "j1234567890123456789012345678905",
    sourceRevisionId: begin.sourceRevisionId,
    batchOrdinal: 0,
    artifact,
    coverage: {
      formFamily: "form_1040",
      requestedRegionsClosed: false,
      continuationsClosed: false,
    },
    pages: [
      { originalPage: 137, text: "Form 1040", textHash: "f".repeat(64) },
      { originalPage: 138, text: "Total tax", textHash: "0".repeat(64) },
    ],
  };
  assert.deepEqual(parseWorkerRequest(append), append);
  for (const bad of [
    { ...append, artifact: { ...artifact, originalPages: [138, 137] } },
    { ...append, pages: [...append.pages].reverse() },
    { ...append, pages: [{ ...append.pages[0], originalPage: true }] },
    { ...append, coverage: { ...append.coverage, continuationsClosed: "yes" } },
    { ...append, pages: append.pages.concat(Array(11).fill(append.pages[1])) },
    { ...begin, requiredFields: ["tax_year"], optionalFields: ["tax_year"] },
    { ...begin, goalKind: "generic_tax_v1" },
  ]) assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
});

const archivedAdmissionReceipt = (subjectKind, copyRole, suffix) => ({
  kind: "create",
  subjectKind,
  copyRole,
  clientReceiptId: `01890a5d-ac96-7cc4-bb7e-6f4f5ca5c1${suffix}`,
  archiveProfileFingerprint: "1".repeat(64),
  archiveIdentityFingerprint: "2".repeat(64),
  recipientFingerprint: "3".repeat(64),
  repositoryKeyDomainFingerprint: "4".repeat(64),
  storageFailureDomainFingerprint: "5".repeat(64),
  archiveObjectId: `01890a5d-ac96-7cc4-bb7e-6f4f5ca5d1${suffix}`,
  ciphertextHash: "6".repeat(64),
  ciphertextByteLength: 32,
  readbackVerifiedAt: 1_758_196_800_000,
  createdAt: 1_758_196_800_000,
});

const providerV2Admission = {
  ...source,
  operation: "discovery.admitArchived",
  requestId: "provider-v2-admission",
  workId: "j1234567890123456789012345678903",
  leaseEpoch: 1,
  leaseToken: "7".repeat(64),
  parserArtifact: {
    kind: "create",
    clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
    outputHash: "8".repeat(64),
    outputByteLength: 20,
    outputMediaType: "application/vnd.docling+json",
    createdAt: 1_758_196_800_000,
  },
  archives: [archivedAdmissionReceipt("parser_output", "primary", "41")],
  parsedText: {
    extractionFingerprint: "9".repeat(64),
    textHash: "a".repeat(64),
    byteLength: 8,
    utf16Length: 8,
    pageCount: 1,
    mappingManifestHash: "b".repeat(64),
    normalizedBundleDigest: "c".repeat(64),
    expectedEvidenceSpanCount: 1,
    expectedDocumentCount: 1,
    expectedChunkCount: 1,
  },
  providerOriginal: {
    referenceVersion: "provider_original_v2",
    providerKind: "dropbox_v1",
    clientReferenceId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c149",
    sourceContentHash: "d".repeat(64),
    sourceByteLength: 10,
    providerAccountIdHash: "e".repeat(64),
    providerRootDirectoryIdHash: "f".repeat(64),
    providerFileIdHash: "0".repeat(64),
    providerRevision: "rev-synthetic-provider",
    providerContentHash: "1".repeat(64),
    verifiedAt: 1_758_196_800_000,
    createdAt: 1_758_196_800_000,
  },
};

test("provider original v2 admits exactly one parser primary and no locator bundle", () => {
  assert.deepEqual(parseWorkerRequest(providerV2Admission), providerV2Admission);
  assert.throws(
    () =>
      parseWorkerRequest({
        ...providerV2Admission,
        providerOriginal: {
          ...providerV2Admission.providerOriginal,
          locatorBundle: {},
        },
      }),
    WorkerProtocolParseError,
  );
  assert.throws(
    () =>
      parseWorkerRequest({
        ...providerV2Admission,
        archives: [
          archivedAdmissionReceipt("original_bytes", "primary", "42"),
          ...providerV2Admission.archives,
          archivedAdmissionReceipt(
            "parser_output",
            "independent_backup",
            "43",
          ),
        ],
      }),
    WorkerProtocolParseError,
  );
});

test("existing provider original selection binds archive cardinality to its version", () => {
  const { providerOriginal: _, ...base } = providerV2Admission;
  const selectedV2 = {
    ...base,
    existingProviderOriginal: {
      referenceVersion: "provider_original_v2",
      referenceId: "j1234567890123456789012345678904",
      bindingEpoch: 0,
    },
  };
  assert.deepEqual(parseWorkerRequest(selectedV2), selectedV2);
  assert.throws(
    () =>
      parseWorkerRequest({
        ...selectedV2,
        existingProviderOriginal: {
          referenceId: "j1234567890123456789012345678904",
          bindingEpoch: 0,
        },
      }),
    WorkerProtocolParseError,
  );
  const selectedV1 = {
    ...base,
    archives: [
      archivedAdmissionReceipt("original_bytes", "primary", "42"),
      ...base.archives,
      archivedAdmissionReceipt(
        "parser_output",
        "independent_backup",
        "43",
      ),
    ],
    existingProviderOriginal: {
      referenceId: "j1234567890123456789012345678904",
      bindingEpoch: 0,
    },
  };
  assert.deepEqual(parseWorkerRequest(selectedV1), selectedV1);
  const explicitV1 = {
    ...selectedV1,
    existingProviderOriginal: {
      ...selectedV1.existingProviderOriginal,
      referenceVersion: "provider_original_v1",
    },
  };
  assert.deepEqual(parseWorkerRequest(explicitV1), explicitV1);
});

test("provider original v2 detach acknowledgement is locator-free and closed", () => {
  const request = {
    ...source,
    operation: "providerOriginal.ackDetach",
    requestId: "provider-v2-detach",
    sourceItemId: "j1234567890123456789012345678903",
    expectedForgetEpoch: 1,
    detachId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
    referenceId: "j1234567890123456789012345678904",
    referenceVersion: "provider_original_v2",
    referenceOutcome: "detached",
    providerSourceOutcome: "retained_unchanged",
  };
  assert.deepEqual(parseWorkerRequest(request), request);
  assert.throws(
    () => parseWorkerRequest({ ...request, locatorObjectName: "forbidden.age" }),
    WorkerProtocolParseError,
  );
});
