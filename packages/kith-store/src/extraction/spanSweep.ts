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
 * Every span id named anywhere in one space -- the single copy of the
 * whitelist, parameterized by how the caller names "this space". `unreferencedSpanIds`
 * instantiates it with the bound parameter `$1`; the cleanup's pre-filter
 * below instantiates the identical text with a correlated column reference,
 * so a span the pre-filter waves through and a span the per-generation
 * delete would keep are provably the same check, not two checks that happen
 * to agree today.
 *
 * ponytail: space-wide, not narrowed to the text version under sweep. An
 * observation's evidence always comes from its own text version *by
 * construction*, but nothing in the schema enforces it and
 * `investment_entries` genuinely may cite any document's span, so narrowing
 * would trade a silent wrong delete for a scan the owner's data does not
 * notice. Narrow it (or index `value_evidence` with GIN) when a space's
 * observation count makes this show up in a timing.
 */
function referencedSpanIdsSql(spaceIdExpr: string): string {
  return `
  SELECT jsonb_array_elements_text(m.evidence_span_ids) AS id
    FROM kith.processing_generation_payload_manifests m
   WHERE m.space_id = ${spaceIdExpr}
     AND jsonb_typeof(m.evidence_span_ids) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(o.value_evidence)
    FROM kith.observations o
   WHERE o.space_id = ${spaceIdExpr}
     AND jsonb_typeof(o.value_evidence) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(entry.value)
    FROM kith.event_versions v,
         jsonb_each(v.field_evidence) AS entry(key, value)
   WHERE v.space_id = ${spaceIdExpr}
     AND jsonb_typeof(v.field_evidence) = 'object'
     AND jsonb_typeof(entry.value) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(d.evidence_span_ids)
    FROM kith.documents d
   WHERE d.space_id = ${spaceIdExpr}
     AND jsonb_typeof(d.evidence_span_ids) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(c.evidence_span_ids)
    FROM kith.chunks c
   WHERE c.space_id = ${spaceIdExpr}
     AND jsonb_typeof(c.evidence_span_ids) = 'array'
  UNION ALL
  SELECT jsonb_array_elements_text(w.evidence_span_ids)
    FROM kith.worker_parsed_stages w
   WHERE w.space_id = ${spaceIdExpr}
     AND jsonb_typeof(w.evidence_span_ids) = 'array'
  UNION ALL
  SELECT e.evidence_span_id
    FROM kith.investment_entries e
   WHERE e.space_id = ${spaceIdExpr}
     AND e.evidence_span_id IS NOT NULL
  UNION ALL
  SELECT statement.value->>'evidenceSpanId'
    FROM kith.document_extractions x,
         jsonb_array_elements(x.statements) AS statement(value)
   WHERE x.space_id = ${spaceIdExpr}
     AND jsonb_typeof(x.statements) = 'array'
`;
}

const REFERENCED_SPAN_IDS = referencedSpanIdsSql("$1");

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
  /** Sealed generations the pre-filter found still holding an unreferenced
   * candidate span. A generation whose only candidate spans are referenced
   * does not appear here: the pre-filter applies the same whitelist the
   * per-generation delete does, so it is not a candidate in the first place. */
  generationsScanned: number;
  /** Of those, the ones that still had one after the reference check ran
   * again inside their own transaction. Ordinarily equal to
   * `generationsScanned`; it can fall short only when a concurrent write
   * references the span in the gap between the pre-filter and that
   * transaction, which SERIALIZABLE surfaces as the transaction seeing
   * nothing left to remove rather than a stale delete. */
  generationsAffected: number;
  /** Spans removed, or that `--apply` would remove. */
  spans: number;
};

/**
 * Raised when a per-generation transaction fails partway through a run. Only
 * the failing generation is rolled back -- every generation processed before
 * it already committed -- so `summary` is not empty progress lost, it is the
 * count the caller can trust and report before exiting nonzero.
 */
export class CleanupInterrupted extends Error {
  readonly summary: CleanupSummary;

  constructor(cause: unknown, summary: CleanupSummary) {
    super("kith-extraction-span-cleanup: a generation's transaction failed mid-run");
    this.name = "CleanupInterrupted";
    this.cause = cause;
    this.summary = summary;
  }
}

/**
 * The legacy residue: spans stranded before the write path swept, which carry
 * no `extraction_v1` marker because the marker did not exist yet.
 *
 * Bounded (`limit` generations per run), transactional per generation, and
 * idempotent -- a generation whose only candidate spans are referenced is
 * excluded by the pre-filter itself, so repeated runs make progress instead
 * of re-walking the same head of the table forever.
 *
 * Deliberately conservative twice over: the candidate set is narrowed by the
 * generation's own manifest, and the reference check applied against it --
 * both in the pre-filter below and again inside each generation's own
 * transaction -- is `referencedSpanIdsSql`, the one whitelist at the top of
 * this file. A span that any of the eight sites names survives, whatever its
 * locator says.
 */
export async function cleanupOrphanedExtractionSpans(
  pool: Pool,
  options: { apply: boolean; limit?: number } = { apply: false },
): Promise<CleanupSummary> {
  const limit = options.limit ?? DEFAULT_CLEANUP_GENERATIONS;
  // The pre-filter: sealed generations holding a span that is outside their
  // own manifest, is not a card's, carries no foreign locator kind, and --
  // the same whitelist `unreferencedSpanIds` uses, instantiated here as a
  // correlated subquery instead of a bound parameter -- is named by nothing.
  // Sharing the fragment is the point: a generation cannot pass this filter
  // and then find its only candidate span referenced once the per-generation
  // transaction below runs the identical check, except by a genuine race,
  // which `generationsAffected` accounts for separately.
  const generations = await withKithReadTransaction(pool, (client) =>
    client.query<{ space_id: string; text_version_id: string }>(
      `WITH candidate AS (
         SELECT DISTINCT m.space_id, m.source_text_version_id AS text_version_id, s.id AS span_id
           FROM kith.processing_generation_payload_manifests m
           JOIN kith.evidence_spans s
             ON s.space_id = m.space_id
            AND s.source_text_version_id = m.source_text_version_id
          WHERE s.card_extraction_fingerprints IS NULL
            AND (s.locator->>'kind' IS NULL OR s.locator->>'kind' = $1)
            AND jsonb_typeof(m.evidence_span_ids) = 'array'
            AND NOT (m.evidence_span_ids @> to_jsonb(s.id))
       )
       SELECT DISTINCT cand.space_id, cand.text_version_id
         FROM candidate cand
        WHERE NOT EXISTS (
          SELECT 1 FROM (${referencedSpanIdsSql("cand.space_id")}) referenced
           WHERE referenced.id = cand.span_id
        )
        ORDER BY cand.space_id, cand.text_version_id
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
    // one, and the next run picks up exactly where this stopped. A failure
    // here is re-thrown carrying the summary as committed so far, so a caller
    // that has already lost this generation's transaction does not also lose
    // the count of what came before it.
    let removed: number;
    try {
      removed = await withKithTransaction(pool, async (client) => {
        const ids = await unreferencedSpanIds(client, {
          spaceId: row.space_id,
          sourceTextVersionId: row.text_version_id,
          include: "legacy",
        });
        if (options.apply) await deleteSpans(client, row.space_id, ids);
        return ids.length;
      });
    } catch (error) {
      throw new CleanupInterrupted(error, { ...summary });
    }
    if (removed > 0) summary.generationsAffected += 1;
    summary.spans += removed;
  }
  return summary;
}
