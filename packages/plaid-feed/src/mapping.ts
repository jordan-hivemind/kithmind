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
  // FIN-1: `kith.fin_accounts.institution_name` is denormalized onto the
  // account row rather than joined from `kith.plaid_items` at read time
  // (migration 048 dropped the account-level Plaid table that join used to
  // go through), so the mapper needs it from the item its caller already has.
  institutionName: string;
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
 * A `date` column's value as `pg` actually hands it back when a caller did
 * not read it `::text`: node-postgres's default type parser for OID 1082
 * (`date`) returns a JS `Date`, not a string, even though this package's own
 * row types say `string`. A live pull after PR 428 hit this directly --
 * `kith.plaid_items.investment_transactions_pulled_through` came back as a
 * `Date`, `` `${pulledThrough}T00:00:00Z` `` built on its default
 * `toString()` was not a parseable timestamp, and the resulting `Invalid
 * Date` threw "Invalid time value" the first time anything tried to read it
 * (here, `toISOString()`). `db.ts` now reads that column `::text` so this
 * should not happen again, but this normalizes defensively too: a `Date` is
 * converted with its own UTC getters (never `toString()`/`toISOString()`,
 * which shift by the runtime's timezone or are exactly what broke above)
 * rather than trusted to already be the `YYYY-MM-DD` string the type says.
 */
function isoDateOnly(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The `start_date` for `/investments/transactions/get`: the full 24-month
 * window Plaid allows when `pulledThrough` is `null` (this item has never
 * had investment transactions pulled), otherwise `pulledThrough` minus a
 * 7-day overlap so a transaction that posts late is not missed.
 *
 * `pulledThrough` accepts a `Date` as well as a `string` -- see
 * `isoDateOnly` above -- so a caller that forgot to read the column `::text`
 * degrades to a normalized value instead of building an Invalid Date.
 */
export function investmentTransactionsStartDate(
  pulledThrough: string | Date | null,
  asOf: string,
): string {
  if (pulledThrough === null) {
    const start = new Date(Date.parse(`${asOf}T00:00:00Z`));
    start.setUTCMonth(
      start.getUTCMonth() - INVESTMENT_TRANSACTIONS_FULL_HISTORY_MONTHS,
    );
    return start.toISOString().slice(0, 10);
  }
  const start = new Date(
    Date.parse(`${isoDateOnly(pulledThrough)}T00:00:00Z`),
  );
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

/**
 * Plaid's optional strings -- subtype, type, name, merchant_name, category,
 * official_name, mask, ticker_symbol and similar -- sometimes arrive as an
 * empty string, or some other shape than a string at all, rather than
 * omitted. Trimmed, with an empty result (after trimming) mapped to `null`,
 * and anything that is not actually a string degrading to `null` instead of
 * throwing. Migration `047_plaid_strings.sql` relaxed every bounded-length
 * CHECK on these columns to accept an empty string too, but there is no
 * reason to store one when `null` already means "Plaid did not provide
 * this" -- and normalizing here, not just relaxing the CHECK, is what keeps
 * a value like `String(undefined)` ("undefined") from ever reaching the
 * database in the first place (PLAID-2's `type`/`subtype` coercion on
 * investment transactions did exactly that).
 */
export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mapAccount(
  account: AccountBase | InvestmentAccount,
  itemId: string,
  institutionName: string,
): PlaidAccountRow {
  return {
    accountId: account.account_id,
    itemId,
    institutionName,
    name: account.name,
    officialName: normalizeOptionalString(account.official_name),
    mask: normalizeOptionalString(account.mask),
    type: String(account.type),
    subtype: normalizeOptionalString(account.subtype),
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
    name: normalizeOptionalString(security.name),
    tickerSymbol: normalizeOptionalString(security.ticker_symbol),
    type: normalizeOptionalString(security.type),
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
    name: normalizeOptionalString(transaction.name),
    merchantName: normalizeOptionalString(transaction.merchant_name),
    amount: transaction.amount,
    currency: mapCurrency(
      transaction.iso_currency_code,
      transaction.unofficial_currency_code,
    ),
    pending: transaction.pending,
    category: normalizeOptionalString(
      transaction.personal_finance_category?.primary,
    ),
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
    name: normalizeOptionalString(transaction.name),
    quantity: transaction.quantity,
    price: transaction.price,
    amount: transaction.amount,
    fees: transaction.fees,
    type: normalizeOptionalString(transaction.type),
    subtype: normalizeOptionalString(transaction.subtype),
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
