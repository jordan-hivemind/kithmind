import { type NextRequest, NextResponse } from "next/server";

import {
  readKithSessionCookie,
  verifyKithSessionCookie,
} from "@/lib/kith/cookie";
import { usesLocalSessionCookie } from "@/lib/kith/session";
import { shouldRewriteMcpRootRequest } from "@/lib/mcp/root-alias";

/**
 * The route matcher, in place of `@convex-dev/auth`'s, which i7b removed.
 *
 * It answers the same for every pattern this file uses. A pattern ending in
 * `(.*)` is a prefix and anything else is that exact path, with an optional
 * trailing slash and case-insensitively, which is what `path-to-regexp` did for
 * these eight patterns. Widening it would make a gated route public, so the
 * shapes it accepts are deliberately only the ones below.
 */
function createRouteMatcher(patterns: readonly string[]) {
  const prefixes = patterns
    .filter((pattern) => pattern.endsWith("(.*)"))
    .map((pattern) => pattern.slice(0, -"(.*)".length).toLowerCase());
  const exact = new Set(
    patterns
      .filter((pattern) => !pattern.endsWith("(.*)"))
      .flatMap((pattern) => [
        pattern.toLowerCase(),
        `${pattern.toLowerCase()}/`,
      ]),
  );
  return (request: NextRequest) => {
    const pathname = request.nextUrl.pathname.toLowerCase();
    return (
      exact.has(pathname) ||
      prefixes.some((prefix) => pathname.startsWith(prefix))
    );
  };
}

/** `nextjsMiddlewareRedirect`, which took the path and dropped the query. */
function redirectTo(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return NextResponse.redirect(url);
}

const isSignInPage = createRouteMatcher(["/sign-in", "/sign-up"]);
export const isPublicRoute = createRouteMatcher([
  "/sign-in",
  "/sign-up",
  "/api/ingest",
  "/api/worker",
  "/invite",
  "/api/mcp(.*)",
  // The four session routes. They authenticate their own callers -- three of
  // them are how a caller becomes authenticated at all -- so an authentication
  // gate in front of them would make sign-in unreachable.
  "/api/auth(.*)",
  "/mcp/authorize",
]);

/**
 * The middleware's own view of who is asking.
 *
 * The session cookie's MAC, checked with no database behind it, because Next.js
 * middleware runs on the edge runtime and `pg` does not.
 *
 * A valid MAC over an unknown, expired or revoked token passes here and is
 * refused by the page or route, which does call `requireWebPrincipal` inside its
 * own transaction. Section 2.3 calls that the correct split, and it is worth
 * restating as a rule rather than a fact: the middleware is a cheap forgery
 * filter, not the authorization boundary, and nothing downstream may treat a
 * request that reached it as authenticated.
 */
async function isAuthenticated(
  request: NextRequest,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const secret = env.KITH_SESSION_SECRET;
  // No secret means no cookie can be verified, so nothing is authenticated.
  // Failing closed here is the only safe direction: the alternative is a
  // deployment that forgot to configure the key letting every request through.
  if (typeof secret !== "string") return false;
  const token = await verifyKithSessionCookie(
    secret,
    readKithSessionCookie(
      request.headers.get("cookie"),
      usesLocalSessionCookie(env),
    ),
  );
  return token !== null;
}

export async function handleMiddlewareRequest(
  request: NextRequest,
  {
    env = process.env,
  }: {
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
) {
  if (
    shouldRewriteMcpRootRequest(
      request.nextUrl.pathname,
      request.method,
      request.headers.get("content-type"),
      request.headers.get("authorization"),
    )
  ) {
    const target = request.nextUrl.clone();
    target.pathname = "/api/mcp";
    return NextResponse.rewrite(target);
  }

  if (isSignInPage(request) && (await isAuthenticated(request, env))) {
    return redirectTo(request, "/");
  }
  if (!isPublicRoute(request) && !(await isAuthenticated(request, env))) {
    // An API path (today only the non-public `/api/kith/*` routes) answers
    // JSON, never a redirect. The second-model review of P2-39i5 found that a
    // redirect here means `fetch` follows it to `/sign-in`'s 200 HTML, which a
    // caller that only checks `response.ok` reads as success; the four
    // `app/api/auth/*` routes already answer JSON on every failure for the
    // same reason, and this puts every other API route under the same rule
    // rather than leaving it to whichever route remembers to opt in.
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Not authenticated", code: "not_authenticated" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return redirectTo(request, "/sign-in");
  }
}

export default function middleware(request: NextRequest) {
  return handleMiddlewareRequest(request);
}

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)"],
};
