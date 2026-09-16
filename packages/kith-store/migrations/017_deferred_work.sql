-- P2-39j: deferred work, sweeps and diagnostics.
--
-- Version 17, behind P2-39g2's embedding build migration (016). The two rows
-- were built concurrently and this one was numbered at integration.
--
-- Section 2.6 of the consolidation plan replaces every `scheduler.runAfter`
-- call site and the always-on host's own periodic sweeps with one table this
-- migration adds and one daemon (`src/deferred/cli.ts`) that drains it. A
-- Convex `ctx.scheduler.runAfter(delay, fn, args)` becomes one row here,
-- insertable in the same transaction as the write it follows -- "scheduled
-- mutation is transactional with its scheduler" (section 2.4) -- and claimed
-- under a lease exactly the way `kith.worker_jobs` already claims ingestion
-- work: `FOR UPDATE SKIP LOCKED`, not a second locking scheme.
--
-- `kind` is a closed CHECK list rather than free text, on purpose: a typo in a
-- caller's kind string must fail the INSERT, not sit in the queue forever
-- refused by a registry that never recognizes it. Three kinds exist today, and
-- none has a registered handler in this migration's own package version:
--
--   * `inline_ingestion` is what this row's own recovery sweep schedules (the
--     port of `models/ingestion/inlineWorker.ts` `recover`). Its handler is
--     left unregistered because the admission and claim mutations it would
--     call (`admitInlineWork`, `claimInlineWork`, the `process` action) have
--     not been ported into `@repo/kith-store` as of this migration -- there is
--     nothing yet for a handler to run. The sweep still does its half: finding
--     stranded work and enqueuing its continuation, ready for the row that
--     ports admission to register the handler.
--   * `embedding_fill` is P2-39g2's hook: the embedding fill driver schedules
--     its own successor today the way `models/embeddings/fill.ts` line 256
--     does; on the daemon it drains through this table instead.
--   * `card_queue_tick` is P2-39f's hook: `models/records/cardQueue.ts`
--     reschedules `runExtractionQueueTick` the same way.
--
-- `drain` (`src/deferred/core.ts`) refuses an unregistered kind with a typed
-- error and fails the job without consuming an attempt, so a queued row for a
-- kind nobody drains yet is inert rather than silently lost or retried to
-- exhaustion.
CREATE TABLE kith.deferred_work (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  run_after timestamptz NOT NULL DEFAULT transaction_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  lease_token text,
  lease_expires_at timestamptz,
  state text NOT NULL DEFAULT 'queued',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT deferred_work_kind_check
    CHECK (kind IN ('inline_ingestion', 'embedding_fill', 'card_queue_tick')),
  CONSTRAINT deferred_work_state_check
    CHECK (state IN ('queued', 'running', 'done', 'failed')),
  CONSTRAINT deferred_work_attempts_check
    CHECK (attempts >= 0 AND attempts = trunc(attempts)
       AND max_attempts >= 1 AND max_attempts = trunc(max_attempts)
       AND attempts <= max_attempts),
  -- A lease is both fields or neither, the same rule migration 008 gives
  -- `worker_discovery_work`'s own lease.
  CONSTRAINT deferred_work_lease_check
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT deferred_work_payload_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT deferred_work_dedupe_check
    CHECK (dedupe_key IS NULL OR length(dedupe_key) <= 200)
);

-- The drain's claim scan: due, queued rows in `run_after` order. Partial on
-- `queued` because `running` and terminal rows are never candidates here and
-- would otherwise bloat the index for nothing.
CREATE INDEX deferred_work_claim_idx
  ON kith.deferred_work (run_after, id)
  WHERE state = 'queued';

-- A lease past its expiry is reclaimed by the same claim pass rather than a
-- separate sweep: the crashed drain that held it never returns, and the next
-- `claim` call's scan matches this index too.
CREATE INDEX deferred_work_reclaim_idx
  ON kith.deferred_work (lease_expires_at)
  WHERE state = 'running';

-- "Scheduling the same job twice while it is queued is a no-op": one live row
-- per `(kind, dedupe_key)` while it is `queued` or `running`. `dedupe_key` is
-- optional -- a job with none is never deduplicated -- so the partial index
-- also excludes NULL, which a plain UNIQUE constraint would not.
CREATE UNIQUE INDEX deferred_work_dedupe_idx
  ON kith.deferred_work (kind, dedupe_key)
  WHERE state IN ('queued', 'running') AND dedupe_key IS NOT NULL;

CREATE INDEX deferred_work_space_idx
  ON kith.deferred_work (space_id, created_at, id)
  WHERE space_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Diagnostics: the three drained tables `models/diagnostics` owns. Migration
-- 004 created them structurally with "every non-structural column nullable",
-- exactly as it did for the worker protocol's own drained tables; migration
-- 008's note explains why. This is that row's required/optional declaration
-- for diagnostics, the same way 008 was for scan and discovery state. No
-- migration between 004 and this one has touched them, and
-- `src/workers/diagnostics.ts` already writes rows shaped to satisfy every
-- constraint below.
-- ---------------------------------------------------------------------------

ALTER TABLE kith.worker_watcher_states
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN watcher_id SET NOT NULL,
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN created_at_field SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,
  ADD CONSTRAINT worker_watcher_states_state_check
    CHECK (state IN ('awaiting_heartbeat', 'active'));

-- At most one watcher row per source account. `diagnostics.ts`'s
-- `watcherForSource` already enforces this by reading up to two rows and
-- refusing with `scan_conflict`; the index makes a second row unwritable
-- rather than merely unqueried, the same upgrade migration 008 made for the
-- worker protocol's own count checks.
CREATE UNIQUE INDEX worker_watcher_states_source_idx
  ON kith.worker_watcher_states (source_account_id);

-- The read-time staleness predicate's own scan: every active watcher, in no
-- particular order, is bounded and cheap at the scale one worker host serves.
CREATE INDEX worker_watcher_states_active_idx
  ON kith.worker_watcher_states (state, next_expected_at)
  WHERE state = 'active';

ALTER TABLE kith.worker_operational_incidents
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN watcher_id SET NOT NULL,
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN opened_at SET NOT NULL,
  ALTER COLUMN observed_at SET NOT NULL,
  ADD CONSTRAINT worker_operational_incidents_kind_check
    CHECK (kind = 'missing_worker'),
  ADD CONSTRAINT worker_operational_incidents_state_check
    CHECK (state IN ('open', 'resolved'));

-- At most one open incident per source account, matching
-- `openIncidentForSource`'s own count check the same way.
CREATE UNIQUE INDEX worker_operational_incidents_open_idx
  ON kith.worker_operational_incidents (source_account_id)
  WHERE state = 'open';

-- The daily incident writer's own dedupe read: has a `missing_worker`
-- incident already been opened for this watcher today.
CREATE INDEX worker_operational_incidents_watcher_idx
  ON kith.worker_operational_incidents
     (source_account_id, watcher_id, kind, opened_at DESC);

ALTER TABLE kith.worker_watcher_reset_receipts
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN request_id SET NOT NULL,
  ALTER COLUMN request_digest SET NOT NULL,
  ALTER COLUMN actor_user_id SET NOT NULL,
  ALTER COLUMN changed_at SET NOT NULL;

-- The replay key `resetWorkerWatcher` reads back.
CREATE UNIQUE INDEX worker_watcher_reset_receipts_request_idx
  ON kith.worker_watcher_reset_receipts (source_account_id, request_id);
