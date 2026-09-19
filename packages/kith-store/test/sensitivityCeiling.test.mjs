// Sensitivity labelling and the opt-in ceiling, against a real database.
//
// The claims here are claims about SQL -- what `kith.document_sensitivity`
// computes from four tables, and what `applyCeiling` drops -- so none of them
// is provable against a fake client.
//
// The most important test in this file is the first one. The owner's decision
// (migration 029's header) is that his own credentials see everything, so the
// default ceiling must return every document and must not even issue the
// sensitivity query. Every other test here describes a restriction the owner
// deliberately chose for one credential.
//
// All data is synthetic: invented space, user, account and document rows.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import {
  applyCeiling,
  ceilingWhereSql,
  documentSensitivity,
  DEFAULT_MAX_SENSITIVITY,
  maxSensitivity,
  sourceItemSensitivity,
  withinCeiling,
} from "../dist/sensitivity/index.js";
import { setApiKeyMaxSensitivity } from "../dist/identity/index.js";
import {
  identityDatabase,
  makeMember,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-19T12:00:00Z");

async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  return { ...database, ctx, userId, spaceId };
}

/**
 * A document and the provenance chain it needs, optionally under a watched
 * root and optionally with an owner override on the item.
 */
async function seedDocument(ctx, spaceId, input) {
  const sourceAccountId = input.sourceAccountId ?? newKithId();
  const sourceItemId = newKithId();
  const generationId = newKithId();
  const documentId = newKithId();
  if (!input.sourceAccountId) {
    await ctx.client.query(
      `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
         VALUES ($1, $2, transaction_timestamp(), 'synthetic', true)`,
      [sourceAccountId, spaceId],
    );
  }
  await ctx.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id_hash, title,
        uri, lifecycle, original_link_available, desired_processing_epoch,
        sensitivity)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'available',
               true, 0, $7)`,
    [
      sourceItemId,
      spaceId,
      sourceAccountId,
      `${sourceItemId}`.padEnd(64, "a").slice(0, 64),
      input.title,
      input.uri ?? null,
      input.itemSensitivity ?? null,
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id,
        desired_processing_epoch, card_generation, state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 0, false, 'ready')`,
    [generationId, spaceId, sourceAccountId, sourceItemId],
  );
  await ctx.client.query(
    `INSERT INTO kith.documents
       (id, space_id, created_at, processing_generation_id, source_item_id,
        document_key, title, doc_type, captured_at, evidence_span_ids,
        publication_state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7,
               transaction_timestamp(), '[]'::jsonb, 'active')`,
    [
      documentId,
      spaceId,
      generationId,
      sourceItemId,
      `doc-${documentId}`,
      input.title,
      input.docType ?? "note",
    ],
  );
  return { documentId, sourceItemId, sourceAccountId };
}

/** A document kind carrying a level. */
async function seedType(ctx, spaceId, kind, sensitivity) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.document_types
       (id, space_id, created_at, kind, description, guidance, version, active,
        sensitivity)
       VALUES ($1, $2, transaction_timestamp(), $3, 'synthetic', '', 1, true, $4)`,
    [id, spaceId, kind, sensitivity],
  );
  return id;
}

test("a label on its own withholds nothing: the default ceiling returns all", { skip }, async (t) => {
  const { ctx, spaceId } = await fixture(t);
  await seedType(ctx, spaceId, "tax_return", "restricted");
  await seedType(ctx, spaceId, "bank_statement", "sensitive");
  const ordinary = await seedDocument(ctx, spaceId, { title: "Receipt" });
  const bank = await seedDocument(ctx, spaceId, {
    title: "Statement",
    docType: "bank_statement",
  });
  const tax = await seedDocument(ctx, spaceId, {
    title: "1040",
    docType: "tax_return",
  });

  const rows = [ordinary, bank, tax];
  // `DEFAULT_MAX_SENSITIVITY` is what every credential the owner has not
  // narrowed carries. Nothing is withheld, including the tax return.
  assert.equal(DEFAULT_MAX_SENSITIVITY, "restricted");
  const all = await applyCeiling(
    ctx.client,
    rows,
    (row) => row.documentId,
    DEFAULT_MAX_SENSITIVITY,
  );
  assert.equal(all.visible.length, 3, "the owner's own credential sees everything");
  assert.equal(all.withheld, 0);
});

test("the levels are still computed and readable, for the UI to show", { skip }, async (t) => {
  const { ctx, spaceId } = await fixture(t);
  await seedType(ctx, spaceId, "tax_return", "restricted");
  await seedType(ctx, spaceId, "bank_statement", "sensitive");
  const ordinary = await seedDocument(ctx, spaceId, { title: "Receipt" });
  const bank = await seedDocument(ctx, spaceId, {
    title: "Statement",
    docType: "bank_statement",
  });
  const tax = await seedDocument(ctx, spaceId, {
    title: "1040",
    docType: "tax_return",
  });

  const levels = await documentSensitivity(ctx.client, [
    ordinary.documentId,
    bank.documentId,
    tax.documentId,
  ]);
  assert.equal(levels.get(ordinary.documentId), "normal");
  assert.equal(levels.get(bank.documentId), "sensitive");
  assert.equal(levels.get(tax.documentId), "restricted");
});

test("an override on the item raises, and never lowers", { skip }, async (t) => {
  const { ctx, spaceId } = await fixture(t);
  await seedType(ctx, spaceId, "tax_return", "restricted");
  // An unlabelled kind, raised by the owner's own override on the item.
  const raised = await seedDocument(ctx, spaceId, {
    title: "Scan",
    itemSensitivity: "sensitive",
  });
  // A restricted kind whose item says `normal`. The MAXIMUM wins, so it stays
  // restricted: an override cannot quietly declassify a kind.
  const notLowered = await seedDocument(ctx, spaceId, {
    title: "1040",
    docType: "tax_return",
    itemSensitivity: "normal",
  });

  const levels = await documentSensitivity(ctx.client, [
    raised.documentId,
    notLowered.documentId,
  ]);
  assert.equal(levels.get(raised.documentId), "sensitive");
  assert.equal(
    levels.get(notLowered.documentId),
    "restricted",
    "an override raises only; the kind's own level survives it",
  );
});

test("marking a folder marks every document under it", { skip }, async (t) => {
  const { ctx, spaceId } = await fixture(t);
  const sourceAccountId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
       VALUES ($1, $2, transaction_timestamp(), 'synthetic', true)`,
    [sourceAccountId, spaceId],
  );
  await ctx.client.query(
    `INSERT INTO kith.source_roots
       (id, space_id, created_at, source_account_id, kind, root_alias,
        relative_path, sensitivity)
       VALUES ($1, $2, transaction_timestamp(), $3, 'folder', 'documents',
               'Taxes', 'restricted')`,
    [newKithId(), spaceId, sourceAccountId],
  );

  const underRoot = await seedDocument(ctx, spaceId, {
    title: "1040",
    sourceAccountId,
    uri: "fs://documents/Taxes/2025/1040.pdf",
  });
  // The trailing-slash rule: a sibling folder whose name merely starts the
  // same way is NOT under the marked root.
  const sibling = await seedDocument(ctx, spaceId, {
    title: "Notes",
    sourceAccountId,
    uri: "fs://documents/Taxes Archive/notes.pdf",
  });

  const levels = await documentSensitivity(ctx.client, [
    underRoot.documentId,
    sibling.documentId,
  ]);
  assert.equal(levels.get(underRoot.documentId), "restricted");
  assert.equal(
    levels.get(sibling.documentId),
    "normal",
    "'Taxes' must not match 'Taxes Archive'",
  );
});

test("a lowered ceiling withholds, and reports a count", { skip }, async (t) => {
  const { ctx, spaceId } = await fixture(t);
  await seedType(ctx, spaceId, "tax_return", "restricted");
  await seedType(ctx, spaceId, "bank_statement", "sensitive");
  const ordinary = await seedDocument(ctx, spaceId, { title: "Receipt" });
  const bank = await seedDocument(ctx, spaceId, {
    title: "Statement",
    docType: "bank_statement",
  });
  const tax = await seedDocument(ctx, spaceId, {
    title: "1040",
    docType: "tax_return",
  });
  const rows = [ordinary, bank, tax];

  // Lowered one notch: the tax return goes, the statement stays.
  const upToSensitive = await applyCeiling(
    ctx.client,
    rows,
    (row) => row.documentId,
    "sensitive",
  );
  assert.deepEqual(
    upToSensitive.visible.map((row) => row.documentId).sort(),
    [ordinary.documentId, bank.documentId].sort(),
  );
  assert.equal(upToSensitive.withheld, 1);

  // Lowered to the bottom: a key at `normal` sees NEITHER the sensitive nor
  // the restricted document, and is told two were withheld.
  const ordinaryOnly = await applyCeiling(
    ctx.client,
    rows,
    (row) => row.documentId,
    "normal",
  );
  assert.deepEqual(ordinaryOnly.visible.map((row) => row.documentId), [
    ordinary.documentId,
  ]);
  assert.equal(
    ordinaryOnly.withheld,
    2,
    "a count, so an assistant can say so rather than conclude nothing exists",
  );
});

test("the withheld count names nothing about what was withheld", { skip }, async (t) => {
  const { ctx, spaceId } = await fixture(t);
  await seedType(ctx, spaceId, "tax_return", "restricted");
  await seedDocument(ctx, spaceId, { title: "Receipt" });
  const tax = await seedDocument(ctx, spaceId, {
    title: "Very Identifying Title",
    docType: "tax_return",
  });
  const result = await applyCeiling(
    ctx.client,
    [tax],
    (row) => row.documentId,
    "normal",
  );
  // The whole return value, serialized: the count and the visible rows, and
  // no id, title or level of anything hidden.
  assert.equal(JSON.stringify(result), JSON.stringify({ visible: [], withheld: 1 }));
});

test("cross-space isolation is unchanged by any of this", { skip }, async (t) => {
  const { ctx, userId, spaceId } = await fixture(t);
  // A second space the user is NOT a member of.
  const strangerId = await makeUser(ctx, { name: "Stranger" });
  const otherSpaceId = await makeSpace(ctx, {
    createdBy: strangerId,
    memberId: strangerId,
    role: "owner",
  });
  await seedType(ctx, otherSpaceId, "tax_return", "restricted");
  const theirs = await seedDocument(ctx, otherSpaceId, {
    title: "Their 1040",
    docType: "tax_return",
  });
  const mine = await seedDocument(ctx, spaceId, { title: "My receipt" });

  // The view answers per document regardless of space -- it is a labelling
  // view, not an authorization boundary, and must not be mistaken for one.
  // Authorization stays where it was: the space set the read functions are
  // given. So the level of a document in a space I cannot read is simply not
  // a question I can ask, because the row never reaches `applyCeiling`.
  const visibleRows = [mine];
  const gated = await applyCeiling(
    ctx.client,
    visibleRows,
    (row) => row.documentId,
    "normal",
  );
  assert.deepEqual(gated.visible.map((row) => row.documentId), [mine.documentId]);
  assert.equal(gated.withheld, 0);

  // And the other space's document is still in the database, untouched by the
  // ceiling: nothing here deletes or rewrites anything.
  const levels = await documentSensitivity(ctx.client, [theirs.documentId]);
  assert.equal(levels.get(theirs.documentId), "restricted");
  assert.ok(userId !== strangerId);
});

test("the level comparison helpers are total and ordered", { skip: false }, () => {
  assert.equal(maxSensitivity("normal", "restricted"), "restricted");
  assert.equal(maxSensitivity("sensitive", "normal"), "sensitive");
  assert.equal(withinCeiling("restricted", "restricted"), true);
  assert.equal(withinCeiling("restricted", "sensitive"), false);
  assert.equal(withinCeiling("normal", "normal"), true);
  assert.equal(withinCeiling("sensitive", "normal"), false);
});

// ---------------------------------------------------------------------------
// Coverage beyond search_documents (review follow-up)
// ---------------------------------------------------------------------------

test("the item view and the document view agree about one document", { skip }, async (t) => {
  const { ctx, spaceId } = await fixture(t);
  await seedType(ctx, spaceId, "tax_return", "restricted");
  const tax = await seedDocument(ctx, spaceId, {
    title: "1040",
    docType: "tax_return",
  });
  const ordinary = await seedDocument(ctx, spaceId, { title: "Receipt" });

  // The document view resolves the kind from `doc_type`; the item view cannot
  // see `doc_type` at all, so for a document whose level comes only from its
  // kind name the two legitimately differ -- and that is exactly why the
  // document view exists on top of the item view rather than instead of it.
  const byDocument = await documentSensitivity(ctx.client, [tax.documentId]);
  assert.equal(byDocument.get(tax.documentId), "restricted");

  // An owner override on the ITEM is visible to both, which is the path the
  // record queries and the inventory depend on.
  await ctx.client.query(
    "UPDATE kith.source_items SET sensitivity = $2 WHERE id = $1",
    [ordinary.sourceItemId, "restricted"],
  );
  const byItem = await sourceItemSensitivity(ctx.client, [
    ordinary.sourceItemId,
  ]);
  assert.equal(byItem.get(ordinary.sourceItemId), "restricted");
  const alsoByDocument = await documentSensitivity(ctx.client, [
    ordinary.documentId,
  ]);
  assert.equal(
    alsoByDocument.get(ordinary.documentId),
    "restricted",
    "an item override must reach the document view too",
  );
});

test("applyCeiling at source-item grain withholds and counts", { skip }, async (t) => {
  const { ctx, spaceId } = await fixture(t);
  const open = await seedDocument(ctx, spaceId, { title: "Receipt" });
  const closed = await seedDocument(ctx, spaceId, { title: "Statement" });
  await ctx.client.query(
    "UPDATE kith.source_items SET sensitivity = $2 WHERE id = $1",
    [closed.sourceItemId, "restricted"],
  );
  const rows = [open, closed];

  const full = await applyCeiling(
    ctx.client,
    rows,
    (row) => row.sourceItemId,
    "restricted",
    "sourceItem",
  );
  assert.equal(full.visible.length, 2, "the default ceiling hides nothing");
  assert.equal(full.withheld, 0);

  const narrowed = await applyCeiling(
    ctx.client,
    rows,
    (row) => row.sourceItemId,
    "sensitive",
    "sourceItem",
  );
  assert.deepEqual(narrowed.visible.map((row) => row.sourceItemId), [
    open.sourceItemId,
  ]);
  assert.equal(narrowed.withheld, 1);
});

test("the record-query SQL fragment excludes above-ceiling source items", { skip }, async (t) => {
  const { ctx, spaceId } = await fixture(t);
  const open = await seedDocument(ctx, spaceId, { title: "Receipt" });
  const closed = await seedDocument(ctx, spaceId, { title: "1040" });
  await ctx.client.query(
    "UPDATE kith.source_items SET sensitivity = $2 WHERE id = $1",
    [closed.sourceItemId, "restricted"],
  );

  // The default ceiling produces no SQL at all, so the query the owner's own
  // credential runs is byte for byte the one that ran before this feature.
  assert.equal(
    ceilingWhereSql("restricted", "kith.source_items.id"),
    "",
  );

  // A narrowed ceiling filters in SQL, which is what `sum_money` needs: the
  // aggregation must never see the withheld row.
  const fragment = ceilingWhereSql("sensitive", "kith.source_items.id");
  const rows = await ctx.client.query(
    `SELECT id FROM kith.source_items WHERE space_id = $1${fragment} ORDER BY id`,
    [spaceId],
  );
  assert.deepEqual(
    rows.rows.map((row) => row.id).sort(),
    [open.sourceItemId].sort(),
    "the restricted item must not reach the aggregation",
  );

  // The fragment refuses anything that is not a qualified column reference.
  assert.throws(() =>
    ceilingWhereSql("normal", "kith.source_items.id; DROP TABLE"),
  );
  // And it refuses a BARE column, which would silently bind to the subquery's
  // own `source_item_id` and filter every row away instead of filtering right.
  assert.throws(
    () => ceilingWhereSql("normal", "source_item_id"),
    /qualified/,
  );
});

test("only an owner session may change a key's ceiling", { skip }, async (t) => {
  const { ctx, userId } = await fixture(t);
  const keyId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.api_keys (id, user_id, key_hash, key_prefix, name, capabilities)
       VALUES ($1, $2, $3, 'kith_test_', 'Test key', '["read"]'::jsonb)`,
    [keyId, userId, "a".repeat(64)],
  );

  // A web session has no credentialId, and may narrow the key.
  await setApiKeyMaxSensitivity(ctx, {
    principal: { userId, capabilities: ["read", "write", "ingest"] },
    id: keyId,
    maxSensitivity: "normal",
  });
  const after = await ctx.client.query(
    "SELECT max_sensitivity FROM kith.api_keys WHERE id = $1",
    [keyId],
  );
  assert.equal(after.rows[0].max_sensitivity, "normal");

  // A bearer-authenticated principal carries a credentialId and is refused --
  // including when it is the very key it is trying to widen. A credential that
  // could raise its own ceiling would make the ceiling decorative.
  await assert.rejects(
    setApiKeyMaxSensitivity(ctx, {
      principal: { userId, credentialId: keyId, capabilities: ["read"] },
      id: keyId,
      maxSensitivity: "restricted",
    }),
    /API key not found/,
  );
  const unchanged = await ctx.client.query(
    "SELECT max_sensitivity FROM kith.api_keys WHERE id = $1",
    [keyId],
  );
  assert.equal(
    unchanged.rows[0].max_sensitivity,
    "normal",
    "the bearer attempt must not have widened anything",
  );

  // Another user's session cannot touch it either.
  const strangerId = await makeUser(ctx, { name: "Stranger" });
  await assert.rejects(
    setApiKeyMaxSensitivity(ctx, {
      principal: { userId: strangerId, capabilities: ["read"] },
      id: keyId,
      maxSensitivity: "restricted",
    }),
    /API key not found/,
  );
});

test("a new key defaults to full access", { skip }, async (t) => {
  const { ctx, userId } = await fixture(t);
  const keyId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.api_keys (id, user_id, key_hash, key_prefix, name, capabilities)
       VALUES ($1, $2, $3, 'kith_test_', 'Test key', '["read"]'::jsonb)`,
    [keyId, userId, "b".repeat(64)],
  );
  const row = await ctx.client.query(
    "SELECT max_sensitivity FROM kith.api_keys WHERE id = $1",
    [keyId],
  );
  assert.equal(
    row.rows[0].max_sensitivity,
    "restricted",
    "the column default is the owner's decision: no withholding",
  );
});
