// The four session routes against a real PostgreSQL.
//
// These go through the route handlers, not through `@repo/kith-store` directly,
// because the properties section 2.4 has to answer for are properties of the
// route: that sign-in gives one message for two different failures, that
// sign-out revokes the row rather than only clearing the cookie, and that a
// password change keeps the session it was made from and ends the rest.
//
// A throwaway database per run, created and dropped here, matching the kith
// store's own convention: the suite skips cleanly when `KITH_STORE_DATABASE_URL`
// is not set, because a public clone has no Postgres, and no connection string
// is ever defaulted or committed.

import { randomBytes } from "node:crypto";

import {
  applyKithSchema,
  createKithPool,
  sha256,
  withKithTransaction,
} from "@repo/kith-store";
import {
  identityCtx,
  IdentityError,
  parseSessionToken,
  readSessionCookie,
  requireWebPrincipal,
  resolveSessionToken,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const secret = randomBytes(32).toString("hex");
const config = { secret, secure: false };
const PASSWORD = "a strong enough password";

type Routes = {
  signIn: (request: Request) => Promise<Response>;
  signUp: (request: Request) => Promise<Response>;
  signOut: (request: Request) => Promise<Response>;
  changePassword: (request: Request) => Promise<Response>;
  googleStart: (
    request: Request,
    options?: {
      env?: Readonly<Record<string, string | undefined>>;
      now?: number;
    },
  ) => Promise<Response>;
  googleCallback: (
    request: Request,
    dependencies?: {
      env?: Readonly<Record<string, string | undefined>>;
      now?: number;
      exchangeCode?: () => Promise<string>;
      verifyIdToken?: () => Promise<{
        subject: string;
        verifiedEmail: string;
      }>;
    },
  ) => Promise<Response>;
};

/** A distinct email per case, so the per-account rate limit is never the reason
 * a test fails. */
let accounts = 0;
function email(): string {
  accounts += 1;
  return `owner-${accounts}-${randomBytes(4).toString("hex")}@example.test`;
}

/** A distinct client address per case, for the same reason. */
let addresses = 0;
function address(): string {
  addresses += 1;
  return `10.0.0.${addresses % 250}`;
}

function post(
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  extra: { cookie?: string; address?: string } = {},
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": extra.address ?? address(),
  });
  if (extra.cookie !== undefined) headers.set("cookie", extra.cookie);
  return handler(
    new Request("https://brain.example.test/api/auth", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** The `Cookie` header a browser would send back for a `Set-Cookie`. */
function cookieHeaderFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("no Set-Cookie on the response");
  return setCookie.split(";")[0]!;
}

function namedCookie(response: Response, name: string): string {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = headers.getSetCookie?.() ?? [];
  const selected = values.find((value) => value.startsWith(`${name}=`));
  if (selected === undefined) {
    throw new Error(`no ${name} Set-Cookie on the response`);
  }
  return selected.split(";")[0]!;
}

describeWithDatabase("the kith session routes", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let routes: Routes;
  let databaseName: string;

  async function onAdmin<T>(
    work: (admin: pg.Client) => Promise<T>,
  ): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await work(admin);
    } finally {
      await admin.end();
    }
  }

  /** `requireWebPrincipal`, as a page or an authenticated route would call it. */
  async function principalFor(cookie: string): Promise<string | null> {
    try {
      return (
        await withKithTransaction(pool, (client) =>
          requireWebPrincipal(identityCtx(client), {
            config,
            cookieHeader: cookie,
          }),
        )
      ).userId;
    } catch (error) {
      if (error instanceof IdentityError) return null;
      throw error;
    }
  }

  beforeAll(async () => {
    databaseName = `kith_web_test_${randomBytes(8).toString("hex")}`;
    await onAdmin((admin) => admin.query(`CREATE DATABASE ${databaseName}`));
    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;

    const migrator = new pg.Client({ connectionString: url.toString() });
    migrator.on("error", () => {});
    await migrator.connect();
    await applyKithSchema(migrator);
    await migrator.end();

    process.env.KITH_SESSION_SECRET = secret;
    pool = createKithPool(url.toString());
    pool.on("error", () => {});
    restorePool = setKithPool(pool);

    routes = {
      signIn: (await import("./sign-in/route")).POST,
      signUp: (await import("./sign-up/route")).POST,
      signOut: (await import("./sign-out/route")).POST,
      changePassword: (await import("./change-password/route")).POST,
      googleStart: (await import("./google/handler")).handleGoogleOAuthStart,
      googleCallback: (await import("./google/callback/handler"))
        .handleGoogleOAuthCallback,
    };
  }, 60_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    delete process.env.KITH_SESSION_SECRET;
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  test("sign-up issues a session cookie the server accepts", async () => {
    const account = email();
    const response = await post(routes.signUp, {
      email: account,
      password: PASSWORD,
      name: "Owner",
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("kith_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).toContain("Path=/");

    const cookie = cookieHeaderFrom(response);
    const userId = await principalFor(cookie);
    expect(userId).not.toBeNull();

    // And the personal space records exist, in the same transaction as the user.
    const settings = await pool.query(
      `SELECT s.kind FROM kith.user_space_settings u
         JOIN kith.spaces s ON s.id = u.personal_space_id
        WHERE u.user_id = $1`,
      [userId],
    );
    expect(settings.rows).toEqual([{ kind: "personal" }]);
  });

  test("sign-in gives one message for an unknown account and a wrong password", async () => {
    const account = email();
    expect(
      (await post(routes.signUp, { email: account, password: PASSWORD }))
        .status,
    ).toBe(204);

    const wrongPassword = await post(routes.signIn, {
      email: account,
      password: `${PASSWORD} but wrong`,
    });
    const unknownAccount = await post(routes.signIn, {
      email: email(),
      password: PASSWORD,
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(await wrongPassword.json()).toEqual({
      error: "Invalid credentials",
    });
    expect(await unknownAccount.json()).toEqual({
      error: "Invalid credentials",
    });
    // Neither response carries a cookie, so a failed attempt cannot be told
    // from a successful one by its headers either.
    expect(wrongPassword.headers.get("set-cookie")).toBeNull();
    expect(unknownAccount.headers.get("set-cookie")).toBeNull();

    // Signing up over an existing account gives the same words, so sign-up is
    // not the account-existence oracle sign-in refuses to be.
    const existing = await post(routes.signUp, {
      email: account,
      password: PASSWORD,
    });
    expect(existing.status).toBe(401);
    expect(await existing.json()).toEqual({ error: "Invalid credentials" });

    // The correct password still works, so the three refusals above are about
    // the credentials and not about the route being broken.
    const correct = await post(routes.signIn, {
      email: account,
      password: PASSWORD,
    });
    expect(correct.status).toBe(204);
  });

  test("explicitly links Google, keeps memberships, and signs in by subject", async () => {
    const googleEnv = {
      NODE_ENV: "test",
      KITH_SESSION_SECRET: secret,
      GOOGLE_OAUTH_CLIENT_ID: "synthetic-client.apps.example.test",
      GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
      GOOGLE_OAUTH_ORIGIN: "https://brain.example.test",
    } as const;
    const passwordCookie = cookieHeaderFrom(
      await post(routes.signUp, { email: email(), password: PASSWORD }),
    );
    const userId = await principalFor(passwordCookie);
    expect(userId).not.toBeNull();
    const membershipsBefore = await pool.query(
      "SELECT space_id, role FROM kith.space_members WHERE user_id = $1 ORDER BY space_id",
      [userId],
    );

    const linkStart = await routes.googleStart(
      new Request("https://brain.example.test/api/auth/google?action=link", {
        headers: { cookie: passwordCookie },
      }),
      { env: googleEnv },
    );
    expect(linkStart.status).toBe(302);
    const authorize = new URL(linkStart.headers.get("location")!);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("nonce")).toBeTruthy();
    const oauthCookie = namedCookie(linkStart, "kith_google_oauth");
    const state = authorize.searchParams.get("state")!;

    const linked = await routes.googleCallback(
      new Request(
        `https://brain.example.test/api/auth/google/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${passwordCookie}; ${oauthCookie}` } },
      ),
      {
        env: googleEnv,
        exchangeCode: async () => "synthetic-id-token",
        verifyIdToken: async () => ({
          subject: "google-owner-subject",
          // The existing Kith session is linking authority. A verified Google
          // address does not have to equal the password provider address.
          verifiedEmail: "chosen-google-account@example.test",
        }),
      },
    );
    expect(linked.status).toBe(302);
    expect(linked.headers.get("location")).toBe(
      "https://brain.example.test/settings?google=linked#account",
    );
    const membershipsAfter = await pool.query(
      "SELECT space_id, role FROM kith.space_members WHERE user_id = $1 ORDER BY space_id",
      [userId],
    );
    expect(membershipsAfter.rows).toEqual(membershipsBefore.rows);

    const signInStart = await routes.googleStart(
      new Request("https://brain.example.test/api/auth/google"),
      { env: googleEnv },
    );
    const signInAuthorize = new URL(signInStart.headers.get("location")!);
    const signedIn = await routes.googleCallback(
      new Request(
        `https://brain.example.test/api/auth/google/callback?code=synthetic-code&state=${encodeURIComponent(signInAuthorize.searchParams.get("state")!)}`,
        {
          headers: {
            cookie: namedCookie(signInStart, "kith_google_oauth"),
          },
        },
      ),
      {
        env: googleEnv,
        exchangeCode: async () => "synthetic-id-token",
        verifyIdToken: async () => ({
          subject: "google-owner-subject",
          verifiedEmail: "renamed-google-account@example.test",
        }),
      },
    );
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe(
      "https://brain.example.test/",
    );
    expect(await principalFor(namedCookie(signedIn, "kith_session"))).toBe(
      userId,
    );
  });

  test("Google callback refuses bad state, bad token, and a changed linking session", async () => {
    const googleEnv = {
      NODE_ENV: "test",
      KITH_SESSION_SECRET: secret,
      GOOGLE_OAUTH_CLIENT_ID: "synthetic-client.apps.example.test",
      GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
      GOOGLE_OAUTH_ORIGIN: "https://brain.example.test",
    } as const;
    const firstCookie = cookieHeaderFrom(
      await post(routes.signUp, { email: email(), password: PASSWORD }),
    );
    const secondCookie = cookieHeaderFrom(
      await post(routes.signUp, { email: email(), password: PASSWORD }),
    );

    const start = await routes.googleStart(
      new Request("https://brain.example.test/api/auth/google?action=link", {
        headers: { cookie: firstCookie },
      }),
      { env: googleEnv },
    );
    const authorize = new URL(start.headers.get("location")!);
    const oauthCookie = namedCookie(start, "kith_google_oauth");
    const state = authorize.searchParams.get("state")!;
    const exchangeCode = vi.fn(async () => "synthetic-id-token");

    const badState = await routes.googleCallback(
      new Request(
        "https://brain.example.test/api/auth/google/callback?code=synthetic-code&state=wrong",
        { headers: { cookie: `${firstCookie}; ${oauthCookie}` } },
      ),
      { env: googleEnv, exchangeCode },
    );
    expect(badState.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();

    const badToken = await routes.googleCallback(
      new Request(
        `https://brain.example.test/api/auth/google/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${firstCookie}; ${oauthCookie}` } },
      ),
      {
        env: googleEnv,
        exchangeCode,
        verifyIdToken: async () => {
          throw new Error("synthetic invalid token");
        },
      },
    );
    expect(badToken.status).toBe(401);

    const changedSession = await routes.googleCallback(
      new Request(
        `https://brain.example.test/api/auth/google/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${secondCookie}; ${oauthCookie}` } },
      ),
      {
        env: googleEnv,
        exchangeCode,
        verifyIdToken: async () => ({
          subject: "must-not-link",
          verifiedEmail: "verified@example.test",
        }),
      },
    );
    expect(changedSession.status).toBe(401);
    expect(
      (
        await pool.query(
          "SELECT id FROM kith.auth_accounts WHERE provider = 'google' AND provider_account_id = 'must-not-link'",
        )
      ).rows,
    ).toHaveLength(0);
  });

  test("sign-out revokes the session on the server, not just in the browser", async () => {
    const account = email();
    const opened = await post(routes.signUp, {
      email: account,
      password: PASSWORD,
    });
    const cookie = cookieHeaderFrom(opened);
    expect(await principalFor(cookie)).not.toBeNull();

    const out = await post(routes.signOut, {}, { cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");

    // The same cookie again. This is the property: a copy of the cookie that
    // never saw the clearing response is still refused, because the row is
    // revoked rather than the browser merely being told to forget it.
    expect(await principalFor(cookie)).toBeNull();
    const token = parseSessionToken(config, readSessionCookie(cookie, config));
    const row = await withKithTransaction(pool, (client) =>
      resolveSessionToken(identityCtx(client), token),
    );
    expect(row).toBeNull();
    // The row is still there and carries the moment it was revoked, which is
    // what makes logout auditable rather than a deletion.
    const stored = await pool.query(
      "SELECT revoked_at FROM kith.sessions WHERE token_hash = $1",
      [sha256(token!)],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].revoked_at).not.toBeNull();

    // Signing out again is not an error and does not report that there was
    // nothing to sign out of.
    expect((await post(routes.signOut, {}, { cookie })).status).toBe(204);
    expect((await post(routes.signOut, {})).status).toBe(204);
  });

  test("change-password keeps the current session and revokes the others", async () => {
    const account = email();
    const first = cookieHeaderFrom(
      await post(routes.signUp, { email: account, password: PASSWORD }),
    );
    const second = cookieHeaderFrom(
      await post(routes.signIn, { email: account, password: PASSWORD }),
    );
    const third = cookieHeaderFrom(
      await post(routes.signIn, { email: account, password: PASSWORD }),
    );
    expect(await principalFor(first)).not.toBeNull();
    expect(await principalFor(second)).not.toBeNull();
    expect(await principalFor(third)).not.toBeNull();

    const changed = await post(
      routes.changePassword,
      {
        email: account,
        currentPassword: PASSWORD,
        newPassword: "an entirely different password",
      },
      { cookie: second },
    );
    expect(changed.status).toBe(204);

    // The session the change was made from survives; every other one is gone.
    expect(await principalFor(second)).not.toBeNull();
    expect(await principalFor(first)).toBeNull();
    expect(await principalFor(third)).toBeNull();

    // The new password is the one that works now.
    expect(
      (await post(routes.signIn, { email: account, password: PASSWORD }))
        .status,
    ).toBe(401);
    expect(
      (
        await post(routes.signIn, {
          email: account,
          password: "an entirely different password",
        })
      ).status,
    ).toBe(204);
  });

  test("change-password refuses an unauthenticated or wrong-password caller", async () => {
    const account = email();
    const cookie = cookieHeaderFrom(
      await post(routes.signUp, { email: account, password: PASSWORD }),
    );

    // No cookie at all.
    expect(
      (
        await post(routes.changePassword, {
          email: account,
          currentPassword: PASSWORD,
          newPassword: "an entirely different password",
        })
      ).status,
    ).toBe(401);

    // Authenticated, but the current password is wrong.
    expect(
      (
        await post(
          routes.changePassword,
          {
            email: account,
            currentPassword: "not the password",
            newPassword: "an entirely different password",
          },
          { cookie },
        )
      ).status,
    ).toBe(401);

    // The original password still works, so neither refusal changed anything.
    expect(
      (await post(routes.signIn, { email: account, password: PASSWORD }))
        .status,
    ).toBe(204);
  });

  test("a malformed body or a form content type is refused before anything else", async () => {
    for (const body of [null, "a string", ["email"], {}, { email: 1 }]) {
      const response = await post(routes.signIn, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request" });
    }

    // A cross-site form post would be `application/x-www-form-urlencoded`, and
    // requiring JSON is what keeps `SameSite=Lax` from being the only defence.
    const form = await routes.signIn(
      new Request("https://brain.example.test/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=owner%40example.test&password=whatever",
      }),
    );
    expect(form.status).toBe(400);
  });

  test("input validation is reported as itself and carries no account fact", async () => {
    // Both are raised before any row is read, so neither can say whether an
    // account exists; reporting them as themselves is more useful than folding
    // them into `Invalid credentials`.
    const badEmail = await post(routes.signUp, {
      email: "not an email",
      password: PASSWORD,
    });
    expect(badEmail.status).toBe(400);
    expect(await badEmail.json()).toEqual({ error: "Invalid email" });

    const shortPassword = await post(routes.signUp, {
      email: email(),
      password: "short",
    });
    expect(shortPassword.status).toBe(400);
    expect(await shortPassword.json()).toEqual({ error: "Invalid password" });
  });
});
