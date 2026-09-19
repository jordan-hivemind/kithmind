// ADM-2, screen 1 (Health): the facts the checks are derived from.
//
// Split in two on purpose. This file reads; `status.ts` decides. The decision
// -- which age is overdue, which count is a problem, what the one line beside
// a check says -- is the part worth testing, and it needs no database to test.
// This file's job is to be a thin, obviously space-scoped read, so the review
// of it is a review of five predicates rather than of a rules engine.
//
// Every read below carries `spacePredicate` over the spaces `getAdminSpaceIds`
// returned, the same narrowing `listSourcesInventory` applies: a reader gets an
// empty administered set and therefore empty facts, and no statement here can
// see a row from a space the caller does not administer.

import type { Principal } from "../identity/authorization.js";
import { type IdentityCtx, rows } from "../identity/db.js";
import { spacePredicate } from "../spaces.js";
import {
  type NotReadyReasons,
  readNotReadyReasons,
} from "../workers/notReady.js";
import { getAdminSpaceIds } from "./model.js";

/** Enough sources to describe; past this the tooltip is a wall rather than a
 * detail, and the watcher check's status is already decided by the worst one. */
const MAX_WATCHED_SOURCES = 50;

/** One source account's watcher and its latest processing assessment. */
export type WatcherFact = {
  sourceAccountId: string;
  name: string;
  enabled: boolean;
  /** `worker_watcher_states.state`, or null when no host ever registered. */
  watcherState: "awaiting_heartbeat" | "active" | null;
  lastSeenAt: number | null;
  nextExpectedAt: number | null;
  /** `worker_processing_assessments.state` of the latest pass, or null. */
  assessmentState: string | null;
  assessmentAt: number | null;
  /** The diagnostic tally `workers/notReady.ts` stores in `counts`. */
  notReadyReasons: NotReadyReasons;
  /**
   * ADM-9, migration 029: how this watcher's last pass ended. It is the only
   * fact a pass that opened no scan produces, which is exactly what PR #313's
   * two circuit breakers do, so without it a watcher that refuses every pass
   * reads as healthy here.
   *
   * `lastPassCode` is a closed-shape value and not free text: the wire pattern
   * (`WORKER_PASS_CODE`) and the column's own CHECK both hold it to
   * `[a-z0-9_]{1,64}`, which is what makes it safe in a tooltip -- the same
   * rule `notReadyReasons` follows.
   */
  lastPassState: "complete" | "incomplete" | "failed" | null;
  lastPassCode: string | null;
  lastPassAt: number | null;
  /**
   * When the current run of non-`complete` outcomes began, null after a clean
   * pass. How long a watcher has been getting nowhere is the question; how
   * many passes that took is the host's cadence, not a fact about health.
   */
  unhealthySince: number | null;
};

export type IndexFact = {
  /** Targets the index is supposed to cover. */
  eligible: number;
  /** Targets a vector already backs under some fingerprint. */
  covered: number;
  /** Eligible targets with no vector: what a fill still owes. */
  owed: number;
};

export type JobsFact = {
  /** `queued` rows whose `run_after` has passed. */
  overdueQueued: number;
  /** `failed` in the last 24 hours with no later `done` job sharing the
   * dedupe key, which is the shape a retry that eventually worked leaves. */
  failed: number;
  /** The kinds those failures were, for the tooltip. */
  failedKinds: Record<string, number>;
};

export type ReviewFact = {
  /** `card_entity_bindings` still `pending`: a name nobody has bound. */
  pendingBindings: number;
  /** `card_field_drops`: a field the gate refused. */
  fieldDrops: number;
};

export type HealthFacts = {
  watchers: WatcherFact[];
  index: IndexFact;
  jobs: JobsFact;
  review: ReviewFact;
};

const EMPTY_FACTS: HealthFacts = {
  watchers: [],
  index: { eligible: 0, covered: 0, owed: 0 },
  jobs: { overdueQueued: 0, failed: 0, failedKinds: {} },
  review: { pendingBindings: 0, fieldDrops: 0 },
};

function epoch(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

/**
 * The `notReadyReasons` tally out of an assessment's `counts` column.
 *
 * `readNotReadyReasons` is `workers/notReady.ts`'s own reader and the one this
 * goes through, rather than a second pass over the same jsonb: it keeps only
 * closed-enum keys (`isNotReadyReason`) with safe integer counts, and caps
 * them. That filter is what makes the tooltip safe to render -- a stale or
 * hand-edited row cannot put an arbitrary string on the screen, which matters
 * because the module's own rule is that a reason is a fixed literal and never
 * a row value.
 */
function assessmentReasons(counts: unknown): NotReadyReasons {
  return readNotReadyReasons(
    counts === null || typeof counts !== "object" || Array.isArray(counts)
      ? null
      : (counts as Record<string, unknown>),
  );
}

type WatcherDbRow = {
  source_account_id: string;
  name: string | null;
  enabled: boolean | null;
  watcher_state: string | null;
  last_seen_at: Date | null;
  next_expected_at: Date | null;
  assessment_state: string | null;
  assessment_at: Date | null;
  counts: unknown;
  last_pass_state: string | null;
  last_pass_code: string | null;
  last_pass_finished_at: Date | null;
  last_pass_unhealthy_since: Date | null;
};

type CountsDbRow = Record<string, string | number | null>;

/**
 * Everything the health screen reads out of the brain, in one transaction.
 *
 * The finance archive is deliberately absent: it is a different database
 * behind its own read contract and its own reader role, and reaching it from
 * here would give this function a second credential. The web layer asks it
 * separately and appends the answer.
 */
export async function readHealthFacts(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceIds?: readonly string[] },
): Promise<HealthFacts> {
  const spaces = await getAdminSpaceIds(ctx, args.principal, args.spaceIds);
  if (spaces.length === 0) return EMPTY_FACTS;

  const watcherPredicate = spacePredicate(spaces, 1, "a.space_id");
  const watcherRows = await rows<WatcherDbRow>(
    ctx,
    `SELECT a.id AS source_account_id, a.name, a.enabled,
            w.state AS watcher_state, w.last_seen_at, w.next_expected_at,
            w.last_pass_state, w.last_pass_code, w.last_pass_finished_at,
            w.last_pass_unhealthy_since,
            s.state AS assessment_state,
            coalesce(s.completed_at, s.updated_at, s.started_at)
              AS assessment_at,
            s.counts
       FROM kith.source_accounts a
       LEFT JOIN kith.worker_watcher_states w
         ON w.source_account_id = a.id AND w.space_id = a.space_id
       LEFT JOIN LATERAL (
         SELECT q.state, q.completed_at, q.updated_at, q.started_at, q.counts
           FROM kith.worker_processing_assessments q
          WHERE q.source_account_id = a.id AND q.space_id = a.space_id
          ORDER BY coalesce(q.completed_at, q.updated_at, q.started_at) DESC,
                   q.id DESC
          LIMIT 1
       ) s ON true
      WHERE ${watcherPredicate.sql}
      ORDER BY a.space_id, a.id
      LIMIT $2`,
    [watcherPredicate.value, MAX_WATCHED_SOURCES],
  );

  // One row of counters for the other three checks. Separate statements would
  // be three more round trips for three numbers each; one `SELECT` of scalar
  // subqueries is the same work in one. Every subquery below carries its own
  // `spacePredicate` against its own alias, all binding the same `$1`.
  const inSpaces = (alias: string) => spacePredicate(spaces, 1, alias).sql;
  const spaceIds = spacePredicate(spaces, 1).value;
  const summary = await rows<CountsDbRow>(
    ctx,
    `SELECT
       (SELECT count(*) FROM kith.embedding_targets t
         WHERE ${inSpaces("t.space_id")} AND t.state = 'eligible') AS eligible,
       (SELECT count(*) FROM kith.embedding_targets t
         WHERE ${inSpaces("t.space_id")}
           AND t.covered_fingerprint IS NOT NULL) AS covered,
       (SELECT count(*) FROM kith.embedding_targets t
         WHERE ${inSpaces("t.space_id")}
           AND t.state = 'eligible' AND t.covered_fingerprint IS NULL)
         AS owed,
       (SELECT count(*) FROM kith.deferred_work d
         WHERE ${inSpaces("d.space_id")}
           AND d.state = 'queued' AND d.run_after <= $2) AS overdue_queued,
       (SELECT count(*) FROM kith.card_entity_bindings b
         WHERE ${inSpaces("b.space_id")} AND b.status = 'pending')
         AS pending_bindings,
       (SELECT count(*) FROM kith.card_field_drops f
         WHERE ${inSpaces("f.space_id")}) AS field_drops`,
    [spaceIds, new Date(ctx.now)],
  );

  // The failures, by kind, excluding any superseded by a later `done` job with
  // the same dedupe key: a job that failed once and succeeded on the retry is
  // not something to page anyone about, and the dedupe key is the only thing
  // relating the two rows. A failure with no dedupe key can never be
  // superseded, so it always counts.
  const failedRows = await rows<{ kind: string; count: string }>(
    ctx,
    `SELECT f.kind, count(*)::text AS count
       FROM kith.deferred_work f
      WHERE ${inSpaces("f.space_id")}
        AND f.state = 'failed'
        AND f.updated_at >= $2
        AND (f.dedupe_key IS NULL OR NOT EXISTS (
          SELECT 1 FROM kith.deferred_work later
           WHERE later.kind = f.kind
             AND later.dedupe_key = f.dedupe_key
             AND later.state = 'done'
             AND later.updated_at > f.updated_at
        ))
      GROUP BY f.kind`,
    [spaceIds, new Date(ctx.now - 24 * 60 * 60 * 1000)],
  );

  const counts = summary[0] ?? {};
  const number = (value: unknown): number => Number(value ?? 0);
  const failedKinds: Record<string, number> = {};
  let failed = 0;
  for (const record of failedRows) {
    failedKinds[record.kind] = Number(record.count);
    failed += Number(record.count);
  }

  return {
    watchers: watcherRows.map((record) => ({
      sourceAccountId: record.source_account_id,
      name: record.name ?? "",
      enabled: record.enabled ?? false,
      watcherState:
        record.watcher_state === "active" ||
        record.watcher_state === "awaiting_heartbeat"
          ? record.watcher_state
          : null,
      lastSeenAt: epoch(record.last_seen_at),
      nextExpectedAt: epoch(record.next_expected_at),
      assessmentState: record.assessment_state,
      assessmentAt: epoch(record.assessment_at),
      notReadyReasons: assessmentReasons(record.counts),
      // The column's CHECK already holds these to the closed state and the
      // code pattern; the narrowing here is what makes that a type rather
      // than a promise, for the same reason `assessmentReasons` re-filters.
      lastPassState:
        record.last_pass_state === "complete" ||
        record.last_pass_state === "incomplete" ||
        record.last_pass_state === "failed"
          ? record.last_pass_state
          : null,
      lastPassCode:
        typeof record.last_pass_code === "string" &&
        /^[a-z0-9_]{1,64}$/.test(record.last_pass_code)
          ? record.last_pass_code
          : null,
      lastPassAt: epoch(record.last_pass_finished_at),
      unhealthySince: epoch(record.last_pass_unhealthy_since),
    })),
    index: {
      eligible: number(counts.eligible),
      covered: number(counts.covered),
      owed: number(counts.owed),
    },
    jobs: {
      overdueQueued: number(counts.overdue_queued),
      failed,
      failedKinds,
    },
    review: {
      pendingBindings: number(counts.pending_bindings),
      fieldDrops: number(counts.field_drops),
    },
  };
}
