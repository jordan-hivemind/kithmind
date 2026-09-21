-- UI-IA: durable identities and audit facts for actionable coverage gaps.
--
-- A gap occurrence remains immutable after it is resolved. Re-detecting the
-- same condition while it is open refreshes that occurrence; detecting it
-- after resolution opens a new occurrence. The partial unique index is the
-- database half of that rule.
ALTER TABLE kith.coverage_gaps
  ADD COLUMN condition_key text;

WITH keyed AS (
  SELECT id,
         md5(concat_ws(E'\x1f', source_account_id::text, record_type,
                       coalesce(entity_id::text, ''),
                       coalesce((extract(epoch FROM "from") * 1000)::bigint::text, ''),
                       coalesce((extract(epoch FROM "to") * 1000)::bigint::text, ''),
                       reason)) AS base_key,
         row_number() OVER (
           PARTITION BY space_id,
             md5(concat_ws(E'\x1f', source_account_id::text, record_type,
                           coalesce(entity_id::text, ''),
                           coalesce((extract(epoch FROM "from") * 1000)::bigint::text, ''),
                           coalesce((extract(epoch FROM "to") * 1000)::bigint::text, ''),
                           reason))
           ORDER BY detected_at DESC, id DESC
         ) AS duplicate_number
    FROM kith.coverage_gaps
   WHERE status = 'open'
), all_keys AS (
  SELECT g.id,
         CASE
           WHEN k.duplicate_number IS NULL OR k.duplicate_number = 1
             THEN md5(concat_ws(E'\x1f', g.source_account_id::text,
                                g.record_type, coalesce(g.entity_id::text, ''),
                                coalesce((extract(epoch FROM g."from") * 1000)::bigint::text, ''),
                                coalesce((extract(epoch FROM g."to") * 1000)::bigint::text, ''),
                                g.reason))
           ELSE k.base_key || ':legacy-duplicate:' || g.id::text
         END AS condition_key
    FROM kith.coverage_gaps g
    LEFT JOIN keyed k ON k.id = g.id
)
UPDATE kith.coverage_gaps g
   SET condition_key = a.condition_key
  FROM all_keys a
 WHERE a.id = g.id;

ALTER TABLE kith.coverage_gaps
  ALTER COLUMN condition_key SET NOT NULL,
  ADD CONSTRAINT coverage_gaps_condition_key_length_check
    CHECK (char_length(condition_key) BETWEEN 1 AND 512);

CREATE UNIQUE INDEX coverage_gaps_open_condition_idx
  ON kith.coverage_gaps (space_id, condition_key)
  WHERE status = 'open';

-- Legacy CSV imports predate condition_key and COPY only their mapped
-- columns. Derive the same identity for those rows before NOT NULL is
-- enforced; current writers supply the value explicitly.
CREATE OR REPLACE FUNCTION kith.fill_coverage_gap_condition_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.condition_key IS NULL THEN
    NEW.condition_key := md5(concat_ws(E'\x1f', NEW.source_account_id::text,
      NEW.record_type, coalesce(NEW.entity_id::text, ''),
      coalesce((extract(epoch FROM NEW."from") * 1000)::bigint::text, ''),
      coalesce((extract(epoch FROM NEW."to") * 1000)::bigint::text, ''),
      NEW.reason));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS coverage_gaps_condition_key_trg ON kith.coverage_gaps;

CREATE TRIGGER coverage_gaps_condition_key_trg
  BEFORE INSERT OR UPDATE OF condition_key ON kith.coverage_gaps
  FOR EACH ROW EXECUTE FUNCTION kith.fill_coverage_gap_condition_key();

CREATE TABLE kith.coverage_gap_actions (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  coverage_gap_id kith.kith_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  actor_user_id kith.kith_id REFERENCES kith.users (id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'system')),
  action text NOT NULL CHECK (action IN
    ('condition_cleared', 'mark_unavailable', 'mark_not_expected')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  UNIQUE (id, space_id),
  FOREIGN KEY (coverage_gap_id, space_id)
    REFERENCES kith.coverage_gaps (id, space_id),
  CONSTRAINT coverage_gap_actions_actor_check CHECK (
    (actor_kind = 'user' AND actor_user_id IS NOT NULL AND
      action IN ('mark_unavailable', 'mark_not_expected')) OR
    (actor_kind = 'system' AND actor_user_id IS NULL AND
      action = 'condition_cleared')
  )
);

CREATE INDEX coverage_gap_actions_gap_idx
  ON kith.coverage_gap_actions
     (space_id, coverage_gap_id, created_at DESC, id DESC);

CREATE TRIGGER coverage_gap_actions_change_trg
  AFTER INSERT OR UPDATE OR DELETE ON kith.coverage_gap_actions
  FOR EACH ROW EXECUTE FUNCTION kith.record_change();
