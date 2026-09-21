// `PATCH /api/kith/source-accounts/:id`: the settings page's edit and
// enable/disable actions, wired to `sources.updateSourceAccount`.

import { sources } from "@repo/kith-store";

import {
  noContent,
  problem,
  readJsonBody,
  withPrincipal,
} from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  // Read inside the callback, after `withPrincipal`'s guard has run -- see
  // `api-keys/route.ts` for why the order matters.
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    if (body === null) return problem(400, "Invalid request");
    const name = typeof body.name === "string" ? body.name : undefined;
    const enabled =
      typeof body.enabled === "boolean" ? body.enabled : undefined;
    const freshnessMs =
      typeof body.freshnessMs === "number" ? body.freshnessMs : undefined;
    await sources.updateSourceAccount(ctx, {
      principal,
      sourceAccountId: id,
      ...(name === undefined ? {} : { name }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(freshnessMs === undefined ? {} : { freshnessMs }),
    });
    return noContent();
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    const result = await sources.disconnectSourceAccount(ctx, {
      principal,
      sourceAccountId: id,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  });
}
