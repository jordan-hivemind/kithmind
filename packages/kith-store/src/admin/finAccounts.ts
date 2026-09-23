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
//
// FIN-5 (migration 052): `fin_accounts.display_name` is the owner's own name
// for a feed-only account -- one Plaid reports with no archive counterpart,
// so `kith.finance_account_overrides` (keyed by the archive's own account id)
// has nothing to key on. `accountName` below is `display_name` when set,
// otherwise the row's own `name`; `feedName` carries the untouched `name`
// alongside it so a reader can still show what the feed itself calls the
// account (a tooltip, or muted secondary text) once a display name has
// replaced it on screen. An archive-linked account's name is still decided
// entirely by `kith.finance_account_overrides` -- see
// `apps/web/src/lib/kith/institutions.ts` -- so `display_name` is read here
// for every row but only ever meaningfully set on a Plaid-only one.

import { type Principal } from "../identity/authorization.js";
import { rows, type IdentityCtx } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId } from "../ids.js";
import { getAdminSpaceIds } from "./model.js";

export type FinAccountRow = {
  /** `kith.fin_accounts.id`: the one ledger identity for this account,
   * whichever source (or both) contributed it. */
  accountId: string;
  archiveAccountId: string | null;
  plaidAccountId: string | null;
  institutionName: string;
  /** `display_name` when the owner set one, otherwise the feed's own name. */
  accountName: string;
  /** The owner's own name for this account (`fin_accounts.display_name`),
   * raw and unmerged -- null when there is none. What an edit form prefills. */
  displayName: string | null;
  /** The feed's own name (`fin_accounts.name`), untouched by any override --
   * what a tooltip shows once `displayName` has replaced it on screen. */
  feedName: string;
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
    display_name: string | null;
    feed_name: string;
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
       coalesce(fa.display_name, fa.name) AS account_name,
       fa.display_name,
       fa.name AS feed_name,
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
     ORDER BY fa.institution_name, coalesce(fa.display_name, fa.name)`,
  );
  return found.map((row) => ({
    accountId: row.account_id,
    archiveAccountId: row.archive_account_id,
    plaidAccountId: row.plaid_account_id,
    institutionName: row.institution_name,
    accountName: row.account_name,
    displayName: row.display_name,
    feedName: row.feed_name,
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

function invalid(message: string): never {
  throw new IdentityError(message, { code: "invalid_input", message });
}

/**
 * Sets, or clears, the owner's own name for one `kith.fin_accounts` row
 * (migration 052). Trimmed to null clears it, the same "blank restores the
 * feed's own value" rule `setAccountOverride` uses for an archive account.
 *
 * `fin_accounts` carries no space, so there is no single space to check
 * `requireSpaceAccess` against the way every other write in this package
 * does. The gate here is the same one the admin panel's own layout applies
 * before this screen is ever reachable (`getAdminSpaceIds`, `sources-data.ts`'s
 * `loadAdminAccess`): a principal who administers no space at all may not
 * write this owner-global row either.
 */
export async function setFinAccountDisplayName(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    accountId: string;
    displayName: string | null;
  },
): Promise<void> {
  const administered = await getAdminSpaceIds(ctx, args.principal);
  if (administered.length === 0) {
    throw new IdentityError("Not authorized", {
      code: "not_authorized",
      message: "Not authorized",
    });
  }
  const accountId = assertKithId(args.accountId, "invalid_account_id");
  const trimmed = args.displayName === null ? "" : args.displayName.trim();
  if (trimmed !== "" && Array.from(trimmed).length > 300) {
    invalid("Name is too long");
  }
  const normalized = trimmed === "" ? null : trimmed;
  const updated = await rows<{ id: string }>(
    ctx,
    `UPDATE kith.fin_accounts
        SET display_name = $2, updated_at = transaction_timestamp()
      WHERE id = $1
      RETURNING id`,
    [accountId, normalized],
  );
  if (updated.length === 0) {
    throw new IdentityError("Account not found", {
      code: "not_found",
      message: "Account not found",
    });
  }
}
