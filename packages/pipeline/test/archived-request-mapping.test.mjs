import assert from "node:assert/strict";
import test from "node:test";

import {
  createArchiveReceiptSelection,
  digestArchiveIntent,
} from "../dist/archivedRequestMapping.js";

const hash = "a".repeat(64);

function copy(role) {
  return {
    role,
    clientReceiptId: "123e4567-e89b-42d3-a456-426614174000",
    archiveObjectId: "123e4567-e89b-42d3-a456-426614174001",
    objectName: "123e4567-e89b-42d3-a456-426614174001.age",
    archiveIdentityFingerprint: hash,
    archiveProfileFingerprint: hash,
    recipientFingerprint: hash,
    repositoryKeyDomainFingerprint: hash,
    storageFailureDomainFingerprint: hash,
    ...(role === "independent_backup"
      ? {
          restic: {
            operationId: "123e4567-e89b-42d3-a456-426614174002",
            host: "worker",
            repositoryId: "repository",
          },
        }
      : {}),
  };
}

function input() {
  return {
    identity: {
      sourceItemId: "item",
      scanId: "scan",
      observationEpoch: 1,
      processingEpoch: 2,
      contentHash: hash,
      byteLength: 1,
      mediaType: "application/pdf",
      parserProfileId: "pdf_docqa_v1",
      parserFingerprint: hash,
      extractionConfigurationFingerprint: hash,
      extractorFingerprint: "extractor",
      recordSchemaFingerprint: "schema",
      normalizationFingerprint: "normalization",
      chunkerFingerprint: "chunking",
      correctionRevision: "correction",
    },
    original: {
      originalCatalogId: "123e4567-e89b-42d3-a456-426614174003",
      copies: {
        primary: copy("primary"),
        independent_backup: copy("independent_backup"),
      },
    },
    processing: {
      processingCatalogId: "123e4567-e89b-42d3-a456-426614174004",
      copies: {
        primary: copy("primary"),
        independent_backup: copy("independent_backup"),
      },
    },
  };
}

test("archive intent digest has a stable ordered domain-separated preimage", () => {
  const fixture = input();
  assert.equal(
    digestArchiveIntent(fixture),
    "7a1d43d049984115e747106306aabf731d0b40fbca12aff85b2dbfdab0d30e38",
  );
  assert.notEqual(
    digestArchiveIntent({
      ...fixture,
      identity: { ...fixture.identity, processingEpoch: 3 },
    }),
    digestArchiveIntent(fixture),
  );
  assert.notEqual(
    digestArchiveIntent({
      ...fixture,
      processing: {
        ...fixture.processing,
        copies: {
          ...fixture.processing.copies,
          primary: {
            ...fixture.processing.copies.primary,
            archiveObjectId: "123e4567-e89b-42d3-a456-426614174005",
          },
        },
      },
    }),
    digestArchiveIntent(fixture),
  );
});

test("archive receipt selection survives a partial cloud-receipt catalog update", () => {
  const archive = copy("primary");
  const durable = {
    ...archive,
    published: {
      state: "published",
      source: { sha256: hash, byteLength: 10 },
      ciphertext: { sha256: hash, byteLength: 20 },
      ciphertextDevice: 1,
      ciphertextInode: 2,
      ageVersion: "1.3.2",
    },
    readbackVerifiedAt: 200,
  };
  const before = {
    createdAt: 100,
    updatedAt: 200,
    copies: {
      primary: durable,
      independent_backup: copy("independent_backup"),
    },
  };
  const pendingSelection = createArchiveReceiptSelection(
    "original_bytes",
    before,
    "primary",
  );
  const afterPartialReceipt = {
    ...before,
    updatedAt: 300,
    copies: {
      ...before.copies,
      primary: {
        ...durable,
        cloudReceipt: {
          receiptId: "123e4567-e89b-42d3-a456-426614174009",
          requestDigest: hash,
          recordedAt: 300,
        },
      },
    },
  };
  assert.deepEqual(
    createArchiveReceiptSelection(
      "original_bytes",
      afterPartialReceipt,
      "primary",
    ),
    pendingSelection,
  );
  assert.equal(pendingSelection.readbackVerifiedAt, 200);
});
