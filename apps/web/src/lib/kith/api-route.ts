// What the `/api/kith/*` routes share: the same-origin and
// content-type checks, the session check, and the response shapes.
//
// Every route below is the write half of a page i5 ported (settings' API
// keys and source accounts, and the family space manager) or, for
// `withPrincipalRead`, the one read route that cannot stay a plain server
// component (`/api/kith/thoughts/search`, because the search text must not
// travel in the URL -- see `lib/kith/browse.ts`). Each one runs in exactly
// one transaction, and `requireWebPrincipal` is called inside it, never
// trusted from the middleware or from a page that rendered earlier in the
// request -- the same rule `lib/kith/page-session.ts` states for the plain
// read side. `guardedRequest` below is the part of that rule that is common
// to every request regardless of what it does once authenticated.

import {
  memory,
  ProofError,
  withKithReadTransaction,
  withKithTransaction,
} from "@repo/kith-store";
import {
  type IdentityCtx,
  identityCtx,
  IdentityError,
  type Principal,
  requireWebPrincipal,
} from "@repo/kith-store/identity";

import { kithNow } from "@/lib/kith/clock";
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

/**
 * `code` is the machine-readable denial (`owner_required`, `last_owner`,
 * `invalid_space_id`, ...), included alongside `message` rather than in place
 * of it: a client that wants to render user-facing text can use `error`
 * directly, and one that wants to branch on the failure has `code` to match
 * on instead of parsing prose.
 */
export function problem(status: number, message: string, code?: string): Response {
  return noStoreJson(code === undefined ? { error: message } : { error: message, code }, status);
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
 * The JSON body parsed against a schema, or the 400 to send instead.
 *
 * Here rather than beside the schemas it is used with: those are loaded into
 * the client bundle, because the spreadsheet import validates every row in the
 * browser against the very schemas its routes will validate them with, and
 * this module pulls in `@repo/kith-store`.
 */
export async function parsedBody<T>(
  request: Request,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): Promise<{ value: T } | { response: Response }> {
  const body = await readJsonBody(request);
  if (body === null) return { response: problem(400, "Invalid request") };
  const result = schema.safeParse(body);
  if (!result.success || result.data === undefined) {
    return { response: problem(400, "Invalid request", "invalid_input") };
  }
  return { value: result.data };
}

/**
 * Same-origin, the way a fetch from this app's own pages always is.
 *
 * `Sec-Fetch-Site` is sent by every browser that still matters and cannot be
 * set by the caller, so it is checked first and trusted alone when present.
 * `same-origin` covers a same-origin `fetch`; `none` covers a request typed
 * directly into the address bar or opened from a bookmark, which is not a
 * cross-site forgery either. Its absence (an older browser, or a non-browser
 * client such as a test) falls back to comparing `Origin` against the
 * request's own host, and a request with neither header is refused: every
 * caller this app's own pages produce sends at least one of the two.
 */
function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * The checks every `/api/kith/*` request needs before it may reach a
 * transaction, regardless of what the route does: `null` to proceed, or the
 * response to send instead.
 *
 *   * Same-origin (finding 8): a state-changing request from another origin
 *     is refused before it is ever handed a transaction.
 *   * Content type (finding 8): required on every method, including a
 *     bodyless `POST` such as approving an invitation -- a plain cross-site
 *     HTML form cannot set a custom header, so requiring one here is a second,
 *     independent barrier past the origin check, not a body format check.
 *
 * Exported since i7a: `/api/kith/thoughts/capture` cannot use `withPrincipal`
 * or `withPrincipalRead`, because `captureThoughtFromWeb` opens its own one-
 * to-three transactions internally (see `lib/kith/capture.ts`'s module
 * comment) and neither wrapper's single transaction fits that shape. The
 * route runs this gate directly and lets `captureThoughtFromWeb`'s own
 * `webPrincipalLoader` (`lib/mcp/principal.ts`) authenticate.
 */
export function guardedRequest(request: Request): Response | null {
  if (!isSameOriginRequest(request)) {
    return problem(403, "Cross-origin request refused", "cross_origin_refused");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return problem(415, "Content-Type must be application/json", "invalid_content_type");
  }
  return null;
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
  const guarded = guardedRequest(request);
  if (guarded) return guarded;
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
 * The read counterpart of `withPrincipal`: same gate (origin,
 * content type), same denial mapping, `withKithReadTransaction` instead of
 * `withKithTransaction`. Two callers share it -- the one `/api/kith/*` route
 * that reads rather than writes (`thoughts/search`, because the search text
 * must not travel in the URL -- see `lib/kith/browse.ts`) and i6's
 * `app/api/status/*` routes, which need the same session check and the same
 * `Cache-Control: no-store` shape but never write.
 *
 * `ctx.now` comes from `kithNow()` rather than a bare `Date.now()` default,
 * so a caller that needs a fixed clock for a read-time predicate
 * (`lib/kith/clock.ts`'s `setKithNow`, which i6's worker-status route uses)
 * can get one without this function knowing it is under test.
 */
export async function withPrincipalRead(
  request: Request,
  run: (session: { ctx: IdentityCtx; principal: Principal }) => Promise<Response>,
): Promise<Response> {
  const guarded = guardedRequest(request);
  if (guarded) return guarded;
  try {
    const config = kithSessionConfig();
    return await withKithReadTransaction(kithPool(), async (client) => {
      const ctx = identityCtx(client, kithNow());
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
 * The bare (non-`IdentityError`, non-`ProofError`) messages the ported
 * services are known to throw as pure input validation, verbatim. Every one
 * of them comes from a check that runs before any row is touched, so none of
 * them can carry a database detail; anything else that is merely
 * `instanceof Error` -- a `pg` error included -- is not on this list on
 * purpose and falls through to the opaque 500 below, the same rule
 * `lib/kith/auth-route.ts` uses for the session routes.
 */
const VALIDATION_MESSAGES = new Set([
  "API keys require bounded capabilities and space scopes",
  "API key scopes must be unique",
  "Ingest capability requires explicit source accounts; other keys cannot grant them",
  "Source account not found",
  "API key not found",
  "Personal space is not configured",
  // `resolveWriteSpace` (`identity/authorization.ts`), reached by every
  // `/api/kith/*` write that resolves a destination without one named
  // explicitly, `/api/kith/thoughts/capture` included: a principal whose
  // configured default write space was deleted or left gets a 400 that
  // names no space id, rather than the opaque 500 this bare message fell
  // through to before.
  "Default write space is not available",
  // `/api/kith/thoughts/capture` (`lib/kith/capture.ts`'s
  // `captureThoughtFromWeb`, the narrative capture admission gate's web
  // caller): the one bare message `runCaptureThought`'s transaction 1 can
  // still throw before any row is touched, from `normalizeCaptureContent`'s
  // length bound. Not "Invalid memory validity interval" or "Invalid memory
  // provenance": this route's request body carries no `validFrom`/`validTo`
  // and no provenance fields (`sourceRef`, `observedAt`, `batchId`), so the
  // gate's validators for them never run long enough to throw.
  `Memory content must contain 1-${memory.MAX_CAPTURE_CONTENT_CHARS} characters`,
  // `memory.updateThought`/`deleteThought`/`updateFact`/`retireFact`
  // (`lib/kith/memory-write.ts`'s `writableThought`/`writableFact` read the
  // row once to authorize it, and the store re-reads it inside the write to
  // check it is still current). A second edit or delete that lands between
  // those two reads throws one of these two bare messages, and without this
  // entry it fell through to the opaque 500 below instead of the 400 that
  // lets the UI roll back its optimistic change and show a toast for what is
  // an ordinary lost-update race, not a server failure.
  "Current thought not found",
  "Current fact not found",
]);

/**
 * The response for a failure raised inside `withPrincipal` or
 * `withPrincipalRead`.
 *
 * `IdentityError` covers every denial the identity, sources and family
 * surfaces raise (`errorThrower` in `identity/errors.ts` builds all of them
 * from the same class), so one mapping serves every route in this directory.
 * `error.message` is always the human-facing text -- `errorThrower` sets
 * `data.message` to the same string it sets `message` to, and the bare
 * `notAuthenticated()`/`spaceNotFound()` throws carry no `data` at all -- so
 * the body's `error` field is always that text, never the machine `code`,
 * which travels alongside it instead.
 *
 * "Not authenticated" is the one case a caller must be able to tell apart
 * from every other denial: the client redirects to sign-in on a 401 and
 * shows every other code as a form error. The identity surface's own
 * `notAuthenticated()` always uses that exact message with no `data`; the
 * family surface's `not_authenticated` (`familyError("not_authenticated")`)
 * is the same fact spelled with its own copy and a `code`, so it is matched
 * by code and given the same 401, not the 400 every other family denial gets.
 *
 * `ProofError` is the other error class the ported services raise --
 * `assertKithId` and its callers, for a malformed id in a URL segment or a
 * request body -- and was missing here entirely: a malformed id used to reach
 * the opaque 500 branch below and log a stack for what is ordinary bad input.
 */
export function mutationFailure(error: unknown): Response {
  if (error instanceof IdentityError) {
    if (error.message === "Not authenticated" || error.data?.code === "not_authenticated") {
      return problem(401, error.message, error.data?.code ?? "not_authenticated");
    }
    return problem(400, error.message, error.data?.code);
  }
  if (error instanceof ProofError) {
    return problem(400, error.message, error.code);
  }
  if (error instanceof Error && VALIDATION_MESSAGES.has(error.message)) {
    return problem(400, error.message);
  }
  console.error("kith mutation route failed", error);
  return problem(500, "Server error");
}
