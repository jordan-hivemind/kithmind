// `investment_link` as deferred work (ADM-8c, slice 2), against a real
// database and a real drain.
//
// Slice 1 proved the scorer decides correctly when something calls it. This
// file proves the calling: that the three triggers put exactly one job per
// document in `kith.deferred_work`, that one drain turns those jobs into the
// same decisions, that a second drain over an unchanged database writes
// nothing at all, and that none of it can reach across a space.
//
// THE CHANGE FEED IS THE IDEMPOTENCE ORACLE. "Wrote nothing" is asserted as
// `kith.changes` not growing, not as the rows still saying the same thing: a
// rewrite with identical values still moves `decided_at`, still fires the
// `record_change` trigger, and still makes every open screen refresh. The
// count is what catches that; equality of the rows is not.
//
// Synthetic fixtures throughout. No real fund, no real amount, no real date.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createKithPool,
  newKithId,
  withKithTransaction,
} from "../dist/index.js";
import {
  archiveInvestment,
  createInvestment,
  createInvestmentEntry,
  investmentLinkDedupeKey,
  listInvestmentDocumentLinks,
  listInvestmentEntries,
  rejectInvestmentDocumentLink,
  scheduleInvestmentLinkBackfill,
  scheduleInvestmentLinkForExtraction,
  scheduleInvestmentLinksFor,
  updateInvestment,
  updateInvestmentEntry,
} from "../dist/admin/index.js";
import {
  defaultRegistry,
  drain,
  schedule,
  deferredCtx,
} from "../dist/deferred/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";
import {
  date,
  money,
  org,
  seedDocument,
} from "./helpers/investmentDocuments.mjs";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const FUND = "Synthetic Meridian Partners IV";

async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const pool = createKithPool(database.databaseUrl, 5);
  // The throwaway database is dropped `WITH (FORCE)` in this test's cleanup,
  // which terminates idle pooled connections; without a listener `pg.Pool`
  // turns that into an uncaught `error` event.
  pool.on("error", () => {});
  t.after(() => pool.end());
  return {
    ...database,
    ctx,
    pool,
    userId,
    spaceId,
    principal: { userId, credentialId: null },
    registry: defaultRegistry(),
  };
}

/** A second space with its own owner, for the isolation test. */
async function otherSpace(base) {
  const userId = await makeUser(base.ctx, { name: "Other owner" });
  const spaceId = await makeSpace(base.ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  return { spaceId, principal: { userId, credentialId: null } };
}

function run(base, now = NOW) {
  return drain(base.pool, base.registry, { now });
}

/** The `investment_link` jobs still waiting, oldest key first. A drained job
 * is `done` and leaves its key free, which is what makes the next edit able to
 * enqueue the same document again. */
async function queuedKeys(base) {
  const found = await base.client.query(
    `SELECT dedupe_key, state FROM kith.deferred_work
      WHERE kind = 'investment_link' AND state IN ('queued', 'running')
      ORDER BY dedupe_key`,
  );
  return found.rows;
}

/**
 * The change feed, restricted to the three tables a decision writes.
 *
 * `kith.deferred_work` carries the same trigger and its rows move on every
 * claim and every completion, which is the queue doing its job rather than a
 * decision changing. Counting those would make this oracle always grow and
 * prove nothing. What must not grow is the feed the screens refresh from:
 * the links, the entries they mirror onto, and the corrections a moved date
 * is recorded as.
 */
async function changeCount(base) {
  const found = await base.client.query(
    `SELECT table_name, op, count(*)::int AS n FROM kith.changes
      WHERE table_name IN ('investment_document_links', 'investment_entries',
                           'corrections')
      GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  return found.rows;
}

async function linkSnapshot(base, spaceId = base.spaceId) {
  const found = await base.client.query(
    `SELECT id, source_item_id, entry_id, state, score, decided_at, created_at
       FROM kith.investment_document_links
      WHERE space_id = $1 ORDER BY source_item_id, id`,
    [spaceId],
  );
  return found.rows;
}

async function entryRow(base, investmentId, entryId) {
  const entries = await listInvestmentEntries(
    base.ctx,
    [base.spaceId],
    [investmentId],
  );
  return entries.find((entry) => entry.id === entryId) ?? null;
}

/**
 * The world the acceptance line describes: one investment, two entries, four
 * documents, and every one of the three triggers fired before a single drain.
 *
 * The documents are seeded with SQL rather than read by a model, for the
 * reason `helpers/investmentDocuments.mjs` gives: what is under test here is
 * the queue, not the reader. `scheduleInvestmentLinkForExtraction` is the
 * exact function `store` calls, so trigger one is the real one; the test
 * below named for it proves `store` calls it.
 */
async function acceptanceFixture(t) {
  const base = await fixture(t);
  const notice = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    title: "Call notice",
    statements: [
      org("fund", FUND),
      money("amount_called", "25000.00"),
      date("due_date", "2026-04-02"),
    ],
  });
  const distNotice = await seedDocument(base.ctx, base.spaceId, {
    kind: "distribution_notice",
    title: "Distribution notice",
    statements: [
      org("fund", FUND),
      // Not the entry's amount: party and date alone reach 6, which is a
      // suggestion and must never be a link.
      money("amount_distributed", "7777.00"),
      date("distribution_date", "2026-04-20"),
    ],
  });
  const owned = await seedDocument(base.ctx, base.spaceId, {
    kind: "distribution_notice",
    title: "The one he says no to",
    statements: [
      org("fund", FUND),
      money("amount_distributed", "5000.00"),
      date("distribution_date", "2026-04-16"),
    ],
  });
  const stranger = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    title: "Someone else's call",
    statements: [
      org("fund", "Synthetic Unrelated Holdings"),
      money("amount_called", "123.45"),
      date("due_date", "2026-05-01"),
    ],
  });

  // Trigger two, first half: a new investment is a new party name for paper
  // already in the store to be about.
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: FUND,
  });
  // Trigger two, second half: two entries, one with an estimated date and one
  // the owner dated himself.
  const call = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-31",
    amount: "25000.00",
    dateIsEstimated: true,
  });
  const distribution = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "distribution",
    entryDate: "2026-04-15",
    amount: "5000.00",
    documentId: owned.documentId,
  });

  // Trigger one, for every document: this is what `store` calls at the end of
  // an extraction.
  for (const [document, kind] of [
    [notice, "capital_call_notice"],
    [distNotice, "distribution_notice"],
    [owned, "distribution_notice"],
    [stranger, "capital_call_notice"],
  ]) {
    await scheduleInvestmentLinkForExtraction(base.ctx, {
      spaceId: base.spaceId,
      sourceItemId: document.sourceItemId,
      kind,
    });
  }

  // Trigger three: the owner takes the attached document back off. It is the
  // strongest candidate the distribution has -- party, amount and date all
  // fire -- so the drain below is a real test of "never re-proposed".
  const attached = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {
    entryIds: [distribution.id],
  });
  assert.equal(attached.length, 1);
  await rejectInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: attached[0].id,
  });

  return {
    ...base,
    investmentId,
    callId: call.id,
    distributionId: distribution.id,
    notice,
    distNotice,
    owned,
    stranger,
  };
}

// ---------------------------------------------------------------------------
// The acceptance line
// ---------------------------------------------------------------------------

test("fixture documents link themselves through one drain", { skip }, async (t) => {
  const base = await acceptanceFixture(t);

  // One job per document, whatever woke it, and nothing for the documents
  // that no trigger touched.
  const queued = await queuedKeys(base);
  assert.deepEqual(
    queued.map((row) => row.dedupe_key).sort(),
    [base.notice, base.distNotice, base.owned, base.stranger]
      .map((document) => investmentLinkDedupeKey(document.sourceItemId))
      .sort(),
  );
  for (const row of queued) assert.equal(row.state, "queued");

  const summary = await run(base);
  assert.equal(summary.claimed, 4);
  assert.equal(summary.completed, 4);
  assert.equal(summary.retrying, 0);
  assert.equal(summary.exhausted, 0);
  assert.equal(summary.terminal, 0);
  assert.equal(summary.unregisteredKind, 0);

  const links = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {});

  // AUTO. Party, amount and date all fire on the call notice, exactly one
  // entry qualifies, and the kind is auto-linkable.
  const auto = links.filter(
    (link) => link.sourceItemId === base.notice.sourceItemId,
  );
  assert.equal(auto.length, 1);
  assert.equal(auto[0].state, "auto_linked");
  assert.equal(auto[0].decidedBy, "rule");
  assert.equal(auto[0].entryId, base.callId);

  // SUGGEST. Party and date, and an amount that disagrees: six points is an
  // offer, never a link.
  const suggested = links.filter(
    (link) => link.sourceItemId === base.distNotice.sourceItemId,
  );
  assert.equal(suggested.length, 1);
  assert.equal(suggested[0].state, "suggested");
  assert.equal(suggested[0].entryId, base.distributionId);

  // NONE. A document naming an investment the owner does not have, for an
  // amount no entry claims, writes no row at all.
  assert.deepEqual(
    links.filter((link) => link.sourceItemId === base.stranger.sourceItemId),
    [],
  );

  // REMEMBERED. The rejected pair stays rejected and is never re-offered,
  // although it is the one that would have scored ten.
  const rejected = links.filter(
    (link) => link.sourceItemId === base.owned.sourceItemId,
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].state, "rejected");

  // THE DATE RULE, on the estimated entry only.
  const call = await entryRow(base, base.investmentId, base.callId);
  assert.equal(call.entryDate, "2026-04-02", "the notice dated the payment");
  assert.equal(call.dateIsEstimated, false);
  assert.equal(call.documentId, base.notice.documentId);
  const distribution = await entryRow(base, base.investmentId, base.distributionId);
  assert.equal(
    distribution.entryDate,
    "2026-04-15",
    "a date the owner stated is never moved",
  );
  assert.equal(distribution.documentId, null);

  const corrections = await base.client.query(
    `SELECT target_id, field_name, original_value, corrected_value
       FROM kith.corrections
      WHERE detector = 'investment_link_date' ORDER BY created_at`,
  );
  assert.equal(corrections.rows.length, 1, "one date moved, one row recording it");
  assert.equal(corrections.rows[0].target_id, base.callId);
  assert.equal(corrections.rows[0].original_value, "2026-03-31");
  assert.equal(corrections.rows[0].corrected_value, "2026-04-02");
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

test("a second drain writes nothing and the change feed does not grow", { skip }, async (t) => {
  const base = await acceptanceFixture(t);
  await run(base);

  const before = await linkSnapshot(base);
  const changesBefore = await changeCount(base);
  const callBefore = await entryRow(base, base.investmentId, base.callId);

  // Every document again, as a nightly sweep or a re-parse would.
  for (const document of [base.notice, base.distNotice, base.owned, base.stranger]) {
    await withKithTransaction(base.pool, (client) =>
      schedule(deferredCtx(client, NOW + 1_000), {
        kind: "investment_link",
        spaceId: base.spaceId,
        payload: {
          spaceId: base.spaceId,
          sourceItemId: document.sourceItemId,
        },
        dedupeKey: investmentLinkDedupeKey(document.sourceItemId),
      }),
    );
  }
  const summary = await run(base, NOW + 2_000);
  assert.equal(summary.claimed, 4);
  assert.equal(summary.completed, 4);

  // The rows are the same rows, with the same decided_at: not merely rows
  // that still say the same thing.
  assert.deepEqual(await linkSnapshot(base), before);
  assert.deepEqual(
    await changeCount(base),
    changesBefore,
    "a decision that has not changed writes nothing the screens refresh from",
  );
  const callAfter = await entryRow(base, base.investmentId, base.callId);
  assert.deepEqual(callAfter, callBefore);
});

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

test("a burst of edits produces one job per document, not one per save", { skip }, async (t) => {
  const base = await acceptanceFixture(t);
  await run(base);
  assert.deepEqual(await queuedKeys(base), []);

  // Twelve saves of one entry, the shape the drawer produces while the owner
  // types a number.
  for (let index = 0; index < 12; index += 1) {
    await updateInvestmentEntry(base.ctx, {
      principal: base.principal,
      entryId: base.callId,
      amount: `${25100 + index}.00`,
    });
  }
  // Three documents, once each, from twelve saves. They are the three that
  // already hold a link row for this investment -- the mandatory half of the
  // fan-out, which is never sampled, because a link left standing behind an
  // amount that has moved is the silent wrong data this slice exists to
  // stop. The stranger's notice names another fund and matches no amount, so
  // it is not woken at all.
  assert.deepEqual(
    (await queuedKeys(base)).map((row) => row.dedupe_key).sort(),
    [base.notice, base.distNotice, base.owned]
      .map((document) => investmentLinkDedupeKey(document.sourceItemId))
      .sort(),
  );

  // A save that changes nothing the matcher scores wakes nothing at all.
  await run(base);
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.callId,
    note: "a note is not a match signal",
  });
  assert.deepEqual(await queuedKeys(base), []);

  // Nor does re-saving the same amount in a different spelling.
  await updateInvestmentEntry(base.ctx, {
    principal: base.principal,
    entryId: base.callId,
    amount: "25111",
  });
  assert.deepEqual(await queuedKeys(base), []);
});

test("an investment's name wakes its documents and its category does not", { skip }, async (t) => {
  const base = await acceptanceFixture(t);
  await run(base);

  await updateInvestment(base.ctx, {
    principal: base.principal,
    investmentId: base.investmentId,
    category: "venture",
    notes: "still the same fund",
  });
  assert.deepEqual(await queuedKeys(base), []);

  await updateInvestment(base.ctx, {
    principal: base.principal,
    investmentId: base.investmentId,
    name: `${FUND} (renamed)`,
  });
  const renamed = (await queuedKeys(base)).map((row) => row.dedupe_key).sort();
  assert.deepEqual(
    renamed,
    [base.notice, base.distNotice, base.owned]
      .map((document) => investmentLinkDedupeKey(document.sourceItemId))
      .sort(),
    "every document that holds a link for it, and none of the strangers",
  );

  await run(base);
  // Archiving is a party change too: the matcher stops seeing the investment,
  // so a live link behind it has to be re-examined rather than left standing.
  await archiveInvestment(base.ctx, {
    principal: base.principal,
    investmentId: base.investmentId,
  });
  assert.ok(
    (await queuedKeys(base)).some(
      (row) =>
        row.dedupe_key === investmentLinkDedupeKey(base.notice.sourceItemId),
    ),
  );
});

// ---------------------------------------------------------------------------
// Trigger one, through the extraction path it actually lives on
// ---------------------------------------------------------------------------

test("a stored extraction enqueues the document, and only an investment kind", { skip }, async (t) => {
  const base = await fixture(t);
  const document = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [org("fund", FUND), money("amount_called", "100.00")],
  });

  // A kind the scorer has no rules for is not a job: `evaluateDocumentLinks`
  // would return `kind_not_matchable` without writing anything, so the row
  // would exist to do nothing.
  assert.equal(
    await scheduleInvestmentLinkForExtraction(base.ctx, {
      spaceId: base.spaceId,
      sourceItemId: document.sourceItemId,
      kind: "receipt",
    }),
    null,
  );
  assert.deepEqual(await queuedKeys(base), []);

  const first = await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: document.sourceItemId,
    kind: "capital_call_notice",
  });
  assert.equal(first.deduped, false);
  // A re-extraction of the same document while the first job is still queued
  // collapses onto it.
  const again = await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: document.sourceItemId,
    kind: "capital_call_notice",
  });
  assert.equal(again.deduped, true);
  assert.equal(again.id, first.id);
  assert.equal((await queuedKeys(base)).length, 1);

  // And it is a quiet success: no investment exists to match, so the drain
  // completes the job and writes no link and no attention row.
  const summary = await run(base);
  assert.equal(summary.completed, 1);
  assert.deepEqual(
    await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {}),
    [],
  );
  const corrections = await base.client.query(
    "SELECT count(*)::int AS n FROM kith.corrections",
  );
  assert.equal(corrections.rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// The rejection
// ---------------------------------------------------------------------------

test("a rejection frees the entry and the next drain re-evaluates the rest", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: FUND,
  });
  const entry = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-31",
    amount: "25000.00",
  });
  // Two notices that both score ten against the one entry. Whichever is
  // drained first takes it; the second finds the entry spoken for and can
  // only offer itself. That is the state a rejection has to be able to
  // resolve, and it is not a tie: a tie is two ENTRIES for one document.
  const first = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", FUND),
      money("amount_called", "25000.00"),
      date("due_date", "2026-04-02"),
    ],
  });
  const second = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", FUND),
      money("amount_called", "25000.00"),
      date("due_date", "2026-04-03"),
    ],
  });
  for (const document of [first, second]) {
    await scheduleInvestmentLinkForExtraction(base.ctx, {
      spaceId: base.spaceId,
      sourceItemId: document.sourceItemId,
      kind: "capital_call_notice",
    });
  }
  await run(base);

  const offered = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {});
  assert.equal(offered.length, 2);
  const taken = offered.filter((link) => link.state === "auto_linked");
  const waiting = offered.filter((link) => link.state === "suggested");
  assert.equal(taken.length, 1, "one document takes the entry");
  assert.equal(waiting.length, 1, "the other can only offer itself");
  assert.equal(taken[0].entryId, entry.id);

  await rejectInvestmentDocumentLink(base.ctx, {
    principal: base.principal,
    linkId: taken[0].id,
  });

  // The rejection enqueued the documents that score against this entry, its
  // own included -- it may belong on a different entry of the same fund.
  assert.deepEqual(
    (await queuedKeys(base)).map((row) => row.dedupe_key).sort(),
    [first, second]
      .map((document) => investmentLinkDedupeKey(document.sourceItemId))
      .sort(),
  );

  await run(base, NOW + 1_000);
  const after = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {});
  assert.equal(after.length, 2, "no third row was invented");
  const rejected = after.find((link) => link.id === taken[0].id);
  assert.equal(rejected.state, "rejected", "never re-proposed");
  const survivor = after.find((link) => link.id === waiting[0].id);
  assert.equal(
    survivor.state,
    "auto_linked",
    "the entry is free, so the other notice takes it",
  );
  assert.equal(survivor.entryId, entry.id);
  const stored = await entryRow(base, investmentId, entry.id);
  assert.equal(stored.documentId, survivor.documentId);
});

// ---------------------------------------------------------------------------
// Space isolation
// ---------------------------------------------------------------------------

test("a job for one space never reads or links another", { skip }, async (t) => {
  const base = await fixture(t);
  const other = await otherSpace(base);

  // The same fund name and the same amount in both spaces. Only the id keeps
  // them apart, which is the point.
  const mine = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: FUND,
  });
  await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId: mine,
    entryType: "capital_call_paid",
    entryDate: "2026-03-31",
    amount: "25000.00",
  });
  const theirs = await createInvestment(base.ctx, {
    principal: other.principal,
    spaceId: other.spaceId,
    name: FUND,
  });
  const theirEntry = await createInvestmentEntry(base.ctx, {
    principal: other.principal,
    investmentId: theirs,
    entryType: "capital_call_paid",
    entryDate: "2026-03-31",
    amount: "25000.00",
  });
  const theirDocument = await seedDocument(base.ctx, other.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", FUND),
      money("amount_called", "25000.00"),
      date("due_date", "2026-04-02"),
    ],
  });

  // A job that names the OTHER space's document but carries this space's id:
  // the shape a cross-space bug would take.
  await withKithTransaction(base.pool, (client) =>
    schedule(deferredCtx(client, NOW), {
      kind: "investment_link",
      spaceId: base.spaceId,
      payload: {
        spaceId: base.spaceId,
        sourceItemId: theirDocument.sourceItemId,
      },
      dedupeKey: investmentLinkDedupeKey(theirDocument.sourceItemId),
    }),
  );
  const summary = await run(base);
  assert.equal(summary.completed, 1, "it finds no extraction, quietly");
  assert.deepEqual(await linkSnapshot(base, base.spaceId), []);
  assert.deepEqual(await linkSnapshot(base, other.spaceId), []);

  // The honest job, in the other space, links only there.
  await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: other.spaceId,
    sourceItemId: theirDocument.sourceItemId,
    kind: "capital_call_notice",
  });
  await run(base, NOW + 1_000);
  assert.deepEqual(await linkSnapshot(base, base.spaceId), []);
  const linked = await linkSnapshot(base, other.spaceId);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].entry_id, theirEntry.id);

  // And a payload whose space is not the job row's is terminal, not a retry
  // loop: no retry can make the two agree.
  await withKithTransaction(base.pool, (client) =>
    schedule(deferredCtx(client, NOW + 2_000), {
      kind: "investment_link",
      spaceId: base.spaceId,
      payload: {
        spaceId: other.spaceId,
        sourceItemId: theirDocument.sourceItemId,
      },
      dedupeKey: "investment_link:crossed",
    }),
  );
  const crossed = await run(base, NOW + 3_000);
  assert.equal(crossed.terminal, 1);
  assert.equal(crossed.retrying, 0);
  const failed = await base.client.query(
    `SELECT state, attempts, last_error FROM kith.deferred_work
      WHERE dedupe_key = 'investment_link:crossed'`,
  );
  assert.equal(failed.rows[0].state, "failed");
  assert.equal(Number(failed.rows[0].attempts), 0, "tried once, answered once");
  assert.match(failed.rows[0].last_error, /not in the job's space/);
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

test("a candidate limit is a recorded outcome, not a retry loop", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: FUND,
  });
  const document = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", FUND),
      money("amount_called", "25000.00"),
      date("due_date", "2026-04-02"),
    ],
  });
  // 201 candidate entries: one past `MAX_LINK_CANDIDATES`, where the scorer
  // refuses rather than scoring a prefix.
  for (let index = 0; index < 201; index += 1) {
    await base.client.query(
      `INSERT INTO kith.investment_entries
         (id, space_id, investment_id, entry_type, entry_date, amount,
          currency, date_is_estimated)
       VALUES ($1, $2, $3, 'capital_call_paid', DATE '2026-03-31', 1, 'USD',
               false)`,
      [newKithId(), base.spaceId, investmentId],
    );
  }
  await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: document.sourceItemId,
    kind: "capital_call_notice",
  });

  const summary = await run(base);
  assert.equal(summary.terminal, 1);
  assert.equal(summary.retrying, 0);
  assert.equal(summary.exhausted, 0);
  const row = (
    await base.client.query(
      `SELECT state, attempts, run_after, last_error FROM kith.deferred_work
        WHERE kind = 'investment_link'`,
    )
  ).rows[0];
  assert.equal(row.state, "failed");
  assert.equal(Number(row.attempts), 0);
  assert.match(row.last_error, /candidate_limit/);
  // And it stays failed: a second drain finds nothing due.
  assert.equal((await run(base, NOW + 60_000)).claimed, 0);
});

test("an unreadable payload is terminal too", { skip }, async (t) => {
  const base = await fixture(t);
  await withKithTransaction(base.pool, (client) =>
    schedule(deferredCtx(client, NOW), {
      kind: "investment_link",
      spaceId: base.spaceId,
      payload: { spaceId: base.spaceId },
      dedupeKey: "investment_link:bad-payload",
    }),
  );
  const summary = await run(base);
  assert.equal(summary.terminal, 1);
  const row = (
    await base.client.query(
      "SELECT state, last_error FROM kith.deferred_work WHERE kind = 'investment_link'",
    )
  ).rows[0];
  assert.equal(row.state, "failed");
  assert.match(row.last_error, /requires spaceId and sourceItemId/);
});

// ---------------------------------------------------------------------------
// The handler beside a concurrent owner
// ---------------------------------------------------------------------------

test("a concurrent owner edit serializes with the handler and neither is lost", { skip }, async (t) => {
  const base = await acceptanceFixture(t);
  await run(base);

  // The owner edits the linked entry's note while the same document's job is
  // draining. Both writes are `SERIALIZABLE` transactions on the same rows;
  // `withKithTransaction` retries whichever one the server aborts, so the
  // note survives and so does the link.
  await withKithTransaction(base.pool, (client) =>
    schedule(deferredCtx(client, NOW + 1_000), {
      kind: "investment_link",
      spaceId: base.spaceId,
      payload: {
        spaceId: base.spaceId,
        sourceItemId: base.notice.sourceItemId,
      },
      dedupeKey: investmentLinkDedupeKey(base.notice.sourceItemId),
    }),
  );
  const [summary] = await Promise.all([
    run(base, NOW + 2_000),
    updateInvestmentEntry(base.ctx, {
      principal: base.principal,
      entryId: base.callId,
      note: "typed while the daemon was running",
    }),
  ]);
  assert.equal(summary.completed, 1);
  assert.equal(summary.retrying, 0);

  const entry = await entryRow(base, base.investmentId, base.callId);
  assert.equal(entry.note, "typed while the daemon was running");
  assert.equal(entry.entryDate, "2026-04-02", "the link's date still stands");
  assert.equal(entry.documentId, base.notice.documentId);
  const links = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {
    entryIds: [base.callId],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].state, "auto_linked");
});

// ---------------------------------------------------------------------------
// The backfill
// ---------------------------------------------------------------------------

test("the backfill dry run counts exactly what --apply enqueues", { skip }, async (t) => {
  const base = await acceptanceFixture(t);
  await run(base);
  assert.deepEqual(await queuedKeys(base), []);

  const dry = await withKithTransaction(base.pool, (client) =>
    scheduleInvestmentLinkBackfill(deferredCtx(client, NOW + 1_000), {
      spaceId: base.spaceId,
    }),
  );
  assert.deepEqual(dry, { considered: 4, alreadyQueued: 0, enqueued: 4 });
  assert.deepEqual(await queuedKeys(base), [], "a dry run writes nothing");

  const applied = await withKithTransaction(base.pool, (client) =>
    scheduleInvestmentLinkBackfill(deferredCtx(client, NOW + 2_000), {
      spaceId: base.spaceId,
      apply: true,
    }),
  );
  assert.deepEqual(applied, { considered: 4, alreadyQueued: 0, enqueued: 4 });
  assert.equal((await queuedKeys(base)).length, 4);

  // Run it again over the same queue: everything is already there, so it adds
  // nothing and says so.
  const second = await withKithTransaction(base.pool, (client) =>
    scheduleInvestmentLinkBackfill(deferredCtx(client, NOW + 3_000), {
      spaceId: base.spaceId,
      apply: true,
    }),
  );
  assert.deepEqual(second, { considered: 4, alreadyQueued: 4, enqueued: 0 });
  assert.equal((await queuedKeys(base)).length, 4);

  // `--kind` narrows to one kind, and `--limit` bounds the page.
  const oneKind = await withKithTransaction(base.pool, (client) =>
    scheduleInvestmentLinkBackfill(deferredCtx(client, NOW + 4_000), {
      spaceId: base.spaceId,
      kind: "capital_call_notice",
    }),
  );
  assert.equal(oneKind.considered, 2);
  const bounded = await withKithTransaction(base.pool, (client) =>
    scheduleInvestmentLinkBackfill(deferredCtx(client, NOW + 5_000), {
      spaceId: base.spaceId,
      limit: 1,
    }),
  );
  assert.equal(bounded.considered, 1);

  // And it never evaluates inline: the links are still only the ones the
  // earlier drain made.
  assert.equal(
    (await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {})).length,
    3,
  );
});

test("the fan-out never scans past its own bound", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: FUND,
  });
  // Documents that name the fund, and one that names nobody. The fan-out
  // wakes the first two and leaves the third alone: "only the documents that
  // could be affected", not the whole space.
  const named = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [org("fund", FUND), money("amount_called", "9.00")],
  });
  const byPath = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    uri: `fs://archive/Investments/${FUND}/call.pdf`,
    statements: [org("fund", "Nobody In Particular")],
  });
  const unrelated = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [org("fund", "Nobody In Particular")],
  });
  // A distribution notice: the wrong kind for a capital call entry, so an
  // entry trigger must not wake it even though it names the fund.
  const wrongKind = await seedDocument(base.ctx, base.spaceId, {
    kind: "distribution_notice",
    statements: [org("fund", FUND)],
  });

  const investmentWide = await withKithTransaction(base.pool, (client) =>
    scheduleInvestmentLinksFor(deferredCtx(client, NOW), {
      spaceId: base.spaceId,
      investmentId,
    }),
  );
  assert.equal(investmentWide.linked, 0);
  assert.equal(investmentWide.candidates, 3, "party, path and the other kind");
  assert.deepEqual(
    (await queuedKeys(base)).map((row) => row.dedupe_key).sort(),
    [named, byPath, wrongKind]
      .map((document) => investmentLinkDedupeKey(document.sourceItemId))
      .sort(),
  );
  assert.ok(
    !(await queuedKeys(base)).some(
      (row) =>
        row.dedupe_key === investmentLinkDedupeKey(unrelated.sourceItemId),
    ),
  );

  await run(base);
  // An entry-level fan-out narrows to the kinds that may be about its type.
  await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-31",
    amount: "9.00",
  });
  assert.deepEqual(
    (await queuedKeys(base)).map((row) => row.dedupe_key).sort(),
    [named, byPath]
      .map((document) => investmentLinkDedupeKey(document.sourceItemId))
      .sort(),
    "a distribution notice is never about a capital call",
  );
});
