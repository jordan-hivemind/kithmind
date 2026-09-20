-- ADM-10 review, finding 1: telling two live hosts apart again.
--
-- The watcher identity used to hash the configuration fingerprint, which
-- included the watched roots with their absolute paths. Two hosts running the
-- same copied journal therefore almost always disagreed about something and
-- registered as two watchers, and the second one was refused. That was never
-- the point of the check, but it was a tripwire, and deriving the identity
-- from the salt and the authority binding alone removes it: a copied journal
-- is deliberately the same watcher now, which is what makes a host move work
-- and what makes two hosts on one copied journal indistinguishable.
--
-- Nothing else on the heartbeat separates them. `connector_version` is a
-- compile-time constant, `actor_credential_id` is the same key, and
-- `received_at` is clamped to `max(now, last_seen_at)`. The owner is about to
-- copy a journal from a laptop to an always-on host, and the journal lock is a
-- loopback port that does not coordinate across machines, so "never run both"
-- is enforced by nothing.
--
-- So the worker sends a per-process random nonce and the server keeps the last
-- two it accepted. Two, not a counter and not a window: nonces are 128 bits of
-- randomness minted once per process, so a nonce can only *recur* if a process
-- that already heartbeated heartbeats again after a different one did. That is
-- exactly two live processes and it is never a restart -- a restart mints a
-- fresh nonce and never comes back, and so does a crash loop, which is why a
-- count of changes would have confused the two and a returning nonce cannot.
-- Detection lands on the third ping of an alternating pair.
--
-- Three nullable columns on `worker_watcher_states` rather than a table or an
-- incident row. The row is already one per source account, already LEFT JOINed
-- by `src/admin/health.ts`, and already carries migration 023's
-- `record_change` trigger, so the health screen updates live with no new
-- trigger. `worker_operational_incidents` was the other candidate and does not
-- fit: its `kind` CHECK admits only `missing_worker`, its unique index allows
-- one open incident per source account whatever the kind, and a heartbeat
-- resolves the open incident -- which is every heartbeat here, since a
-- split-brain watcher is by definition still heartbeating. Bending all three
-- would have touched five call sites to store one timestamp.
--
-- `split_brain_at` is a timestamp and not a flag so it can go stale on its own
-- once one host is stopped: see WATCHER_SPLIT_BRAIN_QUIET_MS in
-- `src/workers/diagnostics.ts`. Heartbeats keep being accepted throughout.
-- Refusing one of the two hosts would put the watcher straight back into the
-- state this whole task exists to remove, and would hide the second host
-- rather than name it.

ALTER TABLE kith.worker_watcher_states
  ADD COLUMN heartbeat_nonce text
    CHECK (heartbeat_nonce IS NULL OR heartbeat_nonce ~ '^[0-9a-f]{32}$'),
  ADD COLUMN heartbeat_nonce_previous text
    CHECK (heartbeat_nonce_previous IS NULL
           OR heartbeat_nonce_previous ~ '^[0-9a-f]{32}$'),
  ADD COLUMN split_brain_at timestamptz;

-- The previous nonce is only meaningful behind a current one, and the two are
-- never equal: the writer shifts on a change and leaves both alone otherwise,
-- so equal values would mean a half-applied update. A watcher that has never
-- sent a nonce (an ADM-9 worker against this server) carries neither.
ALTER TABLE kith.worker_watcher_states
  -- Not `..._heartbeat_nonce_check`: Postgres already auto-named the inline
  -- column CHECK above exactly that.
  ADD CONSTRAINT worker_watcher_states_nonce_pair_check
    CHECK ((heartbeat_nonce IS NOT NULL OR heartbeat_nonce_previous IS NULL)
           AND (heartbeat_nonce_previous IS NULL
                OR heartbeat_nonce <> heartbeat_nonce_previous));
