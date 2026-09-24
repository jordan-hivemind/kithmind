// The store side of the feed: idempotent upserts into `kith.health_sources`,
// `kith.health_records` and `kith.health_documents` (migration
// 053_health_feed.sql), so a re-run of `pull` never duplicates a row.

import { createKithPool, newKithId } from "@repo/kith-store";
import type { Pool } from "pg";

import type { MappedHealthRecord } from "./mappers.js";

export function openPool(databaseUrl: string): Pool {
  return createKithPool(databaseUrl, 2);
}

export type PersonMatch = {
  id: string;
  spaceId: string;
  canonicalName: string;
};

/**
 * Resolves `--person` to one `kith.entities` row of kind `person`: an exact
 * `kith_id` (the 26-character generated id shape), then an exact case-
 * insensitive canonical-name match, then a case-insensitive alias match.
 * Returns `null` for no match and throws for an ambiguous one (more than one
 * live, unmerged person entity matches) -- `authorize` reports either rather
 * than guessing which household member was meant.
 */
export async function resolvePerson(
  pool: Pool,
  selector: string,
): Promise<PersonMatch | null> {
  const byId = await pool.query<{
    id: string;
    space_id: string;
    canonical_name: string | null;
  }>(
    `SELECT id, space_id, canonical_name
       FROM kith.entities
      WHERE id = $1 AND kind = 'person' AND merged_into IS NULL`,
    [selector],
  );
  if (byId.rows.length === 1) {
    const row = byId.rows[0]!;
    return { id: row.id, spaceId: row.space_id, canonicalName: row.canonical_name ?? selector };
  }

  const byName = await pool.query<{
    id: string;
    space_id: string;
    canonical_name: string | null;
  }>(
    `SELECT id, space_id, canonical_name
       FROM kith.entities
      WHERE kind = 'person'
        AND merged_into IS NULL
        AND (
          lower(canonical_name) = lower($1)
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(coalesce(aliases, '[]'::jsonb)) alias
             WHERE lower(alias) = lower($1)
          )
        )`,
    [selector],
  );
  if (byName.rows.length === 0) return null;
  if (byName.rows.length > 1) {
    throw new Error(
      `"${selector}" matches more than one person; use the person's kith_id instead`,
    );
  }
  const row = byName.rows[0]!;
  return { id: row.id, spaceId: row.space_id, canonicalName: row.canonical_name ?? selector };
}

export type HealthSourceRow = {
  id: string;
  personId: string;
  spaceId: string;
  orgName: string;
  fhirBase: string;
  patientFhirId: string;
  keychainService: string;
  scopes: string;
  lastPulledAt: string | null;
  needsReauthAt: string | null;
};

export async function listHealthSources(pool: Pool): Promise<HealthSourceRow[]> {
  const { rows } = await pool.query<{
    id: string;
    person_id: string;
    space_id: string;
    org_name: string;
    fhir_base: string;
    patient_fhir_id: string;
    keychain_service: string;
    scopes: string;
    last_pulled_at: string | null;
    needs_reauth_at: string | null;
  }>(
    `SELECT id, person_id, space_id, org_name, fhir_base, patient_fhir_id,
            keychain_service, scopes, last_pulled_at, needs_reauth_at
       FROM kith.health_sources
      ORDER BY org_name, id`,
  );
  return rows.map((row) => ({
    id: row.id,
    personId: row.person_id,
    spaceId: row.space_id,
    orgName: row.org_name,
    fhirBase: row.fhir_base,
    patientFhirId: row.patient_fhir_id,
    keychainService: row.keychain_service,
    scopes: row.scopes,
    lastPulledAt: row.last_pulled_at,
    needsReauthAt: row.needs_reauth_at,
  }));
}

export async function upsertHealthSource(
  pool: Pool,
  source: {
    personId: string;
    spaceId: string;
    orgName: string;
    fhirBase: string;
    patientFhirId: string;
    keychainService: string;
    scopes: string;
  },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO kith.health_sources
       (id, person_id, space_id, org_name, fhir_base, patient_fhir_id,
        keychain_service, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (person_id, fhir_base) DO UPDATE
       SET org_name = EXCLUDED.org_name,
           patient_fhir_id = EXCLUDED.patient_fhir_id,
           keychain_service = EXCLUDED.keychain_service,
           scopes = EXCLUDED.scopes,
           needs_reauth_at = NULL
     RETURNING id`,
    [
      newKithId(),
      source.personId,
      source.spaceId,
      source.orgName,
      source.fhirBase,
      source.patientFhirId,
      source.keychainService,
      source.scopes,
    ],
  );
  return rows[0]!.id;
}

export async function recordPullSuccess(pool: Pool, sourceId: string): Promise<void> {
  await pool.query(
    `UPDATE kith.health_sources
        SET last_pulled_at = transaction_timestamp(),
            last_pull_error = NULL
      WHERE id = $1`,
    [sourceId],
  );
}

export async function recordPullFailure(
  pool: Pool,
  sourceId: string,
  message: string,
  needsReauth: boolean,
): Promise<void> {
  await pool.query(
    `UPDATE kith.health_sources
        SET last_pulled_at = transaction_timestamp(),
            last_pull_error = $2,
            needs_reauth_at = CASE WHEN $3 THEN transaction_timestamp()
                                    ELSE needs_reauth_at END
      WHERE id = $1`,
    [sourceId, message, needsReauth],
  );
}

export async function upsertHealthRecord(
  pool: Pool,
  sourceId: string,
  personId: string,
  resourceType: string,
  mapped: MappedHealthRecord,
  raw: unknown,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO kith.health_records
       (id, source_id, person_id, resource_type, fhir_id, effective_at,
        status, code_display, value_text, value_number, value_unit,
        category, encounter_fhir_id, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (source_id, resource_type, fhir_id) DO UPDATE
       SET effective_at = EXCLUDED.effective_at,
           status = EXCLUDED.status,
           code_display = EXCLUDED.code_display,
           value_text = EXCLUDED.value_text,
           value_number = EXCLUDED.value_number,
           value_unit = EXCLUDED.value_unit,
           category = EXCLUDED.category,
           encounter_fhir_id = EXCLUDED.encounter_fhir_id,
           raw = EXCLUDED.raw,
           updated_at = transaction_timestamp()
     RETURNING id`,
    [
      newKithId(),
      sourceId,
      personId,
      resourceType,
      mapped.fhirId,
      mapped.effectiveAt,
      mapped.status,
      mapped.codeDisplay,
      mapped.valueText,
      mapped.valueNumber,
      mapped.valueUnit,
      mapped.category,
      mapped.encounterFhirId,
      JSON.stringify(raw),
    ],
  );
  return rows[0]!.id;
}

export async function upsertHealthDocument(
  pool: Pool,
  document: {
    recordId: string;
    personId: string;
    contentType: string;
    byteLength: number;
    text: string | null;
    storageNote: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.health_documents
       (id, record_id, person_id, content_type, byte_length, text, storage_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (record_id) DO UPDATE
       SET content_type = EXCLUDED.content_type,
           byte_length = EXCLUDED.byte_length,
           text = EXCLUDED.text,
           storage_note = EXCLUDED.storage_note`,
    [
      newKithId(),
      document.recordId,
      document.personId,
      document.contentType,
      document.byteLength,
      document.text,
      document.storageNote,
    ],
  );
}
