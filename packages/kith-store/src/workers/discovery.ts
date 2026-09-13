import { isBinaryClass } from "@repo/worker-protocol";
import type {
  WorkerDiscoveryAdmitResult,
  WorkerDiscoveryReserveResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import {
  digestDecodedAdmissionEnvelope,
  digestProcessingConfiguration,
  planInlineText,
  sha256Hex,
} from "../ingestion/inline.js";
import { newKithId, KITH_ID } from "../ids.js";
import {
  createOrGetRevision,
  refreshAvailableSourceItem,
  setDesiredSourceRevision,
} from "../provenance/model.js";
import {
  camelizeProcessingGeneration,
  camelizeSourceItem,
  camelizeSourceRevision,
  type ProcessingGenerationRow,
  type SourceItemRow,
  type SourceRevisionRow,
} from "../provenance/rows.js";
import { requireInlineSourceRevision } from "../provenance/representations.js";
import {
  requireOriginalActor,
  requireWorkerSourceAccount,
  type LoadedWorkerSource,
} from "./auth.js";
import { at, digest, exec, nowPlus, row, rows, type WorkerCtx } from "./db.js";
import { workerProtocolError, workerProtocolErrorCode } from "./errors.js";
import { accountAdmitsBinaryEntry, FS_TEXT_PROFILE } from "./profile.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import {
  camelizeDiscoveryWork,
  camelizeIngestJob,
  camelizeIngestRequest,
  camelizeReservationReceipt,
  camelizeReservationTarget,
  camelizeScan,
  camelizeScanEntry,
  camelizeScanPage,
  type IngestJobRow,
  type IngestRequestRow,
  type WorkerDiscoveryWorkRow,
  type WorkerReservationReceiptRow,
  type WorkerScanEntryRow,
  type WorkerScanPageRow,
  type WorkerSourceScanRow,
} from "./rows.js";

export const WORKER_DISCOVERY_LEASE_MS = 5 * 60 * 1_000;
export const WORKER_RESERVATION_RECEIPT_MS = WORKER_DISCOVERY_LEASE_MS;
export const WORKER_OPERATION_RECEIPT_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_WORKER_DISCOVERY_ATTEMPTS = 8;

export type CurrentDiscovery = {
  source: LoadedWorkerSource;
  item: SourceItemRow;
  scan: WorkerSourceScanRow;
  entry: WorkerScanEntryRow;
  page: WorkerScanPageRow;
  work: WorkerDiscoveryWorkRow;
};

async function loadDiscoveryChain(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  workId: string,
): Promise<CurrentDiscovery> {
  if (!KITH_ID.test(workId)) workerProtocolError("invalid_request");
  const rawWork = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_discovery_work WHERE id = $1",
    [workId],
  );
  if (!rawWork) workerProtocolError("not_found");
  const work = camelizeDiscoveryWork(rawWork);
  if (work.spaceId !== source.spaceId || work.sourceAccountId !== source.account.id) {
    workerProtocolError("not_found");
  }
  // One checked-out pg client executes one statement at a time. Keeping these
  // reads sequential also makes the chain validation order deterministic.
  const rawItem = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_items WHERE id = $1",
    [work.sourceItemId],
  );
  const rawScan = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_source_scans WHERE id = $1",
    [work.scanId],
  );
  const rawEntry = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_scan_entries WHERE id = $1",
    [work.scanEntryId],
  );
  const rawPage = rawEntry
    ? await row<Record<string, unknown>>(ctx, "SELECT * FROM kith.worker_scan_pages WHERE id = $1", [rawEntry.scan_page_id])
    : null;
  if (!rawItem || !rawScan || !rawEntry || !rawPage) workerProtocolError("scan_conflict");
  const item = camelizeSourceItem(rawItem);
  const scan = camelizeScan(rawScan);
  const entry = camelizeScanEntry(rawEntry);
  const page = camelizeScanPage(rawPage);
  if (
    item.spaceId !== source.spaceId || item.sourceAccountId !== source.account.id ||
    scan.spaceId !== source.spaceId || scan.sourceAccountId !== source.account.id ||
    entry.spaceId !== source.spaceId || entry.sourceAccountId !== source.account.id ||
    entry.scanId !== scan.id || entry.scanPageId !== page.id || entry.sourceItemId !== item.id ||
    entry.discoveryWorkId !== work.id || page.spaceId !== source.spaceId ||
    page.sourceAccountId !== source.account.id || page.scanId !== scan.id
  ) workerProtocolError("scan_conflict");
  return { source, item, scan, entry, page, work };
}

function validDate(value: Date | null): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

async function requireCurrentDiscoveryState(
  ctx: WorkerCtx,
  current: CurrentDiscovery,
): Promise<void> {
  const { source, item, scan, entry, work } = current;
  await requireOriginalActor(ctx, source, work);
  await requireOriginalActor(ctx, source, scan);
  const binary = work.contentRepresentation === "archived_binary_v1";
  const profileValid = binary
    ? accountAdmitsBinaryEntry(source.account, entry.binaryParserProfileId) &&
      entry.contentRepresentation === "archived_binary_v1" &&
      isBinaryClass(entry.binaryParserProfileId, entry.binaryMediaType) &&
      entry.binaryParserProfileId === work.profileId &&
      entry.binaryMediaType === work.mediaType &&
      entry.parserFingerprint === work.parserFingerprint &&
      entry.extractionConfigurationFingerprint === work.extractionConfigurationFingerprint &&
      entry.extractorFingerprint === work.extractorFingerprint &&
      entry.recordSchemaFingerprint === work.recordSchemaFingerprint &&
      entry.normalizationFingerprint === work.normalizationFingerprint &&
      entry.chunkerFingerprint === work.chunkerFingerprint &&
      entry.correctionRevision === work.correctionRevision &&
      isBinaryClass(work.profileId, work.mediaType) &&
      typeof work.parserFingerprint === "string" &&
      typeof work.extractionConfigurationFingerprint === "string" &&
      typeof work.correctionRevision === "string"
    : (work.contentRepresentation === null || work.contentRepresentation === "inline_utf8_v1") &&
      (entry.contentRepresentation === null || entry.contentRepresentation === "inline_utf8_v1") &&
      work.mediaType === FS_TEXT_PROFILE.mediaType &&
      work.profileId === FS_TEXT_PROFILE.profileId &&
      work.extractionFingerprint === FS_TEXT_PROFILE.extractionFingerprint &&
      work.extractorFingerprint === FS_TEXT_PROFILE.extractorFingerprint &&
      work.recordSchemaFingerprint === FS_TEXT_PROFILE.recordSchemaFingerprint &&
      work.normalizationFingerprint === FS_TEXT_PROFILE.normalizationFingerprint &&
      work.chunkerFingerprint === FS_TEXT_PROFILE.chunkerFingerprint;
  if (
    item.lifecycle !== "available" || scan.state !== "enumerated" || !validDate(scan.completedAt) ||
    scan.inventoryEpoch !== (source.account.inventoryEpoch ?? 0) ||
    scan.inventoryEpoch !== (source.account.completedInventoryEpoch ?? 0) ||
    scan.reconcileManifestVersion !== (source.account.manifestVersion ?? 0) ||
    entry.state !== "queued" || item.workerLastSeenInventoryEpoch !== scan.inventoryEpoch ||
    item.workerObservationEpoch !== work.observationEpoch || item.workerProcessingEpoch !== work.processingEpoch ||
    entry.observationEpoch !== work.observationEpoch || entry.processingEpoch !== work.processingEpoch ||
    entry.contentHash !== work.contentHash || entry.byteLength !== work.byteLength ||
    entry.processingIdentityDigest !== item.workerProcessingIdentityDigest ||
    item.workerContentHash !== work.contentHash || item.workerProfileId !== work.profileId ||
    work.expectedDesiredProcessingEpoch === null ||
    item.desiredProcessingEpoch !== work.expectedDesiredProcessingEpoch + (work.state === "admitted" ? 1 : 0) ||
    !profileValid || !Number.isSafeInteger(work.observationEpoch) ||
    !Number.isSafeInteger(work.processingEpoch) || !Number.isSafeInteger(work.expectedDesiredProcessingEpoch) ||
    work.expectedDesiredProcessingEpoch >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(work.byteLength) ||
    !validDate(work.capturedAt) || !validDate(work.sourceModifiedAt) || !Number.isSafeInteger(work.attempts) ||
    !Number.isSafeInteger(work.leaseEpoch)
  ) workerProtocolError("stale_observation");
}

export async function requireCurrentDiscovery(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  workId: string,
): Promise<CurrentDiscovery> {
  const current = await loadDiscoveryChain(ctx, source, workId);
  await requireCurrentDiscoveryState(ctx, current);
  return current;
}

export async function requireDiscoveryLease(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  workId: string,
  leaseEpoch: number,
  leaseToken: string,
): Promise<CurrentDiscovery> {
  const current = await requireCurrentDiscovery(ctx, source, workId);
  if (
    current.work.state !== "leased" ||
    current.work.leaseOwnerCredentialId !== source.principal.credentialId ||
    current.work.leaseEpoch !== leaseEpoch || current.work.leaseToken !== leaseToken ||
    !validDate(current.work.leaseExpiresAt) || current.work.leaseExpiresAt.getTime() <= ctx.now
  ) workerProtocolError("lease_conflict");
  return current;
}

function reserveTarget(work: WorkerDiscoveryWorkRow): WorkerDiscoveryReserveResult["targets"][number] {
  if (work.contentRepresentation === "archived_binary_v1" || !work.leaseToken || !validDate(work.leaseExpiresAt)) {
    workerProtocolError("scan_conflict");
  }
  return {
    workId: work.id,
    sourceItemId: work.sourceItemId,
    observationEpoch: work.observationEpoch,
    processingEpoch: work.processingEpoch,
    leaseEpoch: work.leaseEpoch,
    leaseToken: work.leaseToken,
    leaseExpiresAt: work.leaseExpiresAt.getTime(),
    uri: work.uri,
    contentHash: work.contentHash,
    byteLength: work.byteLength,
  };
}

async function replayReservation(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  receipt: WorkerReservationReceiptRow,
): Promise<WorkerDiscoveryReserveResult> {
  if (
    receipt.spaceId !== source.spaceId || receipt.sourceAccountId !== source.account.id ||
    receipt.actorUserId !== source.principal.userId || receipt.actorCredentialId !== source.principal.credentialId ||
    !Number.isSafeInteger(receipt.targetCount) || receipt.targetCount < 0 || receipt.targetCount > 4
  ) workerProtocolError("not_found");
  if (receipt.invalidatedAt !== null || receipt.expiresAt.getTime() <= ctx.now || receipt.retireAt.getTime() <= ctx.now) {
    workerProtocolError("reservation_expired");
  }
  const targets = (
    await rows<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.worker_reservation_targets WHERE receipt_id = $1 ORDER BY ordinal LIMIT 5",
      [receipt.id],
    )
  ).map(camelizeReservationTarget);
  if (targets.length !== receipt.targetCount) workerProtocolError("reservation_expired");
  const result: WorkerDiscoveryReserveResult["targets"] = [];
  for (let ordinal = 0; ordinal < targets.length; ordinal += 1) {
    const target = targets[ordinal]!;
    if (
      target.ordinal !== ordinal || target.spaceId !== source.spaceId ||
      target.sourceAccountId !== source.account.id || target.discoveryWorkId === null ||
      target.ingestJobId !== null || target.leaseExpiresAt.getTime() !== receipt.expiresAt.getTime() ||
      target.leaseExpiresAt.getTime() <= ctx.now
    ) workerProtocolError("reservation_expired");
    const current = await requireCurrentDiscovery(ctx, source, target.discoveryWorkId);
    if (
      current.item.id !== target.sourceItemId || current.work.state !== "leased" ||
      current.work.leaseOwnerCredentialId !== source.principal.credentialId ||
      current.work.leaseEpoch !== target.leaseEpoch || current.work.leaseToken !== target.leaseToken ||
      current.work.leaseExpiresAt?.getTime() !== target.leaseExpiresAt.getTime()
    ) workerProtocolError("reservation_expired");
    result.push(reserveTarget(current.work));
  }
  return { operation: "discovery.reserve", receiptId: receipt.id, expiresAt: receipt.expiresAt.getTime(), reused: true, targets: result };
}

export async function reserveDiscoveryWork(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.reserve" }>,
  tokens: string[],
): Promise<WorkerDiscoveryReserveResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  if (tokens.length < request.maxItems || tokens.slice(0, request.maxItems).some((token) => !/^[0-9a-f]{64}$/.test(token))) {
    workerProtocolError("invalid_request");
  }
  const requestDigest = await digest("worker-discovery-reserve:v1", [source.account.id, request.requestId, request.maxItems]);
  const receipts = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_reservation_receipts
        WHERE source_account_id = $1 AND kind = 'discovery' AND request_id = $2
        ORDER BY created_at, id LIMIT 2`,
      [source.account.id, request.requestId],
    )
  ).map(camelizeReservationReceipt);
  if (receipts.length > 1) workerProtocolError("scan_conflict");
  if (receipts[0]) {
    if (receipts[0].requestDigest !== requestDigest) workerProtocolError("request_conflict");
    return replayReservation(ctx, source, receipts[0]);
  }
  if ((source.account.inventoryEpoch ?? 0) !== (source.account.completedInventoryEpoch ?? 0)) workerProtocolError("scan_not_ready");
  await consumeWorkerMutationRateLimit(ctx, source.principal.credentialId, source.account.id);

  const candidates = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_discovery_work
        WHERE source_account_id = $1
          AND (content_representation IS NULL OR content_representation = 'inline_utf8_v1')
          AND ((state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= $2))
            OR (state = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= $2)
            OR (state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $2))
        ORDER BY created_at_field, id
        FOR UPDATE SKIP LOCKED LIMIT 12`,
      [source.account.id, at(ctx.now)],
    )
  ).map(camelizeDiscoveryWork);
  const claimed: WorkerDiscoveryWorkRow[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= request.maxItems) break;
    if (candidate.spaceId !== source.spaceId || candidate.sourceAccountId !== source.account.id) workerProtocolError("scan_conflict");
    let current: CurrentDiscovery | undefined;
    try {
      current = await loadDiscoveryChain(ctx, source, candidate.id);
      await requireCurrentDiscoveryState(ctx, current);
      if (current.work.state !== candidate.state || current.work.leaseEpoch !== candidate.leaseEpoch || current.work.attempts !== candidate.attempts) workerProtocolError("scan_conflict");
      if (current.work.attempts >= MAX_WORKER_DISCOVERY_ATTEMPTS || (current.work.state === "failed" && current.work.retryable !== true)) {
        await exec(ctx, `UPDATE kith.worker_discovery_work SET state = 'needs_review', lease_token = NULL,
          lease_owner_credential_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL WHERE id = $1`, [current.work.id]);
        continue;
      }
      const leaseEpoch = current.work.leaseEpoch + 1;
      if (!Number.isSafeInteger(leaseEpoch)) workerProtocolError("scan_conflict");
      const leaseExpiresAt = nowPlus(ctx.now, WORKER_DISCOVERY_LEASE_MS);
      const updated = await row<Record<string, unknown>>(
        ctx,
        `UPDATE kith.worker_discovery_work SET state = 'leased', attempts = attempts + 1,
          lease_epoch = $1, lease_token = $2, lease_owner_credential_id = $3,
          lease_expires_at = $4, next_attempt_at = NULL WHERE id = $5 RETURNING *`,
        [leaseEpoch, tokens[claimed.length]!, source.principal.credentialId, at(leaseExpiresAt), current.work.id],
      );
      if (!updated) workerProtocolError("scan_conflict");
      claimed.push(camelizeDiscoveryWork(updated));
    } catch (error) {
      const code = workerProtocolErrorCode(error);
      if (!["not_authorized", "not_found", "scan_conflict", "stale_observation", "source_unavailable"].includes(code ?? "")) throw error;
      if (!current) throw error;
      await exec(ctx, `UPDATE kith.worker_discovery_work SET state = 'needs_review', lease_token = NULL,
        lease_owner_credential_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL WHERE id = $1`, [current.work.id]);
    }
  }
  const expiresAt = nowPlus(ctx.now, WORKER_RESERVATION_RECEIPT_MS);
  const receiptId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_reservation_receipts
       (id, space_id, created_at, source_account_id, kind, request_id, request_digest,
        actor_user_id, actor_credential_id, target_count, created_at_field, expires_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,'discovery',$4,$5,$6,$7,$8,$9,$10,$11)`,
    [receiptId, source.spaceId, source.account.id, request.requestId, requestDigest, source.principal.userId, source.principal.credentialId, claimed.length, at(ctx.now), at(expiresAt), at(nowPlus(ctx.now, WORKER_OPERATION_RECEIPT_MS))],
  );
  for (let ordinal = 0; ordinal < claimed.length; ordinal += 1) {
    const work = claimed[ordinal]!;
    if (!work.leaseToken || !validDate(work.leaseExpiresAt)) workerProtocolError("scan_conflict");
    await exec(
      ctx,
      `INSERT INTO kith.worker_reservation_targets
       (id, space_id, created_at, source_account_id, source_item_id, receipt_id,
        ordinal, discovery_work_id, lease_epoch, lease_token, lease_expires_at)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10)`,
      [newKithId(), source.spaceId, source.account.id, work.sourceItemId, receiptId, ordinal, work.id, work.leaseEpoch, work.leaseToken, work.leaseExpiresAt],
    );
  }
  return { operation: "discovery.reserve", receiptId, expiresAt, reused: false, targets: claimed.map(reserveTarget) };
}

async function loadJob(ctx: WorkerCtx, id: string): Promise<IngestJobRow | null> {
  const found = await row<Record<string, unknown>>(ctx, "SELECT * FROM kith.ingest_jobs WHERE id = $1", [id]);
  return found ? camelizeIngestJob(found) : null;
}

async function validateAdmittedChain(
  ctx: WorkerCtx,
  current: CurrentDiscovery,
  ids: { sourceRevisionId: string; processingGenerationId: string; ingestJobId: string; desiredProcessingEpoch: number },
  requireWorkerBinding: boolean,
): Promise<void> {
  const rawItem = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_items WHERE id = $1",
    [current.item.id],
  );
  const rawRevision = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_revisions WHERE id = $1",
    [ids.sourceRevisionId],
  );
  const rawGeneration = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.processing_generations WHERE id = $1",
    [ids.processingGenerationId],
  );
  const job = await loadJob(ctx, ids.ingestJobId);
  if (!rawItem || !rawRevision || !rawGeneration || !job) workerProtocolError("scan_conflict");
  const item = camelizeSourceItem(rawItem);
  const revision = camelizeSourceRevision(rawRevision);
  const generation = camelizeProcessingGeneration(rawGeneration);
  let revisionText: string | undefined;
  try { revisionText = requireInlineSourceRevision(revision).text; } catch { revisionText = undefined; }
  const revisionTextHash = revisionText === undefined ? undefined : await sha256Hex(revisionText);
  const revisionBytes = revisionText === undefined ? undefined : Buffer.byteLength(revisionText, "utf8");
  if (
    item.spaceId !== current.source.spaceId || item.sourceAccountId !== current.source.account.id ||
    item.desiredRevisionId !== revision.id || item.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    revision.spaceId !== current.source.spaceId || revision.sourceItemId !== item.id ||
    revision.contentHash !== current.work.contentHash || revision.byteLength !== current.work.byteLength ||
    revisionTextHash !== revision.contentHash || revisionBytes !== revision.byteLength || revision.mediaType !== current.work.mediaType ||
    generation.spaceId !== current.source.spaceId || generation.sourceAccountId !== current.source.account.id ||
    generation.sourceItemId !== item.id || generation.sourceRevisionId !== revision.id ||
    generation.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    generation.extractionFingerprint !== current.work.extractionFingerprint ||
    generation.extractorFingerprint !== current.work.extractorFingerprint ||
    generation.recordSchemaFingerprint !== current.work.recordSchemaFingerprint ||
    generation.normalizationFingerprint !== current.work.normalizationFingerprint ||
    generation.chunkerFingerprint !== current.work.chunkerFingerprint ||
    generation.correctionRevision !== `filesystem-observation-v1:${current.work.processingEpoch}` ||
    job.spaceId !== current.source.spaceId || job.sourceAccountId !== current.source.account.id ||
    job.sourceItemId !== item.id || job.sourceRevisionId !== revision.id ||
    job.processingGenerationId !== generation.id || job.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    (requireWorkerBinding && (job.workerDiscoveryWorkId !== current.work.id || job.workerObservationEpoch !== current.work.observationEpoch)) ||
    job.state !== generation.state || job.actorUserId !== current.work.actorUserId ||
    job.actorCredentialId !== current.work.actorCredentialId || job.admittedByUserId !== current.work.actorUserId ||
    job.admittedByCredentialId !== current.work.actorCredentialId
  ) workerProtocolError("scan_conflict");
}

function admissionResult(
  work: WorkerDiscoveryWorkRow,
  ids: { sourceRevisionId: string; processingGenerationId: string; ingestJobId: string; desiredProcessingEpoch: number },
  reused: boolean,
): WorkerDiscoveryAdmitResult {
  return { operation: "discovery.admitUtf8", workId: work.id, sourceItemId: work.sourceItemId, ...ids, state: "admitted", reused };
}

async function createOrReuseInlineAdmission(
  ctx: WorkerCtx,
  current: CurrentDiscovery,
  text: string,
): Promise<{ sourceRevisionId: string; processingGenerationId: string; ingestJobId: string; desiredProcessingEpoch: number }> {
  const work = current.work;
  const expected = work.expectedDesiredProcessingEpoch;
  if (expected === null || !current.item.externalId) workerProtocolError("stale_observation");
  const plan = planInlineText(text);
  const correctionRevision = `filesystem-observation-v1:${work.processingEpoch}`;
  const requestId = `fs-admit:${work.id}`;
  const requestDigest = await digestDecodedAdmissionEnvelope({
    sourceAccountId: current.source.account.id,
    expectedDesiredProcessingEpoch: expected,
    externalId: current.item.externalId,
    ...(work.title === null ? {} : { title: work.title }),
    ...(work.docType === null ? {} : { docType: work.docType }),
    uri: work.uri,
    capturedAt: work.capturedAt.getTime(),
    mediaType: work.mediaType,
    inlineText: text,
    extractionFingerprint: work.extractionFingerprint,
    extractorFingerprint: work.extractorFingerprint,
    recordSchemaFingerprint: work.recordSchemaFingerprint,
    normalizationFingerprint: work.normalizationFingerprint,
    chunkerFingerprint: work.chunkerFingerprint,
    correctionRevision,
    expectedPageCount: plan.expectedPageCount,
    expectedEvidenceSpanCount: plan.expectedEvidenceSpanCount,
    expectedDocumentCount: plan.expectedDocumentCount,
    expectedChunkCount: plan.expectedChunkCount,
    expectedEventCount: plan.expectedEventCount,
    expectedObservationCount: plan.expectedObservationCount,
  });
  const priorRows = (
    await rows<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.ingest_requests WHERE source_account_id = $1 AND request_id = $2 ORDER BY created_at, id LIMIT 2",
      [current.source.account.id, requestId],
    )
  ).map(camelizeIngestRequest);
  if (priorRows.length > 1) workerProtocolError("scan_conflict");
  if (priorRows[0]) {
    const prior = priorRows[0];
    if (prior.requestDigest !== requestDigest) workerProtocolError("request_conflict");
    const job = await loadJob(ctx, prior.ingestJobId);
    if (!job) workerProtocolError("scan_conflict");
    return { sourceRevisionId: prior.sourceRevisionId, processingGenerationId: prior.processingGenerationId, ingestJobId: prior.ingestJobId, desiredProcessingEpoch: job.desiredProcessingEpoch };
  }
  await refreshAvailableSourceItem(ctx.client, {
    spaceId: current.source.spaceId,
    sourceItemId: current.item.id,
    ...(work.title === null ? {} : { title: work.title }),
    ...(work.docType === null ? {} : { docType: work.docType }),
    uri: work.uri,
  });
  const revision = await createOrGetRevision(ctx.client, {
    spaceId: current.source.spaceId,
    sourceItemId: current.item.id,
    mediaType: work.mediaType,
    inlineText: text,
    capturedAt: work.capturedAt,
    userId: work.actorUserId,
  });
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: work.extractionFingerprint,
    extractorFingerprint: work.extractorFingerprint,
    recordSchemaFingerprint: work.recordSchemaFingerprint,
    normalizationFingerprint: work.normalizationFingerprint,
    chunkerFingerprint: work.chunkerFingerprint,
    correctionRevision,
  });
  const existing = (
    await rows<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.processing_generations WHERE source_revision_id = $1 AND processing_fingerprint = $2 ORDER BY created_at, id LIMIT 2",
      [revision.id, processingFingerprint],
    )
  ).map(camelizeProcessingGeneration);
  if (existing.length > 1) workerProtocolError("scan_conflict");
  if (existing[0]) {
    const generation = existing[0];
    const jobs = (
      await rows<Record<string, unknown>>(ctx, "SELECT * FROM kith.ingest_jobs WHERE processing_generation_id = $1 LIMIT 2", [generation.id])
    ).map(camelizeIngestJob);
    if (jobs.length !== 1 || generation.spaceId !== current.source.spaceId ||
      generation.sourceAccountId !== current.source.account.id || generation.sourceItemId !== current.item.id ||
      generation.expectedPageCount !== plan.expectedPageCount || generation.expectedEvidenceSpanCount !== plan.expectedEvidenceSpanCount ||
      generation.expectedDocumentCount !== plan.expectedDocumentCount || generation.expectedChunkCount !== plan.expectedChunkCount ||
      current.item.desiredRevisionId !== revision.id || current.item.desiredProcessingEpoch !== generation.desiredProcessingEpoch) {
      workerProtocolError("scan_conflict");
    }
    await exec(ctx, `INSERT INTO kith.ingest_requests
      (id, space_id, created_at, source_account_id, request_id, request_digest, source_item_id,
       source_revision_id, processing_generation_id, ingest_job_id, actor_user_id, actor_credential_id)
      VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newKithId(), current.source.spaceId, current.source.account.id, requestId, requestDigest, current.item.id, revision.id, generation.id, jobs[0]!.id, work.actorUserId, work.actorCredentialId]);
    return { sourceRevisionId: revision.id, processingGenerationId: generation.id, ingestJobId: jobs[0]!.id, desiredProcessingEpoch: generation.desiredProcessingEpoch! };
  }
  let desiredProcessingEpoch: number;
  try {
    desiredProcessingEpoch = await setDesiredSourceRevision(ctx.client, {
      spaceId: current.source.spaceId,
      sourceItemId: current.item.id,
      desiredRevisionId: revision.id,
      expectedDesiredProcessingEpoch: expected,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("desired processing epoch conflict")) workerProtocolError("desired_processing_epoch_conflict");
    throw error;
  }
  await exec(ctx, "UPDATE kith.source_accounts SET worker_assessment_epoch = COALESCE(worker_assessment_epoch, 0) + 1 WHERE id = $1", [current.source.account.id]);
  const processingGenerationId = newKithId();
  const ingestJobId = newKithId();
  await exec(ctx, `INSERT INTO kith.processing_generations
    (id, space_id, created_at, source_account_id, source_item_id, source_revision_id,
     processing_fingerprint, extraction_fingerprint, extractor_fingerprint,
     record_schema_fingerprint, normalization_fingerprint, chunker_fingerprint,
     correction_revision, desired_processing_epoch, card_generation, state,
     expected_page_count, expected_evidence_span_count, expected_document_count,
     expected_chunk_count, expected_event_count, expected_observation_count, embedding_status)
    VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,'queued',$14,$15,$16,$17,0,0,'unavailable')`,
    [processingGenerationId, current.source.spaceId, current.source.account.id, current.item.id, revision.id, processingFingerprint, work.extractionFingerprint, work.extractorFingerprint, work.recordSchemaFingerprint, work.normalizationFingerprint, work.chunkerFingerprint, correctionRevision, desiredProcessingEpoch, plan.expectedPageCount, plan.expectedEvidenceSpanCount, plan.expectedDocumentCount, plan.expectedChunkCount]);
  await exec(ctx, `INSERT INTO kith.ingest_jobs
    (id, space_id, created_at, source_account_id, source_item_id, source_revision_id,
     processing_generation_id, admitted_by_user_id, admitted_by_credential_id,
     actor_user_id, actor_credential_id, desired_processing_epoch, state, attempts,
     lease_epoch, worker_managed, next_attempt_at, worker_discovery_work_id,
     worker_observation_epoch, worker_processing_mode)
    VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$7,$8,$9,'queued',0,0,true,$10,$11,$12,'inline_utf8_v1')`,
    [ingestJobId, current.source.spaceId, current.source.account.id, current.item.id, revision.id, processingGenerationId, work.actorUserId, work.actorCredentialId, desiredProcessingEpoch, at(ctx.now), work.id, work.observationEpoch]);
  await exec(ctx, `INSERT INTO kith.ingest_requests
    (id, space_id, created_at, source_account_id, request_id, request_digest, source_item_id,
     source_revision_id, processing_generation_id, ingest_job_id, actor_user_id, actor_credential_id)
    VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [newKithId(), current.source.spaceId, current.source.account.id, requestId, requestDigest, current.item.id, revision.id, processingGenerationId, ingestJobId, work.actorUserId, work.actorCredentialId]);
  return { sourceRevisionId: revision.id, processingGenerationId, ingestJobId, desiredProcessingEpoch };
}

export async function admitDiscoveryUtf8(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.admitUtf8" }>,
): Promise<WorkerDiscoveryAdmitResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  if (!KITH_ID.test(request.workId)) workerProtocolError("invalid_request");
  const [textHash, leaseTokenHash] = await Promise.all([sha256Hex(request.text), sha256Hex(request.leaseToken)]);
  const requestDigest = await digest("worker-discovery-admit-utf8:v1", [source.account.id, request.requestId, request.workId, request.leaseEpoch, leaseTokenHash, textHash]);
  const receipts = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_operation_receipts WHERE source_account_id = $1
      AND operation = 'discovery_admit_utf8' AND request_id = $2 ORDER BY created_at, id LIMIT 2`,
    [source.account.id, request.requestId],
  );
  if (receipts.length > 1) workerProtocolError("scan_conflict");
  const prior = receipts[0];
  if (prior) {
    if (prior.space_id !== source.spaceId || prior.actor_user_id !== source.principal.userId || prior.actor_credential_id !== source.principal.credentialId) workerProtocolError("not_found");
    if (prior.request_digest !== requestDigest || prior.discovery_work_id !== request.workId || Number(prior.lease_epoch) !== request.leaseEpoch || prior.lease_token_hash !== leaseTokenHash) workerProtocolError("request_conflict");
    if (new Date(prior.retire_at as string | Date).getTime() <= ctx.now) workerProtocolError("reservation_expired");
    const current = await requireCurrentDiscovery(ctx, source, request.workId);
    if (current.work.state !== "admitted" || current.item.id !== prior.source_item_id || current.work.ingestJobId !== prior.ingest_job_id || current.work.sourceRevisionId !== prior.source_revision_id || current.work.processingGenerationId !== prior.processing_generation_id) workerProtocolError("stale_observation");
    const ids = { sourceRevisionId: String(prior.source_revision_id), processingGenerationId: String(prior.processing_generation_id), ingestJobId: String(prior.ingest_job_id), desiredProcessingEpoch: Number(prior.desired_processing_epoch) };
    await validateAdmittedChain(ctx, current, ids, true);
    return admissionResult(current.work, ids, true);
  }
  const current = await requireDiscoveryLease(ctx, source, request.workId, request.leaseEpoch, request.leaseToken);
  if (current.work.contentRepresentation === "archived_binary_v1") workerProtocolError("stale_observation");
  const plan = planInlineText(request.text);
  if (textHash !== current.work.contentHash || Buffer.byteLength(request.text, "utf8") !== current.work.byteLength || plan.chunkerFingerprint !== current.work.chunkerFingerprint || !current.item.externalId || current.work.expectedDesiredProcessingEpoch === null) {
    workerProtocolError("stale_observation");
  }
  await consumeWorkerMutationRateLimit(ctx, source.principal.credentialId, source.account.id);
  const ids = await createOrReuseInlineAdmission(ctx, current, request.text);
  await validateAdmittedChain(ctx, current, ids, true);
  await exec(ctx, `UPDATE kith.worker_discovery_work SET state = 'admitted', ingest_request_id = $1,
    source_revision_id = $2, processing_generation_id = $3, ingest_job_id = $4,
    lease_token = NULL, lease_owner_credential_id = NULL, lease_expires_at = NULL,
    next_attempt_at = NULL WHERE id = $5`,
    [`fs-admit:${current.work.id}`, ids.sourceRevisionId, ids.processingGenerationId, ids.ingestJobId, current.work.id]);
  await exec(ctx, `INSERT INTO kith.worker_operation_receipts
    (id, space_id, created_at, source_account_id, source_item_id, discovery_work_id,
     operation, request_id, request_digest, actor_user_id, actor_credential_id,
     lease_epoch, lease_token_hash, source_revision_id, processing_generation_id,
     ingest_job_id, desired_processing_epoch, created_at_field, retire_at)
    VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,'discovery_admit_utf8',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [newKithId(), source.spaceId, source.account.id, current.item.id, current.work.id, request.requestId, requestDigest, source.principal.userId, source.principal.credentialId, request.leaseEpoch, leaseTokenHash, ids.sourceRevisionId, ids.processingGenerationId, ids.ingestJobId, ids.desiredProcessingEpoch, at(ctx.now), at(nowPlus(ctx.now, WORKER_OPERATION_RECEIPT_MS))]);
  const updated = camelizeDiscoveryWork((await row<Record<string, unknown>>(ctx, "SELECT * FROM kith.worker_discovery_work WHERE id = $1", [current.work.id])) ?? workerProtocolError("scan_conflict"));
  return admissionResult(updated, ids, false);
}
