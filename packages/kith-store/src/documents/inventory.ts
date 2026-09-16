// Ported from packages/convex/convex/models/documents/inventory.ts (P2-39d).
//
// `upsertSourceInventoryRow`'s Convex original takes a worker-protocol
// `FsDiscoveryEntry` and a `workerScanEntries` row directly -- both belong to
// the workers/ingestion domain (row e), which this port does not touch. The
// ported signature below takes the same fields flattened to plain values
// instead (`identityKeyHash`, the parsed `relativePath`/`folderPath`/
// `fileName`, and the same optional gap/content fields), so the business
// logic -- most importantly PR191's invariant that a rescan of unchanged
// bytes must not clear a settled `parse_failed` back to
// `extraction_pending` -- ports unchanged while the worker-shaped input
// parsing stays with the row that owns that domain.

import type { ClientBase, QueryResultRow } from "pg";

import { newKithId } from "../ids.js";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetCursorColumn,
  keysetCursorPredicate,
} from "../keyset.js";
import { spacePredicate } from "../spaces.js";
import { camelizeSourceInventory, type SourceInventoryExclusionReason, type SourceInventoryRow } from "../provenance/rows.js";
import { sha256Utf8 } from "../provenance/sql.js";

async function duplicateGroupId(
  sourceAccountId: string,
  contentHash: string,
  byteLength: number,
): Promise<string> {
  return sha256Utf8(
    `worker-fs-duplicate-group:v1\0${JSON.stringify([sourceAccountId, contentHash, byteLength])}`,
  );
}

/**
 * Section 2.5 of docs/plans/2026-09-12-document-cards.md: exactly one member
 * of a duplicate group is content indexed; the rest carry `duplicate_of`.
 * Ported unchanged from inventory.ts's `reconcileDuplicateGroup`, as one SQL
 * scan of the group in place of Convex's index query.
 */
async function reconcileDuplicateGroup(
  client: ClientBase,
  spaceId: string,
  groupId: string,
): Promise<void> {
  const members = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.source_inventory WHERE space_id = $1 AND duplicate_group_id = $2`,
      [spaceId, groupId],
    )
  ).rows.map((row) => camelizeSourceInventory(row));
  const pending = members.filter((member) => !member.contentIndexed);
  if (pending.length === 0) return;
  const canonical = pending.reduce((min, member) =>
    member.identityKeyHash < min.identityKeyHash ? member : min,
  );
  for (const member of pending) {
    const nextReason: SourceInventoryExclusionReason =
      member.id === canonical.id ? "extraction_pending" : "duplicate_of";
    if (nextReason === "extraction_pending" && member.exclusionReason === "parse_failed") {
      continue;
    }
    if (member.exclusionReason !== nextReason) {
      await client.query(`UPDATE kith.source_inventory SET exclusion_reason = $1 WHERE id = $2`, [
        nextReason,
        member.id,
      ]);
    }
  }
}

export type UpsertInventoryRowInput = {
  spaceId: string;
  sourceAccountId: string;
  scanId: string;
  sourceItemId?: string;
  identityKeyHash: string;
  relativePath: string;
  folderPath: string;
  fileName: string;
  sourceModifiedAt: Date;
  /** Present exactly when the discovery entry was a gap; its exclusion code. */
  gapCode?: SourceInventoryExclusionReason;
  byteLength?: number;
  contentHash?: string;
  mediaType?: string;
  permissionsRestricted?: boolean;
  permissionsDetail?: string;
};

/**
 * Upserts the durable `source_inventory` row for one discovered file.
 * Keyed by `(sourceAccountId, identityKeyHash)`, so a rescan of unchanged
 * files updates the existing row instead of duplicating it. Ported from
 * `upsertSourceInventoryRow`.
 */
export async function upsertSourceInventoryRow(
  client: ClientBase,
  input: UpsertInventoryRowInput,
): Promise<void> {
  const gapCode = input.gapCode;
  const byteLength = gapCode === undefined ? input.byteLength : undefined;
  const contentHash = gapCode === undefined ? input.contentHash : undefined;
  const mediaType = gapCode === undefined ? input.mediaType : undefined;
  const permissionsRestricted = gapCode === undefined ? (input.permissionsRestricted ?? false) : false;
  const permissionsDetail = permissionsRestricted ? (input.permissionsDetail ?? null) : null;

  // Section 2.2: true only when an active generation holds retained text.
  // Computed live rather than cached, so it can lag between a scan and a
  // later async parse completing.
  let contentIndexed = false;
  if (gapCode === undefined && input.sourceItemId !== undefined) {
    const item = (
      await client.query<QueryResultRow>(`SELECT active_generation_id FROM kith.source_items WHERE id = $1`, [
        input.sourceItemId,
      ])
    ).rows[0];
    contentIndexed = item?.active_generation_id !== null && item?.active_generation_id !== undefined;
  }

  const groupId =
    gapCode === undefined && contentHash !== undefined && byteLength !== undefined
      ? await duplicateGroupId(input.sourceAccountId, contentHash, byteLength)
      : undefined;

  const existingRow = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.source_inventory WHERE source_account_id = $1 AND identity_key_hash = $2 LIMIT 1`,
      [input.sourceAccountId, input.identityKeyHash],
    )
  ).rows[0];
  const existing = existingRow && camelizeSourceInventory(existingRow);

  // Section 2.4/PR191: a settled `parse_failed` outranks a rescan of the same
  // bytes. New bytes (a different content hash) do reset it -- that is a
  // fresh attempt.
  const settledParseFailure =
    existing?.exclusionReason === "parse_failed" && existing.contentHash === (contentHash ?? null);

  const exclusionReason: SourceInventoryExclusionReason | undefined =
    gapCode ?? (contentIndexed ? undefined : settledParseFailure ? "parse_failed" : "extraction_pending");

  if (existing) {
    // Section 2.2: "clear it when the file reappears in a later scan." This
    // call is itself an observation of the file, so any prior "missing" mark
    // no longer holds -- unconditionally cleared, matching the Convex
    // original.
    await client.query(
      `UPDATE kith.source_inventory
          SET source_item_id = $1, identity_key_hash = $2, relative_path = $3, folder_path = $4,
              file_name = $5, byte_length = $6, content_hash = $7, media_type = $8, modified_at = $9,
              duplicate_group_id = $10, content_indexed = $11, exclusion_reason = $12,
              permissions_restricted = $13, permissions_detail = $14, last_seen_scan_id = $15,
              missing_since_scan_id = NULL
        WHERE id = $16`,
      [
        input.sourceItemId ?? null,
        input.identityKeyHash,
        input.relativePath,
        input.folderPath,
        input.fileName,
        byteLength ?? null,
        contentHash ?? null,
        mediaType ?? null,
        input.sourceModifiedAt,
        groupId ?? null,
        contentIndexed,
        exclusionReason ?? null,
        permissionsRestricted,
        permissionsDetail,
        input.scanId,
        existing.id,
      ],
    );
  } else {
    const id = newKithId();
    await client.query(
      `INSERT INTO kith.source_inventory
         (id, space_id, created_at, source_account_id, source_item_id, identity_key_hash, relative_path, folder_path,
          file_name, byte_length, content_hash, media_type, modified_at, duplicate_group_id,
          content_indexed, exclusion_reason, permissions_restricted, permissions_detail,
          first_seen_scan_id, last_seen_scan_id)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
      [
        id,
        input.spaceId,
        input.sourceAccountId,
        input.sourceItemId ?? null,
        input.identityKeyHash,
        input.relativePath,
        input.folderPath,
        input.fileName,
        byteLength ?? null,
        contentHash ?? null,
        mediaType ?? null,
        input.sourceModifiedAt,
        groupId ?? null,
        contentIndexed,
        exclusionReason ?? null,
        permissionsRestricted,
        permissionsDetail,
        input.scanId,
      ],
    );
  }

  if (groupId !== undefined) {
    await reconcileDuplicateGroup(client, input.spaceId, groupId);
  }
}

/** Ported from `markInventoryParseFailed`. */
export async function markInventoryParseFailed(
  client: ClientBase,
  input: { sourceItemId: string; failureClass: string },
): Promise<void> {
  const existingRow = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.source_inventory WHERE source_item_id = $1 LIMIT 1`,
      [input.sourceItemId],
    )
  ).rows[0];
  const existing = existingRow && camelizeSourceInventory(existingRow);
  if (!existing || existing.contentIndexed) return;
  await client.query(
    `UPDATE kith.source_inventory SET exclusion_reason = 'parse_failed', exclusion_detail = $1 WHERE id = $2`,
    [input.failureClass, existing.id],
  );
}

/** Ported from `clearInventoryParseFailed`. */
export async function clearInventoryParseFailed(
  client: ClientBase,
  input: { sourceItemId: string },
): Promise<void> {
  const existingRow = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.source_inventory WHERE source_item_id = $1 LIMIT 1`,
      [input.sourceItemId],
    )
  ).rows[0];
  const existing = existingRow && camelizeSourceInventory(existingRow);
  if (!existing || existing.exclusionReason !== "parse_failed") return;
  await client.query(
    `UPDATE kith.source_inventory SET exclusion_reason = 'extraction_pending', exclusion_detail = NULL WHERE id = $1`,
    [existing.id],
  );
}

/**
 * Ported from `markMissingInventoryRows`. Convex's per-row loop becomes one
 * set-based `UPDATE`: every row this scan did not touch, and that is not
 * already marked missing, is marked missing as of this scan.
 */
export async function markMissingInventoryRows(
  client: ClientBase,
  input: { spaceId: string; sourceAccountId: string; scanId: string },
): Promise<void> {
  await client.query(
    `UPDATE kith.source_inventory
        SET missing_since_scan_id = $1
      WHERE space_id = $2 AND source_account_id = $3 AND last_seen_scan_id <> $1
        AND missing_since_scan_id IS NULL`,
    [input.scanId, input.spaceId, input.sourceAccountId],
  );
}

export type InventoryListArgs = {
  sourceAccountId: string;
  fileName?: string;
  folderPath?: string;
  exclusionReason?: SourceInventoryExclusionReason;
  duplicateGroupId?: string;
  cursor?: string;
  limit?: number;
};

const DEFAULT_INVENTORY_LIMIT = 50;
const MAX_INVENTORY_LIMIT = 200;
const MAX_INVENTORY_COUNT_ROWS = 256;

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_INVENTORY_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INVENTORY_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_INVENTORY_LIMIT}`);
  }
  return value;
}

/** Exported so a review-queue read can reuse the same row shape. */
export function projectInventoryRow(row: SourceInventoryRow) {
  return {
    inventoryId: row.id,
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

function scopeClause(
  filter: Pick<InventoryListArgs, "fileName" | "folderPath" | "exclusionReason" | "duplicateGroupId">,
  startParam: number,
): { sql: string; values: unknown[] } {
  if (filter.duplicateGroupId !== undefined) {
    return { sql: `duplicate_group_id = $${startParam}`, values: [filter.duplicateGroupId] };
  }
  if (filter.fileName !== undefined) {
    return { sql: `file_name = $${startParam}`, values: [filter.fileName] };
  }
  if (filter.exclusionReason !== undefined) {
    return { sql: `exclusion_reason = $${startParam}`, values: [filter.exclusionReason] };
  }
  if (filter.folderPath !== undefined) {
    return { sql: `folder_path = $${startParam}`, values: [filter.folderPath] };
  }
  return { sql: "TRUE", values: [] };
}

async function inventoryScopeCounts(
  client: ClientBase,
  spaceId: string,
  sourceAccountId: string,
  filter: InventoryListArgs,
): Promise<InventoryCounts> {
  const scope = scopeClause(filter, 3);
  const rows = (
    await client.query<QueryResultRow>(
      `SELECT exclusion_reason FROM kith.source_inventory
        WHERE space_id = $1 AND source_account_id = $2 AND ${scope.sql}
        LIMIT ${MAX_INVENTORY_COUNT_ROWS + 1}`,
      [spaceId, sourceAccountId, ...scope.values],
    )
  ).rows;
  const truncated = rows.length > MAX_INVENTORY_COUNT_ROWS;
  const counted = rows.slice(0, MAX_INVENTORY_COUNT_ROWS);
  const byExclusionReason: Partial<Record<SourceInventoryExclusionReason, number>> = {};
  let contentIndexed = 0;
  for (const row of counted) {
    const reason = row.exclusion_reason as SourceInventoryExclusionReason | null;
    if (reason === null) {
      contentIndexed += 1;
    } else {
      byExclusionReason[reason] = (byExclusionReason[reason] ?? 0) + 1;
    }
  }
  return { total: counted.length, contentIndexed, byExclusionReason, truncated };
}

/**
 * Space-scoped inventory read. `authorizedSpaceIds` must already be the
 * caller's membership-checked authorized set; an unauthorized or unknown
 * `sourceAccountId` reads as empty. Ported from `listInventory`, with
 * Convex's `.paginate` replaced by the plan's keyset cursor over
 * `(created_at, id)` (section 2.3).
 */
export async function listInventory(
  client: ClientBase,
  authorizedSpaceIds: readonly string[],
  args: InventoryListArgs,
) {
  const limit = boundedLimit(args.limit);
  const filterCount = [args.fileName, args.folderPath, args.exclusionReason, args.duplicateGroupId].filter(
    (value) => value !== undefined,
  ).length;
  if (filterCount > 1) {
    throw new Error(
      "Inventory reads accept at most one of fileName, folderPath, exclusionReason, duplicateGroupId",
    );
  }

  // An empty authorized set is the same answer as an unauthorized account, and
  // the Convex query returned an empty page for it. `spacePredicate` refuses an
  // empty set outright, on the grounds that reaching a read with no authorized
  // space is an authorization bug, and that is the right rule for a statement;
  // here the caller is an MCP tool whose credential may legitimately hold no
  // space grant, so the read answers empty rather than raising a `ProofError`
  // the tool would surface verbatim.
  if (authorizedSpaceIds.length === 0) {
    return { rows: [], cursor: undefined, isDone: true, counts: emptyCounts() };
  }
  const predicate = spacePredicate(authorizedSpaceIds, 1);
  const account = (
    await client.query<QueryResultRow>(
      `SELECT id, space_id FROM kith.source_accounts WHERE id = $2 AND ${predicate.sql}`,
      [predicate.value, args.sourceAccountId],
    )
  ).rows[0];
  if (!account) {
    return { rows: [], cursor: undefined, isDone: true, counts: emptyCounts() };
  }

  // `$1` and `$2` are the space and the account, so the scope filter is `$3`
  // and the cursor follows whatever the scope bound. Both were previously
  // written as fixed positions (`$4`, then `$5`/`$6`) while the bind array
  // below appended them straight after `$2`, so every filter and every second
  // page asked the server for a parameter that was never sent.
  const values: unknown[] = [account.space_id, account.id];
  const scope = scopeClause(args, values.length + 1);
  values.push(...scope.values);
  let cursorClause = "";
  if (args.cursor !== undefined) {
    const { keysetAt, id } = decodeKeysetCursor(args.cursor);
    cursorClause = ` AND ${keysetCursorPredicate(values.length + 1, values.length + 2)}`;
    values.push(keysetAt, id);
  }
  const page = (
    await client.query<QueryResultRow>(
      `SELECT *, ${keysetCursorColumn()} FROM kith.source_inventory
        WHERE space_id = $1 AND source_account_id = $2 AND ${scope.sql}${cursorClause}
        ORDER BY created_at, id
        LIMIT ${limit + 1}`,
      values,
    )
  ).rows;
  const isDone = page.length <= limit;
  const pageRows = page.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  // The cursor carries the timestamp PostgreSQL rendered, never a round trip
  // through a millisecond `Date`. See `../keyset.ts`.
  const cursor =
    isDone || !last
      ? undefined
      : encodeKeysetCursor(last.keyset_at as string, last.id as string);

  const counts = await inventoryScopeCounts(client, account.space_id as string, account.id as string, args);

  return {
    rows: pageRows.map((row) => projectInventoryRow(camelizeSourceInventory(row))),
    cursor,
    isDone,
    counts,
  };
}

function emptyCounts(): InventoryCounts {
  return { total: 0, contentIndexed: 0, byExclusionReason: {}, truncated: false };
}
