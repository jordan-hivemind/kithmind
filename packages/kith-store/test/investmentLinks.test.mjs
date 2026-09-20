// Investment document links (ADM-8b, slices 1 and 1b), against a real
// database.
//
// Every claim here is a claim about the owner's money or about a date on it,
// and all of them are claims about SQL: that the link table is the source of
// truth and `investment_entries.document_id` cannot drift from it, that a
// rejection is remembered through a re-evaluation, that a link can never join
// two spaces, that an estimated date moves exactly once and goes back when
// the link is rejected, and that a date the owner stated is never touched.
// None of that is provable against a fake client.
//
// `consistent()` runs after every transition. It is the test this whole file
// exists for: one query over the whole table asserting that no entry's
// `document_id` disagrees with its links.
//
// Synthetic fixtures throughout. No real fund, no real amount, no real date.

import assert from "node:assert/strict";
import test from "node:test";

import { applyKithSchema, KITH_MIGRATIONS, newKithId } from "../dist/index.js";
import {
  adoptLegacyEntryDocuments,
  confirmInvestmentDocumentLink,
  createInvestment,
  createInvestmentEntry,
  evaluateDocumentLinks,
  getInvestment,
  listInvestmentDocumentLinks,
  listInvestmentEntries,
  rejectInvestmentDocumentLink,
  syncEntryDocument,
  updateInvestmentEntry,
} from "../dist/admin/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";
import { connect, throwawayDatabase } from "./helpers/pgDatabase.mjs";

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
  return {
    ...database,
    ctx,
    userId,
    spaceId,
    principal: { userId, credentialId: null },
  };
}

/**
 * A document with a typed extraction: the provenance chain, an evidence span
 * per statement, the `document_statement` event and its observations, and the
 * `document_extractions` row that names them.
 *
 * Written with SQL rather than by running the extraction pipeline, because
 * what is under test is the matcher, not the reader. The shapes are the ones
 * `src/extraction/model.ts` writes: a scalar statement's `observationKeys` is
 * its own field name, and the observation's `value` is an `ObservationValue`.
 */
async function seedDocument(ctx, spaceId, input) {
  const sourceAccountId = newKithId();
  const sourceItemId = newKithId();
  const generationId = newKithId();
  const documentId = newKithId();
  const eventId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
       VALUES ($1, $2, transaction_timestamp(), 'synthetic', true)`,
    [sourceAccountId, spaceId],
  );
  await ctx.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id_hash, title, uri,
        lifecycle, original_link_available, desired_processing_epoch)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'available', true, 0)`,
    [
      sourceItemId,
      spaceId,
      sourceAccountId,
      `${sourceItemId}`.padEnd(64, "a").slice(0, 64),
      input.title ?? "Synthetic document",
      input.uri ?? null,
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
      input.title ?? "Synthetic document",
      input.kind,
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.events
       (id, space_id, created_at, source_account_id, source_item_id, event_key)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5)`,
    [eventId, spaceId, sourceAccountId, sourceItemId, `document_statement:${eventId}`],
  );
  const statements = [];
  for (const statement of input.statements) {
    const spanId = newKithId();
    await ctx.client.query(
      `INSERT INTO kith.evidence_spans (id, space_id, created_at)
         VALUES ($1, $2, transaction_timestamp())`,
      [spanId, spaceId],
    );
    await ctx.client.query(
      `INSERT INTO kith.observations
         (id, space_id, created_at, source_item_id, event_id, event_type,
          observation_key, observation_type, value, value_evidence)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'document_statement',
               $5, $5, $6::jsonb, $7::jsonb)`,
      [
        newKithId(),
        spaceId,
        sourceItemId,
        eventId,
        statement.field,
        JSON.stringify(statement.value),
        JSON.stringify([spanId]),
      ],
    );
    statements.push({
      field: statement.field,
      valueType: statement.valueType,
      page: 1,
      quote: "synthetic quote",
      observationKeys: [statement.field],
      evidenceSpanId: spanId,
      citation: { shownPage: 1, pageOrdinal: 1, lines: [1], pageLineCount: 1, contiguous: true },
      modelValue: statement.value,
    });
  }
  await ctx.client.query(
    `INSERT INTO kith.document_extractions
       (id, space_id, created_at, source_item_id, processing_generation_id,
        event_id, kind, model, extracted_at, pages_read, pages_total, statements)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'synthetic-model',
             transaction_timestamp(), 1, 1, $7::jsonb)`,
    [
      newKithId(),
      spaceId,
      sourceItemId,
      generationId,
      eventId,
      input.kind,
      JSON.stringify(statements),
    ],
  );
  return { sourceItemId, documentId, generationId };
}

const org = (field, value) => ({
  field,
  valueType: "organization",
  value: { type: "text", value },
});
const money = (field, amount, currency = "USD") => ({
  field,
  valueType: "money",
  value: { type: "money", amount, currency },
});
const date = (field, value, precision) => ({
  field,
  valueType: "date",
  value:
    precision === undefined
      ? { type: "date", value }
      : { type: "date", value, precision },
});

/**
 * The invariant, as one query.
 *
 * For every entry in the database: its `document_id` must equal the document
 * of its PRIMARY link -- the oldest live one -- or be null when it has none.
 * A row that fails this is a mirror that has drifted from its source of
 * truth, which is the whole failure mode the link table was introduced to
 * make impossible.
 *
 * `LATERAL ... LIMIT 1` and not a plain join: an entry may carry several live
 * links (a notice and the wire that paid it), and only one of them is the
 * citation the entry shows.
 */
async function consistent(ctx) {
  const drift = await ctx.client.query(
    `SELECT e.id, e.document_id, l.document_id AS link_document_id
       FROM kith.investment_entries e
       LEFT JOIN LATERAL (
         SELECT document_id FROM kith.investment_document_links l
          WHERE l.space_id = e.space_id AND l.entry_id = e.id
            AND l.state IN ('auto_linked', 'confirmed')
          ORDER BY l.created_at, l.id
          LIMIT 1
       ) l ON true
      WHERE e.document_id IS DISTINCT FROM l.document_id`,
  );
  assert.deepEqual(
    drift.rows,
    [],
    "investment_entries.document_id disagrees with its links",
  );
}

async function linksFor(base, filters) {
  return listInvestmentDocumentLinks(base.ctx, [base.spaceId], filters);
}

// ---------------------------------------------------------------------------
// The migration itself
// ---------------------------------------------------------------------------

/**
 * Two entries with a document attached the way the previous build attached
 * one, against a schema at version 32: raw SQL, because the store's own
 * functions do not exist at that version and are exactly what is under test.
 */
async function seedLegacyAttachments(client) {
  const ids = {
    userId: newKithId(),
    spaceId: newKithId(),
    investmentId: newKithId(),
    linkedEntryId: newKithId(),
    orphanEntryId: newKithId(),
    sourceAccountId: newKithId(),
    sourceItemId: newKithId(),
    generationId: newKithId(),
    documentId: newKithId(),
    orphanDocumentId: newKithId(),
  };
  await client.query("INSERT INTO kith.users (id, name) VALUES ($1, 'Owner')", [
    ids.userId,
  ]);
  await client.query(
    `INSERT INTO kith.spaces (id, kind, name, created_by)
       VALUES ($1, 'shared', 'Synthetic', $2)`,
    [ids.spaceId, ids.userId],
  );
  await client.query(
    `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
       VALUES ($1, $2, transaction_timestamp(), 'synthetic', true)`,
    [ids.sourceAccountId, ids.spaceId],
  );
  await client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id_hash, title,
        lifecycle, original_link_available, desired_processing_epoch)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'Notice', 'available',
               true, 0)`,
    [
      ids.sourceItemId,
      ids.spaceId,
      ids.sourceAccountId,
      `${ids.sourceItemId}`.padEnd(64, "a").slice(0, 64),
    ],
  );
  await client.query(
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id,
        desired_processing_epoch, card_generation, state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 0, false, 'ready')`,
    [ids.generationId, ids.spaceId, ids.sourceAccountId, ids.sourceItemId],
  );
  for (const [documentId, sourceItemId] of [
    [ids.documentId, ids.sourceItemId],
    [ids.orphanDocumentId, null],
  ]) {
    await client.query(
      `INSERT INTO kith.documents
         (id, space_id, created_at, processing_generation_id, source_item_id,
          document_key, title, doc_type, captured_at, evidence_span_ids,
          publication_state)
         VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, 'Notice',
                 'capital_call_notice', transaction_timestamp(), '[]'::jsonb,
                 'active')`,
      [documentId, ids.spaceId, ids.generationId, sourceItemId, `doc-${documentId}`],
    );
  }
  await client.query(
    `INSERT INTO kith.investments (id, space_id, name) VALUES ($1, $2, 'Fund')`,
    [ids.investmentId, ids.spaceId],
  );
  for (const [entryId, documentId] of [
    [ids.linkedEntryId, ids.documentId],
    [ids.orphanEntryId, ids.orphanDocumentId],
  ]) {
    await client.query(
      `INSERT INTO kith.investment_entries
         (id, space_id, created_at, investment_id, entry_type, entry_date,
          amount, currency, document_id)
       VALUES ($1, $2, transaction_timestamp() - interval '1 year', $3,
               'capital_call_paid', DATE '2025-01-01', 25000.00, 'USD', $4)`,
      [entryId, ids.spaceId, ids.investmentId, documentId],
    );
  }
  return ids;
}

test(
  "the migration applies on a database at version 32 and reaches 33",
  { skip },
  async (t) => {
    const database = await throwawayDatabase(t);
    const client = await connect(database);
    // Replay the chain by hand up to 32, so this is genuinely an UPGRADE of a
    // database at the hosted version rather than a fresh apply of everything.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    await client.query("CREATE SCHEMA kith");
    await client.query(
      `CREATE TABLE kith.schema_version (
         version integer PRIMARY KEY, name text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT transaction_timestamp())`,
    );
    for (const migration of KITH_MIGRATIONS) {
      if (migration.version > 32) continue;
      await client.query(await readFile(fileURLToPath(migration.url), "utf8"));
      await client.query(
        "INSERT INTO kith.schema_version (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    }
    const before = await client.query(
      "SELECT count(*)::int AS n FROM kith.investment_entries",
    );
    assert.equal(before.rows[0].n, 0);

    // Two entries with a document attached the way the previous build
    // attached one: a bare `document_id` with nothing behind it. One has a
    // document with a source item; the other's document has none, and must
    // keep its mirror rather than be given an invented link.
    const seeded = await seedLegacyAttachments(client);

    assert.equal(await applyKithSchema(client), 33);

    const adopted = await client.query(
      `SELECT entry_id, document_id, source_item_id, state, decided_by, reason,
              created_at = (SELECT created_at FROM kith.investment_entries
                             WHERE id = l.entry_id) AS dated_at_the_entry
         FROM kith.investment_document_links l`,
    );
    assert.equal(adopted.rows.length, 1, "only the adoptable one is adopted");
    assert.equal(adopted.rows[0].entry_id, seeded.linkedEntryId);
    assert.equal(adopted.rows[0].document_id, seeded.documentId);
    assert.equal(adopted.rows[0].source_item_id, seeded.sourceItemId);
    assert.equal(adopted.rows[0].state, "confirmed");
    assert.equal(adopted.rows[0].decided_by, "owner");
    assert.equal(adopted.rows[0].reason, "legacy_attached");
    // Dated at the entry, so it is older than anything the rule can make and
    // is therefore the primary link.
    assert.equal(adopted.rows[0].dated_at_the_entry, true);

    // Neither mirror moved, including the one that could not be adopted.
    const mirrors = await client.query(
      "SELECT id, document_id FROM kith.investment_entries ORDER BY id",
    );
    assert.deepEqual(
      Object.fromEntries(mirrors.rows.map((row) => [row.id, row.document_id])),
      {
        [seeded.linkedEntryId]: seeded.documentId,
        [seeded.orphanEntryId]: seeded.orphanDocumentId,
      },
    );

    // The three things 033 adds, and the legacy value of the marker.
    const columns = await client.query(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'kith' AND table_name = 'investment_entries'
          AND column_name = 'date_is_estimated'`,
    );
    assert.equal(columns.rows[0].column_default, "false");
    assert.equal(columns.rows[0].is_nullable, "NO");
    const target = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'corrections_target_kind_check'`,
    );
    assert.match(target.rows[0].def, /'entry'/);
    const trigger = await client.query(
      `SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgname = 'investment_document_links_change_trg'`,
    );
    assert.equal(trigger.rows[0].n, 1);
  },
);

// ---------------------------------------------------------------------------
// Space isolation
// ---------------------------------------------------------------------------

test(
  "a link can never join a document and an entry from different spaces",
  { skip },
  async (t) => {
    const base = await fixture(t);
    const otherUser = await makeUser(base.ctx, { name: "Other" });
    const otherSpace = await makeSpace(base.ctx, {
      createdBy: otherUser,
      memberId: otherUser,
      role: "owner",
    });
    const investmentId = await createInvestment(base.ctx, {
      principal: base.principal,
      spaceId: base.spaceId,
      name: "Synthetic Growth Partners III",
    });
    const entry = await createInvestmentEntry(base.ctx, {
      principal: base.principal,
      investmentId,
      entryType: "capital_call_paid",
      entryDate: "2026-03-10",
      amount: "25000.00",
    });
    // The document is in the OTHER space.
    const foreign = await seedDocument(base.ctx, otherSpace, {
      kind: "capital_call_notice",
      statements: [org("fund", "Synthetic Growth Partners III")],
    });
    await assert.rejects(
      base.ctx.client.query(
        `INSERT INTO kith.investment_document_links
           (id, space_id, investment_id, entry_id, document_id, source_item_id,
            state, score, evidence, decided_by, reason)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed',10,
                 '[{"field":"fund"}]'::jsonb,'rule','party')`,
        [
          newKithId(),
          base.spaceId,
          investmentId,
          entry.id,
          foreign.documentId,
          foreign.sourceItemId,
        ],
      ),
      /foreign key/i,
      "the composite foreign key must refuse a cross-space link",
    );
    // And the evaluation of a foreign document writes nothing in this space.
    const result = await evaluateDocumentLinks(base.ctx, {
      spaceId: base.spaceId,
      sourceItemId: foreign.sourceItemId,
    });
    assert.equal(result.evaluated, false);
    assert.equal(result.reason, "no_extraction");
    assert.deepEqual(await linksFor(base, {}), []);
  },
);

test("a rule-decided link with no evidence is refused at write", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: "Synthetic Growth Partners III",
  });
  const document = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [org("fund", "Synthetic Growth Partners III")],
  });
  await assert.rejects(
    base.ctx.client.query(
      `INSERT INTO kith.investment_document_links
         (id, space_id, investment_id, document_id, source_item_id,
          state, score, evidence, decided_by, reason)
       VALUES ($1,$2,$3,$4,$5,'suggested',4,'[]'::jsonb,'rule','party')`,
      [
        newKithId(),
        base.spaceId,
        investmentId,
        document.documentId,
        document.sourceItemId,
      ],
    ),
    /investment_document_links_evidence_required_check/,
  );
});

// ---------------------------------------------------------------------------
// The auto-link
// ---------------------------------------------------------------------------

/** One investment, one paid call, and the notice that matches it. */
async function autoLinkFixture(t, overrides = {}) {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: "Synthetic Growth Partners III",
  });
  const entry = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-10",
    amount: "25000.00",
    ...overrides.entry,
  });
  const document = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    uri:
      overrides.uri === undefined
        ? "fs://archive/Investments/Synthetic Growth Partners III/call.pdf"
        : overrides.uri,
    statements: overrides.statements ?? [
      org("fund", "Synthetic Growth Partners III"),
      money("amount_called", "25000.00"),
      date("due_date", "2026-03-12"),
    ],
  });
  return { ...base, investmentId, entryId: entry.id, document };
}

test("party, amount and date auto-link, and the entry carries the document", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.evaluated, true);
  assert.equal(result.autoLinkedEntryId, base.entryId);

  const links = await linksFor(base, {});
  assert.equal(links.length, 1);
  assert.equal(links[0].state, "auto_linked");
  assert.equal(links[0].decidedBy, "rule");
  // Party 4 + amount 4 + date 2 + path 1: the folder names the fund too.
  assert.equal(links[0].score, 11);
  assert.equal(links[0].reason, "party+amount+date+path");
  assert.deepEqual(
    links[0].evidence.map((item) => item.field).sort(),
    ["amount_called", "due_date", "fund"],
  );
  for (const cited of links[0].evidence) {
    assert.equal(typeof cited.observationKey, "string");
    assert.equal(typeof cited.evidenceSpanId, "string");
  }

  const entries = await listInvestmentEntries(base.ctx, [base.spaceId], [
    base.investmentId,
  ]);
  assert.equal(entries[0].documentId, base.document.documentId);
  await consistent(base.ctx);
});

test("re-evaluating the same document is a no-op, not a second row", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const first = await linksFor(base, {});
  const again = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(again.autoLinkedEntryId, base.entryId);
  const second = await linksFor(base, {});
  assert.equal(second.length, 1);
  assert.equal(second[0].id, first[0].id);
  assert.equal(second[0].state, "auto_linked");
  await consistent(base.ctx);
});

test("a document the entry's amount disagrees with is suggested, not linked", { skip }, async (t) => {
  const base = await autoLinkFixture(t, {
    statements: [
      org("fund", "Synthetic Growth Partners III"),
      money("amount_called", "25000.01"),
      date("due_date", "2026-03-12"),
    ],
  });
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, null);
  const links = await linksFor(base, {});
  assert.equal(links.length, 1);
  assert.equal(links[0].state, "suggested");
  assert.equal(links[0].score, 7);
  const entries = await listInvestmentEntries(base.ctx, [base.spaceId], [
    base.investmentId,
  ]);
  assert.equal(entries[0].documentId, null);
  await consistent(base.ctx);
});

test("two identical calls in one month link nothing and suggest both", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  const twin = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId: base.investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-20",
    amount: "25000.00",
  });
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, null);
  assert.equal(result.suggestedCount, 2);
  const links = await linksFor(base, {});
  assert.equal(links.length, 2);
  assert.deepEqual([...new Set(links.map((link) => link.state))], ["suggested"]);
  assert.deepEqual(
    links.map((link) => link.entryId).sort(),
    [base.entryId, twin.id].sort(),
  );
  await consistent(base.ctx);
});

test("a document that names no investment the owner has links nothing", { skip }, async (t) => {
  // No party the owner recognises, no amount he holds, and a folder that
  // names nothing either: there is nothing to score against at all.
  const base = await autoLinkFixture(t, {
    uri: "fs://archive/Unsorted/scan-0041.pdf",
    statements: [
      org("fund", "Some Other Partnership"),
      money("amount_called", "999.00"),
      date("due_date", "2026-03-12"),
    ],
  });
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.evaluated, false);
  assert.equal(result.reason, "no_investment_matched");
  assert.deepEqual(await linksFor(base, {}), []);
});

test("an entity alias the owner recorded is a party match", { skip }, async (t) => {
  const base = await autoLinkFixture(t, {
    statements: [
      org("fund", "SGP III"),
      money("amount_called", "25000.00"),
      date("due_date", "2026-03-12"),
    ],
  });
  // No alias yet: the folder still names the fund, so the document is a weak
  // suggestion rather than nothing.
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const before = await linksFor(base, {});
  assert.equal(before[0].state, "suggested");

  await base.ctx.client.query(
    `UPDATE kith.entities SET aliases = '["SGP III"]'::jsonb,
            normalized_aliases = '["sgp iii"]'::jsonb
      WHERE id = (SELECT entity_id FROM kith.investments WHERE id = $1)`,
    [base.investmentId],
  );
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, base.entryId);
  await consistent(base.ctx);
});

// ---------------------------------------------------------------------------
// State transitions and the remembered rejection
// ---------------------------------------------------------------------------

test("every state transition, and the mirror after each one", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  assert.equal(link.state, "auto_linked");
  await consistent(base.ctx);

  // auto_linked -> confirmed
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  let current = (await linksFor(base, {}))[0];
  assert.equal(current.state, "confirmed");
  assert.equal(current.decidedBy, "owner");
  assert.equal(current.actorUserId, base.userId);
  await consistent(base.ctx);

  // confirmed -> rejected
  await rejectInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  current = (await linksFor(base, {}))[0];
  assert.equal(current.state, "rejected");
  const entries = await listInvestmentEntries(base.ctx, [base.spaceId], [
    base.investmentId,
  ]);
  assert.equal(entries[0].documentId, null);
  await consistent(base.ctx);
});

test("a rejected link is never proposed again, however often the sweep runs", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  await rejectInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
    reason: "wrong fund",
  });

  for (let run = 0; run < 3; run += 1) {
    const result = await evaluateDocumentLinks(base.ctx, {
      spaceId: base.spaceId,
      sourceItemId: base.document.sourceItemId,
    });
    assert.equal(result.autoLinkedEntryId, null);
  }
  const after = await linksFor(base, {});
  assert.equal(after.length, 1, "no second row for a pair already rejected");
  assert.equal(after[0].id, link.id);
  assert.equal(after[0].state, "rejected");
  assert.equal(after[0].reason, "wrong fund");
  const entries = await listInvestmentEntries(base.ctx, [base.spaceId], [
    base.investmentId,
  ]);
  assert.equal(entries[0].documentId, null);
  await consistent(base.ctx);
});

test("a confirmed link is not restated by the rule either", { skip }, async (t) => {
  const base = await autoLinkFixture(t, {
    statements: [
      org("fund", "Synthetic Growth Partners III"),
      money("amount_called", "25000.00"),
      date("due_date", "2026-03-12"),
    ],
  });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const after = (await linksFor(base, {}))[0];
  assert.equal(after.state, "confirmed");
  assert.equal(after.decidedBy, "owner");
  await consistent(base.ctx);
});

test("an entry that already cites one document is not auto-linked to a second", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const second = await seedDocument(base.ctx, base.spaceId, {
    kind: "wire_confirmation",
    statements: [
      org("sender", "Synthetic Growth Partners III"),
      money("amount_sent", "25000.00"),
      date("value_date", "2026-03-11"),
    ],
  });
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: second.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, null);
  const links = await linksFor(base, { sourceItemId: second.sourceItemId });
  assert.equal(links[0].state, "suggested");
  const entries = await listInvestmentEntries(base.ctx, [base.spaceId], [
    base.investmentId,
  ]);
  assert.equal(entries[0].documentId, base.document.documentId);
  await consistent(base.ctx);
});

test("a suggestion this pass no longer makes is swept away", { skip }, async (t) => {
  const base = await autoLinkFixture(t, {
    statements: [
      org("fund", "Synthetic Growth Partners III"),
      money("amount_called", "25000.01"),
      date("due_date", "2026-03-12"),
    ],
  });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal((await linksFor(base, {})).length, 1);

  // The owner corrects the fund's name so the document no longer names this
  // investment, and its amount no longer matches anything.
  await base.ctx.client.query(
    `UPDATE kith.observations
        SET value = '{"type":"text","value":"A Different Fund"}'::jsonb
      WHERE space_id = $1 AND observation_key = 'fund'`,
    [base.spaceId],
  );
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  // The folder still names the fund, so the pass runs and scores the entry at
  // one point for the path alone -- below the threshold, so nothing is
  // offered and the row that was offered before is gone.
  assert.equal(result.evaluated, true);
  assert.equal(result.suggestedCount, 0);
  const after = await linksFor(base, {});
  assert.deepEqual(after, []);
  await consistent(base.ctx);
});

test("a corrected observation is what the scorer matches on", { skip }, async (t) => {
  const base = await autoLinkFixture(t, {
    statements: [
      org("fund", "Synthetic Growth Partners III"),
      money("amount_called", "52000.00"),
      date("due_date", "2026-03-12"),
    ],
  });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal((await linksFor(base, {}))[0].state, "suggested");
  // The owner fixes the transposed amount; `writeThrough` puts it on the
  // observation, which is what this reads.
  await base.ctx.client.query(
    `UPDATE kith.observations
        SET value = '{"type":"money","amount":"25000.00","currency":"USD"}'::jsonb
      WHERE space_id = $1 AND observation_key = 'amount_called'`,
    [base.spaceId],
  );
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, base.entryId);
  await consistent(base.ctx);
});

// ---------------------------------------------------------------------------
// The drawer's own attach and detach
// ---------------------------------------------------------------------------

test("attaching a document from the drawer writes an owner link, not a bare id", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    documentId: base.document.documentId,
  });
  const links = await linksFor(base, {});
  assert.equal(links.length, 1);
  assert.equal(links[0].state, "confirmed");
  assert.equal(links[0].decidedBy, "owner");
  assert.equal(links[0].reason, "owner_attached");
  assert.equal(links[0].actorUserId, base.userId);
  const investment = await getInvestment(base.ctx, [base.spaceId], base.investmentId);
  assert.equal(investment.entries[0].documentId, base.document.documentId);
  await consistent(base.ctx);
});

test("a null documentId on an entry patch never rejects and never clears", { skip }, async (t) => {
  // The accident this rule exists for: the drawer is open on an entry with
  // no document, an auto-link lands from the change feed, and the owner's
  // next unrelated edit carries the stale `documentId: null`. That used to
  // reject the link permanently and revert the date it had moved.
  const base = await estimatedCallFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  assert.equal(link.state, "auto_linked");
  assert.equal((await entryRow(base)).entryDate, "2026-03-12");

  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    documentId: null,
    note: "just fixing the note",
  });

  const after = await linksFor(base, {});
  assert.equal(after.length, 1);
  assert.equal(after[0].state, "auto_linked", "the link is untouched");
  const entry = await entryRow(base);
  assert.equal(entry.documentId, base.document.documentId, "the mirror stands");
  assert.equal(entry.entryDate, "2026-03-12", "and so does the date it moved");
  assert.equal(entry.note, "just fixing the note");
  await consistent(base.ctx);
});

test("a document comes off an entry only through an explicit reject", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    documentId: base.document.documentId,
  });
  const [link] = await linksFor(base, {});
  assert.equal(link.state, "confirmed");

  await rejectInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  const after = await linksFor(base, {});
  assert.equal(after[0].state, "rejected");
  const entries = await listInvestmentEntries(base.ctx, [base.spaceId], [
    base.investmentId,
  ]);
  assert.equal(entries[0].documentId, null);
  await consistent(base.ctx);

  // And the sweep does not re-make it.
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, null);
  assert.equal((await linksFor(base, {})).length, 1);
  await consistent(base.ctx);
});

// ---------------------------------------------------------------------------
// Slice 1b: the date replacement rule
// ---------------------------------------------------------------------------

/** An imported commitment with an estimated date, and the agreement that
 * states the real one. */
async function estimatedDateFixture(t, overrides = {}) {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: "Synthetic Growth Partners III",
  });
  const entry = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "commitment",
    // Dated at the first payment, because the sheet had no signing date.
    entryDate: "2026-03-10",
    amount: "250000.00",
    dateIsEstimated: overrides.dateIsEstimated ?? true,
    note: "date estimated from first payment",
  });
  const document = await seedDocument(base.ctx, base.spaceId, {
    kind: "investment_agreement",
    statements: overrides.statements ?? [
      org("company", "Synthetic Growth Partners III"),
      money("amount_committed", "250000.00"),
      date("date_signed", "2026-01-15"),
    ],
  });
  return { ...base, investmentId, entryId: entry.id, document };
}

async function entryRow(base) {
  const entries = await listInvestmentEntries(base.ctx, [base.spaceId], [
    base.investmentId,
  ]);
  return entries[0];
}

async function dateCorrections(base) {
  const result = await base.ctx.client.query(
    `SELECT target_kind, target_id, field_name, original_value, corrected_value,
            state, detector, reason
       FROM kith.corrections
      WHERE space_id = $1 AND detector = 'investment_link_date'
      ORDER BY created_at, id`,
    [base.spaceId],
  );
  return result.rows;
}

test("an estimated date is replaced by the document's, once, with its provenance", { skip }, async (t) => {
  const base = await estimatedDateFixture(t);
  // An agreement is never auto-linked, so the owner confirms it: that is the
  // second half of "the link is confirmed or auto_linked".
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  assert.equal(link.state, "suggested");
  assert.equal((await entryRow(base)).entryDate, "2026-03-10");

  const confirmed = await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  assert.equal(confirmed.dateReplaced, true);
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-01-15");
  assert.equal(entry.dateIsEstimated, false);

  const rows = await dateCorrections(base);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_kind, "entry");
  assert.equal(rows[0].target_id, base.entryId);
  assert.equal(rows[0].field_name, "entry_date");
  assert.equal(rows[0].original_value, "2026-03-10");
  assert.equal(rows[0].corrected_value, "2026-01-15");
  assert.equal(rows[0].state, "resolved");
  // The cited observation and its span, so the change traces back to a line.
  assert.match(rows[0].reason, /date_signed/);
  const stored = (await linksFor(base, {}))[0];
  assert.equal(typeof stored.dateCorrectionId, "string");
  await consistent(base.ctx);
});

test("the replacement is idempotent: a second pass moves nothing", { skip }, async (t) => {
  const base = await estimatedDateFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  const first = await entryRow(base);
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const second = await entryRow(base);
  assert.deepEqual(second, first);
  assert.equal((await dateCorrections(base)).length, 1);
});

test("a date the owner stated is never replaced", { skip }, async (t) => {
  const base = await estimatedDateFixture(t, { dateIsEstimated: false });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  const confirmed = await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  assert.equal(confirmed.dateReplaced, false);
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-03-10");
  assert.equal(entry.dateIsEstimated, false);
  assert.deepEqual(await dateCorrections(base), []);
});

test("a month-precision document date never replaces an estimate", { skip }, async (t) => {
  const base = await estimatedDateFixture(t, {
    statements: [
      org("company", "Synthetic Growth Partners III"),
      money("amount_committed", "250000.00"),
      date("date_signed", "2026-01", "month"),
    ],
  });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  const confirmed = await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  assert.equal(confirmed.dateReplaced, false);
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-03-10");
  assert.equal(
    entry.dateIsEstimated,
    true,
    "the estimate stands: a month has no day to take",
  );
  assert.deepEqual(await dateCorrections(base), []);
});

test("a document that agrees with the estimate clears the marker and records nothing", { skip }, async (t) => {
  const base = await estimatedDateFixture(t, {
    statements: [
      org("company", "Synthetic Growth Partners III"),
      money("amount_committed", "250000.00"),
      date("date_signed", "2026-03-10"),
    ],
  });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  const confirmed = await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  assert.equal(confirmed.dateReplaced, false);
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-03-10");
  assert.equal(entry.dateIsEstimated, false, "the document confirms the guess");
  assert.deepEqual(await dateCorrections(base), []);
});

test("rejecting a link puts the date it moved back, and re-marks it estimated", { skip }, async (t) => {
  const base = await estimatedDateFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  assert.equal((await entryRow(base)).entryDate, "2026-01-15");

  const rejected = await rejectInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  assert.equal(rejected.dateReverted, true);
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-03-10");
  assert.equal(entry.dateIsEstimated, true);
  assert.equal(entry.documentId, null);
  const rows = await dateCorrections(base);
  assert.equal(rows.length, 2, "the reversal is recorded as clearly as the move");
  assert.equal(rows[1].original_value, "2026-01-15");
  assert.equal(rows[1].corrected_value, "2026-03-10");
  assert.equal((await linksFor(base, {}))[0].dateCorrectionId, null);
  await consistent(base.ctx);
});

test("a date the owner edited after the link is his, and rejection leaves it alone", { skip }, async (t) => {
  const base = await estimatedDateFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  // He types a date of his own afterwards.
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    entryDate: "2026-02-02",
  });
  assert.equal((await entryRow(base)).dateIsEstimated, false);

  const rejected = await rejectInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  assert.equal(rejected.dateReverted, false);
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-02-02", "his date stands");
  assert.equal(entry.dateIsEstimated, false);
  await consistent(base.ctx);
});

test("typing a date clears the marker; ticking the box keeps it", { skip }, async (t) => {
  const base = await estimatedDateFixture(t);
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    entryDate: "2026-02-02",
  });
  assert.equal((await entryRow(base)).dateIsEstimated, false);

  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    entryDate: "2026-02-03",
    dateIsEstimated: true,
  });
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-02-03");
  assert.equal(entry.dateIsEstimated, true);

  // A patch that says nothing about either leaves the marker where it is.
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    note: "still a guess",
  });
  assert.equal((await entryRow(base)).dateIsEstimated, true);
});

test("an entry created with no marker is the owner's date, and always was", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: "Synthetic Growth Partners III",
  });
  await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-10",
    amount: "25000.00",
  });
  const entries = await listInvestmentEntries(base.ctx, [base.spaceId], [
    investmentId,
  ]);
  assert.equal(entries[0].dateIsEstimated, false);
});

test("a flag that is not a boolean is refused rather than read as false", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: "Synthetic Growth Partners III",
  });
  await assert.rejects(
    createInvestmentEntry(base.ctx, {
      principal: base.principal,
      investmentId,
      entryType: "capital_call_paid",
      entryDate: "2026-03-10",
      amount: "25000.00",
      dateIsEstimated: "true",
    }),
    /true or false/,
  );
});

// ---------------------------------------------------------------------------
// The shapes with nothing to compare
// ---------------------------------------------------------------------------

test("a notice stating only its fund is a suggestion on the party alone", { skip }, async (t) => {
  // No money statement at all, so the candidate query has no amounts to look
  // for and the party is the whole case: 4 points, plus 1 for the folder.
  const base = await autoLinkFixture(t, {
    statements: [org("fund", "Synthetic Growth Partners III")],
  });
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, null);
  assert.equal(result.suggestedCount, 1);
  const links = await linksFor(base, {});
  assert.equal(links[0].state, "suggested");
  assert.equal(links[0].score, 5);
  assert.equal(links[0].reason, "party+path");
  await consistent(base.ctx);
});

test("a K-1 links to the investment, not to a payment", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  const k1 = await seedDocument(base.ctx, base.spaceId, {
    kind: "schedule_k1",
    statements: [
      org("partnership", "Synthetic Growth Partners III"),
      money("capital_gain", "25000.00"),
    ],
  });
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: k1.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, null);
  const links = await linksFor(base, { sourceItemId: k1.sourceItemId });
  assert.equal(links.length, 1);
  assert.equal(links[0].entryId, null, "an investment-level link");
  assert.equal(links[0].investmentId, base.investmentId);
  assert.equal(links[0].state, "suggested");
  // The money on the page equals the entry's amount and is deliberately not
  // scored: a K-1 box figure is not a payment.
  assert.equal(links[0].score, 4);
  await consistent(base.ctx);
});

// ---------------------------------------------------------------------------
// Cross-currency
// ---------------------------------------------------------------------------

test("a USD notice auto-links to a GBP entry inside the importer's tolerance", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: "Synthetic Growth Partners III",
  });
  const entry = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-10",
    amount: "10000.00",
    currency: "GBP",
    exchangeRate: "1.2734",
  });
  const document = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", "Synthetic Growth Partners III"),
      // 10,000 GBP at 1.2734 is 12,734.00; this is inside 1%.
      money("amount_called", "12800.00"),
      date("due_date", "2026-03-12"),
    ],
  });
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: document.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, entry.id);
  await consistent(base.ctx);
});

test("a USD notice outside the tolerance is only a suggestion", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: "Synthetic Growth Partners III",
  });
  await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-10",
    amount: "10000.00",
    currency: "GBP",
    exchangeRate: "1.2734",
  });
  const document = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", "Synthetic Growth Partners III"),
      money("amount_called", "13000.00"),
      date("due_date", "2026-03-12"),
    ],
  });
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: document.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, null);
  const links = await linksFor(base, {});
  assert.equal(links[0].state, "suggested");
  assert.equal(links[0].score, 6);
  await consistent(base.ctx);
});

// ---------------------------------------------------------------------------
// B1: entries that already carry a document (second review)
// ---------------------------------------------------------------------------

/** An entry whose `document_id` was set the way the old build set it: a bare
 * column write with no link row behind it. */
async function legacyAttach(base, entryId, documentId) {
  await base.ctx.client.query(
    `UPDATE kith.investment_entries SET document_id = $3
      WHERE id = $1 AND space_id = $2`,
    [entryId, base.spaceId, documentId],
  );
  await base.ctx.client.query(
    `DELETE FROM kith.investment_document_links
      WHERE space_id = $1 AND entry_id = $2`,
    [base.spaceId, entryId],
  );
}

test("a legacy attachment is not linked over by a matching notice", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  const owned = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    title: "The owner's own choice",
    statements: [org("fund", "Synthetic Growth Partners III")],
  });
  await legacyAttach(base, base.entryId, owned.documentId);

  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(
    result.autoLinkedEntryId,
    null,
    "an entry that already carries a document is not auto-linked over",
  );
  const entry = await entryRow(base);
  assert.equal(entry.documentId, owned.documentId, "the owner's document stands");
  const links = await linksFor(base, { sourceItemId: base.document.sourceItemId });
  assert.equal(links[0].state, "suggested");
  // And the attachment has been adopted, so it is now a real link.
  const adopted = await linksFor(base, { sourceItemId: owned.sourceItemId });
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].state, "confirmed");
  assert.equal(adopted[0].decidedBy, "owner");
  assert.equal(adopted[0].reason, "legacy_attached");
  await consistent(base.ctx);
});

test("an amount-only suggestion never nulls a legacy mirror", { skip }, async (t) => {
  const base = await autoLinkFixture(t, {
    uri: "fs://archive/Unsorted/scan.pdf",
    statements: [money("amount_called", "25000.00")],
  });
  const owned = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    title: "The owner's own choice",
    statements: [org("fund", "Synthetic Growth Partners III")],
  });
  await legacyAttach(base, base.entryId, owned.documentId);

  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const entry = await entryRow(base);
  assert.equal(
    entry.documentId,
    owned.documentId,
    "a suggestion must never take a document off an entry",
  );
  const offered = await linksFor(base, { sourceItemId: base.document.sourceItemId });
  assert.equal(offered[0].state, "suggested");
  await consistent(base.ctx);
});

test("the backfill is idempotent, and is a dry run until asked", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  const owned = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [org("fund", "Synthetic Growth Partners III")],
  });
  await legacyAttach(base, base.entryId, owned.documentId);

  const dry = await adoptLegacyEntryDocuments(base.ctx, {
    spaceIds: [base.spaceId],
  });
  assert.deepEqual(dry, { pending: 1, adopted: 0, unadoptable: 0 });
  assert.deepEqual(await linksFor(base, {}), [], "a dry run writes nothing");

  const first = await adoptLegacyEntryDocuments(base.ctx, {
    spaceIds: [base.spaceId],
    apply: true,
  });
  assert.equal(first.adopted, 1);
  const second = await adoptLegacyEntryDocuments(base.ctx, {
    spaceIds: [base.spaceId],
    apply: true,
  });
  assert.deepEqual(second, { pending: 0, adopted: 0, unadoptable: 0 });
  assert.equal((await linksFor(base, {})).length, 1);
  await consistent(base.ctx);
});

test("an attached document with no source item keeps its mirror and gets no link", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  const owned = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [org("fund", "Synthetic Growth Partners III")],
  });
  await legacyAttach(base, base.entryId, owned.documentId);
  await base.ctx.client.query(
    "UPDATE kith.documents SET source_item_id = NULL WHERE id = $1",
    [owned.documentId],
  );

  const counts = await adoptLegacyEntryDocuments(base.ctx, {
    spaceIds: [base.spaceId],
    apply: true,
  });
  assert.deepEqual(counts, { pending: 0, adopted: 0, unadoptable: 1 });
  assert.deepEqual(await linksFor(base, {}), [], "no link is invented");

  // And the mirror survives a sync, rather than being cleared for want of a
  // row to justify it.
  await syncEntryDocument(base.ctx, base.spaceId, base.entryId);
  assert.equal((await entryRow(base)).documentId, owned.documentId);
});

// ---------------------------------------------------------------------------
// F1: a rule auto-link that stops qualifying (second review)
// ---------------------------------------------------------------------------

/** An estimated capital call, and the notice that auto-links to it and moves
 * its date from the guess to the stated one. */
async function estimatedCallFixture(t, overrides = {}) {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: "Synthetic Growth Partners III",
  });
  const entry = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-10",
    amount: "25000.00",
    dateIsEstimated: true,
  });
  const document = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    uri: "fs://archive/Investments/Synthetic Growth Partners III/call.pdf",
    statements: overrides.statements ?? [
      org("fund", "Synthetic Growth Partners III"),
      money("amount_called", "25000.00"),
      date("due_date", "2026-03-12"),
    ],
  });
  return { ...base, investmentId, entryId: entry.id, document };
}

test("a second identical entry demotes the auto-link AND gives the date back", { skip }, async (t) => {
  const base = await estimatedCallFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  let entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-03-12");
  assert.equal(entry.dateIsEstimated, false);

  await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId: base.investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-20",
    amount: "25000.00",
  });
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.autoLinkedEntryId, null);

  const links = await linksFor(base, {});
  assert.deepEqual([...new Set(links.map((link) => link.state))], ["suggested"]);
  entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-03-10", "the guess comes back");
  assert.equal(entry.dateIsEstimated, true, "and is a guess again");
  assert.equal(entry.documentId, null);
  for (const link of links) assert.equal(link.dateCorrectionId, null);
  const rows = await dateCorrections(base);
  assert.equal(rows.length, 2, "moved, then put back, both recorded");
  await consistent(base.ctx);
});

test("a document corrected to name nothing gives the date back and drops the row", { skip }, async (t) => {
  const base = await estimatedCallFixture(t);
  // No folder to fall back on, so correcting the party leaves the document
  // matching nothing at all -- which used to end the pass before the sweep.
  await base.ctx.client.query(
    "UPDATE kith.source_items SET uri = 'fs://archive/Unsorted/scan.pdf' WHERE id = $1",
    [base.document.sourceItemId],
  );
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal((await entryRow(base)).entryDate, "2026-03-12");

  await base.ctx.client.query(
    `UPDATE kith.observations
        SET value = '{"type":"text","value":"A Different Fund"}'::jsonb
      WHERE space_id = $1 AND observation_key = 'fund'`,
    [base.spaceId],
  );
  await base.ctx.client.query(
    `UPDATE kith.observations
        SET value = '{"type":"money","amount":"9.99","currency":"USD"}'::jsonb
      WHERE space_id = $1 AND observation_key = 'amount_called'`,
    [base.spaceId],
  );
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(result.reason, "no_investment_matched");
  assert.deepEqual(await linksFor(base, {}), [], "the stale row is gone");
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-03-10");
  assert.equal(entry.dateIsEstimated, true);
  assert.equal(entry.documentId, null);
  await consistent(base.ctx);
});

test("an owner-confirmed link is never swept, whatever the rule now thinks", { skip }, async (t) => {
  const base = await estimatedCallFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId: base.investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-20",
    amount: "25000.00",
  });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const after = (await linksFor(base, { entryIds: [base.entryId] }))[0];
  assert.equal(after.state, "confirmed");
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-03-12", "his decision keeps its date");
  assert.equal(entry.documentId, base.document.documentId);
  await consistent(base.ctx);
});

test("a re-extracted date moves the entry only while the entry still holds this link's date", { skip }, async (t) => {
  const base = await estimatedCallFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal((await entryRow(base)).entryDate, "2026-03-12");

  await base.ctx.client.query(
    `UPDATE kith.observations
        SET value = '{"type":"date","value":"2026-03-13"}'::jsonb
      WHERE space_id = $1 AND observation_key = 'due_date'`,
    [base.spaceId],
  );
  const result = await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.deepEqual(result.datesReplaced, [base.entryId]);
  assert.equal((await entryRow(base)).entryDate, "2026-03-13");
  const rows = await dateCorrections(base);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].original_value, "2026-03-12");
  assert.equal(rows[1].corrected_value, "2026-03-13");

  // Now the owner types a date of his own, and the document changes again.
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    entryDate: "2026-03-01",
  });
  await base.ctx.client.query(
    `UPDATE kith.observations
        SET value = '{"type":"date","value":"2026-03-14"}'::jsonb
      WHERE space_id = $1 AND observation_key = 'due_date'`,
    [base.spaceId],
  );
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal(
    (await entryRow(base)).entryDate,
    "2026-03-01",
    "his date is not the one this link wrote, so nothing moves",
  );
});

test("retyping the very date the document gave still makes it his", { skip }, async (t) => {
  const base = await estimatedCallFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  // He retypes 2026-03-12 -- the same day the notice gave. Without clearing
  // the link's claim, rejecting would read "still my date" and revert it.
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    entryDate: "2026-03-12",
  });
  assert.equal((await linksFor(base, {}))[0].dateCorrectionId, null);

  const rejected = await rejectInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: link.id,
  });
  assert.equal(rejected.dateReverted, false);
  const entry = await entryRow(base);
  assert.equal(entry.entryDate, "2026-03-12", "his date stands");
  assert.equal(entry.dateIsEstimated, false);
  await consistent(base.ctx);
});

// ---------------------------------------------------------------------------
// More than one live link, and the primary (second review)
// ---------------------------------------------------------------------------

/** The wire that paid the same call the notice announced. */
async function seedWire(base) {
  return seedDocument(base.ctx, base.spaceId, {
    kind: "wire_confirmation",
    statements: [
      org("sender", "Synthetic Growth Partners III"),
      money("amount_sent", "25000.00"),
      date("value_date", "2026-03-11"),
    ],
  });
}

test("a notice and the wire that paid it can both be confirmed", { skip }, async (t) => {
  const base = await estimatedCallFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  assert.equal((await linksFor(base, {}))[0].state, "auto_linked");

  const wire = await seedWire(base);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: wire.sourceItemId,
  });
  const [offered] = await linksFor(base, { sourceItemId: wire.sourceItemId });
  assert.equal(offered.state, "suggested");

  // The second confirmation is allowed. It used to be refused, which left the
  // wire as an offer nobody could act on.
  const confirmed = await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: offered.id,
  });
  assert.equal(confirmed.dateReplaced, false, "only the primary dates an entry");
  const live = (await linksFor(base, { entryIds: [base.entryId] })).filter(
    (link) => link.state === "auto_linked" || link.state === "confirmed",
  );
  assert.equal(live.length, 2);
  const entry = await entryRow(base);
  assert.equal(
    entry.documentId,
    base.document.documentId,
    "the mirror follows the primary, which is the older link",
  );
  assert.equal(entry.entryDate, "2026-03-12", "the notice's date, not the wire's");
  await consistent(base.ctx);
});

/**
 * Every link on the entry, the state of the entry itself, and how many rows
 * the change feed holds: one comparable snapshot of what a re-evaluation must
 * not change.
 *
 * Each link carries its `id` and both of its timestamps, so "nothing moved"
 * means the ROWS were not touched rather than merely that they still say the
 * same thing. A re-evaluation that rewrote a settled row with identical
 * values would keep every earlier assertion true and still be wrong: it fires
 * the change feed on every nightly sweep, and `created_at` is what decides
 * which link is PRIMARY.
 *
 * Sorted by `created_at` then source item, never by id. Ids are random, so an
 * assertion whose order depends on them passes or fails by luck -- which is
 * exactly how this helper's first version reached CI.
 */
async function settlement(base) {
  const links = await linksFor(base, { entryIds: [base.entryId] });
  const entry = await entryRow(base);
  const changes = await base.ctx.client.query(
    "SELECT count(*)::int AS n FROM kith.changes WHERE space_id = $1",
    [base.spaceId],
  );
  return {
    links: links
      .map((link) => ({
        sourceItemId: link.sourceItemId,
        id: link.id,
        state: link.state,
        decidedBy: link.decidedBy,
        createdAt: link.createdAt,
        decidedAt: link.decidedAt,
      }))
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.sourceItemId.localeCompare(right.sourceItemId),
      ),
    entryDate: entry.entryDate,
    dateIsEstimated: entry.dateIsEstimated,
    documentId: entry.documentId,
    corrections: (await dateCorrections(base)).length,
    changes: changes.rows[0].n,
  };
}

/** The snapshot's `links`, as the short strings the readable assertions use.
 * Sorted the same way, so neither side depends on a random id. */
function linkStates(snapshot) {
  return snapshot.links.map(
    (link) => `${link.sourceItemId}:${link.state}:${link.decidedBy}`,
  );
}

test("a document the owner has settled beside is not demoted by its own neighbour", { skip }, async (t) => {
  // The shape this exists for: a capital call notice auto-links and moves the
  // estimated date; the wire confirmation for the SAME payment is offered and
  // the owner confirms it. Re-evaluating the notice then saw the wire as "a
  // live link from another document", refused its own auto-link as
  // `entry_already_linked`, and the sweep demoted it -- taking the date back
  // to the guess, moving the mirror to the wire and writing two more
  // correction rows, all for a document nobody had said anything about.
  const base = await estimatedCallFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const wire = await seedWire(base);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: wire.sourceItemId,
  });
  const [offered] = await linksFor(base, { sourceItemId: wire.sourceItemId });
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: offered.id,
  });

  const settled = await settlement(base);
  // In `created_at` order: the notice auto-linked first, the wire came after.
  // Never in id order -- ids are random and an assertion that depends on them
  // passes or fails by luck.
  assert.deepEqual(linkStates(settled), [
    `${base.document.sourceItemId}:auto_linked:rule`,
    `${wire.sourceItemId}:confirmed:owner`,
  ]);
  assert.equal(settled.entryDate, "2026-03-12");
  assert.equal(settled.dateIsEstimated, false);
  assert.equal(settled.documentId, base.document.documentId);
  assert.equal(settled.corrections, 1);

  // Both orders, twice. A sweep is not a one-shot: it runs nightly, and
  // "stable" has to mean stable.
  for (const order of [
    [base.document.sourceItemId, wire.sourceItemId],
    [wire.sourceItemId, base.document.sourceItemId],
  ]) {
    for (let run = 0; run < 2; run += 1) {
      for (const sourceItemId of order) {
        await evaluateDocumentLinks(base.ctx, {
          spaceId: base.spaceId,
          sourceItemId,
        });
      }
      assert.deepEqual(
        await settlement(base),
        settled,
        `re-evaluation changed something on run ${run} of ${order.join(",")}`,
      );
    }
  }
  await consistent(base.ctx);
});

test("the same holds when the wire arrives first and the notice second", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: "Synthetic Growth Partners III",
  });
  const entry = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-10",
    amount: "25000.00",
    dateIsEstimated: true,
  });
  const scoped = { ...base, investmentId, entryId: entry.id };
  const wire = await seedWire(scoped);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: wire.sourceItemId,
  });
  const notice = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", "Synthetic Growth Partners III"),
      money("amount_called", "25000.00"),
      date("due_date", "2026-03-12"),
    ],
  });
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: notice.sourceItemId,
  });
  const [offered] = await linksFor(scoped, { sourceItemId: notice.sourceItemId });
  assert.equal(offered.state, "suggested", "the second document is offered");
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: offered.id,
  });

  const withEntry = { ...scoped, document: wire };
  const settled = await settlement(withEntry);
  assert.equal(settled.entryDate, "2026-03-11", "the wire dated it, being first");
  assert.equal(settled.documentId, wire.documentId);

  for (let run = 0; run < 2; run += 1) {
    for (const sourceItemId of [wire.sourceItemId, notice.sourceItemId]) {
      await evaluateDocumentLinks(base.ctx, { spaceId: base.spaceId, sourceItemId });
    }
    assert.deepEqual(await settlement(withEntry), settled, `run ${run}`);
  }
  await consistent(base.ctx);
});

test("rejecting the primary promotes the next live link and re-runs the date rule", { skip }, async (t) => {
  const base = await estimatedCallFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [notice] = await linksFor(base, {});
  const wire = await seedWire(base);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: wire.sourceItemId,
  });
  const [offered] = await linksFor(base, { sourceItemId: wire.sourceItemId });
  await confirmInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: offered.id,
  });

  const rejected = await rejectInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: notice.id,
  });
  assert.equal(rejected.dateReverted, true, "the notice's date goes back");
  assert.equal(rejected.dateReplaced, true, "and the wire's takes its place");
  const entry = await entryRow(base);
  assert.equal(entry.documentId, wire.documentId, "the wire is now the primary");
  assert.equal(entry.entryDate, "2026-03-11", "dated by the wire");
  assert.equal(entry.dateIsEstimated, false);
  await consistent(base.ctx);
});

// ---------------------------------------------------------------------------
// The foreign keys that clear one column (second review)
// ---------------------------------------------------------------------------

test("deleting a document under a link clears its document and keeps the row", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  // A bare composite `ON DELETE SET NULL` would null `space_id` too and fail
  // with 23502 here.
  await base.ctx.client.query("DELETE FROM kith.documents WHERE id = $1", [
    base.document.documentId,
  ]);
  const after = await linksFor(base, {});
  assert.equal(after.length, 1, "the row survives, so a rejection would too");
  assert.equal(after[0].id, link.id);
  assert.equal(after[0].documentId, null);
  assert.equal(after[0].spaceId, base.spaceId);
  assert.equal(after[0].sourceItemId, base.document.sourceItemId);
});

test("deleting a correction under a link clears only the correction id", { skip }, async (t) => {
  const base = await estimatedCallFixture(t);
  await evaluateDocumentLinks(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.document.sourceItemId,
  });
  const [link] = await linksFor(base, {});
  assert.equal(typeof link.dateCorrectionId, "string");
  await base.ctx.client.query("DELETE FROM kith.corrections WHERE id = $1", [
    link.dateCorrectionId,
  ]);
  const after = await linksFor(base, {});
  assert.equal(after.length, 1);
  assert.equal(after[0].dateCorrectionId, null);
  assert.equal(after[0].spaceId, base.spaceId);
});
