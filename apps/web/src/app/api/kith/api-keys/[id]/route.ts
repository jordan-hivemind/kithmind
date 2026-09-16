// `DELETE /api/kith/api-keys/:id`: the settings page's revoke button.
//
// `identity.revokeApiKey` is the single revocation path required by section 6
// row i5: it checks the key belongs to the caller before it calls
// `deleteApiKey`, so this route never reaches a raw delete.

import { revokeApiKey } from "@repo/kith-store/identity";

import { noContent, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    await revokeApiKey(ctx, { principal, id });
    return noContent();
  });
}
