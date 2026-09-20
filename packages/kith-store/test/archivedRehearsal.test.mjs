// P2-104d. The rehearsal: what the owner's worker is about to do, done here
// first, against real handlers and a real database.
//
// Publish N documents under one parser runtime, switch the runtime, and drive
// passes until the world stops changing. Two switches matter and they are not
// the same:
//
//   profile B1   the same parser fingerprint, a different extraction
//                configuration. The parser re-runs and produces the same raw
//                conversion, because the extraction configuration maps that
//                conversion rather than changing it. The already-archived
//                parser output and its artifact must be reused.
//   profile B2   a different parser fingerprint. A different conversion, a new
//                artifact, an ordinary archive and create.
//
// Two of the live oddities are here: a work row left leased with an expired
// lease at one attempt, and never-activated processing debris in the local
// catalog. The third, a second activated row naming a revision the original
// does not, is the `original_receipt_revision_conflict` park, which is P2-31f's
// and has its own test; fabricating it here would prove that test twice.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createKithPool, newKithId } from "../dist/index.js";
import { sweepUnreferencedExtractionSpans } from "../dist/extraction/index.js";
import {
  addRehearsalRoot,
  installFakeDropbox,
  rehearsalConfig,
  rehearsalPass,
  rehearsalProfile,
  rehearsalUntilSettled,
  rehearsalWorkspace,
  withRehearsalCatalog,
} from "./helpers/archivedRehearsal.mjs";
import {
  identityDatabase,
  makeApiKey,
  makeSpace,
  makeUser,
  skip as databaseSkip,
} from "./helpers/identityFixture.mjs";
import { inProcessWorkerTransport } from "./helpers/inProcessWorker.mjs";

// Opt-in, for two reasons and no others.
//
// The archived lane requires the macOS process boundary (`requiredPlatform` in
// the pipeline's parser process module), so this can only run where the lane
// runs: not in CI, which is Linux.
//
// And it drives real `age` and `restic` child processes for every copy of
// every document. On a fully loaded `pnpm test:once` -- every package's suite
// at once -- an archive command occasionally fails to come up and the pass
// reports `digest_mismatch`, which is the command's own refusal and nothing to
// do with what is under test. A rehearsal is run deliberately before a risky
// change, so it asks to be run:
//
//   KITH_REHEARSAL=1 KITH_STORE_DATABASE_URL=... \
//     node --test packages/kith-store/test/archivedRehearsal.test.mjs
const skip =
  databaseSkip ||
  (process.platform !== "darwin"
    ? "the archived lane requires the macOS process boundary"
    : process.env.KITH_REHEARSAL === "1"
      ? false
      : "set KITH_REHEARSAL=1 to run the archived-lane rehearsal");

const DOCUMENTS = 4;

async function fixture(t) {
  const database = await identityDatabase(t);
  const identity = database.ctx(Date.now());
  const userId = await makeUser(identity, { name: "Rehearsal owner" });
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
        completed_inventory_epoch, manifest_version, created_by,
        binary_profile_ids, binary_profile_audit_digest,
        binary_profile_enabled_at)
     VALUES ($1,$2,transaction_timestamp(),'fs','rehearsal-fs',
             'Rehearsal fixture',true,0,60000,0,0,0,$3,$4,$5,
             transaction_timestamp())`,
    [
      sourceAccountId,
      spaceId,
      userId,
      JSON.stringify(["pdf_docqa_v1"]),
      "a".repeat(64),
    ],
  );
  const credential = await makeApiKey(identity, {
    userId,
    capabilities: ["ingest"],
    spaceIds: [spaceId],
    sourceAccountIds: [sourceAccountId],
  });
  const pool = createKithPool(database.databaseUrl, 4);
  pool.on("error", () => {});
  t.after(() => pool.end().catch(() => {}));
  return { ...database, pool, userId, spaceId, sourceAccountId, credential };
}

async function activeGenerations(f) {
  const { rows } = await f.client.query(
    `SELECT i.id AS item_id, i.active_generation_id, g.extraction_fingerprint,
            g.parser_artifact_id, g.parser_primary_receipt_id,
            g.parser_backup_receipt_id, g.state, d.publication_state
       FROM kith.source_items i
       JOIN kith.processing_generations g ON g.id = i.active_generation_id
       LEFT JOIN kith.documents d ON d.processing_generation_id = g.id
      WHERE i.source_account_id = $1
      ORDER BY i.id`,
    [f.sourceAccountId],
  );
  return rows;
}

/** Every generation, with the publication state of the document it produced. */
async function generations(f) {
  const { rows } = await f.client.query(
    `SELECT g.id, g.state, g.extraction_fingerprint,
            d.publication_state,
            (i.active_generation_id = g.id) AS active
       FROM kith.processing_generations g
       JOIN kith.source_items i ON i.id = g.source_item_id
       LEFT JOIN kith.documents d ON d.processing_generation_id = g.id
      WHERE g.source_account_id = $1
      ORDER BY g.created_at, g.id`,
    [f.sourceAccountId],
  );
  return rows;
}

async function workRows(f) {
  const { rows } = await f.client.query(
    `SELECT id, state, attempts FROM kith.worker_discovery_work
      WHERE source_account_id = $1 ORDER BY created_at, id`,
    [f.sourceAccountId],
  );
  return rows;
}

async function assessment(f) {
  const { rows } = await f.client.query(
    `SELECT state FROM kith.worker_processing_assessments
      WHERE source_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [f.sourceAccountId],
  );
  return rows[0]?.state;
}

/**
 * The live shape: one original carrying never-activated processing rows left
 * by earlier configurations. The pass has to walk past all of them, create its
 * own row, and keep theirs.
 */
function debrisId(slot, index) {
  return `00000000-0000-4000-800${slot}-${String(index).padStart(12, "0")}`;
}

async function seedProcessingDebris(config, credential, count = 6) {
  return await withRehearsalCatalog(config, credential, async (catalog) => {
    const template = catalog.listProcessings()[0];
    assert.ok(template, "a processing row to model the debris on");
    const ids = [];
    for (let index = 1; index <= count; index += 1) {
      const processingCatalogId = debrisId(0, index);
      await catalog.createProcessingIntent({
        ...template,
        processingCatalogId,
        fingerprints: {
          ...template.fingerprints,
          correctionFingerprint: String(index).repeat(64).slice(0, 64),
        },
        parserIntent: {
          ...template.parserIntent,
          outputId: debrisId(1, index),
          parserArtifactClientId: debrisId(2, index),
        },
        captureIntent: {
          ...template.captureIntent,
          captureId: debrisId(7, index),
        },
        spoolIntent: { ...template.spoolIntent, spoolId: debrisId(8, index) },
        copies: {
          primary: {
            ...template.copies.primary,
            clientReceiptId: debrisId(3, index),
            archiveObjectId: debrisId(4, index),
            objectName: `${debrisId(4, index)}.age`,
          },
          independent_backup: {
            ...template.copies.independent_backup,
            clientReceiptId: debrisId(5, index),
            archiveObjectId: debrisId(6, index),
            objectName: `${debrisId(6, index)}.age`,
          },
        },
      });
      ids.push(processingCatalogId);
    }
    return ids;
  });
}

/**
 * The live state, reproduced rather than asserted into being. One pass is let
 * through the scan -- which is what re-queues the documents under the changed
 * processing identity -- and then fails, exactly as the owner's worker did.
 * One of the re-queued rows is then left leased with an expired lease and an
 * attempt spent, which is the row that took every later pass down with it.
 */
async function strandOneWorkRow(f, options, transport) {
  await assert.rejects(
    rehearsalPass({
      ...options,
      transport: {
        async call(request) {
          if (request.operation === "discovery.preflightArchived") {
            throw new Error("rehearsal interruption");
          }
          return await transport.call(request);
        },
      },
    }),
    /rehearsal interruption/,
  );
  return await expireOneLease(f);
}

async function expireOneLease(f) {
  const { rows } = await f.client.query(
    `SELECT id FROM kith.worker_discovery_work
      WHERE source_account_id = $1 AND state = 'queued'
      ORDER BY created_at, id LIMIT 1`,
    [f.sourceAccountId],
  );
  assert.ok(rows[0], "a re-queued work row to strand");
  await f.client.query(
    `UPDATE kith.worker_discovery_work
        SET state = 'leased', attempts = 1, lease_epoch = 1,
            lease_token = $2, lease_owner_credential_id = $3,
            lease_expires_at = transaction_timestamp() - interval '1 hour'
      WHERE id = $1`,
    [rows[0].id, randomBytes(32).toString("hex"), f.credential.id],
  );
  return rows[0].id;
}

test(
  "a changed extraction configuration re-processes every document without re-archiving its parser output",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const transport = inProcessWorkerTransport(f.pool, {
      userId: f.userId,
      credentialId: f.credential.id,
    });
    const workspace = await rehearsalWorkspace(t, { documents: DOCUMENTS });
    const profileA = rehearsalProfile({ mapping: "docling_utf16_pages_v2" });
    const pass = (runtime) => ({
      config: rehearsalConfig({
        endpoint: "http://127.0.0.1:0/api/worker",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        workspace,
        runtime,
      }),
      credential: f.credential.rawKey,
      transport,
      runtime,
    });

    const first = await rehearsalUntilSettled(pass(profileA));
    assert.equal(
      first.at(-1).state,
      "complete",
      `profile A settled: ${JSON.stringify(first)}`,
    );
    const published = await activeGenerations(f);
    assert.equal(published.length, DOCUMENTS);
    const artifactsA = published.map((row) => row.parser_artifact_id);
    const receiptsA = published.map((row) => row.parser_primary_receipt_id);
    for (const row of published) {
      assert.equal(row.state, "ready");
      assert.equal(row.publication_state, "active");
    }

    const debris = await seedProcessingDebris(
      pass(profileA).config,
      f.credential.rawKey,
    );
    const profileB = rehearsalProfile({ mapping: "docling_utf16_pages_v3" });
    assert.equal(
      profileB.profile.parserFingerprint,
      profileA.profile.parserFingerprint,
      "the parser did not change",
    );
    assert.notEqual(
      profileB.profile.extractionConfigurationFingerprint,
      profileA.profile.extractionConfigurationFingerprint,
      "the extraction configuration did",
    );

    await strandOneWorkRow(f, pass(profileB), transport);

    const second = await rehearsalUntilSettled(pass(profileB));
    assert.equal(
      second.at(-1).state,
      "complete",
      `profile B settled: ${JSON.stringify(second)}`,
    );
    assert.ok(second.length <= 4, `bounded passes: ${second.length}`);

    const reprocessed = await activeGenerations(f);
    assert.equal(reprocessed.length, DOCUMENTS);
    for (const row of reprocessed) {
      assert.equal(row.state, "ready");
      assert.equal(row.publication_state, "active");
    }
    assert.deepEqual(
      reprocessed.map((row) => row.parser_artifact_id),
      artifactsA,
      "the parser artifact was reused, not created again",
    );
    assert.deepEqual(
      reprocessed.map((row) => row.parser_primary_receipt_id),
      receiptsA,
      "the archived parser output was reused, not archived again",
    );
    const extractionA = new Set(published.map((r) => r.extraction_fingerprint));
    for (const row of reprocessed) {
      assert.ok(
        !extractionA.has(row.extraction_fingerprint),
        "a new processing generation, not the old one",
      );
    }

    const all = await generations(f);
    assert.equal(
      all.length,
      DOCUMENTS * 2,
      `the old generations were retired, not deleted: ${JSON.stringify(all)}`,
    );
    const retired = all.filter((row) => !row.active);
    assert.equal(retired.length, DOCUMENTS);
    for (const row of retired) {
      assert.ok(
        extractionA.has(row.extraction_fingerprint),
        "the retired generations are the old ones",
      );
      assert.notEqual(
        row.publication_state,
        "active",
        `a retired generation is not still published: ${JSON.stringify(row)}`,
      );
    }
    for (const row of await workRows(f)) {
      assert.ok(
        ["admitted", "obsolete"].includes(row.state),
        `no work row is stuck: ${JSON.stringify(row)}`,
      );
      assert.ok(row.attempts <= 2, `attempts stayed small: ${row.attempts}`);
    }
    assert.equal(await assessment(f), "complete");

    // ADM-5i. Typed extraction writes its own event version, observations and
    // evidence spans onto the activated parsed generation. Until this branch
    // the seal counted every one of them against the manifest, so from the
    // first backfill the assessment reported `payload_verify_error:id_sets`
    // for every extracted document and the watcher never ended a pass
    // `complete` again -- with the documents themselves still perfectly
    // readable, because reads never call the verifier.
    const target = (await activeGenerations(f))[0];
    assert.ok(target, "an activated generation to extract from");
    const generationId = target.active_generation_id;
    const targetText = (
      await f.client.query(
        `SELECT source_text_version_id, source_revision_id, source_item_id,
                source_account_id, space_id
           FROM kith.processing_generations WHERE id = $1`,
        [generationId],
      )
    ).rows[0];
    const targetPage = (
      await f.client.query(
        `SELECT id FROM kith.source_pages
          WHERE source_text_version_id = $1 ORDER BY ordinal LIMIT 1`,
        [targetText.source_text_version_id],
      )
    ).rows[0];
    // Hand-written rather than run through the extraction job, because that
    // needs a model and a seeded document type and this test is about the
    // seal. The rows below mirror `findOrCreateSpan` and `store` in
    // `src/extraction/model.ts` -- if the locator shape there changes, this
    // fixture has to change with it.
    const extractionSpan = newKithId();
    await f.client.query(
      `INSERT INTO kith.evidence_spans
         (id, space_id, created_at, source_revision_id, source_text_version_id,
          source_page_id, ordinal, "start", "end", quote_hash, locator)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,99,0,1,$6,
               jsonb_build_object('kind', 'extraction_v1'))`,
      [
        extractionSpan,
        targetText.space_id,
        targetText.source_revision_id,
        targetText.source_text_version_id,
        targetPage.id,
        "e".repeat(64),
      ],
    );
    const extractionEvent = newKithId();
    const extractionVersion = newKithId();
    await f.client.query(
      `INSERT INTO kith.events
         (id, space_id, created_at, source_account_id, source_item_id,
          event_key, created_by)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,'document_statement:v1',$5)`,
      [
        extractionEvent,
        targetText.space_id,
        targetText.source_account_id,
        targetText.source_item_id,
        f.userId,
      ],
    );
    const extractionEntity = newKithId();
    await f.client.query(
      `INSERT INTO kith.entities
         (id, space_id, created_at, user_id, key, kind, canonical_name,
          normalized_name, aliases, normalized_aliases)
       VALUES ($1,$2,transaction_timestamp(),$3,'other:document','other',
               'Document','document','[]'::jsonb,'[]'::jsonb)`,
      [extractionEntity, targetText.space_id, f.userId],
    );
    const chain = [
      targetText.space_id,
      targetText.source_account_id,
      targetText.source_item_id,
      targetText.source_revision_id,
      targetText.source_text_version_id,
      generationId,
    ];
    await f.client.query(
      `INSERT INTO kith.event_versions
         (id,space_id,created_at,source_account_id,source_item_id,
          source_revision_id,source_text_version_id,processing_generation_id,
          event_id,entity_id,event_type,schema_version,occurrence,
          occurrence_date,occurrence_instant,occurrence_sort_key,
          field_evidence,doc_type_patch,user_id)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,
               'document_statement',1,'{"precision":"unknown"}'::jsonb,
               NULL,NULL,NULL,$10,NULL,$11)`,
      [
        extractionVersion,
        ...chain,
        extractionEvent,
        extractionEntity,
        JSON.stringify({
          occurrence: [extractionSpan],
          entity: [extractionSpan],
          eventType: [extractionSpan],
        }),
        f.userId,
      ],
    );
    await f.client.query(
      `INSERT INTO kith.observations
         (id,space_id,created_at,source_account_id,source_item_id,
          source_revision_id,source_text_version_id,processing_generation_id,
          event_id,event_version_id,entity_id,event_type,occurrence,
          occurrence_date,occurrence_instant,occurrence_sort_key,
          observation_key,observation_type,schema_version,value,value_evidence,
          bound_entity_id,user_id)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,
               'document_statement','{"precision":"unknown"}'::jsonb,
               NULL,NULL,NULL,'vendor','vendor',1,
               '{"type":"text","value":"Synthetic"}'::jsonb,$11,NULL,$12)`,
      [
        newKithId(),
        ...chain,
        extractionEvent,
        extractionVersion,
        extractionEntity,
        JSON.stringify([extractionSpan]),
        f.userId,
      ],
    );

    // The next pass must still end complete: extraction is a derived layer
    // and the seal is over the parsed payload.
    await rehearsalUntilSettled(pass(profileB));
    assert.equal(await assessment(f), "complete");
    // And no item is held back by the seal. `notReadyReasons` lives inside
    // the assessment's `counts` column; on the owner's machine it read
    // `{"payload_verify_error:id_sets": 10}` for every watcher-ingested item.
    const counts = (
      await f.client.query(
        `SELECT counts FROM kith.worker_processing_assessments
          WHERE source_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [f.sourceAccountId],
      )
    ).rows[0]?.counts;
    assert.deepEqual(counts?.notReadyReasons ?? {}, {});
    assert.equal(counts?.unavailable ?? 0, 0);

    // ADM-5j. Re-extraction, which is what actually happens on the owner's
    // machine: the model reads the document again and one statement that
    // survived last time now fails its gate. The previous run's span for it
    // is referenced by nothing after the replace, and before this branch it
    // stayed for ever -- one more unreferenced span per re-extraction per
    // document, which is how 68 of 91 ready generations came to carry one.
    //
    // Still hand-written for the reason above, and still mirroring `store`
    // in `src/extraction/model.ts`: observations replaced, then the sweep, in
    // one transaction.
    const secondSpan = newKithId();
    await f.client.query(
      `INSERT INTO kith.evidence_spans
         (id, space_id, created_at, source_revision_id, source_text_version_id,
          source_page_id, ordinal, "start", "end", quote_hash, locator)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,98,0,1,$6,
               jsonb_build_object('kind', 'extraction_v1'))`,
      [
        secondSpan,
        targetText.space_id,
        targetText.source_revision_id,
        targetText.source_text_version_id,
        targetPage.id,
        "f".repeat(64),
      ],
    );
    await f.client.query(
      `INSERT INTO kith.observations
         (id,space_id,created_at,source_account_id,source_item_id,
          source_revision_id,source_text_version_id,processing_generation_id,
          event_id,event_version_id,entity_id,event_type,occurrence,
          occurrence_date,occurrence_instant,occurrence_sort_key,
          observation_key,observation_type,schema_version,value,value_evidence,
          bound_entity_id,user_id)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,
               'document_statement','{"precision":"unknown"}'::jsonb,
               NULL,NULL,NULL,'total','total',1,
               '{"type":"money","amount":"1.00","currency":"USD"}'::jsonb,
               $11,NULL,$12)`,
      [
        newKithId(),
        ...chain,
        extractionEvent,
        extractionVersion,
        extractionEntity,
        JSON.stringify([secondSpan]),
        f.userId,
      ],
    );

    // The re-extraction: `total` fails its gate this time, so only `vendor`
    // comes back, and `secondSpan` is left pointing at nothing.
    await f.client.query("BEGIN");
    await f.client.query(
      `DELETE FROM kith.observations
        WHERE event_id = $1 AND observation_key = 'total'`,
      [extractionEvent],
    );
    const swept = await sweepUnreferencedExtractionSpans(f.client, {
      spaceId: targetText.space_id,
      sourceTextVersionId: targetText.source_text_version_id,
    });
    await f.client.query("COMMIT");
    assert.equal(swept, 1, "the abandoned statement's span was removed");
    assert.equal(
      (
        await f.client.query(
          "SELECT count(*)::int AS count FROM kith.evidence_spans WHERE id = $1",
          [secondSpan],
        )
      ).rows[0].count,
      0,
    );
    // The statement that survived keeps its span, because an observation
    // still cites it. A sweep that took this one would be far worse than the
    // orphans it exists to remove.
    assert.equal(
      (
        await f.client.query(
          "SELECT count(*)::int AS count FROM kith.evidence_spans WHERE id = $1",
          [extractionSpan],
        )
      ).rows[0].count,
      1,
    );

    await rehearsalUntilSettled(pass(profileB));
    assert.equal(await assessment(f), "complete");
    const afterReextraction = (
      await f.client.query(
        `SELECT counts FROM kith.worker_processing_assessments
          WHERE source_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [f.sourceAccountId],
      )
    ).rows[0]?.counts;
    assert.deepEqual(afterReextraction?.notReadyReasons ?? {}, {});
    assert.equal(afterReextraction?.unavailable ?? 0, 0);

    const kept = await withRehearsalCatalog(
      pass(profileB).config,
      f.credential.rawKey,
      (catalog) =>
        catalog.listProcessings().map((row) => row.processingCatalogId),
    );
    for (const id of debris) {
      assert.ok(kept.includes(id), "old catalog processing rows are kept");
    }
    assert.equal(
      kept.length,
      DOCUMENTS * 2 + debris.length,
      `one new row per document, nothing else removed: ${kept.length}`,
    );

    const again = await rehearsalUntilSettled(pass(profileB), 1);
    assert.deepEqual(again, [
      { state: "complete", scanned: DOCUMENTS, published: 0 },
    ]);
  },
);

test(
  "a changed parser fingerprint creates a new artifact and archives it",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const transport = inProcessWorkerTransport(f.pool, {
      userId: f.userId,
      credentialId: f.credential.id,
    });
    const workspace = await rehearsalWorkspace(t, { documents: 2 });
    const pass = (runtime) => ({
      config: rehearsalConfig({
        endpoint: "http://127.0.0.1:0/api/worker",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        workspace,
        runtime,
      }),
      credential: f.credential.rawKey,
      transport,
      runtime,
    });
    const profileA = rehearsalProfile();
    const firstA = await rehearsalUntilSettled(pass(profileA));
    assert.equal(firstA.at(-1).state, "complete", JSON.stringify(firstA));
    const before = await activeGenerations(f);

    const profileB = rehearsalProfile({
      manifest: "5".repeat(64),
      pageTexts: ["Rebuilt heading", "Rebuilt body one.", "Rebuilt body two."],
    });
    assert.notEqual(
      profileB.profile.parserFingerprint,
      profileA.profile.parserFingerprint,
    );
    await strandOneWorkRow(f, pass(profileB), transport);

    const second = await rehearsalUntilSettled(pass(profileB));
    assert.equal(second.at(-1).state, "complete", JSON.stringify(second));
    for (const row of await workRows(f)) {
      assert.ok(
        ["admitted", "obsolete"].includes(row.state),
        `no work row is stuck: ${JSON.stringify(row)}`,
      );
    }

    const after = await activeGenerations(f);
    assert.equal(after.length, 2);
    for (const [index, row] of after.entries()) {
      assert.equal(row.publication_state, "active");
      assert.notEqual(
        row.parser_artifact_id,
        before[index].parser_artifact_id,
        "a changed parser fingerprint is a new artifact",
      );
      assert.notEqual(
        row.parser_primary_receipt_id,
        before[index].parser_primary_receipt_id,
        "and its own archived parser output",
      );
    }
  },
);

// P2-104e. The owner's source is a provider-original source: the original
// lives in Dropbox and a `provider_original_v1` reference stands where its
// backup receipt would. The rehearsal above never had one, and the live pass
// failed on exactly that: `lease_conflict`, one attempt spent, nothing
// published. A re-queued provider document walked to `admit`, was sent back to
// `lookup_original` with its live lease dropped, and was refused at the second
// `reserve` by its own lease.
test(
  "a provider-original source re-processes under a changed extraction configuration, and a held lease defers one document instead of failing the pass",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const transport = inProcessWorkerTransport(f.pool, {
      userId: f.userId,
      credentialId: f.credential.id,
    });
    const workspace = await rehearsalWorkspace(t, { documents: DOCUMENTS });
    installFakeDropbox(t, workspace);
    const pass = (runtime) => ({
      config: rehearsalConfig({
        endpoint: "http://127.0.0.1:0/api/worker",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        workspace,
        runtime,
        provider: true,
      }),
      credential: f.credential.rawKey,
      transport,
      runtime,
    });
    const providerReferences = async () =>
      (
        await f.client.query(
          `SELECT g.original_provider_reference_id AS id
             FROM kith.source_items i
             JOIN kith.processing_generations g ON g.id = i.active_generation_id
            WHERE i.source_account_id = $1 ORDER BY i.id`,
          [f.sourceAccountId],
        )
      ).rows.map((row) => row.id);

    const profileA = rehearsalProfile({ mapping: "docling_utf16_pages_v2" });
    const first = await rehearsalUntilSettled(pass(profileA));
    assert.equal(first.at(-1).state, "complete", JSON.stringify(first));
    const referencesA = await providerReferences();
    assert.equal(referencesA.length, DOCUMENTS);
    for (const id of referencesA) assert.ok(id, "a provider original");
    const extractionA = new Set(
      (await activeGenerations(f)).map((row) => row.extraction_fingerprint),
    );

    // The live shape: a failed pass under the new configuration left its
    // never-activated row behind and one work row leased, expired, one
    // attempt spent.
    const profileB = rehearsalProfile({ mapping: "docling_utf16_pages_v3" });
    const stranded = await strandOneWorkRow(f, pass(profileB), transport);
    // And one more document whose lease is still live: an earlier pass of
    // this same worker died holding it a minute ago.
    const { rows: held } = await f.client.query(
      `UPDATE kith.worker_discovery_work
          SET state = 'leased', attempts = 1, lease_epoch = 1,
              lease_token = $2, lease_owner_credential_id = $3,
              lease_expires_at = transaction_timestamp() + interval '1 hour'
        WHERE id = (SELECT id FROM kith.worker_discovery_work
                     WHERE source_account_id = $1 AND state = 'queued'
                     ORDER BY created_at DESC, id DESC LIMIT 1)
        RETURNING id`,
      [f.sourceAccountId, randomBytes(32).toString("hex"), f.credential.id],
    );
    assert.equal(held.length, 1);

    const deferred = await rehearsalPass(pass(profileB));
    assert.deepEqual(
      deferred,
      {
        state: "incomplete",
        code: "processing_incomplete",
        scanned: DOCUMENTS,
        published: DOCUMENTS - 1,
      },
      "every other document published; the held one waited, and the pass says so",
    );
    const after = new Map((await workRows(f)).map((row) => [row.id, row]));
    assert.equal(after.get(held[0].id).state, "leased");
    assert.equal(
      Number(after.get(held[0].id).attempts),
      1,
      "a refused reserve spends no attempt",
    );
    assert.ok(
      Number(after.get(stranded).attempts) <= 2,
      "the expired lease was reclaimed once",
    );

    await f.client.query(
      `UPDATE kith.worker_discovery_work
          SET lease_expires_at = transaction_timestamp() - interval '1 minute'
        WHERE id = $1`,
      [held[0].id],
    );
    const rest = await rehearsalUntilSettled(pass(profileB));
    assert.deepEqual(rest, [
      { state: "complete", scanned: DOCUMENTS, published: 1 },
      { state: "complete", scanned: DOCUMENTS, published: 0 },
    ]);

    const reprocessed = await activeGenerations(f);
    assert.equal(reprocessed.length, DOCUMENTS);
    for (const row of reprocessed) {
      assert.equal(row.state, "ready");
      assert.equal(row.publication_state, "active");
      assert.ok(!extractionA.has(row.extraction_fingerprint));
    }
    assert.deepEqual(
      await providerReferences(),
      referencesA,
      "the bound provider reference was selected, not declared again",
    );
    for (const row of await workRows(f)) {
      assert.ok(["admitted", "obsolete"].includes(row.state));
      assert.ok(Number(row.attempts) <= 2, `attempts: ${row.attempts}`);
    }
    assert.equal(await assessment(f), "complete");
  },
);

/** Every live item of this source, with the path the server last recorded. */
async function sourceItems(f) {
  const { rows } = await f.client.query(
    `SELECT i.id, i.external_id, i.uri, i.lifecycle,
            (SELECT count(*) FROM kith.source_alias_digests a
              WHERE a.source_item_id = i.id) AS aliases
       FROM kith.source_items i
      WHERE i.source_account_id = $1
      ORDER BY i.created_at, i.id`,
    [f.sourceAccountId],
  );
  return rows;
}

async function reviewEntries(f) {
  const { rows } = await f.client.query(
    `SELECT state, issue_code FROM kith.worker_scan_entries
      WHERE source_account_id = $1 AND issue_code IS NOT NULL
      ORDER BY created_at, id`,
    [f.sourceAccountId],
  );
  return rows;
}

// ADM-4a. The claim this slice exists for, against the real handlers and a
// real database: renaming a file, and renaming the folder above it, leaves the
// same documents behind. Nothing is re-ingested, nothing needs review.
test(
  "a renamed file and a renamed folder keep their documents",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const transport = inProcessWorkerTransport(f.pool, {
      userId: f.userId,
      credentialId: f.credential.id,
    });
    const workspace = await rehearsalWorkspace(t, { documents: 2 });
    const dropbox = installFakeDropbox(t, workspace);
    const runtime = rehearsalProfile();
    const pass = () => ({
      config: rehearsalConfig({
        endpoint: "http://127.0.0.1:0/api/worker",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        workspace,
        runtime,
        provider: true,
      }),
      credential: f.credential.rawKey,
      transport,
      runtime,
    });

    const first = await rehearsalUntilSettled(pass());
    assert.equal(first.at(-1).state, "complete", JSON.stringify(first));
    const before = await sourceItems(f);
    assert.equal(before.length, 2);
    const identities = before.map((row) => row.external_id).sort();

    // First the general case a rename is one instance of: inventory metadata
    // changed, the bytes did not. A sync client does this on its own.
    const when = new Date(Date.now() + 120_000);
    await utimes(join(workspace.root, "document-0.pdf"), when, when);
    const touched = await rehearsalUntilSettled(pass());
    assert.deepEqual(
      touched,
      [{ state: "complete", scanned: 2, published: 0 }],
      `a new modification time publishes nothing: ${JSON.stringify(touched)}`,
    );

    // One file renamed in place.
    await rename(
      join(workspace.root, "document-0.pdf"),
      join(workspace.root, "bank statement.pdf"),
    );
    dropbox.rename("document-0.pdf", "bank statement.pdf");
    const renamed = await rehearsalUntilSettled(pass());
    assert.deepEqual(
      renamed,
      [{ state: "complete", scanned: 2, published: 0 }],
      `a rename publishes nothing: ${JSON.stringify(renamed)}`,
    );

    // And the folder above both files renamed, which moves every file at once.
    await mkdir(join(workspace.root, "filed 2026"), { mode: 0o700 });
    for (const [from, to] of [
      ["bank statement.pdf", "filed 2026/bank statement.pdf"],
      ["document-1.pdf", "filed 2026/document-1.pdf"],
    ]) {
      await rename(join(workspace.root, from), join(workspace.root, to));
      dropbox.rename(from, to);
    }
    const moved = await rehearsalUntilSettled(pass());
    assert.deepEqual(
      moved,
      [{ state: "complete", scanned: 2, published: 0 }],
      `a folder rename publishes nothing: ${JSON.stringify(moved)}`,
    );

    const after = await sourceItems(f);
    assert.equal(after.length, 2, "no second document was created");
    assert.deepEqual(
      after.map((row) => row.external_id).sort(),
      identities,
      "the same two identities",
    );
    for (const row of after) assert.equal(row.lifecycle, "available");
    assert.deepEqual(
      after.map((row) => Number(row.aliases)).sort(),
      // One file was seen at three paths and the other at two: every path an
      // item has been seen at is an alias of that one item.
      [2, 3],
    );
    assert.deepEqual(
      await reviewEntries(f),
      [],
      "and nothing was sent for identity review",
    );
    assert.deepEqual(
      (await activeGenerations(f)).map((row) => row.publication_state),
      ["active", "active"],
      "both documents are still the published ones",
    );
  },
);

// ADM-4c. A second watched root added to a journal that already has a
// published history. Three claims, against the real handlers and a real
// database:
//
//   1. the first root's documents are untouched: no identity recovery, no
//      re-parse, no re-publish;
//   2. the second root's PDFs publish once, each bound to its own provider
//      folder;
//   3. the files the PDF lane does not handle are counted and skipped by name,
//      and a third pass publishes nothing.
test(
  "a second watched root publishes its own documents and leaves the first alone",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const transport = inProcessWorkerTransport(f.pool, {
      userId: f.userId,
      credentialId: f.credential.id,
    });
    const workspace = await rehearsalWorkspace(t, { documents: 2 });
    const dropbox = installFakeDropbox(t, workspace);
    const runtime = rehearsalProfile();
    const pass = () => ({
      config: rehearsalConfig({
        endpoint: "http://127.0.0.1:0/api/worker",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        workspace,
        runtime,
        provider: true,
      }),
      credential: f.credential.rawKey,
      transport,
      runtime,
    });

    // One root, published, under the pre-ADM-4c single-root provider config.
    const first = await rehearsalUntilSettled(pass());
    assert.equal(first.at(-1).state, "complete", JSON.stringify(first));
    const before = await activeGenerations(f);
    assert.equal(before.length, 2);
    const untouched = new Map(
      before.map((row) => [row.item_id, row.active_generation_id]),
    );
    const firstRootItems = (await sourceItems(f)).map((row) => row.external_id);

    // Now the owner adds a folder: two more documents and three files the PDF
    // lane cannot read.
    const added = await addRehearsalRoot(workspace, "investing", {
      documents: 2,
      unsupported: true,
    });
    dropbox.addRoot(added);

    const second = await rehearsalUntilSettled(pass());
    assert.equal(second.at(-1).state, "complete", JSON.stringify(second));
    assert.equal(
      second.reduce((total, result) => total + (result.published ?? 0), 0),
      2,
      `only the new root's documents published: ${JSON.stringify(second)}`,
    );

    // 1. The first root's documents are the ones they were.
    const after = await activeGenerations(f);
    for (const [itemId, generationId] of untouched) {
      const row = after.find((candidate) => candidate.item_id === itemId);
      assert.ok(row, "the first root's item is still here");
      assert.equal(
        row.active_generation_id,
        generationId,
        "and its published generation was neither re-parsed nor replaced",
      );
      assert.equal(row.publication_state, "active");
    }
    assert.deepEqual(
      (await reviewEntries(f)).filter((row) => row.state !== "gap"),
      [],
      "adding a root is not an identity failure for the root already there",
    );

    // 2. The new root's PDFs published exactly once each.
    const items = await sourceItems(f);
    const fresh = items.filter(
      (row) => !firstRootItems.includes(row.external_id),
    );
    const published = fresh.filter((row) =>
      after.some(
        (generation) =>
          generation.item_id === row.id &&
          generation.publication_state === "active",
      ),
    );
    assert.deepEqual(
      published.map((row) => row.uri).sort(),
      ["fs://investing/investing-0.pdf", "fs://investing/investing-1.pdf"],
      "the second root's two documents, and only those",
    );

    // 3. Its unsupported files are items with a named skip reason and no
    // processing at all.
    const skippedUris = added.skipped
      .map((file) => `fs://investing/${file.relativePath}`)
      .sort();
    assert.deepEqual(
      fresh
        .filter((row) => skippedUris.includes(row.uri))
        .map((row) => row.uri)
        .sort(),
      skippedUris,
      "every skipped file is still an item the sources screen can count",
    );
    assert.deepEqual(
      await gapEntries(f),
      [
        { uri: "fs://investing/blank.pdf", code: "empty" },
        { uri: "fs://investing/large-photo.jpg", code: "oversized" },
        { uri: "fs://investing/photo.jpg", code: "unsupported" },
      ],
      "each under its own closed-enum reason",
    );
    for (const row of fresh.filter((candidate) =>
      skippedUris.includes(candidate.uri),
    )) {
      assert.equal(
        after.some((generation) => generation.item_id === row.id),
        false,
        "and none of them produced a processing generation",
      );
    }

    // And the world has stopped moving.
    const third = await rehearsalUntilSettled(pass());
    assert.deepEqual(
      third,
      [{ state: "complete", scanned: 7, published: 0 }],
      `a third pass publishes nothing: ${JSON.stringify(third)}`,
    );
  },
);

/** The skip reason the server recorded for each gap entry, by item. */
async function gapEntries(f) {
  const { rows } = await f.client.query(
    `SELECT DISTINCT i.uri, e.issue_code
       FROM kith.worker_scan_entries e
       JOIN kith.source_items i ON i.id = e.source_item_id
      WHERE e.source_account_id = $1 AND e.state = 'gap'
      ORDER BY i.uri`,
    [f.sourceAccountId],
  );
  return rows.map((row) => ({ uri: row.uri, code: row.issue_code }));
}

/** ADM-4c. The desired watched-folder list, as the owner's UI would write it. */
async function addSourceRoot(f, { rootAlias, relativePath, state = "active" }) {
  const id = newKithId();
  await f.client.query(
    `INSERT INTO kith.source_roots
       (id, space_id, source_account_id, kind, root_alias, relative_path,
        expected_types, state)
     VALUES ($1,$2,$3,'folder',$4,$5,'[]'::jsonb,$6)`,
    [id, f.spaceId, f.sourceAccountId, rootAlias, relativePath, state],
  );
  return id;
}

async function rootReports(f) {
  const { rows } = await f.client.query(
    `SELECT r.root_alias, r.relative_path, p.state, p.item_count
       FROM kith.source_root_reports p
       JOIN kith.source_roots r ON r.id = p.source_root_id
      WHERE r.source_account_id = $1
      ORDER BY r.root_alias, r.relative_path`,
    [f.sourceAccountId],
  );
  return rows.map((row) => ({
    alias: row.root_alias,
    path: row.relative_path,
    state: row.state,
    items: Number(row.item_count),
  }));
}

// ADM-4c review, findings 1 and 4. The shape the owner's first use of the
// sources screen actually has: an account whose documents are already
// published under a root no server row can ever name, and one new folder added
// in the UI. `reconcileWorkerScan` is account-wide, so a client that dropped
// the unnamed root would take every existing document out of the scan and the
// server would mark them all unavailable on the very next pass.
test(
  "a server row for one new folder leaves the root it does not name alone",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const transport = inProcessWorkerTransport(f.pool, {
      userId: f.userId,
      credentialId: f.credential.id,
    });
    const workspace = await rehearsalWorkspace(t, { documents: 2 });
    const dropbox = installFakeDropbox(t, workspace);
    const runtime = rehearsalProfile();
    const pass = () => ({
      config: rehearsalConfig({
        endpoint: "http://127.0.0.1:0/api/worker",
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        workspace,
        runtime,
        provider: true,
      }),
      credential: f.credential.rawKey,
      transport,
      runtime,
    });

    const first = await rehearsalUntilSettled(pass());
    assert.equal(first.at(-1).state, "complete", JSON.stringify(first));
    const before = await activeGenerations(f);
    assert.equal(before.length, 2);
    const untouched = new Map(
      before.map((row) => [row.item_id, row.active_generation_id]),
    );

    // The owner adds one folder in the UI. The admin API cannot write a row
    // for the whole of the existing root: `relative_path` must be at least one
    // character, so the original root is named by nothing.
    const added = await addRehearsalRoot(workspace, "investing", {
      documents: 2,
    });
    await mkdir(join(added.path, "2026"), { mode: 0o700 });
    dropbox.addRoot(added);
    const rootId = await addSourceRoot(f, {
      rootAlias: "investing",
      relativePath: "2026",
    });
    assert.ok(rootId);

    const second = await rehearsalUntilSettled(pass());
    assert.equal(second.at(-1).state, "complete", JSON.stringify(second));

    // The claim: nothing the owner already had was retired.
    const items = await sourceItems(f);
    for (const row of items.filter((candidate) =>
      untouched.has(candidate.id),
    )) {
      assert.equal(
        row.lifecycle,
        "available",
        "a root no row names is watched whole, so its items stay available",
      );
    }
    const after = await activeGenerations(f);
    for (const [itemId, generationId] of untouched) {
      const row = after.find((candidate) => candidate.item_id === itemId);
      assert.equal(row?.active_generation_id, generationId);
      assert.equal(row?.publication_state, "active");
    }
    // The new root was narrowed to the empty subtree the row names, so its own
    // two documents are outside it and are not ingested. That is the row doing
    // exactly what it says.
    assert.deepEqual(await rootReports(f), [
      { alias: "investing", path: "2026", state: "ok", items: 0 },
    ]);
    assert.equal(
      items.length,
      2,
      "and nothing outside the named subtree was read",
    );
  },
);

// ADM-4c review, finding 4 and the 1024 ceiling. More files than the old
// `maxFiles` and the old catalog bound, across two roots, driven to a settled
// world. The documents are gaps rather than PDFs: what this measures is the
// scan, the checkpoint, the identity bindings and the catalog at scale, and
// parsing 300 synthetic PDFs through real age and restic would take an hour
// and prove nothing the cases above do not.
test(
  "a scan of more than 256 files across two roots settles",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const transport = inProcessWorkerTransport(f.pool, {
      userId: f.userId,
      credentialId: f.credential.id,
    });
    const workspace = await rehearsalWorkspace(t, { documents: 0 });
    installFakeDropbox(t, workspace);
    const runtime = rehearsalProfile();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    for (let index = 0; index < 160; index += 1) {
      await writeFile(
        join(workspace.root, `skipped-${index}.jpg`),
        Buffer.concat([jpeg, Buffer.alloc(512, 7)]),
        { mode: 0o600 },
      );
    }
    const added = await addRehearsalRoot(workspace, "investing");
    for (let index = 0; index < 160; index += 1) {
      await writeFile(
        join(added.path, `skipped-${index}.jpg`),
        Buffer.concat([jpeg, Buffer.alloc(512, 7)]),
        { mode: 0o600 },
      );
    }
    const pass = () => ({
      config: {
        ...rehearsalConfig({
          endpoint: "http://127.0.0.1:0/api/worker",
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          workspace,
          runtime,
          provider: true,
        }),
        maxFiles: 1024,
      },
      credential: f.credential.rawKey,
      transport,
      runtime,
    });

    const results = await rehearsalUntilSettled(pass());
    assert.equal(results.at(-1).state, "complete", JSON.stringify(results));
    assert.equal(
      results.at(-1).scanned,
      320,
      "every file in both roots, well past the old 256 ceiling",
    );
    const items = await sourceItems(f);
    assert.equal(items.length, 320);
    for (const row of items) assert.equal(row.lifecycle, "available");
    // A second pass changes nothing, which is the claim the ceiling rests on:
    // 320 plans and 320 bindings round-trip through the journal unchanged.
    const again = await rehearsalUntilSettled(pass());
    assert.deepEqual(again, [
      { state: "complete", scanned: 320, published: 0 },
    ]);
  },
);

// ADM-4c review, finding 1's second half. The breaker is the last line: it
// does not care why the roots changed, only that a pass is about to take a
// large share of the account out of the scan.
test(
  "a config that stops watching most of the account refuses to scan",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const transport = inProcessWorkerTransport(f.pool, {
      userId: f.userId,
      credentialId: f.credential.id,
    });
    const workspace = await rehearsalWorkspace(t, { documents: 0 });
    installFakeDropbox(t, workspace);
    const runtime = rehearsalProfile();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await writeFile(
      join(workspace.root, "kept.jpg"),
      Buffer.concat([jpeg, Buffer.alloc(512, 7)]),
      { mode: 0o600 },
    );
    const added = await addRehearsalRoot(workspace, "investing");
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        join(added.path, `file-${index}.jpg`),
        Buffer.concat([jpeg, Buffer.alloc(512, 7)]),
        { mode: 0o600 },
      );
    }
    const base = rehearsalConfig({
      endpoint: "http://127.0.0.1:0/api/worker",
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      workspace,
      runtime,
      provider: true,
    });
    const settled = await rehearsalUntilSettled({
      config: base,
      credential: f.credential.rawKey,
      transport,
      runtime,
    });
    assert.equal(settled.at(-1).state, "complete", JSON.stringify(settled));
    assert.equal((await sourceItems(f)).length, 41);

    // Now the second root disappears from the config: a typo, a rolled-back
    // edit, a disk that did not mount. Forty of forty-one items would be
    // retired, so the pass refuses instead.
    const narrowed = {
      ...base,
      roots: base.roots.filter((root) => root.alias !== "investing"),
      pdfDocQa: {
        ...base.pdfDocQa,
        providerOriginal: {
          ...base.pdfDocQa.providerOriginal,
          roots: base.pdfDocQa.providerOriginal.roots.filter(
            (root) => root.rootAlias !== "investing",
          ),
        },
      },
    };
    const refused = await rehearsalPass({
      config: narrowed,
      credential: f.credential.rawKey,
      transport,
      runtime,
    });
    assert.deepEqual(refused, {
      state: "incomplete",
      code: "root_selection_would_retire_items",
      scanned: 0,
      published: 0,
    });
    for (const row of await sourceItems(f)) {
      assert.equal(
        row.lifecycle,
        "available",
        "and not one item was marked unavailable",
      );
    }

    // Putting the config back costs nothing: the journal never forgot.
    const restored = await rehearsalUntilSettled({
      config: base,
      credential: f.credential.rawKey,
      transport,
      runtime,
    });
    assert.deepEqual(restored, [
      { state: "complete", scanned: 41, published: 0 },
    ]);
  },
);
