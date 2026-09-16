// The consent endpoint: the authorize page posts the user's choices here.
//
// Section 1.1 repoints this route from `convexAuthNextjsToken` plus the three
// `models/oauth/web` mutations onto the i1 web session plus
// `identity.{begin,finalize,abandon}AuthorizationGrant`. The flow is unchanged
// and so is every refusal; only where the session and the grant live moves.
//
// Two decisions worth stating, because both could reasonably have gone the other
// way:
//
//   * The session is resolved inside the same transaction as
//     `beginAuthorizationGrant`, not before it. `requireWebPrincipal` is the only
//     path from a cookie to authority, section 7 requires it to run in the
//     route's own transaction rather than on the strength of the middleware, and
//     resolving it in a separate transaction would let a sign-out that commits
//     between the two produce a grant for a session that no longer exists.
//   * Begin and finalize stay two transactions, as they are two mutations under
//     `convex`, with `abandonAuthorizationGrant` as the compensation. One
//     transaction would be simpler and would make the compensation unnecessary,
//     but the point of a dark deploy is that the two surfaces can be compared:
//     a `preparing` key that survives a failed finalize is observable state, and
//     it must appear in both modes or in neither.

import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { withKithTransaction } from "@repo/kith-store";
import {
  abandonAuthorizationGrant,
  beginAuthorizationGrant,
  type BeginResult,
  type Capability,
  finalizeAuthorizationGrant,
  type IdentityCtx,
  identityCtx,
  IdentityError,
  type Principal,
  requireWebPrincipal,
} from "@repo/kith-store/identity";
import { ConvexHttpClient } from "convex/browser";

import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";
import { kithPostgresSurface } from "@/lib/kith/surface";
import { getMcpResourceUri, isMcpResourceUri } from "@/lib/mcp/environment";
import {
  assertOAuthEncryptionConfigured,
  decryptClientRegistration,
  encryptAuthCode,
  hashAuthorizationCode,
  hashOAuthBinding,
  hasTrustedOAuthOrigin,
  OAUTH_NO_STORE_HEADERS,
  readLimitedOAuthBody,
} from "@/lib/mcp/oauth";
import { authorizationConsentSchema } from "@/lib/mcp/oauth-validation";

export const runtime = "nodejs";

function errorResponse(message: string, status: number) {
  return Response.json(
    { error: message },
    { status, headers: OAUTH_NO_STORE_HEADERS },
  );
}

/**
 * The typed code on a failure, from either backend.
 *
 * A `ConvexError` carries `{ data: { code } }` and an `IdentityError` carries the
 * same payload under the same name, which is why the port kept the shape. One
 * reader serves both, so the response mapping below cannot drift between the two
 * surfaces.
 */
function typedErrorCode(error: unknown): string | undefined {
  if (error instanceof IdentityError) return error.data?.code;
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return undefined;
  }
  const data = error.data;
  return typeof data === "object" && data !== null && "code" in data
    ? String(data.code)
    : undefined;
}

function oauthMutationErrorResponse(error: unknown): Response | undefined {
  // The bare "Not authenticated" both surfaces throw for a session that is gone,
  // which carries no typed code by design.
  if (error instanceof IdentityError && error.data === undefined) {
    return error.message === "Not authenticated"
      ? errorResponse("Not authenticated", 401)
      : undefined;
  }
  switch (typedErrorCode(error)) {
    case "not_authenticated":
      return errorResponse("Not authenticated", 401);
    case "invalid_input":
      return errorResponse("Invalid authorization request", 400);
    case "authorization_revoked":
      return errorResponse("Selected access is no longer available", 403);
    case "grant_not_found":
    case "grant_expired":
    case "grant_consumed":
      return errorResponse("Start a fresh authorization request", 409);
    case "grant_preparing":
      return errorResponse("Authorization is still being prepared", 409);
    case "grant_limit_reached":
      return errorResponse("Too many authorizations are pending", 429);
    default:
      return undefined;
  }
}

/** What the two surfaces agree to return from consent. */
type Grant =
  | {
      status: "issued";
      keyId: string;
      userId: string;
      rawKey: string;
      requestHash: string;
      bindingSeedHash: string;
      preparationNonce: string;
      grantExpiresAt: number;
    }
  | { status: "pending"; encryptedCode: string }
  | { status: "preparing"; retryAfterMs: number }
  | { status: "consumed" };

type ConsentRequest = {
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  scope: "open-brain";
  state?: string;
  name: string;
  capabilities: readonly Capability[];
  spaceIds: readonly string[];
};

type FinalizeArgs = {
  keyId: string;
  requestHash: string;
  preparationNonce: string;
  encryptedCode: string;
  codeHash: string;
  bindingHash: string;
  grantExpiresAt: number;
};

type AbandonArgs = {
  keyId: string;
  requestHash: string;
  preparationNonce: string;
};

/**
 * The three grant calls for one surface.
 *
 * The seam is here rather than three `if`s in the handler so that the order of
 * the calls, the compensation and every response code are written once and are
 * identical in both modes.
 */
type GrantBackend = {
  begin(consent: ConsentRequest): Promise<Grant>;
  finalize(args: FinalizeArgs): Promise<void>;
  abandon(args: AbandonArgs): Promise<void>;
};

function postgresGrantBackend(cookieHeader: string | null): GrantBackend {
  const config = kithSessionConfig();
  /** The session, resolved in the caller's transaction and nowhere else. */
  const principal = (ctx: IdentityCtx): Promise<Principal> =>
    requireWebPrincipal(ctx, { config, cookieHeader });

  return {
    begin: (consent) =>
      withKithTransaction(kithPool(), async (client) => {
        const ctx = identityCtx(client);
        const result: BeginResult = await beginAuthorizationGrant(ctx, {
          ...consent,
          principal: await principal(ctx),
        });
        return result.status === "pending"
          ? { status: "pending", encryptedCode: result.encryptedCode }
          : result;
      }),
    finalize: (args) =>
      withKithTransaction(kithPool(), async (client) => {
        const ctx = identityCtx(client);
        await finalizeAuthorizationGrant(ctx, {
          ...args,
          principal: await principal(ctx),
        });
      }),
    abandon: (args) =>
      withKithTransaction(kithPool(), async (client) => {
        const ctx = identityCtx(client);
        await abandonAuthorizationGrant(ctx, {
          ...args,
          principal: await principal(ctx),
        });
      }),
  };
}

/** The Convex surface, unchanged. i7 deletes it. */
async function convexGrantBackend(): Promise<GrantBackend | Response> {
  const token = await convexAuthNextjsToken();
  if (!token) return errorResponse("Not authenticated", 401);

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return errorResponse("Authorization service is not configured", 500);
  }
  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(token);

  return {
    begin: async (consent) =>
      (await convex.mutation(api.models.oauth.web.beginAuthorizationGrant, {
        clientId: consent.clientId,
        redirectUri: consent.redirectUri,
        resource: consent.resource,
        codeChallenge: consent.codeChallenge,
        scope: consent.scope,
        ...(consent.state === undefined ? {} : { state: consent.state }),
        name: consent.name,
        capabilities: consent.capabilities as ("read" | "write" | "ingest")[],
        spaceIds: consent.spaceIds as Id<"spaces">[],
      })) as Grant,
    finalize: async (args) => {
      await convex.mutation(api.models.oauth.web.finalizeAuthorizationGrant, {
        ...args,
        keyId: args.keyId as Id<"apiKeys">,
      });
    },
    abandon: async (args) => {
      await convex.mutation(api.models.oauth.web.abandonAuthorizationGrant, {
        ...args,
        keyId: args.keyId as Id<"apiKeys">,
      });
    },
  };
}

export async function POST(req: Request) {
  if (!hasTrustedOAuthOrigin(req)) {
    return errorResponse("Invalid request origin", 403);
  }
  if (
    !req.headers.get("content-type")?.toLowerCase().includes("application/json")
  ) {
    return errorResponse("Content-Type must be application/json", 415);
  }

  let input: unknown;
  try {
    assertOAuthEncryptionConfigured();
    input = JSON.parse(await readLimitedOAuthBody(req)) as unknown;
  } catch {
    return errorResponse("Invalid authorization request", 400);
  }

  const parsed = authorizationConsentSchema.safeParse(input);
  if (!parsed.success) {
    return errorResponse("Invalid authorization request", 400);
  }

  const request = parsed.data;
  if (request.resource !== undefined && !isMcpResourceUri(request.resource)) {
    return errorResponse("Invalid MCP resource", 400);
  }
  // Store the canonical form, not the caller's spelling. `isMcpResourceUri`
  // accepts origin-case variants, so persisting the raw value would make the
  // token endpoint's equality check fail for a client that sends the resource
  // at authorize and omits it at token exchange.
  const resource = getMcpResourceUri();
  const registration = decryptClientRegistration(request.clientId);
  if (
    !registration ||
    !registration.redirectUris.includes(request.redirectUri)
  ) {
    return errorResponse("Client or redirect URI is not registered", 400);
  }

  let backend: GrantBackend;
  try {
    if (kithPostgresSurface() === "postgres") {
      backend = postgresGrantBackend(req.headers.get("cookie"));
    } else {
      const resolved = await convexGrantBackend();
      if (resolved instanceof Response) return resolved;
      backend = resolved;
    }
  } catch {
    return errorResponse("Authorization service is not configured", 500);
  }

  const consent: ConsentRequest = {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    resource,
    codeChallenge: request.codeChallenge,
    scope: request.scope ?? "open-brain",
    ...(request.state === undefined ? {} : { state: request.state }),
    name: `MCP (${registration.clientName})`,
    capabilities: request.capabilities,
    spaceIds: request.spaceIds,
  };

  let grant: Grant;
  try {
    grant = await backend.begin(consent);
  } catch (error) {
    return (
      oauthMutationErrorResponse(error) ??
      errorResponse("Failed to create API key", 500)
    );
  }

  if (grant.status === "consumed") {
    return errorResponse("Start a fresh authorization request", 409);
  }
  if (grant.status === "preparing") {
    return Response.json(
      { error: "Authorization is still being prepared" },
      {
        status: 409,
        headers: {
          ...OAUTH_NO_STORE_HEADERS,
          "Retry-After": String(
            Math.max(1, Math.ceil(grant.retryAfterMs / 1000)),
          ),
        },
      },
    );
  }

  const redirectWithCode = (code: string) => {
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code);
    if (request.state) redirect.searchParams.set("state", request.state);
    return Response.json(
      { redirect_url: redirect.toString() },
      { headers: OAUTH_NO_STORE_HEADERS },
    );
  };
  if (grant.status === "pending") {
    return redirectWithCode(grant.encryptedCode);
  }

  try {
    const code = encryptAuthCode({
      apiKey: grant.rawKey,
      apiKeyId: grant.keyId,
      userId: grant.userId,
      requestHash: grant.requestHash,
      bindingSeedHash: grant.bindingSeedHash,
      clientId: request.clientId,
      codeChallenge: request.codeChallenge,
      redirectUri: request.redirectUri,
      resource,
      scope: request.scope ?? "open-brain",
      exp: grant.grantExpiresAt,
    });
    const codeHash = hashAuthorizationCode(code);
    const bindingHash = hashOAuthBinding(grant.bindingSeedHash, codeHash);
    await backend.finalize({
      keyId: grant.keyId,
      requestHash: grant.requestHash,
      preparationNonce: grant.preparationNonce,
      encryptedCode: code,
      codeHash,
      bindingHash,
      grantExpiresAt: grant.grantExpiresAt,
    });
    return redirectWithCode(code);
  } catch (error) {
    try {
      await backend.abandon({
        keyId: grant.keyId,
        requestHash: grant.requestHash,
        preparationNonce: grant.preparationNonce,
      });
    } catch {
      // One bounded compensation attempt avoids hiding the original failure.
    }
    return (
      oauthMutationErrorResponse(error) ??
      errorResponse("Failed to complete authorization", 500)
    );
  }
}
