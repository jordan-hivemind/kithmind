// `GET /api/status/dashboard`: the dashboard's live section poll target on
// PostgreSQL (plan section 5, row i6), replacing the Convex reactivity
// `thoughts.public.getStats` and `thoughts.public.listRecent` gave the
// `convex` surface for free.
//
// Reuses `loadDashboard` byte for byte -- the same loader
// `app/(authenticated)/page.tsx` calls for the first paint, one
// `withKithReadTransaction` with `requireWebPrincipal` reloaded from the
// cookie inside it -- so the poll and the server component can never
// disagree about how a stat is computed, and there is exactly one place that
// resolves the caller's authorized space set for this surface.

import { noStoreJson, problem } from "@/lib/kith/api-route";
import { loadDashboard } from "@/lib/kith/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const data = await loadDashboard(request.headers.get("cookie"));
  if (data === null) return problem(401, "Not authenticated");
  return noStoreJson(data);
}
