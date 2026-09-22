import type {
  TargetedTaxArtifactDeclaration,
  TargetedTaxCoverageDeclaration,
  TargetedTaxGoalKind,
  WorkerRequest,
  WorkerTargetedTaxStatus,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import { schedule } from "../deferred/core.js";
import { sha256 } from "../hash.js";
import { KITH_ID, newKithId } from "../ids.js";
import { requireWorkerSourceAccount } from "./auth.js";
import { exec, row, rows, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
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
type StatusRequest = Extract<
  WorkerRequest,
  { operation: "extraction.targetedTaxStatus" }
>;

export type TargetedTaxBatchManifest = {
  ordinal: number;
  requestId: string;
  requestDigest: string;
  sourceTextVersionId: string | null;
  artifact: TargetedTaxArtifactDeclaration;
  coverage: TargetedTaxCoverageDeclaration;
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
  state: "pending" | "extracted";
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
  const priorFamily = target.batches[0]?.coverage.formFamily;
  const detectedFamily = detectTargetedTaxFormFamily(target.goalKind, request.pages);
  if (
    (priorFamily === undefined && detectedFamily !== request.coverage.formFamily) ||
    (priorFamily !== undefined && priorFamily !== request.coverage.formFamily) ||
    (detectedFamily !== "unknown" && detectedFamily !== request.coverage.formFamily)
  ) workerProtocolError("request_conflict");
  const appendDigest = sha256(
    `kith-targeted-tax-batch:v1\0${JSON.stringify([
      target.id,
      request.sourceRevisionId,
      request.batchOrdinal,
      request.artifact,
      request.pages.map((page) => [page.originalPage, page.textHash]),
      request.coverage,
    ])}`,
  );
  const priorOrdinal = target.batches.find((batch) => batch.ordinal === request.batchOrdinal);
  if (priorOrdinal) {
    if (
      priorOrdinal.requestId !== request.requestId ||
      priorOrdinal.requestDigest !== appendDigest ||
      JSON.stringify(priorOrdinal.artifact) !== JSON.stringify(request.artifact) ||
      JSON.stringify(priorOrdinal.requestedPages) !==
        JSON.stringify(request.pages.map((page) => ({ originalPage: page.originalPage, textHash: page.textHash }))) ||
      JSON.stringify(priorOrdinal.coverage) !== JSON.stringify(request.coverage)
    ) workerProtocolError("request_conflict");
    return result("extraction.appendTargetedTaxBatch", target, true);
  }
  if (target.status === "conflict") {
    return result("extraction.appendTargetedTaxBatch", target, true);
  }
  if (request.batchOrdinal !== target.batches.length) {
    workerProtocolError("request_conflict");
  }
  const priorPages = new Map(
    target.batches.flatMap((batch) =>
      batch.pages.map((page) => [page.originalPage, page.textHash] as const),
    ),
  );
  for (const page of request.pages) {
    if (sha256(page.text) !== page.textHash) workerProtocolError("request_conflict");
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
  const newPages = request.pages.filter(
    (page) => priorPages.get(page.originalPage) === undefined,
  );
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const textVersionId = newPages.length === 0 ? null : newKithId();
  const separator = "\n\f\n";
  let cursor = 0;
  const parts: string[] = [];
  const pageRows: TargetedTaxBatchManifest["pages"] = [];
  for (const [index, page] of newPages.entries()) {
    if (index > 0) {
      parts.push(separator);
      cursor += separator.length;
    }
    const start = cursor;
    parts.push(page.text);
    cursor += page.text.length;
    pageRows.push({
      originalPage: page.originalPage,
      sourcePageId: newKithId(),
      textHash: page.textHash,
    });
    void start;
  }
  const fullText = parts.join("");
  const mappingHash = sha256(
    `kith-targeted-tax-page-map:v1\0${JSON.stringify(
      pageRows.map((page) => [page.originalPage, page.textHash]),
    )}`,
  );
  if (textVersionId !== null) {
    await exec(
      ctx,
      `INSERT INTO kith.source_text_versions
       (id, space_id, created_at, source_revision_id, extraction_fingerprint,
        representation, text_hash, text_hash_authority, byte_length,
        utf16_length, page_count, mapping_manifest_hash, evidence_sealed)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,'targeted_pages_v1',$5,
             'server_verified_retained_text',$6,$7,$8,$9,true)`,
    [
        textVersionId,
      source.spaceId,
      target.sourceRevisionId,
      `targeted-tax:${request.artifact.extractionFingerprint}:${request.artifact.coverageFingerprint}`,
      sha256(fullText),
      Buffer.byteLength(fullText, "utf8"),
      fullText.length,
        newPages.length,
      mappingHash,
      ],
    );
  }
  cursor = 0;
  for (const [index, page] of newPages.entries()) {
    if (index > 0) cursor += separator.length;
    const start = cursor;
    cursor += page.text.length;
    await exec(
      ctx,
      `INSERT INTO kith.source_pages
         (id, space_id, created_at, source_text_version_id, ordinal,
          start, "end", text, text_hash)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8)`,
      [
        pageRows[index]!.sourcePageId,
        source.spaceId,
        textVersionId,
        page.originalPage - 1,
        start,
        cursor,
        page.text,
        page.textHash,
      ],
    );
  }
  const manifest: TargetedTaxBatchManifest = {
    ordinal: request.batchOrdinal,
    requestId: request.requestId,
    requestDigest: appendDigest,
    sourceTextVersionId: textVersionId,
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
    state: newPages.length === 0 ? "extracted" : "pending",
  };
  await exec(
    ctx,
    `UPDATE kith.document_targeted_extractions
        SET batches = batches || $2::jsonb,
            status=CASE WHEN $3::boolean THEN status ELSE 'running' END,
            completed_at=CASE WHEN $3::boolean THEN completed_at ELSE NULL END,
            updated_at=transaction_timestamp()
      WHERE id=$1`,
    [target.id, JSON.stringify([manifest]), newPages.length === 0],
  );
  if (newPages.length > 0) {
    await schedule(ctx, {
      kind: "targeted_tax_extraction",
      spaceId: source.spaceId,
      payload: { spaceId: source.spaceId, targetId: target.id, batchOrdinal: request.batchOrdinal },
      dedupeKey: `${target.id}:${request.batchOrdinal}`,
    });
  }
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
