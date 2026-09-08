// describe_schema: table and column documentation, plus the money, currency
// and valuation-basis policy an assistant needs before writing SQL for
// run_query. Table and column names, types and nullability come from the
// live file itself (PRAGMA table_info) so this can never drift from what
// actually shipped; only the human-meaning notes below are hand-authored.

import type { DatabaseSync } from "node:sqlite";

import { CURRENCY_EXPONENTS } from "../money.js";

const TABLE_NOTES: Readonly<Record<string, string>> = Object.freeze({
  institutions: "One row per financial institution.",
  accounts:
    "One row per account. Only the last four digits of an account number are ever stored, in acct_last4.",
  instruments:
    "Securities and other holdings referenced by transactions and positions.",
  transactions:
    "The ledger. amount is INTEGER minor units; quantity, price, fx_rate and running_balance are canonical decimal TEXT. row_hash is the deduplication key.",
  positions:
    "Point-in-time holdings. valuation_basis says what market_value means; mixing bases in a total silently overstates or understates it.",
  balances: "Point-in-time account totals, used by the reconciliation gate.",
  liabilities: "What is owed: loans, margin balances and similar.",
  commitments:
    "Committed, called, outstanding and distributed capital for fund-style investments. Not a transaction and has no ledger representation.",
  documents:
    "Source documents. sha256 is the content hash; text_path is the retained extracted text get_evidence points at.",
  import_runs:
    "One row per importer run: files seen, rows inserted or skipped, reconciliations passed or failed, review items opened.",
  reconciliations:
    "Per account and period: expected vs. computed change and pass/fail/unverified status. A period without a passing row here is not verified.",
  review_items:
    "Ambiguous or out-of-range values a person or agent must judge. status is open, resolved or dismissed.",
});

const COLUMN_NOTES: Readonly<Record<string, string>> = Object.freeze({
  "transactions.amount":
    "INTEGER minor units. Never coerce to a JS number; sum it in SQL and read the result as an exact integer or string.",
  "transactions.row_hash": "UNIQUE. The deduplication key.",
  "transactions.currency":
    "ISO 4217. Totals must group by currency; never sum across currencies.",
  "positions.valuation_basis":
    "market_price | last_round | cost | reported_nav. See valuationBasisMeanings in this response.",
  "documents.sha256": "Content hash of the source document, 64 hex characters.",
  "documents.text_path":
    "Path to the retained extracted text this row's evidence comes from.",
  "documents.file_path": "Path to the raw acquired file in the local raw tree.",
  "reconciliations.status": "pass | fail | unverified.",
  "reconciliations.tolerance":
    "INTEGER minor units. The gate's tolerance for this period, recorded even when it passed.",
  "review_items.status": "open | resolved | dismissed.",
});

const MONEY_POLICY =
  "Cash amounts (transactions.amount, positions.market_value/cost_basis/unrealized, " +
  "balances.total_value/cash/period_start_value/period_end_value, liabilities.balance, " +
  "reconciliations.expected_change/computed_change/delta/tolerance, commitments.committed/" +
  "called/outstanding/distributed/committed_original) are stored as INTEGER minor units at the " +
  "row's own currency exponent, so SUM(...) is exact with no binary float anywhere in the path. " +
  "Quantities, prices, rates and running balances (transactions.quantity/price/fx_rate/" +
  "running_balance, positions.quantity/price, liabilities.rate, commitments.fx_rate) are " +
  "multiplied and compared, never aggregated, and are canonical base-10 decimal TEXT instead. " +
  "No rounding happens on ingest: a value with more precision than its currency allows is stored " +
  "as NULL with a review_items row, never rounded into place.";

const CURRENCY_POLICY =
  "Every money column carries a currency and totals must group by currency; no implicit " +
  "conversion is ever performed. The minor-unit exponent for a currency is fixed and closed -- " +
  "an unlisted currency is a hard error rather than an assumed 2, because assuming 2 for a " +
  "0-exponent currency like JPY is exactly the bug this table exists to prevent.";

const VALUATION_BASIS_MEANINGS: Readonly<Record<string, string>> =
  Object.freeze({
    market_price: "Current tradable market price.",
    last_round:
      "Last priced funding round, for an illiquid or private holding.",
    cost: "Carried at cost; no independent valuation is available.",
    reported_nav: "Net asset value as reported by the fund or manager.",
  });

export type SchemaColumn = {
  name: string;
  type: string | null;
  notNull: boolean;
  primaryKey: boolean;
  note: string | null;
};

export type SchemaTable = {
  name: string;
  note: string;
  columns: SchemaColumn[];
};

export type SchemaDoc = {
  tables: SchemaTable[];
  moneyPolicy: string;
  currencyPolicy: {
    note: string;
    minorUnitExponents: Readonly<Record<string, number>>;
  };
  valuationBasisMeanings: Readonly<Record<string, string>>;
};

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function describeSchema(db: DatabaseSync): SchemaDoc {
  const tableNames = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

  const tables: SchemaTable[] = tableNames.map((name) => {
    const columns = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
      .all() as { name: string; type: string; notnull: number; pk: number }[];
    return {
      name,
      note: TABLE_NOTES[name] ?? "",
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type || null,
        notNull: column.notnull === 1,
        primaryKey: column.pk > 0,
        note: COLUMN_NOTES[`${name}.${column.name}`] ?? null,
      })),
    };
  });

  return {
    tables,
    moneyPolicy: MONEY_POLICY,
    currencyPolicy: {
      note: CURRENCY_POLICY,
      minorUnitExponents: CURRENCY_EXPONENTS,
    },
    valuationBasisMeanings: VALUATION_BASIS_MEANINGS,
  };
}
