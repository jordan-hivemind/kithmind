import { ConvexError } from "convex/values";
import { requireWebPrincipal } from "../../lib/webAuth";

const messages = {
  not_authenticated: "Sign in to authorize an MCP client.",
  invalid_input: "The OAuth authorization request is invalid.",
  grant_not_found: "The OAuth authorization grant is no longer available.",
  grant_expired: "The OAuth authorization grant has expired.",
  grant_preparing: "The OAuth authorization grant is still being prepared.",
  grant_consumed:
    "Start a fresh authorization request to reconnect this client.",
  grant_limit_reached: "Too many OAuth authorization grants are pending.",
  authorization_revoked: "The selected access is no longer available.",
} as const;

export type OAuthErrorCode = keyof typeof messages;

export function oauthError(code: OAuthErrorCode): never {
  throw new ConvexError({ code, message: messages[code] });
}

export async function requireOAuthWebPrincipal(
  ctx: Parameters<typeof requireWebPrincipal>[0],
) {
  try {
    return await requireWebPrincipal(ctx);
  } catch {
    oauthError("not_authenticated");
  }
}
