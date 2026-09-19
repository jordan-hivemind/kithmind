-- ADM-8a: the first slice of the attention queue --
-- docs/plans/2026-09-19-investment-document-matching.md section 5, the quiet
-- dismissible queue itself, with no matching or detector logic yet.
--
-- The owner's principle, quoted in the PR and worth repeating here: this is a
-- best-effort personal store; records will be incomplete; do not chase the
-- owner for information he does not have; warnings about holes must never
-- become so noisy that he misses what he cares about.
--
-- `kith.corrections` is widened rather than duplicated, the way the plan
-- calls for: it already holds extraction gate failures with two states, and
-- every detector this feature will ever add (none of them built yet) writes
-- the same table. Two states are added:
--
--   * `dismissed` -- the owner's permanent "not worth backfilling" (or one of
--     the other closed reasons). `dismiss_reason` is a closed enum so the
--     screen can group by it. A dismissed row is never reopened by a re-run;
--     `src/extraction/corrections.ts`'s `openCorrection` now checks for one by
--     `dedupe_key` before it would otherwise recreate the row.
--   * `snoozed` -- hidden from the default view and from every alert until
--     `snoozed_until` passes. Not an alerting concept yet (no detector alerts
--     in this slice), but the column exists so the one that does needs no
--     second migration.
--
-- `severity` is the nav badge's whole vocabulary: `info` (never counted),
-- `attention` and `alert` (the badge's count, per section 5's "counts by
-- severity ... ONLY attention and alert, never info"). Every row extraction
-- opens today defaults to `info`, so the badge does not change until a
-- detector that sets a higher severity ships.
--
-- `detector` names what produced the row (`'extraction'` for today's only
-- producer) and `dedupe_key` is the one thing every future detector and this
-- migration's `openCorrection` change share: at most one open-or-snoozed row
-- per (space, dedupe_key), so a detector (or a re-run) that finds the same
-- problem twice updates the existing row instead of growing the queue.
--
-- `kith.attention_mutes` is the bulk and standing suppression list (plan
-- section 4, "Dismissing and turning off tracking"): a space-wide "stop
-- opening items for this detector", a per-investment or per-source-root
-- silence, a per-document-kind silence, or a "before this date" cutoff. It is
-- checked before a row is opened -- prospectively, the same place
-- `openCorrection`'s dismissal check runs -- not swept against existing rows,
-- so a mute added today never retroactively hides what already opened.

ALTER TABLE kith.corrections
  DROP CONSTRAINT corrections_state_check,
  ADD CONSTRAINT corrections_state_check
    CHECK (state IN ('open', 'resolved', 'dismissed', 'snoozed'));

ALTER TABLE kith.corrections
  ADD COLUMN dismissed_at timestamptz,
  ADD COLUMN dismissed_by kith.kith_id REFERENCES kith.users (id) ON DELETE SET NULL,
  ADD COLUMN dismiss_reason text
    CHECK (dismiss_reason IS NULL OR dismiss_reason IN
      ('not_worth_backfilling', 'not_mine', 'duplicate', 'wrong_detector', 'other')),
  ADD COLUMN snoozed_until timestamptz,
  ADD COLUMN severity text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'attention', 'alert')),
  ADD COLUMN detector text NOT NULL DEFAULT 'extraction'
    CHECK (char_length(detector) BETWEEN 1 AND 100),
  ADD COLUMN dedupe_key text
    CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 512),
  ADD CONSTRAINT corrections_dismissed_check
    CHECK ((state = 'dismissed') = (dismissed_at IS NOT NULL)),
  -- Named _required_check, not _check: the inline CHECK on the column
  -- itself (above) already claimed `corrections_dismiss_reason_check`, the
  -- name PostgreSQL would otherwise have auto-assigned this one too.
  ADD CONSTRAINT corrections_dismiss_reason_required_check
    CHECK (state <> 'dismissed' OR dismiss_reason IS NOT NULL),
  ADD CONSTRAINT corrections_snoozed_check
    CHECK ((state = 'snoozed') = (snoozed_until IS NOT NULL));

-- At most one open-or-snoozed row per key. A dismissed or resolved row keeps
-- its key (for history and for the "never reopen" check) but frees it, so the
-- same problem can open again after it is auto-cleared -- only a `dismissed`
-- row is permanent.
CREATE UNIQUE INDEX corrections_dedupe_key_idx
  ON kith.corrections (space_id, dedupe_key)
  WHERE state IN ('open', 'snoozed');

-- The queue screen's default read: open items of severity attention or
-- alert, newest first, and the badge's count over the same predicate.
CREATE INDEX corrections_severity_idx
  ON kith.corrections (space_id, state, severity, created_at DESC, id);

CREATE TABLE kith.attention_mutes (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  scope_kind text NOT NULL
    CHECK (scope_kind IN ('detector', 'investment', 'source_root', 'document_kind', 'before_date')),
  -- What the scope names: a detector name, an investment or source root id,
  -- a document kind, or an ISO date for `before_date`. Free text like
  -- `corrections.detector` and for the same reason -- the value's shape
  -- depends on `scope_kind` and none of the four things it can name share a
  -- column type worth inventing a polymorphic reference for.
  scope_value text NOT NULL CHECK (char_length(scope_value) BETWEEN 1 AND 512),
  created_by kith.kith_id REFERENCES kith.users (id) ON DELETE SET NULL,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 2000),
  UNIQUE (space_id, scope_kind, scope_value)
);

CREATE INDEX attention_mutes_space_idx ON kith.attention_mutes (space_id);

CREATE TRIGGER attention_mutes_change_trg
  AFTER INSERT OR UPDATE OR DELETE ON kith.attention_mutes
  FOR EACH ROW EXECUTE FUNCTION kith.record_change();
