import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { digestParsedMappingManifest } from "@repo/worker-protocol";
import { HttpWorkerTransport } from "../../pipeline/dist/transport.js";
import {
  createKithPool,
  newKithId,
  provenance,
  records,
  withKithTransaction,
} from "../dist/index.js";
import { listSources } from "../dist/documents/index.js";
import {
  MAX_INLINE_TEXT_CHUNK_UTF8_BYTES,
  planInlineText,
  sha256Hex,
} from "../dist/ingestion/index.js";
import {
  END_CURSOR,
  WorkerProtocolError,
  activateParsedJob,
  activateProcessingJob,
  acknowledgeArchiveDeletion,
  acknowledgeProviderOriginalDetach,
  admitArchivedDiscovery,
  appendWorkerScanPage,
  artifactBoundExtractionFingerprint,
  admitDiscoveryUtf8,
  beginWorkerScan,
  beginProcessingAssessment,
  camelizeScan,
  consumeWorkerMutationRateLimit,
  decodeCursor,
  encodeCursor,
  failParsedJob,
  failProcessingJob,
  failArchivedDiscovery,
  lookupArchivedAdmission,
  preflightArchivedDiscovery,
  keysetTail,
  getWorkerDiagnosticsStatus,
  getArchiveForgetTargets,
  getProviderOriginalForgetTargets,
  getWorkerInventoryPage,
  getWorkerSourceStatus,
  recordWorkerHeartbeat,
  advanceProcessingAssessment,
  requireWorkerSourceAccount,
  reconcileWorkerScan,
  renewProcessingJob,
  renewParsedJob,
  reserveArchivedDiscovery,
  resetExhaustedDiscoveryWork,
  reserveDiscoveryWork,
  reserveProcessingJobs,
  reserveParsedJobs,
  resolveAndPersistEntry,
  sealWorkerScan,
  stageProcessingUtf8,
  stageParsedBatch,
  touchWorkerPublicationEmbedding,
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
import { listenWorker } from "./helpers/workerHttpServer.mjs";

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

test(
  "worker publication preserves legacy embedding counters and rejects contradictory active fingerprints",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const profileId = newKithId();
    const embeddingGenerationId = newKithId();
    const fingerprint = "c".repeat(64);
    try {
      await f.client.query(
        `INSERT INTO kith.embedding_profiles (id,created_at,fingerprint)
         VALUES ($1,$2,$3)`,
        [profileId, new Date(NOW), fingerprint],
      );
      await f.client.query(
        `INSERT INTO kith.embedding_generations
         (id,space_id,created_at,embedding_profile_id,fingerprint,state,
          eligibility_epoch)
         VALUES ($1,$2,$3,$4,$5,'active',1)`,
        [
          embeddingGenerationId,
          f.spaceId,
          new Date(NOW),
          profileId,
          fingerprint,
        ],
      );
      await f.client.query(
        `INSERT INTO kith.space_embedding_states
         (id,space_id,created_at,eligibility_epoch,
          active_embedding_generation_id,active_fingerprint)
         VALUES ($1,$2,$3,1,$4,$5)`,
        [
          newKithId(),
          f.spaceId,
          new Date(NOW),
          embeddingGenerationId,
          fingerprint,
        ],
      );
      const publication = {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: newKithId(),
        processingGenerationId: newKithId(),
      };
      await withWorkerTransaction(
        pool,
        (ctx) => touchWorkerPublicationEmbedding(ctx, publication),
        NOW + 1,
      );
      const preserved = (
        await f.client.query(
          `SELECT s.eligibility_epoch,s.eligible_counts,s.covered_counts,
                  g.eligibility_epoch AS generation_epoch
           FROM kith.space_embedding_states s
           JOIN kith.embedding_generations g
             ON g.id=s.active_embedding_generation_id
           WHERE s.space_id=$1`,
          [f.spaceId],
        )
      ).rows[0];
      assert.equal(Number(preserved.eligibility_epoch), 2);
      assert.equal(preserved.eligible_counts, null);
      assert.equal(preserved.covered_counts, null);
      assert.equal(Number(preserved.generation_epoch), 2);

      await f.client.query(
        "UPDATE kith.space_embedding_states SET active_fingerprint=$1 WHERE space_id=$2",
        ["d".repeat(64), f.spaceId],
      );
      await assert.rejects(
        withWorkerTransaction(
          pool,
          (ctx) => touchWorkerPublicationEmbedding(ctx, publication),
          NOW + 2,
        ),
        expectProtocolCode("scan_conflict"),
      );
      assert.equal(
        Number(
          (
            await f.client.query(
              "SELECT eligibility_epoch FROM kith.space_embedding_states WHERE space_id=$1",
              [f.spaceId],
            )
          ).rows[0].eligibility_epoch,
        ),
        2,
      );
    } finally {
      await pool.end();
    }
  },
);

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

async function stageSyntheticWorkerRecord(ctx, f, generationId, eventKey) {
  const entityId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.entities
       (id,space_id,created_at,user_id,key,kind,canonical_name,
        normalized_name,aliases,normalized_aliases)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,'other','Synthetic vehicle',
       'synthetic vehicle','[]','[]')`,
    [entityId, f.spaceId, f.userId, `vehicle:${eventKey}`],
  );
  const spanId = (
    await ctx.client.query(
      `SELECT id FROM kith.evidence_spans
       WHERE source_text_version_id=(SELECT source_text_version_id
         FROM kith.processing_generations WHERE id=$1)
       ORDER BY ordinal LIMIT 1`,
      [generationId],
    )
  ).rows[0]?.id;
  assert.equal(typeof spanId, "string");
  const staged = await records.stageRecordBatch(ctx.client, {
    spaceId: f.spaceId,
    processingGenerationId: generationId,
    userId: f.userId,
    records: [
      {
        eventKey,
        entityId,
        eventType: "vehicle_service",
        schemaVersion: 1,
        occurrence: { precision: "date", date: "2026-09-13" },
        fieldEvidence: {
          occurrence: [spanId],
          entity: [spanId],
          eventType: [spanId],
        },
        observations: [
          {
            observationKey: "odometer",
            observationType: "odometer",
            value: { type: "integer", value: "1", unitCode: "[mi_i]" },
            valueEvidence: [spanId],
          },
        ],
      },
    ],
  });
  return { entityId, ...staged };
}

async function removeSyntheticWorkerRecord(client, staged, generationId) {
  await client.query(
    "DELETE FROM kith.observations WHERE processing_generation_id=$1",
    [generationId],
  );
  await client.query(
    "DELETE FROM kith.event_versions WHERE processing_generation_id=$1",
    [generationId],
  );
  await client.query("DELETE FROM kith.events WHERE id=$1", [
    staged.eventIds[0],
  ]);
  await client.query("DELETE FROM kith.entities WHERE id=$1", [
    staged.entityId,
  ]);
  await client.query(
    `UPDATE kith.processing_generations
     SET expected_event_count=0,expected_observation_count=0,
         actual_event_count=0,actual_observation_count=0
     WHERE id=$1`,
    [generationId],
  );
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
      await f.client.query(
        `INSERT INTO kith.worker_protocol_rate_limits
           (id, created_at, credential_id, source_account_id, window_started_at, count)
         VALUES ($1, $2, $3, $4, $2, 7999)`,
        ["r".repeat(26), new Date(NOW), f.credential.id, f.sourceAccountId],
      );
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
        8000,
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
      // The append has to fail somewhere for the rollback to be observable, and
      // `identity_review_required` is the cheapest way to make it fail. This
      // fixture used to plant a second `source_items` row under one external id
      // hash; migration 020's `source_items_external_identity_idx` makes that row
      // unwritable, which is the point of the index. The other half of
      // `itemByExternalIdentity`'s same refusal is still reachable and is what is
      // planted instead: a live item whose stored external id is not the one that
      // hashed to it, meaning a hash collision or a damaged identity column.
      const reviewExternalId = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c141";
      const first = await provenance.createOrGetSourceItem(f.client, {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalId: reviewExternalId,
        title: "First",
        docType: "text",
        uri: "fs://synthetic/first.txt",
      });
      await f.client.query(
        "UPDATE kith.source_items SET external_id = $1 WHERE id = $2",
        ["01890a5d-ac96-7cc4-bb7e-6f4f5ca5c999", first.id],
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
            entries: [readyEntry({ externalId: reviewExternalId })],
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
      const failRequest = {
        protocolVersion: 1,
        operation: "jobs.fail",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "job-fail-1",
        jobId: admitted.ingestJobId,
        leaseEpoch: 1,
        leaseToken: jobToken,
        failureCode: "worker_interrupted",
      };
      const failed = await call(
        (ctx) => failProcessingJob(ctx, f.principal, failRequest),
        NOW + 200,
      );
      assert.equal(failed.state, "failed");
      assert.equal(failed.retryable, true);
      assert.equal(
        (
          await call(
            (ctx) => failProcessingJob(ctx, f.principal, failRequest),
            NOW + 200,
          )
        ).reused,
        true,
      );
      await assert.rejects(
        call(
          (ctx) =>
            stageProcessingUtf8(ctx, f.principal, {
              protocolVersion: 1,
              operation: "jobs.stageUtf8",
              spaceId: f.spaceId,
              sourceAccountId: f.sourceAccountId,
              requestId: "job-stage-revoked",
              jobId: admitted.ingestJobId,
              leaseEpoch: 1,
              leaseToken: jobToken,
            }),
          failed.nextAttemptAt,
        ),
        expectProtocolCode("lease_conflict"),
      );
      const reclaimedAt = failed.nextAttemptAt;
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
      const nextPayload = (
        await f.client.query(
          `SELECT d.id AS document_id, c.id AS chunk_id, c.text,
                  g.source_text_version_id
           FROM kith.processing_generations g
           JOIN kith.documents d ON d.processing_generation_id = g.id
           JOIN kith.chunks c ON c.document_id = d.id
           WHERE g.id = $1`,
          [admitted.processingGenerationId],
        )
      ).rows[0];
      const malformedRecord = await call(
        (ctx) =>
          stageSyntheticWorkerRecord(
            ctx,
            f,
            admitted.processingGenerationId,
            "worker-inline-record",
          ),
        reclaimedAt,
      );
      const unexpectedRecordActivateRequest = {
        protocolVersion: 1,
        operation: "jobs.activate",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "job-activate-unexpected-record",
        jobId: admitted.ingestJobId,
        leaseEpoch: 2,
        leaseToken: replacementToken,
      };
      await assert.rejects(
        call(
          (ctx) =>
            activateProcessingJob(
              ctx,
              f.principal,
              unexpectedRecordActivateRequest,
            ),
          reclaimedAt,
        ),
        expectProtocolCode("scan_conflict"),
      );
      await f.client.query(
        "UPDATE kith.observations SET value=$1 WHERE id=$2",
        [
          { type: "integer", value: "01", unitCode: "[mi_i]" },
          malformedRecord.observationIds[0],
        ],
      );
      await f.client.query(
        `UPDATE kith.processing_generations
         SET expected_event_count=1,expected_observation_count=1,
             actual_event_count=1,actual_observation_count=1
         WHERE id=$1`,
        [admitted.processingGenerationId],
      );
      const malformedStored = (
        await f.client.query(
          `SELECT o.value,g.expected_event_count,g.expected_observation_count,
                  g.actual_event_count,g.actual_observation_count
           FROM kith.observations o
           JOIN kith.processing_generations g ON g.id=o.processing_generation_id
           WHERE o.id=$1`,
          [malformedRecord.observationIds[0]],
        )
      ).rows[0];
      assert.equal(malformedStored.value.value, "01");
      assert.equal(Number(malformedStored.expected_event_count), 1);
      assert.equal(Number(malformedStored.expected_observation_count), 1);
      assert.equal(Number(malformedStored.actual_event_count), 1);
      assert.equal(Number(malformedStored.actual_observation_count), 1);
      const malformedActivateRequest = {
        protocolVersion: 1,
        operation: "jobs.activate",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "job-activate-malformed-record",
        jobId: admitted.ingestJobId,
        leaseEpoch: 2,
        leaseToken: replacementToken,
      };
      await assert.rejects(
        call(
          (ctx) =>
            activateProcessingJob(ctx, f.principal, malformedActivateRequest),
          reclaimedAt,
        ),
        expectProtocolCode("scan_conflict"),
      );
      const malformedRollback = (
        await f.client.query(
          `SELECT j.state,d.publication_state,i.active_generation_id,
             (SELECT count(*)::int FROM kith.worker_operation_receipts
              WHERE request_id=$1) receipt_count,
             (SELECT count(*)::int FROM kith.space_processing_state
              WHERE space_id=j.space_id) processing_state_count,
             (SELECT count(*)::int FROM kith.space_embedding_states
              WHERE space_id=j.space_id) embedding_state_count
           FROM kith.ingest_jobs j
           JOIN kith.documents d ON d.processing_generation_id=j.processing_generation_id
           JOIN kith.source_items i ON i.id=j.source_item_id
           WHERE j.id=$2`,
          [malformedActivateRequest.requestId, admitted.ingestJobId],
        )
      ).rows[0];
      assert.deepEqual(malformedRollback, {
        state: "staged",
        publication_state: "staged",
        active_generation_id: null,
        receipt_count: 0,
        processing_state_count: 0,
        embedding_state_count: 0,
      });
      await removeSyntheticWorkerRecord(
        f.client,
        malformedRecord,
        admitted.processingGenerationId,
      );
      await f.client.query(
        "UPDATE kith.processing_generations SET actual_event_count=1 WHERE id=$1",
        [admitted.processingGenerationId],
      );
      await assert.rejects(
        call(
          (ctx) =>
            activateProcessingJob(ctx, f.principal, {
              ...unexpectedRecordActivateRequest,
              requestId: "job-activate-actual-count-mismatch",
            }),
          reclaimedAt,
        ),
        expectProtocolCode("scan_conflict"),
      );
      await f.client.query(
        "UPDATE kith.processing_generations SET actual_event_count=0 WHERE id=$1",
        [admitted.processingGenerationId],
      );
      // The superseded generation this activation has to retire. It carries a
      // processing fingerprint of its own rather than a copy of the current
      // one: migration 020 makes `(source_revision_id, processing_fingerprint)`
      // unique, and a real prior generation of the same revision differs in
      // exactly that column -- admission refuses a repeat of the pair and tells
      // the caller to increment `correctionRevision`, which is folded into the
      // fingerprint. Nothing here reads the retired generation's fingerprint;
      // it is the `active_generation_id` pointer below that makes it the one to
      // retire.
      const previousGenerationId = newKithId();
      const previousDocumentId = newKithId();
      const previousChunkId = newKithId();
      const previousFingerprint = "a".repeat(64);
      await f.client.query(
        `INSERT INTO kith.processing_generations
         (id,space_id,created_at,source_account_id,source_item_id,
          source_revision_id,source_text_version_id,processing_fingerprint,
          extraction_fingerprint,extractor_fingerprint,
          record_schema_fingerprint,normalization_fingerprint,
          chunker_fingerprint,correction_revision,desired_processing_epoch,
          card_generation,state,expected_page_count,
          expected_evidence_span_count,expected_document_count,
          expected_chunk_count,expected_event_count,
          expected_observation_count,actual_page_count,
          actual_evidence_span_count,actual_document_count,
          actual_chunk_count,actual_event_count,actual_observation_count,
          embedding_status,activated_at)
         SELECT $1,space_id,$2,source_account_id,source_item_id,
          source_revision_id,source_text_version_id,$4,
          extraction_fingerprint,extractor_fingerprint,
          record_schema_fingerprint,normalization_fingerprint,
          chunker_fingerprint,correction_revision,desired_processing_epoch,
          card_generation,'ready',expected_page_count,
          expected_evidence_span_count,expected_document_count,
          expected_chunk_count,expected_event_count,
          expected_observation_count,actual_page_count,
          actual_evidence_span_count,actual_document_count,
          actual_chunk_count,actual_event_count,actual_observation_count,
          embedding_status,$2
         FROM kith.processing_generations WHERE id=$3`,
        [
          previousGenerationId,
          new Date(reclaimedAt - 100),
          admitted.processingGenerationId,
          previousFingerprint,
        ],
      );
      await f.client.query(
        `INSERT INTO kith.documents
         (id,space_id,created_at,processing_generation_id,source_item_id,
          source_revision_id,source_text_version_id,document_key,title,
          doc_type,captured_at,evidence_span_ids,publication_state)
         SELECT $1,space_id,$2,$3,source_item_id,source_revision_id,
          source_text_version_id,document_key,title,doc_type,captured_at,
          evidence_span_ids,'active' FROM kith.documents WHERE id=$4`,
        [
          previousDocumentId,
          new Date(reclaimedAt - 100),
          previousGenerationId,
          nextPayload.document_id,
        ],
      );
      await f.client.query(
        `INSERT INTO kith.chunks
         (id,space_id,created_at,processing_generation_id,document_id,
          ordinal,source_text_version_id,"start","end",text,
          evidence_span_ids,publication_state)
         SELECT $1,space_id,$2,$3,$4,ordinal,source_text_version_id,
          "start","end",text,evidence_span_ids,'active'
         FROM kith.chunks WHERE id=$5`,
        [
          previousChunkId,
          new Date(reclaimedAt - 100),
          previousGenerationId,
          previousDocumentId,
          nextPayload.chunk_id,
        ],
      );
      await f.client.query(
        `UPDATE kith.source_items SET active_generation_id=$1,
         active_revision_id=desired_revision_id WHERE id=$2`,
        [previousGenerationId, admitted.sourceItemId],
      );
      await f.client.query(
        "UPDATE kith.source_accounts SET embed_full_chunks=true WHERE id=$1",
        [f.sourceAccountId],
      );
      const embeddingFingerprint = "e".repeat(64);
      const profileId = newKithId();
      const activeEmbeddingGenerationId = newKithId();
      const retiredEmbeddingGenerationId = newKithId();
      const stagedEmbeddingGenerationId = newKithId();
      await f.client.query(
        `INSERT INTO kith.embedding_profiles (id,created_at,fingerprint)
         VALUES ($1,$2,$3)`,
        [profileId, new Date(reclaimedAt - 100), embeddingFingerprint],
      );
      for (const [id, state] of [
        [activeEmbeddingGenerationId, "active"],
        [retiredEmbeddingGenerationId, "retired"],
        [stagedEmbeddingGenerationId, "staged"],
      ]) {
        await f.client.query(
          `INSERT INTO kith.embedding_generations
           (id,space_id,created_at,embedding_profile_id,fingerprint,state,
            eligibility_epoch,expected_thought_count,expected_chunk_count,
            completed_thought_count,completed_chunk_count,deactivated_at)
           VALUES ($1,$2,$3,$4,$5,$6,1,0,1,0,1,$7)`,
          [
            id,
            f.spaceId,
            new Date(reclaimedAt - 100),
            profileId,
            embeddingFingerprint,
            state,
            state === "retired" ? new Date(reclaimedAt - 50) : null,
          ],
        );
      }
      await f.client.query(
        `INSERT INTO kith.space_embedding_states
         (id,space_id,created_at,eligibility_epoch,
          active_embedding_generation_id,active_fingerprint,target_policy,
          eligible_counts,covered_counts,last_audit_at)
         VALUES ($1,$2,$3,1,$4,$5,'cards_and_opted_in_chunks',$6,$7,$8)`,
        [
          newKithId(),
          f.spaceId,
          new Date(reclaimedAt - 50),
          activeEmbeddingGenerationId,
          embeddingFingerprint,
          JSON.stringify({ thought: 0, chunk: 1, card: 0 }),
          JSON.stringify([
            {
              fingerprint: embeddingFingerprint,
              counts: { thought: 0, chunk: 1, card: 0 },
            },
          ]),
          new Date(reclaimedAt - 50),
        ],
      );
      const previousInputHash = await sha256Hex(nextPayload.text);
      await f.client.query(
        `INSERT INTO kith.embedding_targets
         (id,space_id,created_at,target_kind,target_id,input_hash,
          processing_generation_id,state,covered_fingerprint,updated_at)
         VALUES ($1,$2,$3,'chunk',$4,$5,$6,'eligible',$7,$3)`,
        [
          newKithId(),
          f.spaceId,
          new Date(reclaimedAt - 50),
          previousChunkId,
          previousInputHash,
          previousGenerationId,
          embeddingFingerprint,
        ],
      );
      const activeVectorId = newKithId();
      const retiredVectorId = newKithId();
      for (const [id, embeddingGenerationId] of [
        [activeVectorId, activeEmbeddingGenerationId],
        [retiredVectorId, retiredEmbeddingGenerationId],
      ]) {
        // P2-39g1: `embedding` is `public.vector(1536)` and `scope_v2` is
        // NOT NULL. This publication test does not read either -- it only
        // checks which vector rows a publish retires -- so the vector is the
        // cheapest well-formed one and the scope is the encoding a fill
        // would have written.
        await f.client.query(
          `INSERT INTO kith.embedding_vectors
           (id,space_id,created_at,embedding_generation_id,
            embedding_fingerprint,target_kind,search_scope,chunk_id,
            processing_generation_id,input_hash,embedding,scope_v2)
           VALUES ($1,$2,$3,$4,$5,'chunk','documents',$6,$7,$8,$9::public.vector,$10)`,
          [
            id,
            f.spaceId,
            new Date(reclaimedAt - 50),
            embeddingGenerationId,
            embeddingFingerprint,
            previousChunkId,
            previousGenerationId,
            previousInputHash,
            `[${new Array(1536).fill(0).map((_, index) => (index === 0 ? 1 : 0)).join(",")}]`,
            JSON.stringify([
              "embedding-vector-scope-v2",
              f.spaceId,
              embeddingFingerprint,
              "chunk",
            ]),
          ],
        );
      }
      const snapshotClock = reclaimedAt + 500;
      await f.client.query(
        `INSERT INTO kith.record_query_space_state
         (id,space_id,created_at,visibility_epoch,snapshot_clock,updated_at)
         VALUES ($1,$2,$3,1,$4,$3)`,
        [newKithId(), f.spaceId, new Date(reclaimedAt), snapshotClock],
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
      await f.client.query(
        `UPDATE kith.space_embedding_states SET eligible_counts=$1
         WHERE space_id=$2`,
        [JSON.stringify({ thought: 0, chunk: 1 }), f.spaceId],
      );
      await assert.rejects(
        call(
          (ctx) => activateProcessingJob(ctx, f.principal, activateRequest),
          reclaimedAt,
        ),
        expectProtocolCode("scan_conflict"),
      );
      const rolledBack = (
        await f.client.query(
          `SELECT i.active_generation_id,j.state,
                  (SELECT publication_state FROM kith.documents
                   WHERE processing_generation_id=$1) AS next_state,
                  (SELECT publication_state FROM kith.documents
                   WHERE processing_generation_id=$2) AS previous_state,
                  (SELECT count(*)::int FROM kith.embedding_vectors
                   WHERE id=$3) AS active_vectors
           FROM kith.source_items i JOIN kith.ingest_jobs j ON j.id=$4
           WHERE i.id=$5`,
          [
            admitted.processingGenerationId,
            previousGenerationId,
            activeVectorId,
            admitted.ingestJobId,
            admitted.sourceItemId,
          ],
        )
      ).rows[0];
      assert.deepEqual(rolledBack, {
        active_generation_id: previousGenerationId,
        state: "staged",
        next_state: "staged",
        previous_state: "active",
        active_vectors: 1,
      });
      await f.client.query(
        `UPDATE kith.space_embedding_states SET eligible_counts=$1
         WHERE space_id=$2`,
        [JSON.stringify({ thought: 0, chunk: 1, card: 0 }), f.spaceId],
      );
      const activated = await call(
        (ctx) => activateProcessingJob(ctx, f.principal, activateRequest),
        reclaimedAt,
      );
      assert.equal(activated.state, "ready");
      assert.equal(activated.reused, false);
      assert.equal(activated.activatedAt, snapshotClock + 1);
      assert.equal(activated.previousGenerationId, previousGenerationId);
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
      const embeddingAfter = (
        await f.client.query(
          `SELECT s.eligibility_epoch,s.eligible_counts,s.covered_counts,
                  a.eligibility_epoch AS active_epoch,
                  a.expected_chunk_count,a.completed_chunk_count,
                  staged.eligibility_epoch AS staged_epoch,
                  old_target.state AS old_target_state,
                  old_target.covered_fingerprint AS old_covered,
                  new_target.state AS new_target_state,
                  new_target.processing_generation_id AS new_parent,
                  (SELECT count(*)::int FROM kith.embedding_vectors
                   WHERE id=$1) AS active_vectors,
                  (SELECT count(*)::int FROM kith.embedding_vectors
                   WHERE id=$2) AS retired_vectors
           FROM kith.space_embedding_states s
           JOIN kith.embedding_generations a
             ON a.id=s.active_embedding_generation_id
           JOIN kith.embedding_generations staged ON staged.id=$3
           JOIN kith.embedding_targets old_target
             ON old_target.target_id=$4
           JOIN kith.embedding_targets new_target
             ON new_target.target_id=$5
           WHERE s.space_id=$6`,
          [
            activeVectorId,
            retiredVectorId,
            stagedEmbeddingGenerationId,
            previousChunkId,
            nextPayload.chunk_id,
            f.spaceId,
          ],
        )
      ).rows[0];
      assert.equal(Number(embeddingAfter.eligibility_epoch), 2);
      assert.deepEqual(embeddingAfter.eligible_counts, {
        thought: 0,
        chunk: 1,
        card: 0,
      });
      assert.deepEqual(embeddingAfter.covered_counts, [
        {
          fingerprint: embeddingFingerprint,
          counts: { thought: 0, chunk: 0, card: 0 },
        },
      ]);
      assert.equal(Number(embeddingAfter.active_epoch), 2);
      assert.equal(Number(embeddingAfter.expected_chunk_count), 1);
      assert.equal(Number(embeddingAfter.completed_chunk_count), 0);
      assert.equal(Number(embeddingAfter.staged_epoch), 1);
      assert.equal(embeddingAfter.old_target_state, "retired");
      assert.equal(embeddingAfter.old_covered, null);
      assert.equal(embeddingAfter.new_target_state, "eligible");
      assert.equal(embeddingAfter.new_parent, admitted.processingGenerationId);
      assert.equal(embeddingAfter.active_vectors, 0);
      assert.equal(embeddingAfter.retired_vectors, 1);
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
      const recovery = await call((ctx) =>
        beginWorkerScan(ctx, f.principal, {
          protocolVersion: 1,
          operation: "scan.begin",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          requestId: "identity-recovery-begin",
          watcherId: "watcher-1",
          connectorVersion: "fs-v1",
          mode: "identity_recovery",
          expectedInventoryEpoch: 1,
        }),
      );
      const inventoryRequest = {
        protocolVersion: 1,
        operation: "source.inventoryPage",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        scanId: recovery.scanId,
        requestId: "identity-recovery-page",
        expectedInventoryEpoch: recovery.inventoryEpoch,
        expectedManifestVersion: recovery.manifestVersion,
        paginationOpts: { cursor: null, numItems: 10 },
      };
      const inventory = await call((ctx) =>
        getWorkerInventoryPage(ctx, f.principal, inventoryRequest),
      );
      assert.equal(inventory.page.length, 1);
      assert.equal(inventory.page[0].sourceItemId, admitted.sourceItemId);
      assert.equal(inventory.isDone, true);
      assert.deepEqual(
        await call((ctx) =>
          getWorkerInventoryPage(ctx, f.principal, inventoryRequest),
        ),
        inventory,
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
          getWorkerSourceStatus(ctx, f.principal, {
            ...statusRequest,
            operation: "source.status",
          }),
        ),
        {
          operation: "source.status",
          sourceAccountId: f.sourceAccountId,
          inventoryEpoch: 0,
          completedInventoryEpoch: 0,
          manifestVersion: 0,
          enumeration: { state: "never" },
          processing: { state: "not_assessed" },
          recordCoverage: "not_established",
        },
      );
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

test(
  "archived discovery preflight, failure, and reservation preserve lease fences",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    const fingerprint = "b".repeat(64);
    try {
      await f.client.query(
        `UPDATE kith.source_accounts SET binary_profile_ids = $1, binary_profile_audit_digest = $2,
        binary_profile_enabled_at = $3 WHERE id = $4`,
        [
          JSON.stringify(["pdf_docqa_v1"]),
          fingerprint,
          new Date(NOW),
          f.sourceAccountId,
        ],
      );
      const begun = await call((ctx) =>
        beginWorkerScan(ctx, f.principal, {
          protocolVersion: 1,
          operation: "scan.begin",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          requestId: "binary-begin",
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
          requestId: "binary-page",
          ordinal: 0,
          entries: [
            {
              ...readyEntry(),
              uri: "fs://synthetic/a.pdf",
              docType: "pdf",
              content: {
                status: "ready_binary_v1",
                sha256: HASH_A,
                byteLength: 10,
                mediaType: "application/pdf",
                parserProfileId: "pdf_docqa_v1",
                parserFingerprint: fingerprint,
                extractionConfigurationFingerprint: "c".repeat(64),
                extractorFingerprint: "extractor-v1",
                recordSchemaFingerprint: "schema-v1",
                normalizationFingerprint: "normalization-v1",
                chunkerFingerprint: "chunker-v1",
                correctionRevision: "correction-v1",
              },
            },
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
          requestId: "binary-seal",
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
          requestId: "binary-reconcile",
          expectedInventoryEpoch: 1,
          ordinal: 0,
          maxItems: 10,
        }),
      );
      const work = (
        await f.client.query(
          "SELECT * FROM kith.worker_discovery_work WHERE source_account_id = $1",
          [f.sourceAccountId],
        )
      ).rows[0];
      const identity = {
        sourceItemId: work.source_item_id,
        scanId: begun.scanId,
        observationEpoch: Number(work.observation_epoch),
        processingEpoch: Number(work.processing_epoch),
        contentHash: HASH_A,
        byteLength: 10,
        mediaType: "application/pdf",
        parserProfileId: "pdf_docqa_v1",
        parserFingerprint: fingerprint,
        extractionConfigurationFingerprint: "c".repeat(64),
        extractorFingerprint: "extractor-v1",
        recordSchemaFingerprint: "schema-v1",
        normalizationFingerprint: "normalization-v1",
        chunkerFingerprint: "chunker-v1",
        correctionRevision: "correction-v1",
      };
      const common = {
        protocolVersion: 1,
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        identity,
      };
      const preflight = await call((ctx) =>
        preflightArchivedDiscovery(ctx, f.principal, {
          ...common,
          operation: "discovery.preflightArchived",
          requestId: "binary-preflight",
          archiveIntentDigest: "d".repeat(64),
        }),
      );
      assert.equal(preflight.workId, work.id);
      const reserveRequest = {
        ...common,
        operation: "discovery.reserveArchived",
        requestId: "binary-reserve-1",
      };
      const token = "5".repeat(64);
      const reserved = await call((ctx) =>
        reserveArchivedDiscovery(ctx, f.principal, reserveRequest, token),
      );
      assert.equal(reserved.leaseEpoch, 1);
      assert.deepEqual(
        await call((ctx) =>
          reserveArchivedDiscovery(ctx, f.principal, reserveRequest, token),
        ),
        {
          ...reserved,
          reused: true,
        },
      );
      const failed = await call((ctx) =>
        failArchivedDiscovery(ctx, f.principal, {
          ...common,
          operation: "discovery.failArchived",
          requestId: "binary-fail-1",
          failureCode: "conversion_failed",
        }),
      );
      assert.equal(failed.retryable, true);
      const replacement = await call((ctx) =>
        reserveArchivedDiscovery(
          ctx,
          f.principal,
          { ...reserveRequest, requestId: "binary-reserve-2" },
          "6".repeat(64),
        ),
      );
      assert.equal(replacement.leaseEpoch, 2);
      const terminal = await call((ctx) =>
        failArchivedDiscovery(ctx, f.principal, {
          ...common,
          operation: "discovery.failArchived",
          requestId: "binary-fail-2",
          failureCode: "conversion_failed",
          exhausted: true,
        }),
      );
      assert.equal(terminal.retryable, false);
      assert.equal(
        (
          await f.client.query(
            "SELECT exclusion_reason FROM kith.source_inventory WHERE source_item_id = $1",
            [work.source_item_id],
          )
        ).rows[0].exclusion_reason,
        "parse_failed",
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "provider-original archived admission publishes and assesses through HTTP",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    const parserFingerprint = "1".repeat(64);
    const extractionConfigurationFingerprint = "3".repeat(64);
    const outputHash = "b".repeat(64);
    const parsedTextHash = await sha256Hex("abcdefgh");
    const page = {
      ordinal: 0,
      start: 0,
      end: 8,
      text: "abcdefgh",
      textHash: parsedTextHash,
    };
    const evidence = {
      ordinal: 0,
      pageOrdinal: 0,
      start: 0,
      end: 8,
      quoteHash: parsedTextHash,
      locator: {
        kind: "parser_page_v1",
        pageNumber: 1,
        pageTextHash: parsedTextHash,
      },
    };
    const mappingHash = await digestParsedMappingManifest([page], [evidence]);
    const bundleHash = "e".repeat(64);
    const receipt = (subjectKind, copyRole, offset) => {
      const digit = ((offset % 14) + 1).toString(16);
      return {
        kind: "create",
        subjectKind,
        copyRole,
        clientReceiptId: `01890a5d-ac96-7cc4-bb7e-6f4f5ca5c1${50 + offset}`,
        archiveProfileFingerprint: digit.repeat(64),
        archiveIdentityFingerprint: ((offset + 2) % 15).toString(16).repeat(64),
        recipientFingerprint: ((offset + 3) % 15).toString(16).repeat(64),
        repositoryKeyDomainFingerprint: ((offset + 4) % 15)
          .toString(16)
          .repeat(64),
        storageFailureDomainFingerprint: ((offset + 5) % 15)
          .toString(16)
          .repeat(64),
        archiveObjectId: `01890a5d-ac96-7cc4-bb7e-6f4f5ca5c1${60 + offset}`,
        ciphertextHash: ((offset + 6) % 15).toString(16).repeat(64),
        ciphertextByteLength: subjectKind === "original_bytes" ? 20 : 30,
        createdAt: NOW,
        readbackVerifiedAt: NOW,
      };
    };
    try {
      await f.client.query(
        `UPDATE kith.source_accounts SET binary_profile_ids = $1,
         binary_profile_audit_digest = $2, binary_profile_enabled_at = $3
         WHERE id = $4`,
        [
          JSON.stringify(["pdf_docqa_v1"]),
          parserFingerprint,
          new Date(NOW),
          f.sourceAccountId,
        ],
      );
      const begun = await call((ctx) =>
        beginWorkerScan(ctx, f.principal, {
          protocolVersion: 1,
          operation: "scan.begin",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          requestId: "archive-admit-begin",
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
          requestId: "archive-admit-page",
          ordinal: 0,
          entries: [
            {
              ...readyEntry(),
              uri: "fs://synthetic/admit.pdf",
              docType: "pdf",
              content: {
                status: "ready_binary_v1",
                sha256: HASH_A,
                byteLength: 10,
                mediaType: "application/pdf",
                parserProfileId: "pdf_docqa_v1",
                parserFingerprint,
                extractionConfigurationFingerprint,
                extractorFingerprint: "docling-document-qa:v1",
                recordSchemaFingerprint: "no-records:v1",
                normalizationFingerprint: "docling-pages:v1",
                chunkerFingerprint: "page-aware:v1",
                correctionRevision: "correction:1",
              },
            },
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
          requestId: "archive-admit-seal",
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
          requestId: "archive-admit-reconcile",
          expectedInventoryEpoch: 1,
          ordinal: 0,
          maxItems: 10,
        }),
      );
      const work = (
        await f.client.query(
          "SELECT * FROM kith.worker_discovery_work WHERE source_account_id = $1",
          [f.sourceAccountId],
        )
      ).rows[0];
      const identity = {
        sourceItemId: work.source_item_id,
        scanId: begun.scanId,
        observationEpoch: Number(work.observation_epoch),
        processingEpoch: Number(work.processing_epoch),
        contentHash: HASH_A,
        byteLength: 10,
        mediaType: "application/pdf",
        parserProfileId: "pdf_docqa_v1",
        parserFingerprint,
        extractionConfigurationFingerprint,
        extractorFingerprint: "docling-document-qa:v1",
        recordSchemaFingerprint: "no-records:v1",
        normalizationFingerprint: "docling-pages:v1",
        chunkerFingerprint: "page-aware:v1",
        correctionRevision: "correction:1",
      };
      const common = {
        protocolVersion: 1,
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
      };
      assert.deepEqual(
        await call((ctx) =>
          lookupArchivedAdmission(ctx, f.principal, {
            ...common,
            operation: "discovery.lookupArchivedAdmission",
            requestId: "archive-lookup-empty",
            identity,
            lookup: { mode: "original" },
          }),
        ),
        {
          operation: "discovery.lookupArchivedAdmission",
          mode: "original",
          found: false,
        },
      );
      const leased = await call((ctx) =>
        reserveArchivedDiscovery(
          ctx,
          f.principal,
          {
            ...common,
            operation: "discovery.reserveArchived",
            requestId: "archive-admit-reserve",
            identity,
          },
          "7".repeat(64),
        ),
      );
      const extractionFingerprint = await artifactBoundExtractionFingerprint(
        parserFingerprint,
        outputHash,
        extractionConfigurationFingerprint,
      );
      const admitRequest = {
        ...common,
        operation: "discovery.admitArchived",
        requestId: "archive-admit",
        workId: leased.workId,
        leaseEpoch: leased.leaseEpoch,
        leaseToken: leased.leaseToken,
        parserArtifact: {
          kind: "create",
          clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
          outputHash,
          outputByteLength: 20,
          outputMediaType: "application/vnd.docling+json",
          createdAt: NOW,
        },
        archives: [
          receipt("original_bytes", "primary", 1),
          receipt("parser_output", "primary", 3),
          receipt("parser_output", "independent_backup", 4),
        ],
        providerOriginal: {
          referenceVersion: "provider_original_v1",
          providerKind: "dropbox_v1",
          clientReferenceId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c149",
          sourceContentHash: HASH_A,
          sourceByteLength: 10,
          providerAccountIdHash: "4".repeat(64),
          providerRootDirectoryIdHash: "5".repeat(64),
          providerFileIdHash: "6".repeat(64),
          providerRevision: "rev-synthetic-provider",
          providerContentHash: "7".repeat(64),
          verifiedAt: NOW,
          locatorBundle: {
            bindingId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c148",
            manifestFingerprint: "8".repeat(64),
            recipientFingerprint: "9".repeat(64),
            repositoryKeyDomainFingerprint: "a".repeat(64),
            repositoryId: "b".repeat(64),
            snapshotId: "c".repeat(64),
            objectName: "provider-locator.json.age",
            ciphertextHash: "d".repeat(64),
            ciphertextByteLength: 512,
            readbackVerifiedAt: NOW,
          },
          createdAt: NOW,
        },
        parsedText: {
          extractionFingerprint,
          textHash: parsedTextHash,
          byteLength: 8,
          utf16Length: 8,
          pageCount: 1,
          mappingManifestHash: mappingHash,
          normalizedBundleDigest: bundleHash,
          expectedEvidenceSpanCount: 1,
          expectedDocumentCount: 1,
          expectedChunkCount: 1,
        },
      };
      await assert.rejects(
        call((ctx) =>
          admitArchivedDiscovery(ctx, f.principal, {
            ...admitRequest,
            requestId: "archive-admit-wrong-lease",
            leaseToken: "8".repeat(64),
          }),
        ),
        expectProtocolCode("lease_conflict"),
      );
      assert.equal(
        (
          await f.client.query(
            "SELECT count(*)::int AS count FROM kith.source_revisions WHERE source_item_id = $1",
            [work.source_item_id],
          )
        ).rows[0].count,
        0,
      );
      const admitted = await call((ctx) =>
        admitArchivedDiscovery(ctx, f.principal, admitRequest),
      );
      assert.equal(admitted.reused, false);
      assert.equal(admitted.state, "admitted");
      assert.equal(
        (
          await call((ctx) =>
            admitArchivedDiscovery(ctx, f.principal, admitRequest),
          )
        ).reused,
        true,
      );
      const lookup = await call((ctx) =>
        lookupArchivedAdmission(ctx, f.principal, {
          ...common,
          operation: "discovery.lookupArchivedAdmission",
          requestId: "archive-lookup-processing",
          identity,
          lookup: {
            mode: "processing",
            clientArtifactId: admitRequest.parserArtifact.clientArtifactId,
            parserOutputHash: outputHash,
            parserOutputByteLength: 20,
            parserOutputMediaType: "application/vnd.docling+json",
            parsedText: admitRequest.parsedText,
          },
        }),
      );
      assert.equal(lookup.found, true);
      assert.equal(lookup.mode, "processing");
      assert.equal(
        lookup.processingGenerationId,
        admitted.processingGenerationId,
      );
      assert.equal(lookup.ingestJobId, admitted.ingestJobId);
      assert.equal(
        (
          await f.client.query(
            "SELECT count(*)::int AS count FROM kith.processing_generations WHERE source_item_id = $1",
            [work.source_item_id],
          )
        ).rows[0].count,
        1,
      );

      const reserved = await call((ctx) =>
        reserveParsedJobs(
          ctx,
          f.principal,
          {
            ...common,
            operation: "jobs.reserveParsed",
            requestId: "parsed-reserve",
            maxItems: 1,
            jobId: admitted.ingestJobId,
          },
          ["9".repeat(64)],
        ),
      );
      assert.equal(reserved.targets.length, 1);
      assert.equal(reserved.targets[0].jobId, admitted.ingestJobId);
      assert.equal(
        (
          await call((ctx) =>
            reserveParsedJobs(
              ctx,
              f.principal,
              {
                ...common,
                operation: "jobs.reserveParsed",
                requestId: "parsed-reserve",
                maxItems: 1,
                jobId: admitted.ingestJobId,
              },
              ["9".repeat(64)],
            ),
          )
        ).reused,
        true,
      );
      const initialLease = reserved.targets[0];
      const renewed = await call((ctx) =>
        renewParsedJob(ctx, f.principal, {
          ...common,
          operation: "jobs.renewParsed",
          requestId: "parsed-renew",
          jobId: initialLease.jobId,
          leaseEpoch: initialLease.leaseEpoch,
          leaseToken: initialLease.leaseToken,
        }),
      );
      assert.equal(renewed.reused, false);
      assert.equal(
        (
          await call((ctx) =>
            renewParsedJob(ctx, f.principal, {
              ...common,
              operation: "jobs.renewParsed",
              requestId: "parsed-renew",
              jobId: initialLease.jobId,
              leaseEpoch: initialLease.leaseEpoch,
              leaseToken: initialLease.leaseToken,
            }),
          )
        ).reused,
        true,
      );
      const failRequest = {
        ...common,
        operation: "jobs.failParsed",
        requestId: "parsed-fail",
        jobId: initialLease.jobId,
        leaseEpoch: initialLease.leaseEpoch,
        leaseToken: initialLease.leaseToken,
        failureCode: "worker_interrupted",
      };
      const failed = await call((ctx) =>
        failParsedJob(ctx, f.principal, failRequest),
      );
      assert.equal(failed.state, "failed");
      assert.equal(failed.retryable, true);
      assert.equal(
        (await call((ctx) => failParsedJob(ctx, f.principal, failRequest)))
          .reused,
        true,
      );
      const parsedNow = failed.nextAttemptAt;
      const replacement = await call(
        (ctx) =>
          reserveParsedJobs(
            ctx,
            f.principal,
            {
              ...common,
              operation: "jobs.reserveParsed",
              requestId: "parsed-reserve-after-fail",
              maxItems: 1,
              jobId: admitted.ingestJobId,
            },
            ["a".repeat(64)],
          ),
        parsedNow,
      );
      assert.equal(
        replacement.targets[0].leaseEpoch,
        initialLease.leaseEpoch + 1,
      );
      const lease = replacement.targets[0];
      const parsedCall = (work) => call(work, parsedNow);
      const parsedEndpoint = await listenWorker(t, pool, parsedNow);
      const parsedTransport = new HttpWorkerTransport(
        { endpoint: parsedEndpoint },
        f.credential.rawKey,
      );
      const httpCall = (request) => parsedTransport.call(request);
      const leaseRequest = {
        ...common,
        jobId: lease.jobId,
        leaseEpoch: lease.leaseEpoch,
        leaseToken: lease.leaseToken,
      };
      const beginRequest = {
        ...leaseRequest,
        operation: "jobs.stageParsedBegin",
        requestId: "parsed-begin",
        extractionFingerprint,
        mappingManifestHash: mappingHash,
        normalizedBundleDigest: bundleHash,
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 1,
        expectedChunkCount: 1,
      };
      const stage = await httpCall(beginRequest);
      assert.equal(stage.phase, "pages");
      assert.equal((await httpCall(beginRequest)).reused, true);

      await f.client.query(
        "UPDATE kith.ingest_jobs SET lease_expires_at = $1 WHERE id = $2",
        [new Date(NOW - 1), lease.jobId],
      );
      await assert.rejects(
        parsedCall((ctx) =>
          stageParsedBatch(ctx, f.principal, {
            ...leaseRequest,
            operation: "jobs.stageParsedBatch",
            requestId: "parsed-pages-expired",
            stageId: stage.stageId,
            phase: "pages",
            ordinal: 0,
            rows: [page],
          }),
        ),
        expectProtocolCode("lease_conflict"),
      );
      await f.client.query(
        `UPDATE kith.ingest_jobs SET lease_expires_at = $1,
         worker_lease_owner_credential_id = NULL WHERE id = $2`,
        [new Date(lease.leaseExpiresAt), lease.jobId],
      );
      await assert.rejects(
        parsedCall((ctx) =>
          stageParsedBatch(ctx, f.principal, {
            ...leaseRequest,
            operation: "jobs.stageParsedBatch",
            requestId: "parsed-pages-revoked",
            stageId: stage.stageId,
            phase: "pages",
            ordinal: 0,
            rows: [page],
          }),
        ),
        expectProtocolCode("lease_conflict"),
      );
      await f.client.query(
        `UPDATE kith.ingest_jobs SET worker_lease_owner_credential_id = $1
         WHERE id = $2`,
        [f.principal.credentialId, lease.jobId],
      );

      await f.client.query(
        "CREATE SEQUENCE kith.test_parsed_stage_retry_sequence",
      );
      await f.client.query(`CREATE FUNCTION kith.test_parsed_stage_retry()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('kith.test_parsed_stage_retry_sequence') = 1 THEN
            RAISE EXCEPTION 'synthetic serialization failure' USING ERRCODE = '40001';
          END IF;
          RETURN NEW;
        END $$`);
      await f.client.query(`CREATE TRIGGER test_parsed_stage_retry
        AFTER INSERT ON kith.source_pages FOR EACH ROW
        EXECUTE FUNCTION kith.test_parsed_stage_retry()`);
      const pagesRequest = {
        ...leaseRequest,
        operation: "jobs.stageParsedBatch",
        requestId: "parsed-pages",
        stageId: stage.stageId,
        phase: "pages",
        ordinal: 0,
        rows: [page],
      };
      const pages = await httpCall(pagesRequest);
      assert.equal(pages.phase, "evidence");
      assert.equal(
        (
          await f.client.query(
            "SELECT count(*)::int AS count FROM kith.source_pages WHERE source_text_version_id = $1",
            [admitted.sourceTextVersionId],
          )
        ).rows[0].count,
        1,
      );
      assert.equal(
        Number(
          (
            await f.client.query(
              "SELECT last_value FROM kith.test_parsed_stage_retry_sequence",
            )
          ).rows[0].last_value,
        ),
        2,
      );
      assert.equal(
        (
          await f.client.query(
            `SELECT count(*)::int AS count
             FROM kith.worker_binary_operation_receipts
             WHERE request_id = 'parsed-pages'`,
          )
        ).rows[0].count,
        1,
      );
      assert.equal((await httpCall(pagesRequest)).reused, true);
      await f.client.query(
        "DROP TRIGGER test_parsed_stage_retry ON kith.source_pages",
      );
      await f.client.query("DROP FUNCTION kith.test_parsed_stage_retry()");
      await f.client.query(
        "DROP SEQUENCE kith.test_parsed_stage_retry_sequence",
      );

      const batch = (requestId, phase, rows) =>
        httpCall({
          ...leaseRequest,
          operation: "jobs.stageParsedBatch",
          requestId,
          stageId: stage.stageId,
          phase,
          ordinal: 0,
          rows,
        });
      assert.equal(
        (await batch("parsed-evidence", "evidence", [evidence])).phase,
        "documents",
      );
      assert.equal(
        (
          await batch("parsed-documents", "documents", [
            {
              documentKey: "document-1",
              title: "Synthetic document",
              docType: "pdf",
              capturedAt: NOW,
              evidence: [{ pageOrdinal: 0, evidenceOrdinal: 0 }],
            },
          ])
        ).phase,
        "chunks",
      );
      assert.equal(
        (
          await batch("parsed-chunks", "chunks", [
            {
              documentKey: "document-1",
              ordinal: 0,
              start: 0,
              end: 8,
              text: "abcdefgh",
              evidence: [{ pageOrdinal: 0, evidenceOrdinal: 0 }],
            },
          ])
        ).phase,
        "seal",
      );
      const sealRequest = {
        ...leaseRequest,
        operation: "jobs.stageParsedSeal",
        requestId: "parsed-seal",
        stageId: stage.stageId,
        normalizedBundleDigest: bundleHash,
      };
      const sealed = await httpCall(sealRequest);
      assert.equal(sealed.state, "staged");
      assert.equal((await httpCall(sealRequest)).reused, true);
      const malformedRecord = await parsedCall((ctx) =>
        stageSyntheticWorkerRecord(
          ctx,
          f,
          admitted.processingGenerationId,
          "worker-parsed-record",
        ),
      );
      await f.client.query(
        "UPDATE kith.observations SET value=$1 WHERE id=$2",
        [
          { type: "integer", value: "01", unitCode: "[mi_i]" },
          malformedRecord.observationIds[0],
        ],
      );
      await f.client.query(
        `UPDATE kith.processing_generations
         SET expected_event_count=1,expected_observation_count=1,
             actual_event_count=1,actual_observation_count=1
         WHERE id=$1`,
        [admitted.processingGenerationId],
      );
      const malformedActivateRequest = {
        ...leaseRequest,
        operation: "jobs.activateParsed",
        requestId: "parsed-activate-malformed-record",
      };
      const parsedMalformedStored = (
        await f.client.query(
          `SELECT o.value,g.expected_event_count,g.expected_observation_count,
                  g.actual_event_count,g.actual_observation_count
           FROM kith.observations o
           JOIN kith.processing_generations g ON g.id=o.processing_generation_id
           WHERE o.id=$1`,
          [malformedRecord.observationIds[0]],
        )
      ).rows[0];
      assert.equal(parsedMalformedStored.value.value, "01");
      assert.equal(Number(parsedMalformedStored.expected_event_count), 1);
      assert.equal(Number(parsedMalformedStored.expected_observation_count), 1);
      assert.equal(Number(parsedMalformedStored.actual_event_count), 1);
      assert.equal(Number(parsedMalformedStored.actual_observation_count), 1);
      await assert.rejects(
        parsedCall((ctx) =>
          activateParsedJob(ctx, f.principal, malformedActivateRequest),
        ),
        expectProtocolCode("scan_conflict"),
      );
      const malformedRollback = (
        await f.client.query(
          `SELECT j.state,d.publication_state,i.active_generation_id,
             (SELECT count(*)::int
              FROM kith.worker_binary_operation_receipts
              WHERE request_id=$1) receipt_count,
             (SELECT count(*)::int FROM kith.space_processing_state
              WHERE space_id=j.space_id) processing_state_count,
             (SELECT count(*)::int FROM kith.space_embedding_states
              WHERE space_id=j.space_id) embedding_state_count
           FROM kith.ingest_jobs j
           JOIN kith.documents d ON d.processing_generation_id=j.processing_generation_id
           JOIN kith.source_items i ON i.id=j.source_item_id
           WHERE j.id=$2`,
          [malformedActivateRequest.requestId, admitted.ingestJobId],
        )
      ).rows[0];
      assert.deepEqual(malformedRollback, {
        state: "staged",
        publication_state: "staged",
        active_generation_id: null,
        receipt_count: 0,
        processing_state_count: 0,
        embedding_state_count: 0,
      });
      await removeSyntheticWorkerRecord(
        f.client,
        malformedRecord,
        admitted.processingGenerationId,
      );
      await f.client.query(
        "UPDATE kith.source_accounts SET embed_full_chunks=false WHERE id=$1",
        [f.sourceAccountId],
      );
      await f.client.query(
        "UPDATE kith.source_items SET embed_full_chunks=true WHERE id=$1",
        [admitted.sourceItemId],
      );
      await f.client.query(
        `INSERT INTO kith.space_embedding_states
         (id,space_id,created_at,eligibility_epoch,target_policy,
          eligible_counts,covered_counts,last_audit_at)
         VALUES ($1,$2,$3,0,'cards_and_opted_in_chunks',$4,$5,$3)`,
        [
          newKithId(),
          f.spaceId,
          new Date(parsedNow),
          JSON.stringify({ thought: 0, chunk: 0, card: 0 }),
          JSON.stringify([]),
        ],
      );
      const snapshotClock = parsedNow + 500;
      await f.client.query(
        `INSERT INTO kith.record_query_space_state
         (id, space_id, created_at, visibility_epoch, snapshot_clock, updated_at)
         VALUES ($1,$2,$3,1,$4,$3)`,
        [newKithId(), f.spaceId, new Date(parsedNow), snapshotClock],
      );
      const activateRequest = {
        ...leaseRequest,
        operation: "jobs.activateParsed",
        requestId: "parsed-activate",
      };
      const activated = await httpCall(activateRequest);
      assert.equal(activated.state, "ready");
      assert.equal(activated.activatedAt, snapshotClock + 1);
      assert.equal((await httpCall(activateRequest)).reused, true);
      const published = (
        await f.client.query(
          `SELECT d.publication_state AS document_state,
                  c.publication_state AS chunk_state, j.state AS job_state,
                  j.lease_token, s.activation_epoch, s.activated_at
           FROM kith.documents d
           JOIN kith.chunks c ON c.document_id = d.id
           JOIN kith.ingest_jobs j ON j.id = $1
           JOIN kith.space_processing_state s ON s.space_id = d.space_id
           WHERE d.processing_generation_id = $2`,
          [lease.jobId, admitted.processingGenerationId],
        )
      ).rows[0];
      assert.equal(published.document_state, "active");
      assert.equal(published.chunk_state, "active");
      assert.equal(published.job_state, "ready");
      assert.equal(published.lease_token, null);
      assert.equal(Number(published.activation_epoch), 1);
      assert.equal(published.activated_at.getTime(), snapshotClock + 1);
      const parsedEmbedding = (
        await f.client.query(
          `SELECT s.eligibility_epoch,s.eligible_counts,t.state,
                  t.processing_generation_id
           FROM kith.space_embedding_states s
           JOIN kith.embedding_targets t ON t.space_id=s.space_id
           WHERE s.space_id=$1 AND t.target_kind='chunk'`,
          [f.spaceId],
        )
      ).rows[0];
      assert.equal(Number(parsedEmbedding.eligibility_epoch), 1);
      assert.deepEqual(parsedEmbedding.eligible_counts, {
        thought: 0,
        chunk: 1,
        card: 0,
      });
      assert.equal(parsedEmbedding.state, "eligible");
      assert.equal(
        parsedEmbedding.processing_generation_id,
        admitted.processingGenerationId,
      );

      const accountSnapshot = (
        await f.client.query(
          "SELECT inventory_epoch, manifest_version FROM kith.source_accounts WHERE id=$1",
          [f.sourceAccountId],
        )
      ).rows[0];
      async function assessBinary(requestSuffix) {
        const assessment = await httpCall({
          ...common,
          operation: "processing.assessBegin",
          requestId: `parsed-assess-${requestSuffix}`,
          scanId: begun.scanId,
          expectedInventoryEpoch: Number(accountSnapshot.inventory_epoch),
          expectedManifestVersion: Number(accountSnapshot.manifest_version),
        });
        await httpCall({
          ...common,
          operation: "processing.assessPage",
          requestId: `parsed-assess-${requestSuffix}-items`,
          assessmentId: assessment.assessmentId,
          ordinal: 0,
          maxItems: 1,
        });
        return httpCall({
          ...common,
          operation: "processing.assessPage",
          requestId: `parsed-assess-${requestSuffix}-unresolved`,
          assessmentId: assessment.assessmentId,
          ordinal: 1,
          maxItems: 1,
        });
      }
      const validAssessment = await assessBinary("valid");
      assert.equal(validAssessment.state, "complete");
      assert.equal(validAssessment.counts.items.ready, 1);
      await f.client.query(
        `UPDATE kith.source_parser_artifacts SET parser_fingerprint=$2
         WHERE id=(SELECT parser_artifact_id FROM kith.processing_generations WHERE id=$1)`,
        [admitted.processingGenerationId, "f".repeat(64)],
      );
      const corruptAssessment = await assessBinary("corrupt-artifact");
      assert.equal(corruptAssessment.state, "incomplete");
      assert.equal(corruptAssessment.counts.items.needsReview, 1);
    } finally {
      await pool.end();
    }
  },
);

test(
  "forget operations fence, replay, preserve malformed-history denial, and retry atomically",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const contentHash = await sha256Hex("synthetic original bytes");
    const revision = await provenance.createOrGetArchivedRevision(f.client, {
      spaceId: f.spaceId,
      sourceItemId: (
        await provenance.createOrGetSourceItem(f.client, {
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          externalId: "fixture/forget.pdf",
        })
      ).id,
      contentHash,
      byteLength: 24,
      mediaType: "application/pdf",
      capturedAt: new Date(NOW),
      userId: f.userId,
    });
    const itemId = revision.sourceItemId;
    const receipt = await provenance.createOrGetArchiveReceipt(f.client, {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: itemId,
      sourceRevisionId: revision.id,
      subjectKind: "original_bytes",
      copyRole: "primary",
      clientReceiptId: randomUUID(),
      requestDigest: await sha256Hex("archive request"),
      archiveProfileFingerprint: "1".repeat(64),
      archiveIdentityFingerprint: "2".repeat(64),
      recipientFingerprint: "3".repeat(64),
      repositoryKeyDomainFingerprint: "4".repeat(64),
      storageFailureDomainFingerprint: "5".repeat(64),
      archiveObjectId: randomUUID(),
      plaintextHash: contentHash,
      plaintextByteLength: 24,
      plaintextMediaType: "application/pdf",
      ciphertextHash: "6".repeat(64),
      ciphertextByteLength: 48,
      readbackVerifiedAt: new Date(NOW),
      userId: f.userId,
      actorCredentialId: f.credential.id,
      createdAt: new Date(NOW),
    });
    const declaration = {
      referenceVersion: "provider_original_v1",
      providerKind: "dropbox_v1",
      clientReferenceId: randomUUID(),
      sourceContentHash: contentHash,
      sourceByteLength: 24,
      providerAccountIdHash: "7".repeat(64),
      providerRootDirectoryIdHash: "8".repeat(64),
      providerFileIdHash: "9".repeat(64),
      providerRevision: "rev-synthetic",
      providerContentHash: "a".repeat(64),
      verifiedAt: NOW,
      locatorBundle: {
        bindingId: randomUUID(),
        manifestFingerprint: "b".repeat(64),
        recipientFingerprint: "c".repeat(64),
        repositoryKeyDomainFingerprint: "d".repeat(64),
        repositoryId: "e".repeat(64),
        snapshotId: "f".repeat(64),
        objectName: "synthetic-original.age",
        ciphertextHash: "0".repeat(64),
        ciphertextByteLength: 64,
        readbackVerifiedAt: NOW,
      },
      createdAt: NOW,
    };
    const { reference } = await provenance.createAndBindProviderOriginal(
      f.client,
      {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: itemId,
        sourceRevisionId: revision.id,
        declaration,
        requestDigest: await sha256Hex("provider request"),
        userId: f.userId,
        actorCredentialId: f.credential.id,
        now: new Date(NOW),
      },
    );
    const forgetEpoch = await provenance.beginSourceItemForget(f.client, {
      spaceId: f.spaceId,
      sourceItemId: itemId,
      forgottenAt: new Date(NOW),
      forgottenBy: f.userId,
    });
    const common = {
      protocolVersion: 1,
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: itemId,
      expectedForgetEpoch: forgetEpoch,
    };
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    try {
      const archiveTargets = await call((ctx) =>
        getArchiveForgetTargets(ctx, f.principal, {
          ...common,
          operation: "archive.forgetTargets",
          requestId: "archive-targets",
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      );
      assert.deepEqual(
        archiveTargets.targets.map((value) => value.receiptId),
        [receipt.id],
      );
      const providerTargets = await call((ctx) =>
        getProviderOriginalForgetTargets(ctx, f.principal, {
          ...common,
          operation: "providerOriginal.forgetTargets",
          requestId: "provider-targets",
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      );
      assert.deepEqual(
        providerTargets.targets.map((value) => value.referenceId),
        [reference.id],
      );

      const unauthorized = await makeApiKey(f.ctx(NOW), {
        userId: f.userId,
        capabilities: ["ingest"],
        spaceIds: [f.spaceId],
        sourceAccountIds: [],
      });
      await assert.rejects(
        call((ctx) =>
          getArchiveForgetTargets(
            ctx,
            { userId: f.userId, credentialId: unauthorized.id },
            {
              ...common,
              operation: "archive.forgetTargets",
              requestId: "denied",
              paginationOpts: { cursor: null, numItems: 1 },
            },
          ),
        ),
        expectProtocolCode("not_authorized"),
      );

      const archiveAckRequest = {
        ...common,
        operation: "archive.ackDeletion",
        requestId: "archive-ack",
        deletionId: randomUUID(),
        receiptId: receipt.id,
        objectOutcome: "deleted",
      };
      let attempts = 0;
      const archiveAck = await call(async (ctx) => {
        const result = await acknowledgeArchiveDeletion(
          ctx,
          f.principal,
          archiveAckRequest,
        );
        if (attempts++ === 0)
          throw Object.assign(new Error("forced serialization"), {
            code: "40001",
          });
        return result;
      });
      assert.equal(attempts, 2);
      assert.equal(archiveAck.reused, false);
      assert.equal(
        Number(
          (
            await f.client.query(
              "SELECT count(*) FROM kith.source_artifact_deletion_acks WHERE receipt_id=$1",
              [receipt.id],
            )
          ).rows[0].count,
        ),
        1,
      );
      assert.equal(
        (
          await call((ctx) =>
            acknowledgeArchiveDeletion(ctx, f.principal, archiveAckRequest),
          )
        ).reused,
        true,
      );
      await f.client.query(
        "UPDATE kith.source_artifact_deletion_acks SET ack_version='corrupt' WHERE receipt_id=$1",
        [receipt.id],
      );
      await assert.rejects(
        call((ctx) =>
          acknowledgeArchiveDeletion(ctx, f.principal, archiveAckRequest),
        ),
        expectProtocolCode("request_conflict"),
      );

      const detachRequest = {
        ...common,
        operation: "providerOriginal.ackDetach",
        requestId: "provider-detach",
        detachId: randomUUID(),
        referenceId: reference.id,
        locatorBindingId: reference.locatorBindingId,
        locatorRepositoryId: reference.locatorRepositoryId,
        locatorSnapshotId: reference.locatorSnapshotId,
        locatorObjectName: reference.locatorObjectName,
        referenceOutcome: "detached",
        locatorBundleOutcome: "deleted",
        locatorAbsenceAuthority: "worker_asserted_live_repository_absence",
        retentionDisclosure: "provider_retained_deleted_history_possible",
        providerSourceOutcome: "retained_unchanged",
      };
      assert.equal(
        (
          await call((ctx) =>
            acknowledgeProviderOriginalDetach(ctx, f.principal, detachRequest),
          )
        ).reused,
        false,
      );
      assert.equal(
        (
          await call((ctx) =>
            acknowledgeProviderOriginalDetach(ctx, f.principal, detachRequest),
          )
        ).reused,
        true,
      );
      await assert.rejects(
        call((ctx) =>
          acknowledgeProviderOriginalDetach(ctx, f.principal, {
            ...detachRequest,
            locatorObjectName: "changed.age",
          }),
        ),
        expectProtocolCode("request_conflict"),
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "processing assessment snapshots complete scans, replays pages, and expires stale work",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const { scan } = await makeScan(f, 1);
    await f.client.query(
      `UPDATE kith.worker_source_scans SET state='enumerated', inventory_done=true,
       completed_at=$2, reconcile_manifest_version=0 WHERE id=$1`,
      [scan.id, new Date(NOW)],
    );
    await f.client.query(
      `UPDATE kith.source_accounts SET inventory_epoch=1,
       completed_inventory_epoch=1, last_enumerated_at=$2,
       active_worker_scan_id=NULL WHERE id=$1`,
      [f.sourceAccountId, new Date(NOW)],
    );
    const pool = createKithPool(f.databaseUrl, 2);
    const common = {
      protocolVersion: 1,
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
    };
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    try {
      const beginRequest = {
        ...common,
        operation: "processing.assessBegin",
        requestId: "assess-begin",
        scanId: scan.id,
        expectedInventoryEpoch: 1,
        expectedManifestVersion: 0,
      };
      const begun = await call((ctx) =>
        beginProcessingAssessment(ctx, f.principal, beginRequest),
      );
      assert.equal(begun.state, "running");
      assert.equal(
        (
          await call((ctx) =>
            beginProcessingAssessment(ctx, f.principal, beginRequest),
          )
        ).reused,
        true,
      );
      const page0 = {
        ...common,
        operation: "processing.assessPage",
        requestId: "assess-page-0",
        assessmentId: begun.assessmentId,
        ordinal: 0,
        maxItems: 10,
      };
      assert.equal(
        (
          await call((ctx) =>
            advanceProcessingAssessment(ctx, f.principal, page0),
          )
        ).phase,
        "unresolved_entries",
      );
      const page1 = { ...page0, requestId: "assess-page-1", ordinal: 1 };
      const completed = await call((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, page1),
      );
      assert.equal(completed.state, "complete");
      assert.deepEqual(completed.counts, {
        items: {
          ready: 0,
          pending: 0,
          failed: 0,
          parked: 0,
          needsReview: 0,
          explicitGap: 0,
          unavailable: 0,
          ignoredForgotten: 0,
        },
        unresolvedEntries: { needsReview: 0, ignoredForgotten: 0 },
      });
      assert.equal(
        (
          await call((ctx) =>
            advanceProcessingAssessment(ctx, f.principal, page1),
          )
        ).reused,
        true,
      );

      await f.client.query(
        `UPDATE kith.worker_processing_assessments
         SET counts=counts #- '{items,parked}',
             last_page_result=last_page_result #- '{counts,items,parked}'
         WHERE id=$1`,
        [begun.assessmentId],
      );
      const legacyReplay = await call((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, page1),
      );
      assert.equal(legacyReplay.reused, true);
      assert.equal(legacyReplay.counts.items.parked, 0);

      await f.client.query(
        'UPDATE kith.worker_processing_assessments SET last_page_result=\'{"state":"complete"}\'::jsonb WHERE id=$1',
        [begun.assessmentId],
      );
      const malformedReplay = await call((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, page1),
      );
      assert.equal(malformedReplay.state, "stale");
      assert.equal(malformedReplay.staleReason, "detail_unavailable");

      const { scan: scan2 } = await makeScan(f, 2);
      const corruptItem = await provenance.createOrGetSourceItem(f.client, {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalId: "fixture/corrupt-ready.txt",
        title: "Corrupt ready",
      });
      const corruptRevision = await provenance.createOrGetRevision(f.client, {
        spaceId: f.spaceId,
        sourceItemId: corruptItem.id,
        mediaType: "text/plain;charset=utf-8",
        inlineText: "synthetic",
        capturedAt: new Date(NOW),
        userId: f.userId,
      });
      const generationId = newKithId();
      const jobId = newKithId();
      const entryId = newKithId();
      await f.client.query(
        `INSERT INTO kith.processing_generations
        (id,space_id,created_at,source_account_id,source_item_id,source_revision_id,
         desired_processing_epoch,card_generation,state,activated_at)
        VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,1,false,'ready',$6)`,
        [
          generationId,
          f.spaceId,
          f.sourceAccountId,
          corruptItem.id,
          corruptRevision.id,
          new Date(NOW),
        ],
      );
      await f.client.query(
        `INSERT INTO kith.ingest_jobs
        (id,space_id,created_at,source_account_id,source_item_id,source_revision_id,
         processing_generation_id,admitted_by_user_id,admitted_by_credential_id,
         actor_user_id,actor_credential_id,desired_processing_epoch,state,
         attempts,lease_epoch,lease_token,lease_expires_at,worker_managed,
         worker_lease_owner_credential_id)
        VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$7,$8,1,'ready',1,1,$9,$10,true,$8)`,
        [
          jobId,
          f.spaceId,
          f.sourceAccountId,
          corruptItem.id,
          corruptRevision.id,
          generationId,
          f.userId,
          f.credential.id,
          "f".repeat(64),
          new Date(NOW + 60_000),
        ],
      );
      await f.client.query(
        `UPDATE kith.source_items SET uri='fs://synthetic/corrupt-ready.txt',
        desired_revision_id=$2,desired_processing_epoch=1,active_revision_id=$2,
        active_generation_id=$3,worker_observation_epoch=1,worker_processing_epoch=1,
        worker_content_hash=$4,worker_source_modified_at=$5,worker_profile_id='fs-text:v1',
        worker_last_seen_inventory_epoch=2 WHERE id=$1`,
        [
          corruptItem.id,
          corruptRevision.id,
          generationId,
          corruptRevision.contentHash,
          new Date(NOW),
        ],
      );
      await f.client.query(
        `INSERT INTO kith.worker_scan_entries
        (id,space_id,source_account_id,scan_id,scan_page_id,source_item_id,
         identity_key_hash,external_id_hash,uri_digest,inventory_metadata_digest,
         processing_identity_digest,content_hash,byte_length,content_representation,
         source_modified_at,observation_epoch,processing_epoch,state,observed_at,retire_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'inline_utf8_v1',$14,1,1,'unchanged',$14,$15)`,
        [
          entryId,
          f.spaceId,
          f.sourceAccountId,
          scan2.id,
          (
            await f.client.query(
              "SELECT id FROM kith.worker_scan_pages WHERE scan_id=$1",
              [scan2.id],
            )
          ).rows[0].id,
          corruptItem.id,
          "1".repeat(64),
          corruptItem.externalIdHash,
          "2".repeat(64),
          "3".repeat(64),
          "4".repeat(64),
          corruptRevision.contentHash,
          corruptRevision.byteLength,
          new Date(NOW),
          new Date(NOW + 120_000),
        ],
      );
      await f.client.query(
        "UPDATE kith.worker_scan_pages SET entry_count=1 WHERE scan_id=$1",
        [scan2.id],
      );
      await f.client.query(
        "UPDATE kith.worker_source_scans SET state='enumerated', inventory_done=true, completed_at=$2, reconcile_manifest_version=0, entry_count=1 WHERE id=$1",
        [scan2.id, new Date(NOW)],
      );
      await f.client.query(
        "UPDATE kith.source_accounts SET inventory_epoch=2, completed_inventory_epoch=2, last_enumerated_at=$2, active_worker_scan_id=NULL, active_worker_assessment_id=NULL WHERE id=$1",
        [f.sourceAccountId, new Date(NOW)],
      );
      const begun2 = await call((ctx) =>
        beginProcessingAssessment(ctx, f.principal, {
          ...beginRequest,
          requestId: "assess-corrupt-ready",
          scanId: scan2.id,
          expectedInventoryEpoch: 2,
        }),
      );
      const corrupt0 = await call((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, {
          ...page0,
          requestId: "assess-corrupt-0",
          assessmentId: begun2.assessmentId,
        }),
      );
      const corruptDone = await call((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, {
          ...page1,
          requestId: "assess-corrupt-1",
          assessmentId: begun2.assessmentId,
        }),
      );
      assert.equal(corrupt0.phase, "unresolved_entries");
      assert.equal(corruptDone.state, "incomplete");
      assert.equal(corruptDone.counts.items.unavailable, 1);

      // P2-100a. Why an item is not terminal ready, as counts. The tally rides
      // in the `counts` jsonb and must never reach the protocol response, so it
      // is read back from the row rather than from the result.
      const storedCounts = async (assessmentId) =>
        (
          await f.client.query(
            "SELECT counts, last_page_result FROM kith.worker_processing_assessments WHERE id=$1",
            [assessmentId],
          )
        ).rows[0];
      // A pass with nothing to explain writes no tally at all.
      assert.equal(
        (await storedCounts(begun.assessmentId)).counts.notReadyReasons,
        undefined,
      );
      // This item is one held lease short of terminal, and the `unchanged`
      // entry with no discovery work then makes `classifyItem` throw
      // `scan_conflict`, which the page loop swallows into `unavailable`. The
      // readiness reason wins over the swallowed code: it is the condition that
      // led there.
      const corruptRow = await storedCounts(begun2.assessmentId);
      assert.deepEqual(corruptRow.counts.notReadyReasons, { job_shape: 1 });
      assert.equal(
        corruptRow.last_page_result.counts.notReadyReasons,
        undefined,
      );
      assert.equal(corruptDone.counts.notReadyReasons, undefined);

      const reassess = async (requestId) => {
        await f.client.query(
          "UPDATE kith.source_accounts SET active_worker_assessment_id=NULL WHERE id=$1",
          [f.sourceAccountId],
        );
        const begunNext = await call((ctx) =>
          beginProcessingAssessment(ctx, f.principal, {
            ...beginRequest,
            requestId: `${requestId}-begin`,
            scanId: scan2.id,
            expectedInventoryEpoch: 2,
          }),
        );
        await call((ctx) =>
          advanceProcessingAssessment(ctx, f.principal, {
            ...page0,
            requestId: `${requestId}-0`,
            assessmentId: begunNext.assessmentId,
          }),
        );
        const done = await call((ctx) =>
          advanceProcessingAssessment(ctx, f.principal, {
            ...page1,
            requestId: `${requestId}-1`,
            assessmentId: begunNext.assessmentId,
          }),
        );
        return { done, row: await storedCounts(begunNext.assessmentId) };
      };

      // The same fixture one condition further on: with the lease cleared the
      // job is terminal and the next refusal is the entry's planted digests.
      // The bucket and the pass state are unchanged either way.
      await f.client.query(
        `UPDATE kith.ingest_jobs SET lease_token=NULL, lease_expires_at=NULL,
         worker_lease_owner_credential_id=NULL WHERE id=$1`,
        [jobId],
      );
      const digestPass = await reassess("assess-reason-digest");
      assert.equal(digestPass.done.state, "incomplete");
      assert.equal(digestPass.done.counts.items.unavailable, 1);
      assert.deepEqual(digestPass.row.counts.notReadyReasons, {
        inline_digest_mismatch: 1,
      });

      // The swallowed-protocol-error path with no readiness reason to report:
      // an `ignored_forgotten` entry on an available item refuses before
      // `terminalReady` runs, so the tally names the code that was eaten.
      await f.client.query(
        "UPDATE kith.worker_scan_entries SET state='ignored_forgotten' WHERE id=$1",
        [entryId],
      );
      const swallowed = await reassess("assess-reason-swallowed");
      assert.equal(swallowed.done.state, "incomplete");
      assert.equal(swallowed.done.counts.items.unavailable, 1);
      assert.deepEqual(swallowed.row.counts.notReadyReasons, {
        "protocol_error:scan_conflict": 1,
      });
      await f.client.query(
        "UPDATE kith.worker_scan_entries SET state='unchanged' WHERE id=$1",
        [entryId],
      );
      await f.client.query(
        "UPDATE kith.source_accounts SET active_worker_assessment_id=NULL WHERE id=$1",
        [f.sourceAccountId],
      );

      const { scan: scan3 } = await makeScan(f, 3);
      await f.client.query(
        "UPDATE kith.worker_source_scans SET state='enumerated', inventory_done=true, completed_at=$2, reconcile_manifest_version=0 WHERE id=$1",
        [scan3.id, new Date(NOW)],
      );
      await f.client.query(
        "UPDATE kith.source_accounts SET inventory_epoch=3, completed_inventory_epoch=3, last_enumerated_at=$2, active_worker_scan_id=NULL, active_worker_assessment_id=NULL WHERE id=$1",
        [f.sourceAccountId, new Date(NOW)],
      );
      const begun3 = await call((ctx) =>
        beginProcessingAssessment(ctx, f.principal, {
          ...beginRequest,
          requestId: "assess-expiring",
          scanId: scan3.id,
          expectedInventoryEpoch: 3,
        }),
      );
      const expired = await call(
        (ctx) =>
          advanceProcessingAssessment(ctx, f.principal, {
            ...page0,
            requestId: "assess-expired-page",
            assessmentId: begun3.assessmentId,
          }),
        NOW + 30 * 60 * 1_000,
      );
      assert.equal(expired.state, "stale");
      assert.equal(expired.staleReason, "expired");
    } finally {
      await pool.end();
    }
  },
);

// P2-31a. The wedged live row was `leased` with an expired lease and attempts at
// the cap, which both reserve paths refuse, so the only way back is an operator
// reset of the counter. This proves the reset makes exactly that row reservable
// again, refuses a row a live worker may still hold, and leaves everything else
// alone.
test(
  "resetting exhausted discovery work restores one reserve and keeps the lease fence",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const pool = createKithPool(f.databaseUrl, 2);
    const call = (work, now = NOW) => withWorkerTransaction(pool, work, now);
    const reset = (args) =>
      withKithTransaction(pool, (client) =>
        resetExhaustedDiscoveryWork(client, {
          spaceId: f.spaceId,
          now: NOW,
          ...args,
        }),
      );
    const fingerprint = "b".repeat(64);
    const workRow = async () =>
      (
        await f.client.query(
          "SELECT * FROM kith.worker_discovery_work WHERE source_account_id = $1",
          [f.sourceAccountId],
        )
      ).rows[0];
    try {
      await f.client.query(
        `UPDATE kith.source_accounts SET binary_profile_ids = $1, binary_profile_audit_digest = $2,
        binary_profile_enabled_at = $3 WHERE id = $4`,
        [
          JSON.stringify(["pdf_docqa_v1"]),
          fingerprint,
          new Date(NOW),
          f.sourceAccountId,
        ],
      );
      const begun = await call((ctx) =>
        beginWorkerScan(ctx, f.principal, {
          protocolVersion: 1,
          operation: "scan.begin",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          requestId: "reset-begin",
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
          requestId: "reset-page",
          ordinal: 0,
          entries: [
            {
              ...readyEntry(),
              uri: "fs://synthetic/a.pdf",
              docType: "pdf",
              content: {
                status: "ready_binary_v1",
                sha256: HASH_A,
                byteLength: 10,
                mediaType: "application/pdf",
                parserProfileId: "pdf_docqa_v1",
                parserFingerprint: fingerprint,
                extractionConfigurationFingerprint: "c".repeat(64),
                extractorFingerprint: "extractor-v1",
                recordSchemaFingerprint: "schema-v1",
                normalizationFingerprint: "normalization-v1",
                chunkerFingerprint: "chunker-v1",
                correctionRevision: "correction-v1",
              },
            },
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
          requestId: "reset-seal",
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
          requestId: "reset-reconcile",
          expectedInventoryEpoch: 1,
          ordinal: 0,
          maxItems: 10,
        }),
      );
      const seeded = await workRow();
      const reserveRequest = {
        protocolVersion: 1,
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        operation: "discovery.reserveArchived",
        requestId: "reset-reserve-1",
        identity: {
          sourceItemId: seeded.source_item_id,
          scanId: begun.scanId,
          observationEpoch: Number(seeded.observation_epoch),
          processingEpoch: Number(seeded.processing_epoch),
          contentHash: HASH_A,
          byteLength: 10,
          mediaType: "application/pdf",
          parserProfileId: "pdf_docqa_v1",
          parserFingerprint: fingerprint,
          extractionConfigurationFingerprint: "c".repeat(64),
          extractorFingerprint: "extractor-v1",
          recordSchemaFingerprint: "schema-v1",
          normalizationFingerprint: "normalization-v1",
          chunkerFingerprint: "chunker-v1",
          correctionRevision: "correction-v1",
        },
      };
      // A row under the cap is not the reset's business, whatever state it is
      // in. This one is `queued` with seven attempts spent.
      await f.client.query(
        "UPDATE kith.worker_discovery_work SET attempts = 7 WHERE id = $1",
        [seeded.id],
      );
      assert.deepEqual(await reset({ apply: true }), {
        spaceId: f.spaceId,
        eligible: 0,
        reset: 0,
      });
      assert.equal(Number((await workRow()).attempts), 7);
      // The wedged shape: leased, lease long expired, every attempt spent.
      await f.client.query(
        `UPDATE kith.worker_discovery_work
            SET attempts = 8, state = 'leased', lease_epoch = 4,
                lease_token = $2, lease_owner_credential_id = $3,
                lease_expires_at = $4
          WHERE id = $1`,
        [
          seeded.id,
          "7".repeat(64),
          f.credential.id,
          new Date(NOW - 60 * 60 * 1_000),
        ],
      );
      await assert.rejects(
        () =>
          call((ctx) =>
            reserveArchivedDiscovery(
              ctx,
              f.principal,
              reserveRequest,
              "8".repeat(64),
            ),
          ),
        expectProtocolCode("lease_conflict"),
      );
      // A lease that has not expired may still be held by a live worker.
      await f.client.query(
        "UPDATE kith.worker_discovery_work SET lease_expires_at = $2 WHERE id = $1",
        [seeded.id, new Date(NOW + 60 * 1_000)],
      );
      assert.deepEqual(await reset({ apply: true }), {
        spaceId: f.spaceId,
        eligible: 0,
        reset: 0,
      });
      assert.equal(Number((await workRow()).attempts), 8);
      await f.client.query(
        "UPDATE kith.worker_discovery_work SET lease_expires_at = $2 WHERE id = $1",
        [seeded.id, new Date(NOW - 60 * 60 * 1_000)],
      );
      // A dry run counts the row and writes nothing.
      assert.deepEqual(await reset({ apply: false }), {
        spaceId: f.spaceId,
        eligible: 1,
        reset: 0,
      });
      assert.equal(Number((await workRow()).attempts), 8);
      assert.deepEqual(await reset({ apply: true }), {
        spaceId: f.spaceId,
        eligible: 1,
        reset: 1,
      });
      const after = await workRow();
      assert.equal(after.state, "queued");
      assert.equal(Number(after.attempts), 0);
      assert.equal(after.lease_token, null);
      assert.equal(after.lease_owner_credential_id, null);
      assert.equal(after.lease_expires_at, null);
      assert.equal(after.next_attempt_at, null);
      assert.equal(after.failure_code, null);
      assert.equal(after.retryable, null);
      // The fence only ever rises: the reset left `lease_epoch` alone and the
      // reserve that follows raises it past every lease the row ever issued.
      assert.equal(Number(after.lease_epoch), 4);
      const reserved = await call((ctx) =>
        reserveArchivedDiscovery(
          ctx,
          f.principal,
          reserveRequest,
          "9".repeat(64),
        ),
      );
      assert.equal(reserved.leaseEpoch, 5);
      const leased = await workRow();
      assert.equal(leased.state, "leased");
      assert.equal(Number(leased.attempts), 1);
      // Idempotent: a reset row is below the cap, so a second call is a no-op.
      assert.deepEqual(await reset({ apply: true }), {
        spaceId: f.spaceId,
        eligible: 0,
        reset: 0,
      });
      // Only a row that ran out of attempts without anything having judged the
      // document is in reach. `admitted` succeeded and `obsolete` is superseded
      // history. `failed` at the cap is a settled parse failure and
      // `needs_review` is parked for a review: sweeping either from a command
      // whose dry run reports counts only would retry or step around a judgment
      // no operator got to see.
      for (const state of ["admitted", "obsolete", "failed", "needs_review"]) {
        await f.client.query(
          `UPDATE kith.worker_discovery_work
              SET attempts = 8, state = $2, lease_token = NULL,
                  lease_owner_credential_id = NULL, lease_expires_at = NULL,
                  retryable = $3, failure_code = $4
            WHERE id = $1`,
          [
            seeded.id,
            state,
            state === "failed" ? false : null,
            state === "failed" ? "conversion_failed" : null,
          ],
        );
        assert.deepEqual(
          await reset({ apply: true }),
          { spaceId: f.spaceId, eligible: 0, reset: 0 },
          state,
        );
        const untouched = await workRow();
        assert.equal(untouched.state, state, state);
        assert.equal(Number(untouched.attempts), 8, state);
        if (state === "failed") {
          assert.equal(untouched.retryable, false);
          assert.equal(untouched.failure_code, "conversion_failed");
        }
      }
    } finally {
      await pool.end();
    }
  },
);
