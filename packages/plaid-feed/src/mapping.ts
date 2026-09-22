// Pure mapping from Plaid API response shapes to this package's row shapes.
// No network, no database, no Keychain: `pull.ts` calls these against what
// the Plaid client returned, which is what makes them unit-testable against
// fixtures shaped like Plaid's own responses.

import type {
  AccountBase,
  Holding,
  InvestmentAccount,
  InvestmentTransaction,
  RemovedTransaction,
  Security,
  Transaction,
} from "plaid";

export type PlaidAccountRow = {
  accountId: string;
  itemId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string | null;
};

export type PlaidBalanceSnapshotInput = {
  accountId: string;
  asOf: string;
  current: number | null;
  available: number | null;
  limitAmount: number | null;
  currency: string | null;
  raw: unknown;
};

export type PlaidSecurityRow = {
  securityId: string;
  name: string | null;
  tickerSymbol: string | null;
  type: string | null;
  closePrice: number | null;
  closePriceAsOf: string | null;
  currency: string | null;
};

export type PlaidHoldingSnapshotInput = {
  accountId: string;
  securityId: string;
  asOf: string;
  quantity: number | null;
  price: number | null;
  value: number | null;
  costBasis: number | null;
  currency: string | null;
  raw: unknown;
};

export type PlaidTransactionRow = {
  transactionId: string;
  accountId: string;
  itemId: string;
  date: string | null;
  authorizedDate: string | null;
  name: string | null;
  merchantName: string | null;
  amount: number | null;
  currency: string | null;
  pending: boolean;
  category: string | null;
  removedAt: string | null;
  raw: unknown;
};

export type PlaidInvestmentTransactionRow = {
  investmentTransactionId: string;
  accountId: string;
  itemId: string;
  securityId: string | null;
  date: string;
  name: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fees: number | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  raw: unknown;
};

/** Today, as the `YYYY-MM-DD` a snapshot's `as_of` column expects. */
export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Plaid keeps up to 24 months of investment transactions before an Item was
 * linked, available via `/investments/transactions/get`'s `start_date`. This
 * is the full window a first pull requests for an item that has never had
 * investment transactions pulled.
 */
export const INVESTMENT_TRANSACTIONS_FULL_HISTORY_MONTHS = 24;

/**
 * Every later pull re-requests from the item's stored watermark minus this
 * many days, to catch transactions that post a few days after their own
 * dated day.
 */
export const INVESTMENT_TRANSACTIONS_INCREMENTAL_OVERLAP_DAYS = 7;

/**
 * The `start_date` for `/investments/transactions/get`: the full 24-month
 * window Plaid allows when `pulledThrough` is `null` (this item has never
 * had investment transactions pulled), otherwise `pulledThrough` minus a
 * 7-day overlap so a transaction that posts late is not missed.
 */
export function investmentTransactionsStartDate(
  pulledThrough: string | null,
  asOf: string,
): string {
  if (pulledThrough === null) {
    const start = new Date(Date.parse(`${asOf}T00:00:00Z`));
    start.setUTCMonth(
      start.getUTCMonth() - INVESTMENT_TRANSACTIONS_FULL_HISTORY_MONTHS,
    );
    return start.toISOString().slice(0, 10);
  }
  const start = new Date(Date.parse(`${pulledThrough}T00:00:00Z`));
  start.setUTCDate(
    start.getUTCDate() - INVESTMENT_TRANSACTIONS_INCREMENTAL_OVERLAP_DAYS,
  );
  return start.toISOString().slice(0, 10);
}

/**
 * Plaid's ISO currency code when present, otherwise its unofficial one --
 * a crypto ticker, or a code longer than three letters -- trimmed and
 * uppercased, or `null` when neither is present. Migration
 * 044_plaid_currency.sql relaxed every `currency` CHECK from an ISO-4217
 * shape (`^[A-Z]{3}$`) to a bounded length specifically so this value is
 * never rejected: the first real pull hit an institution whose securities
 * carried a null `iso_currency_code` with an `unofficial_currency_code`,
 * and the old regex aborted the whole item's pull partway through.
 *
 * Guarded with `typeof` rather than trusting the Plaid SDK's types, so an
 * unexpected shape (not a string) degrades to `null` instead of throwing.
 */
export function mapCurrency(
  isoCurrencyCode: string | null | undefined,
  unofficialCurrencyCode: string | null | undefined,
): string | null {
  const code = isoCurrencyCode ?? unofficialCurrencyCode ?? null;
  if (typeof code !== "string") return null;
  const normalized = code.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function mapAccount(
  account: AccountBase | InvestmentAccount,
  itemId: string,
): PlaidAccountRow {
  return {
    accountId: account.account_id,
    itemId,
    name: account.name,
    officialName: account.official_name,
    mask: account.mask,
    type: String(account.type),
    subtype: account.subtype === null ? null : String(account.subtype),
    currency: mapCurrency(
      account.balances.iso_currency_code,
      account.balances.unofficial_currency_code,
    ),
  };
}

export function mapBalanceSnapshot(
  account: AccountBase | InvestmentAccount,
  asOf: string,
): PlaidBalanceSnapshotInput {
  return {
    accountId: account.account_id,
    asOf,
    current: account.balances.current,
    available: account.balances.available,
    limitAmount: account.balances.limit,
    currency: mapCurrency(
      account.balances.iso_currency_code,
      account.balances.unofficial_currency_code,
    ),
    raw: account,
  };
}

export function mapSecurity(security: Security): PlaidSecurityRow {
  return {
    securityId: security.security_id,
    name: security.name,
    tickerSymbol: security.ticker_symbol,
    type: security.type,
    closePrice: security.close_price,
    closePriceAsOf: security.close_price_as_of,
    currency: mapCurrency(security.iso_currency_code, security.unofficial_currency_code),
  };
}

export function mapHoldingSnapshot(
  holding: Holding,
  asOf: string,
): PlaidHoldingSnapshotInput {
  return {
    accountId: holding.account_id,
    securityId: holding.security_id,
    asOf,
    quantity: holding.quantity,
    price: holding.institution_price,
    value: holding.institution_value,
    costBasis: holding.cost_basis,
    currency: mapCurrency(holding.iso_currency_code, holding.unofficial_currency_code),
    raw: holding,
  };
}

export function mapTransaction(
  transaction: Transaction,
  itemId: string,
): PlaidTransactionRow {
  return {
    transactionId: transaction.transaction_id,
    accountId: transaction.account_id,
    itemId,
    date: transaction.date,
    authorizedDate: transaction.authorized_date,
    name: transaction.name,
    merchantName: transaction.merchant_name ?? null,
    amount: transaction.amount,
    currency: mapCurrency(
      transaction.iso_currency_code,
      transaction.unofficial_currency_code,
    ),
    pending: transaction.pending,
    category: transaction.personal_finance_category?.primary ?? null,
    removedAt: null,
    raw: transaction,
  };
}

export function mapRemovedTransactionId(removed: RemovedTransaction): string {
  return removed.transaction_id;
}

export function mapInvestmentTransaction(
  transaction: InvestmentTransaction,
  itemId: string,
): PlaidInvestmentTransactionRow {
  return {
    investmentTransactionId: transaction.investment_transaction_id,
    accountId: transaction.account_id,
    itemId,
    securityId: transaction.security_id,
    date: transaction.date,
    name: transaction.name,
    quantity: transaction.quantity,
    price: transaction.price,
    amount: transaction.amount,
    fees: transaction.fees,
    type: String(transaction.type),
    subtype: String(transaction.subtype),
    currency: mapCurrency(
      transaction.iso_currency_code,
      transaction.unofficial_currency_code,
    ),
    raw: transaction,
  };
}

/** The Plaid error code an axios-style error response carries, or null. */
export function plaidErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const response = (error as { response?: { data?: unknown } }).response;
  const data = response?.data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { error_code?: unknown }).error_code;
  return typeof code === "string" ? code : null;
}

export function isItemLoginRequired(error: unknown): boolean {
  return plaidErrorCode(error) === "ITEM_LOGIN_REQUIRED";
}

/**
 * The item exists and is healthy, but this institution's connection does not
 * support the product just called (for example `/investments/holdings/get`
 * against a Chase checking-only item). Not a failure worth alerting on: the
 * pull reports zero for that product and moves on.
 */
export function isProductNotSupported(error: unknown): boolean {
  const code = plaidErrorCode(error);
  return code === "PRODUCTS_NOT_SUPPORTED" || code === "NO_INVESTMENT_ACCOUNTS";
}
