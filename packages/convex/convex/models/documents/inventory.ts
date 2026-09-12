import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { sha256Utf8 } from "../provenance/model";
import type { FsDiscoveryEntry } from "../workers/protocol";
import type { SourceInventoryExclusionReason } from "./inventoryTables";

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
