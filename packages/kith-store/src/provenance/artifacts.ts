// Ported from packages/convex/convex/models/provenance/artifacts.ts (P2-39d):
// parser artifacts and the archive receipts that prove a worker's original
// bytes or parser output were durably archived.
//
// `requireSourceAccountAccess` (the Convex original's capability check
// against the caller's credential) is not ported: that is `requireSpaceAccess`
// territory, owned by identity (P2-39c) per section 2.5's "leave credential
// checks to that surface." What this module still owns and still checks is
// the parent chain within its own tables -- the source item is available,
// the revision belongs to it, and the revision is the archived-binary
// representation parser artifacts require.

import type { ClientBase, QueryResultRow } from "pg";

import { newKithId } from "../ids.js";
import {
  MAX_ARCHIVED_BINARY_BYTES,
  MAX_PARSER_ARTIFACT_BYTES,
  parseSourceRevisionRepresentation,
  type SourceRevisionShape,
} from "./representations.js";
import {
  camelizeSourceArtifactArchiveReceipt,
  camelizeSourceParserArtifact,
  camelizeSourceRevision,
  type ArchiveCopyRole,
  type ArchiveSubjectKind,
  type SourceArtifactArchiveReceiptRow,
  type SourceParserArtifactRow,
  type SourceRevisionRow,
} from "./rows.js";
import { sha256Utf8, utf8Length } from "./sql.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_FINGERPRINT_BYTES = 1_024;
const MAX_MEDIA_TYPE_CHARS = 255;
const MAX_CIPHERTEXT_OVERHEAD_BYTES = 1 * 1_024 * 1_024;

export type ParserArtifactInput = {
  spaceId: string;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  clientArtifactId: string;
  parserFingerprint: string;
  outputHash: string;
  outputByteLength: number;
  outputMediaType: string;
  userId: string;
  actorCredentialId: string;
  createdAt: Date;
};

export type ArchiveReceiptInput = {
  spaceId: string;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  parserArtifactId?: string;
  subjectKind: ArchiveSubjectKind;
  copyRole: ArchiveCopyRole;
  clientReceiptId: string;
  requestDigest: string;
  archiveProfileFingerprint: string;
  archiveIdentityFingerprint: string;
  recipientFingerprint: string;
  repositoryKeyDomainFingerprint: string;
  storageFailureDomainFingerprint: string;
  archiveObjectId: string;
  plaintextHash: string;
  plaintextByteLength: number;
  plaintextMediaType: string;
  ciphertextHash: string;
  ciphertextByteLength: number;
  readbackVerifiedAt: Date;
  userId: string;
  actorCredentialId: string;
  createdAt: Date;
};

function requireSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function requireSafeInteger(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a safe integer from ${minimum} to ${maximum}`);
  }
}

function requireBoundedUtf8(value: string, label: string, maximum: number): void {
  const length = utf8Length(value);
  if (length === 0 || length > maximum) throw new Error(`${label} must contain 1-${maximum} UTF-8 bytes`);
}

function requireBoundedString(value: string, label: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} UTF-16 code units`);
  }
}

async function requireArtifactParents(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string; sourceRevisionId: string },
): Promise<SourceRevisionRow> {
  const item = (
    await client.query<QueryResultRow>(`SELECT * FROM kith.source_items WHERE id = $1`, [input.sourceItemId])
  ).rows[0];
  if (!item || item.space_id !== input.spaceId || item.lifecycle !== "available") {
    throw new Error("Artifact source item parent is invalid");
  }
  const revisionRow = (
    await client.query<QueryResultRow>(`SELECT * FROM kith.source_revisions WHERE id = $1`, [
      input.sourceRevisionId,
    ])
  ).rows[0];
  if (!revisionRow || revisionRow.space_id !== input.spaceId || revisionRow.source_item_id !== input.sourceItemId) {
    throw new Error("Artifact source revision parent is invalid");
  }
  const revision = camelizeSourceRevision(revisionRow);
  const representation = parseSourceRevisionRepresentation(revision as SourceRevisionShape);
  if (representation.kind !== "archived_binary_v1") {
    throw new Error("Parser artifacts require an archived binary revision");
  }
  return revision;
}

export async function createOrGetParserArtifact(
  client: ClientBase,
  input: ParserArtifactInput,
): Promise<SourceParserArtifactRow> {
  await requireArtifactParents(client, input);
  requireBoundedUtf8(input.parserFingerprint, "Parser fingerprint", MAX_FINGERPRINT_BYTES);
  requireSha256(input.outputHash, "Parser artifact output hash");
  requireSafeInteger(input.outputByteLength, "Parser artifact output byte length", 1, MAX_PARSER_ARTIFACT_BYTES);
  requireBoundedString(input.outputMediaType, "Parser artifact media type", MAX_MEDIA_TYPE_CHARS);

  const byIdentity = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_parser_artifacts WHERE source_revision_id = $1 AND parser_fingerprint = $2 LIMIT 2`,
    [input.sourceRevisionId, input.parserFingerprint],
  );
  const byClientId = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_parser_artifacts WHERE source_account_id = $1 AND client_artifact_id = $2 LIMIT 2`,
    [input.sourceAccountId, input.clientArtifactId],
  );
  if (byIdentity.rowCount! > 1 || byClientId.rowCount! > 1) {
    throw new Error("Parser artifact identity is not unique");
  }
  const identityRow = byIdentity.rows[0] && camelizeSourceParserArtifact(byIdentity.rows[0]);
  const clientRow = byClientId.rows[0] && camelizeSourceParserArtifact(byClientId.rows[0]);
  const existing = identityRow ?? clientRow;
  const same =
    existing &&
    existing.spaceId === input.spaceId &&
    existing.sourceAccountId === input.sourceAccountId &&
    existing.sourceItemId === input.sourceItemId &&
    existing.sourceRevisionId === input.sourceRevisionId &&
    existing.clientArtifactId === input.clientArtifactId &&
    existing.parserFingerprint === input.parserFingerprint &&
    existing.outputHash === input.outputHash &&
    existing.outputByteLength === input.outputByteLength &&
    existing.outputMediaType === input.outputMediaType &&
    existing.userId === input.userId &&
    existing.actorCredentialId === input.actorCredentialId &&
    existing.createdAtField.getTime() === input.createdAt.getTime();
  if ((identityRow && clientRow && identityRow.id !== clientRow.id) || (existing && !same)) {
    throw new Error("Conflicting immutable parser artifact");
  }
  if (existing) return existing;

  const id = newKithId();
  const result = await client.query<QueryResultRow>(
    `INSERT INTO kith.source_parser_artifacts
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, client_artifact_id,
        parser_fingerprint, output_hash, output_byte_length, output_media_type, hash_authority,
        user_id, actor_credential_id, created_at_field)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,'worker_asserted',$11,$12,$13)
     RETURNING *`,
    [
      id,
      input.spaceId,
      input.sourceAccountId,
      input.sourceItemId,
      input.sourceRevisionId,
      input.clientArtifactId,
      input.parserFingerprint,
      input.outputHash,
      input.outputByteLength,
      input.outputMediaType,
      input.userId,
      input.actorCredentialId,
      input.createdAt,
    ],
  );
  return camelizeSourceParserArtifact(result.rows[0]!);
}

export async function createOrGetArchiveReceipt(
  client: ClientBase,
  input: ArchiveReceiptInput,
): Promise<SourceArtifactArchiveReceiptRow> {
  const revision = await requireArtifactParents(client, input);
  requireSha256(input.requestDigest, "Archive request digest");
  requireSha256(input.archiveProfileFingerprint, "Archive profile fingerprint");
  requireSha256(input.archiveIdentityFingerprint, "Archive identity fingerprint");
  requireSha256(input.recipientFingerprint, "Archive recipient fingerprint");
  requireSha256(input.repositoryKeyDomainFingerprint, "Archive repository key-domain fingerprint");
  requireSha256(input.storageFailureDomainFingerprint, "Archive storage failure-domain fingerprint");
  requireSha256(input.plaintextHash, "Archive plaintext hash");
  requireBoundedString(input.plaintextMediaType, "Archive plaintext media type", MAX_MEDIA_TYPE_CHARS);
  requireSha256(input.ciphertextHash, "Archive ciphertext hash");
  requireSafeInteger(
    input.ciphertextByteLength,
    "Archive ciphertext byte length",
    1,
    MAX_PARSER_ARTIFACT_BYTES + MAX_CIPHERTEXT_OVERHEAD_BYTES,
  );
  if (input.readbackVerifiedAt.getTime() < input.createdAt.getTime()) {
    throw new Error("Archive readback precedes object creation");
  }

  if (input.subjectKind === "original_bytes") {
    if (input.parserArtifactId !== undefined) {
      throw new Error("Original-byte receipt cannot name a parser artifact");
    }
    if (
      input.plaintextHash !== revision.contentHash ||
      input.plaintextByteLength !== revision.byteLength ||
      input.plaintextMediaType !== revision.mediaType
    ) {
      throw new Error("Original-byte receipt does not match its revision");
    }
    requireSafeInteger(
      input.plaintextByteLength,
      "Original archive plaintext byte length",
      1,
      MAX_ARCHIVED_BINARY_BYTES,
    );
  } else {
    if (input.parserArtifactId === undefined) {
      throw new Error("Parser-output receipt requires a parser artifact");
    }
    const artifactRow = (
      await client.query<QueryResultRow>(`SELECT * FROM kith.source_parser_artifacts WHERE id = $1`, [
        input.parserArtifactId,
      ])
    ).rows[0];
    const artifact = artifactRow && camelizeSourceParserArtifact(artifactRow);
    if (
      !artifact ||
      artifact.spaceId !== input.spaceId ||
      artifact.sourceAccountId !== input.sourceAccountId ||
      artifact.sourceItemId !== input.sourceItemId ||
      artifact.sourceRevisionId !== input.sourceRevisionId ||
      artifact.outputHash !== input.plaintextHash ||
      artifact.outputByteLength !== input.plaintextByteLength ||
      artifact.outputMediaType !== input.plaintextMediaType
    ) {
      throw new Error("Parser-output receipt parent is invalid");
    }
    requireSafeInteger(input.plaintextByteLength, "Parser archive plaintext byte length", 1, MAX_PARSER_ARTIFACT_BYTES);
  }

  const byClientId = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_artifact_archive_receipts WHERE source_account_id = $1 AND client_receipt_id = $2 LIMIT 2`,
    [input.sourceAccountId, input.clientReceiptId],
  );
  const byArchiveObject = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_artifact_archive_receipts WHERE archive_identity_fingerprint = $1 AND archive_object_id = $2 LIMIT 2`,
    [input.archiveIdentityFingerprint, input.archiveObjectId],
  );
  if (byClientId.rowCount! > 1 || byArchiveObject.rowCount! > 1) {
    throw new Error("Archive receipt identity is not unique");
  }
  const clientRow = byClientId.rows[0] && camelizeSourceArtifactArchiveReceipt(byClientId.rows[0]);
  const objectRow = byArchiveObject.rows[0] && camelizeSourceArtifactArchiveReceipt(byArchiveObject.rows[0]);
  const existing = clientRow ?? objectRow;
  const same =
    existing &&
    existing.spaceId === input.spaceId &&
    existing.sourceAccountId === input.sourceAccountId &&
    existing.sourceItemId === input.sourceItemId &&
    existing.sourceRevisionId === input.sourceRevisionId &&
    (existing.parserArtifactId ?? undefined) === input.parserArtifactId &&
    existing.subjectKind === input.subjectKind &&
    existing.copyRole === input.copyRole &&
    existing.clientReceiptId === input.clientReceiptId &&
    existing.requestDigest === input.requestDigest &&
    existing.archiveProfileFingerprint === input.archiveProfileFingerprint &&
    existing.archiveIdentityFingerprint === input.archiveIdentityFingerprint &&
    existing.recipientFingerprint === input.recipientFingerprint &&
    existing.repositoryKeyDomainFingerprint === input.repositoryKeyDomainFingerprint &&
    existing.storageFailureDomainFingerprint === input.storageFailureDomainFingerprint &&
    existing.archiveObjectId === input.archiveObjectId &&
    existing.plaintextHash === input.plaintextHash &&
    existing.plaintextByteLength === input.plaintextByteLength &&
    existing.plaintextMediaType === input.plaintextMediaType &&
    existing.ciphertextHash === input.ciphertextHash &&
    existing.ciphertextByteLength === input.ciphertextByteLength &&
    existing.readbackVerifiedAt.getTime() === input.readbackVerifiedAt.getTime() &&
    existing.userId === input.userId &&
    existing.actorCredentialId === input.actorCredentialId &&
    existing.createdAtField.getTime() === input.createdAt.getTime();
  if ((clientRow && objectRow && clientRow.id !== objectRow.id) || (existing && !same)) {
    throw new Error("Conflicting immutable archive receipt");
  }
  if (existing) return existing;

  const id = newKithId();
  const result = await client.query<QueryResultRow>(
    `INSERT INTO kith.source_artifact_archive_receipts
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, parser_artifact_id,
        subject_kind, copy_role, client_receipt_id, request_digest, receipt_version,
        archive_representation, archive_profile_fingerprint, archive_identity_fingerprint,
        recipient_fingerprint, repository_key_domain_fingerprint, storage_failure_domain_fingerprint,
        archive_object_id, plaintext_hash, plaintext_byte_length, plaintext_media_type, hash_authority,
        ciphertext_hash, ciphertext_byte_length, verification_kind, readback_verified_at, user_id,
        actor_credential_id, created_at_field)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,'archive_receipt_v1','age_encrypted_v1',$11,$12,$13,$14,$15,
             $16,$17,$18,$19,'worker_asserted',$20,$21,'ciphertext_readback_sha256',$22,$23,$24,$25)
     RETURNING *`,
    [
      id,
      input.spaceId,
      input.sourceAccountId,
      input.sourceItemId,
      input.sourceRevisionId,
      input.parserArtifactId ?? null,
      input.subjectKind,
      input.copyRole,
      input.clientReceiptId,
      input.requestDigest,
      input.archiveProfileFingerprint,
      input.archiveIdentityFingerprint,
      input.recipientFingerprint,
      input.repositoryKeyDomainFingerprint,
      input.storageFailureDomainFingerprint,
      input.archiveObjectId,
      input.plaintextHash,
      input.plaintextByteLength,
      input.plaintextMediaType,
      input.ciphertextHash,
      input.ciphertextByteLength,
      input.readbackVerifiedAt,
      input.userId,
      input.actorCredentialId,
      input.createdAt,
    ],
  );
  return camelizeSourceArtifactArchiveReceipt(result.rows[0]!);
}
