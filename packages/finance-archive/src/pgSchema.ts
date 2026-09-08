// The archive schema on Postgres: one initial schema, not a translation of
// three SQLite migrations. There is no data behind the SQLite migrations, and
// that is the whole reason the engine changes now rather than later, so their
// history collapses into a single CREATE.
//
// What changes from the SQLite schema, and why:
//
//   - Cash amounts stop being INTEGER minor units and quantities stop being
//     canonical decimal TEXT. Both become NUMERIC, which is exact and sums
//     exactly, so the conversion boundary between the two representations
//     disappears along with the class of bugs that lived on it.
//   - NUMERIC is declared with no precision or scale. NUMERIC(38, 18) would
//     round a more precise value into place on insert; the boundary contract
//     is enforced on the way in instead (see pgNumeric.ts), where exceeding
//     it is an explicit rejection rather than a silent rounding.
//   - The CHECK (typeof(...)) constraints do not translate, because Postgres
//     types already cover storage class. Their intent moves to input
//     validation in pgNumeric.ts. Postgres will happily store a value that
//     was already a float before it arrived, so the check had to move rather
//     than be dropped.
//   - Dates become DATE and timestamps TIMESTAMPTZ, so the GLOB spelling
//     checks are unnecessary. Booleans become BOOLEAN.
//
// What deliberately does not change: every money column carries its currency
// and no total ever crosses currencies; positions carry valuation_basis and
// valuation_note; commitments is designed in and unpopulated; every derived
// row carries source_document_id and source_locator; acct_last4 is exactly
// four digits; row_hash is UNIQUE; identities stay stable opaque text.

import type pg from "pg";

/** Bumped when INITIAL_SCHEMA changes. Recorded in `schema_version`. */
export const PG_SCHEMA_VERSION = 1;
const PG_SCHEMA_NAME = "initial postgres archive schema";

/** Key for the advisory lock two concurrent creators contend on. */
const SCHEMA_LOCK_KEY = 4_119_205_001;

const INITIAL_SCHEMA = `
-- Every money, quantity, price and rate column. The domain is where the
-- non-finite rejection lives: Postgres NUMERIC has its own NaN, and
-- 'NaN'::numeric = 'NaN'::numeric is true, so the guard is an inequality.
CREATE DOMAIN finance_numeric AS NUMERIC
  CHECK (VALUE IS NULL OR VALUE <> 'NaN'::numeric);

CREATE DOMAIN currency_code AS TEXT
  CHECK (VALUE IS NULL OR VALUE ~ '^[A-Z]{3}$');

CREATE TABLE institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  -- Only the last four digits of an account number are ever stored.
  acct_last4 TEXT CHECK (acct_last4 IS NULL OR acct_last4 ~ '^[0-9]{4}$'),
  display_name TEXT,
  account_type TEXT,
  program TEXT,
  registration TEXT,
  owner_entity_id TEXT,
  is_pledged BOOLEAN NOT NULL DEFAULT FALSE,
  base_currency currency_code NOT NULL,
  opened_date DATE,
  closed_date DATE,
  notes TEXT
);

CREATE TABLE instruments (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  cusip TEXT,
  isin TEXT,
  name TEXT,
  instrument_kind TEXT,
  asset_class TEXT,
  issuer_note TEXT
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  institution_id TEXT REFERENCES institutions(id),
  account_id TEXT REFERENCES accounts(id),
  doc_type TEXT NOT NULL,
  doc_date DATE,
  -- Path in the raw tree, which lives outside this repository.
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  text_path TEXT,
  parsed_ok BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  trade_date DATE,
  process_date DATE NOT NULL,
  settle_date DATE,
  date_precision TEXT NOT NULL DEFAULT 'day'
    CHECK (date_precision IN ('day', 'month', 'unknown')),
  activity_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instrument_id TEXT REFERENCES instruments(id),
  quantity finance_numeric,
  price finance_numeric,
  amount finance_numeric,
  currency currency_code NOT NULL,
  -- amount converted into accounts.base_currency. Unpopulated in v1.
  amount_base finance_numeric,
  fx_rate finance_numeric,
  -- The rule used to derive amount_base. A stated amount never rounds.
  amount_base_rounding TEXT
    CHECK (amount_base_rounding IS NULL OR amount_base_rounding IN ('half_even', 'none')),
  running_balance finance_numeric,
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT,
  row_hash TEXT NOT NULL UNIQUE,
  provider_txn_id TEXT,
  status TEXT NOT NULL DEFAULT 'imported',
  imported_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of DATE NOT NULL,
  instrument_id TEXT REFERENCES instruments(id),
  quantity finance_numeric,
  price finance_numeric,
  market_value finance_numeric,
  cost_basis finance_numeric,
  unrealized finance_numeric,
  currency currency_code NOT NULL,
  -- Without this a total-assets query mixes marked securities with cost.
  valuation_basis TEXT CHECK (valuation_basis IS NULL
    OR valuation_basis IN ('market_price', 'last_round', 'cost', 'reported_nav')),
  valuation_note TEXT,
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT
);

CREATE TABLE balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of DATE NOT NULL,
  total_value finance_numeric,
  cash finance_numeric,
  currency currency_code NOT NULL,
  period_start_value finance_numeric,
  period_end_value finance_numeric,
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT
);

CREATE TABLE liabilities (
  id TEXT PRIMARY KEY,
  institution_id TEXT REFERENCES institutions(id),
  account_id TEXT REFERENCES accounts(id),
  kind TEXT NOT NULL,
  display_name TEXT,
  balance finance_numeric,
  currency currency_code NOT NULL,
  rate finance_numeric,
  as_of DATE NOT NULL,
  collateral_note TEXT,
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT
);

-- A commitment is not a transaction and has no representation in a ledger.
-- Designed in now, unpopulated in v1, not retrofittable cheaply later.
CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  instrument_id TEXT REFERENCES instruments(id),
  committed finance_numeric,
  called finance_numeric,
  outstanding finance_numeric,
  distributed finance_numeric,
  currency currency_code NOT NULL,
  committed_original finance_numeric,
  currency_original currency_code,
  fx_rate finance_numeric,
  status TEXT,
  as_of DATE NOT NULL,
  source_document_id TEXT REFERENCES documents(id)
);

CREATE TABLE import_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  source TEXT NOT NULL,
  files_seen BIGINT NOT NULL DEFAULT 0,
  rows_inserted BIGINT NOT NULL DEFAULT 0,
  rows_skipped BIGINT NOT NULL DEFAULT 0,
  reconciliations_passed BIGINT NOT NULL DEFAULT 0,
  reconciliations_failed BIGINT NOT NULL DEFAULT 0,
  review_items BIGINT NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE reconciliations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  expected_change finance_numeric,
  computed_change finance_numeric,
  delta finance_numeric,
  currency currency_code NOT NULL,
  -- The gate tolerance is exact zero; the value is recorded per period so a
  -- passing period says what it was allowed.
  tolerance finance_numeric NOT NULL DEFAULT 0 CHECK (tolerance >= 0),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unverified')),
  notes TEXT
);

-- The position quantity gate is per account, per instrument, per period, and
-- reconciliations is per account and period with no instrument. It keeps its
-- own table: a cash verdict and a position verdict must stay distinguishable,
-- or every existing query for unverified periods silently starts returning
-- per-instrument rows. (Under SQLite the tables were also separated by
-- storage class. That reason is gone here; the query one is not.)
CREATE TABLE position_reconciliations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  expected_change finance_numeric,
  computed_change finance_numeric,
  delta finance_numeric,
  tolerance finance_numeric NOT NULL DEFAULT 0 CHECK (tolerance >= 0),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unverified')),
  notes TEXT
);

CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT,
  raw_value TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT
);

CREATE INDEX transactions_account_process_date ON transactions (account_id, process_date);
CREATE INDEX transactions_provider_txn_id ON transactions (account_id, provider_txn_id);
CREATE INDEX transactions_source_document ON transactions (source_document_id);
CREATE INDEX positions_account_as_of ON positions (account_id, as_of);
CREATE INDEX balances_account_as_of ON balances (account_id, as_of);
CREATE INDEX reconciliations_account_period ON reconciliations (account_id, period_start, period_end);
CREATE INDEX position_reconciliations_account_period
  ON position_reconciliations (account_id, instrument_id, period_start, period_end);
CREATE INDEX review_items_status ON review_items (status, kind);
`;

/** Every table the schema creates, in creation order. */
export const PG_TABLES: readonly string[] = Object.freeze([
  "institutions",
  "accounts",
  "instruments",
  "documents",
  "transactions",
  "positions",
  "balances",
  "liabilities",
  "commitments",
  "import_runs",
  "reconciliations",
  "position_reconciliations",
  "review_items",
]);

/** The recorded version of the schema in a database, or 0 for an empty one. */
export async function pgSchemaVersion(client: pg.ClientBase): Promise<number> {
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass('schema_version') IS NOT NULL AS present",
  );
  if (!present.rows[0]?.present) return 0;
  const result = await client.query<{ version: string | null }>(
    "SELECT max(version)::text AS version FROM schema_version",
  );
  return Number(result.rows[0]?.version ?? 0);
}

/**
 * Creates the schema in the connected search_path and records the applied
 * version. Running it again is a no-op returning the recorded version, which
 * is what makes rebuilding the archive from the raw tree routine rather than
 * an event.
 *
 * The whole thing is one transaction, and a session-scoped advisory lock
 * excludes a second creator by the database rather than by everyone
 * remembering that only one machine imports.
 */
export async function applyPgSchema(client: pg.ClientBase): Promise<number> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const current = await pgSchemaVersion(client);
    if (current > PG_SCHEMA_VERSION) {
      throw new Error(
        `archive is at schema ${current}, newer than this build understands (${PG_SCHEMA_VERSION})`,
      );
    }
    if (current < PG_SCHEMA_VERSION) {
      await client.query(INITIAL_SCHEMA);
      await client.query(
        "INSERT INTO schema_version (version, name) VALUES ($1, $2)",
        [PG_SCHEMA_VERSION, PG_SCHEMA_NAME],
      );
    }
    await client.query("COMMIT");
    return PG_SCHEMA_VERSION;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
