-- Goal-aware tax extraction over sealed, selectively converted PDF pages.
--
-- A result is revision-bound and never becomes a source item's active
-- processing generation.  `batches` names immutable source text versions and
-- exact original PDF pages; `outcomes` names only values with retained
-- evidence.  The worker replaces neither array in place: it appends a batch
-- and then merges cited outcomes under a row lock.

ALTER TABLE kith.deferred_work
  DROP CONSTRAINT deferred_work_kind_check,
  ADD CONSTRAINT deferred_work_kind_check
    CHECK (kind IN ('inline_ingestion', 'embedding_fill', 'card_queue_tick',
                    'document_extraction', 'investment_link',
                    'targeted_tax_extraction'));

CREATE TABLE kith.document_targeted_extractions (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  source_account_id kith.kith_id NOT NULL,
  source_item_id kith.kith_id NOT NULL,
  source_revision_id kith.kith_id NOT NULL,
  goal_kind text NOT NULL CHECK (goal_kind IN
    ('form_1040_totals_v1', 'schedule_k1_key_fields_v1')),
  goal_version integer NOT NULL CHECK (goal_version = 1),
  instance_key text NOT NULL CHECK (octet_length(instance_key) BETWEEN 1 AND 256),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  source_page_count integer NOT NULL CHECK (source_page_count BETWEEN 1 AND 10000),
  required_fields jsonb NOT NULL CHECK (
    jsonb_typeof(required_fields) = 'array' AND
    jsonb_array_length(required_fields) BETWEEN 1 AND 128 AND
    octet_length(required_fields::text) <= 16384),
  optional_fields jsonb NOT NULL CHECK (
    jsonb_typeof(optional_fields) = 'array' AND
    jsonb_array_length(optional_fields) <= 128 AND
    octet_length(optional_fields::text) <= 16384),
  status text NOT NULL CHECK (status IN
    ('awaiting_pages', 'running', 'complete', 'incomplete_resumable', 'conflict')),
  batches jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(batches) = 'array' AND
    jsonb_array_length(batches) <= 1024 AND
    octet_length(batches::text) <= 2097152),
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(outcomes) = 'array' AND
    jsonb_array_length(outcomes) <= 128 AND
    octet_length(outcomes::text) <= 524288),
  unresolved_codes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(unresolved_codes) = 'array' AND
           jsonb_array_length(unresolved_codes) <= 256 AND
           octet_length(unresolved_codes::text) <= 32768),
  model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  UNIQUE (id, space_id),
  UNIQUE (source_revision_id, goal_kind, goal_version, instance_key),
  FOREIGN KEY (source_account_id, space_id)
    REFERENCES kith.source_accounts (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (source_item_id, space_id)
    REFERENCES kith.source_items (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (source_revision_id, space_id)
    REFERENCES kith.source_revisions (id, space_id) ON DELETE CASCADE
);

CREATE INDEX document_targeted_extractions_item_idx
  ON kith.document_targeted_extractions (space_id, source_item_id, updated_at DESC);

-- Targeted text is deliberately a third, non-active representation.  Its
-- exact coverage lives in the parent result's immutable batch manifest.  A
-- parser artifact is optional because Dropbox is the retained original and
-- the selected PDF artifact is represented by its bound hashes in that
-- manifest rather than admitted as a whole-document parser artifact.
COMMENT ON COLUMN kith.source_text_versions.representation IS
  'inline_text_v1, parsed_pages_v1, or targeted_pages_v1; targeted pages are never active full-document text';
