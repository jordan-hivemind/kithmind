// Against a real, throwaway Postgres server this suite starts and stops
// itself (test/helpers/localPostgres.mjs): seeds a synthetic person profile,
// upserts a mixed page of health records (and documents) twice, and asserts
// both idempotency and `@repo/kith-store`'s overview read model -- including
// the grouping, dedupe and flag-derivation the admin Health Records page's
// server round trip does. Skips cleanly when `initdb`/`pg_ctl` are not on
// PATH.
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
  recordPullSuccess,
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

// Two Observations a DiagnosticReport's own `result[]` claims (obs-1 by
// reference, obs-2 the same way), one laboratory Observation no report
// claims at all (obs-3, so it must fall into the "Other lab results"
// synthetic group), and one vital-sign Observation (obs-4, grouped by day
// rather than by report). obs-1 carries a `referenceRange` and no
// `interpretation`, so its flag must come from comparing `valueNumber`
// against the range; obs-2 carries neither, so its flag is null.
const MIXED_PAGE = [
  {
    resourceType: "Observation",
    raw: {
      resourceType: "Observation",
      id: "obs-1",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: { text: "Potassium", coding: [{ system: "http://loinc.org", code: "2823-3" }] },
      effectiveDateTime: "2026-09-01T09:00:00Z",
      valueQuantity: { value: 5.9, unit: "mmol/L" },
      referenceRange: [{ low: { value: 3.5, unit: "mmol/L" }, high: { value: 5.1, unit: "mmol/L" } }],
    },
  },
  {
    resourceType: "Observation",
    raw: {
      resourceType: "Observation",
      id: "obs-2",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: { text: "Sodium" },
      effectiveDateTime: "2026-09-01T09:00:00Z",
      valueQuantity: { value: 140, unit: "mEq/L" },
    },
  },
  {
    resourceType: "Observation",
    raw: {
      resourceType: "Observation",
      id: "obs-3",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: { text: "Glucose" },
      effectiveDateTime: "2026-08-15T09:00:00Z",
      valueQuantity: { value: 92, unit: "mg/dL" },
    },
  },
  {
    resourceType: "Observation",
    raw: {
      resourceType: "Observation",
      id: "obs-4",
      status: "final",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: { text: "Heart rate" },
      effectiveDateTime: "2026-09-01T09:05:00Z",
      valueQuantity: { value: 72, unit: "/min" },
    },
  },
  {
    resourceType: "DiagnosticReport",
    raw: {
      resourceType: "DiagnosticReport",
      id: "dr-1",
      status: "final",
      category: [{ coding: [{ code: "Lab" }] }],
      code: { text: "Basic Metabolic Panel" },
      effectiveDateTime: "2026-09-01T09:00:00Z",
      result: [{ reference: "Observation/obs-1" }, { reference: "Observation/obs-2" }],
    },
  },
  // Two occurrences of the same condition, only one of them on the problem
  // list: dedupe must still mark the group `onProblemList`.
  {
    resourceType: "Condition",
    raw: {
      resourceType: "Condition",
      id: "cond-1",
      clinicalStatus: { coding: [{ code: "active" }] },
      category: [{ coding: [{ code: "problem-list-item" }] }],
      code: { text: "Essential hypertension" },
      onsetDateTime: "2020-04-01",
    },
  },
  {
    resourceType: "Condition",
    raw: {
      resourceType: "Condition",
      id: "cond-2",
      category: [{ coding: [{ code: "encounter-diagnosis" }] }],
      code: { text: "Essential hypertension" },
      recordedDate: "2026-06-01",
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
    resourceType: "MedicationRequest",
    raw: {
      resourceType: "MedicationRequest",
      id: "mr-2",
      status: "stopped",
      medicationReference: {
        reference: "Medication/med-opaque-1",
        display: "Atorvastatin 20 MG Oral Tablet",
      },
      authoredOn: "2025-01-01",
    },
  },
  {
    resourceType: "AllergyIntolerance",
    raw: {
      resourceType: "AllergyIntolerance",
      id: "allergy-1",
      clinicalStatus: { coding: [{ code: "active" }] },
      category: ["medication"],
      code: { text: "Penicillin" },
      criticality: "high",
      recordedDate: "2019-06-01",
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
  // With a `health_documents` row, attached below.
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
  // No `health_documents` row: a note whose content was never fetched.
  {
    resourceType: "DocumentReference",
    raw: {
      resourceType: "DocumentReference",
      id: "docref-2",
      status: "current",
      type: { text: "Discharge summary" },
      date: "2026-02-01T10:00:00Z",
    },
  },
];

async function writePage(pool, sourceId, personId) {
  const ids = {};
  for (const item of MIXED_PAGE) {
    const mapped = mapResource(item.raw);
    const key = `${item.resourceType}:${item.raw.id}`;
    ids[key] = await upsertHealthRecord(
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
  await recordPullSuccess(pool, sourceId);

  const firstIds = await writePage(pool, sourceId, personId);
  const secondIds = await writePage(pool, sourceId, personId);
  assert.deepEqual(secondIds, firstIds, "re-running the same page must not create new rows");

  const totalCount = await client.query(
    `SELECT count(*)::int AS count FROM kith.health_records WHERE person_id = $1`,
    [personId],
  );
  assert.equal(totalCount.rows[0].count, MIXED_PAGE.length);

  // Two documents, each written twice: one attached to docref-1, none to
  // docref-2 -- must not duplicate, and the overview must tell them apart.
  const documentInput = {
    recordId: firstIds["DocumentReference:docref-1"],
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

  // The source line the header shows: org name, last pull, no reauth needed.
  assert.equal(person.sources.length, 1);
  assert.equal(person.sources[0].orgName, "Synthetic Health System");
  assert.notEqual(person.sources[0].lastPulledAt, null);
  assert.equal(person.sources[0].needsReauthAt, null);

  // Lab reports: one DiagnosticReport group with both its referenced
  // observations, one synthetic "Other lab results" group for the
  // unreferenced observation.
  assert.equal(person.labReports.length, 2);
  const report = person.labReports.find((group) => group.name === "Basic Metabolic Panel");
  assert.ok(report, "expected the Basic Metabolic Panel group");
  assert.equal(report.resultCount, 2);
  assert.equal(report.testsFull, "Potassium, Sodium");
  const potassium = report.results.find((result) => result.name === "Potassium");
  assert.equal(potassium.value, "5.9");
  assert.equal(potassium.unit, "mmol/L");
  assert.equal(potassium.range, "3.5–5.1 mmol/L");
  // Above the high bound of the range, with no `interpretation` of its own:
  // the flag must come from the range comparison.
  assert.equal(potassium.flag, "H");
  const sodium = report.results.find((result) => result.name === "Sodium");
  // No range and no interpretation: no flag to derive.
  assert.equal(sodium.flag, null);

  const other = person.labReports.find((group) => group.name === "Other lab results");
  assert.ok(other, "expected the Other lab results group");
  assert.equal(other.resultCount, 1);
  assert.equal(other.results[0].name, "Glucose");

  // Lab test history: Potassium's own LOINC code groups its single point.
  const potassiumSeries = person.labTests.find((series) => series.testKey === "2823-3");
  assert.ok(potassiumSeries, "expected Potassium's own test history series");
  assert.equal(potassiumSeries.points.length, 1);
  assert.equal(potassiumSeries.points[0].value, "5.9");

  // Vitals grouped by day.
  assert.equal(person.vitals.length, 1);
  assert.equal(person.vitals[0].readings.length, 1);
  assert.equal(person.vitals[0].readings[0].name, "Heart rate");

  // Conditions deduped: one group for the two "Essential hypertension"
  // occurrences, marked on the problem list because one occurrence was.
  assert.equal(person.conditions.length, 1);
  const condition = person.conditions[0];
  assert.equal(condition.name, "Essential hypertension");
  assert.equal(condition.occurrenceCount, 2);
  assert.equal(condition.onProblemList, true);
  assert.equal(condition.firstSeen.slice(0, 10), "2020-04-01");
  assert.equal(condition.lastSeen.slice(0, 10), "2026-06-01");
  assert.equal(person.current.activeProblems.length, 1);

  // Medications: both requests listed, only the active one in the current
  // state's filtered list.
  assert.equal(person.medications.length, 2);
  assert.equal(person.current.activeMedications.length, 1);
  assert.equal(person.current.activeMedications[0].name, "Cetirizine 10 MG Oral Tablet");
  const atorvastatin = person.medications.find((row) => row.status === "stopped");
  assert.equal(atorvastatin.name, "Atorvastatin 20 MG Oral Tablet");

  assert.equal(person.allergies.length, 1);
  assert.equal(person.immunizations.length, 1);
  assert.equal(person.encounters.length, 1);
  assert.equal(person.current.lastEncounter.name, "ambulatory");

  // Clinical notes: docref-1 has its document's text, docref-2 does not.
  assert.equal(person.clinicalNotes.length, 2);
  const withText = person.clinicalNotes.find((note) => note.title === "Progress note");
  assert.equal(withText.hasText, true);
  assert.equal(withText.text, "Visit went well.");
  const withoutText = person.clinicalNotes.find((note) => note.title === "Discharge summary");
  assert.equal(withoutText.hasText, false);
  assert.equal(withoutText.text, null);

  // listHealthOverview with no personId still finds this one person.
  const overviewAll = await admin.listHealthOverview(ctx, {});
  assert.equal(overviewAll.people.length, 1);
  assert.equal(overviewAll.people[0].personId, personId);

  // The record-list read model, filtered by resource type.
  const observations = await admin.listHealthRecords(ctx, {
    personId,
    resourceType: "Observation",
  });
  assert.equal(observations.records.length, 4);

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
