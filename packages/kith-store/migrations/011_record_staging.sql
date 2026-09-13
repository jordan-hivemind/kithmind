-- P2-39f2: bounded record staging looks up stable identities while holding the
-- source-item lock, and validates all rows for one processing generation.
-- These remain nonunique because the runtime validator reports legacy or
-- malformed duplicate identities instead of making migration 011 a backfill.

CREATE INDEX records_event_item_key_idx
  ON kith.events (source_item_id, event_key, id);

CREATE INDEX records_event_version_identity_idx
  ON kith.event_versions (event_id, processing_generation_id, id);
CREATE INDEX records_event_version_generation_idx
  ON kith.event_versions (processing_generation_id, id);

CREATE INDEX records_observation_identity_idx
  ON kith.observations
     (event_id, observation_key, processing_generation_id, id);
CREATE INDEX records_observation_generation_idx
  ON kith.observations (processing_generation_id, id);
