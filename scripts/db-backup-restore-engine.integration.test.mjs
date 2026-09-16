// P2-39k: the dated-backup recipe's postgres engine, database-backed.
//
// scripts/db-backup-postgres.integration.test.mjs already proves the full
// encrypted publish/verify/isolated-restore pipeline end to end, but it
// shells out to pinned PostgreSQL 17 client tools, `age` v1.3.2 and a real
// `restic` binary (KITH_MIGRATE_TEST_DATABASE_URL, KITH_POSTGRES_17_BIN,
// KITH_AGE_BINARY, KITH_RESTIC_BINARY), so it only runs where all of those
// are installed. This suite proves the same row's two newest pieces --
// writer quiescence (`requireNoActiveWriters`) and the sampled cited answer
// (`sampleCitedAnswer`) -- plus the dump/restore/parity shape itself,
// against whatever `psql`/`pg_dump`/`pg_restore` are on PATH and whatever
// server `KITH_STORE_DATABASE_URL` points at. That is the same ambient
// convention `packages/kith-store/test/helpers/pgDatabase.mjs` already
// uses, so a throwaway Postgres with no pinned tool versions is enough to
// run it.
//
// The corpus is a single real document staged and activated through
// `@repo/kith-store`'s own provenance write surface (the same calls
// production ingestion makes), not raw inserts, so its evidence chain and
// citation hash are exactly what production would write and there is
// something real for `sampleCitedAnswer` to find after the restore.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { applyKithSchema, newKithId } from "../packages/kith-store/dist/index.js";
import * as provenance from "../packages/kith-store/dist/provenance/index.js";
import { connect, throwawayDatabase } from "../packages/kith-store/test/helpers/pgDatabase.mjs";
import { applyPgSchema } from "../packages/finance-archive/dist/index.js";

import { requireNoActiveWriters } from "./db-backup-postgres.mjs";
import { capturePostgresParity, parityEquals } from "./db-postgres-parity.mjs";
import { sampleCitedAnswer } from "./db-restore-proof.mjs";

const execute = promisify(execFile);
const url = process.env.KITH_STORE_DATABASE_URL;
const skip = url
  ? false
  : "set KITH_STORE_DATABASE_URL to a throwaway Postgres to run this test";

function opaqueId() {
  return newKithId();
}
function seedSpace() {
  return newKithId();
}
async function seedSourceAccount(client, spaceId) {
  const id = opaqueId();
  await client.query(
    "INSERT INTO kith.source_accounts (id, space_id, created_at) VALUES ($1,$2,transaction_timestamp())",
    [id, spaceId],
  );
  return id;
}
async function seedUser(client) {
  const id = opaqueId();
  await client.query("INSERT INTO kith.users (id, created_at) VALUES ($1,transaction_timestamp())", [id]);
  return id;
}

test(
  "dated-recipe engine: dump both schemas, restore into a second throwaway database, pass the parity checks, refuse an active writer, and answer a sampled cited question",
  { skip },
  async (t) => {
    const sourceDb = await throwawayDatabase(t);
    const destinationDb = await throwawayDatabase(t);
    const client = await connect(sourceDb);
    await applyPgSchema(client, "finance");
    await applyKithSchema(client);

    const spaceId = seedSpace();
    const sourceAccountId = await seedSourceAccount(client, spaceId);
    const userId = await seedUser(client);
    const text = "Invoice number 100 for the roof repair. Total due: 900.00 USD.";
    const quote = "Invoice number 100";
    assert.equal(text.slice(0, quote.length), quote);

    const item = await provenance.createOrGetSourceItem(client, {
      spaceId,
      sourceAccountId,
      externalId: "fixture/backup-restore.txt",
      title: "Backup restore fixture",
    });
    const revision = await provenance.createOrGetRevision(client, {
      spaceId,
      sourceItemId: item.id,
      mediaType: "text/plain",
      inlineText: text,
      capturedAt: new Date("2026-02-01T00:00:00Z"),
      userId,
    });
    const textVersion = await provenance.createOrGetTextVersion(client, {
      spaceId,
      sourceRevisionId: revision.id,
      extractionFingerprint: "extract-v1",
      text,
    });
    const [page] = await provenance.stagePages(client, {
      spaceId,
      sourceTextVersionId: textVersion.id,
      pages: [{ ordinal: 0, start: 0, end: text.length, text }],
    });
    const [span] = await provenance.stageEvidenceSpans(client, {
      spaceId,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      spans: [{ sourcePageId: page.id, ordinal: 0, start: 0, end: quote.length }],
    });
    await provenance.setDesiredSourceRevision(client, {
      spaceId,
      sourceItemId: item.id,
      desiredRevisionId: revision.id,
      expectedDesiredProcessingEpoch: 0,
    });
    const generationId = (
      await client.query(
        `INSERT INTO kith.processing_generations
           (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, source_text_version_id,
            desired_processing_epoch, card_generation, state)
         VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,1,false,'queued') RETURNING id`,
        [opaqueId(), spaceId, sourceAccountId, item.id, revision.id, textVersion.id],
      )
    ).rows[0].id;
    const [document] = await provenance.stageDocuments(client, {
      spaceId,
      processingGenerationId: generationId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      documents: [
        {
          documentKey: "doc-1",
          title: "Roof repair invoice",
          docType: "invoice",
          capturedAt: new Date("2026-02-01T00:00:00Z"),
          evidenceSpanIds: [span.id],
        },
      ],
    });
    await provenance.stageChunks(client, {
      spaceId,
      processingGenerationId: generationId,
      chunks: [{ documentId: document.id, ordinal: 0, text, evidenceSpanIds: [span.id] }],
    });
    await provenance.activateSourceItemGeneration(client, {
      spaceId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      processingGenerationId: generationId,
      expectedDesiredProcessingEpoch: 1,
    });
    // Ingestion's own activation step also flips the generation to "ready"
    // with an activation timestamp; not ported into this harness, so seeded
    // directly, the same way test/parsedStagingAndDocuments.test.mjs does.
    await client.query(
      "UPDATE kith.processing_generations SET state = 'ready', activated_at = transaction_timestamp() WHERE id = $1",
      [generationId],
    );

    // --- Writer quiescence (AGENTS.md's archive-writer quiescence rule) ---
    const runQuery = async (sql) => String((await client.query(sql)).rows[0].count);
    await requireNoActiveWriters(runQuery); // nothing running yet: resolves
    const deferredId = opaqueId();
    await client.query(
      "INSERT INTO kith.deferred_work (id, kind, payload, state) VALUES ($1,'embedding_fill','{}','running')",
      [deferredId],
    );
    await assert.rejects(
      requireNoActiveWriters(runQuery),
      (error) => error.code === "writer_active" && /kith\.deferred_work/.test(error.detail),
    );
    await client.query("UPDATE kith.deferred_work SET state = 'done' WHERE id = $1", [deferredId]);
    await requireNoActiveWriters(runQuery); // clears again once the writer finishes

    // --- Dump both schemas, restore into a second throwaway database ---
    const root = await mkdtemp(join(homedir(), ".kith-backup-restore-integration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dumpPath = join(root, "kithmind.dump");
    await execute("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--schema=finance",
      "--schema=kith",
      // See db-backup-postgres.mjs's dumpBothSchemas: `--schema` alone drops
      // the `vector` extension `kith.embedding_vectors` depends on.
      "--extension=vector",
      sourceDb.url,
      "-f",
      dumpPath,
    ]);
    await execute("pg_restore", [
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "--dbname",
      destinationDb.url,
      dumpPath,
    ]);

    // --- Step 5's parity checks, as this row's engine runs them ---
    const sourceParity = await capturePostgresParity("psql", sourceDb.url, 60_000);
    const destinationParity = await capturePostgresParity("psql", destinationDb.url, 60_000);
    assert.equal(sourceParity.invalidConstraints, 0);
    assert.equal(destinationParity.invalidConstraints, 0);
    assert.ok(sourceParity.tables.length > 70, "expected the full kith+finance table inventory");
    assert.ok(parityEquals(sourceParity, destinationParity));

    // --- One sampled cited question, answered from the restored database ---
    const citation = await sampleCitedAnswer(destinationDb.url, 60_000);
    assert.equal(citation.attempted, true);
    assert.equal(citation.available, true, citation.reason ?? "");
    assert.equal(citation.citationHashMatched, true);
    assert.equal(citation.documentTitle, "Roof repair invoice");
    assert.match(citation.question, /Roof repair invoice/);
  },
);
