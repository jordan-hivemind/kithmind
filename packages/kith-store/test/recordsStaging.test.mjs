import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  applyKithSchema,
  newKithId,
  provenance,
  records,
  withKithTransaction,
} from "../dist/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

async function sha256(value) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
}

async function database(t) {
  const db = await throwawayDatabase(t);
  const client = await connect(db);
  await applyKithSchema(client);
  const pool = db.adopt(new pg.Pool({ connectionString: db.url, max: 4 }));
  return { db, client, pool };
}

async function fixture(
  client,
  {
    parsed = false,
    card = false,
    text = "A😀B synthetic service evidence",
    quoteStart = 4,
    quoteEnd = text.length,
  } = {},
) {
  const ids = Object.fromEntries(
    [
      "user",
      "space",
      "account",
      "item",
      "revision",
      "artifact",
      "textVersion",
      "page",
      "span",
      "entity",
      "generation",
    ].map((name) => [name, newKithId()]),
  );
  const hash = await sha256(text);
  await client.query(
    "INSERT INTO kith.users(id,created_at,name) VALUES ($1,transaction_timestamp(),'Staging actor')",
    [ids.user],
  );
  await client.query(
    `INSERT INTO kith.spaces(id,created_at,kind,name,created_by)
     VALUES ($1,transaction_timestamp(),'personal','Staging space',$2)`,
    [ids.space, ids.user],
  );
  await client.query(
    `INSERT INTO kith.entities
       (id,space_id,created_at,user_id,key,kind,canonical_name,normalized_name,
        aliases,normalized_aliases)
     VALUES ($1,$2,transaction_timestamp(),$3,'vehicle','other','Vehicle',
       'vehicle','[]','[]')`,
    [ids.entity, ids.space, ids.user],
  );
  await client.query(
    `INSERT INTO kith.source_accounts
       (id,space_id,created_at,connector,account_id,name,enabled,
        subject_entity_id,created_by)
     VALUES ($1,$2,transaction_timestamp(),'synthetic','staging-account',
       'Staging account',true,$3,$4)`,
    [ids.account, ids.space, ids.entity, ids.user],
  );
  await client.query(
    `INSERT INTO kith.source_items
       (id,space_id,created_at,source_account_id,external_id_hash,lifecycle,
        original_link_available,desired_processing_epoch)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,'available',true,1)`,
    [ids.item, ids.space, ids.account, "1".repeat(64)],
  );
  if (parsed) {
    await client.query(
      `INSERT INTO kith.source_revisions
         (id,space_id,created_at,source_item_id,content_hash,byte_length,
          media_type,representation,content_hash_authority,captured_at,user_id)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,100,'application/pdf',
         'archived_binary_v1','worker_asserted',transaction_timestamp(),$5)`,
      [ids.revision, ids.space, ids.item, "2".repeat(64), ids.user],
    );
    await client.query(
      `INSERT INTO kith.source_parser_artifacts
         (id,space_id,created_at,source_account_id,source_item_id,
          source_revision_id,client_artifact_id,parser_fingerprint,output_hash,
          output_byte_length,output_media_type,hash_authority,user_id,
          created_at_field)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,'artifact','parser-v1',
         $6,$7,'application/json','worker_asserted',$8,transaction_timestamp())`,
      [
        ids.artifact,
        ids.space,
        ids.account,
        ids.item,
        ids.revision,
        hash,
        Buffer.byteLength(text),
        ids.user,
      ],
    );
    await client.query(
      `INSERT INTO kith.source_text_versions
         (id,space_id,created_at,source_revision_id,extraction_fingerprint,
          representation,text_hash,text_hash_authority,byte_length,utf16_length,
          page_count,mapping_manifest_hash,parser_artifact_id,evidence_sealed)
       VALUES ($1,$2,transaction_timestamp(),$3,'extract-v1','parsed_pages_v1',
         $4,'server_verified_retained_text',$5,$6,1,$7,$8,true)`,
      [
        ids.textVersion,
        ids.space,
        ids.revision,
        hash,
        Buffer.byteLength(text),
        text.length,
        "3".repeat(64),
        ids.artifact,
      ],
    );
  } else {
    await client.query(
      `INSERT INTO kith.source_revisions
         (id,space_id,created_at,source_item_id,content_hash,byte_length,
          media_type,representation,content_hash_authority,inline_text,
          captured_at,user_id)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,'text/plain',
         'inline_utf8_v1','server_verified_utf8',$6,transaction_timestamp(),$7)`,
      [
        ids.revision,
        ids.space,
        ids.item,
        hash,
        Buffer.byteLength(text),
        text,
        ids.user,
      ],
    );
    await client.query(
      `INSERT INTO kith.source_text_versions
         (id,space_id,created_at,source_revision_id,extraction_fingerprint,
          representation,text,text_hash,text_hash_authority,byte_length,
          evidence_sealed)
       VALUES ($1,$2,transaction_timestamp(),$3,'extract-v1','inline_text_v1',
         $4,$5,'server_verified_retained_text',$6,true)`,
      [
        ids.textVersion,
        ids.space,
        ids.revision,
        text,
        hash,
        Buffer.byteLength(text),
      ],
    );
  }
  await client.query(
    "UPDATE kith.source_items SET desired_revision_id=$1 WHERE id=$2",
    [ids.revision, ids.item],
  );
  await client.query(
    `INSERT INTO kith.source_pages
       (id,space_id,created_at,source_text_version_id,ordinal,start,"end",text,
        text_hash)
     VALUES ($1,$2,transaction_timestamp(),$3,0,0,$4,$5,$6)`,
    [ids.page, ids.space, ids.textVersion, text.length, text, hash],
  );
  await client.query(
    `INSERT INTO kith.evidence_spans
       (id,space_id,created_at,source_revision_id,source_text_version_id,
        source_page_id,ordinal,start,"end",quote_hash)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,0,$6,$7,$8)`,
    [
      ids.span,
      ids.space,
      ids.revision,
      ids.textVersion,
      ids.page,
      quoteStart,
      quoteEnd,
      await sha256(text.slice(quoteStart, quoteEnd)),
    ],
  );
  await client.query(
    `INSERT INTO kith.processing_generations
       (id,space_id,created_at,source_account_id,source_item_id,
        source_revision_id,source_text_version_id,parser_artifact_id,
        card_generation,state,desired_processing_epoch)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,'processing',1)`,
    [
      ids.generation,
      ids.space,
      ids.account,
      ids.item,
      ids.revision,
      ids.textVersion,
      parsed ? ids.artifact : null,
      card,
    ],
  );
  return { ids, text };
}

async function addGeneration(client, item, { card = false } = {}) {
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.processing_generations
       (id,space_id,created_at,source_account_id,source_item_id,
        source_revision_id,source_text_version_id,parser_artifact_id,
        card_generation,state,desired_processing_epoch)
     SELECT $1,space_id,transaction_timestamp(),source_account_id,source_item_id,
       source_revision_id,source_text_version_id,parser_artifact_id,$2,
       'processing',desired_processing_epoch
     FROM kith.processing_generations WHERE id=$3`,
    [id, card, item.ids.generation],
  );
  return id;
}

function record(item, overrides = {}) {
  const base = {
    eventKey: "service:synthetic",
    entityId: item.ids.entity,
    eventType: "vehicle_service",
    schemaVersion: 1,
    occurrence: { precision: "date", date: "2026-09-13" },
    fieldEvidence: {
      occurrence: [item.ids.span],
      entity: [item.ids.span],
      eventType: [item.ids.span],
    },
    observations: [
      {
        observationKey: "odometer",
        observationType: "odometer",
        value: { type: "decimal", value: "0012.500", unitCode: "[mi_i]" },
        valueEvidence: [item.ids.span],
      },
    ],
  };
  return { ...base, ...overrides };
}

function stageInput(item, generationId, stagedRecords, userId = item.ids.user) {
  return {
    spaceId: item.ids.space,
    processingGenerationId: generationId,
    userId,
    records: stagedRecords,
  };
}

test(
  "stage, replay, validate, publish, and hydrate preserve immutable records",
  { skip },
  async (t) => {
    const { client, pool } = await database(t);
    const item = await fixture(client);
    const first = await withKithTransaction(pool, (tx) =>
      records.stageRecordBatch(
        tx,
        stageInput(item, item.ids.generation, [record(item)]),
      ),
    );
    assert.deepEqual(
      [
        first.insertedEventCount,
        first.insertedEventVersionCount,
        first.insertedObservationCount,
      ],
      [1, 1, 1],
    );

    await client.query(
      "UPDATE kith.observations SET bound_entity_id=$1 WHERE id=$2",
      [item.ids.entity, first.observationIds[0]],
    );
    const replayActor = newKithId();
    await client.query(
      "INSERT INTO kith.users(id,created_at,name) VALUES ($1,transaction_timestamp(),'Replay actor')",
      [replayActor],
    );
    const replay = await withKithTransaction(pool, (tx) =>
      records.stageRecordBatch(
        tx,
        stageInput(item, item.ids.generation, [record(item)], replayActor),
      ),
    );
    assert.deepEqual(replay.eventIds, first.eventIds);
    assert.deepEqual(replay.eventVersionIds, first.eventVersionIds);
    assert.deepEqual(replay.observationIds, first.observationIds);
    assert.deepEqual(
      [
        replay.insertedEventCount,
        replay.insertedEventVersionCount,
        replay.insertedObservationCount,
      ],
      [0, 0, 0],
    );
    const actors = await client.query(
      `SELECT e.created_by, v.user_id, o.user_id observation_user_id
       FROM kith.events e
       JOIN kith.event_versions v ON v.event_id=e.id
       JOIN kith.observations o ON o.event_version_id=v.id
       WHERE e.id=$1`,
      [first.eventIds[0]],
    );
    assert.deepEqual(actors.rows[0], {
      created_by: item.ids.user,
      user_id: item.ids.user,
      observation_user_id: item.ids.user,
    });
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, item.ids.generation, [
            record(item, {
              occurrence: { precision: "date", date: "2026-09-12" },
            }),
          ]),
        ),
      ),
      /Conflicting immutable event version/,
    );

    const validated = await withKithTransaction(pool, async (tx) => {
      const proof = await records.validateGenerationRecords(tx, {
        spaceId: item.ids.space,
        processingGenerationId: item.ids.generation,
        expectedEventCount: 1,
        expectedObservationCount: 1,
      });
      await provenance.activateSourceItemGeneration(tx, {
        spaceId: item.ids.space,
        sourceItemId: item.ids.item,
        sourceRevisionId: item.ids.revision,
        processingGenerationId: item.ids.generation,
        expectedDesiredProcessingEpoch: 1,
      });
      await tx.query(
        "UPDATE kith.processing_generations SET state='ready', activated_at=transaction_timestamp() WHERE id=$1",
        [item.ids.generation],
      );
      return proof;
    });
    assert.equal(validated.evidenceSpanCount, 1);
    assert.equal(validated.evidenceReferenceCount, 4);
    const hydrated = await records.hydrateObservation(client, {
      spaceId: item.ids.space,
      observationId: first.observationIds[0],
    });
    assert.deepEqual(hydrated.observation.value, {
      type: "decimal",
      value: "12.5",
      unitCode: "[mi_i]",
    });
    assert.equal(hydrated.observation.boundEntityId, item.ids.entity);
  },
);

test(
  "parsed records stage, zero counts validate, and stored corruption is refused",
  { skip },
  async (t) => {
    const { client, pool } = await database(t);
    const item = await fixture(client, { parsed: true });
    const staged = await withKithTransaction(pool, (tx) =>
      records.stageRecordBatch(
        tx,
        stageInput(item, item.ids.generation, [record(item)]),
      ),
    );
    await withKithTransaction(pool, (tx) =>
      records.validateGenerationRecords(tx, {
        spaceId: item.ids.space,
        processingGenerationId: item.ids.generation,
        expectedEventCount: 1,
        expectedObservationCount: 1,
      }),
    );

    const emptyGeneration = await addGeneration(client, item);
    const empty = await withKithTransaction(pool, (tx) =>
      records.validateGenerationRecords(tx, {
        spaceId: item.ids.space,
        processingGenerationId: emptyGeneration,
        expectedEventCount: 0,
        expectedObservationCount: 0,
      }),
    );
    assert.deepEqual(empty.eventVersions, []);
    assert.deepEqual(empty.observations, []);

    await client.query(
      "UPDATE kith.event_versions SET event_type='document_card' WHERE id=$1",
      [staged.eventVersionIds[0]],
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.validateGenerationRecords(tx, {
          spaceId: item.ids.space,
          processingGenerationId: item.ids.generation,
          expectedEventCount: 1,
          expectedObservationCount: 1,
        }),
      ),
      /generation kind/,
    );
  },
);

test(
  "generation validation refuses duplicates, orphans, missing required observations, and mixed lanes",
  { skip },
  async (t) => {
    const { client, pool } = await database(t);
    const item = await fixture(client);
    const staged = await withKithTransaction(pool, (tx) =>
      records.stageRecordBatch(
        tx,
        stageInput(item, item.ids.generation, [record(item)]),
      ),
    );

    const duplicateVersion = newKithId();
    await client.query(
      `INSERT INTO kith.event_versions
       SELECT $1, space_id, transaction_timestamp(), source_account_id,
         source_item_id, source_revision_id, source_text_version_id,
         processing_generation_id, event_id, entity_id, event_type,
         schema_version, occurrence, occurrence_date, occurrence_instant,
         occurrence_sort_key, field_evidence, doc_type_patch, user_id
       FROM kith.event_versions WHERE id=$2`,
      [duplicateVersion, staged.eventVersionIds[0]],
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.validateGenerationRecords(tx, {
          spaceId: item.ids.space,
          processingGenerationId: item.ids.generation,
          expectedEventCount: 2,
          expectedObservationCount: 1,
        }),
      ),
      /duplicate event version identities/,
    );
    await client.query("DELETE FROM kith.event_versions WHERE id=$1", [
      duplicateVersion,
    ]);

    const otherGeneration = await addGeneration(client, item);
    const other = await withKithTransaction(pool, (tx) =>
      records.stageRecordBatch(
        tx,
        stageInput(item, otherGeneration, [record(item)]),
      ),
    );
    await client.query(
      "UPDATE kith.observations SET event_version_id=$1 WHERE id=$2",
      [other.eventVersionIds[0], staged.observationIds[0]],
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.validateGenerationRecords(tx, {
          spaceId: item.ids.space,
          processingGenerationId: item.ids.generation,
          expectedEventCount: 1,
          expectedObservationCount: 1,
        }),
      ),
      /no event version in its generation/,
    );
    await client.query(
      "UPDATE kith.observations SET event_version_id=$1 WHERE id=$2",
      [staged.eventVersionIds[0], staged.observationIds[0]],
    );

    await client.query("DELETE FROM kith.observations WHERE id=$1", [
      staged.observationIds[0],
    ]);
    await client.query("UPDATE kith.entities SET kind='person' WHERE id=$1", [
      item.ids.entity,
    ]);
    await client.query(
      "UPDATE kith.event_versions SET event_type='lab_panel' WHERE id=$1",
      [staged.eventVersionIds[0]],
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.validateGenerationRecords(tx, {
          spaceId: item.ids.space,
          processingGenerationId: item.ids.generation,
          expectedEventCount: 1,
          expectedObservationCount: 0,
        }),
      ),
      /lab_panel requires at least one observation/,
    );
    await client.query(
      "UPDATE kith.event_versions SET event_type='document_card' WHERE id=$1",
      [staged.eventVersionIds[0]],
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.validateGenerationRecords(tx, {
          spaceId: item.ids.space,
          processingGenerationId: item.ids.generation,
          expectedEventCount: 1,
          expectedObservationCount: 0,
        }),
      ),
      /generation kind/,
    );

    const indexNames = (
      await client.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname='kith' AND indexname LIKE 'records_%'
         ORDER BY indexname`,
      )
    ).rows.map((row) => row.indexname);
    assert.deepEqual(indexNames, [
      "records_event_item_key_idx",
      "records_event_version_generation_idx",
      "records_event_version_identity_idx",
      "records_observation_generation_idx",
      "records_observation_identity_idx",
    ]);
  },
);

test(
  "card records stage and validate only in the card lane",
  { skip },
  async (t) => {
    const { client, pool } = await database(t);
    const item = await fixture(client, { card: true });
    await withKithTransaction(pool, async (tx) => {
      await records.stageRecordBatch(
        tx,
        stageInput(item, item.ids.generation, [
          record(item, {
            eventKey: "card:document_card",
            eventType: "document_card",
            observations: [
              {
                observationKey: "card_title",
                observationType: "card_title",
                value: { type: "text", value: "Synthetic record" },
                valueEvidence: [item.ids.span],
              },
            ],
          }),
        ]),
      );
      const proof = await records.validateGenerationRecords(tx, {
        spaceId: item.ids.space,
        processingGenerationId: item.ids.generation,
        expectedEventCount: 1,
        expectedObservationCount: 1,
      });
      assert.equal(proof.eventVersions[0].eventType, "document_card");
    });
  },
);

test(
  "cross-space input rolls back earlier rows in the same transaction",
  { skip },
  async (t) => {
    const { client, pool } = await database(t);
    const local = await fixture(client);
    const foreign = await fixture(client);
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(local, local.ids.generation, [
            record(local, { eventKey: "valid-before-refusal" }),
            record(local, {
              eventKey: "foreign-entity",
              entityId: foreign.ids.entity,
              observations: [],
            }),
          ]),
        ),
      ),
      /belongs to another space/,
    );
    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM kith.events WHERE source_item_id=$1) events,
         (SELECT count(*)::int FROM kith.event_versions
           WHERE processing_generation_id=$2) versions`,
      [local.ids.item, local.ids.generation],
    );
    assert.deepEqual(counts.rows[0], { events: 0, versions: 0 });
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(tx, {
          ...stageInput(local, local.ids.generation, [record(local)]),
          spaceId: foreign.ids.space,
        }),
      ),
      /does not exist in this space/,
    );
  },
);

test(
  "serializable staging shares one stable event across concurrent generations",
  { skip },
  async (t) => {
    const { client, pool } = await database(t);
    const item = await fixture(client);
    const otherGeneration = await addGeneration(client, item);
    const [left, right] = await Promise.all([
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, item.ids.generation, [record(item)]),
        ),
      ),
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, otherGeneration, [record(item)]),
        ),
      ),
    ]);
    assert.equal(left.eventIds[0], right.eventIds[0]);
    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM kith.events WHERE source_item_id=$1) events,
         (SELECT count(*)::int FROM kith.event_versions WHERE event_id=$2) versions`,
      [item.ids.item, left.eventIds[0]],
    );
    assert.deepEqual(counts.rows[0], { events: 1, versions: 2 });
  },
);

test(
  "staging enforces row, byte, generation, actor, and card lane bounds",
  { skip },
  async (t) => {
    const { client, pool } = await database(t);
    const item = await fixture(client);
    const observations = Array.from({ length: 25 }, (_, index) => ({
      observationKey: `field:${index}`,
      observationType: "field",
      value: { type: "integer", value: index },
      valueEvidence: [item.ids.span],
    }));
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, item.ids.generation, [
            record(item, { observations }),
          ]),
        ),
      ),
      /per-call row limit/,
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, item.ids.generation, [
            record(item, {
              observations: [
                {
                  observationKey: "huge",
                  observationType: "huge",
                  value: { type: "text", value: "x".repeat(140_000) },
                  valueEvidence: [],
                },
              ],
            }),
          ]),
        ),
      ),
      /UTF-8 bytes/,
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, item.ids.generation, [record(item)], newKithId()),
        ),
      ),
      /actor does not exist/,
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, item.ids.generation, [
            record(item, {
              eventType: "document_card",
              observations: [],
            }),
          ]),
        ),
      ),
      /Card records require a card processing generation/,
    );

    const events = Array.from({ length: 32 }, (_, index) =>
      record(item, { eventKey: `bounded:${index}`, observations: [] }),
    );
    await withKithTransaction(pool, (tx) =>
      records.stageRecordBatch(
        tx,
        stageInput(item, item.ids.generation, events.slice(0, 25)),
      ),
    );
    await withKithTransaction(pool, (tx) =>
      records.stageRecordBatch(
        tx,
        stageInput(item, item.ids.generation, events.slice(25)),
      ),
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, item.ids.generation, [
            record(item, { eventKey: "bounded:32", observations: [] }),
          ]),
        ),
      ),
      /exceeds 32 events/,
    );

    const observationGeneration = await addGeneration(client, item);
    const observationsFor = (start, count) =>
      Array.from({ length: count }, (_, offset) => ({
        observationKey: `reading:${start + offset}`,
        observationType: "reading",
        value: { type: "integer", value: start + offset },
        valueEvidence: [item.ids.span],
      }));
    for (let start = 0; start < 120; start += 24) {
      await withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, observationGeneration, [
            record(item, { observations: observationsFor(start, 24) }),
          ]),
        ),
      );
    }
    await withKithTransaction(pool, (tx) =>
      records.stageRecordBatch(
        tx,
        stageInput(item, observationGeneration, [
          record(item, { observations: observationsFor(120, 8) }),
        ]),
      ),
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(item, observationGeneration, [
            record(item, { observations: observationsFor(128, 1) }),
          ]),
        ),
      ),
      /exceeds 128 observations/,
    );
  },
);

test(
  "staging enforces per-record and aggregate evidence quote budgets",
  { skip },
  async (t) => {
    const { client, pool } = await database(t);
    const oversized = await fixture(client, {
      text: "x".repeat(16 * 1024 + 1),
      quoteStart: 0,
    });
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(oversized, oversized.ids.generation, [
            record(oversized, { observations: [] }),
          ]),
        ),
      ),
      /evidence exceeds the global limit/,
    );

    const segmentBytes = 16 * 1024;
    const aggregate = await fixture(client, {
      parsed: true,
      text: "y".repeat(segmentBytes * 9),
      quoteStart: 0,
      quoteEnd: segmentBytes,
    });
    const spanIds = [aggregate.ids.span];
    for (let index = 1; index < 9; index += 1) {
      const spanId = newKithId();
      spanIds.push(spanId);
      await client.query(
        `INSERT INTO kith.evidence_spans
           (id,space_id,created_at,source_revision_id,source_text_version_id,
            source_page_id,ordinal,start,"end",quote_hash)
         VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9)`,
        [
          spanId,
          aggregate.ids.space,
          aggregate.ids.revision,
          aggregate.ids.textVersion,
          aggregate.ids.page,
          index,
          index * segmentBytes,
          (index + 1) * segmentBytes,
          await sha256("y".repeat(segmentBytes)),
        ],
      );
    }
    const batch = spanIds.map((spanId, index) =>
      record(aggregate, {
        eventKey: `aggregate:${index}`,
        fieldEvidence: {
          occurrence: [spanId],
          entity: [spanId],
          eventType: [spanId],
        },
        observations: [],
      }),
    );
    await assert.rejects(
      withKithTransaction(pool, (tx) =>
        records.stageRecordBatch(
          tx,
          stageInput(aggregate, aggregate.ids.generation, batch),
        ),
      ),
      /global evidence-byte limit/,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int count FROM kith.events WHERE source_item_id=$1",
          [aggregate.ids.item],
        )
      ).rows[0].count,
      0,
    );
  },
);
