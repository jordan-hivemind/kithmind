// `GET /api/status/worker?sourceAccountId=`: the worker heartbeat's read-time
// staleness, on PostgreSQL. This is `worker-heartbeat-status.tsx`'s poll
// target under `postgres` (plan section 5, row i6), replacing the Convex
// subscription `diagnostics.public.status` served under `convex`.
//
// One `withReadPrincipal` -- one `REPEATABLE READ READ ONLY` transaction,
// `requireWebPrincipal` reloaded from the cookie inside it, never trusted
// from the middleware or from whatever rendered the page. No space id is
// read from the request; `loadWorkerStatus` resolves `sourceAccountId`
// against the caller's own authorized space set.

import { noStoreJson, problem, withReadPrincipal } from "@/lib/kith/api-route";
import { loadWorkerStatus } from "@/lib/kith/worker-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const sourceAccountId = new URL(request.url).searchParams.get("sourceAccountId");
  if (!sourceAccountId) return problem(400, "sourceAccountId is required");
  return withReadPrincipal(request, async ({ ctx, principal }) => {
    const status = await loadWorkerStatus(ctx, principal, sourceAccountId);
    return noStoreJson(status);
  });
}
