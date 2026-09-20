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

import { isAttentionMuted } from "../admin/attention.js";
import { ProofError } from "../errors.js";
import { newKithId } from "../ids.js";
import { occurrenceSortKey } from "../records/model.js";
import type { Occurrence } from "../records/values.js";
import {
  canonicalizeObservationValue,
  type ObservationValue,
} from "../records/values.js";
import type { CorrectionReason } from "./gate.js";

/** The one detector name every extraction gate failure carries (ADM-8a).
 * `openCorrection` has one caller, `model.ts`, so this is not yet a
 * parameter -- see the module comment on `openCorrection` for why. */
const EXTRACTION_DETECTOR = "extraction";

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

/** The one attention-queue key a gate failure ever carries: the document,
 * the field it failed on (or none, for a document-level reason such as
 * `input_truncated`), and why. Doubles as `corrections.dedupe_key` (ADM-8a),
 * so "the same target+field+reason must never reopen" and "the same
 * dedupe_key must never reopen" are the same rule rather than two to keep in
 * sync. */
function extractionDedupeKey(
  sourceItemId: string,
  fieldName: string | null,
  reason: CorrectionReason,
): string {
  return `extraction:${sourceItemId}:${fieldName ?? "_"}:${reason}`;
}

/**
 * Opens one item for a statement the gate refused.
 *
 * De-duplicated on `dedupe_key` (document, field, reason), which the partial
 * unique index in migration 030 enforces at most one open-or-snoozed row for:
 * re-running extraction on an unchanged document must not grow the queue by
 * one row per run.
 *
 * Two ADM-8a rules on top of that:
 *
 *   * A mute on the `extraction` detector, on this document's kind, or on
 *     this document's source root (`kith.attention_mutes`) refuses the whole
 *     write. Prospective, the same as every mute: it stops a row from being
 *     opened, it does not go looking for one already open. `documentKind`
 *     and `sourceRootId` are the caller's (`model.ts` already knows the
 *     kind it read the document as, and resolves the root -- see
 *     `resolveUnambiguousSourceRoot`); neither is required, so a caller that
 *     cannot supply one simply cannot be muted on it.
 *   * A row the owner dismissed ("not worth backfilling" or one of the other
 *     closed reasons) is never reopened, however many times the same field
 *     fails the gate again. A row this function itself auto-cleared
 *     (`supersedeOpenCorrections`, `resolved`/`cleared`) is not the same
 *     case -- the condition came back, so it reopens -- and a `snoozed` row
 *     keeps its snooze rather than popping back open under the owner.
 */
export async function openCorrection(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceItemId: string;
    fieldName: string | null;
    reason: CorrectionReason;
    reading: unknown;
    documentKind?: string | null;
    sourceRootId?: string | null;
  },
): Promise<string | null> {
  if (
    await isAttentionMuted(client, input.spaceId, {
      detector: EXTRACTION_DETECTOR,
      documentKind: input.documentKind,
      sourceRootId: input.sourceRootId,
    })
  ) {
    return null;
  }
  const dedupeKey = extractionDedupeKey(
    input.sourceItemId,
    input.fieldName,
    input.reason,
  );
  const existing = (
    await client.query<{ id: string; state: string }>(
      `SELECT id, state FROM kith.corrections
        WHERE space_id = $1 AND dedupe_key = $2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.spaceId, dedupeKey],
    )
  ).rows[0];
  if (existing?.state === "dismissed") return existing.id;
  if (existing?.state === "snoozed") {
    await client.query(
      `UPDATE kith.corrections SET original_value = $2 WHERE id = $1`,
      [existing.id, JSON.stringify(input.reading ?? null)],
    );
    return existing.id;
  }
  if (existing) {
    // `reason` is reset here too, not just `state`: `supersedeOpenCorrections`
    // overwrites it to `'cleared'` on the same row when the failure stops
    // reproducing, and `dedupe_key` (which does encode the reason) is not
    // parsed back out of, so without this a failure that recurs would reopen
    // with the *previous* run's "why" still showing `cleared`.
    await client.query(
      `UPDATE kith.corrections
          SET original_value = $2, state = 'open', resolved_at = NULL,
              reason = $3
        WHERE id = $1`,
      [existing.id, JSON.stringify(input.reading ?? null), input.reason],
    );
    return existing.id;
  }
  // `ON CONFLICT`, not a bare INSERT: the SELECT above and this INSERT are
  // two statements, so two concurrent extractions of the same document can
  // both pass the SELECT seeing nothing, then both reach here. Without the
  // conflict clause the second INSERT would hit
  // `corrections_dedupe_key_idx` and abort its whole transaction over a
  // race that is not actually an error -- both writers agree on the row
  // that should exist. The target matches that partial index exactly, so
  // PostgreSQL can infer it; a `dismissed` row (never in it) still cannot
  // conflict here, which is correct -- that case already returned above.
  // `reason` needs no update on conflict: `dedupe_key` encodes it, so the
  // winner already has the same one.
  const id = newKithId();
  const written = await client.query<{ id: string }>(
    `INSERT INTO kith.corrections
       (id, space_id, target_kind, target_id, field_name, original_value,
        reason, state, dedupe_key)
     VALUES ($1,$2,'document',$3,$4,$5,$6,'open',$7)
     ON CONFLICT (space_id, dedupe_key) WHERE state IN ('open', 'snoozed')
     DO UPDATE SET original_value = EXCLUDED.original_value
     RETURNING id`,
    [
      id,
      input.spaceId,
      input.sourceItemId,
      input.fieldName,
      JSON.stringify(input.reading ?? null),
      input.reason,
      dedupeKey,
    ],
  );
  return written.rows[0]!.id;
}

/**
 * Records the owner's fix for one reading of one document.
 *
 * `fieldName` names **one observation**, not a group of them. For a scalar
 * field the two are the same word: `total`'s observation key is `total`. A
 * `line_item_list` field has one observation per line, keyed by their own evidence, and a correction must name the line it fixes. Naming the
 * bare list field is refused with `correction_target_is_a_list_field` rather
 * than accepted and then silently matching nothing, which is what it did
 * before: the row was written, the screen showed the fix, and every reader of
 * the numbers went on seeing the model's.
 *
 * Idempotent per target: a second correction of the same one replaces the
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
  await requireSingleTarget(client, input);
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
 * Refuses a correction that names a group of observations rather than one.
 *
 * A field with no observation of its own key, but observations carrying its
 * name as their type, is a list: `line_items` with keys like
 * `line_items:7-a3f1b2c-0` under it. Correcting "the line items" has no single meaning,
 * so it is an error the caller sees rather than a write that lands nowhere.
 * A field with no observations at all is allowed through: it is an ordinary
 * correction of something the gate refused, and the value is stored for when
 * the extraction next runs.
 */
async function requireSingleTarget(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string; fieldName: string },
): Promise<void> {
  const exact = await client.query(
    `SELECT 1 FROM kith.observations
      WHERE space_id = $1 AND source_item_id = $2
        AND event_type = 'document_statement' AND observation_key = $3 LIMIT 1`,
    [input.spaceId, input.sourceItemId, input.fieldName],
  );
  if (exact.rowCount) return;
  const grouped = await client.query(
    `SELECT 1 FROM kith.observations
      WHERE space_id = $1 AND source_item_id = $2
        AND event_type = 'document_statement' AND observation_type = $3
      LIMIT 1`,
    [input.spaceId, input.sourceItemId, input.fieldName],
  );
  if (grouped.rowCount) {
    throw new ProofError("correction_target_is_a_list_field");
  }
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
  // one observation per item keyed `line_items:<line>-<hash>-<n>`, and
  // matching on the type would overwrite every line of the receipt with the
  // correction meant for one of them.
  const updated = await client.query(
    `UPDATE kith.observations SET value = $4
      WHERE space_id = $1 AND source_item_id = $2
        AND event_type = 'document_statement' AND observation_key = $3`,
    [input.spaceId, input.sourceItemId, input.fieldName, JSON.stringify(value)],
  );
  if (updated.rowCount) return updated.rowCount;
  // A line item's key names one line of one list. When no row matches it, the
  // newest run cited a different, equally valid line for that item -- and
  // inserting the corrected value under the old key would put the item in the
  // list twice, so every sum over it would double count, silently. The
  // correction stands, unapplied, and says so.
  if (input.fieldName.includes(":")) return -1;
  // Nothing to update on a scalar field: the run that produced this document
  // gated it out, so the owner's value is the only reading there is. Without
  // the insert below `get_document` would show it (it reads the correction
  // row) while `sum_money` and `latest_observation` would not see it at all --
  // and a corrected field is the one the owner is most certain about.
  return await insertCorrected(client, input, value);
}

/**
 * Hangs a corrected value off the document's existing statement event as a new
 * observation.
 *
 * Every column but the value and the key is copied from the event version the
 * extraction already wrote, so the row sits on the same generation, the same
 * sealed text and the same occurrence as its siblings and satisfies
 * `validateStoredObservation` on the way back out. Its evidence is the event's
 * own anchor span: the document does not say this, the owner does, and the
 * span says which document the claim is about.
 *
 * A document with no statement event has nothing to hang it on -- extraction
 * has not run, or refused everything -- and the correction row stands alone
 * until it does.
 */
async function insertCorrected(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string; fieldName: string },
  value: ObservationValue,
): Promise<number> {
  const observationType = input.fieldName.split(":")[0]!;
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(observationType)) return 0;
  const version = (
    await client.query<Record<string, unknown>>(
      `SELECT * FROM kith.event_versions
        WHERE space_id = $1 AND source_item_id = $2
          AND event_type = 'document_statement' LIMIT 1`,
      [input.spaceId, input.sourceItemId],
    )
  ).rows[0];
  if (!version) return 0;
  const evidence = (version.field_evidence as { occurrence?: string[] })
    ?.occurrence;
  if (!Array.isArray(evidence) || evidence.length === 0) return 0;
  await client.query(
    `INSERT INTO kith.observations
       (id,space_id,created_at,source_account_id,source_item_id,
        source_revision_id,source_text_version_id,processing_generation_id,
        event_id,event_version_id,entity_id,event_type,occurrence,
        occurrence_date,occurrence_instant,occurrence_sort_key,observation_key,
        observation_type,schema_version,value,value_evidence,bound_entity_id,
        user_id)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,
             'document_statement',$11,$12,$13,$14,$15,$16,1,$17,$18,NULL,$19)`,
    [
      newKithId(),
      input.spaceId,
      version.source_account_id,
      input.sourceItemId,
      version.source_revision_id,
      version.source_text_version_id,
      version.processing_generation_id,
      version.event_id,
      version.id,
      version.entity_id,
      version.occurrence,
      version.occurrence_date,
      version.occurrence_instant,
      occurrenceSortKey(
        version.occurrence as Occurrence,
        `${version.event_id}|${input.fieldName}|${version.processing_generation_id}`,
      ),
      input.fieldName,
      observationType,
      JSON.stringify(value),
      JSON.stringify(evidence.slice(0, 1)),
      version.user_id,
    ],
  );
  return 1;
}

/**
 * Auto-closes the previous run's open items before the current run writes its
 * own.
 *
 * Without this the queue is cumulative rather than current: a field that
 * failed in March and is read correctly in June keeps its March row forever,
 * and a failure that recurs every run keeps exactly one row only because
 * `openCorrection` deduplicates on `dedupe_key`. The owner reads this queue,
 * and a queue that never shrinks is one nobody opens.
 *
 * Only `open` rows the owner has not touched. A `resolved` row is the owner's
 * own answer and outlives every extraction; a `dismissed` or `snoozed` row is
 * untouched by this on purpose (a dismissal is permanent, a snooze is the
 * owner's own wait); an `open` row that already carries a `corrected_value`
 * is one the owner is partway through and is left alone too.
 *
 * ADM-8a: resolved with reason `cleared` rather than deleted, which is the
 * "auto-close when the condition clears ... not by the owner" the attention
 * queue needs -- a screen that shows resolved items keeps the history of what
 * was once wrong, and `openCorrection`'s `dedupe_key` lookup finds this same
 * row and reopens it (never as `dismissed`) if the same field fails again on
 * a later run, so nothing is lost by not deleting.
 */
export async function supersedeOpenCorrections(
  client: ClientBase,
  input: { spaceId: string; sourceItemId: string },
): Promise<number> {
  const cleared = await client.query(
    `UPDATE kith.corrections
        SET state = 'resolved', resolved_at = transaction_timestamp(),
            reason = 'cleared'
      WHERE space_id = $1 AND target_kind = 'document' AND target_id = $2
        AND state = 'open' AND corrected_value IS NULL`,
    [input.spaceId, input.sourceItemId],
  );
  return cleared.rowCount ?? 0;
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
    const wrote = await writeThrough(client, {
      ...input,
      fieldName,
      correctedValue,
    });
    if (wrote < 0) {
      // One attention item naming the field, so the owner can re-make the
      // correction against the line this run cited.
      await openCorrection(client, {
        spaceId: input.spaceId,
        sourceItemId: input.sourceItemId,
        fieldName,
        reason: "correction_orphaned",
        reading: null,
      });
      continue;
    }
    applied += wrote;
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
 *
 * `corrected_value IS NOT NULL` on top of `state = 'resolved'` (ADM-8a):
 * `supersedeOpenCorrections` also leaves a row `resolved` -- with reason
 * `cleared` and no `corrected_value` -- when a gate failure simply stops
 * reproducing. Without this filter that row reads as "the owner fixed
 * `total`" forever after, and `settled()` in `model.ts` would refuse to ever
 * open a `total` item again even though nothing was ever owner-corrected.
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
          AND state = 'resolved' AND corrected_value IS NOT NULL
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
