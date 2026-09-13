import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  applyKithSchema,
  coverage,
  newKithId,
  records,
  withKithTransaction,
} from "../dist/index.js";
import * as identity from "../dist/identity/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

const NOW = 1_800_000_000_000,
  FROM = Date.parse("2026-01-01T00:00:00Z"),
  TO = Date.parse("2026-02-01T00:00:00Z");
async function sha(value) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
}
function sortKey(occurrence, identity) {
  if (occurrence.precision === "unknown") return null;
  if (occurrence.precision === "date")
    return `${occurrence.date}|0|${identity}`;
  const date = new Date(occurrence.instant).toISOString().slice(0, 10),
    instant = (BigInt(occurrence.instant) + BigInt(Number.MAX_SAFE_INTEGER))
      .toString()
      .padStart(17, "0");
  return `${date}|1|${instant}|${identity}`;
}

async function setup(t) {
  const db = await throwawayDatabase(t),
    client = await connect(db);
  await applyKithSchema(client);
  const pool = db.adopt(new pg.Pool({ connectionString: db.url, max: 4 }));
  const ids = Object.fromEntries(
    ["user", "space", "member", "entity", "account"].map((k) => [
      k,
      newKithId(),
    ]),
  );
  await client.query(
    "INSERT INTO kith.users(id,created_at,name) VALUES($1,transaction_timestamp(),'Query user')",
    [ids.user],
  );
  await client.query(
    "INSERT INTO kith.spaces(id,created_at,kind,name,created_by) VALUES($1,transaction_timestamp(),'personal','Query space',$2)",
    [ids.space, ids.user],
  );
  await client.query(
    "INSERT INTO kith.space_members(id,space_id,created_at,user_id,role) VALUES($1,$2,transaction_timestamp(),$3,'owner')",
    [ids.member, ids.space, ids.user],
  );
  await client.query(
    "INSERT INTO kith.entities(id,space_id,created_at,user_id,key,kind,canonical_name,normalized_name,aliases,normalized_aliases) VALUES($1,$2,transaction_timestamp(),$3,'person','person','Person','person','[]','[]')",
    [ids.entity, ids.space, ids.user],
  );
  await client.query(
    "INSERT INTO kith.source_accounts(id,space_id,created_at,connector,account_id,name,enabled,subject_entity_id,freshness_ms,created_by) VALUES($1,$2,transaction_timestamp(),'synthetic','query-account','Query account',true,$3,86400000,$4)",
    [ids.account, ids.space, ids.entity, ids.user],
  );
  return { client, pool, ids };
}

async function addItem(client, base, index, date, feeCount = 1) {
  const ids = Object.fromEntries(
      [
        "item",
        "revision",
        "textVersion",
        "page",
        "span",
        "generation",
        "event",
        "eventVersion",
      ].map((k) => [k, newKithId()]),
    ),
    text = `synthetic transaction ${index}`,
    hash = await sha(text),
    occurrence = { precision: "date", date };
  await client.query(
    "INSERT INTO kith.source_items(id,space_id,created_at,source_account_id,external_id_hash,lifecycle,original_link_available,desired_processing_epoch) VALUES($1,$2,transaction_timestamp(),$3,$4,'available',true,1)",
    [ids.item, base.space, base.account, index.toString(16).padStart(64, "0")],
  );
  await client.query(
    "INSERT INTO kith.source_revisions(id,space_id,created_at,source_item_id,content_hash,byte_length,media_type,representation,content_hash_authority,inline_text,captured_at,user_id) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,'text/plain','inline_utf8_v1','server_verified_utf8',$6,transaction_timestamp(),$7)",
    [
      ids.revision,
      base.space,
      ids.item,
      hash,
      Buffer.byteLength(text),
      text,
      base.user,
    ],
  );
  await client.query(
    "INSERT INTO kith.source_text_versions(id,space_id,created_at,source_revision_id,extraction_fingerprint,representation,text,text_hash,text_hash_authority,byte_length,evidence_sealed) VALUES($1,$2,transaction_timestamp(),$3,$4,'inline_text_v1',$5,$6,'server_verified_retained_text',$7,true)",
    [
      ids.textVersion,
      base.space,
      ids.revision,
      `query-${index}`,
      text,
      hash,
      Buffer.byteLength(text),
    ],
  );
  await client.query(
    'INSERT INTO kith.source_pages(id,space_id,created_at,source_text_version_id,ordinal,start,"end",text,text_hash) VALUES($1,$2,transaction_timestamp(),$3,0,0,$4,$5,$6)',
    [ids.page, base.space, ids.textVersion, text.length, text, hash],
  );
  await client.query(
    'INSERT INTO kith.evidence_spans(id,space_id,created_at,source_revision_id,source_text_version_id,source_page_id,ordinal,start,"end",quote_hash) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,0,0,$6,$7)',
    [
      ids.span,
      base.space,
      ids.revision,
      ids.textVersion,
      ids.page,
      text.length,
      hash,
    ],
  );
  await client.query(
    "INSERT INTO kith.processing_generations(id,space_id,created_at,source_account_id,source_item_id,source_revision_id,source_text_version_id,card_generation,state,activated_at) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6,false,'ready',$7)",
    [
      ids.generation,
      base.space,
      base.account,
      ids.item,
      ids.revision,
      ids.textVersion,
      new Date(100),
    ],
  );
  await client.query(
    "UPDATE kith.source_items SET active_revision_id=$1,active_generation_id=$2 WHERE id=$3",
    [ids.revision, ids.generation, ids.item],
  );
  await client.query(
    "INSERT INTO kith.events(id,space_id,created_at,source_account_id,source_item_id,event_key,created_by) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6)",
    [
      ids.event,
      base.space,
      base.account,
      ids.item,
      `transaction-${index}`,
      base.user,
    ],
  );
  const fields = {
    occurrence: [ids.span],
    entity: [ids.span],
    eventType: [ids.span],
  };
  await client.query(
    "INSERT INTO kith.event_versions(id,space_id,created_at,source_account_id,source_item_id,source_revision_id,source_text_version_id,processing_generation_id,event_id,entity_id,event_type,schema_version,occurrence,occurrence_date,occurrence_sort_key,field_evidence,user_id) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,'financial_transaction',1,$10,$11,$12,$13,$14)",
    [
      ids.eventVersion,
      base.space,
      base.account,
      ids.item,
      ids.revision,
      ids.textVersion,
      ids.generation,
      ids.event,
      base.entity,
      occurrence,
      date,
      sortKey(occurrence, `${ids.event}|${ids.generation}`),
      fields,
      base.user,
    ],
  );
  const observations = [];
  for (let n = 0; n < feeCount + 1; n++) {
    const id = newKithId(),
      key = n === feeCount ? "anchor" : `fee_${index}_${n}`;
    await client.query(
      "INSERT INTO kith.observations(id,space_id,created_at,source_account_id,source_item_id,source_revision_id,source_text_version_id,processing_generation_id,event_id,event_version_id,entity_id,event_type,occurrence,occurrence_date,occurrence_sort_key,observation_key,observation_type,schema_version,value,value_evidence,user_id) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,'financial_transaction',$11,$12,$13,$14,$15,1,$16,$17,$18)",
      [
        id,
        base.space,
        base.account,
        ids.item,
        ids.revision,
        ids.textVersion,
        ids.generation,
        ids.event,
        ids.eventVersion,
        base.entity,
        occurrence,
        date,
        sortKey(occurrence, `${ids.event}|${key}|${ids.generation}`),
        key,
        n === feeCount ? "anchor" : "fee",
        {
          type: "money",
          amount: n === feeCount ? String(index) : "0.01",
          currency: "USD",
        },
        JSON.stringify([ids.span]),
        base.user,
      ],
    );
    observations.push(id);
  }
  return { ...ids, observations, occurrence };
}

async function replaceItem(client, base, prior, date, activatedAt) {
  const ids = Object.fromEntries(
      [
        "revision",
        "textVersion",
        "page",
        "span",
        "generation",
        "eventVersion",
        "observation",
      ].map((key) => [key, newKithId()]),
    ),
    text = "synthetic corrected transaction",
    hash = await sha(text),
    occurrence = { precision: "date", date };
  await client.query(
    "INSERT INTO kith.source_revisions(id,space_id,created_at,source_item_id,content_hash,byte_length,media_type,representation,content_hash_authority,inline_text,captured_at,user_id) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,'text/plain','inline_utf8_v1','server_verified_utf8',$6,transaction_timestamp(),$7)",
    [ids.revision, base.space, prior.item, hash, text.length, text, base.user],
  );
  await client.query(
    "INSERT INTO kith.source_text_versions(id,space_id,created_at,source_revision_id,extraction_fingerprint,representation,text,text_hash,text_hash_authority,byte_length,evidence_sealed) VALUES($1,$2,transaction_timestamp(),$3,'query-correction','inline_text_v1',$4,$5,'server_verified_retained_text',$6,true)",
    [ids.textVersion, base.space, ids.revision, text, hash, text.length],
  );
  await client.query(
    'INSERT INTO kith.source_pages(id,space_id,created_at,source_text_version_id,ordinal,start,"end",text,text_hash) VALUES($1,$2,transaction_timestamp(),$3,0,0,$4,$5,$6)',
    [ids.page, base.space, ids.textVersion, text.length, text, hash],
  );
  await client.query(
    'INSERT INTO kith.evidence_spans(id,space_id,created_at,source_revision_id,source_text_version_id,source_page_id,ordinal,start,"end",quote_hash) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,0,0,$6,$7)',
    [
      ids.span,
      base.space,
      ids.revision,
      ids.textVersion,
      ids.page,
      text.length,
      hash,
    ],
  );
  await client.query(
    "INSERT INTO kith.processing_generations(id,space_id,created_at,source_account_id,source_item_id,source_revision_id,source_text_version_id,card_generation,state,activated_at) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6,false,'ready',$7)",
    [
      ids.generation,
      base.space,
      base.account,
      prior.item,
      ids.revision,
      ids.textVersion,
      new Date(activatedAt),
    ],
  );
  await client.query(
    "UPDATE kith.processing_generations SET deactivated_at=$1 WHERE id=$2",
    [new Date(activatedAt), prior.generation],
  );
  await client.query(
    "UPDATE kith.source_items SET active_revision_id=$1,active_generation_id=$2 WHERE id=$3",
    [ids.revision, ids.generation, prior.item],
  );
  const fields = {
    occurrence: [ids.span],
    entity: [ids.span],
    eventType: [ids.span],
  };
  await client.query(
    "INSERT INTO kith.event_versions(id,space_id,created_at,source_account_id,source_item_id,source_revision_id,source_text_version_id,processing_generation_id,event_id,entity_id,event_type,schema_version,occurrence,occurrence_date,occurrence_sort_key,field_evidence,user_id) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,'financial_transaction',1,$10,$11,$12,$13,$14)",
    [
      ids.eventVersion,
      base.space,
      base.account,
      prior.item,
      ids.revision,
      ids.textVersion,
      ids.generation,
      prior.event,
      base.entity,
      occurrence,
      date,
      sortKey(occurrence, `${prior.event}|${ids.generation}`),
      fields,
      base.user,
    ],
  );
  await client.query(
    "INSERT INTO kith.observations(id,space_id,created_at,source_account_id,source_item_id,source_revision_id,source_text_version_id,processing_generation_id,event_id,event_version_id,entity_id,event_type,occurrence,occurrence_date,occurrence_sort_key,observation_key,observation_type,schema_version,value,value_evidence,user_id) VALUES($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,'financial_transaction',$11,$12,$13,'anchor','anchor',1,$14,$15,$16)",
    [
      ids.observation,
      base.space,
      base.account,
      prior.item,
      ids.revision,
      ids.textVersion,
      ids.generation,
      prior.event,
      ids.eventVersion,
      base.entity,
      occurrence,
      date,
      sortKey(occurrence, `${prior.event}|anchor|${ids.generation}`),
      { type: "money", amount: "9", currency: "USD" },
      JSON.stringify([ids.span]),
      base.user,
    ],
  );
  return ids;
}

async function seed(t) {
  const f = await setup(t);
  const items = [];
  for (let i = 1; i <= 3; i++)
    items.push(await addItem(f.client, f.ids, i, `2026-01-0${i + 1}`, 100));
  await f.client.query(
    "INSERT INTO kith.space_processing_state(id,space_id,created_at,activation_epoch,activated_at) VALUES($1,$2,transaction_timestamp(),1,$3)",
    [newKithId(), f.ids.space, new Date(100)],
  );
  for (const [type, entityId, from, to] of [
    ["fee", undefined, FROM, TO],
    ["fee", f.ids.entity, FROM, TO],
    ["anchor", f.ids.entity, -62_167_219_200_000, 253_402_300_799_999],
    [
      "financial_transaction",
      f.ids.entity,
      -62_167_219_200_000,
      253_402_300_799_999,
    ],
  ])
    await withKithTransaction(f.pool, (tx) =>
      coverage.upsertCoverageWindow(
        { client: tx, now: NOW },
        {
          spaceId: f.ids.space,
          sourceAccountId: f.ids.account,
          recordType: type,
          ...(entityId ? { entityId } : {}),
          from,
          to,
          state: "complete",
          lastEnumeratedAt: NOW,
          lastProcessedAt: NOW,
          discoveredCount: 3,
          indexedCount: 3,
          skippedCount: 0,
        },
      ),
    );
  return { ...f, items };
}
const run = (f, query, now = NOW) =>
  withKithTransaction(f.pool, (tx) =>
    records.executeRecordQuery(
      { client: tx, now },
      { principal: { userId: f.ids.user }, query },
    ),
  );

async function collectSum(f, query, principal, start = NOW) {
  let cursor,
    terminal,
    ids = [];
  for (let page = 0; page < 20; page++) {
    const result = await withKithTransaction(f.pool, (tx) =>
      records.executeRecordQuery(
        { client: tx, now: start + page },
        {
          principal: principal ?? { userId: f.ids.user },
          query: { ...query, ...(cursor ? { cursor } : {}) },
        },
      ),
    );
    ids.push(...result.contributingObservationIds);
    terminal = result;
    cursor = result.cursor;
    if (!cursor) return { terminal, ids };
  }
  throw new Error("sum did not terminate");
}

async function makeReadKey(f) {
  const id = newKithId();
  await f.client.query(
    "INSERT INTO kith.api_keys(id,user_id,key_hash,key_prefix,name,capabilities) VALUES($1,$2,$3,'ob_test','query key',$4)",
    [id, f.ids.user, await sha(id), JSON.stringify(["read"])],
  );
  await f.client.query(
    "INSERT INTO kith.api_key_spaces(id,api_key_id,space_id) VALUES($1,$2,$3)",
    [newKithId(), id, f.ids.space],
  );
  await f.client.query(
    "INSERT INTO kith.api_key_source_accounts(id,api_key_id,source_account_id) VALUES($1,$2,$3)",
    [newKithId(), id, f.ids.account],
  );
  return { userId: f.ids.user, credentialId: id };
}

test(
  "all five typed operations preserve occurrence order and exact multi-page money totals",
  { skip },
  async (t) => {
    const f = await seed(t),
      base = { spaceId: f.ids.space, sourceAccountIds: [f.ids.account] };
    const latestObservation = await run(f, {
      ...base,
      operation: "latest_observation",
      entityId: f.ids.entity,
      observationType: "anchor",
    });
    assert.equal(latestObservation.operation, "latest_observation");
    assert.equal(latestObservation.complete, true);
    assert.equal(latestObservation.candidates[0].occurrence.date, "2026-01-04");
    const latestEvent = await run(f, {
      ...base,
      operation: "latest_event",
      entityId: f.ids.entity,
      eventType: "financial_transaction",
    });
    assert.equal(latestEvent.operation, "latest_event");
    assert.equal(latestEvent.complete, true);
    assert.equal(latestEvent.candidates[0].occurrence.date, "2026-01-04");
    const history = await run(f, {
      ...base,
      operation: "observation_history",
      entityId: f.ids.entity,
      observationType: "anchor",
      from: FROM,
      to: TO,
      order: "desc",
      limit: 2,
    });
    assert.equal(history.operation, "observation_history");
    assert.equal(history.complete, false);
    assert.equal(history.records.length, 2);
    assert.ok(history.cursor);
    const historyEnd = await run(
      f,
      {
        ...base,
        operation: "observation_history",
        entityId: f.ids.entity,
        observationType: "anchor",
        from: FROM,
        to: TO,
        order: "desc",
        limit: 2,
        cursor: history.cursor,
      },
      NOW + 1,
    );
    assert.equal(historyEnd.records.length, 1);
    assert.equal(historyEnd.cursor, undefined);
    assert.equal(historyEnd.complete, true);
    const events = await run(f, {
      ...base,
      operation: "list_events",
      entityId: f.ids.entity,
      eventType: "financial_transaction",
      from: FROM,
      to: TO,
      order: "asc",
    });
    assert.equal(events.operation, "list_events");
    assert.equal(events.records.length, 3);
    assert.equal(events.complete, true);
    const sumQuery = {
        ...base,
        operation: "sum_money",
        sourceAccountId: f.ids.account,
        lineItemType: "fee",
        from: FROM,
        to: TO,
      },
      accountSum = await collectSum(f, sumQuery);
    assert.deepEqual(accountSum.terminal.totals, [
      { currency: "USD", amount: "3" },
    ]);
    assert.equal(accountSum.terminal.status, "total_complete");
    assert.equal(accountSum.terminal.complete, true);
    assert.equal(accountSum.ids.length, 300);
    assert.equal(new Set(accountSum.ids).size, 300);
    const entitySum = await collectSum(f, {
      ...base,
      operation: "sum_money",
      entityId: f.ids.entity,
      lineItemType: "fee",
      from: FROM,
      to: TO,
    });
    assert.deepEqual(entitySum.terminal.totals, accountSum.terminal.totals);
    assert.equal(entitySum.ids.length, 300);
  },
);

test(
  "runtime validation rejects malformed shapes before snapshot mutation",
  { skip },
  async (t) => {
    const f = await setup(t),
      prototype = { entityId: f.ids.entity },
      query = Object.create(prototype);
    Object.assign(query, {
      operation: "latest_event",
      spaceId: f.ids.space,
      eventType: "financial_transaction",
    });
    for (const malformed of [
      query,
      {
        operation: "latest_event",
        spaceId: f.ids.space,
        entityId: undefined,
        eventType: "financial_transaction",
      },
      {
        operation: "list_events",
        spaceId: f.ids.space,
        entityId: f.ids.entity,
        eventType: "financial_transaction",
        from: FROM,
        to: TO,
        order: "sideways",
      },
      {
        operation: "observation_history",
        spaceId: f.ids.space,
        entityId: f.ids.entity,
        observationType: "x",
        from: FROM,
        to: TO,
        order: "asc",
        limit: null,
      },
      {
        operation: "latest_event",
        spaceId: f.ids.space,
        entityId: f.ids.entity,
        eventType: "financial_transaction",
        sourceAccountIds: null,
      },
      {
        operation: "latest_event",
        spaceId: f.ids.space,
        entityId: f.ids.entity,
        eventType: "financial_transaction",
        extra: true,
      },
    ])
      await assert.rejects(run(f, malformed));
    const state = await f.client.query(
      "SELECT count(*)::int AS n FROM kith.record_query_space_state",
    );
    assert.equal(state.rows[0].n, 0);
  },
);

test("complete no-match requires fresh coverage proof", { skip }, async (t) => {
  const f = await seed(t),
    query = {
      operation: "latest_observation",
      spaceId: f.ids.space,
      sourceAccountIds: [f.ids.account],
      entityId: f.ids.entity,
      observationType: "not_recorded",
    };
  const unknown = await run(f, query);
  assert.equal(unknown.status, "no_match_incomplete");
  assert.equal(unknown.complete, false);
  await withKithTransaction(f.pool, (tx) =>
    coverage.upsertCoverageWindow(
      { client: tx, now: NOW },
      {
        spaceId: f.ids.space,
        sourceAccountId: f.ids.account,
        entityId: f.ids.entity,
        recordType: "not_recorded",
        from: -62_167_219_200_000,
        to: 253_402_300_799_999,
        state: "complete",
        lastEnumeratedAt: NOW,
        lastProcessedAt: NOW,
        discoveredCount: 0,
        indexedCount: 0,
        skippedCount: 0,
      },
    ),
  );
  const proven = await run(f, query);
  assert.equal(proven.status, "no_match_complete");
  assert.equal(proven.complete, true);
});

test(
  "latest follows occurrence order and preserves mixed-precision ambiguity",
  { skip },
  async (t) => {
    const f = await seed(t),
      lateOld = await addItem(f.client, f.ids, 4, "2026-01-01", 0),
      query = {
        operation: "latest_observation",
        spaceId: f.ids.space,
        sourceAccountIds: [f.ids.account],
        entityId: f.ids.entity,
        observationType: "anchor",
      };
    const ordered = await run(f, query);
    assert.equal(ordered.candidates.length, 1);
    assert.equal(ordered.candidates[0].sourceItemId, f.items[2].item);
    assert.notEqual(ordered.candidates[0].sourceItemId, lateOld.item);

    const mixed = await addItem(f.client, f.ids, 5, "2026-01-04", 0),
      occurrence = {
        precision: "datetime",
        instant: Date.parse("2026-01-04T12:00:00Z"),
        originalOffset: "Z",
      },
      eventKey = sortKey(occurrence, `${mixed.event}|${mixed.generation}`),
      observationKey = sortKey(
        occurrence,
        `${mixed.event}|anchor|${mixed.generation}`,
      );
    await f.client.query(
      "UPDATE kith.event_versions SET occurrence=$1,occurrence_date=$2,occurrence_instant=$3,occurrence_sort_key=$4 WHERE id=$5",
      [
        occurrence,
        "2026-01-04",
        new Date(occurrence.instant),
        eventKey,
        mixed.eventVersion,
      ],
    );
    await f.client.query(
      "UPDATE kith.observations SET occurrence=$1,occurrence_date=$2,occurrence_instant=$3,occurrence_sort_key=$4 WHERE id=$5",
      [
        occurrence,
        "2026-01-04",
        new Date(occurrence.instant),
        observationKey,
        mixed.observations[0],
      ],
    );
    const ambiguous = await run(f, query);
    assert.equal(ambiguous.candidates.length, 2);
    assert.deepEqual(
      new Set(ambiguous.candidates.map((candidate) => candidate.sourceItemId)),
      new Set([f.items[2].item, mixed.item]),
    );
    const narrow = await run(f, {
      ...query,
      operation: "observation_history",
      from: Date.parse("2026-01-04T06:00:00Z"),
      to: Date.parse("2026-01-04T18:00:00Z"),
      order: "asc",
    });
    assert.equal(narrow.records.length, 1);
    assert.equal(narrow.exclusions.ambiguousTime, 2);
    assert.equal(narrow.complete, false);
  },
);

test(
  "continuations reauthorize membership, credential, grants, and bound scope",
  { skip },
  async (t) => {
    const baseQuery = (f) => ({
      operation: "observation_history",
      spaceId: f.ids.space,
      sourceAccountIds: [f.ids.account],
      entityId: f.ids.entity,
      observationType: "anchor",
      from: FROM,
      to: TO,
      order: "asc",
      limit: 1,
    });

    await t.test("membership removal", async () => {
      const f = await seed(t),
        first = await run(f, baseQuery(f));
      assert.ok(first.cursor);
      await f.client.query("DELETE FROM kith.space_members WHERE id=$1", [
        f.ids.member,
      ]);
      await assert.rejects(
        run(f, { ...baseQuery(f), cursor: first.cursor }, NOW + 1),
      );
    });

    await t.test("credential removal", async () => {
      const f = await seed(t),
        principal = await makeReadKey(f),
        first = await withKithTransaction(f.pool, (tx) =>
          records.executeRecordQuery(
            { client: tx, now: NOW },
            { principal, query: baseQuery(f) },
          ),
        );
      assert.ok(first.cursor);
      await identity.revokeApiKey(identity.identityCtx(f.client, NOW + 1), {
        principal: identity.webPrincipal(f.ids.user),
        id: principal.credentialId,
      });
      await assert.rejects(
        withKithTransaction(f.pool, (tx) =>
          records.executeRecordQuery(
            { client: tx, now: NOW + 1 },
            {
              principal,
              query: { ...baseQuery(f), cursor: first.cursor },
            },
          ),
        ),
      );
    });

    await t.test("space grant removal", async () => {
      const f = await seed(t),
        principal = await makeReadKey(f),
        first = await withKithTransaction(f.pool, (tx) =>
          records.executeRecordQuery(
            { client: tx, now: NOW },
            { principal, query: baseQuery(f) },
          ),
        );
      await f.client.query(
        "DELETE FROM kith.api_key_spaces WHERE api_key_id=$1",
        [principal.credentialId],
      );
      await assert.rejects(
        withKithTransaction(f.pool, (tx) =>
          records.executeRecordQuery(
            { client: tx, now: NOW + 1 },
            {
              principal,
              query: { ...baseQuery(f), cursor: first.cursor },
            },
          ),
        ),
      );
    });

    await t.test("source account grant removal", async () => {
      const f = await seed(t),
        principal = await makeReadKey(f),
        first = await withKithTransaction(f.pool, (tx) =>
          records.executeRecordQuery(
            { client: tx, now: NOW },
            { principal, query: baseQuery(f) },
          ),
        );
      await f.client.query(
        "DELETE FROM kith.api_key_source_accounts WHERE api_key_id=$1",
        [principal.credentialId],
      );
      await assert.rejects(
        withKithTransaction(f.pool, (tx) =>
          records.executeRecordQuery(
            { client: tx, now: NOW + 1 },
            {
              principal,
              query: { ...baseQuery(f), cursor: first.cursor },
            },
          ),
        ),
      );
    });

    const f = await seed(t),
      principal = await makeReadKey(f),
      first = await withKithTransaction(f.pool, (tx) =>
        records.executeRecordQuery(
          { client: tx, now: NOW },
          { principal, query: baseQuery(f) },
        ),
      );
    for (const changed of [
      { ...baseQuery(f), cursor: first.cursor, observationType: "fee" },
      { ...baseQuery(f), cursor: first.cursor, sourceAccountIds: [] },
    ])
      await assert.rejects(
        withKithTransaction(f.pool, (tx) =>
          records.executeRecordQuery(
            { client: tx, now: NOW + 1 },
            { principal, query: changed },
          ),
        ),
      );
    await assert.rejects(
      run(f, { ...baseQuery(f), cursor: first.cursor }, NOW + 1),
    );
  },
);

test(
  "snapshot continuations retain old visibility while current cursors invalidate",
  { skip },
  async (t) => {
    const f = await seed(t),
      query = {
        operation: "observation_history",
        spaceId: f.ids.space,
        sourceAccountIds: [f.ids.account],
        entityId: f.ids.entity,
        observationType: "anchor",
        from: FROM,
        to: TO,
        order: "asc",
        limit: 1,
      },
      snapshot = await run(f, query);
    assert.ok(snapshot.cursor);
    const replacement = await replaceItem(
      f.client,
      f.ids,
      f.items[1],
      "2026-01-05",
      NOW + 1,
    );
    await f.client.query(
      "UPDATE kith.space_processing_state SET activation_epoch=2,activated_at=$1 WHERE space_id=$2",
      [new Date(NOW + 1), f.ids.space],
    );
    const oldPage = await run(
      f,
      { ...query, cursor: snapshot.cursor },
      NOW + 2,
    );
    assert.equal(oldPage.records[0].sourceItemId, f.items[1].item);
    assert.equal(
      oldPage.records[0].observationId,
      f.items[1].observations[100],
    );
    const fresh = await run(
      f,
      {
        operation: "latest_observation",
        spaceId: f.ids.space,
        sourceAccountIds: [f.ids.account],
        entityId: f.ids.entity,
        observationType: "anchor",
      },
      NOW + 2,
    );
    assert.equal(fresh.candidates[0].observationId, replacement.observation);

    const current = await run(f, { ...query, consistency: "current" }, NOW + 2);
    assert.ok(current.cursor);
    await f.client.query(
      "UPDATE kith.space_processing_state SET activation_epoch=3,activated_at=$1 WHERE space_id=$2",
      [new Date(NOW + 3), f.ids.space],
    );
    await assert.rejects(
      run(
        f,
        { ...query, consistency: "current", cursor: current.cursor },
        NOW + 4,
      ),
    );
  },
);

test(
  "an invalid early contribution persists to a truthful terminal partial total",
  { skip },
  async (t) => {
    const f = await seed(t);
    await f.client.query(
      "UPDATE kith.observations SET source_revision_id=$1 WHERE id=$2",
      [f.items[1].revision, f.items[0].observations[0]],
    );
    const result = await collectSum(f, {
      operation: "sum_money",
      spaceId: f.ids.space,
      sourceAccountIds: [f.ids.account],
      sourceAccountId: f.ids.account,
      lineItemType: "fee",
      from: FROM,
      to: TO,
    });
    assert.deepEqual(result.terminal.totals, [
      { currency: "USD", amount: "2.99" },
    ]);
    assert.equal(result.terminal.status, "total_partial");
    assert.equal(result.terminal.complete, false);
    assert.equal(result.terminal.exclusions.invalid, 1);
    assert.equal(result.ids.length, 299);
  },
);

test(
  "an empty terminal page consumes its cursor and denies replay",
  { skip },
  async (t) => {
    const f = await seed(t),
      query = {
        operation: "observation_history",
        spaceId: f.ids.space,
        sourceAccountIds: [f.ids.account],
        entityId: f.ids.entity,
        observationType: "anchor",
        from: FROM,
        to: TO,
        order: "asc",
        limit: 1,
      },
      first = await run(f, query);
    assert.ok(first.cursor);
    await f.client.query(
      "UPDATE kith.observations SET source_revision_id=$1 WHERE id=ANY($2::kith.kith_id[])",
      [
        f.items[0].revision,
        [f.items[1].observations[100], f.items[2].observations[100]],
      ],
    );
    const terminal = await run(f, { ...query, cursor: first.cursor }, NOW + 1);
    assert.equal(terminal.records.length, 0);
    assert.equal(terminal.cursor, undefined);
    assert.equal(terminal.exclusions.invalid, 2);
    await assert.rejects(run(f, { ...query, cursor: first.cursor }, NOW + 2));

    const empty = await seed(t),
      emptyQuery = {
        ...query,
        spaceId: empty.ids.space,
        sourceAccountIds: [empty.ids.account],
        entityId: empty.ids.entity,
      },
      emptyFirst = await run(empty, emptyQuery);
    await empty.client.query(
      "DELETE FROM kith.observations WHERE id=ANY($1::kith.kith_id[])",
      [[empty.items[1].observations[100], empty.items[2].observations[100]]],
    );
    const noCandidates = await run(
      empty,
      { ...emptyQuery, cursor: emptyFirst.cursor },
      NOW + 1,
    );
    assert.equal(noCandidates.records.length, 0);
    assert.equal(noCandidates.cursor, undefined);
    await assert.rejects(
      run(empty, { ...emptyQuery, cursor: emptyFirst.cursor }, NOW + 2),
    );
  },
);

test(
  "serialization retry creates one cursor for one page",
  { skip },
  async (t) => {
    const f = await seed(t);
    await f.client.query("CREATE SEQUENCE kith.query_retry_once");
    await f.client.query(`CREATE FUNCTION kith.raise_query_retry_once()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('kith.query_retry_once') = 1 THEN
          RAISE EXCEPTION 'synthetic serialization retry' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END
      $$`);
    await f.client.query(`CREATE TRIGGER query_retry_once
      BEFORE INSERT ON kith.record_query_sessions
      FOR EACH ROW EXECUTE FUNCTION kith.raise_query_retry_once()`);
    const page = await run(f, {
      operation: "observation_history",
      spaceId: f.ids.space,
      sourceAccountIds: [f.ids.account],
      entityId: f.ids.entity,
      observationType: "anchor",
      from: FROM,
      to: TO,
      order: "asc",
      limit: 1,
    });
    assert.equal(page.records.length, 1);
    assert.ok(page.cursor);
    const sessions = await f.client.query(
      "SELECT id FROM kith.record_query_sessions",
    );
    assert.deepEqual(
      sessions.rows.map((row) => row.id),
      [page.cursor],
    );
  },
);
