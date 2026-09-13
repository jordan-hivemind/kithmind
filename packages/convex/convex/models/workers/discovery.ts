import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { isBinaryClass } from "@repo/worker-protocol";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";
import type { PrincipalRef } from "../../lib/spaces";
import { planInlineText } from "../ingestion/inlineText";
import { admitSourceRevision } from "../ingestion/model";
import { sha256Utf8 } from "../provenance/model";
import { requireInlineSourceRevision } from "../provenance/representations";
import { requireWorkerSourceAccount } from "./auth";
import { workerProtocolError, workerProtocolErrorCode } from "./errors";
import { accountAdmitsBinaryClass, FS_TEXT_PROFILE } from "./profile";
import { consumeWorkerMutationRateLimit } from "./rateLimit";
import type {
  WorkerDiscoveryAdmitResult,
  WorkerDiscoveryReserveResult,
  WorkerRequest,
} from "./protocol";

export const WORKER_DISCOVERY_LEASE_MS = 5 * 60 * 1_000;
export const WORKER_RESERVATION_RECEIPT_MS = WORKER_DISCOVERY_LEASE_MS;
export const WORKER_OPERATION_RECEIPT_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_WORKER_DISCOVERY_ATTEMPTS = 8;
const RESERVATION_CANDIDATE_OVERFETCH = 12;

type LoadedWorkerSource = Awaited<
  ReturnType<typeof requireWorkerSourceAccount>
>;

export type CurrentDiscovery = {
  source: LoadedWorkerSource;
  item: Doc<"sourceItems">;
  scan: Doc<"workerSourceScans">;
  entry: Doc<"workerScanEntries">;
  page: Doc<"workerScanPages">;
  work: Doc<"workerDiscoveryWork">;
};

function safeAdd(now: number, duration: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + duration);
}

async function digest(domain: string, value: unknown): Promise<string> {
  return sha256Utf8(`${domain}\0${JSON.stringify(value)}`);
}

async function requireOriginalActor(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  actor: { actorUserId: Id<"users">; actorCredentialId: Id<"apiKeys"> },
): Promise<void> {
  try {
    const account = await requireSourceAccountAccess(
      ctx,
      {
        userId: actor.actorUserId,
        credentialId: actor.actorCredentialId,
      },
      source.account._id,
      "ingest",
    );
    if (account.spaceId !== source.spaceId || account.connector !== "fs") {
      throw workerProtocolError("not_authorized");
    }
  } catch {
    throw workerProtocolError("not_authorized");
  }
}

async function loadDiscoveryChain(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  workId: Id<"workerDiscoveryWork">,
): Promise<CurrentDiscovery> {
  const work = await ctx.db.get(workId);
  if (
    !work ||
    work.spaceId !== source.spaceId ||
    work.sourceAccountId !== source.account._id
  ) {
    throw workerProtocolError("not_found");
  }
  const [item, scan, entry] = await Promise.all([
    ctx.db.get(work.sourceItemId),
    ctx.db.get(work.scanId),
    ctx.db.get(work.scanEntryId),
  ]);
  const page = entry ? await ctx.db.get(entry.scanPageId) : null;
  if (
    !item ||
    !scan ||
    !entry ||
    !page ||
    item.spaceId !== source.spaceId ||
    item.sourceAccountId !== source.account._id ||
    scan.spaceId !== source.spaceId ||
    scan.sourceAccountId !== source.account._id ||
    entry.spaceId !== source.spaceId ||
    entry.sourceAccountId !== source.account._id ||
    entry.scanId !== scan._id ||
    entry.scanPageId !== page._id ||
    entry.sourceItemId !== item._id ||
    entry.discoveryWorkId !== work._id ||
    page.spaceId !== source.spaceId ||
    page.sourceAccountId !== source.account._id ||
    page.scanId !== scan._id
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return { source, item, scan, entry, page, work };
}

async function requireCurrentDiscoveryState(
  ctx: MutationCtx,
  current: CurrentDiscovery,
): Promise<void> {
  const { source, item, scan, entry, work } = current;
  await requireOriginalActor(ctx, source, work);
  await requireOriginalActor(ctx, source, scan);
  const binary = work.contentRepresentation === "archived_binary_v1";
  const profileValid = binary
    ? accountAdmitsBinaryClass(source.account, entry.binaryParserProfileId) &&
      source.account.binaryProfileEnabledAt !== undefined &&
      Number.isSafeInteger(source.account.binaryProfileEnabledAt) &&
      source.account.binaryProfileEnabledAt >= 0 &&
      source.account.binaryProfileAuditDigest !== undefined &&
      /^[0-9a-f]{64}$/.test(source.account.binaryProfileAuditDigest) &&
      entry.contentRepresentation === "archived_binary_v1" &&
      isBinaryClass(entry.binaryParserProfileId, entry.binaryMediaType) &&
      entry.binaryParserProfileId === work.profileId &&
      entry.binaryMediaType === work.mediaType &&
      entry.parserFingerprint === work.parserFingerprint &&
      entry.extractionConfigurationFingerprint ===
        work.extractionConfigurationFingerprint &&
      entry.extractorFingerprint === work.extractorFingerprint &&
      entry.recordSchemaFingerprint === work.recordSchemaFingerprint &&
      entry.normalizationFingerprint === work.normalizationFingerprint &&
      entry.chunkerFingerprint === work.chunkerFingerprint &&
      entry.correctionRevision === work.correctionRevision &&
      isBinaryClass(work.profileId, work.mediaType) &&
      typeof work.parserFingerprint === "string" &&
      typeof work.extractionConfigurationFingerprint === "string" &&
      typeof work.correctionRevision === "string"
    : (work.contentRepresentation === undefined ||
        work.contentRepresentation === "inline_utf8_v1") &&
      (entry.contentRepresentation === undefined ||
        entry.contentRepresentation === "inline_utf8_v1") &&
      work.mediaType === FS_TEXT_PROFILE.mediaType &&
      work.profileId === FS_TEXT_PROFILE.profileId &&
      work.extractionFingerprint === FS_TEXT_PROFILE.extractionFingerprint &&
      work.extractorFingerprint === FS_TEXT_PROFILE.extractorFingerprint &&
      work.recordSchemaFingerprint ===
        FS_TEXT_PROFILE.recordSchemaFingerprint &&
      work.normalizationFingerprint ===
        FS_TEXT_PROFILE.normalizationFingerprint &&
      work.chunkerFingerprint === FS_TEXT_PROFILE.chunkerFingerprint;
  if (
    item.lifecycle !== "available" ||
    scan.state !== "enumerated" ||
    scan.completedAt === undefined ||
    scan.inventoryEpoch !== (source.account.inventoryEpoch ?? 0) ||
    scan.inventoryEpoch !== (source.account.completedInventoryEpoch ?? 0) ||
    scan.reconcileManifestVersion !== (source.account.manifestVersion ?? 0) ||
    entry.state !== "queued" ||
    item.workerLastSeenInventoryEpoch !== scan.inventoryEpoch ||
    item.workerObservationEpoch !== work.observationEpoch ||
    item.workerProcessingEpoch !== work.processingEpoch ||
    entry.observationEpoch !== work.observationEpoch ||
    entry.processingEpoch !== work.processingEpoch ||
    entry.contentHash !== work.contentHash ||
    entry.byteLength !== work.byteLength ||
    entry.processingIdentityDigest !== item.workerProcessingIdentityDigest ||
    item.workerContentHash !== work.contentHash ||
    item.workerProfileId !== work.profileId ||
    work.expectedDesiredProcessingEpoch === undefined ||
    item.desiredProcessingEpoch !==
      work.expectedDesiredProcessingEpoch +
        (work.state === "admitted" ? 1 : 0) ||
    !profileValid ||
    !Number.isSafeInteger(work.observationEpoch) ||
    !Number.isSafeInteger(work.processingEpoch) ||
    !Number.isSafeInteger(work.expectedDesiredProcessingEpoch) ||
    work.expectedDesiredProcessingEpoch >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(work.byteLength) ||
    !Number.isSafeInteger(work.capturedAt) ||
    !Number.isSafeInteger(work.sourceModifiedAt) ||
    !Number.isSafeInteger(work.attempts) ||
    !Number.isSafeInteger(work.leaseEpoch)
  ) {
    throw workerProtocolError("stale_observation");
  }
}

export async function requireCurrentDiscovery(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  workId: Id<"workerDiscoveryWork">,
): Promise<CurrentDiscovery> {
  const current = await loadDiscoveryChain(ctx, source, workId);
  await requireCurrentDiscoveryState(ctx, current);
  return current;
}

async function requireDiscoveryLease(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  workId: Id<"workerDiscoveryWork">,
  leaseEpoch: number,
  leaseToken: string,
  now: number,
): Promise<CurrentDiscovery> {
  const current = await requireCurrentDiscovery(ctx, source, workId);
  if (
    current.work.state !== "leased" ||
    current.work.leaseOwnerCredentialId !== source.principal.credentialId ||
    current.work.leaseEpoch !== leaseEpoch ||
    current.work.leaseToken !== leaseToken ||
    current.work.leaseExpiresAt === undefined ||
    current.work.leaseExpiresAt <= now
  ) {
    throw workerProtocolError("lease_conflict");
  }
  return current;
}

function reserveTarget(
  work: Doc<"workerDiscoveryWork">,
): WorkerDiscoveryReserveResult["targets"][number] {
  if (
    work.contentRepresentation === "archived_binary_v1" ||
    !work.leaseToken ||
    work.leaseExpiresAt === undefined
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return {
    workId: work._id,
    sourceItemId: work.sourceItemId,
    observationEpoch: work.observationEpoch,
    processingEpoch: work.processingEpoch,
    leaseEpoch: work.leaseEpoch,
    leaseToken: work.leaseToken,
    leaseExpiresAt: work.leaseExpiresAt,
    uri: work.uri,
    contentHash: work.contentHash,
    byteLength: work.byteLength,
  };
}

async function replayReservation(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  receipt: Doc<"workerReservationReceipts">,
  now: number,
): Promise<WorkerDiscoveryReserveResult> {
  if (
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account._id ||
    receipt.actorUserId !== source.principal.userId ||
    receipt.actorCredentialId !== source.principal.credentialId ||
    !Number.isSafeInteger(receipt.targetCount) ||
    receipt.targetCount < 0 ||
    receipt.targetCount > 4 ||
    !Number.isSafeInteger(receipt.expiresAt)
  ) {
    throw workerProtocolError("not_found");
  }
  if (
    receipt.invalidatedAt !== undefined ||
    receipt.expiresAt <= now ||
    receipt.retireAt <= now
  ) {
    throw workerProtocolError("reservation_expired");
  }
  const rows = await ctx.db
    .query("workerReservationTargets")
    .withIndex("by_receiptId_and_ordinal", (q) =>
      q.eq("receiptId", receipt._id),
    )
    .take(5);
  const targets: WorkerDiscoveryReserveResult["targets"] = [];
  if (rows.length !== receipt.targetCount) {
    throw workerProtocolError("reservation_expired");
  }
  for (let ordinal = 0; ordinal < rows.length; ordinal += 1) {
    const row = rows[ordinal]!;
    if (
      row.ordinal !== ordinal ||
      row.spaceId !== source.spaceId ||
      row.sourceAccountId !== source.account._id ||
      row.discoveryWorkId === undefined ||
      row.ingestJobId !== undefined ||
      row.leaseExpiresAt !== receipt.expiresAt ||
      row.leaseExpiresAt <= now
    ) {
      throw workerProtocolError("reservation_expired");
    }
    const current = await requireCurrentDiscovery(
      ctx,
      source,
      row.discoveryWorkId,
    );
    if (
      current.item._id !== row.sourceItemId ||
      current.work.state !== "leased" ||
      current.work.leaseOwnerCredentialId !== source.principal.credentialId ||
      current.work.leaseEpoch !== row.leaseEpoch ||
      current.work.leaseToken !== row.leaseToken ||
      current.work.leaseExpiresAt !== row.leaseExpiresAt
    ) {
      throw workerProtocolError("reservation_expired");
    }
    targets.push(reserveTarget(current.work));
  }
  return {
    operation: "discovery.reserve",
    receiptId: receipt._id,
    expiresAt: receipt.expiresAt,
    reused: true,
    targets,
  };
}

async function dueDiscoveryCandidates(
  ctx: MutationCtx,
  sourceAccountId: Id<"sourceAccounts">,
  now: number,
): Promise<Array<Doc<"workerDiscoveryWork">>> {
  const representations = [undefined, "inline_utf8_v1" as const];
  const groups = await Promise.all(
    representations.flatMap((representation) => [
      ctx.db
        .query("workerDiscoveryWork")
        .withIndex("by_source_rep_state_next", (q) =>
          q
            .eq("sourceAccountId", sourceAccountId)
            .eq("contentRepresentation", representation)
            .eq("state", "queued"),
        )
        .take(RESERVATION_CANDIDATE_OVERFETCH),
      ctx.db
        .query("workerDiscoveryWork")
        .withIndex("by_source_rep_state_next", (q) =>
          q
            .eq("sourceAccountId", sourceAccountId)
            .eq("contentRepresentation", representation)
            .eq("state", "failed")
            .gt("nextAttemptAt", undefined)
            .lte("nextAttemptAt", now),
        )
        .take(RESERVATION_CANDIDATE_OVERFETCH),
      ctx.db
        .query("workerDiscoveryWork")
        .withIndex("by_source_rep_state_lease", (q) =>
          q
            .eq("sourceAccountId", sourceAccountId)
            .eq("contentRepresentation", representation)
            .eq("state", "leased")
            .gt("leaseExpiresAt", undefined)
            .lte("leaseExpiresAt", now),
        )
        .take(RESERVATION_CANDIDATE_OVERFETCH),
    ]),
  );
  const byId = new Map<string, Doc<"workerDiscoveryWork">>();
  for (const row of groups.flat()) {
    const due =
      (row.state === "queued" &&
        (row.nextAttemptAt === undefined || row.nextAttemptAt <= now)) ||
      (row.state === "failed" &&
        row.nextAttemptAt !== undefined &&
        row.nextAttemptAt <= now) ||
      (row.state === "leased" &&
        row.leaseExpiresAt !== undefined &&
        row.leaseExpiresAt <= now);
    if (due) byId.set(row._id, row);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left._id.localeCompare(right._id),
  );
}

export async function reserveDiscoveryWork(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.reserve" }>,
  tokens: string[],
  now: number,
): Promise<WorkerDiscoveryReserveResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  if (tokens.length < request.maxItems) {
    throw workerProtocolError("invalid_request");
  }
  for (const token of tokens.slice(0, request.maxItems)) {
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw workerProtocolError("invalid_request");
    }
  }
  const requestDigest = await digest("worker-discovery-reserve:v1", [
    source.account._id,
    request.requestId,
    request.maxItems,
  ]);
  const receipts = await ctx.db
    .query("workerReservationReceipts")
    .withIndex("by_sourceAccountId_and_kind_and_requestId", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("kind", "discovery")
        .eq("requestId", request.requestId),
    )
    .take(2);
  if (receipts.length > 1) throw workerProtocolError("scan_conflict");
  if (receipts[0]) {
    if (receipts[0].requestDigest !== requestDigest) {
      throw workerProtocolError("request_conflict");
    }
    return replayReservation(ctx, source, receipts[0], now);
  }
  if (
    (source.account.inventoryEpoch ?? 0) !==
    (source.account.completedInventoryEpoch ?? 0)
  ) {
    throw workerProtocolError("scan_not_ready");
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);

  const candidates = await dueDiscoveryCandidates(ctx, source.account._id, now);
  const claimed: Doc<"workerDiscoveryWork">[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= request.maxItems) break;
    if (
      candidate.spaceId !== source.spaceId ||
      candidate.sourceAccountId !== source.account._id
    ) {
      throw workerProtocolError("scan_conflict");
    }
    // The legacy reservation shape promises UTF-8 targets. Binary work has a
    // separate exact reservation operation and must never enter this result.
    if (candidate.contentRepresentation === "archived_binary_v1") continue;
    let current: CurrentDiscovery | undefined;
    try {
      current = await loadDiscoveryChain(ctx, source, candidate._id);
      await requireCurrentDiscoveryState(ctx, current);
      if (
        current.work.state !== candidate.state ||
        current.work.leaseEpoch !== candidate.leaseEpoch ||
        current.work.attempts !== candidate.attempts
      ) {
        throw workerProtocolError("scan_conflict");
      }
      if (
        current.work.attempts >= MAX_WORKER_DISCOVERY_ATTEMPTS ||
        (current.work.state === "failed" && current.work.retryable !== true)
      ) {
        await ctx.db.patch(current.work._id, {
          state: "needs_review",
          leaseToken: undefined,
          leaseOwnerCredentialId: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: undefined,
        });
        continue;
      }
      const leaseEpoch = current.work.leaseEpoch + 1;
      if (!Number.isSafeInteger(leaseEpoch)) {
        throw workerProtocolError("scan_conflict");
      }
      const leaseExpiresAt = safeAdd(now, WORKER_DISCOVERY_LEASE_MS);
      await ctx.db.patch(current.work._id, {
        state: "leased",
        attempts: current.work.attempts + 1,
        leaseEpoch,
        leaseToken: tokens[claimed.length]!,
        leaseOwnerCredentialId: source.principal.credentialId,
        leaseExpiresAt,
        nextAttemptAt: undefined,
      });
      const loaded = await ctx.db.get(current.work._id);
      if (!loaded) throw workerProtocolError("scan_conflict");
      claimed.push(loaded);
    } catch (error) {
      const code = workerProtocolErrorCode(error);
      if (
        code !== "not_authorized" &&
        code !== "not_found" &&
        code !== "scan_conflict" &&
        code !== "stale_observation" &&
        code !== "source_unavailable"
      ) {
        throw error;
      }
      if (!current) throw error;
      await ctx.db.patch(current.work._id, {
        state: "needs_review",
        leaseToken: undefined,
        leaseOwnerCredentialId: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: undefined,
      });
    }
  }

  const expiresAt = safeAdd(now, WORKER_RESERVATION_RECEIPT_MS);
  const receiptId = await ctx.db.insert("workerReservationReceipts", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    kind: "discovery",
    requestId: request.requestId,
    requestDigest,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    targetCount: claimed.length,
    createdAt: now,
    expiresAt,
    retireAt: safeAdd(now, WORKER_OPERATION_RECEIPT_MS),
  });
  for (let ordinal = 0; ordinal < claimed.length; ordinal += 1) {
    const work = claimed[ordinal]!;
    if (!work.leaseToken || work.leaseExpiresAt === undefined) {
      throw workerProtocolError("scan_conflict");
    }
    await ctx.db.insert("workerReservationTargets", {
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      sourceItemId: work.sourceItemId,
      receiptId,
      ordinal,
      discoveryWorkId: work._id,
      leaseEpoch: work.leaseEpoch,
      leaseToken: work.leaseToken,
      leaseExpiresAt: work.leaseExpiresAt,
    });
  }
  return {
    operation: "discovery.reserve",
    receiptId,
    expiresAt,
    reused: false,
    targets: claimed.map(reserveTarget),
  };
}

export async function validateAdmittedChain(
  ctx: MutationCtx,
  current: CurrentDiscovery,
  ids: {
    sourceRevisionId: Id<"sourceRevisions">;
    processingGenerationId: Id<"processingGenerations">;
    ingestJobId: Id<"ingestJobs">;
    desiredProcessingEpoch: number;
  },
  requireWorkerBinding: boolean,
): Promise<void> {
  const [item, revision, generation, job] = await Promise.all([
    ctx.db.get(current.item._id),
    ctx.db.get(ids.sourceRevisionId),
    ctx.db.get(ids.processingGenerationId),
    ctx.db.get(ids.ingestJobId),
  ]);
  let revisionText: string | undefined;
  if (revision) {
    try {
      revisionText = requireInlineSourceRevision(revision).text;
    } catch {
      revisionText = undefined;
    }
  }
  const revisionTextHash =
    revisionText === undefined ? undefined : await sha256Utf8(revisionText);
  const revisionByteLength =
    revisionText === undefined
      ? undefined
      : new TextEncoder().encode(revisionText).byteLength;
  if (
    !item ||
    !revision ||
    !generation ||
    !job ||
    item.spaceId !== current.source.spaceId ||
    item.sourceAccountId !== current.source.account._id ||
    item.desiredRevisionId !== revision._id ||
    item.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    revision.spaceId !== current.source.spaceId ||
    revision.sourceItemId !== item._id ||
    revision.contentHash !== current.work.contentHash ||
    revision.byteLength !== current.work.byteLength ||
    revisionTextHash !== revision.contentHash ||
    revisionByteLength !== revision.byteLength ||
    revision.mediaType !== current.work.mediaType ||
    generation.spaceId !== current.source.spaceId ||
    generation.sourceAccountId !== current.source.account._id ||
    generation.sourceItemId !== item._id ||
    generation.sourceRevisionId !== revision._id ||
    generation.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    generation.extractionFingerprint !== current.work.extractionFingerprint ||
    generation.extractorFingerprint !== current.work.extractorFingerprint ||
    generation.recordSchemaFingerprint !==
      current.work.recordSchemaFingerprint ||
    generation.normalizationFingerprint !==
      current.work.normalizationFingerprint ||
    generation.chunkerFingerprint !== current.work.chunkerFingerprint ||
    generation.correctionRevision !==
      `filesystem-observation-v1:${current.work.processingEpoch}` ||
    job.spaceId !== current.source.spaceId ||
    job.sourceAccountId !== current.source.account._id ||
    job.sourceItemId !== item._id ||
    job.sourceRevisionId !== revision._id ||
    job.processingGenerationId !== generation._id ||
    job.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    (requireWorkerBinding &&
      (job.workerDiscoveryWorkId !== current.work._id ||
        job.workerObservationEpoch !== current.work.observationEpoch)) ||
    job.state !== generation.state ||
    job.actorUserId !== current.work.actorUserId ||
    job.actorCredentialId !== current.work.actorCredentialId ||
    job.admittedByUserId !== current.work.actorUserId ||
    job.admittedByCredentialId !== current.work.actorCredentialId
  ) {
    throw workerProtocolError("scan_conflict");
  }
}

function admissionResult(
  work: Doc<"workerDiscoveryWork">,
  ids: {
    sourceRevisionId: Id<"sourceRevisions">;
    processingGenerationId: Id<"processingGenerations">;
    ingestJobId: Id<"ingestJobs">;
    desiredProcessingEpoch: number;
  },
  reused: boolean,
): WorkerDiscoveryAdmitResult {
  return {
    operation: "discovery.admitUtf8",
    workId: work._id,
    sourceItemId: work.sourceItemId,
    sourceRevisionId: ids.sourceRevisionId,
    processingGenerationId: ids.processingGenerationId,
    ingestJobId: ids.ingestJobId,
    desiredProcessingEpoch: ids.desiredProcessingEpoch,
    state: "admitted",
    reused,
  };
}

export async function admitDiscoveryUtf8(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.admitUtf8" }>,
  now: number,
): Promise<WorkerDiscoveryAdmitResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const workId = ctx.db.normalizeId("workerDiscoveryWork", request.workId);
  if (!workId) throw workerProtocolError("invalid_request");
  const [textHash, leaseTokenHash] = await Promise.all([
    sha256Utf8(request.text),
    sha256Utf8(request.leaseToken),
  ]);
  const requestDigest = await digest("worker-discovery-admit-utf8:v1", [
    source.account._id,
    request.requestId,
    workId,
    request.leaseEpoch,
    leaseTokenHash,
    textHash,
  ]);
  const receipts = await ctx.db
    .query("workerOperationReceipts")
    .withIndex("by_sourceAccountId_and_operation_and_requestId", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("operation", "discovery_admit_utf8")
        .eq("requestId", request.requestId),
    )
    .take(2);
  if (receipts.length > 1) throw workerProtocolError("scan_conflict");
  const prior = receipts[0];
  if (prior) {
    if (
      prior.spaceId !== source.spaceId ||
      prior.sourceAccountId !== source.account._id ||
      prior.actorUserId !== source.principal.userId ||
      prior.actorCredentialId !== source.principal.credentialId
    ) {
      throw workerProtocolError("not_found");
    }
    if (
      prior.requestDigest !== requestDigest ||
      prior.discoveryWorkId !== workId ||
      prior.leaseEpoch !== request.leaseEpoch ||
      prior.leaseTokenHash !== leaseTokenHash
    ) {
      throw workerProtocolError("request_conflict");
    }
    if (prior.retireAt <= now) throw workerProtocolError("reservation_expired");
    const current = await requireCurrentDiscovery(ctx, source, workId);
    if (
      current.work.state !== "admitted" ||
      current.item._id !== prior.sourceItemId ||
      current.work.ingestJobId !== prior.ingestJobId ||
      current.work.sourceRevisionId !== prior.sourceRevisionId ||
      current.work.processingGenerationId !== prior.processingGenerationId
    ) {
      throw workerProtocolError("stale_observation");
    }
    await validateAdmittedChain(ctx, current, prior, true);
    return admissionResult(current.work, prior, true);
  }

  const current = await requireDiscoveryLease(
    ctx,
    source,
    workId,
    request.leaseEpoch,
    request.leaseToken,
    now,
  );
  if (current.work.contentRepresentation === "archived_binary_v1") {
    throw workerProtocolError("stale_observation");
  }
  const plan = planInlineText(request.text);
  const byteLength = new TextEncoder().encode(request.text).byteLength;
  if (
    textHash !== current.work.contentHash ||
    byteLength !== current.work.byteLength ||
    plan.chunkerFingerprint !== current.work.chunkerFingerprint ||
    current.item.externalId === undefined ||
    current.work.expectedDesiredProcessingEpoch === undefined
  ) {
    throw workerProtocolError("stale_observation");
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);

  let admitted: Awaited<ReturnType<typeof admitSourceRevision>>;
  try {
    admitted = await admitSourceRevision(ctx, {
      principal: {
        userId: current.work.actorUserId,
        credentialId: current.work.actorCredentialId,
      },
      sourceAccountId: source.account._id,
      requestId: `fs-admit:${current.work._id}`,
      expectedDesiredProcessingEpoch:
        current.work.expectedDesiredProcessingEpoch,
      source: {
        externalId: current.item.externalId,
        title: current.work.title,
        docType: current.work.docType,
        uri: current.work.uri,
        capturedAt: current.work.capturedAt,
        mediaType: current.work.mediaType,
        inlineText: request.text,
      },
      processing: {
        extractionFingerprint: current.work.extractionFingerprint,
        extractorFingerprint: current.work.extractorFingerprint,
        recordSchemaFingerprint: current.work.recordSchemaFingerprint,
        normalizationFingerprint: current.work.normalizationFingerprint,
        chunkerFingerprint: current.work.chunkerFingerprint,
        correctionRevision: `filesystem-observation-v1:${current.work.processingEpoch}`,
        expectedPageCount: plan.expectedPageCount,
        expectedEvidenceSpanCount: plan.expectedEvidenceSpanCount,
        expectedDocumentCount: plan.expectedDocumentCount,
        expectedChunkCount: plan.expectedChunkCount,
        expectedEventCount: plan.expectedEventCount,
        expectedObservationCount: plan.expectedObservationCount,
      },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Desired processing epoch conflict"
    ) {
      throw workerProtocolError("desired_processing_epoch_conflict");
    }
    throw error;
  }
  const desiredProcessingEpoch =
    current.work.expectedDesiredProcessingEpoch + 1;
  const ids = {
    sourceRevisionId: admitted.sourceRevisionId,
    processingGenerationId: admitted.processingGenerationId,
    ingestJobId: admitted.ingestJobId,
    desiredProcessingEpoch,
  };
  await validateAdmittedChain(ctx, current, ids, false);
  const job = await ctx.db.get(admitted.ingestJobId);
  if (!job) throw workerProtocolError("scan_conflict");
  if (
    job.workerDiscoveryWorkId !== undefined &&
    job.workerDiscoveryWorkId !== current.work._id
  ) {
    throw workerProtocolError("scan_conflict");
  }
  await ctx.db.patch(job._id, {
    workerManaged: true,
    workerDiscoveryWorkId: current.work._id,
    workerObservationEpoch: current.work.observationEpoch,
    nextAttemptAt: now,
  });
  await validateAdmittedChain(ctx, current, ids, true);
  await ctx.db.patch(current.work._id, {
    state: "admitted",
    ingestRequestId: `fs-admit:${current.work._id}`,
    sourceRevisionId: admitted.sourceRevisionId,
    processingGenerationId: admitted.processingGenerationId,
    ingestJobId: admitted.ingestJobId,
    leaseToken: undefined,
    leaseOwnerCredentialId: undefined,
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
  });
  await ctx.db.insert("workerOperationReceipts", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    sourceItemId: current.item._id,
    discoveryWorkId: current.work._id,
    operation: "discovery_admit_utf8",
    requestId: request.requestId,
    requestDigest,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    leaseEpoch: request.leaseEpoch,
    leaseTokenHash,
    sourceRevisionId: admitted.sourceRevisionId,
    processingGenerationId: admitted.processingGenerationId,
    ingestJobId: admitted.ingestJobId,
    desiredProcessingEpoch,
    createdAt: now,
    retireAt: safeAdd(now, WORKER_OPERATION_RECEIPT_MS),
  });
  const updated = await ctx.db.get(current.work._id);
  if (!updated) throw workerProtocolError("scan_conflict");
  return admissionResult(updated, ids, false);
}
