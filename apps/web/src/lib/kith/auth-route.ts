// What the four `app/api/auth/` routes share: the body, the responses, and the
// rule about which failures are allowed to be distinguishable.
//
// Section 2.2 of the web and MCP surface plan: all four are `POST`, all four run
// in one `withKithTransaction`, and `signIn` and `signUp` "both return one
// message, `Invalid credentials`, for an unknown account and a wrong password.
// The routes must not widen that."
//
// So the mapping below is deliberately narrow. `Invalid email` and
// `Invalid password` are returned as themselves with a 400, because the library
// raises both from pure input validation before it reads any row -- neither can
// carry a fact about whether an account exists. Every other `IdentityError`
// becomes one 401 and one message. Anything that is not an `IdentityError` is a
// 500 whose body says nothing: a `pg` error message can contain the connection
// string, the host or a column value, and none of that may reach a client or a
// response body that ends up in a log.

import { IdentityError } from "@repo/kith-store/identity";

/** The one message both an unknown account and a wrong password produce. */
export const INVALID_CREDENTIALS = "Invalid credentials";

/** Library messages that are input validation and carry no account fact. */
const VALIDATION_MESSAGES = new Set(["Invalid email", "Invalid password"]);

export type Credentials = {
  email: string;
  password: string;
  name?: string;
};

/** 204 with no body, plus whatever cookie the route is setting. */
export function noContent(setCookie?: string): Response {
  const headers = new Headers({
    // An authentication response must never be stored by a shared cache, and
    // `Set-Cookie` on a cached response is how one browser gets another's
    // session.
    "Cache-Control": "no-store",
  });
  if (setCookie !== undefined) headers.set("Set-Cookie", setCookie);
  return new Response(null, { status: 204, headers });
}

/** 429 with the message and the wait, and nothing about which limit refused. */
export function tooManyAttempts(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Too many attempts" },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

/**
 * 503 with no detail, for the durable rate limiter's own failure -- the
 * database is unreachable, or the limiter's transaction otherwise failed,
 * before the credential check ever ran. This is section 8 question 2's fail-closed rule: a limiter that cannot
 * be consulted must refuse the attempt, never wave it through as though it
 * had been allowed. Distinct from `problem(500, "Server error")`, which is an
 * unexpected failure *inside* the credential transaction: the caller must not
 * be able to learn which of the two happened, so both bodies are equally
 * empty, but a limiter failure is reported as 503 (the service, not this
 * request, is the problem) rather than 500.
 */
export function limiterUnavailable(): Response {
  return Response.json(
    { error: "Service unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export function problem(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * The JSON body, or null when it is not an object.
 *
 * Only `application/json` is accepted. A browser form post would be
 * `application/x-www-form-urlencoded` and is refused rather than supported,
 * because a plain form post is also what a cross-site form can send without
 * reading the response; requiring a content type the browser only sends from
 * script keeps `SameSite=Lax` from being the only thing between a cross-site
 * page and a sign-in attempt.
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

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The email and password out of a body.
 *
 * Neither is validated here beyond its type. The library owns the rules, and a
 * second copy of them at the route is a second place for them to disagree.
 */
export function readCredentials(
  body: Record<string, unknown>,
): Credentials | null {
  const email = text(body.email);
  const password = text(body.password);
  if (email === undefined || password === undefined) return null;
  const name = text(body.name);
  return name === undefined ? { email, password } : { email, password, name };
}

/**
 * The response for a failure from the identity surface.
 *
 * `logged` is what goes to the server log; the response body carries only what
 * this function chooses.
 */
export function authFailure(error: unknown): Response {
  if (error instanceof IdentityError) {
    if (VALIDATION_MESSAGES.has(error.message)) {
      return problem(400, error.message);
    }
    return problem(401, INVALID_CREDENTIALS);
  }
  // Not a modelled failure: log it where the operator can see it and tell the
  // client nothing. `console.error` here is the server log, not the response.
  console.error("kith auth route failed", error);
  return problem(500, "Server error");
}
