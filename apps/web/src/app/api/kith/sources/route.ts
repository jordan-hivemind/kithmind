// `GET /api/kith/sources`: the sources screen's refetch.
//
// The screen's first paint comes from the page's own read transaction
// (`lib/kith/sources-data.ts`); this is what the client refetches through when
// `useLiveChanges` sees a change on a table the screen reads. Same session
// check, same space scoping, same shape.

import { admin } from "@repo/kith-store";

import { noStoreJson, withPrincipalRead } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) =>
    noStoreJson({
      sources: await admin.listSourcesInventory(ctx, { principal }),
      roots: await admin.listSourceRoots(ctx, { principal }),
    }),
  );
}
