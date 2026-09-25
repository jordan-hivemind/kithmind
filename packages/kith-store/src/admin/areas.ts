// ADM-2, screen 4 (Coverage): life areas against what the system actually
// holds for them.
//
// The point of the screen is the empty rows. "The UI must show a complete
// inventory so gaps are visible" (the owner's operation decision), so an area
// nothing has been ingested for is a row reading Empty rather than an absence,
// and the starter list below is fixed rather than derived from the data --
// derived, an area with nothing in it could not appear at all.
//
// The list is a constant and not a table. `source_roots.area` and
// `document_types.area` are both free-text columns on rows about something
// else; neither is a place to store a list of areas, and a table for eight
// strings nothing else references is a migration for a `const`. An area a root
// names that is not on the list is still shown -- appended below -- so the
// constant bounds what is always visible, not what may exist.

import type { Principal } from "../identity/authorization.js";
import { type IdentityCtx, rows } from "../identity/db.js";
import { spacePredicate } from "../spaces.js";
import { BANKING_ACCOUNT_TYPES } from "./finBanking.js";
import { getAdminSpaceIds } from "./model.js";
import { coverageStatus, type CoverageStatus } from "./status.js";

/**
 * The starter areas, in the order the screen lists them: roughly the owner's
 * ingestion priority (outside investments first, then statements, then the
 * rest), with memory last because it is not a document area at all.
 */
export const LIFE_AREAS = [
  "brokerage",
  "outside investments",
  "banking and cards",
  "taxes",
  "medical",
  "vehicles",
  "home and projects",
  "notes and facts",
] as const;

/** Where the "outside investments" row's records come from. */
const INVESTMENTS_AREA = "outside investments";
/** Where thoughts and facts are counted. */
const MEMORY_AREA = "notes and facts";
/** The area the finance archive's own inventory is added to by the caller. */
export const FINANCE_AREA = "brokerage";
/** The area the Epic health feed's own inventory is added to by the caller. */
export const MEDICAL_AREA = "medical";
/** The area the unified ledger's banking and card accounts are added to. */
export const BANKING_AREA = "banking and cards";

/** A bound on the rows an unexpected area explosion could add. */
const MAX_AREAS = 50;

/**
 * The account's first root, as a lateral subquery.
 *
 * Since migration 028 an account may have several roots, and this screen
 * counts accounts: joined plainly, an account with two folders would be
 * counted twice and its documents and records counted twice with it. The
 * account's area is therefore its first root's, which is what it was when an
 * account could only have one root. (A second root naming a different area is
 * a shape this screen will have to grow a rule for; it has no rows yet, and
 * inventing one now would be inventing it blind.)
 */
const FIRST_ROOT = `SELECT y.area FROM kith.source_roots y
   WHERE y.source_account_id = a.id AND y.space_id = a.space_id
   ORDER BY y.created_at, y.id LIMIT 1`;

export type AreaCoverageRow = {
  area: string;
  /** Source accounts whose root names this area. */
  sources: number;
  /** Documents held under those sources. */
  documents: number;
  /** Structured records: observations, plus this area's own contributions. */
  records: number;
  /** Earliest and latest dates anything in the area is dated, ISO, inclusive. */
  from: string | null;
  to: string | null;
  /** Open coverage gaps, and what they were opened for. */
  gaps: number;
  gapReasons: Record<string, number>;
  /**
   * `coverageStatus` of this row, carried on it rather than derived by the
   * screen: the screen is a client component and importing the store into the
   * browser bundle to re-derive one word would drag `pg` in with it.
   */
  status: CoverageStatus;
};

/** `area` as it is compared: lowercased, trimmed, inner whitespace collapsed. */
export function normalizeArea(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function emptyRow(area: string): AreaCoverageRow {
  return {
    area,
    sources: 0,
    documents: 0,
    records: 0,
    from: null,
    to: null,
    gaps: 0,
    gapReasons: {},
    status: "empty",
  };
}

/** Every row's tag recomputed from its own final counts. */
function tagged(rows: readonly AreaCoverageRow[]): AreaCoverageRow[] {
  return rows.map((row) => ({ ...row, status: coverageStatus(row) }));
}

/** The earlier of two ISO dates, treating null as "no opinion". */
function earlier(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

type AreaDbRow = {
  area: string;
  sources: string;
  documents: string;
  records: string;
  from_date: string | null;
  to_date: string | null;
  gaps: string;
};

type ScalarDbRow = {
  thoughts: string;
  facts: string;
  investments: string;
  investment_entries: string;
  investments_from: string | null;
  investments_to: string | null;
};

/**
 * One row per life area, from the brain's own tables.
 *
 * Everything below is scoped by `getAdminSpaceIds`, so a reader gets the
 * starter list with every count at zero rather than someone else's inventory,
 * and every join carries `space_id` as well as the id for the reason
 * `listSourcesInventory` states: the composite keys make a cross-space
 * reference unrepresentable, and these predicates mean the read does not
 * depend on that being true.
 *
 * The finance archive is not read here (another database, another contract);
 * `mergeFinanceIntoAreas` folds its inventory into the `brokerage` row for a
 * caller that has one. The Epic health feed's tables are read here (this
 * package, this database), but not scoped by space at all -- unlike every
 * query above -- so `healthContribution` and `mergeHealthIntoAreas` fold
 * them into the `medical` row the same, separate way.
 */
export async function listAreaCoverage(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceIds?: readonly string[] },
): Promise<AreaCoverageRow[]> {
  const spaces = await getAdminSpaceIds(ctx, args.principal, args.spaceIds);
  const byArea = new Map<string, AreaCoverageRow>(
    LIFE_AREAS.map((area) => [area, emptyRow(area)]),
  );
  if (spaces.length === 0) return tagged([...byArea.values()]);

  const inSpaces = (alias: string) => spacePredicate(spaces, 1, alias).sql;
  const spaceIds = spacePredicate(spaces, 1).value;

  // Per account first, then grouped: an aggregate correlated to a group rather
  // than to a row would have to name the group's accounts, and this way each
  // subquery is one index lookup on `(source_account_id, space_id)`.
  const areaRows = await rows<AreaDbRow>(
    ctx,
    `SELECT s.area,
            count(*)::text AS sources,
            coalesce(sum(s.documents), 0)::text AS documents,
            coalesce(sum(s.records), 0)::text AS records,
            min(s.from_date)::date::text AS from_date,
            max(s.to_date)::date::text AS to_date,
            coalesce(sum(s.gaps), 0)::text AS gaps
       FROM (
         SELECT lower(btrim(coalesce(r.area, ''))) AS area,
                (SELECT count(*) FROM kith.source_items i
                  WHERE i.source_account_id = a.id AND i.space_id = a.space_id
                    AND i.forgotten_at IS NULL) AS documents,
                (SELECT count(*) FROM kith.observations o
                  WHERE o.source_account_id = a.id
                    AND o.space_id = a.space_id) AS records,
                (SELECT min(w."from") FROM kith.coverage_windows w
                  WHERE w.source_account_id = a.id
                    AND w.space_id = a.space_id) AS from_date,
                (SELECT max(w."to") FROM kith.coverage_windows w
                  WHERE w.source_account_id = a.id
                    AND w.space_id = a.space_id) AS to_date,
                (SELECT count(*) FROM kith.coverage_gaps g
                  WHERE g.source_account_id = a.id
                    AND g.space_id = a.space_id
                    AND g.status = 'open') AS gaps
           FROM kith.source_accounts a
           LEFT JOIN LATERAL (${FIRST_ROOT}) r ON true
          WHERE ${inSpaces("a.space_id")}
       ) s
      WHERE s.area <> ''
      GROUP BY s.area
      ORDER BY s.area
      LIMIT $2`,
    [spaceIds, MAX_AREAS],
  );

  const reasonRows = await rows<{
    area: string;
    reason: string | null;
    count: string;
  }>(
    ctx,
    `SELECT lower(btrim(coalesce(r.area, ''))) AS area,
            g.reason, count(*)::text AS count
       FROM kith.coverage_gaps g
       JOIN kith.source_accounts a
         ON a.id = g.source_account_id AND a.space_id = g.space_id
       LEFT JOIN LATERAL (${FIRST_ROOT}) r ON true
      WHERE ${inSpaces("g.space_id")} AND g.status = 'open'
      GROUP BY 1, 2
      ORDER BY 1, 2
      LIMIT 200`,
    [spaceIds],
  );

  // The two areas whose contents are not keyed by a source account at all.
  const scalars = await rows<ScalarDbRow>(
    ctx,
    `SELECT
       (SELECT count(*) FROM kith.thoughts t
         WHERE ${inSpaces("t.space_id")}
           AND (t.memory_status IS NULL OR t.memory_status = 'current'))
         ::text AS thoughts,
       (SELECT count(*) FROM kith.facts f
         WHERE ${inSpaces("f.space_id")} AND f.status = 'current')
         ::text AS facts,
       (SELECT count(*) FROM kith.investments v
         WHERE ${inSpaces("v.space_id")})::text AS investments,
       (SELECT count(*) FROM kith.investment_entries e
         WHERE ${inSpaces("e.space_id")})::text AS investment_entries,
       (SELECT min(e.entry_date) FROM kith.investment_entries e
         WHERE ${inSpaces("e.space_id")})::text AS investments_from,
       (SELECT max(e.entry_date) FROM kith.investment_entries e
         WHERE ${inSpaces("e.space_id")})::text AS investments_to`,
    [spaceIds],
  );

  for (const record of areaRows) {
    const area = normalizeArea(record.area);
    const row = byArea.get(area) ?? emptyRow(area);
    row.sources += Number(record.sources);
    row.documents += Number(record.documents);
    row.records += Number(record.records);
    row.from = earlier(row.from, record.from_date);
    row.to = later(row.to, record.to_date);
    row.gaps += Number(record.gaps);
    byArea.set(area, row);
  }
  for (const record of reasonRows) {
    const row = byArea.get(normalizeArea(record.area));
    if (row === undefined) continue;
    const reason = record.reason ?? "unspecified";
    row.gapReasons[reason] =
      (row.gapReasons[reason] ?? 0) + Number(record.count);
  }

  const scalar = scalars[0];
  if (scalar !== undefined) {
    const memory = byArea.get(MEMORY_AREA)!;
    memory.records += Number(scalar.thoughts) + Number(scalar.facts);
    const investments = byArea.get(INVESTMENTS_AREA)!;
    investments.sources += Number(scalar.investments);
    investments.records += Number(scalar.investment_entries);
    investments.from = earlier(investments.from, scalar.investments_from);
    investments.to = later(investments.to, scalar.investments_to);
  }

  return tagged([...byArea.values()]);
}

/** One area's contribution from somewhere this package cannot read. */
export type AreaContribution = {
  sources: number;
  documents: number;
  records: number;
  from: string | null;
  to: string | null;
};

/**
 * Folds a contribution into the one row named `area`, add the counts, widen
 * the range, leave the gaps alone because the contributor reports its own
 * coverage (or none) through its own contract.
 *
 * Shared by `mergeFinanceIntoAreas` and `mergeHealthIntoAreas` so the one
 * merge rule lives in one place rather than twice.
 */
function mergeContributionIntoArea(
  areas: readonly AreaCoverageRow[],
  area: string,
  contribution: AreaContribution | null,
): AreaCoverageRow[] {
  if (contribution === null) return [...areas];
  return tagged(
    areas.map((row) =>
      row.area !== area
        ? row
        : {
            ...row,
            sources: row.sources + contribution.sources,
            documents: row.documents + contribution.documents,
            records: row.records + contribution.records,
            from: earlier(row.from, contribution.from),
            to: later(row.to, contribution.to),
          },
    ),
  );
}

/**
 * Folds the finance archive's inventory into the `brokerage` row.
 *
 * Kept here rather than in the caller so the merge rule -- add the counts,
 * widen the range, leave the gaps alone because the archive reports its own
 * coverage through its own contract -- is next to the rule that built the row.
 */
export function mergeFinanceIntoAreas(
  areas: readonly AreaCoverageRow[],
  contribution: AreaContribution | null,
): AreaCoverageRow[] {
  return mergeContributionIntoArea(areas, FINANCE_AREA, contribution);
}

/**
 * Folds the Epic health feed's inventory into the `medical` row, the same
 * way `mergeFinanceIntoAreas` folds the finance archive's into `brokerage`.
 */
export function mergeHealthIntoAreas(
  areas: readonly AreaCoverageRow[],
  contribution: AreaContribution | null,
): AreaCoverageRow[] {
  return mergeContributionIntoArea(areas, MEDICAL_AREA, contribution);
}

type HealthContributionRow = {
  sources: string;
  documents: string;
  records: string;
  from_date: string | null;
  to_date: string | null;
};

/**
 * The Epic feed's own inventory (`kith.health_sources`/`health_records`/
 * `health_documents`, migration 053), for `mergeHealthIntoAreas` to fold into
 * the `medical` row.
 *
 * Read owner-global -- no space predicate -- the same way `listHealthOverview`
 * reads these tables (see the comment above `loadMedical` in
 * `admin-data.ts`): none of these three tables carry a single space this
 * screen could narrow to, and the caller's own admin-layout sign-in check is
 * the only gate, exactly as it is for `listHealthOverview`.
 */
export async function healthContribution(
  ctx: IdentityCtx,
): Promise<AreaContribution> {
  const found = await rows<HealthContributionRow>(
    ctx,
    `SELECT
       (SELECT count(*) FROM kith.health_sources)::text AS sources,
       (SELECT count(*) FROM kith.health_documents)::text AS documents,
       (SELECT count(*) FROM kith.health_records)::text AS records,
       (SELECT min(effective_at) FROM kith.health_records)::date::text
         AS from_date,
       (SELECT max(effective_at) FROM kith.health_records)::date::text
         AS to_date`,
    [],
  );
  const row = found[0];
  return {
    sources: Number(row?.sources ?? "0"),
    documents: Number(row?.documents ?? "0"),
    records: Number(row?.records ?? "0"),
    from: row?.from_date ?? null,
    to: row?.to_date ?? null,
  };
}

/**
 * Folds `kith.fin_accounts`' depository, credit and loan accounts into the
 * `banking and cards` row, the same way `mergeHealthIntoAreas` folds the
 * Epic feed's into `medical`.
 */
export function mergeBankingIntoAreas(
  areas: readonly AreaCoverageRow[],
  contribution: AreaContribution | null,
): AreaCoverageRow[] {
  return mergeContributionIntoArea(areas, BANKING_AREA, contribution);
}

type BankingContributionRow = {
  sources: string;
  records: string;
  from_date: string | null;
  to_date: string | null;
};

/**
 * The unified ledger's banking and card accounts (`BANKING_ACCOUNT_TYPES`),
 * for `mergeBankingIntoAreas` to fold into the `banking and cards` row.
 *
 * Owner-global -- no space predicate -- for the same reason
 * `healthContribution` is: `kith.fin_accounts` and `kith.fin_transactions`
 * carry no space to narrow to (migration 048_finance_unify.sql), so the
 * caller's own admin-layout sign-in check is the only gate.
 *
 * `documents` is always 0: the unified ledger has no per-account statement
 * count of its own (Plaid's feed and the archive's own statements are two
 * different things, and `financeContribution` already carries the archive's
 * statement count into `brokerage`), so there is nothing genuine to put here.
 */
export async function bankingContribution(
  ctx: IdentityCtx,
): Promise<AreaContribution> {
  const found = await rows<BankingContributionRow>(
    ctx,
    `SELECT
       (SELECT count(*) FROM kith.fin_accounts fa
         WHERE lower(fa.type) = ANY($1::text[]))::text AS sources,
       (SELECT count(*) FROM kith.fin_transactions t
          JOIN kith.fin_accounts fa ON fa.id = t.account_id
         WHERE lower(fa.type) = ANY($1::text[]))::text AS records,
       (SELECT min(t.date) FROM kith.fin_transactions t
          JOIN kith.fin_accounts fa ON fa.id = t.account_id
         WHERE lower(fa.type) = ANY($1::text[]))::text AS from_date,
       (SELECT max(t.date) FROM kith.fin_transactions t
          JOIN kith.fin_accounts fa ON fa.id = t.account_id
         WHERE lower(fa.type) = ANY($1::text[]))::text AS to_date`,
    [BANKING_ACCOUNT_TYPES],
  );
  const row = found[0];
  return {
    sources: Number(row?.sources ?? "0"),
    documents: 0,
    records: Number(row?.records ?? "0"),
    from: row?.from_date ?? null,
    to: row?.to_date ?? null,
  };
}

/** The area the Taxes screen's own inventory is added to by the caller. */
export const TAX_AREA = "taxes";

/**
 * Folds the Taxes screen's own inventory into the `taxes` row, the same way
 * `mergeHealthIntoAreas` folds the Epic feed's into `medical`.
 */
export function mergeTaxIntoAreas(
  areas: readonly AreaCoverageRow[],
  contribution: AreaContribution | null,
): AreaCoverageRow[] {
  return mergeContributionIntoArea(areas, TAX_AREA, contribution);
}

type TaxContributionDbRow = {
  documents: string;
  records: string;
  from_date: string | null;
  to_date: string | null;
};

/**
 * The Taxes screen's own inventory (`kith.documents` restricted to
 * `tax_return`/`k1`/`tax_support`, and `kith.tax_payments`; see
 * `taxes.ts`'s `listTaxOverview`), for `mergeTaxIntoAreas` to fold into the
 * `taxes` row.
 *
 * Unlike `healthContribution`, both tables carry `space_id`, so this reads
 * space-scoped from the caller's already-resolved space ids rather than
 * owner-global. `documents` counts only `publication_state = 'active'`: a
 * `historical` row is a superseded revision of a document already counted,
 * the same reason `listAreaCoverage`'s own document counts come from
 * `source_items` rather than every revision ever parsed.
 */
export async function taxContribution(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
): Promise<AreaContribution> {
  if (spaceIds.length === 0) {
    return { sources: 0, documents: 0, records: 0, from: null, to: null };
  }
  const inSpaces = (alias: string) => spacePredicate(spaceIds, 1, alias).sql;
  const spaceIdsValue = spacePredicate(spaceIds, 1).value;
  const found = await rows<TaxContributionDbRow>(
    ctx,
    `SELECT
       (SELECT count(*) FROM kith.documents d
         WHERE ${inSpaces("d.space_id")}
           AND d.doc_type IN ('tax_return', 'k1', 'tax_support')
           AND d.publication_state = 'active')::text AS documents,
       (SELECT count(*) FROM kith.tax_payments p
         WHERE ${inSpaces("p.space_id")})::text AS records,
       (SELECT min(d.captured_at) FROM kith.documents d
         WHERE ${inSpaces("d.space_id")}
           AND d.doc_type IN ('tax_return', 'k1', 'tax_support')
           AND d.publication_state = 'active')::date::text AS from_date,
       (SELECT max(d.captured_at) FROM kith.documents d
         WHERE ${inSpaces("d.space_id")}
           AND d.doc_type IN ('tax_return', 'k1', 'tax_support')
           AND d.publication_state = 'active')::date::text AS to_date`,
    [spaceIdsValue],
  );
  const row = found[0];
  return {
    sources: 0,
    documents: Number(row?.documents ?? "0"),
    records: Number(row?.records ?? "0"),
    from: row?.from_date ?? null,
    to: row?.to_date ?? null,
  };
}
