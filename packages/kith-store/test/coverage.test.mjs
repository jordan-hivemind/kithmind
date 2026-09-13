import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  applyKithSchema,
  coverage,
  newKithId,
  withKithTransaction,
} from "../dist/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

const NOW = 1_800_000_000_000;
async function setup(t) {
  const db = await throwawayDatabase(t),
    client = await connect(db);
  await applyKithSchema(client);
  const pool = db.adopt(new pg.Pool({ connectionString: db.url }));
  const userId = newKithId(),
    spaceId = newKithId(),
    accountId = newKithId();
  await client.query(
    "INSERT INTO kith.users(id,created_at) VALUES($1,transaction_timestamp())",
    [userId],
  );
  await client.query(
    "INSERT INTO kith.spaces(id,created_at,kind,name,created_by) VALUES($1,transaction_timestamp(),'personal','Synthetic',$2)",
    [spaceId, userId],
  );
  await client.query(
    "INSERT INTO kith.source_accounts(id,space_id,created_at,enabled,freshness_ms) VALUES($1,$2,transaction_timestamp(),true,1000)",
    [accountId, spaceId],
  );
  return { client, pool, userId, spaceId, accountId };
}
const tx = (f, fn) =>
  withKithTransaction(f.pool, (client) => fn({ client, now: NOW }));
const args = (f, more = {}) => ({
  spaceId: f.spaceId,
  sourceAccountIds: [f.accountId],
  recordType: "lab",
  from: 0,
  to: 100,
  now: NOW,
  snapshotAt: NOW,
  ...more,
});
async function complete(f, more = {}) {
  return tx(f, (ctx) =>
    coverage.upsertCoverageWindow(ctx, {
      spaceId: f.spaceId,
      sourceAccountId: f.accountId,
      recordType: "lab",
      from: 0,
      to: 100,
      state: "complete",
      lastEnumeratedAt: NOW - 100,
      lastProcessedAt: NOW - 100,
      discoveredCount: 1,
      indexedCount: 1,
      skippedCount: 0,
      ...more,
    }),
  );
}

async function entity(f, spaceId = f.spaceId) {
  const id = newKithId();
  await f.client.query(
    "INSERT INTO kith.entities(id,space_id,created_at,user_id,key,kind,canonical_name,normalized_name) VALUES($1,$2,transaction_timestamp(),$3,$4,'person','Synthetic','synthetic')",
    [id, spaceId, f.userId, id],
  );
  return id;
}

async function secondSpace(f) {
  const id = newKithId();
  await f.client.query(
    "INSERT INTO kith.spaces(id,created_at,kind,name,created_by) VALUES($1,transaction_timestamp(),'personal','Other',$2)",
    [id, f.userId],
  );
  return id;
}

test(
  "fresh, future, snapshot, epoch-zero and null counts never overclaim",
  { skip },
  async (t) => {
    const f = await setup(t);
    await complete(f);
    assert.equal(
      (await tx(f, (c) => coverage.calculateCoverage(c, args(f)))).state,
      "complete",
    );
    await complete(f, { lastEnumeratedAt: NOW + 1, lastProcessedAt: NOW + 1 });
    assert.equal(
      (await tx(f, (c) => coverage.calculateCoverage(c, args(f)))).state,
      "stale",
    );
    await complete(f);
    assert.equal(
      (
        await tx(f, (c) =>
          coverage.calculateCoverage(c, args(f, { snapshotAt: NOW - 101 })),
        )
      ).state,
      "stale",
    );
    await complete(f, { lastEnumeratedAt: 0, lastProcessedAt: 0 });
    const epochArgs = args(f, { now: 500, snapshotAt: 500 });
    assert.equal(
      (await tx(f, (c) => coverage.calculateCoverage(c, epochArgs))).state,
      "complete",
    );
    await f.client.query(
      "UPDATE kith.source_accounts SET coverage_invalidated_at=$2 WHERE id=$1",
      [f.accountId, new Date(0)],
    );
    assert.equal(
      (await tx(f, (c) => coverage.calculateCoverage(c, epochArgs))).state,
      "stale",
    );
    await f.client.query(
      "UPDATE kith.coverage_windows SET discovered_count=NULL",
    );
    assert.equal(
      (await tx(f, (c) => coverage.calculateCoverage(c, args(f)))).state,
      "partial",
    );
  },
);

test(
  "foreign/malformed gaps are suppressed and resolution is space-scoped",
  { skip },
  async (t) => {
    const f = await setup(t);
    await complete(f);
    const foreignSpace = await secondSpace(f);
    const foreignEntity = await entity(f, foreignSpace);
    const corrupt = await f.pool.connect();
    try {
      await corrupt.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await corrupt.query(
        "INSERT INTO kith.coverage_gaps(id,space_id,created_at,source_account_id,record_type,entity_id,reason,detected_at,status) VALUES($1,$2,transaction_timestamp(),$3,'lab',$4,'private cross-space reason',$5,'open')",
        [newKithId(), f.spaceId, f.accountId, foreignEntity, new Date(NOW)],
      );
      const hidden = await coverage.calculateCoverage(
        { client: corrupt, now: NOW },
        args(f),
      );
      assert.equal(hidden.state, "partial");
      assert.deepEqual(hidden.knownGaps, []);
    } finally {
      await corrupt.query("ROLLBACK");
      corrupt.release();
    }
    await f.client.query(
      "INSERT INTO kith.coverage_gaps(id,space_id,created_at,source_account_id,record_type,reason,detected_at,status) VALUES($1,$2,transaction_timestamp(),$3,'lab','',$4,'open')",
      [newKithId(), f.spaceId, f.accountId, new Date(NOW)],
    );
    let r = await tx(f, (c) => coverage.calculateCoverage(c, args(f)));
    assert.equal(r.state, "partial");
    assert.deepEqual(r.knownGaps, []);
    const id = await tx(f, (c) =>
      coverage.openCoverageGap(c, {
        spaceId: f.spaceId,
        sourceAccountId: f.accountId,
        recordType: "lab",
        reason: "valid",
        detectedAt: NOW,
      }),
    );
    await assert.rejects(
      tx(f, (c) =>
        coverage.resolveCoverageGap(c, {
          spaceId: newKithId(),
          gapId: id,
          resolvedAt: NOW + 1,
        }),
      ),
    );
    assert.equal(
      (
        await f.client.query(
          "SELECT status FROM kith.coverage_gaps WHERE id=$1",
          [id],
        )
      ).rows[0].status,
      "open",
    );
  },
);

test(
  "overlapping windows union and entity gaps scope conservatively",
  { skip },
  async (t) => {
    const f = await setup(t);
    const firstEntity = await entity(f);
    const secondEntity = await entity(f);
    await complete(f, { to: 60 });
    await complete(f, { from: 50 });
    let r = await tx(f, (c) => coverage.calculateCoverage(c, args(f)));
    assert.equal(r.state, "complete");
    assert.equal(r.windows.length, 2);
    await tx(f, (c) =>
      coverage.openCoverageGap(c, {
        spaceId: f.spaceId,
        sourceAccountId: f.accountId,
        recordType: "lab",
        entityId: firstEntity,
        from: 20,
        to: 30,
        reason: "Provider omitted one panel",
        detectedAt: NOW,
      }),
    );
    r = await tx(f, (c) => coverage.calculateCoverage(c, args(f)));
    assert.equal(r.state, "partial");
    assert.deepEqual(
      r.knownGaps.map((gap) => gap.reason),
      ["Provider omitted one panel"],
    );
    r = await tx(f, (c) =>
      coverage.calculateCoverage(c, args(f, { entityId: secondEntity })),
    );
    assert.equal(r.state, "complete");
    assert.deepEqual(r.knownGaps, []);
  },
);

test(
  "pending, failed, unfetched, malformed jobs and overflow block completeness",
  { skip },
  async (t) => {
    const f = await setup(t);
    await complete(f);
    const item = newKithId(),
      rev = newKithId();
    await f.client.query(
      "INSERT INTO kith.source_items(id,space_id,created_at,source_account_id,lifecycle,desired_processing_epoch) VALUES($1,$2,transaction_timestamp(),$3,'available',1)",
      [item, f.spaceId, f.accountId],
    );
    await f.client.query(
      "INSERT INTO kith.source_revisions(id,space_id,created_at,source_item_id,content_hash,byte_length,media_type,captured_at,user_id) VALUES($1,$2,transaction_timestamp(),$3,'x',1,'text/plain',transaction_timestamp(),$4)",
      [rev, f.spaceId, item, f.userId],
    );
    await f.client.query(
      "UPDATE kith.source_items SET desired_revision_id=$2 WHERE id=$1",
      [item, rev],
    );
    await f.client.query(
      "INSERT INTO kith.ingest_jobs(id,space_id,created_at,source_account_id,source_item_id,source_revision_id,desired_processing_epoch,state) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,1,'failed')",
      [newKithId(), f.spaceId, f.accountId, item, rev],
    );
    await f.client.query(
      "INSERT INTO kith.source_fetch_requests(id,space_id,created_at,source_account_id,source_item_id,state) VALUES($1,$2,transaction_timestamp(),$3,$4,'queued')",
      [newKithId(), f.spaceId, f.accountId, item],
    );
    let r = await tx(f, (c) => coverage.calculateCoverage(c, args(f)));
    assert.equal(r.state, "partial");
    assert.equal(r.failedJobs, 1);
    assert.equal(r.pendingJobs, 1);
    await f.client.query(
      "UPDATE kith.source_items SET lifecycle='forgotten' WHERE id=$1",
      [item],
    );
    r = await tx(f, (c) => coverage.calculateCoverage(c, args(f)));
    assert.equal(r.state, "complete");
    await f.client.query(
      "UPDATE kith.source_items SET lifecycle='available' WHERE id=$1",
      [item],
    );
    await f.client.query("DELETE FROM kith.source_fetch_requests");
    await f.client.query(
      "UPDATE kith.ingest_jobs SET desired_processing_epoch=NULL",
    );
    r = await tx(f, (c) => coverage.calculateCoverage(c, args(f)));
    assert.equal(r.state, "partial");
    assert.equal(r.pendingJobs, 0);
    assert.equal(r.failedJobs, 0);
    await f.client.query(
      "DELETE FROM kith.ingest_jobs; DELETE FROM kith.source_fetch_requests",
    );
    for (let n = 0; n < 129; n++)
      await f.client.query(
        "INSERT INTO kith.coverage_windows(id,space_id,created_at,source_account_id,record_type,\"from\",\"to\",state,last_enumerated_at,last_processed_at,discovered_count,indexed_count,skipped_count) VALUES($1,$2,transaction_timestamp(),$3,'overflow',$4,$5,'partial',$6,$6,0,0,0)",
        [
          newKithId(),
          f.spaceId,
          f.accountId,
          new Date(n * 1000),
          new Date(n * 1000 + 1),
          new Date(NOW),
        ],
      );
    r = await tx(f, (c) =>
      coverage.calculateCoverage(c, args(f, { recordType: "overflow" })),
    );
    assert.equal(r.overflow, true);
    assert.equal(r.state, "partial");
  },
);

test(
  "window upserts reject duplicate and foreign identities",
  { skip },
  async (t) => {
    const f = await setup(t);
    const id = await complete(f);
    assert.equal(
      await complete(f, { discoveredCount: 2, indexedCount: 2 }),
      id,
    );
    assert.equal(
      Number(
        (
          await f.client.query(
            "SELECT count(*) n FROM kith.coverage_windows WHERE source_account_id=$1",
            [f.accountId],
          )
        ).rows[0].n,
      ),
      1,
    );
    await f.client.query(
      'INSERT INTO kith.coverage_windows(id,space_id,created_at,source_account_id,record_type,"from","to",state,last_enumerated_at,last_processed_at,discovered_count,indexed_count,skipped_count) SELECT $1,space_id,transaction_timestamp(),source_account_id,record_type,"from","to",state,last_enumerated_at,last_processed_at,discovered_count,indexed_count,skipped_count FROM kith.coverage_windows WHERE id=$2',
      [newKithId(), id],
    );
    await assert.rejects(complete(f), /Duplicate coverage window identity/);
    await f.client.query("DELETE FROM kith.coverage_windows WHERE id<>$1", [
      id,
    ]);

    const foreignSpace = await secondSpace(f);
    const corrupt = await f.pool.connect();
    try {
      await corrupt.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await corrupt.query(
        "UPDATE kith.coverage_windows SET space_id=$2 WHERE id=$1",
        [id, foreignSpace],
      );
      await assert.rejects(
        coverage.upsertCoverageWindow(
          { client: corrupt, now: NOW },
          {
            spaceId: f.spaceId,
            sourceAccountId: f.accountId,
            recordType: "lab",
            from: 0,
            to: 100,
            state: "complete",
            lastEnumeratedAt: NOW,
            lastProcessedAt: NOW,
            discoveredCount: 1,
            indexedCount: 1,
            skippedCount: 0,
          },
        ),
        /Coverage window identity is corrupt/,
      );
    } finally {
      await corrupt.query("ROLLBACK");
      corrupt.release();
    }
  },
);

test(
  "serializable concurrent upserts converge on one stable identity",
  { skip },
  async (t) => {
    const f = await setup(t);
    const ids = await Promise.all(
      Array.from({ length: 2 }, (_, discoveredCount) =>
        complete(f, { discoveredCount, indexedCount: discoveredCount }),
      ),
    );
    assert.equal(new Set(ids).size, 1);
    assert.equal(
      Number(
        (
          await f.client.query(
            "SELECT count(*) n FROM kith.coverage_windows WHERE source_account_id=$1 AND record_type='lab'",
            [f.accountId],
          )
        ).rows[0].n,
      ),
      1,
    );
  },
);

test(
  "migration installs bounded coverage lookup indexes",
  { skip },
  async (t) => {
    const f = await setup(t);
    const rows = await f.client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname='kith' AND indexname = ANY($1) ORDER BY indexname",
      [
        [
          "coverage_fetch_requests_lookup_idx",
          "coverage_gaps_lookup_idx",
          "coverage_ingest_jobs_state_lookup_idx",
          "coverage_windows_lookup_idx",
        ],
      ],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.indexname),
      [
        "coverage_fetch_requests_lookup_idx",
        "coverage_gaps_lookup_idx",
        "coverage_ingest_jobs_state_lookup_idx",
        "coverage_windows_lookup_idx",
      ],
    );
  },
);
