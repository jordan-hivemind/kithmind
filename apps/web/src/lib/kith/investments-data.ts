// The investments screen's first paint, from one read-only transaction.
//
// Same shape as `sources-data.ts`: the page reads the cookie once and passes
// it in, `loadAuthenticatedPage` reloads the principal inside the transaction,
// and `null` means "not signed in" and only that.
//
// Investments and entries come from the same transaction so the totals and the
// rows they expand into are one snapshot.

import { admin } from "@repo/kith-store";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

export type InvestmentsPageData = {
  investments: admin.InvestmentRow[];
  entries: admin.InvestmentEntry[];
  /** Where a new investment is created. The screen has no space picker: the
   * owner has one household. */
  spaceIds: string[];
};

export async function loadInvestments(
  cookieHeader: string | null,
): Promise<InvestmentsPageData | null> {
  return await loadAuthenticatedPage(cookieHeader, async ({ ctx, principal }) => {
    const spaceIds = await admin.getAdminSpaceIds(ctx, principal);
    if (spaceIds.length === 0) {
      return { investments: [], entries: [], spaceIds };
    }
    return {
      investments: await admin.listInvestments(ctx, spaceIds),
      entries: await admin.listInvestmentEntries(ctx, spaceIds),
      spaceIds,
    };
  });
}
