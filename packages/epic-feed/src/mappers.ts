// One small, deterministic mapper per FHIR resource type: the raw JSON
// Epic returns in, the flat `kith.health_records` columns out. `raw` itself
// is always kept verbatim (the caller stores the whole resource as jsonb);
// these mappers only decide what belongs in the indexed columns so the
// overview and record-list reads never have to parse FHIR JSON themselves.
//
// `valueText` does double duty for `Observation`, matching the task's own
// phrasing ("value quantity or string with reference range flag"): a
// quantity-valued observation puts the number in `valueNumber`/`valueUnit`
// and any abnormal-result flag (Epic's own `interpretation` coding, for
// example "H"/"L"/"A") in `valueText`; a string- or concept-valued
// observation has no quantity, so `valueText` carries the value itself.

export type MappedHealthRecord = {
  fhirId: string;
  effectiveAt: string | null;
  status: string | null;
  codeDisplay: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueUnit: string | null;
  category: string | null;
  encounterFhirId: string | null;
};

type Fhir = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asArray(value: unknown): Fhir[] {
  return Array.isArray(value) ? (value as Fhir[]) : [];
}

function asObject(value: unknown): Fhir | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fhir)
    : null;
}

/** `CodeableConcept.text`, falling back to the first coding's `display`. */
function codeableConceptText(value: unknown): string | null {
  const concept = asObject(value);
  if (concept === null) return null;
  const text = asString(concept.text);
  if (text !== null) return text;
  const coding = asArray(concept.coding)[0];
  return coding ? asString(coding.display) ?? asString(coding.code) : null;
}

/** The first coding's `code` from a `CodeableConcept`, for a status/category
 * column that wants a short machine value rather than the display text. */
function codeableConceptCode(value: unknown): string | null {
  const concept = asObject(value);
  if (concept === null) return null;
  const coding = asArray(concept.coding)[0];
  return coding ? asString(coding.code) : null;
}

function referenceId(value: unknown): string | null {
  const reference = asObject(value);
  const ref = reference ? asString(reference.reference) : null;
  if (ref === null) return null;
  const slash = ref.lastIndexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

function fhirId(resource: Fhir): string {
  const id = asString(resource.id);
  if (id === null) throw new Error("FHIR resource had no id");
  return id;
}

function base(resource: Fhir): MappedHealthRecord {
  return {
    fhirId: fhirId(resource),
    effectiveAt: null,
    status: null,
    codeDisplay: null,
    valueText: null,
    valueNumber: null,
    valueUnit: null,
    category: null,
    encounterFhirId: null,
  };
}

function interpretationFlag(resource: Fhir): string | null {
  const interpretation = asArray(resource.interpretation)[0];
  return interpretation ? codeableConceptCode(interpretation) : null;
}

export function mapObservation(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay = codeableConceptText(resource.code);
  record.status = asString(resource.status);
  record.category = codeableConceptCode(asArray(resource.category)[0]);
  record.effectiveAt =
    asString(resource.effectiveDateTime) ??
    asString(asObject(resource.effectivePeriod)?.start);
  record.encounterFhirId = referenceId(resource.encounter);
  const quantity = asObject(resource.valueQuantity);
  if (quantity !== null) {
    const value = quantity.value;
    record.valueNumber = typeof value === "number" ? value : null;
    record.valueUnit = asString(quantity.unit) ?? asString(quantity.code);
    record.valueText = interpretationFlag(resource);
  } else {
    record.valueText =
      asString(resource.valueString) ??
      codeableConceptText(resource.valueCodeableConcept);
  }
  return record;
}

export function mapDiagnosticReport(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay = codeableConceptText(resource.code);
  record.status = asString(resource.status);
  record.category = codeableConceptCode(asArray(resource.category)[0]);
  record.effectiveAt =
    asString(resource.effectiveDateTime) ??
    asString(asObject(resource.effectivePeriod)?.start);
  record.encounterFhirId = referenceId(resource.encounter);
  record.valueText = asString(resource.conclusion);
  return record;
}

export function mapCondition(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay = codeableConceptText(resource.code);
  record.status = codeableConceptCode(resource.clinicalStatus);
  record.category = codeableConceptCode(asArray(resource.category)[0]);
  record.effectiveAt =
    asString(resource.onsetDateTime) ?? asString(resource.recordedDate);
  record.encounterFhirId = referenceId(resource.encounter);
  return record;
}

export function mapMedicationRequest(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay =
    codeableConceptText(resource.medicationCodeableConcept) ??
    referenceId(resource.medicationReference);
  record.status = asString(resource.status);
  record.effectiveAt = asString(resource.authoredOn);
  record.encounterFhirId = referenceId(resource.encounter);
  const dosage = asArray(resource.dosageInstruction)[0];
  record.valueText = dosage ? asString(dosage.text) : null;
  return record;
}

export function mapAllergyIntolerance(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay = codeableConceptText(resource.code);
  record.status = codeableConceptCode(resource.clinicalStatus);
  // `AllergyIntolerance.category` is an array of plain code strings
  // (`food`/`medication`/`environment`/`biologic`), not `CodeableConcept`.
  const categories = Array.isArray(resource.category)
    ? (resource.category as unknown[])
    : [];
  const firstCategory = categories[0];
  record.category = typeof firstCategory === "string" ? firstCategory : null;
  record.effectiveAt =
    asString(resource.recordedDate) ?? asString(resource.onsetDateTime);
  record.valueText = asString(resource.criticality);
  return record;
}

export function mapImmunization(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay = codeableConceptText(resource.vaccineCode);
  record.status = asString(resource.status);
  record.effectiveAt = asString(resource.occurrenceDateTime);
  record.encounterFhirId = referenceId(resource.encounter);
  return record;
}

export function mapEncounter(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  const type = asArray(resource.type)[0];
  record.codeDisplay =
    (type ? codeableConceptText(type) : null) ??
    asString(asObject(resource.class)?.display) ??
    asString(asObject(resource.class)?.code);
  record.status = asString(resource.status);
  record.category = asString(asObject(resource.class)?.code);
  const period = asObject(resource.period);
  record.effectiveAt = period ? asString(period.start) : null;
  record.valueText = period ? asString(period.end) : null;
  return record;
}

export function mapProcedure(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay = codeableConceptText(resource.code);
  record.status = asString(resource.status);
  record.effectiveAt =
    asString(resource.performedDateTime) ??
    asString(asObject(resource.performedPeriod)?.start);
  record.encounterFhirId = referenceId(resource.encounter);
  return record;
}

export function mapGoal(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay = codeableConceptText(resource.description);
  record.status = asString(resource.lifecycleStatus);
  record.effectiveAt =
    asString(resource.startDate) ?? asString(resource.statusDate);
  return record;
}

export function mapSpecimen(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay = codeableConceptText(resource.type);
  record.status = asString(resource.status);
  const collection = asObject(resource.collection);
  record.effectiveAt = collection
    ? asString(collection.collectedDateTime)
    : null;
  return record;
}

export function mapDocumentReference(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  record.codeDisplay =
    codeableConceptText(resource.type) ?? asString(resource.description);
  record.status = asString(resource.status) ?? asString(resource.docStatus);
  record.category = codeableConceptCode(asArray(resource.category)[0]);
  record.effectiveAt = asString(resource.date);
  const context = asObject(resource.context);
  record.encounterFhirId = context
    ? referenceId(asArray(context.encounter)[0])
    : null;
  return record;
}

export function mapPatient(resource: Fhir): MappedHealthRecord {
  const record = base(resource);
  const name = asArray(resource.name)[0];
  const given = asArray(name?.given).join(" ");
  const family = name ? asString(name.family) : null;
  record.codeDisplay =
    [given, family].filter((part) => part !== null && part !== "").join(" ") ||
    null;
  record.status = resource.active === false ? "inactive" : "active";
  record.category = asString(resource.gender);
  record.valueText = asString(resource.birthDate);
  record.effectiveAt = asString(resource.birthDate);
  return record;
}

/** Every resource-type mapper, keyed the way Epic names the resource. */
export const MAPPERS: Record<string, (resource: Fhir) => MappedHealthRecord> = {
  Patient: mapPatient,
  Observation: mapObservation,
  DiagnosticReport: mapDiagnosticReport,
  Condition: mapCondition,
  MedicationRequest: mapMedicationRequest,
  AllergyIntolerance: mapAllergyIntolerance,
  Immunization: mapImmunization,
  Encounter: mapEncounter,
  Procedure: mapProcedure,
  Goal: mapGoal,
  Specimen: mapSpecimen,
  DocumentReference: mapDocumentReference,
};

/** Maps one resource by its own `resourceType`, throwing for a type this
 * package does not carry a mapper for (the caller only invokes this for
 * `SEARCHABLE_RESOURCES` plus `Patient`, so this is a defensive check, not a
 * routing table). */
export function mapResource(resource: Fhir): MappedHealthRecord {
  const resourceType = asString(resource.resourceType);
  const mapper = resourceType ? MAPPERS[resourceType] : undefined;
  if (mapper === undefined) {
    throw new Error(`No mapper for resource type "${resourceType}"`);
  }
  return mapper(resource);
}
