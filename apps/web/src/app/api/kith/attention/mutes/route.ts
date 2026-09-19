// `/api/kith/attention/mutes`: the standing suppression list (ADM-8a).
//
// GET lists every mute in the caller's administered spaces; POST adds one,
// idempotently (migration 029's unique index on `(space_id, scope_kind,
// scope_value)`, so a second add of the same mute returns the first one's
// id rather than erroring or duplicating it). Removing one is
// `DELETE /api/kith/attention/mutes/[id]`.

import { admin } from "@repo/kith-store";

import {
  noStoreJson,
  parsedBody,
  withPrincipal,
  withPrincipalRead,
} from "@/lib/kith/api-route";
import { addMuteSchema } from "@/lib/kith/attention-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    return noStoreJson({ mutes: await admin.listAttentionMutes(ctx, { principal }) });
  });
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, addMuteSchema);
    if ("response" in body) return body.response;
    const id = await admin.addAttentionMute(ctx, {
      principal,
      spaceId: body.value.spaceId,
      scopeKind: body.value.scopeKind,
      scopeValue: body.value.scopeValue,
      reason: body.value.reason,
    });
    return noStoreJson({ id }, 201);
  });
}
