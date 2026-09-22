// `GET /api/kith/admin/{health,institutions,coverage}`: ADM-2's refetch.
//
// One route for three screens, because all three are the same request -- no
// body, no filter, the caller's own session -- differing only in which loader
// answers. Each screen's first paint still comes from its own page's read
// transaction (`lib/kith/admin-data.ts`); this is what the client refetches
// through when `useLiveChanges` sees a change on a table the screen reads.
//
// `screen` is matched against a closed map rather than used to build anything,
// so a path segment can only select a loader that exists here, and an unknown
// one is a 404 rather than an error naming what it tried.
//
// The session check is `withPrincipalRead`'s, and each loader re-checks it
// inside its own transaction and narrows to `getAdminSpaceIds` for itself. A
// `reader` member reaching this route gets the same empty answer the admin
// layout's 404 would have kept them from asking for.

import {
  loadBalances,
  loadCoverage,
  loadHealth,
  loadInstitutions,
} from "@/lib/kith/admin-data";
import { guardedRequest, mutationFailure, noStoreJson, problem } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOADERS = {
  health: loadHealth,
  institutions: loadInstitutions,
  coverage: loadCoverage,
  balances: loadBalances,
} as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ screen: string }> },
): Promise<Response> {
  const guarded = guardedRequest(request);
  if (guarded) return guarded;
  const { screen } = await context.params;
  const load = Object.prototype.hasOwnProperty.call(LOADERS, screen)
    ? LOADERS[screen as keyof typeof LOADERS]
    : undefined;
  if (load === undefined) return problem(404, "No such screen", "not_found");
  try {
    // The loaders open their own read transaction and authenticate inside it,
    // the same way the pages do, rather than being handed one from here: they
    // also read the finance archive, which is a second pool and must not be
    // reached with a kith connection held open across it.
    const data = await load(request.headers.get("cookie"));
    if (data === null) return problem(401, "Not authenticated", "not_authenticated");
    return noStoreJson(data);
  } catch (error) {
    return mutationFailure(error);
  }
}
