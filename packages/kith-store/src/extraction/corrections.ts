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
import type { CorrectionReason } from "./gate.js";

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
  return id;
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
           AND o.observation_type = $3
         ORDER BY o.observation_key LIMIT 1`,
      [spaceId, sourceItemId, fieldName],
    )
  ).rows[0];
  return found?.value ?? null;
}

/** The field names of one document that a human has already settled. The
 * extraction writer reads this so a re-run never re-opens a fixed field. */
export async function resolvedCorrections(
  client: ClientBase,
  spaceId: string,
  sourceItemId: string,
): Promise<Set<string>> {
  const rows = (
    await client.query<{ field_name: string | null }>(
      `SELECT field_name FROM kith.corrections
        WHERE space_id = $1 AND target_kind = 'document' AND target_id = $2
          AND state = 'resolved' LIMIT 512`,
      [spaceId, sourceItemId],
    )
  ).rows;
  return new Set(
    rows
      .map((row) => row.field_name)
      .filter((name): name is string => name !== null),
  );
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
