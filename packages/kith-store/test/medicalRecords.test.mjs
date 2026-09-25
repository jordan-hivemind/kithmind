// `admin.listHealthOverview` (migration 053_health_feed.sql): the read model
// behind the admin Health Records page's one server round trip.
//
// Writes go straight through raw SQL rather than `@repo/epic-feed`'s own
// upsert helpers -- this package is the one `epic-feed` depends on, not the
// other way around, so its own test suite cannot import that package's
// writer. `@repo/epic-feed`'s `test/postgres.test.mjs` exercises the same
// read model from the writer side, through `mapResource` and
// `upsertHealthRecord`; this suite is the store-side coverage the same
// derivations need: report grouping by `result[].reference`, an unreferenced
// lab observation's fallback group, a flag derived from a reference range,
// condition dedupe with problem-list precedence, the active-medication
// filter, and a `DocumentReference` with and without a `health_documents`
// row.
//
// Synthetic fixtures throughout -- no real patient data anywhere here.

import assert from "node:assert/strict";
import test from "node:test";

import { listHealthOverview } from "../dist/admin/index.js";
import { newKithId } from "../dist/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

async function makeEntity(ctx, spaceId, userId, name) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.entities
       (id, space_id, created_at, user_id, key, kind, canonical_name,
        normalized_name, aliases, normalized_aliases)
     VALUES ($1,$2,now(),$3,$4,'person',$5,lower($5),'[]'::jsonb,'[]'::jsonb)`,
    [id, spaceId, userId, `person:${id}`, name],
  );
  return id;
}

async function makeHealthSource(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.health_sources
       (id, person_id, space_id, org_name, fhir_base, patient_fhir_id,
        keychain_service, scopes, last_pulled_at, needs_reauth_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      fields.personId,
      fields.spaceId,
      fields.orgName,
      fields.fhirBase ?? `https://fhir.synthetic.example/${id}/`,
      fields.patientFhirId ?? "synthetic-patient-1",
      fields.keychainService ?? `com.kithmind.epic.token.${id}`,
      fields.scopes ?? "openid",
      fields.lastPulledAt ?? null,
      fields.needsReauthAt ?? null,
    ],
  );
  return id;
}

async function makeHealthRecord(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.health_records
       (id, source_id, person_id, resource_type, fhir_id, effective_at,
        status, code_display, value_text, value_number, value_unit,
        category, encounter_fhir_id, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
    [
      id,
      fields.sourceId,
      fields.personId,
      fields.resourceType,
      fields.fhirId,
      fields.effectiveAt ?? null,
      fields.status ?? null,
      fields.codeDisplay ?? null,
      fields.valueText ?? null,
      fields.valueNumber ?? null,
      fields.valueUnit ?? null,
      fields.category ?? null,
      fields.encounterFhirId ?? null,
      JSON.stringify(fields.raw ?? {}),
    ],
  );
  return id;
}

async function makeHealthDocument(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.health_documents
       (id, record_id, person_id, content_type, byte_length, text, storage_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      fields.recordId,
      fields.personId,
      fields.contentType ?? "text/plain",
      fields.byteLength ?? 0,
      fields.text ?? null,
      fields.storageNote ?? null,
    ],
  );
  return id;
}

async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(Date.parse("2026-09-25T12:00:00Z"));
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const personId = await makeEntity(ctx, spaceId, userId, "Jamie Synthetic");
  return { ...database, ctx, userId, spaceId, personId };
}

test(
  "listHealthOverview groups lab results under their report and falls back for the unreferenced one",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await f.tx(async (ctx) => {
      const sourceId = await makeHealthSource(ctx, {
        personId: f.personId,
        spaceId: f.spaceId,
        orgName: "Synthetic Health System",
      });

      const obsInRange = await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "Observation",
        fhirId: "obs-in-range",
        effectiveAt: "2026-09-01T09:00:00Z",
        codeDisplay: "Sodium",
        category: "laboratory",
        valueNumber: 140,
        valueUnit: "mEq/L",
        raw: {
          referenceRange: [{ low: { value: 135, unit: "mEq/L" }, high: { value: 145, unit: "mEq/L" } }],
        },
      });
      const obsAboveRange = await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "Observation",
        fhirId: "obs-above-range",
        effectiveAt: "2026-09-01T09:00:00Z",
        codeDisplay: "Potassium",
        category: "laboratory",
        valueNumber: 5.9,
        valueUnit: "mmol/L",
        raw: {
          referenceRange: [{ low: { value: 3.5, unit: "mmol/L" }, high: { value: 5.1, unit: "mmol/L" } }],
        },
      });
      const obsUnreferenced = await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "Observation",
        fhirId: "obs-unreferenced",
        effectiveAt: "2026-08-15T09:00:00Z",
        codeDisplay: "Glucose",
        category: "laboratory",
        valueNumber: 92,
        valueUnit: "mg/dL",
      });
      await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "DiagnosticReport",
        fhirId: "dr-1",
        effectiveAt: "2026-09-01T09:00:00Z",
        codeDisplay: "Basic Metabolic Panel",
        category: "Lab",
        raw: {
          result: [
            { reference: "Observation/obs-in-range" },
            { reference: "Observation/obs-above-range" },
          ],
        },
      });

      const overview = await listHealthOverview(ctx, { personId: f.personId });
      const person = overview.people[0];
      assert.equal(person.labReports.length, 2);

      const report = person.labReports.find((group) => group.name === "Basic Metabolic Panel");
      assert.equal(report.resultCount, 2);
      const potassium = report.results.find((result) => result.name === "Potassium");
      assert.equal(potassium.range, "3.5–5.1 mmol/L");
      // Above the reference range, with no `interpretation` field at all: the
      // flag has to come from comparing the value against the range.
      assert.equal(potassium.flag, "H");
      const sodium = report.results.find((result) => result.name === "Sodium");
      // Inside the range: not abnormal.
      assert.equal(sodium.flag, "N");

      const other = person.labReports.find((group) => group.name === "Other lab results");
      assert.equal(other.resultCount, 1);
      assert.equal(other.results[0].name, "Glucose");
      assert.equal([obsInRange, obsAboveRange, obsUnreferenced].every(Boolean), true);
    }, Date.parse("2026-09-25T12:00:00Z"));
  },
);

test(
  "listHealthOverview prefers an interpretation flag over the range comparison",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await f.tx(async (ctx) => {
      const sourceId = await makeHealthSource(ctx, {
        personId: f.personId,
        spaceId: f.spaceId,
        orgName: "Synthetic Health System",
      });
      await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "Observation",
        fhirId: "obs-flagged",
        effectiveAt: "2026-09-01T09:00:00Z",
        codeDisplay: "Calcium",
        category: "laboratory",
        valueNumber: 9.0,
        valueUnit: "mg/dL",
        raw: {
          // Inside this range on its own terms, but Epic's own interpretation
          // (an "A" for abnormal) must win over the comparison.
          referenceRange: [{ low: { value: 8.5, unit: "mg/dL" }, high: { value: 10.5, unit: "mg/dL" } }],
          interpretation: [{ coding: [{ code: "A", display: "Abnormal" }] }],
        },
      });

      const overview = await listHealthOverview(ctx, { personId: f.personId });
      const person = overview.people[0];
      const other = person.labReports.find((group) => group.name === "Other lab results");
      assert.equal(other.results[0].flag, "A");
    }, Date.parse("2026-09-25T12:00:00Z"));
  },
);

test(
  "listHealthOverview dedupes a condition across occurrences and keeps problem-list precedence",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await f.tx(async (ctx) => {
      const sourceId = await makeHealthSource(ctx, {
        personId: f.personId,
        spaceId: f.spaceId,
        orgName: "Synthetic Health System",
      });
      await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "Condition",
        fhirId: "cond-early",
        effectiveAt: "2020-04-01",
        status: "active",
        codeDisplay: "Essential hypertension",
        category: "problem-list-item",
      });
      await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "Condition",
        fhirId: "cond-late",
        effectiveAt: "2026-06-01",
        codeDisplay: "Essential hypertension",
        category: "encounter-diagnosis",
      });
      // A second, unrelated condition, off the problem list, so it must sort
      // after the deduped hypertension group despite a later date.
      await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "Condition",
        fhirId: "cond-other",
        effectiveAt: "2026-08-01",
        codeDisplay: "Seasonal allergic rhinitis",
        category: "encounter-diagnosis",
      });

      const overview = await listHealthOverview(ctx, { personId: f.personId });
      const person = overview.people[0];
      assert.equal(person.conditions.length, 2);
      const hypertension = person.conditions.find(
        (condition) => condition.name === "Essential hypertension",
      );
      assert.equal(hypertension.occurrenceCount, 2);
      assert.equal(hypertension.onProblemList, true);
      assert.equal(hypertension.status, "active");
      // Problem-list precedence: hypertension sorts first even though the
      // rhinitis occurrence is dated later.
      assert.equal(person.conditions[0].name, "Essential hypertension");
      assert.equal(person.current.activeProblems.length, 1);
      assert.equal(person.current.activeProblems[0].name, "Essential hypertension");
    }, Date.parse("2026-09-25T12:00:00Z"));
  },
);

test(
  "listHealthOverview lists every medication and filters the current state to active ones",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await f.tx(async (ctx) => {
      const sourceId = await makeHealthSource(ctx, {
        personId: f.personId,
        spaceId: f.spaceId,
        orgName: "Synthetic Health System",
      });
      await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "MedicationRequest",
        fhirId: "mr-active",
        effectiveAt: "2026-04-01",
        status: "active",
        codeDisplay: "Cetirizine 10 MG Oral Tablet",
      });
      await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "MedicationRequest",
        fhirId: "mr-stopped",
        effectiveAt: "2025-01-01",
        status: "stopped",
        codeDisplay: "Atorvastatin 20 MG Oral Tablet",
      });

      const overview = await listHealthOverview(ctx, { personId: f.personId });
      const person = overview.people[0];
      assert.equal(person.medications.length, 2);
      assert.equal(person.current.activeMedications.length, 1);
      assert.equal(person.current.activeMedications[0].name, "Cetirizine 10 MG Oral Tablet");
    }, Date.parse("2026-09-25T12:00:00Z"));
  },
);

test(
  "listHealthOverview tells apart a DocumentReference with a health_documents row from one without",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await f.tx(async (ctx) => {
      const sourceId = await makeHealthSource(ctx, {
        personId: f.personId,
        spaceId: f.spaceId,
        orgName: "Synthetic Health System",
      });
      const withDocId = await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "DocumentReference",
        fhirId: "docref-with-text",
        effectiveAt: "2026-09-01T10:00:00Z",
        codeDisplay: "Progress note",
      });
      await makeHealthDocument(ctx, {
        recordId: withDocId,
        personId: f.personId,
        text: "Visit went well.",
        byteLength: 17,
      });
      await makeHealthRecord(ctx, {
        sourceId,
        personId: f.personId,
        resourceType: "DocumentReference",
        fhirId: "docref-without-text",
        effectiveAt: "2026-02-01T10:00:00Z",
        codeDisplay: "Discharge summary",
      });

      const overview = await listHealthOverview(ctx, { personId: f.personId });
      const person = overview.people[0];
      assert.equal(person.clinicalNotes.length, 2);
      const withText = person.clinicalNotes.find((note) => note.title === "Progress note");
      assert.equal(withText.hasText, true);
      assert.equal(withText.text, "Visit went well.");
      const withoutText = person.clinicalNotes.find(
        (note) => note.title === "Discharge summary",
      );
      assert.equal(withoutText.hasText, false);
      assert.equal(withoutText.text, null);
    }, Date.parse("2026-09-25T12:00:00Z"));
  },
);

test(
  "listHealthOverview surfaces the source line the header needs",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await f.tx(async (ctx) => {
      await makeHealthSource(ctx, {
        personId: f.personId,
        spaceId: f.spaceId,
        orgName: "Synthetic Health System",
        lastPulledAt: "2026-09-25T06:00:00Z",
        needsReauthAt: "2026-09-24T06:00:00Z",
      });

      const overview = await listHealthOverview(ctx, { personId: f.personId });
      const person = overview.people[0];
      assert.equal(person.sources.length, 1);
      assert.equal(person.sources[0].orgName, "Synthetic Health System");
      assert.notEqual(person.sources[0].lastPulledAt, null);
      assert.notEqual(person.sources[0].needsReauthAt, null);
    }, Date.parse("2026-09-25T12:00:00Z"));
  },
);
