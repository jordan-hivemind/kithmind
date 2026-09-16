-- P2-39: the identities the store asserts at read time become database facts.
--
-- Version 20. Every index below backs a lookup that already exists in
-- `packages/kith-store/src`: the code reads its identity key with `LIMIT 2` and
-- throws ("X identity is not unique") or answers `scan_conflict` when two rows
-- come back. That habit came from Convex, where an index cannot be unique, so
-- the only place an invariant could live was the read. On PostgreSQL it can live
-- in the database, and it should:
--
--   * Under SERIALIZABLE the read-then-insert is already safe, but nothing in
--     the schema says so. A write arriving under READ COMMITTED -- a migration
--     load, a repair script, a future path that forgets the transaction helper --
--     can still create the second row.
--   * A duplicate that does get written is not a local failure. It poisons every
--     later read of that identity, because the lookup that finds two rows throws
--     rather than picking one. Failing the *write* with 23505 keeps the damage at
--     the one statement that caused it.
--   * A migration load carrying a legacy Convex duplicate fails at load time,
--     named by index, instead of passing the load and breaking a read months
--     later. Step 3.5's audit reads these indexes back out of the catalog, so it
--     reports such a row without any change to the audit itself.
--
-- The read-time checks stay. A unique index can be dropped; the check in the
-- service cannot, and its message is more useful than a constraint name. They are
-- defense in depth, not a duplicate of this migration.
--
-- Every index is partial on `<key column> IS NOT NULL`. Migration 004 created
-- these tables from the Convex export with its "structure now, constraints when
-- the code that writes them lands" rule, so every key column below is nullable,
-- and existing fixtures write rows that leave some of them unset. A NULL key is
-- not an identity: the partial predicate keeps those rows out of the index rather
-- than letting NULL-distinctness silently admit them.
--
-- No index below carries a status predicate. Each lookup was read for one: none
-- of them filters on a lifecycle, publication or retirement column, and none of
-- the write paths creates a second row when the first is retired. `source_items`
-- refuses a forgotten item's external id rather than re-creating it and never
-- rewrites `external_id_hash`; `documents` moves an existing row between
-- `staged`, `active` and `historical` by id rather than inserting a successor;
-- archive receipts are never deleted or superseded. So the identity holds across
-- every state, and an unconditional index is the honest one.

-- ---------------------------------------------------------------------------
-- Provenance chain identities (`src/provenance/model.ts`, `binary.ts`).
-- ---------------------------------------------------------------------------

-- `createOrGetSourceItem` (model.ts): an external id hashes to at most one item
-- of a source account. `itemByExternalIdentity` (`src/workers/entries.ts`) reads
-- the same pair and answers `identity_review_required` on two, which is an error
-- the owner has to resolve, not a tolerated state -- `identity_recovery` mode
-- resolves an entry *to* an existing item and never adds a second one. Convex
-- indexed it as `by_sourceAccountId_and_externalIdHash`. Replaces migration 008's
-- non-unique `worker_source_items_external_idx` over the same pair.
DROP INDEX IF EXISTS kith.worker_source_items_external_idx;
CREATE UNIQUE INDEX source_items_external_identity_idx
  ON kith.source_items (source_account_id, external_id_hash)
  WHERE source_account_id IS NOT NULL AND external_id_hash IS NOT NULL;

-- Revision identity is item plus exact byte hash: `createOrGetRevision`
-- (model.ts) and `createOrGetArchivedRevision` (binary.ts) look a revision up by
-- exactly this pair and reuse the row rather than writing a second one, inline
-- and archived alike. Convex indexed it as `by_sourceItemId_and_contentHash`.
-- Migration 018 created this name non-unique; it is recreated unique here so the
-- lookup keeps the index name it has always used.
DROP INDEX IF EXISTS kith.source_revisions_content_idx;
CREATE UNIQUE INDEX source_revisions_content_idx
  ON kith.source_revisions (source_item_id, content_hash)
  WHERE source_item_id IS NOT NULL AND content_hash IS NOT NULL;

-- One extraction of one revision produces one text version: `createOrGetTextVersion`
-- (model.ts) and `createOrGetParsedTextVersion` (binary.ts) both read this pair
-- and reject a conflicting second declaration. The extraction fingerprint is what
-- a re-extraction changes, so a genuinely new extraction gets a new key rather
-- than a second row under the old one. Convex:
-- `by_sourceRevisionId_and_extractionFingerprint`.
CREATE UNIQUE INDEX source_text_versions_extraction_idx
  ON kith.source_text_versions (source_revision_id, extraction_fingerprint)
  WHERE source_revision_id IS NOT NULL AND extraction_fingerprint IS NOT NULL;

-- A page ordinal is unique within its text version, not globally: the ordinal
-- restarts at 0 for every text version, so the parent is part of the key.
-- `stagePages` (model.ts) reads this pair per page and refuses a
-- conflicting one; `insertParsedPages` (`src/provenance/parsedStaging.ts`)
-- appends strictly at `pageIds.length`. Convex:
-- `by_sourceTextVersionId_and_ordinal`.
CREATE UNIQUE INDEX source_pages_ordinal_idx
  ON kith.source_pages (source_text_version_id, ordinal)
  WHERE source_text_version_id IS NOT NULL AND ordinal IS NOT NULL;

-- The same shape one level down: an evidence ordinal restarts per page, so the
-- page is part of the key. `stageEvidenceSpans` (model.ts) reads the pair
-- and rejects a conflicting span; the card-citation path (model.ts, the second
-- `evidence_spans` insert) picks the lowest ordinal not already used on that
-- page, which is exactly the invariant this index holds. `insertParsedEvidence`
-- (parsedStaging.ts) assigns a stage-global ordinal instead, which is strictly
-- stronger: globally distinct ordinals are distinct within any page. Convex:
-- `by_sourcePageId_and_ordinal`.
CREATE UNIQUE INDEX evidence_spans_ordinal_idx
  ON kith.evidence_spans (source_page_id, ordinal)
  WHERE source_page_id IS NOT NULL AND ordinal IS NOT NULL;

-- A document key is unique within the generation that produced it, not within a
-- space: the same key recurs across generations of the same item, which is how a
-- reprocessed document stays the same document. `stageDocuments`
-- (model.ts) reads this pair, and `insertParsedDocuments` (parsedStaging.ts)
-- refuses `request_conflict` on a repeat. Publication state is not in the key:
-- `staged`, `active` and `historical` are updates to the one row.
-- Convex: `by_processingGenerationId_and_documentKey`.
CREATE UNIQUE INDEX documents_key_idx
  ON kith.documents (processing_generation_id, document_key)
  WHERE processing_generation_id IS NOT NULL AND document_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Parser artifacts and archive receipts (`src/provenance/artifacts.ts`).
-- ---------------------------------------------------------------------------

-- `createOrGetParserArtifact` reads two identities and refuses a second row under
-- either, so both are indexed. One revision parsed by one parser yields one
-- artifact. Convex: `by_sourceRevisionId_and_parserFingerprint`.
CREATE UNIQUE INDEX source_parser_artifacts_fingerprint_idx
  ON kith.source_parser_artifacts (source_revision_id, parser_fingerprint)
  WHERE source_revision_id IS NOT NULL AND parser_fingerprint IS NOT NULL;

-- The caller-supplied replay key for the same call: a retried request carrying
-- the same `clientArtifactId` must land on the row the first attempt wrote, which
-- is only true while that id names at most one row. Convex:
-- `by_sourceAccountId_and_clientArtifactId`.
CREATE UNIQUE INDEX source_parser_artifacts_client_idx
  ON kith.source_parser_artifacts (source_account_id, client_artifact_id)
  WHERE source_account_id IS NOT NULL AND client_artifact_id IS NOT NULL;

-- `createOrGetArchiveReceipt` likewise reads two identities and refuses a second
-- row under either. The client receipt id is the replay key. Convex:
-- `by_sourceAccountId_and_clientReceiptId`.
CREATE UNIQUE INDEX source_artifact_archive_receipts_client_idx
  ON kith.source_artifact_archive_receipts (source_account_id, client_receipt_id)
  WHERE source_account_id IS NOT NULL AND client_receipt_id IS NOT NULL;

-- The archive-side identity: one object in one archive identity is receipted
-- once. `copy_role` is deliberately not in the key: `requireIndependentArchivePair`
-- (`src/provenance/archiveBindings.ts`) requires a primary and a backup copy to
-- carry different archive identity fingerprints, so two roles never collide
-- here, and including the role would let one object be receipted twice. Convex:
-- `by_archiveIdentity_and_objectId`.
CREATE UNIQUE INDEX source_artifact_archive_receipts_object_idx
  ON kith.source_artifact_archive_receipts (archive_identity_fingerprint, archive_object_id)
  WHERE archive_identity_fingerprint IS NOT NULL AND archive_object_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Admission identities (`src/ingestion/inlineWork.ts`, `src/workers/`).
-- ---------------------------------------------------------------------------

-- The generation's identity: one processing configuration is admitted once for
-- one revision. `admitInlineSourceRevision` (inlineWork.ts) reads it, additionally
-- filtered by space, which narrows the scan but is not part of the identity, the
-- revision already belonging to one space, and `createArchivedIngestWork`
-- (`src/workers/archivedDiscovery.ts`) reads the pair alone and tells the caller
-- to increment `correctionRevision` when it already exists. The correction
-- revision is folded into the fingerprint, so re-processing the same revision on
-- purpose produces a new key rather than a second row under the old one. Convex:
-- `by_sourceRevisionId_and_processingFingerprint`. Migration 018 created this
-- name non-unique; recreated unique here under the same name.
DROP INDEX IF EXISTS kith.processing_generations_fingerprint_idx;
CREATE UNIQUE INDEX processing_generations_fingerprint_idx
  ON kith.processing_generations (source_revision_id, processing_fingerprint)
  WHERE source_revision_id IS NOT NULL AND processing_fingerprint IS NOT NULL;

-- The admission replay key. `admitInlineWork` (inlineWork.ts) and
-- `createOrReuseInlineAdmission` (`src/workers/discovery.ts`) both read a request
-- id within its source account and return the first attempt's result on a repeat,
-- after checking the request digest matches; a second row makes that replay
-- answer `scan_conflict` forever. `admitInlineWork` also filters by space, which
-- the account already fixes, so the two-column key is the identity. Convex: `by_sourceAccountId_and_requestId`.
-- Replaces migration 008's non-unique `worker_ingest_requests_request_idx`.
DROP INDEX IF EXISTS kith.worker_ingest_requests_request_idx;
CREATE UNIQUE INDEX ingest_requests_request_idx
  ON kith.ingest_requests (source_account_id, request_id)
  WHERE source_account_id IS NOT NULL AND request_id IS NOT NULL;
