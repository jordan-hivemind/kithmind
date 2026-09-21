import { coverage } from "@repo/kith-store";

import {
  noContent,
  noStoreJson,
  parsedBody,
  withPrincipal,
  withPrincipalRead,
} from "@/lib/kith/api-route";
import { acknowledgeCoverageGapSchema } from "@/lib/kith/coverage-gaps-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) =>
    noStoreJson(await coverage.listCoverageGaps(ctx, { principal })),
  );
}

export async function PATCH(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, acknowledgeCoverageGapSchema);
    if ("response" in body) return body.response;
    await coverage.acknowledgeCoverageGap(ctx, {
      principal,
      gapId: body.value.id,
      action: body.value.action,
      ...(body.value.note === undefined ? {} : { note: body.value.note }),
    });
    return noContent();
  });
}
