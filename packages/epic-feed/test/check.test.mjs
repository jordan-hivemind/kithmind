// `runCheck`'s three diagnoses, against a mocked directory lookup, SMART
// discovery, and token endpoint -- no network, no Keychain, no database.

import assert from "node:assert/strict";
import test from "node:test";

import { runCheck } from "../dist/index.js";

const DIRECTORY_BUNDLE = {
  resourceType: "Bundle",
  entry: [
    {
      resource: {
        resourceType: "Endpoint",
        name: "Synthetic Health System",
        address: "https://fhir.synthetic.example/api/FHIR/R4/",
      },
    },
  ],
};

const DISCOVERY = {
  authorization_endpoint: "https://fhir.synthetic.example/oauth2/authorize",
  token_endpoint: "https://fhir.synthetic.example/oauth2/token",
};

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * A fetch mock for one production `check` run: the directory lookup, SMART
 * discovery, and two token requests (`runCheck` sends the without-secret
 * attempt first, then the with-secret attempt), answered in that order by
 * `tokenErrors` -- `[withoutSecretError, withSecretError]`, each `null` or
 * an OAuth `error` string.
 */
function fetchMockFor(tokenErrors) {
  const tokenCalls = [];
  const fetchImpl = async (url, init) => {
    if (url === "https://open.epic.com/Endpoints/R4") {
      return jsonResponse(200, DIRECTORY_BUNDLE);
    }
    if (url.includes("well-known/smart-configuration")) {
      return jsonResponse(200, DISCOVERY);
    }
    if (url.includes("/oauth2/token")) {
      tokenCalls.push({ url, init });
      const error = tokenErrors[tokenCalls.length - 1];
      if (error === null) {
        return jsonResponse(200, { access_token: "unused", token_type: "bearer" });
      }
      const status = error === "invalid_client" ? 401 : 400;
      return jsonResponse(status, { error, error_description: `${error} for synthetic test` });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchImpl, tokenCalls };
}

function fakeReader(map) {
  return async (service) => (Object.hasOwn(map, service) ? map[service] : null);
}

const READER = fakeReader({
  "com.kithmind.epic.client-id": "synthetic-production-client-id",
  "com.kithmind.epic.client-secret.synthetic-health-system":
    "synthetic-per-org-secret-value",
});

test("runCheck diagnoses client_known when either attempt returns invalid_grant", async () => {
  const { fetchImpl, tokenCalls } = fetchMockFor(["invalid_grant", "invalid_grant"]);
  const reports = [];
  const outcome = await runCheck(
    { org: "Synthetic Health System" },
    { fetchImpl, readKeychainItem: READER, report: (line) => reports.push(line) },
  );
  assert.equal(outcome.diagnosis, "client_known");
  assert.equal(outcome.withoutSecret.error, "invalid_grant");
  assert.equal(outcome.withSecret.error, "invalid_grant");
  assert.equal(tokenCalls.length, 2);
  assert.ok(reports.some((line) => line.includes("recognizes the configured client ID")));
});

test("runCheck diagnoses client_not_distributed_or_wrong_id when both attempts return invalid_client", async () => {
  const { fetchImpl } = fetchMockFor(["invalid_client", "invalid_client"]);
  const outcome = await runCheck(
    { org: "Synthetic Health System" },
    { fetchImpl, readKeychainItem: READER, report: () => {} },
  );
  assert.equal(outcome.diagnosis, "client_not_distributed_or_wrong_id");
  assert.match(outcome.message, /has not reached this organization yet/);
});

test("runCheck diagnoses secret_missing_or_mismatched when invalid_client with the secret but invalid_grant without it", async () => {
  const { fetchImpl } = fetchMockFor(["invalid_grant", "invalid_client"]);
  const outcome = await runCheck(
    { org: "Synthetic Health System" },
    { fetchImpl, readKeychainItem: READER, report: () => {} },
  );
  assert.equal(outcome.diagnosis, "secret_missing_or_mismatched");
  assert.match(outcome.message, /per-organization secret is not set or does not match/);
});

test("runCheck never reports the secret value, only the Keychain item names it used", async () => {
  const { fetchImpl } = fetchMockFor(["invalid_grant", "invalid_grant"]);
  const reports = [];
  const outcome = await runCheck(
    { org: "Synthetic Health System" },
    { fetchImpl, readKeychainItem: READER, report: (line) => reports.push(line) },
  );
  assert.equal(outcome.clientIdSource, "com.kithmind.epic.client-id");
  assert.equal(
    outcome.clientSecretSource,
    "com.kithmind.epic.client-secret.synthetic-health-system",
  );
  assert.ok(reports.some((line) => line.includes("com.kithmind.epic.client-id")));
  assert.ok(
    reports.some((line) =>
      line.includes("com.kithmind.epic.client-secret.synthetic-health-system"),
    ),
  );
  const joined = reports.join("\n");
  assert.ok(!joined.includes("synthetic-per-org-secret-value"));
  assert.ok(!joined.includes("synthetic-production-client-id"));
});

test("runCheck skips the with-secret attempt and notes it when no secret is configured", async () => {
  const { fetchImpl, tokenCalls } = fetchMockFor(["invalid_client"]);
  const reports = [];
  const outcome = await runCheck(
    { org: "Synthetic Health System" },
    {
      fetchImpl,
      readKeychainItem: fakeReader({
        "com.kithmind.epic.client-id": "synthetic-production-client-id",
      }),
      report: (line) => reports.push(line),
    },
  );
  assert.equal(tokenCalls.length, 1);
  assert.equal(outcome.clientSecretSource, "none");
  assert.deepEqual(outcome.withSecret, outcome.withoutSecret);
  assert.equal(outcome.diagnosis, "client_not_distributed_or_wrong_id");
  assert.ok(reports.some((line) => line.includes("No client secret is configured")));
});

test("runCheck defaults --org to Epic Sandbox in sandbox mode, without a directory lookup", async () => {
  let directoryCalled = false;
  const { fetchImpl: tokenFetch } = fetchMockFor(["invalid_grant", "invalid_grant"]);
  const fetchImpl = async (url, init) => {
    if (url === "https://open.epic.com/Endpoints/R4") {
      directoryCalled = true;
    }
    return tokenFetch(url, init);
  };
  const outcome = await runCheck(
    { sandbox: true },
    {
      fetchImpl,
      readKeychainItem: fakeReader({}),
      report: () => {},
    },
  );
  assert.equal(directoryCalled, false);
  assert.equal(outcome.orgName, "Epic Sandbox");
  assert.equal(outcome.diagnosis, "client_known");
});
