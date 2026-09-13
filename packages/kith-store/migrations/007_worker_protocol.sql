-- The worker protocol's own constraints and indexes (P2-39e).
--
-- Migration 004 (P2-39b) already created every table this domain needs, with
-- "every non-structural column nullable and constraint-free on purpose": that
-- row's job was structural fidelity and the six parity checks, with the
-- required/optional split left to the row that owns each domain. This is that
-- declaration for `models/workers` and the part of `models/ingestion` the
-- worker protocol admits through.
--
-- Two classes of table, treated differently, and the difference is the same one
-- migration 006 drew:
--
--   * Drained tables. Section 1.2 of the consolidation plan does not migrate
--     queue or scan state -- "a quiesced worker has no in-flight work to
--     preserve" -- so `worker_source_scans`, `worker_scan_pages`,
--     `worker_scan_entries`, `worker_discovery_work` and
--     `worker_protocol_rate_limits` are empty at load. They get the full
--     treatment: NOT NULL, CHECKs, and the UNIQUE indexes that make the
--     protocol's own invariants unrepresentable rather than merely unqueried.
--   * Migrated tables. `source_items`, `source_accounts`, `ingest_jobs`,
--     `ingest_requests`, `source_alias_digests` and the four receipt tables all
--     carry real rows across. They get indexes only. A UNIQUE index on a
--     migrated table would turn a tested *denial* into a failed *load*: the
--     protocol reads two rows and denies with `scan_conflict` where it expects
--     one, exactly as `requireSpaceAccess` does for a duplicate membership, and
--     that count check stays in code rather than becoming a load-time refusal of
--     data Convex was willing to hold.
--
-- The code keeps its count checks either way, including on the tables that now
-- have a UNIQUE index. They are the tested denials and a constraint that makes
-- one unreachable is defence in depth, not a licence to delete the assertion.
--
-- `IF NOT EXISTS` on every index: migration 007 is reserved for P2-39d2, which
-- is declaring the provenance read surface's own indexes in parallel, and a
-- `source_items` index it happens to need too must not make this migration a
-- collision. Names are prefixed by domain so the two rows' declarations stay
-- attributable.

-- ---------------------------------------------------------------------------
-- Part 1. The drained scan and queue tables: required columns and value ranges.
-- ---------------------------------------------------------------------------

-- `created_at` is Convex's `_creationTime`. A row this system inserts gets it
-- from the transaction clock, which is also what makes `(created_at, id)` a
-- usable keyset order (section 2.3) without every INSERT naming it.
ALTER TABLE kith.worker_source_scans
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN request_id SET NOT NULL,
  ALTER COLUMN request_digest SET NOT NULL,
  ALTER COLUMN watcher_id SET NOT NULL,
  ALTER COLUMN connector_version SET NOT NULL,
  ALTER COLUMN mode SET NOT NULL,
  ALTER COLUMN inventory_epoch SET NOT NULL,
  ALTER COLUMN manifest_version_at_begin SET NOT NULL,
  ALTER COLUMN actor_user_id SET NOT NULL,
  ALTER COLUMN actor_credential_id SET NOT NULL,
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN next_page_ordinal SET NOT NULL,
  ALTER COLUMN next_reconcile_ordinal SET NOT NULL,
  ALTER COLUMN inventory_done SET NOT NULL,
  ALTER COLUMN page_count SET NOT NULL,
  ALTER COLUMN entry_count SET NOT NULL,
  ALTER COLUMN changed_count SET NOT NULL,
  ALTER COLUMN gap_count SET NOT NULL,
  ALTER COLUMN review_count SET NOT NULL,
  ALTER COLUMN started_at SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN retire_at SET NOT NULL,
  ADD CONSTRAINT worker_source_scans_mode_check
    CHECK (mode IN ('normal', 'identity_recovery')),
  ADD CONSTRAINT worker_source_scans_state_check
    CHECK (state IN ('open', 'sealed', 'reconciling', 'enumerated',
                     'needs_review', 'failed')),
  -- The six FS gap codes the wire contract names, no others.
  ADD CONSTRAINT worker_source_scans_failure_code_check
    CHECK (failure_code IS NULL OR failure_code IN
      ('empty', 'enumeration_interrupted', 'oversized', 'permission_denied',
       'unreadable', 'unstable', 'unsupported', 'encrypted')),
  -- Every counter is a whole non-negative number. `numeric` would otherwise
  -- accept 0.5 or -1 for an ordinal, which no code path can produce and no code
  -- path checks for on the way out.
  ADD CONSTRAINT worker_source_scans_counts_check
    CHECK (inventory_epoch >= 0 AND inventory_epoch = trunc(inventory_epoch)
       AND manifest_version_at_begin >= 0
       AND manifest_version_at_begin = trunc(manifest_version_at_begin)
       AND next_page_ordinal >= 0 AND next_page_ordinal = trunc(next_page_ordinal)
       AND next_reconcile_ordinal >= 0
       AND next_reconcile_ordinal = trunc(next_reconcile_ordinal)
       AND page_count >= 0 AND page_count = trunc(page_count)
       AND entry_count >= 0 AND entry_count = trunc(entry_count)
       AND changed_count >= 0 AND changed_count = trunc(changed_count)
       AND gap_count >= 0 AND gap_count = trunc(gap_count)
       AND review_count >= 0 AND review_count = trunc(review_count));

-- One scan per `(source account, request id)`: the idempotent replay key for
-- `scan.begin`. UNIQUE rather than advisory because a second concurrent begin
-- with the same request id must not be able to produce a second scan even if
-- SERIALIZABLE were relaxed one day.
CREATE UNIQUE INDEX IF NOT EXISTS worker_source_scans_request_idx
  ON kith.worker_source_scans (source_account_id, request_id);

-- The latest scan for a source, which is `source.status`'s fallback when no
-- scan is active. `_creationTime DESC` becomes `(created_at, id) DESC`.
CREATE INDEX IF NOT EXISTS worker_source_scans_latest_idx
  ON kith.worker_source_scans (source_account_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS worker_source_scans_retire_idx
  ON kith.worker_source_scans (retire_at);

ALTER TABLE kith.worker_scan_pages
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN scan_id SET NOT NULL,
  ALTER COLUMN ordinal SET NOT NULL,
  ALTER COLUMN request_id SET NOT NULL,
  ALTER COLUMN entry_count SET NOT NULL,
  ALTER COLUMN created_at_field SET NOT NULL,
  ALTER COLUMN retire_at SET NOT NULL,
  ADD CONSTRAINT worker_scan_pages_ordinal_check
    CHECK (ordinal >= 0 AND ordinal = trunc(ordinal)
       AND entry_count >= 0 AND entry_count = trunc(entry_count)),
  ADD CONSTRAINT worker_scan_pages_scan_fkey
    FOREIGN KEY (scan_id, space_id)
    REFERENCES kith.worker_source_scans (id, space_id);

-- A page is identified twice within its scan and both are exclusive: by the
-- request that appended it (the replay key) and by its ordinal (the contract's
-- "append in order, exactly once" rule).
CREATE UNIQUE INDEX IF NOT EXISTS worker_scan_pages_request_idx
  ON kith.worker_scan_pages (scan_id, request_id);
CREATE UNIQUE INDEX IF NOT EXISTS worker_scan_pages_ordinal_idx
  ON kith.worker_scan_pages (scan_id, ordinal);
CREATE INDEX IF NOT EXISTS worker_scan_pages_retire_idx
  ON kith.worker_scan_pages (retire_at);

ALTER TABLE kith.worker_scan_entries
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN scan_id SET NOT NULL,
  ALTER COLUMN scan_page_id SET NOT NULL,
  ALTER COLUMN identity_key_hash SET NOT NULL,
  ALTER COLUMN uri_digest SET NOT NULL,
  ALTER COLUMN inventory_metadata_digest SET NOT NULL,
  ALTER COLUMN source_modified_at SET NOT NULL,
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN observed_at SET NOT NULL,
  ALTER COLUMN retire_at SET NOT NULL,
  ADD CONSTRAINT worker_scan_entries_state_check
    CHECK (state IN ('unchanged', 'queued', 'gap', 'ignored_forgotten',
                     'needs_review')),
  ADD CONSTRAINT worker_scan_entries_representation_check
    CHECK (content_representation IS NULL
       OR content_representation IN ('inline_utf8_v1', 'archived_binary_v1')),
  ADD CONSTRAINT worker_scan_entries_epochs_check
    CHECK ((observation_epoch IS NULL
            OR (observation_epoch >= 0
                AND observation_epoch = trunc(observation_epoch)))
       AND (processing_epoch IS NULL
            OR (processing_epoch >= 0
                AND processing_epoch = trunc(processing_epoch)))
       AND (byte_length IS NULL
            OR (byte_length >= 0 AND byte_length = trunc(byte_length)))),
  ADD CONSTRAINT worker_scan_entries_page_fkey
    FOREIGN KEY (scan_page_id, space_id)
    REFERENCES kith.worker_scan_pages (id, space_id),
  ADD CONSTRAINT worker_scan_entries_scan_fkey
    FOREIGN KEY (scan_id, space_id)
    REFERENCES kith.worker_source_scans (id, space_id);

CREATE INDEX IF NOT EXISTS worker_scan_entries_page_idx
  ON kith.worker_scan_entries (scan_page_id, created_at, id);
-- One entry per identity per scan. The duplicate is what
-- `duplicate_scan_identity` reports, and the check that finds it reads this.
CREATE UNIQUE INDEX IF NOT EXISTS worker_scan_entries_identity_idx
  ON kith.worker_scan_entries (scan_id, identity_key_hash);
CREATE INDEX IF NOT EXISTS worker_scan_entries_retire_idx
  ON kith.worker_scan_entries (retire_at);

ALTER TABLE kith.worker_discovery_work
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN source_item_id SET NOT NULL,
  ALTER COLUMN scan_id SET NOT NULL,
  ALTER COLUMN scan_entry_id SET NOT NULL,
  ALTER COLUMN observation_epoch SET NOT NULL,
  ALTER COLUMN processing_epoch SET NOT NULL,
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN content_hash SET NOT NULL,
  ALTER COLUMN byte_length SET NOT NULL,
  ALTER COLUMN captured_at SET NOT NULL,
  ALTER COLUMN source_modified_at SET NOT NULL,
  ALTER COLUMN media_type SET NOT NULL,
  ALTER COLUMN profile_id SET NOT NULL,
  ALTER COLUMN extraction_fingerprint SET NOT NULL,
  ALTER COLUMN extractor_fingerprint SET NOT NULL,
  ALTER COLUMN record_schema_fingerprint SET NOT NULL,
  ALTER COLUMN normalization_fingerprint SET NOT NULL,
  ALTER COLUMN chunker_fingerprint SET NOT NULL,
  ALTER COLUMN uri SET NOT NULL,
  ALTER COLUMN actor_user_id SET NOT NULL,
  ALTER COLUMN actor_credential_id SET NOT NULL,
  ALTER COLUMN attempts SET NOT NULL,
  ALTER COLUMN lease_epoch SET NOT NULL,
  ALTER COLUMN created_at_field SET NOT NULL,
  ALTER COLUMN retire_at SET NOT NULL,
  ADD CONSTRAINT worker_discovery_work_state_check
    CHECK (state IN ('queued', 'leased', 'admitted', 'failed', 'needs_review',
                     'obsolete')),
  ADD CONSTRAINT worker_discovery_work_representation_check
    CHECK (content_representation IS NULL
       OR content_representation IN ('inline_utf8_v1', 'archived_binary_v1')),
  -- A lease is all three fields or none of them. The protocol reads them
  -- together and a half-written lease is a `lease_conflict` it should never
  -- have to consider.
  ADD CONSTRAINT worker_discovery_work_lease_check
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)
       AND (lease_token IS NULL) = (lease_owner_credential_id IS NULL)),
  ADD CONSTRAINT worker_discovery_work_numbers_check
    CHECK (observation_epoch >= 0 AND observation_epoch = trunc(observation_epoch)
       AND processing_epoch >= 0 AND processing_epoch = trunc(processing_epoch)
       AND byte_length >= 0 AND byte_length = trunc(byte_length)
       AND attempts >= 0 AND attempts = trunc(attempts)
       AND lease_epoch >= 0 AND lease_epoch = trunc(lease_epoch)
       AND (expected_desired_processing_epoch IS NULL
            OR (expected_desired_processing_epoch >= 0
                AND expected_desired_processing_epoch
                    = trunc(expected_desired_processing_epoch)))),
  ADD CONSTRAINT worker_discovery_work_entry_fkey
    FOREIGN KEY (scan_entry_id, space_id)
    REFERENCES kith.worker_scan_entries (id, space_id),
  ADD CONSTRAINT worker_discovery_work_scan_fkey
    FOREIGN KEY (scan_id, space_id)
    REFERENCES kith.worker_source_scans (id, space_id);

-- At most one live work row per `(item, observation epoch)`. Convex enforced
-- this by reading two rows and denying; here the second insert cannot happen.
-- Partial, because `obsolete` rows accumulate at the same key by design: an
-- obsoleted row is history, and history may repeat an epoch.
CREATE UNIQUE INDEX IF NOT EXISTS worker_discovery_work_current_idx
  ON kith.worker_discovery_work (source_item_id, observation_epoch)
  WHERE state <> 'obsolete';

-- The reservation scan. One index serves all three due-work shapes (queued,
-- retryable-failed past its backoff, and a lease that has expired) because all
-- three filter on the same leading columns and differ only in which timestamp
-- they compare; `created_at, id` trails so the claim order is the keyset order
-- without a sort.
CREATE INDEX IF NOT EXISTS worker_discovery_work_due_idx
  ON kith.worker_discovery_work
     (source_account_id, content_representation, state, created_at, id);
CREATE INDEX IF NOT EXISTS worker_discovery_work_retire_idx
  ON kith.worker_discovery_work (retire_at);
-- `requeueFailedDiscoveryWork` (PR210) and the scan-entry chain walk.
CREATE INDEX IF NOT EXISTS worker_discovery_work_entry_idx
  ON kith.worker_discovery_work (scan_entry_id);

ALTER TABLE kith.worker_protocol_rate_limits
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN credential_id SET NOT NULL,
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN window_started_at SET NOT NULL,
  ALTER COLUMN count SET NOT NULL,
  ADD CONSTRAINT worker_protocol_rate_limits_count_check
    CHECK (count >= 0 AND count = trunc(count));

-- One window per `(credential, source account)`. The limit is per source
-- (tracker row P2-80k keeps the numbers), so the key is what makes the upsert
-- below a single statement instead of a read, a branch and two writes.
CREATE UNIQUE INDEX IF NOT EXISTS worker_protocol_rate_limits_key_idx
  ON kith.worker_protocol_rate_limits (credential_id, source_account_id);

-- ---------------------------------------------------------------------------
-- Part 2. The migrated tables: indexes only.
-- ---------------------------------------------------------------------------

-- The inventory page and the reconcile sweep both walk every item of a source
-- in one stable order. Section 2.3: a keyset cursor over `(created_at, id)`.
CREATE INDEX IF NOT EXISTS worker_source_items_account_keyset_idx
  ON kith.source_items (source_account_id, created_at, id);
-- Identity resolution: an entry's external id hashes to at most one live item.
CREATE INDEX IF NOT EXISTS worker_source_items_external_idx
  ON kith.source_items (source_account_id, external_id_hash);

CREATE INDEX IF NOT EXISTS worker_source_alias_digests_item_idx
  ON kith.source_alias_digests (source_item_id);
CREATE INDEX IF NOT EXISTS worker_source_alias_digests_digest_idx
  ON kith.source_alias_digests (source_account_id, digest);

CREATE INDEX IF NOT EXISTS worker_reservation_receipts_request_idx
  ON kith.worker_reservation_receipts (source_account_id, kind, request_id);
CREATE INDEX IF NOT EXISTS worker_reservation_receipts_retire_idx
  ON kith.worker_reservation_receipts (retire_at);
CREATE INDEX IF NOT EXISTS worker_reservation_targets_receipt_idx
  ON kith.worker_reservation_targets (receipt_id, ordinal);

CREATE INDEX IF NOT EXISTS worker_operation_receipts_request_idx
  ON kith.worker_operation_receipts (source_account_id, operation, request_id);
CREATE INDEX IF NOT EXISTS worker_operation_receipts_retire_idx
  ON kith.worker_operation_receipts (retire_at);

-- Admission writes an `ingest_requests` row per request id and reads it back on
-- replay; the job index is the one `jobs.reserve` (row e's second PR) claims on.
CREATE INDEX IF NOT EXISTS worker_ingest_requests_request_idx
  ON kith.ingest_requests (source_account_id, request_id);
CREATE INDEX IF NOT EXISTS worker_ingest_jobs_desired_idx
  ON kith.ingest_jobs (source_item_id, desired_processing_epoch);
CREATE INDEX IF NOT EXISTS worker_ingest_jobs_claim_idx
  ON kith.ingest_jobs (source_account_id, state, next_attempt_at, created_at, id);
