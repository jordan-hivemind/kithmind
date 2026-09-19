// The attention queue store surface (ADM-8a), against a real database.
//
// The gate-failure integration (a real `openCorrection`/`supersedeOpenCorrections`
// run, the way `src/extraction/model.ts` calls them) is what proves the two
// claims that matter most: a dismissal is remembered across a detector
// re-finding the same problem, and a mute stops a row from ever being written
// rather than merely hiding one that was. Everything else here exercises
// `admin/attention.ts` directly, the same split `investments.test.mjs` uses.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import {
  addAttentionMute,
  attentionSeverityCounts,
  bulkDismissAttention,
  countAttentionByFilter,
  dismissAttention,
  getAdminSpaceIds,
  listAttention,
  listAttentionMutes,
  removeAttentionMute,
  snoozeAttention,
  undoDismissAttention,
} from "../dist/admin/index.js";
import { openCorrection, supersedeOpenCorrections } from "../dist/extraction/index.js";
import {
  identityDatabase,
  makeMember,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-19T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// `listAttention` defaults `severity` to `['attention', 'alert']` (section
// 5's "default view ... info items are one click away"), and every fixture
// here opens through `openGateFailure`, which -- like every extraction
// correction -- defaults to `info`. Most of these tests are about state,
// not severity, so they ask for every severity explicitly rather than
// re-proving the default on each one; `attentionSeverityCounts` and the
// dedicated severity test below are what prove the default itself.
const ALL_SEVERITIES = ["info", "attention", "alert"];

async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  return {
    ...database,
    userId,
    spaceId,
    principal: { userId, credentialId: null },
  };
}

/** A bare `source_items` row: enough for `target_kind = 'document'`'s join
 * to `si.title`, with none of the provenance chain a real ingest needs.
 * `workerSourceModifiedAt` is the provider's own modified time -- the
 * `beforeDate` filter's fallback when the document states no date of its
 * own (see the `bulkDismissAttention` test below). */
async function seedSourceItem(client, spaceId, title, workerSourceModifiedAt = null) {
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, title, worker_source_modified_at)
       VALUES ($1, $2, transaction_timestamp(), $3, $4)`,
    [id, spaceId, title, workerSourceModifiedAt],
  );
  return id;
}

/** One gate failure, the shape `model.ts` calls `openCorrection` with. */
function openGateFailure(client, spaceId, sourceItemId, reason = "quote_not_found") {
  return openCorrection(client, {
    spaceId,
    sourceItemId,
    fieldName: "total",
    reason,
    reading: { type: "text", value: "21.60" },
  });
}

test("a dismissal is remembered across a re-run that finds the same failure", { skip }, async (t) => {
  const f = await fixture(t);
  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");

  const id = await openGateFailure(f.client, f.spaceId, itemId);
  assert.ok(id);
  const ctx = f.ctx(NOW);
  await dismissAttention(ctx, {
    principal: f.principal,
    id,
    reason: "not_worth_backfilling",
  });

  // The same detector re-finding the same field/reason must not reopen it,
  // whatever the run does around it.
  await supersedeOpenCorrections(f.client, { spaceId: f.spaceId, sourceItemId: itemId });
  const again = await openGateFailure(f.client, f.spaceId, itemId);
  assert.equal(again, id);

  const row = (
    await f.client.query("SELECT state, dismiss_reason FROM kith.corrections WHERE id = $1", [id])
  ).rows[0];
  assert.equal(row.state, "dismissed");
  assert.equal(row.dismiss_reason, "not_worth_backfilling");

  // The default (open) view never shows it.
  const list = await listAttention(ctx, { principal: f.principal });
  assert.deepEqual(list.items, []);
});

test("a mute stops a new item from ever being written", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await addAttentionMute(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    scopeKind: "detector",
    scopeValue: "extraction",
  });

  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
  const id = await openGateFailure(f.client, f.spaceId, itemId);
  assert.equal(id, null);
  assert.deepEqual((await listAttention(ctx, { principal: f.principal })).items, []);

  // Removing the mute lets the next run open it.
  const mutes = await listAttentionMutes(ctx, { principal: f.principal });
  assert.equal(mutes.length, 1);
  await removeAttentionMute(ctx, { principal: f.principal, id: mutes[0].id });
  const reopened = await openGateFailure(f.client, f.spaceId, itemId);
  assert.ok(reopened);
});

test("auto-close: a field that is now read correctly resolves as 'cleared', not by the owner", { skip }, async (t) => {
  const f = await fixture(t);
  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
  const id = await openGateFailure(f.client, f.spaceId, itemId);

  const cleared = await supersedeOpenCorrections(f.client, {
    spaceId: f.spaceId,
    sourceItemId: itemId,
  });
  assert.equal(cleared, 1);
  const row = (
    await f.client.query("SELECT state, reason, resolved_at FROM kith.corrections WHERE id = $1", [id])
  ).rows[0];
  assert.equal(row.state, "resolved");
  assert.equal(row.reason, "cleared");
  assert.ok(row.resolved_at);

  const ctx = f.ctx(NOW);
  assert.deepEqual((await listAttention(ctx, { principal: f.principal })).items, []);
});

test("undo puts a dismissed item back to open", { skip }, async (t) => {
  const f = await fixture(t);
  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
  const id = await openGateFailure(f.client, f.spaceId, itemId);
  const ctx = f.ctx(NOW);
  await dismissAttention(ctx, { principal: f.principal, id, reason: "duplicate" });
  assert.equal((await listAttention(ctx, { principal: f.principal })).items.length, 0);

  await undoDismissAttention(ctx, { principal: f.principal, id });
  const list = await listAttention(ctx, { principal: f.principal, severity: ALL_SEVERITIES });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].state, "open");
  assert.equal(list.items[0].dismissedAt, null);

  await assert.rejects(
    undoDismissAttention(ctx, { principal: f.principal, id }),
    /not dismissed/,
  );
});

test("a snoozed item wakes up on its own once the date passes", { skip }, async (t) => {
  const f = await fixture(t);
  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
  const id = await openGateFailure(f.client, f.spaceId, itemId);
  const ctx = f.ctx(NOW);
  await snoozeAttention(ctx, {
    principal: f.principal,
    id,
    until: "2026-09-26",
  });

  assert.deepEqual(
    (
      await listAttention(f.ctx(NOW), { principal: f.principal, severity: ALL_SEVERITIES })
    ).items,
    [],
  );
  // Still asleep the day before it wakes.
  assert.deepEqual(
    (
      await listAttention(f.ctx(Date.parse("2026-09-25T23:00:00Z")), {
        principal: f.principal,
        severity: ALL_SEVERITIES,
      })
    ).items,
    [],
  );
  // Awake once the date passes -- read time, no sweep needed.
  const awake = await listAttention(f.ctx(Date.parse("2026-09-27T00:00:00Z")), {
    principal: f.principal,
    severity: ALL_SEVERITIES,
  });
  assert.equal(awake.items.length, 1);
  assert.equal(awake.items[0].id, id);
});

test("bulk dismiss by id and by 'before date' each remember what they touched", { skip }, async (t) => {
  const f = await fixture(t);
  // `beforeDate` reads the *document's* date, not when the correction row
  // was opened (both are opened "now" here, deliberately, to prove that):
  // the old one's fallback is its file's own provider-reported modified
  // time, since it was never extracted and so has no occurrence date.
  const older = await seedSourceItem(
    f.client,
    f.spaceId,
    "Old receipt",
    "2020-01-01T00:00:00Z",
  );
  const newer = await seedSourceItem(f.client, f.spaceId, "New receipt", "2026-09-01T00:00:00Z");
  const oldId = await openGateFailure(f.client, f.spaceId, older);
  const newId = await openGateFailure(f.client, f.spaceId, newer);

  const ctx = f.ctx(NOW);
  const result = await bulkDismissAttention(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    filter: { kind: "beforeDate", beforeDate: "2025-01-01" },
    reason: "not_worth_backfilling",
  });
  assert.equal(result.count, 1);
  const remaining = await listAttention(ctx, {
    principal: f.principal,
    severity: ALL_SEVERITIES,
  });
  assert.deepEqual(remaining.items.map((item) => item.id), [newId]);

  const byIds = await bulkDismissAttention(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    filter: { kind: "ids", ids: [newId] },
    reason: "other",
  });
  assert.equal(byIds.count, 1);
  assert.deepEqual((await listAttention(ctx, { principal: f.principal })).items, []);
});

test("severity counts include only attention and alert, never info", { skip }, async (t) => {
  const f = await fixture(t);
  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
  // The only producer today (extraction) always opens at the default
  // severity, `info`.
  await openGateFailure(f.client, f.spaceId, itemId);
  const ctx = f.ctx(NOW);
  assert.deepEqual(await attentionSeverityCounts(ctx, { principal: f.principal }), {
    attention: 0,
    alert: 0,
  });

  await f.client.query(
    "UPDATE kith.corrections SET severity = 'attention' WHERE target_id = $1",
    [itemId],
  );
  assert.deepEqual(await attentionSeverityCounts(ctx, { principal: f.principal }), {
    attention: 1,
    alert: 0,
  });
});

test("a reader administers no space and a stranger's items are invisible", { skip }, async (t) => {
  const f = await fixture(t);
  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
  const id = await openGateFailure(f.client, f.spaceId, itemId);

  const readerId = await makeUser(f.ctx(NOW), { name: "Reader" });
  await makeMember(f.ctx(NOW), { spaceId: f.spaceId, userId: readerId, role: "reader" });
  const reader = { userId: readerId, credentialId: null };
  const readerCtx = f.ctx(NOW);
  assert.deepEqual(await getAdminSpaceIds(readerCtx, reader), []);
  assert.deepEqual((await listAttention(readerCtx, { principal: reader })).items, []);
  await assert.rejects(
    dismissAttention(readerCtx, { principal: reader, id, reason: "other" }),
    /Attention item not found/,
  );

  // A stranger in a different space cannot see or touch it either, and the
  // denial does not confirm the row exists.
  const strangerId = await makeUser(f.ctx(NOW), { name: "Stranger" });
  const otherSpaceId = await makeSpace(f.ctx(NOW), {
    createdBy: strangerId,
    memberId: strangerId,
    role: "owner",
  });
  const stranger = { userId: strangerId, credentialId: null };
  const strangerCtx = f.ctx(NOW);
  assert.deepEqual(
    (await listAttention(strangerCtx, { principal: stranger })).items,
    [],
  );
  await assert.rejects(
    dismissAttention(strangerCtx, { principal: stranger, id, reason: "other" }),
    /Attention item not found/,
  );
  void otherSpaceId;
});

// ---------------------------------------------------------------------------
// State-machine transitions (independent review, blockers 1 and 2): every
// UPDATE in dismissAttention/snoozeAttention has to leave the row obeying
// every CHECK constraint it could possibly cross, not just the one the
// review happened to name. Table-driven over every starting state.
// ---------------------------------------------------------------------------

/** Puts a fresh row into exactly one starting state, synthetically -- direct
 * SQL rather than round-tripping through every action, so this test is
 * about the transition *out* of a state, not how the fixture got there. */
async function seedInState(f, itemId, state) {
  const id = await openGateFailure(f.client, f.spaceId, itemId);
  if (state === "open") return id;
  if (state === "dismissed") {
    await dismissAttention(f.ctx(NOW), { principal: f.principal, id, reason: "other" });
    return id;
  }
  if (state === "snoozed") {
    await snoozeAttention(f.ctx(NOW), { principal: f.principal, id, until: "2026-10-01" });
    return id;
  }
  if (state === "resolved_by_owner") {
    await f.client.query(
      `UPDATE kith.corrections
          SET state = 'resolved', resolved_at = transaction_timestamp(),
              corrected_value = '{"type":"text","value":"fixed"}'::jsonb
        WHERE id = $1`,
      [id],
    );
    return id;
  }
  if (state === "resolved_cleared") {
    await supersedeOpenCorrections(f.client, { spaceId: f.spaceId, sourceItemId: itemId });
    return id;
  }
  throw new Error(`unknown state ${state}`);
}

const STARTING_STATES = ["open", "snoozed", "dismissed", "resolved_by_owner", "resolved_cleared"];

test("dismiss never violates a CHECK constraint, from any starting state", { skip }, async (t) => {
  for (const state of STARTING_STATES) {
    const f = await fixture(t);
    const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
    const id = await seedInState(f, itemId, state);
    const ctx = f.ctx(NOW);
    const action = () =>
      dismissAttention(ctx, { principal: f.principal, id, reason: "not_worth_backfilling" });
    if (state === "resolved_by_owner" || state === "resolved_cleared") {
      await assert.rejects(action(), /already resolved/, `dismiss from ${state}`);
      continue;
    }
    await action();
    const row = (
      await f.client.query(
        `SELECT state, dismissed_at, snoozed_until, resolved_at, dismiss_reason
           FROM kith.corrections WHERE id = $1`,
        [id],
      )
    ).rows[0];
    assert.equal(row.state, "dismissed", state);
    assert.ok(row.dismissed_at, `${state}: dismissed_at`);
    assert.equal(row.snoozed_until, null, `${state}: snoozed_until`);
    assert.equal(row.resolved_at, null, `${state}: resolved_at`);
    assert.equal(row.dismiss_reason, "not_worth_backfilling", state);
  }
});

test("snooze never violates a CHECK constraint, from any starting state", { skip }, async (t) => {
  for (const state of STARTING_STATES) {
    const f = await fixture(t);
    const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
    const id = await seedInState(f, itemId, state);
    const ctx = f.ctx(NOW);
    const action = () =>
      snoozeAttention(ctx, { principal: f.principal, id, until: "2026-11-01" });
    if (state === "dismissed") {
      await assert.rejects(action(), /dismissed; undo it/, `snooze from ${state}`);
      continue;
    }
    if (state === "resolved_by_owner" || state === "resolved_cleared") {
      await assert.rejects(action(), /already resolved/, `snooze from ${state}`);
      continue;
    }
    await action();
    const row = (
      await f.client.query(
        `SELECT state, dismissed_at, snoozed_until, resolved_at, dismiss_reason
           FROM kith.corrections WHERE id = $1`,
        [id],
      )
    ).rows[0];
    assert.equal(row.state, "snoozed", state);
    assert.ok(row.snoozed_until, `${state}: snoozed_until`);
    assert.equal(row.dismissed_at, null, `${state}: dismissed_at`);
    assert.equal(row.dismiss_reason, null, `${state}: dismiss_reason`);
    assert.equal(row.resolved_at, null, `${state}: resolved_at`);
  }
});

// ---------------------------------------------------------------------------
// Mute scopes (independent review, major 3): document_kind and source_root
// actually suppress a new item once openCorrection resolves and passes them,
// and investment/before_date are refused as mute scopes in this slice.
// ---------------------------------------------------------------------------

test("a document_kind mute suppresses a new item of that kind", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await addAttentionMute(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    scopeKind: "document_kind",
    scopeValue: "receipt",
  });
  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
  const muted = await openCorrection(f.client, {
    spaceId: f.spaceId,
    sourceItemId: itemId,
    fieldName: "total",
    reason: "quote_not_found",
    reading: { type: "text", value: "21.60" },
    documentKind: "receipt",
  });
  assert.equal(muted, null);

  // A different kind on the same detector is unaffected.
  const otherItemId = await seedSourceItem(f.client, f.spaceId, "Invoice");
  const opened = await openCorrection(f.client, {
    spaceId: f.spaceId,
    sourceItemId: otherItemId,
    fieldName: "total",
    reason: "quote_not_found",
    reading: { type: "text", value: "21.60" },
    documentKind: "invoice",
  });
  assert.ok(opened);
});

test("a source_root mute suppresses a new item from that root", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const rootId = newKithId();
  await addAttentionMute(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    scopeKind: "source_root",
    scopeValue: rootId,
  });
  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
  const muted = await openCorrection(f.client, {
    spaceId: f.spaceId,
    sourceItemId: itemId,
    fieldName: "total",
    reason: "quote_not_found",
    reading: { type: "text", value: "21.60" },
    sourceRootId: rootId,
  });
  assert.equal(muted, null);
});

test("investment and before_date are refused as mute scopes in this slice", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await assert.rejects(
    addAttentionMute(ctx, {
      principal: f.principal,
      spaceId: f.spaceId,
      scopeKind: "investment",
      scopeValue: newKithId(),
    }),
  );
  await assert.rejects(
    addAttentionMute(ctx, {
      principal: f.principal,
      spaceId: f.spaceId,
      scopeKind: "before_date",
      scopeValue: "2020-01-01",
    }),
  );
});

// ---------------------------------------------------------------------------
// The insert race (independent review, minor 5): two writers reaching
// openCorrection's INSERT for the same dedupe_key must not abort either
// transaction. A true concurrent race is timing-dependent to construct
// deterministically; this instead proves the mechanism that closes it --
// `ON CONFLICT ... DO UPDATE` -- by making the "second writer" case
// happen every time: pre-seed the exact row a concurrent insert would have
// produced, then call openCorrection and confirm it reconciles rather than
// throwing.
// ---------------------------------------------------------------------------

test("a concurrent insert for the same dedupe_key reconciles instead of aborting", { skip }, async (t) => {
  const f = await fixture(t);
  const itemId = await seedSourceItem(f.client, f.spaceId, "Receipt");
  const dedupeKey = `extraction:${itemId}:total:quote_not_found`;
  // The row a "winning" concurrent writer already committed.
  const winnerId = newKithId();
  await f.client.query(
    `INSERT INTO kith.corrections
       (id, space_id, target_kind, target_id, field_name, original_value,
        reason, state, dedupe_key)
     VALUES ($1,$2,'document',$3,'total','{"type":"text","value":"stale"}'::jsonb,
             'quote_not_found','open',$4)`,
    [winnerId, f.spaceId, itemId, dedupeKey],
  );
  // Our own call never ran the SELECT-finds-nothing branch in this test --
  // it does not need to, to prove the INSERT itself does not blow up when it
  // turns out a row is already there.
  const result = await openCorrection(f.client, {
    spaceId: f.spaceId,
    sourceItemId: itemId,
    fieldName: "total",
    reason: "quote_not_found",
    reading: { type: "text", value: "fresh" },
  });
  assert.equal(result, winnerId);
  const rows = (
    await f.client.query("SELECT id, original_value FROM kith.corrections WHERE dedupe_key = $1", [
      dedupeKey,
    ])
  ).rows;
  assert.equal(rows.length, 1, "no duplicate row");
  assert.equal(rows[0].original_value.value, "fresh");
});

// ---------------------------------------------------------------------------
// The bulk-dismiss preview count (independent review, minor 7).
// ---------------------------------------------------------------------------

test("countAttentionByFilter previews a bulk dismiss without touching anything", { skip }, async (t) => {
  const f = await fixture(t);
  const a = await seedSourceItem(f.client, f.spaceId, "A", "2020-01-01T00:00:00Z");
  const b = await seedSourceItem(f.client, f.spaceId, "B", "2020-02-01T00:00:00Z");
  await openGateFailure(f.client, f.spaceId, a);
  await openGateFailure(f.client, f.spaceId, b);
  const ctx = f.ctx(NOW);

  const count = await countAttentionByFilter(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    filter: { kind: "beforeDate", beforeDate: "2025-01-01" },
  });
  assert.equal(count, 2);

  // Nothing was touched: both still show up in the full list.
  const list = await listAttention(ctx, { principal: f.principal, severity: ALL_SEVERITIES });
  assert.equal(list.items.length, 2);
});
