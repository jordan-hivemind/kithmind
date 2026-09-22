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
// Boundary rule: an account that already has Plaid transactions in the
// ledger only gets archive transactions strictly before the earliest Plaid
// date already there -- the archive is history, Plaid is the current feed,
// and importing archive rows past where Plaid's own history starts would
// duplicate coverage under two sources instead of extending it. An account
// with no Plaid transactions yet (not linked, or linked but not yet pulled)
// gets its entire archive history: there is nothing to bound against.
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
  instrumentsMatched: number;
  instrumentsCreated: number;
  transactionsImported: number;
  transactionsSkippedPastBoundary: number;
  positionsImported: number;
  positionsSkippedNoInstrument: number;
  balancesImported: number;
};

function emptyResult(): ImportArchiveResult {
  return {
    accountsMatched: 0,
    accountsCreated: 0,
    instrumentsMatched: 0,
    instrumentsCreated: 0,
    transactionsImported: 0,
    transactionsSkippedPastBoundary: 0,
    positionsImported: 0,
    positionsSkippedNoInstrument: 0,
    balancesImported: 0,
  };
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
 * The whole import, given an archive reader and the kith writer pool. Pure
 * orchestration over the pure matching/boundary functions above and
 * `db.ts`-shaped upserts, so the matching and boundary rules stay tested
 * without a database while this function itself is covered by the Postgres
 * test that seeds both an archive-style and a Plaid-style account.
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
    const match = matchArchiveAccount(account, finAccounts);
    if (match !== null) {
      result.accountsMatched += 1;
      await pool.query(
        `UPDATE kith.fin_accounts
            SET archive_account_id = $2, updated_at = transaction_timestamp()
          WHERE id = $1 AND archive_account_id IS NULL`,
        [match.id, account.id],
      );
      finAccountIdByArchiveId.set(account.id, match.id);
    } else {
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
      });
    }
  }

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

  const plaidCutoffByFinAccountId = new Map<string, string | null>();
  for (const finAccountId of new Set(finAccountIdByArchiveId.values())) {
    const { rows } = await pool.query<{ earliest: string | null }>(
      `SELECT min(date)::text AS earliest
         FROM kith.fin_transactions
        WHERE account_id = $1 AND source = 'plaid'`,
      [finAccountId],
    );
    plaidCutoffByFinAccountId.set(finAccountId, rows[0]?.earliest ?? null);
  }

  for (const transaction of transactions) {
    const finAccountId = finAccountIdByArchiveId.get(transaction.accountId);
    if (finAccountId === undefined) continue;
    const cutoff = plaidCutoffByFinAccountId.get(finAccountId) ?? null;
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

async function loadFinAccountCandidates(pool: Pool): Promise<FinAccountCandidate[]> {
  const { rows } = await pool.query<{
    id: string;
    institution_name: string;
    mask: string | null;
    name: string;
  }>(`SELECT id, institution_name, mask, name FROM kith.fin_accounts`);
  return rows.map((row) => ({
    id: row.id,
    institutionName: row.institution_name,
    mask: row.mask,
    name: row.name,
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
 * transaction amount, matching `pull`'s own printed-output rule. */
export function summarizeImportArchive(result: ImportArchiveResult): string {
  return [
    "plaid import-archive",
    `accounts_matched=${result.accountsMatched}`,
    `accounts_created=${result.accountsCreated}`,
    `instruments_matched=${result.instrumentsMatched}`,
    `instruments_created=${result.instrumentsCreated}`,
    `transactions_imported=${result.transactionsImported}`,
    `transactions_skipped_past_boundary=${result.transactionsSkippedPastBoundary}`,
    `positions_imported=${result.positionsImported}`,
    `positions_skipped_no_instrument=${result.positionsSkippedNoInstrument}`,
    `balances_imported=${result.balancesImported}`,
  ].join(" ");
}
