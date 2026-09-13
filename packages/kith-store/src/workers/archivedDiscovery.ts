import {
  BINARY_CLASSES,
  isBinaryClass,
  type ArchivedWorkIdentity,
  type BinaryParserProfileId,
} from "@repo/worker-protocol";
import type {
  WorkerArchivedFailResult,
  WorkerArchivedPreflightResult,
  WorkerArchivedReserveResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import { markInventoryParseFailed } from "../documents/inventory.js";
import { newKithId, KITH_ID } from "../ids.js";
import { requireWorkerSourceAccount, type LoadedWorkerSource } from "./auth.js";
import { at, digest, exec, nowPlus, rows, type WorkerCtx } from "./db.js";
import {
  MAX_WORKER_DISCOVERY_ATTEMPTS,
  requireCurrentDiscovery,
  WORKER_DISCOVERY_LEASE_MS,
  WORKER_OPERATION_RECEIPT_MS,
  type CurrentDiscovery,
} from "./discovery.js";
import { workerProtocolError } from "./errors.js";
import { accountBinaryClasses, accountBinaryLaneEnabled } from "./profile.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import {
  camelizeDiscoveryWork,
  camelizeReservationReceipt,
  camelizeReservationTarget,
} from "./rows.js";

export function requireBinaryGate(source: LoadedWorkerSource): void {
  if (
    accountBinaryClasses(source.account).length === 0 ||
    !accountBinaryLaneEnabled(source.account)
  ) {
    workerProtocolError("source_unavailable");
  }
}

export function requireWorkBinaryClass(
  work: CurrentDiscovery["work"],
): (typeof BINARY_CLASSES)[BinaryParserProfileId] {
  if (!isBinaryClass(work.profileId, work.mediaType))
    workerProtocolError("stale_observation");
  return BINARY_CLASSES[work.profileId];
}

export function requireStoredBinaryWork(current: CurrentDiscovery): void {
  const { work, item, scan, entry } = current;
  const fingerprints = [
    work.parserFingerprint,
    work.extractionConfigurationFingerprint,
    work.extractorFingerprint,
    work.recordSchemaFingerprint,
    work.normalizationFingerprint,
    work.chunkerFingerprint,
    work.correctionRevision,
  ];
  if (
    work.contentRepresentation !== "archived_binary_v1" ||
    item.id !== work.sourceItemId ||
    scan.id !== work.scanId ||
    !isBinaryClass(work.profileId, work.mediaType) ||
    work.extractionFingerprint !== "artifact-bound-extraction:v1" ||
    entry.contentRepresentation !== "archived_binary_v1" ||
    !isBinaryClass(entry.binaryParserProfileId, entry.binaryMediaType) ||
    entry.binaryParserProfileId !== work.profileId ||
    !/^[0-9a-f]{64}$/.test(work.contentHash) ||
    !/^[0-9a-f]{64}$/.test(work.parserFingerprint ?? "") ||
    !/^[0-9a-f]{64}$/.test(work.extractionConfigurationFingerprint ?? "") ||
    !Number.isSafeInteger(work.byteLength) ||
    work.byteLength < 1 ||
    work.byteLength > 16 * 1_024 * 1_024 ||
    fingerprints.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        Buffer.byteLength(value, "utf8") > 1_024,
    )
  )
    workerProtocolError("stale_observation");
}

function requireIdentity(
  current: CurrentDiscovery,
  identity: ArchivedWorkIdentity,
): void {
  requireStoredBinaryWork(current);
  const { work, item, scan } = current;
  if (
    item.id !== identity.sourceItemId ||
    scan.id !== identity.scanId ||
    work.observationEpoch !== identity.observationEpoch ||
    work.processingEpoch !== identity.processingEpoch ||
    work.contentHash !== identity.contentHash ||
    work.byteLength !== identity.byteLength ||
    work.mediaType !== identity.mediaType ||
    work.profileId !== identity.parserProfileId ||
    work.parserFingerprint !== identity.parserFingerprint ||
    work.extractionConfigurationFingerprint !==
      identity.extractionConfigurationFingerprint ||
    work.extractorFingerprint !== identity.extractorFingerprint ||
    work.recordSchemaFingerprint !== identity.recordSchemaFingerprint ||
    work.normalizationFingerprint !== identity.normalizationFingerprint ||
    work.chunkerFingerprint !== identity.chunkerFingerprint ||
    work.correctionRevision !== identity.correctionRevision
  )
    workerProtocolError("stale_observation");
}

async function resolveCurrentArchivedWork(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  identity: ArchivedWorkIdentity,
): Promise<CurrentDiscovery> {
  if (!KITH_ID.test(identity.sourceItemId))
    workerProtocolError("invalid_request");
  const matches = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_discovery_work WHERE source_item_id = $1 AND observation_epoch = $2
        ORDER BY created_at, id LIMIT 2 FOR UPDATE`,
      [identity.sourceItemId, identity.observationEpoch],
    )
  ).map(camelizeDiscoveryWork);
  if (matches.length !== 1) workerProtocolError("stale_observation");
  const current = await requireCurrentDiscovery(ctx, source, matches[0]!.id);
  requireIdentity(current, identity);
  return current;
}

export async function preflightArchivedDiscovery(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.preflightArchived" }>,
): Promise<WorkerArchivedPreflightResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const current = await resolveCurrentArchivedWork(
    ctx,
    source,
    request.identity,
  );
  if (
    (current.work.state !== "queued" &&
      !(current.work.state === "failed" && current.work.retryable === true)) ||
    current.work.leaseToken !== null ||
    current.work.leaseExpiresAt !== null ||
    current.work.leaseOwnerCredentialId !== null ||
    !Number.isSafeInteger(current.work.attempts) ||
    current.work.attempts < 0 ||
    current.work.attempts >= MAX_WORKER_DISCOVERY_ATTEMPTS ||
    (current.work.nextAttemptAt !== null &&
      current.work.nextAttemptAt.getTime() > ctx.now)
  )
    workerProtocolError("stale_observation");
  if (current.work.expectedDesiredProcessingEpoch === null)
    workerProtocolError("scan_conflict");
  return {
    operation: "discovery.preflightArchived",
    sourceItemId: current.item.id,
    workId: current.work.id,
    expectedDesiredProcessingEpoch: current.work.expectedDesiredProcessingEpoch,
    archiveIntentDigest: request.archiveIntentDigest,
  };
}

export async function failArchivedDiscovery(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.failArchived" }>,
): Promise<WorkerArchivedFailResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const current = await resolveCurrentArchivedWork(
    ctx,
    source,
    request.identity,
  );
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const attempts = current.work.attempts + 1;
  if (!Number.isSafeInteger(attempts)) workerProtocolError("scan_conflict");
  const retryable =
    request.exhausted !== true && attempts < MAX_WORKER_DISCOVERY_ATTEMPTS;
  await exec(
    ctx,
    `UPDATE kith.worker_discovery_work SET state = 'failed', attempts = $1,
    failure_code = $2, retryable = $3, lease_token = NULL, lease_owner_credential_id = NULL,
    lease_expires_at = NULL, next_attempt_at = $4 WHERE id = $5`,
    [
      attempts,
      request.failureCode,
      retryable,
      retryable ? at(ctx.now) : null,
      current.work.id,
    ],
  );
  await markInventoryParseFailed(ctx.client, {
    sourceItemId: current.item.id,
    failureClass: request.failureCode,
  });
  return {
    operation: "discovery.failArchived",
    sourceItemId: current.item.id,
    workId: current.work.id,
    state: "failed",
    retryable,
    failureCode: request.failureCode,
  };
}

export async function reserveArchivedDiscovery(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.reserveArchived" }>,
  leaseToken: string,
): Promise<WorkerArchivedReserveResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  if (!/^[0-9a-f]{64}$/.test(leaseToken))
    workerProtocolError("invalid_request");
  const requestDigest = await digest("worker-archived-reserve:v1", [
    source.account.id,
    request.requestId,
    request.identity,
  ]);
  const receipts = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_reservation_receipts
      WHERE source_account_id = $1 AND kind = 'archived_discovery' AND request_id = $2
      ORDER BY created_at, id LIMIT 2`,
      [source.account.id, request.requestId],
    )
  ).map(camelizeReservationReceipt);
  if (receipts.length > 1) workerProtocolError("scan_conflict");
  if (receipts[0]) {
    const receipt = receipts[0];
    if (
      receipt.spaceId !== source.spaceId ||
      receipt.actorUserId !== source.principal.userId ||
      receipt.actorCredentialId !== source.principal.credentialId
    )
      workerProtocolError("not_found");
    if (receipt.requestDigest !== requestDigest)
      workerProtocolError("request_conflict");
    if (receipt.targetCount !== 1 || receipt.expiresAt.getTime() <= ctx.now)
      workerProtocolError("reservation_expired");
    const targets = (
      await rows<Record<string, unknown>>(
        ctx,
        "SELECT * FROM kith.worker_reservation_targets WHERE receipt_id = $1 ORDER BY ordinal LIMIT 2",
        [receipt.id],
      )
    ).map(camelizeReservationTarget);
    const target = targets[0];
    if (
      targets.length !== 1 ||
      !target ||
      target.spaceId !== source.spaceId ||
      target.sourceAccountId !== source.account.id ||
      target.discoveryWorkId === null
    )
      workerProtocolError("scan_conflict");
    const current = await resolveCurrentArchivedWork(
      ctx,
      source,
      request.identity,
    );
    if (
      current.work.id !== target.discoveryWorkId ||
      current.work.state !== "leased" ||
      current.work.leaseEpoch !== target.leaseEpoch ||
      current.work.leaseToken !== target.leaseToken ||
      current.work.leaseExpiresAt?.getTime() !==
        target.leaseExpiresAt.getTime() ||
      current.work.leaseOwnerCredentialId !== source.principal.credentialId
    )
      workerProtocolError("lease_conflict");
    return {
      operation: "discovery.reserveArchived",
      workId: current.work.id,
      sourceItemId: current.item.id,
      observationEpoch: current.work.observationEpoch,
      processingEpoch: current.work.processingEpoch,
      leaseEpoch: target.leaseEpoch,
      leaseToken: target.leaseToken,
      leaseExpiresAt: target.leaseExpiresAt.getTime(),
      reused: true,
    };
  }
  const current = await resolveCurrentArchivedWork(
    ctx,
    source,
    request.identity,
  );
  const work = current.work;
  const claimable =
    ((work.state === "queued" ||
      (work.state === "failed" && work.retryable === true)) &&
      work.leaseToken === null &&
      work.leaseExpiresAt === null &&
      work.leaseOwnerCredentialId === null &&
      (work.nextAttemptAt === null ||
        work.nextAttemptAt.getTime() <= ctx.now)) ||
    (work.state === "leased" &&
      work.leaseToken !== null &&
      work.leaseExpiresAt !== null &&
      work.leaseOwnerCredentialId !== null &&
      work.leaseExpiresAt.getTime() <= ctx.now);
  if (
    !claimable ||
    work.leaseEpoch < 0 ||
    work.attempts < 0 ||
    work.attempts >= MAX_WORKER_DISCOVERY_ATTEMPTS
  )
    workerProtocolError("lease_conflict");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const leaseEpoch = work.leaseEpoch + 1;
  const attempts = work.attempts + 1;
  if (!Number.isSafeInteger(leaseEpoch) || !Number.isSafeInteger(attempts))
    workerProtocolError("scan_conflict");
  const leaseExpiresAt = nowPlus(ctx.now, WORKER_DISCOVERY_LEASE_MS);
  await exec(
    ctx,
    `UPDATE kith.worker_discovery_work SET state = 'leased', attempts = $1,
    lease_epoch = $2, lease_token = $3, lease_owner_credential_id = $4, lease_expires_at = $5,
    next_attempt_at = NULL WHERE id = $6`,
    [
      attempts,
      leaseEpoch,
      leaseToken,
      source.principal.credentialId,
      at(leaseExpiresAt),
      work.id,
    ],
  );
  const receiptId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_reservation_receipts
    (id, space_id, created_at, source_account_id, kind, request_id, request_digest,
     actor_user_id, actor_credential_id, target_count, created_at_field, expires_at, retire_at)
    VALUES ($1,$2,transaction_timestamp(),$3,'archived_discovery',$4,$5,$6,$7,1,$8,$9,$10)`,
    [
      receiptId,
      source.spaceId,
      source.account.id,
      request.requestId,
      requestDigest,
      source.principal.userId,
      source.principal.credentialId,
      at(ctx.now),
      at(leaseExpiresAt),
      at(nowPlus(ctx.now, WORKER_OPERATION_RECEIPT_MS)),
    ],
  );
  await exec(
    ctx,
    `INSERT INTO kith.worker_reservation_targets
    (id, space_id, created_at, source_account_id, source_item_id, receipt_id, ordinal,
     discovery_work_id, lease_epoch, lease_token, lease_expires_at)
    VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,0,$6,$7,$8,$9)`,
    [
      newKithId(),
      source.spaceId,
      source.account.id,
      work.sourceItemId,
      receiptId,
      work.id,
      leaseEpoch,
      leaseToken,
      at(leaseExpiresAt),
    ],
  );
  return {
    operation: "discovery.reserveArchived",
    workId: work.id,
    sourceItemId: work.sourceItemId,
    observationEpoch: work.observationEpoch,
    processingEpoch: work.processingEpoch,
    leaseEpoch,
    leaseToken,
    leaseExpiresAt,
    reused: false,
  };
}
