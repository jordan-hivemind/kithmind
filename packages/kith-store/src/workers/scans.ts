import type {
  FsDiscoveryEntry,
  WorkerInventoryPageResult,
  WorkerRequest,
  WorkerScanAppendResult,
  WorkerScanBeginResult,
  WorkerScanReconcileResult,
  WorkerScanSealResult,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import { markMissingInventoryRows, upsertSourceInventoryRow } from "../documents/inventory.js";
import { newKithId, KITH_ID } from "../ids.js";
import { markSourceItemUnavailable } from "../provenance/model.js";
import { camelizeSourceItem, type SourceItemRow, type SourceLifecycle } from "../provenance/rows.js";
import { requireWorkerSourceAccount, ensureSameActor, type LoadedWorkerSource } from "./auth.js";
import { decodeCursor, keysetPage } from "./cursor.js";
import { at, digest, exec, nowPlus, row, rows, type WorkerCtx } from "./db.js";
import { currentDiscoveryWork, obsoletePriorWork, resolveAndPersistEntry, scanEntryResult } from "./entries.js";
import { workerProtocolError } from "./errors.js";
import { accountAdmitsBinaryEntry } from "./profile.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import { camelizeScan, camelizeScanEntry, type WorkerSourceScanRow } from "./rows.js";

/**
 * ADM-6a review. The lifecycles `reconcileWorkerScan` leaves alone, in the two
 * groups its loop treats differently.
 *
 * A forgetting or forgotten item is passed over before the scan's mode is even
 * read: it is on its way out of the archive and no scan may touch it. An item
 * a previous pass already retired is reached, and then left as it is, because
 * retiring it twice would spend an observation epoch on no change.
 *
 * Read together they are the population reconcile would never mark
 * unavailable, which is exactly the population `getWorkerSourceItemCounts`
 * counts: that query builds its `WHERE` clause from this constant rather than
 * repeating the list. The watcher compares the count it gets back against its
 * own journal and refuses the pass when the two disagree, so a list that had
 * drifted from this one would make it refuse healthy passes, or let a fatal
 * one through.
 */
export const RECONCILE_TERMINAL_LIFECYCLES: readonly SourceLifecycle[] = [
  "forgotten",
  "forgetting",
];
export const RECONCILE_RETIRED_LIFECYCLE: SourceLifecycle = "unavailable";
export const RECONCILE_EXEMPT_LIFECYCLES: readonly SourceLifecycle[] = [
  ...RECONCILE_TERMINAL_LIFECYCLES,
  RECONCILE_RETIRED_LIFECYCLE,
];

export const WORKER_SCAN_IDLE_MS = 30 * 60 * 1_000;
export const WORKER_SCAN_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

function scanResult(scan: WorkerSourceScanRow, reused: boolean): WorkerScanBeginResult {
  return {
    operation: "scan.begin",
    scanId: scan.id,
    inventoryEpoch: scan.inventoryEpoch,
    manifestVersion: scan.manifestVersionAtBegin,
    state: scan.state,
    reused,
  };
}

async function invalidateCoverage(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
): Promise<void> {
  const previous = source.account.coverageInvalidatedAt?.getTime() ?? 0;
  await exec(
    ctx,
    `UPDATE kith.source_accounts
        SET coverage_invalidated_at = $1
      WHERE id = $2 AND space_id = $3`,
    [at(Math.max(ctx.now, previous + 1)), source.account.id, source.spaceId],
  );
}

export async function loadWorkerScan(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  scanId: string,
): Promise<WorkerSourceScanRow> {
  if (!KITH_ID.test(scanId)) workerProtocolError("invalid_request");
  const found = await row<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_source_scans
      WHERE id = $1 AND space_id = $2 AND source_account_id = $3`,
    [scanId, source.spaceId, source.account.id],
  );
  if (!found) workerProtocolError("not_found");
  const scan = camelizeScan(found);
  ensureSameActor(source.principal, scan);
  return scan;
}

async function failExpiredActiveScan(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
): Promise<void> {
  const activeId = source.account.activeWorkerScanId;
  if (!activeId) return;
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_source_scans WHERE id = $1",
    [activeId],
  );
  if (!found) {
    await exec(ctx, "UPDATE kith.source_accounts SET active_worker_scan_id = NULL WHERE id = $1", [source.account.id]);
    await invalidateCoverage(ctx, source);
    return;
  }
  const active = camelizeScan(found);
  if (active.spaceId !== source.spaceId || active.sourceAccountId !== source.account.id) {
    await exec(ctx, "UPDATE kith.source_accounts SET active_worker_scan_id = NULL WHERE id = $1", [source.account.id]);
    await invalidateCoverage(ctx, source);
    return;
  }
  if (["enumerated", "needs_review", "failed"].includes(active.state)) {
    await exec(ctx, "UPDATE kith.source_accounts SET active_worker_scan_id = NULL WHERE id = $1", [source.account.id]);
    return;
  }
  if (active.expiresAt.getTime() > ctx.now) workerProtocolError("scan_conflict");
  await exec(
    ctx,
    `UPDATE kith.worker_source_scans
        SET state = 'failed', failure_code = 'enumeration_interrupted', completed_at = $1,
            retire_at = $2
      WHERE id = $3`,
    [at(ctx.now), at(nowPlus(ctx.now, WORKER_SCAN_RETENTION_MS)), active.id],
  );
  await exec(ctx, "UPDATE kith.source_accounts SET active_worker_scan_id = NULL WHERE id = $1", [source.account.id]);
  await invalidateCoverage(ctx, source);
}

export async function beginWorkerScan(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "scan.begin" }>,
): Promise<WorkerScanBeginResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const requestDigest = await digest("worker-scan-begin:v1", [
    source.account.id,
    request.requestId,
    request.watcherId,
    request.connectorVersion,
    request.hostAffinity ?? null,
    request.mode,
    request.expectedInventoryEpoch,
  ]);
  const prior = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_source_scans
        WHERE source_account_id = $1 AND request_id = $2
        ORDER BY created_at, id LIMIT 2`,
      [source.account.id, request.requestId],
    )
  ).map(camelizeScan);
  if (prior.length > 1) workerProtocolError("scan_conflict");
  if (prior[0]) {
    ensureSameActor(source.principal, prior[0]);
    if (prior[0].requestDigest !== requestDigest) workerProtocolError("request_conflict");
    return scanResult(prior[0], true);
  }

  await failExpiredActiveScan(ctx, source);
  await consumeWorkerMutationRateLimit(ctx, source.principal.credentialId, source.account.id);
  const currentEpoch = source.account.inventoryEpoch ?? 0;
  if (currentEpoch !== request.expectedInventoryEpoch) workerProtocolError("scan_conflict");
  const inventoryEpoch = currentEpoch + 1;
  if (!Number.isSafeInteger(inventoryEpoch)) workerProtocolError("scan_conflict");
  const manifestVersion = source.account.manifestVersion ?? 0;
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_source_scans
       (id, space_id, created_at, source_account_id, request_id, request_digest,
        watcher_id, connector_version, host_affinity, mode, inventory_epoch,
        manifest_version_at_begin, actor_user_id, actor_credential_id, state,
        next_page_ordinal, next_reconcile_ordinal, inventory_done, page_count,
        entry_count, changed_count, gap_count, review_count, started_at, expires_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             'open',0,0,$14,0,0,0,0,0,$15,$16,$17)`,
    [
      id,
      source.spaceId,
      source.account.id,
      request.requestId,
      requestDigest,
      request.watcherId,
      request.connectorVersion,
      request.hostAffinity ?? null,
      request.mode,
      inventoryEpoch,
      manifestVersion,
      source.principal.userId,
      source.principal.credentialId,
      request.mode === "normal",
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_SCAN_IDLE_MS)),
      at(nowPlus(ctx.now, WORKER_SCAN_RETENTION_MS)),
    ],
  );
  await exec(
    ctx,
    `UPDATE kith.source_accounts SET inventory_epoch = $1, active_worker_scan_id = $2
      WHERE id = $3 AND space_id = $4`,
    [inventoryEpoch, id, source.account.id, source.spaceId],
  );
  return scanResult(
    camelizeScan(
      (await row<Record<string, unknown>>(ctx, "SELECT * FROM kith.worker_source_scans WHERE id = $1", [id])) ??
        workerProtocolError("scan_conflict"),
    ),
    false,
  );
}

function inventoryProjection(
  item: SourceItemRow,
  aliases: string[],
): WorkerInventoryPageResult["page"][number] {
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    return { lifecycle: "tombstone", externalIdHash: item.externalIdHash, uriAliasDigests: aliases.sort() };
  }
  if (!item.externalId) workerProtocolError("scan_conflict");
  return {
    lifecycle: item.lifecycle,
    sourceItemId: item.id,
    externalId: item.externalId,
    ...(item.uri === null ? {} : { uri: item.uri }),
    observationEpoch: item.workerObservationEpoch ?? 0,
    processingEpoch: item.workerProcessingEpoch ?? 0,
    ...(item.workerInventoryMetadataDigest === null
      ? {}
      : { inventoryMetadataDigest: item.workerInventoryMetadataDigest }),
  };
}

async function inventoryItem(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  item: SourceItemRow,
): Promise<WorkerInventoryPageResult["page"][number]> {
  if (item.spaceId !== source.spaceId || item.sourceAccountId !== source.account.id) {
    workerProtocolError("scan_conflict");
  }
  let aliases: string[] = [];
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    const found = await rows<{ space_id: string; source_account_id: string; source_item_id: string; digest: string }>(
      ctx,
      `SELECT space_id, source_account_id, source_item_id, digest
         FROM kith.source_alias_digests WHERE source_item_id = $1
         ORDER BY created_at, id LIMIT 9`,
      [item.id],
    );
    if (found.length > 8) workerProtocolError("scan_conflict");
    if (found.some((alias) => alias.space_id !== source.spaceId || alias.source_account_id !== source.account.id || alias.source_item_id !== item.id)) {
      workerProtocolError("scan_conflict");
    }
    aliases = found.map((alias) => alias.digest);
  }
  return inventoryProjection(item, aliases);
}

async function sourceItemsPage(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  cursor: string | null,
  numItems: number,
): Promise<{ page: SourceItemRow[]; isDone: boolean; continueCursor: string }> {
  const position = decodeCursor(cursor);
  const fetched = position
    ? await rows<Record<string, unknown> & { key_created_at: string }>(
        ctx,
        `SELECT *, created_at::text AS key_created_at FROM kith.source_items
          WHERE source_account_id = $1 AND (created_at, id) > ($2, $3)
          ORDER BY created_at, id LIMIT $4`,
        [source.account.id, position.createdAt, position.id, numItems + 1],
      )
    : await rows<Record<string, unknown> & { key_created_at: string }>(
        ctx,
        `SELECT *, created_at::text AS key_created_at FROM kith.source_items
          WHERE source_account_id = $1 ORDER BY created_at, id LIMIT $2`,
        [source.account.id, numItems + 1],
      );
  const positioned = fetched.map((raw) => ({
    ...camelizeSourceItem(raw),
    keyCreatedAt: raw.key_created_at,
  }));
  const page = keysetPage(
    positioned.map((item) => ({ ...item, createdAt: item.keyCreatedAt })),
    numItems,
  );
  return {
    page: page.page.map(({ keyCreatedAt: _key, ...item }) => ({ ...item, createdAt: new Date(item.createdAt) })),
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

export async function getWorkerInventoryPage(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "source.inventoryPage" }>,
): Promise<WorkerInventoryPageResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const scan = await loadWorkerScan(ctx, source, request.scanId);
  if (
    scan.mode !== "identity_recovery" ||
    scan.state !== "open" ||
    scan.expiresAt.getTime() <= ctx.now ||
    source.account.activeWorkerScanId !== scan.id ||
    scan.inventoryEpoch !== request.expectedInventoryEpoch
  ) workerProtocolError("scan_not_ready");
  if ((source.account.manifestVersion ?? 0) !== request.expectedManifestVersion) workerProtocolError("scan_conflict");
  const requestDigest = await digest("worker-inventory-page:v1", [
    source.account.id,
    scan.id,
    request.requestId,
    request.expectedInventoryEpoch,
    request.expectedManifestVersion,
    request.paginationOpts.cursor,
    request.paginationOpts.numItems,
  ]);
  const retry = scan.lastInventoryRequestId === request.requestId;
  if (retry && scan.lastInventoryRequestDigest !== requestDigest) workerProtocolError("request_conflict");
  if (!retry) {
    if (scan.inventoryDone) workerProtocolError("scan_not_ready");
    if ((scan.inventoryCursor ?? null) !== request.paginationOpts.cursor) workerProtocolError("scan_conflict");
    await consumeWorkerMutationRateLimit(ctx, source.principal.credentialId, source.account.id);
  }
  const paginated = await sourceItemsPage(ctx, source, request.paginationOpts.cursor, request.paginationOpts.numItems);
  const page = await Promise.all(paginated.page.map((item) => inventoryItem(ctx, source, item)));
  if (!retry) {
    await exec(
      ctx,
      `UPDATE kith.worker_source_scans
          SET inventory_cursor = $1, inventory_done = $2, last_inventory_request_id = $3,
              last_inventory_request_digest = $4, last_inventory_input_cursor = $5,
              last_inventory_output_cursor = $1, last_inventory_done = $2, expires_at = $6
        WHERE id = $7`,
      [
        paginated.continueCursor,
        paginated.isDone,
        request.requestId,
        requestDigest,
        request.paginationOpts.cursor,
        at(nowPlus(ctx.now, WORKER_SCAN_IDLE_MS)),
        scan.id,
      ],
    );
  }
  return { operation: "source.inventoryPage", page, isDone: paginated.isDone, continueCursor: paginated.continueCursor };
}

function parseFsUri(uri: string): { relativePath: string; folderPath: string; fileName: string } {
  const separator = uri.indexOf("/", "fs://".length);
  const segments = uri.slice(separator + 1).split("/").map((segment) => decodeURIComponent(segment));
  return {
    relativePath: segments.join("/"),
    folderPath: segments.slice(0, -1).join("/"),
    fileName: segments[segments.length - 1]!,
  };
}

async function updateInventory(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  scan: WorkerSourceScanRow,
  entry: FsDiscoveryEntry,
  persisted: ReturnType<typeof camelizeScanEntry>,
): Promise<void> {
  const location = parseFsUri(entry.uri);
  const gapCode = entry.content.status === "gap" ? entry.content.code : undefined;
  const permissionsRestricted = entry.content.status === "ready_binary_v1" && entry.content.permissionsRestricted === true;
  await upsertSourceInventoryRow(ctx.client, {
    spaceId: source.spaceId,
    sourceAccountId: source.account.id,
    scanId: scan.id,
    ...(persisted.sourceItemId === null ? {} : { sourceItemId: persisted.sourceItemId }),
    identityKeyHash: persisted.identityKeyHash,
    ...location,
    sourceModifiedAt: new Date(entry.sourceModifiedAt),
    ...(gapCode === undefined ? {} : { gapCode }),
    ...(entry.content.status === "gap" ? {} : { byteLength: entry.content.byteLength, contentHash: entry.content.sha256 }),
    ...(entry.content.status === "ready_binary_v1"
      ? { mediaType: entry.content.mediaType }
      : entry.content.status === "ready"
        ? { mediaType: "text/plain" }
        : {}),
    permissionsRestricted,
    ...(permissionsRestricted
      ? { permissionsDetail: `standard security handler revision ${entry.content.status === "ready_binary_v1" ? entry.content.encryptionRevision : ""} (empty user password)` }
      : {}),
  });
}

export async function appendWorkerScanPage(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "scan.appendPage" }>,
): Promise<WorkerScanAppendResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  if (request.entries.some((entry) => entry.content.status === "ready_binary_v1" && !accountAdmitsBinaryEntry(source.account, entry.content.parserProfileId))) {
    workerProtocolError("source_unavailable");
  }
  const scan = await loadWorkerScan(ctx, source, request.scanId);
  const requestDigest = await digest("worker-scan-page:v1", [source.account.id, scan.id, request.requestId, request.ordinal, request.entries]);
  const prior = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_scan_pages WHERE scan_id = $1 AND request_id = $2
      ORDER BY created_at, id LIMIT 2`,
    [scan.id, request.requestId],
  );
  if (prior.length > 1) workerProtocolError("scan_conflict");
  if (prior[0]) {
    const page = prior[0];
    if (
      page.space_id !== source.spaceId || page.source_account_id !== source.account.id ||
      page.scan_id !== scan.id || page.redacted_at !== null || page.request_digest !== requestDigest ||
      Number(page.ordinal) !== request.ordinal
    ) workerProtocolError("request_conflict");
    const entries = (
      await rows<Record<string, unknown>>(
        ctx,
        "SELECT * FROM kith.worker_scan_entries WHERE scan_page_id = $1 ORDER BY created_at, id",
        [page.id],
      )
    ).map(camelizeScanEntry);
    if (entries.length !== Number(page.entry_count) || entries.some((entry) => entry.spaceId !== source.spaceId || entry.sourceAccountId !== source.account.id || entry.scanId !== scan.id || entry.scanPageId !== page.id)) {
      workerProtocolError("scan_conflict");
    }
    return { operation: "scan.appendPage", scanId: scan.id, ordinal: request.ordinal, reused: true, entries: entries.map(scanEntryResult) };
  }
  if (scan.state !== "open" || scan.expiresAt.getTime() <= ctx.now || source.account.activeWorkerScanId !== scan.id || (scan.mode === "identity_recovery" && !scan.inventoryDone)) {
    workerProtocolError("scan_not_ready");
  }
  if (scan.nextPageOrdinal !== request.ordinal) workerProtocolError("scan_conflict");
  const ordinalCollision = await row<{ id: string }>(ctx, "SELECT id FROM kith.worker_scan_pages WHERE scan_id = $1 AND ordinal = $2 LIMIT 1", [scan.id, request.ordinal]);
  if (ordinalCollision) workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(ctx, source.principal.credentialId, source.account.id);

  const pageId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_scan_pages
       (id, space_id, created_at, source_account_id, scan_id, ordinal, request_id,
        request_digest, entry_count, created_at_field, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10)`,
    [pageId, source.spaceId, source.account.id, scan.id, request.ordinal, request.requestId, requestDigest, request.entries.length, at(ctx.now), at(nowPlus(ctx.now, 30 * 24 * 60 * 60 * 1_000))],
  );
  const persisted = [];
  let manifestChanged = false;
  for (const entry of request.entries) {
    const result = await resolveAndPersistEntry(ctx, { source, scan, pageId, entry });
    persisted.push(result.row);
    manifestChanged ||= result.manifestChanged;
    await updateInventory(ctx, source, scan, entry, result.row);
  }
  const gapCount = persisted.filter((entry) => entry.state === "gap").length;
  const reviewCount = persisted.filter((entry) => entry.state === "needs_review").length;
  const changedCount = persisted.filter((entry) => entry.state === "queued").length;
  await exec(
    ctx,
    `UPDATE kith.worker_source_scans SET next_page_ordinal = $1, page_count = $2,
       entry_count = $3, changed_count = $4, gap_count = $5, review_count = $6, expires_at = $7
     WHERE id = $8`,
    [scan.nextPageOrdinal + 1, scan.pageCount + 1, scan.entryCount + persisted.length, scan.changedCount + changedCount, scan.gapCount + gapCount, scan.reviewCount + reviewCount, at(nowPlus(ctx.now, WORKER_SCAN_IDLE_MS)), scan.id],
  );
  if (manifestChanged) {
    await exec(ctx, "UPDATE kith.source_accounts SET manifest_version = COALESCE(manifest_version, 0) + 1 WHERE id = $1", [source.account.id]);
    await invalidateCoverage(ctx, source);
  }
  if (gapCount > 0 || reviewCount > 0) await invalidateCoverage(ctx, source);
  return { operation: "scan.appendPage", scanId: scan.id, ordinal: request.ordinal, reused: false, entries: persisted.map(scanEntryResult) };
}

export async function sealWorkerScan(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "scan.seal" }>,
): Promise<WorkerScanSealResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const scan = await loadWorkerScan(ctx, source, request.scanId);
  const requestDigest = await digest("worker-scan-seal:v1", [source.account.id, scan.id, request.requestId, request.expectedPageCount, request.health]);
  if (scan.sealRequestId === request.requestId) {
    if (scan.sealRequestDigest !== requestDigest) workerProtocolError("request_conflict");
    if (
      scan.state !== "sealed" &&
      scan.state !== "reconciling" &&
      scan.state !== "enumerated" &&
      scan.state !== "needs_review" &&
      scan.state !== "failed"
    ) workerProtocolError("scan_conflict");
    const replayState =
      scan.state === "reconciling" || scan.state === "enumerated"
        ? "sealed"
        : scan.state;
    return { operation: "scan.seal", scanId: scan.id, state: replayState, reused: true };
  }
  if (scan.state !== "open" || scan.expiresAt.getTime() <= ctx.now || source.account.activeWorkerScanId !== scan.id || (scan.mode === "identity_recovery" && !scan.inventoryDone)) workerProtocolError("scan_not_ready");
  if (request.expectedPageCount !== scan.pageCount || request.expectedPageCount !== scan.nextPageOrdinal) workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(ctx, source.principal.credentialId, source.account.id);
  const state = request.health.status === "failed" ? "failed" : scan.reviewCount > 0 ? "needs_review" : "sealed";
  const manifestVersion = source.account.manifestVersion ?? 0;
  await exec(
    ctx,
    `UPDATE kith.worker_source_scans SET state = $1, seal_request_id = $2,
       seal_request_digest = $3, manifest_version_at_seal = $4,
       reconcile_manifest_version = $4, sealed_at = $5, completed_at = $6,
       failure_code = $7, expires_at = $8, retire_at = $9 WHERE id = $10`,
    [state, request.requestId, requestDigest, manifestVersion, at(ctx.now), state === "sealed" ? null : at(ctx.now), request.health.status === "failed" ? request.health.code : null, at(nowPlus(ctx.now, WORKER_SCAN_IDLE_MS)), at(nowPlus(ctx.now, WORKER_SCAN_RETENTION_MS)), scan.id],
  );
  await invalidateCoverage(ctx, source);
  if (state !== "sealed") await exec(ctx, "UPDATE kith.source_accounts SET active_worker_scan_id = NULL WHERE id = $1", [source.account.id]);
  return { operation: "scan.seal", scanId: scan.id, state, reused: false };
}

export async function reconcileWorkerScan(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "scan.reconcile" }>,
): Promise<WorkerScanReconcileResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const scan = await loadWorkerScan(ctx, source, request.scanId);
  const requestDigest = await digest("worker-scan-reconcile:v1", [source.account.id, scan.id, request.requestId, request.expectedInventoryEpoch, request.ordinal, request.maxItems]);
  if (scan.lastReconcileRequestId === request.requestId) {
    if (scan.lastReconcileRequestDigest !== requestDigest || !scan.lastReconcileResult) workerProtocolError("request_conflict");
    return { operation: "scan.reconcile", scanId: scan.id, ...scan.lastReconcileResult, reused: true };
  }
  if ((scan.state !== "sealed" && scan.state !== "reconciling") || scan.expiresAt.getTime() <= ctx.now || scan.inventoryEpoch !== request.expectedInventoryEpoch || source.account.activeWorkerScanId !== scan.id) workerProtocolError("scan_not_ready");
  if (scan.nextReconcileOrdinal !== request.ordinal) workerProtocolError("scan_conflict");
  if (scan.reconcileManifestVersion === null || (source.account.manifestVersion ?? 0) !== scan.reconcileManifestVersion) workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(ctx, source.principal.credentialId, source.account.id);
  const paginated = await sourceItemsPage(ctx, source, scan.reconcileCursor, request.maxItems);
  let unavailable = 0;
  let needsReview = scan.reconcileNeedsReview ?? false;
  for (const item of paginated.page) {
    if (item.spaceId !== source.spaceId || item.sourceAccountId !== source.account.id) workerProtocolError("scan_conflict");
    if (RECONCILE_TERMINAL_LIFECYCLES.includes(item.lifecycle) || item.workerLastSeenInventoryEpoch === scan.inventoryEpoch) continue;
    if (scan.mode === "identity_recovery") {
      needsReview = true;
      continue;
    }
    if (item.lifecycle !== RECONCILE_RETIRED_LIFECYCLE) {
      const priorWork = await currentDiscoveryWork(ctx, source, item);
      if (priorWork) await obsoletePriorWork(ctx, priorWork, false);
      const observationEpoch = (item.workerObservationEpoch ?? 0) + 1;
      if (!Number.isSafeInteger(observationEpoch)) workerProtocolError("scan_conflict");
      await markSourceItemUnavailable(ctx.client, { spaceId: source.spaceId, sourceItemId: item.id });
      await exec(ctx, "UPDATE kith.source_items SET worker_observation_epoch = $1 WHERE id = $2", [observationEpoch, item.id]);
      unavailable += 1;
    }
  }
  const done = paginated.isDone;
  const state = done ? (needsReview ? "needs_review" : "enumerated") : "reconciling";
  const result = { state, inspected: paginated.page.length, unavailable, done } as const;
  const nextManifestVersion = (source.account.manifestVersion ?? 0) + (unavailable > 0 ? 1 : 0);
  await exec(
    ctx,
    `UPDATE kith.worker_source_scans SET state = $1, reconcile_cursor = $2,
       next_reconcile_ordinal = $3, reconcile_needs_review = $4,
       reconcile_manifest_version = $5, last_reconcile_request_id = $6,
       last_reconcile_request_digest = $7, last_reconcile_result = $8,
       completed_at = $9, expires_at = $10, retire_at = $11 WHERE id = $12`,
    [state, paginated.continueCursor, scan.nextReconcileOrdinal + 1, needsReview, nextManifestVersion, request.requestId, requestDigest, JSON.stringify(result), done ? at(ctx.now) : null, at(nowPlus(ctx.now, WORKER_SCAN_IDLE_MS)), at(nowPlus(ctx.now, WORKER_SCAN_RETENTION_MS)), scan.id],
  );
  if (unavailable > 0) {
    await exec(ctx, "UPDATE kith.source_accounts SET manifest_version = $1 WHERE id = $2", [nextManifestVersion, source.account.id]);
    await invalidateCoverage(ctx, source);
  }
  if (done) {
    if (needsReview) {
      await exec(ctx, "UPDATE kith.source_accounts SET active_worker_scan_id = NULL WHERE id = $1", [source.account.id]);
      await invalidateCoverage(ctx, source);
    } else {
      await exec(ctx, `UPDATE kith.source_accounts SET active_worker_scan_id = NULL, completed_inventory_epoch = $1, last_enumerated_at = $2 WHERE id = $3`, [scan.inventoryEpoch, at(ctx.now), source.account.id]);
      await markMissingInventoryRows(ctx.client, { spaceId: source.spaceId, sourceAccountId: source.account.id, scanId: scan.id });
    }
  }
  return { operation: "scan.reconcile", scanId: scan.id, ...result, reused: false };
}
