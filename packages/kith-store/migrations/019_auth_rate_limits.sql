-- P2-39i follow-up: `kith.auth_rate_limits`, the durable table section 8
-- question 2 of the web and MCP surface plan opened a row for.
--
-- Version 19. Slice i1 shipped the sign-in and sign-up routes with a
-- per-process token bucket (`apps/web/src/lib/kith/rate-limit.ts`) and the
-- owner accepted that for a pre-launch, one-user deployment on the
-- recommendation that a durable table be tracked separately: "A serverless
-- per-process bucket is weaker than the Convex table it replaces ... open a
-- row for the durable table". This is that table.
--
-- Unlike every table migration 004 mapped, this one has no Convex export to
-- shape it from -- `authRateLimits` was explicitly not migrated (plan 1.2 of
-- the consolidation) -- so it is declared once, fully constrained, the way
-- migration 017 declared `kith.deferred_work`.
--
-- The shape is copied from `kith.worker_protocol_rate_limits`
-- (`migrations/008_worker_protocol.sql`, `src/workers/rateLimit.ts`): a fixed
-- window per key, one row per key, an `ON CONFLICT ... DO UPDATE` that either
-- restarts an expired window or increments a live one in a single statement,
-- and a count that keeps climbing on a refused attempt rather than resetting,
-- so retrying into a refusal cannot make the limit softer. The key here is not
-- a pair of `kith_id` references, though: it is a caller-chosen `scope`
-- (which budget, e.g. the per-address or the per-account one) and a `key_hash`
-- (SHA-256 of the caller-chosen key, e.g. a client address or an account
-- email) rather than the raw value, for the same reason `kith.sessions` stores
-- `token_hash` and not the token: a row in this table is diagnostic-adjacent
-- and a database dump should not hand back a plaintext list of every address
-- or email that has ever attempted to sign in.
CREATE TABLE kith.auth_rate_limits (
  id kith.kith_id PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  scope text NOT NULL,
  key_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  CONSTRAINT auth_rate_limits_scope_check
    CHECK (char_length(scope) BETWEEN 1 AND 64),
  CONSTRAINT auth_rate_limits_key_hash_check
    CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_rate_limits_count_check
    CHECK (count >= 0)
);

-- One window per `(scope, key)`, the same reason the worker protocol table's
-- unique index exists: it is what makes the upsert one statement instead of a
-- read, a branch and two writes.
CREATE UNIQUE INDEX auth_rate_limits_scope_key_idx
  ON kith.auth_rate_limits (scope, key_hash);

-- The sweep's own scan order: oldest window first, bounded per pass exactly
-- like `removeExpiredWorkerProtocolState`'s tables.
CREATE INDEX auth_rate_limits_window_idx
  ON kith.auth_rate_limits (window_started_at, id);
