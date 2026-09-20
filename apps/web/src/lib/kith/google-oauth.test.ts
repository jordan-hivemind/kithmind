import { randomBytes } from "node:crypto";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, test, vi } from "vitest";

import {
  createGoogleOAuthTransaction,
  exchangeGoogleCode,
  googleAuthorizationUrl,
  googleOAuthConfig,
  googleOAuthCookie,
  googleOAuthEnabled,
  googleOAuthStateMatches,
  readGoogleOAuthTransaction,
  verifyGoogleIdToken,
} from "./google-oauth";

const CLIENT_ID = "synthetic-client.apps.example.test";
const PRODUCTION_ENV = {
  NODE_ENV: "production",
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-secret",
  GOOGLE_OAUTH_ORIGIN: "https://brain.example.test",
  GOOGLE_OAUTH_HOSTED_DOMAIN: "staff.example.test",
  GOOGLE_OAUTH_AUTOLINK_USER_ID: "a".repeat(26),
} as const;
const secret = randomBytes(32).toString("hex");
const sessionConfig = { secret, secure: true } as const;

describe("Google OAuth request binding", () => {
  test("is absent unless its server-only configuration is complete", () => {
    expect(googleOAuthEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(
      googleOAuthEnabled({
        ...PRODUCTION_ENV,
        GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      }),
    ).toBe(false);
    expect(googleOAuthEnabled(PRODUCTION_ENV)).toBe(true);
    expect(
      googleOAuthEnabled({
        ...PRODUCTION_ENV,
        GOOGLE_OAUTH_HOSTED_DOMAIN: "Staff.example.test",
      }),
    ).toBe(false);
    expect(
      googleOAuthEnabled({
        ...PRODUCTION_ENV,
        GOOGLE_OAUTH_AUTOLINK_USER_ID: "not-a-kith-id",
      }),
    ).toBe(false);
    expect(
      googleOAuthEnabled({
        ...PRODUCTION_ENV,
        NODE_ENV: "development",
        GOOGLE_OAUTH_ORIGIN: undefined,
      }),
    ).toBe(true);
  });

  test("pins production and accepts only explicit loopback development ports", () => {
    expect(
      googleOAuthConfig(
        "https://attacker.example/api/auth/google",
        PRODUCTION_ENV,
      ),
    ).toMatchObject({
      origin: "https://brain.example.test",
      redirectUri: "https://brain.example.test/api/auth/google/callback",
      allowedHostedDomain: "staff.example.test",
      autoLinkUserId: "a".repeat(26),
    });

    for (const port of [3000, 3001, 3002, 43119]) {
      const config = googleOAuthConfig(
        `http://localhost:${port}/api/auth/google`,
        { ...PRODUCTION_ENV, NODE_ENV: "development" },
      );
      expect(config.redirectUri).toBe(
        `http://localhost:${port}/api/auth/google/callback`,
      );
    }
    expect(
      googleOAuthConfig("http://127.0.0.1:3001/api/auth/google", {
        ...PRODUCTION_ENV,
        NODE_ENV: "development",
      }).origin,
    ).toBe("http://127.0.0.1:3001");
    expect(
      googleOAuthConfig(
        "http://localhost:3001/api/auth/google",
        { ...PRODUCTION_ENV, NODE_ENV: "development" },
        "127.0.0.1:3001",
      ).origin,
    ).toBe("http://127.0.0.1:3001");
    expect(() =>
      googleOAuthConfig(
        "http://localhost:3001/api/auth/google",
        { ...PRODUCTION_ENV, NODE_ENV: "development" },
        "127.0.0.1:3002",
      ),
    ).toThrow("Google OAuth failed");
    expect(
      googleOAuthConfig(
        "https://attacker.example/api/auth/google",
        PRODUCTION_ENV,
        "127.0.0.1:3001",
      ).origin,
    ).toBe("https://brain.example.test");

    for (const unsafe of [
      "http://localhost.example.test:3000/api/auth/google",
      "https://localhost:3000/api/auth/google",
      "http://0.0.0.0:3000/api/auth/google",
      "http://localhost/api/auth/google",
    ]) {
      expect(() =>
        googleOAuthConfig(unsafe, {
          ...PRODUCTION_ENV,
          NODE_ENV: "development",
        }),
      ).toThrow("Google OAuth failed");
    }
  });

  test("binds state, nonce and PKCE to a short-lived signed cookie", () => {
    const now = Date.now();
    const config = googleOAuthConfig("https://ignored.example", PRODUCTION_ENV);
    const { transaction, challenge } = createGoogleOAuthTransaction(
      "sign-in",
      null,
      now,
    );
    const authorization = new URL(
      googleAuthorizationUrl(config, transaction, challenge),
    );
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      config.redirectUri,
    );
    expect(authorization.searchParams.get("state")).toBe(transaction.state);
    expect(authorization.searchParams.get("nonce")).toBe(transaction.nonce);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("code_challenge")).toBe(challenge);
    expect(challenge).not.toBe(transaction.verifier);

    const setCookie = googleOAuthCookie(sessionConfig, transaction);
    expect(setCookie).toContain("__Host-kith_google_oauth=");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";")[0]!;
    expect(readGoogleOAuthTransaction(sessionConfig, cookie, now)).toEqual(
      transaction,
    );
    expect(googleOAuthStateMatches(transaction, transaction.state)).toBe(true);
    expect(googleOAuthStateMatches(transaction, `${transaction.state}x`)).toBe(
      false,
    );
    expect(
      readGoogleOAuthTransaction(
        sessionConfig,
        cookie.replace(/.$/, (last) => (last === "A" ? "B" : "A")),
        now,
      ),
    ).toBeNull();
    expect(
      readGoogleOAuthTransaction(sessionConfig, cookie, now + 10 * 60_000 + 1),
    ).toBeNull();
  });

  test("exchanges the code with the same redirect and PKCE verifier", async () => {
    const config = googleOAuthConfig("https://ignored.example", PRODUCTION_ENV);
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("code")).toBe("authorization-code");
      expect(body.get("client_id")).toBe(CLIENT_ID);
      expect(body.get("client_secret")).toBe("synthetic-secret");
      expect(body.get("redirect_uri")).toBe(config.redirectUri);
      expect(body.get("code_verifier")).toBe("v".repeat(43));
      return Response.json({ id_token: "signed-id-token" });
    });
    await expect(
      exchangeGoogleCode(config, "authorization-code", "v".repeat(43), fetcher),
    ).resolves.toBe("signed-id-token");
    expect(fetcher).toHaveBeenCalledOnce();

    await expect(
      exchangeGoogleCode(config, "authorization-code", "v".repeat(43), () =>
        Promise.resolve(new Response(null, { status: 400 })),
      ),
    ).rejects.toThrow("Google OAuth failed");
  });
});

describe("Google ID token verification", () => {
  let privateKey: CryptoKey;
  let wrongPrivateKey: CryptoKey;
  let signingKeys: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const primary = await generateKeyPair("RS256", { extractable: true });
    const wrong = await generateKeyPair("RS256", { extractable: true });
    privateKey = primary.privateKey;
    wrongPrivateKey = wrong.privateKey;
    signingKeys = createLocalJWKSet({
      keys: [
        {
          ...(await exportJWK(primary.publicKey)),
          alg: "RS256",
          kid: "primary",
          use: "sig",
        },
        {
          ...(await exportJWK(wrong.publicKey)),
          alg: "RS256",
          kid: "wrong",
          use: "sig",
        },
      ],
    });
  });

  async function token(
    overrides: Record<string, unknown> = {},
    key = privateKey,
    kid = "primary",
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "google-subject-123",
      email: "owner@google.example",
      email_verified: true,
      hd: "staff.example.test",
      nonce: "expected-nonce",
      iat: now,
      exp: now + 300,
      ...overrides,
    };
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .sign(key);
  }

  test("accepts Google's RS256 subject and verified email", async () => {
    await expect(
      verifyGoogleIdToken(
        await token(),
        { clientId: CLIENT_ID },
        "expected-nonce",
        signingKeys,
      ),
    ).resolves.toEqual({
      subject: "google-subject-123",
      verifiedEmail: "owner@google.example",
      hostedDomain: "staff.example.test",
    });
  });

  test("returns a missing hosted domain as ineligible signed metadata", async () => {
    await expect(
      verifyGoogleIdToken(
        await token({ hd: undefined }),
        { clientId: CLIENT_ID },
        "expected-nonce",
        signingKeys,
      ),
    ).resolves.toMatchObject({ hostedDomain: null });
  });

  test.each([
    ["wrong audience", { aud: "other-client" }],
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["expired", { exp: 1 }],
    ["wrong nonce", { nonce: "another-nonce" }],
    ["unverified email", { email_verified: false }],
    ["missing subject", { sub: undefined }],
    ["multiple audiences", { aud: [CLIENT_ID, "other-client"] }],
  ])("rejects %s", async (_label, overrides) => {
    await expect(
      verifyGoogleIdToken(
        await token(overrides),
        { clientId: CLIENT_ID },
        "expected-nonce",
        signingKeys,
      ),
    ).rejects.toThrow("Google OAuth failed");
  });

  test("rejects a token signed by an untrusted key", async () => {
    const trustedOnly = createLocalJWKSet({
      keys: [
        {
          ...(await exportJWK(
            (await generateKeyPair("RS256", { extractable: true })).publicKey,
          )),
          alg: "RS256",
          kid: "primary",
          use: "sig",
        },
      ],
    });
    await expect(
      verifyGoogleIdToken(
        await token({}, wrongPrivateKey, "wrong"),
        { clientId: CLIENT_ID },
        "expected-nonce",
        trustedOnly,
      ),
    ).rejects.toThrow("Google OAuth failed");
  });
});
