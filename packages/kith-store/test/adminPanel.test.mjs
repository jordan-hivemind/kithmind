// The admin panel's store surface and the change feed (ADM-1).
//
// Against a real database, because every claim here is a claim about the
// schema: that the triggers migration 023 attaches actually write a change
// row, that the composite foreign keys migration 022 declares refuse a
// cross-space reference, that `listChangesSince` returns another space's
// changes to nobody, and that the money column keeps exact decimals.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import {
  getAdminSpaceIds,
  isChangeCursor,
  latestChangeId,
  listChangesSince,
  listSourceRoots,
  listSourcesInventory,
  upsertSourceRoot,
  upsertSourceRootReport,
} from "../dist/admin/index.js";
import { deferredCtx, removeExpiredChanges } from "../dist/deferred/index.js";
import {
  identityDatabase,
  makeMember,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-18T12:00:00Z");

async function makeSourceAccount(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, created_by)
     VALUES ($1,$2,to_timestamp($3/1000.0),'fs',$4,$5,$6,0,60000,$7)`,
    [
      id,
      fields.spaceId,
      NOW,
      fields.accountId ?? `acct-${id}`,
      fields.name ?? "Synthetic folder",
      fields.enabled ?? true,
      fields.createdBy,
    ],
  );
  return id;
}

async function makeSourceItem(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id, forgotten_at)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6)`,
    [
      id,
      fields.spaceId,
      NOW,
      fields.sourceAccountId,
      `ext-${id}`,
      fields.forgottenAt ?? null,
    ],
  );
  return id;
}

/** One owner, one space, one enabled source account. */
async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const sourceAccountId = await makeSourceAccount(ctx, {
    spaceId,
    createdBy: userId,
    name: "Provider folder",
  });
  return {
    ...database,
    userId,
    spaceId,
    sourceAccountId,
    principal: { userId, credentialId: null },
  };
}

test("the sources inventory joins root, items, watcher and report", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await makeSourceItem(ctx, {
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  });
  await makeSourceItem(ctx, {
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  });
  // A forgotten item is not inventory: the screen counts what the system
  // holds, not what it has ever seen.
  await makeSourceItem(ctx, {
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    forgottenAt: new Date(NOW),
  });

  const rootId = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    providerFolderId: "provider-folder-1",
    lastKnownPath: "/synthetic/statements",
    area: "finance",
    expectedTypes: ["statement"],
  });
  await upsertSourceRootReport(ctx, {
    principal: f.principal,
    sourceRootId: rootId,
    watcherId: "synthetic-host",
    observedAt: NOW - 60_000,
    itemCount: 2,
    skipped: [{ path: "/synthetic/statements/x.heic", reason: "unsupported" }],
  });

  const [source] = await listSourcesInventory(ctx, { principal: f.principal });
  assert.equal(source.name, "Provider folder");
  assert.equal(source.area, "finance");
  assert.equal(source.kind, "folder");
  assert.equal(source.location, "/synthetic/statements");
  assert.equal(source.itemCount, 2);
  assert.equal(source.skippedCount, 1);
  assert.equal(source.lastReadAt, NOW - 60_000);
  // No watcher row yet, so the source is pending rather than failing.
  assert.equal(source.watcher, "not_configured");
  assert.equal(source.status, "pending");

  // The root is an upsert: a second call rewrites the same row, which is what
  // the watcher does every pass when a folder has been renamed.
  const again = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    providerFolderId: "provider-folder-1",
    lastKnownPath: "/synthetic/renamed",
    area: "finance",
  });
  assert.equal(again, rootId);
  const roots = await listSourceRoots(ctx, { principal: f.principal });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].lastKnownPath, "/synthetic/renamed");
  assert.deepEqual(roots[0].expectedTypes, []);
});

test("a reported problem and a disabled source get their own status", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const rootId = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
  });
  await upsertSourceRootReport(ctx, {
    principal: f.principal,
    sourceRootId: rootId,
    observedAt: NOW,
    problem: "folder not found",
  });
  assert.equal(
    (await listSourcesInventory(ctx, { principal: f.principal }))[0].status,
    "problem",
  );

  await ctx.client.query(
    "UPDATE kith.source_accounts SET enabled = false WHERE id = $1",
    [f.sourceAccountId],
  );
  const disabled = await listSourcesInventory(ctx, { principal: f.principal });
  assert.equal(disabled[0].status, "disabled");
  // Disabled outranks the problem: nothing is supposed to be happening.
  assert.equal(disabled[0].problem, "folder not found");
});

test("an overdue watcher is overdue and a current one is ok", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await ctx.client.query(
    `INSERT INTO kith.worker_watcher_states
       (id, space_id, source_account_id, watcher_id, state,
        next_expected_at, created_at_field, updated_at)
     VALUES ($1,$2,$3,'synthetic-host','active',
             to_timestamp($4/1000.0), to_timestamp($4/1000.0),
             to_timestamp($4/1000.0))`,
    [newKithId(), f.spaceId, f.sourceAccountId, NOW - 1],
  );
  assert.equal(
    (await listSourcesInventory(ctx, { principal: f.principal }))[0].status,
    "overdue",
  );
  await ctx.client.query(
    `UPDATE kith.worker_watcher_states
        SET next_expected_at = to_timestamp($2/1000.0)
      WHERE source_account_id = $1`,
    [f.sourceAccountId, NOW + 60_000],
  );
  const current = await listSourcesInventory(ctx, { principal: f.principal });
  assert.equal(current[0].watcher, "current");
  assert.equal(current[0].status, "ok");
});

test("a root cannot be written for another member's source account", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const strangerId = await makeUser(ctx, { name: "Stranger" });
  const strangerSpace = await makeSpace(ctx, {
    createdBy: strangerId,
    memberId: strangerId,
    role: "owner",
  });
  const stranger = { userId: strangerId, credentialId: null };

  await assert.rejects(
    upsertSourceRoot(ctx, {
      principal: stranger,
      sourceAccountId: f.sourceAccountId,
      kind: "folder",
    }),
    /Source account not found/,
  );

  // And the other direction: the owner's inventory never shows the stranger's
  // source, even though both live in the same database.
  await makeSourceAccount(ctx, {
    spaceId: strangerSpace,
    createdBy: strangerId,
    name: "Stranger folder",
  });
  const mine = await listSourcesInventory(ctx, { principal: f.principal });
  assert.deepEqual(
    mine.map((source) => source.name),
    ["Provider folder"],
  );
});

test("the change feed records every write and never another space's", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const strangerId = await makeUser(ctx, { name: "Stranger" });
  const strangerSpace = await makeSpace(ctx, {
    createdBy: strangerId,
    memberId: strangerId,
    role: "owner",
  });
  const cursor = await latestChangeId(ctx, [f.spaceId]);

  const rootId = await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    area: "finance",
  });
  await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    area: "home",
  });
  await makeSourceAccount(ctx, {
    spaceId: strangerSpace,
    createdBy: strangerId,
    name: "Stranger folder",
  });

  const mine = await listChangesSince(ctx, [f.spaceId], cursor);
  assert.deepEqual(
    mine.map((change) => [change.table, change.rowId, change.op]),
    [
      ["source_roots", rootId, "insert"],
      ["source_roots", rootId, "update"],
    ],
  );
  // Ids are strings, and strictly increasing.
  assert.ok(mine.every((change) => typeof change.id === "string"));
  assert.ok(BigInt(mine[1].id) > BigInt(mine[0].id));

  // The stranger's own feed holds the stranger's row and nothing of ours.
  const theirs = await listChangesSince(ctx, [strangerSpace], "0");
  assert.deepEqual(
    theirs.map((change) => change.table),
    ["source_accounts"],
  );

  // The cursor is exclusive: reading from the last id returns nothing.
  assert.deepEqual(await listChangesSince(ctx, [f.spaceId], mine[1].id), []);

  // A delete is a change too, and carries the id of the row that went away.
  await ctx.client.query("DELETE FROM kith.source_roots WHERE id = $1", [rootId]);
  const after = await listChangesSince(ctx, [f.spaceId], mine[1].id);
  assert.deepEqual(
    after.map((change) => [change.table, change.rowId, change.op]),
    [["source_roots", rootId, "delete"]],
  );
});

test("listChangesSince refuses an empty space set and a bad cursor", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await assert.rejects(() => listChangesSince(ctx, [], "0"), /unauthorized/);
  await assert.rejects(
    () => listChangesSince(ctx, [f.spaceId], "1; DROP TABLE kith.changes"),
    /invalid_cursor/,
  );
  await assert.rejects(
    () => listChangesSince(ctx, [f.spaceId], "0", 0),
    /invalid_limit/,
  );
});

test("the prune sweep drops change rows past the retention", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
  });
  const old = NOW - 4 * 86_400_000;
  await ctx.client.query(
    "UPDATE kith.changes SET committed_at = to_timestamp($1/1000.0)",
    [old],
  );
  const kept = await ctx.client.query(
    `INSERT INTO kith.changes (space_id, table_name, row_id, op)
     VALUES ($1,'source_roots','recent','insert') RETURNING id::text AS id`,
    [f.spaceId],
  );

  const swept = await removeExpiredChanges(deferredCtx(ctx.client, NOW));
  assert.ok(swept.removed >= 1);
  assert.equal(swept.remaining, false);
  const remaining = await listChangesSince(ctx, [f.spaceId], "0");
  assert.deepEqual(
    remaining.map((change) => change.id),
    [kept.rows[0].id],
  );
  // Idempotent: a second pass finds nothing.
  assert.deepEqual(await removeExpiredChanges(deferredCtx(ctx.client, NOW)), {
    removed: 0,
    remaining: false,
  });
});

test("an investment entry keeps an exact decimal and a closed entry type", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const investmentId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.investments (id, space_id, name, category, status)
     VALUES ($1,$2,'Synthetic Fund I','venture','active')`,
    [investmentId, f.spaceId],
  );
  await ctx.client.query(
    `INSERT INTO kith.investment_entries
       (id, space_id, investment_id, entry_type, entry_date, amount, currency)
     VALUES ($1,$2,$3,'capital_call_paid','2026-03-01',$4,'USD')`,
    [newKithId(), f.spaceId, investmentId, "1234567.89"],
  );
  const stored = await ctx.client.query(
    "SELECT amount, entry_type FROM kith.investment_entries WHERE investment_id = $1",
    [investmentId],
  );
  // node-pg leaves `numeric` as text, so the cent survives the round trip.
  assert.equal(stored.rows[0].amount, "1234567.89");
  assert.equal(stored.rows[0].entry_type, "capital_call_paid");

  await assert.rejects(
    ctx.client.query(
      `INSERT INTO kith.investment_entries
         (id, space_id, investment_id, entry_type, entry_date, amount, currency)
       VALUES ($1,$2,$3,'refund','2026-03-01',1,'USD')`,
      [newKithId(), f.spaceId, investmentId],
    ),
    /investment_entries_entry_type_check/,
  );
  await assert.rejects(
    ctx.client.query(
      `INSERT INTO kith.investment_entries
         (id, space_id, investment_id, entry_type, entry_date, amount, currency)
       VALUES ($1,$2,$3,'fee','2026-03-01',1,'usd')`,
      [newKithId(), f.spaceId, investmentId],
    ),
    /investment_entries_currency_check/,
  );
});

test("a cross-space reference is unrepresentable, not merely unqueried", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const strangerId = await makeUser(ctx, { name: "Stranger" });
  const strangerSpace = await makeSpace(ctx, {
    createdBy: strangerId,
    memberId: strangerId,
    role: "owner",
  });
  // A root in the stranger's space pointing at the owner's source account.
  await assert.rejects(
    ctx.client.query(
      `INSERT INTO kith.source_roots (id, space_id, source_account_id, kind)
       VALUES ($1,$2,$3,'folder')`,
      [newKithId(), strangerSpace, f.sourceAccountId],
    ),
    /source_roots_source_account_id_space_id_fkey/,
  );
});

test("only an owner or editor sees the sources inventory", { skip }, async (t) => {
  // The admin screens carry operational detail -- the watcher host's
  // filesystem path, the problem text it reported, the account's id -- which
  // a `reader` member of the space is not entitled to. `getAdminSpaceIds`
  // narrows the readable set to the writable one, and every admin read goes
  // through it.
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    lastKnownPath: "/synthetic/statements",
    area: "finance",
  });

  const editorId = await makeUser(ctx, { name: "Editor" });
  await makeMember(ctx, { spaceId: f.spaceId, userId: editorId, role: "editor" });
  const editor = { userId: editorId, credentialId: null };

  const readerId = await makeUser(ctx, { name: "Reader" });
  await makeMember(ctx, { spaceId: f.spaceId, userId: readerId, role: "reader" });
  const reader = { userId: readerId, credentialId: null };

  assert.deepEqual(await getAdminSpaceIds(ctx, f.principal), [f.spaceId]);
  assert.deepEqual(await getAdminSpaceIds(ctx, editor), [f.spaceId]);
  // The reader can read the space -- it is a member -- and still administers
  // nothing, which is what the web layer turns into a 404.
  assert.deepEqual(await getAdminSpaceIds(ctx, reader), []);

  assert.equal((await listSourcesInventory(ctx, { principal: editor })).length, 1);
  assert.deepEqual(await listSourcesInventory(ctx, { principal: reader }), []);
  assert.deepEqual(await listSourceRoots(ctx, { principal: reader }), []);

  // Naming the space explicitly does not get the reader past it either.
  assert.deepEqual(
    await listSourcesInventory(ctx, {
      principal: reader,
      spaceIds: [f.spaceId],
    }),
    [],
  );
});

test("a cursor past the bigint ceiling is not a cursor", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  assert.equal(isChangeCursor("0"), true);
  assert.equal(isChangeCursor("9223372036854775807"), true);
  assert.equal(isChangeCursor("9223372036854775808"), false);
  assert.equal(isChangeCursor("9999999999999999999"), false);
  assert.equal(isChangeCursor("-1"), false);
  assert.equal(isChangeCursor("1e3"), false);
  // And the read refuses it before it reaches a statement, so an out-of-range
  // cast never becomes a database error the caller sees as a server fault.
  await assert.rejects(
    () => listChangesSince(ctx, [f.spaceId], "9223372036854775808"),
    /invalid_cursor/,
  );
});
