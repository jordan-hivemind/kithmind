-- P2-39d2: two columns kith-migrate's snapshot (migration 004) did not carry,
-- needed by the provenance/documents read surface this row ports.
--
-- AGENTS.md reserves 006 for the parallel P2-39c identity port. This row's
-- task brief asked for 007 on that basis, but `git fetch origin && git
-- checkout -b task/P2-39d2 origin/main` found no migration 006 registered in
-- src/schema.ts's KITH_MIGRATIONS -- P2-39c has not merged yet -- and the
-- runner in schema.ts refuses any gap (`migration.version !== current + 1`
-- throws `schema_version_gap`), so registering this as version 7 with no
-- version 6 present would fail `applyKithSchema` immediately, on this branch,
-- for every test. 006 is the next free number in practice, so this uses it
-- and is named accordingly; whichever of P2-39c or this row merges second
-- must rebase and renumber its own migration to keep the sequence gapless.
-- P2-39c has since landed migration 006, so this is migration 007.
-- (the same accommodation this row's brief already made in the other
-- direction). Noted for the tracker and for GitHub Issue 57.
--
-- 1. `source_items.card_doc_type`. Convex's `sourceItemFields` (P2-80i,
--    models/provenance/validators.ts) added this column after the schema
--    kith-migrate captured for migration 004, so `kith.source_items` lacks
--    it. `effectiveDocType` (ported in src/documents/model.ts) reads it: an
--    active document's type is the item's live card kind when one exists,
--    the parser's own `documents.doc_type` otherwise. It lives on the item,
--    not on `documents`, because `documents` is inside the sealed parsed
--    payload's manifest digest (this migration's own `parsedStaging.ts`
--    port) and patching the row in place would break that seal for every
--    document a card had refined.
--
-- 2. `chunks.text_search` plus its GIN index. Section 1.2 of
--    docs/plans/2026-09-12-postgres-consolidation.md assigns `kith.chunks`
--    a generated `tsvector` column with a GIN index in place of Convex's
--    `by_text` search index; nothing before this migration created it, and
--    `searchDocuments`'s keyword leg (also ported in
--    src/documents/model.ts) needs it. Generated and stored, not
--    maintained by the application, so it can never drift from `text`.
ALTER TABLE kith.source_items ADD COLUMN card_doc_type text;

ALTER TABLE kith.chunks ADD COLUMN text_search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX chunks_text_search_idx ON kith.chunks USING GIN (text_search);
