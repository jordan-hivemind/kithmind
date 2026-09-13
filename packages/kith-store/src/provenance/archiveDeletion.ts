// Ported from packages/convex/convex/models/provenance/archiveDeletion.ts
// (P2-39d2): the acknowledgement that an archived copy's deletion request
// was actually carried out, matched field for field against the receipt and
// item it names so a forged or stale ack can never stand in for the real
// one. `forgetEpoch` is the fence `beginSourceItemForget` (model.ts)
// advances: an ack is only valid for the forget cycle that requested it.
//
// The caller is responsible for current authorization and transaction scope;
// this module only validates and reads a supplied item/receipt/forget-epoch
// tuple and cannot turn a caller-provided space into an access grant.

import type { ClientBase, QueryResultRow } from "pg";

import {
  camelizeSourceArtifactDeletionAck,
  type SourceArtifactArchiveReceiptRow,
  type SourceArtifactDeletionAckRow,
  type SourceItemRow,
} from "./rows.js";

export function archiveDeletionAckMatchesReceipt(
  ack: SourceArtifactDeletionAckRow,
  receipt: SourceArtifactArchiveReceiptRow,
  item: SourceItemRow,
  forgetEpoch: number,
): boolean {
  return (
    ack.spaceId === item.spaceId &&
    ack.sourceAccountId === item.sourceAccountId &&
    ack.sourceItemId === item.id &&
    ack.receiptId === receipt.id &&
    ack.forgetEpoch === forgetEpoch &&
    ack.ackVersion === "archive_deletion_ack_v1" &&
    (ack.absenceAuthority === "worker_asserted_physical_absence"
      ? ack.retentionDisclosure === null
      : ack.absenceAuthority === "worker_asserted_live_repository_absence" &&
        ack.retentionDisclosure === "provider_retained_deleted_history_possible" &&
        receipt.copyRole === "independent_backup" &&
        receipt.subjectKind === "parser_output") &&
    ack.clientReceiptId === receipt.clientReceiptId &&
    ack.receiptRequestDigest === receipt.requestDigest &&
    ack.sourceRevisionId === receipt.sourceRevisionId &&
    (ack.parserArtifactId ?? undefined) === (receipt.parserArtifactId ?? undefined) &&
    ack.subjectKind === receipt.subjectKind &&
    ack.copyRole === receipt.copyRole &&
    ack.receiptVersion === receipt.receiptVersion &&
    ack.archiveRepresentation === receipt.archiveRepresentation &&
    ack.archiveProfileFingerprint === receipt.archiveProfileFingerprint &&
    ack.archiveIdentityFingerprint === receipt.archiveIdentityFingerprint &&
    ack.recipientFingerprint === receipt.recipientFingerprint &&
    ack.repositoryKeyDomainFingerprint === receipt.repositoryKeyDomainFingerprint &&
    ack.storageFailureDomainFingerprint === receipt.storageFailureDomainFingerprint &&
    ack.archiveObjectId === receipt.archiveObjectId &&
    ack.plaintextHash === receipt.plaintextHash &&
    ack.plaintextByteLength === receipt.plaintextByteLength &&
    ack.plaintextMediaType === receipt.plaintextMediaType &&
    ack.hashAuthority === receipt.hashAuthority &&
    ack.ciphertextHash === receipt.ciphertextHash &&
    ack.ciphertextByteLength === receipt.ciphertextByteLength &&
    ack.verificationKind === receipt.verificationKind &&
    ack.readbackVerifiedAt.getTime() === receipt.readbackVerifiedAt.getTime() &&
    ack.receiptUserId === receipt.userId &&
    ack.receiptActorCredentialId === receipt.actorCredentialId &&
    ack.receiptCreatedAt.getTime() === receipt.createdAtField.getTime() &&
    (receipt.copyRole === "independent_backup"
      ? ack.backupOutcome === "deleted" || ack.backupOutcome === "already_missing"
      : ack.backupOutcome === null) &&
    (ack.objectOutcome === "deleted" || ack.objectOutcome === "already_missing") &&
    ack.completedAt instanceof Date &&
    !Number.isNaN(ack.completedAt.getTime())
  );
}

export async function loadArchiveDeletionAck(
  client: ClientBase,
  receipt: SourceArtifactArchiveReceiptRow,
  item: SourceItemRow,
  forgetEpoch: number,
): Promise<SourceArtifactDeletionAckRow | null> {
  const matches = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_artifact_deletion_acks WHERE receipt_id = $1 AND forget_epoch = $2 LIMIT 2`,
    [receipt.id, forgetEpoch],
  );
  if (matches.rowCount! > 1) {
    throw new Error("Archive deletion acknowledgement is not unique");
  }
  const row = matches.rows[0];
  if (!row) return null;
  const ack = camelizeSourceArtifactDeletionAck(row);
  if (!archiveDeletionAckMatchesReceipt(ack, receipt, item, forgetEpoch)) {
    throw new Error("Archive deletion acknowledgement is incoherent");
  }
  return ack;
}
