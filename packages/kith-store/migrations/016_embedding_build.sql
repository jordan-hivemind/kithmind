-- P2-39g2: the constraints and indexes the embedding index's *write* side
-- needs. Migration 015 gave the read side its vector column and its candidate
-- scan indexes; this one gives the generation lifecycle, the target table, the
-- counters and the paged build the shapes they depend on.
--
-- The design is docs/plans/2026-09-12-index-capacity.md (sections 2.1, 2.2,
-- 3.3 and 4) carried onto PostgreSQL by section 2.3 of
-- docs/plans/2026-09-12-postgres-consolidation.md, which turns every Convex
-- `paginate` cursor into a keyset cursor over `(created_at, id)` with a
-- supporting index. Four decisions this migration settles:
--
-- 1. `space_embedding_states (space_id)` becomes UNIQUE. Migration 015 left it
--    a plain index on purpose, because the read deliberately takes two rows
--    and reports a second one as a fault, exactly as Convex's `.take(2)` did.
--    The write side changes the argument: `ensureSpaceEmbeddingState` here and
--    `touchWorkerPublicationEmbedding` in `src/workers/publication.ts` both
--    check-then-insert that row. `SERIALIZABLE` does detect that write skew
--    and abort one of them, so uniqueness is not load-bearing for correctness
--    today -- but it is a property of one isolation level rather than of the
--    schema, and the state row is the one row every reader derives its filter
--    from. The `LIMIT 2` fault path stays in the code as a defensive check
--    and simply becomes unreachable, which is the direction section 2.5 of the
--    consolidation plan asks for ("unrepresentable in the schema"). The index
--    keeps its 015 name so no existing reference has to move.
--
-- 2. The `numeric` counter columns migration 004 copied from the Convex
--    `v.number()` shape are NOT retyped to an integer type. `@repo/kith-migrate`
--    renders a Convex number with `String(value)` and constrains nothing about
--    it (`src/transform.ts`), so retyping would move a validation out of the
--    reading code and into a `COPY` that has no way to report which row it
--    refused. What this migration does instead is state the real domain as
--    CHECK constraints -- whole and non-negative -- which is the same
--    guarantee, is enforced on every write rather than only at load, and
--    leaves 004's frozen structural snapshot alone.
--
-- 3. The owed set is a partial index, not a scan. Convex's
--    `by_space_state_and_coveredFingerprint` is an index page over exactly the
--    rows the fill still owes; here that is
--    `(space_id) WHERE state = 'eligible' AND covered_fingerprint IS NULL`.
--    Covering a target removes it from the index, which is why the fill needs
--    no cursor of its own and why replaying a fill page writes nothing twice.
--
-- 4. The paged build's cursors are ascending `(created_at, id)` keysets, so
--    each scan stage gets an ascending index of its own rather than reusing
--    the descending list indexes of migration 009. A descending index can
--    serve an ascending scan, but the build pages every row in a space
--    exactly once per run and the stage predicates differ from the list
--    predicates, so sharing one would be a coincidence rather than a design.
--    The audit phase pages by `(space_id, target_kind, target_id)` instead,
--    which is the identity order its unique index already provides.

-- ---------------------------------------------------------------------------
-- 1. embedding_profiles: one row per fingerprint
-- ---------------------------------------------------------------------------
--
-- `ensureEmbeddingProfile` looks a profile up by fingerprint and expects at
-- most one; a second row is "Duplicate embedding profile fingerprint". The
-- fingerprint is a SHA-256 over the profile fields, so two rows with one
-- fingerprint are either a collision or a damaged row, never a tiebreak.
--
-- Only `fingerprint` becomes NOT NULL. The seven descriptive columns are the
-- fingerprint's own preimage and `ensureEmbeddingProfile` never writes a row
-- missing one, but the read that needs them already fails closed on a null
-- (`profileFromRow` in `src/embeddings/targets.ts` throws "Embedding
-- generation profile is invalid"), so a NOT NULL would be a second opinion
-- rather than the only one. It would also make a legitimate row shape
-- unwritable: the worker publish path in `src/workers/publication.ts` reads
-- nothing from a profile but its fingerprint, and its tests stand up exactly
-- that row.

ALTER TABLE kith.embedding_profiles
  ALTER COLUMN fingerprint SET NOT NULL,
  ADD CONSTRAINT embedding_profiles_fingerprint_check
    CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT embedding_profiles_dimensions_check
    CHECK (dimensions IS NULL
           OR (dimensions > 0 AND dimensions = trunc(dimensions)));

CREATE UNIQUE INDEX embedding_profiles_fingerprint_key
  ON kith.embedding_profiles (fingerprint);

-- ---------------------------------------------------------------------------
-- 2. space_embedding_states: one row per space, and its counters
-- ---------------------------------------------------------------------------

DROP INDEX kith.space_embedding_states_space_idx;
CREATE UNIQUE INDEX space_embedding_states_space_idx
  ON kith.space_embedding_states (space_id);

ALTER TABLE kith.space_embedding_states
  ALTER COLUMN eligibility_epoch SET NOT NULL,
  ADD CONSTRAINT space_embedding_states_epoch_check
    CHECK (eligibility_epoch >= 0
           AND eligibility_epoch = trunc(eligibility_epoch)),
  -- Section 8.2 of the document-card plan. NULL is `all_chunks`, which is what
  -- `spaceEmbedsAllChunks` reads, so deploying the card model retires nothing.
  ADD CONSTRAINT space_embedding_states_target_policy_check
    CHECK (target_policy IS NULL
           OR target_policy IN ('all_chunks', 'cards_and_opted_in_chunks')),
  -- The counters are read as three named kinds and as a fingerprint list. A
  -- reader that finds another shape throws rather than guessing, so the
  -- constraint makes the shape unreachable rather than merely unread.
  ADD CONSTRAINT space_embedding_states_eligible_counts_check
    CHECK (eligible_counts IS NULL
           OR jsonb_typeof(eligible_counts) = 'object'),
  ADD CONSTRAINT space_embedding_states_covered_counts_check
    CHECK (covered_counts IS NULL OR jsonb_typeof(covered_counts) = 'array'),
  ADD CONSTRAINT space_embedding_states_historical_counts_check
    CHECK (historical_thought_counts IS NULL
           OR jsonb_typeof(historical_thought_counts) = 'object'),
  ADD CONSTRAINT space_embedding_states_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 3. embedding_generations: the six states and the two lookups
-- ---------------------------------------------------------------------------

ALTER TABLE kith.embedding_generations
  ALTER COLUMN embedding_profile_id SET NOT NULL,
  ALTER COLUMN fingerprint SET NOT NULL,
  ALTER COLUMN state SET NOT NULL,
  ADD CONSTRAINT embedding_generations_state_check
    CHECK (state IN ('staging', 'staged', 'active', 'failed', 'retired',
                     'retired_cleaned')),
  ADD CONSTRAINT embedding_generations_fingerprint_check
    CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT embedding_generations_counts_check
    CHECK ((expected_thought_count IS NULL
            OR (expected_thought_count >= 0
                AND expected_thought_count = trunc(expected_thought_count)))
       AND (expected_chunk_count IS NULL
            OR (expected_chunk_count >= 0
                AND expected_chunk_count = trunc(expected_chunk_count)))
       AND (completed_thought_count IS NULL
            OR (completed_thought_count >= 0
                AND completed_thought_count = trunc(completed_thought_count)))
       AND (completed_chunk_count IS NULL
            OR (completed_chunk_count >= 0
                AND completed_chunk_count = trunc(completed_chunk_count)))),
  -- A generation is deactivated exactly when it is no longer the live one.
  -- `getActiveEmbeddingTarget` refuses an `active` row carrying a
  -- `deactivated_at`, which is the pointer fault it reports; the constraint
  -- makes that pair unreachable instead.
  ADD CONSTRAINT embedding_generations_deactivated_check
    CHECK (deactivated_at IS NULL OR state <> 'active'),
  ADD CONSTRAINT embedding_generations_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT embedding_generations_profile_id_fkey
    FOREIGN KEY (embedding_profile_id)
    REFERENCES kith.embedding_profiles (id)
    DEFERRABLE INITIALLY DEFERRED;

-- Convex's `by_spaceId_and_fingerprint`: the staged-fingerprint lookup that
-- refuses a second generation of a fingerprint a space already has.
CREATE INDEX embedding_generations_space_fingerprint_idx
  ON kith.embedding_generations (space_id, fingerprint);
-- Convex's `by_spaceId_and_state`: `createEmbeddingGeneration` refuses a space
-- that already has a `staging` or a `staged` generation.
CREATE INDEX embedding_generations_space_state_idx
  ON kith.embedding_generations (space_id, state);

-- ---------------------------------------------------------------------------
-- 4. embedding_targets: identity, state and the owed set
-- ---------------------------------------------------------------------------

ALTER TABLE kith.embedding_targets
  ALTER COLUMN target_kind SET NOT NULL,
  ALTER COLUMN target_id SET NOT NULL,
  ALTER COLUMN input_hash SET NOT NULL,
  ALTER COLUMN state SET NOT NULL,
  ADD CONSTRAINT embedding_targets_target_kind_check
    CHECK (target_kind IN ('thought', 'chunk', 'card')),
  ADD CONSTRAINT embedding_targets_state_check
    CHECK (state IN ('eligible', 'retired')),
  ADD CONSTRAINT embedding_targets_input_hash_check
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT embedding_targets_covered_fingerprint_check
    CHECK (covered_fingerprint IS NULL
           OR covered_fingerprint ~ '^[0-9a-f]{64}$'),
  -- I4, structurally: a retired target covers nothing. `retireEmbeddingTarget`
  -- clears the marker in the same statement that retires the row, and the
  -- counter delta it emits assumes exactly this.
  ADD CONSTRAINT embedding_targets_retired_coverage_check
    CHECK (state <> 'retired' OR covered_fingerprint IS NULL),
  ADD CONSTRAINT embedding_targets_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- Identity, as a constraint rather than as a `LIMIT 2` fault. 015 created this
-- index non-unique for the reader's per-candidate I7 recheck; the write side
-- upserts on it, so the duplicate the reader reports must be unreachable.
DROP INDEX kith.embedding_targets_space_kind_target_idx;
CREATE UNIQUE INDEX embedding_targets_space_kind_target_idx
  ON kith.embedding_targets (space_id, target_kind, target_id);

-- Convex's `by_space_state_and_coveredFingerprint`, as a partial index: the
-- owed set of a space is every eligible row with no coverage marker. Covering
-- one removes it from here, which is the whole of `owedTargetsPage`.
CREATE INDEX embedding_targets_owed_idx
  ON kith.embedding_targets (space_id)
  WHERE state = 'eligible' AND covered_fingerprint IS NULL;

-- Convex's `by_space_and_state`, as the ascending keyset the sweep and fill
-- phases page over.
CREATE INDEX embedding_targets_space_state_created_idx
  ON kith.embedding_targets (space_id, state, created_at, id);

-- ---------------------------------------------------------------------------
-- 5. embedding_build_jobs: one open job per space and fingerprint
-- ---------------------------------------------------------------------------

ALTER TABLE kith.embedding_build_jobs
  ALTER COLUMN fingerprint SET NOT NULL,
  ALTER COLUMN phase SET NOT NULL,
  ADD CONSTRAINT embedding_build_jobs_phase_check
    CHECK (phase IN ('scan', 'fill', 'audit', 'done', 'abandoned')),
  ADD CONSTRAINT embedding_build_jobs_fingerprint_check
    CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT embedding_build_jobs_counts_check
    CHECK ((page_index IS NULL
            OR (page_index >= 0 AND page_index = trunc(page_index)))
       AND (scanned_count IS NULL
            OR (scanned_count >= 0 AND scanned_count = trunc(scanned_count)))
       AND (filled_count IS NULL
            OR (filled_count >= 0 AND filled_count = trunc(filled_count)))
       AND (retired_count IS NULL
            OR (retired_count >= 0 AND retired_count = trunc(retired_count)))
       AND (audit_duplicate_targets IS NULL
            OR (audit_duplicate_targets >= 0
                AND audit_duplicate_targets = trunc(audit_duplicate_targets)))),
  -- A terminal job keeps no cursor: `done` and `abandoned` are answered from
  -- the phase alone, and a cursor left on one would be resumable state on a
  -- job nothing may resume.
  ADD CONSTRAINT embedding_build_jobs_terminal_cursor_check
    CHECK (phase NOT IN ('done', 'abandoned') OR cursor IS NULL),
  ADD CONSTRAINT embedding_build_jobs_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- Convex's `by_space_and_fingerprint`: finding the one job a rerun resumes.
CREATE INDEX embedding_build_jobs_space_fingerprint_idx
  ON kith.embedding_build_jobs (space_id, fingerprint);
-- The operator's "what is running in this space" read.
CREATE INDEX embedding_build_jobs_space_phase_idx
  ON kith.embedding_build_jobs (space_id, phase);

-- ---------------------------------------------------------------------------
-- 6. The ascending keysets the scan stages page over
-- ---------------------------------------------------------------------------
--
-- One per stage, in the order the stage reads. Each is a covering prefix of
-- the stage's predicate followed by `(created_at, id)`, so a page is an index
-- range scan bounded by the cursor rather than an offset into a sort.

CREATE INDEX thoughts_space_created_idx
  ON kith.thoughts (space_id, created_at, id);

CREATE INDEX chunks_space_publication_created_idx
  ON kith.chunks (space_id, publication_state, created_at, id);

-- `markGenerationChunkTargets` and the worker's publish touch read a whole
-- processing generation's chunks in the same order.
CREATE INDEX chunks_generation_created_idx
  ON kith.chunks (processing_generation_id, created_at, id);

CREATE INDEX events_space_created_idx
  ON kith.events (space_id, created_at, id);
