// Calls Epic's real public sandbox `.well-known/smart-configuration` and
// `/metadata` once, to prove `discoverSmartConfiguration` actually works
// against the live sandbox rather than only against a mocked fixture of it.
// Skipped when there is no network path to fhir.epic.com (offline dev, a
// sandboxed CI runner with no outbound internet) -- set
// EPIC_FEED_REQUIRE_NETWORK=1 to turn that skip into a failure where a
// reviewer needs to know this ran for real.

import assert from "node:assert/strict";
import test from "node:test";

import { discoverSmartConfiguration, SANDBOX_FHIR_BASE } from "../dist/index.js";

async function sandboxReachable() {
  try {
    const response = await fetch(`${SANDBOX_FHIR_BASE}metadata`, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

const reachable = await sandboxReachable();
if (process.env.EPIC_FEED_REQUIRE_NETWORK === "1" && !reachable) {
  throw new Error(
    "EPIC_FEED_REQUIRE_NETWORK=1 but fhir.epic.com is not reachable from this runner",
  );
}

test(
  "discoverSmartConfiguration resolves real authorize/token endpoints from Epic's public sandbox",
  { skip: reachable ? false : "no network path to fhir.epic.com" },
  async () => {
    const result = await discoverSmartConfiguration(SANDBOX_FHIR_BASE);
    assert.match(result.authorizationEndpoint, /^https:\/\//);
    assert.match(result.tokenEndpoint, /^https:\/\//);
  },
);
