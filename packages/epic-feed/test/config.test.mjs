// `orgSlug` and `loadClientSecretForOrg`'s per-organization lookup order --
// no Keychain, no network. `readKeychainSecretByService` itself (the real
// Keychain call) is never exercised here; every test injects its own reader.

import assert from "node:assert/strict";
import test from "node:test";

import {
  clientSecretKeychainService,
  loadClientSecretForOrg,
  orgSlug,
} from "../dist/index.js";

test("orgSlug lowercases, hyphenates, and trims a health system name", () => {
  assert.equal(
    orgSlug("Virginia Mason Franciscan Health"),
    "virginia-mason-franciscan-health",
  );
  assert.equal(orgSlug("  St. Luke's -- Regional  "), "st-luke-s-regional");
  assert.equal(orgSlug("Epic Sandbox"), "epic-sandbox");
});

test("orgSlug falls back to \"org\" when nothing alphanumeric remains", () => {
  assert.equal(orgSlug("***"), "org");
  assert.equal(orgSlug(""), "org");
});

test("clientSecretKeychainService namespaces the shared item by org slug", () => {
  assert.equal(
    clientSecretKeychainService("Virginia Mason Franciscan Health"),
    "com.kithmind.epic.client-secret.virginia-mason-franciscan-health",
  );
});

test("loadClientSecretForOrg prefers the org's own Keychain item", async () => {
  const reads = [];
  const reader = async (service) => {
    reads.push(service);
    if (service === "com.kithmind.epic.client-secret.epic-sandbox") {
      return "org-specific-secret";
    }
    return "should-not-be-reached";
  };
  const result = await loadClientSecretForOrg("Epic Sandbox", reader);
  assert.equal(result.secret, "org-specific-secret");
  assert.equal(result.source, "com.kithmind.epic.client-secret.epic-sandbox");
  // Only the per-org item was read -- the shared item is never consulted
  // once the per-org one answers.
  assert.deepEqual(reads, ["com.kithmind.epic.client-secret.epic-sandbox"]);
});

test("loadClientSecretForOrg falls back to the shared Keychain item", async () => {
  const reads = [];
  const reader = async (service) => {
    reads.push(service);
    if (service === "com.kithmind.epic.client-secret") return "shared-secret";
    return null;
  };
  const result = await loadClientSecretForOrg("Epic Sandbox", reader);
  assert.equal(result.secret, "shared-secret");
  assert.equal(result.source, "com.kithmind.epic.client-secret");
  assert.deepEqual(reads, [
    "com.kithmind.epic.client-secret.epic-sandbox",
    "com.kithmind.epic.client-secret",
  ]);
});

test("loadClientSecretForOrg falls back to EPIC_CLIENT_SECRET when neither Keychain item is set", async () => {
  const previous = process.env.EPIC_CLIENT_SECRET;
  process.env.EPIC_CLIENT_SECRET = "env-secret";
  try {
    const result = await loadClientSecretForOrg("Epic Sandbox", async () => null);
    assert.equal(result.secret, "env-secret");
    assert.equal(result.source, "EPIC_CLIENT_SECRET");
  } finally {
    if (previous === undefined) delete process.env.EPIC_CLIENT_SECRET;
    else process.env.EPIC_CLIENT_SECRET = previous;
  }
});

test("loadClientSecretForOrg returns null when nothing is configured", async () => {
  const previous = process.env.EPIC_CLIENT_SECRET;
  delete process.env.EPIC_CLIENT_SECRET;
  try {
    const result = await loadClientSecretForOrg("Epic Sandbox", async () => null);
    assert.equal(result.secret, null);
    assert.equal(result.source, "none");
  } finally {
    if (previous !== undefined) process.env.EPIC_CLIENT_SECRET = previous;
  }
});
