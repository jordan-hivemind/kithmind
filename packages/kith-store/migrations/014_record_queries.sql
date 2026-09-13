-- P2-39f5: bounded exact record queries use these ordered candidate indexes.
CREATE INDEX records_observation_entity_date_idx
  ON kith.observations
     (space_id, entity_id, observation_type, ((occurrence->>'precision')),
      occurrence_date DESC, id DESC);
CREATE INDEX records_observation_entity_instant_idx
  ON kith.observations (space_id, entity_id, observation_type, occurrence_instant DESC, id);
CREATE INDEX records_observation_entity_sort_idx
  ON kith.observations (space_id, entity_id, observation_type, occurrence_sort_key, id);
CREATE INDEX records_observation_account_sort_idx
  ON kith.observations (space_id, source_account_id, observation_type, occurrence_sort_key, id);
CREATE INDEX records_observation_entity_precision_idx
  ON kith.observations (space_id, entity_id, observation_type, ((occurrence->>'precision')), id);
CREATE INDEX records_observation_account_precision_idx
  ON kith.observations
     (space_id, source_account_id, observation_type, ((occurrence->>'precision')), id);
CREATE INDEX records_event_entity_date_idx
  ON kith.event_versions
     (space_id, entity_id, event_type, ((occurrence->>'precision')),
      occurrence_date DESC, id DESC);
CREATE INDEX records_event_entity_instant_idx
  ON kith.event_versions (space_id, entity_id, event_type, occurrence_instant DESC, id);
CREATE INDEX records_event_entity_sort_idx
  ON kith.event_versions (space_id, entity_id, event_type, occurrence_sort_key, id);
CREATE INDEX records_event_entity_precision_idx
  ON kith.event_versions (space_id, entity_id, event_type, ((occurrence->>'precision')), id);

-- Revoking a membership or credential must not be blocked by its short-lived
-- query cursors. The cursor becomes unusable and is removed with the authority.
ALTER TABLE kith.record_query_sessions
  DROP CONSTRAINT record_query_sessions_credential_id_fkey,
  ADD CONSTRAINT record_query_sessions_credential_id_fkey
    FOREIGN KEY (credential_id) REFERENCES kith.api_keys(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  DROP CONSTRAINT record_query_sessions_membership_id_fkey,
  ADD CONSTRAINT record_query_sessions_membership_id_fkey
    FOREIGN KEY (membership_id, space_id)
    REFERENCES kith.space_members(id, space_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;
