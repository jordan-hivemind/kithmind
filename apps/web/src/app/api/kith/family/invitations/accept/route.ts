// `POST /api/kith/family/invitations/accept`: the `/invite` page's accept
// button, wired to `identity.acceptInvitationByToken`. The token is the
// browser address fragment, which never reaches the server in the URL; it
// arrives only in this request's JSON body.

import { acceptInvitationByToken } from "@repo/kith-store/identity";

import { noContent, problem, readJsonBody, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const token = body?.token;
  if (typeof token !== "string") return problem(400, "Invalid request");
  return withPrincipal(request, async ({ ctx, principal }) => {
    await acceptInvitationByToken(ctx, { userId: principal.userId, token });
    return noContent();
  });
}
