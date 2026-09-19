// `POST /api/kith/attention/count`: how many open-or-snoozed rows a bulk
// filter would touch, without touching them.
//
// One caller today: the "Dismiss everything before [date]" control, whose
// confirm dialog is required to state a real count (the action is unbounded
// and owner-visible) rather than "some" or nothing at all. POST, not GET,
// because the filter is a JSON shape (`AttentionFilter`), the same reason
// `investments/[id]/suggestions` is a POST despite reading rather than
// writing anything.

import { admin } from "@repo/kith-store";

import { noStoreJson, parsedBody, withPrincipalRead } from "@/lib/kith/api-route";
import { countAttentionFilterSchema } from "@/lib/kith/attention-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, countAttentionFilterSchema);
    if ("response" in body) return body.response;
    const count = await admin.countAttentionByFilter(ctx, {
      principal,
      spaceId: body.value.spaceId,
      filter: body.value.filter,
    });
    return noStoreJson({ count });
  });
}
