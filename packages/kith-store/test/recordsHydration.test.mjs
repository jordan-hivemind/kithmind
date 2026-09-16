import assert from "node:assert/strict";
import test from "node:test";

import {
  applyKithSchema,
  newKithId,
  records,
} from "../dist/index.js";

import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sortKey(occurrence, identity) {
  if (occurrence.precision === "unknown") return null;
  if (occurrence.precision === "date") {
    return `${occurrence.date}|0|${identity}`;
  }
  const local = new Date(
    occurrence.instant +
      (occurrence.originalOffset === "Z"
        ? 0
        : Number(occurrence.originalOffset.slice(0, 3)) * 60 * 60_000),
  )
    .toISOString()
    .slice(0, 10);
  const instant = (
    BigInt(occurrence.instant) + BigInt(Number.MAX_SAFE_INTEGER)
  )
    .toString()
    .padStart(17, "0");
  return `${local}|1|${instant}|${identity}`;
}

async function fixture(client, input = {}) {
  const ids = Object.fromEntries(
    [
      "user",
      "space",
      "account",
      "item",
      "revision",
      "parserArtifact",
      "textVersion",
      "page",
      "span",
      "entity",
      "generation",
      "event",
      "eventVersion",
      "observation",
    ].map((key) => [key, newKithId()]),
  );
  const text = input.text ?? "A😀B synthetic glucose 4.2";
  const marker = text.indexOf("synthetic");
  const quoteStart = input.quoteStart ?? (marker < 0 ? 5 : marker);
  const quoteEnd = input.quoteEnd ?? text.length;
  const occurrence = input.occurrence ?? {
    precision: "date",
    date: "2026-09-12",
  };
  const eventType = input.eventType ?? "lab_panel";
  const observationType = input.observationType ?? "glucose";
  const observationKey = input.observationKey ?? observationType;
  const value =
    input.value ?? { type: "decimal", value: "4.2", unitCode: "mmol/L" };
  const entityKind = input.entityKind ?? "person";
  const card = eventType.endsWith("_card");
  const parsed = input.parsed === true;
  const activatedAt = input.activatedAt ?? new Date("2026-09-12T10:00:00Z");

  await client.query(
    "INSERT INTO kith.users(id,created_at,name) VALUES ($1,transaction_timestamp(),'Synthetic user')",
    [ids.user],
  );
  await client.query(
    "INSERT INTO kith.spaces(id,created_at,kind,name,created_by) VALUES ($1,transaction_timestamp(),'personal','Synthetic space',$2)",
    [ids.space, ids.user],
  );
  await client.query(
    `INSERT INTO kith.entities
       (id,space_id,created_at,user_id,key,kind,canonical_name,normalized_name,aliases,normalized_aliases)
     VALUES ($1,$2,transaction_timestamp(),$3,'synthetic-subject',$4,'Synthetic subject','synthetic subject','[]','[]')`,
    [ids.entity, ids.space, ids.user, entityKind],
  );
  await client.query(
    `INSERT INTO kith.source_accounts
       (id,space_id,created_at,connector,account_id,name,enabled,subject_entity_id,created_by)
     VALUES ($1,$2,transaction_timestamp(),'synthetic','synthetic-account','Synthetic account',true,$3,$4)`,
    [ids.account, ids.space, ids.entity, ids.user],
  );
  await client.query(
    `INSERT INTO kith.source_items
       (id,space_id,created_at,source_account_id,external_id_hash,lifecycle,original_link_available,desired_processing_epoch)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,'available',true,1)`,
    [ids.item, ids.space, ids.account, "a".repeat(64)],
  );
  const textHash = await sha256(text);
  if (parsed) {
    await client.query(
      `INSERT INTO kith.source_revisions
         (id,space_id,created_at,source_item_id,content_hash,byte_length,media_type,
          representation,content_hash_authority,captured_at,user_id)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,100,'application/pdf',
          'archived_binary_v1','worker_asserted',transaction_timestamp(),$5)`,
      [ids.revision, ids.space, ids.item, "a".repeat(64), ids.user],
    );
    await client.query(
      `INSERT INTO kith.source_parser_artifacts
         (id,space_id,created_at,source_account_id,source_item_id,source_revision_id,
          client_artifact_id,parser_fingerprint,output_hash,output_byte_length,
          output_media_type,hash_authority,user_id,created_at_field)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,'synthetic-artifact',
          'synthetic-parser',$6,$7,'application/json','worker_asserted',$8,
          transaction_timestamp())`,
      [
        ids.parserArtifact,
        ids.space,
        ids.account,
        ids.item,
        ids.revision,
        textHash,
        Buffer.byteLength(text),
        ids.user,
      ],
    );
    await client.query(
      `INSERT INTO kith.source_text_versions
         (id,space_id,created_at,source_revision_id,extraction_fingerprint,
          representation,text_hash,text_hash_authority,byte_length,utf16_length,
          page_count,mapping_manifest_hash,parser_artifact_id,evidence_sealed)
       VALUES ($1,$2,transaction_timestamp(),$3,'synthetic-extraction',
          'parsed_pages_v1',$4,'server_verified_retained_text',$5,$6,1,$7,$8,true)`,
      [
        ids.textVersion,
        ids.space,
        ids.revision,
        textHash,
        Buffer.byteLength(text),
        text.length,
        "b".repeat(64),
        ids.parserArtifact,
      ],
    );
  } else {
    await client.query(
      `INSERT INTO kith.source_revisions
         (id,space_id,created_at,source_item_id,content_hash,byte_length,media_type,
          representation,content_hash_authority,inline_text,captured_at,user_id)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,'text/plain',
          'inline_utf8_v1','server_verified_utf8',$6,transaction_timestamp(),$7)`,
      [
        ids.revision,
        ids.space,
        ids.item,
        textHash,
        Buffer.byteLength(text),
        text,
        ids.user,
      ],
    );
    await client.query(
      `INSERT INTO kith.source_text_versions
         (id,space_id,created_at,source_revision_id,extraction_fingerprint,
          representation,text,text_hash,text_hash_authority,byte_length,evidence_sealed)
       VALUES ($1,$2,transaction_timestamp(),$3,'synthetic-extraction',
          'inline_text_v1',$4,$5,'server_verified_retained_text',$6,true)`,
      [
        ids.textVersion,
        ids.space,
        ids.revision,
        text,
        textHash,
        Buffer.byteLength(text),
      ],
    );
  }
  await client.query(
    `INSERT INTO kith.source_pages
       (id,space_id,created_at,source_text_version_id,ordinal,start,"end",text,text_hash)
     VALUES ($1,$2,transaction_timestamp(),$3,0,0,$4,$5,$6)`,
    [ids.page, ids.space, ids.textVersion, text.length, text, textHash],
  );
  const quote = text.slice(quoteStart, quoteEnd);
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
      await sha256(quote),
    ],
  );
  await client.query(
    `INSERT INTO kith.processing_generations
       (id,space_id,created_at,source_account_id,source_item_id,source_revision_id,
        source_text_version_id,parser_artifact_id,card_generation,state,activated_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,'ready',$9)`,
    [
      ids.generation,
      ids.space,
      ids.account,
      ids.item,
      ids.revision,
      ids.textVersion,
      parsed ? ids.parserArtifact : null,
      card,
      activatedAt,
    ],
  );
  await client.query(
    `UPDATE kith.source_items
     SET active_revision_id=$1, ${card ? "active_card_generation_id" : "active_generation_id"}=$2
     WHERE id=$3`,
    [ids.revision, ids.generation, ids.item],
  );
  await client.query(
    `INSERT INTO kith.events
       (id,space_id,created_at,source_account_id,source_item_id,event_key,created_by)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6)`,
    [
      ids.event,
      ids.space,
      ids.account,
      ids.item,
      card ? `card:${eventType}` : "synthetic-event",
      ids.user,
    ],
  );
  const occurrenceDate =
    occurrence.precision === "unknown"
      ? null
      : occurrence.precision === "date"
        ? occurrence.date
        : new Date(occurrence.instant).toISOString().slice(0, 10);
  const occurrenceInstant =
    occurrence.precision === "datetime" ? new Date(occurrence.instant) : null;
  const fieldEvidence = {
    occurrence: [ids.span],
    entity: [ids.span],
    eventType: [ids.span],
  };
  await client.query(
    `INSERT INTO kith.event_versions
       (id,space_id,created_at,source_account_id,source_item_id,source_revision_id,
        source_text_version_id,processing_generation_id,event_id,entity_id,event_type,
        schema_version,occurrence,occurrence_date,occurrence_instant,
        occurrence_sort_key,field_evidence,user_id)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14,$15,$16)`,
    [
      ids.eventVersion,
      ids.space,
      ids.account,
      ids.item,
      ids.revision,
      ids.textVersion,
      ids.generation,
      ids.event,
      ids.entity,
      eventType,
      occurrence,
      occurrenceDate,
      occurrenceInstant,
      sortKey(occurrence, `${ids.event}|${ids.generation}`),
      fieldEvidence,
      ids.user,
    ],
  );
  await client.query(
    `INSERT INTO kith.observations
       (id,space_id,created_at,source_account_id,source_item_id,source_revision_id,
        source_text_version_id,processing_generation_id,event_id,event_version_id,
        entity_id,event_type,occurrence,occurrence_date,occurrence_instant,
        occurrence_sort_key,observation_key,observation_type,schema_version,
        value,value_evidence,user_id)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1,$18,$19,$20)`,
    [
      ids.observation,
      ids.space,
      ids.account,
      ids.item,
      ids.revision,
      ids.textVersion,
      ids.generation,
      ids.event,
      ids.eventVersion,
      ids.entity,
      eventType,
      occurrence,
      occurrenceDate,
      occurrenceInstant,
      sortKey(
        occurrence,
        `${ids.event}|${observationKey}|${ids.generation}`,
      ),
      observationKey,
      observationType,
      value,
      JSON.stringify([ids.span]),
      ids.user,
    ],
  );
  return { ids, text, quote, occurrence };
}

async function database(t) {
  const db = await throwawayDatabase(t);
  const client = await connect(db);
  await applyKithSchema(client);
  return { db, client };
}

test(
  "current text and card records hydrate with transaction-bound cache narrowing",
  { skip },
  async (t) => {
    const { db, client } = await database(t);
    const textRecord = await fixture(client);
    const cardClient = await connect(db);
    const card = await fixture(cardClient, {
      eventType: "document_card",
      observationType: "card_title",
      observationKey: "card_title",
      value: { type: "text", value: "Synthetic title" },
    });
    const cache = records.createRecordHydrationCache(client);
    const hydrated = await records.hydrateObservation(client, {
      spaceId: textRecord.ids.space,
      observationId: textRecord.ids.observation,
      cache,
    });
    assert.equal(hydrated.sourceText, textRecord.text);
    assert.deepEqual(hydrated.evidence.map((item) => item.quote), [
      textRecord.quote,
    ]);
    assert.equal(
      cache.evidenceQuoteUtf8Bytes,
      Buffer.byteLength(textRecord.quote),
      "repeated references charge one deduplicated quote",
    );
    const charged = cache.loadedUtf8Bytes;
    await records.hydrateObservation(client, {
      spaceId: textRecord.ids.space,
      observationId: textRecord.ids.observation,
      cache,
    });
    assert.equal(cache.loadedUtf8Bytes, charged, "cache hits do not reload text");
    await assert.rejects(
      records.hydrateObservation(client, {
        spaceId: textRecord.ids.space,
        observationId: textRecord.ids.observation,
        sourceAccountIds: [],
        cache,
      }),
      /outside the requested scope/,
    );
    await assert.rejects(
      records.hydrateObservation(cardClient, {
        spaceId: textRecord.ids.space,
        observationId: textRecord.ids.observation,
        cache,
      }),
      /another database transaction/,
    );
    const hydratedCard = await records.hydrateObservation(cardClient, {
      spaceId: card.ids.space,
      observationId: card.ids.observation,
    });
    assert.equal(hydratedCard.eventVersion.eventType, "document_card");
    assert.equal(hydratedCard.generation.id, card.ids.generation);
  },
);

test(
  "historical intervals are half-open and replacement hides the prior current version",
  { skip },
  async (t) => {
    const { client } = await database(t);
    const old = await fixture(client);
    const replacementId = newKithId();
    const replacedAt = new Date("2026-09-12T11:00:00Z");
    await client.query(
      `INSERT INTO kith.processing_generations
         (id,space_id,created_at,source_account_id,source_item_id,source_revision_id,
          source_text_version_id,card_generation,state,activated_at)
       SELECT $1,space_id,transaction_timestamp(),source_account_id,source_item_id,
          source_revision_id,source_text_version_id,false,'ready',$2
       FROM kith.processing_generations WHERE id=$3`,
      [replacementId, replacedAt, old.ids.generation],
    );
    await client.query(
      "UPDATE kith.processing_generations SET deactivated_at=$1 WHERE id=$2",
      [replacedAt, old.ids.generation],
    );
    await client.query(
      "UPDATE kith.source_items SET active_generation_id=$1 WHERE id=$2",
      [replacementId, old.ids.item],
    );
    await assert.rejects(
      records.hydrateEventVersion(client, {
        spaceId: old.ids.space,
        eventVersionId: old.ids.eventVersion,
      }),
      /valid current generation/,
    );
    const historical = await records.hydrateEventVersion(client, {
      spaceId: old.ids.space,
      eventVersionId: old.ids.eventVersion,
      snapshot: new Date(replacedAt.getTime() - 1),
    });
    assert.equal(historical.eventVersion.id, old.ids.eventVersion);
    await assert.rejects(
      records.hydrateEventVersion(client, {
        spaceId: old.ids.space,
        eventVersionId: old.ids.eventVersion,
        snapshot: replacedAt,
      }),
      /not active at the snapshot/,
    );
    await client.query(
      "UPDATE kith.source_items SET lifecycle='forgetting' WHERE id=$1",
      [old.ids.item],
    );
    await assert.rejects(
      records.hydrateEventVersion(client, {
        spaceId: old.ids.space,
        eventVersionId: old.ids.eventVersion,
        snapshot: new Date(replacedAt.getTime() - 1),
      }),
      /not readable/,
    );
  },
);

test(
  "parsed-page hydration requires sealed text and the matching verified parser artifact",
  { skip },
  async (t) => {
    const { client } = await database(t);
    const item = await fixture(client, { parsed: true });
    const hydrated = await records.hydrateObservation(client, {
      spaceId: item.ids.space,
      observationId: item.ids.observation,
    });
    assert.equal(hydrated.representation, "parsed_pages_v1");
    assert.equal("sourceText" in hydrated, false);
    assert.equal(hydrated.evidence[0].quote, item.quote);

    await client.query(
      "UPDATE kith.source_text_versions SET evidence_sealed=false, text_hash_authority=NULL WHERE id=$1",
      [item.ids.textVersion],
    );
    await assert.rejects(
      records.hydrateObservation(client, {
        spaceId: item.ids.space,
        observationId: item.ids.observation,
      }),
      /representation pair is invalid/,
    );
    await client.query(
      "UPDATE kith.source_text_versions SET evidence_sealed=true WHERE id=$1",
      [item.ids.textVersion],
    );
    await assert.rejects(
      records.hydrateObservation(client, {
        spaceId: item.ids.space,
        observationId: item.ids.observation,
      }),
      /verification state is invalid/,
    );
    await client.query(
      "UPDATE kith.source_text_versions SET text_hash_authority='server_verified_retained_text' WHERE id=$1",
      [item.ids.textVersion],
    );
    // A second, genuinely distinct artifact of the same revision: the check under
    // test is `generation.parserArtifactId === text.parserArtifactId`, so what
    // matters is that the text version points at another artifact *id*. Its
    // parser fingerprint is varied because migration 020 makes
    // `(source_revision_id, parser_fingerprint)` unique -- two artifacts sharing
    // one fingerprint was never a legal state, and this fixture no longer needs
    // to manufacture one to reach the mismatch it is asserting.
    const otherArtifact = newKithId();
    await client.query(
      `INSERT INTO kith.source_parser_artifacts
         (id,space_id,created_at,source_account_id,source_item_id,source_revision_id,
          client_artifact_id,parser_fingerprint,output_hash,output_byte_length,
          output_media_type,hash_authority,user_id,created_at_field)
       SELECT $1,space_id,transaction_timestamp(),source_account_id,source_item_id,
          source_revision_id,'other-artifact',parser_fingerprint||'-other',output_hash,
          output_byte_length,output_media_type,hash_authority,user_id,
          transaction_timestamp()
       FROM kith.source_parser_artifacts WHERE id=$2`,
      [otherArtifact, item.ids.parserArtifact],
    );
    await client.query(
      "UPDATE kith.source_text_versions SET parser_artifact_id=$1 WHERE id=$2",
      [otherArtifact, item.ids.textVersion],
    );
    await assert.rejects(
      records.hydrateObservation(client, {
        spaceId: item.ids.space,
        observationId: item.ids.observation,
      }),
      /representation pair is invalid/,
    );
  },
);

test(
  "space scope and entity-valued observations fail closed across spaces",
  { skip },
  async (t) => {
    const { client } = await database(t);
    const local = await fixture(client, {
      eventType: "document_card",
      observationType: "card_party",
      observationKey: "card_party:0",
      value: { type: "text", value: "Synthetic party" },
    });
    const foreign = await fixture(client);
    const cache = records.createRecordHydrationCache(client);
    await records.hydrateObservation(client, {
      spaceId: local.ids.space,
      observationId: local.ids.observation,
      cache,
    });
    await assert.rejects(
      records.hydrateObservation(client, {
        spaceId: foreign.ids.space,
        observationId: local.ids.observation,
        cache,
      }),
      /belongs to another space/,
    );
    await client.query(
      "UPDATE kith.observations SET value=$1 WHERE id=$2",
      [
        { type: "entity", entityId: foreign.ids.entity },
        local.ids.observation,
      ],
    );
    await assert.rejects(
      records.hydrateObservation(client, {
        spaceId: local.ids.space,
        observationId: local.ids.observation,
      }),
      /entity belongs to another space/,
    );
  },
);

test(
  "hydration rejects malformed shapes, noncanonical values, bad indexes, hashes, schemas, and UTF-16 ranges",
  { skip },
  async (t) => {
    const { client } = await database(t);
    const item = await fixture(client);
    const rejectObservation = (pattern) =>
      assert.rejects(
        records.hydrateObservation(client, {
          spaceId: item.ids.space,
          observationId: item.ids.observation,
        }),
        pattern,
      );
    await client.query(
      "UPDATE kith.observations SET value=$1 WHERE id=$2",
      [{ unitCode: "mmol/L", type: "decimal", value: "4.2" }, item.ids.observation],
    );
    await records.hydrateObservation(client, {
      spaceId: item.ids.space,
      observationId: item.ids.observation,
    });
    await client.query(
      "UPDATE kith.observations SET value=$1 WHERE id=$2",
      [{ type: "decimal", value: "04.20", unitCode: "mmol/L" }, item.ids.observation],
    );
    await rejectObservation(/not canonical/);
    await client.query(
      "UPDATE kith.observations SET value=$1 WHERE id=$2",
      [{ type: "decimal", value: "4.2", unitCode: "mmol/L", extra: true }, item.ids.observation],
    );
    await rejectObservation(/malformed/);
    await client.query(
      "UPDATE kith.observations SET value=$1 WHERE id=$2",
      [{ type: "decimal", value: "4.2", unitCode: "mmol/L" }, item.ids.observation],
    );
    await client.query(
      "UPDATE kith.event_versions SET doc_type_patch=$1 WHERE id=$2",
      [JSON.stringify([{ documentId: item.ids.event, appliedDocType: "report", extra: true }]), item.ids.eventVersion],
    );
    await rejectObservation(/document type patch is malformed/);
    await client.query(
      "UPDATE kith.event_versions SET doc_type_patch=NULL WHERE id=$1",
      [item.ids.eventVersion],
    );
    await client.query(
      "UPDATE kith.observations SET value=$1, observation_type=NULL WHERE id=$2",
      [{ type: "decimal", value: "4.2", unitCode: "mmol/L" }, item.ids.observation],
    );
    await rejectObservation(/observation type is malformed/);
    await client.query(
      "UPDATE kith.observations SET observation_type='glucose', user_id=NULL WHERE id=$1",
      [item.ids.observation],
    );
    await rejectObservation(/observation user is malformed/);
    await client.query(
      "UPDATE kith.observations SET user_id=$1 WHERE id=$2",
      [item.ids.user, item.ids.observation],
    );
    await client.query(
      "UPDATE kith.observations SET value=$1, occurrence_sort_key='wrong' WHERE id=$2",
      [{ type: "decimal", value: "4.2", unitCode: "mmol/L" }, item.ids.observation],
    );
    await rejectObservation(/index fields/);
    await client.query(
      "UPDATE kith.observations SET occurrence_sort_key=$1 WHERE id=$2",
      [sortKey(item.occurrence, `${item.ids.event}|glucose|${item.ids.generation}`), item.ids.observation],
    );
    await client.query(
      "UPDATE kith.source_pages SET text_hash=$1 WHERE id=$2",
      ["f".repeat(64), item.ids.page],
    );
    await rejectObservation(/page hash/);
    await client.query(
      "UPDATE kith.source_pages SET text_hash=$1 WHERE id=$2",
      [await sha256(item.text), item.ids.page],
    );
    await client.query(
      "UPDATE kith.evidence_spans SET quote_hash=$1 WHERE id=$2",
      ["d".repeat(64), item.ids.span],
    );
    await rejectObservation(/quote hash/);
    await client.query(
      "UPDATE kith.evidence_spans SET quote_hash=$1 WHERE id=$2",
      [await sha256(item.quote), item.ids.span],
    );
    await client.query(
      'UPDATE kith.evidence_spans SET start=2,"end"=3 WHERE id=$1',
      [item.ids.span],
    );
    await rejectObservation(/splits a UTF-16 surrogate pair/);
    await client.query(
      'UPDATE kith.evidence_spans SET start=$1,"end"=$2 WHERE id=$3',
      [item.text.indexOf("synthetic"), item.text.length, item.ids.span],
    );
    await client.query(
      "UPDATE kith.entities SET kind='organization' WHERE id=$1",
      [item.ids.entity],
    );
    await rejectObservation(/Lab panels must belong/);
    await client.query("UPDATE kith.entities SET kind='person' WHERE id=$1", [
      item.ids.entity,
    ]);
    await client.query(
      "UPDATE kith.event_versions SET event_type='financial_transaction' WHERE id=$1",
      [item.ids.eventVersion],
    );
    await client.query(
      "UPDATE kith.observations SET event_type='financial_transaction' WHERE id=$1",
      [item.ids.observation],
    );
    await rejectObservation(/must use money/);
    await client.query(
      "UPDATE kith.source_revisions SET content_hash=$1 WHERE id=$2",
      ["e".repeat(64), item.ids.revision],
    );
    await assert.rejects(
      records.hydrateEventVersion(client, {
        spaceId: item.ids.space,
        eventVersionId: item.ids.eventVersion,
      }),
      /hash or byte length/,
    );
    await client.query(
      "UPDATE kith.source_revisions SET content_hash=$1, representation='archived_binary_v1' WHERE id=$2",
      [await sha256(item.text), item.ids.revision],
    );
    await assert.rejects(
      records.hydrateEventVersion(client, {
        spaceId: item.ids.space,
        eventVersionId: item.ids.eventVersion,
      }),
      /Archived binary source revision fields are invalid/,
    );
  },
);

test("activation timestamps must be valid non-negative half-open intervals", { skip }, async (t) => {
  const { client } = await database(t);
  const item = await fixture(client);
  await client.query(
    "UPDATE kith.processing_generations SET activated_at=$1 WHERE id=$2",
    [new Date(-1), item.ids.generation],
  );
  await assert.rejects(
    records.hydrateEventVersion(client, {
      spaceId: item.ids.space,
      eventVersionId: item.ids.eventVersion,
    }),
    /activation interval is invalid/,
  );
});

test("field and total evidence-reference bounds match the record contract", { skip }, async (t) => {
  const { client } = await database(t);
  const item = await fixture(client);
  const extraIds = Array.from({ length: 15 }, () => newKithId());
  for (const [ordinal, id] of extraIds.entries()) {
    await client.query(
      `INSERT INTO kith.evidence_spans
         (id,space_id,created_at,source_revision_id,source_text_version_id,
          source_page_id,ordinal,start,"end",quote_hash)
       SELECT $1,space_id,transaction_timestamp(),source_revision_id,
          source_text_version_id,source_page_id,$2,start,"end",quote_hash
       FROM kith.evidence_spans WHERE id=$3`,
      [id, ordinal + 1, item.ids.span],
    );
  }
  const sixteen = [item.ids.span, ...extraIds];
  const fields = { occurrence: sixteen, entity: sixteen, eventType: sixteen };
  await client.query(
    "UPDATE kith.event_versions SET field_evidence=$1 WHERE id=$2",
    [fields, item.ids.eventVersion],
  );
  await client.query(
    "UPDATE kith.observations SET value_evidence=$1 WHERE id=$2",
    [JSON.stringify(sixteen), item.ids.observation],
  );
  const hydrated = await records.hydrateObservation(client, {
    spaceId: item.ids.space,
    observationId: item.ids.observation,
  });
  assert.equal(hydrated.evidence.length, 16);

  await client.query(
    "UPDATE kith.event_versions SET field_evidence=$1 WHERE id=$2",
    [{ ...fields, occurrence: [...sixteen, newKithId()] }, item.ids.eventVersion],
  );
  await assert.rejects(
    records.hydrateEventVersion(client, {
      spaceId: item.ids.space,
      eventVersionId: item.ids.eventVersion,
    }),
    /1-16 unique evidence spans/,
  );
});

test(
  "hydration budgets include inline text and remain exhausted after refusal",
  { skip },
  async (t) => {
    const { client } = await database(t);
    const item = await fixture(client, { text: `A😀B ${"x".repeat(9_000)}` });
    const cache = records.createRecordHydrationCache(client, {
      maxLoadedUtf8Bytes: 1,
    });
    await assert.rejects(
      records.hydrateObservation(client, {
        spaceId: item.ids.space,
        observationId: item.ids.observation,
        cache,
      }),
      /loaded-byte limit/,
    );
    assert.equal(cache.exhausted, true);
    await assert.rejects(
      records.hydrateObservation(client, {
        spaceId: item.ids.space,
        observationId: item.ids.observation,
        cache,
      }),
      /budget is exhausted/,
    );

    const dedup = records.createRecordHydrationCache(client, {
      maxLoadedUtf8Bytes: 64 * 1_024,
      maxEvidenceQuoteUtf8Bytes: 16 * 1_024,
    });
    const hydrated = await records.hydrateObservation(client, {
      spaceId: item.ids.space,
      observationId: item.ids.observation,
      cache: dedup,
    });
    assert.equal(hydrated.evidence.length, 1);
    assert.equal(
      dedup.evidenceQuoteUtf8Bytes,
      Buffer.byteLength(item.quote),
      "four references below 16 KiB deduplicate to one quote",
    );
  },
);
