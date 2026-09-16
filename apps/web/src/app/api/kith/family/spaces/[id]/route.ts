// `POST /api/kith/family/spaces/:id`: the two shared-space actions that act on
// the space itself rather than on one membership or invitation --
// `identity.leaveSharedSpace` and `identity.transferSharedSpaceOwnership` --
// picked by the body's `action` field so leaving and transferring do not need
// two route files for one resource.

import {
  leaveSharedSpace,
  transferSharedSpaceOwnership,
} from "@repo/kith-store/identity";

import { noContent, problem, readJsonBody, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: spaceId } = await params;
  // Read inside the callback, after `withPrincipal`'s guard has run. The
  // second-model review of P2-39i5 found that reading the body first (to
  // decide which service function to call) let a request with the wrong
  // content type reach this route's own "Invalid request" branch and return
  // 400 before the guard ever ran -- the guard silently skipped for the one
  // route that branches on its body before authenticating.
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    const action = body?.action;
    if (action === "leave") {
      await leaveSharedSpace(ctx, { userId: principal.userId, spaceId });
      return noContent();
    }
    if (action === "transferOwnership") {
      const toMembershipId = body?.toMembershipId;
      if (typeof toMembershipId !== "string") return problem(400, "Invalid request");
      await transferSharedSpaceOwnership(ctx, {
        actorUserId: principal.userId,
        spaceId,
        toMembershipId,
      });
      return noContent();
    }
    return problem(400, "Invalid request");
  });
}
