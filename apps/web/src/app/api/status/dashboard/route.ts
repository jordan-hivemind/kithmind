// `GET /api/status/dashboard`: the dashboard's live section poll target on
// PostgreSQL (plan section 5, row i6), replacing the Convex reactivity
// `thoughts.public.getStats` and `thoughts.public.listRecent` gave the
// `convex` surface for free.
//
// One `withPrincipalRead` -- the same surface, origin and content-type gate
// (`guardedRequest`) the `/api/kith/*` mutation routes and `thoughts/search`
// share, then one `REPEATABLE READ READ ONLY` transaction with
// `requireWebPrincipal` reloaded from the cookie inside it -- calling
// `computeDashboardData` on that same session. That is the exact computation
// `app/(authenticated)/page.tsx`'s `loadDashboard` runs for the first paint
// (`lib/kith/dashboard.ts`'s one shared function, each caller's own
// transaction), so the poll and the server component can never disagree
// about how a stat is computed.

import { noStoreJson, withPrincipalRead } from "@/lib/kith/api-route";
import { computeDashboardData } from "@/lib/kith/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withPrincipalRead(request, async (session) => {
    const data = await computeDashboardData(session);
    return noStoreJson(data);
  });
}
