// `/api/kith/investments`: the investments screen's read and its three
// investment-level writes.
//
// One file for four methods rather than four files, because they are one
// resource and share one validation vocabulary. GET is the screen's refetch
// (the first paint comes from the page's own read transaction), POST creates,
// PATCH edits and DELETE archives -- archives, not deletes: the entries and
// therefore the totals survive, and the row leaves the default read.
//
// Every amount crossing this boundary is an exact decimal string in both
// directions. `numeric` in PostgreSQL, `string` in TypeScript, and no `number`
// anywhere between, so nothing rounds a cent on the way through JSON.
//
// The space set is `getAdminSpaceIds`: owner or editor only, the same gate the
// `/admin` layout applies, resolved inside this request's own transaction. A
// reader resolves to no space and gets an empty list rather than a denial,
// which is what the layout's 404 already implies.

import { admin } from "@repo/kith-store";

import {
  noContent,
  noStoreJson,
  withPrincipal,
  withPrincipalRead,
} from "@/lib/kith/api-route";
import {
  archiveInvestmentSchema,
  createInvestmentSchema,
  parsedBody,
  patchInvestmentSchema,
} from "@/lib/kith/investment-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const spaces = await admin.getAdminSpaceIds(ctx, principal);
    if (spaces.length === 0) {
      return noStoreJson({ investments: [], entries: [] });
    }
    const includeArchived =
      new URL(request.url).searchParams.get("includeArchived") === "1";
    // Both halves from one snapshot: an entry arriving between two reads would
    // otherwise show under a total that does not contain it.
    return noStoreJson({
      investments: await admin.listInvestments(ctx, spaces, {
        includeArchived,
      }),
      entries: await admin.listInvestmentEntries(ctx, spaces),
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, createInvestmentSchema);
    if ("response" in body) return body.response;
    const id = await admin.createInvestment(ctx, { principal, ...body.value });
    return noStoreJson({ id }, 201);
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, patchInvestmentSchema);
    if ("response" in body) return body.response;
    const { id, ...fields } = body.value;
    await admin.updateInvestment(ctx, {
      principal,
      investmentId: id,
      ...fields,
    });
    return noContent();
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, archiveInvestmentSchema);
    if ("response" in body) return body.response;
    await admin.archiveInvestment(ctx, {
      principal,
      investmentId: body.value.id,
      ...(body.value.archived === undefined
        ? {}
        : { archived: body.value.archived }),
    });
    return noContent();
  });
}
