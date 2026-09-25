// Display formatting shared by the app pages' tables.

/** `credit_line` to `Credit Line`, for labels shown to people. */
export function label(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** A date as `9-26-2026`, or empty for none. Uses UTC so it is stable across
 * the client and server render boundary. */
export function shortDate(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const date = new Date(value);
  return `${date.getUTCMonth() + 1}-${date.getUTCDate()}-${date.getUTCFullYear()}`;
}

/** A date-only archive value without timezone conversion. */
export function archiveDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const [year, month, day] = value.slice(0, 10).split("-");
  if (year === undefined || month === undefined || day === undefined)
    return value;
  return `${Number(month)}-${Number(day)}-${year}`;
}

/** A table timestamp as `9-26-2026 2:05 PM`, or empty for none. */
export function tableDateTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const date = new Date(value);
  const hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${shortDate(value)} ${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

/** Integer values in tables use separators and stable tabular figures. */
export function tableInteger(value: number | null | undefined): string {
  return value === null || value === undefined
    ? ""
    : value.toLocaleString("en-US");
}

/** Add grouping to an exact decimal string without converting it to a JS
 * number, which would lose precision for money and account values. */
export function tableDecimal(value: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value);
  if (match === null) return value;
  const [, sign = "", whole = "", fraction = ""] = match;
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction}`;
}

/** Whole units in the amount's own currency; no figure is converted. */
export function tableMoney(amount: number, currency: string): string {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol =
    formatter.formatToParts(amount).find((part) => part.type === "currency")
      ?.value ?? currency;
  const numeric = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${symbol} ${numeric}`;
}

/**
 * `tableMoney`, with the sign flipped first when `negate` is true -- for a
 * liability balance (a credit card or loan's `current`) that Plaid and the
 * archive both store as a positive "amount owed": negating it before display
 * is what makes it read as owed rather than as a positive asset value, the
 * Banking & Cards screen's own convention for its credit and loan rows.
 */
export function signedTableMoney(
  amount: number,
  currency: string,
  negate: boolean,
): string {
  return tableMoney(negate ? -amount : amount, currency);
}

/** A ratio as a whole-number percent, e.g. `tablePercent(250, 1000)` is
 * `"25%"` -- a credit account's utilization against its limit. Empty (never
 * `"0%"` or `"Infinity%"`) when there is nothing to divide by. */
export function tablePercent(numerator: number, denominator: number): string {
  if (denominator === 0) return "";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

/** Exact-decimal accounting money for authoritative values from the store. */
export function tableAccountingMoney(value: string, currency = "USD"): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) return value;
  const [, sign, whole, fraction = ""] = match;
  const cents = `${fraction}00`.slice(0, 2);
  const formatted = tableDecimal(`${whole}.${cents}`);
  const symbol =
    new Intl.NumberFormat("en-US", { style: "currency", currency })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency;
  return sign === "-" ? `(${symbol} ${formatted})` : `${symbol} ${formatted}`;
}
