// `POST /api/kith/thoughts/capture`: the dashboard's Quick Capture.
//
// i7a of the web and MCP surface plan. This route cannot use `withPrincipal`
// or `withPrincipalRead` (`lib/kith/api-route.ts`): both wrap the whole
// request in one transaction, and `captureThoughtFromWeb` -- narrative
// capture's admission gate, shared with the MCP `capture_thought` tool --
// opens one to three transactions of its own (see `lib/kith/capture.ts`'s
// module comment for the shape and why). So the route runs `guardedRequest`
// directly for the surface/origin/content-type gate, and hands the gate a
// `webPrincipalLoader` (`lib/mcp/principal.ts`) bound to this request's
// cookie header; every transaction the gate opens reloads the session fresh
// from it, the same property a revoked API key has across two MCP tool
// calls. An authentication failure on the gate's first transaction is an
// `IdentityError("Not authenticated")`, mapped by `mutationFailure` below,
// same as every other `/api/kith/*` route's 401.

import { guardedRequest, mutationFailure, noStoreJson, problem, readJsonBody } from "@/lib/kith/api-route";
import { captureThoughtFromWeb } from "@/lib/kith/capture";
import { webPrincipalLoader } from "@/lib/mcp/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guarded = guardedRequest(request);
  if (guarded) return guarded;
  try {
    const body = await readJsonBody(request);
    if (body === null) return problem(400, "Invalid request");
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) return problem(400, "Invalid request");
    // A present `spaceId` that is not a string (a number, an object, `null`)
    // is refused rather than dropped: silently falling back to the default
    // write space would capture the thought somewhere the caller did not
    // name, which is a worse failure than a 400.
    if ("spaceId" in body && typeof body.spaceId !== "string") {
      return problem(400, "Invalid request");
    }
    const spaceId = typeof body.spaceId === "string" ? body.spaceId : undefined;

    const result = await captureThoughtFromWeb(
      webPrincipalLoader(request.headers.get("cookie")),
      {
        content,
        ...(spaceId === undefined ? {} : { spaceId }),
      },
    );
    return noStoreJson(result, result.disposition === "stored" ? 201 : 200);
  } catch (error) {
    return mutationFailure(error);
  }
}
