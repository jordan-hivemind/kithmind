ALTER TABLE kith.api_keys ADD CONSTRAINT api_keys_id_space_unique UNIQUE (id, space_id);

CREATE TABLE kith.worker_jobs (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES kith.spaces(id) ON DELETE CASCADE,
  enqueue_request_id uuid NOT NULL,
  enqueue_request_hash text NOT NULL CHECK (enqueue_request_hash ~ '^[0-9a-f]{64}$'),
  enqueued_by_api_key_id uuid NOT NULL,
  work_kind text NOT NULL CHECK (work_kind = 'synthetic_document_processing'),
  work_key text NOT NULL CHECK (octet_length(work_key) BETWEEN 1 AND 128),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5 AND attempt_count <= max_attempts),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_epoch integer NOT NULL DEFAULT 0 CHECK (lease_epoch BETWEEN 0 AND 5),
  lease_token_hash bytea CHECK (lease_token_hash IS NULL OR octet_length(lease_token_hash) = 32),
  leased_by_api_key_id uuid,
  lease_expires_at timestamptz,
  output_hash text CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code = 'attempts_exhausted'),
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (space_id, enqueue_request_id),
  UNIQUE (id, space_id),
  FOREIGN KEY (enqueued_by_api_key_id, space_id) REFERENCES kith.api_keys(id, space_id),
  FOREIGN KEY (leased_by_api_key_id, space_id) REFERENCES kith.api_keys(id, space_id),
  CHECK (
    (state = 'queued' AND attempt_count = 0 AND lease_token_hash IS NULL AND leased_by_api_key_id IS NULL AND lease_expires_at IS NULL AND output_hash IS NULL AND completed_at IS NULL AND failure_code IS NULL AND failed_at IS NULL)
    OR
    (state = 'running' AND attempt_count > 0 AND lease_token_hash IS NOT NULL AND leased_by_api_key_id IS NOT NULL AND lease_expires_at IS NOT NULL AND output_hash IS NULL AND completed_at IS NULL AND failure_code IS NULL AND failed_at IS NULL)
    OR
    (state = 'succeeded' AND attempt_count > 0 AND lease_token_hash IS NOT NULL AND leased_by_api_key_id IS NOT NULL AND lease_expires_at IS NOT NULL AND output_hash IS NOT NULL AND completed_at IS NOT NULL AND failure_code IS NULL AND failed_at IS NULL)
    OR
    (state = 'failed' AND attempt_count = max_attempts AND lease_token_hash IS NULL AND leased_by_api_key_id IS NULL AND lease_expires_at IS NULL AND output_hash IS NULL AND completed_at IS NULL AND failure_code = 'attempts_exhausted' AND failed_at IS NOT NULL)
  )
);

CREATE INDEX worker_jobs_claim_idx
  ON kith.worker_jobs (space_id, state, available_at, lease_expires_at, created_at, id);
