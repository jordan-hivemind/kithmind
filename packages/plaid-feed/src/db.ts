// The store side of the feed: one small upsert per Plaid object kind, all
// idempotent so a re-run of `pull` (a retry, a second daily run) never
// duplicates a row. Every table is owner-global (migration
// 043_plaid_feed.sql), so there is no space to narrow to here.

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
};

export async function listPlaidItems(pool: Pool): Promise<PlaidItemRow[]> {
  const { rows } = await pool.query<{
    item_id: string;
    institution_id: string;
    institution_name: string;
    keychain_service: string;
    transactions_cursor: string | null;
    needs_relink_at: string | null;
  }>(
    `SELECT item_id, institution_id, institution_name, keychain_service,
            transactions_cursor, needs_relink_at
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
       (item_id, institution_id, institution_name, keychain_service)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id) DO UPDATE
       SET institution_id = EXCLUDED.institution_id,
           institution_name = EXCLUDED.institution_name,
           keychain_service = EXCLUDED.keychain_service`,
    [item.itemId, item.institutionId, item.institutionName, item.keychainService],
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
    `INSERT INTO kith.plaid_accounts
       (account_id, item_id, name, official_name, mask, type, subtype, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id) DO UPDATE
       SET name = EXCLUDED.name,
           official_name = EXCLUDED.official_name,
           mask = EXCLUDED.mask,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           currency = EXCLUDED.currency,
           updated_at = transaction_timestamp()`,
    [
      account.accountId,
      account.itemId,
      account.name,
      account.officialName,
      account.mask,
      account.type,
      account.subtype,
      account.currency,
    ],
  );
}

export async function upsertSecurity(
  pool: Pool,
  security: PlaidSecurityRow,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.plaid_securities
       (security_id, name, ticker_symbol, type, close_price, close_price_as_of, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (security_id) DO UPDATE
       SET name = EXCLUDED.name,
           ticker_symbol = EXCLUDED.ticker_symbol,
           type = EXCLUDED.type,
           close_price = EXCLUDED.close_price,
           close_price_as_of = EXCLUDED.close_price_as_of,
           currency = EXCLUDED.currency,
           updated_at = transaction_timestamp()`,
    [
      security.securityId,
      security.name,
      security.tickerSymbol,
      security.type,
      security.closePrice,
      security.closePriceAsOf,
      security.currency,
    ],
  );
}

export async function upsertBalanceSnapshot(
  pool: Pool,
  snapshot: PlaidBalanceSnapshotInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.plaid_balance_snapshots
       (id, account_id, as_of, current, available, limit_amount, currency, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id, as_of) DO UPDATE
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
    `INSERT INTO kith.plaid_holding_snapshots
       (id, account_id, security_id, as_of, quantity, price, value, cost_basis, currency, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (account_id, security_id, as_of) DO UPDATE
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

export async function upsertTransaction(
  pool: Pool,
  transaction: PlaidTransactionRow,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.plaid_transactions
       (transaction_id, account_id, item_id, date, authorized_date, name,
        merchant_name, amount, currency, pending, category, removed_at, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (transaction_id) DO UPDATE
       SET date = EXCLUDED.date,
           authorized_date = EXCLUDED.authorized_date,
           name = EXCLUDED.name,
           merchant_name = EXCLUDED.merchant_name,
           amount = EXCLUDED.amount,
           currency = EXCLUDED.currency,
           pending = EXCLUDED.pending,
           category = EXCLUDED.category,
           removed_at = EXCLUDED.removed_at,
           raw = EXCLUDED.raw,
           updated_at = transaction_timestamp()`,
    [
      transaction.transactionId,
      transaction.accountId,
      transaction.itemId,
      transaction.date,
      transaction.authorizedDate,
      transaction.name,
      transaction.merchantName,
      transaction.amount,
      transaction.currency,
      transaction.pending,
      transaction.category,
      transaction.removedAt,
      JSON.stringify(transaction.raw),
    ],
  );
}

export async function markTransactionRemoved(
  pool: Pool,
  transactionId: string,
): Promise<void> {
  await pool.query(
    `UPDATE kith.plaid_transactions
        SET removed_at = transaction_timestamp(),
            updated_at = transaction_timestamp()
      WHERE transaction_id = $1`,
    [transactionId],
  );
}

export async function upsertInvestmentTransaction(
  pool: Pool,
  transaction: PlaidInvestmentTransactionRow,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.plaid_investment_transactions
       (investment_transaction_id, account_id, item_id, security_id, date,
        name, quantity, price, amount, fees, type, subtype, currency, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (investment_transaction_id) DO UPDATE
       SET quantity = EXCLUDED.quantity,
           price = EXCLUDED.price,
           amount = EXCLUDED.amount,
           fees = EXCLUDED.fees,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           currency = EXCLUDED.currency,
           raw = EXCLUDED.raw,
           updated_at = transaction_timestamp()`,
    [
      transaction.investmentTransactionId,
      transaction.accountId,
      transaction.itemId,
      transaction.securityId,
      transaction.date,
      transaction.name,
      transaction.quantity,
      transaction.price,
      transaction.amount,
      transaction.fees,
      transaction.type,
      transaction.subtype,
      transaction.currency,
      JSON.stringify(transaction.raw),
    ],
  );
}
