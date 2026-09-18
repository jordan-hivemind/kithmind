import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MAX_INGEST_JSON_BYTES, MAX_INGEST_TEXT_BYTES } from "./http";

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  authenticateApiKey: vi.fn(),
}));

vi.mock("@/lib/mcp/auth", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
}));

// The route opens no pool of its own: the store takes one and this suite is
// about the transport in front of it, so the lane is stubbed and the pool is
// never touched.
vi.mock("@/lib/kith/pool", () => ({ kithPool: () => ({}) }));

vi.mock("@repo/kith-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/kith-store")>();
  return {
    ...actual,
    ingestion: { ...actual.ingestion, ingestInlineText: mocks.ingest },
  };
});

import { POST } from "../../app/api/ingest/route";

const validPayload = {
  spaceId: "space-1",
  requestId: "request-1",
  expectedDesiredProcessingEpoch: 0,
  source: {
    connector: "mcp-client" as const,
    accountId: "account-1",
    externalId: "item-1",
    uri: "https://example.test/item-1",
    capturedAt: "2026-09-06T12:34:56.000Z",
  },
  title: "Synthetic note",
  text: "Synthetic body",
  docType: "note",
};

const readyResult = {
  sourceItemId: "source-item-1",
  sourceRevisionId: "source-revision-1",
  processingGenerationId: "generation-1",
  ingestJobId: "job-1",
  documentId: "document-1",
  desiredProcessingEpoch: 1,
  isActive: true,
  state: "ready",
};

function request(
  body: BodyInit = JSON.stringify(validPayload),
  headers: Record<string, string> = {},
): Request {
  return new Request("https://brain.example.test/api/ingest", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("POST /api/ingest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticateApiKey.mockResolvedValue({
      userId: "user-1",
      keyId: "key-1",
    });
    mocks.ingest.mockResolvedValue(readyResult);
  });

  afterEach(() => vi.unstubAllEnvs());

  test("rejects a request without a valid bearer credential", async () => {
    mocks.authenticateApiKey.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="ingest"',
    );
    expect(await responseBody(response)).toEqual({
      error: { code: "unauthorized", message: "Unauthorized" },
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  test("stops an oversized streamed body before JSON parsing", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(Math.floor(MAX_INGEST_JSON_BYTES / 2) + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel,
    });
    const streamedRequest = new Request(
      "https://brain.example.test/api/ingest",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );

    const response = await POST(streamedRequest);

    expect(response.status).toBe(413);
    expect(await responseBody(response)).toMatchObject({
      error: { code: "payload_too_large" },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  test.each([
    ["text/plain", "{}", 415, "unsupported_media_type"],
    ["application/problem+json", "{}", 415, "unsupported_media_type"],
    ["application/json", "{", 400, "invalid_json"],
  ])(
    "rejects invalid content type or JSON: %s",
    async (contentType, body, status, code) => {
      const response = await POST(
        request(body, { "Content-Type": contentType }),
      );

      expect(response.status).toBe(status);
      expect(await responseBody(response)).toMatchObject({ error: { code } });
      expect(mocks.ingest).not.toHaveBeenCalled();
    },
  );

  test("rejects malformed UTF-8 before parsing", async () => {
    const response = await POST(request(new Uint8Array([0xc3, 0x28])));

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({
      error: {
        code: "invalid_json",
        message: "Request body must be valid UTF-8 JSON",
      },
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  test("rejects text above the decoded UTF-8 limit", async () => {
    const response = await POST(
      request(
        JSON.stringify({
          ...validPayload,
          text: `${"a".repeat(MAX_INGEST_TEXT_BYTES - 1)}😀`,
        }),
      ),
    );

    expect(response.status).toBe(413);
    expect(await responseBody(response)).toMatchObject({
      error: { code: "text_too_large" },
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  test("enforces the configured source-account identity byte limit", async () => {
    const response = await POST(
      request(
        JSON.stringify({
          ...validPayload,
          source: {
            ...validPayload.source,
            accountId: "é".repeat(257),
          },
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  test("enforces byte limits on request and external identities", async () => {
    for (const payload of [
      { ...validPayload, requestId: "é".repeat(65) },
      {
        ...validPayload,
        source: {
          ...validPayload.source,
          externalId: "é".repeat(1_025),
        },
      },
    ]) {
      const response = await POST(request(JSON.stringify(payload)));
      expect(response.status).toBe(400);
      expect(mocks.ingest).not.toHaveBeenCalled();
    }
  });

  test.each([
    "2026-09-06T12:34:56.1234Z",
    "2026-09-06T12:34:56-00:00",
    "2026-09-06T12:34:56+14:01",
  ])("rejects an unsupported capturedAt instant: %s", async (capturedAt) => {
    const response = await POST(
      request(
        JSON.stringify({
          ...validPayload,
          source: { ...validPayload.source, capturedAt },
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  test("rejects whitespace-only inline text", async () => {
    const response = await POST(
      request(JSON.stringify({ ...validPayload, text: " \n\t " })),
    );

    expect(response.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  test("rejects an escaped unpaired surrogate instead of hashing replacement bytes", async () => {
    const response = await POST(
      request(JSON.stringify({ ...validPayload, text: "\ud800" })),
    );

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({
      error: {
        code: "invalid_request",
        message: "text must contain valid Unicode",
      },
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  test("forwards the validated contract to the lane under the authenticated principal", async () => {
    mocks.ingest.mockResolvedValue({
      ...readyResult,
      internalWorkId: "secret",
    });
    const response = await POST(request());

    expect(response.status).toBe(200);
    // Only the published fields are serialized: `internalWorkId` does not
    // cross the boundary because the route builds the body field by field.
    expect(await responseBody(response)).toEqual(readyResult);
    expect(mocks.authenticateApiKey).toHaveBeenCalledWith("Bearer test-key");
    // The principal reference is the two identifiers the authenticator
    // returned, never anything the body named.
    expect(mocks.ingest.mock.calls[0]![1]).toEqual({
      userId: "user-1",
      credentialId: "key-1",
    });
    expect(mocks.ingest.mock.calls[0]![2]).toEqual(validPayload);
  });

  test.each([
    ["queued", 202],
    ["needs_review", 202],
    ["failed", 500],
  ])(
    "returns a suitable HTTP status for backend state %s",
    async (state, status) => {
      mocks.ingest.mockResolvedValue({
        ...readyResult,
        documentId: undefined,
        isActive: false,
        state,
      });

      const response = await POST(
        request(JSON.stringify(validPayload), {
          "Content-Type": "application/json; charset=utf-8",
        }),
      );

      expect(response.status).toBe(status);
      expect(await responseBody(response)).toMatchObject({ state });
    },
  );

  test("requires the caller to send the initial zero processing epoch", async () => {
    const withoutEpoch = Object.fromEntries(
      Object.entries(validPayload).filter(
        ([key]) => key !== "expectedDesiredProcessingEpoch",
      ),
    );
    const response = await POST(request(JSON.stringify(withoutEpoch)));

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  // Every code in the published table, by the message the lane throws for it.
  // `inlineIngestErrorCode` matches these exactly, so a message changed in the
  // store without changing its classifier turns one of these into a 500.
  test.each([
    ["Not authenticated", 401, "unauthorized"],
    ["Source account not found", 403, "forbidden"],
    ["Space not found", 403, "forbidden"],
    ["Default ingest space is not available", 403, "forbidden"],
    ["requestId conflicts with a different request", 409, "conflict"],
    ["Desired processing epoch conflict", 409, "conflict"],
    ["Source item is not available for admission", 409, "conflict"],
    ["Source item is forgetting", 409, "conflict"],
    ["Source item is forgotten", 409, "conflict"],
    ["Ingest rate limit exceeded", 429, "rate_limited"],
    ["source.externalId is invalid", 400, "invalid_request"],
    ["source.capturedAt must be an RFC3339 instant", 400, "invalid_request"],
    ["title contains malformed UTF-16", 400, "invalid_request"],
  ])("maps the public lane error %s", async (message, status, code) => {
    mocks.ingest.mockRejectedValue(new Error(message));

    const response = await POST(request());

    expect(response.status).toBe(status);
    expect(await responseBody(response)).toEqual({
      error: {
        code,
        message:
          code === "invalid_request"
            ? "Invalid ingest request"
            : message === "Source item is forgetting" ||
                message === "Source item is forgotten"
              ? "Source item is not available for admission"
              : message,
      },
    });
  });

  test.each([
    "secret database table and stack details",
    "Internal database index must be unique",
  ])("does not expose unexpected backend failure: %s", async (message) => {
    mocks.ingest.mockRejectedValue(new Error(message));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await responseBody(response)).toEqual({
      error: { code: "ingest_failed", message: "Ingestion failed" },
    });
  });
});
