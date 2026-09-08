import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import test from "node:test";

import pg from "pg";

import {
  PostgresProof,
  ProofError,
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

function quoteRange(text, quote) {
  const all = Array.from(text);
  const wanted = Array.from(quote);
  for (let start = 0; start <= all.length - wanted.length; start += 1) {
    if (wanted.every((value, offset) => all[start + offset] === value))
      return [start, start + wanted.length];
  }
  throw new Error("quote_not_found");
}

function generationInput(externalId, text, quote, amounts = []) {
  const [startCodepoint, endCodepoint] = quoteRange(text, quote);
  return {
    requestId: randomUUID(),
    documentExternalId: externalId,
    sourceContentHash: sha256(`source:${text}`),
    pages: [{ pageNumber: 1, text, textHash: sha256(text) }],
    evidence: [
      {
        ordinal: 0,
        pageNumber: 1,
        startCodepoint,
        endCodepoint,
        quote,
        quoteHash: sha256(quote),
      },
    ],
    chunks: [{ ordinal: 0, evidenceOrdinal: 0, text }],
    financialAttachments: amounts.map((amount, index) => ({
      evidenceOrdinal: 0,
      label: `synthetic fixture ${index}`,
      amount,
      currency: "USD",
    })),
  };
}

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

test(
  "isolated PostgreSQL proves scoped publication, correction, forgetting and encrypted restore",
  { timeout: 180_000 },
  async (t) => {
    const pools = [];
    const source = await startPostgresCluster("source");
    let restored;
    t.after(async () => {
      const failures = [];
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
    assert.notEqual(spaceA, spaceB);
    const roleState = await app.query(
      "SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser",
    );
    assert.equal(roleState.rows[0].current_user, role.role);
    assert.equal(roleState.rows[0].superuser, false);

    const firstInput = generationInput(
      "statement-a",
      "Opening 😀 balance is 0.1 and adjustment 0.2.",
      "😀 balance",
      ["0.1", "0.2"],
    );
    const staged = await proof.stageGeneration(keyA, firstInput);
    assert.deepEqual(await proof.stageGeneration(keyA, firstInput), staged);
    await assert.rejects(
      proof.stageGeneration(keyA, {
        ...firstInput,
        documentExternalId: "conflict",
      }),
      expectCode("idempotency_conflict"),
    );
    const activationRequest = {
      requestId: randomUUID(),
      generationId: staged.generationId,
    };
    const activated = await proof.activateGeneration(keyA, activationRequest);
    assert.deepEqual(
      await proof.activateGeneration(keyA, activationRequest),
      activated,
    );
    const firstCitation = (await proof.search(keyA, "balance"))[0];
    assert.equal(firstCitation.quote, "😀 balance");
    assert.equal(firstCitation.pageTextHash, firstInput.pages[0].textHash);
    assert.deepEqual(
      await proof.readCitation(keyA, firstCitation.evidenceId),
      firstCitation,
    );
    assert.equal(await proof.syntheticFinancialTotal(keyA, "USD"), "0.3");

    assert.deepEqual(await proof.search(keyB, "balance"), []);
    await assert.rejects(
      proof.readCitation(keyB, firstCitation.evidenceId),
      expectCode("citation_not_found"),
    );

    const correctedInput = generationInput(
      "statement-a",
      "Corrected closing balance is 0.31.",
      "balance",
      ["0.31"],
    );
    const corrected = await proof.stageGeneration(keyA, correctedInput);
    const finalInput = generationInput(
      "statement-a",
      "Final corrected balance is 0.32.",
      "balance",
      ["0.32"],
    );
    const finalRevision = await proof.stageGeneration(keyA, finalInput);
    await assert.rejects(
      proof.activateGeneration(keyA, {
        requestId: randomUUID(),
        generationId: corrected.generationId,
      }),
      expectCode("stale_generation"),
    );
    await proof.activateGeneration(keyA, {
      requestId: randomUUID(),
      generationId: finalRevision.generationId,
    });
    assert.deepEqual(await proof.search(keyA, "Opening"), []);
    assert.deepEqual(
      await proof.readCitation(keyA, firstCitation.evidenceId),
      firstCitation,
    );
    const correctedCitation = (await proof.search(keyA, "Final"))[0];
    assert.equal(correctedCitation.generationId, finalRevision.generationId);
    assert.equal(await proof.syntheticFinancialTotal(keyA, "USD"), "0.32");

    const retainedInput = generationInput(
      "statement-b",
      "Retained citation value is 42.",
      "value is 42",
    );
    const retained = await proof.stageGeneration(keyB, retainedInput);
    await proof.activateGeneration(keyB, {
      requestId: randomUUID(),
      generationId: retained.generationId,
    });
    const retainedCitation = (await proof.search(keyB, "Retained"))[0];

    const crashingProof = new PostgresProof(app, {
      afterDocumentWrite: async () => {
        throw new Error("synthetic_crash");
      },
    });
    await assert.rejects(
      crashingProof.stageGeneration(
        keyA,
        generationInput("rolled-back", "Never committed.", "Never"),
      ),
      /synthetic_crash/,
    );
    const rollbackRows = await owner.query(
      "SELECT count(*)::int AS count FROM kith.documents WHERE external_id='rolled-back'",
    );
    assert.equal(rollbackRows.rows[0].count, 0);

    const forgetRequest = {
      requestId: randomUUID(),
      documentExternalId: "statement-a",
    };
    const forgotten = await proof.forgetDocument(keyA, forgetRequest);
    assert.deepEqual(
      await proof.forgetDocument(keyA, forgetRequest),
      forgotten,
    );
    assert.deepEqual(await proof.search(keyA, "Corrected"), []);
    await assert.rejects(
      proof.readCitation(keyA, correctedCitation.evidenceId),
      expectCode("citation_not_found"),
    );
    await assert.rejects(
      proof.readCitation(keyA, firstCitation.evidenceId),
      expectCode("citation_not_found"),
    );
    await assert.rejects(
      proof.stageGeneration(
        keyA,
        generationInput("statement-a", "Forbidden resurrection.", "Forbidden"),
      ),
      expectCode("document_forgotten"),
    );
    await revokeSyntheticApiKey(owner, keyAId);
    await assert.rejects(
      proof.search(keyA, "anything"),
      expectCode("unauthorized"),
    );

    const beforeState = await owner.query(
      `SELECT
      (SELECT count(*)::int FROM kith.documents) AS documents,
      (SELECT count(*)::int FROM kith.generations) AS generations,
      (SELECT count(*)::int FROM kith.evidence) AS evidence,
      (SELECT count(*)::int FROM kith.api_keys WHERE revoked_at IS NOT NULL) AS revoked_keys`,
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
      (SELECT count(*)::int FROM kith.documents) AS documents,
      (SELECT count(*)::int FROM kith.generations) AS generations,
      (SELECT count(*)::int FROM kith.evidence) AS evidence,
      (SELECT count(*)::int FROM kith.api_keys WHERE revoked_at IS NOT NULL) AS revoked_keys`,
    );
    assert.deepEqual(afterState.rows, beforeState.rows);
    assert.deepEqual(
      await restoredProof.readCitation(keyB, retainedCitation.evidenceId),
      retainedCitation,
    );
    await assert.rejects(
      restoredProof.search(keyA, "anything"),
      expectCode("unauthorized"),
    );
  },
);
