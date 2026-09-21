-- MCP-2: the owner's durable classification for one stable source item.
--
-- `document_extractions.kind` is model output and is replaced on every run.
-- An owner correction stored there would therefore disappear on the next
-- extraction. The source item survives reparsing and re-extraction, so it is
-- the home for the override. NULL restores automatic classification.
--
-- The kind is deliberately not a foreign key. Document type rows are
-- versioned, and an override names the logical kind across those versions.
-- The authorized writer verifies that the kind has a current active schema in
-- the same space before storing it. Extraction repeats that check before use.
ALTER TABLE kith.source_items
  ADD COLUMN owner_document_kind text
    CHECK (owner_document_kind IS NULL OR
           char_length(owner_document_kind) BETWEEN 1 AND 100);
