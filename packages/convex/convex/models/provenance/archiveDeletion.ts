import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export function archiveDeletionAckMatchesReceipt(
  ack: Doc<"sourceArtifactDeletionAcks">,
  receipt: Doc<"sourceArtifactArchiveReceipts">,
  item: Doc<"sourceItems">,
  forgetEpoch: number,
): boolean {
  return (
    ack.spaceId === item.spaceId &&
    ack.sourceAccountId === item.sourceAccountId &&
    ack.sourceItemId === item._id &&
    ack.receiptId === receipt._id &&
    ack.forgetEpoch === forgetEpoch &&
    ack.ackVersion === "archive_deletion_ack_v1" &&
    ack.absenceAuthority === "worker_asserted_physical_absence" &&
    ack.clientReceiptId === receipt.clientReceiptId &&
    ack.receiptRequestDigest === receipt.requestDigest &&
    ack.sourceRevisionId === receipt.sourceRevisionId &&
    ack.parserArtifactId === receipt.parserArtifactId &&
    ack.subjectKind === receipt.subjectKind &&
    ack.copyRole === receipt.copyRole &&
    ack.receiptVersion === receipt.receiptVersion &&
    ack.archiveRepresentation === receipt.archiveRepresentation &&
    ack.archiveProfileFingerprint === receipt.archiveProfileFingerprint &&
    ack.archiveIdentityFingerprint === receipt.archiveIdentityFingerprint &&
    ack.recipientFingerprint === receipt.recipientFingerprint &&
    ack.repositoryKeyDomainFingerprint ===
      receipt.repositoryKeyDomainFingerprint &&
    ack.storageFailureDomainFingerprint ===
      receipt.storageFailureDomainFingerprint &&
    ack.archiveObjectId === receipt.archiveObjectId &&
    ack.plaintextHash === receipt.plaintextHash &&
    ack.plaintextByteLength === receipt.plaintextByteLength &&
    ack.plaintextMediaType === receipt.plaintextMediaType &&
    ack.hashAuthority === receipt.hashAuthority &&
    ack.ciphertextHash === receipt.ciphertextHash &&
    ack.ciphertextByteLength === receipt.ciphertextByteLength &&
    ack.verificationKind === receipt.verificationKind &&
    ack.readbackVerifiedAt === receipt.readbackVerifiedAt &&
    ack.receiptUserId === receipt.userId &&
    ack.receiptActorCredentialId === receipt.actorCredentialId &&
    ack.receiptCreatedAt === receipt.createdAt &&
    (receipt.copyRole === "independent_backup"
      ? ack.backupOutcome === "deleted" ||
        ack.backupOutcome === "already_missing"
      : ack.backupOutcome === undefined) &&
    (ack.objectOutcome === "deleted" ||
      ack.objectOutcome === "already_missing") &&
    Number.isSafeInteger(ack.completedAt) &&
    ack.completedAt >= 0
  );
}

export async function loadArchiveDeletionAck(
  ctx: ReadCtx,
  receipt: Doc<"sourceArtifactArchiveReceipts">,
  item: Doc<"sourceItems">,
  forgetEpoch: number,
): Promise<Doc<"sourceArtifactDeletionAcks"> | null> {
  const matches = await ctx.db
    .query("sourceArtifactDeletionAcks")
    .withIndex("by_receiptId_and_forgetEpoch", (q) =>
      q.eq("receiptId", receipt._id).eq("forgetEpoch", forgetEpoch),
    )
    .take(2);
  if (matches.length > 1) {
    throw new Error("Archive deletion acknowledgement is not unique");
  }
  const ack = matches[0];
  if (!ack) return null;
  if (!archiveDeletionAckMatchesReceipt(ack, receipt, item, forgetEpoch)) {
    throw new Error("Archive deletion acknowledgement is incoherent");
  }
  return ack;
}
