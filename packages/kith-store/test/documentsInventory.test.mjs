// `documents.listInventory` and `documents.listSources` as a paged read.
//
// P2-39i3's review found two faults here that no test could have missed and
// none did, because the read had no test at all:
//
//   * every filter and every second page bound its values one position later
//     than the SQL asked for, so `fileName`, `folderPath`, `exclusionReason`,
//     `duplicateGroupId` and every cursor raised "could not determine data type
//     of parameter $3" instead of answering;
//   * the cursor was built from `row.created_at.toISOString()`, and
//     `timestamptz` holds microseconds while a JavaScript `Date` holds
//     milliseconds, so the cursor named an instant before the row it came from
//     and the next page repeated the previous one forever.
//
// The paging cases below therefore assert the whole traversal rather than one
// page: every row appears exactly once, and the walk terminates. A test that
// only read page one would still pass against both faults.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import * as documents from "../dist/documents/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSourceAccount,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

let files = 0;

/**
 * One inventory row.
 *
 * `at` is SQL, from a closed set: `transaction_timestamp()` gives every row in
 * one transaction the same instant, which is the tie case the `id` half of the
 * keyset has to carry; `clock_timestamp()` gives each row a distinct
 * microsecond value, which is the truncation case.
 */
async function seedInventory(ctx, fields) {
  files += 1;
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_inventory
       (id, space_id, created_at, source_account_id, identity_key_hash,
        relative_path, folder_path, file_name, modified_at, content_indexed,
        exclusion_reason, duplicate_group_id, first_seen_scan_id,
        last_seen_scan_id)
     VALUES ($1, $2, ${fields.at ?? "clock_timestamp()"}, $3, $4, $5, $6, $7,
             transaction_timestamp(), $8, $9, $10, $11, $11)`,
    [
      id,
      fields.spaceId,
      fields.sourceAccountId,
      files.toString(16).padStart(64, "0"),
      `${fields.folderPath ?? "folder"}/${fields.fileName ?? `file-${files}.txt`}`,
      fields.folderPath ?? "folder",
      fields.fileName ?? `file-${files}.txt`,
      fields.contentIndexed ?? false,
      fields.exclusionReason ?? null,
      fields.duplicateGroupId ?? null,
      fields.scanId,
    ],
  );
  return id;
}

/** A space, an account and the scan its inventory rows point at. */
async function account(ctx, options = {}) {
  const userId = options.userId ?? (await makeUser(ctx));
  const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
  const sourceAccountId = await makeSourceAccount(ctx, { spaceId });
  const key = await makeApiKey(ctx, { userId, spaceIds: [spaceId] });
  const scanId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.worker_source_scans
       (id, space_id, created_at, source_account_id, request_id, request_digest,
        watcher_id, connector_version, mode, inventory_epoch,
        manifest_version_at_begin, actor_user_id, actor_credential_id, state,
        next_page_ordinal, next_reconcile_ordinal, inventory_done, page_count,
        entry_count, changed_count, gap_count, review_count, started_at,
        expires_at, retire_at)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, 'fixture-watcher',
             'fixture-connector', 'normal', 0, 0, $6, $7, 'enumerated', 1, 1,
             true, 0, 0, 0, 0, 0, transaction_timestamp(),
             transaction_timestamp(), transaction_timestamp())`,
    [scanId, spaceId, sourceAccountId, scanId, `${scanId}-digest`, userId, key.id],
  );
  return { userId, spaceId, sourceAccountId, scanId };
}

/**
 * Follows the cursor to `isDone`, returning every row seen.
 *
 * The guard is what makes the repeating-page fault a failure rather than a
 * hang: a cursor that never advances trips it instead of looping forever.
 */
async function pageAll(read, limit) {
  const rows = [];
  let cursor;
  for (let guard = 0; guard <= 32; guard += 1) {
    const page = await read(cursor, limit);
    rows.push(...page.rows);
    if (page.isDone) {
      assert.equal(page.cursor, undefined, "a finished page carries no cursor");
      return rows;
    }
    assert.notEqual(page.cursor, undefined, "an unfinished page carries one");
    assert.notEqual(page.cursor, cursor, "the cursor advanced");
    cursor = page.cursor;
  }
  throw new Error("inventory paging did not terminate");
}

test("every inventory filter binds its own value", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const { spaceId, sourceAccountId, scanId } = await account(ctx);
    await seedInventory(ctx, {
      spaceId,
      sourceAccountId,
      scanId,
      fileName: "wanted.txt",
      folderPath: "wanted",
      exclusionReason: "unsupported",
      duplicateGroupId: "group-a",
    });
    await seedInventory(ctx, {
      spaceId,
      sourceAccountId,
      scanId,
      fileName: "other.txt",
      folderPath: "other",
      exclusionReason: "oversized",
      duplicateGroupId: "group-b",
    });

    for (const filter of [
      { fileName: "wanted.txt" },
      { folderPath: "wanted" },
      { exclusionReason: "unsupported" },
      { duplicateGroupId: "group-a" },
    ]) {
      const result = await documents.listInventory(ctx.client, [spaceId], {
        sourceAccountId,
        ...filter,
      });
      const label = Object.keys(filter)[0];
      assert.deepEqual(
        result.rows.map((row) => row.fileName),
        ["wanted.txt"],
        label,
      );
      assert.equal(result.counts.total, 1, label);
      assert.equal(result.isDone, true, label);
    }

    // Unfiltered still reads both, and two filters at once is still refused.
    const all = await documents.listInventory(ctx.client, [spaceId], {
      sourceAccountId,
    });
    assert.equal(all.rows.length, 2);
    await assert.rejects(
      () =>
        documents.listInventory(ctx.client, [spaceId], {
          sourceAccountId,
          fileName: "wanted.txt",
          folderPath: "wanted",
        }),
      /at most one of/,
    );
  });
});

test(
  "inventory paging reaches every row exactly once, with and without a filter",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const { spaceId, sourceAccountId, scanId } = await account(ctx);
      const wanted = [];
      for (let index = 0; index < 5; index += 1) {
        wanted.push(
          await seedInventory(ctx, {
            spaceId,
            sourceAccountId,
            scanId,
            fileName: `paged-${index}.txt`,
            exclusionReason: "unsupported",
          }),
        );
      }
      // One row the filter must exclude from every page.
      await seedInventory(ctx, {
        spaceId,
        sourceAccountId,
        scanId,
        fileName: "excluded.txt",
        exclusionReason: "oversized",
      });

      const unfiltered = await pageAll(
        (cursor, limit) =>
          documents.listInventory(ctx.client, [spaceId], {
            sourceAccountId,
            ...(cursor === undefined ? {} : { cursor }),
            limit,
          }),
        2,
      );
      assert.equal(unfiltered.length, 6);
      assert.equal(new Set(unfiltered.map((row) => row.inventoryId)).size, 6);

      const filtered = await pageAll(
        (cursor, limit) =>
          documents.listInventory(ctx.client, [spaceId], {
            sourceAccountId,
            exclusionReason: "unsupported",
            ...(cursor === undefined ? {} : { cursor }),
            limit,
          }),
        2,
      );
      assert.deepEqual(
        filtered.map((row) => row.inventoryId).sort(),
        [...wanted].sort(),
      );
      assert.equal(
        filtered.some((row) => row.fileName === "excluded.txt"),
        false,
        "the filter survives the cursor",
      );
    });
  },
);

test(
  "inventory paging terminates when every row shares one created_at",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const { spaceId, sourceAccountId, scanId } = await account(ctx);
      const seeded = [];
      for (let index = 0; index < 5; index += 1) {
        seeded.push(
          await seedInventory(ctx, {
            spaceId,
            sourceAccountId,
            scanId,
            at: "transaction_timestamp()",
            fileName: `tied-${index}.txt`,
          }),
        );
      }
      const rows = await pageAll(
        (cursor, limit) =>
          documents.listInventory(ctx.client, [spaceId], {
            sourceAccountId,
            ...(cursor === undefined ? {} : { cursor }),
            limit,
          }),
        2,
      );
      assert.deepEqual(
        rows.map((row) => row.inventoryId).sort(),
        [...seeded].sort(),
      );
    });
  },
);

test("a malformed inventory cursor is refused, not bound", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const { spaceId, sourceAccountId } = await account(ctx);
    for (const cursor of [
      "not-base64url-json",
      Buffer.from(JSON.stringify(["not a timestamp", "id"]), "utf8").toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify(["2026-02-01T00:00:00Z"]), "utf8").toString(
        "base64url",
      ),
    ]) {
      await assert.rejects(
        () =>
          documents.listInventory(ctx.client, [spaceId], {
            sourceAccountId,
            cursor,
          }),
        /Invalid cursor/,
      );
    }
  });
});

test(
  "an empty authorized set reads as an empty inventory and an empty source list",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const { spaceId, sourceAccountId, scanId } = await account(ctx);
      await seedInventory(ctx, { spaceId, sourceAccountId, scanId });

      // The Convex queries returned an empty page for a caller with no
      // readable space. `spacePredicate` refuses an empty set outright, which
      // is right for a statement and wrong for this boundary: an MCP
      // credential may hold no space grant at all.
      const inventory = await documents.listInventory(ctx.client, [], {
        sourceAccountId,
      });
      assert.deepEqual(inventory.rows, []);
      assert.equal(inventory.isDone, true);
      assert.equal(inventory.counts.total, 0);

      const sources = await documents.listSources(ctx.client, [], {});
      assert.deepEqual(sources, {
        sources: [],
        partial: false,
        truncated: false,
      });

      // And the same reads still answer for the authorized set.
      assert.equal(
        (await documents.listInventory(ctx.client, [spaceId], { sourceAccountId }))
          .rows.length,
        1,
      );
      assert.equal(
        (await documents.listSources(ctx.client, [spaceId], {})).sources.length,
        1,
      );
    });
  },
);
