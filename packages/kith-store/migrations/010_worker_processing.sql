-- P2-39e: the worker processing lane's claim paths and the two drained state
-- tables used while a parsed payload or a processing assessment is in flight.
--
-- Migration 008 owns scan/discovery state and the shared receipt indexes. This
-- migration follows the real memory migration 009 and adds only constraints
-- that are safe for tables drained before cutover. Ingest jobs and binary
-- receipts are migrated evidence, so their historical rows remain accepted;
-- the worker validates ambiguity at read time and these are supporting indexes.

-- The two reservation scans differ only by processing mode and which due-time
-- column is tested. Keep both orders so PostgreSQL can claim with SKIP LOCKED
-- without sorting or inspecting another source account's jobs.
CREATE INDEX worker_ingest_jobs_mode_next_claim_idx
  ON kith.ingest_jobs
     (source_account_id, worker_processing_mode, worker_managed, state,
      next_attempt_at, created_at, id);
CREATE INDEX worker_ingest_jobs_mode_lease_claim_idx
  ON kith.ingest_jobs
     (source_account_id, worker_processing_mode, worker_managed, state,
      lease_expires_at, created_at, id);
CREATE INDEX worker_ingest_jobs_generation_idx
  ON kith.ingest_jobs (processing_generation_id);
CREATE INDEX worker_ingest_jobs_discovery_idx
  ON kith.ingest_jobs (worker_discovery_work_id);

CREATE INDEX worker_processing_generation_identity_idx
  ON kith.processing_generations
     (source_revision_id, processing_fingerprint, created_at, id);
CREATE INDEX worker_space_processing_state_idx
  ON kith.space_processing_state (space_id, created_at, id);

CREATE INDEX worker_binary_receipts_request_idx
  ON kith.worker_binary_operation_receipts
     (source_account_id, operation, request_id, created_at, id);
CREATE INDEX worker_binary_receipts_stage_retire_idx
  ON kith.worker_binary_operation_receipts (stage_id, retire_at);
CREATE INDEX worker_binary_receipts_retire_idx
  ON kith.worker_binary_operation_receipts (retire_at);

ALTER TABLE kith.worker_parsed_stages
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN source_item_id SET NOT NULL,
  ALTER COLUMN discovery_work_id SET NOT NULL,
  ALTER COLUMN ingest_job_id SET NOT NULL,
  ALTER COLUMN processing_generation_id SET NOT NULL,
  ALTER COLUMN source_revision_id SET NOT NULL,
  ALTER COLUMN source_text_version_id SET NOT NULL,
  ALTER COLUMN parser_artifact_id SET NOT NULL,
  ALTER COLUMN archive_set_digest SET NOT NULL,
  ALTER COLUMN normalized_bundle_digest SET NOT NULL,
  ALTER COLUMN mapping_manifest_hash SET NOT NULL,
  ALTER COLUMN phase SET NOT NULL,
  ALTER COLUMN next_ordinal SET NOT NULL,
  ALTER COLUMN expected_page_count SET NOT NULL,
  ALTER COLUMN expected_evidence_span_count SET NOT NULL,
  ALTER COLUMN expected_document_count SET NOT NULL,
  ALTER COLUMN expected_chunk_count SET NOT NULL,
  ALTER COLUMN accepted_page_count SET NOT NULL,
  ALTER COLUMN accepted_evidence_span_count SET NOT NULL,
  ALTER COLUMN accepted_document_count SET NOT NULL,
  ALTER COLUMN accepted_chunk_count SET NOT NULL,
  ALTER COLUMN page_ids SET NOT NULL,
  ALTER COLUMN evidence_span_ids SET NOT NULL,
  ALTER COLUMN document_ids SET NOT NULL,
  ALTER COLUMN chunk_ids SET NOT NULL,
  ALTER COLUMN page_bytes SET NOT NULL,
  ALTER COLUMN evidence_bytes SET NOT NULL,
  ALTER COLUMN document_bytes SET NOT NULL,
  ALTER COLUMN chunk_bytes SET NOT NULL,
  ALTER COLUMN created_at_field SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN retire_at SET NOT NULL,
  ADD CONSTRAINT worker_parsed_stages_phase_check
    CHECK (phase IN ('pages', 'evidence', 'documents', 'chunks', 'seal', 'staged')),
  ADD CONSTRAINT worker_parsed_stages_counts_check
    CHECK (next_ordinal >= 0 AND next_ordinal = trunc(next_ordinal)
       AND expected_page_count >= 0
       AND expected_page_count = trunc(expected_page_count)
       AND expected_evidence_span_count >= 0
       AND expected_evidence_span_count = trunc(expected_evidence_span_count)
       AND expected_document_count >= 0
       AND expected_document_count = trunc(expected_document_count)
       AND expected_chunk_count >= 0
       AND expected_chunk_count = trunc(expected_chunk_count)
       AND accepted_page_count >= 0
       AND accepted_page_count = trunc(accepted_page_count)
       AND accepted_evidence_span_count >= 0
       AND accepted_evidence_span_count = trunc(accepted_evidence_span_count)
       AND accepted_document_count >= 0
       AND accepted_document_count = trunc(accepted_document_count)
       AND accepted_chunk_count >= 0
       AND accepted_chunk_count = trunc(accepted_chunk_count)
       AND page_bytes >= 0 AND page_bytes = trunc(page_bytes)
       AND evidence_bytes >= 0 AND evidence_bytes = trunc(evidence_bytes)
       AND document_bytes >= 0 AND document_bytes = trunc(document_bytes)
       AND chunk_bytes >= 0 AND chunk_bytes = trunc(chunk_bytes)),
  ADD CONSTRAINT worker_parsed_stages_arrays_check
    CHECK (jsonb_typeof(page_ids) = 'array'
       AND jsonb_typeof(evidence_span_ids) = 'array'
       AND jsonb_typeof(document_ids) = 'array'
       AND jsonb_typeof(chunk_ids) = 'array');

CREATE UNIQUE INDEX worker_parsed_stages_generation_idx
  ON kith.worker_parsed_stages (processing_generation_id);
CREATE UNIQUE INDEX worker_parsed_stages_job_idx
  ON kith.worker_parsed_stages (ingest_job_id);
CREATE INDEX worker_parsed_stages_retire_idx
  ON kith.worker_parsed_stages (retire_at);

ALTER TABLE kith.worker_processing_assessments
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN scan_id SET NOT NULL,
  ALTER COLUMN request_id SET NOT NULL,
  ALTER COLUMN request_digest SET NOT NULL,
  ALTER COLUMN actor_user_id SET NOT NULL,
  ALTER COLUMN actor_credential_id SET NOT NULL,
  ALTER COLUMN inventory_epoch SET NOT NULL,
  ALTER COLUMN completed_inventory_epoch SET NOT NULL,
  ALTER COLUMN manifest_version SET NOT NULL,
  ALTER COLUMN assessment_epoch SET NOT NULL,
  ALTER COLUMN coverage_invalidated_at SET NOT NULL,
  ALTER COLUMN last_enumerated_at SET NOT NULL,
  ALTER COLUMN last_processed_at_at_start SET NOT NULL,
  ALTER COLUMN scan_completed_at SET NOT NULL,
  ALTER COLUMN scan_state_at_start SET NOT NULL,
  ALTER COLUMN scan_entry_count SET NOT NULL,
  ALTER COLUMN scan_changed_count SET NOT NULL,
  ALTER COLUMN scan_gap_count SET NOT NULL,
  ALTER COLUMN scan_review_count SET NOT NULL,
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN phase SET NOT NULL,
  ALTER COLUMN next_ordinal SET NOT NULL,
  ALTER COLUMN counts SET NOT NULL,
  ALTER COLUMN accounted_scan_entries SET NOT NULL,
  ALTER COLUMN queued_scan_entries SET NOT NULL,
  ALTER COLUMN gap_scan_entries SET NOT NULL,
  ALTER COLUMN review_scan_entries SET NOT NULL,
  ALTER COLUMN ignored_scan_entries SET NOT NULL,
  ALTER COLUMN unchanged_scan_entries SET NOT NULL,
  ALTER COLUMN started_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN retire_at SET NOT NULL,
  ADD CONSTRAINT worker_processing_assessments_state_check
    CHECK (state IN ('running', 'complete', 'incomplete', 'stale')),
  ADD CONSTRAINT worker_processing_assessments_phase_check
    CHECK (phase IN ('items', 'unresolved_entries', 'done')),
  ADD CONSTRAINT worker_processing_assessments_scan_state_check
    CHECK (scan_state_at_start IN ('enumerated', 'needs_review')),
  ADD CONSTRAINT worker_processing_assessments_counts_json_check
    CHECK (jsonb_typeof(counts) = 'object'),
  ADD CONSTRAINT worker_processing_assessments_numbers_check
    CHECK (inventory_epoch >= 0 AND inventory_epoch = trunc(inventory_epoch)
       AND completed_inventory_epoch >= 0
       AND completed_inventory_epoch = trunc(completed_inventory_epoch)
       AND manifest_version >= 0 AND manifest_version = trunc(manifest_version)
       AND assessment_epoch >= 0 AND assessment_epoch = trunc(assessment_epoch)
       AND scan_entry_count >= 0 AND scan_entry_count = trunc(scan_entry_count)
       AND scan_changed_count >= 0 AND scan_changed_count = trunc(scan_changed_count)
       AND scan_gap_count >= 0 AND scan_gap_count = trunc(scan_gap_count)
       AND scan_review_count >= 0 AND scan_review_count = trunc(scan_review_count)
       AND next_ordinal >= 0 AND next_ordinal = trunc(next_ordinal)
       AND accounted_scan_entries >= 0
       AND accounted_scan_entries = trunc(accounted_scan_entries)
       AND queued_scan_entries >= 0
       AND queued_scan_entries = trunc(queued_scan_entries)
       AND gap_scan_entries >= 0 AND gap_scan_entries = trunc(gap_scan_entries)
       AND review_scan_entries >= 0
       AND review_scan_entries = trunc(review_scan_entries)
       AND ignored_scan_entries >= 0
       AND ignored_scan_entries = trunc(ignored_scan_entries)
       AND unchanged_scan_entries >= 0
       AND unchanged_scan_entries = trunc(unchanged_scan_entries));

CREATE UNIQUE INDEX worker_processing_assessments_request_idx
  ON kith.worker_processing_assessments (source_account_id, request_id);
CREATE INDEX worker_processing_assessments_source_state_idx
  ON kith.worker_processing_assessments
     (source_account_id, state, created_at, id);
CREATE INDEX worker_processing_assessments_scan_expiry_idx
  ON kith.worker_processing_assessments (scan_id, state, expires_at);
CREATE INDEX worker_processing_assessments_retire_idx
  ON kith.worker_processing_assessments (retire_at);
