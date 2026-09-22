-- PLAID-1: a daily Plaid feed for current balances and holdings across the
-- owner's linked institutions (Morgan Stanley, Vanguard, Fidelity, Chase).
-- See docs/plans/2026-09-22-simplification-and-feeds.md, order of work item 1.
--
-- Owner-global, matching every existing finance table: the finance archive's
-- own `accounts`/`institutions` carry no `space_id` (one archive per
-- household), and `kith.finance_account_overrides` is the one space-scoped
-- exception because it holds the owner's own edits, not archive data. This
-- feed is likewise one household's own linked accounts, so no `space_id`.
--
-- No triggers, no change-feed rows, no immutable generations, no receipts:
-- the simplification plan retired that machinery for the feed path. A row is
-- upserted from what Plaid reports on each pull; its own `raw` jsonb is the
-- audit trail.
--
-- Primary keys are Plaid's own opaque ids (`item_id`, `account_id`,
-- `security_id`, `transaction_id`, `investment_transaction_id`) rather than
-- `kith.kith_id`: they are already globally unique and stable across pulls,
-- and using them directly is what makes every write here an idempotent
-- upsert. Only the two snapshot tables mint their own id, because a snapshot
-- is an event (one row per account per day) rather than an entity Plaid
-- names.
--
-- `limit` is a reserved word in PostgreSQL (the `LIMIT` clause), so the
-- balance field the task and the Plaid API call "limit" is `limit_amount`
-- here.

CREATE TABLE kith.plaid_items (
  item_id text PRIMARY KEY CHECK (char_length(item_id) BETWEEN 1 AND 200),
  institution_id text NOT NULL
    CHECK (char_length(institution_id) BETWEEN 1 AND 200),
  institution_name text NOT NULL
    CHECK (char_length(institution_name) BETWEEN 1 AND 200),
  -- The macOS Keychain service name the access token lives under
  -- (`com.kithmind.plaid.item.<institution_slug>`). The token itself is
  -- never stored in this database.
  keychain_service text NOT NULL
    CHECK (char_length(keychain_service) BETWEEN 1 AND 200),
  linked_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  -- `/transactions/sync`'s cursor, persisted per item so a pull only asks
  -- Plaid for what changed since the last one.
  transactions_cursor text,
  last_pulled_at timestamptz,
  last_pull_error text,
  -- Set when a pull gets `ITEM_LOGIN_REQUIRED` and cleared the next time a
  -- pull for this item succeeds. `pull` reports this rather than retrying
  -- Link on its own: only the owner can complete re-authentication.
  needs_relink_at timestamptz
);

CREATE TABLE kith.plaid_accounts (
  account_id text PRIMARY KEY CHECK (char_length(account_id) BETWEEN 1 AND 200),
  item_id text NOT NULL
    REFERENCES kith.plaid_items (item_id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  official_name text CHECK (
    official_name IS NULL OR char_length(official_name) BETWEEN 1 AND 300
  ),
  mask text CHECK (mask IS NULL OR char_length(mask) BETWEEN 1 AND 20),
  type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 50),
  subtype text CHECK (subtype IS NULL OR char_length(subtype) BETWEEN 1 AND 50),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX plaid_accounts_item_idx ON kith.plaid_accounts (item_id);

-- A small cache of security metadata (`/investments/holdings/get`'s
-- `securities` array), keyed by Plaid's own id so a holding snapshot can
-- name what it is a holding of without repeating the security's name and
-- ticker on every row.
CREATE TABLE kith.plaid_securities (
  security_id text PRIMARY KEY
    CHECK (char_length(security_id) BETWEEN 1 AND 200),
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 300),
  ticker_symbol text
    CHECK (ticker_symbol IS NULL OR char_length(ticker_symbol) BETWEEN 1 AND 50),
  type text CHECK (type IS NULL OR char_length(type) BETWEEN 1 AND 50),
  close_price numeric,
  close_price_as_of date,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE kith.plaid_balance_snapshots (
  id kith.kith_id PRIMARY KEY,
  account_id text NOT NULL
    REFERENCES kith.plaid_accounts (account_id) ON DELETE CASCADE,
  as_of date NOT NULL,
  current numeric,
  available numeric,
  limit_amount numeric,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (account_id, as_of)
);

CREATE INDEX plaid_balance_snapshots_account_idx
  ON kith.plaid_balance_snapshots (account_id, as_of DESC);

CREATE TABLE kith.plaid_holding_snapshots (
  id kith.kith_id PRIMARY KEY,
  account_id text NOT NULL
    REFERENCES kith.plaid_accounts (account_id) ON DELETE CASCADE,
  security_id text NOT NULL REFERENCES kith.plaid_securities (security_id),
  as_of date NOT NULL,
  quantity numeric,
  price numeric,
  value numeric,
  cost_basis numeric,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (account_id, security_id, as_of)
);

CREATE INDEX plaid_holding_snapshots_account_idx
  ON kith.plaid_holding_snapshots (account_id, as_of DESC);

CREATE TABLE kith.plaid_transactions (
  transaction_id text PRIMARY KEY
    CHECK (char_length(transaction_id) BETWEEN 1 AND 200),
  account_id text NOT NULL
    REFERENCES kith.plaid_accounts (account_id) ON DELETE CASCADE,
  item_id text NOT NULL
    REFERENCES kith.plaid_items (item_id) ON DELETE CASCADE,
  date date,
  authorized_date date,
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 300),
  merchant_name text
    CHECK (merchant_name IS NULL OR char_length(merchant_name) BETWEEN 1 AND 300),
  amount numeric,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  pending boolean NOT NULL DEFAULT false,
  category text,
  -- `/transactions/sync`'s `removed` list marks a transaction gone rather
  -- than deleting the row, so a day's count stays explainable.
  removed_at timestamptz,
  raw jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX plaid_transactions_account_idx
  ON kith.plaid_transactions (account_id, date DESC);

CREATE TABLE kith.plaid_investment_transactions (
  investment_transaction_id text PRIMARY KEY
    CHECK (char_length(investment_transaction_id) BETWEEN 1 AND 200),
  account_id text NOT NULL
    REFERENCES kith.plaid_accounts (account_id) ON DELETE CASCADE,
  item_id text NOT NULL
    REFERENCES kith.plaid_items (item_id) ON DELETE CASCADE,
  security_id text REFERENCES kith.plaid_securities (security_id),
  date date NOT NULL,
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 300),
  quantity numeric,
  price numeric,
  amount numeric,
  fees numeric,
  type text CHECK (type IS NULL OR char_length(type) BETWEEN 1 AND 50),
  subtype text CHECK (subtype IS NULL OR char_length(subtype) BETWEEN 1 AND 50),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  raw jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX plaid_investment_transactions_account_idx
  ON kith.plaid_investment_transactions (account_id, date DESC);
