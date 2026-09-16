// The three periodic sweeps (`src/deferred/sweeps.ts`), the read-time worker
// staleness predicate and daily incident writer
// (`src/workers/diagnostics.ts`), and `tick`'s idempotency. See
// docs/plans/2026-09-12-postgres-consolidation.md sections 1.4 and 2.6.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createKithPool,
  newKithId,
  withKithTransaction,
} from "../dist/index.js";
import {
  createRegistry,
  deferredCtx,
  recoverInlineIngestion,
  removeExpiredOAuthGrants,
  removeExpiredWorkerProtocolState,
  tick,
} from "../dist/deferred/index.js";
import {
  isWatcherOverdue,
  recordMissingWorkerIncidents,
  recordWorkerHeartbeat,
  watcherStaleness,
  withWorkerTransaction,
  workerCtx,
} from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-14T12:00:00Z");

async function sourceFixture(t) {
  const database = await identityDatabase(t);
  const identity = database.ctx(NOW);
  const userId = await makeUser(identity, { name: "Worker owner" });
  const spaceId = await makeSpace(identity, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const sourceAccountId = newKithId();
  await database.client.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, inventory_epoch,
        completed_inventory_epoch, manifest_version, created_by)
     VALUES ($1,$2,transaction_timestamp(),'fs','synthetic-fs',
             'Synthetic filesystem',true,0,60000,0,0,0,$3)`,
    [sourceAccountId, spaceId, userId],
  );
  const credential = await makeApiKey(identity, {
    userId,
    capabilities: ["ingest"],
    spaceIds: [spaceId],
    sourceAccountIds: [sourceAccountId],
  });
  const principal = { userId, credentialId: credential.id };
  const pool = createKithPool(database.databaseUrl, 5);
  // See test/deferredWork.test.mjs's `poolFixture`: the throwaway database's
  // own cleanup drops it `WITH (FORCE)`, which needs a listener here or an
  // idle pooled connection turns that into an uncaught `error` event.
  pool.on("error", () => {});
  t.after(() => pool.end());
  return { ...database, pool, userId, spaceId, sourceAccountId, principal };
}

test("watcher staleness flips at exactly the overdue boundary", () => {
  assert.equal(isWatcherOverdue(NOW, NOW - 1), false);
  assert.equal(isWatcherOverdue(NOW, NOW), true);
  assert.equal(isWatcherOverdue(NOW, NOW + 1), true);

  assert.equal(watcherStaleness(undefined, NOW), "not_configured");
  assert.equal(
    watcherStaleness({ state: "awaiting_heartbeat", nextExpectedAt: null }, NOW),
    "awaiting_heartbeat",
  );
  assert.equal(
    watcherStaleness({ state: "active", nextExpectedAt: new Date(NOW) }, NOW - 1),
    "current",
  );
  assert.equal(
    watcherStaleness({ state: "active", nextExpectedAt: new Date(NOW) }, NOW),
    "overdue",
  );
});

test("recoverInlineIngestion enqueues only due candidates, bounded", { skip }, async (t) => {
  const f = await sourceFixture(t);
  const due = [];
  for (let index = 0; index < 3; index += 1) {
    const id = newKithId();
    due.push(id);
    await f.client.query(
      `INSERT INTO kith.inline_work
         (id, space_id, created_at, state, attempts, next_attempt_at)
       VALUES ($1,$2,transaction_timestamp(),'failed',1,$3)`,
      [id, f.spaceId, new Date(NOW - 1_000)],
    );
  }
  // Not due yet.
  await f.client.query(
    `INSERT INTO kith.inline_work
       (id, space_id, created_at, state, attempts, next_attempt_at)
     VALUES ($1,$2,transaction_timestamp(),'failed',1,$3)`,
    [newKithId(), f.spaceId, new Date(NOW + 60_000)],
  );
  // Terminal; never a candidate.
  await f.client.query(
    `INSERT INTO kith.inline_work
       (id, space_id, created_at, state, attempts)
     VALUES ($1,$2,transaction_timestamp(),'ready',1)`,
    [newKithId(), f.spaceId],
  );

  const bounded = await withKithTransaction(f.pool, (client) =>
    recoverInlineIngestion(deferredCtx(client, NOW), { limit: 2 }),
  );
  assert.equal(bounded.recovered, 2);
  assert.equal(bounded.remaining, true);

  const scheduled = await f.client.query(
    "SELECT dedupe_key FROM kith.deferred_work WHERE kind = 'inline_ingestion' ORDER BY dedupe_key",
  );
  assert.equal(scheduled.rows.length, 2);
  for (const row of scheduled.rows) {
    assert.ok(due.includes(row.dedupe_key));
  }

  // Rerunning with a wide-enough limit picks up the third due candidate, and
  // dedupes the two already queued rather than double-scheduling them.
  const rest = await withKithTransaction(f.pool, (client) =>
    recoverInlineIngestion(deferredCtx(client, NOW), { limit: 10 }),
  );
  assert.equal(rest.recovered, 3);
  assert.equal(rest.remaining, false);
  const afterRest = await f.client.query(
    "SELECT count(*)::int AS n FROM kith.deferred_work WHERE kind = 'inline_ingestion'",
  );
  assert.equal(afterRest.rows[0].n, 3);
});

test("removeExpiredOAuthGrants reports the identity sweep's shape", { skip }, async (t) => {
  const f = await sourceFixture(t);
  const keyId = newKithId();
  await f.client.query(
    `INSERT INTO kith.api_keys
       (id, user_id, key_hash, key_prefix, name, capabilities, oauth_lifecycle,
        oauth_request_hash, oauth_binding_seed_hash, oauth_grant_expires_at)
       VALUES ($1,$2,repeat('ab',32),'aaaaaaaaaaa','Expired grant',
               '[]'::jsonb,'pending',repeat('a',64),repeat('b',64),$3)`,
    [keyId, f.userId, new Date(NOW - 1_000)],
  );
  const result = await withKithTransaction(f.pool, (client) =>
    removeExpiredOAuthGrants(deferredCtx(client, NOW)),
  );
  assert.equal(result.removed, 1);
  assert.equal(result.remaining, false);
  const remaining = await f.client.query(
    "SELECT count(*)::int AS n FROM kith.api_keys WHERE id = $1",
    [keyId],
  );
  assert.equal(remaining.rows[0].n, 0);
});

async function insertOperationReceipt(client, spaceId, retireAt) {
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.worker_operation_receipts
       (id, space_id, created_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3)`,
    [id, spaceId, retireAt],
  );
  return id;
}

async function insertReservationTarget(client, spaceId, leaseExpiresAt) {
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.worker_reservation_targets
       (id, space_id, created_at, lease_expires_at)
     VALUES ($1,$2,transaction_timestamp(),$3)`,
    [id, spaceId, leaseExpiresAt],
  );
  return id;
}

test(
  "removeExpiredWorkerProtocolState deletes only rows past their own expiry, bounded",
  { skip },
  async (t) => {
    const f = await sourceFixture(t);
    const expiredReceipts = [
      await insertOperationReceipt(f.client, f.spaceId, new Date(NOW - 1_000)),
      await insertOperationReceipt(f.client, f.spaceId, new Date(NOW - 500)),
      await insertOperationReceipt(f.client, f.spaceId, new Date(NOW - 1)),
    ];
    const liveReceipt = await insertOperationReceipt(
      f.client,
      f.spaceId,
      new Date(NOW + 60_000),
    );
    const expiredTarget = await insertReservationTarget(
      f.client,
      f.spaceId,
      new Date(NOW - 1_000),
    );
    const liveTarget = await insertReservationTarget(
      f.client,
      f.spaceId,
      new Date(NOW + 60_000),
    );

    const bounded = await withKithTransaction(f.pool, (client) =>
      removeExpiredWorkerProtocolState(deferredCtx(client, NOW), { limit: 2 }),
    );
    // Two of the three expired receipts, plus the one expired target: bounded
    // per table at 2, and the receipts table alone has more than the limit.
    assert.equal(bounded.removed, 3);
    assert.equal(bounded.remaining, true);

    const remainingReceipts = await f.client.query(
      "SELECT id FROM kith.worker_operation_receipts ORDER BY id",
    );
    const remainingIds = remainingReceipts.rows.map((row) => row.id);
    assert.ok(remainingIds.includes(liveReceipt));
    assert.equal(remainingIds.length, 2); // one expired receipt still due

    const targets = await f.client.query(
      "SELECT id FROM kith.worker_reservation_targets ORDER BY id",
    );
    assert.deepEqual(
      targets.rows.map((row) => row.id).sort(),
      [liveTarget].sort(),
    );
    assert.ok(!targets.rows.some((row) => row.id === expiredTarget));

    // A second, unbounded pass finishes the job and reports nothing left.
    const rest = await withKithTransaction(f.pool, (client) =>
      removeExpiredWorkerProtocolState(deferredCtx(client, NOW), {
        limit: 1_000,
      }),
    );
    assert.equal(rest.removed, 1);
    assert.equal(rest.remaining, false);
    const finalReceipts = await f.client.query(
      "SELECT id FROM kith.worker_operation_receipts",
    );
    assert.deepEqual(
      finalReceipts.rows.map((row) => row.id),
      [liveReceipt],
    );
    void expiredReceipts;
  },
);

test(
  "the daily missing-worker incident is written once per watcher per day",
  { skip },
  async (t) => {
    const f = await sourceFixture(t);
    const heartbeatRequest = {
      protocolVersion: 1,
      operation: "diagnostics.heartbeat",
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      watcherId: "watcher-1",
      connectorVersion: "fs-v1",
    };
    await withWorkerTransaction(
      f.pool,
      (ctx) => recordWorkerHeartbeat(ctx, f.principal, heartbeatRequest),
      NOW,
    );
    // The watcher is active with nextExpectedAt = NOW + 180_000. Move past it.
    const overdueAt = NOW + 180_000;

    const first = await withKithTransaction(f.pool, (client) =>
      recordMissingWorkerIncidents(workerCtx(client, overdueAt)),
    );
    assert.equal(first.inspected, 1);
    assert.equal(first.recorded, 1);

    // Running it again immediately (or later the same day) does not open a
    // second incident row: the same open row is touched instead.
    const second = await withKithTransaction(f.pool, (client) =>
      recordMissingWorkerIncidents(workerCtx(client, overdueAt + 60_000)),
    );
    assert.equal(second.recorded, 0);

    const incidents = await f.client.query(
      `SELECT count(*)::int AS n FROM kith.worker_operational_incidents
         WHERE source_account_id = $1 AND kind = 'missing_worker'`,
      [f.sourceAccountId],
    );
    assert.equal(incidents.rows[0].n, 1);

    const openIncident = await f.client.query(
      `SELECT observed_at FROM kith.worker_operational_incidents
         WHERE source_account_id = $1 AND state = 'open'`,
      [f.sourceAccountId],
    );
    assert.equal(
      openIncident.rows[0].observed_at.getTime(),
      overdueAt + 60_000,
    );

    // A heartbeat resolves the open incident; a later overdue period on the
    // *same* day does not reopen it, so the "once per day" count stays at one
    // even though the watcher went missing twice in one day.
    await withWorkerTransaction(
      f.pool,
      (ctx) => recordWorkerHeartbeat(ctx, f.principal, heartbeatRequest),
      overdueAt + 120_000,
    );
    const thirdOverdueAt = overdueAt + 120_000 + 180_000;
    const third = await withKithTransaction(f.pool, (client) =>
      recordMissingWorkerIncidents(workerCtx(client, thirdOverdueAt)),
    );
    assert.equal(third.recorded, 0);
    const stillOne = await f.client.query(
      `SELECT count(*)::int AS n FROM kith.worker_operational_incidents
         WHERE source_account_id = $1 AND kind = 'missing_worker'`,
      [f.sourceAccountId],
    );
    assert.equal(stillOne.rows[0].n, 1);

    // The following day, a fresh missing period opens a new incident row.
    const nextDay = Date.parse("2026-09-15T12:00:00Z");
    const fourth = await withKithTransaction(f.pool, (client) =>
      recordMissingWorkerIncidents(workerCtx(client, nextDay)),
    );
    assert.equal(fourth.recorded, 1);
    const twoRows = await f.client.query(
      `SELECT count(*)::int AS n FROM kith.worker_operational_incidents
         WHERE source_account_id = $1 AND kind = 'missing_worker'`,
      [f.sourceAccountId],
    );
    assert.equal(twoRows.rows[0].n, 2);
  },
);

test("a missed tick costs nothing: running tick twice is a no-op the second time", { skip }, async (t) => {
  const f = await sourceFixture(t);
  const keyId = newKithId();
  await f.client.query(
    `INSERT INTO kith.api_keys
       (id, user_id, key_hash, key_prefix, name, capabilities, oauth_lifecycle,
        oauth_request_hash, oauth_binding_seed_hash, oauth_grant_expires_at)
       VALUES ($1,$2,repeat('cd',32),'ccccccccccc','Expired grant',
               '[]'::jsonb,'pending',repeat('c',64),repeat('d',64),$3)`,
    [keyId, f.userId, new Date(NOW - 1_000)],
  );
  const receiptId = await insertOperationReceipt(
    f.client,
    f.spaceId,
    new Date(NOW - 1_000),
  );

  const registry = createRegistry();
  const first = await tick(f.pool, registry, { now: NOW });
  assert.equal(first.sweeps.expiredOAuthGrants.removed, 1);
  assert.equal(first.sweeps.expiredWorkerProtocolState.removed, 1);
  assert.equal(first.sweeps.inlineIngestionRecovery.recovered, 0);
  assert.equal(first.drain.claimed, 0);

  const second = await tick(f.pool, registry, { now: NOW + 1 });
  assert.equal(second.sweeps.expiredOAuthGrants.removed, 0);
  assert.equal(second.sweeps.expiredWorkerProtocolState.removed, 0);
  assert.equal(second.sweeps.inlineIngestionRecovery.recovered, 0);
  assert.equal(second.drain.claimed, 0);

  const keyGone = await f.client.query(
    "SELECT count(*)::int AS n FROM kith.api_keys WHERE id = $1",
    [keyId],
  );
  assert.equal(keyGone.rows[0].n, 0);
  const receiptGone = await f.client.query(
    "SELECT count(*)::int AS n FROM kith.worker_operation_receipts WHERE id = $1",
    [receiptId],
  );
  assert.equal(receiptGone.rows[0].n, 0);
});
