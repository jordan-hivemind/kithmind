import { withKithTransaction } from "@repo/kith-store";
import {
  ensurePersonalSpace,
  identityCtx,
  IdentityError,
  linkGoogleAccount,
  requireWebSession,
  sessionCookie,
  signInOrAutoLinkGoogle,
} from "@repo/kith-store/identity";

import {
  clearedGoogleOAuthCookie,
  exchangeGoogleCode,
  type GoogleOAuthConfig,
  googleOAuthConfig,
  GoogleOAuthError,
  googleOAuthStateMatches,
  readGoogleOAuthTransaction,
  type VerifiedGoogleIdentity,
  verifyGoogleIdToken,
} from "@/lib/kith/google-oauth";
import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

type Environment = Readonly<Record<string, string | undefined>>;

export type CallbackDependencies = {
  env?: Environment;
  now?: number;
  exchangeCode?: (
    config: GoogleOAuthConfig,
    code: string,
    verifier: string,
  ) => Promise<string>;
  verifyIdToken?: (
    idToken: string,
    config: Pick<GoogleOAuthConfig, "clientId">,
    nonce: string,
  ) => Promise<VerifiedGoogleIdentity>;
};

function response(
  status: number,
  body: string | null,
  clearCookie: string,
  location?: string,
  session?: string,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  if (body !== null) headers.set("Content-Type", "text/plain");
  if (location !== undefined) headers.set("Location", location);
  headers.append("Set-Cookie", clearCookie);
  if (session !== undefined) headers.append("Set-Cookie", session);
  return new Response(body, { status, headers });
}

export async function handleGoogleOAuthCallback(
  request: Request,
  dependencies: CallbackDependencies = {},
): Promise<Response> {
  const env = dependencies.env ?? process.env;
  let oauth: GoogleOAuthConfig;
  let sessionConfig: ReturnType<typeof kithSessionConfig>;
  try {
    oauth = googleOAuthConfig(request.url, env, request.headers.get("host"));
    sessionConfig = kithSessionConfig(env);
  } catch (error) {
    const unavailable = error instanceof GoogleOAuthError;
    if (!unavailable) {
      console.error("Google OAuth callback configuration failed", error);
    }
    return new Response(unavailable ? "Not found" : "Server error", {
      status: unavailable ? 404 : 500,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
    });
  }

  const clearCookie = clearedGoogleOAuthCookie(sessionConfig);
  const url = new URL(request.url);
  const transaction = readGoogleOAuthTransaction(
    sessionConfig,
    request.headers.get("cookie"),
    dependencies.now,
  );
  if (
    transaction === null ||
    !googleOAuthStateMatches(transaction, url.searchParams.get("state"))
  ) {
    return response(400, "Invalid OAuth response", clearCookie);
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || code === null || code.length === 0) {
    return response(400, "Invalid OAuth response", clearCookie);
  }

  let identity: VerifiedGoogleIdentity;
  try {
    const idToken = await (dependencies.exchangeCode ?? exchangeGoogleCode)(
      oauth,
      code,
      transaction.verifier,
    );
    identity = await (dependencies.verifyIdToken ?? verifyGoogleIdToken)(
      idToken,
      oauth,
      transaction.nonce,
    );
  } catch {
    return response(401, "Google sign-in failed", clearCookie);
  }

  if (transaction.action === "link") {
    try {
      await withKithTransaction(kithPool(), async (client) => {
        const ctx = identityCtx(client);
        const { principal, session } = await requireWebSession(ctx, {
          config: sessionConfig,
          cookieHeader: request.headers.get("cookie"),
          touch: true,
        });
        if (
          session.id !== transaction.linkSessionId ||
          principal.userId !== transaction.linkUserId
        ) {
          throw new IdentityError("Not authenticated");
        }
        await linkGoogleAccount(ctx, {
          userId: principal.userId,
          providerAccountId: identity.subject,
          verifiedEmail: identity.verifiedEmail,
        });
      });
      return response(
        302,
        null,
        clearCookie,
        `${oauth.origin}/settings?google=linked#account`,
      );
    } catch (error) {
      if (!(error instanceof IdentityError)) {
        console.error("Google account linking failed", error);
      }
      return response(401, "Google account could not be linked", clearCookie);
    }
  }

  try {
    const opened = await withKithTransaction(kithPool(), async (client) => {
      const ctx = identityCtx(client);
      const signedIn = await signInOrAutoLinkGoogle(ctx, {
        providerAccountId: identity.subject,
        verifiedEmail: identity.verifiedEmail,
        hostedDomain: identity.hostedDomain,
        allowedHostedDomain: oauth.allowedHostedDomain,
        autoLinkUserId: oauth.autoLinkUserId,
      });
      await ensurePersonalSpace(ctx, signedIn.userId);
      return signedIn;
    });
    return response(
      302,
      null,
      clearCookie,
      `${oauth.origin}/`,
      sessionCookie(sessionConfig, opened.token, opened.expiresAt),
    );
  } catch (error) {
    if (!(error instanceof IdentityError)) {
      console.error("Google sign-in failed", error);
    }
    return response(
      302,
      null,
      clearCookie,
      `${oauth.origin}/sign-in?googleError=not-connected`,
    );
  }
}
