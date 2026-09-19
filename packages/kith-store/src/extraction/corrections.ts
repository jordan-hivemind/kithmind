// Corrections: the visible half of "wrong or unsure extractions are visible
// and correctable, never silent".
//
// Two ways a row gets here.
//
//   * The gate refused a statement. The row is `open`, carries the model's
//     reading and a reason code, and has no corrected value yet.
//   * The owner fixed a field. The row is `resolved` and carries both the
//     original reading and the correction.
//
// One rule governs both, and it is the whole reason corrections are a separate
// table rather than an edit to the observation: **a read prefers the
// correction, and re-extraction never overwrites one.** The extraction writer
// replaces its own observations wholesale on every run; the corrections rows
// survive it untouched, so a field the owner fixed in March still reads
// corrected after a re-extraction in June, with the model's newer reading kept
// beside it rather than instead of it.
//
// `target_kind` is `'document'` and `target_id` is the **source item** id, not
// a `brain_documents` id. A re-parse mints new document rows; the source item
// is what survives one, so it is the only identity a correction can be keyed
// by and still be there afterwards.

import type { ClientBase } from "pg";

import { newKithId } from "../ids.js";
import {
  canonicalizeObservationValue,
  type ObservationValue,
} from "../records/values.js";
import type { CorrectionReason } from "./gate.js";

/** The seven `ObservationValue` discriminants, as a set. Kept beside its one
 * caller rather than exported from `values.ts`, which states them as a union
 * type that has no runtime form. */
const OBSERVATION_VALUE_TYPES = new Set([
  "decimal",
  "money",
  "integer",
  "text",
  "boolean",
  "date",
  "entity",
]);

export type CorrectionRow = {
  id: string;
  fieldName: string | null;
  reason: string | null;
  originalValue: unknown;
  correctedValue: unknown;
  state: "open" | "resolved";
  createdAt: Date;
  resolvedAt: Date | null;
};

/**
 * Opens one item for a statement the gate refused.
 *
 * De-duplicated on (document, field, reason): re-running extraction on an
 * unchanged document must not grow the queue by one row per run.
 */
export async function openCorrection(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceItemId: string;
    fieldName: string | null;
    reason: CorrectionReason;
    reading: unknown;
  },
): Promise<string | null> {
  const existing = (
    await client.query<{ id: string }>(
      `SELECT id FROM kith.corrections
        WHERE space_id = $1 AND target_kind = 'document' AND target_id = $2
          AND field_name IS NOT DISTINCT FROM $3 AND reason = $4
          AND state = 'open' LIMIT 1`,
      [input.spaceId, input.sourceItemId, input.fieldName, input.reason],
    )
  ).rows[0];
  if (existing) {
    await client.query(
      `UPDATE kith.corrections SET original_value = $2 WHERE id = $1`,
      [existing.id, JSON.stringify(input.reading ?? null)],
    );
    return existing.id;
  }
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.corrections
       (id, space_id, target_kind, target_id, field_name, original_value,
        reason, state)
     VALUES ($1,$2,'document',$3,$4,$5,$6,'open')`,
    [
      id,
      input.spaceId,
      input.sourceItemId,
      input.fieldName,
      JSON.stringify(input.reading ?? null),
      input.reason,
    ],
  );
  return id;
}

/**
 * Records the owner's fix for one field of one document.
 *
 * Idempotent per field: a second correction of the same field replaces the
 * first rather than stacking, and the original reading is preserved from
 * whichever row was already there (an open gate failure keeps the model's
 * reading; a first correction of a field that passed the gate records the
 * reading it is replacing).
 */
export async function applyCorrection(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceItemId: string;
    fieldName: string;
    correctedValue: unknown;
    actorUserId: string;
    reason?: string;
    now?: number;
  },
): Promise<string> {
  const at = new Date(input.now ?? Date.now());
  const existing = (
    await client.query<{ id: string; original_value: unknown }>(
      `SELECT id, original_value FROM kith.corrections
        WHERE space_id = $1 AND target_kind = 'document' AND target_id = $2
          AND field_name = $3
        ORDER BY created_at DESC, id LIMIT 1`,
      [input.spaceId, input.sourceItemId, input.fieldName],
    )
  ).rows[0];
  const original =
    existing?.original_value ??
    (await currentReading(
      client,
      input.spaceId,
      input.sourceItemId,
      input.fieldName,
    ));
  if (existing) {
    await client.query(
      `UPDATE kith.corrections
          SET corrected_value = $2, actor_user_id = $3, reason = $4,
              state = 'resolved', resolved_at = $5, original_value = $6
        WHERE id = $1`,
      [
        existing.id,
        JSON.stringify(input.correctedValue ?? null),
        input.actorUserId,
        input.reason ?? null,
        at,
        JSON.stringify(original ?? null),
      ],
    );
    await writeThrough(client, input);
    return existing.id;
  }
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.corrections
       (id, space_id, target_kind, target_id, field_name, original_value,
        corrected_value, actor_user_id, reason, state, resolved_at)
     VALUES ($1,$2,'document',$3,$4,$5,$6,$7,$8,'resolved',$9)`,
    [
      id,
      input.spaceId,
      input.sourceItemId,
      input.fieldName,
      JSON.stringify(original ?? null),
      JSON.stringify(input.correctedValue ?? null),
      input.actorUserId,
      input.reason ?? null,
      at,
    ],
  );
  await writeThrough(client, input);
  return id;
}

/**
 * Pushes the corrected value onto the observation the correction replaces, in
 * the same transaction as the correction row.
 *
 * Without this the two halves of the system disagree about the same fact:
 * `get_document` would read the correction and say 250,000 while `sum_money`
 * and `latest_observation` kept totalling the model's 25,000, and both would
 * cite the same span. One number, one transaction.
 *
 * A corrected value that is not a valid `ObservationValue` updates nothing and
 * is not an error. The correction row still stands and the document read still
 * prefers it; what it cannot do is enter the exact-arithmetic side of the
 * store, where a malformed value would be worse than an un-updated one. The
 * evidence stays as it was: the span is what the document says, and correcting
 * a reading does not change the document.
 */
async function writeThrough(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceItemId: string;
    fieldName: string;
    correctedValue: unknown;
  },
): Promise<number> {
  let value: ObservationValue;
  try {
    // The shape check comes first and is not optional.
    // `canonicalizeObservationValue` switches on `value.type` with no default,
    // so a value that is not one of the seven falls out of the switch as
    // `undefined` rather than throwing -- and `undefined` binds as SQL NULL,
    // which would blank the observation instead of leaving it alone.
    const candidate = input.correctedValue as { type?: unknown } | null;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !OBSERVATION_VALUE_TYPES.has(candidate.type as string)
    ) {
      return 0;
    }
    value = canonicalizeObservationValue(candidate as ObservationValue);
  } catch {
    return 0;
  }
  // `observation_key`, not `observation_type`. A single-value field's key is
  // its own name, so the two are the same there; a `line_item_list` field has
  // one observation per item keyed `line_items:0`, `line_items:1`, and
  // matching on the type would overwrite every line of the receipt with the
  // correction meant for one of them.
  const updated = await client.query(
    `UPDATE kith.observations SET value = $4
      WHERE space_id = $1 AND source_item_id = $2
        AND event_type = 'document_statement' AND observation_key = $3`,
    [input.spaceId, input.sourceItemId, input.fieldName, JSON.stringify(value)],
  );
  return updated.rowCount ?? 0;
}

/**
 * Re-applies every resolved correction for one document to the observations
 * that were just written.
 *
 * The extraction writer replaces its observations wholesale on every run, so
 * without this a re-extraction quietly undoes the owner's fix on the exact
 * side while `get_document` goes on showing it: `latest_observation` would say
 * 15.50 and the document read 16.50, from the same transaction, about the same
 * field. Called at the end of the replace, inside it.
 */
export async function reapplyCorrections(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string },
): Promise<number> {
  let applied = 0;
  for (const [fieldName, correctedValue] of await resolvedCorrections(
    client,
    input.spaceId,
    input.sourceItemId,
  )) {
    applied += await writeThrough(client, {
      ...input,
      fieldName,
      correctedValue,
    });
  }
  return applied;
}

/** What the extraction currently says about one field, for the record of what
 * a correction replaced. */
async function currentReading(
  client: ClientBase,
  spaceId: string,
  sourceItemId: string,
  fieldName: string,
): Promise<unknown> {
  const found = (
    await client.query<{ value: unknown }>(
      `SELECT o.value FROM kith.observations o
         WHERE o.space_id = $1 AND o.source_item_id = $2
           AND o.event_type = 'document_statement'
           AND o.observation_key = $3
         LIMIT 1`,
      [spaceId, sourceItemId, fieldName],
    )
  ).rows[0];
  return found?.value ?? null;
}

/**
 * What a human has already settled on this document, by field name.
 *
 * Two readers. The extraction writer uses the keys, so a re-run never re-opens
 * a field the owner has fixed; `reapplyCorrections` uses the values, so the
 * fix survives the observations being replaced.
 */
export async function resolvedCorrections(
  client: ClientBase,
  spaceId: string,
  sourceItemId: string,
): Promise<Map<string, unknown>> {
  const rows = (
    await client.query<{ field_name: string | null; corrected_value: unknown }>(
      `SELECT field_name, corrected_value FROM kith.corrections
        WHERE space_id = $1 AND target_kind = 'document' AND target_id = $2
          AND state = 'resolved'
        ORDER BY resolved_at, id LIMIT 512`,
      [spaceId, sourceItemId],
    )
  ).rows;
  const settled = new Map<string, unknown>();
  for (const row of rows) {
    if (row.field_name !== null) settled.set(row.field_name, row.corrected_value);
  }
  return settled;
}

/** Every correction on one document, newest first. Used by the read side to
 * prefer a corrected value and to show an open item beside the reading. */
export async function listDocumentCorrections(
  client: ClientBase,
  spaceId: string,
  sourceItemId: string,
): Promise<CorrectionRow[]> {
  const rows = (
    await client.query<Record<string, unknown>>(
      `SELECT id, field_name, reason, original_value, corrected_value, state,
              created_at, resolved_at
         FROM kith.corrections
        WHERE space_id = $1 AND target_kind = 'document' AND target_id = $2
        ORDER BY created_at DESC, id LIMIT 512`,
      [spaceId, sourceItemId],
    )
  ).rows;
  return rows.map((row) => ({
    id: String(row.id),
    fieldName: (row.field_name ?? null) as string | null,
    reason: (row.reason ?? null) as string | null,
    originalValue: row.original_value ?? null,
    correctedValue: row.corrected_value ?? null,
    state: row.state as "open" | "resolved",
    createdAt: row.created_at as Date,
    resolvedAt: (row.resolved_at ?? null) as Date | null,
  }));
}
