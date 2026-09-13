import assert from "node:assert/strict";
import test from "node:test";

import { createKithPool, newKithId, provenance } from "../dist/index.js";
import { listSources } from "../dist/documents/index.js";
import {
  MAX_INLINE_TEXT_CHUNK_UTF8_BYTES,
  planInlineText,
  sha256Hex,
} from "../dist/ingestion/index.js";
import {
  END_CURSOR,
  WorkerProtocolError,
  activateProcessingJob,
  appendWorkerScanPage,
  admitDiscoveryUtf8,
  beginWorkerScan,
  camelizeScan,
  consumeWorkerMutationRateLimit,
  decodeCursor,
  encodeCursor,
  keysetTail,
  getWorkerDiagnosticsStatus,
  recordWorkerHeartbeat,
  requireWorkerSourceAccount,
  reconcileWorkerScan,
  renewProcessingJob,
  reserveDiscoveryWork,
  reserveProcessingJobs,
  resolveAndPersistEntry,
  sealWorkerScan,
  stageProcessingUtf8,
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

const NOW = Date.parse("2026-09-13T12:00:00Z");
const HASH_A = "a".repeat(64);

function expectProtocolCode(code) {
  return (error) =>
    error instanceof WorkerProtocolError && error.data.code === code;
}

test("worker cursors preserve PostgreSQL microseconds in the ordering key", () => {
  const id = newKithId();
  const createdAt = "2026-09-13 12:00:00.123456+00";
  const encoded = encodeCursor({ createdAt, id });
  assert.deepEqual(decodeCursor(encoded), { createdAt, id });
  assert.deepEqual(keysetTail(decodeCursor(encoded), 4), {
    sql:
      "AND (created_at, id) > ($4, $5) " + "ORDER BY created_at, id LIMIT $6",
    values: [createdAt, id],
  });
  assert.equal(decodeCursor(END_CURSOR), null);
  assert.throws(
    () =>
      decodeCursor(
        Buffer.from(JSON.stringify(["not-a-timestamp", id])).toString(
          "base64url",
        ),
      ),
    expectProtocolCode("scan_conflict"),
  );
});

test("inline planning keeps UTF-8 boundaries and the migrated digest", async () => {
  const text = "a".repeat(MAX_INLINE_TEXT_CHUNK_UTF8_BYTES - 1) + "😀b";
  const plan = planInlineText(text);
  assert.deepEqual(
    plan.chunks.map(({ start, end, text: chunk }) => [
      start,
      end,
      Buffer.byteLength(chunk, "utf8"),
    ]),
    [
      [0, MAX_INLINE_TEXT_CHUNK_UTF8_BYTES - 1, 2_047],
      [MAX_INLINE_TEXT_CHUNK_UTF8_BYTES - 1, text.length, 5],
    ],
  );
  assert.equal(
    await sha256Hex("alpha beta"),
    "1a989ea86150171c687b0727f218eedbb94c4665a7da9b0add1bf5de607f2bf1",
  );
});

async function fixture(t) {
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
  const source = await requireWorkerSourceAccount(
    workerCtx(database.client, NOW),
    principal,
    { spaceId, sourceAccountId },
  );
  return {
    ...database,
    userId,
    spaceId,
    sourceAccountId,
    credential,
    principal,
    source,
  };
}

async function makeScan(f, inventoryEpoch = 1) {
  const scanId = newKithId();
  const pageId = newKithId();
  await f.client.query(
    `INSERT INTO kith.worker_source_scans
       (id, space_id, source_account_id, request_id, request_digest,
        watcher_id, connector_version, mode, inventory_epoch,
        manifest_version_at_begin, actor_user_id, actor_credential_id, state,
        next_page_ordinal, inventory_done, page_count, entry_count,
        changed_count, gap_count, review_count, next_reconcile_ordinal,
        started_at, expires_at, retire_at)
     VALUES ($1,$2,$3,$4,$5,'watcher-1','fs-v1','normal',$6,0,$7,$8,
             'open',1,false,1,0,0,0,0,0,$9,$10,$11)`,
    [
      scanId,
      f.spaceId,
      f.sourceAccountId,
      `scan-${inventoryEpoch}`,
      `digest-${inventoryEpoch}`,
      inventoryEpoch,
      f.userId,
      f.credential.id,
      new Date(NOW),
      new Date(NOW + 60_000),
      new Date(NOW + 120_000),
    ],
  );
  await f.client.query(
    `INSERT INTO kith.worker_scan_pages
       (id, space_id, source_account_id, scan_id, ordinal, request_id,
        request_digest, entry_count, created_at_field, retire_at)
     VALUES ($1,$2,$3,$4,0,$5,$6,0,$7,$8)`,
    [
      pageId,
      f.spaceId,
      f.sourceAccountId,
      scanId,
      `page-${inventoryEpoch}`,
      `page-digest-${inventoryEpoch}`,
      new Date(NOW),
      new Date(NOW + 120_000),
    ],
  );
  const raw = await f.client.query(
    "SELECT * FROM kith.worker_source_scans WHERE id = $1",
    [scanId],
  );
  return { scan: camelizeScan(raw.rows[0]), pageId };
}

function readyEntry(overrides = {}) {
  return {
    externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
    uri: "fs://synthetic/a.txt",
    title: "A",
    docType: "text",
    sourceModifiedAt: NOW - 1_000,
    content: { status: "ready", sha256: HASH_A, byteLength: 10 },
    ...overrides,
  };
}

test(
  "worker authorization reloads revocation and hides cross-space sources",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const ctx = workerCtx(f.client, NOW);
    assert.equal(
      (
        await requireWorkerSourceAccount(ctx, f.principal, {
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
        })
      ).account.id,
      f.sourceAccountId,
    );
    await assert.rejects(
      requireWorkerSourceAccount(ctx, f.principal, {
        spaceId: newKithId(),
        sourceAccountId: f.sourceAccountId,
      }),
      expectProtocolCode("not_found"),
    );
    await f.client.query("DELETE FROM kith.api_keys WHERE id = $1", [
      f.credential.id,
    ]);
    await assert.rejects(
      requireWorkerSourceAccount(ctx, f.principal, {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
      }),
      expectProtocolCode("not_authenticated"),
    );
  },
);

test(
  "entry resolution creates one work chain and retains a duplicate for review",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const { scan, pageId } = await makeScan(f);
    const first = await resolveAndPersistEntry(workerCtx(f.client, NOW), {
      source: f.source,
      scan,
      pageId,
      entry: readyEntry(),
    });
    assert.equal(first.row.state, "queued");
    assert.equal(first.row.observationEpoch, 1);
    assert.equal(first.row.processingEpoch, 1);
    assert.ok(first.row.sourceItemId);
    assert.ok(first.row.discoveryWorkId);
    assert.equal(first.manifestChanged, true);

    const duplicate = await resolveAndPersistEntry(workerCtx(f.client, NOW), {
      source: f.source,
      scan,
      pageId,
      entry: readyEntry({ title: "Conflicting duplicate" }),
    });
    assert.equal(duplicate.row.state, "needs_review");
    assert.equal(duplicate.row.issueCode, "duplicate_scan_identity");
    assert.equal(duplicate.row.sourceItemId, null);
    assert.equal(duplicate.row.proposedTitle, "Conflicting duplicate");

    const entries = await f.client.query(
      `SELECT state, issue_code FROM kith.worker_scan_entries
        WHERE scan_id = $1 ORDER BY created_at, id`,
      [scan.id],
    );
    assert.deepEqual(
      entries.rows.map(({ state, issue_code: issueCode }) => ({
        state,
        issueCode,
      })),
      [
        { state: "queued", issueCode: null },
        { state: "needs_review", issueCode: "duplicate_scan_identity" },
      ],
    );
    assert.equal(
      (
        await f.client.query(
          "SELECT count(*)::int AS count FROM kith.worker_discovery_work",
        )
      ).rows[0].count,
      1,
    );
  },
);

test(
  "rate limiting is isolated by credential and source and resets after expiry",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    try {
      for (let count = 0; count < 59; count += 1) {
        await withWorkerTransaction(
          pool,
          (ctx) =>
            consumeWorkerMutationRateLimit(
              ctx,
              f.credential.id,
              f.sourceAccountId,
            ),
          NOW,
        );
      }
      const raced = await Promise.allSettled([
        withWorkerTransaction(
          pool,
          (ctx) =>
            consumeWorkerMutationRateLimit(
              ctx,
              f.credential.id,
              f.sourceAccountId,
            ),
          NOW,
        ),
        withWorkerTransaction(
          pool,
          (ctx) =>
            consumeWorkerMutationRateLimit(
              ctx,
              f.credential.id,
              f.sourceAccountId,
            ),
          NOW,
        ),
      ]);
      assert.deepEqual(raced.map(({ status }) => status).sort(), [
        "fulfilled",
        "rejected",
      ]);
      const rejected = raced.find(({ status }) => status === "rejected");
      assert.ok(
        rejected.status === "rejected" &&
          expectProtocolCode("rate_limited")(rejected.reason),
      );
      assert.equal(
        (
          await f.client.query(
            `SELECT count::int AS count FROM kith.worker_protocol_rate_limits
              WHERE credential_id = $1 AND source_account_id = $2`,
            [f.credential.id, f.sourceAccountId],
          )
        ).rows[0].count,
        60,
      );
      await assert.doesNotReject(
        withWorkerTransaction(
          pool,
          (ctx) =>
            consumeWorkerMutationRateLimit(
              ctx,
              f.credential.id,
              f.sourceAccountId,
            ),
          NOW + 60_001,
        ),
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "scan operations replay safely, expire leases, and reconcile missing items",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const oldItem = await provenance.createOrGetSourceItem(f.client, {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
      title: "Old",
      docType: "text",
      uri: "fs://synthetic/old.txt",
    });
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    try {
      const beginRequest = {
        protocolVersion: 1,
        operation: "scan.begin",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "scan-begin-1",
        watcherId: "watcher-1",
        connectorVersion: "fs-v1",
        mode: "normal",
        expectedInventoryEpoch: 0,
      };
      const begun = await call((ctx) =>
        beginWorkerScan(ctx, f.principal, beginRequest),
      );
      assert.equal(begun.reused, false);
      assert.equal(begun.inventoryEpoch, 1);
      assert.deepEqual(
        await call((ctx) => beginWorkerScan(ctx, f.principal, beginRequest)),
        { ...begun, reused: true },
      );
      await assert.rejects(
        call((ctx) =>
          beginWorkerScan(ctx, f.principal, {
            ...beginRequest,
            watcherId: "different-watcher",
          }),
        ),
        expectProtocolCode("request_conflict"),
      );

      const appendRequest = {
        protocolVersion: 1,
        operation: "scan.appendPage",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        scanId: begun.scanId,
        requestId: "scan-page-1",
        ordinal: 0,
        entries: [readyEntry()],
      };
      const appended = await call((ctx) =>
        appendWorkerScanPage(ctx, f.principal, appendRequest),
      );
      assert.equal(appended.reused, false);
      assert.equal(appended.entries[0].state, "queued");
      assert.deepEqual(
        await call((ctx) =>
          appendWorkerScanPage(ctx, f.principal, appendRequest),
        ),
        { ...appended, reused: true },
      );

      const sealRequest = {
        protocolVersion: 1,
        operation: "scan.seal",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        scanId: begun.scanId,
        requestId: "scan-seal-1",
        expectedPageCount: 1,
        health: { status: "healthy" },
      };
      assert.equal(
        (await call((ctx) => sealWorkerScan(ctx, f.principal, sealRequest)))
          .state,
        "sealed",
      );
      assert.equal(
        (await call((ctx) => sealWorkerScan(ctx, f.principal, sealRequest)))
          .reused,
        true,
      );

      const reconcileRequest = {
        protocolVersion: 1,
        operation: "scan.reconcile",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        scanId: begun.scanId,
        requestId: "scan-reconcile-1",
        expectedInventoryEpoch: 1,
        ordinal: 0,
        maxItems: 10,
      };
      const reconciled = await call((ctx) =>
        reconcileWorkerScan(ctx, f.principal, reconcileRequest),
      );
      assert.deepEqual(
        {
          state: reconciled.state,
          unavailable: reconciled.unavailable,
          done: reconciled.done,
          reused: reconciled.reused,
        },
        { state: "enumerated", unavailable: 1, done: true, reused: false },
      );
      assert.equal(
        (
          await call((ctx) =>
            reconcileWorkerScan(ctx, f.principal, reconcileRequest),
          )
        ).reused,
        true,
      );
      assert.equal(
        (
          await f.client.query(
            "SELECT lifecycle FROM kith.source_items WHERE id = $1",
            [oldItem.id],
          )
        ).rows[0].lifecycle,
        "unavailable",
      );

      const expired = await call(
        (ctx) =>
          beginWorkerScan(ctx, f.principal, {
            ...beginRequest,
            requestId: "scan-begin-expired",
            expectedInventoryEpoch: 1,
          }),
        NOW + 1,
      );
      await assert.rejects(
        call(
          (ctx) =>
            appendWorkerScanPage(ctx, f.principal, {
              ...appendRequest,
              scanId: expired.scanId,
              requestId: "expired-page",
            }),
          NOW + 30 * 60 * 1_000 + 2,
        ),
        expectProtocolCode("scan_not_ready"),
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "a failed scan append rolls back its page, entry, and rate-limit unit",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const call = (work) => withWorkerTransaction(pool, work, NOW);
    try {
      const begun = await call((ctx) =>
        beginWorkerScan(ctx, f.principal, {
          protocolVersion: 1,
          operation: "scan.begin",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          requestId: "atomic-begin",
          watcherId: "watcher-1",
          connectorVersion: "fs-v1",
          mode: "normal",
          expectedInventoryEpoch: 0,
        }),
      );
      const duplicateExternalId = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c141";
      const first = await provenance.createOrGetSourceItem(f.client, {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalId: duplicateExternalId,
        title: "First",
        docType: "text",
        uri: "fs://synthetic/first.txt",
      });
      await f.client.query(
        `INSERT INTO kith.source_items
           (id, space_id, created_at, source_account_id, external_id_hash,
            external_id, lifecycle, original_link_available,
            desired_processing_epoch)
         SELECT $1, space_id, transaction_timestamp(), source_account_id,
                external_id_hash, external_id, 'available', true, 0
           FROM kith.source_items WHERE id = $2`,
        [newKithId(), first.id],
      );
      await assert.rejects(
        call((ctx) =>
          appendWorkerScanPage(ctx, f.principal, {
            protocolVersion: 1,
            operation: "scan.appendPage",
            spaceId: f.spaceId,
            sourceAccountId: f.sourceAccountId,
            scanId: begun.scanId,
            requestId: "atomic-page",
            ordinal: 0,
            entries: [readyEntry({ externalId: duplicateExternalId })],
          }),
        ),
        expectProtocolCode("identity_review_required"),
      );
      assert.equal(
        (
          await f.client.query(
            "SELECT count(*)::int AS count FROM kith.worker_scan_pages WHERE scan_id = $1",
            [begun.scanId],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await f.client.query(
            `SELECT count::int AS count FROM kith.worker_protocol_rate_limits
              WHERE credential_id = $1 AND source_account_id = $2`,
            [f.credential.id, f.sourceAccountId],
          )
        ).rows[0].count,
        1,
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "discovery reservations fence leases and admit inline text exactly once",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    const text = "synthetic worker text";
    const contentHash = await sha256Hex(text);
    try {
      const begun = await call((ctx) =>
        beginWorkerScan(ctx, f.principal, {
          protocolVersion: 1,
          operation: "scan.begin",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          requestId: "discovery-begin",
          watcherId: "watcher-1",
          connectorVersion: "fs-v1",
          mode: "normal",
          expectedInventoryEpoch: 0,
        }),
      );
      await call((ctx) =>
        appendWorkerScanPage(ctx, f.principal, {
          protocolVersion: 1,
          operation: "scan.appendPage",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          scanId: begun.scanId,
          requestId: "discovery-page",
          ordinal: 0,
          entries: [
            readyEntry({
              content: {
                status: "ready",
                sha256: contentHash,
                byteLength: Buffer.byteLength(text, "utf8"),
              },
            }),
          ],
        }),
      );
      await call((ctx) =>
        sealWorkerScan(ctx, f.principal, {
          protocolVersion: 1,
          operation: "scan.seal",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          scanId: begun.scanId,
          requestId: "discovery-seal",
          expectedPageCount: 1,
          health: { status: "healthy" },
        }),
      );
      await call((ctx) =>
        reconcileWorkerScan(ctx, f.principal, {
          protocolVersion: 1,
          operation: "scan.reconcile",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          scanId: begun.scanId,
          requestId: "discovery-reconcile",
          expectedInventoryEpoch: 1,
          ordinal: 0,
          maxItems: 10,
        }),
      );

      const reserveRequest = {
        protocolVersion: 1,
        operation: "discovery.reserve",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "discovery-reserve",
        maxItems: 1,
      };
      const token = "1".repeat(64);
      const reserved = await call((ctx) =>
        reserveDiscoveryWork(ctx, f.principal, reserveRequest, [token]),
      );
      assert.equal(reserved.reused, false);
      assert.equal(reserved.targets.length, 1);
      assert.equal(reserved.targets[0].leaseEpoch, 1);
      assert.equal(reserved.targets[0].leaseToken, token);
      assert.deepEqual(
        await call((ctx) =>
          reserveDiscoveryWork(ctx, f.principal, reserveRequest, [token]),
        ),
        { ...reserved, reused: true },
      );
      await assert.rejects(
        call((ctx) =>
          admitDiscoveryUtf8(ctx, f.principal, {
            protocolVersion: 1,
            operation: "discovery.admitUtf8",
            spaceId: f.spaceId,
            sourceAccountId: f.sourceAccountId,
            requestId: "discovery-admit-wrong",
            workId: reserved.targets[0].workId,
            leaseEpoch: 1,
            leaseToken: "2".repeat(64),
            text,
          }),
        ),
        expectProtocolCode("lease_conflict"),
      );
      const admitRequest = {
        protocolVersion: 1,
        operation: "discovery.admitUtf8",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "discovery-admit",
        workId: reserved.targets[0].workId,
        leaseEpoch: 1,
        leaseToken: token,
        text,
      };
      const admitted = await call((ctx) =>
        admitDiscoveryUtf8(ctx, f.principal, admitRequest),
      );
      assert.equal(admitted.state, "admitted");
      assert.equal(admitted.reused, false);
      assert.equal(
        (
          await call((ctx) =>
            admitDiscoveryUtf8(ctx, f.principal, admitRequest),
          )
        ).reused,
        true,
      );
      assert.equal(
        (
          await f.client.query(
            "SELECT count(*)::int AS count FROM kith.ingest_jobs WHERE id = $1",
            [admitted.ingestJobId],
          )
        ).rows[0].count,
        1,
      );

      const jobReserveRequest = {
        protocolVersion: 1,
        operation: "jobs.reserve",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "job-reserve-1",
        maxItems: 1,
      };
      const jobToken = "3".repeat(64);
      const jobReservation = await call((ctx) =>
        reserveProcessingJobs(ctx, f.principal, jobReserveRequest, [jobToken]),
      );
      assert.equal(jobReservation.targets.length, 1);
      assert.equal(jobReservation.targets[0].jobId, admitted.ingestJobId);
      assert.deepEqual(
        await call((ctx) =>
          reserveProcessingJobs(ctx, f.principal, jobReserveRequest, [
            jobToken,
          ]),
        ),
        { ...jobReservation, reused: true },
      );
      const renewed = await call(
        (ctx) =>
          renewProcessingJob(ctx, f.principal, {
            protocolVersion: 1,
            operation: "jobs.renew",
            spaceId: f.spaceId,
            sourceAccountId: f.sourceAccountId,
            requestId: "job-renew-1",
            jobId: admitted.ingestJobId,
            leaseEpoch: 1,
            leaseToken: jobToken,
          }),
        NOW + 100,
      );
      assert.equal(renewed.leaseExpiresAt, NOW + 100 + 5 * 60 * 1_000);
      await assert.rejects(
        call(
          (ctx) =>
            stageProcessingUtf8(ctx, f.principal, {
              protocolVersion: 1,
              operation: "jobs.stageUtf8",
              spaceId: f.spaceId,
              sourceAccountId: f.sourceAccountId,
              requestId: "job-stage-expired",
              jobId: admitted.ingestJobId,
              leaseEpoch: 1,
              leaseToken: jobToken,
            }),
          renewed.leaseExpiresAt + 1,
        ),
        expectProtocolCode("lease_conflict"),
      );
      const reclaimedAt = renewed.leaseExpiresAt + 1;
      const replacementToken = "4".repeat(64);
      const reclaimed = await call(
        (ctx) =>
          reserveProcessingJobs(
            ctx,
            f.principal,
            { ...jobReserveRequest, requestId: "job-reserve-2" },
            [replacementToken],
          ),
        reclaimedAt,
      );
      assert.equal(reclaimed.targets[0].leaseEpoch, 2);

      await f.client
        .query(`CREATE FUNCTION kith.reject_worker_document() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic document refusal'; END $$`);
      await f.client
        .query(`CREATE TRIGGER reject_worker_document BEFORE INSERT ON kith.documents
        FOR EACH ROW EXECUTE FUNCTION kith.reject_worker_document()`);
      const stageRequest = {
        protocolVersion: 1,
        operation: "jobs.stageUtf8",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "job-stage-1",
        jobId: admitted.ingestJobId,
        leaseEpoch: 2,
        leaseToken: replacementToken,
      };
      await assert.rejects(
        call(
          (ctx) => stageProcessingUtf8(ctx, f.principal, stageRequest),
          reclaimedAt,
        ),
        expectProtocolCode("scan_conflict"),
      );
      assert.deepEqual(
        (
          await f.client.query(
            `SELECT
               (SELECT count(*)::int FROM kith.source_text_versions WHERE source_revision_id = $1) AS texts,
               (SELECT count(*)::int FROM kith.source_pages) AS pages,
               (SELECT count(*)::int FROM kith.evidence_spans) AS spans,
               (SELECT count(*)::int FROM kith.documents) AS documents`,
            [admitted.sourceRevisionId],
          )
        ).rows[0],
        { texts: 0, pages: 0, spans: 0, documents: 0 },
      );
      await f.client.query(
        "DROP TRIGGER reject_worker_document ON kith.documents",
      );
      await f.client.query("DROP FUNCTION kith.reject_worker_document() ");
      await f.client.query("CREATE SEQUENCE kith.worker_stage_retry_seq");
      await f.client
        .query(`CREATE FUNCTION kith.retry_worker_document_once() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF nextval('kith.worker_stage_retry_seq') = 1 THEN
            RAISE EXCEPTION 'synthetic serialization abort' USING ERRCODE = '40001';
          END IF;
          RETURN NEW;
        END $$`);
      await f.client
        .query(`CREATE TRIGGER retry_worker_document_once BEFORE INSERT ON kith.documents
        FOR EACH ROW EXECUTE FUNCTION kith.retry_worker_document_once()`);
      const staged = await call(
        (ctx) => stageProcessingUtf8(ctx, f.principal, stageRequest),
        reclaimedAt,
      );
      assert.equal(
        (
          await f.client.query(
            "SELECT last_value::int AS value FROM kith.worker_stage_retry_seq",
          )
        ).rows[0].value,
        2,
      );
      await f.client.query(
        "DROP TRIGGER retry_worker_document_once ON kith.documents",
      );
      await f.client.query("DROP FUNCTION kith.retry_worker_document_once() ");
      await f.client.query("DROP SEQUENCE kith.worker_stage_retry_seq");
      assert.equal(staged.state, "staged");
      assert.equal(staged.reused, false);
      assert.equal(
        (
          await f.client.query(
            "SELECT publication_state FROM kith.documents WHERE processing_generation_id = $1",
            [admitted.processingGenerationId],
          )
        ).rows[0].publication_state,
        "staged",
      );
      const activateRequest = {
        protocolVersion: 1,
        operation: "jobs.activate",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "job-activate-1",
        jobId: admitted.ingestJobId,
        leaseEpoch: 2,
        leaseToken: replacementToken,
      };
      const activated = await call(
        (ctx) => activateProcessingJob(ctx, f.principal, activateRequest),
        reclaimedAt,
      );
      assert.equal(activated.state, "ready");
      assert.equal(activated.reused, false);
      assert.equal(
        (
          await call(
            (ctx) => activateProcessingJob(ctx, f.principal, activateRequest),
            reclaimedAt,
          )
        ).reused,
        true,
      );
      const published = (
        await f.client.query(
          `SELECT i.active_generation_id, d.publication_state
             FROM kith.source_items i
             JOIN kith.documents d ON d.processing_generation_id = i.active_generation_id
            WHERE i.id = $1`,
          [admitted.sourceItemId],
        )
      ).rows[0];
      assert.deepEqual(published, {
        active_generation_id: admitted.processingGenerationId,
        publication_state: "active",
      });
      const sources = await listSources(f.client, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
      });
      assert.equal(sources.partial, false);
      assert.equal(sources.truncated, false);
      assert.equal(sources.sources.length, 1);
      assert.equal(sources.sources[0].pendingJobs, 0);
      assert.equal(sources.sources[0].failedJobs, 0);
      assert.equal(sources.sources[0].items.length, 1);
      assert.equal(sources.sources[0].items[0].contentStatus, "ready");
      assert.deepEqual(
        await listSources(f.client, [f.spaceId], {
          sourceAccountId: newKithId(),
        }),
        { sources: [], partial: false, truncated: false },
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "worker heartbeats suppress hot writes and reject watcher replacement",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    try {
      const statusRequest = {
        protocolVersion: 1,
        operation: "diagnostics.status",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
      };
      assert.deepEqual(
        await call((ctx) =>
          getWorkerDiagnosticsStatus(ctx, f.principal, statusRequest),
        ),
        {
          operation: "diagnostics.status",
          diagnosticsVersion: 1,
          sourceAccountId: f.sourceAccountId,
          source: "enabled",
          watcher: { state: "not_configured" },
          incident: { state: "none" },
        },
      );
      const heartbeatRequest = {
        protocolVersion: 1,
        operation: "diagnostics.heartbeat",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        watcherId: "watcher-1",
        connectorVersion: "fs-v1",
      };
      const first = await call((ctx) =>
        recordWorkerHeartbeat(ctx, f.principal, heartbeatRequest),
      );
      assert.deepEqual(first, {
        operation: "diagnostics.heartbeat",
        sourceAccountId: f.sourceAccountId,
        watcherId: "watcher-1",
        receivedAt: NOW,
        nextExpectedAt: NOW + 180_000,
      });
      assert.deepEqual(
        await call(
          (ctx) => recordWorkerHeartbeat(ctx, f.principal, heartbeatRequest),
          NOW + 100,
        ),
        first,
      );
      assert.equal(
        (
          await call(
            (ctx) =>
              getWorkerDiagnosticsStatus(ctx, f.principal, statusRequest),
            NOW + 179_999,
          )
        ).watcher.state,
        "current",
      );
      assert.equal(
        (
          await call(
            (ctx) =>
              getWorkerDiagnosticsStatus(ctx, f.principal, statusRequest),
            NOW + 180_000,
          )
        ).watcher.state,
        "overdue",
      );
      await assert.rejects(
        call(
          (ctx) =>
            recordWorkerHeartbeat(ctx, f.principal, {
              ...heartbeatRequest,
              watcherId: "watcher-2",
            }),
          NOW + 5_000,
        ),
        expectProtocolCode("identity_review_required"),
      );
    } finally {
      await pool.end();
    }
  },
);
