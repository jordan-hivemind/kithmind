import type { ProviderOriginalDeclaration } from "@repo/worker-protocol";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { sha256Utf8 } from "./model";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^[\x20-\x7e]{1,128}$/;
const OBJECT_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
export const PROVIDER_VERIFICATION_MAX_AGE_MS = 10 * 60 * 1_000;
export const PROVIDER_VERIFICATION_FUTURE_SKEW_MS = 5 * 60 * 1_000;

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

function invalid(message: string): never {
  throw new Error(message);
}

function digest(value: string, name: string): string {
  if (!SHA256.test(value)) invalid(`${name} is invalid`);
  return value;
}

function timestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} is invalid`);
  return value;
}

export function validateProviderOriginalDeclaration(
  value: ProviderOriginalDeclaration,
  now: number,
): void {
  if (
    value.referenceVersion !== "provider_original_v1" ||
    value.providerKind !== "dropbox_v1" ||
    !UUID.test(value.clientReferenceId) ||
    !Number.isSafeInteger(value.sourceByteLength) ||
    value.sourceByteLength < 1 ||
    !REVISION.test(value.providerRevision) ||
    !UUID.test(value.locatorBundle.bindingId) ||
    !OBJECT_NAME.test(value.locatorBundle.objectName) ||
    !Number.isSafeInteger(value.locatorBundle.ciphertextByteLength) ||
    value.locatorBundle.ciphertextByteLength < 1 ||
    value.locatorBundle.ciphertextByteLength > 1_024 * 1_024
  )
    invalid("Provider original declaration is invalid");
  for (const [field, name] of [
    [value.sourceContentHash, "source content hash"],
    [value.providerAccountIdHash, "provider account ID hash"],
    [value.providerRootDirectoryIdHash, "provider root ID hash"],
    [value.providerFileIdHash, "provider file ID hash"],
    [value.providerContentHash, "provider content hash"],
    [value.locatorBundle.manifestFingerprint, "locator manifest fingerprint"],
    [value.locatorBundle.recipientFingerprint, "locator recipient fingerprint"],
    [
      value.locatorBundle.repositoryKeyDomainFingerprint,
      "locator repository key-domain fingerprint",
    ],
    [value.locatorBundle.repositoryId, "locator repository ID"],
    [value.locatorBundle.snapshotId, "locator snapshot ID"],
    [value.locatorBundle.ciphertextHash, "locator ciphertext hash"],
  ] as const)
    digest(field, name);
  timestamp(value.createdAt, "provider reference creation time");
  timestamp(value.verifiedAt, "provider verification time");
  timestamp(
    value.locatorBundle.readbackVerifiedAt,
    "locator readback verification time",
  );
  if (
    value.verifiedAt < value.createdAt ||
    value.locatorBundle.readbackVerifiedAt < value.createdAt ||
    value.verifiedAt < now - PROVIDER_VERIFICATION_MAX_AGE_MS ||
    value.verifiedAt > now + PROVIDER_VERIFICATION_FUTURE_SKEW_MS ||
    value.locatorBundle.readbackVerifiedAt <
      now - PROVIDER_VERIFICATION_MAX_AGE_MS ||
    value.locatorBundle.readbackVerifiedAt >
      now + PROVIDER_VERIFICATION_FUTURE_SKEW_MS
  )
    invalid("Provider original verification is stale");
}

export async function providerOriginalReferenceFingerprint(
  value: ProviderOriginalDeclaration,
): Promise<string> {
  return sha256Utf8(
    `provider-original-reference:v1\0${JSON.stringify([
      value.referenceVersion,
      value.providerKind,
      value.clientReferenceId,
      value.sourceContentHash,
      value.sourceByteLength,
      value.providerAccountIdHash,
      value.providerRootDirectoryIdHash,
      value.providerFileIdHash,
      value.providerRevision,
      value.providerContentHash,
      value.verifiedAt,
      [
        value.locatorBundle.bindingId,
        value.locatorBundle.manifestFingerprint,
        value.locatorBundle.recipientFingerprint,
        value.locatorBundle.repositoryKeyDomainFingerprint,
        value.locatorBundle.repositoryId,
        value.locatorBundle.snapshotId,
        value.locatorBundle.objectName,
        value.locatorBundle.ciphertextHash,
        value.locatorBundle.ciphertextByteLength,
        value.locatorBundle.readbackVerifiedAt,
      ],
      value.createdAt,
    ])}`,
  );
}

function sameReference(
  row: Doc<"sourceProviderOriginalReferences">,
  value: ProviderOriginalDeclaration,
  requestDigest: string,
  fingerprint: string,
): boolean {
  return (
    row.clientReferenceId === value.clientReferenceId &&
    row.requestDigest === requestDigest &&
    row.referenceFingerprint === fingerprint &&
    row.sourceContentHash === value.sourceContentHash &&
    row.sourceByteLength === value.sourceByteLength &&
    row.providerAccountIdHash === value.providerAccountIdHash &&
    row.providerRootDirectoryIdHash === value.providerRootDirectoryIdHash &&
    row.providerFileIdHash === value.providerFileIdHash &&
    row.providerRevision === value.providerRevision &&
    row.providerContentHash === value.providerContentHash &&
    row.verifiedAt === value.verifiedAt &&
    row.locatorBindingId === value.locatorBundle.bindingId &&
    row.locatorManifestFingerprint ===
      value.locatorBundle.manifestFingerprint &&
    row.locatorRecipientFingerprint ===
      value.locatorBundle.recipientFingerprint &&
    row.locatorRepositoryKeyDomainFingerprint ===
      value.locatorBundle.repositoryKeyDomainFingerprint &&
    row.locatorRepositoryId === value.locatorBundle.repositoryId &&
    row.locatorSnapshotId === value.locatorBundle.snapshotId &&
    row.locatorObjectName === value.locatorBundle.objectName &&
    row.locatorCiphertextHash === value.locatorBundle.ciphertextHash &&
    row.locatorCiphertextByteLength ===
      value.locatorBundle.ciphertextByteLength &&
    row.locatorReadbackVerifiedAt === value.locatorBundle.readbackVerifiedAt &&
    row.createdAt === value.createdAt
  );
}

function sameProviderIdentity(
  left: Doc<"sourceProviderOriginalReferences">,
  right: Doc<"sourceProviderOriginalReferences">,
): boolean {
  return (
    left.sourceContentHash === right.sourceContentHash &&
    left.sourceByteLength === right.sourceByteLength &&
    left.providerAccountIdHash === right.providerAccountIdHash &&
    left.providerRootDirectoryIdHash === right.providerRootDirectoryIdHash &&
    left.providerFileIdHash === right.providerFileIdHash &&
    left.providerRevision === right.providerRevision &&
    left.providerContentHash === right.providerContentHash
  );
}

export async function createAndBindProviderOriginal(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    sourceItemId: Id<"sourceItems">;
    sourceRevisionId: Id<"sourceRevisions">;
    declaration: ProviderOriginalDeclaration;
    requestDigest: string;
    userId: Id<"users">;
    actorCredentialId: Id<"apiKeys">;
    now: number;
  },
): Promise<{
  reference: Doc<"sourceProviderOriginalReferences">;
  binding: Doc<"sourceProviderOriginalBindings">;
}> {
  validateProviderOriginalDeclaration(input.declaration, input.now);
  digest(input.requestDigest, "provider reference request digest");
  const fingerprint = await providerOriginalReferenceFingerprint(
    input.declaration,
  );
  const byClient = await ctx.db
    .query("sourceProviderOriginalReferences")
    .withIndex("by_sourceAccountId_and_clientReferenceId", (q) =>
      q
        .eq("sourceAccountId", input.sourceAccountId)
        .eq("clientReferenceId", input.declaration.clientReferenceId),
    )
    .take(2);
  if (byClient.length > 1) invalid("Provider original identity is not unique");
  let reference = byClient[0];
  if (
    reference &&
    (reference.spaceId !== input.spaceId ||
      reference.sourceItemId !== input.sourceItemId ||
      reference.sourceRevisionId !== input.sourceRevisionId ||
      !sameReference(
        reference,
        input.declaration,
        input.requestDigest,
        fingerprint,
      ))
  )
    invalid("Conflicting immutable provider original reference");
  if (!reference) {
    const value = input.declaration;
    const id = await ctx.db.insert("sourceProviderOriginalReferences", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      sourceItemId: input.sourceItemId,
      sourceRevisionId: input.sourceRevisionId,
      clientReferenceId: value.clientReferenceId,
      requestDigest: input.requestDigest,
      referenceVersion: value.referenceVersion,
      providerKind: value.providerKind,
      referenceFingerprint: fingerprint,
      sourceContentHash: value.sourceContentHash,
      sourceByteLength: value.sourceByteLength,
      providerAccountIdHash: value.providerAccountIdHash,
      providerRootDirectoryIdHash: value.providerRootDirectoryIdHash,
      providerFileIdHash: value.providerFileIdHash,
      providerRevision: value.providerRevision,
      providerContentHash: value.providerContentHash,
      verifiedAt: value.verifiedAt,
      locatorBindingId: value.locatorBundle.bindingId,
      locatorManifestFingerprint: value.locatorBundle.manifestFingerprint,
      locatorRecipientFingerprint: value.locatorBundle.recipientFingerprint,
      locatorRepositoryKeyDomainFingerprint:
        value.locatorBundle.repositoryKeyDomainFingerprint,
      locatorRepositoryId: value.locatorBundle.repositoryId,
      locatorSnapshotId: value.locatorBundle.snapshotId,
      locatorObjectName: value.locatorBundle.objectName,
      locatorCiphertextHash: value.locatorBundle.ciphertextHash,
      locatorCiphertextByteLength: value.locatorBundle.ciphertextByteLength,
      locatorReadbackVerifiedAt: value.locatorBundle.readbackVerifiedAt,
      verificationAuthority: "worker_asserted",
      userId: input.userId,
      actorCredentialId: input.actorCredentialId,
      createdAt: value.createdAt,
    });
    reference = (await ctx.db.get(id))!;
  }
  const bindings = await ctx.db
    .query("sourceProviderOriginalBindings")
    .withIndex("by_sourceRevisionId", (q) =>
      q.eq("sourceRevisionId", input.sourceRevisionId),
    )
    .take(2);
  if (bindings.length > 1) invalid("Provider original binding is not unique");
  let binding = bindings[0];
  if (
    binding &&
    (binding.spaceId !== input.spaceId ||
      binding.sourceAccountId !== input.sourceAccountId ||
      binding.sourceItemId !== input.sourceItemId ||
      binding.sourceRevisionId !== input.sourceRevisionId ||
      !Number.isSafeInteger(binding.bindingEpoch) ||
      binding.bindingEpoch < 0)
  )
    invalid("Provider original binding parent is invalid");
  if (!binding) {
    const id = await ctx.db.insert("sourceProviderOriginalBindings", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      sourceItemId: input.sourceItemId,
      sourceRevisionId: input.sourceRevisionId,
      referenceId: reference._id,
      bindingEpoch: 0,
      verifiedAt: reference.verifiedAt,
      userId: input.userId,
      actorCredentialId: input.actorCredentialId,
      updatedAt: input.now,
    });
    binding = (await ctx.db.get(id))!;
  } else if (binding.referenceId === reference._id) {
    if (binding.verifiedAt !== reference.verifiedAt)
      invalid("Provider original binding verification is invalid");
  } else {
    const prior = await ctx.db.get(binding.referenceId);
    if (
      !prior ||
      !sameProviderIdentity(prior, reference) ||
      reference.verifiedAt <= binding.verifiedAt ||
      !Number.isSafeInteger(binding.bindingEpoch) ||
      binding.bindingEpoch < 0 ||
      binding.bindingEpoch >= Number.MAX_SAFE_INTEGER
    )
      invalid("Provider original identity requires review");
    await ctx.db.patch(binding._id, {
      referenceId: reference._id,
      bindingEpoch: binding.bindingEpoch + 1,
      verifiedAt: reference.verifiedAt,
      userId: input.userId,
      actorCredentialId: input.actorCredentialId,
      updatedAt: input.now,
    });
    binding = (await ctx.db.get(binding._id))!;
  }
  return { reference, binding };
}

export async function loadProviderOriginalBinding(
  ctx: ReadCtx,
  sourceRevisionId: Id<"sourceRevisions">,
) {
  const rows = await ctx.db
    .query("sourceProviderOriginalBindings")
    .withIndex("by_sourceRevisionId", (q) =>
      q.eq("sourceRevisionId", sourceRevisionId),
    )
    .take(2);
  if (rows.length > 1) invalid("Provider original binding is not unique");
  if (!rows[0]) return null;
  const binding = rows[0];
  if (
    binding.sourceRevisionId !== sourceRevisionId ||
    !Number.isSafeInteger(binding.bindingEpoch) ||
    binding.bindingEpoch < 0 ||
    !Number.isSafeInteger(binding.verifiedAt) ||
    binding.verifiedAt < 0
  )
    invalid("Provider original binding is invalid");
  const reference = await loadProviderOriginalReference(ctx, {
    referenceId: binding.referenceId,
    spaceId: binding.spaceId,
    sourceAccountId: binding.sourceAccountId,
    sourceItemId: binding.sourceItemId,
    sourceRevisionId: binding.sourceRevisionId,
  });
  if (binding.verifiedAt !== reference.verifiedAt)
    invalid("Provider original binding verification is invalid");
  return { binding, reference };
}

export async function loadProviderOriginalReference(
  ctx: ReadCtx,
  input: {
    referenceId: Id<"sourceProviderOriginalReferences">;
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    sourceItemId: Id<"sourceItems">;
    sourceRevisionId: Id<"sourceRevisions">;
    expectedSourceContentHash?: string;
    expectedSourceByteLength?: number;
  },
) {
  const reference = await ctx.db.get(input.referenceId);
  if (
    !reference ||
    reference.spaceId !== input.spaceId ||
    reference.sourceAccountId !== input.sourceAccountId ||
    reference.sourceItemId !== input.sourceItemId ||
    reference.sourceRevisionId !== input.sourceRevisionId ||
    (input.expectedSourceContentHash !== undefined &&
      reference.sourceContentHash !== input.expectedSourceContentHash) ||
    (input.expectedSourceByteLength !== undefined &&
      reference.sourceByteLength !== input.expectedSourceByteLength) ||
    reference.referenceVersion !== "provider_original_v1" ||
    reference.providerKind !== "dropbox_v1" ||
    reference.verificationAuthority !== "worker_asserted" ||
    !SHA256.test(reference.requestDigest)
  )
    invalid("Provider original reference parent is invalid");
  const declaration: ProviderOriginalDeclaration = {
    referenceVersion: reference.referenceVersion,
    providerKind: reference.providerKind,
    clientReferenceId: reference.clientReferenceId,
    sourceContentHash: reference.sourceContentHash,
    sourceByteLength: reference.sourceByteLength,
    providerAccountIdHash: reference.providerAccountIdHash,
    providerRootDirectoryIdHash: reference.providerRootDirectoryIdHash,
    providerFileIdHash: reference.providerFileIdHash,
    providerRevision: reference.providerRevision,
    providerContentHash: reference.providerContentHash,
    verifiedAt: reference.verifiedAt,
    locatorBundle: {
      bindingId: reference.locatorBindingId,
      manifestFingerprint: reference.locatorManifestFingerprint,
      recipientFingerprint: reference.locatorRecipientFingerprint,
      repositoryKeyDomainFingerprint:
        reference.locatorRepositoryKeyDomainFingerprint,
      repositoryId: reference.locatorRepositoryId,
      snapshotId: reference.locatorSnapshotId,
      objectName: reference.locatorObjectName,
      ciphertextHash: reference.locatorCiphertextHash,
      ciphertextByteLength: reference.locatorCiphertextByteLength,
      readbackVerifiedAt: reference.locatorReadbackVerifiedAt,
    },
    createdAt: reference.createdAt,
  };
  if (
    !UUID.test(declaration.clientReferenceId) ||
    !UUID.test(declaration.locatorBundle.bindingId) ||
    !REVISION.test(declaration.providerRevision) ||
    !OBJECT_NAME.test(declaration.locatorBundle.objectName) ||
    !Number.isSafeInteger(declaration.sourceByteLength) ||
    declaration.sourceByteLength < 1 ||
    !Number.isSafeInteger(declaration.locatorBundle.ciphertextByteLength) ||
    declaration.locatorBundle.ciphertextByteLength < 1 ||
    declaration.locatorBundle.ciphertextByteLength > 1_024 * 1_024 ||
    !Number.isSafeInteger(declaration.createdAt) ||
    !Number.isSafeInteger(declaration.verifiedAt) ||
    !Number.isSafeInteger(declaration.locatorBundle.readbackVerifiedAt) ||
    declaration.createdAt < 0 ||
    declaration.verifiedAt < declaration.createdAt ||
    declaration.locatorBundle.readbackVerifiedAt < declaration.createdAt ||
    [
      declaration.sourceContentHash,
      declaration.providerAccountIdHash,
      declaration.providerRootDirectoryIdHash,
      declaration.providerFileIdHash,
      declaration.providerContentHash,
      declaration.locatorBundle.manifestFingerprint,
      declaration.locatorBundle.recipientFingerprint,
      declaration.locatorBundle.repositoryKeyDomainFingerprint,
      declaration.locatorBundle.repositoryId,
      declaration.locatorBundle.snapshotId,
      declaration.locatorBundle.ciphertextHash,
    ].some((value) => !SHA256.test(value)) ||
    reference.referenceFingerprint !==
      (await providerOriginalReferenceFingerprint(declaration))
  )
    invalid("Provider original reference is invalid");
  return reference;
}
