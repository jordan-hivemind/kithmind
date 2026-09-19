import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import test from "node:test";

import pg from "pg";

import {
  KITH_MIGRATIONS,
  PostgresProof,
  ProofError,
  addSyntheticApiKey,
  applyProofMigration,
  grantProofAppRole,
  newSyntheticApiKey,
  revokeSyntheticApiKey,
  seedSyntheticSpace,
  sha256,
} from "../dist/index.js";
import {
  dockerDump,
  dockerRestore,
  startPostgresCluster,
  stopPostgresCluster,
} from "./docker-postgres.mjs";

const { Pool } = pg;

async function createAppRole(owner, suffix) {
  const role = `kith_app_${suffix}`;
  const password = randomBytes(24).toString("hex");
  await owner.query(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  return { role, password };
}

function appConfig(clusterConfig, role) {
  return { ...clusterConfig, user: role.role, password: role.password };
}

function expectCode(code) {
  return (error) => error instanceof ProofError && error.code === code;
}

function encryptDump(plain) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { key, iv, tag: cipher.getAuthTag(), ciphertext };
}

function decryptDump(value) {
  const decipher = createDecipheriv("aes-256-gcm", value.key, value.iv);
  decipher.setAuthTag(value.tag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
}

function waitForClaim(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("crash_worker_claim_timeout")),
      5_000,
    );
    const onMessage = (message) => {
      if (message?.type === "claimed") resolve(message.lease);
      else reject(new Error("unexpected_crash_worker_message"));
      cleanup();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) =>
      finish(new Error(`crash_worker_exited_before_claim:${code}:${signal}`));
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error) => {
      cleanup();
      reject(error);
    };
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(
      () => finish(new Error("crash_worker_exit_timeout")),
      5_000,
    );
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error) => {
      cleanup();
      reject(error);
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function killAndWait(child) {
  const exit = waitForExit(child);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  return exit;
}

test(
  "isolated PostgreSQL proves scoped worker-job leasing and encrypted restore",
  { timeout: 180_000 },
  async (t) => {
    const pools = [];
    const children = [];
    const source = await startPostgresCluster("source");
    let restored;
    t.after(async () => {
      const failures = [];
      for (const child of children) {
        try {
          await killAndWait(child);
        } catch (error) {
          failures.push(error);
        }
      }
      for (const pool of pools.reverse()) {
        try {
          await pool.end();
        } catch (error) {
          failures.push(error);
        }
      }
      for (const cluster of [restored, source].filter(Boolean)) {
        try {
          await stopPostgresCluster(cluster);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "postgres_proof_cleanup_failed");
    });
    restored = await startPostgresCluster("restore");
    assert.equal(source.config.host, "127.0.0.1");
    assert.equal(source.config.database, "postgres");

    const owner = new Pool(source.config);
    pools.push(owner);
    const role = await createAppRole(owner, randomUUID().slice(0, 8));
    await applyProofMigration(owner, role.role);
    await applyProofMigration(owner, role.role);
    const app = new Pool(appConfig(source.config, role));
    pools.push(app);
    const proof = new PostgresProof(app);

    const keyA = newSyntheticApiKey();
    const keyB = newSyntheticApiKey();
    const { spaceId: spaceA, apiKeyId: keyAId } = await seedSyntheticSpace(
      owner,
      "space-a",
      keyA,
    );
    const { spaceId: spaceB } = await seedSyntheticSpace(
      owner,
      "space-b",
      keyB,
    );
    const workerKey2 = newSyntheticApiKey();
    const workerKey3 = newSyntheticApiKey();
    const workerKey4 = newSyntheticApiKey();
    const { apiKeyId: workerKey2Id } = await addSyntheticApiKey(
      owner,
      spaceA,
      workerKey2,
    );
    const { apiKeyId: workerKey3Id } = await addSyntheticApiKey(
      owner,
      spaceA,
      workerKey3,
    );
    await addSyntheticApiKey(owner, spaceA, workerKey4);
    assert.notEqual(spaceA, spaceB);
    const roleState = await app.query(
      "SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser",
    );
    assert.equal(roleState.rows[0].current_user, role.role);
    assert.equal(roleState.rows[0].superuser, false);

    const enqueueInput = {
      requestId: randomUUID(),
      workKind: "synthetic_document_processing",
      workKey: "source/revision/one",
      inputHash: sha256("worker-input-one"),
      maxAttempts: 3,
    };
    const concurrentEnqueue = await Promise.all([
      proof.enqueueWorkerJob(keyA, enqueueInput),
      proof.enqueueWorkerJob(workerKey2, enqueueInput),
    ]);
    assert.deepEqual(concurrentEnqueue[0], concurrentEnqueue[1]);
    await assert.rejects(
      proof.enqueueWorkerJob(keyA, { ...enqueueInput, workKey: "changed" }),
      expectCode("idempotency_conflict"),
    );

    const child = fork(new URL("./crash-worker.mjs", import.meta.url), [], {
      env: {
        POSTGRES_PROOF_CHILD_CONFIG: JSON.stringify(
          appConfig(source.config, role),
        ),
        POSTGRES_PROOF_CHILD_API_KEY: keyA,
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    const abandonedLease = await waitForClaim(child);
    assert.deepEqual(await killAndWait(child), {
      code: null,
      signal: "SIGKILL",
    });
    assert.equal(
      (await proof.getWorkerJob(keyA, abandonedLease.jobId)).state,
      "running",
    );
    assert.deepEqual(
      await Promise.all([
        proof.claimWorkerJob(workerKey2, { leaseSeconds: 2 }),
        proof.claimWorkerJob(workerKey3, { leaseSeconds: 2 }),
      ]),
      [null, null],
    );
    assert.equal(await proof.claimWorkerJob(keyB, { leaseSeconds: 2 }), null);

    await owner.query("SELECT pg_sleep(2.1)");
    const competingClaims = await Promise.all([
      proof.claimWorkerJob(workerKey2, { leaseSeconds: 2 }),
      proof.claimWorkerJob(workerKey3, { leaseSeconds: 2 }),
    ]);
    assert.equal(competingClaims.filter(Boolean).length, 1);
    const reclaimedLease = competingClaims.find(Boolean);
    const reclaimKey = competingClaims[0] ? workerKey2 : workerKey3;
    const reclaimKeyId = competingClaims[0] ? workerKey2Id : workerKey3Id;
    const remainingKey = competingClaims[0] ? workerKey3 : workerKey2;
    const remainingKeyId = competingClaims[0] ? workerKey3Id : workerKey2Id;
    await assert.rejects(
      proof.completeWorkerJob(keyA, {
        jobId: abandonedLease.jobId,
        leaseEpoch: abandonedLease.leaseEpoch,
        leaseToken: abandonedLease.leaseToken,
        outputHash: sha256("stale-output"),
      }),
      expectCode("lease_not_owned"),
    );
    await assert.rejects(
      proof.completeWorkerJob(keyB, {
        jobId: reclaimedLease.jobId,
        leaseEpoch: reclaimedLease.leaseEpoch,
        leaseToken: reclaimedLease.leaseToken,
        outputHash: sha256("foreign-output"),
      }),
      expectCode("lease_not_owned"),
    );
    await assert.rejects(
      proof.completeWorkerJob(remainingKey, {
        jobId: reclaimedLease.jobId,
        leaseEpoch: reclaimedLease.leaseEpoch,
        leaseToken: reclaimedLease.leaseToken,
        outputHash: sha256("same-space-wrong-owner"),
      }),
      expectCode("lease_not_owned"),
    );
    await revokeSyntheticApiKey(owner, reclaimKeyId);
    await assert.rejects(
      proof.completeWorkerJob(reclaimKey, {
        jobId: reclaimedLease.jobId,
        leaseEpoch: reclaimedLease.leaseEpoch,
        leaseToken: reclaimedLease.leaseToken,
        outputHash: sha256("revoked-output"),
      }),
      expectCode("unauthorized"),
    );

    await owner.query("SELECT pg_sleep(2.1)");
    const finalLease = await proof.claimWorkerJob(remainingKey, {
      leaseSeconds: 2,
    });
    assert.equal(finalLease.attemptCount, 3);
    const completionInput = {
      jobId: finalLease.jobId,
      leaseEpoch: finalLease.leaseEpoch,
      leaseToken: finalLease.leaseToken,
      outputHash: sha256("durable-output"),
    };
    const completedJob = await proof.completeWorkerJob(
      remainingKey,
      completionInput,
    );
    assert.equal(completedJob.state, "succeeded");
    assert.equal(completedJob.reused, false);
    assert.deepEqual(
      await proof.completeWorkerJob(remainingKey, completionInput),
      { ...completedJob, reused: true },
    );
    await assert.rejects(
      proof.completeWorkerJob(remainingKey, {
        ...completionInput,
        outputHash: sha256("different-output"),
      }),
      expectCode("lease_not_owned"),
    );
    await revokeSyntheticApiKey(owner, remainingKeyId);
    await assert.rejects(
      proof.completeWorkerJob(remainingKey, completionInput),
      expectCode("unauthorized"),
    );

    const exhausted = await proof.enqueueWorkerJob(keyA, {
      requestId: randomUUID(),
      workKind: "synthetic_document_processing",
      workKey: "source/revision/exhausted",
      inputHash: sha256("exhausted"),
      maxAttempts: 2,
    });
    await proof.claimWorkerJob(workerKey4, { leaseSeconds: 1 });
    await owner.query("SELECT pg_sleep(1.1)");
    await proof.claimWorkerJob(workerKey4, { leaseSeconds: 1 });
    await owner.query("SELECT pg_sleep(1.1)");
    assert.equal(
      await proof.claimWorkerJob(workerKey4, { leaseSeconds: 1 }),
      null,
    );
    const exhaustedState = await proof.getWorkerJob(
      workerKey4,
      exhausted.jobId,
    );
    assert.deepEqual(exhaustedState, {
      jobId: exhausted.jobId,
      workKind: "synthetic_document_processing",
      workKey: "source/revision/exhausted",
      inputHash: sha256("exhausted"),
      state: "failed",
      attemptCount: 2,
      maxAttempts: 2,
      leaseEpoch: 2,
      failureCode: "attempts_exhausted",
    });

    const lockJob = await proof.enqueueWorkerJob(keyA, {
      requestId: randomUUID(),
      workKind: "synthetic_document_processing",
      workKey: "source/revision/lock",
      inputHash: sha256("lock"),
      maxAttempts: 2,
    });
    const lockLease = await proof.claimWorkerJob(workerKey4, {
      leaseSeconds: 1,
    });
    assert.equal(lockLease.jobId, lockJob.jobId);
    const blocker = await owner.connect();
    let blockedCompletion;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM kith.worker_jobs WHERE id=$1 FOR UPDATE",
        [lockJob.jobId],
      );
      blockedCompletion = proof.completeWorkerJob(workerKey4, {
        jobId: lockLease.jobId,
        leaseEpoch: lockLease.leaseEpoch,
        leaseToken: lockLease.leaseToken,
        outputHash: sha256("too-late"),
      });
      await blocker.query("SELECT pg_sleep(1.1)");
      await blocker.query("COMMIT");
    } catch (error) {
      await blocker.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      blocker.release();
    }
    await assert.rejects(blockedCompletion, expectCode("lease_not_owned"));
    const completedState = await proof.getWorkerJob(
      workerKey4,
      completedJob.jobId,
    );

    // keyAId is unused past this point in the retired document-lifecycle
    // scenario; the revoked-key count the backup/restore proof below checks
    // is already exercised by reclaimKeyId and remainingKeyId above.
    void keyAId;

    const beforeState = await owner.query(
      `SELECT
      (SELECT count(*)::int FROM kith.proof_api_keys WHERE revoked_at IS NOT NULL) AS revoked_keys,
      (SELECT count(*)::int FROM kith.worker_jobs WHERE state='succeeded') AS succeeded_jobs,
      (SELECT count(*)::int FROM kith.worker_jobs WHERE state='failed') AS failed_jobs`,
    );
    const dump = await dockerDump(source);
    const encrypted = encryptDump(dump);
    assert.notDeepEqual(
      encrypted.ciphertext.subarray(0, Math.min(64, dump.length)),
      dump.subarray(0, Math.min(64, dump.length)),
    );
    const decrypted = decryptDump(encrypted);
    assert.deepEqual(decrypted, dump);
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    tampered.ciphertext[0] ^= 1;
    assert.throws(() => decryptDump(tampered));
    const restoredConfig = await dockerRestore(restored, decrypted);
    const restoredOwner = new Pool(restoredConfig);
    pools.push(restoredOwner);
    const restoredRole = await createAppRole(
      restoredOwner,
      randomUUID().slice(0, 8),
    );
    await grantProofAppRole(restoredOwner, restoredRole.role);
    const restoredApp = new Pool(appConfig(restoredConfig, restoredRole));
    pools.push(restoredApp);
    const restoredProof = new PostgresProof(restoredApp);
    const afterState = await restoredOwner.query(
      `SELECT
      (SELECT count(*)::int FROM kith.proof_api_keys WHERE revoked_at IS NOT NULL) AS revoked_keys,
      (SELECT count(*)::int FROM kith.worker_jobs WHERE state='succeeded') AS succeeded_jobs,
      (SELECT count(*)::int FROM kith.worker_jobs WHERE state='failed') AS failed_jobs`,
    );
    assert.deepEqual(afterState.rows, beforeState.rows);
    assert.deepEqual(
      await restoredProof.getWorkerJob(workerKey4, completedJob.jobId),
      completedState,
    );
    assert.deepEqual(
      await restoredProof.getWorkerJob(workerKey4, exhausted.jobId),
      exhaustedState,
    );
    await restoredOwner.query("DROP TABLE kith.worker_jobs");
    await restoredOwner.query(
      "ALTER TABLE kith.proof_api_keys DROP CONSTRAINT api_keys_id_space_unique",
    );
    // Undo migration 4 too: every table it created (P2-39b's Convex-mapped
    // tables) declares its id, space_id and reference columns over the
    // kith_id domain, so the domain cannot be dropped while any of them
    // exist. Found by the domain itself rather than a hardcoded table list,
    // so this keeps working unmodified as later migrations add more of them.
    const migratedTables = await restoredOwner.query(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'kith' AND domain_schema = 'kith' AND domain_name = 'kith_id'`,
    );
    if (migratedTables.rows.length > 0) {
      const names = migratedTables.rows
        .map((row) => `kith.${row.table_name}`)
        .join(", ");
      await restoredOwner.query(`DROP TABLE ${names} CASCADE`);
    }
    // Undo migration 23's function. Dropping the tables above took their
    // triggers with them, but a trigger function outlives its triggers, and a
    // rewind that leaves one behind is not at version 1: the replay would
    // reach 23 with an object it is supposed to be creating. Migration 23 uses
    // `CREATE OR REPLACE` so the replay survives either way; this is the other
    // half, so the rewind means what it says.
    await restoredOwner.query("DROP FUNCTION IF EXISTS kith.record_change()");
    // Undo migration 6's renames as well. It gave the plain `spaces` and
    // `api_keys` names to the kith_id-keyed tables (just dropped above) and moved
    // the prototype's uuid-keyed pair to `proof_*`. A database genuinely at
    // version 1 has them under the plain names, and migration 2 alters
    // `kith.api_keys`, so the replay needs them back.
    await restoredOwner.query("ALTER TABLE kith.proof_spaces RENAME TO spaces");
    await restoredOwner.query(
      "ALTER TABLE kith.proof_api_keys RENAME TO api_keys",
    );
    await restoredOwner.query("DROP DOMAIN kith.kith_id");
    await restoredOwner.query(
      "DELETE FROM kith.schema_version WHERE version > 1",
    );
    await applyProofMigration(restoredOwner, restoredRole.role);
    const upgradedVersions = await restoredOwner.query(
      "SELECT version::int AS version FROM kith.schema_version ORDER BY version",
    );
    // Derived from the registered chain rather than written out, so a row that
    // adds a migration does not have to edit this assertion (and cannot conflict
    // with another row over it).
    assert.deepEqual(
      upgradedVersions.rows.map((row) => row.version),
      KITH_MIGRATIONS.map((migration) => migration.version),
    );
    // A gap rather than a rollback: version 1 missing while 2 and 3 are
    // recorded is a history no build can migrate from, and guessing is how a
    // schema gets half-applied twice.
    await restoredOwner.query(
      "DELETE FROM kith.schema_version WHERE version=1",
    );
    await assert.rejects(
      applyProofMigration(restoredOwner, restoredRole.role),
      expectCode("schema_history_invalid"),
    );
  },
);
