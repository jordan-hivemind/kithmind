import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { parseConfig, validateEndpoint } from "../dist/config.js";
import { HttpWorkerTransport, parseWorkerResponse } from "../dist/transport.js";

test("config accepts only bounded absolute worker config", () => {
  const config = parseConfig({
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space_1",
    sourceAccountId: "source_1",
    credentialEnv: "PIPELINE_TOKEN",
    roots: [{ alias: "notes", path: "/tmp/notes" }],
    journalDir: "/tmp/journal",
  });
  assert.equal(config.maxFiles, 256);
  assert.throws(() => validateEndpoint("http://example.test/api/worker"));
  assert.throws(() =>
    parseConfig({ ...config, roots: [{ alias: "notes", path: "relative" }] }),
  );
});

test("transport response parser rejects extra and malformed success fields", () => {
  const valid = JSON.stringify({
    operation: "scan.begin",
    scanId: "scan",
    inventoryEpoch: 1,
    manifestVersion: 1,
    state: "open",
    reused: false,
  });
  assert.equal(
    parseWorkerResponse(valid, "scan.begin").operation,
    "scan.begin",
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({
        operation: "scan.begin",
        scanId: "scan",
        inventoryEpoch: 1,
        manifestVersion: 1,
        state: "open",
        reused: false,
        leaked: true,
      }),
      "scan.begin",
    ),
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({ error: { code: "unknown", message: "no" } }),
      "scan.begin",
    ),
  );
});

test("strict response parsing rejects malformed status, assessment, and lease targets", () => {
  const baseStatus = {
    operation: "source.status",
    sourceAccountId: "source",
    inventoryEpoch: 1,
    completedInventoryEpoch: 1,
    manifestVersion: 1,
    enumeration: { state: "complete", completedAt: 1 },
    processing: { state: "not_assessed" },
    recordCoverage: "not_established",
  };
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({ ...baseStatus, enumeration: { state: "mystery" } }),
      "source.status",
    ),
  );
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({
        ...baseStatus,
        processing: {
          state: "complete",
          assessmentId: "assessment",
          scanId: "scan",
          inventoryEpoch: 1,
          manifestVersion: 1,
          completedAt: 1,
          counts: {
            items: { ready: -1 },
            unresolvedEntries: { needsReview: 0, ignoredForgotten: 0 },
          },
        },
      }),
      "source.status",
    ),
  );
  const reserve = {
    operation: "jobs.reserve",
    receiptId: "receipt",
    expiresAt: 1,
    reused: false,
    targets: [
      {
        jobId: "job",
        workId: "work",
        sourceItemId: "item",
        observationEpoch: 1,
        processingEpoch: 1,
        state: "processing",
        leaseEpoch: 1,
        leaseToken: "a".repeat(64),
        leaseExpiresAt: 1,
      },
    ],
  };
  for (const change of [
    { jobId: "contains/slash" },
    { state: "queued" },
    { leaseEpoch: -1 },
    { leaseToken: "secret" },
  ]) {
    assert.throws(() =>
      parseWorkerResponse(
        JSON.stringify({
          ...reserve,
          targets: [{ ...reserve.targets[0], ...change }],
        }),
        "jobs.reserve",
      ),
    );
  }
});

test("safe errors retain only an allowlisted code", () => {
  const parsed = parseWorkerResponse(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message: "reflected bearer and document body must not persist",
      },
    }),
    "scan.begin",
  );
  assert.deepEqual(parsed, { error: { code: "rate_limited" } });
  assert.equal(JSON.stringify(parsed).includes("reflected"), false);
  assert.throws(() =>
    parseWorkerResponse(
      JSON.stringify({
        error: { code: "rate_limited", message: "safe", detail: "leak" },
      }),
      "scan.begin",
    ),
  );
});

function transportConfig(endpoint) {
  return {
    protocolVersion: 1,
    endpoint,
    spaceId: "space",
    sourceAccountId: "source",
    credentialEnv: "TOKEN",
    roots: [{ alias: "root", path: "/tmp/root" }],
    journalDir: "/tmp/journal",
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
  };
}

function statusRequest() {
  return {
    protocolVersion: 1,
    operation: "source.status",
    spaceId: "space",
    sourceAccountId: "source",
  };
}

test("redirects are refused without forwarding the bearer", async () => {
  let targetRequests = 0;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.end("unexpected");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = target.address().port;
  const redirect = createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${targetPort}/api/worker`,
    });
    response.end();
  });
  await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  const redirectPort = redirect.address().port;
  try {
    const transport = new HttpWorkerTransport(
      transportConfig(`http://127.0.0.1:${redirectPort}/api/worker`),
      "sensitive-credential",
    );
    await assert.rejects(() => transport.call(statusRequest()));
    assert.equal(targetRequests, 0);
  } finally {
    await new Promise((resolve) => redirect.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  }
});

test("declared and streamed oversized responses are aborted", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const declared of [true, false]) {
      let signal;
      globalThis.fetch = async (_url, options) => {
        signal = options.signal;
        const bytes = "x".repeat(512 * 1024 + 1);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(declared ? { "content-length": String(bytes.length) } : {}),
          },
        });
      };
      const transport = new HttpWorkerTransport(
        transportConfig("http://127.0.0.1:3100/api/worker"),
        "credential",
      );
      await assert.rejects(() => transport.call(statusRequest()));
      assert.equal(signal.aborted, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the request deadline aborts an unresolved fetch", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let signal;
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    };
    const transport = new HttpWorkerTransport(
      transportConfig("http://127.0.0.1:3100/api/worker"),
      "credential",
      5,
    );
    await assert.rejects(() => transport.call(statusRequest()));
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
