import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import { continueForgetFromWeb } from "../ingestion/model";
import {
  beginSourceItemForget,
  deleteSourceItemProvenanceBatch,
  sha256Utf8,
} from "../provenance/model";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  acknowledgeArchiveDeletion,
  getArchiveForgetTargets,
} from "./archiveForget";
import { parseWorkerRequest, type WorkerRequest } from "./protocol";

const principal = (userId: Id<"users">, credentialId: Id<"apiKeys">) => ({
  userId,
  credentialId,
});

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Archive owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Archive space",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "archive-forget",
      name: "Archive source",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "archive-forget-key",
      keyPrefix: "ob_archive",
      name: "Archive worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    const externalId = "00000000-0000-4000-8000-000000000001";
    const externalIdHash = await sha256Utf8(externalId);
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalIdHash,
      externalId,
      lifecycle: "available",
      originalLinkAvailable: true,
      desiredProcessingEpoch: 0,
    });
    const foreignSourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "archive-foreign",
      name: "Other archive source",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const foreignSourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId: foreignSourceAccountId,
      externalIdHash: "0".repeat(64),
      lifecycle: "forgetting",
      originalLinkAvailable: false,
      desiredProcessingEpoch: 1,
    });
    const sourceRevisionId = await ctx.db.insert("sourceRevisions", {
      spaceId,
      sourceItemId,
      representation: "archived_binary_v1",
      contentHashAuthority: "worker_asserted",
      contentHash: "2".repeat(64),
      byteLength: 100,
      mediaType: "application/pdf",
      capturedAt: 1,
      userId,
    });
    const parserArtifactId = await ctx.db.insert("sourceParserArtifacts", {
      spaceId,
      sourceAccountId,
      sourceItemId,
      sourceRevisionId,
      clientArtifactId: "00000000-0000-4000-8000-000000000002",
      parserFingerprint: "3".repeat(64),
      outputHash: "4".repeat(64),
      outputByteLength: 200,
      outputMediaType: "application/vnd.docling+json",
      hashAuthority: "worker_asserted",
      userId,
      actorCredentialId: credentialId,
      createdAt: 2,
    });
    const receipts: Id<"sourceArtifactArchiveReceipts">[] = [];
    for (const [index, subjectKind, copyRole] of [
      [0, "original_bytes", "primary"],
      [1, "original_bytes", "independent_backup"],
      [2, "parser_output", "primary"],
      [3, "parser_output", "independent_backup"],
    ] as const) {
      const parserSubject = subjectKind === "parser_output";
      const archiveIdentityFingerprint = `${index + 5}`.repeat(64);
      const receiptId = await ctx.db.insert("sourceArtifactArchiveReceipts", {
        spaceId,
        sourceAccountId,
        sourceItemId,
        sourceRevisionId,
        ...(parserSubject ? { parserArtifactId } : {}),
        subjectKind,
        copyRole,
        clientReceiptId: `00000000-0000-4000-8000-00000000000${index + 3}`,
        requestDigest: `${index + 1}`.repeat(64),
        receiptVersion: "archive_receipt_v1",
        archiveRepresentation: "age_encrypted_v1",
        archiveProfileFingerprint: "9".repeat(64),
        archiveIdentityFingerprint,
        recipientFingerprint: `${index + 1}`.repeat(64),
        repositoryKeyDomainFingerprint: `${index + 2}`.repeat(64),
        storageFailureDomainFingerprint: `${index + 3}`.repeat(64),
        archiveObjectId: `00000000-0000-4000-8000-00000000001${index}`,
        plaintextHash: parserSubject ? "4".repeat(64) : "2".repeat(64),
        plaintextByteLength: parserSubject ? 200 : 100,
        plaintextMediaType: parserSubject
          ? "application/vnd.docling+json"
          : "application/pdf",
        hashAuthority: "worker_asserted",
        ciphertextHash: `${index + 5}`.repeat(64),
        ciphertextByteLength: parserSubject ? 240 : 140,
        verificationKind: "ciphertext_readback_sha256",
        readbackVerifiedAt: 3,
        userId,
        actorCredentialId: credentialId,
        createdAt: 2,
      });
      receipts.push(receiptId);
      await ctx.db.insert("sourceArtifactArchiveBindings", {
        spaceId,
        sourceAccountId,
        sourceItemId,
        sourceRevisionId,
        ...(parserSubject ? { parserArtifactId } : {}),
        subjectKind,
        subjectKey: await sha256Utf8(
          JSON.stringify([
            "archive-subject:v1",
            subjectKind,
            sourceRevisionId,
            parserSubject ? parserArtifactId : null,
          ]),
        ),
        copyRole,
        receiptId,
        archiveIdentityFingerprint,
        bindingEpoch: 0,
        updatedAt: 3,
        userId,
        actorCredentialId: credentialId,
      });
    }
    return {
      userId,
      spaceId,
      sourceAccountId,
      sourceItemId,
      foreignSourceItemId,
      sourceRevisionId,
      parserArtifactId,
      credentialId,
      receipts,
      externalIdHash,
    };
  });
  return { t, ...ids };
}

function targetsRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  forgetEpoch: number,
  cursor: string | null = null,
): Extract<WorkerRequest, { operation: "archive.forgetTargets" }> {
  return {
    protocolVersion: 1,
    operation: "archive.forgetTargets",
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    requestId: "00000000-0000-4000-8000-000000000020",
    sourceItemId: f.sourceItemId,
    expectedForgetEpoch: forgetEpoch,
    paginationOpts: { cursor, numItems: 2 },
  };
}

function ackRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  input: {
    requestId: string;
    deletionId: string;
    receiptId: Id<"sourceArtifactArchiveReceipts">;
    backup?: boolean;
    liveRepository?: boolean;
  },
): Extract<WorkerRequest, { operation: "archive.ackDeletion" }> {
  const request = {
    protocolVersion: 1,
    operation: "archive.ackDeletion",
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    requestId: input.requestId,
    sourceItemId: f.sourceItemId,
    expectedForgetEpoch: 1,
    deletionId: input.deletionId,
    receiptId: input.receiptId,
    objectOutcome: "deleted",
    ...(input.backup ? { backupOutcome: "already_missing" as const } : {}),
  } as const;
  return input.liveRepository
    ? {
        ...request,
        absenceAuthority: "worker_asserted_live_repository_absence",
        retentionDisclosure: "provider_retained_deleted_history_possible",
      }
    : request;
}

async function beginForget(f: Awaited<ReturnType<typeof fixture>>) {
  return await f.t.run((ctx) =>
    beginSourceItemForget(ctx, {
      spaceId: f.spaceId,
      sourceItemId: f.sourceItemId,
      forgottenAt: 10,
      forgottenBy: f.userId,
    }),
  );
}

describe("archive forget acknowledgements", () => {
  test("strictly parses bounded target and acknowledgement envelopes", async () => {
    const f = await fixture();
    expect(parseWorkerRequest(targetsRequest(f, 1))).toMatchObject({
      operation: "archive.forgetTargets",
      sourceItemId: f.sourceItemId,
      paginationOpts: { numItems: 2 },
    });
    expect(() =>
      parseWorkerRequest({
        ...targetsRequest(f, 1),
        paginationOpts: { cursor: null, numItems: 5 },
      }),
    ).toThrow("Invalid worker request");
    expect(() => parseWorkerRequest(targetsRequest(f, 0))).toThrow(
      "Invalid worker request",
    );
    expect(() =>
      parseWorkerRequest({
        ...ackRequest(f, {
          requestId: "00000000-0000-4000-8000-000000000050",
          deletionId: "00000000-0000-4000-8000-000000000051",
          receiptId: f.receipts[0]!,
        }),
        unexpected: true,
      }),
    ).toThrow("Invalid worker request");
    const physical = ackRequest(f, {
      requestId: "00000000-0000-4000-8000-000000000052",
      deletionId: "00000000-0000-4000-8000-000000000053",
      receiptId: f.receipts[0]!,
    });
    expect(parseWorkerRequest(physical)).toEqual(physical);
    for (const invalid of [
      {
        ...physical,
        retentionDisclosure: "provider_retained_deleted_history_possible",
      },
      {
        ...physical,
        absenceAuthority: "worker_asserted_live_repository_absence",
      },
      {
        ...physical,
        absenceAuthority: "worker_asserted_physical_absence",
        retentionDisclosure: "provider_retained_deleted_history_possible",
      },
    ])
      expect(() => parseWorkerRequest(invalid)).toThrow(
        "Invalid worker request",
      );
  });

  test("enumerates bounded immutable targets only after the owner begins forget", async () => {
    const f = await fixture();
    await expect(
      f.t.run((ctx) =>
        getArchiveForgetTargets(
          ctx,
          principal(f.userId, f.credentialId),
          targetsRequest(f, 0),
        ),
      ),
    ).rejects.toThrow("stale_observation");
    const forgetEpoch = await beginForget(f);
    const hidden = await f.t.run((ctx) => ctx.db.get(f.sourceItemId));
    expect(hidden).toMatchObject({
      lifecycle: "forgetting",
      originalLinkAvailable: false,
      desiredProcessingEpoch: forgetEpoch,
    });
    const first = await f.t.run((ctx) =>
      getArchiveForgetTargets(
        ctx,
        principal(f.userId, f.credentialId),
        targetsRequest(f, forgetEpoch),
      ),
    );
    expect(first.targets).toHaveLength(2);
    expect(first.sourceExternalIdHash).toBe(f.externalIdHash);
    expect(first.targets.every((row) => row.ack === undefined)).toBe(true);
    const second = await f.t.run((ctx) =>
      getArchiveForgetTargets(
        ctx,
        principal(f.userId, f.credentialId),
        targetsRequest(f, forgetEpoch, first.continueCursor),
      ),
    );
    expect([...first.targets, ...second.targets]).toHaveLength(4);
    expect(second.isDone).toBe(true);
  });

  test("returns the authoritative external identity hash with no archive receipts", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (const binding of await ctx.db
        .query("sourceArtifactArchiveBindings")
        .collect())
        await ctx.db.delete(binding._id);
      for (const receipt of await ctx.db
        .query("sourceArtifactArchiveReceipts")
        .collect())
        await ctx.db.delete(receipt._id);
    });
    await beginForget(f);
    const result = await f.t.run((ctx) =>
      getArchiveForgetTargets(
        ctx,
        principal(f.userId, f.credentialId),
        targetsRequest(f, 1),
      ),
    );
    expect(result).toMatchObject({
      sourceItemId: f.sourceItemId,
      sourceExternalIdHash: f.externalIdHash,
      forgetEpoch: 1,
      targets: [],
      isDone: true,
    });
  });

  test("denies stale, cross-source, and disabled target reads", async () => {
    const f = await fixture();
    await beginForget(f);
    await expect(
      f.t.run((ctx) =>
        getArchiveForgetTargets(ctx, principal(f.userId, f.credentialId), {
          ...targetsRequest(f, 2),
          expectedForgetEpoch: 2,
        }),
      ),
    ).rejects.toThrow("stale_observation");
    await expect(
      f.t.run((ctx) =>
        getArchiveForgetTargets(ctx, principal(f.userId, f.credentialId), {
          ...targetsRequest(f, 1),
          sourceItemId: f.foreignSourceItemId,
        }),
      ),
    ).rejects.toThrow("not_found");
    await f.t.run((ctx) => ctx.db.patch(f.sourceAccountId, { enabled: false }));
    await expect(
      f.t.run((ctx) =>
        getArchiveForgetTargets(
          ctx,
          principal(f.userId, f.credentialId),
          targetsRequest(f, 1),
        ),
      ),
    ).rejects.toThrow("not_authorized");
  });

  test("binds exact deletion, request, receipt, role, and forget epoch identities", async () => {
    const f = await fixture();
    await beginForget(f);
    const request = ackRequest(f, {
      requestId: "00000000-0000-4000-8000-000000000021",
      deletionId: "00000000-0000-4000-8000-000000000022",
      receiptId: f.receipts[0]!,
    });
    const accepted = await f.t.run((ctx) =>
      acknowledgeArchiveDeletion(
        ctx,
        principal(f.userId, f.credentialId),
        request,
        20,
      ),
    );
    expect(accepted).toMatchObject({
      receiptId: f.receipts[0],
      absenceAuthority: "worker_asserted_physical_absence",
      reused: false,
      completedAt: 20,
    });
    const storedAck = await f.t.run((ctx) =>
      ctx.db
        .query("sourceArtifactDeletionAcks")
        .withIndex("by_receiptId_and_forgetEpoch", (q) =>
          q.eq("receiptId", f.receipts[0]!).eq("forgetEpoch", 1),
        )
        .unique(),
    );
    expect(storedAck).toMatchObject({
      sourceRevisionId: f.sourceRevisionId,
      subjectKind: "original_bytes",
      receiptVersion: "archive_receipt_v1",
      archiveRepresentation: "age_encrypted_v1",
      plaintextHash: "2".repeat(64),
      plaintextByteLength: 100,
      hashAuthority: "worker_asserted",
      verificationKind: "ciphertext_readback_sha256",
      receiptActorCredentialId: f.credentialId,
    });
    expect(storedAck?.retentionDisclosure).toBeUndefined();
    expect(storedAck?.requestDigest).toBe(
      await sha256Utf8(
        `archive-deletion-ack:v1\0${JSON.stringify([
          request.spaceId,
          request.sourceAccountId,
          request.requestId,
          request.sourceItemId,
          request.expectedForgetEpoch,
          request.deletionId,
          request.receiptId,
          request.objectOutcome,
          request.backupOutcome ?? null,
        ])}`,
      ),
    );
    const acknowledgedPage = await f.t.run((ctx) =>
      getArchiveForgetTargets(
        ctx,
        principal(f.userId, f.credentialId),
        targetsRequest(f, 1),
      ),
    );
    expect(acknowledgedPage.targets[0]?.ack).toMatchObject({
      deletionId: request.deletionId,
      completedAt: 20,
    });
    await expect(
      f.t.run((ctx) =>
        deleteSourceItemProvenanceBatch(ctx, {
          spaceId: f.spaceId,
          sourceItemId: f.sourceItemId,
          limit: 1,
        }),
      ),
    ).resolves.toMatchObject({
      phase: "archiveBindings",
      deleted: 1,
      done: false,
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.receipts[0]!))).not.toBeNull();
    await expect(
      f.t.run((ctx) =>
        deleteSourceItemProvenanceBatch(ctx, {
          spaceId: f.spaceId,
          sourceItemId: f.sourceItemId,
          limit: 1,
        }),
      ),
    ).resolves.toMatchObject({
      phase: "archiveReceipts",
      deleted: 1,
      done: false,
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.receipts[0]!))).toBeNull();
    await expect(
      f.t.run((ctx) =>
        acknowledgeArchiveDeletion(
          ctx,
          principal(f.userId, f.credentialId),
          request,
          30,
        ),
      ),
    ).resolves.toMatchObject({ reused: true, completedAt: 20 });
    await expect(
      f.t.run((ctx) =>
        acknowledgeArchiveDeletion(
          ctx,
          principal(f.userId, f.credentialId),
          { ...request, receiptId: f.receipts[2]! },
          30,
        ),
      ),
    ).rejects.toThrow("request_conflict");
    await expect(
      f.t.run((ctx) =>
        acknowledgeArchiveDeletion(
          ctx,
          principal(f.userId, f.credentialId),
          ackRequest(f, {
            requestId: "00000000-0000-4000-8000-000000000023",
            deletionId: "00000000-0000-4000-8000-000000000024",
            receiptId: f.receipts[1]!,
          }),
          30,
        ),
      ),
    ).rejects.toThrow("invalid_request");
  });

  test("binds live repository absence and provider retention to parser backups only", async () => {
    const f = await fixture();
    await beginForget(f);
    const request = ackRequest(f, {
      requestId: "00000000-0000-4000-8000-000000000025",
      deletionId: "00000000-0000-4000-8000-000000000026",
      receiptId: f.receipts[3]!,
      backup: true,
      liveRepository: true,
    });
    await expect(
      f.t.run((ctx) =>
        acknowledgeArchiveDeletion(
          ctx,
          principal(f.userId, f.credentialId),
          request,
          25,
        ),
      ),
    ).resolves.toMatchObject({
      absenceAuthority: "worker_asserted_live_repository_absence",
      retentionDisclosure: "provider_retained_deleted_history_possible",
      reused: false,
    });
    await expect(
      f.t.run((ctx) =>
        acknowledgeArchiveDeletion(
          ctx,
          principal(f.userId, f.credentialId),
          request,
          26,
        ),
      ),
    ).resolves.toMatchObject({ reused: true, completedAt: 25 });
    await expect(
      f.t.run((ctx) =>
        acknowledgeArchiveDeletion(
          ctx,
          principal(f.userId, f.credentialId),
          {
            ...request,
            absenceAuthority: "worker_asserted_physical_absence",
            retentionDisclosure: undefined,
          },
          26,
        ),
      ),
    ).rejects.toThrow("request_conflict");
    const firstPage = await f.t.run((ctx) =>
      getArchiveForgetTargets(
        ctx,
        principal(f.userId, f.credentialId),
        targetsRequest(f, 1),
      ),
    );
    const page = await f.t.run((ctx) =>
      getArchiveForgetTargets(
        ctx,
        principal(f.userId, f.credentialId),
        targetsRequest(f, 1, firstPage.continueCursor),
      ),
    );
    expect(
      page.targets.find((target) => target.receiptId === f.receipts[3])?.ack,
    ).toMatchObject({
      absenceAuthority: "worker_asserted_live_repository_absence",
      retentionDisclosure: "provider_retained_deleted_history_possible",
    });

    for (const [receiptId, backup, suffix] of [
      [f.receipts[2]!, false, "7"],
      [f.receipts[1]!, true, "8"],
    ] as const) {
      await expect(
        f.t.run((ctx) =>
          acknowledgeArchiveDeletion(
            ctx,
            principal(f.userId, f.credentialId),
            ackRequest(f, {
              requestId: `00000000-0000-4000-8000-00000000002${suffix}`,
              deletionId: `00000000-0000-4000-8000-00000000003${suffix}`,
              receiptId,
              backup,
              liveRepository: true,
            }),
            27,
          ),
        ),
      ).rejects.toThrow("invalid_request");
    }
  });

  test("denies disabled and revoked callers without invalidating accepted acks", async () => {
    const f = await fixture();
    await beginForget(f);
    for (let index = 0; index < f.receipts.length; index += 1) {
      await f.t.run((ctx) =>
        acknowledgeArchiveDeletion(
          ctx,
          principal(f.userId, f.credentialId),
          ackRequest(f, {
            requestId: `00000000-0000-4000-8000-00000000003${index}`,
            deletionId: `00000000-0000-4000-8000-00000000004${index}`,
            receiptId: f.receipts[index]!,
            backup: index === 1 || index === 3,
          }),
          30 + index,
        ),
      );
    }
    await f.t.run((ctx) => ctx.db.delete(f.credentialId));
    await expect(
      f.t.run((ctx) =>
        getArchiveForgetTargets(
          ctx,
          principal(f.userId, f.credentialId),
          targetsRequest(f, 1),
        ),
      ),
    ).rejects.toThrow("not_authorized");
    let done = false;
    let durableSummaryObserved = false;
    for (let attempt = 0; attempt < 30 && !done; attempt += 1) {
      const result = await f.t.run((ctx) =>
        continueForgetFromWeb(ctx, {
          principal: { userId: f.userId },
          sourceItemId: f.sourceItemId,
        }),
      );
      if (result.phase === "archiveDeletionSummary") {
        const summary = await f.t.run(async (ctx) => ({
          item: await ctx.db.get(f.sourceItemId),
          acks: await ctx.db
            .query("sourceArtifactDeletionAcks")
            .withIndex("by_sourceItemId", (q) =>
              q.eq("sourceItemId", f.sourceItemId),
            )
            .collect(),
        }));
        expect(summary.item).toMatchObject({
          archiveDeletionForgetEpoch: 1,
          archiveDeletionReceiptCount: 4,
        });
        expect(summary.item?.archiveDeletionCompletedAt).toEqual(
          expect.any(Number),
        );
        expect(summary.acks).toHaveLength(4);
        durableSummaryObserved = true;
      }
      done = result.done;
    }
    expect(durableSummaryObserved).toBe(true);
    expect(done).toBe(true);
    const final = await f.t.run(async (ctx) => ({
      item: await ctx.db.get(f.sourceItemId),
      receipts: await ctx.db.query("sourceArtifactArchiveReceipts").collect(),
      bindings: await ctx.db.query("sourceArtifactArchiveBindings").collect(),
      acks: await ctx.db.query("sourceArtifactDeletionAcks").collect(),
      artifacts: await ctx.db.query("sourceParserArtifacts").collect(),
    }));
    expect(final.item).toMatchObject({
      lifecycle: "forgotten",
      archiveDeletionForgetEpoch: 1,
      archiveDeletionReceiptCount: 4,
    });
    expect(final.item?.archiveDeletionCompletedAt).toEqual(expect.any(Number));
    expect(final.receipts).toEqual([]);
    expect(final.bindings).toEqual([]);
    expect(final.acks).toEqual([]);
    expect(final.artifacts).toEqual([]);
  });

  test("refuses provenance cleanup until every physical target is acknowledged", async () => {
    const f = await fixture();
    await beginForget(f);
    const result = await f.t.run((ctx) =>
      continueForgetFromWeb(ctx, {
        principal: { userId: f.userId },
        sourceItemId: f.sourceItemId,
      }),
    );
    expect(result).toMatchObject({
      phase: "archive_cleanup_required",
      deleted: 0,
      done: false,
    });
    expect(
      await f.t.run((ctx) => ctx.db.get(f.sourceRevisionId)),
    ).not.toBeNull();
  });

  test("refuses cleanup when the retained acknowledgement snapshot is incoherent", async () => {
    const f = await fixture();
    await beginForget(f);
    await f.t.run((ctx) =>
      acknowledgeArchiveDeletion(
        ctx,
        principal(f.userId, f.credentialId),
        ackRequest(f, {
          requestId: "00000000-0000-4000-8000-000000000060",
          deletionId: "00000000-0000-4000-8000-000000000061",
          receiptId: f.receipts[0]!,
        }),
        40,
      ),
    );
    await f.t.run(async (ctx) => {
      const ack = await ctx.db
        .query("sourceArtifactDeletionAcks")
        .withIndex("by_receiptId_and_forgetEpoch", (q) =>
          q.eq("receiptId", f.receipts[0]!).eq("forgetEpoch", 1),
        )
        .unique();
      if (!ack) throw new Error("missing acknowledgement");
      await ctx.db.patch(ack._id, {
        archiveProfileFingerprint: "0".repeat(64),
      });
    });
    await expect(
      f.t.run((ctx) =>
        deleteSourceItemProvenanceBatch(ctx, {
          spaceId: f.spaceId,
          sourceItemId: f.sourceItemId,
        }),
      ),
    ).rejects.toThrow("incoherent");
    expect(await f.t.run((ctx) => ctx.db.get(f.receipts[0]!))).not.toBeNull();
  });
});
