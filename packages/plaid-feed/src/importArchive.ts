// `kith-plaid-feed import-archive`: a self-repairing read of the finance
// archive (statement-derived, Morgan Stanley only, `finance.transactions`
// 2020 to present) into the same `kith.fin_*` tables `pull` writes the Plaid
// feed into. See docs/plans/2026-09-22-simplification-and-feeds.md and
// migration 048_finance_unify.sql: the owner does not want the archive and
// the Plaid feed to be two ledgers to query separately, so this makes the
// archive's own rows part of the one ledger instead of leaving them behind a
// second read contract.
//
// Read-only against the archive: every query here is a SELECT, never an
// INSERT/UPDATE/DELETE, and it connects with the archive's own reader-role
// credential (`FINANCE_ARCHIVE_READER_DATABASE_URL`, the same one
// `apps/web/src/lib/mcp/finance.ts` uses) rather than a writer connection.
// The finance-archive write path is untouched.
//
// FIN-3: the owner's post-PR-433 live-database audit found the account
// matching below (mask, then name) had collapsed 19 distinct archive
// accounts onto 5 `kith.fin_accounts` rows -- one per `account_type` bucket
// at the one archive institution, each bucket's row count equal to that
// type's whole archive total (12 brokerage accounts on one row, 3 trust, 2
// retirement). `finance.accounts.display_name` is null or generic on this
// database, so every one of those archive accounts fell back to the same
// placeholder name ("Unlabeled account") -- and nothing below stopped that
// placeholder from being compared as if it were real evidence, including
// against another archive-only row. The audit also found 0 of 24 audited
// `acct_last4` values equal to any Plaid `mask` at the same institution:
// Plaid masks a different identifier than the statement account number at
// this institution, so mask cannot be this ledger's primary link either.
//
// The fix has three parts, each documented at its own definition below:
//
// 1. An archive account is identified only by its own archive id
//    (`archive_account_id`, UNIQUE on `kith.fin_accounts`). Name- and
//    mask-based matching (`matchArchiveAccount`) now only ever considers
//    candidates that already carry a `plaid_account_id` -- an archive-only
//    row (no feed account yet) is never a valid match target for a
//    *different* archive account, by name or by mask -- and never matches on
//    a null or placeholder name on either side (`isUsableName`).
// 2. Holdings-overlap matching (`matchByHoldingsOverlap`) is the new primary
//    automatic method for an investment account: the latest position
//    identifiers (CUSIP, then ISIN, then ticker) an archive account and a
//    Plaid-linked account each report, compared by Jaccard overlap.
//    Balance-equality matching (`matchByBalance`) is primary for an account
//    with no holdings to compare (a loan, a credit line, cash). Mask and
//    name matching remain as secondary, fallback methods. Every method that
//    sets `archive_account_id` also records `match_method` (migration 050)
//    so a reader can see how a link was made, and an owner's `--link`/
//    `--unlink` (`kith.fin_account_link_overrides`, migration 050) is
//    authoritative over every automatic method, checked first and persisted
//    past the run that set it.
// 3. Self-repair for rows an earlier, collapsed-matching run already wrote
//    to the wrong `fin_accounts` row: `reattributeArchiveRows` moves every
//    misattributed row onto the correct one, `deleteEmptyArchiveOnlyAccounts`
//    removes whatever archive-only row is left with nothing on it and no
//    feed link, and the existing overlap-boundary step (unchanged) then
//    applies to the now-correctly-attributed rows.
//
// Idempotent by `(source, source_ref)` on `kith.fin_transactions` -- the
// archive's own transaction row id is source-stable, so running this again
// (a later account gets statement history, a correction lands in the
// archive) upserts rather than duplicates. Account and instrument matching
// re-derives the same match every run for the same data, so re-running
// before any new archive data lands is a no-op past the first run.
//
// Linking: an archive account already linked to a `kith.fin_accounts` row
// (by `archive_account_id`) reuses that row -- it is never re-matched by any
// automatic method once linked, so a later run can never move an archive
// account's history onto a different row. When that existing row has no
// `plaid_account_id` yet (an "archive-only" row a previous run created
// because no feed account existed at the time) and a feed account now
// exists matching by holdings, balance, mask or name, the archive-only
// row's transactions and snapshots move onto the feed row, the feed row
// gets `archive_account_id` set, and the now-empty archive-only row is
// deleted -- see `mergeArchiveOnlyAccount`. An archive account with no
// existing link is matched onto an *unclaimed* candidate (no
// `archive_account_id` yet) so two different archive accounts sharing a
// generic display name can never both claim the same feed row -- the first
// one to match claims it in-memory for the rest of this run, not only in
// the database.
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

import { archiveSchemaOf } from "@repo/finance-archive";
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

/** How `archive_account_id` was set on a `kith.fin_accounts` row (migration
 * 050). `holdings` and `balance` are the new primary automatic methods;
 * `mask` and `name` are the original two, kept as secondary fallbacks;
 * `manual` is an owner-supplied `--link`. */
export type MatchMethod = "holdings" | "balance" | "mask" | "name" | "manual";

/** A `kith.fin_accounts` row as a match candidate: every field
 * `matchArchiveAccount` and `planArchiveAccountLink` need to decide whether
 * a row is a valid target, already linked to a *different* archive account,
 * or an archive-only row that is never a valid match target for name/mask
 * matching. */
export type FinAccountCandidate = {
  id: string;
  institutionName: string;
  mask: string | null;
  name: string;
  plaidAccountId: string | null;
};

export type LinkableFinAccountCandidate = FinAccountCandidate & {
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

/** The exact fallback text `archiveReader.accounts()` (below) substitutes
 * for a null or blank `display_name` -- never usable as match evidence,
 * since every archive account with no display name produces the identical
 * string. Matched case-insensitively against a trimmed name so a
 * differently-cased or padded copy of the same fallback is still caught. */
const PLACEHOLDER_NAME = "unlabeled account";

/** `false` for an empty/blank name or this module's own placeholder
 * fallback -- a name that carries no information about which account it
 * actually names, and so must never be compared as if it did. */
function isUsableName(name: string): boolean {
  const trimmed = normalize(name);
  return trimmed.length > 0 && trimmed !== PLACEHOLDER_NAME;
}

/**
 * An archive account against the ledger's existing `fin_accounts`: by
 * institution plus the last-four mask first, then by institution plus name.
 * `null` means no existing row matches and the caller creates one (or tries
 * a different method -- see `planArchiveAccountLink`, which tries holdings
 * and balance overlap before falling back to this).
 *
 * Two invariants this function enforces itself, not just its callers, after
 * the FIN-3 audit found archive accounts of the same institution and type
 * collapsing onto one `fin_accounts` row:
 *
 * - Only a candidate that already carries a `plaid_account_id` (a real feed
 *   account) is ever offered a match. An archive-only row -- another
 *   archive account's own placeholder-named row, in particular -- is never a
 *   valid target: identity here comes only from an archive account's own
 *   `archive_account_id`, never from matching one archive-only row against
 *   another.
 * - Neither side's name is used for matching unless it is a *usable* name
 *   (`isUsableName`): a null, blank, or the fallback placeholder
 *   `archiveReader.accounts()` substitutes for a missing display name
 *   (`"Unlabeled account"`) carries no identity and must never be treated
 *   as if it did, on either side of the comparison.
 */
export function matchArchiveAccount(
  archive: ArchiveAccountRow,
  candidates: readonly FinAccountCandidate[],
): ArchiveAccountMatch | null {
  const sameInstitution = candidates.filter(
    (candidate) =>
      normalize(candidate.institutionName) === normalize(archive.institutionName) &&
      // Loose (`!=`) on purpose: a candidate that omits `plaidAccountId`
      // entirely is treated the same as one that explicitly carries `null`
      // -- neither is a real feed account, so neither is a valid match
      // target.
      candidate.plaidAccountId != null,
  );
  if (archive.mask !== null) {
    const byMask = sameInstitution.find(
      (candidate) => candidate.mask !== null && candidate.mask === archive.mask,
    );
    if (byMask !== undefined) return { id: byMask.id, method: "mask" };
  }
  if (isUsableName(archive.name)) {
    const byName = sameInstitution.find(
      (candidate) => isUsableName(candidate.name) && normalize(candidate.name) === normalize(archive.name),
    );
    if (byName !== undefined) return { id: byName.id, method: "name" };
  }
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
  | { kind: "merge"; archiveOnlyFinAccountId: string; feedFinAccountId: string; method: MatchMethod }
  /** This archive account has no existing link and matched an unclaimed
   * fin_accounts row (which may or may not itself have a plaid_account_id)
   * -- set archive_account_id on it. */
  | { kind: "match"; finAccountId: string; method: MatchMethod }
  /** No existing link and nothing matched (or a manual override blocks
   * automatic matching, or points at a Plaid account that does not exist
   * yet) -- the caller creates a new archive-only row. */
  | { kind: "create" };

/** Precomputed match for one archive account, from a batch method
 * (holdings overlap or balance equality) run once per import across every
 * archive account and every unclaimed feed candidate -- see
 * `matchByHoldingsOverlap` and `matchByBalance`. */
export type PrecomputedMatch = { finAccountId: string; method: MatchMethod };

export type PlanArchiveAccountLinkOptions = {
  /** An owner's `--link`/`--unlink` for this archive account, read from
   * `kith.fin_account_link_overrides` (migration 050):
   * `undefined` -- no override, automatic matching applies as usual.
   * a `plaid_account_id` string -- link to that specific feed account,
   *   never anything automatic matching would have picked instead.
   * `null` -- an explicit `--unlink`: never automatically match this
   *   archive account to anything.
   */
  manualTarget?: string | null;
  /** This archive account's holdings-overlap or balance-equality match, if
   * the batch pass found one -- checked after a manual override and before
   * the mask/name fallback in `matchArchiveAccount`. */
  precomputed?: PrecomputedMatch;
};

/**
 * Whole-run link planning for one archive account, given every current
 * `kith.fin_accounts` row's link state. Pure so the merge decision -- the
 * part `matchArchiveAccount` alone cannot make, since it does not know which
 * candidates are already claimed by a *different* archive account or which
 * one this same archive account was already linked to by an earlier run --
 * is unit-testable with synthetic rows, no database.
 *
 * Priority order for an archive account with no existing link (or an
 * existing archive-only link still looking for a feed row to merge into):
 * a manual override first (authoritative, never overridden by anything
 * automatic), then a precomputed holdings/balance match, then
 * `matchArchiveAccount`'s mask/name fallback, then `create`.
 *
 * An archive account already linked (by `archive_account_id`) to a row that
 * also has a `plaid_account_id` is never re-matched by anything: once fully
 * linked, only the merge path (an archive-only row gaining a feed match)
 * can change which row it points to, and that only ever moves it onto a
 * feed row, never onto a different archive-only or already-merged row.
 * Candidates already claimed by another archive account (their own
 * `archive_account_id` already set to something else) are never offered to
 * any matching method, so two different archive accounts that share a
 * generic display name -- or a coincidental holdings/balance overlap --
 * can never both claim the same feed row within one run.
 */
export function planArchiveAccountLink(
  archive: ArchiveAccountRow,
  candidates: readonly LinkableFinAccountCandidate[],
  options: PlanArchiveAccountLinkOptions = {},
): ArchiveAccountLinkAction {
  const { manualTarget, precomputed } = options;
  const existing = candidates.find((c) => c.archiveAccountId === archive.id);

  if (existing !== undefined) {
    if (existing.plaidAccountId !== null) {
      return { kind: "already-linked", finAccountId: existing.id };
    }
    // Archive-only so far. A blocked override never merges automatically.
    if (manualTarget === null) {
      return { kind: "already-linked", finAccountId: existing.id };
    }
    if (manualTarget !== undefined) {
      const target = candidates.find(
        (c) => c.id !== existing.id && c.archiveAccountId === null && c.plaidAccountId === manualTarget,
      );
      if (target !== undefined) {
        return {
          kind: "merge",
          archiveOnlyFinAccountId: existing.id,
          feedFinAccountId: target.id,
          method: "manual",
        };
      }
      return { kind: "already-linked", finAccountId: existing.id };
    }
    if (precomputed !== undefined) {
      const target = candidates.find(
        (c) => c.id === precomputed.finAccountId && c.archiveAccountId === null && c.plaidAccountId !== null,
      );
      if (target !== undefined) {
        return {
          kind: "merge",
          archiveOnlyFinAccountId: existing.id,
          feedFinAccountId: target.id,
          method: precomputed.method,
        };
      }
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
        method: merge.method,
      };
    }
    return { kind: "already-linked", finAccountId: existing.id };
  }

  // No existing link at all.
  if (manualTarget === null) {
    return { kind: "create" };
  }
  if (manualTarget !== undefined) {
    const target = candidates.find((c) => c.archiveAccountId === null && c.plaidAccountId === manualTarget);
    if (target !== undefined) {
      return { kind: "match", finAccountId: target.id, method: "manual" };
    }
    // The owner's chosen Plaid account does not exist in the ledger yet --
    // create an archive-only row and try again on a later run.
    return { kind: "create" };
  }
  if (precomputed !== undefined) {
    const target = candidates.find(
      (c) => c.id === precomputed.finAccountId && c.archiveAccountId === null && c.plaidAccountId !== null,
    );
    if (target !== undefined) {
      return { kind: "match", finAccountId: target.id, method: precomputed.method };
    }
  }
  const unclaimed = candidates.filter((c) => c.archiveAccountId === null);
  const match = matchArchiveAccount(archive, unclaimed);
  if (match !== null) {
    return { kind: "match", finAccountId: match.id, method: match.method };
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

// -- Holdings-overlap and balance-equality matching -------------------------
//
// Both are batch methods: run once per import over every not-yet-linked
// archive account and every unclaimed feed candidate, rather than per
// account like matchArchiveAccount, because "the best match" and "one to
// one" are properties of the whole assignment, not of a single pair.

/** `cusip`, else `isin`, else `ticker`, prefixed with its own kind so a
 * CUSIP that happens to collide with a ticker string can never be treated
 * as the same identifier. `null` when none of the three is present. */
export function bestIdentifier(
  cusip: string | null,
  isin: string | null,
  ticker: string | null,
): string | null {
  const c = cusip?.trim();
  if (c) return `cusip:${c.toUpperCase()}`;
  const i = isin?.trim();
  if (i) return `isin:${i.toUpperCase()}`;
  const t = ticker?.trim();
  if (t) return `ticker:${t.toUpperCase()}`;
  return null;
}

/** One account's identifier -> quantity holdings, at whatever single `as_of`
 * date turned out latest for that account. */
export type AccountIdentifierProfile = {
  accountId: string;
  identifiers: ReadonlyMap<string, number>;
};

/** One account's latest reported balance. */
export type AccountBalanceProfile = {
  accountId: string;
  asOf: string;
  value: number;
};

/** Keeps, per `accountId`, only the rows at that account's own latest
 * `asOf` -- an account's "the rest of the multi-security snapshot on its
 * most recent statement date" reduction shared by both holdings and balance
 * profile building. */
function latestPerAccount<T extends { accountId: string; asOf: string }>(
  rows: readonly T[],
): T[] {
  const latestByAccount = new Map<string, string>();
  for (const row of rows) {
    const current = latestByAccount.get(row.accountId);
    if (current === undefined || row.asOf > current) latestByAccount.set(row.accountId, row.asOf);
  }
  return rows.filter((row) => latestByAccount.get(row.accountId) === row.asOf);
}

/** One holding at one account, on the date that turned out to be its own
 * latest -- the shared input shape both the archive side (from
 * `ArchivePositionRow` + `ArchiveInstrumentRow`) and the feed side (from a
 * `kith.fin_holding_snapshots`/`fin_securities` join) reduce down to before
 * `matchByHoldingsOverlap` compares them. */
export type IdentifiedHoldingRow = { accountId: string; asOf: string; identifier: string; quantity: number };

/** Groups identified holdings by account, at each account's own latest
 * date, summing quantity when the same identifier appears twice on one
 * account's latest date (a security held across more than one sub-lot). */
export function buildHoldingsProfiles(
  rows: readonly IdentifiedHoldingRow[],
): AccountIdentifierProfile[] {
  const latest = latestPerAccount(rows);
  const byAccount = new Map<string, Map<string, number>>();
  for (const row of latest) {
    let identifiers = byAccount.get(row.accountId);
    if (identifiers === undefined) {
      identifiers = new Map();
      byAccount.set(row.accountId, identifiers);
    }
    identifiers.set(row.identifier, (identifiers.get(row.identifier) ?? 0) + row.quantity);
  }
  return [...byAccount.entries()].map(([accountId, identifiers]) => ({ accountId, identifiers }));
}

/** One `kith.fin_accounts` id linked to one archive account id by
 * holdings-overlap or balance-equality (see `matchByHoldingsOverlap` and
 * `matchByBalance`). */
export type OverlapMatch = { archiveAccountId: string; finAccountId: string; method: MatchMethod };

/**
 * Investment-account linking, primary method: the archive account and the
 * feed account whose latest reported holdings overlap the most, by Jaccard
 * similarity over the *set* of identifiers each side reports (not a
 * multiset -- two accounts holding the same five securities in different
 * proportions are still the same account). A pair needs at least
 * `minShared` identifiers in common and a Jaccard of at least `minJaccard`
 * to be considered at all; among qualifying pairs, the highest Jaccard wins,
 * ties broken by quantity agreement on the shared identifiers (closer
 * average relative difference wins), then by shared-identifier count, then
 * by id order for a fully deterministic result. One to one: greedy
 * best-first assignment, so a candidate already claimed by a better-scoring
 * pair is never offered to a second one.
 */
export function matchByHoldingsOverlap(
  archiveProfiles: readonly AccountIdentifierProfile[],
  candidateProfiles: readonly AccountIdentifierProfile[],
  options: { minJaccard?: number; minShared?: number } = {},
): OverlapMatch[] {
  const minJaccard = options.minJaccard ?? 0.6;
  const minShared = options.minShared ?? 2;

  type Scored = OverlapMatch & { jaccard: number; sharedCount: number; quantityScore: number };
  const pairs: Scored[] = [];

  for (const archiveProfile of archiveProfiles) {
    for (const candidateProfile of candidateProfiles) {
      let shared = 0;
      let relativeDiffTotal = 0;
      for (const [identifier, archiveQuantity] of archiveProfile.identifiers) {
        const candidateQuantity = candidateProfile.identifiers.get(identifier);
        if (candidateQuantity === undefined) continue;
        shared += 1;
        const denominator = Math.max(Math.abs(archiveQuantity), Math.abs(candidateQuantity), 1e-9);
        relativeDiffTotal += Math.abs(archiveQuantity - candidateQuantity) / denominator;
      }
      if (shared < minShared) continue;
      const union = new Set([...archiveProfile.identifiers.keys(), ...candidateProfile.identifiers.keys()]).size;
      const jaccard = union === 0 ? 0 : shared / union;
      if (jaccard < minJaccard) continue;
      pairs.push({
        archiveAccountId: archiveProfile.accountId,
        finAccountId: candidateProfile.accountId,
        method: "holdings",
        jaccard,
        sharedCount: shared,
        quantityScore: -(relativeDiffTotal / shared),
      });
    }
  }

  pairs.sort(
    (a, b) =>
      b.jaccard - a.jaccard ||
      b.quantityScore - a.quantityScore ||
      b.sharedCount - a.sharedCount ||
      a.archiveAccountId.localeCompare(b.archiveAccountId) ||
      a.finAccountId.localeCompare(b.finAccountId),
  );

  const usedArchiveIds = new Set<string>();
  const usedFinIds = new Set<string>();
  const result: OverlapMatch[] = [];
  for (const pair of pairs) {
    if (usedArchiveIds.has(pair.archiveAccountId) || usedFinIds.has(pair.finAccountId)) continue;
    usedArchiveIds.add(pair.archiveAccountId);
    usedFinIds.add(pair.finAccountId);
    result.push({ archiveAccountId: pair.archiveAccountId, finAccountId: pair.finAccountId, method: pair.method });
  }
  return result;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Linking for an account with nothing to compare holdings on -- a loan, a
 * credit line, cash: the archive account and the feed account whose latest
 * reported balances are within `toleranceRatio` (relative to the larger of
 * the two, so a tiny balance is not judged by an absurdly tight absolute
 * bar) of each other, on dates no more than `maxDayGap` apart. Among
 * qualifying pairs, the closest relative difference wins, ties broken by
 * the smaller day gap, then by id order. One to one, same greedy
 * best-first assignment as `matchByHoldingsOverlap`.
 */
export function matchByBalance(
  archiveProfiles: readonly AccountBalanceProfile[],
  candidateProfiles: readonly AccountBalanceProfile[],
  options: { toleranceRatio?: number; maxDayGap?: number } = {},
): OverlapMatch[] {
  const toleranceRatio = options.toleranceRatio ?? 0.01;
  const maxDayGap = options.maxDayGap ?? 45;

  type Scored = OverlapMatch & { relativeDiff: number; dayGap: number };
  const pairs: Scored[] = [];
  for (const archiveProfile of archiveProfiles) {
    for (const candidateProfile of candidateProfiles) {
      const dayGap = daysBetween(archiveProfile.asOf, candidateProfile.asOf);
      if (dayGap > maxDayGap) continue;
      const denominator = Math.max(Math.abs(archiveProfile.value), Math.abs(candidateProfile.value), 0.01);
      const relativeDiff = Math.abs(archiveProfile.value - candidateProfile.value) / denominator;
      if (relativeDiff > toleranceRatio) continue;
      pairs.push({
        archiveAccountId: archiveProfile.accountId,
        finAccountId: candidateProfile.accountId,
        method: "balance",
        relativeDiff,
        dayGap,
      });
    }
  }

  pairs.sort(
    (a, b) =>
      a.relativeDiff - b.relativeDiff ||
      a.dayGap - b.dayGap ||
      a.archiveAccountId.localeCompare(b.archiveAccountId) ||
      a.finAccountId.localeCompare(b.finAccountId),
  );

  const usedArchiveIds = new Set<string>();
  const usedFinIds = new Set<string>();
  const result: OverlapMatch[] = [];
  for (const pair of pairs) {
    if (usedArchiveIds.has(pair.archiveAccountId) || usedFinIds.has(pair.finAccountId)) continue;
    usedArchiveIds.add(pair.archiveAccountId);
    usedFinIds.add(pair.finAccountId);
    result.push({ archiveAccountId: pair.archiveAccountId, finAccountId: pair.finAccountId, method: pair.method });
  }
  return result;
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
  /** Links this run set (matches and merges combined), broken down by
   * `match_method` -- see `MatchMethod`. */
  linksByMethod: Record<MatchMethod, number>;
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
  /** Existing archive-source rows this run moved from the `fin_accounts`
   * row they were wrongly attributed to onto the correct one -- the FIN-3
   * self-repair step (`reattributeArchiveRows`) undoing an earlier
   * collapsed-matching run. Zero on a run against already-correct data. */
  rowsReattributed: number;
  /** Archive-only `fin_accounts` rows this run deleted because reattribution
   * left them with no rows at all and no feed link -- a stale bucket an
   * earlier run created that nothing legitimately owns any more. */
  emptyAccountsRemoved: number;
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
    linksByMethod: { holdings: 0, balance: 0, mask: 0, name: 0, manual: 0 },
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
    rowsReattributed: 0,
    emptyAccountsRemoved: 0,
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
  /** Archive account details for a specific set of ids, regardless of
   * `closed_date` -- unlike `accounts()`, which only returns open accounts.
   * Used by self-repair (`reattributeArchiveRows`) when a misattributed
   * row's true archive account turns out to be one this run's `accounts()`
   * did not return (closed since the row was first imported). */
  accountsByIds(ids: readonly string[]): Promise<ArchiveAccountRow[]>;
  instruments(): Promise<ArchiveInstrumentRow[]>;
  transactions(accountIds: readonly string[]): Promise<ArchiveTransactionRow[]>;
  positions(accountIds: readonly string[]): Promise<ArchivePositionRow[]>;
  balances(accountIds: readonly string[]): Promise<ArchiveBalanceRow[]>;
  /** `finance.transactions.id -> finance.transactions.account_id` for a
   * specific set of transaction ids -- the join self-repair needs to learn
   * which archive account a `kith.fin_transactions` row's `source_ref`
   * (that same transaction id) actually belongs to. */
  transactionAccountIds(transactionIds: readonly string[]): Promise<Map<string, string>>;
};

/**
 * A read-only `ArchiveReader` against a real archive connection. Every query
 * below schema-qualifies its archive tables with the schema this connection
 * is actually pinned to (`archiveSchemaOf(client)` -- `createArchiveClient`/
 * `createArchivePool` record it when they pin `search_path`, defaulting to
 * `archiveSchemaName()`, `finance` unless `FINANCE_ARCHIVE_SCHEMA` overrides
 * it). Defense in depth on top of that `search_path` pin, not a substitute
 * for it: `${schema}.accounts` resolves correctly regardless of whatever
 * schemas happen to precede or follow `finance` on the connection's
 * `search_path`, including a same-named legacy or unrelated table sitting
 * earlier in the path. `assertArchiveSchemaReady` (below) checks that this
 * schema and its tables actually exist before any of these queries run, so
 * a misconfigured connection fails fast and clearly instead of this reader
 * silently resolving to the wrong table or erroring on the first query with
 * a bare "relation does not exist".
 */
export function archiveReader(client: pg.ClientBase): ArchiveReader {
  const schema = archiveSchemaOf(client);
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
           FROM ${schema}.accounts a
           JOIN ${schema}.institutions i ON i.id = a.institution_id
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
    async accountsByIds(ids) {
      if (ids.length === 0) return [];
      const { rows } = await client.query<{
        id: string;
        institution_name: string;
        acct_last4: string | null;
        display_name: string | null;
        account_type: string | null;
      }>(
        `SELECT a.id, i.name AS institution_name, a.acct_last4,
                a.display_name, a.account_type
           FROM ${schema}.accounts a
           JOIN ${schema}.institutions i ON i.id = a.institution_id
          WHERE a.id = ANY($1)
          ORDER BY a.id`,
        [ids],
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
      }>(
        `SELECT id, symbol, cusip, isin, name, instrument_kind
           FROM ${schema}.instruments`,
      );
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
           FROM ${schema}.transactions
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
           FROM ${schema}.positions
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
           FROM ${schema}.balances
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
    async transactionAccountIds(transactionIds) {
      if (transactionIds.length === 0) return new Map();
      const { rows } = await client.query<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM ${schema}.transactions WHERE id = ANY($1)`,
        [transactionIds],
      );
      return new Map(rows.map((row) => [row.id, row.account_id]));
    },
  };
}

/**
 * A startup guard: confirms the archive connection actually resolves
 * `${schema}.accounts` before `import-archive` does any real reading, so a
 * database missing the archive schema entirely, or a connection whose
 * `search_path` pin somehow did not take, fails immediately with a clear
 * message instead of every query below either erroring on "relation does
 * not exist" one at a time or -- the failure mode with no error at all --
 * silently resolving to a same-named table that happens to sit earlier on
 * the connection's `search_path`.
 */
export async function assertArchiveSchemaReady(client: pg.ClientBase): Promise<void> {
  const schema = archiveSchemaOf(client);
  try {
    await client.query(`SELECT count(*) FROM ${schema}.accounts`);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `import-archive: could not read ${schema}.accounts on the archive ` +
        `connection -- the ${schema} schema may not exist on this database, ` +
        `or the connection's search_path may not resolve it. Original error: ${cause}`,
    );
  }
}

// -- Manual link overrides (kith.fin_account_link_overrides, migration 050) -

/**
 * An owner's `--link <archive_account_id>=<plaid_account_id>`: persists a
 * pairing that every future run's automatic matching (holdings, balance,
 * mask, name) treats as authoritative and never overwrites. Overwrites a
 * previous override for the same archive account, including a prior
 * `--unlink`.
 */
export async function setManualLink(
  pool: Pool,
  archiveAccountId: string,
  plaidAccountId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO kith.fin_account_link_overrides (archive_account_id, plaid_account_id)
     VALUES ($1, $2)
     ON CONFLICT (archive_account_id) DO UPDATE
       SET plaid_account_id = EXCLUDED.plaid_account_id, updated_at = transaction_timestamp()`,
    [archiveAccountId, plaidAccountId],
  );
}

/**
 * An owner's `--unlink <archive_account_id>`: persists a block on automatic
 * matching for this archive account, and immediately splits it back out to
 * its own archive-only row if it is currently merged into a feed row --
 * the owner rejected that link, so future runs must not keep serving its
 * archive history through it.
 */
export async function setManualUnlink(pool: Pool, archiveAccountId: string): Promise<void> {
  await pool.query(
    `INSERT INTO kith.fin_account_link_overrides (archive_account_id, plaid_account_id)
     VALUES ($1, NULL)
     ON CONFLICT (archive_account_id) DO UPDATE
       SET plaid_account_id = NULL, updated_at = transaction_timestamp()`,
    [archiveAccountId],
  );
  await splitArchiveAccountFromFeedRow(pool, archiveAccountId);
}

async function loadManualOverrides(pool: Pool): Promise<Map<string, string | null>> {
  const { rows } = await pool.query<{ archive_account_id: string; plaid_account_id: string | null }>(
    `SELECT archive_account_id, plaid_account_id FROM kith.fin_account_link_overrides`,
  );
  return new Map(rows.map((row) => [row.archive_account_id, row.plaid_account_id]));
}

/** Detaches an archive account from whatever feed row it is currently
 * merged into, moving its archive-source rows onto a fresh archive-only
 * row -- the reverse of `mergeArchiveOnlyAccount`. A no-op if this archive
 * account is not currently linked to a row that also has a
 * `plaid_account_id` (nothing to split). */
async function splitArchiveAccountFromFeedRow(pool: Pool, archiveAccountId: string): Promise<void> {
  const { rows } = await pool.query<{
    id: string;
    institution_name: string;
    name: string;
    mask: string | null;
    type: string | null;
  }>(
    `SELECT id, institution_name, name, mask, type FROM kith.fin_accounts
      WHERE archive_account_id = $1 AND plaid_account_id IS NOT NULL`,
    [archiveAccountId],
  );
  const feedRow = rows[0];
  if (feedRow === undefined) return;
  const newId = newKithId();
  await pool.query(
    `INSERT INTO kith.fin_accounts (id, institution_name, name, mask, type, archive_account_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId, feedRow.institution_name, feedRow.name, feedRow.mask, feedRow.type, archiveAccountId],
  );
  await pool.query(
    `UPDATE kith.fin_transactions SET account_id = $2 WHERE account_id = $1 AND source = 'archive'`,
    [feedRow.id, newId],
  );
  await pool.query(
    `UPDATE kith.fin_holding_snapshots SET account_id = $2 WHERE account_id = $1 AND source = 'archive'`,
    [feedRow.id, newId],
  );
  await pool.query(
    `UPDATE kith.fin_balance_snapshots SET account_id = $2 WHERE account_id = $1 AND source = 'archive'`,
    [feedRow.id, newId],
  );
  await pool.query(
    `UPDATE kith.fin_accounts SET archive_account_id = NULL, match_method = NULL, updated_at = transaction_timestamp()
      WHERE id = $1`,
    [feedRow.id],
  );
}

/**
 * Move an archive-only `fin_accounts` row's transactions and snapshots onto
 * a feed row a later archive account link discovered, then set
 * `archive_account_id`/`match_method` on the feed row and delete the
 * now-empty archive-only row. Safe against a unique-constraint collision
 * because the feed row -- unclaimed, `archive_account_id IS NULL` -- can
 * only have `source = 'plaid'` rows so far: nothing this account's archive
 * rows carry (all `source = 'archive'`) can already exist there under the
 * same natural key.
 */
async function mergeArchiveOnlyAccount(
  pool: Pool,
  archiveOnlyFinAccountId: string,
  feedFinAccountId: string,
  archiveAccountId: string,
  method: MatchMethod,
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
        SET archive_account_id = $2, match_method = $3, updated_at = transaction_timestamp()
      WHERE id = $1 AND archive_account_id IS NULL`,
    [feedFinAccountId, archiveAccountId, method],
  );
}

// -- Self-repair: reattributing rows an earlier, collapsed-matching run

/**
 * FIN-3 self-repair, part one: every `kith.fin_transactions` row tagged
 * `source = 'archive'` carries `source_ref` = the archive's own
 * `transactions.id` -- stable, and never touched by which `fin_accounts`
 * row a collapsed match happened to write the row onto. Joining that back
 * to the archive's own `account_id` for the same transaction gives the one
 * ground truth for which account a row actually belongs to, independent of
 * whatever `fin_accounts` row it is currently sitting on. Any row whose
 * current `account_id` does not match `finAccountIdByArchiveId`'s answer
 * for its true archive account moves there, creating a `fin_accounts` row
 * for that archive account first if this run has not already made one (a
 * closed archive account `accounts()` does not return, in particular).
 * Returns the number of rows actually moved.
 */
async function reattributeTransactions(
  pool: Pool,
  archive: ArchiveReader,
  finAccountIdByArchiveId: Map<string, string>,
  finAccounts: LinkableFinAccountCandidate[],
): Promise<number> {
  const { rows: existing } = await pool.query<{ id: string; source_ref: string; account_id: string }>(
    `SELECT id, source_ref, account_id FROM kith.fin_transactions WHERE source = 'archive'`,
  );
  if (existing.length === 0) return 0;

  const archiveAccountIdByTransactionId = await archive.transactionAccountIds(
    existing.map((row) => row.source_ref),
  );

  let moved = 0;
  for (const row of existing) {
    const trueArchiveAccountId = archiveAccountIdByTransactionId.get(row.source_ref);
    // Not resolvable against the archive any more (a correction removed the
    // row, or `source_ref` was never valid) -- nothing to reattribute to.
    if (trueArchiveAccountId === undefined) continue;
    const correctFinAccountId = await ensureFinAccountForArchiveId(
      pool,
      archive,
      trueArchiveAccountId,
      finAccountIdByArchiveId,
      finAccounts,
    );
    if (correctFinAccountId === null || correctFinAccountId === row.account_id) continue;
    await pool.query(`UPDATE kith.fin_transactions SET account_id = $2 WHERE id = $1`, [
      row.id,
      correctFinAccountId,
    ]);
    moved += 1;
  }
  return moved;
}

/**
 * `finAccountIdByArchiveId.get(archiveAccountId)`, falling back to an
 * existing `fin_accounts` row already linked to it, falling back to
 * creating a new archive-only row for it -- used by self-repair when a
 * misattributed row's true archive account turns out to be one this run's
 * normal per-account loop never visited (a closed account). Returns `null`
 * only when the archive itself no longer has any record of this account id.
 */
async function ensureFinAccountForArchiveId(
  pool: Pool,
  archive: ArchiveReader,
  archiveAccountId: string,
  finAccountIdByArchiveId: Map<string, string>,
  finAccounts: LinkableFinAccountCandidate[],
): Promise<string | null> {
  const known = finAccountIdByArchiveId.get(archiveAccountId);
  if (known !== undefined) return known;
  const existing = finAccounts.find((c) => c.archiveAccountId === archiveAccountId);
  if (existing !== undefined) {
    finAccountIdByArchiveId.set(archiveAccountId, existing.id);
    return existing.id;
  }
  const [details] = await archive.accountsByIds([archiveAccountId]);
  if (details === undefined) return null;
  const id = newKithId();
  await pool.query(
    `INSERT INTO kith.fin_accounts (id, institution_name, name, mask, type, archive_account_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, details.institutionName, details.name, details.mask, details.accountType, details.id],
  );
  finAccountIdByArchiveId.set(archiveAccountId, id);
  finAccounts.push({
    id,
    institutionName: details.institutionName,
    mask: details.mask,
    name: details.name,
    plaidAccountId: null,
    archiveAccountId: details.id,
  });
  return id;
}

/**
 * FIN-3 self-repair, part two: `fin_holding_snapshots` and
 * `fin_balance_snapshots` carry no per-row archive locator the way
 * `fin_transactions.source_ref` does, so there is nothing to join a
 * specific existing row back to its true archive account by. Instead this
 * reconciles the whole table against the full, current, correctly-attributed
 * universe this run already knows (every archive position/balance, mapped
 * through `finAccountIdByArchiveId`): any existing `source = 'archive'` row
 * whose `(account_id, security_id, as_of)` (holdings) or
 * `(account_id, as_of)` (balances) is not in that universe is deleted,
 * wherever it currently sits -- on a wrong bucket a collapsed match created,
 * or simply stale because the archive position/balance it came from is
 * gone. The normal insert pass later in `importArchive` then reinserts
 * (upserts) exactly the correct, pre-boundary rows from that same universe,
 * so this is a full correction, not just a deletion. Idempotent: a second
 * run's universe is unchanged, so nothing new to delete.
 */
async function reconcileSnapshotAttribution(
  pool: Pool,
  archivePositions: readonly ArchivePositionRow[],
  archiveBalances: readonly ArchiveBalanceRow[],
  finAccountIdByArchiveId: ReadonlyMap<string, string>,
  finSecurityIdByInstrumentId: ReadonlyMap<string, string>,
): Promise<number> {
  let deleted = 0;

  const holdingAccountIds: string[] = [];
  const holdingSecurityIds: string[] = [];
  const holdingAsOfs: string[] = [];
  for (const position of archivePositions) {
    const finAccountId = finAccountIdByArchiveId.get(position.accountId);
    if (finAccountId === undefined || position.instrumentId === null) continue;
    const securityId = finSecurityIdByInstrumentId.get(position.instrumentId);
    if (securityId === undefined) continue;
    holdingAccountIds.push(finAccountId);
    holdingSecurityIds.push(securityId);
    holdingAsOfs.push(position.asOf);
  }
  {
    const result = await pool.query(
      `DELETE FROM kith.fin_holding_snapshots h
        WHERE h.source = 'archive'
          AND NOT EXISTS (
            SELECT 1 FROM unnest($1::text[], $2::text[], $3::date[])
              AS correct(account_id, security_id, as_of)
             WHERE correct.account_id = h.account_id
               AND correct.security_id = h.security_id
               AND correct.as_of = h.as_of
          )`,
      [holdingAccountIds, holdingSecurityIds, holdingAsOfs],
    );
    deleted += result.rowCount ?? 0;
  }

  const balanceAccountIds: string[] = [];
  const balanceAsOfs: string[] = [];
  for (const balance of archiveBalances) {
    const finAccountId = finAccountIdByArchiveId.get(balance.accountId);
    if (finAccountId === undefined) continue;
    balanceAccountIds.push(finAccountId);
    balanceAsOfs.push(balance.asOf);
  }
  {
    const result = await pool.query(
      `DELETE FROM kith.fin_balance_snapshots b
        WHERE b.source = 'archive'
          AND NOT EXISTS (
            SELECT 1 FROM unnest($1::text[], $2::date[]) AS correct(account_id, as_of)
             WHERE correct.account_id = b.account_id AND correct.as_of = b.as_of
          )`,
      [balanceAccountIds, balanceAsOfs],
    );
    deleted += result.rowCount ?? 0;
  }

  return deleted;
}

/**
 * FIN-3 self-repair, part three: an archive-only `fin_accounts` row (no
 * `plaid_account_id`) that reattribution and reconciliation above left with
 * no transactions, holdings or balances at all is a stale bucket -- either
 * an earlier collapsed-matching run's leftover after everything it wrongly
 * held moved away, or a row whose archive account no longer exists. Deleted
 * outright; a row that still has any rows, or that has a `plaid_account_id`
 * (a real feed account, even one with no archive history), is left alone.
 *
 * `currentTargetFinAccountIds` excludes every row this run's per-account
 * loop is about to populate (a brand new archive-only row from a "create"
 * this run, in particular): its own rows are only inserted later, in
 * `importArchive`'s insert pass, so at this point in the run it is
 * genuinely empty but not stale -- it just has not been filled in yet.
 */
async function deleteEmptyArchiveOnlyAccounts(
  pool: Pool,
  currentTargetFinAccountIds: readonly string[],
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM kith.fin_accounts fa
      WHERE fa.plaid_account_id IS NULL
        AND fa.id != ALL($1)
        AND NOT EXISTS (SELECT 1 FROM kith.fin_transactions t WHERE t.account_id = fa.id)
        AND NOT EXISTS (SELECT 1 FROM kith.fin_holding_snapshots h WHERE h.account_id = fa.id)
        AND NOT EXISTS (SELECT 1 FROM kith.fin_balance_snapshots b WHERE b.account_id = fa.id)`,
    [currentTargetFinAccountIds],
  );
  return result.rowCount ?? 0;
}

/**
 * The whole import, given an archive reader and the kith writer pool. Pure
 * orchestration over the pure matching/planning/boundary functions above and
 * `db.ts`-shaped upserts, so the matching, linking and boundary rules stay
 * tested without a database while this function itself is covered by the
 * Postgres tests in `test/ledger.test.mjs`.
 *
 * Order of operations, each documented at its own step below: load manual
 * overrides; read the archive; self-repair reattribution (so every
 * currently-open archive account's existing rows are on the right
 * `fin_accounts` row *before* linking decisions are made against them);
 * link every archive account (manual, then holdings/balance batch matching,
 * then mask/name, then create); match or create every instrument; delete
 * empty stale archive-only accounts; apply the overlap boundary; insert
 * (upsert) every transaction, position and balance before its account's
 * boundary.
 */
export async function importArchive(
  archive: ArchiveReader,
  pool: Pool,
): Promise<ImportArchiveResult> {
  const result = emptyResult();

  const manualOverrides = await loadManualOverrides(pool);

  // `archive.accounts()`/`archive.instruments()`/the three history reads run
  // over the same single archive connection (a `pg.Client`, not a `Pool`)
  // and so cannot run concurrently -- `pg.Client` queues a second query
  // issued before the first resolves and warns that it will stop doing so;
  // sequential here avoids relying on that queuing at all. `pool` is a real
  // `Pool`, so its reads are still run together where they appear below.
  const archiveAccounts = await archive.accounts();
  const archiveInstruments = await archive.instruments();
  const archiveAccountIds = archiveAccounts.map((account) => account.id);
  const archiveTransactions = await archive.transactions(archiveAccountIds);
  const archivePositions = await archive.positions(archiveAccountIds);
  const archiveBalances = await archive.balances(archiveAccountIds);

  const [finAccounts, finSecurities] = await Promise.all([
    loadFinAccountCandidates(pool),
    loadFinSecurityCandidates(pool),
  ]);

  // Instrument matching first: the holdings-overlap pass below needs
  // finSecurityIdByInstrumentId to translate an archive position's
  // instrument into the same identifier space a feed holding snapshot's
  // security carries.
  const finSecurityIdByInstrumentId = new Map<string, string>();
  const instrumentsById = new Map(archiveInstruments.map((instrument) => [instrument.id, instrument]));
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

  // Batch holdings-overlap and balance-equality matching: only over archive
  // accounts with no existing fin_accounts link at all and no manual
  // override, and feed candidates unclaimed by any archive account and not
  // reserved as some other archive account's manual target.
  const manualTargets = new Set(
    [...manualOverrides.values()].filter((target): target is string => target !== null),
  );
  const unlinkedArchiveAccounts = archiveAccounts.filter(
    (account) =>
      !finAccounts.some((c) => c.archiveAccountId === account.id) && !manualOverrides.has(account.id),
  );
  const unclaimedCandidates = finAccounts.filter(
    (c) => c.plaidAccountId !== null && c.archiveAccountId === null && !manualTargets.has(c.plaidAccountId),
  );

  const archiveHoldingRows: IdentifiedHoldingRow[] = [];
  for (const position of archivePositions) {
    if (position.instrumentId === null || position.quantity === null) continue;
    const instrument = instrumentsById.get(position.instrumentId);
    if (instrument === undefined) continue;
    const identifier = bestIdentifier(instrument.cusip, instrument.isin, instrument.symbol);
    if (identifier === null) continue;
    archiveHoldingRows.push({
      accountId: position.accountId,
      asOf: position.asOf,
      identifier,
      quantity: position.quantity,
    });
  }
  const unlinkedArchiveIds = new Set(unlinkedArchiveAccounts.map((a) => a.id));
  const archiveHoldingProfiles = buildHoldingsProfiles(
    archiveHoldingRows.filter((row) => unlinkedArchiveIds.has(row.accountId)),
  );
  const candidateHoldingRows = await loadCandidateHoldingRows(
    pool,
    unclaimedCandidates.map((c) => c.id),
  );
  const candidateHoldingProfiles = buildHoldingsProfiles(candidateHoldingRows);

  const holdingsMatches = matchByHoldingsOverlap(archiveHoldingProfiles, candidateHoldingProfiles);
  const matchedArchiveIds = new Set(holdingsMatches.map((m) => m.archiveAccountId));
  const matchedFinIds = new Set(holdingsMatches.map((m) => m.finAccountId));

  const archiveBalanceProfiles = latestPerAccount(
    archiveBalances
      .filter((b) => b.total !== null && unlinkedArchiveIds.has(b.accountId) && !matchedArchiveIds.has(b.accountId))
      .map((b) => ({ accountId: b.accountId, asOf: b.asOf, value: b.total as number })),
  );
  const candidateBalanceRows = await loadCandidateBalanceRows(
    pool,
    unclaimedCandidates.filter((c) => !matchedFinIds.has(c.id)).map((c) => c.id),
  );
  const candidateBalanceProfiles = latestPerAccount(candidateBalanceRows);

  const balanceMatches = matchByBalance(archiveBalanceProfiles, candidateBalanceProfiles);

  const precomputedByArchiveId = new Map<string, PrecomputedMatch>();
  for (const match of [...holdingsMatches, ...balanceMatches]) {
    precomputedByArchiveId.set(match.archiveAccountId, { finAccountId: match.finAccountId, method: match.method });
  }

  // Per-account linking.
  const finAccountIdByArchiveId = new Map<string, string>();
  for (const account of archiveAccounts) {
    const plan = planArchiveAccountLink(account, finAccounts, {
      manualTarget: manualOverrides.get(account.id),
      precomputed: precomputedByArchiveId.get(account.id),
    });
    switch (plan.kind) {
      case "already-linked": {
        result.accountsMatched += 1;
        finAccountIdByArchiveId.set(account.id, plan.finAccountId);
        break;
      }
      case "match": {
        result.accountsMatched += 1;
        result.linksSet += 1;
        result.linksByMethod[plan.method] += 1;
        await pool.query(
          `UPDATE kith.fin_accounts
              SET archive_account_id = $2, match_method = $3, updated_at = transaction_timestamp()
            WHERE id = $1 AND archive_account_id IS NULL`,
          [plan.finAccountId, account.id, plan.method],
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
        result.linksByMethod[plan.method] += 1;
        await mergeArchiveOnlyAccount(
          pool,
          plan.archiveOnlyFinAccountId,
          plan.feedFinAccountId,
          account.id,
          plan.method,
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

  // Self-repair: reattribute existing rows onto the now-correct
  // per-archive-account fin_accounts rows, then sweep whatever archive-only
  // row that leaves with nothing on it and no feed link.
  result.rowsReattributed += await reattributeTransactions(pool, archive, finAccountIdByArchiveId, finAccounts);
  result.rowsReattributed += await reconcileSnapshotAttribution(
    pool,
    archivePositions,
    archiveBalances,
    finAccountIdByArchiveId,
    finSecurityIdByInstrumentId,
  );
  result.emptyAccountsRemoved = await deleteEmptyArchiveOnlyAccounts(
    pool,
    [...new Set(finAccountIdByArchiveId.values())],
  );

  // Overlap boundary: re-derive every linked account's two boundaries (one
  // for transactions, one -- against the earliest Plaid holding-or-balance
  // snapshot date -- for snapshots) from the ledger's current Plaid rows,
  // delete any archive-source row this account already has on or after its
  // boundary, and record `archive_coverage_through` as the more
  // conservative (earlier) of the two, so a reader never overstates archive
  // coverage.
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

  for (const transaction of archiveTransactions) {
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
         SET account_id = EXCLUDED.account_id,
             date = EXCLUDED.date,
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

  for (const position of archivePositions) {
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

  for (const balance of archiveBalances) {
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

/** Every unclaimed Plaid-linked candidate's latest reported holdings,
 * identifier-and-quantity, for the holdings-overlap batch match. */
async function loadCandidateHoldingRows(
  pool: Pool,
  accountIds: readonly string[],
): Promise<IdentifiedHoldingRow[]> {
  if (accountIds.length === 0) return [];
  const { rows } = await pool.query<{
    account_id: string;
    as_of: string;
    quantity: string | null;
    cusip: string | null;
    isin: string | null;
    ticker: string | null;
  }>(
    `SELECT h.account_id, h.as_of::text AS as_of, h.quantity, s.cusip, s.isin, s.ticker
       FROM kith.fin_holding_snapshots h
       JOIN kith.fin_securities s ON s.id = h.security_id
      WHERE h.source = 'plaid' AND h.account_id = ANY($1)`,
    [accountIds],
  );
  const result: IdentifiedHoldingRow[] = [];
  for (const row of rows) {
    if (row.quantity === null) continue;
    const identifier = bestIdentifier(row.cusip, row.isin, row.ticker);
    if (identifier === null) continue;
    result.push({ accountId: row.account_id, asOf: row.as_of, identifier, quantity: Number(row.quantity) });
  }
  return result;
}

/** Every unclaimed Plaid-linked candidate's latest reported balance, for
 * the balance-equality batch match. */
async function loadCandidateBalanceRows(
  pool: Pool,
  accountIds: readonly string[],
): Promise<AccountBalanceProfile[]> {
  if (accountIds.length === 0) return [];
  const { rows } = await pool.query<{ account_id: string; as_of: string; current: string | null }>(
    `SELECT account_id, as_of::text AS as_of, current
       FROM kith.fin_balance_snapshots
      WHERE source = 'plaid' AND account_id = ANY($1)`,
    [accountIds],
  );
  const result: AccountBalanceProfile[] = [];
  for (const row of rows) {
    if (row.current === null) continue;
    result.push({ accountId: row.account_id, asOf: row.as_of, value: Number(row.current) });
  }
  return result;
}

/** One summary line, counts only -- never an account name, balance or
 * transaction amount, matching `pull`'s own printed-output rule. */
export function summarizeImportArchive(result: ImportArchiveResult): string {
  const rowsInserted =
    result.transactionsImported + result.positionsImported + result.balancesImported;
  return [
    "plaid import-archive",
    `accounts_matched=${result.accountsMatched}`,
    `links_set=${result.linksSet}`,
    `links_holdings=${result.linksByMethod.holdings}`,
    `links_balance=${result.linksByMethod.balance}`,
    `links_mask=${result.linksByMethod.mask}`,
    `links_name=${result.linksByMethod.name}`,
    `links_manual=${result.linksByMethod.manual}`,
    `archive_only_accounts=${result.archiveOnlyAccounts}`,
    `rows_inserted=${rowsInserted}`,
    `rows_reattributed=${result.rowsReattributed}`,
    `rows_deleted_as_overlap=${result.rowsDeletedAsOverlap}`,
    `empty_accounts_removed=${result.emptyAccountsRemoved}`,
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
