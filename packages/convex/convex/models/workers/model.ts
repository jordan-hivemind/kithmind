import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { PrincipalRef } from "../../lib/spaces";
import { digestProcessingConfiguration } from "../ingestion/hash";
import {
  createOrGetSourceItem,
  markSourceItemUnavailable,
  refreshAvailableSourceItem,
  sha256Utf8,
} from "../provenance/model";
import {
  markMissingInventoryRows,
  upsertSourceInventoryRow,
} from "../documents/inventory";
import { workerProtocolError } from "./errors";
import { accountAdmitsBinaryClass, FS_TEXT_PROFILE } from "./profile";
import {
  type FsDiscoveryEntry,
  type WorkerInventoryPageResult,
  type WorkerRequest,
  type WorkerScanAppendResult,
  type WorkerScanBeginResult,
  type WorkerScanReconcileResult,
  type WorkerScanSealResult,
  type WorkerSourceStatusResult,
} from "./protocol";
import { requireWorkerSourceAccount, type WorkerPrincipal } from "./auth";
import { getProcessingAssessmentStatus } from "./assessment";
import {
  consumeWorkerMutationRateLimit,
  WORKER_MUTATION_RATE_LIMIT,
  WORKER_MUTATION_RATE_WINDOW_MS,
} from "./rateLimit";

export const WORKER_SCAN_IDLE_MS = 30 * 60 * 1_000;
export const WORKER_DETAIL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const WORKER_SCAN_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const MAX_SOURCE_URI_ALIASES = 8;
export const WORKER_CLEANUP_BATCH_SIZE = 25;
export { WORKER_MUTATION_RATE_LIMIT, WORKER_MUTATION_RATE_WINDOW_MS };

type SourceRequest = Pick<WorkerRequest, "spaceId" | "sourceAccountId">;
type WorkerDbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type FsReadyDiscoveryEntry = Omit<FsDiscoveryEntry, "content"> & {
  content: Exclude<FsDiscoveryEntry["content"], { status: "gap" }>;
};

function isReadyEntry(entry: FsDiscoveryEntry): entry is FsReadyDiscoveryEntry {
  return entry.content.status !== "gap";
}

function processingProfile(entry: FsReadyDiscoveryEntry) {
  return entry.content.status === "ready"
    ? {
        representation: "inline_utf8_v1" as const,
        mediaType: FS_TEXT_PROFILE.mediaType,
        profileId: FS_TEXT_PROFILE.profileId,
        parserFingerprint: undefined,
        extractionConfigurationFingerprint: undefined,
        extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
        extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
        recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
        normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
        chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
        correctionRevision: undefined,
      }
    : {
        representation: "archived_binary_v1" as const,
        mediaType: entry.content.mediaType,
        profileId: entry.content.parserProfileId,
        parserFingerprint: entry.content.parserFingerprint,
        extractionConfigurationFingerprint:
          entry.content.extractionConfigurationFingerprint,
        extractionFingerprint: "artifact-bound-extraction:v1",
        extractorFingerprint: entry.content.extractorFingerprint,
        recordSchemaFingerprint: entry.content.recordSchemaFingerprint,
        normalizationFingerprint: entry.content.normalizationFingerprint,
        chunkerFingerprint: entry.content.chunkerFingerprint,
        correctionRevision: entry.content.correctionRevision,
      };
}

type LoadedWorkerSource = Awaited<
  ReturnType<typeof requireWorkerSourceAccount>
>;

function nowPlus(now: number, duration: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + duration);
}

function scanResult(
  scan: Doc<"workerSourceScans">,
  reused: boolean,
): WorkerScanBeginResult {
  return {
    operation: "scan.begin",
    scanId: scan._id,
    inventoryEpoch: scan.inventoryEpoch,
    manifestVersion: scan.manifestVersionAtBegin,
    state: scan.state,
    reused,
  };
}

async function digest(domain: string, value: unknown): Promise<string> {
  return sha256Utf8(`${domain}\0${JSON.stringify(value)}`);
}

function ensureSameActor(
  principal: WorkerPrincipal,
  row: { actorUserId: Id<"users">; actorCredentialId: Id<"apiKeys"> },
): void {
  if (
    row.actorUserId !== principal.userId ||
    row.actorCredentialId !== principal.credentialId
  ) {
    throw workerProtocolError("not_found");
  }
}

async function invalidateCoverage(
  ctx: MutationCtx,
  account: Doc<"sourceAccounts">,
  now: number,
): Promise<void> {
  await ctx.db.patch(account._id, {
    coverageInvalidatedAt: Math.max(
      now,
      (account.coverageInvalidatedAt ?? 0) + 1,
    ),
  });
}

async function loadScan(
  ctx: WorkerDbCtx,
  source: LoadedWorkerSource,
  rawScanId: string,
): Promise<Doc<"workerSourceScans">> {
  const scanId = ctx.db.normalizeId("workerSourceScans", rawScanId);
  if (!scanId) throw workerProtocolError("invalid_request");
  const scan = await ctx.db.get(scanId);
  if (
    !scan ||
    scan.spaceId !== source.spaceId ||
    scan.sourceAccountId !== source.account._id
  ) {
    throw workerProtocolError("not_found");
  }
  ensureSameActor(source.principal, scan);
  return scan;
}

async function failExpiredActiveScan(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  now: number,
): Promise<void> {
  const activeId = source.account.activeWorkerScanId;
  if (!activeId) return;
  const active = await ctx.db.get(activeId);
  if (
    !active ||
    active.spaceId !== source.spaceId ||
    active.sourceAccountId !== source.account._id
  ) {
    await ctx.db.patch(source.account._id, { activeWorkerScanId: undefined });
    await invalidateCoverage(ctx, source.account, now);
    return;
  }
  if (
    active.state === "enumerated" ||
    active.state === "needs_review" ||
    active.state === "failed"
  ) {
    await ctx.db.patch(source.account._id, { activeWorkerScanId: undefined });
    return;
  }
  if (active.expiresAt > now) throw workerProtocolError("scan_conflict");
  await ctx.db.patch(active._id, {
    state: "failed",
    failureCode: "enumeration_interrupted",
    completedAt: now,
    retireAt: nowPlus(now, WORKER_SCAN_RETENTION_MS),
  });
  await ctx.db.patch(source.account._id, { activeWorkerScanId: undefined });
  await invalidateCoverage(ctx, source.account, now);
}

export async function getWorkerSourceStatus(
  ctx: QueryCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "source.status" }>,
  now: number,
): Promise<WorkerSourceStatusResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  let scan: Doc<"workerSourceScans"> | null = null;
  if (source.account.activeWorkerScanId) {
    scan = await ctx.db.get(source.account.activeWorkerScanId);
    if (
      scan &&
      (scan.spaceId !== source.spaceId ||
        scan.sourceAccountId !== source.account._id)
    ) {
      throw workerProtocolError("scan_conflict");
    }
  }
  if (!scan) {
    const recent = await ctx.db
      .query("workerSourceScans")
      .withIndex("by_sourceAccountId", (q) =>
        q.eq("sourceAccountId", source.account._id),
      )
      .order("desc")
      .take(1);
    scan = recent[0] ?? null;
    if (
      scan &&
      (scan.spaceId !== source.spaceId ||
        scan.sourceAccountId !== source.account._id)
    ) {
      throw workerProtocolError("scan_conflict");
    }
  }

  if (scan && scan.inventoryEpoch !== (source.account.inventoryEpoch ?? 0)) {
    scan = null;
  }

  let enumeration: WorkerSourceStatusResult["enumeration"];
  if (!scan) {
    if (
      (source.account.completedInventoryEpoch ?? 0) ===
        (source.account.inventoryEpoch ?? 0) &&
      source.account.lastEnumeratedAt !== undefined
    ) {
      enumeration = {
        state: "complete",
        completedAt: source.account.lastEnumeratedAt,
      };
    } else if (
      (source.account.inventoryEpoch ?? 0) >
      (source.account.completedInventoryEpoch ?? 0)
    ) {
      enumeration = { state: "failed" };
    } else {
      enumeration = { state: "never" };
    }
  } else if (
    (scan.state === "open" ||
      scan.state === "sealed" ||
      scan.state === "reconciling") &&
    scan.expiresAt <= now
  ) {
    enumeration = {
      state: "failed",
      scanId: scan._id,
      failureCode: "enumeration_interrupted",
    };
  } else if (
    scan.state === "open" ||
    scan.state === "sealed" ||
    scan.state === "reconciling"
  ) {
    enumeration = { state: "in_progress", scanId: scan._id };
  } else if (scan.state === "enumerated") {
    if (scan.completedAt === undefined) {
      throw workerProtocolError("scan_conflict");
    }
    enumeration = {
      state: "complete",
      scanId: scan._id,
      completedAt: scan.completedAt,
    };
  } else if (scan.state === "needs_review") {
    enumeration = {
      state: "needs_review",
      scanId: scan._id,
      ...(scan.completedAt === undefined
        ? {}
        : { completedAt: scan.completedAt }),
    };
  } else {
    enumeration = {
      state: "failed",
      scanId: scan._id,
      ...(scan.completedAt === undefined
        ? {}
        : { completedAt: scan.completedAt }),
      ...(scan.failureCode === undefined
        ? {}
        : { failureCode: scan.failureCode }),
    };
  }

  return {
    operation: "source.status",
    sourceAccountId: source.account._id,
    inventoryEpoch: source.account.inventoryEpoch ?? 0,
    completedInventoryEpoch: source.account.completedInventoryEpoch ?? 0,
    manifestVersion: source.account.manifestVersion ?? 0,
    enumeration,
    processing: await getProcessingAssessmentStatus(ctx, source, now),
    recordCoverage: "not_established",
  };
}

export async function beginWorkerScan(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "scan.begin" }>,
  now: number,
): Promise<WorkerScanBeginResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const requestDigest = await digest("worker-scan-begin:v1", [
    source.account._id,
    request.requestId,
    request.watcherId,
    request.connectorVersion,
    request.hostAffinity ?? null,
    request.mode,
    request.expectedInventoryEpoch,
  ]);
  const prior = await ctx.db
    .query("workerSourceScans")
    .withIndex("by_sourceAccountId_and_requestId", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("requestId", request.requestId),
    )
    .take(2);
  if (prior.length > 1) throw workerProtocolError("scan_conflict");
  if (prior[0]) {
    ensureSameActor(source.principal, prior[0]);
    if (prior[0].requestDigest !== requestDigest) {
      throw workerProtocolError("request_conflict");
    }
    return scanResult(prior[0], true);
  }

  await failExpiredActiveScan(ctx, source, now);
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const currentEpoch = source.account.inventoryEpoch ?? 0;
  if (currentEpoch !== request.expectedInventoryEpoch) {
    throw workerProtocolError("scan_conflict");
  }
  const inventoryEpoch = currentEpoch + 1;
  if (!Number.isSafeInteger(inventoryEpoch)) {
    throw workerProtocolError("scan_conflict");
  }
  const manifestVersion = source.account.manifestVersion ?? 0;
  const id = await ctx.db.insert("workerSourceScans", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    requestId: request.requestId,
    requestDigest,
    watcherId: request.watcherId,
    connectorVersion: request.connectorVersion,
    ...(request.hostAffinity === undefined
      ? {}
      : { hostAffinity: request.hostAffinity }),
    mode: request.mode,
    inventoryEpoch,
    manifestVersionAtBegin: manifestVersion,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    state: "open",
    nextPageOrdinal: 0,
    nextReconcileOrdinal: 0,
    inventoryDone: request.mode === "normal",
    pageCount: 0,
    entryCount: 0,
    changedCount: 0,
    gapCount: 0,
    reviewCount: 0,
    startedAt: now,
    expiresAt: nowPlus(now, WORKER_SCAN_IDLE_MS),
    retireAt: nowPlus(now, WORKER_SCAN_RETENTION_MS),
  });
  await ctx.db.patch(source.account._id, {
    inventoryEpoch,
    activeWorkerScanId: id,
  });
  const scan = await ctx.db.get(id);
  if (!scan) throw workerProtocolError("scan_conflict");
  return scanResult(scan, false);
}

async function inventoryItem(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  item: Doc<"sourceItems">,
): Promise<WorkerInventoryPageResult["page"][number]> {
  if (
    item.spaceId !== source.spaceId ||
    item.sourceAccountId !== source.account._id
  ) {
    throw workerProtocolError("scan_conflict");
  }
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    const aliases = await ctx.db
      .query("sourceAliasDigests")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .take(MAX_SOURCE_URI_ALIASES + 1);
    if (aliases.length > MAX_SOURCE_URI_ALIASES) {
      throw workerProtocolError("scan_conflict");
    }
    for (const alias of aliases) {
      if (
        alias.spaceId !== source.spaceId ||
        alias.sourceAccountId !== source.account._id ||
        alias.sourceItemId !== item._id
      ) {
        throw workerProtocolError("scan_conflict");
      }
    }
    return {
      lifecycle: "tombstone",
      externalIdHash: item.externalIdHash,
      uriAliasDigests: aliases.map((alias) => alias.digest).sort(),
    };
  }
  if (!item.externalId) throw workerProtocolError("scan_conflict");
  const observationEpoch = item.workerObservationEpoch ?? 0;
  return {
    lifecycle: item.lifecycle,
    sourceItemId: item._id,
    externalId: item.externalId,
    ...(item.uri === undefined ? {} : { uri: item.uri }),
    observationEpoch,
    processingEpoch: item.workerProcessingEpoch ?? 0,
    ...(item.workerInventoryMetadataDigest === undefined
      ? {}
      : { inventoryMetadataDigest: item.workerInventoryMetadataDigest }),
  };
}

export async function getWorkerInventoryPage(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "source.inventoryPage" }>,
  now: number,
): Promise<WorkerInventoryPageResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const scan = await loadScan(ctx, source, request.scanId);
  if (
    scan.mode !== "identity_recovery" ||
    scan.state !== "open" ||
    scan.expiresAt <= now ||
    source.account.activeWorkerScanId !== scan._id ||
    scan.inventoryEpoch !== request.expectedInventoryEpoch
  ) {
    throw workerProtocolError("scan_not_ready");
  }
  if (
    source.account.manifestVersion !== request.expectedManifestVersion &&
    !(
      source.account.manifestVersion === undefined &&
      request.expectedManifestVersion === 0
    )
  ) {
    throw workerProtocolError("scan_conflict");
  }
  const requestDigest = await digest("worker-inventory-page:v1", [
    source.account._id,
    scan._id,
    request.requestId,
    request.expectedInventoryEpoch,
    request.expectedManifestVersion,
    request.paginationOpts.cursor,
    request.paginationOpts.numItems,
  ]);
  const retry = scan.lastInventoryRequestId === request.requestId;
  if (retry && scan.lastInventoryRequestDigest !== requestDigest) {
    throw workerProtocolError("request_conflict");
  }
  if (!retry) {
    if (scan.inventoryDone) throw workerProtocolError("scan_not_ready");
    const expectedCursor = scan.inventoryCursor ?? null;
    if (expectedCursor !== request.paginationOpts.cursor) {
      throw workerProtocolError("scan_conflict");
    }
    await consumeWorkerMutationRateLimit(ctx, source, now);
  }

  const paginated = await ctx.db
    .query("sourceItems")
    .withIndex("by_sourceAccountId", (q) =>
      q.eq("sourceAccountId", source.account._id),
    )
    .paginate(request.paginationOpts);
  const page = await Promise.all(
    paginated.page.map((item) => inventoryItem(ctx, source, item)),
  );
  if (!retry) {
    await ctx.db.patch(scan._id, {
      inventoryCursor: paginated.continueCursor,
      inventoryDone: paginated.isDone,
      lastInventoryRequestId: request.requestId,
      lastInventoryRequestDigest: requestDigest,
      ...(request.paginationOpts.cursor === null
        ? { lastInventoryInputCursor: undefined }
        : { lastInventoryInputCursor: request.paginationOpts.cursor }),
      lastInventoryOutputCursor: paginated.continueCursor,
      lastInventoryDone: paginated.isDone,
      expiresAt: nowPlus(now, WORKER_SCAN_IDLE_MS),
    });
  }
  return {
    operation: "source.inventoryPage",
    page,
    isDone: paginated.isDone,
    continueCursor: paginated.continueCursor,
  };
}

function scanEntryResult(
  entry: Doc<"workerScanEntries">,
): WorkerScanAppendResult["entries"][number] {
  return {
    state: entry.state,
    ...(entry.sourceItemId === undefined
      ? {}
      : { sourceItemId: entry.sourceItemId }),
    ...(entry.observationEpoch === undefined
      ? {}
      : { observationEpoch: entry.observationEpoch }),
    ...(entry.processingEpoch === undefined
      ? {}
      : { processingEpoch: entry.processingEpoch }),
  };
}

async function externalIdHash(externalId: string): Promise<string> {
  return sha256Utf8(externalId);
}

async function uriDigest(
  sourceAccountId: Id<"sourceAccounts">,
  uri: string,
): Promise<string> {
  return digest("worker-fs-uri:v1", [sourceAccountId, uri]);
}

async function entryDigests(
  sourceAccountId: Id<"sourceAccounts">,
  entry: FsDiscoveryEntry,
): Promise<{
  externalIdHash?: string;
  uriDigest: string;
  identityKeyHash: string;
  inventoryMetadataDigest: string;
  processingIdentityDigest?: string;
}> {
  const extHash =
    entry.externalId === undefined
      ? undefined
      : await externalIdHash(entry.externalId);
  const pathDigest = await uriDigest(sourceAccountId, entry.uri);
  const processingIdentityDigest =
    entry.content.status === "ready"
      ? await digest("worker-fs-processing-identity:v1", [
          entry.content.sha256,
          FS_TEXT_PROFILE.mediaType,
          FS_TEXT_PROFILE.profileId,
          FS_TEXT_PROFILE.extractionFingerprint,
          FS_TEXT_PROFILE.extractorFingerprint,
          FS_TEXT_PROFILE.recordSchemaFingerprint,
          FS_TEXT_PROFILE.normalizationFingerprint,
          FS_TEXT_PROFILE.chunkerFingerprint,
        ])
      : entry.content.status === "ready_binary_v1"
        ? await digest("worker-fs-binary-processing-identity:v1", [
            entry.content.sha256,
            entry.content.mediaType,
            entry.content.parserProfileId,
            entry.content.parserFingerprint,
            entry.content.extractionConfigurationFingerprint,
            entry.content.extractorFingerprint,
            entry.content.recordSchemaFingerprint,
            entry.content.normalizationFingerprint,
            entry.content.chunkerFingerprint,
            entry.content.correctionRevision,
          ])
        : undefined;
  const inventoryMetadataDigest =
    entry.content.status === "ready_binary_v1"
      ? await digest("worker-fs-binary-inventory-metadata:v1", [
          extHash ?? null,
          pathDigest,
          entry.title ?? null,
          entry.docType ?? null,
          entry.sourceModifiedAt,
          entry.content.status,
          entry.content.sha256,
          entry.content.byteLength,
          entry.content.parserProfileId,
        ])
      : await digest("worker-fs-inventory-metadata:v1", [
          extHash ?? null,
          pathDigest,
          entry.title ?? null,
          entry.docType ?? null,
          entry.sourceModifiedAt,
          entry.content.status,
          entry.content.status === "ready" ? entry.content.sha256 : null,
          entry.content.status === "ready" ? entry.content.byteLength : null,
          entry.content.status === "gap" ? entry.content.code : null,
          FS_TEXT_PROFILE.profileId,
        ]);
  return {
    ...(extHash === undefined ? {} : { externalIdHash: extHash }),
    uriDigest: pathDigest,
    identityKeyHash: extHash ?? pathDigest,
    inventoryMetadataDigest,
    ...(processingIdentityDigest === undefined
      ? {}
      : { processingIdentityDigest }),
  };
}

async function aliasMatches(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  pathDigest: string,
): Promise<
  Array<{ alias: Doc<"sourceAliasDigests">; item: Doc<"sourceItems"> }>
> {
  const aliases = await ctx.db
    .query("sourceAliasDigests")
    .withIndex("by_sourceAccountId_and_digest", (q) =>
      q.eq("sourceAccountId", source.account._id).eq("digest", pathDigest),
    )
    .take(MAX_SOURCE_URI_ALIASES + 1);
  const matches = [];
  for (const alias of aliases) {
    const item = await ctx.db.get(alias.sourceItemId);
    if (
      !item ||
      item.spaceId !== source.spaceId ||
      item.sourceAccountId !== source.account._id ||
      alias.spaceId !== source.spaceId
    ) {
      throw workerProtocolError("scan_conflict");
    }
    matches.push({ alias, item });
  }
  return matches;
}

async function itemByExternalIdentity(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  externalId: string,
  extHash: string,
): Promise<Doc<"sourceItems"> | undefined> {
  const matches = await ctx.db
    .query("sourceItems")
    .withIndex("by_sourceAccountId_and_externalIdHash", (q) =>
      q.eq("sourceAccountId", source.account._id).eq("externalIdHash", extHash),
    )
    .take(2);
  if (matches.length > 1) throw workerProtocolError("identity_review_required");
  const item = matches[0];
  if (!item) return undefined;
  if (item.spaceId !== source.spaceId) throw workerProtocolError("not_found");
  if (
    item.lifecycle !== "forgotten" &&
    item.lifecycle !== "forgetting" &&
    item.externalId !== externalId
  ) {
    throw workerProtocolError("identity_review_required");
  }
  return item;
}

async function addOrRefreshAlias(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  item: Doc<"sourceItems">,
  pathDigest: string,
  matches: Awaited<ReturnType<typeof aliasMatches>>,
  now: number,
): Promise<"ok" | "cap_reached"> {
  const same = matches.find((match) => match.item._id === item._id);
  if (same) {
    await ctx.db.patch(same.alias._id, { lastSeenAt: now });
    return "ok";
  }
  const itemAliases = await ctx.db
    .query("sourceAliasDigests")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_SOURCE_URI_ALIASES + 1);
  for (const alias of itemAliases) {
    if (
      alias.spaceId !== source.spaceId ||
      alias.sourceAccountId !== source.account._id ||
      alias.sourceItemId !== item._id
    ) {
      throw workerProtocolError("scan_conflict");
    }
  }
  if (itemAliases.length >= MAX_SOURCE_URI_ALIASES) return "cap_reached";
  await ctx.db.insert("sourceAliasDigests", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    sourceItemId: item._id,
    kind: "uri",
    digest: pathDigest,
    firstSeenAt: now,
    lastSeenAt: now,
  });
  return "ok";
}

async function insertReviewEntry(
  ctx: MutationCtx,
  args: {
    source: LoadedWorkerSource;
    scan: Doc<"workerSourceScans">;
    pageId: Id<"workerScanPages">;
    entry: FsDiscoveryEntry;
    digests: Awaited<ReturnType<typeof entryDigests>>;
    issueCode: string;
    now: number;
    sourceItemId?: Id<"sourceItems">;
    state?: "needs_review" | "ignored_forgotten";
  },
): Promise<Doc<"workerScanEntries">> {
  const state = args.state ?? "needs_review";
  const id = await ctx.db.insert("workerScanEntries", {
    spaceId: args.source.spaceId,
    sourceAccountId: args.source.account._id,
    scanId: args.scan._id,
    scanPageId: args.pageId,
    ...(args.sourceItemId === undefined
      ? {}
      : { sourceItemId: args.sourceItemId }),
    identityKeyHash: args.digests.identityKeyHash,
    ...(args.digests.externalIdHash === undefined
      ? {}
      : { externalIdHash: args.digests.externalIdHash }),
    uriDigest: args.digests.uriDigest,
    inventoryMetadataDigest: args.digests.inventoryMetadataDigest,
    ...(args.digests.processingIdentityDigest === undefined
      ? {}
      : { processingIdentityDigest: args.digests.processingIdentityDigest }),
    ...(isReadyEntry(args.entry)
      ? {
          contentHash: args.entry.content.sha256,
          byteLength: args.entry.content.byteLength,
          contentRepresentation: processingProfile(args.entry).representation,
          ...(args.entry.content.status === "ready_binary_v1"
            ? {
                binaryParserProfileId: args.entry.content.parserProfileId,
                binaryMediaType: args.entry.content.mediaType,
                parserFingerprint: args.entry.content.parserFingerprint,
                extractionConfigurationFingerprint:
                  args.entry.content.extractionConfigurationFingerprint,
                extractorFingerprint: args.entry.content.extractorFingerprint,
                recordSchemaFingerprint:
                  args.entry.content.recordSchemaFingerprint,
                normalizationFingerprint:
                  args.entry.content.normalizationFingerprint,
                chunkerFingerprint: args.entry.content.chunkerFingerprint,
                correctionRevision: args.entry.content.correctionRevision,
              }
            : {}),
        }
      : {}),
    sourceModifiedAt: args.entry.sourceModifiedAt,
    state,
    issueCode: args.issueCode,
    ...(state === "needs_review"
      ? {
          ...(args.entry.externalId === undefined
            ? {}
            : { proposedExternalId: args.entry.externalId }),
          proposedUri: args.entry.uri,
          ...(args.entry.title === undefined
            ? {}
            : { proposedTitle: args.entry.title }),
          ...(args.entry.docType === undefined
            ? {}
            : { proposedDocType: args.entry.docType }),
        }
      : {}),
    observedAt: args.now,
    retireAt: nowPlus(args.now, WORKER_DETAIL_RETENTION_MS),
  });
  const row = await ctx.db.get(id);
  if (!row) throw workerProtocolError("scan_conflict");
  return row;
}

async function currentDiscoveryWork(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  item: Doc<"sourceItems">,
): Promise<Doc<"workerDiscoveryWork"> | undefined> {
  const matches = await ctx.db
    .query("workerDiscoveryWork")
    .withIndex("by_sourceItemId_and_observationEpoch", (q) =>
      q
        .eq("sourceItemId", item._id)
        .eq("observationEpoch", item.workerObservationEpoch ?? 0),
    )
    .take(2);
  if (matches.length > 1) throw workerProtocolError("scan_conflict");
  const work = matches[0];
  if (!work) return undefined;
  if (
    work.spaceId !== source.spaceId ||
    work.sourceAccountId !== source.account._id ||
    work.sourceItemId !== item._id ||
    work.observationEpoch !== (item.workerObservationEpoch ?? 0)
  ) {
    throw workerProtocolError("scan_conflict");
  }
  const [entry, scan] = await Promise.all([
    ctx.db.get(work.scanEntryId),
    ctx.db.get(work.scanId),
  ]);
  const page = entry ? await ctx.db.get(entry.scanPageId) : null;
  if (
    !entry ||
    !scan ||
    !page ||
    entry.spaceId !== work.spaceId ||
    entry.sourceAccountId !== work.sourceAccountId ||
    entry.sourceItemId !== work.sourceItemId ||
    entry.scanId !== work.scanId ||
    entry._id !== work.scanEntryId ||
    entry.discoveryWorkId !== work._id ||
    entry.observationEpoch !== work.observationEpoch ||
    entry.processingEpoch !== work.processingEpoch ||
    entry.contentHash !== work.contentHash ||
    entry.byteLength !== work.byteLength ||
    page.spaceId !== work.spaceId ||
    page.sourceAccountId !== work.sourceAccountId ||
    page.scanId !== work.scanId ||
    page._id !== entry.scanPageId ||
    scan.spaceId !== work.spaceId ||
    scan.sourceAccountId !== work.sourceAccountId ||
    scan._id !== work.scanId
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return work;
}

async function obsoletePriorWork(
  ctx: MutationCtx,
  work: Doc<"workerDiscoveryWork">,
  processingIdentityChanged: boolean,
  now: number,
): Promise<Doc<"ingestJobs"> | undefined> {
  let job: Doc<"ingestJobs"> | undefined;
  let generation: Doc<"processingGenerations"> | undefined;
  if (work.ingestJobId) {
    const loaded = await ctx.db.get(work.ingestJobId);
    if (
      !loaded ||
      loaded.spaceId !== work.spaceId ||
      loaded.sourceAccountId !== work.sourceAccountId ||
      loaded.sourceItemId !== work.sourceItemId ||
      work.sourceRevisionId === undefined ||
      loaded.sourceRevisionId !== work.sourceRevisionId ||
      work.processingGenerationId === undefined ||
      loaded.processingGenerationId !== work.processingGenerationId ||
      loaded.workerDiscoveryWorkId !== work._id ||
      loaded.workerObservationEpoch !== work.observationEpoch
    ) {
      throw workerProtocolError("scan_conflict");
    }
    job = loaded;
    const [revision, loadedGeneration] = await Promise.all([
      ctx.db.get(loaded.sourceRevisionId),
      ctx.db.get(loaded.processingGenerationId),
    ]);
    if (
      !revision ||
      !loadedGeneration ||
      revision.spaceId !== work.spaceId ||
      revision.sourceItemId !== work.sourceItemId ||
      loadedGeneration.spaceId !== work.spaceId ||
      loadedGeneration.sourceAccountId !== work.sourceAccountId ||
      loadedGeneration.sourceItemId !== work.sourceItemId ||
      loadedGeneration.sourceRevisionId !== revision._id ||
      loadedGeneration.state !== loaded.state
    ) {
      throw workerProtocolError("scan_conflict");
    }
    generation = loadedGeneration;
  }
  await ctx.db.patch(work._id, {
    state: "obsolete",
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
  });
  if (job && !processingIdentityChanged && job.state !== "ready") {
    const nextState = job.state === "processing" ? "queued" : job.state;
    await ctx.db.patch(job._id, {
      state: nextState,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      workerLeaseOwnerCredentialId: undefined,
      ...(nextState === "queued" ? { nextAttemptAt: now } : {}),
    });
    if (job.state === "processing") {
      if (!generation) throw workerProtocolError("scan_conflict");
      await ctx.db.patch(generation._id, { state: "queued" });
    }
  } else if (job && processingIdentityChanged && job.state !== "ready") {
    if (!generation) throw workerProtocolError("scan_conflict");
    await ctx.db.patch(job._id, {
      state: "obsolete_generation",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      workerLeaseOwnerCredentialId: undefined,
      nextAttemptAt: undefined,
    });
    await ctx.db.patch(generation._id, { state: "obsolete_generation" });
  }
  return job;
}

async function createDiscoveryWork(
  ctx: MutationCtx,
  args: {
    source: LoadedWorkerSource;
    item: Doc<"sourceItems">;
    scanId: Id<"workerSourceScans">;
    scanEntryId: Id<"workerScanEntries">;
    entry: FsReadyDiscoveryEntry;
    observationEpoch: number;
    processingEpoch: number;
    processingIdentityChanged: boolean;
    priorWork?: Doc<"workerDiscoveryWork">;
    now: number;
  },
): Promise<Doc<"workerDiscoveryWork"> | undefined> {
  const profile = processingProfile(args.entry);
  let priorJob: Doc<"ingestJobs"> | undefined;
  if (args.priorWork) {
    priorJob = await obsoletePriorWork(
      ctx,
      args.priorWork,
      args.processingIdentityChanged,
      args.now,
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
  const id = await ctx.db.insert("workerDiscoveryWork", {
    spaceId: args.source.spaceId,
    sourceAccountId: args.source.account._id,
    sourceItemId: args.item._id,
    scanId: args.scanId,
    scanEntryId: args.scanEntryId,
    observationEpoch: args.observationEpoch,
    processingEpoch: args.processingEpoch,
    ...(rebindJob
      ? args.priorWork?.expectedDesiredProcessingEpoch === undefined
        ? {}
        : {
            expectedDesiredProcessingEpoch:
              args.priorWork.expectedDesiredProcessingEpoch,
          }
      : { expectedDesiredProcessingEpoch: args.item.desiredProcessingEpoch }),
    state: rebindJob ? "admitted" : "queued",
    contentHash: args.entry.content.sha256,
    byteLength: args.entry.content.byteLength,
    capturedAt: args.now,
    sourceModifiedAt: args.entry.sourceModifiedAt,
    mediaType: profile.mediaType,
    profileId: profile.profileId,
    contentRepresentation: profile.representation,
    ...(profile.parserFingerprint === undefined
      ? {}
      : { parserFingerprint: profile.parserFingerprint }),
    ...(profile.extractionConfigurationFingerprint === undefined
      ? {}
      : {
          extractionConfigurationFingerprint:
            profile.extractionConfigurationFingerprint,
        }),
    ...(profile.correctionRevision === undefined
      ? {}
      : { correctionRevision: profile.correctionRevision }),
    extractionFingerprint: profile.extractionFingerprint,
    extractorFingerprint: profile.extractorFingerprint,
    recordSchemaFingerprint: profile.recordSchemaFingerprint,
    normalizationFingerprint: profile.normalizationFingerprint,
    chunkerFingerprint: profile.chunkerFingerprint,
    ...(args.entry.title === undefined ? {} : { title: args.entry.title }),
    ...(args.entry.docType === undefined
      ? {}
      : { docType: args.entry.docType }),
    uri: args.entry.uri,
    actorUserId: rebindJob
      ? args.priorWork!.actorUserId
      : args.source.principal.userId,
    actorCredentialId: rebindJob
      ? args.priorWork!.actorCredentialId
      : args.source.principal.credentialId,
    attempts: 0,
    leaseEpoch: 0,
    nextAttemptAt: args.now,
    ...(rebindJob && args.priorWork?.ingestRequestId
      ? { ingestRequestId: args.priorWork.ingestRequestId }
      : {}),
    ...(rebindJob && priorJob ? { ingestJobId: priorJob._id } : {}),
    ...(rebindJob && args.priorWork?.sourceRevisionId
      ? { sourceRevisionId: args.priorWork.sourceRevisionId }
      : {}),
    ...(rebindJob && args.priorWork?.processingGenerationId
      ? { processingGenerationId: args.priorWork.processingGenerationId }
      : {}),
    createdAt: args.now,
    retireAt: nowPlus(args.now, WORKER_DETAIL_RETENTION_MS),
  });
  if (rebindJob && priorJob) {
    const nextState =
      priorJob.state === "processing" ? "queued" : priorJob.state;
    await ctx.db.patch(priorJob._id, {
      workerManaged: true,
      workerDiscoveryWorkId: id,
      workerObservationEpoch: args.observationEpoch,
      state: nextState,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      workerLeaseOwnerCredentialId: undefined,
      ...(nextState === "queued" ? { nextAttemptAt: args.now } : {}),
    });
    if (priorJob.state === "processing") {
      await ctx.db.patch(priorJob.processingGenerationId, { state: "queued" });
    }
  }
  const work = await ctx.db.get(id);
  if (!work) throw workerProtocolError("scan_conflict");
  return work;
}

async function persistResolvedEntry(
  ctx: MutationCtx,
  args: {
    source: LoadedWorkerSource;
    scan: Doc<"workerSourceScans">;
    pageId: Id<"workerScanPages">;
    item: Doc<"sourceItems">;
    entry: FsDiscoveryEntry;
    digests: Awaited<ReturnType<typeof entryDigests>>;
    now: number;
  },
): Promise<{ row: Doc<"workerScanEntries">; manifestChanged: boolean }> {
  const [currentWorkBeforeObservation, activeGeneration] = await Promise.all([
    currentDiscoveryWork(ctx, args.source, args.item),
    args.item.activeGenerationId
      ? ctx.db.get(args.item.activeGenerationId)
      : Promise.resolve(null),
  ]);
  const activeRevision = activeGeneration
    ? await ctx.db.get(activeGeneration.sourceRevisionId)
    : null;
  const activeParserArtifact = activeGeneration?.parserArtifactId
    ? await ctx.db.get(activeGeneration.parserArtifactId)
    : null;
  if (
    activeGeneration &&
    (activeGeneration.spaceId !== args.source.spaceId ||
      activeGeneration.sourceAccountId !== args.source.account._id ||
      activeGeneration.sourceItemId !== args.item._id ||
      args.item.activeRevisionId !== activeGeneration.sourceRevisionId ||
      !activeRevision ||
      activeRevision.spaceId !== args.source.spaceId ||
      activeRevision.sourceItemId !== args.item._id ||
      activeRevision._id !== activeGeneration.sourceRevisionId)
  ) {
    throw workerProtocolError("scan_conflict");
  }
  const inventoryChanged =
    args.item.workerInventoryMetadataDigest !==
    args.digests.inventoryMetadataDigest;
  const resumesInterruptedDesiredProcessing =
    isReadyEntry(args.entry) &&
    args.item.desiredRevisionId !== undefined &&
    currentWorkBeforeObservation === undefined &&
    (activeGeneration === null ||
      activeGeneration.state !== "ready" ||
      activeGeneration.sourceRevisionId !== args.item.desiredRevisionId ||
      activeGeneration.desiredProcessingEpoch !==
        args.item.desiredProcessingEpoch);
  const processingIdentityChanged =
    isReadyEntry(args.entry) &&
    (args.item.workerProcessingIdentityDigest !==
      args.digests.processingIdentityDigest ||
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
    throw workerProtocolError("scan_conflict");
  }

  const wasUnavailable = args.item.lifecycle === "unavailable";
  await refreshAvailableSourceItem(ctx, {
    spaceId: args.source.spaceId,
    sourceItemId: args.item._id,
    title: args.entry.title,
    docType: args.entry.docType,
    uri: args.entry.uri,
  });
  await ctx.db.patch(args.item._id, {
    workerObservationEpoch: observationEpoch,
    workerProcessingEpoch: processingEpoch,
    workerInventoryMetadataDigest: args.digests.inventoryMetadataDigest,
    ...(isReadyEntry(args.entry)
      ? {
          workerProcessingIdentityDigest: args.digests.processingIdentityDigest,
          workerContentHash: args.entry.content.sha256,
          workerProfileId: processingProfile(args.entry).profileId,
        }
      : {}),
    workerSourceModifiedAt: args.entry.sourceModifiedAt,
    workerLastSeenInventoryEpoch: args.scan.inventoryEpoch,
  });

  let priorWork = currentWorkBeforeObservation;
  if (!priorWork && resumesInterruptedDesiredProcessing) {
    const desiredJobs = await ctx.db
      .query("ingestJobs")
      .withIndex("by_sourceItemId_and_desiredProcessingEpoch", (q) =>
        q
          .eq("sourceItemId", args.item._id)
          .eq("desiredProcessingEpoch", args.item.desiredProcessingEpoch),
      )
      .take(2);
    if (desiredJobs.length !== 1) throw workerProtocolError("scan_conflict");
    const desiredJob = desiredJobs[0]!;
    if (
      desiredJob.spaceId !== args.source.spaceId ||
      desiredJob.sourceAccountId !== args.source.account._id ||
      desiredJob.sourceItemId !== args.item._id ||
      desiredJob.sourceRevisionId !== args.item.desiredRevisionId ||
      desiredJob.workerManaged !== true ||
      desiredJob.workerDiscoveryWorkId === undefined
    ) {
      throw workerProtocolError("scan_conflict");
    }
    const [candidate, candidateGeneration, candidateRevision] =
      await Promise.all([
        ctx.db.get(desiredJob.workerDiscoveryWorkId),
        ctx.db.get(desiredJob.processingGenerationId),
        ctx.db.get(desiredJob.sourceRevisionId),
      ]);
    const candidateArtifact = candidateGeneration?.parserArtifactId
      ? await ctx.db.get(candidateGeneration.parserArtifactId)
      : null;
    const candidateBinary =
      candidate?.contentRepresentation === "archived_binary_v1";
    const candidateExtractionFingerprint = candidateBinary
      ? candidate &&
        candidateGeneration &&
        candidateArtifact &&
        candidate.parserFingerprint &&
        candidate.extractionConfigurationFingerprint
        ? await digest("kith-parsed-extraction:v1", [
            candidate.parserFingerprint,
            candidateArtifact.outputHash,
            candidate.extractionConfigurationFingerprint,
          ])
        : undefined
      : candidate?.extractionFingerprint;
    const candidateCorrectionRevision = candidateBinary
      ? candidate?.correctionRevision
      : candidate
        ? `filesystem-observation-v1:${candidate.processingEpoch}`
        : undefined;
    if (
      !candidate ||
      !candidateGeneration ||
      !candidateRevision ||
      candidate.spaceId !== args.source.spaceId ||
      candidate.sourceAccountId !== args.source.account._id ||
      candidate.sourceItemId !== args.item._id ||
      candidate.state !== "obsolete" ||
      candidate.ingestJobId !== desiredJob._id ||
      candidate.sourceRevisionId !== args.item.desiredRevisionId ||
      candidate.processingGenerationId !== candidateGeneration._id ||
      candidate.expectedDesiredProcessingEpoch === undefined ||
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
      candidateRevision.spaceId !== candidate.spaceId ||
      candidateRevision.sourceItemId !== candidate.sourceItemId ||
      candidateRevision.contentHash !== candidate.contentHash ||
      candidateRevision.byteLength !== candidate.byteLength ||
      candidateRevision.mediaType !== candidate.mediaType ||
      (candidateBinary &&
        (!candidateArtifact ||
          candidateArtifact.spaceId !== candidate.spaceId ||
          candidateArtifact.sourceAccountId !== candidate.sourceAccountId ||
          candidateArtifact.sourceItemId !== candidate.sourceItemId ||
          candidateArtifact.sourceRevisionId !== candidateRevision._id ||
          candidateArtifact._id !== candidateGeneration.parserArtifactId ||
          candidateArtifact.parserFingerprint !==
            candidate.parserFingerprint)) ||
      candidateGeneration.spaceId !== candidate.spaceId ||
      candidateGeneration.sourceAccountId !== candidate.sourceAccountId ||
      candidateGeneration.sourceItemId !== candidate.sourceItemId ||
      candidateGeneration.sourceRevisionId !== candidateRevision._id ||
      candidateGeneration.desiredProcessingEpoch !==
        desiredJob.desiredProcessingEpoch ||
      candidateGeneration.state !== desiredJob.state ||
      candidateGeneration.extractionFingerprint !==
        candidateExtractionFingerprint ||
      candidateGeneration.extractorFingerprint !==
        candidate.extractorFingerprint ||
      candidateGeneration.recordSchemaFingerprint !==
        candidate.recordSchemaFingerprint ||
      candidateGeneration.normalizationFingerprint !==
        candidate.normalizationFingerprint ||
      candidateGeneration.chunkerFingerprint !== candidate.chunkerFingerprint ||
      candidateGeneration.correctionRevision !== candidateCorrectionRevision ||
      candidateGeneration.processingFingerprint !==
        (await digestProcessingConfiguration({
          extractionFingerprint: candidateExtractionFingerprint!,
          extractorFingerprint: candidate.extractorFingerprint,
          recordSchemaFingerprint: candidate.recordSchemaFingerprint,
          normalizationFingerprint: candidate.normalizationFingerprint,
          chunkerFingerprint: candidate.chunkerFingerprint,
          correctionRevision: candidateCorrectionRevision!,
        }))
    ) {
      throw workerProtocolError("scan_conflict");
    }
    const [candidateEntry, candidateScan] = await Promise.all([
      ctx.db.get(candidate.scanEntryId),
      ctx.db.get(candidate.scanId),
    ]);
    const candidatePage = candidateEntry
      ? await ctx.db.get(candidateEntry.scanPageId)
      : null;
    if (
      !candidateEntry ||
      !candidateScan ||
      !candidatePage ||
      candidateEntry.spaceId !== candidate.spaceId ||
      candidateEntry.sourceAccountId !== candidate.sourceAccountId ||
      candidateEntry.sourceItemId !== candidate.sourceItemId ||
      candidateEntry.scanId !== candidate.scanId ||
      candidateEntry.discoveryWorkId !== candidate._id ||
      candidateEntry.observationEpoch !== candidate.observationEpoch ||
      candidateEntry.processingEpoch !== candidate.processingEpoch ||
      candidateEntry.contentHash !== candidate.contentHash ||
      candidateEntry.byteLength !== candidate.byteLength ||
      candidatePage.spaceId !== candidate.spaceId ||
      candidatePage.sourceAccountId !== candidate.sourceAccountId ||
      candidatePage.scanId !== candidate.scanId ||
      candidatePage._id !== candidateEntry.scanPageId ||
      candidateScan.spaceId !== candidate.spaceId ||
      candidateScan.sourceAccountId !== candidate.sourceAccountId ||
      candidateScan._id !== candidate.scanId
    ) {
      throw workerProtocolError("scan_conflict");
    }
    priorWork = candidate;
  }
  const profile = isReadyEntry(args.entry)
    ? processingProfile(args.entry)
    : undefined;
  const activeExtractionMatches =
    profile?.representation === "archived_binary_v1"
      ? activeGeneration !== null &&
        activeRevision !== null &&
        activeParserArtifact !== null &&
        activeParserArtifact.spaceId === args.source.spaceId &&
        activeParserArtifact.sourceAccountId === args.source.account._id &&
        activeParserArtifact.sourceItemId === args.item._id &&
        activeParserArtifact.sourceRevisionId === activeRevision._id &&
        activeParserArtifact._id === activeGeneration.parserArtifactId &&
        activeParserArtifact.parserFingerprint === profile.parserFingerprint &&
        activeGeneration.extractionFingerprint ===
          (await digest("kith-parsed-extraction:v1", [
            profile.parserFingerprint,
            activeParserArtifact.outputHash,
            profile.extractionConfigurationFingerprint,
          ])) &&
        activeGeneration.correctionRevision === profile.correctionRevision
      : activeGeneration?.extractionFingerprint ===
        profile?.extractionFingerprint;
  const alreadyReady =
    isReadyEntry(args.entry) &&
    activeGeneration !== null &&
    activeRevision !== null &&
    activeGeneration.state === "ready" &&
    activeGeneration.sourceRevisionId === args.item.desiredRevisionId &&
    activeGeneration.desiredProcessingEpoch ===
      args.item.desiredProcessingEpoch &&
    activeRevision.contentHash === args.entry.content.sha256 &&
    activeRevision.byteLength === args.entry.content.byteLength &&
    activeRevision.mediaType === profile?.mediaType &&
    activeExtractionMatches &&
    activeGeneration.extractorFingerprint === profile?.extractorFingerprint &&
    activeGeneration.recordSchemaFingerprint ===
      profile?.recordSchemaFingerprint &&
    activeGeneration.normalizationFingerprint ===
      profile?.normalizationFingerprint &&
    activeGeneration.chunkerFingerprint === profile?.chunkerFingerprint;
  // P2-80f: a scan entry `needs_review` means identity review only, which is
  // what the pipeline's `identity_review_required` code and its
  // `identity_recovery` mode exist for. A processing failure is not an
  // identity question, so it never produces one: a still-retryable failure
  // re-queues (`reserveArchivedDiscovery` already reclaims a `failed` row
  // while `retryable`), and an exhausted one settles as `unchanged` with its
  // `failed` work row left in place as the record of the failure. Reporting a
  // settled failure as `needs_review` instead put the source in a permanent
  // loop: every normal pass sealed `needs_review`, the next pass ran in
  // `identity_recovery`, requeued the same deterministic failures, and the
  // pass after that repeated it. `requeueFailedDiscoveryWork` remains the way
  // to re-attempt an exhausted row.
  const settledFailure =
    !alreadyReady &&
    !inventoryChanged &&
    priorWork !== undefined &&
    priorWork.state === "failed" &&
    priorWork.retryable !== true;
  const entryState =
    args.entry.content.status === "gap"
      ? "gap"
      : alreadyReady || settledFailure
        ? "unchanged"
        : !inventoryChanged && priorWork && priorWork.state === "needs_review"
          ? "needs_review"
          : "queued";
  const id = await ctx.db.insert("workerScanEntries", {
    spaceId: args.source.spaceId,
    sourceAccountId: args.source.account._id,
    scanId: args.scan._id,
    scanPageId: args.pageId,
    sourceItemId: args.item._id,
    identityKeyHash: args.digests.identityKeyHash,
    ...(args.digests.externalIdHash === undefined
      ? {}
      : { externalIdHash: args.digests.externalIdHash }),
    uriDigest: args.digests.uriDigest,
    inventoryMetadataDigest: args.digests.inventoryMetadataDigest,
    ...(args.digests.processingIdentityDigest === undefined
      ? {}
      : { processingIdentityDigest: args.digests.processingIdentityDigest }),
    ...(isReadyEntry(args.entry)
      ? {
          contentHash: args.entry.content.sha256,
          byteLength: args.entry.content.byteLength,
          contentRepresentation: processingProfile(args.entry).representation,
          ...(args.entry.content.status === "ready_binary_v1"
            ? {
                binaryParserProfileId: args.entry.content.parserProfileId,
                binaryMediaType: args.entry.content.mediaType,
                parserFingerprint: args.entry.content.parserFingerprint,
                extractionConfigurationFingerprint:
                  args.entry.content.extractionConfigurationFingerprint,
                extractorFingerprint: args.entry.content.extractorFingerprint,
                recordSchemaFingerprint:
                  args.entry.content.recordSchemaFingerprint,
                normalizationFingerprint:
                  args.entry.content.normalizationFingerprint,
                chunkerFingerprint: args.entry.content.chunkerFingerprint,
                correctionRevision: args.entry.content.correctionRevision,
              }
            : {}),
        }
      : {}),
    sourceModifiedAt: args.entry.sourceModifiedAt,
    observationEpoch,
    processingEpoch,
    state: entryState,
    ...(args.entry.content.status === "gap"
      ? { issueCode: args.entry.content.code }
      : {}),
    observedAt: args.now,
    retireAt: nowPlus(args.now, WORKER_DETAIL_RETENTION_MS),
  });
  let work: Doc<"workerDiscoveryWork"> | undefined;
  if (
    isReadyEntry(args.entry) &&
    entryState === "queued" &&
    (processingIdentityChanged ||
      inventoryChanged ||
      !priorWork ||
      priorWork.state === "obsolete")
  ) {
    work = await createDiscoveryWork(ctx, {
      source: args.source,
      item: args.item,
      scanId: args.scan._id,
      scanEntryId: id,
      entry: args.entry as FsReadyDiscoveryEntry,
      observationEpoch,
      processingEpoch,
      processingIdentityChanged,
      priorWork,
      now: args.now,
    });
    if (!work) await ctx.db.patch(id, { state: "unchanged" });
  } else if (priorWork && (entryState === "queued" || settledFailure)) {
    // A settled failure keeps its `failed` work row and rebinds it to this
    // scan, so the entry still points at the failure and the row's retention
    // window is refreshed rather than leaving a stale chain behind.
    if (priorWork.scanId !== args.scan._id || priorWork.scanEntryId !== id) {
      await ctx.db.patch(priorWork._id, {
        scanId: args.scan._id,
        scanEntryId: id,
        retireAt: nowPlus(args.now, WORKER_DETAIL_RETENTION_MS),
      });
      const rebound = await ctx.db.get(priorWork._id);
      if (!rebound) throw workerProtocolError("scan_conflict");
      work = rebound;
    } else {
      work = priorWork;
    }
  }
  if (priorWork && entryState === "unchanged" && !settledFailure) {
    await obsoletePriorWork(ctx, priorWork, false, args.now);
  } else if (inventoryChanged && priorWork && entryState !== "queued") {
    await obsoletePriorWork(
      ctx,
      priorWork,
      processingIdentityChanged,
      args.now,
    );
  }
  if (work) await ctx.db.patch(id, { discoveryWorkId: work._id });
  const row = await ctx.db.get(id);
  if (!row) throw workerProtocolError("scan_conflict");
  return {
    row,
    manifestChanged: inventoryChanged || wasUnavailable,
  };
}

async function resolveAndPersistEntry(
  ctx: MutationCtx,
  args: {
    source: LoadedWorkerSource;
    scan: Doc<"workerSourceScans">;
    pageId: Id<"workerScanPages">;
    entry: FsDiscoveryEntry;
    now: number;
  },
): Promise<{ row: Doc<"workerScanEntries">; manifestChanged: boolean }> {
  let resolvedEntry = args.entry;
  let digests = await entryDigests(args.source.account._id, resolvedEntry);
  const duplicate = await ctx.db
    .query("workerScanEntries")
    .withIndex("by_scanId_and_identityKeyHash", (q) =>
      q
        .eq("scanId", args.scan._id)
        .eq("identityKeyHash", digests.identityKeyHash),
    )
    .take(1);
  if (duplicate[0]) {
    return {
      row: await insertReviewEntry(ctx, {
        ...args,
        digests,
        issueCode: "duplicate_scan_identity",
      }),
      manifestChanged: false,
    };
  }

  const aliases = await aliasMatches(ctx, args.source, digests.uriDigest);
  const liveAliasItems = new Map<string, Doc<"sourceItems">>();
  let hasForgottenAlias = false;
  for (const match of aliases) {
    if (
      match.item.lifecycle === "forgotten" ||
      match.item.lifecycle === "forgetting"
    ) {
      hasForgottenAlias = true;
    } else {
      liveAliasItems.set(match.item._id, match.item);
    }
  }
  if (
    liveAliasItems.size > 1 ||
    (liveAliasItems.size > 0 && hasForgottenAlias)
  ) {
    return {
      row: await insertReviewEntry(ctx, {
        ...args,
        digests,
        issueCode: "ambiguous_uri_alias",
      }),
      manifestChanged: false,
    };
  }

  let item: Doc<"sourceItems"> | undefined;
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
      return {
        row: await insertReviewEntry(ctx, {
          ...args,
          digests,
          issueCode: "forgotten_identity",
          sourceItemId: item._id,
          state: "ignored_forgotten",
        }),
        manifestChanged: false,
      };
    }
    const aliasedItem = liveAliasItems.values().next().value as
      Doc<"sourceItems"> | undefined;
    if (aliasedItem && (!item || aliasedItem._id !== item._id)) {
      return {
        row: await insertReviewEntry(ctx, {
          ...args,
          digests,
          issueCode: "uri_alias_identity_conflict",
          ...(item === undefined ? {} : { sourceItemId: item._id }),
        }),
        manifestChanged: false,
      };
    }
    if (!item && hasForgottenAlias) {
      return {
        row: await insertReviewEntry(ctx, {
          ...args,
          digests,
          issueCode: "forgotten_uri_alias",
          state: "ignored_forgotten",
        }),
        manifestChanged: false,
      };
    }
    if (!item) {
      if (args.scan.mode === "identity_recovery") {
        return {
          row: await insertReviewEntry(ctx, {
            ...args,
            digests,
            issueCode: "unmatched_recovery_identity",
          }),
          manifestChanged: false,
        };
      }
      item = await createOrGetSourceItem(ctx, {
        spaceId: args.source.spaceId,
        sourceAccountId: args.source.account._id,
        externalId: args.entry.externalId,
        title: args.entry.title,
        docType: args.entry.docType,
        uri: args.entry.uri,
      });
    }
  } else {
    if (args.scan.mode !== "identity_recovery") {
      throw workerProtocolError("invalid_request");
    }
    if (hasForgottenAlias && liveAliasItems.size === 0) {
      return {
        row: await insertReviewEntry(ctx, {
          ...args,
          digests,
          issueCode: "forgotten_uri_alias",
          state: "ignored_forgotten",
        }),
        manifestChanged: false,
      };
    }
    if (liveAliasItems.size !== 1) {
      return {
        row: await insertReviewEntry(ctx, {
          ...args,
          digests,
          issueCode: "unmatched_recovery_identity",
        }),
        manifestChanged: false,
      };
    }
    item = liveAliasItems.values().next().value as Doc<"sourceItems">;
    if (!item.externalId) throw workerProtocolError("scan_conflict");
    resolvedEntry = { ...args.entry, externalId: item.externalId };
    digests = await entryDigests(args.source.account._id, resolvedEntry);
    const resolvedDuplicate = await ctx.db
      .query("workerScanEntries")
      .withIndex("by_scanId_and_identityKeyHash", (q) =>
        q
          .eq("scanId", args.scan._id)
          .eq("identityKeyHash", digests.identityKeyHash),
      )
      .take(1);
    if (resolvedDuplicate[0]) {
      return {
        row: await insertReviewEntry(ctx, {
          ...args,
          digests,
          issueCode: "duplicate_scan_identity",
        }),
        manifestChanged: false,
      };
    }
  }

  const alias = await addOrRefreshAlias(
    ctx,
    args.source,
    item,
    digests.uriDigest,
    aliases,
    args.now,
  );
  if (alias === "cap_reached") {
    return {
      row: await insertReviewEntry(ctx, {
        ...args,
        digests,
        issueCode: "uri_alias_limit",
        sourceItemId: item._id,
      }),
      manifestChanged: false,
    };
  }
  return persistResolvedEntry(ctx, {
    ...args,
    entry: resolvedEntry,
    item,
    digests,
  });
}

export async function appendWorkerScanPage(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "scan.appendPage" }>,
  now: number,
): Promise<WorkerScanAppendResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  // P2-70i2: the gate is per class. Every binary entry in this page must name
  // a class this account is audited for, so enabling workbooks is an explicit
  // owner decision and not a side effect of the PDF lane being open.
  if (
    request.entries.some(
      (entry) =>
        entry.content.status === "ready_binary_v1" &&
        (!accountAdmitsBinaryClass(
          source.account,
          entry.content.parserProfileId,
        ) ||
          source.account.binaryProfileEnabledAt === undefined ||
          !Number.isSafeInteger(source.account.binaryProfileEnabledAt) ||
          source.account.binaryProfileEnabledAt < 0 ||
          source.account.binaryProfileAuditDigest === undefined ||
          !/^[0-9a-f]{64}$/.test(source.account.binaryProfileAuditDigest)),
    )
  ) {
    throw workerProtocolError("source_unavailable");
  }
  const scan = await loadScan(ctx, source, request.scanId);
  const requestDigest = await digest("worker-scan-page:v1", [
    source.account._id,
    scan._id,
    request.requestId,
    request.ordinal,
    request.entries,
  ]);
  const priorByRequest = await ctx.db
    .query("workerScanPages")
    .withIndex("by_scanId_and_requestId", (q) =>
      q.eq("scanId", scan._id).eq("requestId", request.requestId),
    )
    .take(2);
  if (priorByRequest.length > 1) throw workerProtocolError("scan_conflict");
  if (priorByRequest[0]) {
    const page = priorByRequest[0];
    if (
      page.spaceId !== source.spaceId ||
      page.sourceAccountId !== source.account._id ||
      page.scanId !== scan._id ||
      page.redactedAt !== undefined ||
      page.requestDigest === undefined ||
      page.requestDigest !== requestDigest ||
      page.ordinal !== request.ordinal
    ) {
      throw workerProtocolError("request_conflict");
    }
    const entries = await ctx.db
      .query("workerScanEntries")
      .withIndex("by_scanPageId", (q) => q.eq("scanPageId", page._id))
      .collect();
    if (entries.length !== page.entryCount) {
      throw workerProtocolError("scan_conflict");
    }
    for (const entry of entries) {
      if (
        entry.spaceId !== source.spaceId ||
        entry.sourceAccountId !== source.account._id ||
        entry.scanId !== scan._id ||
        entry.scanPageId !== page._id
      ) {
        throw workerProtocolError("scan_conflict");
      }
    }
    return {
      operation: "scan.appendPage",
      scanId: scan._id,
      ordinal: page.ordinal,
      reused: true,
      entries: entries.map(scanEntryResult),
    };
  }
  if (
    scan.state !== "open" ||
    scan.expiresAt <= now ||
    source.account.activeWorkerScanId !== scan._id ||
    (scan.mode === "identity_recovery" && !scan.inventoryDone)
  ) {
    throw workerProtocolError("scan_not_ready");
  }
  if (scan.nextPageOrdinal !== request.ordinal) {
    throw workerProtocolError("scan_conflict");
  }
  const priorOrdinal = await ctx.db
    .query("workerScanPages")
    .withIndex("by_scanId_and_ordinal", (q) =>
      q.eq("scanId", scan._id).eq("ordinal", request.ordinal),
    )
    .take(1);
  if (priorOrdinal[0]) throw workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(ctx, source, now);

  const pageId = await ctx.db.insert("workerScanPages", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    scanId: scan._id,
    ordinal: request.ordinal,
    requestId: request.requestId,
    requestDigest,
    entryCount: request.entries.length,
    createdAt: now,
    retireAt: nowPlus(now, WORKER_DETAIL_RETENTION_MS),
  });
  const persisted = [];
  let manifestChanged = false;
  for (const entry of request.entries) {
    const result = await resolveAndPersistEntry(ctx, {
      source,
      scan,
      pageId,
      entry,
      now,
    });
    persisted.push(result.row);
    manifestChanged ||= result.manifestChanged;
    // Additive: one durable sourceInventory row per admitted file, keyed by
    // identity rather than by scan. Never changes admission or which files
    // are processed. See docs/plans/2026-09-12-document-cards.md section 2.
    await upsertSourceInventoryRow(ctx, {
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      scanId: scan._id,
      entry,
      scanEntry: result.row,
    });
  }
  const gapCount = persisted.filter((entry) => entry.state === "gap").length;
  const reviewCount = persisted.filter(
    (entry) => entry.state === "needs_review",
  ).length;
  const changedCount = persisted.filter(
    (entry) => entry.state === "queued",
  ).length;
  await ctx.db.patch(scan._id, {
    nextPageOrdinal: scan.nextPageOrdinal + 1,
    pageCount: scan.pageCount + 1,
    entryCount: scan.entryCount + persisted.length,
    changedCount: scan.changedCount + changedCount,
    gapCount: scan.gapCount + gapCount,
    reviewCount: scan.reviewCount + reviewCount,
    expiresAt: nowPlus(now, WORKER_SCAN_IDLE_MS),
  });
  if (manifestChanged) {
    await ctx.db.patch(source.account._id, {
      manifestVersion: (source.account.manifestVersion ?? 0) + 1,
    });
    await invalidateCoverage(ctx, source.account, now);
  }
  if (gapCount > 0 || reviewCount > 0) {
    await invalidateCoverage(ctx, source.account, now);
  }
  return {
    operation: "scan.appendPage",
    scanId: scan._id,
    ordinal: request.ordinal,
    reused: false,
    entries: persisted.map(scanEntryResult),
  };
}

export async function sealWorkerScan(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "scan.seal" }>,
  now: number,
): Promise<WorkerScanSealResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const scan = await loadScan(ctx, source, request.scanId);
  const requestDigest = await digest("worker-scan-seal:v1", [
    source.account._id,
    scan._id,
    request.requestId,
    request.expectedPageCount,
    request.health,
  ]);
  if (scan.sealRequestId === request.requestId) {
    if (scan.sealRequestDigest !== requestDigest) {
      throw workerProtocolError("request_conflict");
    }
    if (
      scan.state !== "sealed" &&
      scan.state !== "reconciling" &&
      scan.state !== "enumerated" &&
      scan.state !== "needs_review" &&
      scan.state !== "failed"
    ) {
      throw workerProtocolError("scan_conflict");
    }
    const state =
      scan.state === "reconciling" || scan.state === "enumerated"
        ? "sealed"
        : scan.state;
    return {
      operation: "scan.seal",
      scanId: scan._id,
      state,
      reused: true,
    };
  }
  if (
    scan.state !== "open" ||
    scan.expiresAt <= now ||
    source.account.activeWorkerScanId !== scan._id ||
    (scan.mode === "identity_recovery" && !scan.inventoryDone)
  ) {
    throw workerProtocolError("scan_not_ready");
  }
  if (
    request.expectedPageCount !== scan.pageCount ||
    request.expectedPageCount !== scan.nextPageOrdinal
  ) {
    throw workerProtocolError("scan_conflict");
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);

  let state: "sealed" | "needs_review" | "failed";
  if (request.health.status === "failed") state = "failed";
  else if (scan.reviewCount > 0) state = "needs_review";
  else state = "sealed";
  const manifestVersion = source.account.manifestVersion ?? 0;
  await ctx.db.patch(scan._id, {
    state,
    sealRequestId: request.requestId,
    sealRequestDigest: requestDigest,
    manifestVersionAtSeal: manifestVersion,
    reconcileManifestVersion: manifestVersion,
    sealedAt: now,
    ...(state === "sealed" ? {} : { completedAt: now }),
    ...(request.health.status === "failed"
      ? { failureCode: request.health.code }
      : {}),
    expiresAt: nowPlus(now, WORKER_SCAN_IDLE_MS),
    retireAt: nowPlus(now, WORKER_SCAN_RETENTION_MS),
  });
  await invalidateCoverage(ctx, source.account, now);
  if (state !== "sealed") {
    await ctx.db.patch(source.account._id, { activeWorkerScanId: undefined });
  }
  return {
    operation: "scan.seal",
    scanId: scan._id,
    state,
    reused: false,
  };
}

export async function reconcileWorkerScan(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "scan.reconcile" }>,
  now: number,
): Promise<WorkerScanReconcileResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const scan = await loadScan(ctx, source, request.scanId);
  const requestDigest = await digest("worker-scan-reconcile:v1", [
    source.account._id,
    scan._id,
    request.requestId,
    request.expectedInventoryEpoch,
    request.ordinal,
    request.maxItems,
  ]);
  if (scan.lastReconcileRequestId === request.requestId) {
    if (
      scan.lastReconcileRequestDigest !== requestDigest ||
      !scan.lastReconcileResult
    ) {
      throw workerProtocolError("request_conflict");
    }
    return {
      operation: "scan.reconcile",
      scanId: scan._id,
      ...scan.lastReconcileResult,
      reused: true,
    };
  }
  if (
    (scan.state !== "sealed" && scan.state !== "reconciling") ||
    scan.expiresAt <= now ||
    scan.inventoryEpoch !== request.expectedInventoryEpoch ||
    source.account.activeWorkerScanId !== scan._id
  ) {
    throw workerProtocolError("scan_not_ready");
  }
  if (scan.nextReconcileOrdinal !== request.ordinal) {
    throw workerProtocolError("scan_conflict");
  }
  const expectedManifestVersion = scan.reconcileManifestVersion;
  if (
    expectedManifestVersion === undefined ||
    (source.account.manifestVersion ?? 0) !== expectedManifestVersion
  ) {
    throw workerProtocolError("scan_conflict");
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);

  const paginated = await ctx.db
    .query("sourceItems")
    .withIndex("by_sourceAccountId", (q) =>
      q.eq("sourceAccountId", source.account._id),
    )
    .paginate({
      cursor: scan.reconcileCursor ?? null,
      numItems: request.maxItems,
    });
  let unavailable = 0;
  let needsReview = scan.reconcileNeedsReview ?? false;
  for (const item of paginated.page) {
    if (
      item.spaceId !== source.spaceId ||
      item.sourceAccountId !== source.account._id
    ) {
      throw workerProtocolError("scan_conflict");
    }
    if (
      item.lifecycle === "forgotten" ||
      item.lifecycle === "forgetting" ||
      item.workerLastSeenInventoryEpoch === scan.inventoryEpoch
    ) {
      continue;
    }
    if (scan.mode === "identity_recovery") {
      needsReview = true;
      continue;
    }
    if (item.lifecycle !== "unavailable") {
      const priorWork = await currentDiscoveryWork(ctx, source, item);
      if (priorWork) await obsoletePriorWork(ctx, priorWork, false, now);
      const observationEpoch = (item.workerObservationEpoch ?? 0) + 1;
      if (!Number.isSafeInteger(observationEpoch)) {
        throw workerProtocolError("scan_conflict");
      }
      await markSourceItemUnavailable(ctx, {
        spaceId: source.spaceId,
        sourceItemId: item._id,
      });
      await ctx.db.patch(item._id, {
        workerObservationEpoch: observationEpoch,
      });
      unavailable += 1;
    }
  }

  const done = paginated.isDone;
  const state = done
    ? needsReview
      ? "needs_review"
      : "enumerated"
    : "reconciling";
  const result = {
    state,
    inspected: paginated.page.length,
    unavailable,
    done,
  } as const;
  const nextManifestVersion =
    (source.account.manifestVersion ?? 0) + (unavailable > 0 ? 1 : 0);
  await ctx.db.patch(scan._id, {
    state,
    reconcileCursor: paginated.continueCursor,
    nextReconcileOrdinal: scan.nextReconcileOrdinal + 1,
    reconcileNeedsReview: needsReview,
    reconcileManifestVersion: nextManifestVersion,
    lastReconcileRequestId: request.requestId,
    lastReconcileRequestDigest: requestDigest,
    lastReconcileResult: result,
    ...(done ? { completedAt: now } : {}),
    expiresAt: nowPlus(now, WORKER_SCAN_IDLE_MS),
    retireAt: nowPlus(now, WORKER_SCAN_RETENTION_MS),
  });
  if (unavailable > 0) {
    await ctx.db.patch(source.account._id, {
      manifestVersion: nextManifestVersion,
    });
    await invalidateCoverage(ctx, source.account, now);
  }
  if (done) {
    if (needsReview) {
      await ctx.db.patch(source.account._id, { activeWorkerScanId: undefined });
      await invalidateCoverage(ctx, source.account, now);
    } else {
      await ctx.db.patch(source.account._id, {
        activeWorkerScanId: undefined,
        completedInventoryEpoch: scan.inventoryEpoch,
        lastEnumeratedAt: now,
      });
      // Section 2.2/2.4 (P2-70a2): only a healthy completed reconciliation
      // (reached only in this branch) may mark rows missing. Every
      // sourceInventory row this scan did not touch was present at some
      // point and stays inventoried, now as missing rather than dropped.
      await markMissingInventoryRows(ctx, {
        spaceId: source.spaceId,
        sourceAccountId: source.account._id,
        scanId: scan._id,
      });
    }
  }
  return {
    operation: "scan.reconcile",
    scanId: scan._id,
    ...result,
    reused: false,
  };
}
