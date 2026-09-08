import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { PrincipalRef } from "../../lib/spaces";
import {
  archiveDeletionAckMatchesReceipt,
  loadArchiveDeletionAck,
} from "../provenance/archiveDeletion";
import { sha256Utf8 } from "../provenance/model";
import {
  MAX_ARCHIVED_BINARY_BYTES,
  MAX_PARSER_ARTIFACT_BYTES,
  parseSourceRevisionRepresentation,
} from "../provenance/representations";
import { requireWorkerSourceAccount } from "./auth";
import { workerProtocolError } from "./errors";
import { consumeWorkerMutationRateLimit } from "./rateLimit";
import type {
  WorkerArchiveAckDeletionResult,
  WorkerArchiveDeletionAckSummary,
  WorkerArchiveForgetTarget,
  WorkerArchiveForgetTargetsResult,
  WorkerRequest,
} from "./protocol";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ARCHIVE_CIPHERTEXT_BYTES = 65 * 1_024 * 1_024;
const MAX_MEDIA_TYPE_CHARS = 255;

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type LoadedSource = Awaited<ReturnType<typeof requireWorkerSourceAccount>>;

function validDigest(value: string): boolean {
  return SHA256.test(value);
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validBoundedText(value: string, maximumCharacters: number): boolean {
  return value.length >= 1 && value.length <= maximumCharacters;
}

async function requireForgettingItem(
  ctx: ReadCtx,
  principal: PrincipalRef,
  request: {
    spaceId: string;
    sourceAccountId: string;
    sourceItemId: string;
    expectedForgetEpoch: number;
  },
): Promise<{ source: LoadedSource; item: Doc<"sourceItems"> }> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const sourceItemId = ctx.db.normalizeId("sourceItems", request.sourceItemId);
  if (!sourceItemId) throw workerProtocolError("invalid_request");
  const item = await ctx.db.get(sourceItemId);
  if (
    !item ||
    item.spaceId !== source.spaceId ||
    item.sourceAccountId !== source.account._id
  )
    throw workerProtocolError("not_found");
  if (
    item.lifecycle !== "forgetting" ||
    item.desiredProcessingEpoch !== request.expectedForgetEpoch
  )
    throw workerProtocolError("stale_observation");
  if (
    item.externalId === undefined ||
    (await sha256Utf8(item.externalId)) !== item.externalIdHash
  )
    throw workerProtocolError("scan_conflict");
  return { source, item };
}

async function requireReceiptChain(
  ctx: ReadCtx,
  source: LoadedSource,
  item: Doc<"sourceItems">,
  receipt: Doc<"sourceArtifactArchiveReceipts">,
): Promise<void> {
  const revision = await ctx.db.get(receipt.sourceRevisionId);
  if (
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account._id ||
    receipt.sourceItemId !== item._id ||
    !revision ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== item._id ||
    receipt.receiptVersion !== "archive_receipt_v1" ||
    receipt.archiveRepresentation !== "age_encrypted_v1" ||
    receipt.hashAuthority !== "worker_asserted" ||
    receipt.verificationKind !== "ciphertext_readback_sha256" ||
    !UUID.test(receipt.clientReceiptId) ||
    !UUID.test(receipt.archiveObjectId) ||
    !validDigest(receipt.requestDigest) ||
    !validDigest(receipt.archiveProfileFingerprint) ||
    !validDigest(receipt.archiveIdentityFingerprint) ||
    !validDigest(receipt.recipientFingerprint) ||
    !validDigest(receipt.repositoryKeyDomainFingerprint) ||
    !validDigest(receipt.storageFailureDomainFingerprint) ||
    !validDigest(receipt.plaintextHash) ||
    !validDigest(receipt.ciphertextHash) ||
    !Number.isSafeInteger(receipt.ciphertextByteLength) ||
    receipt.ciphertextByteLength < 1 ||
    receipt.ciphertextByteLength > MAX_ARCHIVE_CIPHERTEXT_BYTES ||
    !validTimestamp(receipt.readbackVerifiedAt) ||
    !validTimestamp(receipt.createdAt) ||
    receipt.readbackVerifiedAt < receipt.createdAt
  )
    throw workerProtocolError("scan_conflict");
  try {
    if (
      parseSourceRevisionRepresentation(revision).kind !== "archived_binary_v1"
    )
      throw new Error("invalid revision");
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  if (receipt.subjectKind === "original_bytes") {
    if (
      receipt.parserArtifactId !== undefined ||
      receipt.plaintextHash !== revision.contentHash ||
      receipt.plaintextByteLength !== revision.byteLength ||
      receipt.plaintextMediaType !== revision.mediaType
    )
      throw workerProtocolError("scan_conflict");
    return;
  }
  const artifact = receipt.parserArtifactId
    ? await ctx.db.get(receipt.parserArtifactId)
    : null;
  if (
    !artifact ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account._id ||
    artifact.sourceItemId !== item._id ||
    artifact.sourceRevisionId !== revision._id ||
    receipt.plaintextHash !== artifact.outputHash ||
    receipt.plaintextByteLength !== artifact.outputByteLength ||
    receipt.plaintextMediaType !== artifact.outputMediaType
  )
    throw workerProtocolError("scan_conflict");
}

function ackSummary(
  ack: Doc<"sourceArtifactDeletionAcks">,
): WorkerArchiveDeletionAckSummary {
  const common = {
    deletionId: ack.deletionId,
    receiptId: ack.receiptId,
    forgetEpoch: ack.forgetEpoch,
    objectOutcome: ack.objectOutcome,
    ...(ack.backupOutcome === undefined
      ? {}
      : { backupOutcome: ack.backupOutcome }),
    completedAt: ack.completedAt,
  };
  if (ack.absenceAuthority === "worker_asserted_live_repository_absence") {
    if (
      ack.copyRole !== "independent_backup" ||
      ack.subjectKind !== "parser_output" ||
      ack.backupOutcome === undefined ||
      ack.retentionDisclosure !== "provider_retained_deleted_history_possible"
    )
      throw new Error("Archive deletion acknowledgement is incoherent");
    return {
      ...common,
      backupOutcome: ack.backupOutcome,
      absenceAuthority: ack.absenceAuthority,
      retentionDisclosure: ack.retentionDisclosure,
    };
  }
  if (ack.retentionDisclosure !== undefined)
    throw new Error("Archive deletion acknowledgement is incoherent");
  return {
    ...common,
    absenceAuthority: "worker_asserted_physical_absence",
  };
}

function targetResult(
  receipt: Doc<"sourceArtifactArchiveReceipts">,
  forgetEpoch: number,
  ack: Doc<"sourceArtifactDeletionAcks"> | null,
): WorkerArchiveForgetTarget {
  return {
    receiptId: receipt._id,
    clientReceiptId: receipt.clientReceiptId,
    receiptRequestDigest: receipt.requestDigest,
    subjectKind: receipt.subjectKind,
    copyRole: receipt.copyRole,
    archiveIdentityFingerprint: receipt.archiveIdentityFingerprint,
    archiveObjectId: receipt.archiveObjectId,
    ciphertextHash: receipt.ciphertextHash,
    ciphertextByteLength: receipt.ciphertextByteLength,
    forgetEpoch,
    ...(ack ? { ack: ackSummary(ack) } : {}),
  };
}

export async function getArchiveForgetTargets(
  ctx: QueryCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "archive.forgetTargets" }>,
): Promise<WorkerArchiveForgetTargetsResult> {
  const { source, item } = await requireForgettingItem(ctx, principal, request);
  const page = await ctx.db
    .query("sourceArtifactArchiveReceipts")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .paginate({
      cursor: request.paginationOpts.cursor,
      numItems: request.paginationOpts.numItems,
    });
  const targets: WorkerArchiveForgetTarget[] = [];
  for (const receipt of page.page) {
    await requireReceiptChain(ctx, source, item, receipt);
    let ack: Doc<"sourceArtifactDeletionAcks"> | null;
    try {
      ack = await loadArchiveDeletionAck(
        ctx,
        receipt,
        item,
        request.expectedForgetEpoch,
      );
    } catch {
      throw workerProtocolError("scan_conflict");
    }
    targets.push(targetResult(receipt, request.expectedForgetEpoch, ack));
  }
  return {
    operation: "archive.forgetTargets",
    sourceItemId: item._id,
    sourceExternalIdHash: item.externalIdHash,
    forgetEpoch: request.expectedForgetEpoch,
    targets,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

async function deletionRequestDigest(
  request: Extract<WorkerRequest, { operation: "archive.ackDeletion" }>,
): Promise<string> {
  const fields: unknown[] = [
    request.spaceId,
    request.sourceAccountId,
    request.requestId,
    request.sourceItemId,
    request.expectedForgetEpoch,
    request.deletionId,
    request.receiptId,
    request.objectOutcome,
    request.backupOutcome ?? null,
  ];
  if (request.absenceAuthority !== undefined) {
    fields.push(
      "absence_authority_v1",
      request.absenceAuthority,
      request.retentionDisclosure ?? null,
    );
  }
  return sha256Utf8(`archive-deletion-ack:v1\0${JSON.stringify(fields)}`);
}

function requestedAbsenceAuthority(
  request: Extract<WorkerRequest, { operation: "archive.ackDeletion" }>,
) {
  return request.absenceAuthority ?? "worker_asserted_physical_absence";
}

function sameAckRequest(
  ack: Doc<"sourceArtifactDeletionAcks">,
  request: Extract<WorkerRequest, { operation: "archive.ackDeletion" }>,
  source: LoadedSource,
  item: Doc<"sourceItems">,
  receipt: Doc<"sourceArtifactArchiveReceipts">,
  digest: string,
): boolean {
  return (
    ack.requestId === request.requestId &&
    ack.requestDigest === digest &&
    ack.deletionId === request.deletionId &&
    ack.objectOutcome === request.objectOutcome &&
    ack.backupOutcome === request.backupOutcome &&
    ack.absenceAuthority === requestedAbsenceAuthority(request) &&
    ack.retentionDisclosure === request.retentionDisclosure &&
    ack.actorUserId === source.principal.userId &&
    ack.actorCredentialId === source.principal.credentialId &&
    archiveDeletionAckMatchesReceipt(
      ack,
      receipt,
      item,
      request.expectedForgetEpoch,
    )
  );
}

function sameAckReplayWithoutReceipt(
  ack: Doc<"sourceArtifactDeletionAcks">,
  request: Extract<WorkerRequest, { operation: "archive.ackDeletion" }>,
  source: LoadedSource,
  item: Doc<"sourceItems">,
  digest: string,
): boolean {
  return (
    ack.spaceId === source.spaceId &&
    ack.sourceAccountId === source.account._id &&
    ack.sourceItemId === item._id &&
    ack.receiptId === request.receiptId &&
    ack.forgetEpoch === request.expectedForgetEpoch &&
    ack.requestId === request.requestId &&
    ack.requestDigest === digest &&
    ack.deletionId === request.deletionId &&
    ack.objectOutcome === request.objectOutcome &&
    ack.backupOutcome === request.backupOutcome &&
    ack.absenceAuthority === requestedAbsenceAuthority(request) &&
    ack.retentionDisclosure === request.retentionDisclosure &&
    ack.actorUserId === source.principal.userId &&
    ack.actorCredentialId === source.principal.credentialId &&
    ack.ackVersion === "archive_deletion_ack_v1" &&
    (ack.absenceAuthority === "worker_asserted_physical_absence"
      ? ack.retentionDisclosure === undefined
      : ack.absenceAuthority === "worker_asserted_live_repository_absence" &&
        ack.retentionDisclosure ===
          "provider_retained_deleted_history_possible" &&
        ack.copyRole === "independent_backup" &&
        ack.subjectKind === "parser_output") &&
    UUID.test(ack.deletionId) &&
    validDigest(ack.requestDigest) &&
    validDigest(ack.receiptRequestDigest) &&
    validDigest(ack.archiveProfileFingerprint) &&
    validDigest(ack.archiveIdentityFingerprint) &&
    validDigest(ack.recipientFingerprint) &&
    validDigest(ack.repositoryKeyDomainFingerprint) &&
    validDigest(ack.storageFailureDomainFingerprint) &&
    UUID.test(ack.archiveObjectId) &&
    validDigest(ack.plaintextHash) &&
    Number.isSafeInteger(ack.plaintextByteLength) &&
    ack.plaintextByteLength >= 1 &&
    ack.plaintextByteLength <=
      (ack.subjectKind === "original_bytes"
        ? MAX_ARCHIVED_BINARY_BYTES
        : MAX_PARSER_ARTIFACT_BYTES) &&
    validBoundedText(ack.plaintextMediaType, MAX_MEDIA_TYPE_CHARS) &&
    ack.hashAuthority === "worker_asserted" &&
    validDigest(ack.ciphertextHash) &&
    Number.isSafeInteger(ack.ciphertextByteLength) &&
    ack.ciphertextByteLength >= 1 &&
    ack.ciphertextByteLength <= MAX_ARCHIVE_CIPHERTEXT_BYTES &&
    ack.verificationKind === "ciphertext_readback_sha256" &&
    validTimestamp(ack.receiptCreatedAt) &&
    validTimestamp(ack.readbackVerifiedAt) &&
    ack.readbackVerifiedAt >= ack.receiptCreatedAt &&
    validTimestamp(ack.completedAt) &&
    (ack.subjectKind === "parser_output") ===
      (ack.parserArtifactId !== undefined) &&
    (ack.copyRole === "independent_backup") ===
      (ack.backupOutcome !== undefined)
  );
}

export async function acknowledgeArchiveDeletion(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "archive.ackDeletion" }>,
  now: number,
): Promise<WorkerArchiveAckDeletionResult> {
  const { source, item } = await requireForgettingItem(ctx, principal, request);
  const digest = await deletionRequestDigest(request);
  const [priorByDeletion, priorByRequest] = await Promise.all([
    ctx.db
      .query("sourceArtifactDeletionAcks")
      .withIndex("by_sourceAccountId_and_deletionId", (q) =>
        q
          .eq("sourceAccountId", source.account._id)
          .eq("deletionId", request.deletionId),
      )
      .take(2),
    ctx.db
      .query("sourceArtifactDeletionAcks")
      .withIndex("by_sourceAccountId_and_requestId", (q) =>
        q
          .eq("sourceAccountId", source.account._id)
          .eq("requestId", request.requestId),
      )
      .take(2),
  ]);
  if (priorByDeletion.length > 1 || priorByRequest.length > 1)
    throw workerProtocolError("request_conflict");
  const priorRows = [priorByDeletion[0], priorByRequest[0]].filter(
    (value): value is Doc<"sourceArtifactDeletionAcks"> => Boolean(value),
  );
  if (new Set(priorRows.map((value) => value._id)).size > 1)
    throw workerProtocolError("request_conflict");
  const prior = priorRows[0];
  if (prior) {
    if (!sameAckReplayWithoutReceipt(prior, request, source, item, digest))
      throw workerProtocolError("request_conflict");
    return {
      operation: "archive.ackDeletion",
      ...ackSummary(prior),
      reused: true,
    };
  }
  const receiptId = ctx.db.normalizeId(
    "sourceArtifactArchiveReceipts",
    request.receiptId,
  );
  if (!receiptId) throw workerProtocolError("invalid_request");
  const receipt = await ctx.db.get(receiptId);
  if (!receipt) throw workerProtocolError("not_found");
  await requireReceiptChain(ctx, source, item, receipt);
  if (
    (receipt.copyRole === "independent_backup") !==
    (request.backupOutcome !== undefined)
  )
    throw workerProtocolError("invalid_request");
  if (
    requestedAbsenceAuthority(request) ===
      "worker_asserted_live_repository_absence" &&
    (receipt.copyRole !== "independent_backup" ||
      receipt.subjectKind !== "parser_output")
  )
    throw workerProtocolError("invalid_request");
  const byReceipt = await ctx.db
    .query("sourceArtifactDeletionAcks")
    .withIndex("by_receiptId_and_forgetEpoch", (q) =>
      q
        .eq("receiptId", receipt._id)
        .eq("forgetEpoch", request.expectedForgetEpoch),
    )
    .take(2);
  if (byReceipt.length > 1) throw workerProtocolError("request_conflict");
  const found = [priorByDeletion[0], priorByRequest[0], byReceipt[0]].filter(
    (value): value is Doc<"sourceArtifactDeletionAcks"> => Boolean(value),
  );
  const ids = new Set(found.map((value) => value._id));
  if (ids.size > 1) throw workerProtocolError("request_conflict");
  const existing = found[0];
  if (existing) {
    if (!sameAckRequest(existing, request, source, item, receipt, digest))
      throw workerProtocolError("request_conflict");
    return {
      operation: "archive.ackDeletion",
      ...ackSummary(existing),
      reused: true,
    };
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const id = await ctx.db.insert("sourceArtifactDeletionAcks", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    sourceItemId: item._id,
    receiptId: receipt._id,
    forgetEpoch: request.expectedForgetEpoch,
    deletionId: request.deletionId,
    requestId: request.requestId,
    requestDigest: digest,
    ackVersion: "archive_deletion_ack_v1",
    absenceAuthority: requestedAbsenceAuthority(request),
    ...(request.retentionDisclosure === undefined
      ? {}
      : { retentionDisclosure: request.retentionDisclosure }),
    clientReceiptId: receipt.clientReceiptId,
    receiptRequestDigest: receipt.requestDigest,
    sourceRevisionId: receipt.sourceRevisionId,
    ...(receipt.parserArtifactId === undefined
      ? {}
      : { parserArtifactId: receipt.parserArtifactId }),
    subjectKind: receipt.subjectKind,
    copyRole: receipt.copyRole,
    receiptVersion: receipt.receiptVersion,
    archiveRepresentation: receipt.archiveRepresentation,
    archiveProfileFingerprint: receipt.archiveProfileFingerprint,
    archiveIdentityFingerprint: receipt.archiveIdentityFingerprint,
    recipientFingerprint: receipt.recipientFingerprint,
    repositoryKeyDomainFingerprint: receipt.repositoryKeyDomainFingerprint,
    storageFailureDomainFingerprint: receipt.storageFailureDomainFingerprint,
    archiveObjectId: receipt.archiveObjectId,
    plaintextHash: receipt.plaintextHash,
    plaintextByteLength: receipt.plaintextByteLength,
    plaintextMediaType: receipt.plaintextMediaType,
    hashAuthority: receipt.hashAuthority,
    ciphertextHash: receipt.ciphertextHash,
    ciphertextByteLength: receipt.ciphertextByteLength,
    verificationKind: receipt.verificationKind,
    readbackVerifiedAt: receipt.readbackVerifiedAt,
    receiptUserId: receipt.userId,
    receiptActorCredentialId: receipt.actorCredentialId,
    receiptCreatedAt: receipt.createdAt,
    objectOutcome: request.objectOutcome,
    ...(request.backupOutcome === undefined
      ? {}
      : { backupOutcome: request.backupOutcome }),
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    completedAt: now,
  });
  const inserted = await ctx.db.get(id);
  if (!inserted) throw workerProtocolError("scan_conflict");
  return {
    operation: "archive.ackDeletion",
    ...ackSummary(inserted),
    reused: false,
  };
}
