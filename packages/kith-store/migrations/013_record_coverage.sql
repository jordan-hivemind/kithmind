-- P2-39f5. Existing migrated rows may be malformed or duplicated. Runtime
-- readers therefore validate and deny completeness rather than trusting these
-- indexes or adding constraints that would make an old database unloadable.
CREATE INDEX coverage_windows_lookup_idx
  ON kith.coverage_windows (source_account_id, record_type, entity_id, "from", "to", id);
CREATE INDEX coverage_gaps_lookup_idx
  ON kith.coverage_gaps (source_account_id, record_type, entity_id, status, id);
CREATE INDEX coverage_fetch_requests_lookup_idx
  ON kith.source_fetch_requests (source_account_id, id);
CREATE INDEX coverage_ingest_jobs_state_lookup_idx
  ON kith.ingest_jobs (source_account_id, state, id);
