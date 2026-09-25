// The Banking & Cards screen's read surface: one row per `kith.fin_accounts`
// depository, credit or loan account (Chase, Bank of America, the Morgan
// Stanley loan products), and the transactions and balance history beneath
// them.
//
// Owner-global, like `listFinAccounts` and the tables themselves: there is no
// space to narrow this to (see `finAccounts.ts`'s own comment). This file
// only reads `kith.fin_accounts`/`fin_balance_snapshots`/`fin_transactions`;
// it never reaches the finance archive (a different database, a different
// contract), the same separation `admin-data.ts` keeps between
// `listFinAccounts` and `archiveInventory`.

import { rows, type IdentityCtx } from "../identity/db.js";

/**
 * `kith.fin_accounts.type` values this screen counts as a bank or card
 * account, rather than an investment, retirement or trust account (the
 * Investment Accounts screen's territory).
 *
 * `depository`, `credit` and `loan` are Plaid's own vocabulary
 * (`packages/kith-store/migrations/048_finance_unify.sql`). `mortgage` is
 * also matched: an archive-only row that `import-archive` created for an
 * archive account with no Plaid counterpart carries the archive's own
 * free-text `account_type` verbatim as `type`
 * (`packages/plaid-feed/src/importArchive.ts`), and at least one Morgan
 * Stanley loan account is recorded there as "mortgage" rather than as a
 * Plaid-style `loan` row with a `mortgage` subtype. `investment` (Plaid) and
 * the archive's own `brokerage`/`retirement`/`trust` strings are deliberately
 * not matched here.
 */
export const BANKING_ACCOUNT_TYPES = [
  "depository",
  "credit",
  "loan",
  "mortgage",
] as const;

const BANKING_TYPE_PREDICATE = `lower(fa.type) = ANY($1::text[])`;

export type BankingAccountRow = {
  accountId: string;
  archiveAccountId: string | null;
  plaidAccountId: string | null;
  institutionName: string;
  accountName: string;
  displayName: string | null;
  feedName: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currentBalance: number | null;
  availableBalance: number | null;
  limitAmount: number | null;
  currency: string | null;
  balanceAsOf: string | null;
  lastTransactionAt: string | null;
  needsRelinkAt: string | null;
};

/**
 * Every depository, credit and loan account, including one with no
 * transactions or balance at all -- `listBankingAccounts` never filters a
 * row out for having nothing under it. See `BANKING_ACCOUNT_TYPES` for which
 * `type` values qualify.
 */
export async function listBankingAccounts(
  ctx: IdentityCtx,
): Promise<BankingAccountRow[]> {
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
    available_balance: string | null;
    limit_amount: string | null;
    currency: string | null;
    balance_as_of: string | null;
    last_transaction_at: string | null;
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
       b.available AS available_balance,
       b.limit_amount,
       b.currency,
       b.as_of::text AS balance_as_of,
       tx.last_transaction_at::text AS last_transaction_at,
       i.needs_relink_at
     FROM kith.fin_accounts fa
     LEFT JOIN kith.plaid_items i ON i.item_id = fa.plaid_item_id
     LEFT JOIN LATERAL (
       SELECT current, available, limit_amount, currency, as_of
         FROM kith.fin_balance_snapshots
        WHERE account_id = fa.id
        ORDER BY as_of DESC
        LIMIT 1
     ) b ON true
     LEFT JOIN LATERAL (
       SELECT max(date) AS last_transaction_at
         FROM kith.fin_transactions
        WHERE account_id = fa.id
     ) tx ON true
     WHERE ${BANKING_TYPE_PREDICATE}
     ORDER BY fa.institution_name, coalesce(fa.display_name, fa.name)`,
    [BANKING_ACCOUNT_TYPES],
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
    currentBalance:
      row.current_balance === null ? null : Number(row.current_balance),
    availableBalance:
      row.available_balance === null ? null : Number(row.available_balance),
    limitAmount: row.limit_amount === null ? null : Number(row.limit_amount),
    currency: row.currency,
    balanceAsOf: row.balance_as_of,
    lastTransactionAt: row.last_transaction_at,
    needsRelinkAt: row.needs_relink_at,
  }));
}

export type BankingTransactionRow = {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  description: string | null;
  amount: number | null;
  currency: string | null;
  pending: boolean;
};

/** A bound on one page's rows, independent of what the caller asks for, so a
 * caller cannot turn a widened window into an unbounded read. */
const MAX_BANKING_TRANSACTIONS = 2000;

/**
 * Transactions across the banking accounts (`BANKING_ACCOUNT_TYPES`), latest
 * first, capped at `limit` (itself capped at `MAX_BANKING_TRANSACTIONS`).
 * `total` is the count the window actually matched, so a capped caller can
 * still say how many rows it is not showing.
 *
 * One function serves both readers this screen needs: the widen-able
 * transactions table (`accountId` omitted, a date window) and one account's
 * drawer (`accountId` set, `from`/`toExclusive` omitted, `limit: 50`) --
 * `accountId` is still checked against `BANKING_TYPE_PREDICATE` rather than
 * trusted outright, so a drawer id from outside this screen's own accounts
 * (an investment account, say) reads as no rows rather than as a leak across
 * the screens' boundary.
 */
export async function listBankingTransactions(
  ctx: IdentityCtx,
  args: {
    accountId?: string | null;
    from?: string | null;
    toExclusive?: string | null;
    limit: number;
  },
): Promise<{ items: BankingTransactionRow[]; total: number }> {
  const limit = Math.max(1, Math.min(args.limit, MAX_BANKING_TRANSACTIONS));
  const params = [
    BANKING_ACCOUNT_TYPES,
    args.accountId ?? null,
    args.from ?? null,
    args.toExclusive ?? null,
  ];
  const scopeSql = `FROM kith.fin_transactions t
     JOIN kith.fin_accounts fa ON fa.id = t.account_id
    WHERE ${BANKING_TYPE_PREDICATE}
      AND ($2::text IS NULL OR t.account_id = $2)
      AND ($3::date IS NULL OR t.date >= $3::date)
      AND ($4::date IS NULL OR t.date < $4::date)`;
  const [items, totals] = await Promise.all([
    rows<{
      id: string;
      account_id: string;
      account_name: string;
      date: string;
      description: string | null;
      amount: string | null;
      currency: string | null;
      pending: boolean;
    }>(
      ctx,
      `SELECT t.id, t.account_id,
              coalesce(fa.display_name, fa.name) AS account_name,
              t.date::text AS date, t.description, t.amount, t.currency,
              t.pending
         ${scopeSql}
        ORDER BY t.date DESC, t.id DESC
        LIMIT $5`,
      [...params, limit],
    ),
    rows<{ total: string }>(
      ctx,
      `SELECT count(*)::text AS total ${scopeSql}`,
      params,
    ),
  ]);
  return {
    items: items.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      date: row.date,
      description: row.description,
      amount: row.amount === null ? null : Number(row.amount),
      currency: row.currency,
      pending: row.pending,
    })),
    total: Number(totals[0]?.total ?? "0"),
  };
}

export type BankingBalancePoint = {
  asOf: string;
  current: number | null;
  currency: string | null;
};

/**
 * Up to `months` distinct months' latest balance snapshot for one account,
 * newest first -- the account drawer's "balance history". The latest
 * snapshot within a month stands in for a month-end figure: balances are
 * recorded daily, so in every month but the current one that is the same
 * thing.
 */
export async function listAccountBalanceHistory(
  ctx: IdentityCtx,
  accountId: string,
  months = 12,
): Promise<BankingBalancePoint[]> {
  const found = await rows<{
    as_of: string;
    current: string | null;
    currency: string | null;
  }>(
    ctx,
    `SELECT DISTINCT ON (date_trunc('month', as_of))
            as_of::text AS as_of, current, currency
       FROM kith.fin_balance_snapshots
      WHERE account_id = $1
      ORDER BY date_trunc('month', as_of) DESC, as_of DESC
      LIMIT $2`,
    [accountId, months],
  );
  return found.map((row) => ({
    asOf: row.as_of,
    current: row.current === null ? null : Number(row.current),
    currency: row.currency,
  }));
}
