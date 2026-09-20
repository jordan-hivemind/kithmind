// Screen 5 (Investments) of docs/plans/2026-09-18-admin-panel-and-ingestion.md,
// and the two MCP read tools section 11 accepts on.
//
// Two conventions meet in this file and it is worth saying which is which,
// because they look inconsistent until you know why.
//
//   * The reads (`listInvestments`, `getInvestment`, `suggestDocumentsForEntry`)
//     take an already-resolved space set, the way `documents.listSources` does.
//     They have two callers with two different notions of who may read: the
//     admin screen resolves through `getAdminSpaceIds` (owner or editor only,
//     see `model.ts`), and the MCP tools resolve through
//     `getAuthorizedReadSpaceIds`, which is what every other read tool uses, so
//     a `reader` member may ask Claude about the investments they can already
//     see in the app. Resolving inside the read would mean picking one of those
//     for both.
//   * The writes take a `Principal` and check `requireSpaceAccess(..., "write")`
//     against the space the row itself names, the way `upsertSourceRoot` does.
//     There is one notion of who may write and it is not the caller's to pass in.
//
// Money never becomes a JavaScript number anywhere below. `amount` and
// `exchange_rate` are `numeric`, node-pg hands them back as strings, every sum
// is `sum(...)::text` computed by PostgreSQL, and the only arithmetic this file
// performs is arithmetic it asks the database to perform. A `parseFloat` here
// would be a lost cent in a total the owner reads as exact.

import {
  type Principal,
  requireSpaceAccess,
} from "../identity/authorization.js";
import { exec, type IdentityCtx, row, rows } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId, newKithId } from "../ids.js";
import { resolveEntity } from "../memory/entities.js";
import { spacePredicate } from "../spaces.js";
import { setEntryDocument } from "./investmentLinks.js";
import {
  INVESTMENT_ENTRY_TYPES,
  INVESTMENT_STATUSES,
  type InvestmentEntry,
  type InvestmentEntryType,
  type InvestmentStatus,
} from "./model.js";

/** The owner tracks about 39 investments. The bound is for a runaway read. */
const MAX_INVESTMENTS = 500;

/**
 * One investment's entries. A capital call a month for twenty years fits.
 *
 * Per investment, not per screen: the screen loads an investment's entries
 * when the owner expands its row, so the bound is on one read of one
 * investment rather than on the household's whole history. A single list of
 * every entry was the earlier shape and would have started throwing on the
 * thousandth entry across all 39 investments, which is a failure the owner
 * would have had no way to clear.
 */
const MAX_ENTRIES = 1_000;

/** Investments whose entries one call may read. The screen asks for one. */
const MAX_ENTRY_INVESTMENTS = 25;

/** How many documents one suggestion call ranks and how many it returns. */
const MAX_SUGGESTION_CANDIDATES = 200;
const MAX_SUGGESTIONS = 10;

/** Section 6(a): a date this far from the entry's date still counts as near. */
export const SUGGESTION_DATE_WINDOW_DAYS = 45;

const NAME_MAX_CHARS = 200;
const NOTE_MAX_CHARS = 4_000;
const IMPORT_KEY_MAX_CHARS = 512;

/**
 * `numeric`, at most two decimal places more than money needs.
 *
 * The direction of an entry is its type, never the sign of its amount: a
 * distribution is a `distribution`, not a negative capital call, and a
 * negative capital call would subtract from `sent`.
 *
 * `commitment_change` is the one exception: reducing a commitment is a
 * genuinely signed quantity and there is no second entry type that means
 * "commitment went down". `investment_entries_amount_sign_check` in migration
 * 025 states the same rule in the schema, so a writer that bypasses this
 * module cannot store a negative capital call either.
 *
 * Both patterns exist because the two uses differ: an entry's amount is
 * parsed as signed and then judged against its type, while a document
 * suggestion's amount is a magnitude to look for in a document's text and is
 * never signed.
 */
const SIGNED_AMOUNT = /^-?\d{1,20}(\.\d{1,6})?$/;
const AMOUNT = /^\d{1,20}(\.\d{1,6})?$/;

/** The one entry type whose amount may be negative. */
const SIGNED_ENTRY_TYPE: InvestmentEntryType = "commitment_change";
const RATE = /^\d{1,10}(\.\d{1,10})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Per-currency totals, exact decimal strings, one row per currency used. */
export type CurrencyTotals = {
  currency: string;
  committed: string;
  sent: string;
  fees: string;
  received: string;
  /**
   * `committed - sent`, signed.
   *
   * Signed rather than floored at zero, because flooring hides an over-call:
   * an investment that has taken more money than it was committed is the one
   * case the owner most needs to see, and "0 outstanding" is what a fully
   * called fund looks like too. A negative outstanding reads as "they have
   * called more than I committed", and `overCalled` states the same fact as a
   * positive number for a caller that would rather not reason about the sign.
   */
  outstanding: string;
  /** `greatest(sent - committed, 0)`. Zero unless the fund over-called. */
  overCalled: string;
};

export type InvestmentTotals = {
  /** The entries' own currencies. Never summed across currencies. */
  byCurrency: CurrencyTotals[];
  /**
   * The same totals converted with each entry's own exchange rate, rounded to
   * two decimal places.
   *
   * Rounded because a converted total carries the rate's precision, not
   * money's: 10000.00 GBP at 1.2734 is 12734.000000 and no one holds
   * six-decimal dollars. The per-currency totals above are unrounded, so the
   * exact figure is always still available; this is the one the screen and the
   * tools show. The rounding happens once, in SQL, after the conversion and
   * the sum, so it is never applied twice to the same money.
   */
  usd: Omit<CurrencyTotals, "currency">;
};

export type InvestmentRow = {
  id: string;
  spaceId: string;
  entityId: string | null;
  name: string;
  category: string | null;
  signedOn: string | null;
  status: InvestmentStatus;
  notes: string | null;
  archivedAt: number | null;
  entryCount: number;
  /** Entries carrying a document. The screen's "documents" column. */
  documentCount: number;
  /** The distinct documents those entries cite. */
  linkedDocumentIds: string[];
  /** Section 6(c): published documents whose title names this investment and
   * that no entry links to. The number the owner should look at. */
  unlinkedDocumentCount: number;
  totals: InvestmentTotals;
};

export type InvestmentDetail = InvestmentRow & { entries: InvestmentEntry[] };

/** One ranked suggestion (section 6(b)). Computed on read, never stored. */
export type DocumentLinkSuggestion = {
  documentId: string;
  title: string;
  docType: string;
  capturedAt: number;
  score: number;
  /** Which signals fired, so the drawer can say why without a second read. */
  reasons: ("name" | "amount" | "date")[];
};

function typedError(code: string, message: string): never {
  throw new IdentityError(message, { code, message });
}

/** Bare and non-enumerating, the way `model.ts`'s denials are: an investment in
 * a space the caller cannot write and an investment that does not exist are the
 * same answer, so neither enumerates the other. */
function investmentNotFound(): never {
  throw new IdentityError("Investment not found");
}

function entryNotFound(): never {
  throw new IdentityError("Investment entry not found");
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value).length > maximum ||
    value.includes("\0")
  ) {
    typedError("invalid_input", `${name} is empty, malformed or too long`);
  }
  return value.trim();
}

function optionalText(
  value: unknown,
  name: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return boundedText(value, name, maximum);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    typedError("invalid_input", `${name} is not a known value`);
  }
  return value as T;
}

function isoDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !DATE.test(value)) {
    typedError("invalid_input", `${name} must be an ISO date`);
  }
  // `2026-02-31` matches the pattern and is not a date. `Date.UTC` would
  // silently roll it into March; the round trip catches it.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value)) {
    typedError("invalid_input", `${name} must be an ISO date`);
  }
  return value;
}

/** A flag, or its default. Anything else is bad input rather than a silent
 * `false`: `dateIsEstimated: "true"` from a hand-written request must not
 * quietly store the opposite of what it says. */
function boolean(value: unknown, name: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    typedError("invalid_input", `${name} must be true or false`);
  }
  return value;
}

function optionalIsoDate(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return isoDate(value, name);
}

/** The exact decimal text a `numeric` column will accept, unchanged. */
function decimal(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    typedError("invalid_input", `${name} must be an exact decimal string`);
  }
  return value;
}

/**
 * The amount, currency and rate as one decision, because the three are only
 * valid together: a non-USD amount without a rate cannot be converted, and the
 * USD totals would silently lose it. The schema refuses that row too
 * (`investment_entries_exchange_rate_check`, migration 025); this is the same
 * rule where the caller can be told which field is wrong.
 *
 * `entryType` is here for the same reason: whether a negative amount is legal
 * depends on it, and only `commitment_change` may be negative.
 */
function money(args: {
  amount: unknown;
  entryType: InvestmentEntryType;
  currency?: unknown;
  exchangeRate?: unknown;
}): { amount: string; currency: string; exchangeRate: string | null } {
  // Parsed as signed and then judged, rather than parsed with the unsigned
  // pattern: a negative amount on the wrong type is a specific, nameable
  // mistake, and "must be an exact decimal string" would be the wrong thing to
  // tell a caller whose decimal string was perfectly well formed.
  const amount = decimal(args.amount, "Amount", SIGNED_AMOUNT);
  if (args.entryType !== SIGNED_ENTRY_TYPE && amount.startsWith("-")) {
    typedError(
      "negative_amount",
      "Only a commitment change may be negative; every other type carries its direction in the type",
    );
  }
  const currency = args.currency === undefined ? "USD" : args.currency;
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    typedError("invalid_input", "Currency must be an ISO 4217 code");
  }
  if (currency === "USD") {
    // A rate on a USD row is not wrong, it is meaningless, and storing one
    // would make `amount * exchange_rate` and `amount` disagree about the same
    // money. The conversion below reads `amount` for USD rows regardless.
    return { amount, currency, exchangeRate: null };
  }
  if (args.exchangeRate === null || args.exchangeRate === undefined) {
    typedError(
      "exchange_rate_required",
      "An amount not in USD needs an exchange rate to USD",
    );
  }
  return {
    amount,
    currency,
    exchangeRate: decimal(args.exchangeRate, "Exchange rate", RATE),
  };
}

function epoch(value: Date | string | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** `date` comes back from node-pg as a `Date` in the server's zone; the column
 * holds a calendar date and the UI wants that date, not a moment. */
function calendarDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every total this screen shows, computed by PostgreSQL in `numeric` and
 * returned as text.
 *
 *   committed   commitment + commitment_change
 *   sent        capital_call_paid, and only that
 *   fees        fee, kept as its own total
 *   received    distribution
 *   outstanding committed - sent, signed
 *   overCalled  greatest(sent - committed, 0)
 *
 * `fees` is separate rather than folded into `sent` because the owner's sheet
 * may or may not have counted a management fee as money sent, and a total that
 * quietly picks one answer is a total he cannot check. Both numbers are here
 * and `sent` means capital calls.
 *
 * `outstanding` is signed and not floored at zero. Flooring made an over-call
 * indistinguishable from a fully called fund -- both read "0 outstanding" --
 * and an over-call is exactly the thing the owner needs to be told about.
 * `overCalled` is the same fact as a positive number, so a caller that would
 * rather not reason about a sign has one to compare against zero.
 *
 * Two groupings, one statement. `by_currency` groups by currency and never
 * adds two currencies together. `usd` converts each entry with its own stored
 * rate and then sums, which is the only order that is right: converting a sum
 * would apply one row's rate to another row's money. The USD figures are
 * rounded to two places after the sum, because the product of an amount and a
 * rate carries the rate's precision rather than money's.
 */
const TOTALS_CTE = `
  scoped AS (
    SELECT e.investment_id, e.currency, e.entry_type, e.amount, e.document_id,
           CASE WHEN e.currency = 'USD' THEN e.amount
                ELSE e.amount * e.exchange_rate END AS usd_amount
      FROM kith.investment_entries e
     WHERE {{ENTRY_SPACE}}
  ),
  by_currency AS (
    SELECT investment_id, currency,
           coalesce(sum(amount) FILTER (
             WHERE entry_type IN ('commitment', 'commitment_change')), 0) AS committed,
           coalesce(sum(amount) FILTER (WHERE entry_type = 'capital_call_paid'), 0) AS sent,
           coalesce(sum(amount) FILTER (WHERE entry_type = 'fee'), 0) AS fees,
           coalesce(sum(amount) FILTER (WHERE entry_type = 'distribution'), 0) AS received
      FROM scoped GROUP BY investment_id, currency
  ),
  in_usd AS (
    SELECT investment_id,
           count(*) AS entry_count,
           count(document_id) AS document_count,
           -- The linked documents, from the entries already scanned. Read
           -- here rather than by loading every entry: a caller that wants the
           -- ids should not have to pull the household's whole ledger to get
           -- them.
           coalesce(jsonb_agg(DISTINCT document_id)
                      FILTER (WHERE document_id IS NOT NULL),
                    '[]'::jsonb) AS linked_document_ids,
           coalesce(sum(usd_amount) FILTER (
             WHERE entry_type IN ('commitment', 'commitment_change')), 0) AS committed,
           coalesce(sum(usd_amount) FILTER (WHERE entry_type = 'capital_call_paid'), 0) AS sent,
           coalesce(sum(usd_amount) FILTER (WHERE entry_type = 'fee'), 0) AS fees,
           coalesce(sum(usd_amount) FILTER (WHERE entry_type = 'distribution'), 0) AS received
      FROM scoped GROUP BY investment_id
  )`;

const TOTALS_COLUMNS = `
  coalesce(u.entry_count, 0) AS entry_count,
  coalesce(u.document_count, 0) AS document_count,
  coalesce(u.linked_document_ids, '[]'::jsonb) AS linked_document_ids,
  round(coalesce(u.committed, 0), 2)::text AS usd_committed,
  round(coalesce(u.sent, 0), 2)::text AS usd_sent,
  round(coalesce(u.fees, 0), 2)::text AS usd_fees,
  round(coalesce(u.received, 0), 2)::text AS usd_received,
  round(coalesce(u.committed, 0) - coalesce(u.sent, 0), 2)::text AS usd_outstanding,
  round(greatest(coalesce(u.sent, 0) - coalesce(u.committed, 0), 0), 2)::text
    AS usd_over_called,
  (SELECT jsonb_agg(jsonb_build_object(
            'currency', b.currency,
            'committed', b.committed::text,
            'sent', b.sent::text,
            'fees', b.fees::text,
            'received', b.received::text,
            'outstanding', (b.committed - b.sent)::text,
            'overCalled', greatest(b.sent - b.committed, 0)::text)
          ORDER BY b.currency)
     FROM by_currency b WHERE b.investment_id = i.id) AS by_currency,
  -- Section 6(c). \`position\` rather than ILIKE so a name containing % or _ is
  -- matched literally instead of becoming a wildcard.
  (SELECT count(*) FROM kith.documents d
    WHERE d.space_id = i.space_id
      AND d.publication_state = 'active'
      AND position(lower(i.name) in lower(d.title)) > 0
      AND NOT EXISTS (
        SELECT 1 FROM kith.investment_entries x
         WHERE x.document_id = d.id AND x.space_id = d.space_id))
    AS unlinked_document_count`;

type InvestmentDbRow = {
  id: string;
  space_id: string;
  entity_id: string | null;
  name: string;
  category: string | null;
  signed_on: Date | string | null;
  status: string;
  notes: string | null;
  archived_at: Date | null;
  entry_count: string | number;
  document_count: string | number;
  linked_document_ids: string[] | null;
  usd_committed: string;
  usd_sent: string;
  usd_fees: string;
  usd_received: string;
  usd_outstanding: string;
  usd_over_called: string;
  by_currency: CurrencyTotals[] | null;
  unlinked_document_count: string | number;
};

function toInvestmentRow(record: InvestmentDbRow): InvestmentRow {
  return {
    id: record.id,
    spaceId: record.space_id,
    entityId: record.entity_id,
    name: record.name,
    category: record.category,
    signedOn: calendarDate(record.signed_on),
    status: record.status as InvestmentStatus,
    notes: record.notes,
    archivedAt: epoch(record.archived_at),
    entryCount: Number(record.entry_count),
    documentCount: Number(record.document_count),
    linkedDocumentIds: record.linked_document_ids ?? [],
    unlinkedDocumentCount: Number(record.unlinked_document_count),
    totals: {
      byCurrency: record.by_currency ?? [],
      usd: {
        committed: record.usd_committed,
        sent: record.usd_sent,
        fees: record.usd_fees,
        received: record.usd_received,
        outstanding: record.usd_outstanding,
        overCalled: record.usd_over_called,
      },
    },
  };
}

export type InvestmentFilters = {
  category?: string;
  status?: InvestmentStatus;
  /** Case-insensitive substring, matched literally. */
  nameContains?: string;
  includeArchived?: boolean;
};

/**
 * Every investment in the given spaces with its computed totals.
 *
 * `spaceIds` is the caller's already-resolved authorized set (see the module
 * comment). `spacePredicate` refuses an empty one rather than matching
 * everything, so a caller that resolved to nothing gets a thrown
 * `unauthorized`, not a silent empty list -- callers that mean "no access, no
 * rows" check the length themselves.
 */
export async function listInvestments(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  filters: InvestmentFilters = {},
): Promise<InvestmentRow[]> {
  const investmentSpaces = spacePredicate(spaceIds, 1, "i.space_id");
  const entrySpaces = spacePredicate(spaceIds, 1, "e.space_id");
  const category = optionalText(filters.category ?? null, "Category", 100);
  const status =
    filters.status === undefined
      ? null
      : oneOf(filters.status, INVESTMENT_STATUSES, "Status");
  const nameContains = optionalText(
    filters.nameContains ?? null,
    "Name filter",
    NAME_MAX_CHARS,
  );
  const records = await rows<InvestmentDbRow>(
    ctx,
    `WITH ${TOTALS_CTE.replace("{{ENTRY_SPACE}}", entrySpaces.sql)}
     SELECT i.id, i.space_id, i.entity_id, i.name, i.category, i.signed_on,
            i.status, i.notes, i.archived_at,
            ${TOTALS_COLUMNS}
       FROM kith.investments i
       LEFT JOIN in_usd u ON u.investment_id = i.id
      WHERE ${investmentSpaces.sql}
        AND ($2::boolean OR i.archived_at IS NULL)
        AND ($3::text IS NULL OR i.category = $3)
        AND ($4::text IS NULL OR i.status = $4)
        AND ($5::text IS NULL OR position(lower($5) in lower(i.name)) > 0)
      ORDER BY i.name, i.id
      LIMIT $6`,
    [
      investmentSpaces.value,
      filters.includeArchived === true,
      category,
      status,
      nameContains,
      MAX_INVESTMENTS + 1,
    ],
  );
  if (records.length > MAX_INVESTMENTS) {
    typedError("investment_limit", "Too many investments; filter the read");
  }
  return records.map(toInvestmentRow);
}

type EntryDbRow = {
  id: string;
  space_id: string;
  investment_id: string;
  entry_type: string;
  entry_date: Date | string;
  amount: string;
  currency: string;
  exchange_rate: string | null;
  note: string | null;
  document_id: string | null;
  evidence_span_id: string | null;
  date_is_estimated: boolean;
};

function toEntry(record: EntryDbRow): InvestmentEntry {
  return {
    id: record.id,
    spaceId: record.space_id,
    investmentId: record.investment_id,
    entryType: record.entry_type as InvestmentEntryType,
    entryDate: calendarDate(record.entry_date)!,
    amount: record.amount,
    currency: record.currency,
    exchangeRate: record.exchange_rate,
    note: record.note,
    documentId: record.document_id,
    evidenceSpanId: record.evidence_span_id,
    dateIsEstimated: record.date_is_estimated,
  };
}

/**
 * The entries of the named investments, oldest first.
 *
 * `investmentIds` is required, and bounded. The screen calls this with one id
 * when a row is expanded rather than loading the household's whole history up
 * front: the earlier shape read every entry in the space and raised
 * `entry_limit` once the thousandth existed anywhere, which would have broken
 * the screen for good with no action the owner could take to fix it. Now the
 * bound is one investment's entries, which is a number the owner controls.
 */
export async function listInvestmentEntries(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  investmentIds: readonly string[],
): Promise<InvestmentEntry[]> {
  if (
    !Array.isArray(investmentIds) ||
    investmentIds.length === 0 ||
    investmentIds.length > MAX_ENTRY_INVESTMENTS
  ) {
    typedError("invalid_input", "Name between one and 25 investments");
  }
  const predicate = spacePredicate(spaceIds, 1);
  const ids = investmentIds.map((id) =>
    assertKithId(id, "invalid_investment_id"),
  );
  const limit = MAX_ENTRIES * ids.length;
  const records = await rows<EntryDbRow>(
    ctx,
    `SELECT id, space_id, investment_id, entry_type, entry_date, amount,
            currency, exchange_rate, note, document_id, evidence_span_id,
            date_is_estimated
       FROM kith.investment_entries
      WHERE ${predicate.sql} AND investment_id = ANY($2::text[])
      ORDER BY entry_date, id
      LIMIT $3`,
    [predicate.value, ids, limit + 1],
  );
  if (records.length > limit) {
    typedError("entry_limit", "Too many entries; read one investment");
  }
  return records.map(toEntry);
}

/** One investment with its entries, or null when it is not in `spaceIds`. */
export async function getInvestment(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  investmentId: string,
): Promise<InvestmentDetail | null> {
  const id = assertKithId(investmentId, "invalid_investment_id");
  const investmentSpaces = spacePredicate(spaceIds, 1, "i.space_id");
  const entrySpaces = spacePredicate(spaceIds, 1, "e.space_id");
  const record = await row<InvestmentDbRow>(
    ctx,
    `WITH ${TOTALS_CTE.replace("{{ENTRY_SPACE}}", entrySpaces.sql)}
     SELECT i.id, i.space_id, i.entity_id, i.name, i.category, i.signed_on,
            i.status, i.notes, i.archived_at,
            ${TOTALS_COLUMNS}
       FROM kith.investments i
       LEFT JOIN in_usd u ON u.investment_id = i.id
      WHERE ${investmentSpaces.sql} AND i.id = $2`,
    [investmentSpaces.value, id],
  );
  if (!record) return null;
  return {
    ...toInvestmentRow(record),
    entries: await listInvestmentEntries(ctx, spaceIds, [id]),
  };
}

/**
 * Section 6(a) and (b): the documents this entry is probably about, ranked by
 * the signals that exist today.
 *
 * Nothing is stored. A suggestion is a read over what is already indexed, so
 * it cannot go stale and there is no table to reconcile when a document is
 * reprocessed.
 *
 * Three signals, weighted so that a name match alone is a weaker suggestion
 * than a name match with the money in it:
 *
 *   name    3  the investment's name appears in the document's title, which
 *              for a watched folder is derived from the file's path.
 *   amount  2  an exact string form of the amount appears in the document's
 *              text: `25,000`, `25000`, `25000.00`, `25,000.00`. Formatting is
 *              the document's choice, so all four are tried.
 *   date    1  the document was captured within
 *              SUGGESTION_DATE_WINDOW_DAYS of the entry's date.
 *
 * ponytail: a linear scan of the space's active documents joined to their
 * chunks, bounded at MAX_SUGGESTION_CANDIDATES. This is 39 investments and a
 * few thousand documents on one household's machine. Upgrade path when
 * extraction lands: the typed party and money statements section 8 produces
 * replace the string matching outright, and the rule for doing that
 * automatically is written down in the plan rather than half-built here.
 */
export async function suggestDocumentsForEntry(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  args: {
    investmentId: string;
    amount?: string;
    entryDate?: string;
  },
): Promise<DocumentLinkSuggestion[]> {
  const investmentId = assertKithId(args.investmentId, "invalid_investment_id");
  const predicate = spacePredicate(spaceIds, 1, "d.space_id");
  const investment = await row<{ name: string }>(
    ctx,
    `SELECT name FROM kith.investments i
      WHERE i.id = $2 AND ${spacePredicate(spaceIds, 1, "i.space_id").sql}`,
    [predicate.value, investmentId],
  );
  if (!investment) return [];
  const amount =
    args.amount === undefined || args.amount === ""
      ? null
      : decimal(args.amount, "Amount", AMOUNT);
  const entryDate = optionalIsoDate(args.entryDate ?? null, "Entry date");

  const records = await rows<{
    id: string;
    title: string;
    doc_type: string;
    captured_at: Date;
    name_match: boolean;
    amount_match: boolean;
    date_match: boolean;
  }>(
    ctx,
    `SELECT d.id, d.title, d.doc_type, d.captured_at,
            position(lower($2) in lower(d.title)) > 0 AS name_match,
            ($3::text[] IS NOT NULL AND EXISTS (
               SELECT 1 FROM kith.chunks c
                WHERE c.document_id = d.id AND c.space_id = d.space_id
                  AND c.publication_state = 'active'
                  AND c.text LIKE ANY($3::text[]))) AS amount_match,
            ($4::date IS NOT NULL
             AND d.captured_at >= $4::date - make_interval(days => $5::int)
             AND d.captured_at < $4::date + make_interval(days => $5::int + 1)) AS date_match
       FROM kith.documents d
      WHERE ${predicate.sql}
        AND d.publication_state = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM kith.investment_entries x
           WHERE x.document_id = d.id AND x.space_id = d.space_id)
      ORDER BY d.captured_at DESC, d.id
      LIMIT $6`,
    [
      predicate.value,
      investment.name,
      amount === null ? null : amountPatterns(amount),
      entryDate,
      SUGGESTION_DATE_WINDOW_DAYS,
      MAX_SUGGESTION_CANDIDATES,
    ],
  );

  return records
    .map((record) => {
      const reasons: DocumentLinkSuggestion["reasons"] = [];
      let score = 0;
      if (record.name_match) {
        reasons.push("name");
        score += 3;
      }
      if (record.amount_match) {
        reasons.push("amount");
        score += 2;
      }
      if (record.date_match) {
        reasons.push("date");
        score += 1;
      }
      return {
        documentId: record.id,
        title: record.title,
        docType: record.doc_type,
        capturedAt: record.captured_at.getTime(),
        score,
        reasons,
      };
    })
    .filter((suggestion) => suggestion.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.capturedAt - left.capturedAt ||
        left.documentId.localeCompare(right.documentId),
    )
    .slice(0, MAX_SUGGESTIONS);
}

/**
 * The string forms of `amount` a document might actually print, as SQL LIKE
 * patterns. `25000.00` is looked for as 25000.00, 25000, 25,000.00 and 25,000.
 *
 * Exported for the tests, which assert on the forms rather than on a document
 * that happens to contain one of them.
 */
export function amountPatterns(amount: string): string[] {
  const [whole = "0", fraction] = amount.split(".");
  const cents =
    fraction === undefined
      ? "00"
      : `${fraction}00`.slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const forms = new Set([
    `${whole}.${cents}`,
    `${grouped}.${cents}`,
    ...(cents === "00" ? [whole, grouped] : []),
  ]);
  // LIKE metacharacters cannot appear in a digit string, so no escaping is
  // needed; the patterns are built from `amount`, which matched AMOUNT.
  return [...forms].map((form) => `%${form}%`);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The space the caller may write, resolved from the row rather than trusted
 * from the request: the two-step `upsertSourceRoot` uses. */
async function writableInvestment(
  ctx: IdentityCtx,
  principal: Principal,
  investmentId: string,
): Promise<{ id: string; spaceId: string; name: string }> {
  const id = assertKithId(investmentId, "invalid_investment_id");
  const record = await row<{ space_id: string; name: string }>(
    ctx,
    "SELECT space_id, name FROM kith.investments WHERE id = $1",
    [id],
  );
  if (!record) investmentNotFound();
  await denyAsNotFound(
    () => requireSpaceAccess(ctx, principal, record.space_id, "write"),
    investmentNotFound,
  );
  return { id, spaceId: record.space_id, name: record.name };
}

/**
 * Turn the space denial, and only the space denial, into this module's own
 * non-enumerating "not found".
 *
 * A bare `catch {}` here would have swallowed a lost connection, a
 * serialization failure or a bug in `requireSpaceAccess` and reported all
 * three as "not found", which is both a wrong answer and an invisible
 * outage. `spaceNotFound()` raises exactly this message (see
 * `identity/errors.ts`), so it is the one that is translated; everything else
 * is rethrown for `mutationFailure` to turn into a 500 with a logged stack.
 */
async function denyAsNotFound(
  work: () => Promise<unknown>,
  notFound: () => never,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof IdentityError && error.message === "Space not found") {
      notFound();
    }
    throw error;
  }
}

/** PostgreSQL's unique violation. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

/**
 * Create an investment, tied to an `entities` row for the organization.
 *
 * "Find or create by exact normalized name; never create duplicates." The
 * entity key `resolveEntity` derives from the name is the uniqueness: two
 * names that normalize the same produce the same key, and the key is unique
 * per space, so the second call finds the first's row rather than making a
 * second. `normalizeEntityName` is the store's one normalizer (P2-70l2) and is
 * not re-implemented here.
 *
 * An investment whose name normalizes to an existing investment's name is
 * refused rather than silently merged: the owner has 39 of these and two rows
 * called the same thing would split his totals in half without saying so.
 */
export async function createInvestment(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceId: string;
    name: string;
    category?: string | null;
    signedOn?: string | null;
    status?: InvestmentStatus;
    notes?: string | null;
  },
): Promise<string> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  await requireSpaceAccess(ctx, args.principal, spaceId, "write");
  const name = boundedText(args.name, "Name", NAME_MAX_CHARS);
  const category = optionalText(args.category, "Category", 100);
  const signedOn = optionalIsoDate(args.signedOn, "Signed date");
  const status =
    args.status === undefined
      ? "active"
      : oneOf(args.status, INVESTMENT_STATUSES, "Status");
  const notes = optionalText(args.notes, "Note", NOTE_MAX_CHARS);

  // Find or create by exact normalized name: `resolveEntity` derives the key
  // from `normalizeEntityName(name)` and the key is unique per space, so the
  // second investment named the same organization reuses the first's entity
  // instead of minting a duplicate.
  const entity = await resolveEntity(ctx, args.principal.userId, spaceId, {
    kind: "organization",
    name,
  });

  // The duplicate is caught by `investments_active_name_idx`, not by a read
  // this function does first: a read-then-insert cannot see a concurrent
  // insert, and the import creates investments in a loop. The index can, so
  // the insert is attempted and its unique violation is the denial.
  const id = newKithId();
  try {
    await exec(
      ctx,
      `INSERT INTO kith.investments
         (id, space_id, entity_id, name, category, signed_on, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, spaceId, entity.id, name, category, signedOn, status, notes],
    );
  } catch (error) {
    if (isUniqueViolation(error, "investments_active_name_idx")) {
      typedError("duplicate_investment", "An investment with that name exists");
    }
    throw error;
  }
  return id;
}

/** Find the investment with this name, or create it. The import's path: a
 * sheet row names an investment and must not make a second one. */
export async function findOrCreateInvestment(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceId: string;
    name: string;
    category?: string | null;
    signedOn?: string | null;
    status?: InvestmentStatus;
    notes?: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  await requireSpaceAccess(ctx, args.principal, spaceId, "write");
  const name = boundedText(args.name, "Name", NAME_MAX_CHARS);
  const find = () =>
    row<{ id: string }>(
      ctx,
      `SELECT id FROM kith.investments
        WHERE space_id = $1 AND lower(btrim(name)) = lower(btrim($2))
          AND archived_at IS NULL
        LIMIT 1`,
      [spaceId, name],
    );
  const existing = await find();
  if (existing) return { id: existing.id, created: false };
  try {
    return { id: await createInvestment(ctx, args), created: true };
  } catch (error) {
    // Someone else created it between the read and the insert. "Find or
    // create" means the row exists afterwards, so this is a find.
    if (
      error instanceof IdentityError &&
      error.data?.code === "duplicate_investment"
    ) {
      const raced = await find();
      if (raced) return { id: raced.id, created: false };
    }
    throw error;
  }
}

export async function updateInvestment(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    investmentId: string;
    name?: string;
    category?: string | null;
    signedOn?: string | null;
    status?: InvestmentStatus;
    notes?: string | null;
  },
): Promise<void> {
  const target = await writableInvestment(
    ctx,
    args.principal,
    args.investmentId,
  );
  const name =
    args.name === undefined
      ? null
      : boundedText(args.name, "Name", NAME_MAX_CHARS);
  await guardDuplicateName(() =>
    exec(
      ctx,
      `UPDATE kith.investments SET
         name = coalesce($3, name),
         category = CASE WHEN $4::boolean THEN $5 ELSE category END,
         signed_on = CASE WHEN $6::boolean THEN $7 ELSE signed_on END,
         status = coalesce($8, status),
         notes = CASE WHEN $9::boolean THEN $10 ELSE notes END
       WHERE id = $1 AND space_id = $2`,
      [
        target.id,
        target.spaceId,
        name,
        args.category !== undefined,
        optionalText(args.category ?? null, "Category", 100),
        args.signedOn !== undefined,
        optionalIsoDate(args.signedOn ?? null, "Signed date"),
        args.status === undefined
          ? null
          : oneOf(args.status, INVESTMENT_STATUSES, "Status"),
        args.notes !== undefined,
        optionalText(args.notes ?? null, "Note", NOTE_MAX_CHARS),
      ],
    ),
  );
}

/** A rename onto another investment's name is a named denial, not a 500. */
async function guardDuplicateName(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (isUniqueViolation(error, "investments_active_name_idx")) {
      typedError("duplicate_investment", "An investment with that name exists");
    }
    throw error;
  }
}

/**
 * Archive, not delete. The entries stay, the totals stay computable, and the
 * row simply leaves the default read. Idempotent: archiving an archived
 * investment keeps the first archival's timestamp, because "when was this
 * archived" should not move because someone clicked twice.
 */
export async function archiveInvestment(
  ctx: IdentityCtx,
  args: { principal: Principal; investmentId: string; archived?: boolean },
): Promise<void> {
  const target = await writableInvestment(
    ctx,
    args.principal,
    args.investmentId,
  );
  const archived = args.archived ?? true;
  // Restoring can collide: the name freed by archiving may have been taken
  // since. `investments_active_name_idx` catches it and the caller is told
  // which, rather than getting a 500 out of a constraint it cannot see.
  await guardDuplicateName(() =>
    exec(
      ctx,
      `UPDATE kith.investments
          SET archived_at = CASE WHEN $3::boolean
                                 THEN coalesce(archived_at, $4)
                                 ELSE NULL END
        WHERE id = $1 AND space_id = $2`,
      [target.id, target.spaceId, archived, new Date(ctx.now)],
    ),
  );
}

/** A document may only be linked when it is in the entry's own space. The
 * composite foreign key would refuse anything else, but a foreign key
 * violation is a 500 and this is ordinary bad input.
 *
 * The source item comes back with it because the link a document attachment
 * now writes is keyed on the source item, not on the document row: a re-parse
 * mints a new document and the source item survives it (ADM-8b, migration
 * 033). */
async function documentInSpace(
  ctx: IdentityCtx,
  spaceId: string,
  documentId: string,
): Promise<{ id: string; sourceItemId: string }> {
  const id = assertKithId(documentId, "invalid_document_id");
  const found = await row<{ id: string; source_item_id: string }>(
    ctx,
    "SELECT id, source_item_id FROM kith.documents WHERE id = $1 AND space_id = $2",
    [id, spaceId],
  );
  if (!found) typedError("document_not_found", "Document not found");
  return { id: found.id, sourceItemId: found.source_item_id };
}

export type CreateEntryArgs = {
  principal: Principal;
  investmentId: string;
  entryType: InvestmentEntryType;
  entryDate: string;
  amount: string;
  currency?: string;
  exchangeRate?: string | null;
  note?: string | null;
  documentId?: string | null;
  /**
   * True when `entryDate` is an estimate rather than a stated date.
   *
   * The import sets it on a commitment it dated from the investment's first
   * payment (ADM-8b, slice 1b); the drawer sets it when the owner ticks the
   * box. It defaults to false, so an entry that says nothing is an entry
   * whose date is the owner's own and can never be rewritten by a document.
   */
  dateIsEstimated?: boolean;
  /** The import's stable row key. A second import of the same file re-uses it
   * and the unique index turns the insert into a no-op. */
  importKey?: string | null;
};

/**
 * One entry. Returns the id, or the existing id when `importKey` says this row
 * has already been imported.
 */
export async function createInvestmentEntry(
  ctx: IdentityCtx,
  args: CreateEntryArgs,
): Promise<{ id: string; created: boolean }> {
  const target = await writableInvestment(
    ctx,
    args.principal,
    args.investmentId,
  );
  const entryType = oneOf(args.entryType, INVESTMENT_ENTRY_TYPES, "Entry type");
  const entryDate = isoDate(args.entryDate, "Entry date");
  const amounts = money({ ...args, entryType });
  const note = optionalText(args.note ?? null, "Note", NOTE_MAX_CHARS);
  const importKey = optionalText(
    args.importKey ?? null,
    "Import key",
    IMPORT_KEY_MAX_CHARS,
  );
  const document =
    args.documentId === undefined || args.documentId === null
      ? null
      : await documentInSpace(ctx, target.spaceId, args.documentId);
  const dateIsEstimated = boolean(args.dateIsEstimated, "Date is estimated");

  const id = newKithId();
  // `document_id` is deliberately not in this INSERT any more. It is a mirror
  // of `kith.investment_document_links` (ADM-8b) and `setEntryDocument` is the
  // one thing that writes it, in this same transaction, immediately below.
  const inserted = await row<{ id: string }>(
    ctx,
    `INSERT INTO kith.investment_entries
       (id, space_id, investment_id, entry_type, entry_date, amount, currency,
        exchange_rate, note, import_key, date_is_estimated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (space_id, import_key) WHERE import_key IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      id,
      target.spaceId,
      target.id,
      entryType,
      entryDate,
      amounts.amount,
      amounts.currency,
      amounts.exchangeRate,
      note,
      importKey,
      dateIsEstimated,
    ],
  );
  if (inserted) {
    if (document !== null) {
      await setEntryDocument(ctx, {
        spaceId: target.spaceId,
        investmentId: target.id,
        entryId: inserted.id,
        actorUserId: args.principal.userId,
        document,
      });
    }
    return { id: inserted.id, created: true };
  }
  const existing = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.investment_entries
      WHERE space_id = $1 AND import_key = $2`,
    [target.spaceId, importKey],
  );
  if (!existing) entryNotFound();
  return { id: existing.id, created: false };
}

/**
 * The entry the caller may write.
 *
 * `investmentId`, when given, must be the entry's own. The routes carry an
 * investment id in the path and the entry id in the body, and without this an
 * entry could be edited through a path naming a different investment: the
 * space check would still pass (same space), but the URL would then be a lie
 * about what was changed, and a caller that authorized "edit this
 * investment's entries" would have edited another's.
 */
async function writableEntry(
  ctx: IdentityCtx,
  principal: Principal,
  entryId: string,
  investmentId?: string,
): Promise<{ id: string; spaceId: string; investmentId: string }> {
  const id = assertKithId(entryId, "invalid_entry_id");
  const record = await row<{ space_id: string; investment_id: string }>(
    ctx,
    "SELECT space_id, investment_id FROM kith.investment_entries WHERE id = $1",
    [id],
  );
  if (!record) entryNotFound();
  if (
    investmentId !== undefined &&
    assertKithId(investmentId, "invalid_investment_id") !== record.investment_id
  ) {
    entryNotFound();
  }
  await denyAsNotFound(
    () => requireSpaceAccess(ctx, principal, record.space_id, "write"),
    entryNotFound,
  );
  return {
    id,
    spaceId: record.space_id,
    investmentId: record.investment_id,
  };
}

/**
 * Change an entry.
 *
 * Amount, currency and rate move together or not at all: patching a currency
 * to GBP while leaving a null rate behind would store a row whose USD value is
 * null, so `money` is re-run over the merged values rather than over the
 * patch.
 *
 * `entryDate` and `dateIsEstimated` move together for a related reason.
 * Typing a date is how the owner states one, so a patch that sets the date
 * and says nothing about the marker CLEARS it: the date is now his. He keeps
 * the marker by sending `dateIsEstimated: true` in the same patch, which is
 * what the drawer's tick box does.
 *
 * `documentId` no longer writes the column. It goes through
 * `setEntryDocument`, so attaching a document writes an owner-confirmed link
 * and detaching one rejects the live link -- which is also what stops a
 * sweep from re-attaching what the owner just took off.
 */
export async function updateInvestmentEntry(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    entryId: string;
    /** The investment the caller believes this entry belongs to. */
    investmentId?: string;
    entryType?: InvestmentEntryType;
    entryDate?: string;
    amount?: string;
    currency?: string;
    exchangeRate?: string | null;
    note?: string | null;
    documentId?: string | null;
    dateIsEstimated?: boolean;
  },
): Promise<void> {
  const target = await writableEntry(
    ctx,
    args.principal,
    args.entryId,
    args.investmentId,
  );
  const current = await row<EntryDbRow>(
    ctx,
    `SELECT id, space_id, investment_id, entry_type, entry_date, amount,
            currency, exchange_rate, note, document_id, evidence_span_id,
            date_is_estimated
       FROM kith.investment_entries WHERE id = $1 AND space_id = $2`,
    [target.id, target.spaceId],
  );
  if (!current) entryNotFound();
  // The merged type decides whether the merged amount may be negative: a
  // patch that changes a `commitment_change` of -5000 to a `fee` has to be
  // refused, not stored as a negative fee.
  const entryType =
    args.entryType === undefined
      ? (current.entry_type as InvestmentEntryType)
      : oneOf(args.entryType, INVESTMENT_ENTRY_TYPES, "Entry type");
  const amounts = money({
    amount: args.amount ?? current.amount,
    entryType,
    currency: args.currency ?? current.currency,
    exchangeRate:
      args.exchangeRate === undefined ? current.exchange_rate : args.exchangeRate,
  });
  const document =
    args.documentId === undefined || args.documentId === null
      ? null
      : await documentInSpace(ctx, target.spaceId, args.documentId);
  // Absent and unaccompanied by a new date: leave the marker alone. Absent
  // beside a new date: the owner typed the date, so it is no longer an
  // estimate. Present: he said which it is.
  const dateIsEstimated =
    args.dateIsEstimated === undefined
      ? args.entryDate === undefined
        ? current.date_is_estimated
        : false
      : boolean(args.dateIsEstimated, "Date is estimated");
  await exec(
    ctx,
    `UPDATE kith.investment_entries SET
       entry_type = $3,
       entry_date = coalesce($4, entry_date),
       amount = $5,
       currency = $6,
       exchange_rate = $7,
       note = CASE WHEN $8::boolean THEN $9 ELSE note END,
       date_is_estimated = $10
     WHERE id = $1 AND space_id = $2`,
    [
      target.id,
      target.spaceId,
      entryType,
      args.entryDate === undefined ? null : isoDate(args.entryDate, "Entry date"),
      amounts.amount,
      amounts.currency,
      amounts.exchangeRate,
      args.note !== undefined,
      optionalText(args.note ?? null, "Note", NOTE_MAX_CHARS),
      dateIsEstimated,
    ],
  );
  if (args.documentId !== undefined) {
    await setEntryDocument(ctx, {
      spaceId: target.spaceId,
      investmentId: target.investmentId,
      entryId: target.id,
      actorUserId: args.principal.userId,
      document,
    });
  }
}

/** An entry is a mistake or it is not, so this one is a real delete. The
 * investment is what gets archived. */
export async function deleteInvestmentEntry(
  ctx: IdentityCtx,
  args: { principal: Principal; entryId: string; investmentId?: string },
): Promise<void> {
  const target = await writableEntry(
    ctx,
    args.principal,
    args.entryId,
    args.investmentId,
  );
  await exec(
    ctx,
    "DELETE FROM kith.investment_entries WHERE id = $1 AND space_id = $2",
    [target.id, target.spaceId],
  );
}
