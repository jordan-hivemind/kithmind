// Ported from packages/convex/convex/models/provenance/providerOriginals.ts
// (P2-39d2): a worker's declaration that a source revision's original bytes
// still live at a provider (Dropbox today), verified against a locator
// bundle it archived independently, in place of this system holding its own
// copy of the original.
//
// `ProviderOriginalDeclaration` is `@repo/worker-protocol`'s wire shape
// (already framework-agnostic -- `models/workers/parsedProtocol.ts` in
// Convex just re-exports the same package this port depends on directly),
// so its timestamps stay epoch-millisecond numbers exactly as the worker
// sends them. Only the columns this module stores through -- `verifiedAt`,
// `createdAt`, the locator bundle's `readbackVerifiedAt`, and the
// bindings' own `updatedAt` -- cross into `Date`, matching every other
// ported table in this package.

import type { ProviderOriginalDeclaration } from "@repo/worker-protocol";
import type { ClientBase, QueryResultRow } from "pg";

import { newKithId } from "../ids.js";
import {
  camelizeSourceProviderOriginalBinding,
  camelizeSourceProviderOriginalReference,
  type SourceProviderOriginalBindingRow,
  type SourceProviderOriginalReferenceRow,
} from "./rows.js";
import { sha256Utf8 } from "./sql.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^[\x20-\x7e]{1,128}$/;
const OBJECT_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
export const PROVIDER_VERIFICATION_MAX_AGE_MS = 10 * 60 * 1_000;
export const PROVIDER_VERIFICATION_FUTURE_SKEW_MS = 5 * 60 * 1_000;

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
  timestamp(value.locatorBundle.readbackVerifiedAt, "locator readback verification time");
  if (
    value.verifiedAt < value.createdAt ||
    value.locatorBundle.readbackVerifiedAt < value.createdAt ||
    value.verifiedAt < now - PROVIDER_VERIFICATION_MAX_AGE_MS ||
    value.verifiedAt > now + PROVIDER_VERIFICATION_FUTURE_SKEW_MS ||
    value.locatorBundle.readbackVerifiedAt < now - PROVIDER_VERIFICATION_MAX_AGE_MS ||
    value.locatorBundle.readbackVerifiedAt > now + PROVIDER_VERIFICATION_FUTURE_SKEW_MS
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
  row: SourceProviderOriginalReferenceRow,
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
    row.verifiedAt.getTime() === value.verifiedAt &&
    row.locatorBindingId === value.locatorBundle.bindingId &&
    row.locatorManifestFingerprint === value.locatorBundle.manifestFingerprint &&
    row.locatorRecipientFingerprint === value.locatorBundle.recipientFingerprint &&
    row.locatorRepositoryKeyDomainFingerprint ===
      value.locatorBundle.repositoryKeyDomainFingerprint &&
    row.locatorRepositoryId === value.locatorBundle.repositoryId &&
    row.locatorSnapshotId === value.locatorBundle.snapshotId &&
    row.locatorObjectName === value.locatorBundle.objectName &&
    row.locatorCiphertextHash === value.locatorBundle.ciphertextHash &&
    row.locatorCiphertextByteLength === value.locatorBundle.ciphertextByteLength &&
    row.locatorReadbackVerifiedAt.getTime() === value.locatorBundle.readbackVerifiedAt &&
    row.createdAtField.getTime() === value.createdAt
  );
}

function sameProviderIdentity(
  left: SourceProviderOriginalReferenceRow,
  right: SourceProviderOriginalReferenceRow,
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
  client: ClientBase,
  input: {
    spaceId: string;
    sourceAccountId: string;
    sourceItemId: string;
    sourceRevisionId: string;
    declaration: ProviderOriginalDeclaration;
    requestDigest: string;
    userId: string;
    actorCredentialId: string;
    now: Date;
  },
): Promise<{
  reference: SourceProviderOriginalReferenceRow;
  binding: SourceProviderOriginalBindingRow;
}> {
  const nowMs = input.now.getTime();
  validateProviderOriginalDeclaration(input.declaration, nowMs);
  digest(input.requestDigest, "provider reference request digest");
  const fingerprint = await providerOriginalReferenceFingerprint(input.declaration);
  const byClient = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_provider_original_references
      WHERE source_account_id = $1 AND client_reference_id = $2 LIMIT 2`,
    [input.sourceAccountId, input.declaration.clientReferenceId],
  );
  if (byClient.rowCount! > 1) invalid("Provider original identity is not unique");
  let reference = byClient.rows[0] && camelizeSourceProviderOriginalReference(byClient.rows[0]);
  if (
    reference &&
    (reference.spaceId !== input.spaceId ||
      reference.sourceItemId !== input.sourceItemId ||
      reference.sourceRevisionId !== input.sourceRevisionId ||
      !sameReference(reference, input.declaration, input.requestDigest, fingerprint))
  )
    invalid("Conflicting immutable provider original reference");
  if (!reference) {
    const value = input.declaration;
    const id = newKithId();
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.source_provider_original_references
         (id, space_id, created_at, source_account_id, source_item_id, source_revision_id,
          client_reference_id, request_digest, reference_version, provider_kind, reference_fingerprint,
          source_content_hash, source_byte_length, provider_account_id_hash, provider_root_directory_id_hash,
          provider_file_id_hash, provider_revision, provider_content_hash, verified_at,
          locator_binding_id, locator_manifest_fingerprint, locator_recipient_fingerprint,
          locator_repository_key_domain_fingerprint, locator_repository_id, locator_snapshot_id,
          locator_object_name, locator_ciphertext_hash, locator_ciphertext_byte_length,
          locator_readback_verified_at, verification_authority, user_id, actor_credential_id, created_at_field)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,'worker_asserted',$29,$30,$31)
       RETURNING *`,
      [
        id,
        input.spaceId,
        input.sourceAccountId,
        input.sourceItemId,
        input.sourceRevisionId,
        value.clientReferenceId,
        input.requestDigest,
        value.referenceVersion,
        value.providerKind,
        fingerprint,
        value.sourceContentHash,
        value.sourceByteLength,
        value.providerAccountIdHash,
        value.providerRootDirectoryIdHash,
        value.providerFileIdHash,
        value.providerRevision,
        value.providerContentHash,
        new Date(value.verifiedAt),
        value.locatorBundle.bindingId,
        value.locatorBundle.manifestFingerprint,
        value.locatorBundle.recipientFingerprint,
        value.locatorBundle.repositoryKeyDomainFingerprint,
        value.locatorBundle.repositoryId,
        value.locatorBundle.snapshotId,
        value.locatorBundle.objectName,
        value.locatorBundle.ciphertextHash,
        value.locatorBundle.ciphertextByteLength,
        new Date(value.locatorBundle.readbackVerifiedAt),
        input.userId,
        input.actorCredentialId,
        new Date(value.createdAt),
      ],
    );
    reference = camelizeSourceProviderOriginalReference(result.rows[0]!);
  }
  const byRevision = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_provider_original_bindings WHERE source_revision_id = $1 LIMIT 2`,
    [input.sourceRevisionId],
  );
  if (byRevision.rowCount! > 1) invalid("Provider original binding is not unique");
  let binding = byRevision.rows[0] && camelizeSourceProviderOriginalBinding(byRevision.rows[0]);
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
    const id = newKithId();
    const result = await client.query<QueryResultRow>(
      `INSERT INTO kith.source_provider_original_bindings
         (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, reference_id,
          binding_epoch, verified_at, user_id, actor_credential_id, updated_at)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,0,$7,$8,$9,$10)
       RETURNING *`,
      [
        id,
        input.spaceId,
        input.sourceAccountId,
        input.sourceItemId,
        input.sourceRevisionId,
        reference.id,
        reference.verifiedAt,
        input.userId,
        input.actorCredentialId,
        input.now,
      ],
    );
    binding = camelizeSourceProviderOriginalBinding(result.rows[0]!);
  } else if (binding.referenceId === reference.id) {
    if (binding.verifiedAt.getTime() !== reference.verifiedAt.getTime()) {
      invalid("Provider original binding verification is invalid");
    }
  } else {
    const priorRow = (
      await client.query<QueryResultRow>(`SELECT * FROM kith.source_provider_original_references WHERE id = $1`, [
        binding.referenceId,
      ])
    ).rows[0];
    const prior = priorRow && camelizeSourceProviderOriginalReference(priorRow);
    if (
      !prior ||
      !sameProviderIdentity(prior, reference) ||
      reference.verifiedAt.getTime() <= binding.verifiedAt.getTime() ||
      !Number.isSafeInteger(binding.bindingEpoch) ||
      binding.bindingEpoch < 0 ||
      binding.bindingEpoch >= Number.MAX_SAFE_INTEGER
    )
      invalid("Provider original identity requires review");
    const result = await client.query<QueryResultRow>(
      `UPDATE kith.source_provider_original_bindings
          SET reference_id = $1, binding_epoch = $2, verified_at = $3, user_id = $4,
              actor_credential_id = $5, updated_at = $6
        WHERE id = $7
        RETURNING *`,
      [
        reference.id,
        binding.bindingEpoch + 1,
        reference.verifiedAt,
        input.userId,
        input.actorCredentialId,
        input.now,
        binding.id,
      ],
    );
    binding = camelizeSourceProviderOriginalBinding(result.rows[0]!);
  }
  return { reference, binding };
}

export async function loadProviderOriginalBinding(
  client: ClientBase,
  sourceRevisionId: string,
): Promise<
  | { binding: SourceProviderOriginalBindingRow; reference: SourceProviderOriginalReferenceRow }
  | null
> {
  const rows = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_provider_original_bindings WHERE source_revision_id = $1 LIMIT 2`,
    [sourceRevisionId],
  );
  if (rows.rowCount! > 1) invalid("Provider original binding is not unique");
  const row = rows.rows[0];
  if (!row) return null;
  const binding = camelizeSourceProviderOriginalBinding(row);
  if (
    binding.sourceRevisionId !== sourceRevisionId ||
    !Number.isSafeInteger(binding.bindingEpoch) ||
    binding.bindingEpoch < 0 ||
    Number.isNaN(binding.verifiedAt.getTime()) ||
    binding.verifiedAt.getTime() < 0
  )
    invalid("Provider original binding is invalid");
  const reference = await loadProviderOriginalReference(client, {
    referenceId: binding.referenceId,
    spaceId: binding.spaceId,
    sourceAccountId: binding.sourceAccountId,
    sourceItemId: binding.sourceItemId,
    sourceRevisionId: binding.sourceRevisionId,
  });
  if (binding.verifiedAt.getTime() !== reference.verifiedAt.getTime()) {
    invalid("Provider original binding verification is invalid");
  }
  return { binding, reference };
}

export async function loadProviderOriginalReference(
  client: ClientBase,
  input: {
    referenceId: string;
    spaceId: string;
    sourceAccountId: string;
    sourceItemId: string;
    sourceRevisionId: string;
    expectedSourceContentHash?: string;
    expectedSourceByteLength?: number;
  },
): Promise<SourceProviderOriginalReferenceRow> {
  const row = (
    await client.query<QueryResultRow>(`SELECT * FROM kith.source_provider_original_references WHERE id = $1`, [
      input.referenceId,
    ])
  ).rows[0];
  const reference = row && camelizeSourceProviderOriginalReference(row);
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
    verifiedAt: reference.verifiedAt.getTime(),
    locatorBundle: {
      bindingId: reference.locatorBindingId,
      manifestFingerprint: reference.locatorManifestFingerprint,
      recipientFingerprint: reference.locatorRecipientFingerprint,
      repositoryKeyDomainFingerprint: reference.locatorRepositoryKeyDomainFingerprint,
      repositoryId: reference.locatorRepositoryId,
      snapshotId: reference.locatorSnapshotId,
      objectName: reference.locatorObjectName,
      ciphertextHash: reference.locatorCiphertextHash,
      ciphertextByteLength: reference.locatorCiphertextByteLength,
      readbackVerifiedAt: reference.locatorReadbackVerifiedAt.getTime(),
    },
    createdAt: reference.createdAtField.getTime(),
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
    reference.referenceFingerprint !== (await providerOriginalReferenceFingerprint(declaration))
  )
    invalid("Provider original reference is invalid");
  return reference;
}
