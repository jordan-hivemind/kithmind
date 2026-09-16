// `POST /api/kith/thoughts/search`: the browse page's thought search.
//
// A route rather than a `?q=` query string on `/browse`, so the search text
// travels in the request body, not the URL -- see `lib/kith/browse.ts` for
// why that distinction matters here. Read-only (`withPrincipalRead`): search
// does not write, and `embeddings.searchThoughtsHybrid`'s keyword leg needs
// nothing the server component's read-only transaction shape does not
// already give every other read on this surface.

import { getAuthorizedReadSpaceIds } from "@repo/kith-store/identity";

import { noStoreJson, problem, readJsonBody, withPrincipalRead } from "@/lib/kith/api-route";
import { searchThoughtsScoped } from "@/lib/kith/browse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Read inside the callback, after `withPrincipalRead`'s guard has run --
  // see `family/spaces/[id]/route.ts` for why the order matters.
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (!query) return problem(400, "Invalid request");
    const includeHistorical = body?.includeHistorical === true;
    const type = typeof body?.type === "string" ? body.type : undefined;

    const spaceIds = await getAuthorizedReadSpaceIds(ctx, principal);
    const result = await searchThoughtsScoped(ctx, spaceIds, {
      query,
      includeHistorical,
      ...(type === undefined ? {} : { type }),
    });
    return noStoreJson(result);
  });
}
