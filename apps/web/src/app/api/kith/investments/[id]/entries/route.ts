// `/api/kith/investments/[id]/entries`: one investment's entries.
//
// GET reads them, which is what the screen calls when a row is expanded; POST
// creates, PATCH edits and DELETE removes. The three that act on an existing
// entry name it in the body rather than in a second path segment, because the
// entry id is already unique and a nested `[entryId]` segment would be a
// second file saying the same three lines.
//
// The `[id]` segment is not authorization -- the store checks write access
// against the space the row itself names -- but it is not decoration either:
// every handler passes it down, and the store refuses an entry that belongs to
// a different investment. Without that, an entry could be edited through a URL
// naming an investment it has nothing to do with, and the path would be a lie
// about what was changed.

import { admin } from "@repo/kith-store";

import {
  noContent,
  noStoreJson,
  parsedBody,
  withPrincipal,
  withPrincipalRead,
} from "@/lib/kith/api-route";
import {
  createEntrySchema,
  deleteEntrySchema,
  patchEntrySchema,
} from "@/lib/kith/investment-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  { params }: Params,
): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const spaces = await admin.getAdminSpaceIds(ctx, principal);
    if (spaces.length === 0) return noStoreJson({ entries: [] });
    return noStoreJson({
      entries: await admin.listInvestmentEntries(ctx, spaces, [
        (await params).id,
      ]),
    });
  });
}

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

export async function PATCH(
  request: Request,
  { params }: Params,
): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, patchEntrySchema);
    if ("response" in body) return body.response;
    await admin.updateInvestmentEntry(ctx, {
      principal,
      investmentId: (await params).id,
      ...body.value,
    });
    return noContent();
  });
}

export async function DELETE(
  request: Request,
  { params }: Params,
): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, deleteEntrySchema);
    if ("response" in body) return body.response;
    await admin.deleteInvestmentEntry(ctx, {
      principal,
      investmentId: (await params).id,
      entryId: body.value.entryId,
    });
    return noContent();
  });
}
