import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { sha256Utf8 } from "./model";
import {
  auditFullLegacyPayloadPage,
  auditLegacyProvenancePage,
} from "./migrations";

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Audit space",
      createdBy: userId,
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "manual",
      accountId: "audit",
      name: "Audit",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalIdHash: "a".repeat(64),
      lifecycle: "available",
      originalLinkAvailable: false,
      desiredProcessingEpoch: 0,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "audit-key-hash",
      keyPrefix: "ob_audit",
      name: "Audit ingest key",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    return {
      userId,
      spaceId,
      sourceAccountId,
      sourceItemId,
      credentialId,
    };
  });
  return { t, ...ids };
}

async function insertLegacyRevision(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
) {
  return await f.t.run(async (ctx) =>
    ctx.db.insert("sourceRevisions", {
      spaceId: f.spaceId,
      sourceItemId: f.sourceItemId,
      contentHash: await sha256Utf8(text),
      byteLength: new TextEncoder().encode(text).byteLength,
      mediaType: "text/plain",
      inlineText: text,
      capturedAt: 1,
      userId: f.userId,
    }),
  );
}

async function insertParsedGeneration(f: Awaited<ReturnType<typeof fixture>>) {
  return await f.t.run(async (ctx) => {
    const rawHash = "1".repeat(64);
    const artifactHash = "2".repeat(64);
    const revisionId = await ctx.db.insert("sourceRevisions", {
      spaceId: f.spaceId,
      sourceItemId: f.sourceItemId,
      representation: "archived_binary_v1",
      contentHashAuthority: "worker_asserted",
      contentHash: rawHash,
      byteLength: 10,
      mediaType: "application/pdf",
      capturedAt: 1,
      userId: f.userId,
    });
    const artifactId = await ctx.db.insert("sourceParserArtifacts", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: f.sourceItemId,
      sourceRevisionId: revisionId,
      clientArtifactId: "00000000-0000-4000-8000-000000000001",
      parserFingerprint: "3".repeat(64),
      outputHash: artifactHash,
      outputByteLength: 20,
      outputMediaType: "application/vnd.docling+json",
      hashAuthority: "worker_asserted",
      userId: f.userId,
      actorCredentialId: f.credentialId,
      createdAt: 2,
    });
    const receiptIds: Id<"sourceArtifactArchiveReceipts">[] = [];
    for (const [index, subjectKind, copyRole] of [
      [0, "original_bytes", "primary"],
      [1, "original_bytes", "independent_backup"],
      [2, "parser_output", "primary"],
      [3, "parser_output", "independent_backup"],
    ] as const) {
      const parserSubject = subjectKind === "parser_output";
      receiptIds.push(
        await ctx.db.insert("sourceArtifactArchiveReceipts", {
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          sourceItemId: f.sourceItemId,
          sourceRevisionId: revisionId,
          ...(parserSubject ? { parserArtifactId: artifactId } : {}),
          subjectKind,
          copyRole,
          clientReceiptId: `00000000-0000-4000-8000-00000000000${index + 2}`,
          requestDigest: `${index + 4}`.repeat(64),
          receiptVersion: "archive_receipt_v1",
          archiveRepresentation: "age_encrypted_v1",
          archiveProfileFingerprint: "8".repeat(64),
          archiveIdentityFingerprint: `${index + 1}`.repeat(64),
          recipientFingerprint: `${index + 2}`.repeat(64),
          repositoryKeyDomainFingerprint: `${index + 3}`.repeat(64),
          storageFailureDomainFingerprint: `${index + 4}`.repeat(64),
          archiveObjectId: `sha256:${`${index + 5}`.repeat(64)}`,
          plaintextHash: parserSubject ? artifactHash : rawHash,
          plaintextByteLength: parserSubject ? 20 : 10,
          plaintextMediaType: parserSubject
            ? "application/vnd.docling+json"
            : "application/pdf",
          hashAuthority: "worker_asserted",
          ciphertextHash: `${index + 6}`.repeat(64),
          ciphertextByteLength: 30,
          verificationKind: "ciphertext_readback_sha256",
          readbackVerifiedAt: 3,
          userId: f.userId,
          actorCredentialId: f.credentialId,
          createdAt: 3,
        }),
      );
    }
    const textId = await ctx.db.insert("sourceTextVersions", {
      spaceId: f.spaceId,
      sourceRevisionId: revisionId,
      extractionFingerprint: "9".repeat(64),
      representation: "parsed_pages_v1",
      textHash: "a".repeat(64),
      byteLength: 5,
      utf16Length: 5,
      pageCount: 1,
      mappingManifestHash: "b".repeat(64),
      parserArtifactId: artifactId,
      evidenceSealed: false,
    });
    const generationId = await ctx.db.insert("processingGenerations", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: f.sourceItemId,
      sourceRevisionId: revisionId,
      sourceTextVersionId: textId,
      processingFingerprint: "c".repeat(64),
      extractionFingerprint: "9".repeat(64),
      extractorFingerprint: "d".repeat(64),
      recordSchemaFingerprint: "e".repeat(64),
      normalizationFingerprint: "f".repeat(64),
      chunkerFingerprint: "0".repeat(64),
      correctionRevision: "0",
      parserArtifactId: artifactId,
      archiveSetDigest: "1".repeat(64),
      normalizedBundleDigest: "2".repeat(64),
      originalPrimaryReceiptId: receiptIds[0]!,
      originalBackupReceiptId: receiptIds[1]!,
      parserPrimaryReceiptId: receiptIds[2]!,
      parserBackupReceiptId: receiptIds[3]!,
      desiredProcessingEpoch: 1,
      state: "queued",
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      expectedEventCount: 0,
      expectedObservationCount: 0,
      embeddingStatus: "unavailable",
    });
    return { artifactId, generationId };
  });
}

describe("legacy provenance audit", () => {
  test("full audit detects a corrupt sealed page without disclosing text", async () => {
    const f = await fixture();
    const revisionId = await insertLegacyRevision(f, "source");
    const textId = await f.t.run(async (ctx) => {
      const id = await ctx.db.insert("sourceTextVersions", {
        spaceId: f.spaceId,
        sourceRevisionId: revisionId,
        extractionFingerprint: "legacy:v1",
        text: "private-payload",
        textHash: await sha256Utf8("private-payload"),
        byteLength: 15,
        evidenceSealed: true,
      });
      await ctx.db.insert("sourcePages", {
        spaceId: f.spaceId,
        sourceTextVersionId: id,
        ordinal: 0,
        start: 0,
        end: 15,
        text: "private-payload",
        textHash: "0".repeat(64),
      });
      return id;
    });
    const result = await f.t.run((ctx) =>
      auditFullLegacyPayloadPage(ctx, {
        phase: "source_text_versions",
        cursor: null,
        maxItems: 1,
      }),
    );
    expect(result).toMatchObject({
      scope: "full_legacy_payload_v1",
      applicable: 1,
      validCount: 0,
      incompleteCount: 0,
      invalidCount: 1,
      invalidRows: [{ rowId: textId, code: "payload_invalid" }],
      pagePassed: false,
      pageReadyForBinaryEnablement: false,
    });
    expect(JSON.stringify(result)).not.toContain("private-payload");
  });

  test("marks a complete sealed legacy text page ready for the later enablement gate", async () => {
    const f = await fixture();
    const revisionId = await insertLegacyRevision(f, "source");
    await f.t.run(async (ctx) => {
      const text = "sealed-text";
      const textId = await ctx.db.insert("sourceTextVersions", {
        spaceId: f.spaceId,
        sourceRevisionId: revisionId,
        extractionFingerprint: "legacy:v1",
        text,
        textHash: await sha256Utf8(text),
        byteLength: new TextEncoder().encode(text).byteLength,
        evidenceSealed: true,
      });
      await ctx.db.insert("sourcePages", {
        spaceId: f.spaceId,
        sourceTextVersionId: textId,
        ordinal: 0,
        start: 0,
        end: text.length,
        text,
        textHash: await sha256Utf8(text),
      });
    });
    const result = await f.t.run((ctx) =>
      auditFullLegacyPayloadPage(ctx, {
        phase: "source_text_versions",
        cursor: null,
        maxItems: 1,
      }),
    );
    expect(result).toMatchObject({
      applicable: 1,
      validCount: 1,
      incompleteCount: 0,
      invalidCount: 0,
      pagePassed: true,
      pageReadyForBinaryEnablement: true,
    });
    expect(JSON.stringify(result)).not.toContain("sealed-text");
  });

  test("full audit is hard limited to one root row", async () => {
    const f = await fixture();
    await expect(
      f.t.run((ctx) =>
        auditFullLegacyPayloadPage(ctx, {
          phase: "processing_generations",
          cursor: null,
          maxItems: 2,
        }),
      ),
    ).rejects.toThrow("one root row");
  });

  test("does not classify an unsealed queued generation as corrupt", async () => {
    const f = await fixture();
    const revisionId = await insertLegacyRevision(f, "queued-source");
    await f.t.run((ctx) =>
      ctx.db.insert("processingGenerations", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: f.sourceItemId,
        sourceRevisionId: revisionId,
        processingFingerprint: "queued-processing",
        extractionFingerprint: "queued-extraction",
        extractorFingerprint: "queued-extractor",
        recordSchemaFingerprint: "queued-records",
        normalizationFingerprint: "queued-normalization",
        chunkerFingerprint: "queued-chunker",
        correctionRevision: "queued-correction",
        desiredProcessingEpoch: 0,
        state: "queued",
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 1,
        expectedChunkCount: 1,
        expectedEventCount: 1,
        expectedObservationCount: 1,
        embeddingStatus: "unavailable",
      }),
    );
    const result = await f.t.run((ctx) =>
      auditFullLegacyPayloadPage(ctx, {
        phase: "processing_generations",
        cursor: null,
        maxItems: 1,
      }),
    );
    expect(result).toMatchObject({
      applicable: 1,
      validCount: 1,
      incompleteCount: 1,
      invalidCount: 0,
      pagePassed: true,
      pageReadyForBinaryEnablement: false,
    });
    expect(JSON.stringify(result)).not.toContain("queued-source");
  });

  test("skips a closed parsed generation without claiming to audit its payload", async () => {
    const f = await fixture();
    await insertParsedGeneration(f);
    const result = await f.t.run((ctx) =>
      auditFullLegacyPayloadPage(ctx, {
        phase: "processing_generations",
        cursor: null,
        maxItems: 1,
      }),
    );
    expect(result).toMatchObject({
      scope: "full_legacy_payload_v1",
      inspected: 1,
      applicable: 0,
      validCount: 0,
      incompleteCount: 0,
      invalidCount: 0,
      pagePassed: true,
    });
  });

  test("reports partial binary generation metadata on inline text", async () => {
    const f = await fixture();
    const { generationId } = await insertParsedGeneration(f);
    await f.t.run(async (ctx) => {
      const generation = await ctx.db.get(generationId);
      if (!generation?.sourceTextVersionId) throw new Error("missing text");
      const text = "legacy-text";
      await ctx.db.patch(generation.sourceTextVersionId, {
        representation: "inline_text_v1",
        text,
        textHash: await sha256Utf8(text),
        textHashAuthority: "server_verified_retained_text",
        byteLength: new TextEncoder().encode(text).byteLength,
        utf16Length: undefined,
        pageCount: undefined,
        mappingManifestHash: undefined,
        parserArtifactId: undefined,
      });
      await ctx.db.patch(generationId, {
        archiveSetDigest: undefined,
        normalizedBundleDigest: undefined,
        originalPrimaryReceiptId: undefined,
        originalBackupReceiptId: undefined,
        parserPrimaryReceiptId: undefined,
        parserBackupReceiptId: undefined,
      });
    });
    const result = await f.t.run((ctx) =>
      auditFullLegacyPayloadPage(ctx, {
        phase: "processing_generations",
        cursor: null,
        maxItems: 1,
      }),
    );
    expect(result).toMatchObject({
      applicable: 1,
      validCount: 0,
      incompleteCount: 0,
      invalidCount: 1,
      invalidRows: [{ rowId: generationId, code: "representation_invalid" }],
      pagePassed: false,
      pageReadyForBinaryEnablement: false,
    });
  });

  test("paginates without mutation or content disclosure", async () => {
    const f = await fixture();
    await insertLegacyRevision(f, "private-first");
    await insertLegacyRevision(f, "private-second");
    const before = await f.t.run((ctx) =>
      ctx.db.query("sourceRevisions").collect(),
    );
    const first = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_revisions",
        cursor: null,
        maxItems: 1,
      }),
    );
    expect(first).toMatchObject({
      scope: "representations_parents_inline_hashes_only",
      binaryEnablementReady: false,
      inspected: 1,
      validCount: 1,
      implicitLegacyCount: 1,
      invalidCount: 0,
      isDone: false,
    });
    expect(JSON.stringify(first)).not.toContain("private-");
    const second = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_revisions",
        cursor: first.continueCursor,
        maxItems: 1,
      }),
    );
    expect(second).toMatchObject({
      inspected: 1,
      validCount: 1,
      binaryEnablementReady: false,
      isDone: true,
    });
    expect(
      await f.t.run((ctx) => ctx.db.query("sourceRevisions").collect()),
    ).toEqual(before);
  });

  test("reports mixed representations, hash damage, and broken parents by ID", async () => {
    const f = await fixture();
    const mixedId = await f.t.run((ctx) =>
      ctx.db.insert("sourceRevisions", {
        spaceId: f.spaceId,
        sourceItemId: f.sourceItemId,
        representation: "archived_binary_v1",
        contentHashAuthority: "worker_asserted",
        contentHash: "b".repeat(64),
        byteLength: 10,
        mediaType: "application/pdf",
        inlineText: "mixed",
        capturedAt: 2,
        userId: f.userId,
      }),
    );
    const damagedId = await f.t.run((ctx) =>
      ctx.db.insert("sourceRevisions", {
        spaceId: f.spaceId,
        sourceItemId: f.sourceItemId,
        contentHash: "c".repeat(64),
        byteLength: 7,
        mediaType: "text/plain",
        inlineText: "damaged",
        capturedAt: 3,
        userId: f.userId,
      }),
    );
    const otherSpaceId = await f.t.run((ctx) =>
      ctx.db.insert("spaces", {
        kind: "personal",
        name: "Other",
        createdBy: f.userId,
      }),
    );
    const brokenId = await f.t.run(async (ctx) =>
      ctx.db.insert("sourceRevisions", {
        spaceId: otherSpaceId,
        sourceItemId: f.sourceItemId,
        contentHash: await sha256Utf8("parent"),
        byteLength: 6,
        mediaType: "text/plain",
        inlineText: "parent",
        capturedAt: 4,
        userId: f.userId,
      }),
    );
    const result = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_revisions",
        cursor: null,
        maxItems: 4,
      }),
    );
    expect(result.invalidRows).toEqual(
      expect.arrayContaining([
        { rowId: mixedId, code: "invalid_representation" },
        { rowId: damagedId, code: "hash_mismatch" },
        { rowId: brokenId, code: "parent_mismatch" },
      ]),
    );
  });

  test("audits text hashes and exact revision parent chains", async () => {
    const f = await fixture();
    const revisionId = await insertLegacyRevision(f, "source");
    await f.t.run(async (ctx) =>
      ctx.db.insert("sourceTextVersions", {
        spaceId: f.spaceId,
        sourceRevisionId: revisionId,
        extractionFingerprint: "legacy:é",
        text: "retained😀",
        textHash: await sha256Utf8("retained😀"),
        byteLength: 12,
        evidenceSealed: false,
      }),
    );
    const invalidId = await f.t.run((ctx) =>
      ctx.db.insert("sourceTextVersions", {
        spaceId: f.spaceId,
        sourceRevisionId: revisionId,
        extractionFingerprint: "legacy:bad",
        text: "secret-value",
        textHash: "d".repeat(64),
        byteLength: 12,
        evidenceSealed: false,
      }),
    );
    const result = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_text_versions",
        cursor: null,
        maxItems: 4,
      }),
    );
    expect(result).toMatchObject({
      inspected: 2,
      validCount: 1,
      implicitLegacyCount: 1,
      invalidCount: 1,
      invalidRows: [{ rowId: invalidId, code: "hash_mismatch" }],
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  test("does not accept a chain whose space was deleted", async () => {
    const f = await fixture();
    const revisionId = await insertLegacyRevision(f, "dangling-space");
    await f.t.run((ctx) => ctx.db.delete(f.spaceId));
    const result = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_revisions",
        cursor: null,
        maxItems: 1,
      }),
    );
    expect(result.invalidRows).toEqual([
      { rowId: revisionId, code: "parent_mismatch" },
    ]);
  });

  test("rejects unbounded audit requests", async () => {
    const f = await fixture();
    await expect(
      f.t.run((ctx) =>
        auditLegacyProvenancePage(ctx, {
          phase: "source_revisions",
          cursor: null,
          maxItems: 5,
        }),
      ),
    ).rejects.toThrow("Invalid provenance audit page bounds");
  });
});
