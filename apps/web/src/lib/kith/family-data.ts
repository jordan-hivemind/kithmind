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
  IdentityError,
  type ListedSpace,
  listSpaces,
} from "@repo/kith-store/identity";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

/**
 * Set when `getFamilySpace` refused to answer for a reason that is not "the
 * caller does not belong there" -- today only the bounded member and
 * invitation scans in `identity/family.ts` -- and is distinct from both "no
 * space selected" and "not a member": the page has to say why the space is
 * unavailable rather than rendering it as if it did not exist.
 */
export type FamilyDetailUnavailable = "member_limit_reached" | "invitation_limit_reached";

const DETAIL_UNAVAILABLE_CODES: readonly FamilyDetailUnavailable[] = [
  "member_limit_reached",
  "invitation_limit_reached",
];

export type FamilyOverview = {
  userId: string;
  spaces: ListedSpace[];
  selected: FamilySpaceView | null;
  selectedUnavailable?: FamilyDetailUnavailable;
};

/**
 * `selectedSpaceId` is read from the page's own `?space=` query string, the
 * same way `useSearchParams` read it on the Convex component. A shared space
 * the caller does not belong to, or an unknown id, resolves to no detail
 * rather than an error: the page falls back to the plain space list.
 *
 * The second-model review of P2-39i5 found the previous bare `catch` here
 * swallowed every failure `getFamilySpace` could raise, including a genuine
 * database error and `member_limit_reached`, and rendered all of them as "not
 * a member". Only the typed `space_not_found` denial is caught now; a bound
 * that actually bound is reported through `selectedUnavailable` instead of
 * being hidden, and anything else propagates to the page's own error
 * boundary.
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
    let selectedUnavailable: FamilyDetailUnavailable | undefined;
    if (target && target.kind === "shared") {
      try {
        selected = await getFamilySpace(ctx, {
          userId: principal.userId,
          spaceId: target.spaceId,
        });
      } catch (error) {
        if (error instanceof IdentityError && error.data?.code === "space_not_found") {
          selected = null;
        } else if (
          error instanceof IdentityError &&
          DETAIL_UNAVAILABLE_CODES.includes(error.data?.code as FamilyDetailUnavailable)
        ) {
          selectedUnavailable = error.data!.code as FamilyDetailUnavailable;
        } else {
          throw error;
        }
      }
    }
    return {
      userId: principal.userId,
      spaces,
      selected,
      ...(selectedUnavailable === undefined ? {} : { selectedUnavailable }),
    };
  });
}
