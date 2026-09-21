import type {
  WorkerDiscoveryPreviewResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import { newKithId } from "../ids.js";
import { requireWorkerSourceAccount } from "./auth.js";
import {
  linkTriagePreviewsToRevision,
  resolveCurrentArchivedWork,
} from "./archivedDiscovery.js";
import { at, digest, exec, nowPlus, rows, type WorkerCtx } from "./db.js";
import { WORKER_OPERATION_RECEIPT_MS } from "./discovery.js";
import { workerProtocolError } from "./errors.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import { camelizeSourceRevision } from "../provenance/rows.js";
import {
  camelizeSourceTriagePreview,
  type SourceTriagePreviewRow,
} from "./rows.js";

type PreviewRequest = Extract<
  WorkerRequest,
  { operation: "discovery.recordPreview" }
>;

type StoredPreview = SourceTriagePreviewRow & {
  units_match: boolean;
  metadata_match: boolean;
};

async function loadPreview(
  ctx: WorkerCtx,
  key: {
    sourceItemId: string;
    contentHash: string;
    previewFingerprint: string;
    inspectedOriginalUnits: unknown;
    provisionalMetadata: unknown;
  },
): Promise<StoredPreview | null> {
  const found = await rows<Record<string, unknown>>(
    ctx,
    `SELECT p.*,
            p.inspected_original_units = $4::jsonb AS units_match,
            p.provisional_metadata = $5::jsonb AS metadata_match
       FROM kith.source_triage_previews p
      WHERE p.source_item_id = $1 AND p.observed_content_hash = $2
        AND p.preview_fingerprint = $3
      LIMIT 2 FOR UPDATE`,
    [
      key.sourceItemId,
      key.contentHash,
      key.previewFingerprint,
      JSON.stringify(key.inspectedOriginalUnits),
      JSON.stringify(key.provisionalMetadata),
    ],
  );
  if (found.length > 1) workerProtocolError("scan_conflict");
  if (!found[0]) return null;
  return {
    ...camelizeSourceTriagePreview(found[0]),
    units_match: found[0].units_match === true,
    metadata_match: found[0].metadata_match === true,
  };
}

function previewKey(request: PreviewRequest) {
  return {
    sourceItemId: request.identity.sourceItemId,
    contentHash: request.identity.contentHash,
    previewFingerprint: request.preview.previewFingerprint,
    inspectedOriginalUnits: request.preview.inspectedOriginalUnits,
    provisionalMetadata: request.preview.provisionalMetadata,
  };
}

function previewAgrees(
  stored: StoredPreview,
  request: PreviewRequest,
): boolean {
  const preview = request.preview;
  return (
    stored.spaceId === request.spaceId &&
    stored.sourceAccountId === request.sourceAccountId &&
    stored.sourceItemId === request.identity.sourceItemId &&
    stored.observedContentHash === request.identity.contentHash &&
    stored.observedByteLength === request.identity.byteLength &&
    stored.observedMediaType === request.identity.mediaType &&
    stored.previewFingerprint === preview.previewFingerprint &&
    stored.previewMethod === preview.previewMethod &&
    stored.sourceFormat === preview.sourceFormat &&
    (stored.sourceUnitCount === null
      ? preview.sourceUnitCount === null
      : stored.sourceUnitCount === preview.sourceUnitCount) &&
    stored.units_match &&
    stored.metadata_match &&
    (stored.confidence === null
      ? preview.confidence === null
      : stored.confidence === preview.confidence)
  );
}

function result(
  stored: StoredPreview,
  reused: boolean,
): WorkerDiscoveryPreviewResult {
  return {
    operation: "discovery.recordPreview",
    previewId: stored.id,
    sourceItemId: stored.sourceItemId,
    observedContentHash: stored.observedContentHash,
    previewFingerprint: stored.previewFingerprint,
    ...(stored.sourceRevisionId === null
      ? {}
      : { sourceRevisionId: stored.sourceRevisionId }),
    state: stored.sourceRevisionId === null ? "provisional" : "retained",
    reused,
  };
}

async function linkToCurrentRevision(
  ctx: WorkerCtx,
  stored: StoredPreview,
  sourceRevisionId: string | null,
): Promise<StoredPreview> {
  if (sourceRevisionId === null || stored.sourceRevisionId !== null) {
    if (
      sourceRevisionId !== null &&
      stored.sourceRevisionId !== null &&
      stored.sourceRevisionId !== sourceRevisionId
    ) {
      workerProtocolError("scan_conflict");
    }
    return stored;
  }
  const revisionRaw = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.source_revisions WHERE id = $1 LIMIT 2`,
    [sourceRevisionId],
  );
  if (revisionRaw.length !== 1) workerProtocolError("scan_conflict");
  await linkTriagePreviewsToRevision(
    ctx,
    camelizeSourceRevision(revisionRaw[0]!),
  );
  const linked = await loadPreview(ctx, {
    sourceItemId: stored.sourceItemId,
    contentHash: stored.observedContentHash,
    previewFingerprint: stored.previewFingerprint,
    inspectedOriginalUnits: stored.inspectedOriginalUnits,
    provisionalMetadata: stored.provisionalMetadata,
  });
  if (!linked || linked.sourceRevisionId !== sourceRevisionId) {
    workerProtocolError("scan_conflict");
  }
  return linked;
}

/** Persists bounded, provisional metadata without creating retained evidence. */
export async function recordDiscoveryPreview(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: PreviewRequest,
): Promise<WorkerDiscoveryPreviewResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const requestDigest = await digest("worker-discovery-record-preview:v1", [
    source.account.id,
    request,
  ]);

  // This lock serializes both the receipt lookup and the unique preview claim.
  // It also validates the item, scan entry and current non-obsolete work
  // against every field of the hash-bound identity before metadata is stored.
  const current = await resolveCurrentArchivedWork(
    ctx,
    source,
    request.identity,
  );
  const receipts = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_operation_receipts
      WHERE source_account_id = $1
        AND operation = 'discovery_record_preview' AND request_id = $2
      ORDER BY created_at, id LIMIT 2`,
    [source.account.id, request.requestId],
  );
  if (receipts.length > 1) workerProtocolError("scan_conflict");
  const prior = receipts[0];
  if (prior) {
    if (
      prior.space_id !== source.spaceId ||
      prior.actor_user_id !== source.principal.userId ||
      prior.actor_credential_id !== source.principal.credentialId
    ) {
      workerProtocolError("not_found");
    }
    if (
      prior.request_digest !== requestDigest ||
      prior.discovery_work_id !== current.work.id ||
      prior.source_item_id !== current.item.id
    ) {
      workerProtocolError("request_conflict");
    }
    if (new Date(prior.retire_at as string | Date).getTime() <= ctx.now) {
      workerProtocolError("reservation_expired");
    }
    const stored = await loadPreview(ctx, previewKey(request));
    if (!stored || !previewAgrees(stored, request)) {
      workerProtocolError("scan_conflict");
    }
    return result(stored, true);
  }

  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  let stored = await loadPreview(ctx, previewKey(request));
  let reused = true;
  if (stored) {
    if (!previewAgrees(stored, request))
      workerProtocolError("request_conflict");
  } else {
    const preview = request.preview;
    const id = newKithId();
    const inserted = await rows<Record<string, unknown>>(
      ctx,
      `INSERT INTO kith.source_triage_previews
       (id, space_id, source_account_id, source_item_id,
        observed_content_hash, observed_byte_length, observed_media_type,
        observed_observation_epoch, preview_fingerprint, preview_method,
        source_format, source_unit_count, inspected_original_units,
        provisional_metadata, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
       ON CONFLICT (source_item_id, observed_content_hash, preview_fingerprint)
       DO NOTHING RETURNING id`,
      [
        id,
        source.spaceId,
        source.account.id,
        current.item.id,
        request.identity.contentHash,
        request.identity.byteLength,
        request.identity.mediaType,
        request.identity.observationEpoch,
        preview.previewFingerprint,
        preview.previewMethod,
        preview.sourceFormat,
        preview.sourceUnitCount,
        JSON.stringify(preview.inspectedOriginalUnits),
        JSON.stringify(preview.provisionalMetadata),
        preview.confidence,
      ],
    );
    if (inserted.length > 1) workerProtocolError("scan_conflict");
    stored = await loadPreview(ctx, previewKey(request));
    if (!stored) workerProtocolError("scan_conflict");
    if (!previewAgrees(stored, request)) {
      workerProtocolError("request_conflict");
    }
    if (inserted.length === 1 && stored.id !== id) {
      workerProtocolError("scan_conflict");
    }
    reused = inserted.length === 0;
  }

  stored = await linkToCurrentRevision(
    ctx,
    stored,
    current.work.sourceRevisionId,
  );
  await exec(
    ctx,
    `INSERT INTO kith.worker_operation_receipts
     (id, space_id, created_at, source_account_id, source_item_id,
      discovery_work_id, operation, phase, request_id, request_digest,
      actor_user_id, actor_credential_id, result_state, created_at_field,
      retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,
      'discovery_record_preview','completed',$6,$7,$8,$9,$10,$11,$12)`,
    [
      newKithId(),
      source.spaceId,
      source.account.id,
      current.item.id,
      current.work.id,
      request.requestId,
      requestDigest,
      source.principal.userId,
      source.principal.credentialId,
      stored.sourceRevisionId === null ? "provisional" : "retained",
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_OPERATION_RECEIPT_MS)),
    ],
  );
  return result(stored, reused);
}
