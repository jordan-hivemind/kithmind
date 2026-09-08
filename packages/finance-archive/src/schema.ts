// The archive store: one SQLite file, opened through versioned migrations.
//
// SQLite is dynamically typed, so the column types below are backed by CHECK
// constraints. Cash amounts must be INTEGER minor units and prices must be
// TEXT, which is how a REAL sneaking in from a parser is caught at write time
// rather than found later in a wrong total. Canonical spelling of a decimal is
// enforced in TypeScript (decimal.ts); SQL enforces the storage class.

import { DatabaseSync } from "node:sqlite";

export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

const INITIAL_SCHEMA = `
CREATE TABLE institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  -- Only the last four digits of an account number are ever stored.
  acct_last4 TEXT CHECK (acct_last4 IS NULL OR acct_last4 GLOB '[0-9][0-9][0-9][0-9]'),
  display_name TEXT,
  account_type TEXT,
  program TEXT,
  registration TEXT,
  owner_entity_id TEXT,
  is_pledged INTEGER NOT NULL DEFAULT 0 CHECK (is_pledged IN (0, 1)),
  base_currency TEXT NOT NULL CHECK (base_currency GLOB '[A-Z][A-Z][A-Z]'),
  opened_date TEXT CHECK (opened_date IS NULL OR opened_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  closed_date TEXT CHECK (closed_date IS NULL OR closed_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
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
  doc_date TEXT CHECK (doc_date IS NULL OR doc_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Absolute path in the local raw tree, which lives outside this repository.
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  text_path TEXT,
  parsed_ok INTEGER NOT NULL DEFAULT 0 CHECK (parsed_ok IN (0, 1)),
  notes TEXT
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  trade_date TEXT CHECK (trade_date IS NULL OR trade_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  process_date TEXT NOT NULL CHECK (process_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  settle_date TEXT CHECK (settle_date IS NULL OR settle_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  date_precision TEXT NOT NULL DEFAULT 'day' CHECK (date_precision IN ('day', 'month', 'unknown')),
  activity_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instrument_id TEXT REFERENCES instruments(id),
  quantity TEXT CHECK (typeof(quantity) IN ('text', 'null')),
  price TEXT CHECK (typeof(price) IN ('text', 'null')),
  amount INTEGER CHECK (typeof(amount) IN ('integer', 'null')),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  -- amount converted into accounts.base_currency. Unpopulated in v1.
  amount_base INTEGER CHECK (typeof(amount_base) IN ('integer', 'null')),
  fx_rate TEXT CHECK (typeof(fx_rate) IN ('text', 'null')),
  -- The rule used to derive amount_base. A stated amount never rounds.
  amount_base_rounding TEXT CHECK (amount_base_rounding IS NULL OR amount_base_rounding IN ('half_even', 'none')),
  running_balance TEXT CHECK (typeof(running_balance) IN ('text', 'null')),
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT,
  row_hash TEXT NOT NULL UNIQUE,
  provider_txn_id TEXT,
  status TEXT NOT NULL DEFAULT 'imported',
  imported_at TEXT NOT NULL
);

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of TEXT NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  instrument_id TEXT REFERENCES instruments(id),
  quantity TEXT CHECK (typeof(quantity) IN ('text', 'null')),
  price TEXT CHECK (typeof(price) IN ('text', 'null')),
  market_value INTEGER CHECK (typeof(market_value) IN ('integer', 'null')),
  cost_basis INTEGER CHECK (typeof(cost_basis) IN ('integer', 'null')),
  unrealized INTEGER CHECK (typeof(unrealized) IN ('integer', 'null')),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  -- Without this a total-assets query mixes marked securities with cost.
  valuation_basis TEXT CHECK (valuation_basis IS NULL OR valuation_basis IN ('market_price', 'last_round', 'cost', 'reported_nav')),
  valuation_note TEXT,
  source_document_id TEXT REFERENCES documents(id)
);

CREATE TABLE balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of TEXT NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  total_value INTEGER CHECK (typeof(total_value) IN ('integer', 'null')),
  cash INTEGER CHECK (typeof(cash) IN ('integer', 'null')),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  period_start_value INTEGER CHECK (typeof(period_start_value) IN ('integer', 'null')),
  period_end_value INTEGER CHECK (typeof(period_end_value) IN ('integer', 'null')),
  source_document_id TEXT REFERENCES documents(id)
);

CREATE TABLE liabilities (
  id TEXT PRIMARY KEY,
  institution_id TEXT REFERENCES institutions(id),
  account_id TEXT REFERENCES accounts(id),
  kind TEXT NOT NULL,
  display_name TEXT,
  balance INTEGER CHECK (typeof(balance) IN ('integer', 'null')),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  -- An interest rate is a rate, not an amount: canonical decimal text.
  rate TEXT CHECK (typeof(rate) IN ('text', 'null')),
  as_of TEXT NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  collateral_note TEXT,
  source_document_id TEXT REFERENCES documents(id)
);

-- A commitment is not a transaction and has no representation in a ledger.
-- Designed in now, unpopulated in v1, not retrofittable cheaply later.
CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  instrument_id TEXT REFERENCES instruments(id),
  committed INTEGER CHECK (typeof(committed) IN ('integer', 'null')),
  called INTEGER CHECK (typeof(called) IN ('integer', 'null')),
  outstanding INTEGER CHECK (typeof(outstanding) IN ('integer', 'null')),
  distributed INTEGER CHECK (typeof(distributed) IN ('integer', 'null')),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  committed_original INTEGER CHECK (typeof(committed_original) IN ('integer', 'null')),
  currency_original TEXT CHECK (currency_original IS NULL OR currency_original GLOB '[A-Z][A-Z][A-Z]'),
  fx_rate TEXT CHECK (typeof(fx_rate) IN ('text', 'null')),
  status TEXT,
  as_of TEXT NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source_document_id TEXT REFERENCES documents(id)
);

CREATE TABLE import_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source TEXT NOT NULL,
  files_seen INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  reconciliations_passed INTEGER NOT NULL DEFAULT 0,
  reconciliations_failed INTEGER NOT NULL DEFAULT 0,
  review_items INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE reconciliations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  period_start TEXT NOT NULL CHECK (period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_end TEXT NOT NULL CHECK (period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  expected_change INTEGER CHECK (typeof(expected_change) IN ('integer', 'null')),
  computed_change INTEGER CHECK (typeof(computed_change) IN ('integer', 'null')),
  delta INTEGER CHECK (typeof(delta) IN ('integer', 'null')),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  -- Minor units. The gate tolerance is exact zero; the value is recorded per
  -- period so a passing period says what it was allowed.
  tolerance INTEGER NOT NULL DEFAULT 0 CHECK (typeof(tolerance) = 'integer' AND tolerance >= 0),
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
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_at TEXT,
  resolution_note TEXT
);

CREATE INDEX transactions_account_process_date ON transactions (account_id, process_date);
CREATE INDEX transactions_provider_txn_id ON transactions (account_id, provider_txn_id);
CREATE INDEX transactions_source_document ON transactions (source_document_id);
CREATE INDEX positions_account_as_of ON positions (account_id, as_of);
CREATE INDEX balances_account_as_of ON balances (account_id, as_of);
CREATE INDEX reconciliations_account_period ON reconciliations (account_id, period_start, period_end);
CREATE INDEX review_items_status ON review_items (status, kind);
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: "initial archive schema", sql: INITIAL_SCHEMA },
]);

export const ARCHIVE_SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.version ?? 0;

/** Reads the version recorded in the file itself. A fresh file reports 0. */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Applies every migration the file has not seen and records the new version in
 * the file. Running it again is a no-op, which is what makes rebuilding the
 * archive from the raw tree a routine operation rather than an event.
 */
export function migrate(db: DatabaseSync): number {
  let current = schemaVersion(db);
  if (current > ARCHIVE_SCHEMA_VERSION) {
    throw new Error(
      `archive is at schema ${current}, newer than this build understands (${ARCHIVE_SCHEMA_VERSION})`,
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    current = migration.version;
  }
  return current;
}

/**
 * Opens the archive file and brings it to the current schema. The path is a
 * local directory outside this repository; it is never a repository path and
 * never a shared folder.
 */
export function openArchive(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}
