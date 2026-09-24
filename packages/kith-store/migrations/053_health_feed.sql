-- Epic MyChart feed: one FHIR authorization per person and the structured
-- records `kith-epic-feed pull` writes from it. See
-- docs/plans/2026-09-22-simplification-and-feeds.md, order of work items 4
-- and 5, and the people/vehicle profiles work (migration 039) whose
-- `kith.entities` rows this feed's `person_id` points at.
--
-- Every household member authorizes separately (the owner directly, family
-- members through the owner's own MyChart proxy access), so `health_sources`
-- is one row per (person, health system) rather than one row per household --
-- the same "every record carries the person it belongs to" rule the
-- simplification plan states for both finance and health.
--
-- `person_id` and `space_id` together are a composite foreign key into
-- `kith.entities (id, space_id)`, the same shape migration 004's
-- `person_entity_id`/`space_id` pair already uses on
-- `user_space_settings`: a plain `person_id -> entities.id` reference would
-- still be correct (entities.id is already a primary key on its own), but
-- carrying `space_id` alongside it here means a reader never has to join
-- `entities` just to learn which space's membership authorizes a look at
-- this person's health data -- the same reasoning `kith.fin_accounts`
-- avoids a join for its own owner-global reads, just scoped to a space
-- instead of being owner-global outright.
--
-- No triggers, no change-feed rows: matching the Plaid feed (migration 043),
-- a row is upserted from what Epic reports on each pull and `raw` jsonb is
-- the audit trail.
--
-- Every table carries a `kith.kith_id` primary key (migration 003's
-- convention, restated in migration 043's own note): the natural FHIR id is
-- a separate `NOT NULL` column, unique together with its owning source and
-- resource type, so a foreign key can still target it exactly the way a
-- primary key would.

CREATE TABLE kith.health_sources (
  id kith.kith_id PRIMARY KEY,
  person_id kith.kith_id NOT NULL,
  space_id kith.kith_id NOT NULL,
  org_name text NOT NULL CHECK (char_length(org_name) BETWEEN 1 AND 300),
  fhir_base text NOT NULL CHECK (char_length(fhir_base) BETWEEN 1 AND 2000),
  patient_fhir_id text NOT NULL
    CHECK (char_length(patient_fhir_id) BETWEEN 1 AND 200),
  -- The macOS Keychain service name the tokens live under
  -- (`com.kithmind.epic.token.<person-slug>`). No token is ever stored here.
  keychain_service text NOT NULL
    CHECK (char_length(keychain_service) BETWEEN 1 AND 200),
  -- Space-separated SMART v1 scope string the authorization actually
  -- granted, kept for audit (Epic can grant a subset of what was requested).
  scopes text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  last_pulled_at timestamptz,
  last_pull_error text,
  -- Set when a refresh gets `invalid_grant` and cleared the next time a pull
  -- for this source succeeds. `pull` reports this rather than looping on a
  -- dead refresh token: only the owner can complete a new `authorize`.
  needs_reauth_at timestamptz,
  UNIQUE (person_id, fhir_base),
  FOREIGN KEY (person_id, space_id)
    REFERENCES kith.entities (id, space_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX health_sources_person_idx ON kith.health_sources (person_id);

CREATE TABLE kith.health_records (
  id kith.kith_id PRIMARY KEY,
  source_id kith.kith_id NOT NULL
    REFERENCES kith.health_sources (id) ON DELETE CASCADE,
  -- Denormalized from `health_sources.person_id` so every record carries the
  -- person it belongs to directly, per the simplification plan's rule, and
  -- so `listHealthRecords`/`listHealthOverview` never need to join back to
  -- `health_sources` for the one column every one of their reads filters on.
  person_id kith.kith_id NOT NULL,
  resource_type text NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 50),
  fhir_id text NOT NULL CHECK (char_length(fhir_id) BETWEEN 1 AND 200),
  effective_at timestamptz,
  status text CHECK (status IS NULL OR char_length(status) BETWEEN 1 AND 50),
  code_display text
    CHECK (code_display IS NULL OR char_length(code_display) BETWEEN 1 AND 500),
  value_text text,
  value_number numeric,
  value_unit text CHECK (value_unit IS NULL OR char_length(value_unit) BETWEEN 1 AND 50),
  category text CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 100),
  encounter_fhir_id text
    CHECK (encounter_fhir_id IS NULL OR char_length(encounter_fhir_id) BETWEEN 1 AND 200),
  raw jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (source_id, resource_type, fhir_id)
);

CREATE INDEX health_records_person_type_idx
  ON kith.health_records (person_id, resource_type, effective_at DESC);

-- `DocumentReference`'s `Binary` attachment, fetched only when the content
-- type is text, HTML, RTF or PDF. Text and HTML get `text` extracted; a PDF
-- is stored to a folder under the user's data directory and only its path is
-- recorded here (`storage_note`) -- no text extraction yet, per the task.
CREATE TABLE kith.health_documents (
  id kith.kith_id PRIMARY KEY,
  record_id kith.kith_id NOT NULL
    REFERENCES kith.health_records (id) ON DELETE CASCADE,
  person_id kith.kith_id NOT NULL,
  content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 200),
  byte_length integer NOT NULL CHECK (byte_length >= 0),
  text text,
  storage_note text
    CHECK (storage_note IS NULL OR char_length(storage_note) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (record_id)
);

CREATE INDEX health_documents_person_idx
  ON kith.health_documents (person_id, record_id);
