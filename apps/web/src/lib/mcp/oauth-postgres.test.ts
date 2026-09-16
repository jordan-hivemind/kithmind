// The OAuth authorization-code flow on the PostgreSQL surface, end to end.
//
// Consent and exchange are two routes and one property: the key an MCP client
// ends up holding is inert until the code it was issued for is exchanged exactly
// once, and a second exchange of the same code destroys it.
//
// The whole flow runs against a real database because that is the only way the
// interesting states are reachable. A `pending` key is a row with an
// `oauth_lifecycle`; whether the gateway refuses it as a bearer is a question
// about that row and the authenticator together, and a mocked mutation cannot
// answer it.

import crypto, { randomBytes } from "node:crypto";

import {
  applyKithSchema,
  createKithPool,
  withKithTransaction,
} from "@repo/kith-store";
import {
  ensurePersonalSpace,
  identityCtx,
  sessionCookie,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { setKithPool } from "@/lib/kith/pool";

const mocks = vi.hoisted(() => ({ convexToken: vi.fn() }));
vi.mock("server-only", () => ({}));
// The complete route still imports the Convex session reader for its `convex`
// branch, and that module does not load under vitest. Mocking it lets the route
// load; asserting it is never called is what proves the PostgreSQL branch does
// not fall back to it.
vi.mock("@convex-dev/auth/nextjs/server", () => ({
  convexAuthNextjsToken: mocks.convexToken,
}));

import { authenticateApiKey } from "./auth";
import { decryptAuthCode, encryptClientRegistration } from "./oauth";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const ORIGIN = "https://brain.example.test";
const REDIRECT_URI = "https://client.example.test/callback";
const PASSWORD = "a strong enough password";
const sessionSecret = randomBytes(32).toString("hex");
const encryptionKey = Buffer.alloc(32, 5).toString("base64url");

const verifier = "v".repeat(43);
const challenge = crypto
  .createHash("sha256")
  .update(verifier, "ascii")
  .digest("base64url");

let accounts = 0;
function email(): string {
  accounts += 1;
  return `oauth-owner-${accounts}-${randomBytes(4).toString("hex")}@example.test`;
}

type Routes = {
  complete: (request: Request) => Promise<Response>;
  token: (request: Request) => Promise<Response>;
};

describeWithDatabase("the OAuth flow on PostgreSQL", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let routes: Routes;
  let databaseName: string;

  async function onAdmin<T>(work: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await work(admin);
    } finally {
      await admin.end();
    }
  }

  /** A signed-in owner: the cookie a browser would send, and their space. */
  async function owner(): Promise<{
    userId: string;
    cookie: string;
    spaceId: string;
  }> {
    return await withKithTransaction(pool, async (client) => {
      const ctx = identityCtx(client);
      const session = await signUp(ctx, { email: email(), password: PASSWORD });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const setCookie = sessionCookie(
        { secret: sessionSecret, secure: false },
        session.token,
        session.expiresAt,
      );
      return {
        userId: session.userId,
        cookie: setCookie.split(";")[0]!,
        spaceId,
      };
    });
  }

  function clientId(): string {
    return encryptClientRegistration({
      clientName: "Synthetic client",
      redirectUris: [REDIRECT_URI],
      issuedAt: Date.now(),
    });
  }

  function consentRequest(
    body: Record<string, unknown>,
    cookie: string | null,
  ): Request {
    const headers = new Headers({
      "Content-Type": "application/json",
      Origin: ORIGIN,
    });
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}/api/mcp/authorize/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  function tokenRequest(
    code: string,
    registration: string,
    codeVerifier = verifier,
  ): Request {
    return new Request(`${ORIGIN}/api/mcp/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
        client_id: registration,
        resource: `${ORIGIN}/api/mcp`,
      }).toString(),
    });
  }

  /** Runs consent and returns the authorization code from the redirect. */
  async function consent(
    account: { cookie: string; spaceId: string },
    registration: string,
  ): Promise<string> {
    const response = await routes.complete(
      consentRequest(
        {
          clientId: registration,
          redirectUri: REDIRECT_URI,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          responseType: "code",
          spaceIds: [account.spaceId],
          capabilities: ["read", "write"],
        },
        account.cookie,
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { redirect_url: string };
    const code = new URL(body.redirect_url).searchParams.get("code");
    expect(code).not.toBeNull();
    return code!;
  }

  beforeAll(async () => {
    databaseName = `kith_oauth_test_${randomBytes(8).toString("hex")}`;
    await onAdmin((admin) => admin.query(`CREATE DATABASE ${databaseName}`));
    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;

    const migrator = new pg.Client({ connectionString: url.toString() });
    migrator.on("error", () => {});
    await migrator.connect();
    await applyKithSchema(migrator);
    await migrator.end();

    pool = createKithPool(url.toString());
    pool.on("error", () => {});
    restorePool = setKithPool(pool);

    routes = {
      complete: (await import("../../app/api/mcp/authorize/complete/route"))
        .POST,
      token: (await import("../../app/api/mcp/token/route")).POST,
    };
  }, 60_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("KITH_POSTGRES_SURFACE", "postgres");
    vi.stubEnv("MCP_PUBLIC_ORIGIN", ORIGIN);
    vi.stubEnv("MCP_OAUTH_ENCRYPTION_KEY", encryptionKey);
    vi.stubEnv("KITH_SESSION_SECRET", sessionSecret);
  });
  afterEach(() => vi.unstubAllEnvs());

  test("consent needs the web session and issues an inert key", async () => {
    const account = await owner();
    const registration = clientId();

    const anonymous = await routes.complete(
      consentRequest(
        {
          clientId: registration,
          redirectUri: REDIRECT_URI,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          responseType: "code",
          spaceIds: [account.spaceId],
          capabilities: ["read"],
        },
        null,
      ),
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Not authenticated" });
    // Nothing was written for a caller who is not signed in.
    const none = await pool.query(
      "SELECT id FROM kith.api_keys WHERE user_id = $1",
      [account.userId],
    );
    expect(none.rows).toEqual([]);

    await consent(account, registration);

    const key = await pool.query<{ oauth_lifecycle: string | null }>(
      "SELECT oauth_lifecycle FROM kith.api_keys WHERE user_id = $1",
      [account.userId],
    );
    expect(key.rows).toEqual([{ oauth_lifecycle: "pending" }]);
  });

  test("the key inside an unexchanged code authenticates nothing", async () => {
    const account = await owner();
    const registration = clientId();
    const code = await consent(account, registration);

    // The client already holds the raw key: it is inside the authorization code.
    // That is precisely why the key has to be inert until the code is exchanged,
    // and it is the reason the exchange identity is not a credential -- there is
    // nothing to be a credential with until activation clears the lifecycle.
    const payload = decryptAuthCode(code);
    expect(payload).not.toBeNull();
    expect(await authenticateApiKey(`Bearer ${payload!.apiKey}`)).toBeNull();

    const exchanged = await routes.token(tokenRequest(code, registration));
    expect(exchanged.status).toBe(200);
    const issued = (await exchanged.json()) as { access_token: string };
    expect(issued.access_token).toBe(payload!.apiKey);

    // The same bearer, after the exchange and only after it.
    expect(await authenticateApiKey(`Bearer ${issued.access_token}`)).toEqual({
      userId: account.userId,
      keyId: payload!.apiKeyId,
    });
    // And the Convex session reader was never consulted on this surface.
    expect(mocks.convexToken).not.toHaveBeenCalled();
  });

  test("a consumed-code replay is refused and revokes the issued key", async () => {
    const account = await owner();
    const registration = clientId();
    const code = await consent(account, registration);

    const first = await routes.token(tokenRequest(code, registration));
    expect(first.status).toBe(200);
    const issued = (await first.json()) as { access_token: string };
    expect(
      await authenticateApiKey(`Bearer ${issued.access_token}`),
    ).not.toBeNull();

    const replay = await routes.token(tokenRequest(code, registration));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    // RFC 6749 section 4.1.2: a validated replay denies and revokes the token
    // the first exchange issued. The revocation has to be committed, so the key
    // it names stops authenticating rather than merely failing this request.
    expect(await authenticateApiKey(`Bearer ${issued.access_token}`)).toBeNull();
    const rows = await pool.query(
      "SELECT id FROM kith.api_keys WHERE user_id = $1",
      [account.userId],
    );
    expect(rows.rows).toEqual([]);
  });

  test("an invalid PKCE verifier leaves the grant untouched", async () => {
    const account = await owner();
    const registration = clientId();
    const code = await consent(account, registration);

    const wrong = await routes.token(tokenRequest(code, registration, "x".repeat(43)));
    expect(wrong.status).toBe(400);

    // The grant is still exchangeable: a bad proof must not consume a code, or
    // an attacker could burn a legitimate client's authorization.
    const key = await pool.query<{ oauth_lifecycle: string | null }>(
      "SELECT oauth_lifecycle FROM kith.api_keys WHERE user_id = $1",
      [account.userId],
    );
    expect(key.rows).toEqual([{ oauth_lifecycle: "pending" }]);
    expect((await routes.token(tokenRequest(code, registration))).status).toBe(200);
  });

  test("consent refuses a space the session cannot read", async () => {
    const account = await owner();
    const other = await owner();

    const response = await routes.complete(
      consentRequest(
        {
          clientId: clientId(),
          redirectUri: REDIRECT_URI,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          responseType: "code",
          spaceIds: [other.spaceId],
          capabilities: ["read"],
        },
        account.cookie,
      ),
    );
    // The exact refusal, not merely "some error". This is 500 and not 403, and
    // that is Convex parity rather than a port defect: `getAuthorizedReadSpaceIds`
    // raises the typed `space_not_found` read denial, `beginAuthorizationGrant`
    // rethrows a typed error unchanged, and neither this route's mapping nor the
    // Convex one it was copied from has a `space_not_found` case, so both fall
    // through to "Failed to create API key". Asserting the real status is what
    // keeps the two surfaces comparable while the flag decides between them;
    // mapping the read denial to 403 is a behavior change and belongs to a row
    // that can make it on both surfaces at once.
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to create API key" });
    // Either way it says nothing about whether the other space exists.
    expect(JSON.stringify(body)).not.toContain(other.spaceId);
    const created = await pool.query(
      "SELECT id FROM kith.api_keys WHERE user_id = $1",
      [account.userId],
    );
    expect(created.rows).toEqual([]);
  });
});
