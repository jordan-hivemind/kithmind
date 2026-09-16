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

/** A `worker_source_scans` row with no pages or entries: the minimal valid
 * row (migration 008's required columns), used both as a scan
 * `source_inventory` still points to and as an unreferenced sibling. */
async function insertScan(client, f, { retireAt, requestId }) {
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.worker_source_scans
       (id, space_id, created_at, source_account_id, request_id, request_digest,
        watcher_id, connector_version, mode, inventory_epoch, manifest_version_at_begin,
        actor_user_id, actor_credential_id, state, next_page_ordinal,
        next_reconcile_ordinal, inventory_done, page_count, entry_count,
        changed_count, gap_count, review_count, started_at, expires_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,
       'fixture-watcher','fixture-connector','normal',0,0,$6,$7,'enumerated',
       1,1,true,0,0,0,0,0,$8,$8,$9)`,
    [
      id,
      f.spaceId,
      f.sourceAccountId,
      requestId,
      `${requestId}-digest`,
      f.userId,
      f.principal.credentialId,
      new Date(NOW),
      retireAt,
    ],
  );
  return id;
}

async function insertSourceItem(client, spaceId) {
  const id = newKithId();
  await client.query(
    "INSERT INTO kith.source_items (id, space_id, created_at) VALUES ($1,$2,transaction_timestamp())",
    [id, spaceId],
  );
  return id;
}

async function insertSourceInventory(client, spaceId, column, scanId) {
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.source_inventory (id, space_id, created_at, ${column})
     VALUES ($1,$2,transaction_timestamp(),$3)`,
    [id, spaceId, scanId],
  );
  return id;
}

/** A full `worker_discovery_work` chain (scan, page, entry, work row), the
 * minimal valid rows migrations 008 and 010 require. `chainRetireAt` governs
 * the backing scan/page/entry so the chain's own foreign keys stay
 * satisfiable regardless of what this sweep does to the work row itself;
 * `workRetireAt` governs only the work row, which is this test's actual
 * subject. */
async function insertDiscoveryWork(
  client,
  f,
  sourceItemId,
  { chainRetireAt, workRetireAt, requestId },
) {
  const scanId = newKithId();
  const pageId = newKithId();
  const entryId = newKithId();
  const workId = newKithId();
  const now = new Date(NOW);
  await client.query(
    `INSERT INTO kith.worker_source_scans
       (id, space_id, created_at, source_account_id, request_id, request_digest,
        watcher_id, connector_version, mode, inventory_epoch, manifest_version_at_begin,
        actor_user_id, actor_credential_id, state, next_page_ordinal,
        next_reconcile_ordinal, inventory_done, page_count, entry_count,
        changed_count, gap_count, review_count, started_at, expires_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,
       'fixture-watcher','fixture-connector','normal',0,0,$6,$7,'enumerated',
       1,1,true,1,1,0,0,0,$8,$9,$9)`,
    [
      scanId,
      f.spaceId,
      f.sourceAccountId,
      requestId,
      `${requestId}-digest`,
      f.userId,
      f.principal.credentialId,
      now,
      chainRetireAt,
    ],
  );
  await client.query(
    `INSERT INTO kith.worker_scan_pages
       (id, space_id, created_at, source_account_id, scan_id, ordinal,
        request_id, entry_count, created_at_field, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,0,$5,1,$6,$7)`,
    [pageId, f.spaceId, f.sourceAccountId, scanId, `${requestId}-page`, now, chainRetireAt],
  );
  await client.query(
    `INSERT INTO kith.worker_scan_entries
       (id, space_id, created_at, source_account_id, scan_id, scan_page_id,
        source_item_id, identity_key_hash, uri_digest, inventory_metadata_digest,
        source_modified_at, state, observed_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,'queued',$10,$11)`,
    [
      entryId,
      f.spaceId,
      f.sourceAccountId,
      scanId,
      pageId,
      sourceItemId,
      `${requestId}-identity`,
      `${requestId}-uri`,
      `${requestId}-meta`,
      now,
      chainRetireAt,
    ],
  );
  await client.query(
    `INSERT INTO kith.worker_discovery_work
       (id, space_id, created_at, source_account_id, source_item_id, scan_id,
        scan_entry_id, observation_epoch, processing_epoch, state, content_hash,
        byte_length, captured_at, source_modified_at, media_type, profile_id,
        extraction_fingerprint, extractor_fingerprint, record_schema_fingerprint,
        normalization_fingerprint, chunker_fingerprint, uri, actor_user_id,
        actor_credential_id, attempts, lease_epoch, created_at_field, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,1,1,'admitted',$7,
       1,$8,$8,'application/pdf','fixture-profile','fixture-extraction',
       'fixture-extractor','fixture-records','fixture-normalization',
       'fixture-chunker','fixture://parsed',$9,$10,1,1,$8,$11)`,
    [
      workId,
      f.spaceId,
      f.sourceAccountId,
      sourceItemId,
      scanId,
      entryId,
      "a".repeat(64),
      now,
      f.userId,
      f.principal.credentialId,
      workRetireAt,
    ],
  );
  await client.query(
    "UPDATE kith.worker_scan_entries SET discovery_work_id = $1 WHERE id = $2",
    [workId, entryId],
  );
  return { workId, scanId, pageId, entryId };
}

async function insertIngestJobReferencingWork(client, f, workId) {
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.ingest_jobs (id, space_id, created_at, worker_discovery_work_id)
     VALUES ($1,$2,transaction_timestamp(),$3)`,
    [id, f.spaceId, workId],
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
  "removeExpiredWorkerProtocolState keeps a scan or discovery-work row a durable row still references, and its transaction commits",
  { skip },
  async (t) => {
    const f = await sourceFixture(t);
    const past = new Date(NOW - 1_000);
    const future = new Date(NOW + 60_000);

    // A scan past its own retire_at, but still pointed to by a durable
    // source_inventory row: without the guard, deleting it would leave that
    // row's deferred foreign key dangling at COMMIT.
    const referencedScanId = await insertScan(f.client, f, {
      retireAt: past,
      requestId: "referenced-scan",
    });
    await insertSourceInventory(
      f.client,
      f.spaceId,
      "first_seen_scan_id",
      referencedScanId,
    );

    // An unreferenced sibling scan past its own retire_at: nothing durable
    // points to it, so the sweep is still free to delete it.
    const unreferencedScanId = await insertScan(f.client, f, {
      retireAt: past,
      requestId: "unreferenced-scan",
    });

    // A discovery-work row past its own retire_at, but still pointed to by a
    // durable ingest_jobs row. Its own backing scan/page/entry chain is kept
    // live (a future retire_at) so this case isolates the defect under test:
    // the work row's own foreign keys to that chain are not at risk here.
    const referencedItemId = await insertSourceItem(f.client, f.spaceId);
    const referencedWork = await insertDiscoveryWork(
      f.client,
      f,
      referencedItemId,
      { chainRetireAt: future, workRetireAt: past, requestId: "referenced-work" },
    );
    await insertIngestJobReferencingWork(f.client, f, referencedWork.workId);

    // An unreferenced sibling discovery-work row, chain included, all past
    // retirement: nothing durable points to any of it.
    const unreferencedItemId = await insertSourceItem(f.client, f.spaceId);
    const unreferencedWork = await insertDiscoveryWork(
      f.client,
      f,
      unreferencedItemId,
      { chainRetireAt: past, workRetireAt: past, requestId: "unreferenced-work" },
    );

    // Before the fix, this transaction would abort at COMMIT with a foreign
    // key violation the moment the referenced scan or work row was deleted.
    const result = await withKithTransaction(f.pool, (client) =>
      removeExpiredWorkerProtocolState(deferredCtx(client, NOW)),
    );
    assert.equal(result.removed, 5); // unreferenced scan + work + entry + page + scan

    const scans = await f.client.query(
      "SELECT id FROM kith.worker_source_scans",
    );
    const scanIds = scans.rows.map((row) => row.id);
    assert.ok(scanIds.includes(referencedScanId));
    assert.ok(!scanIds.includes(unreferencedScanId));

    const work = await f.client.query(
      "SELECT id FROM kith.worker_discovery_work",
    );
    const workIds = work.rows.map((row) => row.id);
    assert.ok(workIds.includes(referencedWork.workId));
    assert.ok(!workIds.includes(unreferencedWork.workId));

    // A second, unbounded pass is still a no-op on the referenced rows: they
    // stay kept for as long as the reference exists, not just on the first
    // pass.
    const rest = await withKithTransaction(f.pool, (client) =>
      removeExpiredWorkerProtocolState(deferredCtx(client, NOW), {
        limit: 1_000,
      }),
    );
    assert.equal(rest.removed, 0);
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
