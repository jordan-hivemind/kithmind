-- UI-IA: a disconnected connection is not merely disabled, and a worker can
-- advertise its allowed root aliases before any watched location exists.
ALTER TABLE kith.source_accounts
  ADD COLUMN disconnected_at timestamptz,
  ADD COLUMN disconnected_by kith.kith_id
    REFERENCES kith.users (id) ON DELETE SET NULL,
  ADD COLUMN allowed_root_aliases jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(allowed_root_aliases) = 'array'),
  ADD COLUMN allowed_roots_reported_at timestamptz,
  ADD CONSTRAINT source_accounts_disconnected_check CHECK (
    (disconnected_at IS NULL AND disconnected_by IS NULL) OR
    (disconnected_at IS NOT NULL AND enabled = false)
  );
