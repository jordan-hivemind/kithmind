-- FIN-1: one physical ledger over the archive (statement-derived, Morgan
-- Stanley only, `finance.transactions` 2020 to present) and the Plaid feed
-- (`kith.plaid_*`, all institutions, 24 months back and daily going
-- forward). See docs/plans/2026-09-22-simplification-and-feeds.md.
--
-- The owner does not want two ledgers to query separately. Rather than a view
-- joining the archive and the feed at read time, this migration replaces the
-- Plaid-only tables migration 043_plaid_feed.sql created with a single set of
-- `kith.fin_*` tables that hold rows from either source, tagged `source`
-- (`archive` or `plaid`) and deduplicated by `(source, source_ref)`.
--
-- `kith.plaid_items` is kept as-is: it is item state (the access-token
-- Keychain pointer, the transactions-sync cursor, the investment-transaction
-- watermark, needs_relink_at), not ledger data, and `pull` still needs it to
-- talk to Plaid per item.
--
-- `kith.plaid_accounts`, `plaid_securities`, `plaid_balance_snapshots`,
-- `plaid_holding_snapshots`, `plaid_transactions` and
-- `plaid_investment_transactions` are retired. Production has at most three
-- days of them (PLAID-1 shipped 2026-09-22), so this migration copies what
-- is there into the new tables rather than requiring a re-pull, then drops
-- the old tables outright.
--
-- `fin_accounts.plaid_item_id` is not in the owner's original column list
-- for this table, but is added anyway: `plaid_accounts.item_id` was the only
-- way to find an account's item (for `needs_relink_at`, which the Balances
-- screen already shows), and that mapping is lost once `plaid_accounts` is
-- dropped unless it is carried forward.

CREATE TABLE kith.fin_accounts (
  id kith.kith_id PRIMARY KEY,
  institution_name text NOT NULL
    CHECK (char_length(institution_name) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  official_name text CHECK (
    official_name IS NULL OR char_length(official_name) BETWEEN 1 AND 300
  ),
  mask text CHECK (mask IS NULL OR char_length(mask) BETWEEN 1 AND 20),
  type text CHECK (type IS NULL OR char_length(type) BETWEEN 1 AND 50),
  subtype text CHECK (subtype IS NULL OR char_length(subtype) BETWEEN 1 AND 50),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  -- The archive's opaque account id (`finance.accounts.id`), not a foreign
  -- key: the archive is a different database, the same reason
  -- `kith.finance_account_overrides.finance_account_id` (migration 035) is
  -- not one either.
  archive_account_id text UNIQUE CHECK (
    archive_account_id IS NULL OR char_length(archive_account_id) BETWEEN 1 AND 200
  ),
  plaid_account_id text UNIQUE CHECK (
    plaid_account_id IS NULL OR char_length(plaid_account_id) BETWEEN 1 AND 200
  ),
  plaid_item_id text REFERENCES kith.plaid_items (item_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (archive_account_id IS NOT NULL OR plaid_account_id IS NOT NULL)
);

CREATE TABLE kith.fin_securities (
  id kith.kith_id PRIMARY KEY,
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 300),
  ticker text CHECK (ticker IS NULL OR char_length(ticker) BETWEEN 1 AND 50),
  cusip text CHECK (cusip IS NULL OR char_length(cusip) BETWEEN 1 AND 20),
  isin text CHECK (isin IS NULL OR char_length(isin) BETWEEN 1 AND 20),
  type text CHECK (type IS NULL OR char_length(type) BETWEEN 1 AND 50),
  plaid_security_id text UNIQUE CHECK (
    plaid_security_id IS NULL OR char_length(plaid_security_id) BETWEEN 1 AND 200
  ),
  archive_instrument_id text UNIQUE CHECK (
    archive_instrument_id IS NULL OR char_length(archive_instrument_id) BETWEEN 1 AND 200
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (plaid_security_id IS NOT NULL OR archive_instrument_id IS NOT NULL)
);

-- `kind` is deliberately one CHECK list shared by both sources: an archive
-- purchase and a Plaid buy read as the same thing to the owner, and giving
-- each source its own vocabulary would just move the merge this migration
-- exists to avoid into every reader instead.
CREATE TABLE kith.fin_transactions (
  id kith.kith_id PRIMARY KEY,
  account_id kith.kith_id NOT NULL
    REFERENCES kith.fin_accounts (id) ON DELETE CASCADE,
  date date NOT NULL,
  posted_date date,
  kind text NOT NULL CHECK (kind IN (
    'buy', 'sell', 'dividend', 'interest', 'fee', 'transfer', 'deposit',
    'withdrawal', 'purchase', 'payment', 'other'
  )),
  description text CHECK (
    description IS NULL OR char_length(description) BETWEEN 1 AND 400
  ),
  amount numeric,
  quantity numeric,
  price numeric,
  fees numeric,
  security_id kith.kith_id REFERENCES kith.fin_securities (id),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  pending boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('archive', 'plaid')),
  -- The Plaid transaction/investment-transaction id, or the archive's own
  -- transaction row id / evidence locator. Unique with `source` so an import
  -- or a pull re-run upserts rather than duplicates.
  source_ref text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 300),
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (source, source_ref)
);

CREATE INDEX fin_transactions_account_date_idx
  ON kith.fin_transactions (account_id, date DESC);

CREATE TABLE kith.fin_holding_snapshots (
  id kith.kith_id PRIMARY KEY,
  account_id kith.kith_id NOT NULL
    REFERENCES kith.fin_accounts (id) ON DELETE CASCADE,
  as_of date NOT NULL,
  security_id kith.kith_id NOT NULL REFERENCES kith.fin_securities (id),
  quantity numeric,
  price numeric,
  value numeric,
  cost_basis numeric,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  source text NOT NULL CHECK (source IN ('archive', 'plaid')),
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (account_id, security_id, as_of, source)
);

CREATE INDEX fin_holding_snapshots_account_idx
  ON kith.fin_holding_snapshots (account_id, as_of DESC);

CREATE TABLE kith.fin_balance_snapshots (
  id kith.kith_id PRIMARY KEY,
  account_id kith.kith_id NOT NULL
    REFERENCES kith.fin_accounts (id) ON DELETE CASCADE,
  as_of date NOT NULL,
  current numeric,
  available numeric,
  limit_amount numeric,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  source text NOT NULL CHECK (source IN ('archive', 'plaid')),
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (account_id, as_of, source)
);

CREATE INDEX fin_balance_snapshots_account_idx
  ON kith.fin_balance_snapshots (account_id, as_of DESC);

-- Copy what the retiring tables hold into the new ones before they are
-- dropped below. `md5(random()::text || clock_timestamp()::text || <row's
-- own natural key>)` mints a 32-character lowercase-hex id, which satisfies
-- `kith.kith_id`'s `^[a-z0-9]{20,64}$` domain check the same way
-- `newKithId()` does; there is no SQL-side equivalent of that generator, and
-- this is a one-time data migration, not a row this schema creates going
-- forward.
INSERT INTO kith.fin_accounts
  (id, institution_name, name, official_name, mask, type, subtype, currency,
   plaid_account_id, plaid_item_id, created_at, updated_at)
SELECT md5(random()::text || clock_timestamp()::text || a.account_id),
       i.institution_name, a.name, a.official_name, a.mask, a.type,
       a.subtype, a.currency, a.account_id, a.item_id, a.updated_at, a.updated_at
  FROM kith.plaid_accounts a
  JOIN kith.plaid_items i ON i.item_id = a.item_id;

INSERT INTO kith.fin_securities
  (id, name, ticker, type, plaid_security_id, created_at, updated_at)
SELECT md5(random()::text || clock_timestamp()::text || s.security_id),
       s.name, s.ticker_symbol, s.type, s.security_id, s.updated_at, s.updated_at
  FROM kith.plaid_securities s;

INSERT INTO kith.fin_balance_snapshots
  (id, account_id, as_of, current, available, limit_amount, currency, source,
   raw, created_at)
SELECT md5(random()::text || clock_timestamp()::text || b.account_id || b.as_of::text),
       fa.id, b.as_of, b.current, b.available, b.limit_amount, b.currency,
       'plaid', b.raw, b.created_at
  FROM kith.plaid_balance_snapshots b
  JOIN kith.fin_accounts fa ON fa.plaid_account_id = b.account_id;

INSERT INTO kith.fin_holding_snapshots
  (id, account_id, as_of, security_id, quantity, price, value, cost_basis,
   currency, source, raw, created_at)
SELECT md5(random()::text || clock_timestamp()::text || h.account_id || h.security_id || h.as_of::text),
       fa.id, h.as_of, fs.id, h.quantity, h.price, h.value, h.cost_basis,
       h.currency, 'plaid', h.raw, h.created_at
  FROM kith.plaid_holding_snapshots h
  JOIN kith.fin_accounts fa ON fa.plaid_account_id = h.account_id
  JOIN kith.fin_securities fs ON fs.plaid_security_id = h.security_id;

-- Banking transactions. `removed_at` rows and rows Plaid never gave a date
-- (both rare, and `fin_transactions.date` is NOT NULL) are not carried over:
-- a removed row should not exist in the unified ledger either, and a dateless
-- row cannot be placed in it.
INSERT INTO kith.fin_transactions
  (id, account_id, date, posted_date, kind, description, amount, currency,
   pending, source, source_ref, raw, created_at, updated_at)
SELECT md5(random()::text || clock_timestamp()::text || t.transaction_id),
       fa.id, t.date, t.authorized_date,
       CASE
         WHEN t.amount IS NULL THEN 'other'
         WHEN t.amount > 0 THEN 'withdrawal'
         WHEN t.amount < 0 THEN 'deposit'
         ELSE 'other'
       END,
       coalesce(t.merchant_name, t.name), t.amount, t.currency, t.pending,
       'plaid', t.transaction_id, t.raw, t.updated_at, t.updated_at
  FROM kith.plaid_transactions t
  JOIN kith.fin_accounts fa ON fa.plaid_account_id = t.account_id
 WHERE t.removed_at IS NULL AND t.date IS NOT NULL;

-- Investment transactions. Plaid's own `type`/`subtype` vocabulary maps onto
-- the shared `kind` CHECK; `subtype` is checked first since it is the more
-- specific of the two when both are present.
INSERT INTO kith.fin_transactions
  (id, account_id, date, kind, description, amount, quantity, price, fees,
   security_id, currency, source, source_ref, raw, created_at, updated_at)
SELECT md5(random()::text || clock_timestamp()::text || it.investment_transaction_id),
       fa.id, it.date,
       CASE
         WHEN it.subtype ILIKE 'dividend%' THEN 'dividend'
         WHEN it.subtype ILIKE 'interest%' THEN 'interest'
         WHEN it.subtype ILIKE '%fee%' THEN 'fee'
         WHEN it.subtype ILIKE '%transfer%' THEN 'transfer'
         WHEN it.subtype ILIKE '%deposit%' THEN 'deposit'
         WHEN it.subtype ILIKE '%withdrawal%' THEN 'withdrawal'
         WHEN it.type = 'buy' THEN 'buy'
         WHEN it.type = 'sell' THEN 'sell'
         WHEN it.type = 'fee' THEN 'fee'
         WHEN it.type = 'cash' THEN 'transfer'
         ELSE 'other'
       END,
       it.name, it.amount, it.quantity, it.price, it.fees, fs.id, it.currency,
       'plaid', it.investment_transaction_id, it.raw, it.updated_at, it.updated_at
  FROM kith.plaid_investment_transactions it
  JOIN kith.fin_accounts fa ON fa.plaid_account_id = it.account_id
  LEFT JOIN kith.fin_securities fs ON fs.plaid_security_id = it.security_id;

DROP TABLE kith.plaid_investment_transactions;
DROP TABLE kith.plaid_transactions;
DROP TABLE kith.plaid_holding_snapshots;
DROP TABLE kith.plaid_balance_snapshots;
DROP TABLE kith.plaid_securities;
DROP TABLE kith.plaid_accounts;
