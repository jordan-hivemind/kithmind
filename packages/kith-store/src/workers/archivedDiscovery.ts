import {
  type ArchiveReceiptSelection,
  BINARY_CLASSES,
  isBinaryClass,
  type ArchivedWorkIdentity,
  type BinaryParserProfileId,
  type ParsedTextDeclaration,
} from "@repo/worker-protocol";
import type {
  WorkerArchivedAdmitResult,
  WorkerArchivedFailResult,
  WorkerArchivedLookupResult,
  WorkerArchivedPreflightResult,
  WorkerArchivedReserveResult,
  WorkerExistingParserArtifact,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import { markInventoryParseFailed } from "../documents/inventory.js";
import {
  createOrGetArchiveReceipt,
  createOrGetArchivedRevision,
  createOrGetParsedTextVersion,
  createOrGetParserArtifact,
  bindInitialArchiveReceipt,
  createAndBindProviderOriginal,
  loadCurrentArchiveBinding,
  loadProviderOriginalBinding,
  loadProviderOriginalReference,
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
  requireIndependentArchivePair,
  setDesiredSourceRevision,
} from "../provenance/index.js";
import {
  camelizeProcessingGeneration,
  camelizeSourceArtifactArchiveReceipt,
  camelizeSourceParserArtifact,
  camelizeSourceRevision,
  camelizeSourceTextVersion,
  type ProcessingGenerationRow,
  type SourceArtifactArchiveBindingRow,
  type SourceArtifactArchiveReceiptRow,
  type SourceParserArtifactRow,
  type SourceRevisionRow,
  type SourceTextVersionRow,
} from "../provenance/rows.js";
import {
  digestProcessingConfiguration,
  sha256Hex,
} from "../ingestion/inline.js";
import { newKithId, KITH_ID } from "../ids.js";
import { requireWorkerSourceAccount, type LoadedWorkerSource } from "./auth.js";
import { at, digest, exec, nowPlus, row, rows, type WorkerCtx } from "./db.js";
import { artifactBoundExtractionFingerprint } from "./entries.js";
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
  camelizeIngestJob,
  camelizeReservationReceipt,
  camelizeReservationTarget,
  type IngestJobRow,
} from "./rows.js";

type ArchivedRequest = Extract<
  WorkerRequest,
  { operation: "discovery.admitArchived" }
>;

export type BoundArchive = {
  receipt: SourceArtifactArchiveReceiptRow;
  binding: SourceArtifactArchiveBindingRow;
};

type ArchiveRecovery =
  | {
      originalPrimaryReceiptId: string;
      originalPrimaryBindingEpoch: number;
      originalBackupReceiptId: string;
      originalBackupBindingEpoch: number;
      originalProviderReferenceId?: never;
      originalProviderBindingEpoch?: never;
    }
  | {
      originalPrimaryReceiptId: string;
      originalPrimaryBindingEpoch: number;
      originalProviderReferenceId: string;
      originalProviderBindingEpoch: number;
      originalBackupReceiptId?: never;
      originalBackupBindingEpoch?: never;
    };

type BinaryOperationReceipt = {
  id: string;
  spaceId: string;
  sourceAccountId: string;
  sourceItemId: string;
  discoveryWorkId: string;
  operation: string;
  phase: string;
  requestId: string;
  requestDigest: string;
  actorUserId: string;
  actorCredentialId: string;
  leaseEpoch: number;
  leaseTokenHash: string;
  sourceRevisionId: string | null;
  parserArtifactId: string | null;
  sourceTextVersionId: string | null;
  processingGenerationId: string | null;
  ingestJobId: string | null;
  desiredProcessingEpoch: number | null;
  archiveSetDigest: string | null;
  originalProviderReferenceId: string | null;
  originalProviderBindingEpoch: number | null;
  retireAt: Date;
};

function binaryReceipt(raw: Record<string, unknown>): BinaryOperationReceipt {
  const value = Object.fromEntries(
    Object.entries(raw).map(([key, field]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      field,
    ]),
  ) as unknown as BinaryOperationReceipt;
  value.leaseEpoch = Number(value.leaseEpoch);
  value.desiredProcessingEpoch =
    value.desiredProcessingEpoch === null
      ? null
      : Number(value.desiredProcessingEpoch);
  value.originalProviderBindingEpoch =
    value.originalProviderBindingEpoch === null
      ? null
      : Number(value.originalProviderBindingEpoch);
  return value;
}

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

async function loadRevision(
  ctx: WorkerCtx,
  id: string,
): Promise<SourceRevisionRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_revisions WHERE id = $1",
    [id],
  );
  return found ? camelizeSourceRevision(found) : null;
}

async function loadArtifact(
  ctx: WorkerCtx,
  id: string,
): Promise<SourceParserArtifactRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_parser_artifacts WHERE id = $1",
    [id],
  );
  return found ? camelizeSourceParserArtifact(found) : null;
}

async function loadTextVersion(
  ctx: WorkerCtx,
  id: string,
): Promise<SourceTextVersionRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_text_versions WHERE id = $1",
    [id],
  );
  return found ? camelizeSourceTextVersion(found) : null;
}

async function loadGeneration(
  ctx: WorkerCtx,
  id: string,
): Promise<ProcessingGenerationRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.processing_generations WHERE id = $1",
    [id],
  );
  return found ? camelizeProcessingGeneration(found) : null;
}

async function loadJob(
  ctx: WorkerCtx,
  id: string,
): Promise<IngestJobRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.ingest_jobs WHERE id = $1",
    [id],
  );
  return found ? camelizeIngestJob(found) : null;
}

export async function archiveSetDigest(
  originalPrimary: BoundArchive,
  originalBackup: BoundArchive | undefined,
  provider: { reference: { id: string }; bindingEpoch: number } | null,
  parserPrimary: BoundArchive,
  parserBackup: BoundArchive,
): Promise<string> {
  if (originalBackup) {
    return digest(
      "archive-set:v1",
      [originalPrimary, originalBackup, parserPrimary, parserBackup].map(
        ({ receipt, binding }) => [
          receipt.subjectKind,
          receipt.copyRole,
          receipt.id,
          binding.bindingEpoch,
        ],
      ),
    );
  }
  if (!provider) workerProtocolError("scan_conflict");
  return digest("recovery-set:provider-original:v1", [
    [
      originalPrimary.receipt.subjectKind,
      originalPrimary.receipt.copyRole,
      originalPrimary.receipt.id,
      originalPrimary.binding.bindingEpoch,
    ],
    ["provider_original", provider.reference.id, provider.bindingEpoch],
    ...[parserPrimary, parserBackup].map(({ receipt, binding }) => [
      receipt.subjectKind,
      receipt.copyRole,
      receipt.id,
      binding.bindingEpoch,
    ]),
  ]);
}

async function loadArchiveRecovery(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  current: CurrentDiscovery,
  revision: SourceRevisionRow,
): Promise<
  | {
      recovery: ArchiveRecovery;
      originalPrimary: BoundArchive;
      originalBackup?: BoundArchive;
      provider: { reference: { id: string }; bindingEpoch: number } | null;
    }
  | undefined
> {
  const originalPrimary = await loadCurrentArchiveBinding(ctx.client, {
    spaceId: source.spaceId,
    sourceAccountId: source.account.id,
    sourceItemId: current.item.id,
    sourceRevisionId: revision.id,
    subjectKind: "original_bytes",
    copyRole: "primary",
  });
  const originalBackup = await loadCurrentArchiveBinding(ctx.client, {
    spaceId: source.spaceId,
    sourceAccountId: source.account.id,
    sourceItemId: current.item.id,
    sourceRevisionId: revision.id,
    subjectKind: "original_bytes",
    copyRole: "independent_backup",
  });
  const providerBinding = await loadProviderOriginalBinding(
    ctx.client,
    revision.id,
  );
  if (
    !originalPrimary ||
    (!originalBackup && !providerBinding) ||
    (originalBackup && providerBinding)
  )
    return undefined;
  if (originalBackup) {
    requireIndependentArchivePair(
      originalPrimary.receipt,
      originalBackup.receipt,
    );
    return {
      originalPrimary,
      originalBackup,
      provider: null,
      recovery: {
        originalPrimaryReceiptId: originalPrimary.receipt.id,
        originalPrimaryBindingEpoch: originalPrimary.binding.bindingEpoch,
        originalBackupReceiptId: originalBackup.receipt.id,
        originalBackupBindingEpoch: originalBackup.binding.bindingEpoch,
      },
    };
  }
  const provider = {
    reference: { id: providerBinding!.reference.id },
    bindingEpoch: providerBinding!.binding.bindingEpoch,
  };
  return {
    originalPrimary,
    provider,
    recovery: {
      originalPrimaryReceiptId: originalPrimary.receipt.id,
      originalPrimaryBindingEpoch: originalPrimary.binding.bindingEpoch,
      originalProviderReferenceId: provider.reference.id,
      originalProviderBindingEpoch: provider.bindingEpoch,
    },
  };
}

export async function validateAdmittedArchiveChain(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  current: CurrentDiscovery,
  ids: {
    sourceRevisionId: string;
    parserArtifactId: string;
    sourceTextVersionId: string;
    processingGenerationId: string;
    ingestJobId: string;
    desiredProcessingEpoch: number;
    archiveSetDigest: string;
    parsedText?: ParsedTextDeclaration;
  },
): Promise<
  ArchiveRecovery & {
    parserPrimaryReceiptId: string;
    parserPrimaryBindingEpoch: number;
    parserBackupReceiptId: string;
    parserBackupBindingEpoch: number;
  }
> {
  requireStoredBinaryWork(current);
  const revision = await loadRevision(ctx, ids.sourceRevisionId);
  const artifact = await loadArtifact(ctx, ids.parserArtifactId);
  const text = await loadTextVersion(ctx, ids.sourceTextVersionId);
  const generation = await loadGeneration(ctx, ids.processingGenerationId);
  const job = await loadJob(ctx, ids.ingestJobId);
  if (!revision || !artifact || !text || !generation || !job)
    workerProtocolError("scan_conflict");
  let parsedRevision;
  let parsedText;
  try {
    parsedRevision = parseSourceRevisionRepresentation(revision);
    parsedText = parseSourceTextRepresentation(text);
  } catch {
    workerProtocolError("scan_conflict");
  }
  if (
    parsedRevision!.kind !== "archived_binary_v1" ||
    parsedText!.kind !== "parsed_pages_v1" ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== current.item.id ||
    revision.contentHashAuthority !== "worker_asserted" ||
    revision.contentHash !== current.work.contentHash ||
    revision.byteLength !== current.work.byteLength ||
    revision.mediaType !== current.work.mediaType ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account.id ||
    artifact.sourceItemId !== current.item.id ||
    artifact.sourceRevisionId !== revision.id ||
    artifact.parserFingerprint !== current.work.parserFingerprint ||
    text.spaceId !== source.spaceId ||
    text.sourceRevisionId !== revision.id ||
    text.parserArtifactId !== artifact.id ||
    generation.spaceId !== source.spaceId ||
    generation.sourceAccountId !== source.account.id ||
    generation.sourceItemId !== current.item.id ||
    generation.sourceRevisionId !== revision.id ||
    generation.sourceTextVersionId !== text.id ||
    generation.parserArtifactId !== artifact.id ||
    generation.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    generation.archiveSetDigest !== ids.archiveSetDigest ||
    generation.normalizedBundleDigest === null ||
    generation.expectedEventCount !== 0 ||
    generation.expectedObservationCount !== 0 ||
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account.id ||
    job.sourceItemId !== current.item.id ||
    job.sourceRevisionId !== revision.id ||
    job.processingGenerationId !== generation.id ||
    job.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    job.state !== generation.state ||
    job.actorUserId !== current.work.actorUserId ||
    job.actorCredentialId !== current.work.actorCredentialId ||
    job.admittedByUserId !== current.work.actorUserId ||
    job.admittedByCredentialId !== current.work.actorCredentialId ||
    job.workerManaged !== true ||
    job.workerProcessingMode !== "parsed_pages_v1" ||
    job.workerDiscoveryWorkId !== current.work.id ||
    job.workerObservationEpoch !== current.work.observationEpoch ||
    current.item.desiredRevisionId !== revision.id ||
    current.item.desiredProcessingEpoch !== ids.desiredProcessingEpoch ||
    current.work.state !== "admitted" ||
    current.work.sourceRevisionId !== revision.id ||
    current.work.processingGenerationId !== generation.id ||
    current.work.ingestJobId !== job.id
  )
    workerProtocolError("scan_conflict");
  if (
    ids.parsedText !== undefined &&
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
      generation.expectedChunkCount !== ids.parsedText.expectedChunkCount)
  )
    workerProtocolError("scan_conflict");
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
  )
    workerProtocolError("scan_conflict");
  const recovery = await loadArchiveRecovery(ctx, source, current, revision);
  if (!recovery) workerProtocolError("scan_conflict");
  if (recovery.provider) {
    await loadProviderOriginalReference(ctx.client, {
      referenceId: recovery.provider.reference.id,
      spaceId: source.spaceId,
      sourceAccountId: source.account.id,
      sourceItemId: current.item.id,
      sourceRevisionId: revision.id,
      expectedSourceContentHash: revision.contentHash,
      expectedSourceByteLength: revision.byteLength,
    });
  }
  const parserPrimary = await loadCurrentArchiveBinding(ctx.client, {
    spaceId: source.spaceId,
    sourceAccountId: source.account.id,
    sourceItemId: current.item.id,
    sourceRevisionId: revision.id,
    parserArtifactId: artifact.id,
    subjectKind: "parser_output",
    copyRole: "primary",
  });
  const parserBackup = await loadCurrentArchiveBinding(ctx.client, {
    spaceId: source.spaceId,
    sourceAccountId: source.account.id,
    sourceItemId: current.item.id,
    sourceRevisionId: revision.id,
    parserArtifactId: artifact.id,
    subjectKind: "parser_output",
    copyRole: "independent_backup",
  });
  if (!parserPrimary || !parserBackup) workerProtocolError("scan_conflict");
  requireIndependentArchivePair(parserPrimary.receipt, parserBackup.receipt);
  const expectedArchiveSet = await archiveSetDigest(
    recovery.originalPrimary,
    recovery.originalBackup,
    recovery.provider,
    parserPrimary,
    parserBackup,
  );
  if (
    expectedArchiveSet !== ids.archiveSetDigest ||
    generation.originalPrimaryReceiptId !==
      recovery.recovery.originalPrimaryReceiptId ||
    generation.originalBackupReceiptId !==
      ("originalBackupReceiptId" in recovery.recovery
        ? recovery.recovery.originalBackupReceiptId!
        : null) ||
    generation.originalProviderReferenceId !==
      ("originalProviderReferenceId" in recovery.recovery
        ? recovery.recovery.originalProviderReferenceId!
        : null) ||
    generation.originalProviderBindingEpoch !==
      ("originalProviderBindingEpoch" in recovery.recovery
        ? recovery.recovery.originalProviderBindingEpoch!
        : null) ||
    generation.parserPrimaryReceiptId !== parserPrimary.receipt.id ||
    generation.parserBackupReceiptId !== parserBackup.receipt.id
  )
    workerProtocolError("scan_conflict");
  return {
    ...recovery.recovery,
    parserPrimaryReceiptId: parserPrimary.receipt.id,
    parserPrimaryBindingEpoch: parserPrimary.binding.bindingEpoch,
    parserBackupReceiptId: parserBackup.receipt.id,
    parserBackupBindingEpoch: parserBackup.binding.bindingEpoch,
  };
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
  // P2-104c: `state <> 'obsolete'`, exactly as `currentDiscoveryWork` in
  // entries.ts selects the current row. Without it this asks "the work row for
  // this item at this observation epoch" and gets every row ever written at
  // that epoch, including superseded ones.
  //
  // That is not a rare shape, it is what re-parsing looks like. A parser
  // change moves `processingIdentityDigest` and not
  // `inventoryMetadataDigest`, so the processing epoch advances while the
  // observation epoch deliberately stays put: the bytes did not change. The
  // re-queue therefore leaves the superseded row and the new `queued` row
  // sharing this key, two matches are returned, and every archived operation
  // for that document answers `stale_observation` forever. The document can
  // never be re-parsed, and no retry or lease expiry clears it, because
  // nothing here depends on time.
  const matches = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_discovery_work
        WHERE source_item_id = $1 AND observation_epoch = $2 AND state <> 'obsolete'
        ORDER BY created_at, id LIMIT 2 FOR UPDATE`,
      [identity.sourceItemId, identity.observationEpoch],
    )
  ).map(camelizeDiscoveryWork);
  if (matches.length !== 1) workerProtocolError("stale_observation");
  const current = await requireCurrentDiscovery(ctx, source, matches[0]!.id);
  requireIdentity(current, identity);
  return current;
}

/**
 * Whether this worker may take this archived work row now.
 *
 * P2-104d. One predicate, used by both `preflightArchivedDiscovery` and
 * `reserveArchivedDiscovery`, because they disagreed and the disagreement was
 * live. Reserve has always treated an expired lease as claimable -- that is
 * how a pass that died holding one is recovered -- and preflight required no
 * lease at all. Preflight is the gate reserve sits behind, so a row left
 * `leased` with an expired lease answered `stale_observation` at preflight
 * forever and took the whole pass down with it, while the reserve that would
 * have reclaimed it was never reached.
 *
 * This grants nothing. Preflight hands out no lease, writes nothing and fences
 * nothing; it authorizes the archive intent for work this credential could
 * claim in the very next call. Saying no to work reserve would say yes to was
 * never a safety property, only a missing case.
 */
function claimableArchivedWork(
  work: CurrentDiscovery["work"],
  now: number,
): boolean {
  return (
    ((work.state === "queued" ||
      (work.state === "failed" && work.retryable === true)) &&
      work.leaseToken === null &&
      work.leaseExpiresAt === null &&
      work.leaseOwnerCredentialId === null &&
      (work.nextAttemptAt === null || work.nextAttemptAt.getTime() <= now)) ||
    (work.state === "leased" &&
      work.leaseToken !== null &&
      work.leaseExpiresAt !== null &&
      work.leaseOwnerCredentialId !== null &&
      work.leaseExpiresAt.getTime() <= now)
  );
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
    !claimableArchivedWork(current.work, ctx.now) ||
    !Number.isSafeInteger(current.work.attempts) ||
    current.work.attempts < 0 ||
    current.work.attempts >= MAX_WORKER_DISCOVERY_ATTEMPTS
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
  if (
    !claimableArchivedWork(work, ctx.now) ||
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

/**
 * P2-104d. The parser artifact this revision already has under this parser
 * fingerprint, with the archive receipts currently bound to its parser output,
 * or `undefined` when there is nothing to reuse.
 *
 * `(source_revision_id, parser_fingerprint)` is the artifact's identity
 * because the archived parser output is the raw conversion, and the extraction
 * configuration maps that raw output into the bundle rather than changing it.
 * Re-processing under a new extraction configuration therefore re-parses to
 * the same bytes: the client has to select this artifact and its archived
 * copies, not archive a second copy of bytes that are already archived and
 * then be refused by artifact immutability.
 *
 * Offered only when the output the client just produced *is* this artifact's
 * output. A parser that produced different bytes under an unchanged
 * fingerprint is not a reuse case, and saying nothing lets the ordinary
 * create path refuse it where the conflict is visible.
 */
async function existingParserArtifact(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  current: CurrentDiscovery,
  revision: SourceRevisionRow,
  lookup: {
    parserOutputHash: string;
    parserOutputByteLength: number;
    parserOutputMediaType: string;
  },
): Promise<WorkerExistingParserArtifact | undefined> {
  if (current.work.parserFingerprint === null) return undefined;
  const found = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.source_parser_artifacts
       WHERE source_revision_id = $1 AND parser_fingerprint = $2
       ORDER BY created_at, id LIMIT 2`,
      [revision.id, current.work.parserFingerprint],
    )
  ).map(camelizeSourceParserArtifact);
  if (found.length > 1) workerProtocolError("scan_conflict");
  const artifact = found[0];
  if (
    !artifact ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account.id ||
    artifact.sourceItemId !== current.item.id ||
    artifact.outputHash !== lookup.parserOutputHash ||
    artifact.outputByteLength !== lookup.parserOutputByteLength ||
    artifact.outputMediaType !== lookup.parserOutputMediaType
  )
    return undefined;
  const subject = {
    spaceId: source.spaceId,
    sourceAccountId: source.account.id,
    sourceItemId: current.item.id,
    sourceRevisionId: revision.id,
    parserArtifactId: artifact.id,
    subjectKind: "parser_output" as const,
  };
  const primary = await loadCurrentArchiveBinding(ctx.client, {
    ...subject,
    copyRole: "primary",
  });
  const backup = await loadCurrentArchiveBinding(ctx.client, {
    ...subject,
    copyRole: "independent_backup",
  });
  // Both copies or nothing. A half-archived artifact is not reusable: the
  // client would skip the archive step for a copy that was never durable.
  if (!primary || !backup) return undefined;
  requireIndependentArchivePair(primary.receipt, backup.receipt);
  return {
    parserArtifactId: artifact.id,
    primaryReceiptId: primary.receipt.id,
    primaryBindingEpoch: primary.binding.bindingEpoch,
    backupReceiptId: backup.receipt.id,
    backupBindingEpoch: backup.binding.bindingEpoch,
  };
}

export async function lookupArchivedAdmission(
  ctx: WorkerCtx,
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
  const revisions = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.source_revisions
       WHERE source_item_id = $1 AND content_hash = $2
       ORDER BY created_at, id LIMIT 2`,
      [current.item.id, current.work.contentHash],
    )
  ).map(camelizeSourceRevision);
  if (revisions.length > 1) workerProtocolError("scan_conflict");
  const revision = revisions[0];
  if (!revision)
    return {
      operation: "discovery.lookupArchivedAdmission",
      mode: request.lookup.mode,
      found: false,
    };
  let representation;
  try {
    representation = parseSourceRevisionRepresentation(revision);
  } catch {
    workerProtocolError("scan_conflict");
  }
  if (
    representation!.kind !== "archived_binary_v1" ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== current.item.id ||
    revision.contentHashAuthority !== "worker_asserted" ||
    revision.contentHash !== current.work.contentHash ||
    revision.byteLength !== current.work.byteLength ||
    revision.mediaType !== current.work.mediaType ||
    revision.inlineText !== null ||
    revision.archiveRef !== null
  )
    workerProtocolError("scan_conflict");
  const recovery = await loadArchiveRecovery(ctx, source, current, revision);
  if (!recovery)
    return {
      operation: "discovery.lookupArchivedAdmission",
      mode: request.lookup.mode,
      found: false,
    };
  if (request.lookup.mode === "original") {
    return {
      operation: "discovery.lookupArchivedAdmission",
      mode: "original",
      found: true,
      sourceRevisionId: revision.id,
      ...recovery.recovery,
    };
  }
  const lookup = request.lookup;
  // P2-104d. Computed once, attached to every not-found processing answer,
  // and only for a client that asked for it. A not-found answer is exactly
  // when the client needs it: it is about to archive and admit, and this is
  // what tells it there is nothing to archive.
  const reusable = lookup.reuseParserArtifact
    ? await existingParserArtifact(ctx, source, current, revision, lookup)
    : undefined;
  const processingNotFound = (): WorkerArchivedLookupResult => ({
    operation: "discovery.lookupArchivedAdmission",
    mode: "processing",
    found: false,
    ...(reusable === undefined ? {} : { existingParserArtifact: reusable }),
  });
  const artifacts = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.source_parser_artifacts
       WHERE source_account_id = $1 AND client_artifact_id = $2
       ORDER BY created_at, id LIMIT 2`,
      [source.account.id, lookup.clientArtifactId],
    )
  ).map(camelizeSourceParserArtifact);
  if (artifacts.length > 1) workerProtocolError("scan_conflict");
  const artifact = artifacts[0];
  if (
    !artifact ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account.id ||
    artifact.sourceItemId !== current.item.id ||
    artifact.sourceRevisionId !== revision.id ||
    artifact.parserFingerprint !== current.work.parserFingerprint ||
    artifact.outputHash !== lookup.parserOutputHash ||
    artifact.outputByteLength !== lookup.parserOutputByteLength ||
    artifact.outputMediaType !== lookup.parserOutputMediaType
  )
    return processingNotFound();
  const expectedExtraction = await artifactBoundExtractionFingerprint(
    current.work.parserFingerprint!,
    artifact.outputHash,
    current.work.extractionConfigurationFingerprint!,
  );
  if (lookup.parsedText.extractionFingerprint !== expectedExtraction)
    workerProtocolError("request_conflict");
  const parserPrimary = await loadCurrentArchiveBinding(ctx.client, {
    spaceId: source.spaceId,
    sourceAccountId: source.account.id,
    sourceItemId: current.item.id,
    sourceRevisionId: revision.id,
    parserArtifactId: artifact.id,
    subjectKind: "parser_output",
    copyRole: "primary",
  });
  const parserBackup = await loadCurrentArchiveBinding(ctx.client, {
    spaceId: source.spaceId,
    sourceAccountId: source.account.id,
    sourceItemId: current.item.id,
    sourceRevisionId: revision.id,
    parserArtifactId: artifact.id,
    subjectKind: "parser_output",
    copyRole: "independent_backup",
  });
  const textRows = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.source_text_versions
     WHERE source_revision_id = $1 AND extraction_fingerprint = $2
     ORDER BY created_at, id LIMIT 2`,
    [revision.id, lookup.parsedText.extractionFingerprint],
  );
  if (!parserPrimary || !parserBackup || textRows.length !== 1)
    return processingNotFound();
  requireIndependentArchivePair(parserPrimary.receipt, parserBackup.receipt);
  const text = camelizeSourceTextVersion(textRows[0]!);
  let textRepresentation;
  try {
    textRepresentation = parseSourceTextRepresentation(text);
  } catch {
    workerProtocolError("request_conflict");
  }
  if (
    textRepresentation!.kind !== "parsed_pages_v1" ||
    text.spaceId !== source.spaceId ||
    text.parserArtifactId !== artifact.id ||
    text.textHash !== lookup.parsedText.textHash ||
    text.byteLength !== lookup.parsedText.byteLength ||
    text.utf16Length !== lookup.parsedText.utf16Length ||
    text.pageCount !== lookup.parsedText.pageCount ||
    text.mappingManifestHash !== lookup.parsedText.mappingManifestHash
  )
    workerProtocolError("request_conflict");
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: lookup.parsedText.extractionFingerprint,
    extractorFingerprint: current.work.extractorFingerprint,
    recordSchemaFingerprint: current.work.recordSchemaFingerprint,
    normalizationFingerprint: current.work.normalizationFingerprint,
    chunkerFingerprint: current.work.chunkerFingerprint,
    correctionRevision: current.work.correctionRevision!,
  });
  const generations = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.processing_generations
       WHERE source_revision_id = $1 AND processing_fingerprint = $2
       ORDER BY created_at, id LIMIT 2`,
      [revision.id, processingFingerprint],
    )
  ).map(camelizeProcessingGeneration);
  if (generations.length !== 1) return processingNotFound();
  const generation = generations[0]!;
  const jobs = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.ingest_jobs
       WHERE processing_generation_id = $1 ORDER BY created_at, id LIMIT 2`,
      [generation.id],
    )
  ).map(camelizeIngestJob);
  if (jobs.length !== 1) return processingNotFound();
  const job = jobs[0]!;
  const expectedArchiveSet = await archiveSetDigest(
    recovery.originalPrimary,
    recovery.originalBackup,
    recovery.provider,
    parserPrimary,
    parserBackup,
  );
  if (
    generation.normalizedBundleDigest !==
      lookup.parsedText.normalizedBundleDigest ||
    generation.expectedPageCount !== lookup.parsedText.pageCount ||
    generation.expectedEvidenceSpanCount !==
      lookup.parsedText.expectedEvidenceSpanCount ||
    generation.expectedDocumentCount !==
      lookup.parsedText.expectedDocumentCount ||
    generation.expectedChunkCount !== lookup.parsedText.expectedChunkCount ||
    generation.archiveSetDigest !== expectedArchiveSet ||
    job.workerProcessingMode !== "parsed_pages_v1" ||
    job.workerDiscoveryWorkId !== current.work.id ||
    current.work.state !== "admitted" ||
    current.work.sourceRevisionId !== revision.id ||
    current.work.processingGenerationId !== generation.id ||
    current.work.ingestJobId !== job.id ||
    generation.desiredProcessingEpoch === null
  )
    workerProtocolError("scan_conflict");
  await validateAdmittedArchiveChain(ctx, source, current, {
    sourceRevisionId: revision.id,
    parserArtifactId: artifact.id,
    sourceTextVersionId: text.id,
    processingGenerationId: generation.id,
    ingestJobId: job.id,
    desiredProcessingEpoch: generation.desiredProcessingEpoch,
    archiveSetDigest: expectedArchiveSet,
    parsedText: lookup.parsedText,
  });
  return {
    operation: "discovery.lookupArchivedAdmission",
    mode: "processing",
    found: true,
    sourceRevisionId: revision.id,
    parserArtifactId: artifact.id,
    sourceTextVersionId: text.id,
    processingGenerationId: generation.id,
    ingestJobId: job.id,
    desiredProcessingEpoch: generation.desiredProcessingEpoch,
    archiveSetDigest: expectedArchiveSet,
    ...recovery.recovery,
    parserPrimaryReceiptId: parserPrimary.receipt.id,
    parserPrimaryBindingEpoch: parserPrimary.binding.bindingEpoch,
    parserBackupReceiptId: parserBackup.receipt.id,
    parserBackupBindingEpoch: parserBackup.binding.bindingEpoch,
  };
}

async function resolveParserArtifact(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  current: CurrentDiscovery,
  revision: SourceRevisionRow,
  request: ArchivedRequest,
): Promise<SourceParserArtifactRow> {
  const expectedOutputMediaType = requireWorkBinaryClass(
    current.work,
  ).parserOutputMediaType;
  if (request.parserArtifact.kind === "create") {
    if (request.parserArtifact.outputMediaType !== expectedOutputMediaType)
      workerProtocolError("stale_observation");
    return createOrGetParserArtifact(ctx.client, {
      spaceId: source.spaceId,
      sourceAccountId: source.account.id,
      sourceItemId: current.item.id,
      sourceRevisionId: revision.id,
      clientArtifactId: request.parserArtifact.clientArtifactId,
      parserFingerprint: current.work.parserFingerprint!,
      outputHash: request.parserArtifact.outputHash,
      outputByteLength: request.parserArtifact.outputByteLength,
      outputMediaType: request.parserArtifact.outputMediaType,
      userId: source.principal.userId,
      actorCredentialId: source.principal.credentialId,
      createdAt: at(request.parserArtifact.createdAt)!,
    });
  }
  if (!KITH_ID.test(request.parserArtifact.parserArtifactId))
    workerProtocolError("invalid_request");
  const artifact = await loadArtifact(
    ctx,
    request.parserArtifact.parserArtifactId,
  );
  if (
    !artifact ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account.id ||
    artifact.sourceItemId !== current.item.id ||
    artifact.sourceRevisionId !== revision.id ||
    artifact.parserFingerprint !== current.work.parserFingerprint ||
    artifact.outputMediaType !== expectedOutputMediaType
  )
    workerProtocolError("stale_observation");
  return artifact;
}

async function resolveArchive(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  current: CurrentDiscovery,
  revision: SourceRevisionRow,
  artifact: SourceParserArtifactRow,
  selection: ArchiveReceiptSelection,
  admissionDigest: string,
): Promise<BoundArchive> {
  let receipt: SourceArtifactArchiveReceiptRow | null;
  if (selection.kind === "create") {
    const parser = selection.subjectKind === "parser_output";
    receipt = await createOrGetArchiveReceipt(ctx.client, {
      spaceId: source.spaceId,
      sourceAccountId: source.account.id,
      sourceItemId: current.item.id,
      sourceRevisionId: revision.id,
      ...(parser ? { parserArtifactId: artifact.id } : {}),
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
      readbackVerifiedAt: at(selection.readbackVerifiedAt)!,
      userId: source.principal.userId,
      actorCredentialId: source.principal.credentialId,
      createdAt: at(selection.createdAt)!,
    });
  } else {
    if (!KITH_ID.test(selection.receiptId))
      workerProtocolError("invalid_request");
    const found = await row<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.source_artifact_archive_receipts WHERE id = $1",
      [selection.receiptId],
    );
    receipt = found ? camelizeSourceArtifactArchiveReceipt(found) : null;
  }
  if (
    !receipt ||
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account.id ||
    receipt.sourceItemId !== current.item.id ||
    receipt.sourceRevisionId !== revision.id ||
    receipt.subjectKind !== selection.subjectKind ||
    receipt.copyRole !== selection.copyRole ||
    receipt.parserArtifactId !==
      (selection.subjectKind === "parser_output" ? artifact.id : null)
  )
    workerProtocolError("stale_observation");
  const binding = await bindInitialArchiveReceipt(ctx.client, {
    receipt,
    ...(selection.kind === "existing"
      ? { expectedBindingEpoch: selection.bindingEpoch }
      : {}),
    userId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    now: at(ctx.now)!,
  });
  return { receipt, binding };
}

async function createArchivedIngestWork(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  current: CurrentDiscovery,
  input: {
    revision: SourceRevisionRow;
    text: SourceTextVersionRow;
    artifact: SourceParserArtifactRow;
    archiveSetDigest: string;
    parsedText: ParsedTextDeclaration;
    recovery: ArchiveRecovery;
    parserPrimaryReceiptId: string;
    parserBackupReceiptId: string;
  },
): Promise<{
  generation: ProcessingGenerationRow;
  job: IngestJobRow;
  desiredProcessingEpoch: number;
}> {
  const expected = current.work.expectedDesiredProcessingEpoch;
  if (expected === null || current.item.desiredProcessingEpoch !== expected)
    workerProtocolError("desired_processing_epoch_conflict");
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: input.parsedText.extractionFingerprint,
    extractorFingerprint: current.work.extractorFingerprint,
    recordSchemaFingerprint: current.work.recordSchemaFingerprint,
    normalizationFingerprint: current.work.normalizationFingerprint,
    chunkerFingerprint: current.work.chunkerFingerprint,
    correctionRevision: current.work.correctionRevision!,
  });
  const existing = await rows<Record<string, unknown>>(
    ctx,
    `SELECT id FROM kith.processing_generations
     WHERE source_revision_id = $1 AND processing_fingerprint = $2 LIMIT 2`,
    [input.revision.id, processingFingerprint],
  );
  if (existing.length > 1)
    throw new Error("Binary generation identity is not unique");
  if (existing.length === 1)
    throw new Error(
      "Processing configuration was already used; increment correctionRevision",
    );
  let desiredProcessingEpoch: number;
  try {
    desiredProcessingEpoch = await setDesiredSourceRevision(ctx.client, {
      spaceId: source.spaceId,
      sourceItemId: current.item.id,
      desiredRevisionId: input.revision.id,
      expectedDesiredProcessingEpoch: expected,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("desired processing epoch conflict")
    )
      workerProtocolError("desired_processing_epoch_conflict");
    throw error;
  }
  await exec(
    ctx,
    "UPDATE kith.source_accounts SET worker_assessment_epoch = COALESCE(worker_assessment_epoch, 0) + 1 WHERE id = $1",
    [source.account.id],
  );
  const processingGenerationId = newKithId();
  const ingestJobId = newKithId();
  const originalBackupReceiptId =
    "originalBackupReceiptId" in input.recovery
      ? input.recovery.originalBackupReceiptId!
      : null;
  const originalProviderReferenceId =
    "originalProviderReferenceId" in input.recovery
      ? input.recovery.originalProviderReferenceId!
      : null;
  const originalProviderBindingEpoch =
    "originalProviderBindingEpoch" in input.recovery
      ? input.recovery.originalProviderBindingEpoch!
      : null;
  await exec(
    ctx,
    `INSERT INTO kith.processing_generations
     (id, space_id, created_at, source_account_id, source_item_id,
      source_revision_id, source_text_version_id, processing_fingerprint,
      extraction_fingerprint, extractor_fingerprint, record_schema_fingerprint,
      normalization_fingerprint, chunker_fingerprint, correction_revision,
      parser_artifact_id, archive_set_digest, normalized_bundle_digest,
      original_primary_receipt_id, original_backup_receipt_id,
      original_provider_reference_id, original_provider_binding_epoch,
      parser_primary_receipt_id, parser_backup_receipt_id,
      desired_processing_epoch, card_generation, state, expected_page_count,
      expected_evidence_span_count, expected_document_count,
      expected_chunk_count, expected_event_count, expected_observation_count,
      embedding_status)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
      $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,false,'queued',$24,$25,$26,
      $27,0,0,'unavailable')`,
    [
      processingGenerationId,
      source.spaceId,
      source.account.id,
      current.item.id,
      input.revision.id,
      input.text.id,
      processingFingerprint,
      input.parsedText.extractionFingerprint,
      current.work.extractorFingerprint,
      current.work.recordSchemaFingerprint,
      current.work.normalizationFingerprint,
      current.work.chunkerFingerprint,
      current.work.correctionRevision,
      input.artifact.id,
      input.archiveSetDigest,
      input.parsedText.normalizedBundleDigest,
      input.recovery.originalPrimaryReceiptId,
      originalBackupReceiptId,
      originalProviderReferenceId,
      originalProviderBindingEpoch,
      input.parserPrimaryReceiptId,
      input.parserBackupReceiptId,
      desiredProcessingEpoch,
      input.parsedText.pageCount,
      input.parsedText.expectedEvidenceSpanCount,
      input.parsedText.expectedDocumentCount,
      input.parsedText.expectedChunkCount,
    ],
  );
  await exec(
    ctx,
    `INSERT INTO kith.ingest_jobs
     (id, space_id, created_at, source_account_id, source_item_id,
      source_revision_id, processing_generation_id, admitted_by_user_id,
      admitted_by_credential_id, actor_user_id, actor_credential_id,
      desired_processing_epoch, state, attempts, lease_epoch, worker_managed,
      worker_discovery_work_id, worker_observation_epoch, worker_processing_mode)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$7,$8,$9,
      'queued',0,0,true,$10,$11,'parsed_pages_v1')`,
    [
      ingestJobId,
      source.spaceId,
      source.account.id,
      current.item.id,
      input.revision.id,
      processingGenerationId,
      current.work.actorUserId,
      current.work.actorCredentialId,
      desiredProcessingEpoch,
      current.work.id,
      current.work.observationEpoch,
    ],
  );
  const generation = await loadGeneration(ctx, processingGenerationId);
  const job = await loadJob(ctx, ingestJobId);
  if (!generation || !job) workerProtocolError("scan_conflict");
  return { generation, job, desiredProcessingEpoch };
}

export async function admitArchivedDiscovery(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: ArchivedRequest,
): Promise<WorkerArchivedAdmitResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  if (!KITH_ID.test(request.workId)) workerProtocolError("invalid_request");
  const leaseTokenHash = await sha256Hex(request.leaseToken);
  const requestDigest = await digest("worker-discovery-admit-archived:v1", [
    source.account.id,
    request,
    leaseTokenHash,
  ]);
  const priors = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_binary_operation_receipts
       WHERE source_account_id = $1 AND operation = 'discovery_admit_archived'
         AND request_id = $2 ORDER BY created_at, id LIMIT 2`,
      [source.account.id, request.requestId],
    )
  ).map(binaryReceipt);
  if (priors.length > 1) workerProtocolError("scan_conflict");
  const prior = priors[0];
  if (prior) {
    if (
      prior.spaceId !== source.spaceId ||
      prior.actorUserId !== source.principal.userId ||
      prior.actorCredentialId !== source.principal.credentialId
    )
      workerProtocolError("not_found");
    if (
      prior.requestDigest !== requestDigest ||
      prior.discoveryWorkId !== request.workId ||
      prior.leaseEpoch !== request.leaseEpoch ||
      prior.leaseTokenHash !== leaseTokenHash
    )
      workerProtocolError("request_conflict");
    if (
      prior.phase !== "completed" ||
      !prior.sourceRevisionId ||
      !prior.parserArtifactId ||
      !prior.sourceTextVersionId ||
      !prior.processingGenerationId ||
      !prior.ingestJobId ||
      prior.desiredProcessingEpoch === null ||
      !prior.archiveSetDigest
    )
      workerProtocolError("scan_conflict");
    const current = await requireCurrentDiscovery(ctx, source, request.workId);
    if (
      prior.sourceItemId !== current.item.id ||
      current.work.state !== "admitted" ||
      current.work.sourceRevisionId !== prior.sourceRevisionId ||
      current.work.processingGenerationId !== prior.processingGenerationId ||
      current.work.ingestJobId !== prior.ingestJobId
    )
      workerProtocolError("stale_observation");
    const archives = await validateAdmittedArchiveChain(ctx, source, current, {
      sourceRevisionId: prior.sourceRevisionId,
      parserArtifactId: prior.parserArtifactId,
      sourceTextVersionId: prior.sourceTextVersionId,
      processingGenerationId: prior.processingGenerationId,
      ingestJobId: prior.ingestJobId,
      desiredProcessingEpoch: prior.desiredProcessingEpoch,
      archiveSetDigest: prior.archiveSetDigest,
      parsedText: request.parsedText,
    });
    if (
      prior.originalProviderReferenceId !==
        ("originalProviderReferenceId" in archives
          ? archives.originalProviderReferenceId!
          : null) ||
      prior.originalProviderBindingEpoch !==
        ("originalProviderBindingEpoch" in archives
          ? archives.originalProviderBindingEpoch!
          : null)
    )
      workerProtocolError("scan_conflict");
    return {
      operation: "discovery.admitArchived",
      workId: request.workId,
      sourceItemId: prior.sourceItemId,
      sourceRevisionId: prior.sourceRevisionId,
      parserArtifactId: prior.parserArtifactId,
      sourceTextVersionId: prior.sourceTextVersionId,
      processingGenerationId: prior.processingGenerationId,
      ingestJobId: prior.ingestJobId,
      desiredProcessingEpoch: prior.desiredProcessingEpoch,
      archiveSetDigest: prior.archiveSetDigest,
      ...archives,
      state: "admitted",
      reused: true,
    };
  }
  const current = await requireCurrentDiscovery(ctx, source, request.workId);
  requireStoredBinaryWork(current);
  if (
    current.work.state !== "leased" ||
    current.work.leaseOwnerCredentialId !== source.principal.credentialId ||
    current.work.leaseEpoch !== request.leaseEpoch ||
    current.work.leaseToken !== request.leaseToken ||
    !current.work.leaseExpiresAt ||
    current.work.leaseExpiresAt.getTime() <= ctx.now ||
    current.work.expectedDesiredProcessingEpoch === null ||
    current.work.parserFingerprint === null ||
    current.work.correctionRevision === null
  )
    workerProtocolError("lease_conflict");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const pendingId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_binary_operation_receipts
     (id, space_id, created_at, source_account_id, source_item_id,
      discovery_work_id, operation, phase, request_id, request_digest,
      actor_user_id, actor_credential_id, lease_epoch, lease_token_hash,
      created_at_field, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,
      'discovery_admit_archived','pending',$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      pendingId,
      source.spaceId,
      source.account.id,
      current.item.id,
      current.work.id,
      request.requestId,
      requestDigest,
      source.principal.userId,
      source.principal.credentialId,
      request.leaseEpoch,
      leaseTokenHash,
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_OPERATION_RECEIPT_MS)),
    ],
  );
  try {
    const revision = await createOrGetArchivedRevision(ctx.client, {
      spaceId: source.spaceId,
      sourceItemId: current.item.id,
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
    const expectedExtraction = await artifactBoundExtractionFingerprint(
      current.work.parserFingerprint,
      artifact.outputHash,
      current.work.extractionConfigurationFingerprint!,
    );
    if (request.parsedText.extractionFingerprint !== expectedExtraction)
      workerProtocolError("stale_observation");
    const selections: BoundArchive[] = [];
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
        ),
      );
    }
    const byRole = new Map(
      selections.map((selection) => [
        `${selection.receipt.subjectKind}:${selection.receipt.copyRole}`,
        selection,
      ]),
    );
    const originalPrimary = byRole.get("original_bytes:primary");
    const originalBackup = byRole.get("original_bytes:independent_backup");
    const parserPrimary = byRole.get("parser_output:primary");
    const parserBackup = byRole.get("parser_output:independent_backup");
    if (!originalPrimary || !parserPrimary || !parserBackup)
      workerProtocolError("invalid_request");
    if (
      request.providerOriginal &&
      (request.providerOriginal.sourceContentHash !== revision.contentHash ||
        request.providerOriginal.sourceByteLength !== revision.byteLength)
    )
      workerProtocolError("stale_observation");
    const providerOriginal = request.providerOriginal
      ? await createAndBindProviderOriginal(ctx.client, {
          spaceId: source.spaceId,
          sourceAccountId: source.account.id,
          sourceItemId: current.item.id,
          sourceRevisionId: revision.id,
          declaration: request.providerOriginal,
          requestDigest,
          userId: source.principal.userId,
          actorCredentialId: source.principal.credentialId,
          now: at(ctx.now)!,
        })
      : null;
    if (
      (!originalBackup && !providerOriginal) ||
      (originalBackup && providerOriginal)
    )
      workerProtocolError("invalid_request");
    if (originalBackup)
      requireIndependentArchivePair(
        originalPrimary.receipt,
        originalBackup.receipt,
      );
    requireIndependentArchivePair(parserPrimary.receipt, parserBackup.receipt);
    const provider = providerOriginal
      ? {
          reference: { id: providerOriginal.reference.id },
          bindingEpoch: providerOriginal.binding.bindingEpoch,
        }
      : null;
    const archiveDigest = await archiveSetDigest(
      originalPrimary,
      originalBackup,
      provider,
      parserPrimary,
      parserBackup,
    );
    const recovery: ArchiveRecovery = originalBackup
      ? {
          originalPrimaryReceiptId: originalPrimary.receipt.id,
          originalPrimaryBindingEpoch: originalPrimary.binding.bindingEpoch,
          originalBackupReceiptId: originalBackup.receipt.id,
          originalBackupBindingEpoch: originalBackup.binding.bindingEpoch,
        }
      : {
          originalPrimaryReceiptId: originalPrimary.receipt.id,
          originalPrimaryBindingEpoch: originalPrimary.binding.bindingEpoch,
          originalProviderReferenceId: providerOriginal!.reference.id,
          originalProviderBindingEpoch: providerOriginal!.binding.bindingEpoch,
        };
    const textVersion = await createOrGetParsedTextVersion(ctx.client, {
      spaceId: source.spaceId,
      sourceRevisionId: revision.id,
      parserArtifactId: artifact.id,
      extractionFingerprint: request.parsedText.extractionFingerprint,
      textHash: request.parsedText.textHash,
      byteLength: request.parsedText.byteLength,
      utf16Length: request.parsedText.utf16Length,
      pageCount: request.parsedText.pageCount,
      mappingManifestHash: request.parsedText.mappingManifestHash,
    });
    const admitted = await createArchivedIngestWork(ctx, source, current, {
      revision,
      text: textVersion,
      artifact,
      archiveSetDigest: archiveDigest,
      parsedText: request.parsedText,
      recovery,
      parserPrimaryReceiptId: parserPrimary.receipt.id,
      parserBackupReceiptId: parserBackup.receipt.id,
    });
    await exec(
      ctx,
      `UPDATE kith.worker_discovery_work SET state = 'admitted',
       ingest_request_id = $1, source_revision_id = $2,
       processing_generation_id = $3, ingest_job_id = $4,
       lease_token = NULL, lease_owner_credential_id = NULL,
       lease_expires_at = NULL, next_attempt_at = NULL WHERE id = $5`,
      [
        `fs-archive-admit:${current.work.id}`,
        revision.id,
        admitted.generation.id,
        admitted.job.id,
        current.work.id,
      ],
    );
    const admittedCurrent = await requireCurrentDiscovery(
      ctx,
      source,
      current.work.id,
    );
    const archiveReceipts = await validateAdmittedArchiveChain(
      ctx,
      source,
      admittedCurrent,
      {
        sourceRevisionId: revision.id,
        parserArtifactId: artifact.id,
        sourceTextVersionId: textVersion.id,
        processingGenerationId: admitted.generation.id,
        ingestJobId: admitted.job.id,
        desiredProcessingEpoch: admitted.desiredProcessingEpoch,
        archiveSetDigest: archiveDigest,
        parsedText: request.parsedText,
      },
    );
    await exec(
      ctx,
      `UPDATE kith.worker_binary_operation_receipts SET phase = 'completed',
       source_revision_id = $1, parser_artifact_id = $2,
       source_text_version_id = $3, processing_generation_id = $4,
       ingest_job_id = $5, desired_processing_epoch = $6,
       archive_set_digest = $7, original_provider_reference_id = $8,
       original_provider_binding_epoch = $9 WHERE id = $10`,
      [
        revision.id,
        artifact.id,
        textVersion.id,
        admitted.generation.id,
        admitted.job.id,
        admitted.desiredProcessingEpoch,
        archiveDigest,
        "originalProviderReferenceId" in archiveReceipts
          ? archiveReceipts.originalProviderReferenceId!
          : null,
        "originalProviderBindingEpoch" in archiveReceipts
          ? archiveReceipts.originalProviderBindingEpoch!
          : null,
        pendingId,
      ],
    );
    return {
      operation: "discovery.admitArchived",
      workId: current.work.id,
      sourceItemId: current.item.id,
      sourceRevisionId: revision.id,
      parserArtifactId: artifact.id,
      sourceTextVersionId: textVersion.id,
      processingGenerationId: admitted.generation.id,
      ingestJobId: admitted.job.id,
      desiredProcessingEpoch: admitted.desiredProcessingEpoch,
      archiveSetDigest: archiveDigest,
      ...archiveReceipts,
      state: "admitted",
      reused: false,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("desired processing epoch conflict")
    )
      workerProtocolError("desired_processing_epoch_conflict");
    throw error;
  }
}
