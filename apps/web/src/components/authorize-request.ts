// The OAuth authorization request as the browser sees it, and the consent post.
//
// Both surface flows read the same query string and both post to the same route,
// so the parameter check and the redirect check live here once. Neither is the
// authoritative check: `/api/mcp/authorize/complete` validates the client, the
// redirect URI, the resource and the PKCE challenge again on the server, and the
// registration is decrypted there rather than trusted from here. What this file
// does is refuse to show a consent screen for a request the server would reject
// anyway, and refuse to follow a redirect the client did not register.

export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
  resource?: string;
  scope?: string;
  state: string;
  /** The host shown to the user, so consent names where they are going. */
  redirectDestination: string;
};

/** The request, or null when the client did not send a usable one. */
export function readAuthorizeRequest(
  searchParams: URLSearchParams,
): AuthorizeRequest | null {
  const clientId = searchParams.get("client_id") || "";
  const redirectUri = searchParams.get("redirect_uri") || "";
  const codeChallenge = searchParams.get("code_challenge") || "";
  const codeChallengeMethod = searchParams.get("code_challenge_method") || "";
  const responseType = searchParams.get("response_type") || "";
  const resource = searchParams.get("resource") || undefined;
  const scope = searchParams.get("scope") || undefined;
  const state = searchParams.get("state") || "";

  let redirectDestination = "";
  try {
    redirectDestination = new URL(redirectUri).host;
  } catch {
    // The server performs the authoritative redirect URI validation.
  }

  if (
    !clientId ||
    !redirectUri ||
    !codeChallenge ||
    codeChallengeMethod !== "S256" ||
    responseType !== "code" ||
    !redirectDestination ||
    (scope !== undefined && scope !== "open-brain")
  ) {
    return null;
  }

  return {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    responseType,
    resource,
    scope,
    state,
    redirectDestination,
  };
}

/**
 * Posts the consent decision and returns the URL to send the browser to.
 *
 * The returned redirect is checked against the registered one before it is used,
 * so a compromised response cannot turn consent into an open redirect. The code
 * is in the query string of that URL, which is why the check is on origin and
 * path rather than on the whole string.
 */
export async function submitConsent(
  request: AuthorizeRequest,
  grant: { spaceIds: readonly string[]; capabilities: readonly string[] },
): Promise<string> {
  const response = await fetch("/api/mcp/authorize/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      responseType: request.responseType,
      resource: request.resource,
      scope: request.scope,
      state: request.state || undefined,
      spaceIds: grant.spaceIds,
      capabilities: grant.capabilities,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Authorization failed");
  }

  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("redirect_url" in body) ||
    typeof body.redirect_url !== "string"
  ) {
    throw new Error("Authorization returned an invalid redirect");
  }

  const redirect = new URL(body.redirect_url);
  const registered = new URL(request.redirectUri);
  if (
    redirect.origin !== registered.origin ||
    redirect.pathname !== registered.pathname
  ) {
    throw new Error("Authorization returned an invalid redirect");
  }
  return redirect.toString();
}
