// One synthetic FHIR fixture per resource type, asserting the flat columns
// each mapper produces. No real patient data anywhere here.

import assert from "node:assert/strict";
import test from "node:test";

import { mapResource } from "../dist/index.js";

test("mapResource maps a quantity-valued Observation with an abnormal flag", () => {
  const mapped = mapResource({
    resourceType: "Observation",
    id: "obs-1",
    status: "final",
    category: [{ coding: [{ code: "laboratory" }] }],
    code: { text: "Potassium" },
    effectiveDateTime: "2026-01-05T10:00:00Z",
    encounter: { reference: "Encounter/enc-1" },
    valueQuantity: { value: 5.9, unit: "mmol/L" },
    interpretation: [{ coding: [{ code: "H", display: "High" }] }],
  });
  assert.equal(mapped.fhirId, "obs-1");
  assert.equal(mapped.status, "final");
  assert.equal(mapped.category, "laboratory");
  assert.equal(mapped.codeDisplay, "Potassium");
  assert.equal(mapped.effectiveAt, "2026-01-05T10:00:00Z");
  assert.equal(mapped.encounterFhirId, "enc-1");
  assert.equal(mapped.valueNumber, 5.9);
  assert.equal(mapped.valueUnit, "mmol/L");
  assert.equal(mapped.valueText, "H");
});

test("mapResource maps a string-valued Observation with no quantity", () => {
  const mapped = mapResource({
    resourceType: "Observation",
    id: "obs-2",
    status: "final",
    code: { coding: [{ display: "Smoking status" }] },
    valueString: "Never smoker",
  });
  assert.equal(mapped.valueNumber, null);
  assert.equal(mapped.valueText, "Never smoker");
  assert.equal(mapped.codeDisplay, "Smoking status");
});

test("mapResource maps DiagnosticReport's conclusion", () => {
  const mapped = mapResource({
    resourceType: "DiagnosticReport",
    id: "dr-1",
    status: "final",
    code: { text: "Basic Metabolic Panel" },
    effectivePeriod: { start: "2026-01-05T09:00:00Z" },
    conclusion: "Within normal limits.",
  });
  assert.equal(mapped.codeDisplay, "Basic Metabolic Panel");
  assert.equal(mapped.effectiveAt, "2026-01-05T09:00:00Z");
  assert.equal(mapped.valueText, "Within normal limits.");
});

test("mapResource maps Condition's clinical status and category", () => {
  const mapped = mapResource({
    resourceType: "Condition",
    id: "cond-1",
    clinicalStatus: { coding: [{ code: "active" }] },
    category: [{ coding: [{ code: "problem-list-item" }] }],
    code: { text: "Essential hypertension" },
    onsetDateTime: "2020-03-01",
  });
  assert.equal(mapped.status, "active");
  assert.equal(mapped.category, "problem-list-item");
  assert.equal(mapped.codeDisplay, "Essential hypertension");
  assert.equal(mapped.effectiveAt, "2020-03-01");
});

test("mapResource maps MedicationRequest's medication display and dosage", () => {
  const mapped = mapResource({
    resourceType: "MedicationRequest",
    id: "mr-1",
    status: "active",
    medicationCodeableConcept: { text: "Lisinopril 10 MG Oral Tablet" },
    authoredOn: "2026-02-01",
    dosageInstruction: [{ text: "Take 1 tablet by mouth daily" }],
  });
  assert.equal(mapped.codeDisplay, "Lisinopril 10 MG Oral Tablet");
  assert.equal(mapped.status, "active");
  assert.equal(mapped.effectiveAt, "2026-02-01");
  assert.equal(mapped.valueText, "Take 1 tablet by mouth daily");
});

test("mapResource maps AllergyIntolerance's category as a plain code", () => {
  const mapped = mapResource({
    resourceType: "AllergyIntolerance",
    id: "allergy-1",
    clinicalStatus: { coding: [{ code: "active" }] },
    category: ["medication"],
    code: { text: "Penicillin" },
    criticality: "high",
    recordedDate: "2019-06-01",
  });
  assert.equal(mapped.codeDisplay, "Penicillin");
  assert.equal(mapped.category, "medication");
  assert.equal(mapped.valueText, "high");
  assert.equal(mapped.effectiveAt, "2019-06-01");
});

test("mapResource maps Immunization's vaccine and occurrence date", () => {
  const mapped = mapResource({
    resourceType: "Immunization",
    id: "imm-1",
    status: "completed",
    vaccineCode: { text: "Influenza, seasonal" },
    occurrenceDateTime: "2025-10-15",
  });
  assert.equal(mapped.codeDisplay, "Influenza, seasonal");
  assert.equal(mapped.status, "completed");
  assert.equal(mapped.effectiveAt, "2025-10-15");
});

test("mapResource maps Encounter's class and period", () => {
  const mapped = mapResource({
    resourceType: "Encounter",
    id: "enc-1",
    status: "finished",
    class: { code: "AMB", display: "ambulatory" },
    period: { start: "2026-01-05T09:00:00Z", end: "2026-01-05T09:30:00Z" },
  });
  assert.equal(mapped.codeDisplay, "ambulatory");
  assert.equal(mapped.category, "AMB");
  assert.equal(mapped.effectiveAt, "2026-01-05T09:00:00Z");
  assert.equal(mapped.valueText, "2026-01-05T09:30:00Z");
});

test("mapResource maps Procedure's code and performed period", () => {
  const mapped = mapResource({
    resourceType: "Procedure",
    id: "proc-1",
    status: "completed",
    code: { text: "Appendectomy" },
    performedPeriod: { start: "2018-05-01" },
    encounter: { reference: "Encounter/enc-2" },
  });
  assert.equal(mapped.codeDisplay, "Appendectomy");
  assert.equal(mapped.effectiveAt, "2018-05-01");
  assert.equal(mapped.encounterFhirId, "enc-2");
});

test("mapResource maps Goal's description and dates", () => {
  const mapped = mapResource({
    resourceType: "Goal",
    id: "goal-1",
    lifecycleStatus: "active",
    description: { text: "Lower blood pressure" },
    startDate: "2026-01-01",
  });
  assert.equal(mapped.codeDisplay, "Lower blood pressure");
  assert.equal(mapped.status, "active");
  assert.equal(mapped.effectiveAt, "2026-01-01");
});

test("mapResource maps Specimen's type and collection date", () => {
  const mapped = mapResource({
    resourceType: "Specimen",
    id: "spec-1",
    status: "available",
    type: { text: "Venous blood" },
    collection: { collectedDateTime: "2026-01-05T08:45:00Z" },
  });
  assert.equal(mapped.codeDisplay, "Venous blood");
  assert.equal(mapped.effectiveAt, "2026-01-05T08:45:00Z");
});

test("mapResource maps DocumentReference's type and encounter", () => {
  const mapped = mapResource({
    resourceType: "DocumentReference",
    id: "docref-1",
    status: "current",
    type: { text: "Progress note" },
    date: "2026-01-05T11:00:00Z",
    context: { encounter: [{ reference: "Encounter/enc-3" }] },
  });
  assert.equal(mapped.codeDisplay, "Progress note");
  assert.equal(mapped.status, "current");
  assert.equal(mapped.effectiveAt, "2026-01-05T11:00:00Z");
  assert.equal(mapped.encounterFhirId, "enc-3");
});

test("mapResource maps Patient's name, gender and birth date", () => {
  const mapped = mapResource({
    resourceType: "Patient",
    id: "patient-1",
    active: true,
    name: [{ given: ["Jamie"], family: "Synthetic" }],
    gender: "unknown",
    birthDate: "1990-01-01",
  });
  assert.equal(mapped.codeDisplay, "Jamie Synthetic");
  assert.equal(mapped.status, "active");
  assert.equal(mapped.category, "unknown");
  assert.equal(mapped.valueText, "1990-01-01");
});

test("mapResource throws for an unmapped resource type", () => {
  assert.throws(() => mapResource({ resourceType: "Basic", id: "x" }));
});

test("mapResource throws when the resource has no id", () => {
  assert.throws(() => mapResource({ resourceType: "Patient" }));
});
