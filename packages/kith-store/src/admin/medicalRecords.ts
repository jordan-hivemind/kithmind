// Epic MyChart feed (migration 053_health_feed.sql): the read surface behind
// the admin Health Records screen and the `list_health_records`/
// `get_health_document` MCP tools.
//
// Named `medicalRecords.ts` rather than `health.ts` because `admin/health.ts`
// already exists for ADM-2's "System Health" screen (watcher and processing
// state, not patient data) -- see that file's own header. Two unrelated
// meanings of "health" collided on the obvious filename; this module keeps
// the medical one and leaves the system-health one alone.
//
// Owner-global in the same sense the Plaid feed's `fin_*` tables are:
// `kith.health_sources`/`health_records`/`health_documents` carry a
// `person_id` (and `health_sources` a `space_id`, for MCP authorization --
// see `apps/web/src/lib/mcp/reads.ts`'s `listHealthRecords`), but there is no
// single space this admin screen itself narrows to. It is gated the same way
// `admin/finAccounts.ts` is: by the admin layout's own owner-or-editor check,
// not by a per-row space predicate.
//
// `listHealthOverview` is the one server round trip the admin page's first
// paint (and its refetch) makes. Rather than one SQL query per section, it
// pulls every one of a person's records, sources and documents once each
// and groups/derives everything else in JS: a DiagnosticReport's `result`
// references, a deduped condition's occurrence history, a lab's flag against
// its reference range, and so on all need to look inside a record's `raw`
// FHIR jsonb, and doing that in SQL would mean either a jsonb expression per
// derived column or a stored generated column migration for each one this
// screen turns out to want. `raw` itself is never part of this module's own
// return types -- every shape below is a flat, typed projection of it, so the
// browser never receives the FHIR payload directly.

import { rows, type IdentityCtx } from "../identity/db.js";

const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;

// A generous cap on how many of one person's records this module will ever
// pull into memory for the overview. Today's Epic feed for one person is a
// few hundred rows across every resource type; this is headroom, not a
// pagination boundary -- the overview is meant to hold everything so the
// grouping below (a report's results, a condition's whole history) is
// always complete.
const MAX_OVERVIEW_RECORDS = 20_000;

// ---------------------------------------------------------------------------
// FHIR jsonb helpers
//
// Deliberately not imported from `@repo/epic-feed`: that package depends on
// this one (it writes through `admin`'s upsert helpers), so the dependency
// cannot run the other way. These are small, pure re-implementations of the
// same handful of `CodeableConcept`/`Reference` idioms `epic-feed`'s own
// `mappers.ts` already carries for the same reason: two `raw`-flattening
// packages on either side of one dependency edge.
// ---------------------------------------------------------------------------

type Fhir = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

/** The first coding's `code`. */
function codeableConceptCode(value: unknown): string | null {
  const concept = asObject(value);
  if (concept === null) return null;
  const coding = asArray(concept.coding)[0];
  return coding ? asString(coding.code) : null;
}

/** The LOINC coding's `code`, when a `CodeableConcept` carries one --
 * the identity a lab test's history is grouped by in preference to its
 * display text, which two different panels can share loosely while meaning
 * different tests. */
function loincCode(value: unknown): string | null {
  const concept = asObject(value);
  if (concept === null) return null;
  const loinc = asArray(concept.coding).find((coding) => {
    const system = asString(coding.system);
    return system !== null && system.toLowerCase().includes("loinc");
  });
  return loinc ? asString(loinc.code) : null;
}

/** A `Reference.display`, when present. */
function referenceDisplay(value: unknown): string | null {
  const reference = asObject(value);
  return reference ? asString(reference.display) : null;
}

/** A `Reference.reference`'s trailing id (`ResourceType/id` -> `id`). */
function referenceId(value: unknown): string | null {
  const reference = asObject(value);
  const ref = reference ? asString(reference.reference) : null;
  if (ref === null) return null;
  const slash = ref.lastIndexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

/** `ReferenceRange.low`/`.high` as `"3.5–5.5 mmol/L"`, `"≥3.5"`, `"≤5.5"`, or
 * its own `.text` when there is no numeric bound. */
function referenceRangeText(range: Fhir | undefined): string | null {
  if (range === undefined) return null;
  const low = asObject(range.low);
  const high = asObject(range.high);
  const lowValue = low ? asNumber(low.value) : null;
  const highValue = high ? asNumber(high.value) : null;
  const unit =
    (high ? asString(high.unit) : null) ?? (low ? asString(low.unit) : null);
  const suffix = unit !== null ? ` ${unit}` : "";
  if (lowValue !== null && highValue !== null) {
    return `${lowValue}–${highValue}${suffix}`;
  }
  if (lowValue !== null) return `≥${lowValue}${suffix}`;
  if (highValue !== null) return `≤${highValue}${suffix}`;
  return asString(range.text);
}

/** An observation's flag: its own `interpretation` coding when Epic sent
 * one, otherwise a comparison of `valueNumber` against the first
 * `referenceRange`'s bounds (`"L"`/`"H"`/`"N"`), or null when neither is
 * available. */
function observationFlag(raw: Fhir, valueNumber: number | null): string | null {
  const interpretation = asArray(raw.interpretation)[0];
  const code = interpretation ? codeableConceptCode(interpretation) : null;
  if (code !== null) return code;
  if (valueNumber === null) return null;
  const range = asArray(raw.referenceRange)[0];
  if (range === undefined) return null;
  const low = asObject(range.low);
  const high = asObject(range.high);
  const lowValue = low ? asNumber(low.value) : null;
  const highValue = high ? asNumber(high.value) : null;
  if (lowValue !== null && valueNumber < lowValue) return "L";
  if (highValue !== null && valueNumber > highValue) return "H";
  if (lowValue !== null || highValue !== null) return "N";
  return null;
}

// ---------------------------------------------------------------------------
// Row shapes read out of `kith.health_records`/`health_documents` and their
// `raw` jsonb, before this module groups them into the typed sections the
// page renders.
// ---------------------------------------------------------------------------

type RecordRow = {
  id: string;
  resource_type: string;
  fhir_id: string;
  effective_at: string | null;
  status: string | null;
  code_display: string | null;
  value_text: string | null;
  value_number: string | null;
  value_unit: string | null;
  category: string | null;
  encounter_fhir_id: string | null;
  raw: unknown;
};

type DocumentRow = {
  id: string;
  record_id: string;
  content_type: string;
  byte_length: number;
  text: string | null;
  storage_note: string | null;
};

type SourceRow = {
  org_name: string;
  last_pulled_at: Date | string | null;
  needs_reauth_at: Date | string | null;
};

function rawOf(row: RecordRow): Fhir {
  return asObject(row.raw) ?? {};
}

function numberOf(row: RecordRow): number | null {
  return row.value_number === null ? null : Number(row.value_number);
}

/** Epoch ms from a timestamptz column, which `pg` hands back as a `Date`
 * unless the query itself casts it to text (every clinical date in this
 * module does, and stays a string formatted with `archiveDate`; a source's
 * own pull/reauth moments are a point in time rather than a calendar date,
 * so the header renders them with `tableDateTime` instead, the same
 * convention `admin/model.ts`'s own `epoch()` already uses for a source's
 * freshness timestamps). */
function epochMs(value: Date | string | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

// ---------------------------------------------------------------------------
// Public shapes: what the page and its drawers actually render. Every one of
// these is derived from `RecordRow`/`DocumentRow` above; none carries `raw`.
// ---------------------------------------------------------------------------

export type HealthSourceSummary = {
  orgName: string;
  lastPulledAt: number | null;
  needsReauthAt: number | null;
};

export type LabResultItem = {
  id: string;
  name: string | null;
  testKey: string;
  value: string | null;
  unit: string | null;
  range: string | null;
  flag: string | null;
  date: string | null;
};

export type LabReportGroup = {
  id: string;
  name: string;
  date: string | null;
  category: string | null;
  resultCount: number;
  testsSummary: string;
  testsFull: string;
  results: LabResultItem[];
};

export type LabTestPoint = {
  date: string | null;
  value: string | null;
  unit: string | null;
  range: string | null;
  flag: string | null;
  reportId: string | null;
  reportName: string | null;
};

export type LabTestSeries = {
  testKey: string;
  name: string;
  points: LabTestPoint[];
};

export type ConditionOccurrence = {
  date: string | null;
  category: string | null;
  status: string | null;
  encounterFhirId: string | null;
};

export type ConditionGroup = {
  name: string;
  status: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  occurrenceCount: number;
  onProblemList: boolean;
  occurrences: ConditionOccurrence[];
};

export type MedicationRow = {
  id: string;
  name: string | null;
  status: string | null;
  date: string | null;
  dosageText: string | null;
  requesterDisplay: string | null;
  reasonText: string | null;
};

export type AllergyReaction = {
  manifestation: string | null;
  severity: string | null;
};

export type AllergyRow = {
  id: string;
  name: string | null;
  status: string | null;
  category: string | null;
  criticality: string | null;
  date: string | null;
  reactions: AllergyReaction[];
};

export type ImmunizationRow = {
  id: string;
  name: string | null;
  status: string | null;
  date: string | null;
  lotNumber: string | null;
};

export type EncounterRow = {
  id: string;
  name: string | null;
  status: string | null;
  category: string | null;
  start: string | null;
  end: string | null;
};

export type VitalsReading = {
  name: string | null;
  value: string | null;
  unit: string | null;
  flag: string | null;
};

export type VitalsDayGroup = {
  date: string | null;
  readings: VitalsReading[];
};

export type ClinicalNoteRow = {
  id: string;
  title: string | null;
  date: string | null;
  type: string | null;
  hasText: boolean;
  text: string | null;
  storageNote: string | null;
};

export type HealthOverviewPerson = {
  personId: string;
  personName: string;
  sources: HealthSourceSummary[];
  current: {
    activeProblems: ConditionGroup[];
    activeMedications: MedicationRow[];
    allergies: AllergyRow[];
    mostRecentLabReport: LabReportGroup | null;
    lastEncounter: EncounterRow | null;
  };
  labReports: LabReportGroup[];
  labTests: LabTestSeries[];
  medications: MedicationRow[];
  conditions: ConditionGroup[];
  allergies: AllergyRow[];
  immunizations: ImmunizationRow[];
  encounters: EncounterRow[];
  vitals: VitalsDayGroup[];
  clinicalNotes: ClinicalNoteRow[];
};

export type HealthOverview = {
  people: HealthOverviewPerson[];
};

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function dateOnly(value: string | null): string | null {
  return value === null ? null : value.slice(0, 10);
}

/** Newest first, nulls last -- the sort every section below uses. */
function byDateDesc<T>(dateOf: (item: T) => string | null): (a: T, b: T) => number {
  return (a, b) => {
    const left = dateOf(a);
    const right = dateOf(b);
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return left < right ? 1 : -1;
  };
}

function toLabResultItem(row: RecordRow): LabResultItem {
  const raw = rawOf(row);
  const value = numberOf(row);
  const name = row.code_display;
  const testKey = loincCode(raw.code) ?? name ?? row.id;
  return {
    id: row.id,
    name,
    testKey,
    value: value === null ? row.value_text : String(value),
    unit: row.value_unit,
    range: referenceRangeText(asArray(raw.referenceRange)[0]),
    flag: observationFlag(raw, value),
    date: row.effective_at,
  };
}

function truncateList(names: string[], max = 90): { summary: string; full: string } {
  const full = names.join(", ");
  if (full.length <= max) return { summary: full, full };
  return { summary: `${full.slice(0, max - 1).trimEnd()}…`, full };
}

/**
 * Every lab-relevant `Observation` grouped under the `DiagnosticReport` that
 * lists it in `result[]` (matched by the reference's trailing fhir id), plus
 * a synthetic "Other lab results" group per date for a laboratory
 * observation no report claims. A `DiagnosticReport` with no matches at all
 * (an Imaging study, most often) still gets a row, with zero results.
 */
function buildLabReports(
  observations: RecordRow[],
  diagnosticReports: RecordRow[],
): LabReportGroup[] {
  const obsByFhirId = new Map(observations.map((row) => [row.fhir_id, row]));
  const used = new Set<string>();
  const groups: LabReportGroup[] = [];

  for (const report of diagnosticReports) {
    const raw = rawOf(report);
    const refs = asArray(raw.result)
      .map((reference) => referenceId(reference))
      .filter((id): id is string => id !== null);
    const matched: RecordRow[] = [];
    for (const ref of refs) {
      const obs = obsByFhirId.get(ref);
      if (obs !== undefined && !used.has(obs.id)) {
        matched.push(obs);
        used.add(obs.id);
      }
    }
    const results = matched.map(toLabResultItem);
    const { summary, full } = truncateList(
      results.map((result) => result.name).filter((name): name is string => name !== null),
    );
    groups.push({
      id: report.id,
      name: report.code_display ?? "Untitled report",
      date: report.effective_at,
      category: report.category,
      resultCount: results.length,
      testsSummary: summary,
      testsFull: full,
      results,
    });
  }

  const orphanedLabs = observations.filter(
    (row) => row.category === "laboratory" && !used.has(row.id),
  );
  const byDate = new Map<string, RecordRow[]>();
  for (const row of orphanedLabs) {
    const key = dateOnly(row.effective_at) ?? "unknown";
    const bucket = byDate.get(key);
    if (bucket === undefined) byDate.set(key, [row]);
    else bucket.push(row);
  }
  for (const [key, rowsForDate] of byDate) {
    const results = rowsForDate.map(toLabResultItem);
    const { summary, full } = truncateList(
      results.map((result) => result.name).filter((name): name is string => name !== null),
    );
    groups.push({
      id: `other:${key}`,
      name: "Other lab results",
      date: rowsForDate[0]?.effective_at ?? null,
      category: "laboratory",
      resultCount: results.length,
      testsSummary: summary,
      testsFull: full,
      results,
    });
  }

  return groups.sort(byDateDesc((group) => group.date));
}

/** Every lab result across every report (and "Other lab results" group),
 * regrouped by test identity so a report drawer's test row can open its own
 * trend -- every value that test has ever produced, in one place. */
function buildLabTests(labReports: LabReportGroup[]): LabTestSeries[] {
  const byKey = new Map<string, { name: string; points: LabTestPoint[] }>();
  for (const group of labReports) {
    for (const result of group.results) {
      const entry = byKey.get(result.testKey);
      const point: LabTestPoint = {
        date: result.date,
        value: result.value,
        unit: result.unit,
        range: result.range,
        flag: result.flag,
        reportId: group.id,
        reportName: group.name,
      };
      if (entry === undefined) {
        byKey.set(result.testKey, {
          name: result.name ?? "Unnamed test",
          points: [point],
        });
      } else {
        entry.points.push(point);
      }
    }
  }
  return Array.from(byKey.entries())
    .map(([testKey, entry]) => ({
      testKey,
      name: entry.name,
      points: entry.points.sort(byDateDesc((point) => point.date)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildConditions(rowsForPerson: RecordRow[]): ConditionGroup[] {
  const byName = new Map<string, RecordRow[]>();
  for (const row of rowsForPerson) {
    const key = row.code_display ?? "Unnamed condition";
    const bucket = byName.get(key);
    if (bucket === undefined) byName.set(key, [row]);
    else bucket.push(row);
  }
  const groups = Array.from(byName.entries()).map(([name, occurrenceRows]) => {
    const sorted = [...occurrenceRows].sort(byDateDesc((row) => row.effective_at));
    const withStatus = sorted.find((row) => row.status !== null);
    const dates = occurrenceRows
      .map((row) => row.effective_at)
      .filter((date): date is string => date !== null);
    return {
      name,
      status: withStatus?.status ?? null,
      firstSeen: dates.length > 0 ? dates.reduce((a, b) => (a < b ? a : b)) : null,
      lastSeen: dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null,
      occurrenceCount: occurrenceRows.length,
      onProblemList: occurrenceRows.some((row) => row.category === "problem-list-item"),
      occurrences: sorted.map((row) => ({
        date: row.effective_at,
        category: row.category,
        status: row.status,
        encounterFhirId: row.encounter_fhir_id,
      })),
    };
  });
  return groups.sort((a, b) => {
    if (a.onProblemList !== b.onProblemList) return a.onProblemList ? -1 : 1;
    return byDateDesc<ConditionGroup>((group) => group.lastSeen)(a, b);
  });
}

function toMedicationRow(row: RecordRow): MedicationRow {
  const raw = rawOf(row);
  const reasonCode = asArray(raw.reasonCode)[0];
  return {
    id: row.id,
    name: row.code_display,
    status: row.status,
    date: row.effective_at,
    dosageText: row.value_text,
    requesterDisplay: referenceDisplay(raw.requester),
    reasonText:
      (reasonCode ? codeableConceptText(reasonCode) : null) ??
      referenceDisplay(asArray(raw.reasonReference)[0]),
  };
}

function toAllergyRow(row: RecordRow): AllergyRow {
  const raw = rawOf(row);
  const reactions = asArray(raw.reaction).map((reaction) => ({
    manifestation: codeableConceptText(asArray(reaction.manifestation)[0]),
    severity: asString(reaction.severity),
  }));
  return {
    id: row.id,
    name: row.code_display,
    status: row.status,
    category: row.category,
    criticality: row.value_text,
    date: row.effective_at,
    reactions,
  };
}

function toImmunizationRow(row: RecordRow): ImmunizationRow {
  const raw = rawOf(row);
  return {
    id: row.id,
    name: row.code_display,
    status: row.status,
    date: row.effective_at,
    lotNumber: asString(raw.lotNumber),
  };
}

function toEncounterRow(row: RecordRow): EncounterRow {
  return {
    id: row.id,
    name: row.code_display,
    status: row.status,
    category: row.category,
    start: row.effective_at,
    end: row.value_text,
  };
}

function buildVitals(rowsForPerson: RecordRow[]): VitalsDayGroup[] {
  const byDate = new Map<string, RecordRow[]>();
  for (const row of rowsForPerson) {
    const key = dateOnly(row.effective_at) ?? "unknown";
    const bucket = byDate.get(key);
    if (bucket === undefined) byDate.set(key, [row]);
    else bucket.push(row);
  }
  return Array.from(byDate.entries())
    .map(([, rowsForDate]) => ({
      date: rowsForDate[0]?.effective_at ?? null,
      readings: rowsForDate.map((row) => {
        const raw = rawOf(row);
        const value = numberOf(row);
        return {
          name: row.code_display,
          value: value === null ? row.value_text : String(value),
          unit: row.value_unit,
          flag: observationFlag(raw, value),
        };
      }),
    }))
    .sort(byDateDesc((group) => group.date));
}

function buildClinicalNotes(
  rowsForPerson: RecordRow[],
  documentsByRecordId: Map<string, DocumentRow>,
): ClinicalNoteRow[] {
  return rowsForPerson
    .map((row) => {
      const document = documentsByRecordId.get(row.id);
      return {
        id: row.id,
        title: row.code_display,
        date: row.effective_at,
        type: row.category,
        hasText: document?.text !== undefined && document.text !== null,
        text: document?.text ?? null,
        storageNote: document?.storage_note ?? null,
      };
    })
    .sort(byDateDesc((row) => row.date));
}

async function overviewForPerson(
  ctx: IdentityCtx,
  personId: string,
  personName: string,
): Promise<HealthOverviewPerson> {
  const sourceRows = await rows<SourceRow>(
    ctx,
    `SELECT org_name, last_pulled_at, needs_reauth_at
       FROM kith.health_sources
      WHERE person_id = $1
      ORDER BY org_name`,
    [personId],
  );

  const recordRows = await rows<RecordRow>(
    ctx,
    `SELECT id, resource_type, fhir_id, effective_at::text AS effective_at,
            status, code_display, value_text,
            value_number::text AS value_number, value_unit, category,
            encounter_fhir_id, raw
       FROM kith.health_records
      WHERE person_id = $1
      ORDER BY effective_at DESC NULLS LAST, updated_at DESC
      LIMIT $2`,
    [personId, MAX_OVERVIEW_RECORDS],
  );

  const documentRows = await rows<DocumentRow>(
    ctx,
    `SELECT id, record_id, content_type, byte_length, text, storage_note
       FROM kith.health_documents
      WHERE person_id = $1`,
    [personId],
  );
  const documentsByRecordId = new Map(documentRows.map((row) => [row.record_id, row]));

  const byType = new Map<string, RecordRow[]>();
  for (const row of recordRows) {
    const bucket = byType.get(row.resource_type);
    if (bucket === undefined) byType.set(row.resource_type, [row]);
    else bucket.push(row);
  }
  const of = (resourceType: string) => byType.get(resourceType) ?? [];

  const observations = of("Observation");
  const labObservations = observations.filter((row) => row.category === "laboratory");
  const vitalsObservations = observations.filter((row) => row.category === "vital-signs");

  const labReports = buildLabReports(labObservations, of("DiagnosticReport"));
  const labTests = buildLabTests(labReports);
  const conditions = buildConditions(of("Condition"));
  const medications = of("MedicationRequest")
    .map(toMedicationRow)
    .sort(byDateDesc((row) => row.date));
  const allergies = of("AllergyIntolerance")
    .map(toAllergyRow)
    .sort(byDateDesc((row) => row.date));
  const immunizations = of("Immunization")
    .map(toImmunizationRow)
    .sort(byDateDesc((row) => row.date));
  const encounters = of("Encounter")
    .map(toEncounterRow)
    .sort(byDateDesc((row) => row.start));
  const vitals = buildVitals(vitalsObservations);
  const clinicalNotes = buildClinicalNotes(of("DocumentReference"), documentsByRecordId);

  const activeProblems = conditions.filter(
    (condition) =>
      condition.onProblemList && (condition.status === "active" || condition.status === null),
  );
  const activeMedications = medications.filter((medication) => medication.status === "active");

  return {
    personId,
    personName,
    sources: sourceRows.map((row) => ({
      orgName: row.org_name,
      lastPulledAt: epochMs(row.last_pulled_at),
      needsReauthAt: epochMs(row.needs_reauth_at),
    })),
    current: {
      activeProblems,
      activeMedications,
      allergies,
      mostRecentLabReport: labReports[0] ?? null,
      lastEncounter: encounters[0] ?? null,
    },
    labReports,
    labTests,
    medications,
    conditions,
    allergies,
    immunizations,
    encounters,
    vitals,
    clinicalNotes,
  };
}

/**
 * Every person with a linked Epic source (or just one, when `personId` is
 * given): their current state (active problems, active medications,
 * allergies, most recent lab report, last encounter) plus every section's
 * full history. See `HealthOverviewPerson` for the exact shape.
 */
export async function listHealthOverview(
  ctx: IdentityCtx,
  args: { personId?: string } = {},
): Promise<HealthOverview> {
  const people = await rows<{ person_id: string; canonical_name: string | null }>(
    ctx,
    `SELECT DISTINCT hs.person_id, e.canonical_name
       FROM kith.health_sources hs
       LEFT JOIN kith.entities e ON e.id = hs.person_id
      WHERE $1::kith.kith_id IS NULL OR hs.person_id = $1
      ORDER BY e.canonical_name NULLS LAST, hs.person_id`,
    [args.personId ?? null],
  );
  const overview = await Promise.all(
    people.map((row) =>
      overviewForPerson(ctx, row.person_id, row.canonical_name ?? row.person_id),
    ),
  );
  return { people: overview };
}

export type HealthRecordRow = {
  id: string;
  sourceId: string;
  personId: string;
  resourceType: string;
  fhirId: string;
  effectiveAt: string | null;
  status: string | null;
  codeDisplay: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueUnit: string | null;
  category: string | null;
  encounterFhirId: string | null;
  updatedAt: string;
};

type Cursor = { sortAt: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (typeof parsed.sortAt !== "string" || typeof parsed.id !== "string") {
      throw new Error("invalid cursor shape");
    }
    return parsed;
  } catch {
    throw new Error("Invalid cursor");
  }
}

/**
 * One person's raw records, optionally narrowed to a resource type and/or
 * an `effective_at` (or `updated_at`, for a record with no clinical date)
 * lower bound, newest first. Keyset-paginated on
 * `(coalesce(effective_at, updated_at), id)` rather than offset, so a page
 * boundary is stable even while `pull` is writing concurrently.
 */
export async function listHealthRecords(
  ctx: IdentityCtx,
  args: {
    personId: string;
    resourceType?: string;
    since?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<{ records: HealthRecordRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const cursor = args.cursor !== undefined ? decodeCursor(args.cursor) : null;
  const found = await rows<{
    id: string;
    source_id: string;
    person_id: string;
    resource_type: string;
    fhir_id: string;
    effective_at: string | null;
    status: string | null;
    code_display: string | null;
    value_text: string | null;
    value_number: string | null;
    value_unit: string | null;
    category: string | null;
    encounter_fhir_id: string | null;
    updated_at: string;
    sort_at: string;
  }>(
    ctx,
    `SELECT id, source_id, person_id, resource_type, fhir_id,
            effective_at::text AS effective_at, status, code_display,
            value_text, value_number::text AS value_number, value_unit,
            category, encounter_fhir_id, updated_at::text AS updated_at,
            coalesce(effective_at, updated_at)::text AS sort_at
       FROM kith.health_records
      WHERE person_id = $1
        AND ($2::text IS NULL OR resource_type = $2)
        AND ($3::timestamptz IS NULL OR effective_at >= $3)
        AND (
          $4::timestamptz IS NULL
          OR (coalesce(effective_at, updated_at), id) < ($4::timestamptz, $5::text)
        )
      ORDER BY coalesce(effective_at, updated_at) DESC, id DESC
      LIMIT $6`,
    [
      args.personId,
      args.resourceType ?? null,
      args.since ?? null,
      cursor?.sortAt ?? null,
      cursor?.id ?? null,
      limit,
    ],
  );
  const records = found.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    personId: row.person_id,
    resourceType: row.resource_type,
    fhirId: row.fhir_id,
    effectiveAt: row.effective_at,
    status: row.status,
    codeDisplay: row.code_display,
    valueText: row.value_text,
    valueNumber: row.value_number === null ? null : Number(row.value_number),
    valueUnit: row.value_unit,
    category: row.category,
    encounterFhirId: row.encounter_fhir_id,
    updatedAt: row.updated_at,
  }));
  const last = found[found.length - 1];
  const nextCursor =
    found.length === limit && last !== undefined
      ? encodeCursor({ sortAt: last.sort_at, id: last.id })
      : null;
  return { records, nextCursor };
}

export type HealthDocumentRow = {
  id: string;
  recordId: string;
  personId: string;
  contentType: string;
  byteLength: number;
  text: string | null;
  storageNote: string | null;
  createdAt: string;
};

/** One document by id, for `get_health_document`. Null when it does not
 * exist -- the caller decides what an authorization mismatch versus a
 * missing id means. */
export async function getHealthDocument(
  ctx: IdentityCtx,
  documentId: string,
): Promise<HealthDocumentRow | null> {
  const found = await rows<{
    id: string;
    record_id: string;
    person_id: string;
    content_type: string;
    byte_length: number;
    text: string | null;
    storage_note: string | null;
    created_at: string;
  }>(
    ctx,
    `SELECT id, record_id, person_id, content_type, byte_length, text,
            storage_note, created_at::text AS created_at
       FROM kith.health_documents
      WHERE id = $1`,
    [documentId],
  );
  const row = found[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    recordId: row.record_id,
    personId: row.person_id,
    contentType: row.content_type,
    byteLength: row.byte_length,
    text: row.text,
    storageNote: row.storage_note,
    createdAt: row.created_at,
  };
}

/** The space a person's health data is authorized under, for the MCP gate
 * (`kith.health_sources.space_id`) -- null when this person has no linked
 * Epic source at all. */
export async function healthPersonSpaceId(
  ctx: IdentityCtx,
  personId: string,
): Promise<string | null> {
  const found = await rows<{ space_id: string }>(
    ctx,
    `SELECT space_id FROM kith.health_sources WHERE person_id = $1 LIMIT 1`,
    [personId],
  );
  return found[0]?.space_id ?? null;
}

/** The space a health document's owning person is authorized under, for
 * `get_health_document`'s MCP gate. Null when the document does not exist or
 * its person has no linked source. */
export async function healthDocumentSpaceId(
  ctx: IdentityCtx,
  documentId: string,
): Promise<string | null> {
  const found = await rows<{ space_id: string }>(
    ctx,
    `SELECT hs.space_id
       FROM kith.health_documents hd
       JOIN kith.health_sources hs ON hs.person_id = hd.person_id
      WHERE hd.id = $1
      LIMIT 1`,
    [documentId],
  );
  return found[0]?.space_id ?? null;
}
