// Orphaned extraction spans: the ones nothing points at any more.
//
// The extraction writer mints an evidence span per cited line *before* it
// knows whether the statement survives the rest of the run. Two things then
// strand spans:
//
//   * pass two of `prepare` drops a field whose statements disagreed
//     (`conflicting_values`), after their spans were already written; and
//   * a re-extraction replaces the previous run's observations wholesale, so
//     every span that run cited and this one did not is left behind.
//
// A stranded span is not cosmetic. Before ADM-5i it counted against the
// parsed payload's seal and every extracted document failed
// `payload_verify_error:id_sets`; ADM-5i taught the seal to skip spans marked
// `extraction_v1`, which fixed the marked ones and left the legacy unmarked
// ones failing. 68 of 91 of the owner's ready generations still carry at
// least one. This module is both halves of the answer: the write path sweeps
// what it stranded in the same transaction, and `unreferencedSpanIds` is
// re-used by `kith-extraction-span-cleanup` for the legacy residue.
//
// ## Every place in the schema that names an evidence span
//
// Read off `packages/kith-store/migrations`, and all eight are checked below.
// A span referenced from any of them is never a candidate:
//
// | Table                                       | Column                        | Shape                      |
// | ------------------------------------------- | ----------------------------- | -------------------------- |
// | `processing_generation_payload_manifests`    | `evidence_span_ids`           | id array -- **the seal**   |
// | `observations`                              | `value_evidence`              | id array                   |
// | `event_versions`                            | `field_evidence`              | object of id arrays        |
// | `documents` (was `brain_documents`)         | `evidence_span_ids`           | id array                   |
// | `chunks` (was `brain_chunks`)               | `evidence_span_ids`           | id array                   |
// | `worker_parsed_stages`                      | `evidence_span_ids`           | id array                   |
// | `investment_entries`                        | `evidence_span_id`            | foreign key                |
// | `document_extractions`                      | `statements[].evidenceSpanId` | object array               |
//
// Two more were read and are deliberately *not* reference sites:
//
//   * `corrections` names a document, a field or an observation key
//     (`target_kind`, `target_id`, `field_name`) and its `original_value` /
//     `corrected_value` / `reading` carry a citation of page and line
//     numbers. No column and no jsonb path holds a span id.
//   * the `*_evidence_span_count` columns on `worker_parsed_stages` and the
//     worker result rows are counts, not ids.
//
// `investment_entries.evidence_span_id` is `ON DELETE SET NULL`, so a wrong
// delete would *silently* blank an investment entry's evidence rather than
// fail. That is the reason this check is a whitelist of eight tables read
// from the schema and not a foreign-key sweep.

import type { ClientBase, Pool } from "pg";

import { EXTRACTION_SPAN_LOCATOR_KIND } from "../provenance/parsedStaging.js";
import { withKithReadTransaction, withKithTransaction } from "../schema.js";

/**
 * How many spans one sweep will remove. A document's extraction cites tens of
 * lines and a re-extraction strands at most that many again, so this is two
 * orders of magnitude of headroom; a scope that exceeds it is a bug worth
 * leaving visible rather than a backlog worth grinding through silently.
 */
export const MAX_SWEEP_SPANS = 2000;

/**
 * Every span id named anywhere in one space.
 *
 * ponytail: space-wide, not narrowed to the text version under sweep. An
 * observation's evidence always comes from its own text version *by
 * construction*, but nothing in the schema enforces it and
 * `investment_entries` genuinely may cite any document's span, so narrowing
 * would trade a silent wrong delete for a scan the owner's data does not
 * notice. Narrow it (or index `value_evidence` with GIN) when a space's
 * observation count makes this show up in a timing.
 */
const REFERENCED_SPAN_IDS = `
  SELECT jsonb_array_elements_text(m.evidence_span_ids) AS id
    FROM kith.processing_generation_payload_manifests m
   WHERE m.space_id = $1
     AND jsonb_typeof(m.evidence_span_ids) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(o.value_evidence)
    FROM kith.observations o
   WHERE o.space_id = $1
     AND jsonb_typeof(o.value_evidence) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(entry.value)
    FROM kith.event_versions v,
         jsonb_each(v.field_evidence) AS entry(key, value)
   WHERE v.space_id = $1
     AND jsonb_typeof(v.field_evidence) = 'object'
     AND jsonb_typeof(entry.value) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(d.evidence_span_ids)
    FROM kith.documents d
   WHERE d.space_id = $1
     AND jsonb_typeof(d.evidence_span_ids) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(c.evidence_span_ids)
    FROM kith.chunks c
   WHERE c.space_id = $1
     AND jsonb_typeof(c.evidence_span_ids) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(w.evidence_span_ids)
    FROM kith.worker_parsed_stages w
   WHERE w.space_id = $1
     AND jsonb_typeof(w.evidence_span_ids) = 'array'
  UNION ALL
  SELECT e.evidence_span_id
    FROM kith.investment_entries e
   WHERE e.space_id = $1
     AND e.evidence_span_id IS NOT NULL
  UNION ALL
  SELECT statement.value->>'evidenceSpanId'
    FROM kith.document_extractions x,
         jsonb_array_elements(x.statements) AS statement(value)
   WHERE x.space_id = $1
     AND jsonb_typeof(x.statements) = 'array'
`;

export type SweepScope = {
  spaceId: string;
  sourceTextVersionId: string;
  /**
   * `marked` is the write path: only spans this pipeline stamped
   * `extraction_v1`, so a parser span, a card span and anything with a
   * foreign locator are out of scope before the reference check even runs.
   *
   * `legacy` is the one-time cleanup, which must also reach spans minted
   * before the marker existed. It widens the scope to a locator with no
   * `kind` at all -- and nothing further: a locator naming any other kind is
   * somebody else's row.
   */
  include: "marked" | "legacy";
  limit?: number;
};

/**
 * The spans in scope that nothing in the table above names.
 *
 * Never returns a manifest span: the manifest is the first reference site, so
 * a sealed span is referenced by definition. Never returns a card span:
 * `card_extraction_fingerprints` is non-null on those and
 * `sweepCardEvidenceSpans` owns them.
 */
export async function unreferencedSpanIds(
  client: ClientBase,
  scope: SweepScope,
): Promise<string[]> {
  const kinds =
    scope.include === "marked"
      ? `s.locator->>'kind' = $3`
      : `(s.locator->>'kind' IS NULL OR s.locator->>'kind' = $3)`;
  const found = await client.query<{ id: string }>(
    `WITH candidate AS (
       SELECT s.id
         FROM kith.evidence_spans s
        WHERE s.space_id = $1
          AND s.source_text_version_id = $2
          AND s.card_extraction_fingerprints IS NULL
          AND ${kinds}
        ORDER BY s.id
        LIMIT $4
     ), referenced AS (${REFERENCED_SPAN_IDS})
     SELECT id FROM candidate
      WHERE id NOT IN (SELECT id FROM referenced WHERE id IS NOT NULL)`,
    [
      scope.spaceId,
      scope.sourceTextVersionId,
      EXTRACTION_SPAN_LOCATOR_KIND,
      scope.limit ?? MAX_SWEEP_SPANS,
    ],
  );
  return found.rows.map((row) => row.id);
}

/** Deletes exactly the ids given, scoped to the space. */
export async function deleteSpans(
  client: ClientBase,
  spaceId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const removed = await client.query(
    `DELETE FROM kith.evidence_spans
      WHERE space_id = $1 AND id = ANY($2::text[])`,
    [spaceId, ids],
  );
  return removed.rowCount ?? 0;
}

/**
 * The write path's sweep. Call it inside the extraction transaction, after
 * the observations, the event version and `document_extractions` are written:
 * those three are reference sites, so a span this run still uses is only safe
 * once its referent exists.
 */
export async function sweepUnreferencedExtractionSpans(
  client: ClientBase,
  scope: { spaceId: string; sourceTextVersionId: string },
): Promise<number> {
  const ids = await unreferencedSpanIds(client, {
    ...scope,
    include: "marked",
  });
  return deleteSpans(client, scope.spaceId, ids);
}

// ---------------------------------------------------------------------------
// The one-time cleanup
// ---------------------------------------------------------------------------

/** Generations one run will look at. See {@link cleanupOrphanedExtractionSpans}. */
export const DEFAULT_CLEANUP_GENERATIONS = 100;

export type CleanupSummary = {
  /** `false` for a dry run, which touches nothing. */
  applied: boolean;
  /** The ceiling this run worked under, so a truncated run is visible. */
  limit: number;
  /** Sealed generations that carried at least one candidate span. */
  generationsScanned: number;
  /** Of those, the ones that still had one after the reference check. */
  generationsAffected: number;
  /** Spans removed, or that `--apply` would remove. */
  spans: number;
};

/**
 * The legacy residue: spans stranded before the write path swept, which carry
 * no `extraction_v1` marker because the marker did not exist yet.
 *
 * Bounded (`limit` generations per run), transactional per generation, and
 * idempotent -- a generation with nothing left to remove drops out of the
 * candidate list, so repeated runs make progress instead of re-walking the
 * same head of the table.
 *
 * Deliberately conservative twice over: the candidate set is narrowed by the
 * generation's own manifest *before* the reference check, and the reference
 * check is the whole whitelist at the top of this file. A span that any of
 * the eight sites names survives, whatever its locator says.
 */
export async function cleanupOrphanedExtractionSpans(
  pool: Pool,
  options: { apply: boolean; limit?: number } = { apply: false },
): Promise<CleanupSummary> {
  const limit = options.limit ?? DEFAULT_CLEANUP_GENERATIONS;
  // A cheap pre-filter: sealed generations holding a span that is outside
  // their own manifest, is not a card's, and carries no foreign locator
  // kind. The expensive whitelist runs per generation below.
  const generations = await withKithReadTransaction(pool, (client) =>
    client.query<{ space_id: string; text_version_id: string }>(
      `SELECT DISTINCT m.space_id, m.source_text_version_id AS text_version_id
         FROM kith.processing_generation_payload_manifests m
         JOIN kith.evidence_spans s
           ON s.space_id = m.space_id
          AND s.source_text_version_id = m.source_text_version_id
        WHERE s.card_extraction_fingerprints IS NULL
          AND (s.locator->>'kind' IS NULL OR s.locator->>'kind' = $1)
          AND jsonb_typeof(m.evidence_span_ids) = 'array'
          AND NOT (m.evidence_span_ids @> to_jsonb(s.id))
        ORDER BY m.space_id, m.source_text_version_id
        LIMIT $2`,
      [EXTRACTION_SPAN_LOCATOR_KIND, limit],
    ),
  );
  const summary: CleanupSummary = {
    applied: options.apply,
    limit,
    generationsScanned: generations.rows.length,
    generationsAffected: 0,
    spans: 0,
  };
  for (const row of generations.rows) {
    // One transaction per generation: a run interrupted halfway leaves whole
    // generations done and whole generations untouched, never a half-swept
    // one, and the next run picks up exactly where this stopped.
    const removed = await withKithTransaction(pool, async (client) => {
      const ids = await unreferencedSpanIds(client, {
        spaceId: row.space_id,
        sourceTextVersionId: row.text_version_id,
        include: "legacy",
      });
      if (options.apply) await deleteSpans(client, row.space_id, ids);
      return ids.length;
    });
    if (removed > 0) summary.generationsAffected += 1;
    summary.spans += removed;
  }
  return summary;
}
