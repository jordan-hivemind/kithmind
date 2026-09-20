import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { validateArchiveRelocationConfig } from "../dist/archiveRelocationConfig.js";

import {
  journalBindingForConfig,
  parseConfig,
  validateEndpoint,
} from "../dist/config.js";
import {
  PDF_DOCQA_CHUNKING_FINGERPRINT,
  PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT,
} from "../dist/parsedBundleMapping.js";
import { HttpWorkerTransport, parseWorkerResponse } from "../dist/transport.js";
import { MAX_WORKER_SCAN_ENTRIES } from "@repo/worker-protocol/request";

test("config accepts only bounded absolute worker config", () => {
  const config = parseConfig({
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space_1",
    sourceAccountId: "source_1",
    credentialEnv: "PIPELINE_TOKEN",
    roots: [{ alias: "notes", path: "/tmp/notes" }],
    journalDir: "/tmp/journal",
  });
  assert.equal(config.maxFiles, 256);
  assert.equal(config.assessmentPacingMs, undefined);
  assert.throws(() => validateEndpoint("http://example.test/api/worker"));
  assert.throws(() =>
    parseConfig({ ...config, roots: [{ alias: "notes", path: "relative" }] }),
  );
});

test("config accepts a bounded assessment pacing delay", () => {
  const base = {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space_1",
    sourceAccountId: "source_1",
    credentialEnv: "PIPELINE_TOKEN",
    roots: [{ alias: "notes", path: "/tmp/notes" }],
    journalDir: "/tmp/journal",
  };
  assert.equal(
    parseConfig({ ...base, assessmentPacingMs: 250 }).assessmentPacingMs,
    250,
  );
  assert.throws(() => parseConfig({ ...base, assessmentPacingMs: -1 }));
  assert.throws(() => parseConfig({ ...base, assessmentPacingMs: 300_001 }));
});

test("config accepts only bounded normalized exact-file roots", () => {
  const base = {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space_1",
    sourceAccountId: "source_1",
    credentialEnv: "PIPELINE_TOKEN",
    roots: [
      {
        alias: "notes",
        path: "/tmp/notes",
        includeFiles: ["reports/zeta.pdf", "reports/alpha.pdf"],
      },
    ],
    journalDir: "/tmp/journal",
  };
  const parsed = parseConfig(base);
  assert.deepEqual(parsed.roots[0].includeFiles, [
    "reports/alpha.pdf",
    "reports/zeta.pdf",
  ]);
  const reversed = structuredClone(base);
  reversed.roots[0].includeFiles.reverse();
  assert.equal(
    journalBindingForConfig(parseConfig(reversed)).configFingerprint,
    journalBindingForConfig(parsed).configFingerprint,
  );
  const unrestricted = structuredClone(base);
  delete unrestricted.roots[0].includeFiles;
  assert.notEqual(
    journalBindingForConfig(parseConfig(unrestricted)).configFingerprint,
    journalBindingForConfig(parsed).configFingerprint,
  );
  for (const includeFiles of [
    [],
    ["reports/alpha.pdf", "reports/alpha.pdf"],
    ["reports", "reports/alpha.pdf"],
    ["reports", "reports-old/alpha.pdf", "reports/alpha.pdf"],
    ["/reports/alpha.pdf"],
    ["reports//alpha.pdf"],
    ["reports/../alpha.pdf"],
    ["reports\\alpha.pdf"],
    [" reports/alpha.pdf"],
    ["reports/alpha.pdf "],
    [`reports/${"a".repeat(2_048)}.pdf`],
    Array.from({ length: 257 }, (_, index) => `report-${index}.pdf`),
  ]) {
    const invalid = structuredClone(base);
    invalid.roots[0].includeFiles = includeFiles;
    assert.throws(() => parseConfig(invalid));
  }
  const unknown = structuredClone(base);
  unknown.roots[0].includeGlobs = ["reports/*.pdf"];
  assert.throws(() => parseConfig(unknown));
});

function pdfDocQaConfig() {
  const digest = "a".repeat(64);
  const archiveIdentity = {
    archiveProfileFingerprint: digest,
    archiveIdentityFingerprint: digest,
    recipientFingerprint: digest,
    repositoryKeyDomainFingerprint: digest,
    storageFailureDomainFingerprint: digest,
  };
  return {
    captureDirectory: "/private/captures",
    parserOutputRoot: "/private/outputs",
    spoolDirectory: "/private/spool",
    parser: {
      pythonExecutable: "/tools/python",
      expectedPythonSha256: digest,
      launcherPath: "/parser/launcher.py",
      expectedLauncherSha256: digest,
      packageRoot: "/parser/package",
      modelAssetsPath: "/parser/models",
      modelLockPath: "/parser/model-lock.json",
      expectedModelLockSha256: digest,
    },
    profile: {
      parserProfileId: "pdf_docqa_v1",
      parserFingerprint: digest,
      extractionConfigurationFingerprint: digest,
      extractorFingerprint: "extractor-v1",
      recordSchemaFingerprint: "records-disabled-v1",
      normalizationFingerprint: "normalization-v1",
      chunkerFingerprint: PDF_DOCQA_CHUNKING_FINGERPRINT,
      correctionRevision: "correction-v1",
    },
    archive: {
      ageBinary: "/tools/age",
      primary: {
        directory: "/private/archive-primary",
        recipient: `age1pq1${"q".repeat(40)}`,
        ...archiveIdentity,
      },
      independentBackup: {
        directory: "/private/archive-backup",
        recipient: `age1pq1${"p".repeat(40)}`,
        resticBinary: "/tools/restic",
        repositoryPath: "/private/repository",
        expectedRepositoryId: digest,
        passwordCommand: {
          executable: "/tools/password-selector",
          publicArgs: ["selector-v1"],
        },
        host: "worker_host",
        ...archiveIdentity,
      },
    },
  };
}

test("archive relocation permits only a remote root path change", () => {
  const pdf = pdfDocQaConfig();
  delete pdf.archive.independentBackup.repositoryPath;
  pdf.archive.independentBackup.repository = {
    kind: "rclone_dropbox_v1",
    remoteName: "test_dropbox",
    rootPath: "Legacy/backups",
    rcloneBinary: "/tools/rclone",
    configPath: "/credentials/rclone.conf",
    configIdentityFingerprint: "c".repeat(64),
    expectedRootDirectoryIdHash: "d".repeat(64),
  };
  const before = parseConfig({
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space_1",
    sourceAccountId: "source_1",
    credentialEnv: "PIPELINE_TOKEN",
    roots: [{ alias: "notes", path: "/tmp/root" }],
    journalDir: "/tmp/journal",
    pdfDocQa: pdf,
  });
  const after = structuredClone(before);
  after.pdfDocQa.archive.independentBackup.repository.rootPath =
    "Managed/backups";
  const result = validateArchiveRelocationConfig(before, after);
  assert.deepEqual(result.previousBinding, journalBindingForConfig(before));
  assert.deepEqual(result.proposedBinding, journalBindingForConfig(after));
  assert.notEqual(
    result.previousBinding.configFingerprint,
    result.proposedBinding.configFingerprint,
  );
  assert.equal(
    before.pdfDocQa.archive.independentBackup.repository.rootPath,
    "Legacy/backups",
  );
  assert.throws(() => validateArchiveRelocationConfig(before, before));
  for (const mutate of [
    (value) => {
      value.spaceId = "other";
    },
    (value) => {
      value.credentialEnv = "OTHER_TOKEN";
    },
    (value) => {
      value.maxFiles += 1;
    },
    (value) => {
      value.roots[0].path = "/tmp/other";
    },
    (value) => {
      value.journalDir = "/tmp/other-journal";
    },
    (value) => {
      value.pdfDocQa.archive.independentBackup.expectedRepositoryId =
        "b".repeat(64);
    },
    (value) => {
      value.pdfDocQa.archive.independentBackup.repository.expectedRootDirectoryIdHash =
        "b".repeat(64);
    },
    (value) => {
      value.pdfDocQa.archive.independentBackup.repository.configIdentityFingerprint =
        "b".repeat(64);
    },
    (value) => {
      value.pdfDocQa.archive.independentBackup.repository.rootPath =
        "../escape";
    },
  ]) {
    const changed = structuredClone(after);
    mutate(changed);
    assert.throws(() => validateArchiveRelocationConfig(before, changed));
  }
});

test("PDF document-Q&A config is closed, bound, and keeps legacy bindings stable", () => {
  const base = {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space_1",
    sourceAccountId: "source_1",
    credentialEnv: "PIPELINE_TOKEN",
    roots: [{ alias: "notes", path: "/tmp/root" }],
    journalDir: "/tmp/journal",
  };
  const legacy = parseConfig(base);
  const legacyPreimage = JSON.stringify({
    endpoint: legacy.endpoint,
    spaceId: legacy.spaceId,
    sourceAccountId: legacy.sourceAccountId,
    roots: legacy.roots,
  });
  assert.equal(
    journalBindingForConfig(legacy).configFingerprint,
    createHash("sha256").update(legacyPreimage).digest("hex"),
  );
  const pdf = parseConfig({ ...base, pdfDocQa: pdfDocQaConfig() });
  assert.equal(
    pdf.pdfDocQa.profile.chunkerFingerprint,
    PDF_DOCQA_CHUNKING_FINGERPRINT,
  );
  assert.equal(pdf.pdfDocQa.parser.tableStructure, undefined);
  const historicalPdf = structuredClone(pdf);
  delete historicalPdf.pdfDocQa.parser.tableStructure;
  const historicalPdfPreimage = JSON.stringify({
    endpoint: historicalPdf.endpoint,
    spaceId: historicalPdf.spaceId,
    sourceAccountId: historicalPdf.sourceAccountId,
    roots: historicalPdf.roots,
    pdfDocQa: historicalPdf.pdfDocQa,
  });
  assert.equal(
    journalBindingForConfig(pdf).configFingerprint,
    createHash("sha256").update(historicalPdfPreimage).digest("hex"),
  );
  const tableOff = pdfDocQaConfig();
  tableOff.parser.tableStructure = "off";
  const explicitTableOff = parseConfig({ ...base, pdfDocQa: tableOff });
  assert.equal(explicitTableOff.pdfDocQa.parser.tableStructure, "off");
  assert.notEqual(
    journalBindingForConfig(explicitTableOff).configFingerprint,
    journalBindingForConfig(pdf).configFingerprint,
  );
  const invalidTableStructure = pdfDocQaConfig();
  invalidTableStructure.parser.tableStructure = "automatic";
  assert.throws(() =>
    parseConfig({ ...base, pdfDocQa: invalidTableStructure }),
  );
  const archivedProfile = pdfDocQaConfig();
  archivedProfile.profile.chunkerFingerprint =
    PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT;
  assert.equal(
    parseConfig({ ...base, pdfDocQa: archivedProfile }).pdfDocQa.profile
      .chunkerFingerprint,
    PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT,
  );
  assert.notEqual(
    journalBindingForConfig(pdf).configFingerprint,
    journalBindingForConfig(legacy).configFingerprint,
  );
  const remotePdf = pdfDocQaConfig();
  delete remotePdf.archive.independentBackup.repositoryPath;
  remotePdf.archive.independentBackup.repository = {
    kind: "rclone_dropbox_v1",
    remoteName: "kithmind_dropbox",
    rootPath: "Kith Mind Backups/Processing",
    rcloneBinary: "/tools/rclone",
    configPath: "/credentials/kithmind-rclone.conf",
    configIdentityFingerprint: "c".repeat(64),
    expectedRootDirectoryIdHash: "d".repeat(64),
  };
  const parsedRemote = parseConfig({ ...base, pdfDocQa: remotePdf });
  assert.deepEqual(
    parsedRemote.pdfDocQa.archive.independentBackup.repository,
    remotePdf.archive.independentBackup.repository,
  );
  assert.notEqual(
    journalBindingForConfig(parsedRemote).configFingerprint,
    journalBindingForConfig(pdf).configFingerprint,
  );
  const providerPdf = structuredClone(remotePdf);
  const providerRootId = "id:synthetic_root";
  providerPdf.providerOriginal = {
    rootAlias: "notes",
    providerRootDirectoryId: providerRootId,
    providerAccountIdHash: "e".repeat(64),
    providerRootDirectoryIdHash: createHash("sha256")
      .update(providerRootId)
      .digest("hex"),
    refreshPath: "Kith Mind/Inbox",
    registryDirectory: "/private/provider-registry",
  };
  const parsedProvider = parseConfig({ ...base, pdfDocQa: providerPdf });
  // ADM-4c: the pre-ADM-4c single-root shape is accepted verbatim and becomes
  // a one-element `roots`, so the owner's config file needs no edit.
  assert.deepEqual(parsedProvider.pdfDocQa.providerOriginal.roots, [
    {
      rootAlias: "notes",
      providerRootDirectoryId: providerRootId,
      providerRootDirectoryIdHash: createHash("sha256")
        .update(providerRootId)
        .digest("hex"),
    },
  ]);
  assert.equal(parsedProvider.pdfDocQa.providerOriginal.rootAlias, undefined);
  assert.notEqual(
    journalBindingForConfig(parsedProvider).configFingerprint,
    journalBindingForConfig(parsedRemote).configFingerprint,
  );
  const invalidProvider = structuredClone(providerPdf);
  invalidProvider.providerOriginal.providerRootDirectoryIdHash = "f".repeat(64);
  assert.throws(() => parseConfig({ ...base, pdfDocQa: invalidProvider }));
  const singleSegmentRefreshPath = structuredClone(providerPdf);
  singleSegmentRefreshPath.providerOriginal.refreshPath = "Inbox";
  assert.equal(
    parseConfig({ ...base, pdfDocQa: singleSegmentRefreshPath }).pdfDocQa
      .providerOriginal.refreshPath,
    "Inbox",
  );
  for (const refreshPath of [
    "",
    "/Inbox",
    "Inbox/",
    "Inbox/..",
    "..",
    "Inbox ",
    "Inbox\u0000",
    "a".repeat(513),
  ]) {
    const invalidRefreshPath = structuredClone(providerPdf);
    invalidRefreshPath.providerOriginal.refreshPath = refreshPath;
    assert.throws(() => parseConfig({ ...base, pdfDocQa: invalidRefreshPath }));
  }
  const invalidRemote = structuredClone(remotePdf);
  invalidRemote.archive.independentBackup.repository.rootPath =
    "Kith Mind Backups/../Processing";
  assert.throws(() => parseConfig({ ...base, pdfDocQa: invalidRemote }));
  const extraRemote = structuredClone(remotePdf);
  extraRemote.archive.independentBackup.repository.endpoint = "custom";
  assert.throws(() => parseConfig({ ...base, pdfDocQa: extraRemote }));
  assert.throws(() =>
    parseConfig({
      ...base,
      pdfDocQa: {
        ...pdfDocQaConfig(),
        profile: {
          ...pdfDocQaConfig().profile,
          chunkerFingerprint: "b".repeat(64),
        },
      },
    }),
  );
  assert.throws(() =>
    parseConfig({
      ...base,
      pdfDocQa: {
        ...pdfDocQaConfig(),
        captureDirectory: "/",
      },
    }),
  );
  assert.throws(() => {
    const pdfDocQa = pdfDocQaConfig();
    return parseConfig({
      ...base,
      pdfDocQa: {
        ...pdfDocQa,
        parser: {
          ...pdfDocQa.parser,
          packageRoot: "/private/captures/parser-package",
        },
      },
    });
  });
  assert.throws(() => {
    const pdfDocQa = pdfDocQaConfig();
    return parseConfig({
      ...base,
      pdfDocQa: {
        ...pdfDocQa,
        parser: {
          ...pdfDocQa.parser,
          launcherPath: "/tmp/root/launcher.py",
        },
      },
    });
  });
  assert.throws(() => {
    const pdfDocQa = pdfDocQaConfig();
    return parseConfig({
      ...base,
      pdfDocQa: {
        ...pdfDocQa,
        archive: {
          ...pdfDocQa.archive,
          independentBackup: {
            ...pdfDocQa.archive.independentBackup,
            passwordCommand: { executable: "/private/spool/selector" },
          },
        },
      },
    });
  });
  assert.throws(() =>
    parseConfig({
      ...base,
      pdfDocQa: {
        ...pdfDocQaConfig(),
        captureDirectory: "/tmp/root/captures",
      },
    }),
  );
  assert.throws(() => {
    const pdfDocQa = pdfDocQaConfig();
    return parseConfig({
      ...base,
      pdfDocQa: {
        ...pdfDocQa,
        archive: {
          ...pdfDocQa.archive,
          independentBackup: {
            ...pdfDocQa.archive.independentBackup,
            recipient: pdfDocQa.archive.primary.recipient,
          },
        },
      },
    });
  });
  assert.throws(() =>
    parseConfig({
      ...base,
      pdfDocQa: {
        ...pdfDocQaConfig(),
        archive: {
          ...pdfDocQaConfig().archive,
          independentBackup: {
            ...pdfDocQaConfig().archive.independentBackup,
            directory: "/private/archive-primary",
          },
        },
      },
    }),
  );
  assert.throws(() =>
    parseConfig({
      ...base,
      pdfDocQa: {
        ...pdfDocQaConfig(),
        profile: { ...pdfDocQaConfig().profile, unexpected: true },
      },
    }),
  );
});

test("PDF table structure bypass policy is bounded, canonical, and bound", () => {
  const base = {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space_1",
    sourceAccountId: "source_1",
    credentialEnv: "PIPELINE_TOKEN",
    roots: [{ alias: "notes", path: "/tmp/root" }],
    journalDir: "/tmp/journal",
  };
  const first = "b".repeat(64);
  const second = "a".repeat(64);
  const omitted = parseConfig({ ...base, pdfDocQa: pdfDocQaConfig() });
  const omittedHistorical = structuredClone(omitted);
  delete omittedHistorical.pdfDocQa.parser.tableStructure;
  assert.equal(
    journalBindingForConfig(omitted).configFingerprint,
    createHash("sha256")
      .update(
        JSON.stringify({
          endpoint: omittedHistorical.endpoint,
          spaceId: omittedHistorical.spaceId,
          sourceAccountId: omittedHistorical.sourceAccountId,
          roots: omittedHistorical.roots,
          pdfDocQa: omittedHistorical.pdfDocQa,
        }),
      )
      .digest("hex"),
  );
  assert.equal("tableStructureBypass" in omitted.pdfDocQa.parser, false);

  const withPolicy = pdfDocQaConfig();
  withPolicy.parser.tableStructureBypass = {
    [first]: [2, 7],
    [second]: [1, 4],
  };
  const normalized = parseConfig({ ...base, pdfDocQa: withPolicy });
  assert.deepEqual(normalized.pdfDocQa.parser.tableStructureBypass, {
    [second]: [1, 4],
    [first]: [2, 7],
  });
  assert.notEqual(
    journalBindingForConfig(normalized).configFingerprint,
    journalBindingForConfig(omitted).configFingerprint,
  );
  const reordered = pdfDocQaConfig();
  reordered.parser.tableStructureBypass = {
    [second]: [1, 4],
    [first]: [2, 7],
  };
  assert.equal(
    journalBindingForConfig(parseConfig({ ...base, pdfDocQa: reordered }))
      .configFingerprint,
    journalBindingForConfig(normalized).configFingerprint,
  );

  const invalidPolicies = [
    {},
    { ["A".repeat(64)]: [1] },
    { [first]: [] },
    { [first]: [1, 1] },
    { [first]: [2, 1] },
    { [first]: [0] },
    { [first]: [65] },
    { [first]: [1.5] },
    { [first]: [true] },
    { [first]: [1, , 3] },
    Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [
        index.toString(16).padStart(64, "0"),
        [1],
      ]),
    ),
    { [first]: Array.from({ length: 65 }, (_, index) => index + 1) },
  ];
  for (const tableStructureBypass of invalidPolicies) {
    const invalid = pdfDocQaConfig();
    invalid.parser.tableStructureBypass = tableStructureBypass;
    assert.throws(() => parseConfig({ ...base, pdfDocQa: invalid }));
  }
  const conflict = pdfDocQaConfig();
  conflict.parser.tableStructure = "off";
  conflict.parser.tableStructureBypass = { [first]: [1] };
  assert.throws(() => parseConfig({ ...base, pdfDocQa: conflict }));
});

test("transport response parser rejects extra and malformed success fields", () => {
  const valid = JSON.stringify({
    operation: "scan.begin",
    scanId: "scan",
    inventoryEpoch: 1,
    manifestVersion: 1,
    state: "open",
    reused: false,
  });
  assert.equal(
    parseWorkerResponse(valid, "scan.begin").operation,
    "scan.begin",
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({
        operation: "scan.begin",
        scanId: "scan",
        inventoryEpoch: 1,
        manifestVersion: 1,
        state: "open",
        reused: false,
        leaked: true,
      }),
      "scan.begin",
    ),
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({ error: { code: "unknown", message: "no" } }),
      "scan.begin",
    ),
  );
});

test("scan append accepts optional epochs on needs_review and ignored_forgotten entries", () => {
  const page = {
    operation: "scan.appendPage",
    scanId: "scan",
    ordinal: 0,
    reused: false,
    entries: [
      {
        state: "needs_review",
        sourceItemId: "review-item",
        observationEpoch: 2,
        processingEpoch: 3,
      },
      { state: "ignored_forgotten", sourceItemId: "forgotten-item" },
    ],
  };
  assert.equal(
    parseWorkerResponse(JSON.stringify(page), "scan.appendPage").operation,
    "scan.appendPage",
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({
        ...page,
        entries: [{ ...page.entries[0], observationEpoch: 1.5 }],
      }),
      "scan.appendPage",
    ),
  );
});

test("strict response parsing rejects malformed status, assessment, and lease targets", () => {
  const baseStatus = {
    operation: "source.status",
    sourceAccountId: "source",
    inventoryEpoch: 1,
    completedInventoryEpoch: 1,
    manifestVersion: 1,
    enumeration: { state: "complete", completedAt: 1 },
    processing: { state: "not_assessed" },
    recordCoverage: "not_established",
  };
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({ ...baseStatus, enumeration: { state: "mystery" } }),
      "source.status",
    ),
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({
        ...baseStatus,
        processing: {
          state: "complete",
          assessmentId: "assessment",
          scanId: "scan",
          inventoryEpoch: 1,
          manifestVersion: 1,
          completedAt: 1,
          counts: {
            items: { ready: -1 },
            unresolvedEntries: { needsReview: 0, ignoredForgotten: 0 },
          },
        },
      }),
      "source.status",
    ),
  );
  const reserve = {
    operation: "jobs.reserve",
    receiptId: "receipt",
    expiresAt: 1,
    reused: false,
    targets: [
      {
        jobId: "job",
        workId: "work",
        sourceItemId: "item",
        observationEpoch: 1,
        processingEpoch: 1,
        state: "processing",
        leaseEpoch: 1,
        leaseToken: "a".repeat(64),
        leaseExpiresAt: 1,
      },
    ],
  };
  for (const change of [
    { jobId: "contains/slash" },
    { state: "queued" },
    { leaseEpoch: -1 },
    { leaseToken: "secret" },
  ]) {
    assert.throws(() =>
      parseWorkerResponse(
        JSON.stringify({
          ...reserve,
          targets: [{ ...reserve.targets[0], ...change }],
        }),
        "jobs.reserve",
      ),
    );
  }
});

test("safe errors retain only an allowlisted code", () => {
  const parsed = parseWorkerResponse(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message: "reflected bearer and document body must not persist",
      },
    }),
    "scan.begin",
  );
  assert.deepEqual(parsed, { error: { code: "rate_limited" } });
  assert.equal(JSON.stringify(parsed).includes("reflected"), false);
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({
        error: { code: "rate_limited", message: "safe", detail: "leak" },
      }),
      "scan.begin",
    ),
  );
});

test("archive forget responses bind the source hash, epoch, receipt, and acknowledgement", () => {
  const target = {
    receiptId: "receipt_1",
    clientReceiptId: "11111111-1111-4111-8111-111111111111",
    receiptRequestDigest: "1".repeat(64),
    subjectKind: "original_bytes",
    copyRole: "primary",
    archiveIdentityFingerprint: "2".repeat(64),
    archiveObjectId: "22222222-2222-4222-8222-222222222222",
    ciphertextHash: "3".repeat(64),
    ciphertextByteLength: 100,
    forgetEpoch: 4,
    ack: {
      deletionId: "33333333-3333-4333-8333-333333333333",
      receiptId: "receipt_1",
      forgetEpoch: 4,
      objectOutcome: "deleted",
      absenceAuthority: "worker_asserted_physical_absence",
      completedAt: 5,
    },
  };
  const page = {
    operation: "archive.forgetTargets",
    sourceItemId: "source_item",
    sourceExternalIdHash: "4".repeat(64),
    forgetEpoch: 4,
    targets: [target],
    isDone: true,
    continueCursor: "done",
  };
  assert.equal(
    parseWorkerResponse(JSON.stringify(page), page.operation).operation,
    page.operation,
  );
  for (const invalid of [
    { ...page, sourceExternalIdHash: "bad" },
    { ...page, targets: [{ ...target, forgetEpoch: 5 }] },
    {
      ...page,
      targets: [
        target,
        { ...target, archiveObjectId: "44444444-4444-4444-8444-444444444444" },
      ],
    },
    {
      ...page,
      targets: [
        {
          ...target,
          ack: { ...target.ack, backupOutcome: "deleted" },
        },
      ],
    },
  ])
    assert.throws(() =>
      parseWorkerResponse(JSON.stringify(invalid), page.operation),
    );
  const ack = {
    operation: "archive.ackDeletion",
    ...target.ack,
    reused: false,
  };
  assert.equal(
    parseWorkerResponse(JSON.stringify(ack), ack.operation).operation,
    ack.operation,
  );
  const liveTarget = {
    ...target,
    subjectKind: "parser_output",
    copyRole: "independent_backup",
    ack: {
      ...target.ack,
      backupOutcome: "deleted",
      absenceAuthority: "worker_asserted_live_repository_absence",
      retentionDisclosure: "provider_retained_deleted_history_possible",
    },
  };
  const livePage = { ...page, targets: [liveTarget] };
  assert.equal(
    parseWorkerResponse(JSON.stringify(livePage), livePage.operation).operation,
    livePage.operation,
  );
  assert.equal(
    parseWorkerResponse(
      JSON.stringify({
        operation: "archive.ackDeletion",
        ...liveTarget.ack,
        reused: false,
      }),
      "archive.ackDeletion",
    ).retentionDisclosure,
    "provider_retained_deleted_history_possible",
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({ ...ack, absenceAuthority: "filesystem_guess" }),
      ack.operation,
    ),
  );
  for (const invalid of [
    {
      ...ack,
      retentionDisclosure: "provider_retained_deleted_history_possible",
    },
    {
      ...ack,
      absenceAuthority: "worker_asserted_live_repository_absence",
      retentionDisclosure: "provider_retained_deleted_history_possible",
    },
    {
      ...ack,
      absenceAuthority: "worker_asserted_live_repository_absence",
    },
    {
      ...ack,
      absenceAuthority: "worker_asserted_live_repository_absence",
      retentionDisclosure: "physical_erasure_complete",
    },
  ])
    assert.throws(() =>
      parseWorkerResponse(
        JSON.stringify(invalid),
        invalid.operation ?? "archive.ackDeletion",
      ),
    );
  for (const inconsistentTarget of [
    { ...liveTarget, copyRole: "primary", ack: liveTarget.ack },
    { ...liveTarget, subjectKind: "original_bytes", ack: liveTarget.ack },
  ])
    assert.throws(() =>
      parseWorkerResponse(
        JSON.stringify({ ...page, targets: [inconsistentTarget] }),
        page.operation,
      ),
    );
});

test("provider original forget responses require exact retained-source disclosure", () => {
  const ack = {
    detachId: "11111111-1111-4111-8111-111111111111",
    referenceId: "reference_1",
    forgetEpoch: 3,
    referenceOutcome: "detached",
    locatorBundleOutcome: "deleted",
    locatorAbsenceAuthority: "worker_asserted_live_repository_absence",
    retentionDisclosure: "provider_retained_deleted_history_possible",
    providerSourceOutcome: "retained_unchanged",
    completedAt: 10,
  };
  const target = {
    referenceId: ack.referenceId,
    referenceFingerprint: "1".repeat(64),
    locatorBindingId: "22222222-2222-4222-8222-222222222222",
    locatorRepositoryId: "2".repeat(64),
    locatorSnapshotId: "3".repeat(64),
    locatorObjectName: "locator.age",
    locatorCiphertextHash: "4".repeat(64),
    locatorCiphertextByteLength: 500,
    forgetEpoch: 3,
    ack,
  };
  const page = {
    operation: "providerOriginal.forgetTargets",
    sourceItemId: "source_1",
    sourceExternalIdHash: "5".repeat(64),
    forgetEpoch: 3,
    targets: [target],
    isDone: true,
    continueCursor: "done",
  };
  assert.equal(
    parseWorkerResponse(JSON.stringify(page), page.operation).operation,
    page.operation,
  );
  const result = {
    operation: "providerOriginal.ackDetach",
    ...ack,
    reused: false,
  };
  assert.equal(
    parseWorkerResponse(JSON.stringify(result), result.operation)
      .providerSourceOutcome,
    "retained_unchanged",
  );
  for (const invalid of [
    { ...page, targets: [{ ...target, forgetEpoch: 4 }] },
    { ...page, targets: [{ ...target, locatorObjectName: "../locator.age" }] },
    {
      ...page,
      targets: [
        { ...target, ack: { ...ack, providerSourceOutcome: "deleted" } },
      ],
    },
    { ...result, retentionDisclosure: undefined },
    { ...result, locatorAbsenceAuthority: "worker_asserted_physical_absence" },
  ])
    assert.throws(() =>
      parseWorkerResponse(JSON.stringify(invalid), invalid.operation),
    );
});

test("archived discovery responses require exact closed B1 shapes", () => {
  const ids = {
    workId: "work",
    sourceItemId: "item",
    sourceRevisionId: "revision",
    parserArtifactId: "artifact",
    sourceTextVersionId: "text-version",
    processingGenerationId: "generation",
    ingestJobId: "job",
    originalPrimaryReceiptId: "original-primary",
    originalBackupReceiptId: "original-backup",
    parserPrimaryReceiptId: "parser-primary",
    parserBackupReceiptId: "parser-backup",
  };
  const hash = "a".repeat(64);
  const preflight = {
    operation: "discovery.preflightArchived",
    sourceItemId: ids.sourceItemId,
    workId: ids.workId,
    expectedDesiredProcessingEpoch: 1,
    archiveIntentDigest: hash,
  };
  const reserve = {
    operation: "discovery.reserveArchived",
    workId: ids.workId,
    sourceItemId: ids.sourceItemId,
    observationEpoch: 1,
    processingEpoch: 1,
    leaseEpoch: 1,
    leaseToken: hash,
    leaseExpiresAt: 2,
    reused: false,
  };
  const originalLookup = {
    operation: "discovery.lookupArchivedAdmission",
    mode: "original",
    found: true,
    sourceRevisionId: ids.sourceRevisionId,
    originalPrimaryReceiptId: ids.originalPrimaryReceiptId,
    originalPrimaryBindingEpoch: 0,
    originalBackupReceiptId: ids.originalBackupReceiptId,
    originalBackupBindingEpoch: 0,
  };
  const processingLookup = {
    operation: "discovery.lookupArchivedAdmission",
    mode: "processing",
    found: true,
    sourceRevisionId: ids.sourceRevisionId,
    parserArtifactId: ids.parserArtifactId,
    sourceTextVersionId: ids.sourceTextVersionId,
    processingGenerationId: ids.processingGenerationId,
    ingestJobId: ids.ingestJobId,
    desiredProcessingEpoch: 1,
    archiveSetDigest: hash,
    originalPrimaryReceiptId: ids.originalPrimaryReceiptId,
    originalPrimaryBindingEpoch: 0,
    originalBackupReceiptId: ids.originalBackupReceiptId,
    originalBackupBindingEpoch: 0,
    parserPrimaryReceiptId: ids.parserPrimaryReceiptId,
    parserPrimaryBindingEpoch: 0,
    parserBackupReceiptId: ids.parserBackupReceiptId,
    parserBackupBindingEpoch: 0,
  };
  const admit = {
    operation: "discovery.admitArchived",
    workId: ids.workId,
    sourceItemId: ids.sourceItemId,
    sourceRevisionId: ids.sourceRevisionId,
    parserArtifactId: ids.parserArtifactId,
    sourceTextVersionId: ids.sourceTextVersionId,
    processingGenerationId: ids.processingGenerationId,
    ingestJobId: ids.ingestJobId,
    desiredProcessingEpoch: 1,
    archiveSetDigest: hash,
    originalPrimaryReceiptId: ids.originalPrimaryReceiptId,
    originalPrimaryBindingEpoch: 0,
    originalBackupReceiptId: ids.originalBackupReceiptId,
    originalBackupBindingEpoch: 0,
    parserPrimaryReceiptId: ids.parserPrimaryReceiptId,
    parserPrimaryBindingEpoch: 0,
    parserBackupReceiptId: ids.parserBackupReceiptId,
    parserBackupBindingEpoch: 0,
    state: "admitted",
    reused: false,
  };
  for (const response of [
    preflight,
    reserve,
    originalLookup,
    processingLookup,
    admit,
  ]) {
    assert.equal(
      parseWorkerResponse(JSON.stringify(response), response.operation)
        .operation,
      response.operation,
    );
  }
  for (const response of [originalLookup, processingLookup, admit].map(
    (value) => {
      const provider = {
        ...value,
        originalProviderReferenceId: "provider-reference",
        originalProviderBindingEpoch: 1,
      };
      delete provider.originalBackupReceiptId;
      delete provider.originalBackupBindingEpoch;
      return provider;
    },
  ))
    assert.equal(
      parseWorkerResponse(JSON.stringify(response), response.operation)
        .originalProviderReferenceId,
      "provider-reference",
    );
  assert.equal(
    parseWorkerResponse(
      JSON.stringify({
        operation: "discovery.lookupArchivedAdmission",
        mode: "processing",
        found: false,
      }),
      "discovery.lookupArchivedAdmission",
    ).operation,
    "discovery.lookupArchivedAdmission",
  );
  for (const [response, operation] of [
    [{ ...preflight, leaked: true }, preflight.operation],
    [{ ...reserve, leaseToken: "not-a-token" }, reserve.operation],
    [
      { ...originalLookup, originalPrimaryBindingEpoch: -1 },
      originalLookup.operation,
    ],
    [
      { ...processingLookup, archiveSetDigest: "not-a-digest" },
      processingLookup.operation,
    ],
    [{ ...admit, state: "queued" }, admit.operation],
    [
      {
        ...admit,
        originalProviderReferenceId: "provider-reference",
        originalProviderBindingEpoch: 1,
      },
      admit.operation,
    ],
  ]) {
    assert.throws(() =>
      parseWorkerResponse(JSON.stringify(response), operation),
    );
  }
});

test("parsed job responses require closed B2 phases, counts, and leases", () => {
  const target = {
    jobId: "job",
    workId: "work",
    sourceItemId: "item",
    observationEpoch: 1,
    processingEpoch: 1,
    state: "processing",
    leaseEpoch: 1,
    leaseToken: "b".repeat(64),
    leaseExpiresAt: 2,
  };
  const responses = [
    {
      operation: "jobs.reserveParsed",
      receiptId: "receipt",
      expiresAt: 2,
      reused: false,
      targets: [target],
    },
    {
      operation: "jobs.renewParsed",
      jobId: "job",
      state: "processing",
      leaseExpiresAt: 2,
      reused: false,
    },
    {
      operation: "jobs.failParsed",
      jobId: "job",
      state: "failed",
      retryable: true,
      nextAttemptAt: 3,
      failureCode: "worker_resource_exhausted",
      reused: false,
    },
    {
      operation: "jobs.stageParsedBegin",
      jobId: "job",
      stageId: "stage",
      phase: "pages",
      nextOrdinal: 0,
      reused: false,
    },
    {
      operation: "jobs.stageParsedBatch",
      jobId: "job",
      stageId: "stage",
      committedPhase: "pages",
      phase: "pages",
      nextOrdinal: 1,
      acceptedCount: 1,
      reused: false,
    },
    {
      operation: "jobs.stageParsedBatch",
      jobId: "job",
      stageId: "stage",
      committedPhase: "pages",
      phase: "evidence",
      nextOrdinal: 0,
      acceptedCount: 8,
      reused: true,
    },
    {
      operation: "jobs.stageParsedSeal",
      jobId: "job",
      stageId: "stage",
      payloadManifestId: "manifest",
      state: "staged",
      actualPageCount: 1,
      actualEvidenceSpanCount: 1,
      actualDocumentCount: 1,
      actualChunkCount: 1,
      reused: false,
    },
    {
      operation: "jobs.activateParsed",
      jobId: "job",
      state: "ready",
      activatedAt: 3,
      previousGenerationId: "generation",
      reused: false,
    },
  ];
  for (const response of responses) {
    assert.equal(
      parseWorkerResponse(JSON.stringify(response), response.operation)
        .operation,
      response.operation,
    );
  }
  const maximumSeal = {
    ...responses[6],
    actualPageCount: 64,
    actualEvidenceSpanCount: 256,
    actualChunkCount: 256,
  };
  assert.equal(
    parseWorkerResponse(JSON.stringify(maximumSeal), "jobs.stageParsedSeal")
      .operation,
    "jobs.stageParsedSeal",
  );
  for (const [response, operation] of [
    [
      { ...responses[0], targets: [{ ...target, state: "queued" }] },
      "jobs.reserveParsed",
    ],
    [{ ...responses[1], state: "ready" }, "jobs.renewParsed"],
    [{ ...responses[2], nextAttemptAt: undefined }, "jobs.failParsed"],
    [
      { ...responses[3], phase: "seal", nextOrdinal: 1 },
      "jobs.stageParsedBegin",
    ],
    [
      { ...responses[4], phase: "documents", nextOrdinal: 0 },
      "jobs.stageParsedBatch",
    ],
    [{ ...responses[5], nextOrdinal: 1 }, "jobs.stageParsedBatch"],
    [{ ...responses[4], acceptedCount: 9 }, "jobs.stageParsedBatch"],
    [{ ...responses[6], actualPageCount: 0 }, "jobs.stageParsedSeal"],
    [{ ...responses[7], previousGenerationId: 1 }, "jobs.activateParsed"],
  ]) {
    assert.throws(() =>
      parseWorkerResponse(JSON.stringify(response), operation),
    );
  }
});

test("HTTP transport accepts current parsed stage boundaries and rejects values above them", async () => {
  const originalFetch = globalThis.fetch;
  let response;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const transport = new HttpWorkerTransport(
      transportConfig("http://127.0.0.1:3100/api/worker"),
      "credential",
    );
    const boundaries = [
      {
        operation: "jobs.stageParsedBegin",
        jobId: "job",
        stageId: "stage",
        phase: "pages",
        nextOrdinal: 64,
        reused: true,
      },
      ...[
        ["pages", 64, 8],
        ["evidence", 256, 25],
        ["chunks", 256, 25],
      ].map(([phase, nextOrdinal, acceptedCount]) => ({
        operation: "jobs.stageParsedBatch",
        jobId: "job",
        stageId: "stage",
        committedPhase: phase,
        phase,
        nextOrdinal,
        acceptedCount,
        reused: false,
      })),
    ];
    for (const value of boundaries) {
      response = value;
      assert.equal(
        (
          await transport.call({
            protocolVersion: 1,
            operation: value.operation,
          })
        ).operation,
        value.operation,
      );
    }
    for (const value of boundaries.map((candidate) => ({
      ...candidate,
      nextOrdinal: candidate.nextOrdinal + 1,
    }))) {
      response = value;
      await assert.rejects(() =>
        transport.call({
          protocolVersion: 1,
          operation: value.operation,
        }),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function transportConfig(endpoint) {
  return {
    protocolVersion: 1,
    endpoint,
    spaceId: "space",
    sourceAccountId: "source",
    credentialEnv: "TOKEN",
    roots: [{ alias: "root", path: "/tmp/root" }],
    journalDir: "/tmp/journal",
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
  };
}

function statusRequest() {
  return {
    protocolVersion: 1,
    operation: "source.status",
    spaceId: "space",
    sourceAccountId: "source",
  };
}

test("redirects are refused without forwarding the bearer", async () => {
  let targetRequests = 0;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.end("unexpected");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = target.address().port;
  const redirect = createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${targetPort}/api/worker`,
    });
    response.end();
  });
  await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  const redirectPort = redirect.address().port;
  try {
    const transport = new HttpWorkerTransport(
      transportConfig(`http://127.0.0.1:${redirectPort}/api/worker`),
      "sensitive-credential",
    );
    await assert.rejects(() => transport.call(statusRequest()));
    assert.equal(targetRequests, 0);
  } finally {
    await new Promise((resolve) => redirect.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  }
});

test("declared and streamed oversized responses are aborted", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const declared of [true, false]) {
      let signal;
      globalThis.fetch = async (_url, options) => {
        signal = options.signal;
        const bytes = "x".repeat(512 * 1024 + 1);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(declared ? { "content-length": String(bytes.length) } : {}),
          },
        });
      };
      const transport = new HttpWorkerTransport(
        transportConfig("http://127.0.0.1:3100/api/worker"),
        "credential",
      );
      await assert.rejects(() => transport.call(statusRequest()));
      assert.equal(signal.aborted, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the request deadline aborts an unresolved fetch", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let signal;
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    };
    const transport = new HttpWorkerTransport(
      transportConfig("http://127.0.0.1:3100/api/worker"),
      "credential",
      5,
    );
    await assert.rejects(() => transport.call(statusRequest()));
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ADM-9, first review finding 1. `parseWorkerResponse` refuses an operation it
// has no case for, so a new operation the runner sends and the parser does not
// know throws client-side on a 200 the server already stored -- once per pass,
// forever, while the row lands every time. Every runner test until now used a
// transport double that returns objects rather than bytes, so none of them
// reached this parser at all. This one drives the real HttpWorkerTransport.
test("a stored pass outcome parses through the real transport", async () => {
  const originalFetch = globalThis.fetch;
  const accepted = {
    operation: "diagnostics.passOutcome",
    sourceAccountId: "j1234567890123456789012345678902",
    watcherId: "0f1e2d3c-4b5a-4968-8776-655443322110",
    finishedAt: 1_758_196_800_000,
    unhealthySince: 1_758_196_000_000,
  };
  let body = accepted;
  let status = 200;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const transport = new HttpWorkerTransport(
      transportConfig("http://127.0.0.1:3100/api/worker"),
      "credential",
    );
    const request = {
      protocolVersion: 1,
      operation: "diagnostics.passOutcome",
      spaceId: "space",
      sourceAccountId: "source",
      watcherId: accepted.watcherId,
      state: "incomplete",
      code: "root_contents_collapsed",
      scanned: 0,
      published: 0,
      finishedAt: accepted.finishedAt,
    };
    assert.deepEqual(await transport.call(request), accepted);
    // A clean pass owes nothing, so `unhealthySince` comes back null.
    body = { ...accepted, unhealthySince: null };
    assert.deepEqual(await transport.call(request), body);

    // An old server that has never heard of the operation. Its refusal is a
    // safe error envelope, which must come back as a value rather than a
    // throw: the watcher's report is best-effort and the pass carries on.
    body = { error: { code: "invalid_request", message: "unknown operation" } };
    status = 400;
    assert.deepEqual(await transport.call(request), {
      error: { code: "invalid_request" },
    });

    // And a malformed success is still refused, field by field.
    status = 200;
    for (const bad of [
      { ...accepted, watcherId: "not-a-uuid" },
      { ...accepted, finishedAt: "soon" },
      { ...accepted, unhealthySince: 1.5 },
      { ...accepted, extra: 1 },
    ]) {
      body = bad;
      await assert.rejects(() => transport.call(request));
    }
    const missing = { ...accepted };
    delete missing.unhealthySince;
    body = missing;
    await assert.rejects(() => transport.call(request));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ADM-4c. More than one watched root, and more than one provider folder.

function multiRootBase() {
  return {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space_1",
    sourceAccountId: "source_1",
    credentialEnv: "PIPELINE_TOKEN",
    roots: [
      { alias: "notes", path: "/tmp/root" },
      { alias: "investing", path: "/tmp/investing" },
      { alias: "medical", path: "/tmp/medical" },
    ],
    journalDir: "/tmp/journal",
  };
}

function providerRootEntry(id) {
  return {
    providerRootDirectoryId: id,
    providerRootDirectoryIdHash: createHash("sha256").update(id).digest("hex"),
  };
}

test("provider originals are per root", () => {
  const base = multiRootBase();
  const pdf = pdfDocQaConfig();
  delete pdf.archive.independentBackup.repositoryPath;
  pdf.archive.independentBackup.repository = {
    kind: "rclone_dropbox_v1",
    remoteName: "kithmind_dropbox",
    rootPath: "Kith Mind Backups/Processing",
    rcloneBinary: "/tools/rclone",
    configPath: "/credentials/kithmind-rclone.conf",
    configIdentityFingerprint: "c".repeat(64),
    expectedRootDirectoryIdHash: "d".repeat(64),
  };
  pdf.providerOriginal = {
    providerAccountIdHash: "e".repeat(64),
    refreshPath: "Kith Mind/Inbox",
    registryDirectory: "/private/provider-registry",
    roots: [
      { rootAlias: "notes", ...providerRootEntry("id:notes_root") },
      { rootAlias: "investing", ...providerRootEntry("id:investing_root") },
    ],
  };
  // Review finding 3: once one root has a provider folder, every watched root
  // must, so `medical` gets one here. The case where none does is the
  // provider-less config, which is unchanged.
  pdf.providerOriginal.roots.push({
    rootAlias: "medical",
    ...providerRootEntry("id:medical_root"),
  });
  const parsed = parseConfig({ ...base, pdfDocQa: pdf });
  assert.deepEqual(
    parsed.pdfDocQa.providerOriginal.roots.map((root) => root.rootAlias),
    ["notes", "investing", "medical"],
  );

  const unknownAlias = structuredClone(pdf);
  unknownAlias.providerOriginal.roots[1].rootAlias = "not-a-watched-root";
  assert.throws(() => parseConfig({ ...base, pdfDocQa: unknownAlias }));

  const duplicateAlias = structuredClone(pdf);
  duplicateAlias.providerOriginal.roots[1].rootAlias = "notes";
  assert.throws(() => parseConfig({ ...base, pdfDocQa: duplicateAlias }));

  const duplicateFolder = structuredClone(pdf);
  duplicateFolder.providerOriginal.roots[1] = {
    rootAlias: "investing",
    ...providerRootEntry("id:notes_root"),
  };
  assert.throws(() => parseConfig({ ...base, pdfDocQa: duplicateFolder }));

  const mismatchedHash = structuredClone(pdf);
  mismatchedHash.providerOriginal.roots[0].providerRootDirectoryIdHash =
    "f".repeat(64);
  assert.throws(() => parseConfig({ ...base, pdfDocQa: mismatchedHash }));

  const emptyList = structuredClone(pdf);
  emptyList.providerOriginal.roots = [];
  assert.throws(() => parseConfig({ ...base, pdfDocQa: emptyList }));

  const mixedShape = structuredClone(pdf);
  mixedShape.providerOriginal.rootAlias = "notes";
  assert.throws(
    () => parseConfig({ ...base, pdfDocQa: mixedShape }),
    "the two shapes are alternatives, never a merge",
  );

  const extraField = structuredClone(pdf);
  extraField.providerOriginal.roots[0].refreshPath = "Kith Mind/Inbox";
  assert.throws(() => parseConfig({ ...base, pdfDocQa: extraField }));
});

test("the maxFiles ceiling is the scan manifest's, and the default is unchanged", () => {
  const base = multiRootBase();
  assert.equal(parseConfig(base).maxFiles, 256, "the default did not move");
  assert.equal(parseConfig({ ...base, maxFiles: 1024 }).maxFiles, 1024);
  assert.throws(() => parseConfig({ ...base, maxFiles: 1025 }));
  assert.equal(MAX_WORKER_SCAN_ENTRIES, 1024);
});

// ADM-6a. The other half of the compatibility story, and the reason the count
// arrives as its own operation rather than as a field on `source.status`: a
// watcher refuses any response carrying a key it does not know, so an additive
// field on an existing response breaks every watcher already deployed the day
// the server ships it. This test pins that strictness, because it is the whole
// argument for the shape of this change.
test("a response carrying an unknown key is refused, whichever operation it answers", () => {
  const status = {
    operation: "source.status",
    sourceAccountId: "source_1",
    inventoryEpoch: 3,
    completedInventoryEpoch: 3,
    manifestVersion: 4,
    enumeration: { state: "complete", scanId: "scan_1", completedAt: 1 },
    processing: { state: "not_assessed" },
    recordCoverage: "not_established",
  };
  assert.deepEqual(
    parseWorkerResponse(JSON.stringify(status), "source.status"),
    status,
    "the shape an already-deployed watcher expects is unchanged",
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({ ...status, liveItems: 687 }),
      "source.status",
    ),
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({
        operation: "source.roots",
        sourceAccountId: "source_1",
        roots: [],
        liveItems: 687,
      }),
      "source.roots",
    ),
  );
});

test("the server's live item counts are validated against a closed shape", () => {
  const ok = {
    operation: "source.itemCounts",
    sourceAccountId: "source_1",
    liveItems: 687,
    roots: [
      { rootAlias: "investing", liveItems: 600 },
      { rootAlias: "fixture", liveItems: 87 },
    ],
    truncated: false,
  };
  assert.deepEqual(
    parseWorkerResponse(JSON.stringify(ok), "source.itemCounts"),
    ok,
  );
  assert.deepEqual(
    parseWorkerResponse(
      JSON.stringify({
        operation: "source.itemCounts",
        sourceAccountId: "source_1",
        liveItems: 0,
        roots: [],
        truncated: false,
      }),
      "source.itemCounts",
    ).roots,
    [],
    "an account holding nothing is a valid answer, and is what a new source says",
  );
  for (const mutate of [
    (value) => {
      // An alias, never a path: this value is compared against the host's own
      // allow-list keys and is printed in the refusal.
      value.roots[0].rootAlias = "/Users/someone/Finance";
    },
    (value) => {
      value.roots[0].rootAlias = "Investing";
    },
    (value) => {
      value.roots[0].liveItems = -1;
    },
    (value) => {
      value.roots[0].liveItems = 1.5;
    },
    (value) => {
      value.roots[0].relativePath = "Investing/2026";
    },
    (value) => {
      value.roots[1].rootAlias = "investing";
    },
    (value) => {
      delete value.truncated;
    },
    (value) => {
      value.liveItems = "687";
    },
    (value) => {
      value.unexpected = true;
    },
    (value) => {
      value.roots = Array.from({ length: 65 }, (_, index) => ({
        rootAlias: `root-${index}`,
        liveItems: 1,
      }));
    },
  ]) {
    const invalid = structuredClone(ok);
    mutate(invalid);
    assert.throws(() =>
      parseWorkerResponse(JSON.stringify(invalid), "source.itemCounts"),
    );
  }
});

test("the watched-folder list and its report are validated against closed shapes", () => {
  const ok = {
    operation: "source.roots",
    sourceAccountId: "source_1",
    roots: [
      {
        sourceRootId: "root_1",
        kind: "folder",
        state: "active",
        rootAlias: "investing",
        relativePath: "Investing/2026",
        providerFolderId: "id:abc",
        area: "finance",
        expectedTypes: ["capital_call_notice"],
      },
      {
        sourceRootId: "root_2",
        kind: "manual",
        state: "paused",
        expectedTypes: [],
      },
    ],
  };
  assert.deepEqual(parseWorkerResponse(JSON.stringify(ok), "source.roots"), ok);
  assert.deepEqual(
    parseWorkerResponse(
      JSON.stringify({
        operation: "source.roots",
        sourceAccountId: "source_1",
        roots: [],
      }),
      "source.roots",
    ).roots,
    [],
    "no rows is a valid answer and means the host's allow-list stands",
  );
  for (const mutate of [
    (value) => {
      value.roots[0].kind = "drive";
    },
    (value) => {
      value.roots[0].state = "retired";
    },
    (value) => {
      value.roots[0].rootAlias = "Investing";
    },
    (value) => {
      value.roots[0].unexpected = true;
    },
    (value) => {
      delete value.roots[0].expectedTypes;
    },
    (value) => {
      value.roots = Array.from({ length: 101 }, () => value.roots[0]);
    },
  ]) {
    const invalid = structuredClone(ok);
    mutate(invalid);
    assert.throws(() =>
      parseWorkerResponse(JSON.stringify(invalid), "source.roots"),
    );
  }

  const report = {
    operation: "source.rootReport",
    sourceRootId: "root_1",
    reportId: "report_1",
    observedAt: 1_758_000_000_000,
  };
  assert.deepEqual(
    parseWorkerResponse(JSON.stringify(report), "source.rootReport"),
    report,
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({ ...report, state: "ok" }),
      "source.rootReport",
    ),
  );
});

// Review finding 3. A provider original config forces a remote independent
// backup, and the runner refuses a remote repository for original bytes on
// purpose. A root with no provider entry then has nowhere to put its
// independent copy and would fail `archive_remote_original_unsupported` on
// every pass, for every document under it. Refuse it where it can be read.
test("every watched root must have a provider folder once one root does", () => {
  const base = multiRootBase();
  const pdf = pdfDocQaConfig();
  delete pdf.archive.independentBackup.repositoryPath;
  pdf.archive.independentBackup.repository = {
    kind: "rclone_dropbox_v1",
    remoteName: "kithmind_dropbox",
    rootPath: "Kith Mind Backups/Processing",
    rcloneBinary: "/tools/rclone",
    configPath: "/credentials/kithmind-rclone.conf",
    configIdentityFingerprint: "c".repeat(64),
    expectedRootDirectoryIdHash: "d".repeat(64),
  };
  pdf.providerOriginal = {
    providerAccountIdHash: "e".repeat(64),
    refreshPath: "Kith Mind/Inbox",
    registryDirectory: "/private/provider-registry",
    roots: [
      { rootAlias: "notes", ...providerRootEntry("id:notes_root") },
      { rootAlias: "investing", ...providerRootEntry("id:investing_root") },
    ],
  };
  // `medical` is watched but has no provider folder.
  assert.throws(
    () => parseConfig({ ...base, pdfDocQa: pdf }),
    /medical has no provider folder/,
  );
  const complete = structuredClone(pdf);
  complete.providerOriginal.roots.push({
    rootAlias: "medical",
    ...providerRootEntry("id:medical_root"),
  });
  assert.equal(
    parseConfig({ ...base, pdfDocQa: complete }).pdfDocQa.providerOriginal.roots
      .length,
    3,
  );
  // With no provider original at all, a root needs nothing: both archive
  // copies are the pipeline's own, which is how every non-provider source runs.
  const noProvider = structuredClone(pdf);
  delete noProvider.providerOriginal;
  assert.equal(parseConfig({ ...base, pdfDocQa: noProvider }).roots.length, 3);
});
