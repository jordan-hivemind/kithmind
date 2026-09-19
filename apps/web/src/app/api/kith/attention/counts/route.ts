// `GET /api/kith/attention/counts`: the nav badge's own read.
//
// Split out of the main list route so the badge -- shown beside the
// "Attention" link on every admin page, not just the attention screen
// itself -- costs a severity-grouped count query rather than a full
// default-view list on every page load.

import { admin } from "@repo/kith-store";

import { noStoreJson, withPrincipalRead } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    return noStoreJson(await admin.attentionSeverityCounts(ctx, { principal }));
  });
}
