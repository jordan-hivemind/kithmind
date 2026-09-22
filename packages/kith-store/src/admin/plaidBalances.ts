// PLAID-1's read surface: one row per linked account, its latest balance
// snapshot and the sum of its latest holding snapshot's values.
//
// Owner-global, like the tables themselves (migration 043_plaid_feed.sql):
// there is no space to narrow this read to, the same way the finance
// archive's own account inventory is one archive rather than a per-space
// read. This is the only store function this feed's admin screen needs.

import { rows, type IdentityCtx } from "../identity/db.js";

export type PlaidBalanceRow = {
  accountId: string;
  institutionName: string;
  accountName: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  currentBalance: number | null;
  currency: string | null;
  balanceAsOf: string | null;
  holdingsValue: number | null;
  holdingsAsOf: string | null;
  needsRelinkAt: string | null;
};

export async function listPlaidBalances(
  ctx: IdentityCtx,
): Promise<PlaidBalanceRow[]> {
  const found = await rows<{
    account_id: string;
    institution_name: string;
    account_name: string;
    mask: string | null;
    type: string;
    subtype: string | null;
    current_balance: string | null;
    currency: string | null;
    balance_as_of: string | null;
    holdings_value: string | null;
    holdings_as_of: string | null;
    needs_relink_at: string | null;
  }>(
    ctx,
    `SELECT
       a.account_id,
       i.institution_name,
       a.name AS account_name,
       a.mask,
       a.type,
       a.subtype,
       b.current AS current_balance,
       b.currency,
       b.as_of::text AS balance_as_of,
       h.holdings_value,
       h.holdings_as_of::text AS holdings_as_of,
       i.needs_relink_at
     FROM kith.plaid_accounts a
     JOIN kith.plaid_items i ON i.item_id = a.item_id
     LEFT JOIN LATERAL (
       SELECT current, currency, as_of
         FROM kith.plaid_balance_snapshots
        WHERE account_id = a.account_id
        ORDER BY as_of DESC
        LIMIT 1
     ) b ON true
     LEFT JOIN LATERAL (
       SELECT sum(value) AS holdings_value, max(as_of) AS holdings_as_of
         FROM kith.plaid_holding_snapshots hs
        WHERE hs.account_id = a.account_id
          AND hs.as_of = (
            SELECT max(as_of) FROM kith.plaid_holding_snapshots
             WHERE account_id = a.account_id
          )
     ) h ON true
     ORDER BY i.institution_name, a.name`,
  );
  return found.map((row) => ({
    accountId: row.account_id,
    institutionName: row.institution_name,
    accountName: row.account_name,
    mask: row.mask,
    type: row.type,
    subtype: row.subtype,
    currentBalance: row.current_balance === null ? null : Number(row.current_balance),
    currency: row.currency,
    balanceAsOf: row.balance_as_of,
    holdingsValue: row.holdings_value === null ? null : Number(row.holdings_value),
    holdingsAsOf: row.holdings_as_of,
    needsRelinkAt: row.needs_relink_at,
  }));
}
