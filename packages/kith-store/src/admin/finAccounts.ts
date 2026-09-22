// FIN-1's read surface: one row per unified ledger account
// (`kith.fin_accounts`, migration 048_finance_unify.sql), its latest balance
// snapshot and the sum of its latest holdings snapshot's values, whichever
// source (`archive` or `plaid`) most recently reported them.
//
// Replaces PLAID-1's `listPlaidBalances`/`PlaidBalanceRow`, which read the
// now-retired `kith.plaid_accounts`/`plaid_balance_snapshots`/
// `plaid_holding_snapshots`. The Balances screen's own columns are
// unchanged; only the table underneath moved.
//
// Owner-global, like the tables themselves: there is no space to narrow this
// read to, the same way the finance archive's own account inventory is one
// archive rather than a per-space read.

import { rows, type IdentityCtx } from "../identity/db.js";

export type FinAccountRow = {
  /** `kith.fin_accounts.id`: the one ledger identity for this account,
   * whichever source (or both) contributed it. */
  accountId: string;
  archiveAccountId: string | null;
  plaidAccountId: string | null;
  institutionName: string;
  accountName: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currentBalance: number | null;
  currency: string | null;
  balanceAsOf: string | null;
  balanceSource: "archive" | "plaid" | null;
  holdingsValue: number | null;
  holdingsAsOf: string | null;
  holdingsSource: "archive" | "plaid" | null;
  needsRelinkAt: string | null;
};

export async function listFinAccounts(ctx: IdentityCtx): Promise<FinAccountRow[]> {
  const found = await rows<{
    account_id: string;
    archive_account_id: string | null;
    plaid_account_id: string | null;
    institution_name: string;
    account_name: string;
    mask: string | null;
    type: string | null;
    subtype: string | null;
    current_balance: string | null;
    currency: string | null;
    balance_as_of: string | null;
    balance_source: "archive" | "plaid" | null;
    holdings_value: string | null;
    holdings_as_of: string | null;
    holdings_source: "archive" | "plaid" | null;
    needs_relink_at: string | null;
  }>(
    ctx,
    `SELECT
       fa.id AS account_id,
       fa.archive_account_id,
       fa.plaid_account_id,
       fa.institution_name,
       fa.name AS account_name,
       fa.mask,
       fa.type,
       fa.subtype,
       b.current AS current_balance,
       b.currency,
       b.as_of::text AS balance_as_of,
       b.source AS balance_source,
       h.holdings_value,
       h.holdings_as_of::text AS holdings_as_of,
       h.holdings_source,
       i.needs_relink_at
     FROM kith.fin_accounts fa
     LEFT JOIN kith.plaid_items i ON i.item_id = fa.plaid_item_id
     LEFT JOIN LATERAL (
       SELECT current, currency, as_of, source
         FROM kith.fin_balance_snapshots
        WHERE account_id = fa.id
        ORDER BY as_of DESC
        LIMIT 1
     ) b ON true
     LEFT JOIN LATERAL (
       SELECT sum(value) AS holdings_value, max(as_of) AS holdings_as_of,
              (array_agg(source ORDER BY as_of DESC))[1] AS holdings_source
         FROM kith.fin_holding_snapshots hs
        WHERE hs.account_id = fa.id
          AND hs.as_of = (
            SELECT max(as_of) FROM kith.fin_holding_snapshots
             WHERE account_id = fa.id
          )
     ) h ON true
     ORDER BY fa.institution_name, fa.name`,
  );
  return found.map((row) => ({
    accountId: row.account_id,
    archiveAccountId: row.archive_account_id,
    plaidAccountId: row.plaid_account_id,
    institutionName: row.institution_name,
    accountName: row.account_name,
    mask: row.mask,
    type: row.type,
    subtype: row.subtype,
    currentBalance: row.current_balance === null ? null : Number(row.current_balance),
    currency: row.currency,
    balanceAsOf: row.balance_as_of,
    balanceSource: row.balance_source,
    holdingsValue: row.holdings_value === null ? null : Number(row.holdings_value),
    holdingsAsOf: row.holdings_as_of,
    holdingsSource: row.holdings_source,
    needsRelinkAt: row.needs_relink_at,
  }));
}
