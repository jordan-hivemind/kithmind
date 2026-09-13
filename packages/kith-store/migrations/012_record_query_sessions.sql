-- P2-39f4: query snapshot and cursor lookups. These indexes intentionally
-- remain nonunique so the runtime can detect and refuse legacy duplicate state.

CREATE INDEX record_query_space_state_lookup_idx
  ON kith.record_query_space_state (space_id, created_at, id);

CREATE INDEX record_query_sessions_active_idx
  ON kith.record_query_sessions (user_id, space_id, expires_at, id);

CREATE INDEX record_query_sessions_visibility_idx
  ON kith.record_query_sessions
     (space_id, visibility_epoch, expires_at, id);
