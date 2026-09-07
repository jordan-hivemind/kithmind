import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";
import {
  MAX_ARCHIVED_BINARY_BYTES,
  MAX_PARSER_ARTIFACT_BYTES,
  parseSourceRevisionRepresentation,
} from "./representations";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FINGERPRINT_BYTES = 1_024;
const MAX_MEDIA_TYPE_CHARS = 255;
const MAX_CIPHERTEXT_OVERHEAD_BYTES = 1 * 1_024 * 1_024;

export type ParserArtifactInput = {
  spaceId: Id<"spaces">;
  sourceAccountId: Id<"sourceAccounts">;
  sourceItemId: Id<"sourceItems">;
  sourceRevisionId: Id<"sourceRevisions">;
  clientArtifactId: string;
  parserFingerprint: string;
  outputHash: string;
  outputByteLength: number;
  outputMediaType: string;
  userId: Id<"users">;
  actorCredentialId: Id<"apiKeys">;
  createdAt: number;
};

export type ArchiveReceiptInput = {
  spaceId: Id<"spaces">;
  sourceAccountId: Id<"sourceAccounts">;
  sourceItemId: Id<"sourceItems">;
  sourceRevisionId: Id<"sourceRevisions">;
  parserArtifactId?: Id<"sourceParserArtifacts">;
  subjectKind: "original_bytes" | "parser_output";
  copyRole: "primary" | "independent_backup";
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
  readbackVerifiedAt: number;
  userId: Id<"users">;
  actorCredentialId: Id<"apiKeys">;
  createdAt: number;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requireSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function requireUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase UUID`);
  }
}

function requireSafeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} must be a safe integer from ${minimum} to ${maximum}`,
    );
  }
}

function requireTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function requireBoundedUtf8(
  value: string,
  label: string,
  maximum: number,
): void {
  const length = utf8Length(value);
  if (length === 0 || length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} UTF-8 bytes`);
  }
}

function requireBoundedString(
  value: string,
  label: string,
  maximum: number,
): void {
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} UTF-16 code units`);
  }
}

async function requireArtifactParents(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    sourceItemId: Id<"sourceItems">;
    sourceRevisionId: Id<"sourceRevisions">;
    userId: Id<"users">;
    actorCredentialId: Id<"apiKeys">;
  },
): Promise<Doc<"sourceRevisions">> {
  const account = await requireSourceAccountAccess(
    ctx,
    { userId: input.userId, credentialId: input.actorCredentialId },
    input.sourceAccountId,
    "ingest",
  );
  const [item, revision] = await Promise.all([
    ctx.db.get(input.sourceItemId),
    ctx.db.get(input.sourceRevisionId),
  ]);
  if (account.spaceId !== input.spaceId) {
    throw new Error("Artifact source account parent is invalid");
  }
  if (
    !item ||
    item.spaceId !== input.spaceId ||
    item.sourceAccountId !== account._id ||
    item.lifecycle !== "available"
  ) {
    throw new Error("Artifact source item parent is invalid");
  }
  if (
    !revision ||
    revision.spaceId !== input.spaceId ||
    revision.sourceItemId !== item._id
  ) {
    throw new Error("Artifact source revision parent is invalid");
  }
  if (!(await ctx.db.get(revision.userId))) {
    throw new Error("Artifact source revision actor is invalid");
  }
  const representation = parseSourceRevisionRepresentation(revision);
  if (representation.kind !== "archived_binary_v1") {
    throw new Error("Parser artifacts require an archived binary revision");
  }
  return revision;
}

function sameParserArtifact(
  existing: Doc<"sourceParserArtifacts">,
  input: ParserArtifactInput,
): boolean {
  return (
    existing.spaceId === input.spaceId &&
    existing.sourceAccountId === input.sourceAccountId &&
    existing.sourceItemId === input.sourceItemId &&
    existing.sourceRevisionId === input.sourceRevisionId &&
    existing.clientArtifactId === input.clientArtifactId &&
    existing.parserFingerprint === input.parserFingerprint &&
    existing.outputHash === input.outputHash &&
    existing.outputByteLength === input.outputByteLength &&
    existing.outputMediaType === input.outputMediaType &&
    existing.hashAuthority === "worker_asserted" &&
    existing.userId === input.userId &&
    existing.actorCredentialId === input.actorCredentialId &&
    existing.createdAt === input.createdAt
  );
}

export async function createOrGetParserArtifact(
  ctx: MutationCtx,
  input: ParserArtifactInput,
): Promise<Doc<"sourceParserArtifacts">> {
  await requireArtifactParents(ctx, input);
  requireUuid(input.clientArtifactId, "Client parser artifact ID");
  requireBoundedUtf8(
    input.parserFingerprint,
    "Parser fingerprint",
    MAX_FINGERPRINT_BYTES,
  );
  requireSha256(input.outputHash, "Parser artifact output hash");
  requireSafeInteger(
    input.outputByteLength,
    "Parser artifact output byte length",
    1,
    MAX_PARSER_ARTIFACT_BYTES,
  );
  requireBoundedString(
    input.outputMediaType,
    "Parser artifact media type",
    MAX_MEDIA_TYPE_CHARS,
  );
  requireTimestamp(input.createdAt, "Parser artifact creation time");

  const [byIdentity, byClientId] = await Promise.all([
    ctx.db
      .query("sourceParserArtifacts")
      .withIndex("by_sourceRevisionId_and_parserFingerprint", (q) =>
        q
          .eq("sourceRevisionId", input.sourceRevisionId)
          .eq("parserFingerprint", input.parserFingerprint),
      )
      .take(2),
    ctx.db
      .query("sourceParserArtifacts")
      .withIndex("by_sourceAccountId_and_clientArtifactId", (q) =>
        q
          .eq("sourceAccountId", input.sourceAccountId)
          .eq("clientArtifactId", input.clientArtifactId),
      )
      .take(2),
  ]);
  if (byIdentity.length > 1 || byClientId.length > 1) {
    throw new Error("Parser artifact identity is not unique");
  }
  const existing = byIdentity[0] ?? byClientId[0];
  if (
    (byIdentity[0] &&
      byClientId[0] &&
      byIdentity[0]._id !== byClientId[0]._id) ||
    (existing && !sameParserArtifact(existing, input))
  ) {
    throw new Error("Conflicting immutable parser artifact");
  }
  if (existing) return existing;

  const id = await ctx.db.insert("sourceParserArtifacts", {
    ...input,
    hashAuthority: "worker_asserted",
  });
  return (await ctx.db.get(id))!;
}

function sameArchiveReceipt(
  existing: Doc<"sourceArtifactArchiveReceipts">,
  input: ArchiveReceiptInput,
): boolean {
  return (
    existing.spaceId === input.spaceId &&
    existing.sourceAccountId === input.sourceAccountId &&
    existing.sourceItemId === input.sourceItemId &&
    existing.sourceRevisionId === input.sourceRevisionId &&
    existing.parserArtifactId === input.parserArtifactId &&
    existing.subjectKind === input.subjectKind &&
    existing.copyRole === input.copyRole &&
    existing.clientReceiptId === input.clientReceiptId &&
    existing.requestDigest === input.requestDigest &&
    existing.receiptVersion === "archive_receipt_v1" &&
    existing.archiveRepresentation === "age_encrypted_v1" &&
    existing.archiveProfileFingerprint === input.archiveProfileFingerprint &&
    existing.archiveIdentityFingerprint === input.archiveIdentityFingerprint &&
    existing.recipientFingerprint === input.recipientFingerprint &&
    existing.repositoryKeyDomainFingerprint ===
      input.repositoryKeyDomainFingerprint &&
    existing.storageFailureDomainFingerprint ===
      input.storageFailureDomainFingerprint &&
    existing.archiveObjectId === input.archiveObjectId &&
    existing.plaintextHash === input.plaintextHash &&
    existing.plaintextByteLength === input.plaintextByteLength &&
    existing.plaintextMediaType === input.plaintextMediaType &&
    existing.hashAuthority === "worker_asserted" &&
    existing.ciphertextHash === input.ciphertextHash &&
    existing.ciphertextByteLength === input.ciphertextByteLength &&
    existing.verificationKind === "ciphertext_readback_sha256" &&
    existing.readbackVerifiedAt === input.readbackVerifiedAt &&
    existing.userId === input.userId &&
    existing.actorCredentialId === input.actorCredentialId &&
    existing.createdAt === input.createdAt
  );
}

export async function createOrGetArchiveReceipt(
  ctx: MutationCtx,
  input: ArchiveReceiptInput,
): Promise<Doc<"sourceArtifactArchiveReceipts">> {
  const revision = await requireArtifactParents(ctx, input);
  requireUuid(input.clientReceiptId, "Client archive receipt ID");
  requireSha256(input.requestDigest, "Archive request digest");
  requireSha256(input.archiveProfileFingerprint, "Archive profile fingerprint");
  requireSha256(
    input.archiveIdentityFingerprint,
    "Archive identity fingerprint",
  );
  requireSha256(input.recipientFingerprint, "Archive recipient fingerprint");
  requireSha256(
    input.repositoryKeyDomainFingerprint,
    "Archive repository key-domain fingerprint",
  );
  requireSha256(
    input.storageFailureDomainFingerprint,
    "Archive storage failure-domain fingerprint",
  );
  requireUuid(input.archiveObjectId, "Archive object ID");
  requireSha256(input.plaintextHash, "Archive plaintext hash");
  requireBoundedString(
    input.plaintextMediaType,
    "Archive plaintext media type",
    MAX_MEDIA_TYPE_CHARS,
  );
  requireSha256(input.ciphertextHash, "Archive ciphertext hash");
  requireSafeInteger(
    input.ciphertextByteLength,
    "Archive ciphertext byte length",
    1,
    MAX_PARSER_ARTIFACT_BYTES + MAX_CIPHERTEXT_OVERHEAD_BYTES,
  );
  requireTimestamp(input.createdAt, "Archive receipt creation time");
  requireTimestamp(input.readbackVerifiedAt, "Archive readback time");
  if (input.readbackVerifiedAt < input.createdAt) {
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
    const artifact = await ctx.db.get(input.parserArtifactId);
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
    requireSafeInteger(
      input.plaintextByteLength,
      "Parser archive plaintext byte length",
      1,
      MAX_PARSER_ARTIFACT_BYTES,
    );
  }

  const [byClientId, byArchiveObject] = await Promise.all([
    ctx.db
      .query("sourceArtifactArchiveReceipts")
      .withIndex("by_sourceAccountId_and_clientReceiptId", (q) =>
        q
          .eq("sourceAccountId", input.sourceAccountId)
          .eq("clientReceiptId", input.clientReceiptId),
      )
      .take(2),
    ctx.db
      .query("sourceArtifactArchiveReceipts")
      .withIndex("by_archiveIdentity_and_objectId", (q) =>
        q
          .eq("archiveIdentityFingerprint", input.archiveIdentityFingerprint)
          .eq("archiveObjectId", input.archiveObjectId),
      )
      .take(2),
  ]);
  if (byClientId.length > 1 || byArchiveObject.length > 1) {
    throw new Error("Archive receipt identity is not unique");
  }
  const existing = byClientId[0] ?? byArchiveObject[0];
  if (
    (byClientId[0] &&
      byArchiveObject[0] &&
      byClientId[0]._id !== byArchiveObject[0]._id) ||
    (existing && !sameArchiveReceipt(existing, input))
  ) {
    throw new Error("Conflicting immutable archive receipt");
  }
  if (existing) return existing;

  const id = await ctx.db.insert("sourceArtifactArchiveReceipts", {
    ...input,
    receiptVersion: "archive_receipt_v1",
    archiveRepresentation: "age_encrypted_v1",
    hashAuthority: "worker_asserted",
    verificationKind: "ciphertext_readback_sha256",
  });
  return (await ctx.db.get(id))!;
}
