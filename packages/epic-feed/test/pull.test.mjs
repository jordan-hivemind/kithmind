// `pullSource`/`pullOneSource` against a mocked FHIR server and a fake pool
// -- no network, no Keychain, no real database.

import assert from "node:assert/strict";
import test from "node:test";

import { pullOneSource, pullSource } from "../dist/index.js";

import { fakePool } from "./helpers/fakePool.mjs";
import { inMemoryTokenStore } from "./helpers/tokenStore.mjs";

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

test("pullSource searches Observation once per registered category and merges the results", async () => {
  const pool = fakePool();
  const observationUrls = [];
  const fetchImpl = async (url) => {
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    if (url.includes("Observation")) {
      observationUrls.push(url);
      const category = new URL(url).searchParams.get("category");
      return jsonResponse(200, {
        entry: [
          {
            resource: {
              resourceType: "Observation",
              id: `obs-${category}`,
              status: "final",
              category: [{ coding: [{ code: category }] }],
              code: { text: `Observation (${category})` },
            },
          },
        ],
      });
    }
    return jsonResponse(200, { entry: [] });
  };

  const result = await pullSource(pool, SOURCE, "access-token-1", fetchImpl);

  assert.equal(result.status, "ok");
  assert.equal(result.counts.Observation, 3);
  assert.deepEqual(result.resourceErrors, {});
  assert.equal(observationUrls.length, 3);
  const categories = observationUrls.map((url) => new URL(url).searchParams.get("category"));
  assert.deepEqual(new Set(categories), new Set(["laboratory", "vital-signs", "social-history"]));
  // Every category call also carried the patient id.
  assert.ok(observationUrls.every((url) => url.includes("patient=patient-1")));
  // Each stored record keeps its own category, read off the resource rather
  // than the search parameter.
  const inserts = pool.calls.filter(
    (call) =>
      call.text.includes("INSERT INTO kith.health_records") && call.params[3] === "Observation",
  );
  assert.equal(inserts.length, 3);
  const storedCategories = new Set(inserts.map((call) => call.params[11]));
  assert.deepEqual(storedCategories, new Set(["laboratory", "vital-signs", "social-history"]));
});

test("pullSource treats a 400 on one Observation category as unsupported without losing the others", async () => {
  const pool = fakePool();
  const observationUrls = [];
  const fetchImpl = async (url) => {
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    if (url.includes("Observation")) {
      observationUrls.push(url);
      const category = new URL(url).searchParams.get("category");
      if (category === "social-history") return jsonResponse(400, { issue: "unsupported" });
      return jsonResponse(200, {
        entry: [
          {
            resource: {
              resourceType: "Observation",
              id: `obs-${category}`,
              status: "final",
              category: [{ coding: [{ code: category }] }],
              code: { text: `Observation (${category})` },
            },
          },
        ],
      });
    }
    return jsonResponse(200, { entry: [] });
  };

  const result = await pullSource(pool, SOURCE, "access-token-1", fetchImpl);

  assert.equal(result.status, "ok");
  // laboratory and vital-signs still ran and are counted, even though
  // social-history 400'd.
  assert.equal(result.counts.Observation, 2);
  assert.equal(observationUrls.length, 3);
  const categories = observationUrls.map((url) => new URL(url).searchParams.get("category"));
  assert.deepEqual(new Set(categories), new Set(["laboratory", "vital-signs", "social-history"]));
  assert.deepEqual(result.unsupported, ["Observation:social-history"]);
  // A 400 on one category is not a resource error for Observation.
  assert.equal(result.resourceErrors.Observation, undefined);
  assert.deepEqual(result.resourceErrors, {});
});

test("pullSource resolves a relative Binary url against the source's FHIR base", async () => {
  const pool = fakePool();
  const binaryUrls = [];
  const fetchImpl = async (url) => {
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    if (url.includes("DocumentReference")) {
      return jsonResponse(200, {
        entry: [
          {
            resource: {
              resourceType: "DocumentReference",
              id: "docref-3",
              status: "current",
              type: { text: "Clinical note" },
              content: [
                {
                  attachment: {
                    contentType: "text/plain",
                    url: "Binary/ew0p-relative",
                  },
                },
              ],
            },
          },
        ],
      });
    }
    if (url.includes("Binary")) {
      binaryUrls.push(url);
      return jsonResponse(
        200,
        {
          resourceType: "Binary",
          contentType: "text/plain",
          data: Buffer.from("Note from the Binary resource.").toString("base64"),
        },
        { "content-type": "application/fhir+json" },
      );
    }
    return jsonResponse(200, { entry: [] });
  };

  const result = await pullSource(pool, SOURCE, "access-token-1", fetchImpl);

  assert.equal(result.documents, 1);
  assert.equal(binaryUrls.length, 1);
  assert.equal(binaryUrls[0], "https://fhir.synthetic.example/api/FHIR/R4/Binary/ew0p-relative");
  const documentInsert = pool.calls.find((call) =>
    call.text.includes("INSERT INTO kith.health_documents"),
  );
  // The Binary resource's own `data` (base64) was read and decoded --
  // text/plain is extracted, so no filesystem write happens.
  assert.equal(documentInsert.params[5], "Note from the Binary resource.");
  assert.equal(documentInsert.params[6], null);
});

test("pullSource leaves an absolute Binary url untouched", async () => {
  const pool = fakePool();
  const binaryUrls = [];
  const absoluteUrl = "https://other.example/FHIR/R4/Binary/abs-1";
  const fetchImpl = async (url) => {
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    if (url.includes("DocumentReference")) {
      return jsonResponse(200, {
        entry: [
          {
            resource: {
              resourceType: "DocumentReference",
              id: "docref-4",
              status: "current",
              type: { text: "Clinical note" },
              content: [{ attachment: { contentType: "text/plain", url: absoluteUrl } }],
            },
          },
        ],
      });
    }
    if (url === absoluteUrl) {
      binaryUrls.push(url);
      return jsonResponse(
        200,
        {
          resourceType: "Binary",
          contentType: "text/plain",
          data: Buffer.from("Note from the Binary resource.").toString("base64"),
        },
        { "content-type": "application/fhir+json" },
      );
    }
    return jsonResponse(200, { entry: [] });
  };

  const result = await pullSource(pool, SOURCE, "access-token-1", fetchImpl);

  assert.equal(result.documents, 1);
  assert.deepEqual(binaryUrls, [absoluteUrl]);
});

test("pullSource treats a Specimen 400 as unsupported, not a resource error", async () => {
  const pool = fakePool();
  const fetchImpl = async (url) => {
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    if (url.includes("Specimen")) return jsonResponse(400, { issue: "unsupported" });
    return jsonResponse(200, { entry: [] });
  };

  const result = await pullSource(pool, SOURCE, "access-token-1", fetchImpl);

  assert.equal(result.status, "ok");
  assert.deepEqual(result.unsupported, ["Specimen"]);
  assert.equal(result.resourceErrors.Specimen, undefined);
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
  const originalToken = JSON.stringify({
    refreshToken: "dead-refresh",
    accessToken: "stale-access",
    expiresAt: "2020-01-01T00:00:00Z",
    patientFhirId: "patient-1",
    fhirBase: SOURCE.fhirBase,
    orgName: SOURCE.orgName,
  });
  const tokenStore = inMemoryTokenStore({ [SOURCE.keychainService]: originalToken });
  const result = await pullOneSource(pool, SOURCE, fetchImpl, tokenStore, {
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.equal(result.status, "needs_reauth");
  assert.match(result.error, /dead token/);
  // A dead refresh token must not be rewritten -- the stored token is
  // exactly what it was before this failed attempt.
  assert.equal(tokenStore.items.get(SOURCE.keychainService), originalToken);
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
    inMemoryTokenStore(),
    { clientId: "client-1", clientSecret: "secret-1" },
  );
  assert.equal(result.status, "failed");
  assert.match(result.error, /not found/);
});

// Migration coverage for a `health_sources` row written before
// `tokenKeychainService` suffixed its Keychain item name with the org slug
// (see `config.ts`/`pull.ts`'s `resolveKeychainService`). `SOURCE.keychainService`
// ("com.kithmind.epic.token.synthetic") is itself such a pre-migration,
// unsuffixed name for `SOURCE.orgName` ("Synthetic Health System" ->
// org slug "synthetic-health-system").
test("pullOneSource keeps reading a pre-migration Keychain item when no suffixed item exists (no rename)", async () => {
  const pool = fakePool();
  const fetchImpl = async (url) => {
    if (url.includes("smart-configuration") || url.includes("/oauth2/token")) {
      throw new Error(`unexpected token-refresh fetch in this test: ${url}`);
    }
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    return jsonResponse(200, { entry: [] });
  };
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const originalToken = JSON.stringify({
    refreshToken: null,
    accessToken: "pre-migration-access",
    expiresAt,
    patientFhirId: "patient-1",
    fhirBase: SOURCE.fhirBase,
    orgName: SOURCE.orgName,
  });
  // Only the pre-migration, unsuffixed item exists -- the suffixed name
  // ("...synthetic.synthetic-health-system") was never written.
  const tokenStore = inMemoryTokenStore({ [SOURCE.keychainService]: originalToken });
  const result = await pullOneSource(pool, SOURCE, fetchImpl, tokenStore, {
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.equal(result.status, "ok");
  // No rename: still exactly one item, at the original, unsuffixed name.
  assert.equal(tokenStore.items.size, 1);
  assert.ok(tokenStore.items.has(SOURCE.keychainService));
});

test("pullOneSource prefers an already-migrated suffixed Keychain item over the stored unsuffixed name", async () => {
  const pool = fakePool();
  const fetchImpl = async (url) => {
    if (url.includes("smart-configuration") || url.includes("/oauth2/token")) {
      throw new Error(`unexpected token-refresh fetch in this test: ${url}`);
    }
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    return jsonResponse(200, { entry: [] });
  };
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const migratedToken = JSON.stringify({
    refreshToken: null,
    accessToken: "migrated-access",
    expiresAt,
    patientFhirId: "patient-1",
    fhirBase: SOURCE.fhirBase,
    orgName: SOURCE.orgName,
  });
  const suffixedService = `${SOURCE.keychainService}.synthetic-health-system`;
  const tokenStore = inMemoryTokenStore({ [suffixedService]: migratedToken });
  const result = await pullOneSource(pool, SOURCE, fetchImpl, tokenStore, {
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.equal(result.status, "ok");
  assert.equal(tokenStore.items.size, 1);
  assert.ok(tokenStore.items.has(suffixedService));
});

test("pullOneSource pulls with an unexpired access token when no refresh token is stored", async () => {
  const pool = fakePool();
  // No `smart-configuration`/`/oauth2/token` call is expected -- there is no
  // refresh token to refresh with, and this test throws if either is
  // fetched anyway.
  const fetchImpl = async (url) => {
    if (url.includes("smart-configuration") || url.includes("/oauth2/token")) {
      throw new Error(`unexpected token-refresh fetch in this test: ${url}`);
    }
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    return jsonResponse(200, { entry: [] });
  };
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const originalToken = JSON.stringify({
    refreshToken: null,
    accessToken: "sandbox-access-only",
    expiresAt,
    patientFhirId: "patient-1",
    fhirBase: SOURCE.fhirBase,
    orgName: SOURCE.orgName,
  });
  const tokenStore = inMemoryTokenStore({ [SOURCE.keychainService]: originalToken });
  const result = await pullOneSource(pool, SOURCE, fetchImpl, tokenStore, {
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.counts.Patient, 1);
  assert.match(result.tokenNote, /^access token only; expires in \d+ minutes$/);
  // Nothing was refreshed, so the stored token is untouched.
  assert.equal(tokenStore.items.get(SOURCE.keychainService), originalToken);
});

test("pullOneSource marks needs_reauth when no refresh token is stored and the access token has expired", async () => {
  const pool = fakePool();
  const fetchImpl = async (url) => {
    throw new Error(`unexpected fetch in this test: ${url}`);
  };
  const originalToken = JSON.stringify({
    refreshToken: null,
    accessToken: "sandbox-access-only",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    patientFhirId: "patient-1",
    fhirBase: SOURCE.fhirBase,
    orgName: SOURCE.orgName,
  });
  const tokenStore = inMemoryTokenStore({ [SOURCE.keychainService]: originalToken });
  const result = await pullOneSource(pool, SOURCE, fetchImpl, tokenStore, {
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.equal(result.status, "needs_reauth");
  assert.match(result.error, /No refresh token stored/);
  assert.equal(tokenStore.items.get(SOURCE.keychainService), originalToken);
  const failureUpdate = pool.calls.find((call) => call.text.includes("needs_reauth_at"));
  assert.ok(failureUpdate);
  assert.equal(failureUpdate.params[2], true);
});

function fetchImplForRefresh(tokenCalls) {
  return async (url, init) => {
    if (url.includes("smart-configuration")) {
      return jsonResponse(200, {
        authorization_endpoint: "https://fhir.synthetic.example/oauth2/authorize",
        token_endpoint: "https://fhir.synthetic.example/oauth2/token",
      });
    }
    if (url.includes("/oauth2/token")) {
      tokenCalls.push(init);
      return jsonResponse(200, {
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      });
    }
    if (url.includes("/Patient/")) return jsonResponse(200, patientResource());
    return jsonResponse(200, { entry: [] });
  };
}

test("pullOneSource refreshes with HTTP Basic when the stored token's clientAuth is secret", async () => {
  const pool = fakePool();
  const tokenCalls = [];
  const originalToken = JSON.stringify({
    refreshToken: "old-refresh",
    accessToken: "stale-access",
    expiresAt: "2020-01-01T00:00:00Z",
    patientFhirId: "patient-1",
    fhirBase: SOURCE.fhirBase,
    orgName: SOURCE.orgName,
    clientAuth: "secret",
  });
  const tokenStore = inMemoryTokenStore({ [SOURCE.keychainService]: originalToken });
  const result = await pullOneSource(pool, SOURCE, fetchImplForRefresh(tokenCalls), tokenStore, {
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.equal(result.status, "ok");
  assert.equal(tokenCalls.length, 1);
  assert.equal(
    tokenCalls[0].headers.authorization,
    `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`,
  );
  const body = new URLSearchParams(tokenCalls[0].body);
  assert.equal(body.get("client_id"), null);
  const updated = JSON.parse(tokenStore.items.get(SOURCE.keychainService));
  assert.equal(updated.clientAuth, "secret");
  assert.equal(updated.accessToken, "fresh-access");
});

test("pullOneSource treats a stored token with no clientAuth field as secret (Basic)", async () => {
  const pool = fakePool();
  const tokenCalls = [];
  const originalToken = JSON.stringify({
    refreshToken: "old-refresh",
    accessToken: "stale-access",
    expiresAt: "2020-01-01T00:00:00Z",
    patientFhirId: "patient-1",
    fhirBase: SOURCE.fhirBase,
    orgName: SOURCE.orgName,
    // No clientAuth field -- a token written before this field existed.
  });
  const tokenStore = inMemoryTokenStore({ [SOURCE.keychainService]: originalToken });
  const result = await pullOneSource(pool, SOURCE, fetchImplForRefresh(tokenCalls), tokenStore, {
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.equal(result.status, "ok");
  assert.equal(
    tokenCalls[0].headers.authorization,
    `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`,
  );
  const updated = JSON.parse(tokenStore.items.get(SOURCE.keychainService));
  assert.equal(updated.clientAuth, "secret");
});

test("pullOneSource refreshes with client_id in the body, no Authorization header, when the stored token's clientAuth is public", async () => {
  const pool = fakePool();
  const tokenCalls = [];
  const originalToken = JSON.stringify({
    refreshToken: "old-refresh",
    accessToken: "stale-access",
    expiresAt: "2020-01-01T00:00:00Z",
    patientFhirId: "patient-1",
    fhirBase: SOURCE.fhirBase,
    orgName: SOURCE.orgName,
    clientAuth: "public",
  });
  const tokenStore = inMemoryTokenStore({ [SOURCE.keychainService]: originalToken });
  const result = await pullOneSource(pool, SOURCE, fetchImplForRefresh(tokenCalls), tokenStore, {
    clientId: "client-1",
    clientSecret: null,
  });
  assert.equal(result.status, "ok");
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].headers.authorization, undefined);
  const body = new URLSearchParams(tokenCalls[0].body);
  assert.equal(body.get("client_id"), "client-1");
  const updated = JSON.parse(tokenStore.items.get(SOURCE.keychainService));
  assert.equal(updated.clientAuth, "public");
  assert.equal(updated.accessToken, "fresh-access");
});
