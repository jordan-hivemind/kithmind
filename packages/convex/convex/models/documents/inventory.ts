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

  // `extraction_pending` is provisional here: reconcileDuplicateGroup below
  // may immediately override it to `duplicate_of` for every group member
  // except the deterministic canonical.
  const exclusionReason: SourceInventoryExclusionReason | undefined =
    gapCode ?? (contentIndexed ? undefined : "extraction_pending");

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
    lastSeenScanId: scanId,
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

function projectInventoryRow(row: Doc<"sourceInventory">) {
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
    duplicateGroupId: row.duplicateGroupId,
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
