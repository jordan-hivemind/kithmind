// `POST /api/kith/family/invitations`: the owner's "Invite a member" form,
// wired to `identity.createInvitation`. The token is returned once, exactly as
// the Convex action returned it, so the page can build the one-time invite
// link from the response.

import { createInvitation } from "@repo/kith-store/identity";

import { noStoreJson, problem, readJsonBody, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Read inside the callback, after `withPrincipal`'s guard has run -- see
  // `family/spaces/[id]/route.ts` for why the order matters.
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    const spaceId = body?.spaceId;
    const email = body?.email;
    const role = body?.role;
    if (
      typeof spaceId !== "string" ||
      typeof email !== "string" ||
      typeof role !== "string"
    ) {
      return problem(400, "Invalid request");
    }
    const created = await createInvitation(ctx, {
      actorUserId: principal.userId,
      spaceId,
      email,
      role,
    });
    return noStoreJson(created, 201);
  });
}
