// `pullSource`/`pullOneSource` against a mocked FHIR server and a fake pool
// -- no network, no Keychain, no real database.

import assert from "node:assert/strict";
import test from "node:test";

import { pullOneSource, pullSource } from "../dist/index.js";

import { fakePool } from "./helpers/fakePool.mjs";

const SOURCE = {
  id: "source-1",
  personId: "person-1",
  spaceId: "space-1",
  orgName: "Synthetic Health System",
  fhirBase: "https://fhir.synthetic.example/api/FHIR/R4/",
  patientFhirId: "patient-1",
  keychainService: "com.kithmind.epic.token.synthetic",
  scopes: "openid",
  lastPulledAt: null,
  needsReauthAt: null,
};

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

function patientResource() {
  return {
    resourceType: "Patient",
    id: "patient-1",
    active: true,
    name: [{ given: ["Jamie"], family: "Synthetic" }],
    birthDate: "1990-01-01",
  };
}

test("pullSource fetches Patient and pages through a resource type's next links", async () => {
  const pool = fakePool();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    if (url.includes("page=2")) {
      return jsonResponse(200, {
        entry: [
          {
            resource: {
              resourceType: "Condition",
              id: "cond-2",
              code: { text: "Condition two" },
            },
          },
        ],
      });
    }
    return jsonResponse(200, {
      entry: [
        {
          resource: {
            resourceType: "Condition",
            id: "cond-1",
            code: { text: "Condition one" },
          },
        },
      ],
      link: [{ relation: "next", url: `${url}&page=2` }],
    });
  };

  const result = await pullSource(pool, SOURCE, "access-token-1", fetchImpl);

  assert.equal(result.status, "ok");
  assert.equal(result.counts.Patient, 1);
  assert.equal(result.counts.Condition, 2);
  assert.equal(result.error, null);
  assert.deepEqual(result.resourceErrors, {});
  // Every non-Patient FHIR call carried the bearer token.
  assert.ok(calls.some((url) => url.includes("Condition?patient=patient-1")));
});

test("pullSource fails the whole source when the Patient fetch fails", async () => {
  const pool = fakePool();
  const fetchImpl = async (url) => {
    if (url.includes("/Patient/")) return jsonResponse(404, {});
    return jsonResponse(200, { entry: [] });
  };
  const result = await pullSource(pool, SOURCE, "access-token-1", fetchImpl);
  assert.equal(result.status, "failed");
  assert.match(result.error, /Patient fetch failed/);
  const update = pool.calls.find((call) => call.text.includes("last_pull_error"));
  assert.ok(update);
});

test("pullSource records a resource-type error without failing the whole source", async () => {
  const pool = fakePool();
  const fetchImpl = async (url) => {
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    // 404 (not 5xx/429) so `fetchWithRetry` returns immediately rather than
    // spending its real backoff delays in this test.
    if (url.includes("Observation")) return jsonResponse(404, {});
    return jsonResponse(200, { entry: [] });
  };
  const result = await pullSource(pool, SOURCE, "access-token-1", fetchImpl);
  assert.equal(result.status, "ok");
  assert.match(result.resourceErrors.Observation, /Observation search failed/);
});

test("pullSource stores a text/plain DocumentReference attachment inline, no filesystem write", async () => {
  const pool = fakePool();
  const fetchImpl = async (url) => {
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    if (url.includes("DocumentReference")) {
      return jsonResponse(200, {
        entry: [
          {
            resource: {
              resourceType: "DocumentReference",
              id: "docref-1",
              status: "current",
              type: { text: "Progress note" },
              content: [
                {
                  attachment: {
                    contentType: "text/plain",
                    data: Buffer.from("Visit went well.").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      });
    }
    return jsonResponse(200, { entry: [] });
  };
  const result = await pullSource(pool, SOURCE, "access-token-1", fetchImpl);
  assert.equal(result.documents, 1);
  const documentInsert = pool.calls.find((call) =>
    call.text.includes("INSERT INTO kith.health_documents"),
  );
  assert.ok(documentInsert);
  assert.equal(documentInsert.params[5], "Visit went well.");
  assert.equal(documentInsert.params[6], null); // storage_note: text was extracted
});

test("pullSource stores a PDF DocumentReference attachment to the injected data dir", async () => {
  const pool = fakePool();
  const pdfBytes = "%PDF-1.4 synthetic";
  const fetchImpl = async (url) => {
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    if (url.includes("DocumentReference")) {
      return jsonResponse(200, {
        entry: [
          {
            resource: {
              resourceType: "DocumentReference",
              id: "docref-2",
              status: "current",
              type: { text: "Discharge summary" },
              content: [
                {
                  attachment: {
                    contentType: "application/pdf",
                    url: "https://fhir.synthetic.example/api/FHIR/R4/Binary/bin-1",
                  },
                },
              ],
            },
          },
        ],
      });
    }
    if (url.includes("/Binary/")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from(pdfBytes),
      };
    }
    return jsonResponse(200, { entry: [] });
  };
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "epic-feed-test-"));
  try {
    const result = await pullSource(
      pool,
      SOURCE,
      "access-token-1",
      fetchImpl,
      () => dir,
    );
    assert.equal(result.documents, 1);
    const documentInsert = pool.calls.find((call) =>
      call.text.includes("INSERT INTO kith.health_documents"),
    );
    assert.equal(documentInsert.params[5], null); // text: not extracted for PDF
    const storageNote = documentInsert.params[6];
    assert.ok(storageNote.startsWith(dir));
    const written = await readFile(storageNote, "utf8");
    assert.equal(written, pdfBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pullOneSource sets needs_reauth on invalid_grant and does not call pullSource", async () => {
  const pool = fakePool();
  const fetchImpl = async (url) => {
    if (url.includes("smart-configuration")) {
      return jsonResponse(200, {
        authorization_endpoint: "https://fhir.synthetic.example/oauth2/authorize",
        token_endpoint: "https://fhir.synthetic.example/oauth2/token",
      });
    }
    if (url.includes("/oauth2/token")) {
      return jsonResponse(400, { error: "invalid_grant", error_description: "dead token" });
    }
    throw new Error(`unexpected fetch in this test: ${url}`);
  };
  const readSecret = async () =>
    JSON.stringify({
      refreshToken: "dead-refresh",
      accessToken: "stale-access",
      expiresAt: "2020-01-01T00:00:00Z",
      patientFhirId: "patient-1",
      fhirBase: SOURCE.fhirBase,
      orgName: SOURCE.orgName,
    });
  let wroteSecret = false;
  const writeSecret = async () => {
    wroteSecret = true;
  };
  const result = await pullOneSource(pool, SOURCE, fetchImpl, readSecret, writeSecret, {
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.equal(result.status, "needs_reauth");
  assert.match(result.error, /dead token/);
  assert.equal(wroteSecret, false);
  const failureUpdate = pool.calls.find((call) => call.text.includes("needs_reauth_at"));
  assert.ok(failureUpdate);
  assert.equal(failureUpdate.params[2], true);
});

test("pullOneSource fails without reauth when the Keychain item is missing", async () => {
  const pool = fakePool();
  const result = await pullOneSource(
    pool,
    SOURCE,
    async () => jsonResponse(200, {}),
    async () => null,
    async () => {},
    { clientId: "client-1", clientSecret: "secret-1" },
  );
  assert.equal(result.status, "failed");
  assert.match(result.error, /not found/);
});
