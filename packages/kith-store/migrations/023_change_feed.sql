-- ADM-1: the change feed of section 4 of
-- docs/plans/2026-09-18-admin-panel-and-ingestion.md.
--
-- PostgreSQL and serverless hosting give no subscriptions, so "server-side
-- changes appear live with no refresh" (the owner's UI decision) is a table of
-- ids plus a cursor. One row per insert, update and delete on the tables the
-- admin screens read; the row carries the table name, the row id and the
-- operation and never the row's content, so the feed leaks nothing a reader of
-- the table itself could not already see, and the route over it
-- (`apps/web/src/app/api/kith/changes/route.ts`) has only ids to scope.
--
-- `id` is an identity column rather than `bigserial` on purpose: an identity
-- column's sequence is owned by the column, so INSERT on the table is the whole
-- privilege a writer needs. A `bigserial` would need a separate USAGE grant on
-- the sequence, and a trigger that fires under a role missing it fails the
-- caller's own write, which is the worst possible way for a UI convenience to
-- break.
--
-- ponytail: identity ids are assigned before commit, so two concurrent writers
-- can commit out of id order and a reader polling `id > cursor` between the two
-- commits can step over the slower one. One owner and one worker host write
-- here, a change row is only a hint to refetch, and the client refetches on
-- reconnect and on focus anyway. Upgrade path if it ever matters: read with a
-- lag window on `committed_at` instead of straight off the id.
CREATE TABLE kith.changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Nullable because the trigger is generic and a future table it is attached
  -- to may not be space scoped. A null-space row is never returned by
  -- `listChangesSince`, whose predicate is `space_id = ANY(...)`.
  space_id kith.kith_id,
  table_name text NOT NULL,
  row_id text NOT NULL,
  op text NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  committed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

-- The feed read: one space set, everything past a cursor, in id order.
CREATE INDEX changes_cursor_idx ON kith.changes (space_id, id);

-- The prune sweep's scan (`removeExpiredChanges` in src/deferred/sweeps.ts).
CREATE INDEX changes_committed_at_idx ON kith.changes (committed_at);

-- One trigger function for every table, resolving `space_id` and `id` off the
-- record at run time. A plain insert of four scalars: no `to_jsonb`, no
-- per-table function, nothing that grows with the row's width.
CREATE FUNCTION kith.record_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  changed record;
BEGIN
  IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
  INSERT INTO kith.changes (space_id, table_name, row_id, op)
  VALUES (changed.space_id, TG_TABLE_NAME, changed.id::text, lower(TG_OP));
  RETURN NULL;
END;
$$;

-- The tables the first screens read. The seven new ones from migration 022,
-- plus the four existing ones the sources and health screens are built on:
-- the account itself, its items (the counts), its latest processing assessment
-- (what a pass found) and its watcher state (whether a host is still reporting).
DO $$
DECLARE
  watched text;
BEGIN
  FOREACH watched IN ARRAY ARRAY[
    'document_types', 'document_type_fields',
    'source_roots', 'source_root_reports',
    'investments', 'investment_entries', 'corrections',
    'source_accounts', 'source_items',
    'worker_processing_assessments', 'worker_watcher_states'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON kith.%I
         FOR EACH ROW EXECUTE FUNCTION kith.record_change()',
      watched || '_change_trg', watched);
  END LOOP;
END;
$$;
