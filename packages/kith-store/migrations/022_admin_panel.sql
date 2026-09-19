-- ADM-1: the eight tables section 5 of
-- docs/plans/2026-09-18-admin-panel-and-ingestion.md adds, less `changes`,
-- which is its own migration (023) because it is the change feed rather than
-- part of the data model.
--
-- Every table here follows the conventions the migrated set already fixed:
-- a `kith.kith_id` primary key (migration 003), a `space_id` that is a real
-- foreign key to `kith.spaces`, a `created_at` with a transaction-timestamp
-- default, and the composite `UNIQUE (id, space_id)` migration 004's generator
-- put on every space-scoped table. The composite unique is what lets the
-- cross-table references below be composite foreign keys, which is how a
-- reference into another space becomes unrepresentable rather than merely
-- unqueried (see src/spaces.ts).
--
-- Money is `numeric` with migration 001's guards (`kith.synthetic_financial_
-- attachments`, the only other money column in this schema) plus an ISO 4217
-- `currency`. node-pg returns `numeric` as a string, so a read never passes an
-- amount through a float; that is the same exact-decimal-text representation
-- `src/records/values.ts` canonicalizes money into.

-- ---------------------------------------------------------------------------
-- Document types and their fields.
--
-- "Editing creates a new version": the unique index is over
-- (space, kind, version), so a new version is a new row and the old row stays
-- readable by whatever recorded that it extracted against it.
-- ---------------------------------------------------------------------------

CREATE TABLE kith.document_types (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 100),
  description text,
  area text CHECK (area IS NULL OR char_length(area) BETWEEN 1 AND 100),
  guidance text,
  examples jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(examples) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (id, space_id)
);

CREATE UNIQUE INDEX document_types_kind_version_idx
  ON kith.document_types (space_id, kind, version);

CREATE TABLE kith.document_type_fields (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  document_type_id kith.kith_id NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- Section 5's closed list of value types. A check rather than free text for
  -- the reason migration 017 gives `deferred_work.kind`: a typo must fail the
  -- INSERT, not sit in a row nothing knows how to check.
  value_type text NOT NULL CHECK (value_type IN (
    'text', 'organization', 'person', 'date', 'money', 'number',
    'identifier', 'line_item_list')),
  required boolean NOT NULL DEFAULT false,
  -- Section 8: "Checks are per value type, not per kind." Null means the value
  -- type's own default check and nothing more.
  check_kind text CHECK (check_kind IN ('on_page', 'exact', 'sums_to_total')),
  example text,
  UNIQUE (id, space_id),
  FOREIGN KEY (document_type_id, space_id)
    REFERENCES kith.document_types (id, space_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX document_type_fields_name_idx
  ON kith.document_type_fields (document_type_id, name);

-- ---------------------------------------------------------------------------
-- Source roots: the desired list the watcher pulls each pass, and what the
-- watcher host reports back about each one.
--
-- One root per source account (the unique index below). A source account today
-- is one watched folder, institution or manual source, so the two are the same
-- thing seen from the two sides -- the account is what the worker protocol
-- already keys scans and items by, and the root is the configuration the
-- account never had. Splitting them would mean deciding which root a
-- `source_items` row belongs to, and nothing asks that question yet.
-- ---------------------------------------------------------------------------

CREATE TABLE kith.source_roots (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  source_account_id kith.kith_id NOT NULL,
  kind text NOT NULL CHECK (kind IN ('folder', 'institution', 'manual')),
  -- Section 6: the source is keyed by the provider's folder id, and the path
  -- is what the watcher re-resolves and rewrites each pass. So the id is the
  -- identity and the path is a cache, not the other way round.
  provider_folder_id text,
  last_known_path text,
  expected_types jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(expected_types) = 'array'),
  area text CHECK (area IS NULL OR char_length(area) BETWEEN 1 AND 100),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'paused', 'problem', 'retired')),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (id, space_id),
  FOREIGN KEY (source_account_id, space_id)
    REFERENCES kith.source_accounts (id, space_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX source_roots_source_account_idx
  ON kith.source_roots (source_account_id);

CREATE TABLE kith.source_root_reports (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  source_root_id kith.kith_id NOT NULL,
  watcher_id text,
  observed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  available_folders jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(available_folders) = 'array'),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  -- `[{ "path": ..., "reason": ... }]`. Shape is the writer's, not the
  -- schema's: the UI renders a count and a tooltip, and the watcher is the
  -- only writer.
  skipped jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(skipped) = 'array'),
  problem text,
  UNIQUE (id, space_id),
  FOREIGN KEY (source_root_id, space_id)
    REFERENCES kith.source_roots (id, space_id) ON DELETE CASCADE
);

-- One report per root per pass, so the sources screen's "latest report" read is
-- a single index lookup rather than a sort over the history.
CREATE UNIQUE INDEX source_root_reports_latest_idx
  ON kith.source_root_reports (source_root_id, observed_at DESC, id);

-- ---------------------------------------------------------------------------
-- Investments and their entries. Totals are computed, never stored
-- (section 5), so there is no committed/sent/outstanding column anywhere here.
-- ---------------------------------------------------------------------------

CREATE TABLE kith.investments (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  -- Section 8: "Names are stored as written and bound to entities later", so
  -- the name is the row's own and the entity reference is optional.
  entity_id kith.kith_id,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  category text CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 100),
  signed_on date,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed', 'written_off')),
  notes text,
  UNIQUE (id, space_id),
  FOREIGN KEY (entity_id, space_id)
    REFERENCES kith.entities (id, space_id) ON DELETE SET NULL
);

CREATE INDEX investments_space_idx ON kith.investments (space_id, name, id);

CREATE TABLE kith.investment_entries (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  investment_id kith.kith_id NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN (
    'capital_call_paid', 'distribution', 'commitment', 'commitment_change',
    'fee', 'write_off', 'other')),
  entry_date date NOT NULL,
  -- Migration 001's money guards, verbatim: no NaN or infinity, at most 18
  -- decimal places, at most 38 significant digits.
  amount numeric NOT NULL CHECK (
    amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    AND abs(amount) < 100000000000000000000000000000000000000::numeric
    AND scale(amount) <= 18
    AND length(replace(trim_scale(abs(amount))::text, '.', '')) <= 38
  ),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  note text,
  document_id kith.kith_id,
  evidence_span_id kith.kith_id,
  UNIQUE (id, space_id),
  FOREIGN KEY (investment_id, space_id)
    REFERENCES kith.investments (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, space_id)
    REFERENCES kith.documents (id, space_id) ON DELETE SET NULL,
  FOREIGN KEY (evidence_span_id, space_id)
    REFERENCES kith.evidence_spans (id, space_id) ON DELETE SET NULL
);

-- The expandable-rows read on the investments screen: one investment's entries
-- in date order.
CREATE INDEX investment_entries_investment_idx
  ON kith.investment_entries (investment_id, entry_date, id);

-- ---------------------------------------------------------------------------
-- Corrections: "The original reading is kept. Reads prefer the correction."
-- ---------------------------------------------------------------------------

CREATE TABLE kith.corrections (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  target_kind text NOT NULL CHECK (target_kind IN ('document', 'field', 'record')),
  -- Deliberately `text` and not `kith.kith_id`: a field target names a document
  -- and a field, and a record target may name an observation the extraction
  -- writer has not minted yet. `field_name` carries the second half.
  target_id text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 512),
  field_name text,
  original_value jsonb,
  corrected_value jsonb,
  actor_user_id kith.kith_id REFERENCES kith.users (id) ON DELETE SET NULL,
  reason text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  resolved_at timestamptz,
  CONSTRAINT corrections_resolved_check
    CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
  UNIQUE (id, space_id)
);

-- The corrections screen: open items first, newest first.
CREATE INDEX corrections_state_idx
  ON kith.corrections (space_id, state, created_at DESC, id);

CREATE INDEX corrections_target_idx
  ON kith.corrections (space_id, target_kind, target_id);
