-- P2-39g1: the vector column, the full-text columns, and the indexes the
-- retrieval legs in `src/embeddings/search.ts` read.
--
-- Section 2.7 of docs/plans/2026-09-12-postgres-consolidation.md is the
-- design. Four decisions it left open are settled here.
--
-- 1. Where `vector` lives. `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA
--    public`, and every reference from application code is schema-qualified
--    (`public.vector`, `OPERATOR(public.<=>)`). It has to be: a ported
--    mutation runs under `withKithTransaction`, which pins
--    `search_path TO kith` alone (`@repo/pg`'s `withSchemaTransaction`), so an
--    unqualified `vector` or `<=>` would not resolve there. `public` rather
--    than `kith` because the extension is a database-wide object that a
--    co-located component may already own; relocating someone else's
--    extension under them is not this migration's business. The DO block
--    below turns a pre-existing `vector` in some *other* schema into a loud
--    failure instead of a column that cannot be created.
--
-- 2. The column type. `embedding` was `jsonb` (migration 004 copied the
--    Convex shape verbatim). Section 5.2 does not migrate vector rows -- they
--    are derived, content-addressed by `input_hash`, and re-embedded after
--    cutover -- so the table is empty on every target and the column is
--    dropped and re-added as `public.vector(1536)` rather than converted.
--    Nothing is rounded in place.
--
-- 3. The `real[]` fallback of section 2.7's last row is deliberately NOT
--    implemented in this slice. Both places this schema is applied provide
--    the extension: the hosted provider supports `pgvector` on every plan
--    with no add-on, and CI now runs `pgvector/pgvector:pg17`. A second,
--    untested cosine path would be a claim of a known-good degraded mode
--    that nothing exercises. If a target ever lacks the extension, this
--    migration fails at step 1, which is the honest answer.
--
-- 4. No HNSW index. The pilot corpus is 180 active targets; an exact scan
--    filtered by `(space_id, embedding_fingerprint, target_kind)` is correct
--    and fast at that size. Add `USING hnsw (embedding vector_cosine_ops)`
--    when one space exceeds about 2,000 targets, which is the card-model
--    first backfill.
--
-- `scope_v2` is kept rather than dropped. Section 2.7 retires it as a
-- *filter* -- that job is the composite index below -- but the ported
-- resolvers (`resolveAuthorizedThoughtVectorCandidates` and its chunk and
-- card siblings) also recheck `row.scopeV2` against a scope recomputed from
-- the row's own space, fingerprint and kind. That is an integrity check on a
-- row that claims to be in scope, not a lookup, and dropping the column would
-- delete the check rather than reimplement it.

-- ---------------------------------------------------------------------------
-- 1. The extension
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_extension AS e
      JOIN pg_namespace AS n ON n.oid = e.extnamespace
     WHERE e.extname = 'vector' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION
      'pgvector must be installed in the public schema; kith''s vector reads are qualified as public.vector';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. embedding_vectors: the vector column, its domain constraints, its indexes
-- ---------------------------------------------------------------------------

ALTER TABLE kith.embedding_vectors DROP COLUMN embedding;
ALTER TABLE kith.embedding_vectors ADD COLUMN embedding public.vector(1536);

ALTER TABLE kith.embedding_vectors
  ALTER COLUMN embedding_generation_id SET NOT NULL,
  ALTER COLUMN embedding_fingerprint SET NOT NULL,
  ALTER COLUMN target_kind SET NOT NULL,
  ALTER COLUMN input_hash SET NOT NULL,
  ALTER COLUMN scope_v2 SET NOT NULL,
  ALTER COLUMN embedding SET NOT NULL,
  ADD CONSTRAINT embedding_vectors_target_kind_check
    CHECK (target_kind IN ('thought', 'chunk', 'card')),
  -- One row names exactly one target, and the kind says which. The resolvers
  -- assert the same shape row by row (a thought row with a `chunk_id` is
  -- dropped); the constraint makes the state unreachable rather than merely
  -- unreturned.
  ADD CONSTRAINT embedding_vectors_target_identity_check CHECK (
    (target_kind = 'thought'
       AND thought_id IS NOT NULL AND chunk_id IS NULL AND event_id IS NULL
       AND processing_generation_id IS NULL)
    OR (target_kind = 'chunk'
       AND chunk_id IS NOT NULL AND thought_id IS NULL AND event_id IS NULL
       AND processing_generation_id IS NOT NULL)
    OR (target_kind = 'card'
       AND event_id IS NOT NULL AND thought_id IS NULL AND chunk_id IS NULL)
  ),
  ADD CONSTRAINT embedding_vectors_input_hash_check
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT embedding_vectors_fingerprint_check
    CHECK (embedding_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT embedding_vectors_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- Section 2.7's replacement for Convex's `scopeV2` filter field: every
-- candidate scan is `space_id = $1 AND embedding_fingerprint = $2 AND
-- target_kind = $3`, then an exact cosine scan of what survives.
CREATE INDEX embedding_vectors_scope_idx
  ON kith.embedding_vectors (space_id, embedding_fingerprint, target_kind);

-- Convex's `by_generation_and_thoughtId` / `_chunkId` / `_eventId`: the
-- per-target lookups the fill, retirement and duplicate probe use. Partial,
-- because each one is meaningless for the other two kinds.
CREATE INDEX embedding_vectors_generation_thought_idx
  ON kith.embedding_vectors (embedding_generation_id, thought_id)
  WHERE thought_id IS NOT NULL;
CREATE INDEX embedding_vectors_generation_chunk_idx
  ON kith.embedding_vectors (embedding_generation_id, chunk_id)
  WHERE chunk_id IS NOT NULL;
CREATE INDEX embedding_vectors_generation_event_idx
  ON kith.embedding_vectors (embedding_generation_id, event_id)
  WHERE event_id IS NOT NULL;

-- `findEmbeddingTarget`'s expected-unique lookup (Convex's
-- `by_space_kind_target`), which the I7 eligibility recheck runs per
-- candidate.
CREATE INDEX embedding_targets_space_kind_target_idx
  ON kith.embedding_targets (space_id, target_kind, target_id);

-- `getActiveEmbeddingTarget`'s `.unique()` on `by_spaceId`. Not UNIQUE: the
-- read deliberately takes two rows and reports the duplicate as a fault,
-- exactly as Convex's `.take(2)` did.
CREATE INDEX space_embedding_states_space_idx
  ON kith.space_embedding_states (space_id);

-- ---------------------------------------------------------------------------
-- 3. thoughts.content_search and facts.search_text_search
-- ---------------------------------------------------------------------------
--
-- Named after their source columns, matching `chunks.text_search` (migration
-- 007) over `chunks.text`. Generated and stored, so the index can never drift
-- from the text it indexes. `'english'`, matching the document keyword leg.
--
-- This is not equivalent to what Convex's search indexes did: Convex is typo
-- tolerant and prefix matching, PostgreSQL full-text search stems. Section
-- 4.2 measures the difference with the frozen question set; this migration
-- does not claim parity, and `pg_trgm` is the named remedy if recall drops.

ALTER TABLE kith.thoughts ADD COLUMN content_search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX thoughts_content_search_idx
  ON kith.thoughts USING GIN (content_search);

ALTER TABLE kith.facts ADD COLUMN search_text_search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED;

CREATE INDEX facts_search_text_search_idx
  ON kith.facts USING GIN (search_text_search);
