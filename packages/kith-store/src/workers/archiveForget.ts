import type {
  WorkerArchiveAckDeletionResult,
  WorkerArchiveDeletionAckSummary,
  WorkerArchiveForgetTarget,
  WorkerArchiveForgetTargetsResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";
import { newKithId, KITH_ID } from "../ids.js";
import {
  archiveDeletionAckMatchesReceipt,
  camelizeSourceArtifactArchiveReceipt,
  camelizeSourceArtifactDeletionAck,
  camelizeSourceParserArtifact,
  camelizeSourceRevision,
  loadArchiveDeletionAck,
  MAX_ARCHIVED_BINARY_BYTES,
  MAX_PARSER_ARTIFACT_BYTES,
  parseSourceRevisionRepresentation,
  type SourceArtifactArchiveReceiptRow,
  type SourceArtifactDeletionAckRow,
  type SourceItemRow,
} from "../provenance/index.js";
import { decodeCursor, keysetPage, keysetTail } from "./cursor.js";
import { at, exec, row, rows, type WorkerCtx } from "./db.js";
import { isWorkerTransactionAbort, workerProtocolError } from "./errors.js";
import { requireForgettingItem } from "./forget.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import type { LoadedWorkerSource } from "./auth.js";
import { sha256Hex } from "../ingestion/inline.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ARCHIVE_CIPHERTEXT_BYTES = 65 * 1_024 * 1_024;

async function requireReceiptChain(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  item: SourceItemRow,
  receipt: SourceArtifactArchiveReceiptRow,
): Promise<void> {
  const revisionRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_revisions WHERE id = $1",
    [receipt.sourceRevisionId],
  );
  const revision = revisionRaw ? camelizeSourceRevision(revisionRaw) : null;
  if (
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account.id ||
    receipt.sourceItemId !== item.id ||
    !revision ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== item.id ||
    receipt.receiptVersion !== "archive_receipt_v1" ||
    receipt.archiveRepresentation !== "age_encrypted_v1" ||
    receipt.hashAuthority !== "worker_asserted" ||
    receipt.verificationKind !== "ciphertext_readback_sha256" ||
    !UUID.test(receipt.clientReceiptId) ||
    !UUID.test(receipt.archiveObjectId) ||
    !SHA256.test(receipt.requestDigest) ||
    !SHA256.test(receipt.archiveProfileFingerprint) ||
    !SHA256.test(receipt.archiveIdentityFingerprint) ||
    !SHA256.test(receipt.recipientFingerprint) ||
    !SHA256.test(receipt.repositoryKeyDomainFingerprint) ||
    !SHA256.test(receipt.storageFailureDomainFingerprint) ||
    !SHA256.test(receipt.plaintextHash) ||
    !SHA256.test(receipt.ciphertextHash) ||
    !Number.isSafeInteger(receipt.ciphertextByteLength) ||
    receipt.ciphertextByteLength < 1 ||
    receipt.ciphertextByteLength > MAX_ARCHIVE_CIPHERTEXT_BYTES ||
    receipt.readbackVerifiedAt.getTime() < receipt.createdAtField.getTime()
  )
    workerProtocolError("scan_conflict");
  try {
    if (
      parseSourceRevisionRepresentation(revision).kind !== "archived_binary_v1"
    )
      workerProtocolError("scan_conflict");
  } catch {
    workerProtocolError("scan_conflict");
  }
  if (receipt.subjectKind === "original_bytes") {
    if (
      receipt.parserArtifactId !== null ||
      receipt.plaintextHash !== revision.contentHash ||
      receipt.plaintextByteLength !== revision.byteLength ||
      receipt.plaintextMediaType !== revision.mediaType
    )
      workerProtocolError("scan_conflict");
    return;
  }
  if (!receipt.parserArtifactId) workerProtocolError("scan_conflict");
  const artifactRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_parser_artifacts WHERE id = $1",
    [receipt.parserArtifactId],
  );
  const artifact = artifactRaw
    ? camelizeSourceParserArtifact(artifactRaw)
    : null;
  if (
    !artifact ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account.id ||
    artifact.sourceItemId !== item.id ||
    artifact.sourceRevisionId !== revision.id ||
    receipt.plaintextHash !== artifact.outputHash ||
    receipt.plaintextByteLength !== artifact.outputByteLength ||
    receipt.plaintextMediaType !== artifact.outputMediaType
  )
    workerProtocolError("scan_conflict");
}

function ackSummary(
  ack: SourceArtifactDeletionAckRow,
): WorkerArchiveDeletionAckSummary {
  if (
    ack.absenceAuthority === "worker_asserted_live_repository_absence" &&
    (ack.copyRole !== "independent_backup" ||
      ack.subjectKind !== "parser_output" ||
      ack.backupOutcome === null ||
      ack.retentionDisclosure !== "provider_retained_deleted_history_possible")
  )
    workerProtocolError("scan_conflict");
  if (
    ack.absenceAuthority === "worker_asserted_physical_absence" &&
    ack.retentionDisclosure !== null
  )
    workerProtocolError("scan_conflict");
  return {
    deletionId: ack.deletionId,
    receiptId: ack.receiptId,
    forgetEpoch: ack.forgetEpoch,
    objectOutcome: ack.objectOutcome,
    ...(ack.backupOutcome ? { backupOutcome: ack.backupOutcome } : {}),
    completedAt: ack.completedAt.getTime(),
    absenceAuthority: ack.absenceAuthority,
    ...(ack.retentionDisclosure
      ? { retentionDisclosure: ack.retentionDisclosure }
      : {}),
  } as WorkerArchiveDeletionAckSummary;
}

function target(
  receipt: SourceArtifactArchiveReceiptRow,
  forgetEpoch: number,
  ack: SourceArtifactDeletionAckRow | null,
): WorkerArchiveForgetTarget {
  return {
    receiptId: receipt.id,
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
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "archive.forgetTargets" }>,
): Promise<WorkerArchiveForgetTargetsResult> {
  const { source, item } = await requireForgettingItem(ctx, principal, request);
  const cursor = decodeCursor(request.paginationOpts.cursor);
  const tail = keysetTail(cursor, 2);
  const fetched = await rows<Record<string, unknown>>(
    ctx,
    `SELECT *, created_at::text AS cursor_created_at FROM kith.source_artifact_archive_receipts
     WHERE source_item_id = $1 ${tail.sql}`,
    [item.id, ...tail.values, request.paginationOpts.numItems + 1],
  );
  const page = keysetPage(
    fetched.map((raw) => ({
      createdAt: String(raw.cursor_created_at),
      id: String(raw.id),
      value: camelizeSourceArtifactArchiveReceipt(raw),
    })),
    request.paginationOpts.numItems,
  );
  const targets: WorkerArchiveForgetTarget[] = [];
  for (const wrapped of page.page) {
    const receipt = wrapped.value;
    await requireReceiptChain(ctx, source, item, receipt);
    let ack: SourceArtifactDeletionAckRow | null;
    try {
      ack = await loadArchiveDeletionAck(
        ctx.client,
        receipt,
        item,
        request.expectedForgetEpoch,
      );
    } catch (error) {
      if (isWorkerTransactionAbort(error)) throw error;
      workerProtocolError("scan_conflict");
    }
    targets.push(target(receipt, request.expectedForgetEpoch, ack));
  }
  return {
    operation: "archive.forgetTargets",
    sourceItemId: item.id,
    sourceExternalIdHash: item.externalIdHash,
    forgetEpoch: request.expectedForgetEpoch,
    targets,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

async function requestDigest(
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
  if (request.absenceAuthority !== undefined)
    fields.push(
      "absence_authority_v1",
      request.absenceAuthority,
      request.retentionDisclosure ?? null,
    );
  return sha256Hex(`archive-deletion-ack:v1\0${JSON.stringify(fields)}`);
}

function sameAck(
  ack: SourceArtifactDeletionAckRow,
  request: Extract<WorkerRequest, { operation: "archive.ackDeletion" }>,
  source: LoadedWorkerSource,
  item: SourceItemRow,
  digest: string,
): boolean {
  return (
    ack.spaceId === source.spaceId &&
    ack.sourceAccountId === source.account.id &&
    ack.sourceItemId === item.id &&
    ack.receiptId === request.receiptId &&
    ack.forgetEpoch === request.expectedForgetEpoch &&
    ack.requestId === request.requestId &&
    ack.requestDigest === digest &&
    ack.deletionId === request.deletionId &&
    ack.objectOutcome === request.objectOutcome &&
    (ack.backupOutcome ?? undefined) === request.backupOutcome &&
    ack.absenceAuthority ===
      (request.absenceAuthority ?? "worker_asserted_physical_absence") &&
    (ack.retentionDisclosure ?? undefined) === request.retentionDisclosure &&
    ack.actorUserId === source.principal.userId &&
    ack.actorCredentialId === source.principal.credentialId &&
    ack.ackVersion === "archive_deletion_ack_v1" &&
    UUID.test(ack.deletionId) &&
    SHA256.test(ack.requestDigest) &&
    SHA256.test(ack.receiptRequestDigest) &&
    SHA256.test(ack.archiveProfileFingerprint) &&
    SHA256.test(ack.archiveIdentityFingerprint) &&
    SHA256.test(ack.recipientFingerprint) &&
    SHA256.test(ack.repositoryKeyDomainFingerprint) &&
    SHA256.test(ack.storageFailureDomainFingerprint) &&
    UUID.test(ack.archiveObjectId) &&
    SHA256.test(ack.plaintextHash) &&
    Number.isSafeInteger(ack.plaintextByteLength) &&
    ack.plaintextByteLength >= 1 &&
    ack.plaintextByteLength <=
      (ack.subjectKind === "original_bytes"
        ? MAX_ARCHIVED_BINARY_BYTES
        : MAX_PARSER_ARTIFACT_BYTES) &&
    ack.plaintextMediaType.length >= 1 &&
    ack.plaintextMediaType.length <= 255 &&
    ack.hashAuthority === "worker_asserted" &&
    SHA256.test(ack.ciphertextHash) &&
    Number.isSafeInteger(ack.ciphertextByteLength) &&
    ack.ciphertextByteLength >= 1 &&
    ack.ciphertextByteLength <= MAX_ARCHIVE_CIPHERTEXT_BYTES &&
    ack.verificationKind === "ciphertext_readback_sha256" &&
    ack.readbackVerifiedAt.getTime() >= ack.receiptCreatedAt.getTime() &&
    Number.isSafeInteger(ack.completedAt.getTime()) &&
    (ack.subjectKind === "parser_output") === (ack.parserArtifactId !== null) &&
    (ack.copyRole === "independent_backup") === (ack.backupOutcome !== null) &&
    (ack.absenceAuthority === "worker_asserted_physical_absence"
      ? ack.retentionDisclosure === null
      : ack.absenceAuthority === "worker_asserted_live_repository_absence" &&
        ack.retentionDisclosure ===
          "provider_retained_deleted_history_possible" &&
        ack.copyRole === "independent_backup" &&
        ack.subjectKind === "parser_output")
  );
}

export async function acknowledgeArchiveDeletion(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "archive.ackDeletion" }>,
): Promise<WorkerArchiveAckDeletionResult> {
  const { source, item } = await requireForgettingItem(ctx, principal, request);
  if (!UUID.test(request.deletionId) || !KITH_ID.test(request.receiptId))
    workerProtocolError("invalid_request");
  const digest = await requestDigest(request);
  const byDeletion = await rows<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_artifact_deletion_acks WHERE source_account_id=$1 AND deletion_id=$2 LIMIT 2 FOR UPDATE",
    [source.account.id, request.deletionId],
  );
  const byRequest = await rows<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_artifact_deletion_acks WHERE source_account_id=$1 AND request_id=$2 LIMIT 2 FOR UPDATE",
    [source.account.id, request.requestId],
  );
  const byReceipt = await rows<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_artifact_deletion_acks WHERE receipt_id=$1 AND forget_epoch=$2 LIMIT 2 FOR UPDATE",
    [request.receiptId, request.expectedForgetEpoch],
  );
  if ([byDeletion, byRequest, byReceipt].some((found) => found.length > 1))
    workerProtocolError("scan_conflict");
  const found = [byDeletion[0], byRequest[0], byReceipt[0]]
    .filter((value): value is Record<string, unknown> => Boolean(value))
    .map(camelizeSourceArtifactDeletionAck);
  if (found.length) {
    if (
      new Set(found.map((ack) => ack.id)).size !== 1 ||
      !sameAck(found[0]!, request, source, item, digest)
    )
      workerProtocolError("request_conflict");
    return {
      operation: "archive.ackDeletion",
      ...ackSummary(found[0]!),
      reused: true,
    };
  }
  const receiptRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_artifact_archive_receipts WHERE id = $1 FOR UPDATE",
    [request.receiptId],
  );
  if (!receiptRaw) workerProtocolError("not_found");
  const receipt = camelizeSourceArtifactArchiveReceipt(receiptRaw);
  await requireReceiptChain(ctx, source, item, receipt);
  if (
    (receipt.copyRole === "independent_backup") !==
      (request.backupOutcome !== undefined) ||
    (request.absenceAuthority === "worker_asserted_live_repository_absence" &&
      (receipt.copyRole !== "independent_backup" ||
        receipt.subjectKind !== "parser_output"))
  )
    workerProtocolError("invalid_request");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const id = newKithId();
  const authority =
    request.absenceAuthority ?? "worker_asserted_physical_absence";
  await exec(
    ctx,
    `INSERT INTO kith.source_artifact_deletion_acks
     (id, space_id, created_at, source_account_id, source_item_id, receipt_id,
      forget_epoch, deletion_id, request_id, request_digest, ack_version,
      absence_authority, retention_disclosure, client_receipt_id,
      receipt_request_digest, source_revision_id, parser_artifact_id,
      subject_kind, copy_role, receipt_version, archive_representation,
      archive_profile_fingerprint, archive_identity_fingerprint,
      recipient_fingerprint, repository_key_domain_fingerprint,
      storage_failure_domain_fingerprint, archive_object_id, plaintext_hash,
      plaintext_byte_length, plaintext_media_type, hash_authority,
      ciphertext_hash, ciphertext_byte_length, verification_kind,
      readback_verified_at, receipt_user_id, receipt_actor_credential_id,
      receipt_created_at, object_outcome, backup_outcome, actor_user_id,
      actor_credential_id, completed_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,
      'archive_deletion_ack_v1',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
      $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,
      $36,$37,$38,$39,$40,$41)`,
    [
      id,
      source.spaceId,
      source.account.id,
      item.id,
      receipt.id,
      request.expectedForgetEpoch,
      request.deletionId,
      request.requestId,
      digest,
      authority,
      request.retentionDisclosure ?? null,
      receipt.clientReceiptId,
      receipt.requestDigest,
      receipt.sourceRevisionId,
      receipt.parserArtifactId,
      receipt.subjectKind,
      receipt.copyRole,
      receipt.receiptVersion,
      receipt.archiveRepresentation,
      receipt.archiveProfileFingerprint,
      receipt.archiveIdentityFingerprint,
      receipt.recipientFingerprint,
      receipt.repositoryKeyDomainFingerprint,
      receipt.storageFailureDomainFingerprint,
      receipt.archiveObjectId,
      receipt.plaintextHash,
      receipt.plaintextByteLength,
      receipt.plaintextMediaType,
      receipt.hashAuthority,
      receipt.ciphertextHash,
      receipt.ciphertextByteLength,
      receipt.verificationKind,
      receipt.readbackVerifiedAt,
      receipt.userId,
      receipt.actorCredentialId,
      receipt.createdAtField,
      request.objectOutcome,
      request.backupOutcome ?? null,
      source.principal.userId,
      source.principal.credentialId,
      at(ctx.now),
    ],
  );
  const insertedRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_artifact_deletion_acks WHERE id = $1",
    [id],
  );
  if (!insertedRaw) workerProtocolError("scan_conflict");
  const inserted = camelizeSourceArtifactDeletionAck(insertedRaw);
  if (
    !archiveDeletionAckMatchesReceipt(
      inserted,
      receipt,
      item,
      request.expectedForgetEpoch,
    )
  )
    workerProtocolError("scan_conflict");
  return {
    operation: "archive.ackDeletion",
    ...ackSummary(inserted),
    reused: false,
  };
}
