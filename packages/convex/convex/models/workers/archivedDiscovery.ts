import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { PrincipalRef } from "../../lib/spaces";
import { createArchivedIngestWork } from "../ingestion/archived";
import { digestProcessingConfiguration } from "../ingestion/hash";
import {
  createOrGetArchiveReceipt,
  createOrGetParserArtifact,
} from "../provenance/artifacts";
import {
  bindInitialArchiveReceipt,
  loadCurrentArchiveBinding,
  requireIndependentArchivePair,
} from "../provenance/archiveBindings";
import {
  createOrGetArchivedRevision,
  createOrGetParsedTextVersion,
} from "../provenance/binary";
import { sha256Utf8 } from "../provenance/model";
import {
  createAndBindProviderOriginal,
  loadProviderOriginalBinding,
  loadProviderOriginalReference,
} from "../provenance/providerOriginals";
import { parseSourceTextRepresentation } from "../provenance/representations";
import { markInventoryParseFailed } from "../documents/inventory";
import {
  BINARY_CLASSES,
  isBinaryClass,
  type BinaryParserProfileId,
} from "@repo/worker-protocol";
import { requireWorkerSourceAccount } from "./auth";
import { accountBinaryClasses } from "./profile";
import {
  MAX_WORKER_DISCOVERY_ATTEMPTS,
  requireCurrentDiscovery,
  WORKER_DISCOVERY_LEASE_MS,
  WORKER_OPERATION_RECEIPT_MS,
} from "./discovery";
import { workerProtocolError } from "./errors";
import { consumeWorkerMutationRateLimit } from "./rateLimit";
import type {
  ArchiveReceiptSelection,
  ArchivedWorkIdentity,
  ParsedTextDeclaration,
  WorkerArchivedAdmitResult,
  WorkerArchivedFailResult,
  WorkerArchivedLookupResult,
  WorkerArchivedPreflightResult,
  WorkerArchivedReserveResult,
  WorkerRequest,
} from "./protocol";

type LoadedWorkerSource = Awaited<
  ReturnType<typeof requireWorkerSourceAccount>
>;
type ArchivedRequest = Extract<
  WorkerRequest,
  { operation: "discovery.admitArchived" }
>;

function safeAdd(value: number, increment: number): number {
  const result = value + increment;
  if (!Number.isSafeInteger(result)) throw workerProtocolError("scan_conflict");
  return result;
}

async function digest(domain: string, value: unknown): Promise<string> {
  return sha256Utf8(`${domain}\0${JSON.stringify(value)}`);
}

/**
 * The lane gate: the archived-binary path is enabled and audited for at least
 * one class. Which class a particular file may use is checked where the class
 * is known, against the scan entry and the discovery work.
 */
export function requireBinaryGate(source: LoadedWorkerSource): void {
  if (
    accountBinaryClasses(source.account).length === 0 ||
    source.account.binaryProfileEnabledAt === undefined ||
    !Number.isSafeInteger(source.account.binaryProfileEnabledAt) ||
    source.account.binaryProfileEnabledAt < 0 ||
    source.account.binaryProfileAuditDigest === undefined ||
    !/^[0-9a-f]{64}$/.test(source.account.binaryProfileAuditDigest)
  ) {
    throw workerProtocolError("source_unavailable");
  }
}

/**
 * The class of one discovery work row. The row stores its media type and
 * profile as plain strings, so this is where a stored pair becomes a class
 * again; a pair outside the closed set is a stale observation, not a default.
 */
export function requireWorkBinaryClass(
  work: Doc<"workerDiscoveryWork">,
): (typeof BINARY_CLASSES)[BinaryParserProfileId] {
  if (!isBinaryClass(work.profileId, work.mediaType)) {
    throw workerProtocolError("stale_observation");
  }
  return BINARY_CLASSES[work.profileId];
}

export function requireStoredBinaryWork(
  current: Awaited<ReturnType<typeof requireCurrentDiscovery>>,
): void {
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
    item._id !== work.sourceItemId ||
    scan._id !== work.scanId ||
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
        new TextEncoder().encode(value).byteLength > 1_024,
    )
  ) {
    throw workerProtocolError("stale_observation");
  }
}

function requireIdentity(
  current: Awaited<ReturnType<typeof requireCurrentDiscovery>>,
  identity: ArchivedWorkIdentity,
): void {
  requireStoredBinaryWork(current);
  const { work, item, scan } = current;
  if (
    item._id !== identity.sourceItemId ||
    scan._id !== identity.scanId ||
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
  ) {
    throw workerProtocolError("stale_observation");
  }
}

export async function artifactBoundExtractionFingerprint(
  parserFingerprint: string,
  parserArtifactHash: string,
  extractionConfigurationFingerprint: string,
): Promise<string> {
  return digest("kith-parsed-extraction:v1", [
    parserFingerprint,
    parserArtifactHash,
    extractionConfigurationFingerprint,
  ]);
}

export async function validateAdmittedArchiveChain(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  current: Awaited<ReturnType<typeof requireCurrentDiscovery>>,
  ids: {
    sourceRevisionId: Id<"sourceRevisions">;
    parserArtifactId: Id<"sourceParserArtifacts">;
    sourceTextVersionId: Id<"sourceTextVersions">;
    processingGenerationId: Id<"processingGenerations">;
    ingestJobId: Id<"ingestJobs">;
    desiredProcessingEpoch: number;
    archiveSetDigest: string;
    parsedText?: ParsedTextDeclaration;
  },
): Promise<
  {
    originalPrimaryReceiptId: Id<"sourceArtifactArchiveReceipts">;
    originalPrimaryBindingEpoch: number;
    parserPrimaryReceiptId: Id<"sourceArtifactArchiveReceipts">;
    parserPrimaryBindingEpoch: number;
    parserBackupReceiptId: Id<"sourceArtifactArchiveReceipts">;
    parserBackupBindingEpoch: number;
  } & (
    | {
        originalBackupReceiptId: Id<"sourceArtifactArchiveReceipts">;
        originalBackupBindingEpoch: number;
        originalProviderReferenceId?: never;
        originalProviderBindingEpoch?: never;
      }
    | {
        originalProviderReferenceId: Id<"sourceProviderOriginalReferences">;
        originalProviderBindingEpoch: number;
        originalBackupReceiptId?: never;
        originalBackupBindingEpoch?: never;
      }
  )
> {
  requireStoredBinaryWork(current);
  const [revision, artifact, text, generation, job] = await Promise.all([
    ctx.db.get(ids.sourceRevisionId),
    ctx.db.get(ids.parserArtifactId),
    ctx.db.get(ids.sourceTextVersionId),
    ctx.db.get(ids.processingGenerationId),
    ctx.db.get(ids.ingestJobId),
  ]);
  if (
    !revision ||
    !artifact ||
    !text ||
    !generation ||
    !job ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== current.item._id ||
    revision.representation !== "archived_binary_v1" ||
    revision.contentHashAuthority !== "worker_asserted" ||
    revision.contentHash !== current.work.contentHash ||
    revision.byteLength !== current.work.byteLength ||
    revision.mediaType !== current.work.mediaType ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account._id ||
    artifact.sourceItemId !== current.item._id ||
    artifact.sourceRevisionId !== revision._id ||
    artifact.parserFingerprint !== current.work.parserFingerprint ||
    text.spaceId !== source.spaceId ||
    text.sourceRevisionId !== revision._id ||
    text.representation !== "parsed_pages_v1" ||
    text.parserArtifactId !== artifact._id ||
    generation.spaceId !== source.spaceId ||
    generation.sourceAccountId !== source.account._id ||
    generation.sourceItemId !== current.item._id ||
    generation.sourceRevisionId !== revision._id ||
    generation.sourceTextVersionId !== text._id ||
    generation.parserArtifactId !== artifact._id ||
    generation.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    generation.archiveSetDigest !== ids.archiveSetDigest ||
    generation.normalizedBundleDigest === undefined ||
    generation.expectedEventCount !== 0 ||
    generation.expectedObservationCount !== 0 ||
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account._id ||
    job.sourceItemId !== current.item._id ||
    job.sourceRevisionId !== revision._id ||
    job.processingGenerationId !== generation._id ||
    job.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    job.state !== generation.state ||
    job.actorUserId !== current.work.actorUserId ||
    job.actorCredentialId !== current.work.actorCredentialId ||
    job.admittedByUserId !== current.work.actorUserId ||
    job.admittedByCredentialId !== current.work.actorCredentialId ||
    job.workerManaged !== true ||
    job.workerProcessingMode !== "parsed_pages_v1" ||
    job.workerDiscoveryWorkId !== current.work._id ||
    job.workerObservationEpoch !== current.work.observationEpoch ||
    current.item.desiredRevisionId !== revision._id ||
    current.item.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    current.work.state !== "admitted" ||
    current.work.sourceRevisionId !== revision._id ||
    current.work.processingGenerationId !== generation._id ||
    current.work.ingestJobId !== job._id
  ) {
    throw workerProtocolError("scan_conflict");
  }
  let parsedText;
  try {
    parsedText = parseSourceTextRepresentation(text);
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  if (
    parsedText.kind !== "parsed_pages_v1" ||
    (ids.parsedText !== undefined &&
      (text.extractionFingerprint !== ids.parsedText.extractionFingerprint ||
        text.textHash !== ids.parsedText.textHash ||
        text.byteLength !== ids.parsedText.byteLength ||
        text.utf16Length !== ids.parsedText.utf16Length ||
        text.pageCount !== ids.parsedText.pageCount ||
        text.mappingManifestHash !== ids.parsedText.mappingManifestHash ||
        generation.normalizedBundleDigest !==
          ids.parsedText.normalizedBundleDigest ||
        generation.expectedPageCount !== ids.parsedText.pageCount ||
        generation.expectedEvidenceSpanCount !==
          ids.parsedText.expectedEvidenceSpanCount ||
        generation.expectedDocumentCount !==
          ids.parsedText.expectedDocumentCount ||
        generation.expectedChunkCount !== ids.parsedText.expectedChunkCount))
  ) {
    throw workerProtocolError("scan_conflict");
  }
  const expectedExtraction = await artifactBoundExtractionFingerprint(
    artifact.parserFingerprint,
    artifact.outputHash,
    current.work.extractionConfigurationFingerprint!,
  );
  const expectedProcessing = await digestProcessingConfiguration({
    extractionFingerprint: expectedExtraction,
    extractorFingerprint: current.work.extractorFingerprint,
    recordSchemaFingerprint: current.work.recordSchemaFingerprint,
    normalizationFingerprint: current.work.normalizationFingerprint,
    chunkerFingerprint: current.work.chunkerFingerprint,
    correctionRevision: current.work.correctionRevision!,
  });
  if (
    text.extractionFingerprint !== expectedExtraction ||
    generation.extractionFingerprint !== expectedExtraction ||
    generation.processingFingerprint !== expectedProcessing ||
    generation.extractorFingerprint !== current.work.extractorFingerprint ||
    generation.recordSchemaFingerprint !==
      current.work.recordSchemaFingerprint ||
    generation.normalizationFingerprint !==
      current.work.normalizationFingerprint ||
    generation.chunkerFingerprint !== current.work.chunkerFingerprint ||
    generation.correctionRevision !== current.work.correctionRevision
  ) {
    throw workerProtocolError("scan_conflict");
  }
  if (
    (generation.originalProviderReferenceId === undefined) !==
    (generation.originalProviderBindingEpoch === undefined)
  )
    throw workerProtocolError("scan_conflict");
  const providerGeneration =
    generation.originalProviderReferenceId === undefined
      ? null
      : {
          reference: await loadProviderOriginalReference(ctx, {
            referenceId: generation.originalProviderReferenceId,
            spaceId: source.spaceId,
            sourceAccountId: source.account._id,
            sourceItemId: current.item._id,
            sourceRevisionId: revision._id,
            expectedSourceContentHash: revision.contentHash,
            expectedSourceByteLength: revision.byteLength,
          }),
          bindingEpoch: generation.originalProviderBindingEpoch,
        };
  const [originalPrimary, originalBackup, parserPrimary, parserBackup] =
    await Promise.all([
      loadCurrentArchiveBinding(ctx, {
        spaceId: source.spaceId,
        sourceAccountId: source.account._id,
        sourceItemId: current.item._id,
        sourceRevisionId: revision._id,
        subjectKind: "original_bytes",
        copyRole: "primary",
      }),
      loadCurrentArchiveBinding(ctx, {
        spaceId: source.spaceId,
        sourceAccountId: source.account._id,
        sourceItemId: current.item._id,
        sourceRevisionId: revision._id,
        subjectKind: "original_bytes",
        copyRole: "independent_backup",
      }),
      loadCurrentArchiveBinding(ctx, {
        spaceId: source.spaceId,
        sourceAccountId: source.account._id,
        sourceItemId: current.item._id,
        sourceRevisionId: revision._id,
        parserArtifactId: artifact._id,
        subjectKind: "parser_output",
        copyRole: "primary",
      }),
      loadCurrentArchiveBinding(ctx, {
        spaceId: source.spaceId,
        sourceAccountId: source.account._id,
        sourceItemId: current.item._id,
        sourceRevisionId: revision._id,
        parserArtifactId: artifact._id,
        subjectKind: "parser_output",
        copyRole: "independent_backup",
      }),
    ]);
  if (
    !originalPrimary ||
    (!originalBackup && !providerGeneration) ||
    (originalBackup && providerGeneration) ||
    !parserPrimary ||
    !parserBackup
  ) {
    throw workerProtocolError("scan_conflict");
  }
  if (originalBackup)
    requireIndependentArchivePair(
      originalPrimary.receipt,
      originalBackup.receipt,
    );
  requireIndependentArchivePair(parserPrimary.receipt, parserBackup.receipt);
  const archiveSetDigest = originalBackup
    ? await digest("archive-set:v1", [
        ...[originalPrimary, originalBackup, parserPrimary, parserBackup].map(
          ({ receipt, binding }) => [
            receipt.subjectKind,
            receipt.copyRole,
            receipt._id,
            binding.bindingEpoch,
          ],
        ),
      ])
    : await digest("recovery-set:provider-original:v1", [
        [
          originalPrimary.receipt.subjectKind,
          originalPrimary.receipt.copyRole,
          originalPrimary.receipt._id,
          originalPrimary.binding.bindingEpoch,
        ],
        [
          "provider_original",
          providerGeneration!.reference._id,
          providerGeneration!.bindingEpoch,
        ],
        ...[parserPrimary, parserBackup].map(({ receipt, binding }) => [
          receipt.subjectKind,
          receipt.copyRole,
          receipt._id,
          binding.bindingEpoch,
        ]),
      ]);
  if (
    archiveSetDigest !== ids.archiveSetDigest ||
    generation.originalPrimaryReceiptId !== originalPrimary.receipt._id ||
    (originalBackup
      ? generation.originalBackupReceiptId !== originalBackup.receipt._id ||
        generation.originalProviderReferenceId !== undefined ||
        generation.originalProviderBindingEpoch !== undefined
      : generation.originalBackupReceiptId !== undefined ||
        generation.originalProviderReferenceId !==
          providerGeneration!.reference._id ||
        generation.originalProviderBindingEpoch !==
          providerGeneration!.bindingEpoch) ||
    generation.parserPrimaryReceiptId !== parserPrimary.receipt._id ||
    generation.parserBackupReceiptId !== parserBackup.receipt._id
  ) {
    throw workerProtocolError("scan_conflict");
  }
  const common = {
    originalPrimaryReceiptId: originalPrimary.receipt._id,
    originalPrimaryBindingEpoch: originalPrimary.binding.bindingEpoch,
    parserPrimaryReceiptId: parserPrimary.receipt._id,
    parserPrimaryBindingEpoch: parserPrimary.binding.bindingEpoch,
    parserBackupReceiptId: parserBackup.receipt._id,
    parserBackupBindingEpoch: parserBackup.binding.bindingEpoch,
  };
  return originalBackup
    ? {
        ...common,
        originalBackupReceiptId: originalBackup.receipt._id,
        originalBackupBindingEpoch: originalBackup.binding.bindingEpoch,
      }
    : {
        ...common,
        originalProviderReferenceId: providerGeneration!.reference._id,
        originalProviderBindingEpoch: providerGeneration!.bindingEpoch!,
      };
}

async function resolveCurrentArchivedWork(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  identity: ArchivedWorkIdentity,
) {
  const itemId = ctx.db.normalizeId("sourceItems", identity.sourceItemId);
  if (!itemId) throw workerProtocolError("invalid_request");
  const rows = await ctx.db
    .query("workerDiscoveryWork")
    .withIndex("by_sourceItemId_and_observationEpoch", (q) =>
      q
        .eq("sourceItemId", itemId)
        .eq("observationEpoch", identity.observationEpoch),
    )
    .take(2);
  if (rows.length !== 1) throw workerProtocolError("stale_observation");
  const current = await requireCurrentDiscovery(ctx, source, rows[0]!._id);
  requireIdentity(current, identity);
  return current;
}

export async function preflightArchivedDiscovery(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.preflightArchived" }>,
  now: number,
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
    current.work.leaseToken !== undefined ||
    current.work.leaseExpiresAt !== undefined ||
    current.work.leaseOwnerCredentialId !== undefined ||
    !Number.isSafeInteger(current.work.attempts) ||
    current.work.attempts < 0 ||
    current.work.attempts >= 8 ||
    (current.work.nextAttemptAt !== undefined &&
      current.work.nextAttemptAt > now)
  ) {
    throw workerProtocolError("stale_observation");
  }
  if (current.work.expectedDesiredProcessingEpoch === undefined) {
    throw workerProtocolError("scan_conflict");
  }
  return {
    operation: "discovery.preflightArchived",
    sourceItemId: current.item._id,
    workId: current.work._id,
    expectedDesiredProcessingEpoch: current.work.expectedDesiredProcessingEpoch,
    archiveIntentDigest: request.archiveIntentDigest,
  };
}

/**
 * A document-level parser failure (conversion_failed, page_limit_exceeded,
 * bundle_too_large, conversion_output_invalid): the worker never got far
 * enough to admit this file, so there is no ingestJobs row for jobs.fail /
 * jobs.failParsed to act on yet. This records the failure directly against
 * the file's `workerDiscoveryWork` row (the same lease/attempt record
 * `discovery.reserveArchived` already claims, and which already permits
 * reclaiming a `failed` row while `retryable`) and, like `failJob`, marks
 * the file's `sourceInventory` row `parse_failed` with the failure class so
 * `list_review_queue` can count and explain it. Unlike `failJob`, this marks
 * the row on every reported failure rather than only the final one: a
 * manual backfill pass may not retry for a long time, and the mark is
 * purely additive (self-healing back to `extraction_pending` the moment a
 * later attempt activates, via the existing `activateGeneration` ->
 * `clearInventoryParseFailed` path).
 *
 * ponytail: no request-id receipt here (unlike reserveArchivedDiscovery),
 * so a retried report after a lost response can double-count `attempts`.
 * Acceptable for a best-effort visibility signal bounded by
 * MAX_WORKER_DISCOVERY_ATTEMPTS; the pipeline's own local catalog is what
 * actually stops it from retrying forever. Add a receipt if double-counting
 * ever causes a real problem.
 */
export async function failArchivedDiscovery(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.failArchived" }>,
  now: number,
): Promise<WorkerArchivedFailResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const current = await resolveCurrentArchivedWork(
    ctx,
    source,
    request.identity,
  );
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const attempts = safeAdd(current.work.attempts, 1);
  const retryable = attempts < MAX_WORKER_DISCOVERY_ATTEMPTS;
  await ctx.db.patch(current.work._id, {
    state: "failed",
    attempts,
    failureCode: request.failureCode,
    retryable,
    leaseToken: undefined,
    leaseOwnerCredentialId: undefined,
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
  });
  await markInventoryParseFailed(ctx, {
    sourceItemId: current.item._id,
    failureClass: request.failureCode,
  });
  return {
    operation: "discovery.failArchived",
    sourceItemId: current.item._id,
    workId: current.work._id,
    state: "failed",
    retryable,
    failureCode: request.failureCode,
  };
}

export async function reserveArchivedDiscovery(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "discovery.reserveArchived" }>,
  leaseToken: string,
  now: number,
): Promise<WorkerArchivedReserveResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const requestDigest = await digest("worker-archived-reserve:v1", [
    source.account._id,
    request.requestId,
    request.identity,
  ]);
  const receipts = await ctx.db
    .query("workerReservationReceipts")
    .withIndex("by_sourceAccountId_and_kind_and_requestId", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("kind", "archived_discovery")
        .eq("requestId", request.requestId),
    )
    .take(2);
  if (receipts.length > 1) throw workerProtocolError("scan_conflict");
  if (receipts[0]) {
    const receipt = receipts[0];
    if (
      receipt.spaceId !== source.spaceId ||
      receipt.actorUserId !== source.principal.userId ||
      receipt.actorCredentialId !== source.principal.credentialId
    ) {
      throw workerProtocolError("not_found");
    }
    if (receipt.requestDigest !== requestDigest) {
      throw workerProtocolError("request_conflict");
    }
    if (receipt.targetCount !== 1 || receipt.expiresAt <= now) {
      throw workerProtocolError("reservation_expired");
    }
    const targets = await ctx.db
      .query("workerReservationTargets")
      .withIndex("by_receiptId_and_ordinal", (q) =>
        q.eq("receiptId", receipt._id),
      )
      .take(2);
    const target = targets[0];
    if (
      targets.length !== 1 ||
      !target ||
      target.spaceId !== source.spaceId ||
      target.sourceAccountId !== source.account._id ||
      target.discoveryWorkId === undefined
    ) {
      throw workerProtocolError("scan_conflict");
    }
    const current = await resolveCurrentArchivedWork(
      ctx,
      source,
      request.identity,
    );
    if (
      current.work._id !== target.discoveryWorkId ||
      current.work.state !== "leased" ||
      current.work.leaseEpoch !== target.leaseEpoch ||
      current.work.leaseToken !== target.leaseToken ||
      current.work.leaseExpiresAt !== target.leaseExpiresAt ||
      current.work.leaseOwnerCredentialId !== source.principal.credentialId
    ) {
      throw workerProtocolError("lease_conflict");
    }
    return {
      operation: "discovery.reserveArchived",
      workId: current.work._id,
      sourceItemId: current.item._id,
      observationEpoch: current.work.observationEpoch,
      processingEpoch: current.work.processingEpoch,
      leaseEpoch: target.leaseEpoch,
      leaseToken: target.leaseToken,
      leaseExpiresAt: target.leaseExpiresAt,
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
      work.leaseToken === undefined &&
      work.leaseExpiresAt === undefined &&
      work.leaseOwnerCredentialId === undefined &&
      (work.nextAttemptAt === undefined || work.nextAttemptAt <= now)) ||
    (work.state === "leased" &&
      work.leaseToken !== undefined &&
      work.leaseExpiresAt !== undefined &&
      work.leaseOwnerCredentialId !== undefined &&
      work.leaseExpiresAt <= now);
  if (
    !claimable ||
    !Number.isSafeInteger(work.leaseEpoch) ||
    work.leaseEpoch < 0 ||
    !Number.isSafeInteger(work.attempts) ||
    work.attempts < 0 ||
    work.attempts >= 8
  ) {
    throw workerProtocolError("lease_conflict");
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const leaseEpoch = safeAdd(work.leaseEpoch, 1);
  const leaseExpiresAt = safeAdd(now, WORKER_DISCOVERY_LEASE_MS);
  await ctx.db.patch(work._id, {
    state: "leased",
    attempts: safeAdd(work.attempts, 1),
    leaseEpoch,
    leaseToken,
    leaseOwnerCredentialId: source.principal.credentialId,
    leaseExpiresAt,
    nextAttemptAt: undefined,
  });
  const receiptId = await ctx.db.insert("workerReservationReceipts", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    kind: "archived_discovery",
    requestId: request.requestId,
    requestDigest,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    targetCount: 1,
    createdAt: now,
    expiresAt: leaseExpiresAt,
    retireAt: safeAdd(now, WORKER_OPERATION_RECEIPT_MS),
  });
  await ctx.db.insert("workerReservationTargets", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    sourceItemId: work.sourceItemId,
    receiptId,
    ordinal: 0,
    discoveryWorkId: work._id,
    leaseEpoch,
    leaseToken,
    leaseExpiresAt,
  });
  return {
    operation: "discovery.reserveArchived",
    workId: work._id,
    sourceItemId: work.sourceItemId,
    observationEpoch: work.observationEpoch,
    processingEpoch: work.processingEpoch,
    leaseEpoch,
    leaseToken,
    leaseExpiresAt,
    reused: false,
  };
}

export async function lookupArchivedAdmission(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<
    WorkerRequest,
    { operation: "discovery.lookupArchivedAdmission" }
  >,
): Promise<WorkerArchivedLookupResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const current = await resolveCurrentArchivedWork(
    ctx,
    source,
    request.identity,
  );
  const revisions = await ctx.db
    .query("sourceRevisions")
    .withIndex("by_sourceItemId_and_contentHash", (q) =>
      q
        .eq("sourceItemId", current.item._id)
        .eq("contentHash", current.work.contentHash),
    )
    .take(2);
  if (revisions.length > 1) throw workerProtocolError("scan_conflict");
  const revision = revisions[0];
  if (!revision) {
    return {
      operation: "discovery.lookupArchivedAdmission",
      mode: request.lookup.mode,
      found: false,
    };
  }
  if (
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== current.item._id ||
    revision.representation !== "archived_binary_v1" ||
    revision.contentHashAuthority !== "worker_asserted" ||
    revision.contentHash !== current.work.contentHash ||
    revision.byteLength !== current.work.byteLength ||
    revision.mediaType !== current.work.mediaType ||
    revision.inlineText !== undefined ||
    revision.archiveRef !== undefined
  ) {
    throw workerProtocolError("scan_conflict");
  }
  const [originalPrimary, originalBackup, providerOriginal] = await Promise.all(
    [
      loadCurrentArchiveBinding(ctx, {
        spaceId: source.spaceId,
        sourceAccountId: source.account._id,
        sourceItemId: current.item._id,
        sourceRevisionId: revision._id,
        subjectKind: "original_bytes",
        copyRole: "primary",
      }),
      loadCurrentArchiveBinding(ctx, {
        spaceId: source.spaceId,
        sourceAccountId: source.account._id,
        sourceItemId: current.item._id,
        sourceRevisionId: revision._id,
        subjectKind: "original_bytes",
        copyRole: "independent_backup",
      }),
      loadProviderOriginalBinding(ctx, revision._id),
    ],
  );
  if (
    !originalPrimary ||
    (!originalBackup && !providerOriginal) ||
    (originalBackup && providerOriginal)
  ) {
    return {
      operation: "discovery.lookupArchivedAdmission",
      mode: request.lookup.mode,
      found: false,
    };
  }
  if (originalBackup)
    requireIndependentArchivePair(
      originalPrimary.receipt,
      originalBackup.receipt,
    );
  if (request.lookup.mode === "original") {
    const common = {
      operation: "discovery.lookupArchivedAdmission",
      mode: "original",
      found: true,
      sourceRevisionId: revision._id,
      originalPrimaryReceiptId: originalPrimary.receipt._id,
      originalPrimaryBindingEpoch: originalPrimary.binding.bindingEpoch,
    } as const;
    return originalBackup
      ? {
          ...common,
          originalBackupReceiptId: originalBackup.receipt._id,
          originalBackupBindingEpoch: originalBackup.binding.bindingEpoch,
        }
      : {
          ...common,
          originalProviderReferenceId: providerOriginal!.reference._id,
          originalProviderBindingEpoch: providerOriginal!.binding.bindingEpoch,
        };
  }
  const processingLookup = request.lookup;
  const artifacts = await ctx.db
    .query("sourceParserArtifacts")
    .withIndex("by_sourceAccountId_and_clientArtifactId", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("clientArtifactId", processingLookup.clientArtifactId),
    )
    .take(2);
  if (artifacts.length > 1) throw workerProtocolError("scan_conflict");
  const artifact = artifacts[0];
  if (
    !artifact ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account._id ||
    artifact.sourceItemId !== current.item._id ||
    artifact.sourceRevisionId !== revision._id ||
    artifact.parserFingerprint !== current.work.parserFingerprint ||
    artifact.outputHash !== processingLookup.parserOutputHash ||
    artifact.outputByteLength !== processingLookup.parserOutputByteLength ||
    artifact.outputMediaType !== processingLookup.parserOutputMediaType
  ) {
    return {
      operation: "discovery.lookupArchivedAdmission",
      mode: "processing",
      found: false,
    };
  }
  const expectedExtractionFingerprint =
    await artifactBoundExtractionFingerprint(
      current.work.parserFingerprint!,
      artifact.outputHash,
      current.work.extractionConfigurationFingerprint!,
    );
  if (
    processingLookup.parsedText.extractionFingerprint !==
    expectedExtractionFingerprint
  ) {
    throw workerProtocolError("request_conflict");
  }
  const [parserPrimary, parserBackup, textRows] = await Promise.all([
    loadCurrentArchiveBinding(ctx, {
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      sourceItemId: current.item._id,
      sourceRevisionId: revision._id,
      parserArtifactId: artifact._id,
      subjectKind: "parser_output",
      copyRole: "primary",
    }),
    loadCurrentArchiveBinding(ctx, {
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      sourceItemId: current.item._id,
      sourceRevisionId: revision._id,
      parserArtifactId: artifact._id,
      subjectKind: "parser_output",
      copyRole: "independent_backup",
    }),
    ctx.db
      .query("sourceTextVersions")
      .withIndex("by_sourceRevisionId_and_extractionFingerprint", (q) =>
        q
          .eq("sourceRevisionId", revision._id)
          .eq(
            "extractionFingerprint",
            processingLookup.parsedText.extractionFingerprint,
          ),
      )
      .take(2),
  ]);
  if (!parserPrimary || !parserBackup || textRows.length !== 1) {
    return {
      operation: "discovery.lookupArchivedAdmission",
      mode: "processing",
      found: false,
    };
  }
  requireIndependentArchivePair(parserPrimary.receipt, parserBackup.receipt);
  const text = textRows[0]!;
  if (
    text.spaceId !== source.spaceId ||
    text.parserArtifactId !== artifact._id ||
    text.representation !== "parsed_pages_v1" ||
    text.textHash !== processingLookup.parsedText.textHash ||
    text.byteLength !== processingLookup.parsedText.byteLength ||
    text.utf16Length !== processingLookup.parsedText.utf16Length ||
    text.pageCount !== processingLookup.parsedText.pageCount ||
    text.mappingManifestHash !== processingLookup.parsedText.mappingManifestHash
  ) {
    throw workerProtocolError("request_conflict");
  }
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: processingLookup.parsedText.extractionFingerprint,
    extractorFingerprint: current.work.extractorFingerprint,
    recordSchemaFingerprint: current.work.recordSchemaFingerprint,
    normalizationFingerprint: current.work.normalizationFingerprint,
    chunkerFingerprint: current.work.chunkerFingerprint,
    correctionRevision: current.work.correctionRevision!,
  });
  const generations = await ctx.db
    .query("processingGenerations")
    .withIndex("by_sourceRevisionId_and_processingFingerprint", (q) =>
      q
        .eq("sourceRevisionId", revision._id)
        .eq("processingFingerprint", processingFingerprint),
    )
    .take(2);
  if (generations.length !== 1) {
    return {
      operation: "discovery.lookupArchivedAdmission",
      mode: "processing",
      found: false,
    };
  }
  const generation = generations[0]!;
  if (
    (generation.originalProviderReferenceId === undefined) !==
    (generation.originalProviderBindingEpoch === undefined)
  )
    throw workerProtocolError("scan_conflict");
  const generationProvider =
    generation.originalProviderReferenceId === undefined
      ? null
      : {
          reference: await loadProviderOriginalReference(ctx, {
            referenceId: generation.originalProviderReferenceId,
            spaceId: source.spaceId,
            sourceAccountId: source.account._id,
            sourceItemId: current.item._id,
            sourceRevisionId: revision._id,
            expectedSourceContentHash: revision.contentHash,
            expectedSourceByteLength: revision.byteLength,
          }),
          bindingEpoch: generation.originalProviderBindingEpoch,
        };
  if (
    (!originalBackup && !generationProvider) ||
    (originalBackup && generationProvider)
  )
    throw workerProtocolError("scan_conflict");
  const jobs = await ctx.db
    .query("ingestJobs")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", generation._id),
    )
    .take(2);
  const job = jobs[0];
  const archiveSetDigest = originalBackup
    ? await digest("archive-set:v1", [
        ...[originalPrimary, originalBackup, parserPrimary, parserBackup].map(
          ({ receipt, binding }) => [
            receipt.subjectKind,
            receipt.copyRole,
            receipt._id,
            binding.bindingEpoch,
          ],
        ),
      ])
    : await digest("recovery-set:provider-original:v1", [
        [
          "original_bytes",
          "primary",
          originalPrimary.receipt._id,
          originalPrimary.binding.bindingEpoch,
        ],
        [
          "provider_original",
          generationProvider!.reference._id,
          generationProvider!.bindingEpoch,
        ],
        ...[parserPrimary, parserBackup].map(({ receipt, binding }) => [
          receipt.subjectKind,
          receipt.copyRole,
          receipt._id,
          binding.bindingEpoch,
        ]),
      ]);
  if (
    jobs.length !== 1 ||
    !job ||
    generation.spaceId !== source.spaceId ||
    generation.sourceAccountId !== source.account._id ||
    generation.sourceItemId !== current.item._id ||
    generation.sourceTextVersionId !== text._id ||
    generation.parserArtifactId !== artifact._id ||
    generation.normalizedBundleDigest !==
      processingLookup.parsedText.normalizedBundleDigest ||
    generation.expectedPageCount !== processingLookup.parsedText.pageCount ||
    generation.expectedEvidenceSpanCount !==
      processingLookup.parsedText.expectedEvidenceSpanCount ||
    generation.expectedDocumentCount !==
      processingLookup.parsedText.expectedDocumentCount ||
    generation.expectedChunkCount !==
      processingLookup.parsedText.expectedChunkCount ||
    generation.archiveSetDigest !== archiveSetDigest ||
    generation.originalPrimaryReceiptId !== originalPrimary.receipt._id ||
    (originalBackup
      ? generation.originalBackupReceiptId !== originalBackup.receipt._id ||
        generation.originalProviderReferenceId !== undefined
      : generation.originalBackupReceiptId !== undefined ||
        generation.originalProviderReferenceId !==
          generationProvider!.reference._id ||
        generation.originalProviderBindingEpoch !==
          generationProvider!.bindingEpoch) ||
    generation.parserPrimaryReceiptId !== parserPrimary.receipt._id ||
    generation.parserBackupReceiptId !== parserBackup.receipt._id ||
    job.workerProcessingMode !== "parsed_pages_v1" ||
    job.workerDiscoveryWorkId !== current.work._id ||
    current.work.state !== "admitted" ||
    current.work.sourceRevisionId !== revision._id ||
    current.work.processingGenerationId !== generation._id ||
    current.work.ingestJobId !== job._id
  ) {
    throw workerProtocolError("scan_conflict");
  }
  await validateAdmittedArchiveChain(ctx, source, current, {
    sourceRevisionId: revision._id,
    parserArtifactId: artifact._id,
    sourceTextVersionId: text._id,
    processingGenerationId: generation._id,
    ingestJobId: job._id,
    desiredProcessingEpoch: generation.desiredProcessingEpoch,
    archiveSetDigest,
    parsedText: processingLookup.parsedText,
  });
  const common = {
    operation: "discovery.lookupArchivedAdmission",
    mode: "processing",
    found: true,
    sourceRevisionId: revision._id,
    parserArtifactId: artifact._id,
    sourceTextVersionId: text._id,
    processingGenerationId: generation._id,
    ingestJobId: job._id,
    desiredProcessingEpoch: generation.desiredProcessingEpoch,
    archiveSetDigest,
    originalPrimaryReceiptId: originalPrimary.receipt._id,
    originalPrimaryBindingEpoch: originalPrimary.binding.bindingEpoch,
    parserPrimaryReceiptId: parserPrimary.receipt._id,
    parserPrimaryBindingEpoch: parserPrimary.binding.bindingEpoch,
    parserBackupReceiptId: parserBackup.receipt._id,
    parserBackupBindingEpoch: parserBackup.binding.bindingEpoch,
  } as const;
  return originalBackup
    ? {
        ...common,
        originalBackupReceiptId: originalBackup.receipt._id,
        originalBackupBindingEpoch: originalBackup.binding.bindingEpoch,
      }
    : {
        ...common,
        originalProviderReferenceId: generationProvider!.reference._id,
        originalProviderBindingEpoch: generationProvider!.bindingEpoch!,
      };
}

async function resolveParserArtifact(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  current: Awaited<ReturnType<typeof requireCurrentDiscovery>>,
  revision: Doc<"sourceRevisions">,
  request: ArchivedRequest,
): Promise<Doc<"sourceParserArtifacts">> {
  // The parser output media type belongs to the class, so a docling artifact
  // can never stand in for a workbook's rendered grid, or the other way round.
  const expectedOutputMediaType = requireWorkBinaryClass(
    current.work,
  ).parserOutputMediaType;
  if (request.parserArtifact.kind === "create") {
    if (request.parserArtifact.outputMediaType !== expectedOutputMediaType) {
      throw workerProtocolError("stale_observation");
    }
    return createOrGetParserArtifact(ctx, {
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      sourceItemId: current.item._id,
      sourceRevisionId: revision._id,
      clientArtifactId: request.parserArtifact.clientArtifactId,
      parserFingerprint: current.work.parserFingerprint!,
      outputHash: request.parserArtifact.outputHash,
      outputByteLength: request.parserArtifact.outputByteLength,
      outputMediaType: request.parserArtifact.outputMediaType,
      userId: source.principal.userId,
      actorCredentialId: source.principal.credentialId,
      createdAt: request.parserArtifact.createdAt,
    });
  }
  const id = ctx.db.normalizeId(
    "sourceParserArtifacts",
    request.parserArtifact.parserArtifactId,
  );
  const artifact = id ? await ctx.db.get(id) : null;
  if (
    !artifact ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account._id ||
    artifact.sourceItemId !== current.item._id ||
    artifact.sourceRevisionId !== revision._id ||
    artifact.parserFingerprint !== current.work.parserFingerprint ||
    artifact.outputMediaType !== expectedOutputMediaType
  ) {
    throw workerProtocolError("stale_observation");
  }
  return artifact;
}

async function resolveArchive(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  current: Awaited<ReturnType<typeof requireCurrentDiscovery>>,
  revision: Doc<"sourceRevisions">,
  artifact: Doc<"sourceParserArtifacts">,
  selection: ArchiveReceiptSelection,
  admissionDigest: string,
  now: number,
) {
  let receipt: Doc<"sourceArtifactArchiveReceipts"> | null;
  if (selection.kind === "create") {
    const parser = selection.subjectKind === "parser_output";
    receipt = await createOrGetArchiveReceipt(ctx, {
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      sourceItemId: current.item._id,
      sourceRevisionId: revision._id,
      ...(parser ? { parserArtifactId: artifact._id } : {}),
      subjectKind: selection.subjectKind,
      copyRole: selection.copyRole,
      clientReceiptId: selection.clientReceiptId,
      requestDigest: await digest("archive-admission-receipt:v1", [
        admissionDigest,
        selection.subjectKind,
        selection.copyRole,
        selection.clientReceiptId,
      ]),
      archiveProfileFingerprint: selection.archiveProfileFingerprint,
      archiveIdentityFingerprint: selection.archiveIdentityFingerprint,
      recipientFingerprint: selection.recipientFingerprint,
      repositoryKeyDomainFingerprint: selection.repositoryKeyDomainFingerprint,
      storageFailureDomainFingerprint:
        selection.storageFailureDomainFingerprint,
      archiveObjectId: selection.archiveObjectId,
      plaintextHash: parser ? artifact.outputHash : revision.contentHash,
      plaintextByteLength: parser
        ? artifact.outputByteLength
        : revision.byteLength,
      plaintextMediaType: parser
        ? artifact.outputMediaType
        : revision.mediaType,
      ciphertextHash: selection.ciphertextHash,
      ciphertextByteLength: selection.ciphertextByteLength,
      readbackVerifiedAt: selection.readbackVerifiedAt,
      userId: source.principal.userId,
      actorCredentialId: source.principal.credentialId,
      createdAt: selection.createdAt,
    });
  } else {
    const id = ctx.db.normalizeId(
      "sourceArtifactArchiveReceipts",
      selection.receiptId,
    );
    receipt = id ? await ctx.db.get(id) : null;
  }
  if (
    !receipt ||
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account._id ||
    receipt.sourceItemId !== current.item._id ||
    receipt.sourceRevisionId !== revision._id ||
    receipt.subjectKind !== selection.subjectKind ||
    receipt.copyRole !== selection.copyRole ||
    receipt.parserArtifactId !==
      (selection.subjectKind === "parser_output" ? artifact._id : undefined)
  ) {
    throw workerProtocolError("stale_observation");
  }
  const binding = await bindInitialArchiveReceipt(ctx, {
    receipt,
    ...(selection.kind === "existing"
      ? { expectedBindingEpoch: selection.bindingEpoch }
      : {}),
    userId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    now,
  });
  return { receipt, binding };
}

export async function admitArchivedDiscovery(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: ArchivedRequest,
  now: number,
): Promise<WorkerArchivedAdmitResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const workId = ctx.db.normalizeId("workerDiscoveryWork", request.workId);
  if (!workId) throw workerProtocolError("invalid_request");
  const leaseTokenHash = await sha256Utf8(request.leaseToken);
  const requestDigest = await digest("worker-discovery-admit-archived:v1", [
    source.account._id,
    request,
    leaseTokenHash,
  ]);
  const priors = await ctx.db
    .query("workerBinaryOperationReceipts")
    .withIndex("by_source_operation_request", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("operation", "discovery_admit_archived")
        .eq("requestId", request.requestId),
    )
    .take(2);
  if (priors.length > 1) throw workerProtocolError("scan_conflict");
  const prior = priors[0];
  if (prior) {
    if (
      prior.spaceId !== source.spaceId ||
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
    if (
      prior.phase !== "completed" ||
      prior.sourceRevisionId === undefined ||
      prior.parserArtifactId === undefined ||
      prior.sourceTextVersionId === undefined ||
      prior.processingGenerationId === undefined ||
      prior.ingestJobId === undefined ||
      prior.desiredProcessingEpoch === undefined ||
      prior.archiveSetDigest === undefined
    ) {
      throw workerProtocolError("scan_conflict");
    }
    const current = await requireCurrentDiscovery(ctx, source, workId);
    if (
      prior.sourceItemId !== current.item._id ||
      current.work.state !== "admitted" ||
      current.work.sourceRevisionId !== prior.sourceRevisionId ||
      current.work.processingGenerationId !== prior.processingGenerationId ||
      current.work.ingestJobId !== prior.ingestJobId
    ) {
      throw workerProtocolError("stale_observation");
    }
    const archiveReceipts = await validateAdmittedArchiveChain(
      ctx,
      source,
      current,
      {
        sourceRevisionId: prior.sourceRevisionId,
        parserArtifactId: prior.parserArtifactId,
        sourceTextVersionId: prior.sourceTextVersionId,
        processingGenerationId: prior.processingGenerationId,
        ingestJobId: prior.ingestJobId,
        desiredProcessingEpoch: prior.desiredProcessingEpoch,
        archiveSetDigest: prior.archiveSetDigest,
        parsedText: request.parsedText,
      },
    );
    if (
      prior.originalProviderReferenceId !==
        archiveReceipts.originalProviderReferenceId ||
      prior.originalProviderBindingEpoch !==
        archiveReceipts.originalProviderBindingEpoch
    )
      throw workerProtocolError("scan_conflict");
    return {
      operation: "discovery.admitArchived",
      workId,
      sourceItemId: prior.sourceItemId,
      sourceRevisionId: prior.sourceRevisionId,
      parserArtifactId: prior.parserArtifactId,
      sourceTextVersionId: prior.sourceTextVersionId,
      processingGenerationId: prior.processingGenerationId,
      ingestJobId: prior.ingestJobId,
      desiredProcessingEpoch: prior.desiredProcessingEpoch,
      archiveSetDigest: prior.archiveSetDigest,
      ...archiveReceipts,
      state: "admitted",
      reused: true,
    };
  }
  const current = await requireCurrentDiscovery(ctx, source, workId);
  requireStoredBinaryWork(current);
  if (
    current.work.state !== "leased" ||
    current.work.leaseOwnerCredentialId !== source.principal.credentialId ||
    current.work.leaseEpoch !== request.leaseEpoch ||
    current.work.leaseToken !== request.leaseToken ||
    current.work.leaseExpiresAt === undefined ||
    current.work.leaseExpiresAt <= now ||
    current.work.contentRepresentation !== "archived_binary_v1" ||
    current.work.expectedDesiredProcessingEpoch === undefined ||
    current.work.parserFingerprint === undefined ||
    current.work.correctionRevision === undefined
  ) {
    throw workerProtocolError("lease_conflict");
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const pendingId = await ctx.db.insert("workerBinaryOperationReceipts", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    sourceItemId: current.item._id,
    discoveryWorkId: current.work._id,
    operation: "discovery_admit_archived",
    phase: "pending",
    requestId: request.requestId,
    requestDigest,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    leaseEpoch: request.leaseEpoch,
    leaseTokenHash,
    createdAt: now,
    retireAt: safeAdd(now, WORKER_OPERATION_RECEIPT_MS),
  });
  try {
    const revision = await createOrGetArchivedRevision(ctx, {
      spaceId: source.spaceId,
      sourceItemId: current.item._id,
      contentHash: current.work.contentHash,
      byteLength: current.work.byteLength,
      mediaType: requireWorkBinaryClass(current.work).mediaType,
      capturedAt: current.work.capturedAt,
      userId: current.work.actorUserId,
    });
    const artifact = await resolveParserArtifact(
      ctx,
      source,
      current,
      revision,
      request,
    );
    const expectedExtractionFingerprint =
      await artifactBoundExtractionFingerprint(
        current.work.parserFingerprint,
        artifact.outputHash,
        current.work.extractionConfigurationFingerprint!,
      );
    if (
      request.parsedText.extractionFingerprint !== expectedExtractionFingerprint
    ) {
      throw workerProtocolError("stale_observation");
    }
    const selections = [];
    for (const selection of request.archives) {
      selections.push(
        await resolveArchive(
          ctx,
          source,
          current,
          revision,
          artifact,
          selection,
          requestDigest,
          now,
        ),
      );
    }
    const byRole = new Map(
      selections.map((value) => [
        `${value.receipt.subjectKind}:${value.receipt.copyRole}`,
        value,
      ]),
    );
    const originalPrimary = byRole.get("original_bytes:primary")!;
    const originalBackup = byRole.get("original_bytes:independent_backup");
    const parserPrimary = byRole.get("parser_output:primary")!;
    const parserBackup = byRole.get("parser_output:independent_backup")!;
    if (
      request.providerOriginal &&
      (request.providerOriginal.sourceContentHash !== revision.contentHash ||
        request.providerOriginal.sourceByteLength !== revision.byteLength)
    )
      throw workerProtocolError("stale_observation");
    const providerOriginal = request.providerOriginal
      ? await createAndBindProviderOriginal(ctx, {
          spaceId: source.spaceId,
          sourceAccountId: source.account._id,
          sourceItemId: current.item._id,
          sourceRevisionId: revision._id,
          declaration: request.providerOriginal,
          requestDigest,
          userId: source.principal.userId,
          actorCredentialId: source.principal.credentialId,
          now,
        })
      : null;
    if (
      (!originalBackup && !providerOriginal) ||
      (originalBackup && providerOriginal)
    )
      throw workerProtocolError("invalid_request");
    if (originalBackup)
      requireIndependentArchivePair(
        originalPrimary.receipt,
        originalBackup.receipt,
      );
    requireIndependentArchivePair(parserPrimary.receipt, parserBackup.receipt);
    const archiveSetDigest = originalBackup
      ? await digest("archive-set:v1", [
          ...[originalPrimary, originalBackup, parserPrimary, parserBackup].map(
            ({ receipt, binding }) => [
              receipt.subjectKind,
              receipt.copyRole,
              receipt._id,
              binding.bindingEpoch,
            ],
          ),
        ])
      : await digest("recovery-set:provider-original:v1", [
          [
            originalPrimary.receipt.subjectKind,
            originalPrimary.receipt.copyRole,
            originalPrimary.receipt._id,
            originalPrimary.binding.bindingEpoch,
          ],
          [
            "provider_original",
            providerOriginal!.reference._id,
            providerOriginal!.binding.bindingEpoch,
          ],
          ...[parserPrimary, parserBackup].map(({ receipt, binding }) => [
            receipt.subjectKind,
            receipt.copyRole,
            receipt._id,
            binding.bindingEpoch,
          ]),
        ]);
    const textVersion = await createOrGetParsedTextVersion(ctx, {
      spaceId: source.spaceId,
      sourceRevisionId: revision._id,
      parserArtifactId: artifact._id,
      extractionFingerprint: request.parsedText.extractionFingerprint,
      textHash: request.parsedText.textHash,
      byteLength: request.parsedText.byteLength,
      utf16Length: request.parsedText.utf16Length,
      pageCount: request.parsedText.pageCount,
      mappingManifestHash: request.parsedText.mappingManifestHash,
    });
    const admitted = await createArchivedIngestWork(ctx, {
      account: source.account,
      item: current.item,
      revision,
      textVersion,
      parserArtifactId: artifact._id,
      archiveSetDigest,
      normalizedBundleDigest: request.parsedText.normalizedBundleDigest,
      originalPrimaryReceiptId: originalPrimary.receipt._id,
      ...(originalBackup
        ? { originalBackupReceiptId: originalBackup.receipt._id }
        : {
            originalProviderReferenceId: providerOriginal!.reference._id,
            originalProviderBindingEpoch:
              providerOriginal!.binding.bindingEpoch,
          }),
      parserPrimaryReceiptId: parserPrimary.receipt._id,
      parserBackupReceiptId: parserBackup.receipt._id,
      processing: {
        extractionFingerprint: request.parsedText.extractionFingerprint,
        extractorFingerprint: current.work.extractorFingerprint,
        recordSchemaFingerprint: current.work.recordSchemaFingerprint,
        normalizationFingerprint: current.work.normalizationFingerprint,
        chunkerFingerprint: current.work.chunkerFingerprint,
        correctionRevision: current.work.correctionRevision,
        expectedPageCount: request.parsedText.pageCount,
        expectedEvidenceSpanCount: request.parsedText.expectedEvidenceSpanCount,
        expectedDocumentCount: request.parsedText.expectedDocumentCount,
        expectedChunkCount: request.parsedText.expectedChunkCount,
      },
      actorUserId: current.work.actorUserId,
      actorCredentialId: current.work.actorCredentialId,
      expectedDesiredProcessingEpoch:
        current.work.expectedDesiredProcessingEpoch,
      workerDiscoveryWorkId: current.work._id,
      workerObservationEpoch: current.work.observationEpoch,
    });
    await ctx.db.patch(current.work._id, {
      state: "admitted",
      ingestRequestId: `fs-archive-admit:${current.work._id}`,
      sourceRevisionId: revision._id,
      processingGenerationId: admitted.generation._id,
      ingestJobId: admitted.job._id,
      leaseToken: undefined,
      leaseOwnerCredentialId: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt: undefined,
    });
    const admittedCurrent = await requireCurrentDiscovery(
      ctx,
      source,
      current.work._id,
    );
    const archiveReceipts = await validateAdmittedArchiveChain(
      ctx,
      source,
      admittedCurrent,
      {
        sourceRevisionId: revision._id,
        parserArtifactId: artifact._id,
        sourceTextVersionId: textVersion._id,
        processingGenerationId: admitted.generation._id,
        ingestJobId: admitted.job._id,
        desiredProcessingEpoch: admitted.desiredProcessingEpoch,
        archiveSetDigest,
        parsedText: request.parsedText,
      },
    );
    await ctx.db.patch(pendingId, {
      phase: "completed",
      sourceRevisionId: revision._id,
      parserArtifactId: artifact._id,
      sourceTextVersionId: textVersion._id,
      processingGenerationId: admitted.generation._id,
      ingestJobId: admitted.job._id,
      desiredProcessingEpoch: admitted.desiredProcessingEpoch,
      archiveSetDigest,
      ...(archiveReceipts.originalProviderReferenceId === undefined
        ? {}
        : {
            originalProviderReferenceId:
              archiveReceipts.originalProviderReferenceId,
            originalProviderBindingEpoch:
              archiveReceipts.originalProviderBindingEpoch,
          }),
    });
    return {
      operation: "discovery.admitArchived",
      workId: current.work._id,
      sourceItemId: current.item._id,
      sourceRevisionId: revision._id,
      parserArtifactId: artifact._id,
      sourceTextVersionId: textVersion._id,
      processingGenerationId: admitted.generation._id,
      ingestJobId: admitted.job._id,
      desiredProcessingEpoch: admitted.desiredProcessingEpoch,
      archiveSetDigest,
      ...archiveReceipts,
      state: "admitted",
      reused: false,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Desired processing epoch conflict"
    ) {
      throw workerProtocolError("desired_processing_epoch_conflict");
    }
    throw error;
  }
}
