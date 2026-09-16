-- P2-39e2: the inline ingestion pipeline's indexes.
--
-- Version 18. Migration 004 created every table this row writes -- `inline_work`,
-- `ingest_requests`, `ingest_rate_limits`, `source_fetch_requests` -- with its
-- declarative "structure now, constraints when the code that writes them lands"
-- rule, and migration 008 indexed the one lookup the worker protocol needed from
-- that set (`ingest_requests (source_account_id, request_id)`). This migration
-- adds the remaining lookups the inline lane performs and nothing else.
--
-- No column is added: every column `src/ingestion/` writes already exists. No
-- NOT NULL or CHECK is added either, which is a deliberate limit rather than an
-- oversight. `kith.inline_work` is already written by an existing suite
-- (`test/deferredSweeps.test.mjs`) with only the columns the recovery sweep
-- reads, and migration 017's precedent for declaring a migrated table's required
-- columns applies to a table one row wholly owns. `inline_work` is written by
-- this row and read by the sweep P2-39j already landed, so the required/optional
-- declaration belongs to whichever later row can change both halves at once.
--
-- Uniqueness is added only where the ported Convex code already refused a second
-- row by reading two and throwing. Those reads stay (a unique index can be
-- dropped; the check in the service cannot be), but the index makes the second
-- row unwritable rather than merely refused on the next read -- the upgrade
-- migration 008 made for the worker protocol's own count checks.

-- `createOrGetInlineWork` finds the work row for an admitted ingest job.
-- `admitInlineWork` refuses a second row for one job ("Inline work identity is
-- invalid"); this makes that state unrepresentable. Partial on NOT NULL because
-- migration 004 left the column nullable and the recovery sweep's own fixtures
-- write rows without one.
CREATE UNIQUE INDEX inline_work_ingest_job_idx
  ON kith.inline_work (ingest_job_id)
  WHERE ingest_job_id IS NOT NULL;

-- `recoverInlineIngestion` (`src/deferred/sweeps.ts`) scans for due candidates:
-- `state IN ('queued','running','failed') AND next_attempt_at <= now`, oldest due
-- time first. That sweep has run unindexed since P2-39j; this is the index it
-- was always scanning for. Terminal rows carry no `next_attempt_at`, so the
-- partial predicate keeps them out of the index entirely.
CREATE INDEX inline_work_recovery_idx
  ON kith.inline_work (next_attempt_at, id)
  WHERE next_attempt_at IS NOT NULL
    AND state IN ('queued', 'running', 'failed');

-- The fixed-window admission limiter's single row per credential.
-- `consumeIngestAdmissionRateLimit` refuses a second ("Ingest rate limit state
-- is invalid"); one row per credential is the whole data model.
CREATE UNIQUE INDEX ingest_rate_limits_credential_idx
  ON kith.ingest_rate_limits (credential_id)
  WHERE credential_id IS NOT NULL;

-- `urlQueue.enqueue`'s replay key. Convex read two rows under
-- `by_sourceAccountId_requestId` and threw "Duplicate URL request identity" on
-- the second. NULL `request_id` rows (migration 004 allows them, and
-- `test/coverage.test.mjs` writes them) are distinct under a unique index, so
-- the queue's own fixtures are unaffected.
CREATE UNIQUE INDEX source_fetch_requests_request_idx
  ON kith.source_fetch_requests (source_account_id, request_id)
  WHERE request_id IS NOT NULL;

-- Revision identity is item plus exact byte hash: `createOrGetRevision`
-- (`src/provenance/model.ts`) looks a revision up by exactly this pair on every
-- admission, and admission is now on the request path rather than only the
-- worker's. Convex indexed it as `by_sourceItemId_and_contentHash`.
CREATE INDEX source_revisions_content_idx
  ON kith.source_revisions (source_item_id, content_hash);

-- The generation's identity, read by every admission that must decide whether
-- this exact processing configuration has already been admitted for this exact
-- revision. Convex indexed it as
-- `by_sourceRevisionId_and_processingFingerprint`.
CREATE INDEX processing_generations_fingerprint_idx
  ON kith.processing_generations (source_revision_id, processing_fingerprint);

-- `getInlineIngestResult` reads the generation's published document to answer
-- with a document id. Convex indexed it as `by_processingGenerationId`.
CREATE INDEX documents_generation_idx
  ON kith.documents (processing_generation_id);
