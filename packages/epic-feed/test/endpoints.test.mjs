// Production health-system lookup against a mocked copy of Epic's public R4
// endpoint directory bundle shape.

import assert from "node:assert/strict";
import test from "node:test";

import { findEndpointsByName } from "../dist/index.js";

const DIRECTORY_BUNDLE = {
  resourceType: "Bundle",
  entry: [
    {
      resource: {
        resourceType: "Endpoint",
        name: "Synthetic General Hospital",
        address: "https://fhir.synthetic.example/api/FHIR/R4/",
      },
    },
    {
      resource: {
        resourceType: "Endpoint",
        name: "Synthetic General Hospital - North Campus",
        address: "https://fhir.synthetic-north.example/api/FHIR/R4/",
      },
    },
    {
      resource: {
        resourceType: "Endpoint",
        name: "Unrelated Clinic",
        address: "https://fhir.unrelated.example/api/FHIR/R4/",
      },
    },
    { resource: { resourceType: "OperationOutcome" } },
  ],
};

function fetchReturning(body, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

test("findEndpointsByName matches case-insensitively by substring", async () => {
  const matches = await findEndpointsByName(
    "synthetic general",
    fetchReturning(DIRECTORY_BUNDLE),
  );
  assert.equal(matches.length, 2);
  assert.deepEqual(
    matches.map((m) => m.orgName).sort(),
    ["Synthetic General Hospital", "Synthetic General Hospital - North Campus"],
  );
});

test("findEndpointsByName returns [] for an empty query without fetching", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => DIRECTORY_BUNDLE };
  };
  const matches = await findEndpointsByName("   ", fetchImpl);
  assert.deepEqual(matches, []);
  assert.equal(called, false);
});

test("findEndpointsByName returns [] when nothing matches", async () => {
  const matches = await findEndpointsByName(
    "no such hospital anywhere",
    fetchReturning(DIRECTORY_BUNDLE),
  );
  assert.deepEqual(matches, []);
});

test("findEndpointsByName throws when the directory fetch fails", async () => {
  await assert.rejects(() =>
    findEndpointsByName("synthetic", fetchReturning({}, 500)),
  );
});
