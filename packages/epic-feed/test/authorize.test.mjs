// `runAuthorize`'s orchestration against a fake pool and a mocked fetch/
// Keychain/prompt -- no network, no database, no Keychain, no real stdin.

import assert from "node:assert/strict";
import test from "node:test";

import { runAuthorize } from "../dist/index.js";

import { fakePool } from "./helpers/fakePool.mjs";
import { inMemoryTokenStore } from "./helpers/tokenStore.mjs";

// `runAuthorize` loads the client id and secret itself (env-first, then
// Keychain, `loadClientId`/`loadClientSecret` in `config.ts`); setting both
// here means these tests never fall through to a real Keychain lookup --
// `security` does not exist on a Linux CI runner, and a fallback lookup that
// found nothing there would otherwise throw `spawn ... ENOENT` before this
// file's own `tokenStore`/`fakePool` mocks are ever reached.
process.env.EPIC_CLIENT_ID ??= "synthetic-test-client-id";
process.env.EPIC_CLIENT_SECRET ??= "synthetic-test-secret";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const PERSON_ROW = {
  id: "person-kith-id-1",
  space_id: "space-kith-id-1",
  canonical_name: "Jamie Synthetic",
};

function personPool() {
  return fakePool({
    "WHERE id = $1 AND kind = 'person'": { rows: [PERSON_ROW] },
  });
}

test("runAuthorize completes a sandbox flow and stores the token and the source row", async () => {
  const pool = personPool();
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    if (url.includes("well-known/smart-configuration")) {
      return jsonResponse(200, {
        authorization_endpoint: "https://fhir.epic.com/oauth2/authorize",
        token_endpoint: "https://fhir.epic.com/oauth2/token",
      });
    }
    if (url.includes("/oauth2/token")) {
      return jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        patient: "patient-1",
        scope: "openid patient/Patient.read",
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const tokenStore = inMemoryTokenStore();
  const reports = [];
  const outcome = await runAuthorize(
    { personSelector: "person-kith-id-1", sandbox: true },
    {
      pool,
      fetchImpl,
      prompt: async () => "the-pasted-code",
      tokenStore,
      report: (line) => reports.push(line),
      generateVerifier: () => "verifier-1",
      generateStateValue: () => "state-1",
    },
  );

  assert.equal(outcome.status, "linked");
  assert.equal(outcome.personName, "Jamie Synthetic");
  assert.equal(outcome.orgName, "Epic Sandbox");
  assert.equal(tokenStore.items.size, 1);
  const [[service, secret]] = tokenStore.items;
  assert.equal(service, "com.kithmind.epic.token.jamie-synthetic");
  const stored = JSON.parse(secret);
  assert.equal(stored.refreshToken, "refresh-1");
  assert.equal(stored.patientFhirId, "patient-1");
  assert.equal(stored.clientAuth, "secret");
  const insert = pool.calls.find((call) =>
    call.text.includes("INSERT INTO kith.health_sources"),
  );
  assert.ok(insert);
  assert.equal(insert.params[1], "person-kith-id-1");
  assert.equal(insert.params[2], "space-kith-id-1");
  assert.ok(reports.some((line) => line.includes("Linked Epic Sandbox")));
  assert.ok(
    reports.some(
      (line) => line === "Authorized as confidential client; refresh token: present",
    ),
  );
});

test("runAuthorize falls back to a public client on Basic invalid_client and stores clientAuth: public", async () => {
  const pool = personPool();
  const tokenCalls = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("well-known/smart-configuration")) {
      return jsonResponse(200, {
        authorization_endpoint: "https://fhir.epic.com/oauth2/authorize",
        token_endpoint: "https://fhir.epic.com/oauth2/token",
      });
    }
    if (url.includes("/oauth2/token")) {
      tokenCalls.push(init);
      if (init.headers.authorization !== undefined) {
        return jsonResponse(401, {
          error: "invalid_client",
          error_description: "invalid client credentials",
        });
      }
      return jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        patient: "patient-1",
        scope: "openid patient/Patient.read",
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const tokenStore = inMemoryTokenStore();
  const reports = [];
  const outcome = await runAuthorize(
    { personSelector: "person-kith-id-1", sandbox: true },
    {
      pool,
      fetchImpl,
      prompt: async () => "the-pasted-code",
      tokenStore,
      report: (line) => reports.push(line),
      generateVerifier: () => "verifier-1",
      generateStateValue: () => "state-1",
    },
  );

  assert.equal(outcome.status, "linked");
  assert.equal(tokenCalls.length, 2);
  const [[, secret]] = tokenStore.items;
  const stored = JSON.parse(secret);
  assert.equal(stored.clientAuth, "public");
  assert.equal(stored.refreshToken, "refresh-1");
  assert.ok(
    reports.some((line) => line === "Authorized as public client; refresh token: present"),
  );
});

test("runAuthorize reports and stores an absent refresh token", async () => {
  const pool = personPool();
  const fetchImpl = async (url) => {
    if (url.includes("well-known/smart-configuration")) {
      return jsonResponse(200, {
        authorization_endpoint: "https://fhir.epic.com/oauth2/authorize",
        token_endpoint: "https://fhir.epic.com/oauth2/token",
      });
    }
    if (url.includes("/oauth2/token")) {
      return jsonResponse(200, {
        access_token: "access-1",
        expires_in: 3600,
        patient: "patient-1",
        scope: "openid patient/Patient.read",
        // No refresh_token: Epic did not grant one.
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const tokenStore = inMemoryTokenStore();
  const reports = [];
  const outcome = await runAuthorize(
    { personSelector: "person-kith-id-1", sandbox: true },
    {
      pool,
      fetchImpl,
      prompt: async () => "the-pasted-code",
      tokenStore,
      report: (line) => reports.push(line),
      generateVerifier: () => "verifier-1",
      generateStateValue: () => "state-1",
    },
  );

  assert.equal(outcome.status, "linked");
  const [[, secret]] = tokenStore.items;
  const stored = JSON.parse(secret);
  assert.equal(stored.refreshToken, null);
  assert.equal(stored.accessToken, "access-1");
  assert.ok(
    reports.some(
      (line) => line === "Authorized as confidential client; refresh token: absent",
    ),
  );
  assert.ok(
    reports.some((line) => line.includes("will need a new authorization")),
  );
});

test("runAuthorize throws when no person matches the selector", async () => {
  const pool = fakePool({
    "WHERE id = $1 AND kind = 'person'": { rows: [] },
    "lower(canonical_name) = lower($1)": { rows: [] },
  });
  await assert.rejects(
    () =>
      runAuthorize(
        { personSelector: "nobody", sandbox: true },
        { pool, prompt: async () => "code" },
      ),
    /No person found/,
  );
});

test("runAuthorize requires --org in production", async () => {
  const pool = personPool();
  await assert.rejects(
    () =>
      runAuthorize(
        { personSelector: "person-kith-id-1", sandbox: false },
        { pool, prompt: async () => "code" },
      ),
    /--org/,
  );
});

test("runAuthorize rejects a pasted code whose state does not match", async () => {
  const pool = personPool();
  const fetchImpl = async (url) => {
    if (url.includes("well-known/smart-configuration")) {
      return jsonResponse(200, {
        authorization_endpoint: "https://fhir.epic.com/oauth2/authorize",
        token_endpoint: "https://fhir.epic.com/oauth2/token",
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  await assert.rejects(
    () =>
      runAuthorize(
        { personSelector: "person-kith-id-1", sandbox: true },
        {
          pool,
          fetchImpl,
          prompt: async () =>
            "https://brain.hive-mind.com/api/epic/callback?code=abc&state=wrong-state",
          generateStateValue: () => "expected-state",
        },
      ),
    /state/,
  );
});
