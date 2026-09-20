// ADM-2: the first paint of screens 1, 3 and 4, each from one read-only
// transaction, plus the archive read the institutions screen needs.
//
// Same shape as `sources-data.ts`: the page reads the cookie once and passes
// it in, `loadAuthenticatedPage` reloads the principal inside the transaction
// and every store call narrows to `getAdminSpaceIds` for itself, and `null`
// means "not signed in" and only that.
//
// The finance archive is the one thing here that is not a Kith Mind read. It
// is a different database behind its own read contract and its own reader
// role, so it is reached the same way `lib/mcp/finance.ts` reaches it for the
// MCP gateway -- `resolveFinanceArchive` plus `readFinanceArchive`, which
// re-authorizes the request against the archive's own pinned space -- and
// never by widening the kith pool's credentials. `readAccountInventory` below
// is the only new call, and it is a read of counts and one figure per account,
// its current value: no instrument, no description, and no full account number
// exists in the archive to return.

import {
  type FinanceAccountInventoryRecord,
  FinanceContractError,
} from "@repo/finance-contract";
import { admin } from "@repo/kith-store";
import type { IdentityCtx, Principal } from "@repo/kith-store/identity";

import { groupInstitutions, type InstitutionRow } from "@/lib/kith/institutions";
import { loadAuthenticatedPage } from "@/lib/kith/page-session";
import {
  type FinanceArchiveAccess,
  readFinanceArchive,
  resolveFinanceArchive,
} from "@/lib/mcp/finance";

/** Accounts per archive page, and how many pages are followed at most. */
const ARCHIVE_PAGE = 100;
const MAX_ARCHIVE_PAGES = 5;

/**
 * The archive's inventory, or why there is none.
 *
 * Three outcomes, and they are three because collapsing any two of them would
 * be a lie: an archive nobody configured is not an empty archive, and an
 * archive that would not answer is not an archive with no accounts.
 */
export type ArchiveInventory =
  | { state: "not_configured" }
  | { state: "unavailable"; reason: string }
  | {
      state: "read";
      records: FinanceAccountInventoryRecord[];
      /**
       * The archive had more accounts than `MAX_ARCHIVE_PAGES` pages carry and
       * the rest were not read.
       *
       * Carried rather than swallowed: a screen showing 500 of 700 accounts
       * with no sign of the other 200 is the exact failure the inventory
       * exists to prevent, and a coverage total quietly short by 200 accounts
       * is worse than one labelled partial.
       */
      truncated: boolean;
    };

async function readAccountInventory(
  archive: FinanceArchiveAccess,
  principal: Principal,
  authorizedSpaceIds: readonly string[],
): Promise<ArchiveInventory> {
  const trusted = {
    // The same `<who>:<credential>` shape `app/api/mcp/route.ts` builds, with
    // the web session in place of an API key: the archive uses it to bind a
    // cursor to the caller that was issued it, never to authorize.
    principalId: `web:${principal.userId}`,
    authorizedSpaceIds,
  };
  const records: FinanceAccountInventoryRecord[] = [];
  let cursor: string | undefined;
  let truncated = false;
  try {
    for (let page = 0; page < MAX_ARCHIVE_PAGES; page += 1) {
      const response = await readFinanceArchive(
        archive,
        {
          contractVersion: 1,
          operation: "list_account_inventory",
          spaceId: archive.spaceId,
          limit: ARCHIVE_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        trusted,
      );
      if (response.operation !== "list_account_inventory") break;
      records.push(...response.items);
      if (response.nextCursor === undefined) break;
      cursor = response.nextCursor;
      // The page bound was reached with a cursor still in hand: there is more
      // and this read stops here.
      truncated = page === MAX_ARCHIVE_PAGES - 1;
    }
  } catch (error: unknown) {
    // An archive that cannot be reached says so, for the reason the MCP
    // gateway gives: dropping the block silently would let a configured but
    // unavailable archive read as an inventory with nothing in it.
    return {
      state: "unavailable",
      reason:
        error instanceof FinanceContractError ? error.code : "unavailable",
    };
  }
  return { state: "read", records, truncated };
}

/**
 * The archive inventory for a principal, or `not_configured`.
 *
 * Resolved outside the kith transaction on purpose: the archive is a separate
 * pool, and holding a kith connection open across a second database's read
 * would tie up two of this instance's connections for one page.
 */
async function archiveInventory(
  principal: Principal,
  authorizedSpaceIds: readonly string[],
): Promise<ArchiveInventory> {
  const archive = resolveFinanceArchive();
  if (archive === null) return { state: "not_configured" };
  if (!authorizedSpaceIds.includes(archive.spaceId)) {
    // The caller administers spaces, but not the one the archive holds. Not a
    // failure and not an empty archive: there is nothing here for them.
    return { state: "not_configured" };
  }
  return await readAccountInventory(archive, principal, authorizedSpaceIds);
}

async function administeredSpaces(
  ctx: IdentityCtx,
  principal: Principal,
): Promise<string[]> {
  return await admin.getAdminSpaceIds(ctx, principal);
}

// ---------------------------------------------------------------------------
// Screen 1: Health
// ---------------------------------------------------------------------------

export type HealthPageData = { checks: admin.HealthCheck[] };

export async function loadHealth(
  cookieHeader: string | null,
  now: number = Date.now(),
): Promise<HealthPageData | null> {
  const loaded = await loadAuthenticatedPage(
    cookieHeader,
    async ({ ctx, principal }) => ({
      facts: await admin.readHealthFacts(ctx, { principal }),
      principal,
      spaces: await administeredSpaces(ctx, principal),
    }),
  );
  if (loaded === null) return null;
  const inventory = await archiveInventory(loaded.principal, loaded.spaces);
  return {
    checks: [
      ...admin.deriveHealthChecks(loaded.facts, now),
      financeCheck(inventory, now),
      admin.BACKUP_CHECK,
    ],
  };
}

/** The archive's freshness check, from the newest snapshot any account has. */
function financeCheck(
  inventory: ArchiveInventory,
  now: number,
): admin.HealthCheck {
  if (inventory.state === "not_configured") {
    return admin.financeFreshnessCheck(null, now, false);
  }
  if (inventory.state === "unavailable") {
    return {
      id: "finance_archive",
      name: "Finance archive",
      status: "problem",
      detail: inventory.reason,
      tooltip: null,
      lastCheckedAt: null,
    };
  }
  const latest = inventory.records
    .map((record) => record.latestSnapshotAsOf)
    .filter((asOf): asOf is string => asOf !== undefined)
    .sort();
  return admin.financeFreshnessCheck(latest[latest.length - 1] ?? null, now);
}

// ---------------------------------------------------------------------------
// Screen 3: Institutions
// ---------------------------------------------------------------------------

export type InstitutionsPageData = {
  institutions: InstitutionRow[];
  /** What the screen says when there is nothing to group. */
  state: ArchiveInventory["state"];
  reason: string | null;
  /** More accounts exist than this read followed; the table says so. */
  truncated: boolean;
};

export async function loadInstitutions(
  cookieHeader: string | null,
  now: number = Date.now(),
): Promise<InstitutionsPageData | null> {
  const loaded = await loadAuthenticatedPage(
    cookieHeader,
    async ({ ctx, principal }) => {
      const spaces = await administeredSpaces(ctx, principal);
      // The owner's edits to account names and the like live beside the
      // archive, in the archive's own space.
      const archiveSpace = resolveFinanceArchive()?.spaceId;
      const overrides =
        archiveSpace !== undefined && spaces.includes(archiveSpace)
          ? await admin.listAccountOverrides(ctx, { spaceId: archiveSpace })
          : [];
      return { principal, spaces, overrides };
    },
  );
  if (loaded === null) return null;
  const inventory = await archiveInventory(loaded.principal, loaded.spaces);
  return {
    institutions:
      inventory.state === "read"
        ? groupInstitutions(
            inventory.records,
            now,
            new Map(loaded.overrides.map((item) => [item.accountId, item])),
          )
        : [],
    state: inventory.state,
    reason: inventory.state === "unavailable" ? inventory.reason : null,
    truncated: inventory.state === "read" && inventory.truncated,
  };
}

// ---------------------------------------------------------------------------
// Screen 4: Coverage
// ---------------------------------------------------------------------------

export type CoveragePageData = {
  areas: admin.AreaCoverageRow[];
  /** The archive contribution is short: more accounts exist than were read. */
  truncated: boolean;
};

export async function loadCoverage(
  cookieHeader: string | null,
): Promise<CoveragePageData | null> {
  const loaded = await loadAuthenticatedPage(
    cookieHeader,
    async ({ ctx, principal }) => ({
      areas: await admin.listAreaCoverage(ctx, { principal }),
      principal,
      spaces: await administeredSpaces(ctx, principal),
    }),
  );
  if (loaded === null) return null;
  const inventory = await archiveInventory(loaded.principal, loaded.spaces);
  return {
    areas: admin.mergeFinanceIntoAreas(
      loaded.areas,
      inventory.state === "read" ? financeContribution(inventory.records) : null,
    ),
    truncated: inventory.state === "read" && inventory.truncated,
  };
}

/** The archive's accounts, statements and records as one area's contribution. */
function financeContribution(
  records: readonly FinanceAccountInventoryRecord[],
): admin.AreaContribution {
  const contribution: admin.AreaContribution = {
    sources: records.length,
    documents: 0,
    records: 0,
    from: null,
    to: null,
  };
  for (const record of records) {
    contribution.documents += record.statementCount;
    contribution.records += record.recordCount;
    if (
      record.activityFrom !== undefined &&
      (contribution.from === null || record.activityFrom < contribution.from)
    ) {
      contribution.from = record.activityFrom;
    }
    if (
      record.activityTo !== undefined &&
      (contribution.to === null || record.activityTo > contribution.to)
    ) {
      contribution.to = record.activityTo;
    }
  }
  return contribution;
}
