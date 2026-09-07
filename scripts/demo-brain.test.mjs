import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig, runDemo } from "./demo-brain.mjs";

const environment = {
  KITHMIND_URL: "https://brain.example.test",
  KITHMIND_API_KEY: "secret-key",
  KITHMIND_SPACE_ID: "space-id",
  KITHMIND_SOURCE_ACCOUNT_ID: "desktop-capture",
};

const demoScript = fileURLToPath(new URL("./demo-brain.mjs", import.meta.url));

function runDemoCli(script) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {},
  });
}

test("direct CLI invocation reports missing configuration", () => {
  const result = runDemoCli(demoScript);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "demo: configuration invalid\n");
});

test("symlink CLI invocation runs instead of silently exiting", () => {
  const directory = mkdtempSync(join(tmpdir(), "kithmind-demo-"));
  const link = join(directory, "demo-brain.mjs");
  try {
    symlinkSync(realpathSync(demoScript), link);
    const result = runDemoCli(link);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "demo: configuration invalid\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch() {
  const calls = [];
  const ids = new Map();
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const body = JSON.parse(options.body);
      if (url.endsWith("/api/ingest")) {
        const id = ids.get(body.requestId) ?? `document-${ids.size + 1}`;
        ids.set(body.requestId, id);
        return json({
          documentId: id,
          sourceRevisionId: `revision-${id}`,
          state: "ready",
          isActive: true,
        });
      }
      const { name, arguments: args } = body.params;
      const documentId =
        name === "get_document"
          ? args.documentId
          : ids.get(
              args.query.includes("service")
                ? "kithmind-demo-service-20260907"
                : "kithmind-demo-lab-20260907",
            );
      const evidence =
        documentId === "document-1"
          ? "KITHMIND-DEMO-SERVICE-MARKER: café 🚗 service record."
          : "KITHMIND-DEMO-LAB-MARKER: naïve sample α retained.";
      const result =
        name === "search_documents"
          ? { results: [{ documentId }] }
          : {
              documentId,
              sourceRevisionId: `revision-${documentId}`,
              retainedTextAvailable: true,
              pages: [
                {
                  text: evidence,
                  evidence: [{ quote: evidence, evidenceSpanId: "span-1" }],
                },
              ],
            };
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      });
    },
  };
}

test("accepts only a safe gateway origin", () => {
  assert.equal(loadConfig(environment).baseUrl, environment.KITHMIND_URL);
  for (const url of [
    "http://brain.example.test",
    "https://user:pass@brain.example.test",
    "https://brain.example.test/api/mcp",
    "https://brain.example.test/?key=secret",
    "https://brain.example.test/#secret",
  ]) {
    assert.throws(
      () => loadConfig({ ...environment, KITHMIND_URL: url }),
      /configuration invalid/u,
    );
  }
  assert.equal(
    loadConfig({ ...environment, KITHMIND_URL: "http://localhost:3000" })
      .baseUrl,
    "http://localhost:3000",
  );
});

test("replays two fixed synthetic documents and verifies retained Unicode evidence", async () => {
  const transport = mockFetch();
  const output = [];
  const result = await runDemo({
    environment,
    fetchImpl: transport.fetch,
    output: (line) => output.push(line),
  });
  assert.deepEqual(result.documentIds, ["document-1", "document-2"]);
  assert.equal(
    transport.calls.filter(({ url }) => url.endsWith("/api/ingest")).length,
    4,
  );
  assert.equal(
    transport.calls.every(({ options }) => options.redirect === "error"),
    true,
  );
  const searchCalls = transport.calls.filter(({ url }) =>
    url.endsWith("/api/mcp"),
  );
  assert.equal(
    searchCalls
      .filter(
        ({ options }) =>
          JSON.parse(options.body).params.name === "search_documents",
      )
      .every(
        ({ options }) =>
          JSON.parse(options.body).params.arguments.searchMode === "keyword",
      ),
    true,
  );
  assert.deepEqual(output, [
    "demo: synthetic documents ingested, replayed, and retrieved",
  ]);
  assert.equal(
    JSON.stringify(output).includes(environment.KITHMIND_API_KEY),
    false,
  );
});

test("does not expose a server response or secret when a request fails", async () => {
  const secretResponse = `upstream leaked ${environment.KITHMIND_API_KEY}`;
  await assert.rejects(
    runDemo({
      environment,
      fetchImpl: async () => new Response(secretResponse, { status: 500 }),
      output: () => assert.fail("must not report success"),
    }),
    (error) =>
      error.message === "demo: request failed" &&
      !error.message.includes(environment.KITHMIND_API_KEY),
  );
});

test("converts malicious transport errors into a fixed safe failure", async () => {
  await assert.rejects(
    runDemo({
      environment,
      fetchImpl: async () => {
        throw new Error(`demo: ${environment.KITHMIND_API_KEY}`);
      },
      output: () => assert.fail("must not report success"),
    }),
    (error) =>
      error.message === "demo: request failed" &&
      !error.message.includes(environment.KITHMIND_API_KEY),
  );
});

test("rejects an MCP error envelope even when it contains expected evidence", async () => {
  const transport = mockFetch();
  transport.fetch = async (url, options) => {
    if (url.endsWith("/api/ingest")) {
      const body = JSON.parse(options.body);
      return json({
        documentId: "document-1",
        sourceRevisionId: "revision-document-1",
        state: "ready",
        isActive: true,
      });
    }
    return json({
      jsonrpc: "2.0",
      id: JSON.parse(options.body).id,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              pages: [
                {
                  text: "KITHMIND-DEMO-SERVICE-MARKER: café 🚗 service record.",
                },
              ],
            }),
          },
        ],
      },
    });
  };
  await assert.rejects(
    runDemo({
      environment,
      fetchImpl: transport.fetch,
      output: () => undefined,
    }),
    /demo: response rejected/u,
  );
});

test("rejects an MCP response whose JSON-RPC id does not match the request", async () => {
  const transport = mockFetch();
  const originalFetch = transport.fetch;
  transport.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (!url.endsWith("/api/mcp")) return response;
    const body = await response.json();
    body.id = 999;
    return json(body);
  };
  await assert.rejects(
    runDemo({
      environment,
      fetchImpl: transport.fetch,
      output: () => undefined,
    }),
    /demo: response rejected/u,
  );
});

test("rejects oversized and truncated responses without surfacing transport text", async () => {
  for (const response of [
    new Response("x".repeat(512 * 1024 + 1), { status: 200 }),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("transport secret"));
        },
      }),
      { status: 200 },
    ),
  ]) {
    await assert.rejects(
      runDemo({
        environment,
        fetchImpl: async () => response,
        output: () => undefined,
      }),
      (error) =>
        error.message === "demo: request failed" ||
        error.message === "demo: response rejected",
    );
  }
});

test("rejects redirect responses without following them", async () => {
  const requests = [];
  await assert.rejects(
    runDemo({
      environment,
      fetchImpl: async (_url, options) => {
        requests.push(options);
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example.test/collect" },
        });
      },
      output: () => assert.fail("must not report success"),
    }),
    /demo: request failed/u,
  );
  assert.equal(requests[0].redirect, "error");
});
