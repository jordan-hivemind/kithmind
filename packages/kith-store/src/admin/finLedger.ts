// FIN-1's unified ledger read: `kith.fin_transactions` and
// `kith.fin_holding_snapshots` (migration 048_finance_unify.sql) already
// hold both the archive's and the Plaid feed's rows, tagged `source`, so
// this is one indexed query per read rather than a merge of two sources at
// read time -- the whole point of the owner's "build one ledger" direction.
//
// `fin_transactions_account_date_idx (account_id, date DESC)` and
// `fin_holding_snapshots_account_idx (account_id, as_of DESC)` back both
// queries below; neither does a sequential scan for a single account, which
// is what keeps this under the 5-second statement budget.

import { ProofError } from "../errors.js";
import { rows, type IdentityCtx } from "../identity/db.js";

export type LedgerRow = {
  id: string;
  accountId: string;
  date: string;
  postedDate: string | null;
  kind: string;
  description: string | null;
  amount: number | null;
  quantity: number | null;
  price: number | null;
  fees: number | null;
  securityId: string | null;
  securityTicker: string | null;
  currency: string | null;
  pending: boolean;
  source: "archive" | "plaid";
};

export type ListLedgerParams = {
  accountId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

export type ListLedgerResult = {
  rows: LedgerRow[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Opaque cursor: base64 of `date|id`, the same keyset pagination shape
 * `(date DESC, id DESC)` orders by. Exported only within this module --
 * callers treat it as opaque, matching every other cursor in this package. */
function encodeCursor(row: { date: string; id: string }): string {
  return Buffer.from(`${row.date}|${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { date: string; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ProofError("invalid_cursor");
  }
  const separator = decoded.indexOf("|");
  if (separator < 0) throw new ProofError("invalid_cursor");
  const date = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (date === "" || id === "") throw new ProofError("invalid_cursor");
  return { date, id };
}

/**
 * One account's (or, with no `accountId`, every account's) unified
 * transaction stream, newest first. `from`/`to` bound `date` inclusively.
 * `limit` is clamped to `MAX_LIMIT`; a page short of `limit` rows means
 * there is no next page and `nextCursor` is `null`.
 */
export async function listLedger(
  ctx: IdentityCtx,
  params: ListLedgerParams = {},
): Promise<ListLedgerResult> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = params.cursor === undefined ? null : decodeCursor(params.cursor);

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.accountId !== undefined) {
    values.push(params.accountId);
    conditions.push(`t.account_id = $${values.length}`);
  }
  if (params.from !== undefined) {
    values.push(params.from);
    conditions.push(`t.date >= $${values.length}`);
  }
  if (params.to !== undefined) {
    values.push(params.to);
    conditions.push(`t.date <= $${values.length}`);
  }
  if (cursor !== null) {
    values.push(cursor.date, cursor.id);
    conditions.push(
      `(t.date, t.id) < ($${values.length - 1}::date, $${values.length})`,
    );
  }
  values.push(limit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const found = await rows<{
    id: string;
    account_id: string;
    date: string;
    posted_date: string | null;
    kind: string;
    description: string | null;
    amount: string | null;
    quantity: string | null;
    price: string | null;
    fees: string | null;
    security_id: string | null;
    security_ticker: string | null;
    currency: string | null;
    pending: boolean;
    source: "archive" | "plaid";
  }>(
    ctx,
    `SELECT t.id, t.account_id, t.date::text AS date,
            t.posted_date::text AS posted_date, t.kind, t.description,
            t.amount, t.quantity, t.price, t.fees, t.security_id,
            s.ticker AS security_ticker, t.currency, t.pending, t.source
       FROM kith.fin_transactions t
       LEFT JOIN kith.fin_securities s ON s.id = t.security_id
       ${where}
      ORDER BY t.date DESC, t.id DESC
      LIMIT $${values.length}`,
    values,
  );

  const ledgerRows = found.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    date: row.date,
    postedDate: row.posted_date,
    kind: row.kind,
    description: row.description,
    amount: row.amount === null ? null : Number(row.amount),
    quantity: row.quantity === null ? null : Number(row.quantity),
    price: row.price === null ? null : Number(row.price),
    fees: row.fees === null ? null : Number(row.fees),
    securityId: row.security_id,
    securityTicker: row.security_ticker,
    currency: row.currency,
    pending: row.pending,
    source: row.source,
  }));

  const nextCursor =
    ledgerRows.length < limit
      ? null
      : encodeCursor(ledgerRows[ledgerRows.length - 1]!);

  return { rows: ledgerRows, nextCursor };
}

export type HoldingRow = {
  accountId: string;
  securityId: string;
  securityName: string | null;
  securityTicker: string | null;
  asOf: string;
  quantity: number | null;
  price: number | null;
  value: number | null;
  costBasis: number | null;
  currency: string | null;
  source: "archive" | "plaid";
};

export type ListHoldingsParams = {
  accountId?: string;
  asOf?: string;
};

/**
 * The latest holdings snapshot per (account, security) as of `asOf`
 * (default: each one's own latest), across both sources.
 */
export async function listHoldings(
  ctx: IdentityCtx,
  params: ListHoldingsParams = {},
): Promise<HoldingRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.accountId !== undefined) {
    values.push(params.accountId);
    conditions.push(`h.account_id = $${values.length}`);
  }
  if (params.asOf !== undefined) {
    values.push(params.asOf);
    conditions.push(`h.as_of <= $${values.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const found = await rows<{
    account_id: string;
    security_id: string;
    security_name: string | null;
    security_ticker: string | null;
    as_of: string;
    quantity: string | null;
    price: string | null;
    value: string | null;
    cost_basis: string | null;
    currency: string | null;
    source: "archive" | "plaid";
  }>(
    ctx,
    `SELECT DISTINCT ON (h.account_id, h.security_id)
            h.account_id, h.security_id, s.name AS security_name,
            s.ticker AS security_ticker, h.as_of::text AS as_of, h.quantity,
            h.price, h.value, h.cost_basis, h.currency, h.source
       FROM kith.fin_holding_snapshots h
       LEFT JOIN kith.fin_securities s ON s.id = h.security_id
       ${where}
      ORDER BY h.account_id, h.security_id, h.as_of DESC`,
    values,
  );

  return found.map((row) => ({
    accountId: row.account_id,
    securityId: row.security_id,
    securityName: row.security_name,
    securityTicker: row.security_ticker,
    asOf: row.as_of,
    quantity: row.quantity === null ? null : Number(row.quantity),
    price: row.price === null ? null : Number(row.price),
    value: row.value === null ? null : Number(row.value),
    costBasis: row.cost_basis === null ? null : Number(row.cost_basis),
    currency: row.currency,
    source: row.source,
  }));
}
