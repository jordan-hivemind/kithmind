-- Additive home for the stateless filesystem ingester's
-- (packages/ingest-simple) glance/full depth policy metadata: page count,
-- byte length, detected tax year, detected kind, ingested depth and the
-- converter identity, as one small JSON object per source item, updated in
-- place on every ingest and every depth promotion. See
-- docs/plans/2026-09-22-simplification-and-feeds.md and
-- packages/ingest-simple/README.md's "Depth policy" section for why no
-- existing column fit before this migration.
--
-- Nullable, with no CHECK on shape: this is provisional, ingester-owned
-- metadata, not a fact or evidence, and it must stay writable by a simple
-- UPDATE from outside a processing-generation transaction (see write.ts's
-- setSourceItemIngestMetadata) without the immutability guarantees the rest
-- of the provenance chain enforces.
ALTER TABLE kith.source_items
  ADD COLUMN ingest_metadata jsonb;
