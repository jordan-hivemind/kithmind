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

/** A bound on the rows an unexpected area explosion could add. */
const MAX_AREAS = 50;

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
 * caller that has one.
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
           LEFT JOIN kith.source_roots r
             ON r.source_account_id = a.id AND r.space_id = a.space_id
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
       LEFT JOIN kith.source_roots r
         ON r.source_account_id = a.id AND r.space_id = a.space_id
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
    row.gapReasons[reason] = (row.gapReasons[reason] ?? 0) + Number(record.count);
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
  if (contribution === null) return [...areas];
  return tagged(
    areas.map((row) =>
      row.area !== FINANCE_AREA
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
