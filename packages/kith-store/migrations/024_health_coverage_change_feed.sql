-- ADM-2: change-feed triggers for the tables the health and coverage screens
-- read, so those screens are live on the same mechanism the sources screen is.
--
-- No new table and no new function. `kith.record_change()` from migration 023
-- already does the work, and this is the list of tables it is now attached to.
-- Migration 023's own header explains why the function is `SECURITY DEFINER`
-- and why it writes four scalars rather than the row; nothing here changes
-- either.
--
-- Which tables, and why these:
--
--   * `deferred_work`      the background-jobs check, and -- because the
--                          embedding fill schedules its own successor through
--                          this table -- the signal that the search-index
--                          counters are worth re-reading.
--   * `coverage_windows`   the coverage screen's date range.
--   * `coverage_gaps`      its gap count.
--   * `card_entity_bindings`, `card_field_drops`
--                          the review-queue check.
--   * `observations`       the coverage screen's structured-record count.
--   * `thoughts`, `facts`  the "notes and facts" area's record count.
--
-- ponytail: `embedding_targets` is deliberately NOT here, although the
-- search-index check counts its rows. A full re-embed writes one target row
-- per chunk, and a trigger on it would write one change row per chunk on the
-- single most write-heavy path in the system, to tell a screen a counter moved
-- by one. The fill's own `deferred_work` rows already tick while it runs,
-- which is when the counters actually move, so the check is live during a fill
-- and costs nothing when idle. Upgrade path if a target changing outside a
-- fill ever needs to be visible immediately: add it to the array below.
DO $$
DECLARE
  watched text;
BEGIN
  FOREACH watched IN ARRAY ARRAY[
    'deferred_work',
    'coverage_windows', 'coverage_gaps',
    'card_entity_bindings', 'card_field_drops',
    'observations', 'thoughts', 'facts'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON kith.%I
         FOR EACH ROW EXECUTE FUNCTION kith.record_change()',
      watched || '_change_trg', watched);
  END LOOP;
END;
$$;
