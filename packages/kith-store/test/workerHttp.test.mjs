import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal } from "../../pipeline/dist/journal.js";
import {
  initialCheckpoint,
  journalCodec,
  PipelineRunner,
} from "../../pipeline/dist/runner.js";
import { HttpWorkerTransport } from "../../pipeline/dist/transport.js";
import { createKithPool, newKithId } from "../dist/index.js";
import { handlePostgresWorkerRequest } from "../dist/workers/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";
import { listenWorker } from "./helpers/workerHttpServer.mjs";

async function fixture(t) {
  const database = await identityDatabase(t);
  const identity = database.ctx(Date.now());
  const userId = await makeUser(identity, { name: "HTTP worker owner" });
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
     VALUES ($1,$2,transaction_timestamp(),'fs','http-fixture',
             'HTTP fixture',true,0,60000,0,0,0,$3)`,
    [sourceAccountId, spaceId, userId],
  );
  const credential = await makeApiKey(identity, {
    userId,
    capabilities: ["ingest"],
    spaceIds: [spaceId],
    sourceAccountIds: [sourceAccountId],
  });
  const pool = createKithPool(database.databaseUrl, 3);
  pool.on("error", () => {});
  t.after(() => pool.end().catch(() => {}));
  return { ...database, pool, userId, spaceId, sourceAccountId, credential };
}

function pipelineConfig(f, endpoint, root, journalDir) {
  return {
    protocolVersion: 1,
    endpoint,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
    credentialEnv: "SYNTHETIC_WORKER_TOKEN",
    roots: [{ alias: "fixture", path: root }],
    journalDir,
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
  };
}

function base(f, operation) {
  return {
    protocolVersion: 1,
    operation,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  };
}

test(
  "PostgreSQL HTTP adapter preserves auth ordering, denials, replay, and lease fencing",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const endpoint = await listenWorker(t, f.pool);

    const unsupported = await fetch(endpoint, { method: "DELETE" });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "POST");

    const denied = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    assert.equal(denied.status, 401);
    assert.equal(
      denied.headers.get("www-authenticate"),
      'Bearer realm="worker"',
    );
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assert.deepEqual(await denied.json(), {
      error: { code: "not_authenticated", message: "Not authenticated" },
    });

    const wrongMedia = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.credential.rawKey}`,
        "content-type": "text/plain",
      },
      body: "not json",
    });
    assert.equal(wrongMedia.status, 415);
    assert.deepEqual(await wrongMedia.json(), {
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json",
      },
    });

    const malformed = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.credential.rawKey}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: { code: "invalid_json", message: "Invalid JSON body" },
    });

    const oversized = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.credential.rawKey}`,
        "content-type": "application/json",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(512 * 1024 + 1));
          controller.close();
        },
      }),
      duplex: "half",
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), {
      error: {
        code: "payload_too_large",
        message: "JSON body exceeds 524288 bytes",
      },
    });
    assert.equal(
      (
        await f.client.query(
          "SELECT count(*)::int AS count FROM kith.worker_source_scans",
        )
      ).rows[0].count,
      0,
    );

    const transport = new HttpWorkerTransport(
      pipelineConfig(f, endpoint, "/tmp", "/tmp"),
      f.credential.rawKey,
    );
    const status = await transport.call(base(f, "source.status"));
    assert.equal(status.operation, "source.status");
    assert.equal(status.sourceAccountId, f.sourceAccountId);
    assert.equal("error" in status, false);

    const otherUser = await makeUser(f.ctx(Date.now()), {
      name: "Other worker",
    });
    const otherSpace = await makeSpace(f.ctx(Date.now()), {
      createdBy: otherUser,
      memberId: otherUser,
      role: "owner",
    });
    const otherSource = newKithId();
    await f.client.query(
      `INSERT INTO kith.source_accounts
       (id,space_id,created_at,connector,account_id,name,enabled,created_by)
       VALUES ($1,$2,transaction_timestamp(),'fs','other','Other',true,$3)`,
      [otherSource, otherSpace, otherUser],
    );
    const otherCredential = await makeApiKey(f.ctx(Date.now()), {
      userId: otherUser,
      capabilities: ["ingest"],
      spaceIds: [otherSpace],
      sourceAccountIds: [otherSource],
    });
    const wrongSpace = await new HttpWorkerTransport(
      pipelineConfig(f, endpoint, "/tmp", "/tmp"),
      otherCredential.rawKey,
    ).call(base(f, "source.status"));
    assert.deepEqual(wrongSpace, { error: { code: "not_authorized" } });

    const scanBegin = {
      ...base(f, "scan.begin"),
      requestId: "http-scan-begin",
      watcherId: "http-watcher",
      connectorVersion: "http-test-v1",
      mode: "normal",
      expectedInventoryEpoch: 0,
    };
    const begun = await transport.call(scanBegin);
    assert.equal(begun.operation, "scan.begin");
    assert.equal(begun.reused, false);
    assert.equal((await transport.call(scanBegin)).reused, true);

    const text = "HTTP lease fixture";
    await transport.call({
      ...base(f, "scan.appendPage"),
      scanId: begun.scanId,
      requestId: "http-scan-page",
      ordinal: 0,
      entries: [
        {
          externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5d001",
          uri: "fs://http/lease.txt",
          title: "lease.txt",
          docType: "text",
          sourceModifiedAt: Date.now() - 1_000,
          content: {
            status: "ready",
            sha256: createHash("sha256").update(text).digest("hex"),
            byteLength: Buffer.byteLength(text),
          },
        },
      ],
    });
    await transport.call({
      ...base(f, "scan.seal"),
      scanId: begun.scanId,
      requestId: "http-scan-seal",
      expectedPageCount: 1,
      health: { status: "healthy" },
    });
    await transport.call({
      ...base(f, "scan.reconcile"),
      scanId: begun.scanId,
      requestId: "http-scan-reconcile",
      expectedInventoryEpoch: 1,
      ordinal: 0,
      maxItems: 10,
    });
    const reserveRequest = {
      ...base(f, "discovery.reserve"),
      requestId: "http-discovery-reserve",
      maxItems: 1,
    };
    const reserved = await transport.call(reserveRequest);
    assert.equal(reserved.targets.length, 1);
    assert.equal((await transport.call(reserveRequest)).reused, true);
    const target = reserved.targets[0];
    const leaseDenied = await transport.call({
      ...base(f, "discovery.admitUtf8"),
      requestId: "http-admit-wrong-lease",
      workId: target.workId,
      leaseEpoch: target.leaseEpoch,
      leaseToken: "0".repeat(64),
      text,
    });
    assert.deepEqual(leaseDenied, { error: { code: "lease_conflict" } });

    const slowBody = JSON.stringify({
      ...base(f, "discovery.admitUtf8"),
      requestId: "http-admit-expired-while-reading",
      workId: target.workId,
      leaseEpoch: target.leaseEpoch,
      leaseToken: target.leaseToken,
      text,
    });
    let clockReads = 0;
    const expiredWhileReading = await handlePostgresWorkerRequest(
      f.pool,
      new Request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.credential.rawKey}`,
          "content-type": "application/json",
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(slowBody.slice(0, 8)));
            controller.enqueue(new TextEncoder().encode(slowBody.slice(8)));
            controller.close();
          },
        }),
        duplex: "half",
      }),
      () =>
        clockReads++ === 0
          ? target.leaseExpiresAt - 1
          : target.leaseExpiresAt + 1,
    );
    assert.equal(expiredWhileReading.status, 409);
    assert.deepEqual(await expiredWhileReading.json(), {
      error: {
        code: "lease_conflict",
        message: "Work lease is no longer current",
      },
    });
    assert.equal(
      (
        await f.client.query(
          "SELECT count(*)::int AS count FROM kith.source_revisions",
        )
      ).rows[0].count,
      0,
    );

    const revocable = await makeApiKey(f.ctx(Date.now()), {
      userId: f.userId,
      capabilities: ["ingest"],
      spaceIds: [f.spaceId],
      sourceAccountIds: [f.sourceAccountId],
    });
    const revokedTransport = new HttpWorkerTransport(
      pipelineConfig(f, endpoint, "/tmp", "/tmp"),
      revocable.rawKey,
    );
    assert.equal(
      (await revokedTransport.call(base(f, "source.status"))).operation,
      "source.status",
    );
    await f.client.query("DELETE FROM kith.api_keys WHERE id=$1", [
      revocable.id,
    ]);
    assert.deepEqual(await revokedTransport.call(base(f, "source.status")), {
      error: { code: "not_authenticated" },
    });
  },
);

test(
  "filesystem pipeline completes one inline publication through the PostgreSQL HTTP adapter",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const endpoint = await listenWorker(t, f.pool);
    const directory = await mkdtemp(join(tmpdir(), "kith-worker-http-e2e-"));
    const root = join(directory, "root");
    const journalDir = join(directory, "journal");
    await mkdir(root, { mode: 0o700 });
    await mkdir(journalDir, { mode: 0o700 });
    await writeFile(join(root, "note.txt"), "synthetic pipeline text\n", {
      mode: 0o600,
    });
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = pipelineConfig(f, endpoint, root, journalDir);
    const journal = await Journal.open({
      directory: journalDir,
      binding: {
        protocolVersion: 1,
        endpoint,
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        configFingerprint: "b".repeat(64),
        credentialSlot: "SYNTHETIC_WORKER_TOKEN",
      },
      credential: f.credential.rawKey,
      initialCheckpoint,
      codec: journalCodec,
    });
    try {
      const result = await new PipelineRunner(
        config,
        journal,
        new HttpWorkerTransport(config, f.credential.rawKey),
      ).run();
      assert.deepEqual(result, { state: "complete", scanned: 1, published: 1 });
      const published = await f.client.query(
        `SELECT i.active_generation_id, j.state, d.publication_state
         FROM kith.source_items i
         JOIN kith.ingest_jobs j ON j.processing_generation_id=i.active_generation_id
         JOIN kith.documents d ON d.processing_generation_id=i.active_generation_id
         WHERE i.source_account_id=$1`,
        [f.sourceAccountId],
      );
      assert.equal(published.rowCount, 1);
      assert.equal(published.rows[0].state, "ready");
      assert.equal(published.rows[0].publication_state, "active");
    } finally {
      await journal.close();
    }
  },
);
