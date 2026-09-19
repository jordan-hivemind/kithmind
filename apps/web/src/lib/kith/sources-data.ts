// The sources screen's first paint, from one read-only transaction.
//
// Same shape as `settings-data.ts`: the page reads the cookie once and passes
// it in, `loadAuthenticatedPage` reloads the principal inside the transaction,
// and `null` means "not signed in" and only that.

import { admin } from "@repo/kith-store";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

export type SourcesPageData = {
  sources: admin.SourceInventoryRow[];
  /** The watched folders under those sources (ADM-4b), each with the latest
   * thing the watcher host said about it. */
  roots: admin.SourceRoot[];
};

export async function loadSources(
  cookieHeader: string | null,
): Promise<SourcesPageData | null> {
  return await loadAuthenticatedPage(cookieHeader, async ({ ctx, principal }) => ({
    sources: await admin.listSourcesInventory(ctx, { principal }),
    roots: await admin.listSourceRoots(ctx, { principal }),
  }));
}

/**
 * Whether this session may see the admin panel at all: it administers at
 * least one space (owner or editor). A `reader` member gets `false` and the
 * layout answers 404, so the panel's existence is not confirmed to someone
 * who may not use it.
 *
 * `null` is "not signed in", the same as every other loader here.
 */
export async function loadAdminAccess(
  cookieHeader: string | null,
): Promise<boolean | null> {
  return await loadAuthenticatedPage(
    cookieHeader,
    async ({ ctx, principal }) =>
      (await admin.getAdminSpaceIds(ctx, principal)).length > 0,
  );
}
