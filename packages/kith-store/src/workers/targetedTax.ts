import type {
  ArchiveReceiptSelection,
  ParsedTextDeclaration,
  ParserArtifactSelection,
  TargetedPagesCoverage,
} from "@repo/worker-protocol";
import { BINARY_CLASSES } from "@repo/worker-protocol";
import type {
  TargetedTaxArtifactDeclaration,
  TargetedTaxCoverageDeclaration,
  TargetedTaxGoalKind,
  WorkerRequest,
  WorkerTargetedTaxAdmissionResult,
  WorkerTargetedTaxStatus,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import { schedule } from "../deferred/core.js";
import { sha256 } from "../hash.js";
import { KITH_ID, newKithId } from "../ids.js";
import { requireWorkerSourceAccount } from "./auth.js";
import { at, digest, exec, row, rows, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import {
  archiveSetDigest,
  type BoundArchive,
} from "./archivedDiscovery.js";
import { artifactBoundExtractionFingerprint } from "./entries.js";
import {
  bindInitialArchiveReceipt,
  createOrGetArchiveReceipt,
  createOrGetParsedTextVersion,
  createOrGetParserArtifact,
  loadProviderOriginalBinding,
  parseSourceRevisionRepresentation,
  sameTargetedPagesCoverage,
} from "../provenance/index.js";
import {
  camelizeProcessingGeneration,
  camelizeSourceArtifactArchiveReceipt,
  camelizeSourceParserArtifact,
  camelizeSourceRevision,
  type SourceParserArtifactRow,
  type SourceRevisionRow,
} from "../provenance/rows.js";
import { digestProcessingConfiguration } from "../ingestion/inline.js";
import {
  detectTargetedTaxFormFamily,
  targetedTaxFieldsAgree,
} from "../extraction/targetedTax.js";

type BeginRequest = Extract<
  WorkerRequest,
  { operation: "extraction.beginTargetedTax" }
>;
type AppendRequest = Extract<
  WorkerRequest,
  { operation: "extraction.appendTargetedTaxBatch" }
>;
type AdmitBatchRequest = Extract<
  WorkerRequest,
  { operation: "extraction.admitTargetedTaxBatch" }
>;
type StatusRequest = Extract<
  WorkerRequest,
  { operation: "extraction.targetedTaxStatus" }
>;

function sameArtifact(
  left: TargetedTaxArtifactDeclaration,
  right: TargetedTaxArtifactDeclaration,
): boolean {
  return (
    left.artifactKind === right.artifactKind &&
    left.sourceSha256 === right.sourceSha256 &&
    left.selectedPdfSha256 === right.selectedPdfSha256 &&
    left.sourcePageCount === right.sourcePageCount &&
    left.coverageFingerprint === right.coverageFingerprint &&
    left.artifactFingerprint === right.artifactFingerprint &&
    left.parserFingerprint === right.parserFingerprint &&
    left.extractionFingerprint === right.extractionFingerprint &&
    left.originalPages.length === right.originalPages.length &&
    left.originalPages.every((page, index) => page === right.originalPages[index])
  );
}

function sameCoverage(
  left: TargetedTaxCoverageDeclaration | null,
  right: TargetedTaxCoverageDeclaration,
): boolean {
  return Boolean(
    left &&
      left.formFamily === right.formFamily &&
      left.requestedRegionsClosed === right.requestedRegionsClosed &&
      left.continuationsClosed === right.continuationsClosed,
  );
}

function sameRequestedPages(
  left: TargetedTaxBatchManifest["requestedPages"],
  right: AppendRequest["pages"],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (page, index) =>
        page.originalPage === right[index]!.originalPage &&
        page.textHash === right[index]!.textHash,
    )
  );
}

export type TargetedTaxBatchManifest = {
  ordinal: number;
  requestId: string | null;
  requestDigest: string | null;
  admissionRequestId: string | null;
  admissionRequestDigest: string | null;
  sourceTextVersionId: string | null;
  processingGenerationId: string;
  artifact: TargetedTaxArtifactDeclaration;
  coverage: TargetedTaxCoverageDeclaration | null;
  requestedPages: Array<{ originalPage: number; textHash: string }>;
  artifactFingerprint: string;
  coverageFingerprint: string;
  selectedPdfSha256: string;
  parserFingerprint: string;
  extractionFingerprint: string;
  pages: Array<{
    originalPage: number;
    sourcePageId: string;
    textHash: string;
  }>;
  state: "admitted" | "pending" | "extracted";
};

export type TargetedTaxOutcome = {
  field: string;
  status: "cited" | "conflict";
  valueType: string;
  readings: Array<{
    value: unknown;
    currencyAssumed?: true;
    citations: Array<{
      sourceTextVersionId: string;
      sourcePageId: string;
      originalPage: number;
      evidenceSpanId: string;
    }>;
  }>;
};

export type TargetedTaxRow = {
  id: string;
  spaceId: string;
  sourceAccountId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  goalKind: TargetedTaxGoalKind;
  goalVersion: number;
  instanceKey: string;
  requestDigest: string;
  sourcePageCount: number;
  requiredFields: string[];
  optionalFields: string[];
  status: WorkerTargetedTaxStatus["status"];
  batches: TargetedTaxBatchManifest[];
  outcomes: TargetedTaxOutcome[];
  unresolvedCodes: string[];
  model: string | null;
};

function camel(raw: Record<string, unknown>): TargetedTaxRow {
  return {
    id: String(raw.id),
    spaceId: String(raw.space_id),
    sourceAccountId: String(raw.source_account_id),
    sourceItemId: String(raw.source_item_id),
    sourceRevisionId: String(raw.source_revision_id),
    goalKind: raw.goal_kind as TargetedTaxGoalKind,
    goalVersion: Number(raw.goal_version),
    instanceKey: String(raw.instance_key),
    requestDigest: String(raw.request_digest),
    sourcePageCount: Number(raw.source_page_count),
    requiredFields: raw.required_fields as string[],
    optionalFields: raw.optional_fields as string[],
    status: raw.status as TargetedTaxRow["status"],
    batches: raw.batches as TargetedTaxBatchManifest[],
    outcomes: raw.outcomes as TargetedTaxOutcome[],
    unresolvedCodes: raw.unresolved_codes as string[],
    model: (raw.model ?? null) as string | null,
  };
}

function goalDigest(request: BeginRequest): string {
  return sha256(
    `kith-targeted-tax-goal:v1\0${JSON.stringify([
      request.sourceItemId,
      request.sourceRevisionId,
      request.observedContentHash,
      request.goalKind,
      request.instanceKey,
      request.requiredFields,
      request.optionalFields,
      request.sourcePageCount,
    ])}`,
  );
}

async function loadTarget(
  ctx: WorkerCtx,
  source: { spaceId: string; account: { id: string } },
  targetId: string,
  lock = false,
): Promise<TargetedTaxRow> {
  if (!KITH_ID.test(targetId)) workerProtocolError("invalid_request");
  const found = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.document_targeted_extractions
      WHERE id = $1 AND space_id = $2 AND source_account_id = $3
      LIMIT 2${lock ? " FOR UPDATE" : ""}`,
    [targetId, source.spaceId, source.account.id],
  );
  if (found.length !== 1) workerProtocolError("not_found");
  return camel(found[0]!);
}

async function requireCurrentRevision(
  ctx: WorkerCtx,
  source: { spaceId: string; account: { id: string } },
  sourceItemId: string,
  sourceRevisionId: string,
  contentHash?: string,
): Promise<void> {
  if (!KITH_ID.test(sourceItemId) || !KITH_ID.test(sourceRevisionId)) {
    workerProtocolError("invalid_request");
  }
  const current = await row<Record<string, unknown>>(
    ctx,
    `SELECT i.id, i.lifecycle, i.desired_revision_id, i.worker_content_hash,
            r.content_hash
       FROM kith.source_items i
       JOIN kith.source_revisions r
         ON r.id = $2 AND r.source_item_id = i.id AND r.space_id = i.space_id
      WHERE i.id = $1 AND i.space_id = $3 AND i.source_account_id = $4
      FOR UPDATE OF i`,
    [sourceItemId, sourceRevisionId, source.spaceId, source.account.id],
  );
  if (!current) workerProtocolError("not_found");
  if (
    current.lifecycle !== "available" ||
    current.desired_revision_id !== sourceRevisionId ||
    (contentHash !== undefined &&
      (current.content_hash !== contentHash ||
        current.worker_content_hash !== contentHash))
  ) {
    workerProtocolError("stale_observation");
  }
}

async function targetedParserArtifact(
  ctx: WorkerCtx,
  source: Awaited<ReturnType<typeof requireWorkerSourceAccount>>,
  target: TargetedTaxRow,
  request: AdmitBatchRequest,
): Promise<SourceParserArtifactRow> {
  const selection: ParserArtifactSelection = request.parserArtifact;
  if (selection.kind === "create") {
    if (
      selection.outputMediaType !==
      BINARY_CLASSES.pdf_docqa_v1.parserOutputMediaType
    ) workerProtocolError("invalid_request");
    return createOrGetParserArtifact(ctx.client, {
      spaceId: source.spaceId,
      sourceAccountId: source.account.id,
      sourceItemId: target.sourceItemId,
      sourceRevisionId: target.sourceRevisionId,
      clientArtifactId: selection.clientArtifactId,
      parserFingerprint: request.artifact.parserFingerprint,
      targetedSelectionFingerprint: request.artifact.artifactFingerprint,
      outputHash: selection.outputHash,
      outputByteLength: selection.outputByteLength,
      outputMediaType: selection.outputMediaType,
      userId: source.principal.userId,
      actorCredentialId: source.principal.credentialId,
      createdAt: at(selection.createdAt)!,
    });
  }
  if (!KITH_ID.test(selection.parserArtifactId))
    workerProtocolError("invalid_request");
  const raw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_parser_artifacts WHERE id=$1",
    [selection.parserArtifactId],
  );
  const artifact = raw ? camelizeSourceParserArtifact(raw) : null;
  if (
    !artifact ||
    artifact.spaceId !== source.spaceId ||
    artifact.sourceAccountId !== source.account.id ||
    artifact.sourceItemId !== target.sourceItemId ||
    artifact.sourceRevisionId !== target.sourceRevisionId ||
    artifact.parserFingerprint !== request.artifact.parserFingerprint ||
    artifact.targetedSelectionFingerprint !==
      request.artifact.artifactFingerprint ||
    artifact.outputMediaType !==
      BINARY_CLASSES.pdf_docqa_v1.parserOutputMediaType
  ) workerProtocolError("stale_observation");
  return artifact;
}

async function targetedParserArchive(
  ctx: WorkerCtx,
  source: Awaited<ReturnType<typeof requireWorkerSourceAccount>>,
  target: TargetedTaxRow,
  revision: SourceRevisionRow,
  artifact: SourceParserArtifactRow,
  selection: ArchiveReceiptSelection,
  requestDigest: string,
): Promise<BoundArchive> {
  let receipt;
  if (selection.kind === "create") {
    receipt = await createOrGetArchiveReceipt(ctx.client, {
      spaceId: source.spaceId,
      sourceAccountId: source.account.id,
      sourceItemId: target.sourceItemId,
      sourceRevisionId: revision.id,
      parserArtifactId: artifact.id,
      subjectKind: "parser_output",
      copyRole: "primary",
      clientReceiptId: selection.clientReceiptId,
      requestDigest: await digest("targeted-tax-parser-receipt:v1", [
        requestDigest,
        selection.clientReceiptId,
      ]),
      archiveProfileFingerprint: selection.archiveProfileFingerprint,
      archiveIdentityFingerprint: selection.archiveIdentityFingerprint,
      recipientFingerprint: selection.recipientFingerprint,
      repositoryKeyDomainFingerprint: selection.repositoryKeyDomainFingerprint,
      storageFailureDomainFingerprint:
        selection.storageFailureDomainFingerprint,
      archiveObjectId: selection.archiveObjectId,
      plaintextHash: artifact.outputHash,
      plaintextByteLength: artifact.outputByteLength,
      plaintextMediaType: artifact.outputMediaType,
      ciphertextHash: selection.ciphertextHash,
      ciphertextByteLength: selection.ciphertextByteLength,
      readbackVerifiedAt: at(selection.readbackVerifiedAt)!,
      userId: source.principal.userId,
      actorCredentialId: source.principal.credentialId,
      createdAt: at(selection.createdAt)!,
    });
  } else {
    const raw = await row<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.source_artifact_archive_receipts WHERE id=$1",
      [selection.receiptId],
    );
    receipt = raw ? camelizeSourceArtifactArchiveReceipt(raw) : null;
  }
  if (
    !receipt ||
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account.id ||
    receipt.sourceItemId !== target.sourceItemId ||
    receipt.sourceRevisionId !== revision.id ||
    receipt.parserArtifactId !== artifact.id ||
    receipt.subjectKind !== "parser_output" ||
    receipt.copyRole !== "primary"
  ) workerProtocolError("stale_observation");
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

function result(
  operation: WorkerTargetedTaxStatus["operation"],
  target: TargetedTaxRow,
  reused: boolean,
): WorkerTargetedTaxStatus {
  const inspectedOriginalPages = [
    ...new Set(target.batches.flatMap((batch) => batch.pages.map((page) => page.originalPage))),
  ].sort((a, b) => a - b);
  const cited = new Set(
    target.outcomes
      .filter((outcome) => outcome.status === "cited")
      .map((outcome) => outcome.field),
  );
  return {
    operation,
    targetId: target.id,
    sourceItemId: target.sourceItemId,
    sourceRevisionId: target.sourceRevisionId,
    goalKind: target.goalKind,
    status: target.status,
    inspectedOriginalPages,
    unresolvedFields: target.requiredFields.filter((field) => !cited.has(field)),
    reused,
  };
}

export async function beginTargetedTaxExtraction(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: BeginRequest,
): Promise<WorkerTargetedTaxStatus> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  if (goalDigest(request) !== request.requestDigest) {
    workerProtocolError("request_conflict");
  }
  if (
    !targetedTaxFieldsAgree(
      request.goalKind,
      request.requiredFields,
      request.optionalFields,
    )
  ) workerProtocolError("invalid_request");
  await requireCurrentRevision(
    ctx,
    source,
    request.sourceItemId,
    request.sourceRevisionId,
    request.observedContentHash,
  );
  const existingRows = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.document_targeted_extractions
      WHERE source_revision_id = $1 AND goal_kind = $2
        AND goal_version = 1 AND instance_key = $3
      LIMIT 2 FOR UPDATE`,
    [request.sourceRevisionId, request.goalKind, request.instanceKey],
  );
  if (existingRows.length > 1) workerProtocolError("scan_conflict");
  if (existingRows[0]) {
    const existing = camel(existingRows[0]);
    if (
      existing.spaceId !== source.spaceId ||
      existing.sourceAccountId !== source.account.id ||
      existing.sourceItemId !== request.sourceItemId ||
      existing.requestDigest !== request.requestDigest ||
      existing.sourcePageCount !== request.sourcePageCount ||
      JSON.stringify(existing.requiredFields) !== JSON.stringify(request.requiredFields) ||
      JSON.stringify(existing.optionalFields) !== JSON.stringify(request.optionalFields)
    ) workerProtocolError("request_conflict");
    return result("extraction.beginTargetedTax", existing, true);
  }
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const id = newKithId();
  const inserted = await row<Record<string, unknown>>(
    ctx,
    `INSERT INTO kith.document_targeted_extractions
       (id, space_id, source_account_id, source_item_id, source_revision_id,
        goal_kind, goal_version, instance_key, request_digest, source_page_count,
        required_fields, optional_fields, status)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10::jsonb,$11::jsonb,'awaiting_pages')
     RETURNING *`,
    [
      id,
      source.spaceId,
      source.account.id,
      request.sourceItemId,
      request.sourceRevisionId,
      request.goalKind,
      request.instanceKey,
      request.requestDigest,
      request.sourcePageCount,
      JSON.stringify(request.requiredFields),
      JSON.stringify(request.optionalFields),
    ],
  );
  return result("extraction.beginTargetedTax", camel(inserted!), false);
}

export async function admitTargetedTaxBatch(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: AdmitBatchRequest,
): Promise<WorkerTargetedTaxAdmissionResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const target = await loadTarget(ctx, source, request.targetId, true);
  if (
    target.sourceRevisionId !== request.sourceRevisionId ||
    request.artifact.sourceSha256 !==
      request.parsedText.targetedCoverage?.sourceSha256 ||
    request.artifact.sourcePageCount !== target.sourcePageCount
  ) workerProtocolError("request_conflict");
  await requireCurrentRevision(
    ctx,
    source,
    target.sourceItemId,
    target.sourceRevisionId,
    request.artifact.sourceSha256,
  );
  const admissionDigest = await digest("targeted-tax-batch-admit:v1", [
    source.account.id,
    request,
  ]);
  const priorBatch = target.batches.at(-1);
  const replay = target.batches.find(
    (batch) => batch.ordinal === request.batchOrdinal,
  );
  if (replay) {
    if (
      replay.admissionRequestId !== request.requestId ||
      replay.admissionRequestDigest !== admissionDigest ||
      replay.processingGenerationId === null ||
      replay.sourceTextVersionId === null ||
      !sameArtifact(replay.artifact, request.artifact)
    ) workerProtocolError("request_conflict");
    const job = await row<Record<string, unknown>>(
      ctx,
      `SELECT id FROM kith.ingest_jobs
        WHERE targeted_extraction_id=$1 AND targeted_batch_ordinal=$2
          AND processing_generation_id=$3
        LIMIT 2`,
      [target.id, request.batchOrdinal, replay.processingGenerationId],
    );
    if (!job) workerProtocolError("scan_conflict");
    const generation = await row<Record<string, unknown>>(
      ctx,
      "SELECT parser_artifact_id FROM kith.processing_generations WHERE id=$1",
      [replay.processingGenerationId],
    );
    if (!generation?.parser_artifact_id) workerProtocolError("scan_conflict");
    return {
      operation: "extraction.admitTargetedTaxBatch",
      targetId: target.id,
      sourceItemId: target.sourceItemId,
      sourceRevisionId: target.sourceRevisionId,
      batchOrdinal: request.batchOrdinal,
      parserArtifactId: String(generation.parser_artifact_id),
      sourceTextVersionId: replay.sourceTextVersionId,
      processingGenerationId: replay.processingGenerationId,
      ingestJobId: String(job.id),
      state: "admitted",
      reused: true,
    };
  }
  if (
    request.batchOrdinal !== target.batches.length ||
    request.batchOrdinal < 1 ||
    !priorBatch ||
    priorBatch.state !== "extracted" ||
    priorBatch.processingGenerationId !== request.priorProcessingGenerationId ||
    target.status === "complete" ||
    target.status === "conflict"
  ) workerProtocolError("stale_observation");
  const revisionRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_revisions WHERE id=$1 FOR UPDATE",
    [target.sourceRevisionId],
  );
  const revision = revisionRaw ? camelizeSourceRevision(revisionRaw) : null;
  if (!revision) workerProtocolError("not_found");
  let revisionRepresentation;
  try {
    revisionRepresentation = parseSourceRevisionRepresentation(revision);
  } catch {
    workerProtocolError("scan_conflict");
  }
  if (
    revisionRepresentation!.kind !== "archived_binary_v1" ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== target.sourceItemId ||
    revision.contentHash !== request.artifact.sourceSha256
  ) workerProtocolError("stale_observation");
  const provider = await loadProviderOriginalBinding(
    ctx.client,
    revision.id,
  );
  if (
    !provider ||
    provider.reference.id !== request.existingProviderOriginal.referenceId ||
    provider.reference.referenceVersion !== "provider_original_v2" ||
    provider.binding.bindingEpoch !==
      request.existingProviderOriginal.bindingEpoch ||
    provider.binding.spaceId !== source.spaceId ||
    provider.binding.sourceAccountId !== source.account.id ||
    provider.binding.sourceItemId !== target.sourceItemId
  ) workerProtocolError("stale_observation");
  const priorGenerationRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.processing_generations WHERE id=$1 FOR UPDATE",
    [request.priorProcessingGenerationId],
  );
  const priorGeneration = priorGenerationRaw
    ? camelizeProcessingGeneration(priorGenerationRaw)
    : null;
  if (
    !priorGeneration ||
    priorGeneration.spaceId !== source.spaceId ||
    priorGeneration.sourceAccountId !== source.account.id ||
    priorGeneration.sourceItemId !== target.sourceItemId ||
    priorGeneration.sourceRevisionId !== target.sourceRevisionId ||
    priorGeneration.state !== "staged" ||
    priorGeneration.extractorFingerprint === null ||
    priorGeneration.recordSchemaFingerprint === null ||
    priorGeneration.normalizationFingerprint === null ||
    priorGeneration.chunkerFingerprint === null
  ) workerProtocolError("stale_observation");
  const priorJob = await row<Record<string, unknown>>(
    ctx,
    `SELECT worker_discovery_work_id FROM kith.ingest_jobs
      WHERE processing_generation_id=$1 AND source_account_id=$2
      ORDER BY created_at, id LIMIT 2`,
    [priorGeneration.id, source.account.id],
  );
  if (!priorJob?.worker_discovery_work_id)
    workerProtocolError("scan_conflict");
  const artifact = await targetedParserArtifact(ctx, source, target, request);
  const expectedExtraction = await artifactBoundExtractionFingerprint(
    request.artifact.parserFingerprint,
    artifact.outputHash,
    request.extractionConfigurationFingerprint,
  );
  if (
    expectedExtraction !== request.artifact.extractionFingerprint ||
    expectedExtraction !== request.parsedText.extractionFingerprint
  ) workerProtocolError("stale_observation");
  const parserPrimary = await targetedParserArchive(
    ctx,
    source,
    target,
    revision,
    artifact,
    request.archives[0]!,
    admissionDigest,
  );
  const archiveDigest = await archiveSetDigest(
    undefined,
    undefined,
    {
      reference: {
        id: provider.reference.id,
        referenceVersion: "provider_original_v2",
      },
      bindingEpoch: provider.binding.bindingEpoch,
    },
    parserPrimary,
    undefined,
  );
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
    representation: "targeted_pages_v1",
    targetedCoverage: request.parsedText.targetedCoverage,
  });
  const correctionRevision = `targeted-tax-batch-v1:${target.id}:${request.batchOrdinal}`;
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: request.parsedText.extractionFingerprint,
    extractorFingerprint: priorGeneration.extractorFingerprint,
    recordSchemaFingerprint: priorGeneration.recordSchemaFingerprint,
    normalizationFingerprint: priorGeneration.normalizationFingerprint,
    chunkerFingerprint: priorGeneration.chunkerFingerprint,
    correctionRevision,
  });
  const item = await row<Record<string, unknown>>(
    ctx,
    `SELECT desired_processing_epoch FROM kith.source_items
      WHERE id=$1 AND space_id=$2 AND source_account_id=$3 AND lifecycle='available'
      FOR UPDATE`,
    [target.sourceItemId, source.spaceId, source.account.id],
  );
  if (!item || !Number.isSafeInteger(Number(item.desired_processing_epoch)))
    workerProtocolError("stale_observation");
  const generationId = newKithId();
  const jobId = newKithId();
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
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
      $13,$14,$15,$16,NULL,NULL,$17,$18,$19,NULL,$20,false,'queued',$21,$22,$23,
      $24,0,0,'unavailable')`,
    [
      generationId,
      source.spaceId,
      source.account.id,
      target.sourceItemId,
      revision.id,
      textVersion.id,
      processingFingerprint,
      request.parsedText.extractionFingerprint,
      priorGeneration.extractorFingerprint,
      priorGeneration.recordSchemaFingerprint,
      priorGeneration.normalizationFingerprint,
      priorGeneration.chunkerFingerprint,
      correctionRevision,
      artifact.id,
      archiveDigest,
      request.parsedText.normalizedBundleDigest,
      provider.reference.id,
      provider.binding.bindingEpoch,
      parserPrimary.receipt.id,
      Number(item.desired_processing_epoch),
      request.parsedText.pageCount,
      request.parsedText.expectedEvidenceSpanCount,
      request.parsedText.expectedDocumentCount,
      request.parsedText.expectedChunkCount,
    ],
  );
  await exec(
    ctx,
    `INSERT INTO kith.ingest_jobs
     (id, space_id, created_at, source_account_id, source_item_id,
      source_revision_id, processing_generation_id, admitted_by_user_id,
      admitted_by_credential_id, actor_user_id, actor_credential_id,
      desired_processing_epoch, state, attempts, lease_epoch, worker_managed,
      worker_discovery_work_id, worker_observation_epoch, worker_processing_mode,
      targeted_extraction_id, targeted_batch_ordinal)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$7,$8,$9,
      'queued',0,0,true,$10,NULL,'targeted_pages_v1',$11,$12)`,
    [
      jobId,
      source.spaceId,
      source.account.id,
      target.sourceItemId,
      revision.id,
      generationId,
      source.principal.userId,
      source.principal.credentialId,
      Number(item.desired_processing_epoch),
      String(priorJob.worker_discovery_work_id),
      target.id,
      request.batchOrdinal,
    ],
  );
  const manifest: TargetedTaxBatchManifest = {
    ordinal: request.batchOrdinal,
    requestId: null,
    requestDigest: null,
    admissionRequestId: request.requestId,
    admissionRequestDigest: admissionDigest,
    sourceTextVersionId: textVersion.id,
    processingGenerationId: generationId,
    artifact: request.artifact,
    coverage: null,
    requestedPages: [],
    artifactFingerprint: request.artifact.artifactFingerprint,
    coverageFingerprint: request.artifact.coverageFingerprint,
    selectedPdfSha256: request.artifact.selectedPdfSha256,
    parserFingerprint: request.artifact.parserFingerprint,
    extractionFingerprint: request.artifact.extractionFingerprint,
    pages: [],
    state: "admitted",
  };
  await exec(
    ctx,
    `UPDATE kith.document_targeted_extractions
        SET batches=batches || $2::jsonb, updated_at=transaction_timestamp()
      WHERE id=$1`,
    [target.id, JSON.stringify([manifest])],
  );
  return {
    operation: "extraction.admitTargetedTaxBatch",
    targetId: target.id,
    sourceItemId: target.sourceItemId,
    sourceRevisionId: target.sourceRevisionId,
    batchOrdinal: request.batchOrdinal,
    parserArtifactId: artifact.id,
    sourceTextVersionId: textVersion.id,
    processingGenerationId: generationId,
    ingestJobId: jobId,
    state: "admitted",
    reused: false,
  };
}

export async function appendTargetedTaxBatch(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: AppendRequest,
): Promise<WorkerTargetedTaxStatus> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const target = await loadTarget(ctx, source, request.targetId, true);
  if (target.sourceRevisionId !== request.sourceRevisionId) {
    workerProtocolError("request_conflict");
  }
  await requireCurrentRevision(
    ctx,
    source,
    target.sourceItemId,
    target.sourceRevisionId,
    request.artifact.sourceSha256,
  );
  if (request.artifact.sourcePageCount !== target.sourcePageCount) {
    workerProtocolError("request_conflict");
  }
  const appendDigest = sha256(
    `kith-targeted-tax-batch:v1\0${JSON.stringify([
      target.id,
      request.sourceRevisionId,
      request.batchOrdinal,
      request.sourceTextVersionId,
      request.processingGenerationId,
      request.artifact,
      request.pages.map((page) => [page.originalPage, page.textHash]),
      request.coverage,
    ])}`,
  );
  const priorOrdinal = target.batches.find((batch) => batch.ordinal === request.batchOrdinal);
  if (priorOrdinal && priorOrdinal.state !== "admitted") {
    if (
      priorOrdinal.requestId !== request.requestId ||
      priorOrdinal.requestDigest !== appendDigest ||
      priorOrdinal.sourceTextVersionId !== request.sourceTextVersionId ||
      priorOrdinal.processingGenerationId !== request.processingGenerationId ||
      !sameArtifact(priorOrdinal.artifact, request.artifact) ||
      !sameRequestedPages(priorOrdinal.requestedPages, request.pages) ||
      !sameCoverage(priorOrdinal.coverage, request.coverage)
    ) workerProtocolError("request_conflict");
    return result("extraction.appendTargetedTaxBatch", target, true);
  }
  if (target.status === "conflict") {
    return result("extraction.appendTargetedTaxBatch", target, true);
  }
  if (
    priorOrdinal?.state === "admitted"
      ? priorOrdinal.sourceTextVersionId !== request.sourceTextVersionId ||
        priorOrdinal.processingGenerationId !== request.processingGenerationId ||
        !sameArtifact(priorOrdinal.artifact, request.artifact)
      : request.batchOrdinal !== target.batches.length
  ) {
    workerProtocolError("request_conflict");
  }
  const priorPages = new Map(
    target.batches.flatMap((batch) =>
      batch.pages.map((page) => [page.originalPage, page.textHash] as const),
    ),
  );
  for (const page of request.pages) {
    const prior = priorPages.get(page.originalPage);
    if (prior !== undefined && prior !== page.textHash) {
      await exec(
        ctx,
        `UPDATE kith.document_targeted_extractions
            SET status='conflict',
                unresolved_codes='["overlapping_page_changed"]'::jsonb,
                updated_at=transaction_timestamp()
          WHERE id=$1`,
        [target.id],
      );
      const conflicted = await loadTarget(ctx, source, target.id);
      return result("extraction.appendTargetedTaxBatch", conflicted, false);
    }
  }
  if (request.pages.some((page) => priorPages.has(page.originalPage))) {
    workerProtocolError("request_conflict");
  }
  const admitted = await row<Record<string, unknown>>(
    ctx,
    `SELECT t.id AS text_id, t.source_revision_id, t.representation,
            t.parser_artifact_id, t.extraction_fingerprint, t.page_count,
            t.evidence_sealed, t.targeted_coverage, g.id AS generation_id, g.source_account_id,
            g.source_item_id, g.source_revision_id AS generation_revision_id,
            g.state AS generation_state, g.source_text_version_id,
            g.parser_artifact_id AS generation_artifact_id,
            a.parser_fingerprint
       FROM kith.source_text_versions t
       JOIN kith.processing_generations g
         ON g.id=$2 AND g.source_text_version_id=t.id AND g.space_id=t.space_id
       JOIN kith.source_parser_artifacts a
         ON a.id=t.parser_artifact_id AND a.space_id=t.space_id
      WHERE t.id=$1 AND t.space_id=$3
      FOR UPDATE OF t,g`,
    [request.sourceTextVersionId, request.processingGenerationId, source.spaceId],
  );
  if (
    !admitted ||
    admitted.representation !== "targeted_pages_v1" ||
    admitted.source_revision_id !== target.sourceRevisionId ||
    admitted.generation_revision_id !== target.sourceRevisionId ||
    admitted.source_account_id !== source.account.id ||
    admitted.source_item_id !== target.sourceItemId ||
    admitted.generation_state !== "staged" ||
    admitted.evidence_sealed !== true ||
    admitted.parser_artifact_id !== admitted.generation_artifact_id ||
    admitted.extraction_fingerprint !== request.artifact.extractionFingerprint ||
    admitted.parser_fingerprint !== request.artifact.parserFingerprint ||
    Number(admitted.page_count) !== request.pages.length ||
    !sameTargetedPagesCoverage(
      admitted.targeted_coverage as TargetedPagesCoverage | null,
      {
        sourceSha256: request.artifact.sourceSha256,
        selectedPdfSha256: request.artifact.selectedPdfSha256,
        sourcePageCount: request.artifact.sourcePageCount,
        originalPages: request.artifact.originalPages,
        coverageFingerprint: request.artifact.coverageFingerprint,
        artifactFingerprint: request.artifact.artifactFingerprint,
      },
    )
  ) workerProtocolError("request_conflict");
  const storedPages = await rows<Record<string, unknown>>(
    ctx,
    `SELECT id, ordinal, text, text_hash FROM kith.source_pages
      WHERE source_text_version_id=$1 AND space_id=$2
      ORDER BY ordinal, id LIMIT 13`,
    [request.sourceTextVersionId, source.spaceId],
  );
  if (
    storedPages.length !== request.pages.length ||
    storedPages.some((page, index) =>
      Number(page.ordinal) !== index ||
      page.text_hash !== request.pages[index]!.textHash ||
      sha256(String(page.text)) !== request.pages[index]!.textHash
    )
  ) workerProtocolError("request_conflict");
  const priorFamily = target.batches.find((batch) => batch.coverage !== null)
    ?.coverage?.formFamily;
  const detectedFamily = detectTargetedTaxFormFamily(
    target.goalKind,
    storedPages.map((page) => ({ text: String(page.text) })),
  );
  if (
    (priorFamily === undefined && detectedFamily !== request.coverage.formFamily) ||
    (priorFamily !== undefined && priorFamily !== request.coverage.formFamily) ||
    (detectedFamily !== "unknown" && detectedFamily !== request.coverage.formFamily)
  ) workerProtocolError("request_conflict");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const pageRows: TargetedTaxBatchManifest["pages"] = storedPages.map((page, index) => ({
    originalPage: request.pages[index]!.originalPage,
    sourcePageId: String(page.id),
    textHash: String(page.text_hash),
  }));
  const manifest: TargetedTaxBatchManifest = {
    ordinal: request.batchOrdinal,
    requestId: request.requestId,
    requestDigest: appendDigest,
    admissionRequestId: priorOrdinal?.admissionRequestId ?? null,
    admissionRequestDigest: priorOrdinal?.admissionRequestDigest ?? null,
    sourceTextVersionId: request.sourceTextVersionId,
    processingGenerationId: request.processingGenerationId,
    artifact: request.artifact,
    coverage: request.coverage,
    requestedPages: request.pages.map((page) => ({
      originalPage: page.originalPage,
      textHash: page.textHash,
    })),
    artifactFingerprint: request.artifact.artifactFingerprint,
    coverageFingerprint: request.artifact.coverageFingerprint,
    selectedPdfSha256: request.artifact.selectedPdfSha256,
    parserFingerprint: request.artifact.parserFingerprint,
    extractionFingerprint: request.artifact.extractionFingerprint,
    pages: pageRows,
    state: "pending",
  };
  await exec(
    ctx,
    `UPDATE kith.document_targeted_extractions
        SET batches = $2::jsonb,
            status='running', completed_at=NULL,
            updated_at=transaction_timestamp()
      WHERE id=$1`,
    [
      target.id,
      JSON.stringify(
        priorOrdinal?.state === "admitted"
          ? target.batches.map((batch) =>
              batch.ordinal === request.batchOrdinal ? manifest : batch,
            )
          : [...target.batches, manifest],
      ),
    ],
  );
  await schedule(ctx, {
    kind: "targeted_tax_extraction",
    spaceId: source.spaceId,
    payload: { spaceId: source.spaceId, targetId: target.id, batchOrdinal: request.batchOrdinal },
    dedupeKey: `${target.id}:${request.batchOrdinal}`,
  });
  const updated = await loadTarget(ctx, source, target.id);
  return result("extraction.appendTargetedTaxBatch", updated, false);
}

export async function getTargetedTaxStatus(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: StatusRequest,
): Promise<WorkerTargetedTaxStatus> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const target = await loadTarget(ctx, source, request.targetId);
  await requireCurrentRevision(
    ctx,
    source,
    target.sourceItemId,
    target.sourceRevisionId,
  );
  return result("extraction.targetedTaxStatus", target, true);
}
