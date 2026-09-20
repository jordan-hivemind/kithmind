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
  confirmInvestmentDocumentLink,
  createInvestment,
  createInvestmentEntry,
  evaluateDocumentLinks,
  getInvestment,
  listInvestmentDocumentLinks,
  listInvestmentEntries,
  rejectInvestmentDocumentLink,
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
 * of its one live link, or be null when it has none. A row that fails this is
 * a mirror that has drifted from its source of truth, which is the whole
 * failure mode the link table was introduced to make impossible.
 */
async function consistent(ctx) {
  const drift = await ctx.client.query(
    `SELECT e.id, e.document_id, l.document_id AS link_document_id
       FROM kith.investment_entries e
       LEFT JOIN kith.investment_document_links l
         ON l.space_id = e.space_id AND l.entry_id = e.id
        AND l.state IN ('auto_linked', 'confirmed')
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

    assert.equal(await applyKithSchema(client), 33);

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

test("detaching a document rejects the link, so nothing puts it back", { skip }, async (t) => {
  const base = await autoLinkFixture(t);
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    documentId: base.document.documentId,
  });
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.entryId,
    investmentId: base.investmentId,
    documentId: null,
  });
  const links = await linksFor(base, {});
  assert.equal(links[0].state, "rejected");
  assert.equal(links[0].reason, "owner_detached");
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
