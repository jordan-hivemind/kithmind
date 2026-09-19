// The sources screen's first paint, from one read-only transaction.
//
// Same shape as `settings-data.ts`: the page reads the cookie once and passes
// it in, `loadAuthenticatedPage` reloads the principal inside the transaction,
// and `null` means "not signed in" and only that.

import { admin } from "@repo/kith-store";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

export type SourcesPageData = { sources: admin.SourceInventoryRow[] };

export async function loadSources(
  cookieHeader: string | null,
): Promise<SourcesPageData | null> {
  return await loadAuthenticatedPage(cookieHeader, async ({ ctx, principal }) => ({
    sources: await admin.listSourcesInventory(ctx, { principal }),
  }));
}
