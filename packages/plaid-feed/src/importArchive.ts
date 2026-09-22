// `kith-plaid-feed import-archive`: a one-time read of the finance archive
// (statement-derived, Morgan Stanley only, `finance.transactions` 2020 to
// present) into the same `kith.fin_*` tables `pull` writes the Plaid feed
// into. See docs/plans/2026-09-22-simplification-and-feeds.md and migration
// 048_finance_unify.sql: the owner does not want the archive and the Plaid
// feed to be two ledgers to query separately, so this makes the archive's
// own rows part of the one ledger instead of leaving them behind a second
// read contract.
//
// Read-only against the archive: every query here is a SELECT, never an
// INSERT/UPDATE/DELETE, and it connects with the archive's own reader-role
// credential (`FINANCE_ARCHIVE_READER_DATABASE_URL`, the same one
// `apps/web/src/lib/mcp/finance.ts` uses) rather than a writer connection.
// The finance-archive write path is untouched.
//
// Idempotent by `(source, source_ref)` on `kith.fin_transactions` -- the
// archive's own transaction row id is source-stable, so running this again
// (a later account gets statement history, a correction lands in the
// archive) upserts rather than duplicates. Account and instrument matching
// re-derives the same match every run for the same data, so re-running
// before any new archive data lands is a no-op past the first run.
//
// Self-repairing, not just idempotent: every run re-derives every archive
// account's link and every linked account's overlap boundary from scratch,
// deletes any archive-source row that is on or after the boundary (a row a
// previous, buggy run left behind), and reinserts whatever archive rows
// belong before it. A run against already-correct data deletes and reinserts
// nothing.
//
// Linking: an archive account already linked to a `kith.fin_accounts` row
// (by `archive_account_id`) reuses that row -- it is never re-matched by
// mask or name once linked, so a later run can never move an archive
// account's history onto a different row. When that existing row has no
// `plaid_account_id` yet (an "archive-only" row a previous run created
// because no feed account existed at the time) and a feed account now
// exists matching by institution plus mask, then name, the archive-only
// row's transactions and snapshots move onto the feed row, the feed row
// gets `archive_account_id` set, and the now-empty archive-only row is
// deleted -- see `mergeArchiveOnlyAccount`. An archive account with no
// existing link is matched onto an *unclaimed* candidate (no
// `archive_account_id` yet) by mask, then name, so two different archive
// accounts sharing a generic display name can never both claim the same
// feed row -- the first one to match claims it in-memory for the rest of
// this run, not only in the database.
//
// Boundary rule: an account that already has Plaid transactions in the
// ledger only gets archive transactions strictly before the earliest Plaid
// date already there -- the archive is history, Plaid is the current feed,
// and importing archive rows past where Plaid's own history starts would
// duplicate coverage under two sources instead of extending it. The same
// rule applies to holding and balance snapshots, against the earliest Plaid
// snapshot date (holding or balance, whichever is earlier) rather than the
// earliest Plaid transaction date -- a snapshot's own history can start
// before or after transaction history does. An account with no Plaid
// transactions (for the transaction boundary) or no Plaid snapshots (for
// the snapshot boundary) yet gets its entire archive history for that row
// kind: there is nothing to bound against. The more conservative (earlier)
// of the two boundaries, when both exist, is recorded on
// `kith.fin_accounts.archive_coverage_through` (migration
// 049_fin_archive_coverage.sql) as "the boundary used" for that account.
//
// Prints counts only, never an account name, balance or transaction amount,
// matching `pull`'s own rule.

import type pg from "pg";
import type { Pool } from "pg";

import { newKithId } from "@repo/kith-store";

export type ArchiveAccountRow = {
  id: string;
  institutionName: string;
  mask: string | null;
  name: string;
  accountType: string | null;
};

export type ArchiveInstrumentRow = {
  id: string;
  symbol: string | null;
  cusip: string | null;
  isin: string | null;
  name: string | null;
  kind: string | null;
};

export type ArchiveTransactionRow = {
  id: string;
  accountId: string;
  date: string;
  postedDate: string | null;
  activityType: string;
  description: string;
  instrumentId: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  currency: string;
};

export type ArchivePositionRow = {
  id: string;
  accountId: string;
  asOf: string;
  instrumentId: string | null;
  quantity: number | null;
  price: number | null;
  value: number | null;
  costBasis: number | null;
  currency: string;
};

export type ArchiveBalanceRow = {
  id: string;
  accountId: string;
  asOf: string;
  total: number | null;
  currency: string;
};

export type FinAccountCandidate = {
  id: string;
  institutionName: string;
  mask: string | null;
  name: string;
};

/** A `FinAccountCandidate` plus the two link columns `planArchiveAccountLink`
 * needs to decide whether a row is already linked, an unclaimed feed row, or
 * an unclaimed archive-only row -- `matchArchiveAccount` itself never looks
 * at these two fields, so its existing unit tests (synthetic candidates with
 * no such fields) keep working unchanged. */
export type LinkableFinAccountCandidate = FinAccountCandidate & {
  plaidAccountId: string | null;
  archiveAccountId: string | null;
};

export type FinSecurityCandidate = {
  id: string;
  ticker: string | null;
  cusip: string | null;
  isin: string | null;
};

export type ArchiveAccountMatch = { id: string; method: "mask" | "name" };

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * An archive account against the ledger's existing `fin_accounts`: by
 * institution plus the last-four mask first (the strongest signal Plaid and
 * a statement can agree on independently), then by institution plus name.
 * `null` means no existing row matches and the caller creates one.
 *
 * The reusable half of the matching this migration's owner-direction change
 * kept from the retired `linkPlaidAccounts` design: same two-tier rule
 * (mask, then name), scoped to one institution at a time either way.
 */
export function matchArchiveAccount(
  archive: ArchiveAccountRow,
  candidates: readonly FinAccountCandidate[],
): ArchiveAccountMatch | null {
  const sameInstitution = candidates.filter(
    (candidate) =>
      normalize(candidate.institutionName) === normalize(archive.institutionName),
  );
  if (archive.mask !== null) {
    const byMask = sameInstitution.find(
      (candidate) => candidate.mask !== null && candidate.mask === archive.mask,
    );
    if (byMask !== undefined) return { id: byMask.id, method: "mask" };
  }
  const byName = sameInstitution.find(
    (candidate) => normalize(candidate.name) === normalize(archive.name),
  );
  if (byName !== undefined) return { id: byName.id, method: "name" };
  return null;
}

export type ArchiveAccountLinkAction =
  /** This archive account is already linked to a fin_accounts row that also
   * has a plaid_account_id (fully merged, by an earlier run or earlier in
   * this same run) -- reuse it, no database write needed. */
  | { kind: "already-linked"; finAccountId: string }
  /** This archive account matched an unclaimed feed row (or, when it was
   * already linked to an archive-only row, an unclaimed feed row appeared
   * since) -- the archive-only row (if any) merges into the feed row. */
  | { kind: "merge"; archiveOnlyFinAccountId: string; feedFinAccountId: string }
  /** This archive account has no existing link and matched an unclaimed
   * fin_accounts row (which may or may not itself have a plaid_account_id)
   * by mask or name -- set archive_account_id on it. */
  | { kind: "match"; finAccountId: string }
  /** No existing link and nothing matched -- the caller creates a new
   * archive-only row. */
  | { kind: "create" };

/**
 * Whole-run link planning for one archive account, given every current
 * `kith.fin_accounts` row's link state. Pure so the merge decision -- the
 * part `matchArchiveAccount` alone cannot make, since it does not know which
 * candidates are already claimed by a *different* archive account or which
 * one this same archive account was already linked to by an earlier run --
 * is unit-testable with synthetic rows, no database.
 *
 * An archive account already linked (by `archive_account_id`) is never
 * re-matched by mask or name: once linked, only the merge path (an
 * archive-only row gaining a feed match) can change which row it points to,
 * and that only ever moves it onto a feed row, never onto a different
 * archive-only or already-merged row. Candidates already claimed by another
 * archive account (their own `archive_account_id` already set to something
 * else) are never offered to `matchArchiveAccount`, so two different archive
 * accounts that share a generic display name can never both claim the same
 * feed row within one run.
 */
export function planArchiveAccountLink(
  archive: ArchiveAccountRow,
  candidates: readonly LinkableFinAccountCandidate[],
): ArchiveAccountLinkAction {
  const existing = candidates.find((c) => c.archiveAccountId === archive.id);
  if (existing !== undefined) {
    if (existing.plaidAccountId !== null) {
      return { kind: "already-linked", finAccountId: existing.id };
    }
    const unclaimedFeedRows = candidates.filter(
      (c) => c.id !== existing.id && c.archiveAccountId === null && c.plaidAccountId !== null,
    );
    const merge = matchArchiveAccount(archive, unclaimedFeedRows);
    if (merge !== null) {
      return {
        kind: "merge",
        archiveOnlyFinAccountId: existing.id,
        feedFinAccountId: merge.id,
      };
    }
    return { kind: "already-linked", finAccountId: existing.id };
  }
  const unclaimed = candidates.filter((c) => c.archiveAccountId === null);
  const match = matchArchiveAccount(archive, unclaimed);
  if (match !== null) {
    return { kind: "match", finAccountId: match.id };
  }
  return { kind: "create" };
}

/** An archive instrument against `fin_securities`, by ticker, then CUSIP,
 * then ISIN -- whichever identifier both sides happen to carry. */
export function matchArchiveInstrument(
  archive: ArchiveInstrumentRow,
  candidates: readonly FinSecurityCandidate[],
): string | null {
  if (archive.symbol !== null) {
    const byTicker = candidates.find(
      (candidate) =>
        candidate.ticker !== null &&
        normalize(candidate.ticker) === normalize(archive.symbol!),
    );
    if (byTicker !== undefined) return byTicker.id;
  }
  if (archive.cusip !== null) {
    const byCusip = candidates.find(
      (candidate) => candidate.cusip !== null && candidate.cusip === archive.cusip,
    );
    if (byCusip !== undefined) return byCusip.id;
  }
  if (archive.isin !== null) {
    const byIsin = candidates.find(
      (candidate) => candidate.isin !== null && candidate.isin === archive.isin,
    );
    if (byIsin !== undefined) return byIsin.id;
  }
  return null;
}

/**
 * The boundary rule, whole: an archive transaction dated on or after
 * `plaidCutoff` is not imported when the account has one (it is already, or
 * will be, covered by the account's own Plaid history); every archive
 * transaction is imported when it does not (`plaidCutoff === null`, meaning
 * this account has no Plaid transactions in the ledger yet).
 */
export function isBeforeArchiveCutoff(
  date: string,
  plaidCutoff: string | null,
): boolean {
  return plaidCutoff === null || date < plaidCutoff;
}

/** The shared `kind` vocabulary `kith.fin_transactions.kind` CHECKs, mapped
 * from the archive's own free-text `activity_type` (Morgan Stanley's
 * statement vocabulary, not a fixed enum the archive itself constrains). */
export function mapArchiveActivityKind(activityType: string): string {
  const type = activityType.toLowerCase();
  if (type.includes("dividend")) return "dividend";
  if (type.includes("interest")) return "interest";
  if (type.includes("buy") || type.includes("purchase")) return "buy";
  if (type.includes("sell") || type.includes("sale")) return "sell";
  if (type.includes("fee")) return "fee";
  if (type.includes("transfer")) return "transfer";
  if (type.includes("deposit")) return "deposit";
  if (type.includes("withdraw")) return "withdrawal";
  if (type.includes("payment")) return "payment";
  return "other";
}

export type ImportArchiveResult = {
  accountsMatched: number;
  accountsCreated: number;
  /** New `archive_account_id` links this run set -- a subset of
   * `accountsMatched` (an already-linked account re-derives to the same
   * link every run without writing anything) plus every merge. */
  linksSet: number;
  /** Merges this run performed: an archive-only row folded into a feed row
   * that appeared since. */
  accountsMerged: number;
  /** How many of this archive's accounts are linked, after this run, to a
   * `fin_accounts` row that still has no `plaid_account_id` -- not yet
   * matched (or merged) to any feed account. */
  archiveOnlyAccounts: number;
  instrumentsMatched: number;
  instrumentsCreated: number;
  transactionsImported: number;
  transactionsSkippedPastBoundary: number;
  positionsImported: number;
  positionsSkippedNoInstrument: number;
  positionsSkippedPastBoundary: number;
  balancesImported: number;
  balancesSkippedPastBoundary: number;
  /** Archive-source rows (transactions, holding snapshots, balance
   * snapshots combined) deleted this run because they are on or after the
   * boundary now in force for their account -- the self-repair step
   * cleaning up what an earlier, boundary-blind run left behind. Zero on a
   * run against already-correct data. */
  rowsDeletedAsOverlap: number;
  /** How many linked accounts got a non-null boundary this run (had some
   * Plaid transaction or snapshot data already) -- the rest had none yet, so
   * their whole archive history applies with no boundary. */
  boundaryDateCount: number;
};

function emptyResult(): ImportArchiveResult {
  return {
    accountsMatched: 0,
    accountsCreated: 0,
    linksSet: 0,
    accountsMerged: 0,
    archiveOnlyAccounts: 0,
    instrumentsMatched: 0,
    instrumentsCreated: 0,
    transactionsImported: 0,
    transactionsSkippedPastBoundary: 0,
    positionsImported: 0,
    positionsSkippedNoInstrument: 0,
    positionsSkippedPastBoundary: 0,
    balancesImported: 0,
    balancesSkippedPastBoundary: 0,
    rowsDeletedAsOverlap: 0,
    boundaryDateCount: 0,
  };
}

/** `null`-aware minimum of two ISO date strings -- either side may be `null`
 * (no boundary of that kind for this account), and `null` sorts as "no
 * bound" rather than smallest, so it only wins when the other side is also
 * `null`. The more conservative (earlier) of the transaction and snapshot
 * boundaries is what `archive_coverage_through` records for an account. */
export function earlierDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** Every archive read this command makes, read-only. Its own type -- not
 * `pg.ClientBase` directly -- so a test can hand it a fake without a real
 * archive connection, the same way `db.ts`'s functions take a `Pool`. */
export type ArchiveReader = {
  accounts(): Promise<ArchiveAccountRow[]>;
  instruments(): Promise<ArchiveInstrumentRow[]>;
  transactions(accountIds: readonly string[]): Promise<ArchiveTransactionRow[]>;
  positions(accountIds: readonly string[]): Promise<ArchivePositionRow[]>;
  balances(accountIds: readonly string[]): Promise<ArchiveBalanceRow[]>;
};

/** A read-only `ArchiveReader` against a real archive connection, `finance`
 * schema already pinned by `createArchiveClient`/`createArchivePool` so
 * every query below is unqualified. */
export function archiveReader(client: pg.ClientBase): ArchiveReader {
  return {
    async accounts() {
      const { rows } = await client.query<{
        id: string;
        institution_name: string;
        acct_last4: string | null;
        display_name: string | null;
        account_type: string | null;
      }>(
        `SELECT a.id, i.name AS institution_name, a.acct_last4,
                a.display_name, a.account_type
           FROM accounts a
           JOIN institutions i ON i.id = a.institution_id
          WHERE a.closed_date IS NULL
          ORDER BY a.id`,
      );
      return rows.map((row) => ({
        id: row.id,
        institutionName: row.institution_name,
        mask: row.acct_last4,
        name: row.display_name?.trim() || "Unlabeled account",
        accountType: row.account_type,
      }));
    },
    async instruments() {
      const { rows } = await client.query<{
        id: string;
        symbol: string | null;
        cusip: string | null;
        isin: string | null;
        name: string | null;
        instrument_kind: string | null;
      }>(`SELECT id, symbol, cusip, isin, name, instrument_kind FROM instruments`);
      return rows.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        cusip: row.cusip,
        isin: row.isin,
        name: row.name,
        kind: row.instrument_kind,
      }));
    },
    async transactions(accountIds) {
      if (accountIds.length === 0) return [];
      // `::text` on every date column: `pg`'s default type parser returns a
      // JS `Date` for a `date` column, not the string these row types say --
      // see mapping.ts's `isoDateOnly` for the live failure that shape of
      // bug already caused once in this package.
      const { rows } = await client.query<{
        id: string;
        account_id: string;
        process_date: string;
        settle_date: string | null;
        activity_type: string;
        description: string;
        instrument_id: string | null;
        quantity: string | null;
        price: string | null;
        amount: string | null;
        currency: string;
      }>(
        `SELECT id, account_id, process_date::text AS process_date,
                settle_date::text AS settle_date, activity_type, description,
                instrument_id, quantity, price, amount, currency
           FROM transactions
          WHERE account_id = ANY($1)
          ORDER BY account_id, process_date`,
        [accountIds],
      );
      return rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        date: row.process_date,
        postedDate: row.settle_date,
        activityType: row.activity_type,
        description: row.description,
        instrumentId: row.instrument_id,
        quantity: row.quantity === null ? null : Number(row.quantity),
        price: row.price === null ? null : Number(row.price),
        amount: row.amount === null ? null : Number(row.amount),
        currency: row.currency,
      }));
    },
    async positions(accountIds) {
      if (accountIds.length === 0) return [];
      const { rows } = await client.query<{
        id: string;
        account_id: string;
        as_of: string;
        instrument_id: string | null;
        quantity: string | null;
        price: string | null;
        market_value: string | null;
        cost_basis: string | null;
        currency: string;
      }>(
        `SELECT id, account_id, as_of::text AS as_of, instrument_id,
                quantity, price, market_value, cost_basis, currency
           FROM positions
          WHERE account_id = ANY($1)
          ORDER BY account_id, as_of`,
        [accountIds],
      );
      return rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        asOf: row.as_of,
        instrumentId: row.instrument_id,
        quantity: row.quantity === null ? null : Number(row.quantity),
        price: row.price === null ? null : Number(row.price),
        value: row.market_value === null ? null : Number(row.market_value),
        costBasis: row.cost_basis === null ? null : Number(row.cost_basis),
        currency: row.currency,
      }));
    },
    async balances(accountIds) {
      if (accountIds.length === 0) return [];
      const { rows } = await client.query<{
        id: string;
        account_id: string;
        as_of: string;
        total_value: string | null;
        currency: string;
      }>(
        `SELECT id, account_id, as_of::text AS as_of, total_value, currency
           FROM balances
          WHERE account_id = ANY($1)
          ORDER BY account_id, as_of`,
        [accountIds],
      );
      return rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        asOf: row.as_of,
        total: row.total_value === null ? null : Number(row.total_value),
        currency: row.currency,
      }));
    },
  };
}

/**
 * Move an archive-only `fin_accounts` row's transactions and snapshots onto
 * a feed row a later archive account link discovered, then set
 * `archive_account_id` on the feed row and delete the now-empty archive-only
 * row. Safe against a unique-constraint collision because the feed row --
 * unclaimed, `archive_account_id IS NULL` -- can only have `source = 'plaid'`
 * rows so far: nothing this account's archive rows carry (all
 * `source = 'archive'`) can already exist there under the same natural key.
 */
async function mergeArchiveOnlyAccount(
  pool: Pool,
  archiveOnlyFinAccountId: string,
  feedFinAccountId: string,
  archiveAccountId: string,
): Promise<void> {
  await pool.query(
    `UPDATE kith.fin_transactions SET account_id = $2 WHERE account_id = $1`,
    [archiveOnlyFinAccountId, feedFinAccountId],
  );
  await pool.query(
    `UPDATE kith.fin_holding_snapshots SET account_id = $2 WHERE account_id = $1`,
    [archiveOnlyFinAccountId, feedFinAccountId],
  );
  await pool.query(
    `UPDATE kith.fin_balance_snapshots SET account_id = $2 WHERE account_id = $1`,
    [archiveOnlyFinAccountId, feedFinAccountId],
  );
  // Delete the archive-only row *before* claiming its archive_account_id on
  // the feed row: `archive_account_id` is UNIQUE, so both rows cannot hold
  // the same value at once, and the archive-only row is the one giving it up.
  await pool.query(`DELETE FROM kith.fin_accounts WHERE id = $1`, [archiveOnlyFinAccountId]);
  await pool.query(
    `UPDATE kith.fin_accounts
        SET archive_account_id = $2, updated_at = transaction_timestamp()
      WHERE id = $1 AND archive_account_id IS NULL`,
    [feedFinAccountId, archiveAccountId],
  );
}

/**
 * The whole import, given an archive reader and the kith writer pool. Pure
 * orchestration over the pure matching/planning/boundary functions above and
 * `db.ts`-shaped upserts, so the matching, linking and boundary rules stay
 * tested without a database while this function itself is covered by the
 * Postgres test that seeds both an archive-style and a Plaid-style account.
 *
 * Self-repairing: every run re-derives every account's link (see
 * `planArchiveAccountLink`) and overlap boundary from the ledger's current
 * rows, deletes any archive-source row on or after that boundary, then
 * reinserts (upserts) whatever archive rows belong before it. A run against
 * already-correct data deletes and inserts nothing new.
 */
export async function importArchive(
  archive: ArchiveReader,
  pool: Pool,
): Promise<ImportArchiveResult> {
  const result = emptyResult();

  // `archive.accounts()`/`archive.instruments()` run over the same single
  // archive connection (a `pg.Client`, not a `Pool`) and so cannot run
  // concurrently -- `pg.Client` queues a second query issued before the
  // first resolves and warns that it will stop doing so; sequential here
  // avoids relying on that queuing at all. `pool` is a real `Pool`, so its
  // two reads are still run together.
  const archiveAccounts = await archive.accounts();
  const archiveInstruments = await archive.instruments();
  const [finAccounts, finSecurities] = await Promise.all([
    loadFinAccountCandidates(pool),
    loadFinSecurityCandidates(pool),
  ]);

  const finAccountIdByArchiveId = new Map<string, string>();
  for (const account of archiveAccounts) {
    const plan = planArchiveAccountLink(account, finAccounts);
    switch (plan.kind) {
      case "already-linked": {
        result.accountsMatched += 1;
        finAccountIdByArchiveId.set(account.id, plan.finAccountId);
        break;
      }
      case "match": {
        result.accountsMatched += 1;
        result.linksSet += 1;
        await pool.query(
          `UPDATE kith.fin_accounts
              SET archive_account_id = $2, updated_at = transaction_timestamp()
            WHERE id = $1 AND archive_account_id IS NULL`,
          [plan.finAccountId, account.id],
        );
        const candidate = finAccounts.find((c) => c.id === plan.finAccountId);
        if (candidate !== undefined) candidate.archiveAccountId = account.id;
        finAccountIdByArchiveId.set(account.id, plan.finAccountId);
        break;
      }
      case "merge": {
        result.accountsMatched += 1;
        result.linksSet += 1;
        result.accountsMerged += 1;
        await mergeArchiveOnlyAccount(
          pool,
          plan.archiveOnlyFinAccountId,
          plan.feedFinAccountId,
          account.id,
        );
        const feedCandidate = finAccounts.find((c) => c.id === plan.feedFinAccountId);
        if (feedCandidate !== undefined) feedCandidate.archiveAccountId = account.id;
        const archiveOnlyIndex = finAccounts.findIndex(
          (c) => c.id === plan.archiveOnlyFinAccountId,
        );
        if (archiveOnlyIndex !== -1) finAccounts.splice(archiveOnlyIndex, 1);
        finAccountIdByArchiveId.set(account.id, plan.feedFinAccountId);
        break;
      }
      case "create": {
        const id = newKithId();
        await pool.query(
          `INSERT INTO kith.fin_accounts
             (id, institution_name, name, mask, type, archive_account_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, account.institutionName, account.name, account.mask, account.accountType, account.id],
        );
        result.accountsCreated += 1;
        finAccountIdByArchiveId.set(account.id, id);
        finAccounts.push({
          id,
          institutionName: account.institutionName,
          mask: account.mask,
          name: account.name,
          plaidAccountId: null,
          archiveAccountId: account.id,
        });
        break;
      }
    }
  }

  result.archiveOnlyAccounts = [...new Set(finAccountIdByArchiveId.values())].filter((id) => {
    const candidate = finAccounts.find((c) => c.id === id);
    return candidate !== undefined && candidate.plaidAccountId === null;
  }).length;

  const finSecurityIdByInstrumentId = new Map<string, string>();
  for (const instrument of archiveInstruments) {
    const matched = matchArchiveInstrument(instrument, finSecurities);
    if (matched !== null) {
      result.instrumentsMatched += 1;
      finSecurityIdByInstrumentId.set(instrument.id, matched);
      continue;
    }
    const id = newKithId();
    await pool.query(
      `INSERT INTO kith.fin_securities
         (id, name, ticker, cusip, isin, type, archive_instrument_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, instrument.name, instrument.symbol, instrument.cusip, instrument.isin, instrument.kind, instrument.id],
    );
    result.instrumentsCreated += 1;
    finSecurityIdByInstrumentId.set(instrument.id, id);
    finSecurities.push({ id, ticker: instrument.symbol, cusip: instrument.cusip, isin: instrument.isin });
  }

  const archiveAccountIds = archiveAccounts.map((account) => account.id);
  // Sequential for the same reason as above: one archive connection.
  const transactions = await archive.transactions(archiveAccountIds);
  const positions = await archive.positions(archiveAccountIds);
  const balances = await archive.balances(archiveAccountIds);

  // Self-repair: re-derive every linked account's two boundaries (one for
  // transactions, one -- against the earliest Plaid holding-or-balance
  // snapshot date -- for snapshots) from the ledger's current Plaid rows,
  // delete any archive-source row this account already has on or after its
  // boundary (left behind by an earlier, boundary-blind or unlinked run),
  // and record `archive_coverage_through` as the more conservative (earlier)
  // of the two, so a reader never overstates archive coverage.
  const transactionCutoffByFinAccountId = new Map<string, string | null>();
  const snapshotCutoffByFinAccountId = new Map<string, string | null>();
  for (const finAccountId of new Set(finAccountIdByArchiveId.values())) {
    const { rows: txRows } = await pool.query<{ earliest: string | null }>(
      `SELECT min(date)::text AS earliest
         FROM kith.fin_transactions
        WHERE account_id = $1 AND source = 'plaid'`,
      [finAccountId],
    );
    const transactionCutoff = txRows[0]?.earliest ?? null;

    const { rows: snapshotRows } = await pool.query<{ earliest: string | null }>(
      `SELECT min(as_of)::text AS earliest FROM (
         SELECT as_of FROM kith.fin_balance_snapshots
          WHERE account_id = $1 AND source = 'plaid'
         UNION ALL
         SELECT as_of FROM kith.fin_holding_snapshots
          WHERE account_id = $1 AND source = 'plaid'
       ) AS plaid_snapshots`,
      [finAccountId],
    );
    const snapshotCutoff = snapshotRows[0]?.earliest ?? null;

    transactionCutoffByFinAccountId.set(finAccountId, transactionCutoff);
    snapshotCutoffByFinAccountId.set(finAccountId, snapshotCutoff);

    if (transactionCutoff !== null) {
      const deleted = await pool.query(
        `DELETE FROM kith.fin_transactions
          WHERE account_id = $1 AND source = 'archive' AND date >= $2`,
        [finAccountId, transactionCutoff],
      );
      result.rowsDeletedAsOverlap += deleted.rowCount ?? 0;
    }
    if (snapshotCutoff !== null) {
      const deletedHoldings = await pool.query(
        `DELETE FROM kith.fin_holding_snapshots
          WHERE account_id = $1 AND source = 'archive' AND as_of >= $2`,
        [finAccountId, snapshotCutoff],
      );
      result.rowsDeletedAsOverlap += deletedHoldings.rowCount ?? 0;
      const deletedBalances = await pool.query(
        `DELETE FROM kith.fin_balance_snapshots
          WHERE account_id = $1 AND source = 'archive' AND as_of >= $2`,
        [finAccountId, snapshotCutoff],
      );
      result.rowsDeletedAsOverlap += deletedBalances.rowCount ?? 0;
    }

    const coverageThrough = earlierDate(transactionCutoff, snapshotCutoff);
    if (coverageThrough !== null) result.boundaryDateCount += 1;
    await pool.query(
      `UPDATE kith.fin_accounts SET archive_coverage_through = $2 WHERE id = $1`,
      [finAccountId, coverageThrough],
    );
  }

  for (const transaction of transactions) {
    const finAccountId = finAccountIdByArchiveId.get(transaction.accountId);
    if (finAccountId === undefined) continue;
    const cutoff = transactionCutoffByFinAccountId.get(finAccountId) ?? null;
    if (!isBeforeArchiveCutoff(transaction.date, cutoff)) {
      result.transactionsSkippedPastBoundary += 1;
      continue;
    }
    const securityId =
      transaction.instrumentId === null
        ? null
        : (finSecurityIdByInstrumentId.get(transaction.instrumentId) ?? null);
    await pool.query(
      `INSERT INTO kith.fin_transactions
         (id, account_id, date, posted_date, kind, description, amount,
          quantity, price, security_id, currency, source, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'archive', $12)
       ON CONFLICT (source, source_ref) DO UPDATE
         SET date = EXCLUDED.date,
             posted_date = EXCLUDED.posted_date,
             kind = EXCLUDED.kind,
             description = EXCLUDED.description,
             amount = EXCLUDED.amount,
             quantity = EXCLUDED.quantity,
             price = EXCLUDED.price,
             security_id = EXCLUDED.security_id,
             currency = EXCLUDED.currency,
             updated_at = transaction_timestamp()`,
      [
        newKithId(),
        finAccountId,
        transaction.date,
        transaction.postedDate,
        mapArchiveActivityKind(transaction.activityType),
        transaction.description || null,
        transaction.amount,
        transaction.quantity,
        transaction.price,
        securityId,
        transaction.currency,
        transaction.id,
      ],
    );
    result.transactionsImported += 1;
  }

  for (const position of positions) {
    const finAccountId = finAccountIdByArchiveId.get(position.accountId);
    if (finAccountId === undefined) continue;
    const cutoff = snapshotCutoffByFinAccountId.get(finAccountId) ?? null;
    if (!isBeforeArchiveCutoff(position.asOf, cutoff)) {
      result.positionsSkippedPastBoundary += 1;
      continue;
    }
    const securityId =
      position.instrumentId === null
        ? null
        : (finSecurityIdByInstrumentId.get(position.instrumentId) ?? null);
    // fin_holding_snapshots.security_id is NOT NULL: a position with no
    // instrument (a cash sweep line some statements print as a position) has
    // nowhere to go in a holdings snapshot and is skipped, counted rather
    // than silently dropped.
    if (securityId === null) {
      result.positionsSkippedNoInstrument += 1;
      continue;
    }
    await pool.query(
      `INSERT INTO kith.fin_holding_snapshots
         (id, account_id, as_of, security_id, quantity, price, value,
          cost_basis, currency, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'archive')
       ON CONFLICT (account_id, security_id, as_of, source) DO UPDATE
         SET quantity = EXCLUDED.quantity,
             price = EXCLUDED.price,
             value = EXCLUDED.value,
             cost_basis = EXCLUDED.cost_basis,
             currency = EXCLUDED.currency`,
      [
        newKithId(),
        finAccountId,
        position.asOf,
        securityId,
        position.quantity,
        position.price,
        position.value,
        position.costBasis,
        position.currency,
      ],
    );
    result.positionsImported += 1;
  }

  for (const balance of balances) {
    const finAccountId = finAccountIdByArchiveId.get(balance.accountId);
    if (finAccountId === undefined) continue;
    const cutoff = snapshotCutoffByFinAccountId.get(finAccountId) ?? null;
    if (!isBeforeArchiveCutoff(balance.asOf, cutoff)) {
      result.balancesSkippedPastBoundary += 1;
      continue;
    }
    await pool.query(
      `INSERT INTO kith.fin_balance_snapshots
         (id, account_id, as_of, current, currency, source)
       VALUES ($1, $2, $3, $4, $5, 'archive')
       ON CONFLICT (account_id, as_of, source) DO UPDATE
         SET current = EXCLUDED.current,
             currency = EXCLUDED.currency`,
      [newKithId(), finAccountId, balance.asOf, balance.total, balance.currency],
    );
    result.balancesImported += 1;
  }

  return result;
}

async function loadFinAccountCandidates(pool: Pool): Promise<LinkableFinAccountCandidate[]> {
  const { rows } = await pool.query<{
    id: string;
    institution_name: string;
    mask: string | null;
    name: string;
    plaid_account_id: string | null;
    archive_account_id: string | null;
  }>(
    `SELECT id, institution_name, mask, name, plaid_account_id, archive_account_id
       FROM kith.fin_accounts`,
  );
  return rows.map((row) => ({
    id: row.id,
    institutionName: row.institution_name,
    mask: row.mask,
    name: row.name,
    plaidAccountId: row.plaid_account_id,
    archiveAccountId: row.archive_account_id,
  }));
}

async function loadFinSecurityCandidates(pool: Pool): Promise<FinSecurityCandidate[]> {
  const { rows } = await pool.query<{
    id: string;
    ticker: string | null;
    cusip: string | null;
    isin: string | null;
  }>(`SELECT id, ticker, cusip, isin FROM kith.fin_securities`);
  return rows.map((row) => ({
    id: row.id,
    ticker: row.ticker,
    cusip: row.cusip,
    isin: row.isin,
  }));
}

/** One summary line, counts only -- never an account name, balance or
 * transaction amount, matching `pull`'s own printed-output rule. Leads with
 * the six counts the owner-facing spec for this fix names (accounts
 * matched, links set, archive-only accounts, rows inserted, rows deleted as
 * overlap, boundary date count), then the same per-kind detail the original
 * format printed. */
export function summarizeImportArchive(result: ImportArchiveResult): string {
  const rowsInserted =
    result.transactionsImported + result.positionsImported + result.balancesImported;
  return [
    "plaid import-archive",
    `accounts_matched=${result.accountsMatched}`,
    `links_set=${result.linksSet}`,
    `archive_only_accounts=${result.archiveOnlyAccounts}`,
    `rows_inserted=${rowsInserted}`,
    `rows_deleted_as_overlap=${result.rowsDeletedAsOverlap}`,
    `boundary_date_count=${result.boundaryDateCount}`,
    `accounts_created=${result.accountsCreated}`,
    `accounts_merged=${result.accountsMerged}`,
    `instruments_matched=${result.instrumentsMatched}`,
    `instruments_created=${result.instrumentsCreated}`,
    `transactions_imported=${result.transactionsImported}`,
    `transactions_skipped_past_boundary=${result.transactionsSkippedPastBoundary}`,
    `positions_imported=${result.positionsImported}`,
    `positions_skipped_no_instrument=${result.positionsSkippedNoInstrument}`,
    `positions_skipped_past_boundary=${result.positionsSkippedPastBoundary}`,
    `balances_imported=${result.balancesImported}`,
    `balances_skipped_past_boundary=${result.balancesSkippedPastBoundary}`,
  ].join(" ");
}
