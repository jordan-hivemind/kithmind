// `/api/kith/investments/[id]/entries`: adding an entry is the frequent
// action, so it is the smallest surface that can be.
//
// POST creates, PATCH edits and DELETE removes; the two that act on an
// existing entry name it in the body rather than in a second path segment,
// because the entry id is already unique and a nested `[entryId]` segment
// would be a second file saying the same three lines.
//
// The store re-checks that the entry belongs to the investment's space and
// that the caller may write there, so the `[id]` segment is not trusted as
// authorization: it is the investment a create attaches to, and nothing else.

import { admin } from "@repo/kith-store";

import {
  noContent,
  noStoreJson,
  withPrincipal,
} from "@/lib/kith/api-route";
import {
  createEntrySchema,
  deleteEntrySchema,
  parsedBody,
  patchEntrySchema,
} from "@/lib/kith/investment-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  { params }: Params,
): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, createEntrySchema);
    if ("response" in body) return body.response;
    const result = await admin.createInvestmentEntry(ctx, {
      principal,
      investmentId: (await params).id,
      ...body.value,
    });
    // 200 rather than 201 when the import key said this row already existed:
    // the caller asked for the row to exist and it does, but nothing was made.
    return noStoreJson(result, result.created ? 201 : 200);
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, patchEntrySchema);
    if ("response" in body) return body.response;
    await admin.updateInvestmentEntry(ctx, { principal, ...body.value });
    return noContent();
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, deleteEntrySchema);
    if ("response" in body) return body.response;
    await admin.deleteInvestmentEntry(ctx, {
      principal,
      entryId: body.value.entryId,
    });
    return noContent();
  });
}
