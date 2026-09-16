// The spaces page's data, on PostgreSQL: the caller's own spaces
// (`identity.listSpaces`) and, when one is selected and shared,
// `identity.getFamilySpace` for its members and invitations.
//
// The person-linking section of the original page -- `models/spaces/people`,
// `peopleApi` in the deleted `lib/family-api.ts` -- is not ported here. Section
// 1.5 of the surface plan says why: every function in `models/spaces/people.ts`
// reads or writes `kith.entities`, which is P2-39h's table, and a half port
// that skipped its checks would be the wrong shape to hand that row. The
// PostgreSQL spaces page therefore shows spaces, members, roles and
// invitations, and marks "link a person" as not yet available rather than
// silently dropping it.

import {
  type FamilySpaceView,
  getFamilySpace,
  type ListedSpace,
  listSpaces,
} from "@repo/kith-store/identity";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

export type FamilyOverview = {
  userId: string;
  spaces: ListedSpace[];
  selected: FamilySpaceView | null;
};

/**
 * `selectedSpaceId` is read from the page's own `?space=` query string, the
 * same way `useSearchParams` read it on the Convex component. A shared space
 * the caller does not belong to, or an unknown id, resolves to no detail
 * rather than an error: the page falls back to the plain space list.
 */
export async function loadFamilyOverview(
  cookieHeader: string | null,
  selectedSpaceId: string | undefined,
): Promise<FamilyOverview | null> {
  return await loadAuthenticatedPage(cookieHeader, async ({ ctx, principal }) => {
    const spaces = await listSpaces(ctx, { principal });
    const target =
      selectedSpaceId === undefined
        ? undefined
        : spaces.find((space) => space.spaceId === selectedSpaceId);
    let selected: FamilySpaceView | null = null;
    if (target && target.kind === "shared") {
      try {
        selected = await getFamilySpace(ctx, {
          userId: principal.userId,
          spaceId: target.spaceId,
        });
      } catch {
        selected = null;
      }
    }
    return { userId: principal.userId, spaces, selected };
  });
}
