// The dashboard's data, on PostgreSQL: `memory.computeSpaceStats` for the
// counters (section 8 question 4, adopted and landed in i3) and
// `memory.listBySpaces` for the ten most recent thoughts, both on the one
// authorized space set `getAuthorizedReadSpaceIds` resolves inside this page's
// own read-only transaction.

import { memory } from "@repo/kith-store";
import { getAuthorizedReadSpaceIds } from "@repo/kith-store/identity";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

const RECENT_LIMIT = 10;

export type DashboardData = {
  stats: memory.SpaceStats;
  recent: memory.Thought[];
};

/** `null` means the session does not authenticate anyone; the page redirects. */
export async function loadDashboard(
  cookieHeader: string | null,
): Promise<DashboardData | null> {
  return await loadAuthenticatedPage(cookieHeader, async ({ ctx, principal }) => {
    const spaceIds = await getAuthorizedReadSpaceIds(ctx, principal);
    const stats = await memory.computeSpaceStats(ctx, spaceIds);
    const recent = await memory.listBySpaces(ctx, spaceIds, RECENT_LIMIT, false);
    return { stats, recent };
  });
}
