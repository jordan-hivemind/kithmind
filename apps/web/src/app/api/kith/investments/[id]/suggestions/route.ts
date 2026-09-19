// `POST /api/kith/investments/[id]/suggestions`: the documents the drawer
// offers for the entry being typed.
//
// A POST rather than a GET with query parameters, for the reason
// `/api/kith/thoughts/search` is one: the amount and the date are the
// household's financial detail and must not travel in a URL, where they would
// land in a proxy log and in the browser's history.
//
// Nothing is stored. The suggestion is recomputed from the documents that
// exist at read time, so there is no stale link table and nothing to clean up
// when a document is reprocessed.

import { admin } from "@repo/kith-store";

import {
  noStoreJson,
  parsedBody,
  withPrincipalRead,
} from "@/lib/kith/api-route";
import { suggestSchema } from "@/lib/kith/investment-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, suggestSchema);
    if ("response" in body) return body.response;
    const spaces = await admin.getAdminSpaceIds(ctx, principal);
    if (spaces.length === 0) return noStoreJson({ suggestions: [] });
    return noStoreJson({
      suggestions: await admin.suggestDocumentsForEntry(ctx, spaces, {
        investmentId: (await params).id,
        ...body.value,
      }),
    });
  });
}
