-- PLAID-4: the second real pull failed partway through with
-- "new row for relation \"plaid_investment_transactions\" violates check
-- constraint \"plaid_investment_transactions_subtype_check\"" after 949 rows
-- had already been fetched and written. Migration 043 constrains many
-- Plaid-provided strings with `char_length(x) BETWEEN 1 AND N`; even on a
-- nullable column, that CHECK still rejects an empty string (char_length 0
-- is neither NULL nor in `[1, N]`), and Plaid does send an empty string --
-- not just an unexpected one -- for subtype, type, name, merchant_name,
-- category, official_name, mask, ticker_symbol and similar fields on some
-- rows.
--
-- Replace every such CHECK on a nullable column across the six Plaid tables
-- that carry one (plaid_accounts, plaid_securities, plaid_balance_snapshots,
-- plaid_holding_snapshots, plaid_transactions,
-- plaid_investment_transactions -- plaid_items has no nullable text column
-- with a length CHECK) with `x IS NULL OR char_length(x) <= N`: NULL and
-- empty are both allowed now, N is unchanged, and any non-empty value this
-- build already accepted still passes -- a pure relaxation, safe to apply
-- without touching data, the same shape migration 044 used for currency.
-- The `currency` CHECK migration 044 already relaxed to a bounded length
-- keeps the same `BETWEEN 1 AND N` shape and gets the identical treatment
-- here for the same reason.
--
-- The `NOT NULL` identity columns (`item_id`, `account_id`, `security_id`,
-- `transaction_id`, `investment_transaction_id`, `institution_id`,
-- `keychain_service`) and the other `NOT NULL` columns (`plaid_items.
-- institution_name`, `plaid_accounts.name`, `plaid_accounts.type`) are
-- untouched: a `NOT NULL` column cannot accept the `x IS NULL OR` form, and
-- these are not the columns the real pull's row failures came from.

ALTER TABLE kith.plaid_accounts
  DROP CONSTRAINT plaid_accounts_official_name_check,
  ADD CONSTRAINT plaid_accounts_official_name_check
    CHECK (official_name IS NULL OR char_length(official_name) <= 300),
  DROP CONSTRAINT plaid_accounts_mask_check,
  ADD CONSTRAINT plaid_accounts_mask_check
    CHECK (mask IS NULL OR char_length(mask) <= 20),
  DROP CONSTRAINT plaid_accounts_subtype_check,
  ADD CONSTRAINT plaid_accounts_subtype_check
    CHECK (subtype IS NULL OR char_length(subtype) <= 50),
  DROP CONSTRAINT plaid_accounts_currency_check,
  ADD CONSTRAINT plaid_accounts_currency_check
    CHECK (currency IS NULL OR char_length(currency) <= 20);

ALTER TABLE kith.plaid_securities
  DROP CONSTRAINT plaid_securities_name_check,
  ADD CONSTRAINT plaid_securities_name_check
    CHECK (name IS NULL OR char_length(name) <= 300),
  DROP CONSTRAINT plaid_securities_ticker_symbol_check,
  ADD CONSTRAINT plaid_securities_ticker_symbol_check
    CHECK (ticker_symbol IS NULL OR char_length(ticker_symbol) <= 50),
  DROP CONSTRAINT plaid_securities_type_check,
  ADD CONSTRAINT plaid_securities_type_check
    CHECK (type IS NULL OR char_length(type) <= 50),
  DROP CONSTRAINT plaid_securities_currency_check,
  ADD CONSTRAINT plaid_securities_currency_check
    CHECK (currency IS NULL OR char_length(currency) <= 20);

ALTER TABLE kith.plaid_balance_snapshots
  DROP CONSTRAINT plaid_balance_snapshots_currency_check,
  ADD CONSTRAINT plaid_balance_snapshots_currency_check
    CHECK (currency IS NULL OR char_length(currency) <= 20);

ALTER TABLE kith.plaid_holding_snapshots
  DROP CONSTRAINT plaid_holding_snapshots_currency_check,
  ADD CONSTRAINT plaid_holding_snapshots_currency_check
    CHECK (currency IS NULL OR char_length(currency) <= 20);

ALTER TABLE kith.plaid_transactions
  DROP CONSTRAINT plaid_transactions_name_check,
  ADD CONSTRAINT plaid_transactions_name_check
    CHECK (name IS NULL OR char_length(name) <= 300),
  DROP CONSTRAINT plaid_transactions_merchant_name_check,
  ADD CONSTRAINT plaid_transactions_merchant_name_check
    CHECK (merchant_name IS NULL OR char_length(merchant_name) <= 300),
  DROP CONSTRAINT plaid_transactions_currency_check,
  ADD CONSTRAINT plaid_transactions_currency_check
    CHECK (currency IS NULL OR char_length(currency) <= 20);

ALTER TABLE kith.plaid_investment_transactions
  DROP CONSTRAINT plaid_investment_transactions_name_check,
  ADD CONSTRAINT plaid_investment_transactions_name_check
    CHECK (name IS NULL OR char_length(name) <= 300),
  DROP CONSTRAINT plaid_investment_transactions_type_check,
  ADD CONSTRAINT plaid_investment_transactions_type_check
    CHECK (type IS NULL OR char_length(type) <= 50),
  DROP CONSTRAINT plaid_investment_transactions_subtype_check,
  ADD CONSTRAINT plaid_investment_transactions_subtype_check
    CHECK (subtype IS NULL OR char_length(subtype) <= 50),
  DROP CONSTRAINT plaid_investment_transactions_currency_check,
  ADD CONSTRAINT plaid_investment_transactions_currency_check
    CHECK (currency IS NULL OR char_length(currency) <= 20);
