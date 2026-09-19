-- SENS-1: sensitivity as a label, and an opt-in ceiling per connection.
--
-- NOTE FOR MERGE: this file and PR #316 (task/ADM-9,
-- 029_watcher_pass_outcome.sql) both take 029. They were cut from the same
-- origin/main at 028 and neither can see the other's number. The migration
-- runner requires contiguous versions from 1, so a branch cannot politely skip
-- ahead to 030 and still apply -- which is why this is 029 rather than
-- pre-emptively renumbered. Whichever of the two merges SECOND renumbers to
-- 030: rename the file, change the `version` and the URL in src/schema.ts, and
-- update the `migration 029` references in src/sensitivity/*, src/identity/
-- authorization.ts and test/sensitivity*. Nothing else depends on the number.
--
-- WHAT THIS IS NOT
--
-- An earlier draft of this work built a system that masked identifiers out of
-- MCP results, refused to store an SSN as an extracted value, and logged every
-- read of a restricted document. The owner rejected that design on 2026-09-19,
-- in these words: "This is my personal data that I personally am accessing. Why
-- wouldn't I be allowed to view my tax information? Or SSN for that matter? If
-- I forget my wife's SSN and I need it, why shouldn't I be allowed to ask the
-- agent to retrieve it for me?"
--
-- So the rule this migration is built to respect is: nothing here may stand
-- between the owner, or an assistant the owner connected, and the owner's own
-- data. Documents store what they say. Extraction stores the values it reads,
-- identifiers included. MCP tools return them in full. There is no audit table,
-- because there is nobody to audit.
--
-- What is left is two things, and both are additive in the strict sense -- new
-- columns with defaults that reproduce today's behaviour exactly:
--
-- 1. LABELS. A level on a document kind, a field, a source item and a source
--    root. By itself this restricts nothing at all; it is how the archive
--    describes itself, and it is what the one restriction below is expressed
--    in terms of.
--
-- 2. ONE OPT-IN CEILING. `api_keys.max_sensitivity`, defaulting to
--    `restricted`, which means "everything" -- no withholding, today's
--    behaviour, for every existing key and grant and every new one the owner
--    does not deliberately narrow. The owner may LOWER it on a particular
--    credential when handing one to a third-party tool or a client he trusts
--    less. That is the only thing in this migration that can withhold a row,
--    and it only ever does so because the owner chose it for that connection.

-- The levels: closed, ordered, normal < sensitive < restricted. A CHECK rather
-- than free text for the reason migration 017 gives `deferred_work.kind`: a
-- typo must fail the INSERT rather than sit in a row nothing knows how to
-- compare.
--
-- The rank function is what lets `GREATEST` order them and the view below map
-- back. SQL, IMMUTABLE and PARALLEL SAFE: a three-way CASE over a literal.
CREATE FUNCTION kith.sensitivity_rank(level text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE level
           WHEN 'restricted' THEN 2
           WHEN 'sensitive' THEN 1
           ELSE 0
         END;

ALTER TABLE kith.document_types
  ADD COLUMN sensitivity text NOT NULL DEFAULT 'normal'
    CHECK (sensitivity IN ('normal', 'sensitive', 'restricted'));

ALTER TABLE kith.document_type_fields
  ADD COLUMN sensitivity text NOT NULL DEFAULT 'normal'
    CHECK (sensitivity IN ('normal', 'sensitive', 'restricted'));

-- The owner's overrides. NULL, not 'normal': "this row says nothing" and "this
-- row says normal" are different answers, and only the first should let the
-- document's kind speak instead.
--
-- The root override is what makes this usable without per-document work: mark
-- the "Taxes" folder once and every document under it carries the level.
ALTER TABLE kith.source_items
  ADD COLUMN sensitivity text
    CHECK (sensitivity IS NULL
           OR sensitivity IN ('normal', 'sensitive', 'restricted'));

ALTER TABLE kith.source_roots
  ADD COLUMN sensitivity text
    CHECK (sensitivity IS NULL
           OR sensitivity IN ('normal', 'sensitive', 'restricted'));

-- The ceiling. One column, because an OAuth grant IS an `api_keys` row here
-- (migration 006 gave the table `oauth_lifecycle`, `oauth_code_hash` and the
-- rest). The API key form and the consent screen therefore set the same column
-- and there is one enforcement path rather than two that can drift.
--
-- DEFAULT 'restricted' is the owner's decision expressed as a default: a new
-- credential sees everything unless the owner says otherwise, and every key and
-- grant that exists when this migration runs keeps working with nothing hidden.
-- A default of 'sensitive' would have silently narrowed live clients on deploy,
-- which is precisely the behaviour the owner rejected.
ALTER TABLE kith.api_keys
  ADD COLUMN max_sensitivity text NOT NULL DEFAULT 'restricted'
    CHECK (max_sensitivity IN ('normal', 'sensitive', 'restricted'));

-- The effective level, as two views.
--
-- Views rather than a column, because the inputs change under them: editing a
-- kind's level, marking a folder, or re-extracting a document into a different
-- kind all change the answer, and a stored column would need triggers on four
-- tables to stay true. Only the narrowed-ceiling read path joins these, so on
-- the default path they cost nothing at all.
--
-- The level is the MAXIMUM of the kind's and the two overrides', never the
-- minimum and never the last one written. An override raises; it cannot lower a
-- kind's own level. Marking a folder `restricted` therefore cannot be undone by
-- a kind that forgot to declare itself.
--
-- SOURCE ITEM first, because that is the grain almost everything else uses:
-- `observations`, `event_versions`, `source_inventory`, the review queue's
-- binding and drop rows and `document_extractions` all carry `source_item_id`,
-- while only `documents` carries a document id. Defining the rule here and
-- letting the document view build on it is what keeps one definition for both.
--
-- `starts_with` rather than LIKE for the root match: `relative_path` is owner
-- input and a LIKE pattern built from it would read a `%` in a folder name as a
-- wildcard. The trailing slash keeps "Taxes" from matching "Taxes Archive".
CREATE VIEW kith.source_item_sensitivity AS
SELECT
  item.id AS source_item_id,
  item.space_id,
  CASE GREATEST(
         kith.sensitivity_rank(coalesce(kind_type.sensitivity, 'normal')),
         kith.sensitivity_rank(coalesce(item.sensitivity, 'normal')),
         kith.sensitivity_rank(coalesce(root.sensitivity, 'normal')))
    WHEN 2 THEN 'restricted'
    WHEN 1 THEN 'sensitive'
    ELSE 'normal'
  END AS sensitivity
FROM kith.source_items item
LEFT JOIN LATERAL (
  SELECT dt.sensitivity
    FROM kith.document_extractions de
    JOIN kith.document_types dt
      ON dt.id = de.document_type_id AND dt.space_id = de.space_id
   WHERE de.source_item_id = item.id AND de.space_id = item.space_id
   ORDER BY kith.sensitivity_rank(coalesce(dt.sensitivity, 'normal')) DESC
   LIMIT 1
) kind_type ON true
LEFT JOIN LATERAL (
  SELECT sr.sensitivity
    FROM kith.source_roots sr
   WHERE sr.space_id = item.space_id
     AND sr.root_alias IS NOT NULL
     AND sr.relative_path IS NOT NULL
     AND item.uri IS NOT NULL
     AND starts_with(
           item.uri,
           'fs://' || sr.root_alias || '/' || sr.relative_path || '/')
   ORDER BY kith.sensitivity_rank(coalesce(sr.sensitivity, 'normal')) DESC
   LIMIT 1
) root ON true;

-- The document's own level: its source item's, raised by the level of a kind
-- matching its free-text `doc_type`.
--
-- The doc_type fallback matters and is document-grained, which is why it lives
-- here and not in the view above: every document ingested before ADM-5a has no
-- extraction row, and a bank statement from last year must not label itself
-- `normal` merely because it predates typed extraction.
CREATE VIEW kith.document_sensitivity AS
SELECT
  d.id AS document_id,
  d.space_id,
  d.source_item_id,
  CASE GREATEST(
         kith.sensitivity_rank(coalesce(item.sensitivity, 'normal')),
         kith.sensitivity_rank(coalesce(named_type.sensitivity, 'normal')))
    WHEN 2 THEN 'restricted'
    WHEN 1 THEN 'sensitive'
    ELSE 'normal'
  END AS sensitivity
FROM kith.documents d
LEFT JOIN kith.source_item_sensitivity item
  ON item.source_item_id = d.source_item_id AND item.space_id = d.space_id
LEFT JOIN LATERAL (
  SELECT dt.sensitivity
    FROM kith.document_types dt
   WHERE dt.space_id = d.space_id
     AND dt.active
     AND d.doc_type IS NOT NULL
     AND dt.kind = d.doc_type
   ORDER BY kith.sensitivity_rank(coalesce(dt.sensitivity, 'normal')) DESC
   LIMIT 1
) named_type ON true;
