// `POST` approves and `DELETE` revokes one invitation, wired to
// `identity.approveInvitationForOwner` and `identity.revokeInvitationForOwner`.

import {
  approveInvitationForOwner,
  revokeInvitationForOwner,
} from "@repo/kith-store/identity";

import { noContent, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: invitationId } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    await approveInvitationForOwner(ctx, {
      actorUserId: principal.userId,
      invitationId,
    });
    return noContent();
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: invitationId } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    await revokeInvitationForOwner(ctx, {
      actorUserId: principal.userId,
      invitationId,
    });
    return noContent();
  });
}
