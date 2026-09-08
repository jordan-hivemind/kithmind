import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  deleteSourceItemProvenanceBatch,
  sha256Utf8,
} from "../provenance/model";
import { providerOriginalReferenceFingerprint } from "../provenance/providerOriginals";
import {
  acknowledgeProviderOriginalDetach,
  getProviderOriginalForgetTargets,
} from "./providerOriginalForget";
import { parseWorkerRequest } from "./protocol";

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Provider owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Provider forget",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "provider-forget",
      name: "Provider forget",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "1".repeat(64),
      keyPrefix: "provider",
      name: "Provider worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    const externalId = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c190";
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalId,
      externalIdHash: await sha256Utf8(externalId),
      lifecycle: "forgetting",
      originalLinkAvailable: false,
      desiredProcessingEpoch: 1,
    });
    const sourceRevisionId = await ctx.db.insert("sourceRevisions", {
      spaceId,
      sourceItemId,
      representation: "archived_binary_v1",
      contentHash: "2".repeat(64),
      contentHashAuthority: "worker_asserted",
      byteLength: 1_024,
      mediaType: "application/pdf",
      capturedAt: 10,
      userId,
    });
    const referenceFingerprint = await providerOriginalReferenceFingerprint({
      referenceVersion: "provider_original_v1",
      providerKind: "dropbox_v1",
      clientReferenceId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c191",
      sourceContentHash: "2".repeat(64),
      sourceByteLength: 1_024,
      providerAccountIdHash: "5".repeat(64),
      providerRootDirectoryIdHash: "6".repeat(64),
      providerFileIdHash: "7".repeat(64),
      providerRevision: "015f00feed",
      providerContentHash: "8".repeat(64),
      verifiedAt: 10,
      locatorBundle: {
        bindingId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c192",
        manifestFingerprint: "9".repeat(64),
        recipientFingerprint: "a".repeat(64),
        repositoryKeyDomainFingerprint: "b".repeat(64),
        repositoryId: "c".repeat(64),
        snapshotId: "d".repeat(64),
        objectName: "provider-locator.json.age",
        ciphertextHash: "e".repeat(64),
        ciphertextByteLength: 512,
        readbackVerifiedAt: 11,
      },
      createdAt: 10,
    });
    const referenceId = await ctx.db.insert(
      "sourceProviderOriginalReferences",
      {
        spaceId,
        sourceAccountId,
        sourceItemId,
        sourceRevisionId,
        clientReferenceId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c191",
        requestDigest: "3".repeat(64),
        referenceVersion: "provider_original_v1",
        providerKind: "dropbox_v1",
        referenceFingerprint,
        sourceContentHash: "2".repeat(64),
        sourceByteLength: 1_024,
        providerAccountIdHash: "5".repeat(64),
        providerRootDirectoryIdHash: "6".repeat(64),
        providerFileIdHash: "7".repeat(64),
        providerRevision: "015f00feed",
        providerContentHash: "8".repeat(64),
        verifiedAt: 10,
        locatorBindingId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c192",
        locatorManifestFingerprint: "9".repeat(64),
        locatorRecipientFingerprint: "a".repeat(64),
        locatorRepositoryKeyDomainFingerprint: "b".repeat(64),
        locatorRepositoryId: "c".repeat(64),
        locatorSnapshotId: "d".repeat(64),
        locatorObjectName: "provider-locator.json.age",
        locatorCiphertextHash: "e".repeat(64),
        locatorCiphertextByteLength: 512,
        locatorReadbackVerifiedAt: 11,
        verificationAuthority: "worker_asserted",
        userId,
        actorCredentialId: credentialId,
        createdAt: 10,
      },
    );
    await ctx.db.insert("sourceProviderOriginalBindings", {
      spaceId,
      sourceAccountId,
      sourceItemId,
      sourceRevisionId,
      referenceId,
      bindingEpoch: 0,
      verifiedAt: 10,
      userId,
      actorCredentialId: credentialId,
      updatedAt: 10,
    });
    return {
      userId,
      spaceId,
      sourceAccountId,
      credentialId,
      sourceItemId,
      sourceRevisionId,
      referenceId,
    };
  });
  return {
    t,
    ...ids,
    principal: { userId: ids.userId, credentialId: ids.credentialId },
  };
}

function base(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    protocolVersion: 1 as const,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  };
}

function detachRequest(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    ...base(f),
    operation: "providerOriginal.ackDetach" as const,
    requestId: "detach-request-1",
    sourceItemId: f.sourceItemId,
    expectedForgetEpoch: 1,
    detachId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c193",
    referenceId: f.referenceId,
    locatorBindingId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c192",
    locatorRepositoryId: "c".repeat(64),
    locatorSnapshotId: "d".repeat(64),
    locatorObjectName: "provider-locator.json.age",
    referenceOutcome: "detached" as const,
    locatorBundleOutcome: "deleted" as const,
    locatorAbsenceAuthority: "worker_asserted_live_repository_absence" as const,
    retentionDisclosure: "provider_retained_deleted_history_possible" as const,
    providerSourceOutcome: "retained_unchanged" as const,
  };
}

describe("provider original forget", () => {
  test("returns exact locator targets, replays one detach, and rejects duplicate authority", async () => {
    const f = await fixture();
    const targets = parseWorkerRequest({
      ...base(f),
      operation: "providerOriginal.forgetTargets",
      requestId: "targets-1",
      sourceItemId: f.sourceItemId,
      expectedForgetEpoch: 1,
      paginationOpts: { cursor: null, numItems: 4 },
    });
    if (targets.operation !== "providerOriginal.forgetTargets")
      throw new Error("bad targets");
    await expect(
      f.t.run((ctx) =>
        getProviderOriginalForgetTargets(ctx, f.principal, targets),
      ),
    ).resolves.toMatchObject({
      targets: [
        { referenceId: f.referenceId, locatorRepositoryId: "c".repeat(64) },
      ],
    });
    const request = parseWorkerRequest(detachRequest(f));
    if (request.operation !== "providerOriginal.ackDetach")
      throw new Error("bad detach");
    const first = await f.t.run((ctx) =>
      acknowledgeProviderOriginalDetach(ctx, f.principal, request, 100),
    );
    expect(first).toMatchObject({
      providerSourceOutcome: "retained_unchanged",
      locatorAbsenceAuthority: "worker_asserted_live_repository_absence",
      reused: false,
    });
    await expect(
      f.t.run((ctx) =>
        acknowledgeProviderOriginalDetach(ctx, f.principal, request, 101),
      ),
    ).resolves.toEqual({ ...first, reused: true });
    const duplicate = parseWorkerRequest({
      ...detachRequest(f),
      requestId: "detach-request-2",
      detachId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c194",
    });
    if (duplicate.operation !== "providerOriginal.ackDetach")
      throw new Error("bad detach");
    await expect(
      f.t.run((ctx) =>
        acknowledgeProviderOriginalDetach(ctx, f.principal, duplicate, 102),
      ),
    ).rejects.toThrow();
    const targetAfter = await f.t.run((ctx) =>
      getProviderOriginalForgetTargets(ctx, f.principal, targets),
    );
    expect(targetAfter.targets[0]?.ack).toMatchObject({
      detachId: request.detachId,
      providerSourceOutcome: "retained_unchanged",
    });
    await expect(
      f.t.run((ctx) =>
        deleteSourceItemProvenanceBatch(ctx, {
          spaceId: f.spaceId,
          sourceItemId: f.sourceItemId,
          limit: 1,
        }),
      ),
    ).resolves.toMatchObject({ phase: "providerOriginalBindings" });
    await expect(
      f.t.run((ctx) =>
        deleteSourceItemProvenanceBatch(ctx, {
          spaceId: f.spaceId,
          sourceItemId: f.sourceItemId,
          limit: 1,
        }),
      ),
    ).resolves.toMatchObject({ phase: "providerOriginalReferences" });
  });

  test("malformed detach evidence cannot authorize reference cleanup", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.insert("sourceProviderOriginalDetachAcks", {
        ackVersion: "provider_original_detach_ack_v1",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: f.sourceItemId,
        sourceRevisionId: f.sourceRevisionId,
        referenceId: f.referenceId,
        forgetEpoch: 1,
        detachId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c193",
        requestId: "malformed",
        requestDigest: "3".repeat(64),
        referenceFingerprint: "0".repeat(64),
        locatorBindingId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c192",
        locatorRepositoryId: "c".repeat(64),
        locatorSnapshotId: "d".repeat(64),
        locatorObjectName: "provider-locator.json.age",
        referenceOutcome: "detached",
        locatorBundleOutcome: "deleted",
        locatorAbsenceAuthority: "worker_asserted_live_repository_absence",
        retentionDisclosure: "provider_retained_deleted_history_possible",
        providerSourceOutcome: "retained_unchanged",
        actorUserId: f.userId,
        actorCredentialId: f.credentialId,
        completedAt: 100,
      }),
    );
    await expect(
      f.t.run((ctx) =>
        deleteSourceItemProvenanceBatch(ctx, {
          spaceId: f.spaceId,
          sourceItemId: f.sourceItemId,
          limit: 1,
        }),
      ),
    ).rejects.toThrow("Provider original detach acknowledgement is invalid");
    await expect(
      f.t.run((ctx) => ctx.db.get(f.referenceId)),
    ).resolves.not.toBeNull();
  });
});
