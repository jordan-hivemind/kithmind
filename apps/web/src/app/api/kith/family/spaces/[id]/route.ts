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
  const body = await readJsonBody(request);
  const action = body?.action;
  if (action === "leave") {
    return withPrincipal(request, async ({ ctx, principal }) => {
      await leaveSharedSpace(ctx, { userId: principal.userId, spaceId });
      return noContent();
    });
  }
  if (action === "transferOwnership") {
    const toMembershipId = body?.toMembershipId;
    if (typeof toMembershipId !== "string") return problem(400, "Invalid request");
    return withPrincipal(request, async ({ ctx, principal }) => {
      await transferSharedSpaceOwnership(ctx, {
        actorUserId: principal.userId,
        spaceId,
        toMembershipId,
      });
      return noContent();
    });
  }
  return problem(400, "Invalid request");
}
