// `kith-plaid-feed pull`: one round over every linked item.
//
// For each item: read its access token from the Keychain, fetch balances
// (required), then best-effort fetch holdings, a transactions-sync page and
// 30 days of investment transactions -- a product an institution does not
// support (Chase has no investments; some brokerages have no transactions)
// is reported as zero for that product, not a failure. `ITEM_LOGIN_REQUIRED`,
// from any call, ends that item's pull immediately, marks `needs_relink_at`,
// and is never retried in this process. Every other unexpected error also
// ends that item's pull and is reported, but does not touch `needs_relink_at`.
//
// Nothing here prints a balance, a holding value, or a transaction amount --
// only counts -- and the process exits non-zero when any item failed, which
// is what makes a launchd job's exit status meaningful.

import type { Pool } from "pg";
import type { PlaidApi } from "plaid";

import { loadDatabaseUrl, loadPlaidCredentials } from "./config.js";
import {
  listPlaidItems,
  openPool,
  recordPullFailure,
  recordPullSuccess,
  upsertAccount,
  upsertBalanceSnapshot,
  upsertHoldingSnapshot,
  upsertInvestmentTransaction,
  upsertSecurity,
  upsertTransaction,
  markTransactionRemoved,
  type PlaidItemRow,
} from "./db.js";
import { readKeychainSecret } from "./keychain.js";
import {
  isItemLoginRequired,
  isProductNotSupported,
  mapAccount,
  mapBalanceSnapshot,
  mapHoldingSnapshot,
  mapInvestmentTransaction,
  mapRemovedTransactionId,
  mapSecurity,
  mapTransaction,
  todayIsoDate,
} from "./mapping.js";
import { createPlaidClient } from "./plaidClient.js";

const INVESTMENT_TRANSACTIONS_LOOKBACK_DAYS = 30;
/** Guards against an unbounded loop if Plaid's pagination never terminates. */
const MAX_SYNC_PAGES = 50;
const MAX_INVESTMENT_TRANSACTION_PAGES = 20;
const INVESTMENT_TRANSACTIONS_PAGE_SIZE = 500;

export type ItemPullResult = {
  institutionName: string;
  status: "ok" | "needs_relink" | "failed";
  accounts: number;
  balances: number;
  holdings: number;
  transactionsAdded: number;
  transactionsModified: number;
  transactionsRemoved: number;
  investmentTransactions: number;
  error: string | null;
};

export async function pullAll(): Promise<{
  results: ItemPullResult[];
  anyFailed: boolean;
}> {
  const [credentials, databaseUrl] = await Promise.all([
    loadPlaidCredentials(),
    loadDatabaseUrl(),
  ]);
  const client = createPlaidClient(credentials);
  const pool = openPool(databaseUrl);
  try {
    const items = await listPlaidItems(pool);
    if (items.length === 0) {
      process.stdout.write("plaid pull: no linked items\n");
      return { results: [], anyFailed: false };
    }
    const results: ItemPullResult[] = [];
    for (const item of items) {
      const accessToken = await readKeychainSecret(item.keychainService);
      const result =
        accessToken === null
          ? await missingTokenResult(pool, item)
          : await pullItem(client, pool, item, accessToken);
      results.push(result);
      process.stdout.write(`${summaryLine(item, result)}\n`);
    }
    return {
      results,
      anyFailed: results.some((result) => result.status !== "ok"),
    };
  } finally {
    await pool.end();
  }
}

function summaryLine(item: PlaidItemRow, result: ItemPullResult): string {
  const parts = [
    `plaid pull item=${item.institutionId}`,
    `institution="${result.institutionName}"`,
    `status=${result.status}`,
    `accounts=${result.accounts}`,
    `balances=${result.balances}`,
    `holdings=${result.holdings}`,
    `tx_added=${result.transactionsAdded}`,
    `tx_modified=${result.transactionsModified}`,
    `tx_removed=${result.transactionsRemoved}`,
    `inv_tx=${result.investmentTransactions}`,
  ];
  if (result.error !== null) parts.push(`error=${JSON.stringify(result.error)}`);
  return parts.join(" ");
}

function emptyResult(item: PlaidItemRow): ItemPullResult {
  return {
    institutionName: item.institutionName,
    status: "ok",
    accounts: 0,
    balances: 0,
    holdings: 0,
    transactionsAdded: 0,
    transactionsModified: 0,
    transactionsRemoved: 0,
    investmentTransactions: 0,
    error: null,
  };
}

async function missingTokenResult(
  pool: Pool,
  item: PlaidItemRow,
): Promise<ItemPullResult> {
  const result = emptyResult(item);
  result.status = "failed";
  result.error = `Keychain item "${item.keychainService}" not found`;
  await recordPullFailure(pool, item.itemId, result.error, false);
  return result;
}

/**
 * One item's pull, given an already-resolved access token. Exported so a
 * test can drive it against a mocked Plaid client and a fake pool, without
 * touching the Keychain or a real database.
 */
export async function pullItem(
  client: PlaidApi,
  pool: Pool,
  item: PlaidItemRow,
  accessToken: string,
): Promise<ItemPullResult> {
  const result = emptyResult(item);
  const asOf = todayIsoDate();

  // Balances: required. A failure here (including ITEM_LOGIN_REQUIRED) ends
  // the item's pull.
  try {
    const response = await client.accountsBalanceGet({
      access_token: accessToken,
    });
    for (const account of response.data.accounts) {
      await upsertAccount(pool, mapAccount(account, item.itemId));
      await upsertBalanceSnapshot(pool, mapBalanceSnapshot(account, asOf));
      result.accounts += 1;
      result.balances += 1;
    }
  } catch (error) {
    return await failItem(pool, item, result, error);
  }

  // Holdings: best-effort. Institutions with no investment accounts (Chase)
  // report PRODUCTS_NOT_SUPPORTED here, which is not a failure.
  try {
    const response = await client.investmentsHoldingsGet({
      access_token: accessToken,
    });
    for (const security of response.data.securities) {
      await upsertSecurity(pool, mapSecurity(security));
    }
    for (const account of response.data.accounts) {
      await upsertAccount(pool, mapAccount(account, item.itemId));
    }
    for (const holding of response.data.holdings) {
      await upsertHoldingSnapshot(pool, mapHoldingSnapshot(holding, asOf));
      result.holdings += 1;
    }
  } catch (error) {
    if (isItemLoginRequired(error)) return await failItem(pool, item, result, error);
    if (!isProductNotSupported(error)) return await failItem(pool, item, result, error);
  }

  // Transactions sync: best-effort, cursor persisted per item.
  let cursor = item.transactionsCursor ?? undefined;
  try {
    let hasMore = true;
    let pages = 0;
    while (hasMore && pages < MAX_SYNC_PAGES) {
      pages += 1;
      const response = await client.transactionsSync({
        access_token: accessToken,
        cursor,
      });
      for (const account of response.data.accounts) {
        await upsertAccount(pool, mapAccount(account, item.itemId));
      }
      for (const transaction of response.data.added) {
        await upsertTransaction(pool, mapTransaction(transaction, item.itemId));
        result.transactionsAdded += 1;
      }
      for (const transaction of response.data.modified) {
        await upsertTransaction(pool, mapTransaction(transaction, item.itemId));
        result.transactionsModified += 1;
      }
      for (const removed of response.data.removed) {
        await markTransactionRemoved(pool, mapRemovedTransactionId(removed));
        result.transactionsRemoved += 1;
      }
      cursor = response.data.next_cursor;
      hasMore = response.data.has_more;
    }
  } catch (error) {
    if (isItemLoginRequired(error)) return await failItem(pool, item, result, error);
    if (!isProductNotSupported(error)) return await failItem(pool, item, result, error);
  }

  // Investment transactions for the last 30 days: best-effort, paginated.
  try {
    const end = asOf;
    const start = new Date(Date.parse(`${asOf}T00:00:00Z`));
    start.setUTCDate(start.getUTCDate() - INVESTMENT_TRANSACTIONS_LOOKBACK_DAYS);
    const startDate = start.toISOString().slice(0, 10);
    let offset = 0;
    let total = Infinity;
    let pages = 0;
    while (offset < total && pages < MAX_INVESTMENT_TRANSACTION_PAGES) {
      pages += 1;
      const response = await client.investmentsTransactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: end,
        options: {
          count: INVESTMENT_TRANSACTIONS_PAGE_SIZE,
          offset,
        },
      });
      for (const security of response.data.securities) {
        await upsertSecurity(pool, mapSecurity(security));
      }
      for (const transaction of response.data.investment_transactions) {
        await upsertInvestmentTransaction(
          pool,
          mapInvestmentTransaction(transaction, item.itemId),
        );
        result.investmentTransactions += 1;
      }
      total = response.data.total_investment_transactions;
      offset += response.data.investment_transactions.length;
      if (response.data.investment_transactions.length === 0) break;
    }
  } catch (error) {
    if (isItemLoginRequired(error)) return await failItem(pool, item, result, error);
    if (!isProductNotSupported(error)) return await failItem(pool, item, result, error);
  }

  await recordPullSuccess(pool, item.itemId, cursor ?? null);
  return result;
}

async function failItem(
  pool: Pool,
  item: PlaidItemRow,
  result: ItemPullResult,
  error: unknown,
): Promise<ItemPullResult> {
  const loginRequired = isItemLoginRequired(error);
  result.status = loginRequired ? "needs_relink" : "failed";
  result.error = errorMessage(error);
  await recordPullFailure(pool, item.itemId, result.error, loginRequired);
  return result;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
