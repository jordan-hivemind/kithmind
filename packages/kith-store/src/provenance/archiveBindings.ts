// Ported from packages/convex/convex/models/provenance/archiveBindings.ts
// (P2-39d2). Tracks which archive receipt is *current* for one
// (sourceAccountId, subjectKey, copyRole) identity, so a later re-archive of
// the same subject rebinds instead of silently forking which copy the item
// points at. `bindingEpoch` is the fence: it starts at 0 on first bind and
// this port, like the original, never advances it (advancing it belongs to
// the caller that re-selects a receipt after a successful new archive,
// which is ingestion/worker-protocol territory, row e).

import type { ClientBase, QueryResultRow } from "pg";

import { newKithId } from "../ids.js";
import {
  camelizeSourceArtifactArchiveBinding,
  camelizeSourceArtifactArchiveReceipt,
  type ArchiveCopyRole,
  type ArchiveSubjectKind,
  type SourceArtifactArchiveBindingRow,
  type SourceArtifactArchiveReceiptRow,
} from "./rows.js";
import { sha256Utf8 } from "./sql.js";

export type ArchiveRole = {
  subjectKind: ArchiveSubjectKind;
  copyRole: ArchiveCopyRole;
};

export async function archiveSubjectKey(input: {
  sourceRevisionId: string;
  parserArtifactId?: string | null;
  subjectKind: ArchiveRole["subjectKind"];
}): Promise<string> {
  return sha256Utf8(
    JSON.stringify([
      "archive-subject:v1",
      input.subjectKind,
      input.sourceRevisionId,
      input.parserArtifactId ?? null,
    ]),
  );
}

export async function bindInitialArchiveReceipt(
  client: ClientBase,
  input: {
    receipt: SourceArtifactArchiveReceiptRow;
    expectedBindingEpoch?: number;
    userId: string;
    actorCredentialId: string;
    now: Date;
  },
): Promise<SourceArtifactArchiveBindingRow> {
  const subjectKey = await archiveSubjectKey(input.receipt);
  const matches = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_artifact_archive_bindings
      WHERE source_account_id = $1 AND subject_key = $2 AND copy_role = $3
      LIMIT 2`,
    [input.receipt.sourceAccountId, subjectKey, input.receipt.copyRole],
  );
  if (matches.rowCount! > 1) throw new Error("Archive binding identity is not unique");
  const existing = matches.rows[0] && camelizeSourceArtifactArchiveBinding(matches.rows[0]);
  if (existing) {
    if (
      existing.spaceId !== input.receipt.spaceId ||
      existing.sourceItemId !== input.receipt.sourceItemId ||
      existing.sourceRevisionId !== input.receipt.sourceRevisionId ||
      (existing.parserArtifactId ?? undefined) !== (input.receipt.parserArtifactId ?? undefined) ||
      existing.subjectKind !== input.receipt.subjectKind ||
      existing.receiptId !== input.receipt.id ||
      existing.archiveIdentityFingerprint !== input.receipt.archiveIdentityFingerprint ||
      (input.expectedBindingEpoch !== undefined && existing.bindingEpoch !== input.expectedBindingEpoch)
    ) {
      throw new Error("Archive binding conflicts with current selection");
    }
    return existing;
  }
  if (input.expectedBindingEpoch !== undefined && input.expectedBindingEpoch !== 0) {
    throw new Error("Archive binding epoch is not current");
  }
  const id = newKithId();
  const result = await client.query<QueryResultRow>(
    `INSERT INTO kith.source_artifact_archive_bindings
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, parser_artifact_id,
        subject_kind, subject_key, copy_role, receipt_id, archive_identity_fingerprint, binding_epoch,
        updated_at, user_id, actor_credential_id)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13,$14)
     RETURNING *`,
    [
      id,
      input.receipt.spaceId,
      input.receipt.sourceAccountId,
      input.receipt.sourceItemId,
      input.receipt.sourceRevisionId,
      input.receipt.parserArtifactId ?? null,
      input.receipt.subjectKind,
      subjectKey,
      input.receipt.copyRole,
      input.receipt.id,
      input.receipt.archiveIdentityFingerprint,
      input.now,
      input.userId,
      input.actorCredentialId,
    ],
  );
  return camelizeSourceArtifactArchiveBinding(result.rows[0]!);
}

export async function loadCurrentArchiveBinding(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceAccountId: string;
    sourceItemId: string;
    sourceRevisionId: string;
    parserArtifactId?: string;
    subjectKind: ArchiveRole["subjectKind"];
    copyRole: ArchiveRole["copyRole"];
  },
): Promise<
  | { binding: SourceArtifactArchiveBindingRow; receipt: SourceArtifactArchiveReceiptRow }
  | undefined
> {
  const subjectKey = await archiveSubjectKey(input);
  const matches = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_artifact_archive_bindings
      WHERE source_account_id = $1 AND subject_key = $2 AND copy_role = $3
      LIMIT 2`,
    [input.sourceAccountId, subjectKey, input.copyRole],
  );
  if (matches.rowCount! > 1) throw new Error("Archive binding identity is not unique");
  const bindingRow = matches.rows[0];
  if (!bindingRow) return undefined;
  const binding = camelizeSourceArtifactArchiveBinding(bindingRow);
  const receiptRow = (
    await client.query<QueryResultRow>(`SELECT * FROM kith.source_artifact_archive_receipts WHERE id = $1`, [
      binding.receiptId,
    ])
  ).rows[0];
  const receipt = receiptRow && camelizeSourceArtifactArchiveReceipt(receiptRow);
  if (
    !receipt ||
    binding.spaceId !== input.spaceId ||
    binding.sourceAccountId !== input.sourceAccountId ||
    binding.sourceItemId !== input.sourceItemId ||
    binding.sourceRevisionId !== input.sourceRevisionId ||
    (binding.parserArtifactId ?? undefined) !== input.parserArtifactId ||
    binding.subjectKind !== input.subjectKind ||
    binding.copyRole !== input.copyRole ||
    binding.subjectKey !== subjectKey ||
    !Number.isSafeInteger(binding.bindingEpoch) ||
    binding.bindingEpoch < 0 ||
    receipt.spaceId !== binding.spaceId ||
    receipt.sourceAccountId !== binding.sourceAccountId ||
    receipt.sourceItemId !== binding.sourceItemId ||
    receipt.sourceRevisionId !== binding.sourceRevisionId ||
    (receipt.parserArtifactId ?? undefined) !== (binding.parserArtifactId ?? undefined) ||
    receipt.subjectKind !== binding.subjectKind ||
    receipt.copyRole !== binding.copyRole ||
    receipt.archiveIdentityFingerprint !== binding.archiveIdentityFingerprint
  ) {
    throw new Error("Current archive binding is invalid");
  }
  return { binding, receipt };
}

export function requireIndependentArchivePair(
  primary: SourceArtifactArchiveReceiptRow,
  backup: SourceArtifactArchiveReceiptRow,
): void {
  if (
    primary.id === backup.id ||
    primary.archiveIdentityFingerprint === backup.archiveIdentityFingerprint ||
    primary.recipientFingerprint === backup.recipientFingerprint ||
    primary.repositoryKeyDomainFingerprint === backup.repositoryKeyDomainFingerprint ||
    primary.storageFailureDomainFingerprint === backup.storageFailureDomainFingerprint
  ) {
    throw new Error("Archive copies are not independently identified");
  }
}
