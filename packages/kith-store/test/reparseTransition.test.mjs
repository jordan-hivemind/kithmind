// P2-104c. Re-parsing an already published document under a changed
// processing identity, against the real worker handlers.
//
// The live incident: ten documents published and activated under extraction
// configuration fingerprint A. The operator moved to a new parser, so the
// fingerprint became B. The server re-queued all ten correctly. The worker
// then failed every pass, first `lease_conflict`, then `stale_observation`
// forever, and published nothing.
//
// This drives the same shape end to end so the failure is reproduced against
// the handlers rather than argued about.

import assert from "node:assert/strict";
import test from "node:test";

import { createKithPool, newKithId } from "../dist/index.js";
import {
  admitArchivedDiscovery,
  appendWorkerScanPage,
  artifactBoundExtractionFingerprint,
  beginWorkerScan,
  lookupArchivedAdmission,
  preflightArchivedDiscovery,
  reconcileWorkerScan,
  reserveArchivedDiscovery,
  sealWorkerScan,
  requireWorkerSourceAccount,
  withWorkerTransaction,
  workerCtx,
} from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const HASH_A = "a".repeat(64);
const PARSER_FINGERPRINT = "1".repeat(64);
const EXTRACTION_A = "3".repeat(64);
const EXTRACTION_B = "4".repeat(64);
const PARSER_FINGERPRINT_B = "2".repeat(64);

function expectProtocolCode(code) {
  return (error) => error?.code === code;
}

async function fixture(t) {
  const database = await identityDatabase(t);
  const identity = database.ctx(NOW);
  const userId = await makeUser(identity, { name: "Worker owner" });
  const spaceId = await makeSpace(identity, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const sourceAccountId = newKithId();
  await database.client.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, inventory_epoch,
        completed_inventory_epoch, manifest_version, created_by)
     VALUES ($1,$2,transaction_timestamp(),'fs','synthetic-fs',
             'Synthetic filesystem',true,0,60000,0,0,0,$3)`,
    [sourceAccountId, spaceId, userId],
  );
  await database.client.query(
    `UPDATE kith.source_accounts SET binary_profile_ids = $1,
       binary_profile_audit_digest = $2, binary_profile_enabled_at = $3
     WHERE id = $4`,
    [
      JSON.stringify(["pdf_docqa_v1"]),
      PARSER_FINGERPRINT,
      new Date(NOW),
      sourceAccountId,
    ],
  );
  const credential = await makeApiKey(identity, {
    userId,
    capabilities: ["ingest"],
    spaceIds: [spaceId],
    sourceAccountIds: [sourceAccountId],
  });
  const principal = { userId, credentialId: credential.id };
  const source = await requireWorkerSourceAccount(
    workerCtx(database.client, NOW),
    principal,
    { spaceId, sourceAccountId },
  );
  return {
    ...database,
    userId,
    spaceId,
    sourceAccountId,
    credential,
    principal,
    source,
  };
}

function binaryContent(
  extractionConfigurationFingerprint,
  parser = PARSER_FINGERPRINT,
) {
  return {
    status: "ready_binary_v1",
    sha256: HASH_A,
    byteLength: 10,
    mediaType: "application/pdf",
    parserProfileId: "pdf_docqa_v1",
    parserFingerprint: parser,
    extractionConfigurationFingerprint,
    extractorFingerprint: "docling-document-qa:v1",
    recordSchemaFingerprint: "no-records:v1",
    normalizationFingerprint: "docling-pages:v1",
    chunkerFingerprint: "page-aware:v1",
    correctionRevision: "correction:1",
  };
}

/** One full scan: begin, one entry, seal, reconcile. Returns the scan id. */
async function runScan(
  call,
  f,
  label,
  extraction,
  inventoryEpoch,
  parser = PARSER_FINGERPRINT,
) {
  const common = {
    protocolVersion: 1,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  };
  const begun = await call((ctx) =>
    beginWorkerScan(ctx, f.principal, {
      ...common,
      operation: "scan.begin",
      requestId: `${label}-begin`,
      watcherId: "watcher-1",
      connectorVersion: "fs-v1",
      mode: "normal",
      expectedInventoryEpoch: inventoryEpoch,
    }),
  );
  await call((ctx) =>
    appendWorkerScanPage(ctx, f.principal, {
      ...common,
      operation: "scan.appendPage",
      scanId: begun.scanId,
      requestId: `${label}-page`,
      ordinal: 0,
      entries: [
        {
          externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
          uri: "fs://synthetic/statement.pdf",
          title: "Statement",
          docType: "pdf",
          sourceModifiedAt: NOW - 1_000,
          content: binaryContent(extraction, parser),
        },
      ],
    }),
  );
  await call((ctx) =>
    sealWorkerScan(ctx, f.principal, {
      ...common,
      operation: "scan.seal",
      scanId: begun.scanId,
      requestId: `${label}-seal`,
      expectedPageCount: 1,
      health: { status: "healthy" },
    }),
  );
  await call((ctx) =>
    reconcileWorkerScan(ctx, f.principal, {
      ...common,
      operation: "scan.reconcile",
      scanId: begun.scanId,
      requestId: `${label}-reconcile`,
      expectedInventoryEpoch: inventoryEpoch + 1,
      ordinal: 0,
      maxItems: 10,
    }),
  );
  return begun.scanId;
}

async function workRows(f) {
  return (
    await f.client.query(
      `SELECT id, state, attempts, observation_epoch, processing_epoch,
              lease_token, extraction_configuration_fingerprint
         FROM kith.worker_discovery_work WHERE source_account_id = $1
        ORDER BY created_at, id`,
      [f.sourceAccountId],
    )
  ).rows;
}

function identityFor(work, scanId, extraction, parser = PARSER_FINGERPRINT) {
  return {
    sourceItemId: work.source_item_id,
    scanId,
    observationEpoch: Number(work.observation_epoch),
    processingEpoch: Number(work.processing_epoch),
    contentHash: HASH_A,
    byteLength: 10,
    mediaType: "application/pdf",
    parserProfileId: "pdf_docqa_v1",
    parserFingerprint: parser,
    extractionConfigurationFingerprint: extraction,
    extractorFingerprint: "docling-document-qa:v1",
    recordSchemaFingerprint: "no-records:v1",
    normalizationFingerprint: "docling-pages:v1",
    chunkerFingerprint: "page-aware:v1",
    correctionRevision: "correction:1",
  };
}

const receipt = (subjectKind, copyRole, offset) => {
  const digit = ((offset % 14) + 1).toString(16);
  return {
    kind: "create",
    subjectKind,
    copyRole,
    clientReceiptId: `01890a5d-ac96-7cc4-bb7e-6f4f5ca5c1${50 + offset}`,
    archiveProfileFingerprint: digit.repeat(64),
    archiveIdentityFingerprint: ((offset + 2) % 15).toString(16).repeat(64),
    recipientFingerprint: ((offset + 3) % 15).toString(16).repeat(64),
    repositoryKeyDomainFingerprint: ((offset + 4) % 15).toString(16).repeat(64),
    storageFailureDomainFingerprint: ((offset + 5) % 15)
      .toString(16)
      .repeat(64),
    archiveObjectId: `01890a5d-ac96-7cc4-bb7e-6f4f5ca5c1${60 + offset}`,
    ciphertextHash: ((offset + 6) % 15).toString(16).repeat(64),
    ciphertextByteLength: subjectKind === "original_bytes" ? 20 : 30,
    createdAt: NOW,
    readbackVerifiedAt: NOW,
  };
};

test(
  "a processing epoch bump re-queues an admitted document and the worker can take it",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    const common = {
      protocolVersion: 1,
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
    };
    try {
      // --- profile A: scan, reserve, admit ---------------------------------
      const scanA = await runScan(call, f, "a", EXTRACTION_A, 0);
      const afterScanA = await workRows(f);
      assert.equal(afterScanA.length, 1, "one work row after the first scan");
      assert.equal(afterScanA[0].state, "queued");

      const workA = (
        await f.client.query(
          "SELECT * FROM kith.worker_discovery_work WHERE id = $1",
          [afterScanA[0].id],
        )
      ).rows[0];
      const identityA = identityFor(workA, scanA, EXTRACTION_A);

      await call((ctx) =>
        preflightArchivedDiscovery(ctx, f.principal, {
          ...common,
          operation: "discovery.preflightArchived",
          requestId: "a-preflight",
          identity: identityA,
          archiveIntentDigest: "c".repeat(64),
        }),
      );
      const leasedA = await call((ctx) =>
        reserveArchivedDiscovery(
          ctx,
          f.principal,
          {
            ...common,
            operation: "discovery.reserveArchived",
            requestId: "a-reserve",
            identity: identityA,
          },
          "7".repeat(64),
        ),
      );
      const outputHash = "b".repeat(64);
      const extractionFingerprintA = await artifactBoundExtractionFingerprint(
        PARSER_FINGERPRINT,
        outputHash,
        EXTRACTION_A,
      );
      const admittedA = await call((ctx) =>
        admitArchivedDiscovery(ctx, f.principal, {
          ...common,
          operation: "discovery.admitArchived",
          requestId: "a-admit",
          workId: leasedA.workId,
          leaseEpoch: leasedA.leaseEpoch,
          leaseToken: leasedA.leaseToken,
          parserArtifact: {
            kind: "create",
            clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
            outputHash,
            outputByteLength: 20,
            outputMediaType: "application/vnd.docling+json",
            createdAt: NOW,
          },
          archives: [
            receipt("original_bytes", "primary", 1),
            receipt("original_bytes", "independent_backup", 2),
            receipt("parser_output", "primary", 3),
            receipt("parser_output", "independent_backup", 4),
          ],
          parsedText: {
            extractionFingerprint: extractionFingerprintA,
            textHash: HASH_A,
            byteLength: 8,
            utf16Length: 8,
            pageCount: 1,
            mappingManifestHash: "d".repeat(64),
            normalizedBundleDigest: "e".repeat(64),
            expectedEvidenceSpanCount: 1,
            expectedDocumentCount: 1,
            expectedChunkCount: 1,
          },
        }),
      );
      assert.equal(admittedA.state, "admitted");

      // --- profile B: the operator's parser change -------------------------
      const scanB = await runScan(
        call,
        f,
        "b",
        EXTRACTION_B,
        1,
        PARSER_FINGERPRINT_B,
      );
      const afterScanB = await workRows(f);
      t.diagnostic(
        `after profile B scan: ${JSON.stringify(
          afterScanB.map((row) => ({
            state: row.state,
            attempts: row.attempts,
            observationEpoch: Number(row.observation_epoch),
            processingEpoch: Number(row.processing_epoch),
            leased: row.lease_token !== null,
          })),
        )}`,
      );

      const queued = afterScanB.filter((row) => row.state === "queued");
      assert.equal(
        queued.length,
        1,
        "the epoch bump must leave exactly one claimable work row",
      );
      const workB = (
        await f.client.query(
          "SELECT * FROM kith.worker_discovery_work WHERE id = $1",
          [queued[0].id],
        )
      ).rows[0];
      assert.equal(
        Number(workB.processing_epoch),
        Number(workA.processing_epoch) + 1,
        "the processing epoch advanced",
      );
      assert.equal(
        Number(workB.observation_epoch),
        Number(workA.observation_epoch),
        "the observation epoch did not: the bytes did not change",
      );

      // This is the worker's next move, and where the live pass died.
      const identityB = identityFor(
        workB,
        scanB,
        EXTRACTION_B,
        PARSER_FINGERPRINT_B,
      );
      await call((ctx) =>
        preflightArchivedDiscovery(ctx, f.principal, {
          ...common,
          operation: "discovery.preflightArchived",
          requestId: "b-preflight",
          identity: identityB,
          archiveIntentDigest: "c".repeat(64),
        }),
      );
      const leasedB = await call((ctx) =>
        reserveArchivedDiscovery(
          ctx,
          f.principal,
          {
            ...common,
            operation: "discovery.reserveArchived",
            requestId: "b-reserve",
            identity: identityB,
          },
          "8".repeat(64),
        ),
      );
      assert.equal(leasedB.processingEpoch, Number(workB.processing_epoch));

      const lookupB = await call((ctx) =>
        lookupArchivedAdmission(ctx, f.principal, {
          ...common,
          operation: "discovery.lookupArchivedAdmission",
          requestId: "b-lookup",
          identity: identityB,
          lookup: { mode: "original" },
        }),
      );
      assert.equal(
        lookupB.found,
        true,
        "the original is already admitted and is reused, not re-archived",
      );

      // The re-parse itself: same original bytes, a new parser artifact and a
      // new parsed text under profile B.
      const outputHashB = "f".repeat(64);
      const extractionFingerprintB = await artifactBoundExtractionFingerprint(
        PARSER_FINGERPRINT_B,
        outputHashB,
        EXTRACTION_B,
      );
      const admittedB = await call((ctx) =>
        admitArchivedDiscovery(ctx, f.principal, {
          ...common,
          operation: "discovery.admitArchived",
          requestId: "b-admit",
          workId: leasedB.workId,
          leaseEpoch: leasedB.leaseEpoch,
          leaseToken: leasedB.leaseToken,
          parserArtifact: {
            kind: "create",
            // A new artifact id per processing row, as the runner mints via
            // stableUuid(processingId, "parser-artifact").
            clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c141",
            outputHash: outputHashB,
            outputByteLength: 21,
            outputMediaType: "application/vnd.docling+json",
            createdAt: NOW,
          },
          archives: [
            {
              kind: "existing",
              subjectKind: "original_bytes",
              copyRole: "primary",
              receiptId: lookupB.originalPrimaryReceiptId,
              bindingEpoch: lookupB.originalPrimaryBindingEpoch,
            },
            {
              kind: "existing",
              subjectKind: "original_bytes",
              copyRole: "independent_backup",
              receiptId: lookupB.originalBackupReceiptId,
              bindingEpoch: lookupB.originalBackupBindingEpoch,
            },
            receipt("parser_output", "primary", 7),
            receipt("parser_output", "independent_backup", 8),
          ],
          parsedText: {
            extractionFingerprint: extractionFingerprintB,
            textHash: HASH_A,
            byteLength: 8,
            utf16Length: 8,
            pageCount: 1,
            mappingManifestHash: "d".repeat(64),
            normalizedBundleDigest: "e".repeat(64),
            expectedEvidenceSpanCount: 1,
            expectedDocumentCount: 1,
            expectedChunkCount: 1,
          },
        }),
      );
      assert.equal(admittedB.state, "admitted");
      assert.notEqual(
        admittedB.processingGenerationId,
        admittedA.processingGenerationId,
        "the re-parse is a new processing generation",
      );

      const generations = (
        await f.client.query(
          `SELECT id, state FROM kith.processing_generations
            WHERE source_item_id = $1 ORDER BY created_at, id`,
          [workA.source_item_id],
        )
      ).rows;
      assert.equal(
        generations.length,
        2,
        "the generation from the previous parser is retained, not replaced",
      );
      assert.equal(
        generations.some((row) => row.id === admittedA.processingGenerationId),
        true,
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "a re-parse that does not move the parser fingerprint is refused by artifact immutability",
  { skip },
  async (t) => {
    // The owner's live case. P2-68 changed the normalizer, so
    // `extractionConfigurationFingerprint` moved (mappingFormat v2 -> v3) while
    // `parserFingerprint` did not: the four functions it hashes were untouched.
    //
    // The server holds one parser artifact per (source_revision_id,
    // parser_fingerprint) and refuses any other client artifact id for that
    // pair (`createOrGetParserArtifact`, provenance/artifacts.ts:138-167). The
    // runner mints a fresh `clientArtifactId` per processing row
    // (`createParserArtifactSelection`, pipeline/src/archivedRequestMapping.ts:123-140,
    // always `kind: "create"`), so the re-parse presents a new id for an
    // artifact the server already considers settled.
    //
    // Reusing it needs `parserArtifact: {kind: "existing", parserArtifactId}`
    // plus the existing parser_output bindings as `kind: "existing"`, and the
    // client has no way to learn either: `lookupArchivedAdmission` mode
    // "processing" resolves the artifact by the client's own
    // `lookup.clientArtifactId` and answers a bare `found: false` when the text
    // version for the new extraction fingerprint is absent
    // (archivedDiscovery.ts:965-1032).
    //
    // This test pins that wall. It is the blocker for a same-parser re-parse
    // and must be turned into a passing re-parse, not deleted.
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    const common = {
      protocolVersion: 1,
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
    };
    try {
      const scanA = await runScan(call, f, "a", EXTRACTION_A, 0);
      const rowsA = await workRows(f);
      const workA = (
        await f.client.query(
          "SELECT * FROM kith.worker_discovery_work WHERE id = $1",
          [rowsA[0].id],
        )
      ).rows[0];
      const identityA = identityFor(workA, scanA, EXTRACTION_A);
      const leasedA = await call((ctx) =>
        reserveArchivedDiscovery(
          ctx,
          f.principal,
          {
            ...common,
            operation: "discovery.reserveArchived",
            requestId: "a-reserve",
            identity: identityA,
          },
          "7".repeat(64),
        ),
      );
      const outputHash = "b".repeat(64);
      const extractionA = await artifactBoundExtractionFingerprint(
        PARSER_FINGERPRINT,
        outputHash,
        EXTRACTION_A,
      );
      await call((ctx) =>
        admitArchivedDiscovery(ctx, f.principal, {
          ...common,
          operation: "discovery.admitArchived",
          requestId: "a-admit",
          workId: leasedA.workId,
          leaseEpoch: leasedA.leaseEpoch,
          leaseToken: leasedA.leaseToken,
          parserArtifact: {
            kind: "create",
            clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
            outputHash,
            outputByteLength: 20,
            outputMediaType: "application/vnd.docling+json",
            createdAt: NOW,
          },
          archives: [
            receipt("original_bytes", "primary", 1),
            receipt("original_bytes", "independent_backup", 2),
            receipt("parser_output", "primary", 3),
            receipt("parser_output", "independent_backup", 4),
          ],
          parsedText: {
            extractionFingerprint: extractionA,
            textHash: HASH_A,
            byteLength: 8,
            utf16Length: 8,
            pageCount: 1,
            mappingManifestHash: "d".repeat(64),
            normalizedBundleDigest: "e".repeat(64),
            expectedEvidenceSpanCount: 1,
            expectedDocumentCount: 1,
            expectedChunkCount: 1,
          },
        }),
      );

      // Same parser, new extraction configuration.
      const scanB = await runScan(call, f, "b", EXTRACTION_B, 1);
      const queued = (await workRows(f)).filter(
        (row) => row.state === "queued",
      );
      assert.equal(queued.length, 1);
      const workB = (
        await f.client.query(
          "SELECT * FROM kith.worker_discovery_work WHERE id = $1",
          [queued[0].id],
        )
      ).rows[0];
      const identityB = identityFor(workB, scanB, EXTRACTION_B);

      // P2-104c's fix gets the document this far. Before it, preflight itself
      // answered `stale_observation` because the superseded row shared the
      // observation epoch.
      const leasedB = await call((ctx) =>
        reserveArchivedDiscovery(
          ctx,
          f.principal,
          {
            ...common,
            operation: "discovery.reserveArchived",
            requestId: "b-reserve",
            identity: identityB,
          },
          "8".repeat(64),
        ),
      );
      const extractionB = await artifactBoundExtractionFingerprint(
        PARSER_FINGERPRINT,
        outputHash,
        EXTRACTION_B,
      );
      await assert.rejects(
        call((ctx) =>
          admitArchivedDiscovery(ctx, f.principal, {
            ...common,
            operation: "discovery.admitArchived",
            requestId: "b-admit",
            workId: leasedB.workId,
            leaseEpoch: leasedB.leaseEpoch,
            leaseToken: leasedB.leaseToken,
            parserArtifact: {
              kind: "create",
              clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c141",
              outputHash,
              outputByteLength: 20,
              outputMediaType: "application/vnd.docling+json",
              createdAt: NOW,
            },
            archives: [
              receipt("original_bytes", "primary", 1),
              receipt("original_bytes", "independent_backup", 2),
              receipt("parser_output", "primary", 7),
              receipt("parser_output", "independent_backup", 8),
            ],
            parsedText: {
              extractionFingerprint: extractionB,
              textHash: HASH_A,
              byteLength: 8,
              utf16Length: 8,
              pageCount: 1,
              mappingManifestHash: "d".repeat(64),
              normalizedBundleDigest: "e".repeat(64),
              expectedEvidenceSpanCount: 1,
              expectedDocumentCount: 1,
              expectedChunkCount: 1,
            },
          }),
        ),
        /Conflicting immutable parser artifact/,
        "the same-parser re-parse is not implemented end to end yet",
      );
    } finally {
      await pool.end();
    }
  },
);
