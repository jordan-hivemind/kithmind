// `GET /api/status/worker?sourceAccountId=`: the worker heartbeat's read-time
// staleness, on PostgreSQL. This is `worker-heartbeat-status.tsx`'s poll
// target under `postgres` (plan section 5, row i6), replacing the Convex
// subscription `diagnostics.public.status` served under `convex`.
//
// One `withPrincipalRead` -- the surface, origin and content-type gate
// (`guardedRequest`, shared with the `/api/kith/*` mutation routes and
// `thoughts/search`), then one `REPEATABLE READ READ ONLY` transaction with
// `requireWebPrincipal` reloaded from the cookie inside it, never trusted
// from the middleware or from whatever rendered the page. No space id is
// read from the request; `loadWorkerStatus` resolves `sourceAccountId`
// against the caller's own authorized space set. The `sourceAccountId`
// presence check runs inside the callback, after the gate, so a
// cross-origin or wrong-content-type request never reaches it -- the same
// ordering finding 8 of the P2-39i5 review required for a route's own body
// checks.

import { noStoreJson, problem, withPrincipalRead } from "@/lib/kith/api-route";
import { loadWorkerStatus } from "@/lib/kith/worker-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const sourceAccountId = new URL(request.url).searchParams.get("sourceAccountId");
    if (!sourceAccountId) return problem(400, "sourceAccountId is required");
    const status = await loadWorkerStatus(ctx, principal, sourceAccountId);
    return noStoreJson(status);
  });
}
