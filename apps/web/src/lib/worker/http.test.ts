// `/api/worker`'s envelope, with the dispatcher stubbed.
//
// i7b repointed these cases from the Convex action to
// `workers.dispatchWorkerRequest`, which is what the route calls now. What they
// pin is the route rather than the dispatcher: authentication happens before
// the body is read, an authentication outage is a 503 and not a 401, the
// content type and body bounds are enforced before dispatch, and a refusal
// leaves the route as its published code with no backend detail in it. The
// dispatcher's own behavior against a real database is `postgres-writes.test.ts`.
import { WORKER_PROTOCOL_ERROR_CODES } from "@repo/worker-protocol/request";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MAX_INGEST_JSON_BYTES } from "@/lib/ingest/http";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@/lib/mcp/auth", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
}));
// The real `workerProtocolErrorCode` is kept: it is the classifier under test
// in the last two cases, and stubbing it would compare the route with itself.
vi.mock("@repo/kith-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/kith-store")>();
  return {
    ...actual,
    workers: { ...actual.workers, dispatchWorkerRequest: mocks.dispatch },
  };
});
vi.mock("@/lib/kith/pool", () => ({ kithPool: () => ({}) }));

import { POST } from "../../app/api/worker/route";

const validPayload = {
  protocolVersion: 1,
  operation: "source.status",
  spaceId: "synthetic-space",
  sourceAccountId: "synthetic-source",
};

function request(
  body: BodyInit = JSON.stringify(validPayload),
  headers: Record<string, string> = {},
) {
  return new Request("https://brain.example.test/api/worker", {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic-key",
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

describe("POST /api/worker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticateApiKey.mockResolvedValue({
      userId: "user-1",
      keyId: "key-1",
    });
    mocks.dispatch.mockResolvedValue({
      protocolVersion: 1,
      operation: "source.status",
      inventoryEpoch: 0,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  test("authenticates before reading or dispatching a malformed body", async () => {
    mocks.authenticateApiKey.mockResolvedValue(null);
    const response = await POST(request("not JSON"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="worker"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test("distinguishes unavailable authentication from an invalid credential", async () => {
    mocks.authenticateApiKey.mockRejectedValue(
      new Error("private authentication details"),
    );
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "authentication_unavailable",
        message: "Authentication service is unavailable",
      },
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test.each([
    ["text/plain", "{}", 415],
    ["application/problem+json", "{}", 415],
    ["application/json", "{", 400],
  ])(
    "rejects invalid content type or JSON %s",
    async (contentType, body, status) => {
      const response = await POST(
        request(body, { "Content-Type": contentType }),
      );
      expect(response.status).toBe(status);
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );

  test("rejects malformed UTF-8", async () => {
    const response = await POST(request(new Uint8Array([0xc3, 0x28])));
    expect(response.status).toBe(400);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test.each([
    { ...validPayload, protocolVersion: 2 },
    { ...validPayload, operation: "models/ingestion/private:activate" },
    { ...validPayload, actor: { userId: "another-user" } },
    { ...validPayload, sourceAccountId: "\ud800" },
    { jsonrpc: "2.0", method: "source.status", params: validPayload },
  ])("rejects unknown commands and injected fields %j", async (payload) => {
    const response = await POST(request(JSON.stringify(payload)));
    expect(response.status).toBe(400);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test("bounds declared and streamed bodies before dispatch", async () => {
    const declared = await POST(
      request("{}", { "Content-Length": String(MAX_INGEST_JSON_BYTES + 1) }),
    );
    expect(declared.status).toBe(413);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_INGEST_JSON_BYTES + 1));
      },
      cancel,
    });
    const streamed = new Request("https://brain.example.test/api/worker", {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic-key",
        "Content-Type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await POST(streamed)).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test("dispatches the parsed request under the current bearer identity", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      operation: "source.status",
      inventoryEpoch: 0,
    });
    expect(mocks.authenticateApiKey).toHaveBeenCalledWith(
      "Bearer synthetic-key",
    );
    // The principal reference is the two identifiers the bearer resolved to,
    // and the request is the parsed one, not the raw body.
    expect(mocks.dispatch.mock.calls[0]![1]).toEqual({
      userId: "user-1",
      credentialId: "key-1",
    });
    expect(mocks.dispatch.mock.calls[0]![2]).toEqual(validPayload);
  });

  test.each(WORKER_PROTOCOL_ERROR_CODES)(
    "maps only the published backend code %s",
    async (code) => {
      mocks.dispatch.mockRejectedValue(
        Object.assign(new Error("private source path"), {
          data: {
            type: "worker_protocol_error",
            code,
            message: "private source path",
          },
        }),
      );
      const response = await POST(request());
      expect(response.status).toBe(
        code === "not_authenticated"
          ? 401
          : code === "not_authorized"
            ? 403
            : code === "invalid_request"
              ? 400
              : code === "not_found"
                ? 404
                : code === "rate_limited"
                  ? 429
                  : 409,
      );
      const body = await response.json();
      expect(body.error.code).toBe(code);
      expect(JSON.stringify(body)).not.toContain("private source path");
    },
  );

  test.each([
    new Error("not_authorized private details"),
    Object.assign(new Error("private details"), {
      data: { type: "worker_protocol_error", code: "unknown" },
    }),
    Object.assign(new Error("private details"), {
      data: { type: "different_error", code: "not_authorized" },
    }),
  ])("does not expose unexpected backend failures", async (error) => {
    mocks.dispatch.mockRejectedValue(error);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "worker_failed", message: "Worker operation failed" },
    });
  });
});
