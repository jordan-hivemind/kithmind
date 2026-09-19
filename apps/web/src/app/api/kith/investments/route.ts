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
  parsedBody,
  withPrincipal,
  withPrincipalRead,
} from "@/lib/kith/api-route";
import {
  archiveInvestmentSchema,
  createInvestmentSchema,
  patchInvestmentSchema,
} from "@/lib/kith/investment-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const spaces = await admin.getAdminSpaceIds(ctx, principal);
    if (spaces.length === 0) {
      return noStoreJson({ investments: [] });
    }
    const includeArchived =
      new URL(request.url).searchParams.get("includeArchived") === "1";
    // Investments and their totals, never the entries. One investment's
    // entries are read when its row is expanded
    // (`GET /api/kith/investments/[id]/entries`), so this read's cost is the
    // number of investments the owner has rather than the number of capital
    // calls he has ever paid -- which is a number that only grows, and which
    // the earlier single-list shape would eventually have refused to return
    // at all.
    return noStoreJson({
      investments: await admin.listInvestments(ctx, spaces, {
        includeArchived,
      }),
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
