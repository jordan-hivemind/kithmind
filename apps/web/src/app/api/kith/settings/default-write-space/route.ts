// `POST /api/kith/settings/default-write-space`: the settings page's
// destination picker, wired to `identity.setDefaultWriteSpace`.

import { setDefaultWriteSpace } from "@repo/kith-store/identity";

import { noContent, problem, readJsonBody, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return problem(400, "Invalid request");
  const raw = body.spaceId;
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    return problem(400, "Invalid request");
  }
  return withPrincipal(request, async ({ ctx, principal }) => {
    await setDefaultWriteSpace(ctx, {
      principal,
      spaceId: raw === undefined ? null : raw,
    });
    return noContent();
  });
}
