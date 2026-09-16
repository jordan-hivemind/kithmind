// What the `/api/kith/*` mutation routes share: the body, the session check,
// and the response shapes.
//
// Every route below is the write half of a page i5 ported: settings' API
// keys and source accounts, and the family space manager. Each one runs in
// exactly one `withKithTransaction`, and `requireWebPrincipal` is called
// inside it, never trusted from the middleware or from a page that rendered
// earlier in the request -- the same rule `lib/kith/page-session.ts` states
// for the read side. `withPrincipal` below is that rule for the write side.

import { withKithTransaction } from "@repo/kith-store";
import {
  type IdentityCtx,
  identityCtx,
  IdentityError,
  type Principal,
  requireWebPrincipal,
} from "@repo/kith-store/identity";

import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

export function noStoreJson(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export function problem(status: number, error: string): Response {
  return noStoreJson({ error }, status);
}

/**
 * The JSON body, or null when it is not an object. Only `application/json` is
 * accepted, for the reason `lib/kith/auth-route.ts` states: it is a content
 * type a cross-site form post cannot send.
 */
export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return null;
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * One authenticated mutation, one transaction, one reloaded principal.
 *
 * Returns the route's response either way: `run` produces the success
 * response, and a denial is mapped to a response here, so every caller gets
 * the same shape for the same failure rather than inventing its own.
 */
export async function withPrincipal(
  request: Request,
  run: (session: { ctx: IdentityCtx; principal: Principal }) => Promise<Response>,
): Promise<Response> {
  try {
    const config = kithSessionConfig();
    return await withKithTransaction(kithPool(), async (client) => {
      const ctx = identityCtx(client);
      const principal = await requireWebPrincipal(ctx, {
        config,
        cookieHeader: request.headers.get("cookie"),
      });
      return await run({ ctx, principal });
    });
  } catch (error) {
    return mutationFailure(error);
  }
}

/**
 * The response for a failure raised inside `withPrincipal`.
 *
 * `IdentityError` covers every denial the identity, sources and family
 * surfaces raise (`errorThrower` in `identity/errors.ts` builds all of them
 * from the same class), so one mapping serves every route in this
 * directory. "Not authenticated" is the one case a caller must be able to
 * tell apart from every other denial: the client redirects to sign-in on a
 * 401 and shows every other code as a form error.
 */
/**
 * The bare (non-`IdentityError`) messages the ported services are known to
 * throw as pure input validation, verbatim. Every one of them comes from a
 * check that runs before any row is touched, so none of them can carry a
 * database detail; anything else that is merely `instanceof Error` -- a `pg`
 * error included -- is not on this list on purpose and falls through to the
 * opaque 500 below, the same rule `lib/kith/auth-route.ts` uses for the
 * session routes.
 */
const VALIDATION_MESSAGES = new Set([
  "API keys require bounded capabilities and space scopes",
  "API key scopes must be unique",
  "Ingest capability requires explicit source accounts; other keys cannot grant them",
  "Source account not found",
  "API key not found",
  "Personal space is not configured",
]);

export function mutationFailure(error: unknown): Response {
  if (error instanceof IdentityError) {
    if (error.message === "Not authenticated") {
      return problem(401, "Not authenticated");
    }
    return problem(400, error.data?.code ?? error.message);
  }
  if (error instanceof Error && VALIDATION_MESSAGES.has(error.message)) {
    return problem(400, error.message);
  }
  console.error("kith mutation route failed", error);
  return problem(500, "Server error");
}
