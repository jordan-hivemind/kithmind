// `records.listReviewQueue`, the review queue P2-39i3 ported from
// packages/convex/convex/models/records/reviewQueue.ts.
//
// The card extractor, the duplicate reconciler and the entity binder all
// belong to other rows, so every row here is seeded with SQL. A read test that
// could only run after those writers would prove nothing about the read.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import * as records from "../dist/records/index.js";
import {
  identityDatabase,
  makeSourceAccount,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

let files = 0;

async function seedInventory(ctx, fields) {
  files += 1;
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_inventory
       (id, space_id, created_at, source_account_id, identity_key_hash,
        relative_path, folder_path, file_name, modified_at, content_indexed,
        exclusion_reason, duplicate_group_id, first_seen_scan_id,
        last_seen_scan_id, byte_length, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, transaction_timestamp(), $9, $10,
             $11, $12, $12, 10, $5)`,
    [
      id,
      fields.spaceId,
      new Date(1_760_000_000_000 + files * 1_000),
      fields.sourceAccountId,
      files.toString(16).padStart(64, "0"),
      `folder/${fields.fileName ?? `file-${files}.txt`}`,
      "folder",
      fields.fileName ?? `file-${files}.txt`,
      fields.contentIndexed ?? false,
      fields.exclusionReason ?? null,
      fields.duplicateGroupId ?? null,
      fields.scanId,
    ],
  );
  return id;
}

let drops = 0;

async function seedDrop(ctx, fields) {
  drops += 1;
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.card_field_drops
       (id, space_id, created_at, source_account_id, source_item_id,
        processing_generation_id, record_kind, kind, field_key, code,
        created_at_field)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $7, $8, $3)`,
    [
      id,
      fields.spaceId,
      new Date(1_760_000_000_000 + drops * 1_000),
      fields.sourceAccountId,
      fields.recordKind ?? "lab_panel",
      fields.kind,
      fields.fieldKey ?? "result_value",
      fields.code ?? "unparseable",
    ],
  );
  return id;
}

let bindings = 0;

async function seedBinding(ctx, fields) {
  bindings += 1;
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.card_entity_bindings
       (id, space_id, created_at, source_account_id, source_item_id,
        processing_generation_id, event_id, observation_id, record_kind,
        field_key, observation_type, literal_name, normalized_name,
        candidate_count, status, created_at_field)
     VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5, 'patient',
             'patient', $6, $7, $8, $9, $3)`,
    [
      id,
      fields.spaceId,
      new Date(1_760_000_000_000 + bindings * 1_000),
      fields.sourceAccountId,
      fields.recordKind ?? "lab_panel",
      fields.literalName ?? `Name ${bindings}`,
      (fields.literalName ?? `Name ${bindings}`).toLowerCase(),
      fields.candidateCount ?? 0,
      fields.status ?? "pending",
    ],
  );
  return id;
}

async function seedQueueState(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.card_extraction_queue_states
       (id, space_id, created_at, kind, phase, extracted_count,
        gate_failed_count, skipped_count, documents_processed_today,
        daily_document_budget, documents_processed_this_week,
        weekly_document_budget, cost_micro_usd_this_week,
        weekly_cost_budget_micro_usd, pause_reason)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, 5, 2, 1, 3, 20, 9, 100,
             1234, 50000, $5)`,
    [id, fields.spaceId, fields.kind, fields.phase ?? "running", fields.pauseReason ?? null],
  );
  return id;
}

/** A space with one source account and a scan id the inventory rows share. */
async function account(ctx, options = {}) {
  const userId = options.userId ?? (await makeUser(ctx));
  const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
  const sourceAccountId = await makeSourceAccount(ctx, { spaceId });
  const scanId = newKithId();
  // Migration 008's required columns. `source_inventory` has a composite
  // foreign key onto this row, so a synthetic inventory row needs a synthetic
  // scan to point at.
  await ctx.client.query(
    `INSERT INTO kith.worker_source_scans
       (id, space_id, created_at, source_account_id, request_id, request_digest,
        watcher_id, connector_version, mode, inventory_epoch,
        manifest_version_at_begin, actor_user_id, actor_credential_id, state,
        next_page_ordinal, next_reconcile_ordinal, inventory_done, page_count,
        entry_count, changed_count, gap_count, review_count, started_at,
        expires_at, retire_at)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, 'fixture-watcher',
             'fixture-connector', 'normal', 0, 0, $6, $6, 'enumerated', 1, 1,
             true, 0, 0, 0, 0, 0, transaction_timestamp(),
             transaction_timestamp(), transaction_timestamp())`,
    [scanId, spaceId, sourceAccountId, scanId, `${scanId}-digest`, userId],
  );
  return { userId, spaceId, sourceAccountId, scanId };
}

test("the review queue counts every class from its own bounded scan", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const { spaceId, sourceAccountId, scanId } = await account(ctx);

    await seedInventory(ctx, {
      spaceId,
      sourceAccountId,
      scanId,
      exclusionReason: "unsupported",
    });
    await seedInventory(ctx, {
      spaceId,
      sourceAccountId,
      scanId,
      exclusionReason: "unsupported",
    });
    await seedInventory(ctx, {
      spaceId,
      sourceAccountId,
      scanId,
      exclusionReason: "oversized",
    });
    await seedInventory(ctx, {
      spaceId,
      sourceAccountId,
      scanId,
      contentIndexed: true,
    });

    await seedDrop(ctx, { spaceId, sourceAccountId, kind: "field_dropped" });
    await seedDrop(ctx, {
      spaceId,
      sourceAccountId,
      kind: "field_dropped",
      code: "out_of_range",
    });
    await seedDrop(ctx, {
      spaceId,
      sourceAccountId,
      kind: "card_gate_failed",
      recordKind: "vehicle_service",
    });

    await seedBinding(ctx, { spaceId, sourceAccountId, candidateCount: 0 });
    await seedBinding(ctx, { spaceId, sourceAccountId, candidateCount: 3 });
    // A resolved binding is an audit note, never queued work.
    await seedBinding(ctx, {
      spaceId,
      sourceAccountId,
      candidateCount: 1,
      status: "resolved",
    });

    await seedQueueState(ctx, { spaceId, kind: "lab_panel" });

    const result = await records.listReviewQueue(ctx.client, [spaceId], {
      sourceAccountId,
    });
    assert.deepEqual(result.rows, []);
    assert.equal(result.isDone, true);
    assert.equal(result.cursor, undefined);
    assert.deepEqual(result.counts.skippedByType, {
      total: 3,
      byExclusionReason: { unsupported: 2, oversized: 1 },
      truncated: false,
    });
    assert.deepEqual(result.counts.fieldDropped, {
      total: 2,
      byCode: { unparseable: 1, out_of_range: 1 },
      truncated: false,
    });
    assert.deepEqual(result.counts.cardGateFailed, {
      total: 1,
      byRecordKind: { vehicle_service: 1 },
      truncated: false,
    });
    assert.deepEqual(result.counts.entityBindingNeeded, {
      total: 2,
      unresolved: 1,
      ambiguous: 1,
      truncated: false,
    });
    assert.deepEqual(result.counts.queueStatus, [
      {
        kind: "lab_panel",
        phase: "running",
        extractedCount: 5,
        gateFailedCount: 2,
        skippedCount: 1,
        documentsProcessedToday: 3,
        dailyDocumentBudget: 20,
        documentsProcessedThisWeek: 9,
        weeklyDocumentBudget: 100,
        costMicroUsdThisWeek: 1234,
        weeklyCostBudgetMicroUsd: 50000,
        pauseReason: undefined,
        resumeAt: undefined,
      },
    ]);
  });
});

test("only real duplicate groups are counted, and their members page", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const { spaceId, sourceAccountId, scanId } = await account(ctx);

    // A group of two, a group of three, and one row whose hash is merely
    // unique: a group of one is not a duplicate group.
    for (const group of ["group-a", "group-a", "group-b", "group-b", "group-b", "group-c"]) {
      await seedInventory(ctx, {
        spaceId,
        sourceAccountId,
        scanId,
        duplicateGroupId: group,
        exclusionReason: group === "group-c" ? null : "duplicate_of",
      });
    }

    const counted = await records.listReviewQueue(ctx.client, [spaceId], {
      sourceAccountId,
    });
    assert.deepEqual(counted.counts.duplicateGroup, {
      total: 2,
      truncated: false,
    });

    const first = await records.listReviewQueue(ctx.client, [spaceId], {
      sourceAccountId,
      class: "duplicate_group",
      limit: 3,
    });
    assert.equal(first.rows.length, 3);
    assert.equal(first.isDone, false);
    assert.deepEqual(
      first.rows.map((row) => row.duplicateGroupId),
      ["group-a", "group-a", "group-b"],
    );
    const second = await records.listReviewQueue(ctx.client, [spaceId], {
      sourceAccountId,
      class: "duplicate_group",
      limit: 3,
      cursor: first.cursor,
    });
    assert.deepEqual(
      second.rows.map((row) => row.duplicateGroupId),
      ["group-b", "group-b"],
    );
    assert.equal(second.isDone, true);
    assert.equal(second.cursor, undefined);
  });
});

test("a named class pages its rows and carries no refused value", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const { spaceId, sourceAccountId, scanId } = await account(ctx);
    await seedInventory(ctx, {
      spaceId,
      sourceAccountId,
      scanId,
      exclusionReason: "unreadable",
      fileName: "skipped.bin",
    });
    await seedDrop(ctx, {
      spaceId,
      sourceAccountId,
      kind: "field_dropped",
      fieldKey: "result_value",
      code: "unparseable",
    });
    await seedDrop(ctx, {
      spaceId,
      sourceAccountId,
      kind: "card_gate_failed",
      recordKind: "lab_panel",
    });
    await seedBinding(ctx, {
      spaceId,
      sourceAccountId,
      literalName: "Rowan Example",
      candidateCount: 2,
    });

    const skipped = await records.listReviewQueue(ctx.client, [spaceId], {
      sourceAccountId,
      class: "skipped_by_type",
    });
    assert.equal(skipped.rows.length, 1);
    assert.equal(skipped.rows[0].fileName, "skipped.bin");
    assert.equal(skipped.rows[0].exclusionReason, "unreadable");

    const dropped = await records.listReviewQueue(ctx.client, [spaceId], {
      sourceAccountId,
      class: "field_dropped",
    });
    assert.equal(dropped.rows.length, 1);
    assert.equal(dropped.rows[0].kind, "field_dropped");
    assert.equal(dropped.rows[0].fieldKey, "result_value");
    assert.equal(dropped.rows[0].code, "unparseable");
    assert.equal(
      Object.prototype.hasOwnProperty.call(dropped.rows[0], "reason"),
      false,
      "a drop row never carries the value it refused",
    );

    const gateFailed = await records.listReviewQueue(ctx.client, [spaceId], {
      sourceAccountId,
      class: "card_gate_failed",
    });
    assert.equal(gateFailed.rows.length, 1);
    assert.equal(gateFailed.rows[0].kind, "card_gate_failed");

    const binding = await records.listReviewQueue(ctx.client, [spaceId], {
      sourceAccountId,
      class: "entity_binding_needed",
    });
    assert.equal(binding.rows.length, 1);
    assert.equal(binding.rows[0].literalName, "Rowan Example");
    assert.equal(binding.rows[0].candidateCount, 2);

    const status = await records.listReviewQueue(ctx.client, [spaceId], {
      sourceAccountId,
      class: "queue_status",
    });
    assert.deepEqual(status.rows, []);
    assert.equal(status.isDone, true);
  });
});

test(
  "a source account in another space reads as empty rather than as a denial",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const a = await account(ctx, { userId });
      const b = await account(ctx, { userId });

      await seedInventory(ctx, {
        spaceId: a.spaceId,
        sourceAccountId: a.sourceAccountId,
        scanId: a.scanId,
        exclusionReason: "unsupported",
      });
      await seedInventory(ctx, {
        spaceId: b.spaceId,
        sourceAccountId: b.sourceAccountId,
        scanId: b.scanId,
        exclusionReason: "oversized",
      });
      await seedDrop(ctx, {
        spaceId: b.spaceId,
        sourceAccountId: b.sourceAccountId,
        kind: "field_dropped",
      });
      await seedQueueState(ctx, { spaceId: b.spaceId, kind: "lab_panel" });

      // Authorized for A only: B's account is indistinguishable from one that
      // does not exist, and none of B's counts leak through it.
      const crossSpace = await records.listReviewQueue(ctx.client, [a.spaceId], {
        sourceAccountId: b.sourceAccountId,
      });
      assert.deepEqual(crossSpace.rows, []);
      assert.equal(crossSpace.counts.skippedByType.total, 0);
      assert.equal(crossSpace.counts.fieldDropped.total, 0);
      assert.deepEqual(crossSpace.counts.queueStatus, []);

      const unknown = await records.listReviewQueue(ctx.client, [a.spaceId], {
        sourceAccountId: newKithId(),
      });
      assert.deepEqual(crossSpace, unknown);

      // And A's own account still answers with A's rows only.
      const own = await records.listReviewQueue(ctx.client, [a.spaceId], {
        sourceAccountId: a.sourceAccountId,
      });
      assert.deepEqual(own.counts.skippedByType.byExclusionReason, {
        unsupported: 1,
      });

      // An empty authorized set denies rather than reading everything.
      const none = await records.listReviewQueue(ctx.client, [], {
        sourceAccountId: a.sourceAccountId,
      });
      assert.deepEqual(none.rows, []);
      assert.equal(none.counts.skippedByType.total, 0);
    });
  },
);

test("the limit and the cursor are validated", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const { spaceId, sourceAccountId } = await account(ctx);
    for (const limit of [0, 26, 1.5]) {
      await assert.rejects(
        () =>
          records.listReviewQueue(ctx.client, [spaceId], {
            sourceAccountId,
            limit,
          }),
        /limit must be an integer from 1 to 25/,
      );
    }
    await assert.rejects(
      () =>
        records.listReviewQueue(ctx.client, [spaceId], {
          sourceAccountId,
          class: "duplicate_group",
          cursor: "-1",
        }),
      /Invalid cursor/,
    );
  });
});
