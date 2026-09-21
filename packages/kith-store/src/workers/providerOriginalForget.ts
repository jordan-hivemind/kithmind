import type {
  WorkerProviderOriginalAckDetachResult,
  WorkerProviderOriginalDetachAckSummary,
  WorkerProviderOriginalForgetTarget,
  WorkerProviderOriginalForgetTargetsResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";
import { sha256Hex } from "../ingestion/inline.js";
import { newKithId, KITH_ID } from "../ids.js";
import {
  camelizeSourceProviderOriginalDetachAck,
  camelizeSourceProviderOriginalReference,
  camelizeSourceRevision,
  loadProviderOriginalReference,
  type SourceItemRow,
  type SourceProviderOriginalDetachAckRow,
  type SourceProviderOriginalReferenceRow,
} from "../provenance/index.js";
import type { LoadedWorkerSource } from "./auth.js";
import { decodeCursor, keysetPage, keysetTail } from "./cursor.js";
import { at, exec, row, rows, type WorkerCtx } from "./db.js";
import { isWorkerTransactionAbort, workerProtocolError } from "./errors.js";
import { requireForgettingItem } from "./forget.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

function ackSummary(
  ack: SourceProviderOriginalDetachAckRow,
): WorkerProviderOriginalDetachAckSummary {
  if (ack.ackVersion === "provider_original_detach_ack_v2") {
    if (
      (ack.referenceOutcome !== "detached" &&
        ack.referenceOutcome !== "already_detached") ||
      ack.providerSourceOutcome !== "retained_unchanged" ||
      ack.locatorBindingId !== null ||
      ack.locatorRepositoryId !== null ||
      ack.locatorSnapshotId !== null ||
      ack.locatorObjectName !== null ||
      ack.locatorBundleOutcome !== null ||
      ack.locatorAbsenceAuthority !== null ||
      ack.retentionDisclosure !== null
    )
      workerProtocolError("scan_conflict");
    return {
      referenceVersion: "provider_original_v2",
      detachId: ack.detachId,
      referenceId: ack.referenceId,
      forgetEpoch: ack.forgetEpoch,
      referenceOutcome: ack.referenceOutcome,
      providerSourceOutcome: ack.providerSourceOutcome,
      completedAt: ack.completedAt.getTime(),
    };
  }
  if (
    ack.ackVersion !== "provider_original_detach_ack_v1" ||
    ack.locatorAbsenceAuthority !== "worker_asserted_live_repository_absence" ||
    ack.retentionDisclosure !== "provider_retained_deleted_history_possible" ||
    ack.providerSourceOutcome !== "retained_unchanged" ||
    (ack.referenceOutcome !== "detached" &&
      ack.referenceOutcome !== "already_detached") ||
    (ack.locatorBundleOutcome !== "deleted" &&
      ack.locatorBundleOutcome !== "already_missing")
  )
    workerProtocolError("scan_conflict");
  return {
    detachId: ack.detachId,
    referenceId: ack.referenceId,
    forgetEpoch: ack.forgetEpoch,
    referenceOutcome: ack.referenceOutcome,
    locatorBundleOutcome: ack.locatorBundleOutcome,
    locatorAbsenceAuthority: ack.locatorAbsenceAuthority,
    retentionDisclosure: ack.retentionDisclosure,
    providerSourceOutcome: ack.providerSourceOutcome,
    completedAt: ack.completedAt.getTime(),
  };
}

export async function requireProviderOriginalReferenceChain(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  item: SourceItemRow,
  reference: SourceProviderOriginalReferenceRow,
): Promise<void> {
  const revisionRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_revisions WHERE id = $1",
    [reference.sourceRevisionId],
  );
  const revision = revisionRaw ? camelizeSourceRevision(revisionRaw) : null;
  if (
    reference.spaceId !== source.spaceId ||
    reference.sourceAccountId !== source.account.id ||
    reference.sourceItemId !== item.id ||
    !revision ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== item.id ||
    revision.contentHash !== reference.sourceContentHash ||
    revision.byteLength !== reference.sourceByteLength ||
    reference.providerKind !== "dropbox_v1" ||
    reference.verificationAuthority !== "worker_asserted" ||
    !SHA256.test(reference.referenceFingerprint) ||
    (reference.referenceVersion === "provider_original_v2"
      ? reference.locatorBindingId !== null ||
        reference.locatorRepositoryKeyDomainFingerprint !== null ||
        reference.locatorRepositoryId !== null ||
        reference.locatorSnapshotId !== null ||
        reference.locatorObjectName !== null ||
        reference.locatorCiphertextHash !== null ||
        reference.locatorCiphertextByteLength !== null ||
        reference.locatorReadbackVerifiedAt !== null
      : reference.referenceVersion !== "provider_original_v1" ||
        !UUID.test(reference.locatorBindingId ?? "") ||
        !SHA256.test(reference.locatorRepositoryId ?? "") ||
        !SHA256.test(reference.locatorSnapshotId ?? "") ||
        !SHA256.test(reference.locatorCiphertextHash ?? "") ||
        !OBJECT_NAME.test(reference.locatorObjectName ?? "") ||
        !Number.isSafeInteger(reference.locatorCiphertextByteLength) ||
        (reference.locatorCiphertextByteLength ?? 0) < 1)
  )
    workerProtocolError("scan_conflict");
  try {
    await loadProviderOriginalReference(ctx.client, {
      referenceId: reference.id,
      spaceId: source.spaceId,
      sourceAccountId: source.account.id,
      sourceItemId: item.id,
      sourceRevisionId: reference.sourceRevisionId,
      expectedSourceContentHash: revision.contentHash,
      expectedSourceByteLength: revision.byteLength,
    });
  } catch (error) {
    if (isWorkerTransactionAbort(error)) throw error;
    workerProtocolError("scan_conflict");
  }
}

function target(
  reference: SourceProviderOriginalReferenceRow,
  forgetEpoch: number,
  ack: SourceProviderOriginalDetachAckRow | null,
): WorkerProviderOriginalForgetTarget {
  const summary = ack ? ackSummary(ack) : undefined;
  const referenceV2 = reference.referenceVersion === "provider_original_v2";
  const summaryV2 = summary
    ? "referenceVersion" in summary &&
      summary.referenceVersion === "provider_original_v2"
    : referenceV2;
  if (referenceV2 !== summaryV2) workerProtocolError("scan_conflict");
  if (reference.referenceVersion === "provider_original_v2") {
    return {
      referenceVersion: "provider_original_v2",
      referenceId: reference.id,
      referenceFingerprint: reference.referenceFingerprint,
      forgetEpoch,
      ...(summary
        ? {
            ack: summary as Extract<
              WorkerProviderOriginalDetachAckSummary,
              { referenceVersion: "provider_original_v2" }
            >,
          }
        : {}),
    };
  }
  if (
    reference.locatorBindingId === null ||
    reference.locatorRepositoryId === null ||
    reference.locatorSnapshotId === null ||
    reference.locatorObjectName === null ||
    reference.locatorCiphertextHash === null ||
    reference.locatorCiphertextByteLength === null
  )
    workerProtocolError("scan_conflict");
  return {
    referenceId: reference.id,
    referenceFingerprint: reference.referenceFingerprint,
    locatorBindingId: reference.locatorBindingId,
    locatorRepositoryId: reference.locatorRepositoryId,
    locatorSnapshotId: reference.locatorSnapshotId,
    locatorObjectName: reference.locatorObjectName,
    locatorCiphertextHash: reference.locatorCiphertextHash,
    locatorCiphertextByteLength: reference.locatorCiphertextByteLength,
    forgetEpoch,
    ...(summary
      ? {
          ack: summary as Exclude<
            WorkerProviderOriginalDetachAckSummary,
            { referenceVersion: "provider_original_v2" }
          >,
        }
      : {}),
  };
}

export async function getProviderOriginalForgetTargets(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<
    WorkerRequest,
    { operation: "providerOriginal.forgetTargets" }
  >,
): Promise<WorkerProviderOriginalForgetTargetsResult> {
  const { source, item } = await requireForgettingItem(ctx, principal, request);
  const cursor = decodeCursor(request.paginationOpts.cursor);
  const tail = keysetTail(cursor, 2);
  const fetched = await rows<Record<string, unknown>>(
    ctx,
    `SELECT *, created_at::text AS cursor_created_at
     FROM kith.source_provider_original_references
     WHERE source_item_id = $1 ${tail.sql}`,
    [item.id, ...tail.values, request.paginationOpts.numItems + 1],
  );
  const page = keysetPage(
    fetched.map((raw) => ({
      createdAt: String(raw.cursor_created_at),
      id: String(raw.id),
      value: camelizeSourceProviderOriginalReference(raw),
    })),
    request.paginationOpts.numItems,
  );
  const targets: WorkerProviderOriginalForgetTarget[] = [];
  for (const wrapped of page.page) {
    const reference = wrapped.value;
    await requireProviderOriginalReferenceChain(ctx, source, item, reference);
    const ackRows = (
      await rows<Record<string, unknown>>(
        ctx,
        `SELECT * FROM kith.source_provider_original_detach_acks
         WHERE reference_id = $1 AND forget_epoch = $2 LIMIT 2`,
        [reference.id, request.expectedForgetEpoch],
      )
    ).map(camelizeSourceProviderOriginalDetachAck);
    if (ackRows.length > 1) workerProtocolError("scan_conflict");
    targets.push(
      target(reference, request.expectedForgetEpoch, ackRows[0] ?? null),
    );
  }
  return {
    operation: "providerOriginal.forgetTargets",
    sourceItemId: item.id,
    sourceExternalIdHash: item.externalIdHash,
    forgetEpoch: request.expectedForgetEpoch,
    targets,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

async function requestDigest(
  request: Extract<WorkerRequest, { operation: "providerOriginal.ackDetach" }>,
): Promise<string> {
  if (request.referenceVersion === "provider_original_v2") {
    return sha256Hex(
      `provider-original-detach-ack:v2\0${JSON.stringify([
        request.spaceId,
        request.sourceAccountId,
        request.requestId,
        request.sourceItemId,
        request.expectedForgetEpoch,
        request.detachId,
        request.referenceId,
        request.referenceOutcome,
        request.providerSourceOutcome,
      ])}`,
    );
  }
  return sha256Hex(
    `provider-original-detach-ack:v1\0${JSON.stringify([
      request.spaceId,
      request.sourceAccountId,
      request.requestId,
      request.sourceItemId,
      request.expectedForgetEpoch,
      request.detachId,
      request.referenceId,
      request.locatorBindingId,
      request.locatorRepositoryId,
      request.locatorSnapshotId,
      request.locatorObjectName,
      request.referenceOutcome,
      request.locatorBundleOutcome,
      request.locatorAbsenceAuthority,
      request.retentionDisclosure,
      request.providerSourceOutcome,
    ])}`,
  );
}

function sameAck(
  ack: SourceProviderOriginalDetachAckRow,
  request: Extract<WorkerRequest, { operation: "providerOriginal.ackDetach" }>,
  source: LoadedWorkerSource,
  item: SourceItemRow,
  digest: string,
): boolean {
  const common =
    ack.spaceId === source.spaceId &&
    ack.sourceAccountId === source.account.id &&
    ack.sourceItemId === item.id &&
    ack.referenceId === request.referenceId &&
    ack.forgetEpoch === request.expectedForgetEpoch &&
    ack.detachId === request.detachId &&
    ack.requestId === request.requestId &&
    ack.requestDigest === digest &&
    ack.referenceOutcome === request.referenceOutcome &&
    ack.providerSourceOutcome === request.providerSourceOutcome &&
    ack.actorUserId === source.principal.userId &&
    ack.actorCredentialId === source.principal.credentialId;
  if (!common) return false;
  if (request.referenceVersion === "provider_original_v2")
    return (
      ack.ackVersion === "provider_original_detach_ack_v2" &&
      ack.locatorBindingId === null &&
      ack.locatorRepositoryId === null &&
      ack.locatorSnapshotId === null &&
      ack.locatorObjectName === null &&
      ack.locatorBundleOutcome === null &&
      ack.locatorAbsenceAuthority === null &&
      ack.retentionDisclosure === null
    );
  return (
    ack.ackVersion === "provider_original_detach_ack_v1" &&
    ack.locatorBindingId === request.locatorBindingId &&
    ack.locatorRepositoryId === request.locatorRepositoryId &&
    ack.locatorSnapshotId === request.locatorSnapshotId &&
    ack.locatorObjectName === request.locatorObjectName &&
    ack.locatorBundleOutcome === request.locatorBundleOutcome &&
    ack.locatorAbsenceAuthority === request.locatorAbsenceAuthority &&
    ack.retentionDisclosure === request.retentionDisclosure
  );
}

export async function acknowledgeProviderOriginalDetach(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "providerOriginal.ackDetach" }>,
): Promise<WorkerProviderOriginalAckDetachResult> {
  const { source, item } = await requireForgettingItem(ctx, principal, request);
  if (!UUID.test(request.detachId) || !KITH_ID.test(request.referenceId))
    workerProtocolError("invalid_request");
  const digest = await requestDigest(request);
  const byDetach = await rows<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_provider_original_detach_acks WHERE source_account_id=$1 AND detach_id=$2 LIMIT 2 FOR UPDATE",
    [source.account.id, request.detachId],
  );
  const byRequest = await rows<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_provider_original_detach_acks WHERE source_account_id=$1 AND request_id=$2 LIMIT 2 FOR UPDATE",
    [source.account.id, request.requestId],
  );
  const byReference = await rows<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_provider_original_detach_acks WHERE reference_id=$1 AND forget_epoch=$2 LIMIT 2 FOR UPDATE",
    [request.referenceId, request.expectedForgetEpoch],
  );
  if ([byDetach, byRequest, byReference].some((found) => found.length > 1))
    workerProtocolError("scan_conflict");
  const found = [byDetach[0], byRequest[0], byReference[0]]
    .filter((value): value is Record<string, unknown> => Boolean(value))
    .map(camelizeSourceProviderOriginalDetachAck);
  if (found.length) {
    if (
      new Set(found.map((ack) => ack.id)).size !== 1 ||
      !sameAck(found[0]!, request, source, item, digest)
    )
      workerProtocolError("request_conflict");
    return {
      operation: "providerOriginal.ackDetach",
      ...ackSummary(found[0]!),
      reused: true,
    };
  }
  const referenceRaw = await row<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.source_provider_original_references
     WHERE id = $1 FOR UPDATE`,
    [request.referenceId],
  );
  const reference = referenceRaw
    ? camelizeSourceProviderOriginalReference(referenceRaw)
    : null;
  if (
    !reference ||
    reference.spaceId !== source.spaceId ||
    reference.sourceAccountId !== source.account.id ||
    reference.sourceItemId !== item.id ||
    reference.referenceVersion !==
      (request.referenceVersion ?? "provider_original_v1") ||
    (request.referenceVersion === "provider_original_v2"
      ? reference.locatorBindingId !== null ||
        reference.locatorRepositoryId !== null ||
        reference.locatorSnapshotId !== null ||
        reference.locatorObjectName !== null
      : reference.locatorBindingId !== request.locatorBindingId ||
        reference.locatorRepositoryId !== request.locatorRepositoryId ||
        reference.locatorSnapshotId !== request.locatorSnapshotId ||
        reference.locatorObjectName !== request.locatorObjectName)
  )
    workerProtocolError("stale_observation");
  await requireProviderOriginalReferenceChain(ctx, source, item, reference);
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.source_provider_original_detach_acks
     (id, space_id, created_at, ack_version, source_account_id, source_item_id,
      source_revision_id, reference_id, forget_epoch, detach_id, request_id,
      request_digest, reference_fingerprint, locator_binding_id,
      locator_repository_id, locator_snapshot_id, locator_object_name,
      reference_outcome, locator_bundle_outcome, locator_absence_authority,
      retention_disclosure, provider_source_outcome, actor_user_id,
      actor_credential_id, completed_at)
     VALUES ($1,$2,transaction_timestamp(),$3,
      $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
      $22,$23,$24)`,
    [
      id,
      source.spaceId,
      request.referenceVersion === "provider_original_v2"
        ? "provider_original_detach_ack_v2"
        : "provider_original_detach_ack_v1",
      source.account.id,
      item.id,
      reference.sourceRevisionId,
      reference.id,
      request.expectedForgetEpoch,
      request.detachId,
      request.requestId,
      digest,
      reference.referenceFingerprint,
      request.referenceVersion === "provider_original_v2"
        ? null
        : reference.locatorBindingId,
      request.referenceVersion === "provider_original_v2"
        ? null
        : reference.locatorRepositoryId,
      request.referenceVersion === "provider_original_v2"
        ? null
        : reference.locatorSnapshotId,
      request.referenceVersion === "provider_original_v2"
        ? null
        : reference.locatorObjectName,
      request.referenceOutcome,
      request.referenceVersion === "provider_original_v2"
        ? null
        : request.locatorBundleOutcome,
      request.referenceVersion === "provider_original_v2"
        ? null
        : request.locatorAbsenceAuthority,
      request.referenceVersion === "provider_original_v2"
        ? null
        : request.retentionDisclosure,
      request.providerSourceOutcome,
      source.principal.userId,
      source.principal.credentialId,
      at(ctx.now),
    ],
  );
  const ackRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_provider_original_detach_acks WHERE id = $1",
    [id],
  );
  if (!ackRaw) workerProtocolError("scan_conflict");
  return {
    operation: "providerOriginal.ackDetach",
    ...ackSummary(camelizeSourceProviderOriginalDetachAck(ackRaw)),
    reused: false,
  };
}
