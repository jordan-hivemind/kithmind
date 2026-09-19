// The investments store surface (ADM-3), against a real database.
//
// Every claim here is a claim about money or about who may see it, and both
// are claims about SQL: that `sum(...)` in `numeric` keeps the cent, that a
// GBP entry is converted with its own rate and never with another row's, that
// `outstanding` floors at zero, that the unique index makes a second import a
// no-op, and that a principal with no write access to a space cannot read or
// change an investment in it. None of that is provable against a fake client.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import {
  amountPatterns,
  archiveInvestment,
  createInvestment,
  createInvestmentEntry,
  deleteInvestmentEntry,
  findOrCreateInvestment,
  getAdminSpaceIds,
  getInvestment,
  listInvestmentEntries,
  listInvestments,
  suggestDocumentsForEntry,
  updateInvestment,
  updateInvestmentEntry,
} from "../dist/admin/index.js";
import {
  identityDatabase,
  makeMember,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-18T12:00:00Z");

/** One owner, one space. */
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

/** A published document with one chunk, and the provenance chain it needs. */
async function seedDocument(ctx, spaceId, input) {
  const sourceAccountId = newKithId();
  const sourceItemId = newKithId();
  const generationId = newKithId();
  const documentId = newKithId();
  const chunkId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
       VALUES ($1, $2, transaction_timestamp(), 'synthetic', true)`,
    [sourceAccountId, spaceId],
  );
  await ctx.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id_hash, title,
        lifecycle, original_link_available, desired_processing_epoch)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, 'available', true, 0)`,
    [
      sourceItemId,
      spaceId,
      sourceAccountId,
      `${sourceItemId}`.padEnd(64, "a").slice(0, 64),
      input.title,
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
    "UPDATE kith.source_items SET active_generation_id = $1 WHERE id = $2",
    [generationId, sourceItemId],
  );
  await ctx.client.query(
    `INSERT INTO kith.documents
       (id, space_id, created_at, processing_generation_id, source_item_id,
        document_key, title, doc_type, captured_at, evidence_span_ids,
        publication_state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'note', $7,
               '[]'::jsonb, $8)`,
    [
      documentId,
      spaceId,
      generationId,
      sourceItemId,
      `doc-${documentId}`,
      input.title,
      new Date(input.capturedAt ?? NOW),
      input.publicationState ?? "active",
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.chunks
       (id, space_id, created_at, processing_generation_id, document_id, ordinal,
        start, "end", text, evidence_span_ids, publication_state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 0, 0, $5, $6, '[]'::jsonb, $7)`,
    [
      chunkId,
      spaceId,
      generationId,
      documentId,
      (input.text ?? "").length,
      input.text ?? "",
      input.publicationState ?? "active",
    ],
  );
  return { documentId, chunkId };
}


test("an investment is tied to one organization entity, found not duplicated", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const first = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Northwind Ventures II",
    category: "Investment Fund",
    signedOn: "2024-03-04",
  });
  await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "northwind  ventures ii (SPV)",
  });
  const entities = await ctx.client.query(
    "SELECT id, canonical_name, kind FROM kith.entities WHERE space_id = $1 ORDER BY canonical_name",
    [f.spaceId],
  );
  assert.equal(entities.rows.length, 2);
  assert.ok(entities.rows.every((row) => row.kind === "organization"));

  // The same name twice is refused by the unique index, not by a read that
  // races with itself.
  await assert.rejects(
    createInvestment(ctx, {
      principal: f.principal,
      spaceId: f.spaceId,
      name: "  northwind ventures ii  ",
    }),
    /An investment with that name exists/,
  );

  const found = await findOrCreateInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Northwind Ventures II",
  });
  assert.deepEqual(found, { id: first, created: false });

  // Archiving frees the name; the partial index only covers live rows.
  await archiveInvestment(ctx, { principal: f.principal, investmentId: first });
  const reused = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Northwind Ventures II",
  });
  assert.notEqual(reused, first);
  // And restoring the archived one now collides, which is a named denial.
  await assert.rejects(
    archiveInvestment(ctx, {
      principal: f.principal,
      investmentId: first,
      archived: false,
    }),
    /An investment with that name exists/,
  );
});

test("totals are computed in numeric, per currency and in USD", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Bramble Fund I",
    category: "Investment Fund",
    signedOn: "2023-01-10",
  });
  const entry = (fields) =>
    createInvestmentEntry(ctx, {
      principal: f.principal,
      investmentId,
      ...fields,
    });

  await entry({ entryType: "commitment", entryDate: "2023-01-10", amount: "100000.00" });
  await entry({ entryType: "commitment_change", entryDate: "2024-01-10", amount: "25000.55" });
  await entry({ entryType: "capital_call_paid", entryDate: "2023-04-01", amount: "30000.33" });
  await entry({ entryType: "capital_call_paid", entryDate: "2024-04-01", amount: "20000.11" });
  await entry({ entryType: "fee", entryDate: "2024-04-02", amount: "500.01" });
  await entry({ entryType: "distribution", entryDate: "2025-06-30", amount: "12345.67" });
  // A GBP capital call with its own rate. It is never added to the USD
  // amounts in `byCurrency`, and it is converted with this rate and no other
  // in the USD totals.
  await entry({
    entryType: "capital_call_paid",
    entryDate: "2025-01-15",
    amount: "10000.00",
    currency: "GBP",
    exchangeRate: "1.25",
  });

  const [row] = await listInvestments(ctx, [f.spaceId]);
  assert.equal(row.name, "Bramble Fund I");
  assert.equal(row.entryCount, 7);
  assert.equal(row.signedOn, "2023-01-10");

  const usd = row.totals.byCurrency.find((total) => total.currency === "USD");
  assert.deepEqual(usd, {
    currency: "USD",
    committed: "125000.55",
    sent: "50000.44",
    fees: "500.01",
    received: "12345.67",
    outstanding: "75000.11",
    overCalled: "0",
  });
  const gbp = row.totals.byCurrency.find((total) => total.currency === "GBP");
  assert.deepEqual(gbp, {
    currency: "GBP",
    committed: "0",
    sent: "10000.00",
    fees: "0",
    received: "0",
    outstanding: "-10000.00",
    overCalled: "10000.00",
  });

  // 50000.44 + 10000.00 * 1.25 = 62500.44, to the cent, rounded to two places
  // because the product of an amount and a rate carries the rate's precision.
  assert.deepEqual(row.totals.usd, {
    committed: "125000.55",
    sent: "62500.44",
    fees: "500.01",
    received: "12345.67",
    outstanding: "62500.11",
    overCalled: "0.00",
  });
});

test("an over-call is reported rather than floored away", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Overcalled LP",
  });
  await createInvestmentEntry(ctx, {
    principal: f.principal,
    investmentId,
    entryType: "commitment",
    entryDate: "2024-01-01",
    amount: "1000.00",
  });
  await createInvestmentEntry(ctx, {
    principal: f.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2024-06-01",
    amount: "1500.00",
  });
  await createInvestmentEntry(ctx, {
    principal: f.principal,
    investmentId,
    entryType: "fee",
    entryDate: "2024-06-02",
    amount: "9999.00",
  });
  const [row] = await listInvestments(ctx, [f.spaceId]);
  // Signed, so "called more than committed" no longer reads the same as
  // "fully called".
  assert.equal(row.totals.usd.outstanding, "-500.00");
  assert.equal(row.totals.usd.overCalled, "500.00");
  // Fees are their own total and are never counted as sent.
  assert.equal(row.totals.usd.sent, "1500.00");
  assert.equal(row.totals.usd.fees, "9999.00");
});

test("only a commitment change may be negative", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Reduced LP",
  });
  await createInvestmentEntry(ctx, {
    principal: f.principal,
    investmentId,
    entryType: "commitment",
    entryDate: "2024-01-01",
    amount: "1000.00",
  });
  const { id: changeId } = await createInvestmentEntry(ctx, {
    principal: f.principal,
    investmentId,
    entryType: "commitment_change",
    entryDate: "2024-07-01",
    amount: "-250.00",
  });
  const [row] = await listInvestments(ctx, [f.spaceId]);
  assert.equal(row.totals.usd.committed, "750.00");

  for (const entryType of ["capital_call_paid", "distribution", "fee", "other"]) {
    await assert.rejects(
      createInvestmentEntry(ctx, {
        principal: f.principal,
        investmentId,
        entryType,
        entryDate: "2024-08-01",
        amount: "-10.00",
      }),
      /Only a commitment change may be negative/,
      entryType,
    );
  }
  // Retyping the negative change is refused too, rather than stored as a
  // negative fee.
  await assert.rejects(
    updateInvestmentEntry(ctx, {
      principal: f.principal,
      entryId: changeId,
      entryType: "fee",
    }),
    /Only a commitment change may be negative/,
  );
  // And the schema refuses it even when the service is bypassed.
  await assert.rejects(
    ctx.client.query(
      `INSERT INTO kith.investment_entries
         (id, space_id, investment_id, entry_type, entry_date, amount, currency)
       VALUES ($1, $2, $3, 'capital_call_paid', '2025-02-02', -100, 'USD')`,
      [newKithId(), f.spaceId, investmentId],
    ),
    /investment_entries_amount_sign_check/,
  );
});

test("an investment with no entries reads as zero, not null", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Signed But Uncalled",
  });
  const [row] = await listInvestments(ctx, [f.spaceId]);
  assert.deepEqual(row.totals.byCurrency, []);
  assert.deepEqual(row.totals.usd, {
    committed: "0.00",
    sent: "0.00",
    fees: "0.00",
    received: "0.00",
    outstanding: "0.00",
    overCalled: "0.00",
  });
  assert.equal(row.entryCount, 0);
  assert.equal(row.documentCount, 0);
  assert.deepEqual(row.linkedDocumentIds, []);
});

test("a non-USD amount without an exchange rate is refused twice over", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Sterling SPV",
  });
  await assert.rejects(
    createInvestmentEntry(ctx, {
      principal: f.principal,
      investmentId,
      entryType: "capital_call_paid",
      entryDate: "2025-02-02",
      amount: "100.00",
      currency: "GBP",
    }),
    /needs an exchange rate/,
  );
  // And the schema refuses it even when the service is bypassed, which is what
  // makes the USD totals safe to read as complete.
  await assert.rejects(
    ctx.client.query(
      `INSERT INTO kith.investment_entries
         (id, space_id, investment_id, entry_type, entry_date, amount, currency)
       VALUES ($1, $2, $3, 'capital_call_paid', '2025-02-02', 100, 'GBP')`,
      [newKithId(), f.spaceId, investmentId],
    ),
    /investment_entries_exchange_rate_present_check/,
  );
  // A float amount is refused too: money is an exact decimal string.
  await assert.rejects(
    createInvestmentEntry(ctx, {
      principal: f.principal,
      investmentId,
      entryType: "fee",
      entryDate: "2025-02-02",
      amount: 100.5,
    }),
    /exact decimal string/,
  );
});

test("an entry changes, moves currency with its rate, and deletes", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Rowan Capital",
  });
  const { id: entryId } = await createInvestmentEntry(ctx, {
    principal: f.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2025-03-01",
    amount: "4000.00",
    note: "wire",
  });

  // Patching a currency without a rate is refused, because the merged row
  // would have a null USD value.
  await assert.rejects(
    updateInvestmentEntry(ctx, {
      principal: f.principal,
      entryId,
      currency: "EUR",
    }),
    /needs an exchange rate/,
  );

  await updateInvestmentEntry(ctx, {
    principal: f.principal,
    entryId,
    entryType: "distribution",
    currency: "EUR",
    exchangeRate: "1.1",
    amount: "4500.00",
  });
  const [entry] = await listInvestmentEntries(ctx, [f.spaceId], [investmentId]);
  assert.equal(entry.entryType, "distribution");
  assert.equal(entry.currency, "EUR");
  assert.equal(entry.exchangeRate, "1.1");
  assert.equal(entry.amount, "4500.00");
  assert.equal(entry.note, "wire");

  const detail = await getInvestment(ctx, [f.spaceId], investmentId);
  assert.equal(detail.entries.length, 1);
  assert.equal(detail.totals.usd.received, "4950.00");

  // An entry may only be reached through its own investment.
  const other = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Bystander",
  });
  await assert.rejects(
    updateInvestmentEntry(ctx, {
      principal: f.principal,
      entryId,
      investmentId: other,
      amount: "1.00",
    }),
    /Investment entry not found/,
  );
  await assert.rejects(
    deleteInvestmentEntry(ctx, {
      principal: f.principal,
      entryId,
      investmentId: other,
    }),
    /Investment entry not found/,
  );

  await deleteInvestmentEntry(ctx, {
    principal: f.principal,
    entryId,
    investmentId,
  });
  assert.deepEqual(
    await listInvestmentEntries(ctx, [f.spaceId], [investmentId]),
    [],
  );
});

test("reading entries needs at least one investment and at most 25", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await assert.rejects(
    listInvestmentEntries(ctx, [f.spaceId], []),
    /between one and 25/,
  );
  await assert.rejects(
    listInvestmentEntries(
      ctx,
      [f.spaceId],
      Array.from({ length: 26 }, () => newKithId()),
    ),
    /between one and 25/,
  );
});

test("an import key makes a second import of the same row a no-op", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Imported LP",
  });
  const args = {
    principal: f.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2024-05-05",
    amount: "7500.00",
    importKey: "ledger:imported lp:2024-05-05:USD:-7500.00#1",
  };
  const first = await createInvestmentEntry(ctx, args);
  assert.equal(first.created, true);
  const second = await createInvestmentEntry(ctx, args);
  assert.deepEqual(second, { id: first.id, created: false });
  assert.equal(
    (await listInvestmentEntries(ctx, [f.spaceId], [investmentId])).length,
    1,
  );

  // The same values under the next occurrence's key are a second entry: a
  // sheet may legitimately hold the same call twice on the same day.
  const twin = await createInvestmentEntry(ctx, {
    ...args,
    importKey: "ledger:imported lp:2024-05-05:USD:-7500.00#2",
  });
  assert.equal(twin.created, true);
  assert.equal(
    (await listInvestmentEntries(ctx, [f.spaceId], [investmentId])).length,
    2,
  );

  // Two entries without a key are two entries: only the import claims
  // uniqueness, and the owner may legitimately pay the same amount twice.
  const keyless = { ...args, importKey: null };
  await createInvestmentEntry(ctx, keyless);
  await createInvestmentEntry(ctx, keyless);
  assert.equal(
    (await listInvestmentEntries(ctx, [f.spaceId], [investmentId])).length,
    4,
  );
});

test("archive hides the investment without losing its entries", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Closed Fund",
  });
  await createInvestmentEntry(ctx, {
    principal: f.principal,
    investmentId,
    entryType: "distribution",
    entryDate: "2025-01-01",
    amount: "10.00",
  });
  await archiveInvestment(ctx, { principal: f.principal, investmentId });
  assert.deepEqual(await listInvestments(ctx, [f.spaceId]), []);

  const [archived] = await listInvestments(ctx, [f.spaceId], {
    includeArchived: true,
  });
  assert.equal(archived.archivedAt, NOW);
  assert.equal(archived.totals.usd.received, "10.00");

  // Archiving twice keeps the first archival's time.
  await archiveInvestment(ctx, { principal: f.principal, investmentId });
  const [again] = await listInvestments(ctx, [f.spaceId], {
    includeArchived: true,
  });
  assert.equal(again.archivedAt, NOW);

  await archiveInvestment(ctx, {
    principal: f.principal,
    investmentId,
    archived: false,
  });
  assert.equal((await listInvestments(ctx, [f.spaceId])).length, 1);
});

test("filters narrow by category, status and name", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Alpha Angel",
    category: "Direct",
  });
  await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Beta Fund",
    category: "Investment Fund",
    status: "closed",
  });
  assert.equal(
    (await listInvestments(ctx, [f.spaceId], { category: "Direct" })).length,
    1,
  );
  assert.equal(
    (await listInvestments(ctx, [f.spaceId], { status: "closed" }))[0].name,
    "Beta Fund",
  );
  assert.equal(
    (await listInvestments(ctx, [f.spaceId], { nameContains: "ANGEL" }))[0].name,
    "Alpha Angel",
  );
  // A name filter containing a LIKE wildcard matches literally.
  assert.deepEqual(
    await listInvestments(ctx, [f.spaceId], { nameContains: "%" }),
    [],
  );
});

test("another space's investments are invisible and unwritable", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const strangerId = await makeUser(ctx, { name: "Stranger" });
  const otherSpaceId = await makeSpace(ctx, {
    createdBy: strangerId,
    memberId: strangerId,
    role: "owner",
  });
  const stranger = { userId: strangerId, credentialId: null };
  const mine = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Mine Only",
  });
  await createInvestment(ctx, {
    principal: stranger,
    spaceId: otherSpaceId,
    name: "Theirs Only",
  });

  assert.deepEqual(
    (await listInvestments(ctx, [f.spaceId])).map((row) => row.name),
    ["Mine Only"],
  );
  assert.equal(await getInvestment(ctx, [otherSpaceId], mine), null);
  assert.deepEqual(await listInvestmentEntries(ctx, [otherSpaceId], [mine]), []);
  await assert.rejects(
    updateInvestment(ctx, {
      principal: stranger,
      investmentId: mine,
      name: "Stolen",
    }),
    /Investment not found/,
  );
  await assert.rejects(
    createInvestmentEntry(ctx, {
      principal: stranger,
      investmentId: mine,
      entryType: "fee",
      entryDate: "2025-01-01",
      amount: "1.00",
    }),
    /Investment not found/,
  );
  await assert.rejects(
    archiveInvestment(ctx, { principal: stranger, investmentId: mine }),
    /Investment not found/,
  );
  // A space with no membership at all is a denial, not an empty list: the
  // predicate refuses rather than matching everything.
  await assert.rejects(listInvestments(ctx, []), /unauthorized/);
});

test("a reader may read the space but never write an investment", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const readerId = await makeUser(ctx, { name: "Reader" });
  await makeMember(ctx, {
    spaceId: f.spaceId,
    userId: readerId,
    role: "reader",
  });
  const reader = { userId: readerId, credentialId: null };
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Read Only LP",
  });

  // The admin screen is owner and editor only, so the reader administers no
  // space at all. The MCP read tools resolve a different set (read access),
  // which is why the reads take the set rather than resolving it.
  assert.deepEqual(await getAdminSpaceIds(ctx, reader), []);
  assert.equal(
    (await listInvestments(ctx, [f.spaceId]))[0].name,
    "Read Only LP",
  );

  await assert.rejects(
    createInvestment(ctx, {
      principal: reader,
      spaceId: f.spaceId,
      name: "Reader's LP",
    }),
    /Space not found/,
  );
  await assert.rejects(
    updateInvestment(ctx, {
      principal: reader,
      investmentId,
      name: "Renamed",
    }),
    /Investment not found/,
  );

  // An editor may write.
  const editorId = await makeUser(ctx, { name: "Editor" });
  await makeMember(ctx, {
    spaceId: f.spaceId,
    userId: editorId,
    role: "editor",
  });
  const editor = { userId: editorId, credentialId: null };
  assert.deepEqual(await getAdminSpaceIds(ctx, editor), [f.spaceId]);
  await updateInvestment(ctx, {
    principal: editor,
    investmentId,
    status: "closed",
  });
  assert.equal(
    (await listInvestments(ctx, [f.spaceId]))[0].status,
    "closed",
  );
});

test("a document may only be linked from its own space", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const strangerId = await makeUser(ctx, { name: "Stranger" });
  const otherSpaceId = await makeSpace(ctx, {
    createdBy: strangerId,
    memberId: strangerId,
    role: "owner",
  });
  const theirs = await seedDocument(ctx, otherSpaceId, {
    title: "Their capital call",
  });
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Linked LP",
  });
  await assert.rejects(
    createInvestmentEntry(ctx, {
      principal: f.principal,
      investmentId,
      entryType: "capital_call_paid",
      entryDate: "2025-01-01",
      amount: "1.00",
      documentId: theirs.documentId,
    }),
    /Document not found/,
  );

  const mine = await seedDocument(ctx, f.spaceId, {
    title: "Linked LP capital call notice",
  });
  await createInvestmentEntry(ctx, {
    principal: f.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2025-01-01",
    amount: "1.00",
    documentId: mine.documentId,
  });
  const [row] = await listInvestments(ctx, [f.spaceId]);
  assert.equal(row.documentCount, 1);
  assert.deepEqual(row.linkedDocumentIds, [mine.documentId]);
  // Now linked, so it no longer counts as unlinked.
  assert.equal(row.unlinkedDocumentCount, 0);
});

test("unlinked documents are counted by title, wildcards and all", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Harborline 100%",
  });
  await seedDocument(ctx, f.spaceId, {
    title: "2025 Harborline 100% distribution notice",
  });
  await seedDocument(ctx, f.spaceId, { title: "Harborline 1000 something" });
  await seedDocument(ctx, f.spaceId, { title: "Unrelated utility bill" });
  const [row] = await listInvestments(ctx, [f.spaceId]);
  assert.equal(row.unlinkedDocumentCount, 1);
});

test("document suggestions rank name, amount and date", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const investmentId = await createInvestment(ctx, {
    principal: f.principal,
    spaceId: f.spaceId,
    name: "Tanager Partners",
  });
  const all = await seedDocument(ctx, f.spaceId, {
    title: "Tanager Partners capital call 3",
    text: "Please wire USD 25,000.00 by 1 March.",
    capturedAt: Date.parse("2025-03-01T00:00:00Z"),
  });
  const nameOnly = await seedDocument(ctx, f.spaceId, {
    title: "Tanager Partners annual report",
    text: "No amount here.",
    capturedAt: Date.parse("2020-01-01T00:00:00Z"),
  });
  const amountOnly = await seedDocument(ctx, f.spaceId, {
    title: "Unrelated statement",
    text: "Debit of 25000.00 cleared.",
    capturedAt: Date.parse("2020-01-01T00:00:00Z"),
  });
  await seedDocument(ctx, f.spaceId, {
    title: "Nothing to do with it",
    text: "Nothing here at all.",
    capturedAt: Date.parse("2020-01-01T00:00:00Z"),
  });
  // A historical revision is not a suggestion.
  await seedDocument(ctx, f.spaceId, {
    title: "Tanager Partners capital call 3",
    text: "Please wire USD 25,000.00 by 1 March.",
    capturedAt: Date.parse("2025-03-01T00:00:00Z"),
    publicationState: "historical",
  });

  const suggestions = await suggestDocumentsForEntry(ctx, [f.spaceId], {
    investmentId,
    amount: "25000.00",
    entryDate: "2025-03-05",
  });
  assert.deepEqual(
    suggestions.map((s) => s.documentId),
    [all.documentId, nameOnly.documentId, amountOnly.documentId],
  );
  assert.deepEqual(suggestions[0].reasons, ["name", "amount", "date"]);
  assert.equal(suggestions[0].score, 6);
  assert.deepEqual(suggestions[1].reasons, ["name"]);
  assert.deepEqual(suggestions[2].reasons, ["amount"]);

  // A linked document is not suggested again.
  await createInvestmentEntry(ctx, {
    principal: f.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2025-03-05",
    amount: "25000.00",
    documentId: all.documentId,
  });
  const after = await suggestDocumentsForEntry(ctx, [f.spaceId], {
    investmentId,
    amount: "25000.00",
    entryDate: "2025-03-05",
  });
  assert.ok(!after.some((s) => s.documentId === all.documentId));

  // Another space's investment id suggests nothing rather than leaking that it
  // exists.
  assert.deepEqual(
    await suggestDocumentsForEntry(ctx, [f.spaceId], {
      investmentId: newKithId(),
      amount: "25000.00",
    }),
    [],
  );
});

test("amountPatterns covers the forms a document actually prints", { skip: false }, () => {
  assert.deepEqual(amountPatterns("25000.00").sort(), [
    "%25,000%",
    "%25,000.00%",
    "%25000%",
    "%25000.00%",
  ]);
  assert.deepEqual(amountPatterns("1234.5").sort(), [
    "%1,234.50%",
    "%1234.50%",
  ]);
});
