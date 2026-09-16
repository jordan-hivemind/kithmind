import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import { type NextRequest, NextResponse } from "next/server";

import {
  readKithSessionCookie,
  verifyKithSessionCookie,
} from "@/lib/kith/cookie";
import { kithPostgresSurface } from "@/lib/kith/surface";
import { shouldRewriteMcpRootRequest } from "@/lib/mcp/root-alias";

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

type MiddlewareAuth = {
  isAuthenticated(): Promise<boolean>;
};

/**
 * The middleware's own view of who is asking.
 *
 * Under `KITH_POSTGRES_SURFACE=convex` this is `convexAuth.isAuthenticated()`
 * and nothing changes. Under `postgres` it is the session cookie's MAC, checked
 * with no database behind it, because Next.js middleware runs on the edge
 * runtime and `pg` does not.
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
  convexAuth: MiddlewareAuth,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  if (kithPostgresSurface(env) !== "postgres") {
    return await convexAuth.isAuthenticated();
  }
  const secret = env.KITH_SESSION_SECRET;
  // No secret means no cookie can be verified, so nothing is authenticated.
  // Failing closed here is the only safe direction: the alternative is a
  // deployment that forgot to configure the key letting every request through.
  if (typeof secret !== "string") return false;
  const token = await verifyKithSessionCookie(
    secret,
    readKithSessionCookie(request.headers.get("cookie")),
  );
  return token !== null;
}

export async function handleMiddlewareRequest(
  request: NextRequest,
  {
    convexAuth,
    env = process.env,
  }: {
    convexAuth: MiddlewareAuth;
    env?: Readonly<Record<string, string | undefined>>;
  },
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

  if (
    isSignInPage(request) &&
    (await isAuthenticated(request, convexAuth, env))
  ) {
    return nextjsMiddlewareRedirect(request, "/");
  }
  if (
    !isPublicRoute(request) &&
    !(await isAuthenticated(request, convexAuth, env))
  ) {
    return nextjsMiddlewareRedirect(request, "/sign-in");
  }
}

export default convexAuthNextjsMiddleware(handleMiddlewareRequest);

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)"],
};
