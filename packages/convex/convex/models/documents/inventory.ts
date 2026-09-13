import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { boundedLimit, validateSpaces } from "./model";
import { sha256Utf8 } from "../provenance/model";
import type { FsDiscoveryEntry } from "../workers/protocol";
import type { SourceInventoryExclusionReason } from "./inventoryTables";

// Bounded scan for the exclusion-reason breakdown (section 2.6: "The response
// always carries counts ... for the selected scope, so a truncated page never
// reads as a complete folder"). Matches the MAX_QUERY_SCAN_ROWS bound records
// reads already use for this shape of honest, bounded aggregate.
const MAX_INVENTORY_COUNT_ROWS = 256;

/**
 * `entry.uri` is already validated by `parseWorkerRequest`'s `canonicalFsUri`
 * before this runs: `fs://<alias>/<percent-encoded-segment>/...`.
 */
function parseFsUri(uri: string): {
  relativePath: string;
  folderPath: string;
  fileName: string;
} {
  const separator = uri.indexOf("/", "fs://".length);
  const segments = uri
    .slice(separator + 1)
    .split("/")
    .map((segment) => decodeURIComponent(segment));
  const fileName = segments[segments.length - 1]!;
  return {
    relativePath: segments.join("/"),
    folderPath: segments.slice(0, -1).join("/"),
    fileName,
  };
}

async function duplicateGroupId(
  sourceAccountId: Id<"sourceAccounts">,
  contentHash: string,
  byteLength: number,
): Promise<string> {
  return sha256Utf8(
    `worker-fs-duplicate-group:v1\0${JSON.stringify([
      sourceAccountId,
      contentHash,
      byteLength,
    ])}`,
  );
}

/**
 * Section 2.5: exactly one member of a duplicate group is content indexed;
 * the rest carry `duplicate_of`. Today's admission path processes every
 * distinct `sourceItem` independently (P2-70a does not change that, per its
 * scope), so more than one member can legitimately become content indexed
 * over time. Among the members that are NOT yet content indexed, this picks
 * a single deterministic canonical (the smallest `identityKeyHash`) and
 * labels the rest `duplicate_of`, self-healing on every call so the result
 * does not depend on scan or arrival order.
 */
async function reconcileDuplicateGroup(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  groupId: string,
): Promise<void> {
  const members = await ctx.db
    .query("sourceInventory")
    .withIndex("by_space_duplicateGroup", (q) =>
      q.eq("spaceId", spaceId).eq("duplicateGroupId", groupId),
    )
    .collect();
  const pending = members.filter((member) => !member.contentIndexed);
  if (pending.length === 0) return;
  const canonical = pending.reduce((min, member) =>
    member.identityKeyHash < min.identityKeyHash ? member : min,
  );
  for (const member of pending) {
    const nextReason: SourceInventoryExclusionReason =
      member._id === canonical._id ? "extraction_pending" : "duplicate_of";
    // Same rule as the upsert above: a settled `parse_failed` outranks
    // `extraction_pending` (P2-80f). `duplicate_of` still wins, since another
    // member of the group carries the content.
    if (
      nextReason === "extraction_pending" &&
      member.exclusionReason === "parse_failed"
    ) {
      continue;
    }
    if (member.exclusionReason !== nextReason) {
      await ctx.db.patch(member._id, { exclusionReason: nextReason });
    }
  }
}

/**
 * Upserts the durable `sourceInventory` row for one `scan.appendPage` entry.
 * Additive only: never changes `workerScanEntries`, admission, or which
 * files are processed. Keyed by `(sourceAccountId, identityKeyHash)`, the
 * same stable per-file identity `workerScanEntries` already carries, so a
 * rescan of unchanged files updates the existing row instead of duplicating
 * it.
 */
export async function upsertSourceInventoryRow(
  ctx: MutationCtx,
  args: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    scanId: Id<"workerSourceScans">;
    entry: FsDiscoveryEntry;
    scanEntry: Doc<"workerScanEntries">;
  },
): Promise<void> {
  const { spaceId, sourceAccountId, scanId, entry, scanEntry } = args;
  const location = parseFsUri(entry.uri);
  const gapCode =
    entry.content.status === "gap" ? entry.content.code : undefined;
  const byteLength =
    entry.content.status === "gap" ? undefined : entry.content.byteLength;
  const contentHash =
    entry.content.status === "gap" ? undefined : entry.content.sha256;
  const mediaType =
    entry.content.status === "ready_binary_v1"
      ? entry.content.mediaType
      : entry.content.status === "ready"
        ? "text/plain"
        : undefined;

  // P2-77: a permissions-only encrypted PDF is admitted (no exclusion
  // reason below), but the restriction is still worth surfacing on the row.
  const encryptionRevision =
    entry.content.status === "ready_binary_v1" &&
    entry.content.permissionsRestricted === true
      ? entry.content.encryptionRevision
      : undefined;
  const permissionsRestricted = encryptionRevision !== undefined;
  const permissionsDetail = permissionsRestricted
    ? `standard security handler revision ${encryptionRevision} (empty user password)`
    : undefined;

  // Section 2.2: "True only when an active generation holds retained text."
  // This is the existing document pipeline's activation state, computed live
  // rather than cached, so it can lag between a scan and a later async parse
  // completing; nothing outside a scan currently refreshes this row.
  let contentIndexed = false;
  if (gapCode === undefined && scanEntry.sourceItemId !== undefined) {
    const item = await ctx.db.get(scanEntry.sourceItemId);
    contentIndexed = item?.activeGenerationId !== undefined;
  }

  const groupId =
    gapCode === undefined &&
    contentHash !== undefined &&
    byteLength !== undefined
      ? await duplicateGroupId(sourceAccountId, contentHash, byteLength)
      : undefined;

  const existing = (
    await ctx.db
      .query("sourceInventory")
      .withIndex("by_sourceAccountId_and_identityKeyHash", (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("identityKeyHash", scanEntry.identityKeyHash),
      )
      .take(1)
  )[0];

  // Section 2.4: `parse_failed` is set and cleared outside a scan. Rescanning
  // the same bytes is not news about the parse, so it must not relabel a
  // settled failure back to `extraction_pending` and drop the file out of the
  // review queue (P2-80f). New bytes do reset it: that is a fresh attempt.
  const settledParseFailure =
    existing?.exclusionReason === "parse_failed" &&
    existing.contentHash === contentHash;

  // `extraction_pending` is provisional here: reconcileDuplicateGroup below
  // may immediately override it to `duplicate_of` for every group member
  // except the deterministic canonical.
  const exclusionReason: SourceInventoryExclusionReason | undefined =
    gapCode ??
    (contentIndexed
      ? undefined
      : settledParseFailure
        ? "parse_failed"
        : "extraction_pending");

  const fields = {
    spaceId,
    sourceAccountId,
    ...(scanEntry.sourceItemId === undefined
      ? {}
      : { sourceItemId: scanEntry.sourceItemId }),
    identityKeyHash: scanEntry.identityKeyHash,
    relativePath: location.relativePath,
    folderPath: location.folderPath,
    fileName: location.fileName,
    ...(byteLength === undefined ? {} : { byteLength }),
    ...(contentHash === undefined ? {} : { contentHash }),
    ...(mediaType === undefined ? {} : { mediaType }),
    modifiedAt: entry.sourceModifiedAt,
    ...(groupId === undefined ? {} : { duplicateGroupId: groupId }),
    contentIndexed,
    exclusionReason,
    permissionsRestricted,
    permissionsDetail,
    lastSeenScanId: scanId,
    // Section 2.2: "clear it when the file reappears in a later scan". This
    // call is itself an observation of the file, so any prior "missing" mark
    // no longer holds.
    ...(existing?.missingSinceScanId === undefined
      ? {}
      : { missingSinceScanId: undefined }),
  };

  if (existing) {
    await ctx.db.patch(existing._id, fields);
  } else {
    await ctx.db.insert("sourceInventory", {
      ...fields,
      firstSeenScanId: scanId,
    });
  }

  if (groupId !== undefined) {
    await reconcileDuplicateGroup(ctx, spaceId, groupId);
  }
}

/**
 * Section 2.2/2.3 (P2-70a2): a document job's failure path calls this with
 * the job's `sourceItemId` and its failure class (an `ingestJobs.error.code`,
 * already bounded and never document text) once the job has given up
 * retrying. Only files that reached item admission can have a job at all, so
 * the `by_sourceItemId` index (already defined for this table) is enough to
 * find the row; a row that is already content indexed is left alone, since a
 * job failure after an earlier success does not retroactively exclude a
 * file whose active generation still holds retained text.
 */
export async function markInventoryParseFailed(
  ctx: MutationCtx,
  args: { sourceItemId: Id<"sourceItems">; failureClass: string },
): Promise<void> {
  const existing = (
    await ctx.db
      .query("sourceInventory")
      .withIndex("by_sourceItemId", (q) =>
        q.eq("sourceItemId", args.sourceItemId),
      )
      .take(1)
  )[0];
  if (!existing || existing.contentIndexed) return;
  await ctx.db.patch(existing._id, {
    exclusionReason: "parse_failed",
    exclusionDetail: args.failureClass,
  });
}

/**
 * Section 2.2/2.3 (P2-70a2): the counterpart to `markInventoryParseFailed`,
 * called once a later job for the same file activates successfully. This
 * only reverts a `parse_failed` row back to `extraction_pending` (the same
 * value a fresh scan would assign a not-yet-indexed file): `contentIndexed`
 * itself is scan-computed only, per the existing note on that field above,
 * so the next scan is what promotes the row the rest of the way.
 */
export async function clearInventoryParseFailed(
  ctx: MutationCtx,
  args: { sourceItemId: Id<"sourceItems"> },
): Promise<void> {
  const existing = (
    await ctx.db
      .query("sourceInventory")
      .withIndex("by_sourceItemId", (q) =>
        q.eq("sourceItemId", args.sourceItemId),
      )
      .take(1)
  )[0];
  if (!existing || existing.exclusionReason !== "parse_failed") return;
  await ctx.db.patch(existing._id, {
    exclusionReason: "extraction_pending",
    exclusionDetail: undefined,
  });
}

/**
 * Section 2.4 (P2-70a2): called only from the reconcile-completion path,
 * only for a healthy completed reconciliation (`done && !needsReview`), the
 * same gate the plan requires for `missingSinceScanId`. Every row this scan
 * did not touch (`lastSeenScanId !== scanId`) was present at some point and
 * is now inventoried as missing rather than silently dropped; a row already
 * marked missing keeps its earlier scan id, so `missingSinceScanId` names
 * the start of the gap rather than the latest scan that failed to find it.
 *
 * ponytail: one full per-account sweep inside this mutation, matching this
 * table's existing `reconcileDuplicateGroup` sweep. Fine at personal-archive
 * scale; move to a paginated multi-call sweep (mirroring the sourceItems
 * reconcile loop above) if a source account's file count grows enough to
 * threaten a single mutation's read/write bounds.
 */
export async function markMissingInventoryRows(
  ctx: MutationCtx,
  args: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    scanId: Id<"workerSourceScans">;
  },
): Promise<void> {
  for await (const row of ctx.db
    .query("sourceInventory")
    .withIndex("by_space_account_folder", (q) =>
      q.eq("spaceId", args.spaceId).eq("sourceAccountId", args.sourceAccountId),
    )) {
    if (row.lastSeenScanId !== args.scanId && row.missingSinceScanId === undefined) {
      await ctx.db.patch(row._id, { missingSinceScanId: args.scanId });
    }
  }
}

/**
 * Section 2.6 read surface. Exactly one of `fileName`, `folderPath`,
 * `exclusionReason` or `duplicateGroupId` may be given, each answering one of
 * the four question shapes in section 1: is this file present, what is in
 * this folder, what was excluded and why, and which files are duplicates.
 * Every existing index requires `sourceAccountId`, which `duplicateGroupId`
 * already embeds (see `duplicateGroupId()` above), so this read takes it as a
 * required scope rather than fanning a filter out across every account in a
 * space.
 */
export type InventoryListArgs = {
  sourceAccountId: Id<"sourceAccounts">;
  fileName?: string;
  folderPath?: string;
  exclusionReason?: SourceInventoryExclusionReason;
  duplicateGroupId?: string;
  cursor?: string;
  limit?: number;
};

type InventoryScopeFilter = Pick<
  InventoryListArgs,
  "fileName" | "folderPath" | "exclusionReason" | "duplicateGroupId"
>;

function scopedInventoryQuery(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
  filter: InventoryScopeFilter,
) {
  if (filter.duplicateGroupId !== undefined) {
    return ctx.db
      .query("sourceInventory")
      .withIndex("by_space_duplicateGroup", (q) =>
        q
          .eq("spaceId", spaceId)
          .eq("duplicateGroupId", filter.duplicateGroupId!),
      );
  }
  if (filter.fileName !== undefined) {
    return ctx.db
      .query("sourceInventory")
      .withIndex("by_space_account_fileName", (q) =>
        q
          .eq("spaceId", spaceId)
          .eq("sourceAccountId", sourceAccountId)
          .eq("fileName", filter.fileName!),
      );
  }
  if (filter.exclusionReason !== undefined) {
    return ctx.db
      .query("sourceInventory")
      .withIndex("by_space_account_exclusionReason", (q) =>
        q
          .eq("spaceId", spaceId)
          .eq("sourceAccountId", sourceAccountId)
          .eq("exclusionReason", filter.exclusionReason!),
      );
  }
  if (filter.folderPath !== undefined) {
    return ctx.db
      .query("sourceInventory")
      .withIndex("by_space_account_folder", (q) =>
        q
          .eq("spaceId", spaceId)
          .eq("sourceAccountId", sourceAccountId)
          .eq("folderPath", filter.folderPath!),
      );
  }
  return ctx.db
    .query("sourceInventory")
    .withIndex("by_space_account_folder", (q) =>
      q.eq("spaceId", spaceId).eq("sourceAccountId", sourceAccountId),
    );
}

/** Exported so P2-70k's review queue can reuse the same row shape for the
 * inventory-backed classes (skipped files, duplicate group members). */
export function projectInventoryRow(row: Doc<"sourceInventory">) {
  return {
    inventoryId: row._id,
    sourceAccountId: row.sourceAccountId,
    fileName: row.fileName,
    relativePath: row.relativePath,
    folderPath: row.folderPath,
    byteLength: row.byteLength,
    contentHash: row.contentHash,
    mediaType: row.mediaType,
    modifiedAt: row.modifiedAt,
    contentIndexed: row.contentIndexed,
    exclusionReason: row.exclusionReason,
    exclusionDetail: row.exclusionDetail,
    permissionsRestricted: row.permissionsRestricted,
    permissionsDetail: row.permissionsDetail,
    duplicateGroupId: row.duplicateGroupId,
    missingSinceScanId: row.missingSinceScanId,
  };
}

type InventoryCounts = {
  total: number;
  contentIndexed: number;
  byExclusionReason: Partial<Record<SourceInventoryExclusionReason, number>>;
  truncated: boolean;
};

function emptyCounts(): InventoryCounts {
  return {
    total: 0,
    contentIndexed: 0,
    byExclusionReason: {},
    truncated: false,
  };
}

async function inventoryScopeCounts(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
  filter: InventoryScopeFilter,
): Promise<InventoryCounts> {
  const rows = (
    await scopedInventoryQuery(ctx, spaceId, sourceAccountId, filter).take(
      MAX_INVENTORY_COUNT_ROWS + 1,
    )
  ).filter((row) => row.sourceAccountId === sourceAccountId);
  const truncated = rows.length > MAX_INVENTORY_COUNT_ROWS;
  const counted = rows.slice(0, MAX_INVENTORY_COUNT_ROWS);
  const byExclusionReason: Partial<Record<SourceInventoryExclusionReason, number>> =
    {};
  let contentIndexed = 0;
  for (const row of counted) {
    if (row.exclusionReason === undefined) {
      contentIndexed += 1;
    } else {
      byExclusionReason[row.exclusionReason] =
        (byExclusionReason[row.exclusionReason] ?? 0) + 1;
    }
  }
  return { total: counted.length, contentIndexed, byExclusionReason, truncated };
}

/**
 * Space-scoped inventory read. `spaceIds` must already be the caller's
 * membership-checked authorized set (from `getAuthorizedReadSpaceIds`), the
 * same convention every other document read in this module family uses;
 * this function never trusts a caller-supplied space on its own. An
 * unauthorized or unknown `sourceAccountId` reads as empty, the same
 * non-enumerating behavior `listSources` uses for the same input shape.
 */
export async function listInventory(
  ctx: Pick<QueryCtx, "db">,
  spaceIds: readonly Id<"spaces">[],
  args: InventoryListArgs,
) {
  validateSpaces(spaceIds);
  const limit = boundedLimit(args.limit);
  const filterCount = [
    args.fileName,
    args.folderPath,
    args.exclusionReason,
    args.duplicateGroupId,
  ].filter((value) => value !== undefined).length;
  if (filterCount > 1) {
    throw new Error(
      "Inventory reads accept at most one of fileName, folderPath, exclusionReason, duplicateGroupId",
    );
  }

  const authorized = new Set(spaceIds);
  const account = await ctx.db.get(args.sourceAccountId);
  if (!account || !authorized.has(account.spaceId)) {
    return {
      rows: [],
      cursor: undefined,
      isDone: true,
      counts: emptyCounts(),
    };
  }

  const page = await scopedInventoryQuery(
    ctx,
    account.spaceId,
    account._id,
    args,
  ).paginate({ cursor: args.cursor ?? null, numItems: limit });
  const rows = page.page
    .filter((row) => row.sourceAccountId === account._id)
    .map(projectInventoryRow);
  const counts = await inventoryScopeCounts(
    ctx,
    account.spaceId,
    account._id,
    args,
  );

  return {
    rows,
    cursor: page.isDone ? undefined : page.continueCursor,
    isDone: page.isDone,
    counts,
  };
}
