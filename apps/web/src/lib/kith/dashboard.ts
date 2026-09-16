// The dashboard's data, on PostgreSQL: `memory.computeSpaceStats` for the
// counters (section 8 question 4, adopted and landed in i3) and
// `memory.listBySpaces` for the ten most recent thoughts, both on the one
// authorized space set `getAuthorizedReadSpaceIds` resolves inside the
// caller's own read-only transaction.
//
// `computeDashboardData` is the computation alone, taking an already-opened
// session rather than opening one itself, so it has exactly one caller's
// transaction to run in rather than its own. Two callers share it:
// `loadDashboard` (the page's own `withKithReadTransaction`, via
// `loadAuthenticatedPage`) and i6's `GET /api/status/dashboard` (`withPrincipalRead`,
// which adds the surface, origin and content-type gate `guardedRequest`
// enforces). Neither wraps the other -- this pool holds at most two
// connections per instance (`lib/kith/pool.ts`), so nesting one read-only
// transaction inside another here would either exhaust it or, in the
// `max: 1` case, deadlock the request against itself.

import { memory } from "@repo/kith-store";
import { getAuthorizedReadSpaceIds } from "@repo/kith-store/identity";

import { loadAuthenticatedPage, type PageSession } from "@/lib/kith/page-session";

const RECENT_LIMIT = 10;

export type DashboardData = {
  stats: memory.SpaceStats;
  recent: memory.Thought[];
};

export async function computeDashboardData({
  ctx,
  principal,
}: PageSession): Promise<DashboardData> {
  const spaceIds = await getAuthorizedReadSpaceIds(ctx, principal);
  const stats = await memory.computeSpaceStats(ctx, spaceIds);
  const recent = await memory.listBySpaces(ctx, spaceIds, RECENT_LIMIT, false);
  return { stats, recent };
}

/** `null` means the session does not authenticate anyone; the page redirects. */
export async function loadDashboard(
  cookieHeader: string | null,
): Promise<DashboardData | null> {
  return await loadAuthenticatedPage(cookieHeader, computeDashboardData);
}
