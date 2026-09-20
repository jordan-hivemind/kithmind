// The attention screen's first paint, from one read-only transaction.
//
// Same shape as `investments-data.ts`: the page reads the cookie once and
// passes it in, `loadAuthenticatedPage` reloads the principal inside the
// transaction, and `null` means "not signed in" and only that. The default
// view includes open `info` rows. The table keeps that severity distinction
// visible, while allowing the owner to hide info when needed.

import { admin } from "@repo/kith-store";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

export type AttentionPageData = {
  items: admin.AttentionItem[];
  nextCursor: string | null;
  counts: { attention: number; alert: number };
  /** Where a bulk action or a mute is written. The screen has no space
   * picker: the owner has one household. */
  spaceIds: string[];
};

export async function loadAttention(
  cookieHeader: string | null,
): Promise<AttentionPageData | null> {
  return await loadAuthenticatedPage(
    cookieHeader,
    async ({ ctx, principal }) => {
      const spaceIds = await admin.getAdminSpaceIds(ctx, principal);
      if (spaceIds.length === 0) {
        return {
          items: [],
          nextCursor: null,
          counts: { attention: 0, alert: 0 },
          spaceIds,
        };
      }
      const [{ items, nextCursor }, counts] = await Promise.all([
        admin.listAttention(ctx, {
          principal,
          severity: ["info", "attention", "alert"],
        }),
        admin.attentionSeverityCounts(ctx, { principal }),
      ]);
      return { items, nextCursor, counts, spaceIds };
    },
  );
}

/** The nav badge's first paint (`components/admin/attention-badge.tsx`),
 * read from the admin layout for every admin page, not only the attention
 * screen. `null` (not signed in, or administers no space) reads as zero. */
export async function loadAttentionCounts(
  cookieHeader: string | null,
): Promise<{ attention: number; alert: number }> {
  const counts = await loadAuthenticatedPage(
    cookieHeader,
    ({ ctx, principal }) => admin.attentionSeverityCounts(ctx, { principal }),
  );
  return counts ?? { attention: 0, alert: 0 };
}
