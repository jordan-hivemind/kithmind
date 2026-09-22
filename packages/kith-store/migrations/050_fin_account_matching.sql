-- FIN-3: fix `import-archive`'s account-matching and add the linking
-- machinery the owner's live-database audit called for after PR 433's first
-- real run.
--
-- The audit found `finance.transactions` (the archive) carrying 19 distinct
-- `account_id` values while the archive-source rows in `kith.fin_transactions`
-- sat on only 5 `kith.fin_accounts` rows -- one per `account_type` bucket at
-- the one archive institution, each bucket's row count equal to the whole
-- archive total for that type (brokerage 12 accounts collapsed onto one row,
-- trust 3, retirement 2). `kith.fin_accounts.display_name` (read through
-- `finance.accounts.display_name`) is null or generic on this database, so
-- `import-archive`'s name-fallback ("Unlabeled account") and its institution-
-- plus-name matching could compare two different archive accounts' fallback
-- names as if they were real evidence of the same account. This migration
-- adds the columns the code-side fix (packages/plaid-feed/src/importArchive.ts)
-- needs to record what actually linked an account and to let the owner
-- correct or pin a link by hand.
--
-- `match_method` records how `archive_account_id` was set on a `fin_accounts`
-- row: `holdings` (overlapping positions, the new primary method for
-- investment accounts -- Plaid's `mask` and a statement's own account number
-- turned out to encode different things at this institution, 0 of 24 audited
-- masks agreeing), `balance` (matching latest balances within tolerance, for
-- accounts with no holdings -- loans, credit lines, cash), `mask` and `name`
-- (the original two methods, kept as secondary fallbacks), and `manual` (an
-- owner-supplied `--link`). Null means unlinked (an archive-only row with no
-- feed match yet) or a Plaid-only row with no archive link at all.
ALTER TABLE kith.fin_accounts
  ADD COLUMN match_method text CHECK (
    match_method IS NULL
    OR match_method IN ('holdings', 'balance', 'mask', 'name', 'manual')
  );

-- An owner-supplied `--link <archive_account_id>=<plaid_account_id>` or
-- `--unlink <archive_account_id>` from the `import-archive` CLI. Persisted
-- here (not just applied once in memory) so it survives past the run that
-- set it and automatic matching -- holdings, balance, mask or name -- never
-- overwrites it on a later run: `import-archive` reads this table before it
-- reads or computes anything else.
--
-- `plaid_account_id IS NULL` records an explicit `--unlink`: this archive
-- account must never be auto-matched to anything again until the owner
-- clears the override (a future `--link` overwrites it; there is no
-- separate "clear" command yet -- re-running `--link` is how the owner
-- reverses an `--unlink`).
CREATE TABLE kith.fin_account_link_overrides (
  archive_account_id text PRIMARY KEY
    CHECK (char_length(archive_account_id) BETWEEN 1 AND 200),
  plaid_account_id text
    CHECK (plaid_account_id IS NULL OR char_length(plaid_account_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
