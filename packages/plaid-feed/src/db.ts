// The store side of the feed: one small upsert per Plaid object kind, all
// idempotent so a re-run of `pull` (a retry, a second daily run) never
// duplicates a row.
//
// FIN-1 (migration 048_finance_unify.sql): these write into the unified
// `kith.fin_*` tables rather than the Plaid-only tables PLAID-1 first
// created. `kith.plaid_items` is still item state -- the Keychain pointer,
// the transactions-sync cursor, the investment-transaction watermark,
// `needs_relink_at` -- and is unaffected. Every `fin_*` write here tags
// `source = 'plaid'` and dedupes on the natural Plaid id
// (`plaid_account_id`, `plaid_security_id`, or `(source, source_ref)` for a
// transaction or a snapshot), so an account or a security an archive import
// already created (FIN-1's `import-archive` command) is filled in rather
// than duplicated, and a transaction the archive already holds under a
// different `source` is kept as two rows -- one per source, which is the
// point: neither source overwrites the other's evidence.

import { createKithPool, newKithId } from "@repo/kith-store";
import type { Pool } from "pg";

import type {
  PlaidAccountRow,
  PlaidBalanceSnapshotInput,
  PlaidHoldingSnapshotInput,
  PlaidInvestmentTransactionRow,
  PlaidSecurityRow,
  PlaidTransactionRow,
} from "./mapping.js";

export function openPool(databaseUrl: string): Pool {
  return createKithPool(databaseUrl, 2);
}

export type PlaidItemRow = {
  itemId: string;
  institutionId: string;
  institutionName: string;
  keychainService: string;
  transactionsCursor: string | null;
  needsRelinkAt: string | null;
  /**
   * How far this item's investment-transaction history has been pulled, or
   * `null` for an item that has never had investment transactions pulled
   * (migration 045). `null` tells `pull` to fetch the full 24-month window
   * instead of just the incremental one.
   */
  investmentTransactionsPulledThrough: string | null;
};

export async function listPlaidItems(pool: Pool): Promise<PlaidItemRow[]> {
  const { rows } = await pool.query<{
    item_id: string;
    institution_id: string;
    institution_name: string;
    keychain_service: string;
    transactions_cursor: string | null;
    needs_relink_at: string | null;
    investment_transactions_pulled_through: string | null;
  }>(
    // `investment_transactions_pulled_through` is a `date` column and `pg`'s
    // default type parser for OID 1082 returns a JS `Date`, not the string
    // this row type says -- `::text` here is what makes that true rather
    // than merely typed. A live pull after PR 428 hit this: the Date's
    // default `toString()` fed into `investmentTransactionsStartDate`'s
    // string interpolation built an unparseable timestamp and threw
    // "Invalid time value" for every item that already had a watermark.
    `SELECT item_id, institution_id, institution_name, keychain_service,
            transactions_cursor, needs_relink_at,
            investment_transactions_pulled_through::text
              AS investment_transactions_pulled_through
       FROM kith.plaid_items
      ORDER BY institution_name, item_id`,
  );
  return rows.map((row) => ({
    itemId: row.item_id,
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    keychainService: row.keychain_service,
    transactionsCursor: row.transactions_cursor,
    needsRelinkAt: row.needs_relink_at,
    investmentTransactionsPulledThrough:
      row.investment_transactions_pulled_through,
  }));
}

export async function upsertPlaidItem(
  pool: Pool,
  item: {
    itemId: string;
    institutionId: string;
    institutionName: string;
    keychainService: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.plaid_items
       (id, item_id, institution_id, institution_name, keychain_service)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (item_id) DO UPDATE
       SET institution_id = EXCLUDED.institution_id,
           institution_name = EXCLUDED.institution_name,
           keychain_service = EXCLUDED.keychain_service`,
    [
      newKithId(),
      item.itemId,
      item.institutionId,
      item.institutionName,
      item.keychainService,
    ],
  );
}

export async function recordPullSuccess(
  pool: Pool,
  itemId: string,
  transactionsCursor: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE kith.plaid_items
        SET last_pulled_at = transaction_timestamp(),
            last_pull_error = NULL,
            needs_relink_at = NULL,
            transactions_cursor = COALESCE($2, transactions_cursor)
      WHERE item_id = $1`,
    [itemId, transactionsCursor],
  );
}

/**
 * How far this item's investment-transaction history reaches, after a
 * successful (partial or full) fetch of that window. Separate from
 * `recordPullSuccess` (and called before it, from within the investment-
 * transactions block) so a later failure elsewhere in the same pull -- for
 * example transactions-sync -- does not also roll this back: the investment
 * transactions already fetched are already written, so the watermark they
 * establish should stick regardless of what happens next in the same pull.
 */
export async function recordInvestmentTransactionsPulledThrough(
  pool: Pool,
  itemId: string,
  pulledThrough: string,
): Promise<void> {
  await pool.query(
    `UPDATE kith.plaid_items
        SET investment_transactions_pulled_through = $2
      WHERE item_id = $1`,
    [itemId, pulledThrough],
  );
}

export async function recordPullFailure(
  pool: Pool,
  itemId: string,
  message: string,
  needsRelink: boolean,
): Promise<void> {
  await pool.query(
    `UPDATE kith.plaid_items
        SET last_pulled_at = transaction_timestamp(),
            last_pull_error = $2,
            needs_relink_at = CASE WHEN $3 THEN transaction_timestamp()
                                    ELSE needs_relink_at END
      WHERE item_id = $1`,
    [itemId, message, needsRelink],
  );
}

export async function upsertAccount(
  pool: Pool,
  account: PlaidAccountRow,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.fin_accounts
       (id, institution_name, name, official_name, mask, type, subtype,
        currency, plaid_account_id, plaid_item_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (plaid_account_id) DO UPDATE
       SET institution_name = EXCLUDED.institution_name,
           name = EXCLUDED.name,
           official_name = EXCLUDED.official_name,
           mask = EXCLUDED.mask,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           currency = EXCLUDED.currency,
           plaid_item_id = EXCLUDED.plaid_item_id,
           updated_at = transaction_timestamp()`,
    [
      newKithId(),
      account.institutionName,
      account.name,
      account.officialName,
      account.mask,
      account.type,
      account.subtype,
      account.currency,
      account.accountId,
      account.itemId,
    ],
  );
}

export async function upsertSecurity(
  pool: Pool,
  security: PlaidSecurityRow,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.fin_securities
       (id, name, ticker, type, plaid_security_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (plaid_security_id) DO UPDATE
       SET name = EXCLUDED.name,
           ticker = EXCLUDED.ticker,
           type = EXCLUDED.type,
           updated_at = transaction_timestamp()`,
    [
      newKithId(),
      security.name,
      security.tickerSymbol,
      security.type,
      security.securityId,
    ],
  );
}

export async function upsertBalanceSnapshot(
  pool: Pool,
  snapshot: PlaidBalanceSnapshotInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.fin_balance_snapshots
       (id, account_id, as_of, current, available, limit_amount, currency,
        source, raw)
     SELECT $1, fa.id, $3, $4, $5, $6, $7, 'plaid', $8
       FROM kith.fin_accounts fa
      WHERE fa.plaid_account_id = $2
     ON CONFLICT (account_id, as_of, source) DO UPDATE
       SET current = EXCLUDED.current,
           available = EXCLUDED.available,
           limit_amount = EXCLUDED.limit_amount,
           currency = EXCLUDED.currency,
           raw = EXCLUDED.raw`,
    [
      newKithId(),
      snapshot.accountId,
      snapshot.asOf,
      snapshot.current,
      snapshot.available,
      snapshot.limitAmount,
      snapshot.currency,
      JSON.stringify(snapshot.raw),
    ],
  );
}

export async function upsertHoldingSnapshot(
  pool: Pool,
  snapshot: PlaidHoldingSnapshotInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.fin_holding_snapshots
       (id, account_id, security_id, as_of, quantity, price, value,
        cost_basis, currency, source, raw)
     SELECT $1, fa.id, fs.id, $4, $5, $6, $7, $8, $9, 'plaid', $10
       FROM kith.fin_accounts fa, kith.fin_securities fs
      WHERE fa.plaid_account_id = $2 AND fs.plaid_security_id = $3
     ON CONFLICT (account_id, security_id, as_of, source) DO UPDATE
       SET quantity = EXCLUDED.quantity,
           price = EXCLUDED.price,
           value = EXCLUDED.value,
           cost_basis = EXCLUDED.cost_basis,
           currency = EXCLUDED.currency,
           raw = EXCLUDED.raw`,
    [
      newKithId(),
      snapshot.accountId,
      snapshot.securityId,
      snapshot.asOf,
      snapshot.quantity,
      snapshot.price,
      snapshot.value,
      snapshot.costBasis,
      snapshot.currency,
      JSON.stringify(snapshot.raw),
    ],
  );
}

/** Plaid's amount sign for a banking transaction: positive is money leaving
 * the account. Mapped onto the ledger's own `kind` vocabulary; there is no
 * Plaid banking analog of `buy`/`sell`/`dividend`, so this is deliberately
 * coarse. */
function bankingKind(amount: number | null): string {
  if (amount === null || amount === 0) return "other";
  return amount > 0 ? "withdrawal" : "deposit";
}

export async function upsertTransaction(
  pool: Pool,
  transaction: PlaidTransactionRow,
): Promise<void> {
  if (transaction.date === null) return;
  await pool.query(
    `INSERT INTO kith.fin_transactions
       (id, account_id, date, posted_date, kind, description, amount,
        currency, pending, source, source_ref, raw)
     SELECT $1, fa.id, $3, $4, $5, $6, $7, $8, $9, 'plaid', $2, $10
       FROM kith.fin_accounts fa
      WHERE fa.plaid_account_id = $11
     ON CONFLICT (source, source_ref) DO UPDATE
       SET date = EXCLUDED.date,
           posted_date = EXCLUDED.posted_date,
           kind = EXCLUDED.kind,
           description = EXCLUDED.description,
           amount = EXCLUDED.amount,
           currency = EXCLUDED.currency,
           pending = EXCLUDED.pending,
           raw = EXCLUDED.raw,
           updated_at = transaction_timestamp()`,
    [
      newKithId(),
      transaction.transactionId,
      transaction.date,
      transaction.authorizedDate,
      bankingKind(transaction.amount),
      transaction.merchantName ?? transaction.name,
      transaction.amount,
      transaction.currency,
      transaction.pending,
      JSON.stringify(transaction.raw),
      transaction.accountId,
    ],
  );
}

/**
 * `/transactions/sync`'s `removed` list. Unlike the retired
 * `plaid_transactions` table (which kept the row and set `removed_at`),
 * `kith.fin_transactions` has no `removed_at` column -- an archive row has
 * no such concept and the unified table shares one shape -- so a removed
 * Plaid transaction is deleted outright. A transaction that was never
 * written (a row failure on the original add, or one this pull never saw)
 * has nothing to delete and this is a no-op.
 */
export async function markTransactionRemoved(
  pool: Pool,
  transactionId: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM kith.fin_transactions
      WHERE source = 'plaid' AND source_ref = $1`,
    [transactionId],
  );
}

export async function upsertInvestmentTransaction(
  pool: Pool,
  transaction: PlaidInvestmentTransactionRow,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.fin_transactions
       (id, account_id, date, kind, description, amount, quantity, price,
        fees, security_id, currency, source, source_ref, raw)
     SELECT $1, fa.id, $3, $4, $5, $6, $7, $8, $9,
            (SELECT id FROM kith.fin_securities WHERE plaid_security_id = $10),
            $11, 'plaid', $2, $12
       FROM kith.fin_accounts fa
      WHERE fa.plaid_account_id = $13
     ON CONFLICT (source, source_ref) DO UPDATE
       SET date = EXCLUDED.date,
           kind = EXCLUDED.kind,
           description = EXCLUDED.description,
           amount = EXCLUDED.amount,
           quantity = EXCLUDED.quantity,
           price = EXCLUDED.price,
           fees = EXCLUDED.fees,
           security_id = EXCLUDED.security_id,
           currency = EXCLUDED.currency,
           raw = EXCLUDED.raw,
           updated_at = transaction_timestamp()`,
    [
      newKithId(),
      transaction.investmentTransactionId,
      transaction.date,
      investmentKind(transaction.type, transaction.subtype),
      transaction.name,
      transaction.amount,
      transaction.quantity,
      transaction.price,
      transaction.fees,
      transaction.securityId,
      transaction.currency,
      JSON.stringify(transaction.raw),
      transaction.accountId,
    ],
  );
}

/** The same `type`/`subtype` -> `kind` mapping migration 048's one-time copy
 * used for the rows it carried over, kept here so a live pull's investment
 * transactions land in the same vocabulary. Exported for the mapping test. */
export function investmentKind(
  type: string | null,
  subtype: string | null,
): string {
  const sub = subtype?.toLowerCase() ?? "";
  if (sub.startsWith("dividend")) return "dividend";
  if (sub.startsWith("interest")) return "interest";
  if (sub.includes("fee")) return "fee";
  if (sub.includes("transfer")) return "transfer";
  if (sub.includes("deposit")) return "deposit";
  if (sub.includes("withdrawal")) return "withdrawal";
  if (type === "buy") return "buy";
  if (type === "sell") return "sell";
  if (type === "fee") return "fee";
  if (type === "cash") return "transfer";
  return "other";
}
