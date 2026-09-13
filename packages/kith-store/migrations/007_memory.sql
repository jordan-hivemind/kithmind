-- The memory domain's own constraints and indexes: `entities`, `facts` and
-- `thoughts`, structurally created nullable and constraint-free by migration
-- 004 (P2-39b), the same way migration 006 (P2-39c) tightened identity.
--
-- Numbering note: this file is 007 in this worktree because, at the time it
-- was written, migrations 007 and 008 were reserved for P2-39d2 and P2-39e,
-- both in flight on other branches and neither merged yet. Whoever merges
-- this after one or both land must renumber this file (and its
-- `KITH_MIGRATIONS` entry in src/schema.ts) to the next free version so the
-- final sequence stays contiguous from 1 -- `applyKithSchema` refuses a gap.
--
-- Three constraints are deliberately *not* declared, each because the typed
-- surface in `src/memory/` depends on the state it would make unrepresentable:
--
--   * No CHECK ties `facts.value`'s `entityId` (a jsonb field) to a real
--     `entities` row. A jsonb value cannot carry a foreign key, so
--     `hydrateFact` re-checks it and space-scopes it at read time, exactly as
--     the Convex original did against `ctx.db.get`.
--   * `thoughts.memory_status` stays nullable. A freshly written row always
--     carries `'current'` (`captureThought` sets it), but a row migrated from
--     a Convex thought written before the memory-lifecycle fields existed can
--     carry NULL, and NULL is "current" there too -- the CHECK allows it
--     rather than making that legacy shape unloadable.
--   * No uniqueness on `(space_id, subject_entity_id, predicate)` for
--     `facts.status = 'current'`. `rememberFact` enforces the
--     `MAX_CURRENT_FACTS_PER_PREDICATE` bound and the duplicate/supersede
--     decision in application code, reading up to that bound and deciding;
--     a partial unique index would turn "more than one current value for a
--     single-cardinality predicate" from an application decision into a
--     constraint violation that the multi-cardinality path must legitimately
--     be able to reach.

-- ---------------------------------------------------------------------------
-- entities
-- ---------------------------------------------------------------------------

ALTER TABLE kith.entities
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN key SET NOT NULL,
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN canonical_name SET NOT NULL,
  ALTER COLUMN normalized_name SET NOT NULL,
  ALTER COLUMN aliases SET DEFAULT '[]'::jsonb,
  ALTER COLUMN aliases SET NOT NULL,
  ALTER COLUMN normalized_aliases SET DEFAULT '[]'::jsonb,
  ALTER COLUMN normalized_aliases SET NOT NULL,
  ADD CONSTRAINT entities_kind_check
    CHECK (kind IN ('person', 'organization', 'project', 'place', 'other')),
  ADD CONSTRAINT entities_key_check CHECK (char_length(key) BETWEEN 1 AND 160),
  ADD CONSTRAINT entities_canonical_name_check
    CHECK (char_length(canonical_name) BETWEEN 1 AND 200),
  ADD CONSTRAINT entities_aliases_check CHECK (jsonb_typeof(aliases) = 'array'),
  ADD CONSTRAINT entities_normalized_aliases_check
    CHECK (jsonb_typeof(normalized_aliases) = 'array'),
  ADD CONSTRAINT entities_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- `resolveEntity` reads this with an expected-unique lookup (Convex's
-- `.unique()` on `by_spaceId_and_key`) and relies on a second row being
-- impossible rather than merely unlikely.
CREATE UNIQUE INDEX entities_space_key_idx ON kith.entities (space_id, key);

-- ---------------------------------------------------------------------------
-- facts
-- ---------------------------------------------------------------------------

ALTER TABLE kith.facts
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN subject_entity_id SET NOT NULL,
  ALTER COLUMN predicate SET NOT NULL,
  ALTER COLUMN value SET NOT NULL,
  ALTER COLUMN statement SET NOT NULL,
  ALTER COLUMN search_text SET NOT NULL,
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN confidence SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT facts_predicate_check
    CHECK (predicate ~ '^[a-z][a-z0-9_]{1,63}$'),
  ADD CONSTRAINT facts_value_check CHECK (jsonb_typeof(value) = 'object'),
  ADD CONSTRAINT facts_source_type_check
    CHECK (source_type IN ('user_stated', 'user_confirmed')),
  ADD CONSTRAINT facts_status_check
    CHECK (status IN ('current', 'superseded', 'retracted')),
  ADD CONSTRAINT facts_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  ADD CONSTRAINT facts_supersedes_check
    CHECK (supersedes IS NULL OR jsonb_typeof(supersedes) = 'array'),
  ADD CONSTRAINT facts_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- `rememberFact`'s current-value read: every current fact for one subject and
-- predicate, bounded by `MAX_CURRENT_FACTS_PER_PREDICATE`.
CREATE INDEX facts_space_subject_predicate_status_idx
  ON kith.facts (space_id, subject_entity_id, predicate, status);
-- `listFacts`'s two non-core reads (current-only and history-included).
CREATE INDEX facts_space_status_created_idx
  ON kith.facts (space_id, status, created_at DESC, id DESC);
-- `listFacts`'s core reads.
CREATE INDEX facts_space_core_status_created_idx
  ON kith.facts (space_id, is_core, status, created_at DESC, id DESC)
  WHERE is_core IS TRUE;

-- ---------------------------------------------------------------------------
-- thoughts
-- ---------------------------------------------------------------------------

ALTER TABLE kith.thoughts
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN content SET NOT NULL,
  ALTER COLUMN metadata SET NOT NULL,
  ADD CONSTRAINT thoughts_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object'),
  ADD CONSTRAINT thoughts_memory_status_check
    CHECK (memory_status IS NULL
      OR memory_status IN ('current', 'superseded', 'retracted')),
  ADD CONSTRAINT thoughts_supersedes_check
    CHECK (supersedes IS NULL OR jsonb_typeof(supersedes) = 'array'),
  ADD CONSTRAINT thoughts_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- `listBySpaces`/`captureThought`'s retrievability reads, one per space.
CREATE INDEX thoughts_space_status_created_idx
  ON kith.thoughts (space_id, memory_status, created_at DESC, id DESC);
-- `listCoreBySpaces`.
CREATE INDEX thoughts_space_core_created_idx
  ON kith.thoughts (space_id, is_core, created_at DESC, id DESC)
  WHERE is_core IS TRUE;
-- `listBySpaces`'s `metadata.type` filter (Convex's `by_spaceId_and_type`).
CREATE INDEX thoughts_space_type_created_idx
  ON kith.thoughts (space_id, (metadata ->> 'type'), created_at DESC, id DESC);
