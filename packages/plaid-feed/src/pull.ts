// `kith-plaid-feed pull`: one round over every linked item.
//
// For each item: read its access token from the Keychain, fetch balances
// (required), then fetch holdings, a transactions-sync page and investment
// transactions -- the full 24-month history Plaid allows on a first pull for
// this item, then just the window since the last pull (see
// mapping.ts's investmentTransactionsStartDate). `link` only requires the
// `transactions` product
// (`investments` is optional there, so depository-only institutions like
// Chase are still offered), so the holdings and investment-transactions
// calls are skipped outright -- not a failure -- for an item whose consented
// products do not include `investments`; an item that did consent but still
// has no investment accounts reports PRODUCTS_NOT_SUPPORTED, which is also
// not a failure. `ITEM_LOGIN_REQUIRED`, from any call, ends that item's pull
// immediately, marks `needs_relink_at`, and is never retried in this
// process. Every other unexpected error also ends that item's pull and is
// reported, but does not touch `needs_relink_at`.
//
// A single security or holding row's own upsert failing (for example a
// value shaped in a way the schema still rejects) does not end the item's
// pull either: it is counted in `rowFailures` and the rest of that item --
// including transactions, fetched after holdings -- is still attempted and
// still written.
//
// Nothing here prints a balance, a holding value, or a transaction amount --
// only counts -- and the process exits non-zero when any item failed or had
// a row failure, which is what makes a launchd job's exit status
// meaningful.

import type { Pool } from "pg";
import { Products, type PlaidApi } from "plaid";

import { loadDatabaseUrl, loadPlaidCredentials } from "./config.js";
import {
  listPlaidItems,
  openPool,
  recordInvestmentTransactionsPulledThrough,
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
  investmentTransactionsStartDate,
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

/** Guards against an unbounded loop if Plaid's pagination never terminates. */
const MAX_SYNC_PAGES = 50;
/**
 * A first pull's full 24-month window can need more pages than an
 * incremental one; generous enough for 50,000 investment transactions at
 * Plaid's maximum page size below, well beyond a household's real volume.
 */
const MAX_INVESTMENT_TRANSACTION_PAGES = 100;
/** Plaid's documented maximum `count` per `/investments/transactions/get` page. */
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
  /**
   * Security or holding rows whose own upsert failed (for example the
   * `plaid_securities_currency_check` violation a real pull hit) but did not
   * abort the rest of this item's pull. Counts only -- never a security's
   * name or values -- exactly like every other field here.
   */
  rowFailures: number;
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
      // A row-level failure keeps the item's own status "ok" (balances and
      // transactions still wrote fine), but must still fail the process's
      // exit code -- the same reason `status !== "ok"` does -- so a
      // launchd job or any other monitor reading the exit status notices.
      anyFailed: results.some(
        (result) => result.status !== "ok" || result.rowFailures > 0,
      ),
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
    `row_failures=${result.rowFailures}`,
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
    rowFailures: 0,
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
  // the item's pull. `link` only requires `transactions` and offers
  // `investments` as optional (PLAID-1's product change: requiring both
  // excluded depository-only institutions like Chase from Link's picker), so
  // an item's own consented products decide whether the investments calls
  // below are worth attempting at all.
  let investmentsConsented = true;
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
    const products =
      response.data.item?.consented_products ?? response.data.item?.products;
    // `undefined` (an older item Plaid reports no product list for) leaves
    // `investmentsConsented` at its default of `true`: attempt the call and
    // let the existing PRODUCTS_NOT_SUPPORTED tolerance below cover it,
    // rather than guessing the item has no holdings.
    if (products !== undefined) {
      investmentsConsented = products.includes(Products.Investments);
    }
  } catch (error) {
    return await failItem(pool, item, result, error);
  }

  // Holdings: skipped outright for an item that never consented to
  // `investments` (expected for Chase) -- not a failure. Otherwise
  // best-effort: an item that did consent but simply has no investment
  // accounts still reports PRODUCTS_NOT_SUPPORTED here, which is also not a
  // failure.
  if (investmentsConsented) {
    try {
      const response = await client.investmentsHoldingsGet({
        access_token: accessToken,
      });
      // A single security or holding row failing its own upsert (for
      // example the currency check a real pull hit) must not abort this
      // item's pull: catch per row, count it, and keep going so the rest of
      // this institution's securities/holdings, and everything after this
      // block (transactions), still get written.
      for (const security of response.data.securities) {
        try {
          await upsertSecurity(pool, mapSecurity(security));
        } catch {
          result.rowFailures += 1;
        }
      }
      for (const account of response.data.accounts) {
        await upsertAccount(pool, mapAccount(account, item.itemId));
      }
      for (const holding of response.data.holdings) {
        try {
          await upsertHoldingSnapshot(pool, mapHoldingSnapshot(holding, asOf));
          result.holdings += 1;
        } catch {
          result.rowFailures += 1;
        }
      }
    } catch (error) {
      if (isItemLoginRequired(error)) return await failItem(pool, item, result, error);
      if (!isProductNotSupported(error)) return await failItem(pool, item, result, error);
    }
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

  // Investment transactions: the full 24-month window Plaid allows when
  // this item has never had investment transactions pulled, otherwise just
  // the incremental window since the last pull (with a 7-day overlap for
  // late postings) -- see mapping.ts's investmentTransactionsStartDate and
  // migration 045. Skipped for the same reason holdings is, otherwise
  // best-effort and paginated.
  if (investmentsConsented) {
    try {
      const end = asOf;
      const startDate = investmentTransactionsStartDate(
        item.investmentTransactionsPulledThrough,
        asOf,
      );
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
        // Same per-row isolation as the holdings block above: this page's
        // securities are a cache refresh, not the point of this call, and
        // one failing row must not cost the investment-transaction pages
        // still to come.
        for (const security of response.data.securities) {
          try {
            await upsertSecurity(pool, mapSecurity(security));
          } catch {
            result.rowFailures += 1;
          }
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
      // Only reached once every page of this window was fetched without
      // throwing: a page that fails partway through must not advance the
      // watermark past transactions this pull never actually saw.
      await recordInvestmentTransactionsPulledThrough(pool, item.itemId, end);
    } catch (error) {
      if (isItemLoginRequired(error)) return await failItem(pool, item, result, error);
      if (!isProductNotSupported(error)) return await failItem(pool, item, result, error);
    }
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
