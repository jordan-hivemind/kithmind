import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  createOrGetArchiveReceipt,
  createOrGetParserArtifact,
  type ArchiveReceiptInput,
} from "./artifacts";

const RAW_HASH = "a".repeat(64);
const OUTPUT_HASH = "b".repeat(64);
const CIPHER_HASH = "c".repeat(64);
const PROFILE_HASH = "d".repeat(64);
const ARCHIVE_IDENTITY = "e".repeat(64);
const RECIPIENT = "f".repeat(64);
const REPOSITORY_DOMAIN = "1".repeat(64);
const STORAGE_DOMAIN = "2".repeat(64);

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Archive owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Archive space",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "archive-fixture",
      name: "Archive fixture",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "key",
      keyPrefix: "worker",
      name: "Archive worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalIdHash: "3".repeat(64),
      externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
      lifecycle: "available",
      originalLinkAvailable: true,
      desiredProcessingEpoch: 0,
    });
    const sourceRevisionId = await ctx.db.insert("sourceRevisions", {
      spaceId,
      sourceItemId,
      representation: "archived_binary_v1",
      contentHashAuthority: "worker_asserted",
      contentHash: RAW_HASH,
      byteLength: 1_024,
      mediaType: "application/pdf",
      capturedAt: 100,
      userId,
    });
    return {
      userId,
      spaceId,
      sourceAccountId,
      sourceItemId,
      sourceRevisionId,
      credentialId,
    };
  });
  return { t, ...ids };
}

function parserInput(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    sourceItemId: f.sourceItemId,
    sourceRevisionId: f.sourceRevisionId,
    clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
    parserFingerprint: "docling:locked:v1",
    outputHash: OUTPUT_HASH,
    outputByteLength: 2_048,
    outputMediaType: "application/vnd.docling+json",
    userId: f.userId,
    actorCredentialId: f.credentialId,
    createdAt: 200,
  };
}

function originalReceiptInput(
  f: Awaited<ReturnType<typeof fixture>>,
): ArchiveReceiptInput {
  return {
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    sourceItemId: f.sourceItemId,
    sourceRevisionId: f.sourceRevisionId,
    subjectKind: "original_bytes",
    copyRole: "primary",
    clientReceiptId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c141",
    requestDigest: "8".repeat(64),
    archiveProfileFingerprint: PROFILE_HASH,
    archiveIdentityFingerprint: ARCHIVE_IDENTITY,
    recipientFingerprint: RECIPIENT,
    repositoryKeyDomainFingerprint: REPOSITORY_DOMAIN,
    storageFailureDomainFingerprint: STORAGE_DOMAIN,
    archiveObjectId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c142",
    plaintextHash: RAW_HASH,
    plaintextByteLength: 1_024,
    plaintextMediaType: "application/pdf",
    ciphertextHash: CIPHER_HASH,
    ciphertextByteLength: 1_100,
    readbackVerifiedAt: 220,
    userId: f.userId,
    actorCredentialId: f.credentialId,
    createdAt: 210,
  };
}

describe("immutable parser artifacts and archive receipts", () => {
  test("replays exact artifact identity and rejects changed output", async () => {
    const f = await fixture();
    const first = await f.t.run((ctx) =>
      createOrGetParserArtifact(ctx, parserInput(f)),
    );
    const replay = await f.t.run((ctx) =>
      createOrGetParserArtifact(ctx, parserInput(f)),
    );
    expect(replay._id).toBe(first._id);
    await expect(
      f.t.run((ctx) =>
        createOrGetParserArtifact(ctx, {
          ...parserInput(f),
          outputHash: "9".repeat(64),
        }),
      ),
    ).rejects.toThrow("Conflicting immutable parser artifact");
  });

  test("binds receipt replay to archive authority, object, subject, and actor", async () => {
    const f = await fixture();
    const input = originalReceiptInput(f);
    const first = await f.t.run((ctx) => createOrGetArchiveReceipt(ctx, input));
    const replay = await f.t.run((ctx) =>
      createOrGetArchiveReceipt(ctx, input),
    );
    expect(replay._id).toBe(first._id);
    expect(replay).toMatchObject({
      archiveIdentityFingerprint: ARCHIVE_IDENTITY,
      archiveObjectId: input.archiveObjectId,
      verificationKind: "ciphertext_readback_sha256",
      hashAuthority: "worker_asserted",
    });
    await expect(
      f.t.run((ctx) =>
        createOrGetArchiveReceipt(ctx, {
          ...input,
          clientReceiptId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c143",
          ciphertextHash: "4".repeat(64),
        }),
      ),
    ).rejects.toThrow("Conflicting immutable archive receipt");
    expect(
      await f.t.run((ctx) =>
        ctx.db.query("sourceArtifactArchiveReceipts").collect(),
      ),
    ).toHaveLength(1);
  });

  test("requires current ingest authority before artifact or receipt access", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.patch(f.credentialId, { capabilities: [] }));
    await expect(
      f.t.run((ctx) => createOrGetParserArtifact(ctx, parserInput(f))),
    ).rejects.toThrow("Source account not found");
    await expect(
      f.t.run((ctx) => createOrGetArchiveReceipt(ctx, originalReceiptInput(f))),
    ).rejects.toThrow("Source account not found");
    expect(
      await f.t.run(async (ctx) => ({
        artifacts: await ctx.db.query("sourceParserArtifacts").collect(),
        receipts: await ctx.db.query("sourceArtifactArchiveReceipts").collect(),
      })),
    ).toEqual({ artifacts: [], receipts: [] });
  });

  test("binds parser-output receipts to the exact artifact", async () => {
    const f = await fixture();
    const artifact = await f.t.run((ctx) =>
      createOrGetParserArtifact(ctx, parserInput(f)),
    );
    const receipt = {
      ...originalReceiptInput(f),
      parserArtifactId: artifact._id,
      subjectKind: "parser_output" as const,
      clientReceiptId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c144",
      archiveObjectId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c145",
      plaintextHash: artifact.outputHash,
      plaintextByteLength: artifact.outputByteLength,
      plaintextMediaType: artifact.outputMediaType,
    };
    await expect(
      f.t.run((ctx) =>
        createOrGetArchiveReceipt(ctx, {
          ...receipt,
          plaintextHash: RAW_HASH,
        }),
      ),
    ).rejects.toThrow("Parser-output receipt parent is invalid");
    await expect(
      f.t.run((ctx) => createOrGetArchiveReceipt(ctx, receipt)),
    ).resolves.toMatchObject({ parserArtifactId: artifact._id });
  });
});
