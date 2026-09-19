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
  documentSensitivity,
  DEFAULT_MAX_SENSITIVITY,
  maxSensitivity,
  withinCeiling,
} from "../dist/sensitivity/index.js";
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
