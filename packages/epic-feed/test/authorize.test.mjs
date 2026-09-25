// `runAuthorize`'s orchestration against a fake pool and a mocked fetch/
// Keychain/prompt -- no network, no database, no Keychain, no real stdin.

import assert from "node:assert/strict";
import test from "node:test";

import { runAuthorize } from "../dist/index.js";

import { fakePool } from "./helpers/fakePool.mjs";
import { inMemoryTokenStore } from "./helpers/tokenStore.mjs";

// `runAuthorize` loads the client id (env-first, then Keychain,
// `loadClientId` in `config.ts`) and the client secret
// (`loadClientSecretForOrg`: the org's own Keychain item, then the shared
// Keychain item, then env -- see `config.test.mjs` for that order on its
// own) itself; setting `EPIC_CLIENT_ID` here and passing
// `readClientSecret: async () => null` in each test below (so both Keychain
// items "miss" and the lookup falls through to `EPIC_CLIENT_SECRET`) means
// these tests never fall through to a real Keychain lookup -- `security`
// does not exist on a Linux CI runner, and a fallback lookup that found
// nothing there would otherwise throw `spawn ... ENOENT` before this file's
// own `tokenStore`/`fakePool` mocks are ever reached.
process.env.EPIC_CLIENT_ID ??= "synthetic-test-client-id";
process.env.EPIC_CLIENT_SECRET ??= "synthetic-test-secret";

const noKeychainSecret = async () => null;

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
    // No other person is already linked to whatever patient this test
    // exchanges a code for -- see the collision-guard tests near the
    // bottom of this file for the case where this does find a row.
    "WHERE fhir_base = $1 AND patient_fhir_id = $2 AND person_id <> $3": { rows: [] },
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
      readClientSecret: noKeychainSecret,
    },
  );

  assert.equal(outcome.status, "linked");
  assert.equal(outcome.personName, "Jamie Synthetic");
  assert.equal(outcome.orgName, "Epic Sandbox");
  assert.equal(tokenStore.items.size, 1);
  const [[service, secret]] = tokenStore.items;
  assert.equal(service, "com.kithmind.epic.token.jamie-synthetic.epic-sandbox");
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
      readClientSecret: noKeychainSecret,
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
      readClientSecret: noKeychainSecret,
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
          readClientSecret: noKeychainSecret,
        },
      ),
    /state/,
  );
});

test("runAuthorize prefers the org's own client secret and reports the item name, never the value", async () => {
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
  const secretReads = [];
  const readClientSecret = async (service) => {
    secretReads.push(service);
    if (service === "com.kithmind.epic.client-secret.epic-sandbox") {
      return "org-specific-secret";
    }
    return null;
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
      readClientSecret,
    },
  );

  assert.equal(outcome.status, "linked");
  // The org's own item answered, so the shared item was never consulted.
  assert.deepEqual(secretReads, ["com.kithmind.epic.client-secret.epic-sandbox"]);
  assert.ok(
    reports.includes("Client secret: com.kithmind.epic.client-secret.epic-sandbox"),
  );
  // The secret value itself is never printed.
  assert.ok(reports.every((line) => !line.includes("org-specific-secret")));
  // The exchange actually used it.
  assert.equal(tokenCalls.length, 1);
  assert.equal(
    tokenCalls[0].headers.authorization,
    `Basic ${Buffer.from("synthetic-test-client-id:org-specific-secret").toString("base64")}`,
  );
});

// Regression coverage for the defect this task fixes: authorizing the same
// person at two organizations (e.g. Virginia Mason Franciscan Health, then
// Optum Care Washington -- a real scenario Epic's own proxy access enables)
// must not have the second authorization's Keychain item overwrite the
// first's, since `kith.health_sources` allows one row per
// (person_id, fhir_base) and both organizations get their own row.
test("runAuthorize stores a distinct Keychain item and source row per organization for the same person", async () => {
  const pool = personPool();
  const DIRECTORY_BUNDLE = {
    entry: [
      {
        resource: {
          resourceType: "Endpoint",
          name: "Virginia Mason Franciscan Health",
          address: "https://fhir.vmfh.example/api/FHIR/R4/",
        },
      },
      {
        resource: {
          resourceType: "Endpoint",
          name: "Optum Care Washington",
          address: "https://fhir.optum-wa.example/api/FHIR/R4/",
        },
      },
    ],
  };
  const fetchImpl = async (url) => {
    if (url.includes("Endpoints/R4")) {
      return jsonResponse(200, DIRECTORY_BUNDLE);
    }
    if (url.includes("well-known/smart-configuration")) {
      return jsonResponse(200, {
        authorization_endpoint: "https://example.org/oauth2/authorize",
        token_endpoint: "https://example.org/oauth2/token",
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

  const first = await runAuthorize(
    {
      personSelector: "person-kith-id-1",
      org: "Virginia Mason Franciscan Health",
      sandbox: false,
    },
    {
      pool,
      fetchImpl,
      prompt: async () => "code-1",
      tokenStore,
      report: () => {},
      generateVerifier: () => "verifier-1",
      generateStateValue: () => "state-1",
      readClientSecret: noKeychainSecret,
    },
  );
  const second = await runAuthorize(
    { personSelector: "person-kith-id-1", org: "Optum Care Washington", sandbox: false },
    {
      pool,
      fetchImpl,
      prompt: async () => "code-2",
      tokenStore,
      report: () => {},
      generateVerifier: () => "verifier-2",
      generateStateValue: () => "state-2",
      readClientSecret: noKeychainSecret,
    },
  );

  assert.equal(first.status, "linked");
  assert.equal(second.status, "linked");

  // Two distinct Keychain items -- the second authorization did not
  // overwrite the first.
  assert.equal(tokenStore.items.size, 2);
  const itemNames = [...tokenStore.items.keys()].sort();
  assert.deepEqual(itemNames, [
    "com.kithmind.epic.token.jamie-synthetic.optum-care-washington",
    "com.kithmind.epic.token.jamie-synthetic.virginia-mason-franciscan-health",
  ]);

  // Two distinct `health_sources` upserts, one per (person, fhir_base).
  const upserts = pool.calls.filter((call) =>
    call.text.includes("INSERT INTO kith.health_sources"),
  );
  assert.equal(upserts.length, 2);
  const fhirBases = upserts.map((call) => call.params[4]).sort();
  assert.deepEqual(fhirBases, [
    "https://fhir.optum-wa.example/api/FHIR/R4/",
    "https://fhir.vmfh.example/api/FHIR/R4/",
  ]);
  const keychainParams = upserts.map((call) => call.params[6]).sort();
  assert.deepEqual(keychainParams, itemNames);
});

// Regression coverage for the collision guard: `kith.health_sources` is
// only unique on (person_id, fhir_base), not on (fhir_base,
// patient_fhir_id), so nothing at the database level stops the operator
// from picking the wrong family member in MyChart's proxy picker and
// attaching one patient's records to two different person entities. This
// must be refused before either the Keychain token or the source row is
// written.
function collisionFetchImpl() {
  return async (url) => {
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
        patient: "shared-patient-1",
        scope: "openid patient/Patient.read",
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test("runAuthorize refuses to link a patient already linked to a different person", async () => {
  const pool = fakePool({
    "WHERE id = $1 AND kind = 'person'": { rows: [PERSON_ROW] },
    "WHERE fhir_base = $1 AND patient_fhir_id = $2 AND person_id <> $3": {
      rows: [{ person_id: "some-other-person-kith-id", org_name: "Epic Sandbox" }],
    },
  });
  const tokenStore = inMemoryTokenStore();
  const reports = [];

  await assert.rejects(
    () =>
      runAuthorize(
        { personSelector: "person-kith-id-1", sandbox: true },
        {
          pool,
          fetchImpl: collisionFetchImpl(),
          prompt: async () => "the-pasted-code",
          tokenStore,
          report: (line) => reports.push(line),
          generateVerifier: () => "verifier-1",
          generateStateValue: () => "state-1",
          readClientSecret: noKeychainSecret,
        },
      ),
    (error) => {
      assert.match(error.message, /already linked to another person/);
      // Names the org and the person selector the operator passed, per the
      // task -- never a token or the raw patient id.
      assert.match(error.message, /Epic Sandbox/);
      assert.match(error.message, /person-kith-id-1/);
      assert.match(error.message, /proxy picker/);
      assert.doesNotMatch(error.message, /shared-patient-1/);
      assert.doesNotMatch(error.message, /refresh-1/);
      assert.doesNotMatch(error.message, /access-1/);
      return true;
    },
  );

  // Nothing was written: the collision check runs before the Keychain
  // token store write and before `upsertHealthSource`.
  assert.equal(tokenStore.items.size, 0);
  assert.ok(
    !pool.calls.some((call) => call.text.includes("INSERT INTO kith.health_sources")),
  );
});

test("runAuthorize still succeeds when the same person re-authorizes the same patient", async () => {
  const pool = fakePool({
    "WHERE id = $1 AND kind = 'person'": { rows: [PERSON_ROW] },
    // The only existing row for this (fhir_base, patient) pair belongs to
    // the same person being authorized -- `person_id <> $3` excludes it, so
    // the lookup below finds no collision and the flow proceeds as before.
    "WHERE fhir_base = $1 AND patient_fhir_id = $2 AND person_id <> $3": { rows: [] },
  });
  const tokenStore = inMemoryTokenStore();
  const reports = [];

  const outcome = await runAuthorize(
    { personSelector: "person-kith-id-1", sandbox: true },
    {
      pool,
      fetchImpl: collisionFetchImpl(),
      prompt: async () => "the-pasted-code",
      tokenStore,
      report: (line) => reports.push(line),
      generateVerifier: () => "verifier-1",
      generateStateValue: () => "state-1",
      readClientSecret: noKeychainSecret,
    },
  );

  assert.equal(outcome.status, "linked");
  assert.equal(tokenStore.items.size, 1);
  const insert = pool.calls.find((call) =>
    call.text.includes("INSERT INTO kith.health_sources"),
  );
  assert.ok(insert);
  assert.equal(insert.params[1], "person-kith-id-1");
  assert.ok(reports.some((line) => line.includes("Linked Epic Sandbox")));
});
