// PKCE, SMART discovery, the token exchange/refresh calls, and pasted-code
// parsing -- all against a mocked `fetch`, no network.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthorizationUrl,
  codeChallengeS256,
  discoverSmartConfiguration,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  InvalidGrantError,
  parsePastedCode,
  refreshAccessToken,
} from "../dist/index.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("generateCodeVerifier produces a 128-character unreserved string each time", () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.equal(a.length, 128);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b);
});

test("codeChallengeS256 is deterministic and matches the RFC 7636 example", () => {
  // RFC 7636 appendix B's own worked example.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(codeChallengeS256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("generateState produces a distinct opaque value each time", () => {
  assert.notEqual(generateState(), generateState());
});

test("buildAuthorizationUrl includes PKCE, state, aud and the joined scopes", () => {
  const url = new URL(
    buildAuthorizationUrl({
      authorizationEndpoint: "https://fhir.epic.com/authorize",
      clientId: "client-1",
      redirectUri: "https://brain.hive-mind.com/api/epic/callback",
      scopes: ["openid", "patient/Patient.read"],
      state: "state-1",
      codeChallenge: "challenge-1",
      aud: "https://fhir.epic.com/api/FHIR/R4/",
    }),
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://brain.hive-mind.com/api/epic/callback",
  );
  assert.equal(url.searchParams.get("scope"), "openid patient/Patient.read");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("aud"), "https://fhir.epic.com/api/FHIR/R4/");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("discoverSmartConfiguration reads the well-known document when present", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse(200, {
      authorization_endpoint: "https://fhir.epic.com/oauth2/authorize",
      token_endpoint: "https://fhir.epic.com/oauth2/token",
    });
  };
  const result = await discoverSmartConfiguration(
    "https://fhir.epic.com/api/FHIR/R4",
    fetchImpl,
  );
  assert.equal(result.authorizationEndpoint, "https://fhir.epic.com/oauth2/authorize");
  assert.equal(result.tokenEndpoint, "https://fhir.epic.com/oauth2/token");
  assert.equal(calls[0], "https://fhir.epic.com/api/FHIR/R4/.well-known/smart-configuration");
});

test("discoverSmartConfiguration falls back to /metadata's oauth-uris extension", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith(".well-known/smart-configuration")) {
      return jsonResponse(404, {});
    }
    return jsonResponse(200, {
      rest: [
        {
          security: {
            extension: [
              {
                url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris",
                extension: [
                  { url: "authorize", valueUri: "https://fhir.epic.com/oauth2/authorize" },
                  { url: "token", valueUri: "https://fhir.epic.com/oauth2/token" },
                ],
              },
            ],
          },
        },
      ],
    });
  };
  const result = await discoverSmartConfiguration(
    "https://fhir.epic.com/api/FHIR/R4/",
    fetchImpl,
  );
  assert.equal(result.tokenEndpoint, "https://fhir.epic.com/oauth2/token");
});

test("discoverSmartConfiguration throws when neither document has usable endpoints", async () => {
  const fetchImpl = async () => jsonResponse(500, {});
  await assert.rejects(() =>
    discoverSmartConfiguration("https://fhir.epic.com/api/FHIR/R4/", fetchImpl),
  );
});

test("exchangeCode sends HTTP Basic client auth and the code verifier", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return jsonResponse(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      patient: "patient-1",
      scope: "openid patient/Patient.read",
    });
  };
  const result = await exchangeCode(
    {
      tokenEndpoint: "https://fhir.epic.com/oauth2/token",
      clientId: "client-1",
      clientSecret: "secret-1",
      code: "code-1",
      redirectUri: "https://brain.hive-mind.com/api/epic/callback",
      codeVerifier: "verifier-1",
    },
    fetchImpl,
  );
  assert.equal(captured.url, "https://fhir.epic.com/oauth2/token");
  assert.equal(captured.init.method, "POST");
  assert.equal(
    captured.init.headers.authorization,
    `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`,
  );
  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "code-1");
  assert.equal(body.get("code_verifier"), "verifier-1");
  assert.equal(result.accessToken, "access-1");
  assert.equal(result.refreshToken, "refresh-1");
  assert.equal(result.patientFhirId, "patient-1");
});

test("refreshAccessToken sends the refresh grant with Basic auth", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = init;
    return jsonResponse(200, {
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_in: 3600,
    });
  };
  const result = await refreshAccessToken(
    {
      tokenEndpoint: "https://fhir.epic.com/oauth2/token",
      clientId: "client-1",
      clientSecret: "secret-1",
      refreshToken: "refresh-1",
    },
    fetchImpl,
  );
  const body = new URLSearchParams(captured.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "refresh-1");
  assert.equal(result.accessToken, "access-2");
});

test("refreshAccessToken throws InvalidGrantError on an invalid_grant response", async () => {
  const fetchImpl = async () =>
    jsonResponse(400, { error: "invalid_grant", error_description: "Refresh token expired" });
  await assert.rejects(
    () =>
      refreshAccessToken(
        {
          tokenEndpoint: "https://fhir.epic.com/oauth2/token",
          clientId: "client-1",
          clientSecret: "secret-1",
          refreshToken: "dead-refresh-token",
        },
        fetchImpl,
      ),
    (error) => {
      assert.ok(error instanceof InvalidGrantError);
      assert.equal(error.message, "Refresh token expired");
      return true;
    },
  );
});

test("refreshAccessToken throws a plain error for a non-invalid_grant failure", async () => {
  const fetchImpl = async () =>
    jsonResponse(500, { error: "server_error", error_description: "boom" });
  await assert.rejects(
    () =>
      refreshAccessToken(
        {
          tokenEndpoint: "https://fhir.epic.com/oauth2/token",
          clientId: "client-1",
          clientSecret: "secret-1",
          refreshToken: "refresh-1",
        },
        fetchImpl,
      ),
    (error) => {
      assert.ok(!(error instanceof InvalidGrantError));
      return true;
    },
  );
});

test("parsePastedCode accepts a bare code", () => {
  assert.deepEqual(parsePastedCode("abc123", "state-1"), { code: "abc123" });
});

test("parsePastedCode accepts a full callback URL and checks state", () => {
  assert.deepEqual(
    parsePastedCode(
      "https://brain.hive-mind.com/api/epic/callback?code=abc123&state=state-1",
      "state-1",
    ),
    { code: "abc123" },
  );
});

test("parsePastedCode rejects a callback URL whose state does not match", () => {
  assert.throws(() =>
    parsePastedCode(
      "https://brain.hive-mind.com/api/epic/callback?code=abc123&state=wrong",
      "state-1",
    ),
  );
});

test("parsePastedCode rejects empty input", () => {
  assert.throws(() => parsePastedCode("   ", "state-1"));
});
