// The inline ingestion pipeline (`src/ingestion/`), against the real migrated
// schema. See docs/plans/2026-09-06-inline-ingestion-contract.md for the
// behaviour and docs/plans/2026-09-12-postgres-consolidation.md sections 1.3,
// 1.4 and 2.4 for why it is shaped this way.
//
// Everything here goes through a pool and `withKithTransaction`, not the shared
// fixture client: the whole point of the row is that admission is one
// transaction, the lease is visible between them, and two concurrent admissions
// of one request id converge. None of that is observable inside a single
// rolled-back transaction.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createKithPool,
  newKithId,
  withKithTransaction,
} from "../dist/index.js";
import { getDocument, searchDocuments } from "../dist/documents/index.js";
import {
  defaultRegistry,
  drain,
  recoverInlineIngestion,
} from "../dist/deferred/index.js";
import {
  admitInlineWork,
  claimInlineWork,
  enqueueSourceFetch,
  getInlineIngestResult,
  inlineIngestErrorCode,
  processInlineWork,
  INLINE_WORK_FALLBACK_DELAY_MS,
  INLINE_WORK_LEASE_MS,
} from "../dist/ingestion/index.js";
import { workerCtx } from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  refusal,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const TEXT = "The synthetic vehicle received an oil change on 2026-09-01.";

async function inlineFixture(t) {
  const database = await identityDatabase(t);
  const identity = database.ctx(NOW);
  const userId = await makeUser(identity, { name: "Capture owner" });
  const spaceId = await makeSpace(identity, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const sourceAccountId = newKithId();
  await database.client.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, inventory_epoch, completed_inventory_epoch,
        manifest_version, created_by)
     VALUES ($1,$2,transaction_timestamp(),'mcp-client','desktop-capture',
             'Desktop capture',true,0,60000,0,0,0,$3)`,
    [sourceAccountId, spaceId, userId],
  );
  const credential = await makeApiKey(identity, {
    userId,
    capabilities: ["read", "write", "ingest"],
    spaceIds: [spaceId],
    sourceAccountIds: [sourceAccountId],
  });
  const pool = createKithPool(database.databaseUrl, 5);
  // The throwaway database is dropped `WITH (FORCE)`, which terminates a
  // pooled connection; without a listener that arrives as an uncaught error.
  pool.on("error", () => {});
  t.after(() => pool.end());
  return {
    ...database,
    pool,
    userId,
    spaceId,
    sourceAccountId,
    principal: { userId, credentialId: credential.id },
    /** The contract's example capture, addressed to this fixture's space. */
    input(overrides = {}) {
      return inlineInput(spaceId, overrides);
    },
    /** One service call in one SERIALIZABLE transaction, at a fixed clock. */
    run(now, work) {
      return withKithTransaction(pool, (client) =>
        work(workerCtx(client, now)),
      );
    },
  };
}

/** The contract's example request, with an explicit destination. A capture
 * with no `spaceId` would take the caller's configured default; these tests
 * name the space so the assertions are about ingestion, not about defaulting. */
function inlineInput(spaceId, overrides = {}) {
  return {
    spaceId,
    requestId: "synthetic-capture-1",
    expectedDesiredProcessingEpoch: 0,
    source: {
      connector: "mcp-client",
      accountId: "desktop-capture",
      externalId: "synthetic-note-1",
      capturedAt: "2026-09-06T18:00:00Z",
      ...(overrides.source ?? {}),
    },
    title: "Synthetic service note",
    text: TEXT,
    docType: "vehicle-service",
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "source"),
    ),
  };
}

async function count(client, table, where = "", values = []) {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM kith.${table} ${where}`,
    values,
  );
  return result.rows[0].n;
}

async function inlineWorkRow(client, workId) {
  return (
    await client.query("SELECT * FROM kith.inline_work WHERE id = $1", [workId])
  ).rows[0];
}

async function ingestJobRow(client, jobId) {
  return (
    await client.query("SELECT * FROM kith.ingest_jobs WHERE id = $1", [jobId])
  ).rows[0];
}

test(
  "admit, claim and process publish one active, searchable inline document",
  { skip },
  async (t) => {
    const f = await inlineFixture(t);
    const admitted = await f.run(NOW, (ctx) =>
      admitInlineWork(ctx, { principal: f.principal, input: f.input() }),
    );
    assert.equal(admitted.newWork, true);
    assert.equal(admitted.reused, false);
    assert.equal(admitted.spaceId, f.spaceId);
    assert.equal(admitted.admission.state, "queued");

    // The `scheduler.runAfter` successor is a row in the admission's own
    // transaction, keyed the way the recovery sweep keys its own enqueue.
    const scheduled = (await f.client.query("SELECT * FROM kith.deferred_work"))
      .rows;
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].kind, "inline_ingestion");
    assert.equal(scheduled[0].dedupe_key, admitted.workId);
    assert.deepEqual(scheduled[0].payload, { workId: admitted.workId });
    assert.equal(
      scheduled[0].run_after.getTime(),
      NOW + INLINE_WORK_FALLBACK_DELAY_MS,
    );

    // The lease is the ingest job's, taken before any staging is written.
    const claimed = await f.run(NOW + 1, (ctx) =>
      claimInlineWork(ctx, {
        workId: admitted.workId,
        leaseToken: "synthetic-lease-token",
      }),
    );
    assert.equal(claimed.kind, "claimed");
    assert.equal(claimed.leaseEpoch, 1);
    assert.equal(claimed.alreadyStaged, false);
    assert.equal(claimed.text, TEXT);
    const leased = await ingestJobRow(f.client, claimed.jobId);
    assert.equal(leased.state, "processing");
    assert.equal(leased.lease_token, "synthetic-lease-token");
    assert.equal(Number(leased.attempts), 1);
    assert.equal(leased.worker_managed, false);

    // A held, unexpired lease is busy rather than double-claimed.
    const busy = await f.run(NOW + 2, (ctx) =>
      claimInlineWork(ctx, { workId: admitted.workId, leaseToken: "second" }),
    );
    assert.equal(busy.kind, "busy");
    assert.equal(busy.retryAt, NOW + 1 + INLINE_WORK_LEASE_MS);

    // Past the lease, the work is reclaimable without a separate sweep: the
    // holder that took it never came back.
    const reclaimed = NOW + 1 + INLINE_WORK_LEASE_MS + 1;
    const processed = await f.run(reclaimed, (ctx) =>
      processInlineWork(ctx, { workId: admitted.workId }),
    );
    assert.equal(processed.state, "ready");

    const result = await f.run(reclaimed + 1, (ctx) =>
      getInlineIngestResult(ctx, {
        principal: f.principal,
        workId: admitted.workId,
      }),
    );
    assert.equal(result.state, "ready");
    assert.equal(result.isActive, true);
    assert.equal(result.desiredProcessingEpoch, 1);
    assert.ok(result.documentId);

    const work = await inlineWorkRow(f.client, admitted.workId);
    assert.equal(work.state, "ready");
    assert.equal(work.next_attempt_at, null);
    const job = await ingestJobRow(f.client, result.ingestJobId);
    assert.equal(job.state, "ready");
    assert.equal(job.lease_token, null);

    // The retained text, its page and its evidence are readable by id.
    const document = await getDocument(
      f.client,
      [f.spaceId],
      result.documentId,
    );
    assert.ok(document);
    assert.equal(document.title, "Synthetic service note");
    assert.equal(document.docType, "vehicle-service");
    assert.equal(document.historical, false);
    assert.equal(document.contentStatus, "ready");
    assert.equal(document.pages.length, 1);
    assert.equal(document.pages[0].text, TEXT);
    assert.equal(document.pages[0].evidence.length, 1);

    // And the same document is findable by keyword.
    const search = await searchDocuments(f.client, [f.spaceId], {
      query: "oil change",
    });
    assert.ok(
      search.results.some((hit) => hit.documentId === result.documentId),
      "the activated inline document is a keyword search result",
    );

    // Activation makes the chunk targets owed, which is what the embedding
    // fill later reads. Publication bumps the space's eligibility epoch.
    const embeddingState = (
      await f.client.query(
        "SELECT * FROM kith.space_embedding_states WHERE space_id = $1",
        [f.spaceId],
      )
    ).rows;
    assert.equal(embeddingState.length, 1);
    const processingState = (
      await f.client.query(
        "SELECT * FROM kith.space_processing_state WHERE space_id = $1",
        [f.spaceId],
      )
    ).rows;
    assert.equal(processingState.length, 1);
    assert.equal(Number(processingState[0].activation_epoch), 1);
  },
);

test(
  "a replayed request id returns the same receipt and writes nothing",
  { skip },
  async (t) => {
    const f = await inlineFixture(t);
    const first = await f.run(NOW, (ctx) =>
      admitInlineWork(ctx, { principal: f.principal, input: f.input() }),
    );
    const before = {
      requests: await count(f.client, "ingest_requests"),
      jobs: await count(f.client, "ingest_jobs"),
      work: await count(f.client, "inline_work"),
      revisions: await count(f.client, "source_revisions"),
      generations: await count(f.client, "processing_generations"),
      deferred: await count(f.client, "deferred_work"),
      rateLimit: (
        await f.client.query("SELECT count FROM kith.ingest_rate_limits")
      ).rows[0].count,
    };

    const replay = await f.run(NOW + 1_000, (ctx) =>
      admitInlineWork(ctx, { principal: f.principal, input: f.input() }),
    );
    assert.equal(replay.reused, true);
    assert.equal(replay.newWork, false);
    assert.equal(replay.workId, first.workId);
    assert.deepEqual(replay.admission.ingestJobId, first.admission.ingestJobId);
    assert.deepEqual(
      replay.admission.sourceRevisionId,
      first.admission.sourceRevisionId,
    );
    assert.deepEqual(
      replay.admission.processingGenerationId,
      first.admission.processingGenerationId,
    );

    const after = {
      requests: await count(f.client, "ingest_requests"),
      jobs: await count(f.client, "ingest_jobs"),
      work: await count(f.client, "inline_work"),
      revisions: await count(f.client, "source_revisions"),
      generations: await count(f.client, "processing_generations"),
      deferred: await count(f.client, "deferred_work"),
      rateLimit: (
        await f.client.query("SELECT count FROM kith.ingest_rate_limits")
      ).rows[0].count,
    };
    // Including the rate limit: "matching receipts exempt" is what makes an
    // interrupted client safe to retry unchanged.
    assert.deepEqual(after, before);
  },
);

test(
  "a differing payload under one request id is a conflict",
  { skip },
  async (t) => {
    const f = await inlineFixture(t);
    await f.run(NOW, (ctx) =>
      admitInlineWork(ctx, { principal: f.principal, input: f.input() }),
    );
    const message = await refusal(() =>
      f.run(NOW + 1, (ctx) =>
        admitInlineWork(ctx, {
          principal: f.principal,
          input: f.input({ text: "A different synthetic note." }),
        }),
      ),
    );
    assert.equal(message, "requestId conflicts with a different request");
    assert.equal(
      inlineIngestErrorCode(new Error(message)),
      "request_conflict",
      "the transport can answer 409 rather than 500",
    );
    assert.equal(await count(f.client, "ingest_requests"), 1);
    assert.equal(await count(f.client, "source_revisions"), 1);
  },
);

test("a cross-space admission is refused", { skip }, async (t) => {
  const f = await inlineFixture(t);
  const identity = f.ctx(NOW);
  const strangerId = await makeUser(identity, { name: "Someone else" });
  const otherSpaceId = await makeSpace(identity, {
    createdBy: strangerId,
    memberId: strangerId,
    role: "owner",
  });
  const otherAccountId = newKithId();
  // Same connector and account id, another space. Only the destination differs.
  await f.client.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, inventory_epoch, completed_inventory_epoch,
        manifest_version, created_by)
     VALUES ($1,$2,transaction_timestamp(),'mcp-client','desktop-capture',
             'Their capture',true,0,60000,0,0,0,$3)`,
    [otherAccountId, otherSpaceId, strangerId],
  );

  const message = await refusal(() =>
    f.run(NOW, (ctx) =>
      admitInlineWork(ctx, {
        principal: f.principal,
        input: f.input({ spaceId: otherSpaceId }),
      }),
    ),
  );
  assert.equal(message, "Space not found");
  assert.equal(inlineIngestErrorCode(new Error(message)), "space_not_found");
  assert.equal(await count(f.client, "ingest_requests"), 0);
  assert.equal(await count(f.client, "source_items"), 0);

  // The same refusal when the credential holds the space but not the account:
  // "source ingest grants are additional to current space access".
  await f.client.query(
    `INSERT INTO kith.space_members (id, space_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
    [newKithId(), otherSpaceId, f.userId],
  );
  await f.client.query(
    "INSERT INTO kith.api_key_spaces (id, api_key_id, space_id) VALUES ($1, $2, $3)",
    [newKithId(), f.principal.credentialId, otherSpaceId],
  );
  const ungranted = await refusal(() =>
    f.run(NOW + 1, (ctx) =>
      admitInlineWork(ctx, {
        principal: f.principal,
        input: f.input({ spaceId: otherSpaceId }),
      }),
    ),
  );
  assert.equal(ungranted, "Source account not found");
  assert.equal(await count(f.client, "ingest_requests"), 0);
});

test(
  "the decoded byte bound is enforced before any write",
  { skip },
  async (t) => {
    const f = await inlineFixture(t);
    const message = await refusal(() =>
      f.run(NOW, (ctx) =>
        admitInlineWork(ctx, {
          principal: f.principal,
          input: f.input({ text: "a".repeat(65_537) }),
        }),
      ),
    );
    assert.equal(message, "Inline text exceeds the supported 65536-byte limit");
    assert.equal(inlineIngestErrorCode(new Error(message)), "invalid_request");
    assert.equal(await count(f.client, "source_items"), 0);
    assert.equal(await count(f.client, "ingest_rate_limits"), 0);

    // Exactly at the bound, and multibyte, it is accepted: the limit is UTF-8
    // bytes, not UTF-16 code units.
    const atBound = "é".repeat(32_768);
    assert.equal(Buffer.byteLength(atBound, "utf8"), 65_536);
    const admitted = await f.run(NOW + 1, (ctx) =>
      admitInlineWork(ctx, {
        principal: f.principal,
        input: f.input({ text: atBound }),
      }),
    );
    assert.equal(admitted.newWork, true);
  },
);

test(
  "a failed process records the failure and the sweep plus the handler recover it",
  { skip },
  async (t) => {
    const f = await inlineFixture(t);
    const admitted = await f.run(NOW, (ctx) =>
      admitInlineWork(ctx, { principal: f.principal, input: f.input() }),
    );

    // A synthetic outage inside staging. The message is deliberately none of
    // the strings `inlineErrorCode` classifies as invalid staging, so this is a
    // retryable `inline_worker_error` -- the case the recovery sweep exists for.
    await f.client.query(`
      CREATE FUNCTION kith.synthetic_chunk_outage() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic staging outage'; END $$;
      CREATE TRIGGER synthetic_chunk_outage BEFORE INSERT ON kith.chunks
        FOR EACH ROW EXECUTE FUNCTION kith.synthetic_chunk_outage();
    `);
    const failed = await f.run(NOW + 1, (ctx) =>
      processInlineWork(ctx, { workId: admitted.workId }),
    );
    assert.equal(failed.state, "failed");

    // The claim and the recorded failure committed together: the savepoint
    // rolled back the staging, not the attempt.
    const work = await inlineWorkRow(f.client, admitted.workId);
    assert.equal(work.state, "failed");
    assert.equal(work.last_error_code, "inline_worker_error");
    assert.equal(work.next_attempt_at.getTime(), NOW + 1 + 60_000);
    const job = await ingestJobRow(f.client, admitted.admission.ingestJobId);
    assert.equal(job.state, "failed");
    assert.equal(job.error.code, "inline_worker_error");
    assert.equal(job.error.retryable, true);
    assert.equal(Number(job.attempts), 1);
    assert.equal(job.lease_token, null);
    // Nothing partial survived.
    assert.equal(await count(f.client, "chunks"), 0);
    assert.equal(await count(f.client, "documents"), 0);
    const item = (
      await f.client.query("SELECT last_failure FROM kith.source_items")
    ).rows[0];
    assert.equal(item.last_failure.code, "inline_worker_error");

    await f.client.query(`
      DROP TRIGGER synthetic_chunk_outage ON kith.chunks;
      DROP FUNCTION kith.synthetic_chunk_outage();
    `);

    const later = NOW + 1 + 120_000;
    const swept = await f.run(later, (ctx) => recoverInlineIngestion(ctx));
    assert.equal(swept.recovered, 1);
    assert.equal(swept.remaining, false);
    // The sweep and the admission fallback key on the same work row id, so the
    // queue holds one job rather than two.
    assert.equal(await count(f.client, "deferred_work"), 1);

    const drained = await drain(f.pool, defaultRegistry(), { now: later + 1 });
    assert.equal(drained.claimed, 1);
    assert.equal(drained.completed, 1);
    assert.equal(drained.outcomes[0].kind, "inline_ingestion");

    const result = await f.run(later + 2, (ctx) =>
      getInlineIngestResult(ctx, {
        principal: f.principal,
        workId: admitted.workId,
      }),
    );
    assert.equal(result.state, "ready");
    assert.equal(result.isActive, true);
    assert.ok(result.documentId);
    const recovered = await inlineWorkRow(f.client, admitted.workId);
    assert.equal(recovered.state, "ready");
    assert.equal(recovered.next_attempt_at, null);
  },
);

test(
  "a stranded work row is drained by drain through the registered handler",
  { skip },
  async (t) => {
    const f = await inlineFixture(t);
    const admitted = await f.run(NOW, (ctx) =>
      admitInlineWork(ctx, { principal: f.principal, input: f.input() }),
    );
    // Nothing processed it inline. The fallback job comes due and the daemon
    // picks it up with no further help.
    const drained = await drain(f.pool, defaultRegistry(), {
      now: NOW + INLINE_WORK_FALLBACK_DELAY_MS + 1,
    });
    assert.equal(drained.claimed, 1);
    assert.equal(drained.completed, 1);
    assert.equal(drained.unregisteredKind, 0);

    const result = await f.run(NOW + 20_000, (ctx) =>
      getInlineIngestResult(ctx, {
        principal: f.principal,
        workId: admitted.workId,
      }),
    );
    assert.equal(result.state, "ready");
    assert.equal(result.isActive, true);
    const document = await getDocument(
      f.client,
      [f.spaceId],
      result.documentId,
    );
    assert.equal(document.pages[0].text, TEXT);
  },
);

test(
  "serializable concurrent admissions of one request id converge on one row",
  { skip },
  async (t) => {
    const f = await inlineFixture(t);
    const admissions = await Promise.all([
      f.run(NOW, (ctx) =>
        admitInlineWork(ctx, { principal: f.principal, input: f.input() }),
      ),
      f.run(NOW, (ctx) =>
        admitInlineWork(ctx, { principal: f.principal, input: f.input() }),
      ),
    ]);
    assert.equal(admissions[0].workId, admissions[1].workId);
    assert.equal(
      admissions[0].admission.ingestJobId,
      admissions[1].admission.ingestJobId,
    );
    assert.equal(
      admissions.filter((admission) => admission.newWork).length,
      1,
      "exactly one of the two created the work row",
    );
    assert.equal(await count(f.client, "ingest_requests"), 1);
    assert.equal(await count(f.client, "ingest_jobs"), 1);
    assert.equal(await count(f.client, "inline_work"), 1);
    assert.equal(await count(f.client, "source_items"), 1);
    assert.equal(await count(f.client, "source_revisions"), 1);
    assert.equal(await count(f.client, "processing_generations"), 1);
    assert.equal(await count(f.client, "deferred_work"), 1);
  },
);

test(
  "ingest_url queues a fetch request and never invents source text",
  { skip },
  async (t) => {
    const f = await inlineFixture(t);
    const input = {
      spaceId: f.spaceId,
      requestId: "synthetic-url-1",
      source: {
        connector: "mcp-client",
        accountId: "desktop-capture",
        externalId: "synthetic-url-target-1",
      },
      url: "https://example.test/synthetic/service-note",
      title: "Synthetic queued page",
    };
    const queued = await f.run(NOW, (ctx) =>
      enqueueSourceFetch(ctx, { principal: f.principal, input }),
    );
    assert.equal(queued.state, "queued");
    assert.equal(queued.workerRequired, true);
    assert.equal(queued.requestId, "synthetic-url-1");
    // Queue only: an item exists, no revision, no generation, no document.
    assert.equal(await count(f.client, "source_items"), 1);
    assert.equal(await count(f.client, "source_revisions"), 0);
    assert.equal(await count(f.client, "processing_generations"), 0);
    assert.equal(await count(f.client, "documents"), 0);
    // The title belongs to the request until a worker fetches the URL.
    const stored = (
      await f.client.query("SELECT * FROM kith.source_fetch_requests")
    ).rows[0];
    assert.equal(stored.title, "Synthetic queued page");
    assert.equal(stored.space_id, f.spaceId);
    const item = (await f.client.query("SELECT * FROM kith.source_items"))
      .rows[0];
    assert.equal(item.title, null);
    assert.equal(item.uri, input.url);

    const replay = await f.run(NOW + 1, (ctx) =>
      enqueueSourceFetch(ctx, { principal: f.principal, input }),
    );
    assert.equal(replay.fetchRequestId, queued.fetchRequestId);
    assert.equal(await count(f.client, "source_fetch_requests"), 1);

    const conflict = await refusal(() =>
      f.run(NOW + 2, (ctx) =>
        enqueueSourceFetch(ctx, {
          principal: f.principal,
          input: { ...input, url: "https://example.test/other" },
        }),
      ),
    );
    assert.equal(conflict, "requestId conflicts with a different request");

    // A URL carrying credentials is refused before anything is stored.
    const credentialed = await refusal(() =>
      f.run(NOW + 3, (ctx) =>
        enqueueSourceFetch(ctx, {
          principal: f.principal,
          input: {
            ...input,
            requestId: "synthetic-url-2",
            url: "https://user:secret@example.test/page",
          },
        }),
      ),
    );
    assert.equal(
      credentialed,
      "URL must be an http(s) URL without user information",
    );

    // And a control character, which a later fetch worker must never be handed.
    const controlCharacter = await refusal(() =>
      f.run(NOW + 4, (ctx) =>
        enqueueSourceFetch(ctx, {
          principal: f.principal,
          input: {
            ...input,
            requestId: "synthetic-url-3",
            url: "https://example.test/pa\u0007ge",
          },
        }),
      ),
    );
    assert.equal(controlCharacter, "URL is invalid");
    assert.equal(await count(f.client, "source_fetch_requests"), 1);
  },
);
