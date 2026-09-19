-- ADM-5a: typed extraction's own two schema needs.
--
-- 1. A deferred-work kind. Migration 017 constrains `deferred_work.kind` to a
--    closed list for the reason it gives there: a typo must fail the INSERT
--    rather than sit in a row nothing knows how to run. Adding a kind is
--    therefore a migration, the same way `embedding_fill` was.
--
-- 2. One row per extracted document. Everything the extraction *asserts* is an
--    ordinary event plus observations with evidence spans (so `query_records`,
--    coverage and citations keep working unchanged); this table is what the
--    extraction *is*: which document type and which VERSION of it was used,
--    which model produced it, when, how much of the document the model was
--    shown, and the per-statement detail that has no column in `observations`
--    (the cited page and quote, and whether a money value's currency was
--    assumed rather than read off the page).
--
-- Keyed by `source_item_id`, not by a `brain_documents` id. The source item is
-- the durable identity of "this document": a re-parse mints a new generation
-- and new `brain_documents` rows, and an extraction (and the corrections the
-- owner made against it) must survive that. `corrections.target_id` carries
-- the same source item id for `target_kind = 'document'`.

ALTER TABLE kith.deferred_work
  DROP CONSTRAINT deferred_work_kind_check,
  ADD CONSTRAINT deferred_work_kind_check
    CHECK (kind IN ('inline_ingestion', 'embedding_fill', 'card_queue_tick',
                    'document_extraction'));

CREATE TABLE kith.document_extractions (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  source_item_id kith.kith_id NOT NULL,
  processing_generation_id kith.kith_id NOT NULL,
  -- The stable event the statements hang off. Null only between the row's
  -- insert and the first statement, which never happens in one transaction.
  event_id kith.kith_id,
  -- The kind the model chose: one of the space's active `document_types.kind`
  -- values, or the literal 'other'. Free text rather than a foreign key
  -- because "adding a kind is a row, not a release" (section 8) and a type may
  -- later be deactivated without invalidating what was already read.
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 100),
  document_type_id kith.kith_id,
  -- Recorded, not derived: the guidance that produced this reading is the
  -- version that was active when it ran, and editing guidance bumps it.
  document_type_version integer CHECK (document_type_version IS NULL
                                       OR document_type_version >= 1),
  summary text,
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  extracted_at timestamptz NOT NULL,
  -- Truncation is a visible limitation, never a silent one: `pages_read <
  -- pages_total` is the whole statement, and the extraction also opens a
  -- correction item when it happens.
  pages_read integer NOT NULL CHECK (pages_read >= 0),
  pages_total integer NOT NULL CHECK (pages_total >= 0),
  statements jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(statements) = 'array'),
  UNIQUE (id, space_id),
  FOREIGN KEY (source_item_id, space_id)
    REFERENCES kith.source_items (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (processing_generation_id, space_id)
    REFERENCES kith.processing_generations (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, space_id)
    REFERENCES kith.events (id, space_id) ON DELETE SET NULL
);

-- One current extraction per document. Re-extraction replaces this row's
-- contents in the same transaction as it replaces the observations.
CREATE UNIQUE INDEX document_extractions_item_idx
  ON kith.document_extractions (source_item_id);

-- The "re-extract every document of this kind" scheduler's scan.
CREATE INDEX document_extractions_kind_idx
  ON kith.document_extractions (space_id, kind, source_item_id);

-- Migration 023's feed, for the types-and-fields and corrections screens.
CREATE TRIGGER document_extractions_change_trg
  AFTER INSERT OR UPDATE OR DELETE ON kith.document_extractions
  FOR EACH ROW EXECUTE FUNCTION kith.record_change();
