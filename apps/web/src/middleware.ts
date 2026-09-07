import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import { type NextRequest, NextResponse } from "next/server";

import { shouldRewriteMcpRootRequest } from "@/lib/mcp/root-alias";

const isSignInPage = createRouteMatcher(["/sign-in", "/sign-up"]);
export const isPublicRoute = createRouteMatcher([
  "/sign-in",
  "/sign-up",
  "/api/ingest",
  "/api/mcp(.*)",
  "/mcp/authorize",
]);

type MiddlewareAuth = {
  isAuthenticated(): Promise<boolean>;
};

export async function handleMiddlewareRequest(
  request: NextRequest,
  { convexAuth }: { convexAuth: MiddlewareAuth },
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

  if (isSignInPage(request) && (await convexAuth.isAuthenticated())) {
    return nextjsMiddlewareRedirect(request, "/");
  }
  if (!isPublicRoute(request) && !(await convexAuth.isAuthenticated())) {
    return nextjsMiddlewareRedirect(request, "/sign-in");
  }
}

export default convexAuthNextjsMiddleware(handleMiddlewareRequest);

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)"],
};
