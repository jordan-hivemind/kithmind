// Against a real, throwaway Postgres server this suite starts and stops
// itself (test/helpers/localPostgres.mjs): seeds a synthetic person profile,
// upserts a mixed page of health records (and a document) twice, and asserts
// both idempotency and `@repo/kith-store`'s overview read model. Skips
// cleanly when `initdb`/`pg_ctl` are not on PATH.
//
// Synthetic fixtures throughout -- no real patient data anywhere here.

import assert from "node:assert/strict";
import test from "node:test";

import { admin } from "@repo/kith-store";
import { identityCtx } from "@repo/kith-store/identity";
import pg from "pg";

import {
  mapResource,
  openPool,
  upsertHealthDocument,
  upsertHealthRecord,
  upsertHealthSource,
} from "../dist/index.js";

import { localPostgresAvailable, startLocalPostgres } from "./helpers/localPostgres.mjs";

const available = await localPostgresAvailable();

function newId() {
  // A local, dependency-free stand-in for `newKithId()` (26 lowercase
  // base32-ish characters) -- good enough for a synthetic fixture's own row
  // ids, which need only to be unique and to satisfy the `kith_id` domain's
  // shape check.
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let id = "";
  for (let i = 0; i < 26; i += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

const MIXED_PAGE = [
  {
    resourceType: "Observation",
    raw: {
      resourceType: "Observation",
      id: "obs-1",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: { text: "Potassium" },
      effectiveDateTime: "2026-09-01T09:00:00Z",
      valueQuantity: { value: 4.1, unit: "mmol/L" },
    },
  },
  {
    resourceType: "Condition",
    raw: {
      resourceType: "Condition",
      id: "cond-1",
      clinicalStatus: { coding: [{ code: "active" }] },
      code: { text: "Seasonal allergic rhinitis" },
      onsetDateTime: "2020-04-01",
    },
  },
  {
    resourceType: "MedicationRequest",
    raw: {
      resourceType: "MedicationRequest",
      id: "mr-1",
      status: "active",
      medicationCodeableConcept: { text: "Cetirizine 10 MG Oral Tablet" },
      authoredOn: "2026-04-01",
    },
  },
  {
    resourceType: "Encounter",
    raw: {
      resourceType: "Encounter",
      id: "enc-1",
      status: "finished",
      class: { code: "AMB", display: "ambulatory" },
      period: { start: "2026-09-01T09:00:00Z", end: "2026-09-01T09:20:00Z" },
    },
  },
  {
    resourceType: "Immunization",
    raw: {
      resourceType: "Immunization",
      id: "imm-1",
      status: "completed",
      vaccineCode: { text: "Influenza, seasonal" },
      occurrenceDateTime: "2025-10-15",
    },
  },
  {
    resourceType: "DocumentReference",
    raw: {
      resourceType: "DocumentReference",
      id: "docref-1",
      status: "current",
      type: { text: "Progress note" },
      date: "2026-09-01T10:00:00Z",
    },
  },
];

async function writePage(pool, sourceId, personId) {
  const ids = {};
  for (const item of MIXED_PAGE) {
    const mapped = mapResource(item.raw);
    ids[item.resourceType] = await upsertHealthRecord(
      pool,
      sourceId,
      personId,
      item.resourceType,
      mapped,
      item.raw,
    );
  }
  return ids;
}

async function seedFixture(client) {
  const userId = newId();
  await client.query(`INSERT INTO kith.users (id, email, name) VALUES ($1, $2, $3)`, [
    userId,
    null,
    "Synthetic Owner",
  ]);
  const spaceId = newId();
  await client.query(
    `INSERT INTO kith.spaces (id, kind, name, created_by) VALUES ($1, 'shared', $2, $3)`,
    [spaceId, "Synthetic Household", userId],
  );
  const personId = newId();
  await client.query(
    `INSERT INTO kith.entities
       (id, space_id, created_at, user_id, key, kind, canonical_name, normalized_name)
       VALUES ($1, $2, now(), $3, $4, 'person', $5, lower($5))`,
    [personId, spaceId, userId, `person:${personId}`, "Jamie Synthetic"],
  );
  return { spaceId, personId };
}

async function runAssertions(client, pool, ctx, spaceId, personId) {
  const sourceId = await upsertHealthSource(pool, {
    personId,
    spaceId,
    orgName: "Synthetic Health System",
    fhirBase: "https://fhir.synthetic.example/api/FHIR/R4/",
    patientFhirId: "synthetic-patient-1",
    keychainService: "com.kithmind.epic.token.jamie-synthetic",
    scopes: "openid patient/Observation.read",
  });

  const firstIds = await writePage(pool, sourceId, personId);
  const secondIds = await writePage(pool, sourceId, personId);
  assert.deepEqual(secondIds, firstIds, "re-running the same page must not create new rows");

  const totalCount = await client.query(
    `SELECT count(*)::int AS count FROM kith.health_records WHERE person_id = $1`,
    [personId],
  );
  assert.equal(totalCount.rows[0].count, MIXED_PAGE.length);

  // The document, also written twice, must not duplicate either.
  const documentInput = {
    recordId: firstIds.DocumentReference,
    personId,
    contentType: "text/plain",
    byteLength: 17,
    text: "Visit went well.",
    storageNote: null,
  };
  await upsertHealthDocument(pool, documentInput);
  await upsertHealthDocument(pool, documentInput);
  const documentCount = await client.query(
    `SELECT count(*)::int AS count FROM kith.health_documents WHERE person_id = $1`,
    [personId],
  );
  assert.equal(documentCount.rows[0].count, 1);

  // The overview read model.
  const overview = await admin.listHealthOverview(ctx, { personId });
  assert.equal(overview.people.length, 1);
  const person = overview.people[0];
  assert.equal(person.personName, "Jamie Synthetic");
  assert.equal(person.countsByType.Observation, 1);
  assert.equal(person.countsByType.Condition, 1);
  assert.equal(person.countsByType.DocumentReference, 1);
  assert.equal(person.activeMedications.length, 1);
  assert.equal(person.activeMedications[0].name, "Cetirizine 10 MG Oral Tablet");
  assert.equal(person.conditions.length, 1);
  assert.equal(person.immunizations.length, 1);
  assert.equal(person.encounters.length, 1);
  assert.equal(person.labResults.length, 1);
  assert.equal(person.labResults[0].value, "4.1");
  assert.equal(person.labResults[0].unit, "mmol/L");
  assert.equal(person.documentsCount, 1);

  // listHealthOverview with no personId still finds this one person.
  const overviewAll = await admin.listHealthOverview(ctx, {});
  assert.equal(overviewAll.people.length, 1);
  assert.equal(overviewAll.people[0].personId, personId);

  // The record-list read model, filtered by resource type.
  const observations = await admin.listHealthRecords(ctx, {
    personId,
    resourceType: "Observation",
  });
  assert.equal(observations.records.length, 1);
  assert.equal(observations.records[0].codeDisplay, "Potassium");
  assert.equal(observations.nextCursor, null);

  const everyRecord = await admin.listHealthRecords(ctx, { personId, limit: 2 });
  assert.equal(everyRecord.records.length, 2);
  assert.notEqual(everyRecord.nextCursor, null);
  const nextPage = await admin.listHealthRecords(ctx, {
    personId,
    limit: 2,
    cursor: everyRecord.nextCursor,
  });
  assert.equal(nextPage.records.length, 2);
  const seenIds = new Set([
    ...everyRecord.records.map((r) => r.id),
    ...nextPage.records.map((r) => r.id),
  ]);
  assert.equal(seenIds.size, 4, "paging must not repeat a record across pages");

  // The document itself, for `get_health_document`.
  const documentRow = await client.query(
    `SELECT id FROM kith.health_documents WHERE person_id = $1`,
    [personId],
  );
  const document = await admin.getHealthDocument(ctx, documentRow.rows[0].id);
  assert.equal(document.text, "Visit went well.");
  assert.equal(document.personId, personId);

  // The MCP authorization lookups.
  assert.equal(await admin.healthPersonSpaceId(ctx, personId), spaceId);
  assert.equal(await admin.healthDocumentSpaceId(ctx, documentRow.rows[0].id), spaceId);
}

async function runAgainstServer(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { applyKithSchema } = await import("@repo/kith-store");
    await applyKithSchema(client);
    const ctx = identityCtx(client, Date.parse("2026-09-23T12:00:00Z"));
    const { spaceId, personId } = await seedFixture(client);

    const pool = openPool(url);
    try {
      await runAssertions(client, pool, ctx, spaceId, personId);
    } finally {
      await pool.end();
    }
  } finally {
    await client.end();
  }
}

test(
  "epic-feed's writes are idempotent and kith-store's overview reflects them",
  { skip: available ? false : "no local initdb/pg_ctl found on PATH" },
  async () => {
    const server = await startLocalPostgres();
    try {
      await runAgainstServer(server.url);
    } finally {
      // Explicit, ordered teardown rather than `t.after` (whose hook
      // ordering is easy to get backwards): the pool and client close
      // before the server stops, never after.
      await server.stop();
    }
  },
);
