// `POST /api/kith/family/spaces`: the spaces page's "Create a shared space"
// form, wired to `identity.createSharedSpace`.

import { createSharedSpace } from "@repo/kith-store/identity";

import { noStoreJson, problem, readJsonBody, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const name = body === null ? undefined : body.name;
  if (typeof name !== "string") return problem(400, "Invalid request");
  return withPrincipal(request, async ({ ctx, principal }) => {
    const created = await createSharedSpace(ctx, {
      userId: principal.userId,
      name,
    });
    return noStoreJson(created, 201);
  });
}
