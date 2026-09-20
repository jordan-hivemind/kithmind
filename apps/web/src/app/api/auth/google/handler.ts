import { withKithTransaction } from "@repo/kith-store";
import {
  identityCtx,
  IdentityError,
  requireWebSession,
} from "@repo/kith-store/identity";

import {
  createGoogleOAuthTransaction,
  googleAuthorizationUrl,
  type GoogleOAuthAction,
  googleOAuthConfig,
  googleOAuthCookie,
  GoogleOAuthError,
} from "@/lib/kith/google-oauth";
import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

type Environment = Readonly<Record<string, string | undefined>>;

function problem(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
  });
}

export async function handleGoogleOAuthStart(
  request: Request,
  options: { env?: Environment; now?: number } = {},
): Promise<Response> {
  const env = options.env ?? process.env;
  try {
    const url = new URL(request.url);
    const requestedAction = url.searchParams.get("action");
    if (requestedAction !== null && requestedAction !== "link") {
      return problem(400, "Invalid request");
    }
    const action: GoogleOAuthAction =
      requestedAction === "link" ? "link" : "sign-in";
    const oauth = googleOAuthConfig(request.url, env);
    const sessionConfig = kithSessionConfig(env);

    const link =
      action === "link"
        ? await withKithTransaction(kithPool(), async (client) => {
            const { principal, session } = await requireWebSession(
              identityCtx(client),
              {
                config: sessionConfig,
                cookieHeader: request.headers.get("cookie"),
                touch: true,
              },
            );
            return { sessionId: session.id, userId: principal.userId };
          })
        : null;
    const { transaction, challenge } = createGoogleOAuthTransaction(
      action,
      link,
      options.now,
    );
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: googleAuthorizationUrl(oauth, transaction, challenge),
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": googleOAuthCookie(sessionConfig, transaction),
      },
    });
  } catch (error) {
    if (error instanceof GoogleOAuthError) return problem(404, "Not found");
    // Missing/invalid session for linking deliberately does not say whether a
    // Google account or a Kith account exists.
    if (error instanceof IdentityError) {
      return problem(401, "Not authenticated");
    }
    console.error("Google OAuth start failed", error);
    return problem(500, "Server error");
  }
}
