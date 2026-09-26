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
  withKithQueueTransaction,
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
  runInvestmentLinkJob,
  scheduleInvestmentLink,
  scheduleInvestmentLinkBackfill,
  scheduleInvestmentLinkForExtraction,
  scheduleInvestmentLinksFor,
  updateInvestment,
  updateInvestmentEntry,
} from "../dist/admin/index.js";
import {
  claim,
  complete,
  defaultRegistry,
  drain,
  schedule,
  deferredCtx,
} from "../dist/deferred/index.js";
import { identityCtx } from "../dist/identity/index.js";
import { resolveEntity } from "../dist/memory/index.js";
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
// A running job and a concurrent owner
// ---------------------------------------------------------------------------

/**
 * One investment, one capital call entry at 25,000, and the notice that
 * auto-links to it. The state the two tests below start their interleaving
 * from.
 */
async function autoLinkedFixture(t) {
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
  const notice = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", FUND),
      money("amount_called", "25000.00"),
      date("due_date", "2026-04-02"),
    ],
  });
  await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: notice.sourceItemId,
    kind: "capital_call_notice",
  });
  await run(base);
  const [link] = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {});
  assert.equal(link.state, "auto_linked");
  assert.equal(link.score, 10);
  return { ...base, investmentId, entryId: entry.id, notice, key: investmentLinkDedupeKey(notice.sourceItemId) };
}

/**
 * A raw `SERIALIZABLE` transaction this test drives by hand, because what is
 * under test is an interleaving and `withKithTransaction` has no seam in the
 * middle of one. The isolation and the search path are the ones it sets.
 *
 * `finish` is idempotent and every caller runs it from a `finally`. The
 * fixture's `pool.end()` waits for every checked-out client, so a connection
 * left open by a failed assertion would hang the suite rather than report it.
 */
async function openSerializable(base) {
  const client = await base.pool.connect();
  let open = true;
  const finish = async (verb) => {
    if (!open) return;
    open = false;
    try {
      await client.query(verb);
    } catch {
      // The transaction may already be aborted; the release is what matters.
    }
    client.release();
  };
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SET LOCAL search_path TO kith");
  return { client, finish };
}

test("a running job does not swallow a concurrent owner edit", { skip }, async (t) => {
  const base = await autoLinkedFixture(t);

  // A nightly pass, or a re-extraction: the document's job is queued again,
  // and the daemon claims it.
  await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.notice.sourceItemId,
    kind: "capital_call_notice",
  });
  const claimed = await withKithQueueTransaction(base.pool, (client) =>
    claim(deferredCtx(client, NOW + 1_000)),
  );
  assert.equal(claimed.dedupeKey, base.key);

  // The handler runs and reaches the same decision it did before -- the entry
  // still says 25,000 as far as its snapshot is concerned -- and has not
  // committed yet.
  const handler = await openSerializable(base);
  try {
    await runInvestmentLinkJob(
      deferredCtx(handler.client, NOW + 1_000),
      claimed.payload,
      claimed,
    );

    // The owner saves a different amount while that transaction is open. His
    // UPDATE may wait on the handler, so it is deliberately not awaited here.
    const save = withKithTransaction(base.pool, (client) =>
      updateInvestmentEntry(identityCtx(client, NOW + 2_000), {
        principal: base.principal,
        entryId: base.entryId,
        amount: "31000.00",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await handler.finish("COMMIT");
    await save;
  } finally {
    await handler.finish("ROLLBACK");
  }

  // THE BUG THIS PINS: the fan-out used to find the running row and
  // de-duplicate onto it, so the owner's edit was absorbed by a job that had
  // already read the old amount. Nothing new was queued, nothing errored, and
  // a wrong `auto_linked` row stayed -- the running row below was the only
  // one, and it was about to finish. A running job can no longer absorb an
  // edit: it gets a follow-up, one per running job.
  const pending = await queuedKeys(base);
  assert.deepEqual(
    pending.map((row) => row.dedupe_key).sort(),
    [base.key, `${base.key}:after:${claimed.id}`].sort(),
  );
  assert.equal(
    pending.find((row) => row.dedupe_key.endsWith(claimed.id)).state,
    "queued",
  );
  // A second save while the same job runs collapses onto that follow-up
  // rather than making a third row.
  await withKithTransaction(base.pool, (client) =>
    updateInvestmentEntry(identityCtx(client, NOW + 2_500), {
      principal: base.principal,
      entryId: base.entryId,
      amount: "31500.00",
    }),
  );
  assert.equal((await queuedKeys(base)).length, 2);

  await withKithQueueTransaction(base.pool, (client) =>
    complete(deferredCtx(client, NOW + 3_000), {
      id: claimed.id,
      leaseToken: claimed.leaseToken,
    }),
  );
  await run(base, NOW + 4_000);

  // What a fresh evaluation gives: party and date, no amount.
  const links = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {});
  assert.equal(links.length, 1);
  assert.equal(links[0].state, "suggested");
  assert.equal(links[0].score, 6);
  const entry = await entryRow(base, base.investmentId, base.entryId);
  assert.equal(entry.amount, "31500.00");
  assert.equal(entry.documentId, null, "the mirror followed the demotion");
});

test("a job claimed after the saver's snapshot is a serialization failure, not a swallowed edit", { skip }, async (t) => {
  const base = await autoLinkedFixture(t);
  await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: base.notice.sourceItemId,
    kind: "capital_call_notice",
  });

  // The saver's snapshot is taken here, while the job is still queued.
  const saver = await openSerializable(base);
  try {
    const seen = await saver.client.query(
      `SELECT state FROM kith.deferred_work
        WHERE kind = 'investment_link' AND dedupe_key = $1
          AND state IN ('queued', 'running')`,
      [base.key],
    );
    assert.equal(seen.rows[0].state, "queued");

    // The daemon claims it after that snapshot. The saver cannot see this.
    const claimed = await withKithQueueTransaction(base.pool, (client) =>
      claim(deferredCtx(client, NOW + 1_000)),
    );
    assert.equal(claimed.dedupeKey, base.key);

    // Reading the row `FOR UPDATE` is what refuses to decide on a stale
    // reading: the queued row the saver can still see has been claimed
    // since, so PostgreSQL raises 40001 and `withKithTransaction` retries
    // the whole save against a snapshot that sees the job running.
    await assert.rejects(
      () =>
        scheduleInvestmentLink(deferredCtx(saver.client, NOW + 2_000), {
          spaceId: base.spaceId,
          sourceItemId: base.notice.sourceItemId,
        }),
      (error) => error.code === "40001",
    );
  } finally {
    await saver.finish("ROLLBACK");
  }
});

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

test("a new alias on the investment's entity wakes the documents that use it", { skip }, async (t) => {
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
    amount: "9000.00",
  });
  // The notice calls the fund by a short name the owner has not taught the
  // store yet, and for an amount the entry does not claim. Nothing about it
  // reaches this investment.
  const notice = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", "SMP IV Fund"),
      money("amount_called", "25000.00"),
      date("due_date", "2026-04-02"),
    ],
  });
  await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: notice.sourceItemId,
    kind: "capital_call_notice",
  });
  await run(base);
  assert.deepEqual(
    await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {}),
    [],
  );

  // He teaches it the short name. The scorer reads aliases, so this changes
  // what that notice is about -- and nothing used to notice.
  await resolveEntity(base.ctx, base.userId, base.spaceId, {
    kind: "organization",
    name: FUND,
    aliases: ["SMP IV Fund"],
  });
  assert.deepEqual(
    (await queuedKeys(base)).map((row) => row.dedupe_key),
    [investmentLinkDedupeKey(notice.sourceItemId)],
  );

  await run(base, NOW + 1_000);
  const links = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {});
  assert.equal(links.length, 1);
  assert.equal(links[0].state, "suggested");
  assert.equal(links[0].entryId, entry.id);

  // Resolving the same entity again with nothing new changes no alias, so it
  // wakes nothing: this must not become a job per fact captured.
  await run(base, NOW + 2_000);
  await resolveEntity(base.ctx, base.userId, base.spaceId, {
    kind: "organization",
    name: FUND,
    aliases: ["SMP IV Fund"],
  });
  assert.deepEqual(await queuedKeys(base), []);
});

test("an alias on an entity no investment is bound to wakes nothing", { skip }, async (t) => {
  const base = await fixture(t);
  await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [org("fund", "Synthetic Unrelated Holdings")],
  });
  await resolveEntity(base.ctx, base.userId, base.spaceId, {
    kind: "organization",
    name: "Synthetic Unrelated Holdings",
  });
  await resolveEntity(base.ctx, base.userId, base.spaceId, {
    kind: "organization",
    name: "Synthetic Unrelated Holdings",
    aliases: ["SUH"],
  });
  assert.deepEqual(await queuedKeys(base), []);
});

// ---------------------------------------------------------------------------
// A document that stops being an investment document
// ---------------------------------------------------------------------------

async function dateCorrections(base) {
  const found = await base.client.query(
    `SELECT original_value, corrected_value, state FROM kith.corrections
      WHERE detector = 'investment_link_date' ORDER BY created_at, id`,
  );
  return found.rows;
}

test("a re-extraction to a kind the scorer cannot read gives the date back", { skip }, async (t) => {
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
    dateIsEstimated: true,
  });
  const notice = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [
      org("fund", FUND),
      money("amount_called", "25000.00"),
      date("due_date", "2026-04-02"),
    ],
  });
  await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: notice.sourceItemId,
    kind: "capital_call_notice",
  });
  await run(base);
  const before = await entryRow(base, investmentId, entry.id);
  assert.equal(before.entryDate, "2026-04-02");
  assert.equal(before.dateIsEstimated, false);
  assert.equal((await dateCorrections(base)).length, 1);

  // A parser upgrade, or a corrected kind: the same source item is now read
  // as something the scorer has no rules for at all.
  await base.client.query(
    `UPDATE kith.document_extractions SET kind = 'receipt'
      WHERE space_id = $1 AND source_item_id = $2`,
    [base.spaceId, notice.sourceItemId],
  );

  // THE HOLE THIS PINS: the trigger used to enqueue nothing for a
  // non-matchable kind, and the evaluation used to return before it swept,
  // so the `auto_linked` row stood with the date it had moved still moved --
  // a date the owner's own paper no longer justifies.
  const scheduled = await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: notice.sourceItemId,
    kind: "receipt",
  });
  assert.notEqual(scheduled, null, "a document that holds a link is enqueued");
  await run(base, NOW + 1_000);

  assert.deepEqual(
    await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {}),
    [],
    "the rule made the row, so the rule takes it back",
  );
  const after = await entryRow(base, investmentId, entry.id);
  assert.equal(after.entryDate, "2026-03-31", "the estimate is back");
  assert.equal(after.dateIsEstimated, true);
  assert.equal(after.documentId, null);
  const corrections = await dateCorrections(base);
  assert.equal(corrections.length, 2, "the move and its reversal, both recorded");
  assert.equal(corrections[1].original_value, "2026-04-02");
  assert.equal(corrections[1].corrected_value, "2026-03-31");
});

test("an owner-decided link survives a kind the scorer cannot read", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: FUND,
  });
  const notice = await seedDocument(base.ctx, base.spaceId, {
    kind: "capital_call_notice",
    statements: [org("fund", FUND), money("amount_called", "25000.00")],
  });
  const entry = await createInvestmentEntry(base.ctx, {
    principal: base.principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-31",
    amount: "25000.00",
    documentId: notice.documentId,
  });
  await base.client.query(
    `UPDATE kith.document_extractions SET kind = 'receipt'
      WHERE space_id = $1 AND source_item_id = $2`,
    [base.spaceId, notice.sourceItemId],
  );
  await scheduleInvestmentLinkForExtraction(base.ctx, {
    spaceId: base.spaceId,
    sourceItemId: notice.sourceItemId,
    kind: "receipt",
  });
  await run(base);

  const links = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {});
  assert.equal(links.length, 1);
  assert.equal(links[0].state, "confirmed");
  assert.equal(links[0].decidedBy, "owner");
  const stored = await entryRow(base, investmentId, entry.id);
  assert.equal(stored.documentId, notice.documentId);
});

test("a document with no link and a kind the scorer cannot read is not a job", { skip }, async (t) => {
  const base = await fixture(t);
  const other = await seedDocument(base.ctx, base.spaceId, {
    kind: "receipt",
    statements: [org("vendor", "Synthetic Hardware")],
  });
  assert.equal(
    await scheduleInvestmentLinkForExtraction(base.ctx, {
      spaceId: base.spaceId,
      sourceItemId: other.sourceItemId,
      kind: "receipt",
    }),
    null,
  );
  assert.deepEqual(await queuedKeys(base), []);
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

test("letters and unclassified pages are jobs, and drain to investment-level links", { skip }, async (t) => {
  const base = await fixture(t);
  const investmentId = await createInvestment(base.ctx, {
    principal: base.principal,
    spaceId: base.spaceId,
    name: FUND,
  });
  const letter = await seedDocument(base.ctx, base.spaceId, {
    kind: "letter_or_notice",
    uri: `fs://dropbox-investing/${FUND}/letter.pdf`,
    statements: [org("sender", "Synthetic Administrator")],
  });
  const scan = await seedDocument(base.ctx, base.spaceId, {
    kind: "other",
    uri: `fs://dropbox-investing/${FUND}/scan.pdf`,
    statements: [],
  });
  const agreement = await seedDocument(base.ctx, base.spaceId, {
    kind: "investment_agreement",
    statements: [org("company", `${FUND}, L.P.`), date("date_signed", "2025-02-03")],
  });
  for (const [document, kind] of [
    [letter, "letter_or_notice"],
    [scan, "other"],
    [agreement, "investment_agreement"],
  ]) {
    const scheduled = await scheduleInvestmentLinkForExtraction(base.ctx, {
      spaceId: base.spaceId,
      sourceItemId: document.sourceItemId,
      kind,
    });
    assert.notEqual(scheduled, null, `${kind} is a job`);
  }
  const summary = await run(base);
  assert.equal(summary.completed, 3);
  const links = await listInvestmentDocumentLinks(base.ctx, [base.spaceId], {});
  assert.equal(links.length, 3);
  for (const link of links) {
    assert.equal(link.state, "auto_linked");
    assert.equal(link.entryId, null);
    assert.equal(link.investmentId, investmentId);
  }

  // The backfill selects these kinds too, and `--kind` still narrows it.
  const all = await withKithTransaction(base.pool, (client) =>
    scheduleInvestmentLinkBackfill(deferredCtx(client, NOW + 1_000), {
      spaceId: base.spaceId,
    }),
  );
  assert.equal(all.considered, 3);
  const letters = await withKithTransaction(base.pool, (client) =>
    scheduleInvestmentLinkBackfill(deferredCtx(client, NOW + 2_000), {
      spaceId: base.spaceId,
      kind: "letter_or_notice",
    }),
  );
  assert.equal(letters.considered, 1);

  // A rename wakes the letter through the investment fan-out as well.
  const woken = await withKithTransaction(base.pool, (client) =>
    scheduleInvestmentLinksFor(deferredCtx(client, NOW + 3_000), {
      spaceId: base.spaceId,
      investmentId,
    }),
  );
  assert.equal(woken.linked, 3);
});
