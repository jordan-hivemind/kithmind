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
    currency:
      account.balances.iso_currency_code ??
      account.balances.unofficial_currency_code ??
      null,
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
    currency:
      account.balances.iso_currency_code ??
      account.balances.unofficial_currency_code ??
      null,
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
    currency: security.iso_currency_code ?? security.unofficial_currency_code ?? null,
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
    currency: holding.iso_currency_code ?? holding.unofficial_currency_code ?? null,
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
    currency:
      transaction.iso_currency_code ??
      transaction.unofficial_currency_code ??
      null,
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
    currency:
      transaction.iso_currency_code ??
      transaction.unofficial_currency_code ??
      null,
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
