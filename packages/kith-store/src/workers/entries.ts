// Resolving one discovered file into a scan entry, and, when it is new work,
// into a discovery work row.
//
// This is the port of `model.ts`'s `resolveAndPersistEntry`,
// `persistResolvedEntry`, `createDiscoveryWork`, `obsoletePriorWork` and their
// helpers: about 900 lines of Convex and the densest part of row e. Nothing in it
// is simplified, because every branch is an identity decision with a durable
// consequence, and the consequences are asymmetric. Admitting a file twice under
// two identities duplicates a document in the index; failing to notice a changed
// file leaves a stale document indexed as current; resolving an ambiguous identity
// in the caller's favour attaches new bytes to an existing item's provenance
// chain. So every ambiguity becomes a `needs_review` entry with a named issue
// code, and every inconsistency between two rows that should agree becomes
// `scan_conflict`.
//
// Two structural differences from the original, both forced by the platform and
// neither changing a decision:
//
//   * Convex `ctx.db.patch(id, { field: undefined })` clears a field. Postgres
//     needs the column named, so a clear is an explicit `= NULL`. The lease
//     triple in particular is always cleared together, which migration 007
//     enforces with a CHECK so a half-cleared lease is not representable.
//   * Convex reads a row back after a patch to return it. Here the `UPDATE` uses
//     `RETURNING *`, so there is one statement instead of two and no window in
//     which the row could be read by this transaction in a state it never had.
//
// The one behavioural note worth repeating from the original, because it is a
// bug that was fixed rather than a design: a settled (exhausted, non-retryable)
// processing failure settles as `unchanged`, never `needs_review`. A scan entry
// `needs_review` means *identity* review, which puts the source into
// `identity_recovery` mode on the next pass; reporting a processing failure that
// way put the source in a permanent loop (P2-80f). `requeueFailedDiscoveryWork`
// is how an exhausted row is re-attempted.

import type { FsDiscoveryEntry } from "@repo/worker-protocol/request";

import { newKithId } from "../ids.js";
import {
  createOrGetSourceItem,
  refreshAvailableSourceItem,
} from "../provenance/model.js";
import { camelizeSourceItem, type SourceItemRow } from "../provenance/rows.js";
import { digestProcessingConfiguration } from "../ingestion/inline.js";
import type { LoadedWorkerSource } from "./auth.js";
import {
  at,
  digest,
  exec,
  nowPlus,
  num,
  numOr0,
  row,
  rows,
  type WorkerCtx,
} from "./db.js";
import {
  entryDigests,
  isReadyEntry,
  processingProfile,
  type EntryDigests,
  type FsReadyDiscoveryEntry,
} from "./digests.js";
import { workerProtocolError } from "./errors.js";
import {
  camelizeAliasDigest,
  camelizeDiscoveryWork,
  camelizeIngestJob,
  camelizeScanEntry,
  type IngestJobRow,
  type SourceAliasDigestRow,
  type WorkerDiscoveryWorkRow,
  type WorkerScanEntryRow,
  type WorkerSourceScanRow,
} from "./rows.js";

/** How long a scan entry and its discovery work row are retained. */
export const WORKER_DETAIL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** How many URI aliases one source item may accumulate before review. */
export const MAX_SOURCE_URI_ALIASES = 8;

/** The extraction fingerprint of an artifact-bound (parsed binary) generation. */
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

async function loadItem(
  ctx: WorkerCtx,
  sourceItemId: string,
): Promise<SourceItemRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_items WHERE id = $1",
    [sourceItemId],
  );
  return found ? camelizeSourceItem(found) : null;
}

async function loadWork(
  ctx: WorkerCtx,
  id: string,
): Promise<WorkerDiscoveryWorkRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_discovery_work WHERE id = $1",
    [id],
  );
  return found ? camelizeDiscoveryWork(found) : null;
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

// ---------------------------------------------------------------------------
// Aliases: the URI a file was last seen at, per source item.
// ---------------------------------------------------------------------------

export type AliasMatch = {
  alias: SourceAliasDigestRow;
  item: SourceItemRow;
};

/**
 * Every source item whose alias set contains this path digest.
 *
 * The cap is read as `MAX + 1` so exceeding it is observable rather than
 * truncated, and a match whose item is missing or in another space is
 * `scan_conflict`: the alias table is the identity index, and an alias pointing
 * outside the space it was written in means identity resolution cannot be
 * trusted for this source at all.
 */
export async function aliasMatches(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  pathDigest: string,
): Promise<AliasMatch[]> {
  const aliases = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.source_alias_digests
        WHERE source_account_id = $1 AND digest = $2
        ORDER BY created_at, id LIMIT $3`,
      [source.account.id, pathDigest, MAX_SOURCE_URI_ALIASES + 1],
    )
  ).map(camelizeAliasDigest);
  const matches: AliasMatch[] = [];
  for (const alias of aliases) {
    const item = await loadItem(ctx, alias.sourceItemId);
    if (
      !item ||
      item.spaceId !== source.spaceId ||
      item.sourceAccountId !== source.account.id ||
      alias.spaceId !== source.spaceId
    ) {
      workerProtocolError("scan_conflict");
    }
    matches.push({ alias, item });
  }
  return matches;
}

async function itemAliases(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  sourceItemId: string,
): Promise<SourceAliasDigestRow[]> {
  const aliases = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.source_alias_digests
        WHERE source_item_id = $1 ORDER BY created_at, id LIMIT $2`,
      [sourceItemId, MAX_SOURCE_URI_ALIASES + 1],
    )
  ).map(camelizeAliasDigest);
  for (const alias of aliases) {
    if (
      alias.spaceId !== source.spaceId ||
      alias.sourceAccountId !== source.account.id ||
      alias.sourceItemId !== sourceItemId
    ) {
      workerProtocolError("scan_conflict");
    }
  }
  return aliases;
}

/**
 * Records this path as an alias of the item, or reports the cap.
 *
 * `cap_reached` is not an error: a file that has moved nine times is a real
 * thing, and the answer is one `uri_alias_limit` review entry rather than a
 * refused page. The cap exists so one renamed-in-a-loop file cannot grow an
 * unbounded identity index.
 */
export async function addOrRefreshAlias(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  item: SourceItemRow,
  pathDigest: string,
  matches: readonly AliasMatch[],
): Promise<"ok" | "cap_reached"> {
  const same = matches.find((match) => match.item.id === item.id);
  if (same) {
    await exec(
      ctx,
      "UPDATE kith.source_alias_digests SET last_seen_at = $1 WHERE id = $2",
      [at(ctx.now), same.alias.id],
    );
    return "ok";
  }
  const existing = await itemAliases(ctx, source, item.id);
  if (existing.length >= MAX_SOURCE_URI_ALIASES) return "cap_reached";
  await exec(
    ctx,
    `INSERT INTO kith.source_alias_digests
       (id, space_id, created_at, source_account_id, source_item_id, kind, digest,
        first_seen_at, last_seen_at)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, 'uri', $5, $6, $6)`,
    [
      newKithId(),
      source.spaceId,
      source.account.id,
      item.id,
      pathDigest,
      at(ctx.now),
    ],
  );
  return "ok";
}

/**
 * The live item this external id resolves to, or undefined.
 *
 * Two matches is `identity_review_required` rather than `scan_conflict`: two
 * items sharing an external id hash is an identity question the owner has to
 * answer, and `identity_recovery` mode exists for exactly that. A live item whose
 * stored external id differs from the one that hashed to it is the same question,
 * because it means either a hash collision or a damaged identity column.
 */
export async function itemByExternalIdentity(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  externalId: string,
  extHash: string,
): Promise<SourceItemRow | undefined> {
  const matches = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.source_items
        WHERE source_account_id = $1 AND external_id_hash = $2
        ORDER BY created_at, id LIMIT 2`,
      [source.account.id, extHash],
    )
  ).map(camelizeSourceItem);
  if (matches.length > 1) workerProtocolError("identity_review_required");
  const item = matches[0];
  if (!item) return undefined;
  if (item.spaceId !== source.spaceId) workerProtocolError("not_found");
  if (
    item.lifecycle !== "forgotten" &&
    item.lifecycle !== "forgetting" &&
    item.externalId !== externalId
  ) {
    workerProtocolError("identity_review_required");
  }
  return item;
}

// ---------------------------------------------------------------------------
// Scan entries.
// ---------------------------------------------------------------------------

type EntryInsert = {
  source: LoadedWorkerSource;
  scan: WorkerSourceScanRow;
  pageId: string;
  entry: FsDiscoveryEntry;
  digests: EntryDigests;
  state: WorkerScanEntryRow["state"];
  sourceItemId?: string;
  issueCode?: string;
  observationEpoch?: number;
  processingEpoch?: number;
  /** Only a review entry records what the worker proposed. */
  recordProposal: boolean;
};

/**
 * One `worker_scan_entries` insert, covering both the review path and the
 * resolved path.
 *
 * Convex spells these as two functions with two large object literals; here they
 * are one statement with one parameter list, because the column set is identical
 * and the difference is which values are null. That is the same code, not a
 * simplification: the two literals in the original differ only in the proposal
 * fields and the epochs, and both of those are parameters here.
 */
async function insertEntry(
  ctx: WorkerCtx,
  args: EntryInsert,
): Promise<WorkerScanEntryRow> {
  const ready = isReadyEntry(args.entry);
  const profile = ready
    ? processingProfile(args.entry as FsReadyDiscoveryEntry)
    : undefined;
  const binary = ready && args.entry.content.status === "ready_binary_v1";
  const content = args.entry.content;
  const inserted = await row<Record<string, unknown>>(
    ctx,
    `INSERT INTO kith.worker_scan_entries
       (id, space_id, created_at, source_account_id, scan_id, scan_page_id,
        source_item_id, identity_key_hash, external_id_hash, uri_digest,
        inventory_metadata_digest, processing_identity_digest, content_hash,
        byte_length, content_representation, binary_parser_profile_id,
        binary_media_type, parser_fingerprint,
        extraction_configuration_fingerprint, extractor_fingerprint,
        record_schema_fingerprint, normalization_fingerprint,
        chunker_fingerprint, correction_revision, source_modified_at,
        observation_epoch, processing_epoch, state, issue_code,
        proposed_external_id, proposed_uri, proposed_title, proposed_doc_type,
        observed_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
             $30,$31,$32,$33,$34)
     RETURNING *`,
    [
      newKithId(),
      args.source.spaceId,
      args.source.account.id,
      args.scan.id,
      args.pageId,
      args.sourceItemId ?? null,
      args.digests.identityKeyHash,
      args.digests.externalIdHash ?? null,
      args.digests.uriDigest,
      args.digests.inventoryMetadataDigest,
      args.digests.processingIdentityDigest ?? null,
      ready ? content.sha256 : null,
      ready ? content.byteLength : null,
      profile?.representation ?? null,
      binary ? content.parserProfileId : null,
      binary ? content.mediaType : null,
      binary ? content.parserFingerprint : null,
      binary ? content.extractionConfigurationFingerprint : null,
      binary ? content.extractorFingerprint : null,
      binary ? content.recordSchemaFingerprint : null,
      binary ? content.normalizationFingerprint : null,
      binary ? content.chunkerFingerprint : null,
      binary ? content.correctionRevision : null,
      at(args.entry.sourceModifiedAt),
      args.observationEpoch ?? null,
      args.processingEpoch ?? null,
      args.state,
      args.issueCode ?? null,
      args.recordProposal ? (args.entry.externalId ?? null) : null,
      args.recordProposal ? args.entry.uri : null,
      args.recordProposal ? (args.entry.title ?? null) : null,
      args.recordProposal ? (args.entry.docType ?? null) : null,
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_DETAIL_RETENTION_MS)),
    ],
  );
  if (!inserted) workerProtocolError("scan_conflict");
  return camelizeScanEntry(inserted);
}

/**
 * A `needs_review` or `ignored_forgotten` entry with its issue code.
 *
 * `needs_review` records what the worker proposed (external id, URI, title, doc
 * type) so the owner has something to decide about; `ignored_forgotten` does not,
 * because a forgotten item's metadata is exactly what must not be re-recorded.
 */
async function insertReviewEntry(
  ctx: WorkerCtx,
  args: {
    source: LoadedWorkerSource;
    scan: WorkerSourceScanRow;
    pageId: string;
    entry: FsDiscoveryEntry;
    digests: EntryDigests;
    issueCode: string;
    sourceItemId?: string;
    state?: "needs_review" | "ignored_forgotten";
  },
): Promise<WorkerScanEntryRow> {
  const state = args.state ?? "needs_review";
  return insertEntry(ctx, {
    ...args,
    state,
    recordProposal: state === "needs_review",
  });
}

// ---------------------------------------------------------------------------
// Discovery work: the queue row a queued entry produces.
// ---------------------------------------------------------------------------

/**
 * The live work row for this item at its current observation epoch, with the
 * whole chain back to the scan re-verified.
 *
 * Twenty-odd equality checks, kept one for one. They are not paranoia about the
 * database: the chain `work -> entry -> page -> scan` carries the epochs and the
 * content hash that decide whether this work is still current, and a single
 * mismatched field means some earlier operation wrote a state that cannot have
 * arisen from this protocol. Continuing on such a chain is how a document gets
 * published from bytes nobody observed.
 */
export async function currentDiscoveryWork(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  item: SourceItemRow,
): Promise<WorkerDiscoveryWorkRow | undefined> {
  const observationEpoch = item.workerObservationEpoch ?? 0;
  const matches = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_discovery_work
        WHERE source_item_id = $1 AND observation_epoch = $2 AND state <> 'obsolete'
        ORDER BY created_at, id LIMIT 2`,
      [item.id, observationEpoch],
    )
  ).map(camelizeDiscoveryWork);
  if (matches.length > 1) workerProtocolError("scan_conflict");
  const work = matches[0];
  if (!work) return undefined;
  if (
    work.spaceId !== source.spaceId ||
    work.sourceAccountId !== source.account.id ||
    work.sourceItemId !== item.id ||
    work.observationEpoch !== observationEpoch
  ) {
    workerProtocolError("scan_conflict");
  }
  const chain = await row<{
    entry: Record<string, unknown>;
    page: Record<string, unknown>;
    scan: Record<string, unknown>;
  }>(
    ctx,
    `SELECT to_jsonb(e) AS entry, to_jsonb(p) AS page, to_jsonb(s) AS scan
       FROM kith.worker_scan_entries e
       JOIN kith.worker_scan_pages p ON p.id = e.scan_page_id
       JOIN kith.worker_source_scans s ON s.id = $2
      WHERE e.id = $1`,
    [work.scanEntryId, work.scanId],
  );
  if (!chain) workerProtocolError("scan_conflict");
  const entry = camelizeScanEntry(chain.entry);
  const page = camelizeScanPageJson(chain.page);
  const scan = chain.scan;
  if (
    entry.spaceId !== work.spaceId ||
    entry.sourceAccountId !== work.sourceAccountId ||
    entry.sourceItemId !== work.sourceItemId ||
    entry.scanId !== work.scanId ||
    entry.id !== work.scanEntryId ||
    entry.discoveryWorkId !== work.id ||
    entry.observationEpoch !== work.observationEpoch ||
    entry.processingEpoch !== work.processingEpoch ||
    entry.contentHash !== work.contentHash ||
    entry.byteLength !== work.byteLength ||
    page.spaceId !== work.spaceId ||
    page.sourceAccountId !== work.sourceAccountId ||
    page.scanId !== work.scanId ||
    page.id !== entry.scanPageId ||
    scan.space_id !== work.spaceId ||
    scan.source_account_id !== work.sourceAccountId ||
    scan.id !== work.scanId
  ) {
    workerProtocolError("scan_conflict");
  }
  return work;
}

/** `to_jsonb` loses `Date`, so a page read that way is normalized by hand. */
function camelizeScanPageJson(raw: Record<string, unknown>): {
  id: string;
  spaceId: string;
  sourceAccountId: string;
  scanId: string;
} {
  return {
    id: raw.id as string,
    spaceId: raw.space_id as string,
    sourceAccountId: raw.source_account_id as string,
    scanId: raw.scan_id as string,
  };
}

/**
 * Retires a superseded work row, and decides what happens to the job it admitted.
 *
 * Three outcomes, and which one applies turns entirely on whether the *processing*
 * identity changed, not merely the inventory metadata:
 *
 *   * The job is already `ready`. Nothing happens to it: published work is not
 *     un-published because the file was touched.
 *   * The processing identity is unchanged. The job goes back to `queued` (with
 *     its generation), because the same bytes still need the same processing and
 *     only the lease is stale.
 *   * The processing identity changed. The job and its generation become
 *     `obsolete_generation`, because the work it would have done is for bytes
 *     that are no longer what the file holds.
 */
export async function obsoletePriorWork(
  ctx: WorkerCtx,
  work: WorkerDiscoveryWorkRow,
  processingIdentityChanged: boolean,
): Promise<IngestJobRow | undefined> {
  let job: IngestJobRow | undefined;
  let generationId: string | undefined;
  if (work.ingestJobId) {
    const loaded = await loadJob(ctx, work.ingestJobId);
    if (
      !loaded ||
      loaded.spaceId !== work.spaceId ||
      loaded.sourceAccountId !== work.sourceAccountId ||
      loaded.sourceItemId !== work.sourceItemId ||
      work.sourceRevisionId === null ||
      loaded.sourceRevisionId !== work.sourceRevisionId ||
      work.processingGenerationId === null ||
      loaded.processingGenerationId !== work.processingGenerationId ||
      loaded.workerDiscoveryWorkId !== work.id ||
      loaded.workerObservationEpoch !== work.observationEpoch
    ) {
      workerProtocolError("scan_conflict");
    }
    job = loaded;
    const parents = await row<{
      revision_space_id: string;
      revision_source_item_id: string;
      generation_space_id: string;
      generation_source_account_id: string;
      generation_source_item_id: string;
      generation_source_revision_id: string;
      generation_state: string;
      generation_id: string;
    }>(
      ctx,
      `SELECT r.space_id AS revision_space_id,
              r.source_item_id AS revision_source_item_id,
              g.space_id AS generation_space_id,
              g.source_account_id AS generation_source_account_id,
              g.source_item_id AS generation_source_item_id,
              g.source_revision_id AS generation_source_revision_id,
              g.state AS generation_state,
              g.id AS generation_id
         FROM kith.source_revisions r
         JOIN kith.processing_generations g ON g.id = $2
        WHERE r.id = $1`,
      [loaded.sourceRevisionId, loaded.processingGenerationId],
    );
    if (
      !parents ||
      parents.revision_space_id !== work.spaceId ||
      parents.revision_source_item_id !== work.sourceItemId ||
      parents.generation_space_id !== work.spaceId ||
      parents.generation_source_account_id !== work.sourceAccountId ||
      parents.generation_source_item_id !== work.sourceItemId ||
      parents.generation_source_revision_id !== loaded.sourceRevisionId ||
      parents.generation_state !== loaded.state
    ) {
      workerProtocolError("scan_conflict");
    }
    generationId = parents.generation_id;
  }
  await exec(
    ctx,
    `UPDATE kith.worker_discovery_work
        SET state = 'obsolete', lease_token = NULL, lease_owner_credential_id = NULL,
            lease_expires_at = NULL, next_attempt_at = NULL
      WHERE id = $1`,
    [work.id],
  );
  if (job && !processingIdentityChanged && job.state !== "ready") {
    const nextState = job.state === "processing" ? "queued" : job.state;
    await exec(
      ctx,
      `UPDATE kith.ingest_jobs
          SET state = $1, lease_token = NULL, lease_expires_at = NULL,
              worker_lease_owner_credential_id = NULL,
              next_attempt_at = CASE WHEN $1 = 'queued' THEN $2 ELSE next_attempt_at END
        WHERE id = $3`,
      [nextState, at(ctx.now), job.id],
    );
    if (job.state === "processing") {
      if (!generationId) workerProtocolError("scan_conflict");
      await exec(
        ctx,
        "UPDATE kith.processing_generations SET state = 'queued' WHERE id = $1",
        [generationId],
      );
    }
  } else if (job && processingIdentityChanged && job.state !== "ready") {
    if (!generationId) workerProtocolError("scan_conflict");
    await exec(
      ctx,
      `UPDATE kith.ingest_jobs
          SET state = 'obsolete_generation', lease_token = NULL,
              lease_expires_at = NULL, worker_lease_owner_credential_id = NULL,
              next_attempt_at = NULL
        WHERE id = $1`,
      [job.id],
    );
    await exec(
      ctx,
      `UPDATE kith.processing_generations SET state = 'obsolete_generation' WHERE id = $1`,
      [generationId],
    );
  }
  return job;
}

/**
 * Creates the work row a queued entry needs, or returns undefined when the prior
 * work already published what this observation asks for.
 *
 * `rebindJob` is the case that makes this function long: an unchanged processing
 * identity whose job is still unpublished keeps its job, its revision, its
 * generation and its original actor, and the *new* work row takes them over. A
 * fresh chain would re-admit the same bytes under a second generation and leave
 * the first one queued forever.
 */
export async function createDiscoveryWork(
  ctx: WorkerCtx,
  args: {
    source: LoadedWorkerSource;
    item: SourceItemRow;
    scanId: string;
    scanEntryId: string;
    entry: FsReadyDiscoveryEntry;
    observationEpoch: number;
    processingEpoch: number;
    processingIdentityChanged: boolean;
    priorWork?: WorkerDiscoveryWorkRow;
  },
): Promise<WorkerDiscoveryWorkRow | undefined> {
  const profile = processingProfile(args.entry);
  let priorJob: IngestJobRow | undefined;
  if (args.priorWork) {
    priorJob = await obsoletePriorWork(
      ctx,
      args.priorWork,
      args.processingIdentityChanged,
    );
    if (!args.processingIdentityChanged && priorJob?.state === "ready") {
      return undefined;
    }
  }

  const rebindJob =
    !args.processingIdentityChanged &&
    priorJob !== undefined &&
    priorJob.state !== "ready" &&
    priorJob.state !== "obsolete_generation";
  const expectedDesired = rebindJob
    ? (args.priorWork?.expectedDesiredProcessingEpoch ?? null)
    : args.item.desiredProcessingEpoch;
  const inserted = await row<Record<string, unknown>>(
    ctx,
    `INSERT INTO kith.worker_discovery_work
       (id, space_id, created_at, source_account_id, source_item_id, scan_id,
        scan_entry_id, observation_epoch, processing_epoch,
        expected_desired_processing_epoch, state, content_hash, byte_length,
        captured_at, source_modified_at, media_type, profile_id,
        content_representation, parser_fingerprint,
        extraction_configuration_fingerprint, correction_revision,
        extraction_fingerprint, extractor_fingerprint, record_schema_fingerprint,
        normalization_fingerprint, chunker_fingerprint, title, doc_type, uri,
        actor_user_id, actor_credential_id, attempts, lease_epoch,
        next_attempt_at, ingest_request_id, ingest_job_id, source_revision_id,
        processing_generation_id, created_at_field, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
             $30,0,0,$31,$32,$33,$34,$35,$31,$36)
     RETURNING *`,
    [
      newKithId(),
      args.source.spaceId,
      args.source.account.id,
      args.item.id,
      args.scanId,
      args.scanEntryId,
      args.observationEpoch,
      args.processingEpoch,
      expectedDesired,
      rebindJob ? "admitted" : "queued",
      args.entry.content.sha256,
      args.entry.content.byteLength,
      at(args.entry.content.status === "ready" ? ctx.now : ctx.now),
      at(args.entry.sourceModifiedAt),
      profile.mediaType,
      profile.profileId,
      profile.representation,
      profile.parserFingerprint ?? null,
      profile.extractionConfigurationFingerprint ?? null,
      profile.correctionRevision ?? null,
      profile.extractionFingerprint,
      profile.extractorFingerprint,
      profile.recordSchemaFingerprint,
      profile.normalizationFingerprint,
      profile.chunkerFingerprint,
      args.entry.title ?? null,
      args.entry.docType ?? null,
      args.entry.uri,
      rebindJob ? args.priorWork!.actorUserId : args.source.principal.userId,
      rebindJob
        ? args.priorWork!.actorCredentialId
        : args.source.principal.credentialId,
      at(ctx.now),
      rebindJob ? (args.priorWork?.ingestRequestId ?? null) : null,
      rebindJob && priorJob ? priorJob.id : null,
      rebindJob ? (args.priorWork?.sourceRevisionId ?? null) : null,
      rebindJob ? (args.priorWork?.processingGenerationId ?? null) : null,
      at(nowPlus(ctx.now, WORKER_DETAIL_RETENTION_MS)),
    ],
  );
  if (!inserted) workerProtocolError("scan_conflict");
  const work = camelizeDiscoveryWork(inserted);
  if (rebindJob && priorJob) {
    const nextState = priorJob.state === "processing" ? "queued" : priorJob.state;
    await exec(
      ctx,
      `UPDATE kith.ingest_jobs
          SET worker_managed = true, worker_discovery_work_id = $1,
              worker_observation_epoch = $2, state = $3, lease_token = NULL,
              lease_expires_at = NULL, worker_lease_owner_credential_id = NULL,
              next_attempt_at = CASE WHEN $3 = 'queued' THEN $4 ELSE next_attempt_at END
        WHERE id = $5`,
      [work.id, args.observationEpoch, nextState, at(ctx.now), priorJob.id],
    );
    if (priorJob.state === "processing") {
      await exec(
        ctx,
        "UPDATE kith.processing_generations SET state = 'queued' WHERE id = $1",
        [priorJob.processingGenerationId],
      );
    }
  }
  return work;
}

// ---------------------------------------------------------------------------
// The resolved path: an entry whose identity is settled.
// ---------------------------------------------------------------------------

type PersistArgs = {
  source: LoadedWorkerSource;
  scan: WorkerSourceScanRow;
  pageId: string;
  item: SourceItemRow;
  entry: FsDiscoveryEntry;
  digests: EntryDigests;
};

export type PersistedEntry = {
  row: WorkerScanEntryRow;
  manifestChanged: boolean;
};

async function loadActiveChain(
  ctx: WorkerCtx,
  item: SourceItemRow,
): Promise<{
  generation: Record<string, unknown> | null;
  revision: Record<string, unknown> | null;
  artifact: Record<string, unknown> | null;
}> {
  if (!item.activeGenerationId) {
    return { generation: null, revision: null, artifact: null };
  }
  const found = await row<{
    generation: Record<string, unknown>;
    revision: Record<string, unknown> | null;
    artifact: Record<string, unknown> | null;
  }>(
    ctx,
    `SELECT to_jsonb(g) AS generation, to_jsonb(r) AS revision, to_jsonb(a) AS artifact
       FROM kith.processing_generations g
       LEFT JOIN kith.source_revisions r ON r.id = g.source_revision_id
       LEFT JOIN kith.source_parser_artifacts a ON a.id = g.parser_artifact_id
      WHERE g.id = $1`,
    [item.activeGenerationId],
  );
  return {
    generation: found?.generation ?? null,
    revision: found?.revision ?? null,
    artifact: found?.artifact ?? null,
  };
}

/**
 * Writes the observation onto the item, inserts the entry, and creates or rebinds
 * the discovery work.
 *
 * The four decisions this function makes, in the order it makes them, because
 * each one feeds the next:
 *
 *   1. `inventoryChanged`: the inventory metadata digest differs, so the
 *      observation epoch advances and the manifest version bumps.
 *   2. `processingIdentityChanged`: the processing identity digest differs, *or*
 *      an earlier desired-processing run was interrupted and is being resumed, so
 *      the processing epoch advances.
 *   3. `alreadyReady`: the active generation already published exactly these
 *      bytes under exactly this processing identity, so the entry is `unchanged`
 *      and no work is created.
 *   4. `settledFailure`: the prior work failed and is not retryable, so the entry
 *      is `unchanged` too, and the failed work row is rebound to this scan rather
 *      than abandoned (P2-80f).
 */
async function persistResolvedEntry(
  ctx: WorkerCtx,
  args: PersistArgs,
): Promise<PersistedEntry> {
  const currentWorkBeforeObservation = await currentDiscoveryWork(
    ctx,
    args.source,
    args.item,
  );
  const active = await loadActiveChain(ctx, args.item);
  const activeGeneration = active.generation;
  const activeRevision = active.revision;
  const activeParserArtifact = active.artifact;
  if (
    activeGeneration &&
    (activeGeneration.space_id !== args.source.spaceId ||
      activeGeneration.source_account_id !== args.source.account.id ||
      activeGeneration.source_item_id !== args.item.id ||
      args.item.activeRevisionId !== activeGeneration.source_revision_id ||
      !activeRevision ||
      activeRevision.space_id !== args.source.spaceId ||
      activeRevision.source_item_id !== args.item.id ||
      activeRevision.id !== activeGeneration.source_revision_id)
  ) {
    workerProtocolError("scan_conflict");
  }
  const ready = isReadyEntry(args.entry);
  const inventoryChanged =
    args.item.workerInventoryMetadataDigest !==
    args.digests.inventoryMetadataDigest;
  const resumesInterruptedDesiredProcessing =
    ready &&
    args.item.desiredRevisionId !== null &&
    currentWorkBeforeObservation === undefined &&
    (activeGeneration === null ||
      activeGeneration.state !== "ready" ||
      activeGeneration.source_revision_id !== args.item.desiredRevisionId ||
      numOr0(activeGeneration.desired_processing_epoch) !==
        args.item.desiredProcessingEpoch);
  const processingIdentityChanged =
    ready &&
    (args.item.workerProcessingIdentityDigest !==
      (args.digests.processingIdentityDigest ?? null) ||
      resumesInterruptedDesiredProcessing);
  const observationEpoch = inventoryChanged
    ? (args.item.workerObservationEpoch ?? 0) + 1
    : (args.item.workerObservationEpoch ?? 0);
  const processingEpoch = processingIdentityChanged
    ? (args.item.workerProcessingEpoch ?? 0) + 1
    : (args.item.workerProcessingEpoch ?? 0);
  if (
    !Number.isSafeInteger(observationEpoch) ||
    !Number.isSafeInteger(processingEpoch)
  ) {
    workerProtocolError("scan_conflict");
  }

  const wasUnavailable = args.item.lifecycle === "unavailable";
  await refreshAvailableSourceItem(ctx.client, {
    spaceId: args.source.spaceId,
    sourceItemId: args.item.id,
    ...(args.entry.title === undefined ? {} : { title: args.entry.title }),
    ...(args.entry.docType === undefined ? {} : { docType: args.entry.docType }),
    uri: args.entry.uri,
  });
  const profile = ready
    ? processingProfile(args.entry as FsReadyDiscoveryEntry)
    : undefined;
  await exec(
    ctx,
    `UPDATE kith.source_items
        SET worker_observation_epoch = $1,
            worker_processing_epoch = $2,
            worker_inventory_metadata_digest = $3,
            worker_processing_identity_digest =
              COALESCE($4, worker_processing_identity_digest),
            worker_content_hash = COALESCE($5, worker_content_hash),
            worker_profile_id = COALESCE($6, worker_profile_id),
            worker_source_modified_at = $7,
            worker_last_seen_inventory_epoch = $8
      WHERE id = $9`,
    [
      observationEpoch,
      processingEpoch,
      args.digests.inventoryMetadataDigest,
      ready ? (args.digests.processingIdentityDigest ?? null) : null,
      ready ? args.entry.content.sha256 : null,
      ready ? profile!.profileId : null,
      at(args.entry.sourceModifiedAt),
      args.scan.inventoryEpoch,
      args.item.id,
    ],
  );

  let priorWork = currentWorkBeforeObservation;
  if (!priorWork && resumesInterruptedDesiredProcessing) {
    priorWork = await recoverInterruptedDesiredWork(ctx, args);
  }

  const activeExtractionMatches = await activeExtractionAgrees(
    profile,
    activeGeneration,
    activeRevision,
    activeParserArtifact,
    args,
  );
  const alreadyReady =
    ready &&
    activeGeneration !== null &&
    activeRevision !== null &&
    activeGeneration.state === "ready" &&
    activeGeneration.source_revision_id === args.item.desiredRevisionId &&
    numOr0(activeGeneration.desired_processing_epoch) ===
      args.item.desiredProcessingEpoch &&
    activeRevision.content_hash === args.entry.content.sha256 &&
    numOr0(activeRevision.byte_length) === args.entry.content.byteLength &&
    activeRevision.media_type === profile?.mediaType &&
    activeExtractionMatches &&
    activeGeneration.extractor_fingerprint === profile?.extractorFingerprint &&
    activeGeneration.record_schema_fingerprint ===
      profile?.recordSchemaFingerprint &&
    activeGeneration.normalization_fingerprint ===
      profile?.normalizationFingerprint &&
    activeGeneration.chunker_fingerprint === profile?.chunkerFingerprint;

  // P2-80f: a settled processing failure is `unchanged`, never `needs_review`.
  // A scan entry `needs_review` means identity review, which drives the next
  // pass into `identity_recovery` mode; reporting a deterministic processing
  // failure that way looped the source forever.
  const settledFailure =
    !alreadyReady &&
    !inventoryChanged &&
    priorWork !== undefined &&
    priorWork.state === "failed" &&
    priorWork.retryable !== true;
  const entryState: WorkerScanEntryRow["state"] =
    args.entry.content.status === "gap"
      ? "gap"
      : alreadyReady || settledFailure
        ? "unchanged"
        : !inventoryChanged && priorWork && priorWork.state === "needs_review"
          ? "needs_review"
          : "queued";

  const entryRow = await insertEntry(ctx, {
    source: args.source,
    scan: args.scan,
    pageId: args.pageId,
    entry: args.entry,
    digests: args.digests,
    state: entryState,
    sourceItemId: args.item.id,
    ...(args.entry.content.status === "gap"
      ? { issueCode: args.entry.content.code }
      : {}),
    observationEpoch,
    processingEpoch,
    recordProposal: false,
  });

  let work: WorkerDiscoveryWorkRow | undefined;
  if (
    ready &&
    entryState === "queued" &&
    (processingIdentityChanged ||
      inventoryChanged ||
      !priorWork ||
      priorWork.state === "obsolete")
  ) {
    work = await createDiscoveryWork(ctx, {
      source: args.source,
      item: args.item,
      scanId: args.scan.id,
      scanEntryId: entryRow.id,
      entry: args.entry as FsReadyDiscoveryEntry,
      observationEpoch,
      processingEpoch,
      processingIdentityChanged,
      ...(priorWork === undefined ? {} : { priorWork }),
    });
    if (!work) {
      await exec(
        ctx,
        "UPDATE kith.worker_scan_entries SET state = 'unchanged' WHERE id = $1",
        [entryRow.id],
      );
      entryRow.state = "unchanged";
    }
  } else if (priorWork && (entryState === "queued" || settledFailure)) {
    // A settled failure keeps its `failed` work row and rebinds it to this scan,
    // so the entry still points at the failure and the row's retention window is
    // refreshed rather than leaving a stale chain behind.
    if (priorWork.scanId !== args.scan.id || priorWork.scanEntryId !== entryRow.id) {
      const rebound = await row<Record<string, unknown>>(
        ctx,
        `UPDATE kith.worker_discovery_work
            SET scan_id = $1, scan_entry_id = $2, retire_at = $3
          WHERE id = $4 RETURNING *`,
        [
          args.scan.id,
          entryRow.id,
          at(nowPlus(ctx.now, WORKER_DETAIL_RETENTION_MS)),
          priorWork.id,
        ],
      );
      if (!rebound) workerProtocolError("scan_conflict");
      work = camelizeDiscoveryWork(rebound);
    } else {
      work = priorWork;
    }
  }
  if (priorWork && entryState === "unchanged" && !settledFailure) {
    await obsoletePriorWork(ctx, priorWork, false);
  } else if (inventoryChanged && priorWork && entryState !== "queued") {
    await obsoletePriorWork(ctx, priorWork, processingIdentityChanged);
  }
  if (work) {
    const updated = await row<Record<string, unknown>>(
      ctx,
      `UPDATE kith.worker_scan_entries SET discovery_work_id = $1 WHERE id = $2
       RETURNING *`,
      [work.id, entryRow.id],
    );
    if (!updated) workerProtocolError("scan_conflict");
    return {
      row: camelizeScanEntry(updated),
      manifestChanged: inventoryChanged || wasUnavailable,
    };
  }
  return {
    row: entryRow,
    manifestChanged: inventoryChanged || wasUnavailable,
  };
}

/**
 * Whether the active generation's extraction fingerprint agrees with what this
 * entry declares.
 *
 * Binary and inline differ, and the binary case needs the parser artifact:
 * an artifact-bound extraction fingerprint is a digest of the parser, the
 * artifact's output hash and the extraction configuration, so a reparse of the
 * same bytes by a different parser build is correctly *not* already ready.
 */
async function activeExtractionAgrees(
  profile: ReturnType<typeof processingProfile> | undefined,
  activeGeneration: Record<string, unknown> | null,
  activeRevision: Record<string, unknown> | null,
  activeParserArtifact: Record<string, unknown> | null,
  args: PersistArgs,
): Promise<boolean> {
  if (profile?.representation !== "archived_binary_v1") {
    return activeGeneration?.extraction_fingerprint === profile?.extractionFingerprint;
  }
  if (
    activeGeneration === null ||
    activeRevision === null ||
    activeParserArtifact === null ||
    activeParserArtifact.space_id !== args.source.spaceId ||
    activeParserArtifact.source_account_id !== args.source.account.id ||
    activeParserArtifact.source_item_id !== args.item.id ||
    activeParserArtifact.source_revision_id !== activeRevision.id ||
    activeParserArtifact.id !== activeGeneration.parser_artifact_id ||
    activeParserArtifact.parser_fingerprint !== profile.parserFingerprint
  ) {
    return false;
  }
  const expected = await artifactBoundExtractionFingerprint(
    profile.parserFingerprint!,
    activeParserArtifact.output_hash as string,
    profile.extractionConfigurationFingerprint!,
  );
  return (
    activeGeneration.extraction_fingerprint === expected &&
    activeGeneration.correction_revision === profile.correctionRevision
  );
}

/**
 * Finds the obsoleted work row an interrupted desired-processing run left behind,
 * so this observation resumes it instead of starting a second chain.
 *
 * Every check the original makes is kept. The reason there are so many is that
 * this is the one path where a *new* observation adopts a *previous* run's
 * revision, generation and job: if any one of the eight identities in that chain
 * does not line up, adopting it would attach this file's new bytes to another
 * run's provenance. `scan_conflict` is the only safe answer to a chain that does
 * not reconstruct exactly.
 */
async function recoverInterruptedDesiredWork(
  ctx: WorkerCtx,
  args: PersistArgs,
): Promise<WorkerDiscoveryWorkRow | undefined> {
  const desiredJobs = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.ingest_jobs
        WHERE source_item_id = $1 AND desired_processing_epoch = $2
        ORDER BY created_at, id LIMIT 2`,
      [args.item.id, args.item.desiredProcessingEpoch],
    )
  ).map(camelizeIngestJob);
  if (desiredJobs.length !== 1) workerProtocolError("scan_conflict");
  const desiredJob = desiredJobs[0]!;
  if (
    desiredJob.spaceId !== args.source.spaceId ||
    desiredJob.sourceAccountId !== args.source.account.id ||
    desiredJob.sourceItemId !== args.item.id ||
    desiredJob.sourceRevisionId !== args.item.desiredRevisionId ||
    desiredJob.workerManaged !== true ||
    desiredJob.workerDiscoveryWorkId === null
  ) {
    workerProtocolError("scan_conflict");
  }
  const candidate = await loadWork(ctx, desiredJob.workerDiscoveryWorkId!);
  const chain = await row<{
    generation: Record<string, unknown>;
    revision: Record<string, unknown> | null;
    artifact: Record<string, unknown> | null;
  }>(
    ctx,
    `SELECT to_jsonb(g) AS generation, to_jsonb(r) AS revision, to_jsonb(a) AS artifact
       FROM kith.processing_generations g
       LEFT JOIN kith.source_revisions r ON r.id = $2
       LEFT JOIN kith.source_parser_artifacts a ON a.id = g.parser_artifact_id
      WHERE g.id = $1`,
    [desiredJob.processingGenerationId, desiredJob.sourceRevisionId],
  );
  const candidateGeneration = chain?.generation ?? null;
  const candidateRevision = chain?.revision ?? null;
  const candidateArtifact = chain?.artifact ?? null;
  const candidateBinary = candidate?.contentRepresentation === "archived_binary_v1";
  const candidateExtractionFingerprint = candidateBinary
    ? candidate &&
      candidateGeneration &&
      candidateArtifact &&
      candidate.parserFingerprint &&
      candidate.extractionConfigurationFingerprint
      ? await artifactBoundExtractionFingerprint(
          candidate.parserFingerprint,
          candidateArtifact.output_hash as string,
          candidate.extractionConfigurationFingerprint,
        )
      : undefined
    : candidate?.extractionFingerprint;
  const candidateCorrectionRevision = candidateBinary
    ? (candidate?.correctionRevision ?? undefined)
    : candidate
      ? `filesystem-observation-v1:${candidate.processingEpoch}`
      : undefined;
  if (
    !candidate ||
    !candidateGeneration ||
    !candidateRevision ||
    candidate.spaceId !== args.source.spaceId ||
    candidate.sourceAccountId !== args.source.account.id ||
    candidate.sourceItemId !== args.item.id ||
    candidate.state !== "obsolete" ||
    candidate.ingestJobId !== desiredJob.id ||
    candidate.sourceRevisionId !== args.item.desiredRevisionId ||
    candidate.processingGenerationId !== candidateGeneration.id ||
    candidate.expectedDesiredProcessingEpoch === null ||
    candidate.expectedDesiredProcessingEpoch + 1 !==
      desiredJob.desiredProcessingEpoch ||
    !Number.isSafeInteger(candidate.processingEpoch) ||
    candidate.processingEpoch < 0 ||
    candidate.processingEpoch > (args.item.workerProcessingEpoch ?? 0) ||
    desiredJob.workerObservationEpoch !== candidate.observationEpoch ||
    desiredJob.actorUserId !== candidate.actorUserId ||
    desiredJob.actorCredentialId !== candidate.actorCredentialId ||
    desiredJob.admittedByUserId !== candidate.actorUserId ||
    desiredJob.admittedByCredentialId !== candidate.actorCredentialId ||
    candidateRevision.space_id !== candidate.spaceId ||
    candidateRevision.source_item_id !== candidate.sourceItemId ||
    candidateRevision.content_hash !== candidate.contentHash ||
    numOr0(candidateRevision.byte_length) !== candidate.byteLength ||
    candidateRevision.media_type !== candidate.mediaType ||
    (candidateBinary &&
      (!candidateArtifact ||
        candidateArtifact.space_id !== candidate.spaceId ||
        candidateArtifact.source_account_id !== candidate.sourceAccountId ||
        candidateArtifact.source_item_id !== candidate.sourceItemId ||
        candidateArtifact.source_revision_id !== candidateRevision.id ||
        candidateArtifact.id !== candidateGeneration.parser_artifact_id ||
        candidateArtifact.parser_fingerprint !== candidate.parserFingerprint)) ||
    candidateGeneration.space_id !== candidate.spaceId ||
    candidateGeneration.source_account_id !== candidate.sourceAccountId ||
    candidateGeneration.source_item_id !== candidate.sourceItemId ||
    candidateGeneration.source_revision_id !== candidateRevision.id ||
    numOr0(candidateGeneration.desired_processing_epoch) !==
      desiredJob.desiredProcessingEpoch ||
    candidateGeneration.state !== desiredJob.state ||
    candidateGeneration.extraction_fingerprint !==
      candidateExtractionFingerprint ||
    candidateGeneration.extractor_fingerprint !== candidate.extractorFingerprint ||
    candidateGeneration.record_schema_fingerprint !==
      candidate.recordSchemaFingerprint ||
    candidateGeneration.normalization_fingerprint !==
      candidate.normalizationFingerprint ||
    candidateGeneration.chunker_fingerprint !== candidate.chunkerFingerprint ||
    candidateGeneration.correction_revision !== candidateCorrectionRevision ||
    candidateGeneration.processing_fingerprint !==
      (await digestProcessingConfiguration({
        extractionFingerprint: candidateExtractionFingerprint!,
        extractorFingerprint: candidate.extractorFingerprint,
        recordSchemaFingerprint: candidate.recordSchemaFingerprint,
        normalizationFingerprint: candidate.normalizationFingerprint,
        chunkerFingerprint: candidate.chunkerFingerprint,
        correctionRevision: candidateCorrectionRevision!,
      }))
  ) {
    workerProtocolError("scan_conflict");
  }
  const candidateChain = await row<{
    entry: Record<string, unknown>;
    page: Record<string, unknown>;
    scan: Record<string, unknown>;
  }>(
    ctx,
    `SELECT to_jsonb(e) AS entry, to_jsonb(p) AS page, to_jsonb(s) AS scan
       FROM kith.worker_scan_entries e
       JOIN kith.worker_scan_pages p ON p.id = e.scan_page_id
       JOIN kith.worker_source_scans s ON s.id = $2
      WHERE e.id = $1`,
    [candidate.scanEntryId, candidate.scanId],
  );
  if (!candidateChain) workerProtocolError("scan_conflict");
  const candidateEntry = camelizeScanEntry(candidateChain.entry);
  const candidatePage = camelizeScanPageJson(candidateChain.page);
  const candidateScan = candidateChain.scan;
  if (
    candidateEntry.spaceId !== candidate.spaceId ||
    candidateEntry.sourceAccountId !== candidate.sourceAccountId ||
    candidateEntry.sourceItemId !== candidate.sourceItemId ||
    candidateEntry.scanId !== candidate.scanId ||
    candidateEntry.discoveryWorkId !== candidate.id ||
    candidateEntry.observationEpoch !== candidate.observationEpoch ||
    candidateEntry.processingEpoch !== candidate.processingEpoch ||
    candidateEntry.contentHash !== candidate.contentHash ||
    candidateEntry.byteLength !== candidate.byteLength ||
    candidatePage.spaceId !== candidate.spaceId ||
    candidatePage.sourceAccountId !== candidate.sourceAccountId ||
    candidatePage.scanId !== candidate.scanId ||
    candidatePage.id !== candidateEntry.scanPageId ||
    candidateScan.space_id !== candidate.spaceId ||
    candidateScan.source_account_id !== candidate.sourceAccountId ||
    candidateScan.id !== candidate.scanId
  ) {
    workerProtocolError("scan_conflict");
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// The entry point: identity resolution, then persistence.
// ---------------------------------------------------------------------------

/**
 * Resolves one discovery entry to a source item, or records why it could not be.
 *
 * Seven issue codes, each a distinct ambiguity, and every one of them produces a
 * review entry rather than a guess:
 *
 *   `duplicate_scan_identity`      two entries in one scan claim one identity
 *   `ambiguous_uri_alias`          one path is an alias of two live items
 *   `forgotten_identity`           the external id belongs to a forgotten item
 *   `uri_alias_identity_conflict`  path and external id disagree about the item
 *   `forgotten_uri_alias`          the path is an alias of a forgotten item only
 *   `unmatched_recovery_identity`  recovery mode found nothing to recover to
 *   `uri_alias_limit`              the item already holds eight aliases
 *
 * The `identity_recovery` branch is the one that reassigns identity: an entry with
 * no external id is only legal in recovery mode, where the single live alias match
 * supplies the id, and the digests are then recomputed because the identity key
 * changed underneath them. Recomputing means re-checking for a duplicate, which is
 * why that check appears twice.
 */
export async function resolveAndPersistEntry(
  ctx: WorkerCtx,
  args: {
    source: LoadedWorkerSource;
    scan: WorkerSourceScanRow;
    pageId: string;
    entry: FsDiscoveryEntry;
  },
): Promise<PersistedEntry> {
  let resolvedEntry = args.entry;
  let digests = await entryDigests(args.source.account.id, resolvedEntry);
  const review = async (
    issueCode: string,
    extra: { sourceItemId?: string; state?: "needs_review" | "ignored_forgotten" } = {},
  ): Promise<PersistedEntry> => ({
    row: await insertReviewEntry(ctx, {
      source: args.source,
      scan: args.scan,
      pageId: args.pageId,
      entry: resolvedEntry,
      digests,
      issueCode,
      ...extra,
    }),
    manifestChanged: false,
  });

  const duplicate = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.worker_scan_entries
      WHERE scan_id = $1 AND identity_key_hash = $2 LIMIT 1`,
    [args.scan.id, digests.identityKeyHash],
  );
  if (duplicate) return review("duplicate_scan_identity");

  const aliases = await aliasMatches(ctx, args.source, digests.uriDigest);
  const liveAliasItems = new Map<string, SourceItemRow>();
  let hasForgottenAlias = false;
  for (const match of aliases) {
    if (
      match.item.lifecycle === "forgotten" ||
      match.item.lifecycle === "forgetting"
    ) {
      hasForgottenAlias = true;
    } else {
      liveAliasItems.set(match.item.id, match.item);
    }
  }
  if (liveAliasItems.size > 1 || (liveAliasItems.size > 0 && hasForgottenAlias)) {
    return review("ambiguous_uri_alias");
  }

  let item: SourceItemRow | undefined;
  if (args.entry.externalId !== undefined) {
    item = await itemByExternalIdentity(
      ctx,
      args.source,
      args.entry.externalId,
      digests.externalIdHash!,
    );
    if (
      item &&
      (item.lifecycle === "forgotten" || item.lifecycle === "forgetting")
    ) {
      return review("forgotten_identity", {
        sourceItemId: item.id,
        state: "ignored_forgotten",
      });
    }
    const aliasedItem = liveAliasItems.values().next().value;
    if (aliasedItem && (!item || aliasedItem.id !== item.id)) {
      return review("uri_alias_identity_conflict", {
        ...(item === undefined ? {} : { sourceItemId: item.id }),
      });
    }
    if (!item && hasForgottenAlias) {
      return review("forgotten_uri_alias", { state: "ignored_forgotten" });
    }
    if (!item) {
      if (args.scan.mode === "identity_recovery") {
        return review("unmatched_recovery_identity");
      }
      item = camelizeSourceItem(
        (await createOrGetSourceItem(ctx.client, {
          spaceId: args.source.spaceId,
          sourceAccountId: args.source.account.id,
          externalId: args.entry.externalId,
          ...(args.entry.title === undefined ? {} : { title: args.entry.title }),
          ...(args.entry.docType === undefined
            ? {}
            : { docType: args.entry.docType }),
          uri: args.entry.uri,
        })) as unknown as Record<string, unknown>,
      );
    }
  } else {
    if (args.scan.mode !== "identity_recovery") {
      workerProtocolError("invalid_request");
    }
    if (hasForgottenAlias && liveAliasItems.size === 0) {
      return review("forgotten_uri_alias", { state: "ignored_forgotten" });
    }
    if (liveAliasItems.size !== 1) return review("unmatched_recovery_identity");
    item = liveAliasItems.values().next().value!;
    if (!item.externalId) workerProtocolError("scan_conflict");
    resolvedEntry = { ...args.entry, externalId: item.externalId };
    digests = await entryDigests(args.source.account.id, resolvedEntry);
    const resolvedDuplicate = await row<{ id: string }>(
      ctx,
      `SELECT id FROM kith.worker_scan_entries
        WHERE scan_id = $1 AND identity_key_hash = $2 LIMIT 1`,
      [args.scan.id, digests.identityKeyHash],
    );
    if (resolvedDuplicate) return review("duplicate_scan_identity");
  }

  const alias = await addOrRefreshAlias(
    ctx,
    args.source,
    item,
    digests.uriDigest,
    aliases,
  );
  if (alias === "cap_reached") {
    return review("uri_alias_limit", { sourceItemId: item.id });
  }
  return persistResolvedEntry(ctx, {
    source: args.source,
    scan: args.scan,
    pageId: args.pageId,
    item,
    entry: resolvedEntry,
    digests,
  });
}

/** The wire shape of one appended entry. */
export function scanEntryResult(entry: WorkerScanEntryRow): {
  state: WorkerScanEntryRow["state"];
  sourceItemId?: string;
  observationEpoch?: number;
  processingEpoch?: number;
} {
  return {
    state: entry.state,
    ...(entry.sourceItemId === null ? {} : { sourceItemId: entry.sourceItemId }),
    ...(num(entry.observationEpoch) === null
      ? {}
      : { observationEpoch: entry.observationEpoch as number }),
    ...(num(entry.processingEpoch) === null
      ? {}
      : { processingEpoch: entry.processingEpoch as number }),
  };
}
