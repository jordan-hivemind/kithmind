-- PLAID-3: pull as much history as Plaid allows, not just recent activity.
--
-- Banking transaction history is bounded by `transactions.days_requested` on
-- the link token (default 90, Plaid's maximum 730) and is fixed at Item
-- creation -- an Item already linked before this change keeps its original
-- window unless it is removed and re-linked. `/transactions/sync`'s cursor
-- (already persisted in `plaid_items.transactions_cursor`) still carries
-- that item forward incrementally; nothing here changes that path.
--
-- Investment transactions are different: `/investments/transactions/get`
-- takes an explicit `start_date`/`end_date` on every call, Plaid keeps up to
-- 24 months of them before the Item was linked, and the feed only ever asked
-- for the last 30 days. This column is how `pull` tells a first pull (fetch
-- the full 24-month window, paginated) from every later one (fetch from here
-- minus a 7-day overlap, to catch postings that landed late) for investment
-- transactions specifically -- `transactions_cursor` already does the
-- equivalent job for the separate, cursor-based banking-transactions call.
--
-- Nullable and unset for an existing item: the next `pull` for it is treated
-- as a first pull and backfills the full 24-month window, exactly like an
-- item linked after this change.

ALTER TABLE kith.plaid_items
  ADD COLUMN investment_transactions_pulled_through date;
