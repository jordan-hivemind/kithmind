// `DELETE /api/kith/attention/mutes/[id]`: remove one standing mute.
//
// The `[id]` segment is not authorization -- the store checks write access
// against the mute's own space -- but an id from another space still reads
// as not found rather than confirming it exists, the same non-enumerating
// denial every other admin write in this app uses.

import { admin } from "@repo/kith-store";

import { noContent, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(
  request: Request,
  { params }: Params,
): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    await admin.removeAttentionMute(ctx, { principal, id: (await params).id });
    return noContent();
  });
}
