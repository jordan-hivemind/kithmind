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

import { rows, type IdentityCtx } from "../identity/db.js";

const MAX_LAB_RESULTS = 25;
const MAX_ENCOUNTERS = 10;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;

export type HealthRecordSummary = {
  id: string;
  resourceType: string;
  name: string | null;
  status: string | null;
  value: string | null;
  unit: string | null;
  flag: string | null;
  date: string | null;
};

function toSummary(row: {
  id: string;
  resource_type: string;
  code_display: string | null;
  status: string | null;
  value_text: string | null;
  value_number: string | null;
  value_unit: string | null;
  effective_at: string | null;
}): HealthRecordSummary {
  const hasNumber = row.value_number !== null;
  return {
    id: row.id,
    resourceType: row.resource_type,
    name: row.code_display,
    status: row.status,
    value: hasNumber ? row.value_number : row.value_text,
    unit: row.value_unit,
    // `value_text` carries a quantity observation's abnormal-result flag
    // (mappers.ts's own double-duty convention); it is only ever meaningful
    // as a "flag" when a quantity value is also present.
    flag: hasNumber ? row.value_text : null,
    date: row.effective_at,
  };
}

async function listByType(
  ctx: IdentityCtx,
  personId: string,
  resourceType: string,
  limit: number,
): Promise<HealthRecordSummary[]> {
  const found = await rows<{
    id: string;
    resource_type: string;
    code_display: string | null;
    status: string | null;
    value_text: string | null;
    value_number: string | null;
    value_unit: string | null;
    effective_at: string | null;
  }>(
    ctx,
    `SELECT id, resource_type, code_display, status, value_text,
            value_number::text AS value_number, value_unit,
            effective_at::text AS effective_at
       FROM kith.health_records
      WHERE person_id = $1 AND resource_type = $2
      ORDER BY effective_at DESC NULLS LAST, updated_at DESC
      LIMIT $3`,
    [personId, resourceType, limit],
  );
  return found.map(toSummary);
}

export type HealthOverviewPerson = {
  personId: string;
  personName: string;
  countsByType: Record<string, number>;
  labResults: HealthRecordSummary[];
  activeMedications: HealthRecordSummary[];
  conditions: HealthRecordSummary[];
  immunizations: HealthRecordSummary[];
  encounters: HealthRecordSummary[];
  documentsCount: number;
};

export type HealthOverview = {
  people: HealthOverviewPerson[];
};

async function overviewForPerson(
  ctx: IdentityCtx,
  personId: string,
  personName: string,
): Promise<HealthOverviewPerson> {
  const counts = await rows<{ resource_type: string; count: string }>(
    ctx,
    `SELECT resource_type, count(*)::text AS count
       FROM kith.health_records
      WHERE person_id = $1
      GROUP BY resource_type`,
    [personId],
  );
  const countsByType = Object.fromEntries(
    counts.map((row) => [row.resource_type, Number(row.count)]),
  );

  const labResultsRaw = await rows<{
    id: string;
    resource_type: string;
    code_display: string | null;
    status: string | null;
    value_text: string | null;
    value_number: string | null;
    value_unit: string | null;
    effective_at: string | null;
  }>(
    ctx,
    `SELECT id, resource_type, code_display, status, value_text,
            value_number::text AS value_number, value_unit,
            effective_at::text AS effective_at
       FROM kith.health_records
      WHERE person_id = $1
        AND resource_type = 'Observation'
        AND (category = 'laboratory' OR category IS NULL)
      ORDER BY effective_at DESC NULLS LAST, updated_at DESC
      LIMIT $2`,
    [personId, MAX_LAB_RESULTS],
  );

  const activeMedicationsRaw = await rows<{
    id: string;
    resource_type: string;
    code_display: string | null;
    status: string | null;
    value_text: string | null;
    value_number: string | null;
    value_unit: string | null;
    effective_at: string | null;
  }>(
    ctx,
    `SELECT id, resource_type, code_display, status, value_text,
            value_number::text AS value_number, value_unit,
            effective_at::text AS effective_at
       FROM kith.health_records
      WHERE person_id = $1 AND resource_type = 'MedicationRequest'
        AND status = 'active'
      ORDER BY effective_at DESC NULLS LAST, updated_at DESC`,
    [personId],
  );

  const documentsCount = await rows<{ count: string }>(
    ctx,
    `SELECT count(*)::text AS count
       FROM kith.health_documents
      WHERE person_id = $1`,
    [personId],
  );

  return {
    personId,
    personName,
    countsByType,
    labResults: labResultsRaw.map(toSummary),
    activeMedications: activeMedicationsRaw.map(toSummary),
    conditions: await listByType(ctx, personId, "Condition", MAX_LIST_LIMIT),
    immunizations: await listByType(ctx, personId, "Immunization", MAX_LIST_LIMIT),
    encounters: await listByType(ctx, personId, "Encounter", MAX_ENCOUNTERS),
    documentsCount: Number(documentsCount[0]?.count ?? "0"),
  };
}

/**
 * Every person with a linked Epic source (or just one, when `personId` is
 * given), each with counts by resource type, the latest lab results,
 * currently-active medications, conditions, immunizations, recent encounters
 * and a document count. See `HealthOverviewPerson` for the exact shape.
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
