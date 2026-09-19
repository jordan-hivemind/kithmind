-- ADM-9: the terminal outcome of one watcher pass, on the row the health
-- screen already reads.
--
-- PR #313 gave the filesystem watcher two client-side circuit breakers. A pass
-- that trips one ends `incomplete` with `root_selection_would_retire_items` or
-- `root_contents_collapsed` and writes nothing at all -- no scan, and so no
-- processing assessment. The health screen reads exactly two things about a
-- watcher, the heartbeat and the latest assessment, so a watcher that refuses
-- every pass kept heartbeating and looked healthy. More generally no terminal
-- pass outcome reached the server.
--
-- Six columns on `worker_watcher_states` rather than a table of their own,
-- because the question they answer is "is this watcher doing its job", which
-- is what that row already exists to answer; it is one row per source account,
-- it is already LEFT JOINed by `src/admin/health.ts`, and migration 023
-- already put a `record_change` trigger on it, so the screen updates live with
-- no new trigger.
--
-- `last_pass_code` is bounded and lower-case-ASCII by CHECK rather than by a
-- closed enum: the codes are the pipeline's own literals and it mints new ones
-- as it grows. The pattern is the same one `WORKER_PASS_CODE` in
-- packages/worker-protocol/src/request.ts enforces on the wire, and it is what
-- keeps a path, a file name or free text out of a column the health tooltip
-- renders. Belt and braces, the same way migration 028's path CHECKs sit under
-- `assertSourceRootLocation`.
--
-- `last_pass_unhealthy_streak` is a counter and not a second history table.
-- The screen's rule needs one bit of history -- "a non-complete outcome
-- repeated on two consecutive passes" -- and a counter the writer maintains is
-- the whole of it. `recordWorkerPassOutcome` resets it to 0 on `complete`.

ALTER TABLE kith.worker_watcher_states
  ADD COLUMN last_pass_state text
    CHECK (last_pass_state IS NULL
           OR last_pass_state IN ('complete', 'incomplete', 'failed')),
  ADD COLUMN last_pass_code text
    CHECK (last_pass_code IS NULL OR last_pass_code ~ '^[a-z0-9_]{1,64}$'),
  ADD COLUMN last_pass_scanned integer
    CHECK (last_pass_scanned IS NULL
           OR last_pass_scanned BETWEEN 0 AND 100000000),
  ADD COLUMN last_pass_published integer
    CHECK (last_pass_published IS NULL
           OR last_pass_published BETWEEN 0 AND 100000000),
  ADD COLUMN last_pass_finished_at timestamptz,
  ADD COLUMN last_pass_unhealthy_streak integer NOT NULL DEFAULT 0
    CHECK (last_pass_unhealthy_streak >= 0);

-- A code with no state is a half-written row: the two are written together or
-- not at all, and the screen reads the code only through the state.
ALTER TABLE kith.worker_watcher_states
  ADD CONSTRAINT worker_watcher_states_last_pass_check
    CHECK (last_pass_state IS NOT NULL
           OR (last_pass_code IS NULL AND last_pass_finished_at IS NULL));
