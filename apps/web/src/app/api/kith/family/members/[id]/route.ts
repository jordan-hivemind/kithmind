// `PATCH` changes a member's role and `DELETE` removes them, wired to
// `identity.changeFamilyMemberRole` and `identity.removeFamilyMember`.

import {
  changeFamilyMemberRole,
  removeFamilyMember,
} from "@repo/kith-store/identity";

import { noContent, problem, readJsonBody, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: membershipId } = await params;
  // Read inside the callback, after `withPrincipal`'s guard has run -- see
  // `family/spaces/[id]/route.ts` for why the order matters.
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    const role = body?.role;
    if (role !== "editor" && role !== "reader") return problem(400, "Invalid request");
    await changeFamilyMemberRole(ctx, {
      actorUserId: principal.userId,
      membershipId,
      role,
    });
    return noContent();
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: membershipId } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    await removeFamilyMember(ctx, { actorUserId: principal.userId, membershipId });
    return noContent();
  });
}
