import { describe, expect, test } from "vitest";

import {
  BASELINE_EMBEDDING_DIMENSIONS,
  BASELINE_EMBEDDING_ENDPOINT,
  BASELINE_EMBEDDING_MODEL,
  BASELINE_EMBEDDING_MODEL_REVISION,
  BASELINE_EMBEDDING_PROVIDER_ID,
  embeddingProfile,
  fingerprintEmbeddingConfig,
  loadEmbeddingConfig,
  requestEmbedding,
  type EmbeddingFetch,
} from "./embeddingProvider";

const vector = Array.from(
  { length: BASELINE_EMBEDDING_DIMENSIONS },
  (_, index) => index / 10,
);

function successfulResponse(model = BASELINE_EMBEDDING_MODEL): Response {
  return new Response(
    JSON.stringify({ model, data: [{ embedding: vector }] }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("embedding provider configuration", () => {
  test("uses an explicit local compatibility declaration for the legacy deployment", () => {
    const config = loadEmbeddingConfig({});

    expect(config).toMatchObject({
      endpoint: BASELINE_EMBEDDING_ENDPOINT,
      providerId: BASELINE_EMBEDDING_PROVIDER_ID,
      model: BASELINE_EMBEDDING_MODEL,
      modelRevision: BASELINE_EMBEDDING_MODEL_REVISION,
      dimensions: BASELINE_EMBEDDING_DIMENSIONS,
    });
  });

  test("rejects a dimension that cannot query the current vector index", () => {
    expect(() =>
      loadEmbeddingConfig({ BRAIN_EMBED_DIMENSIONS: "3072" }),
    ).toThrow("current vector index");
  });

  test("requires explicit provider identity for custom endpoints", () => {
    expect(() =>
      loadEmbeddingConfig({
        BRAIN_EMBED_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      }),
    ).toThrow("BRAIN_EMBED_PROVIDER_ID must be explicitly configured");

    expect(() =>
      loadEmbeddingConfig({
        BRAIN_EMBED_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
        BRAIN_EMBED_PROVIDER_ID: "example",
      }),
    ).toThrow("BRAIN_EMBED_MODEL_REVISION must be explicitly configured");
  });

  test("does not permit URL credentials and only permits loopback HTTP in development", () => {
    expect(() =>
      loadEmbeddingConfig({
        BRAIN_EMBED_ENDPOINT: "https://key@example.test/v1/embeddings",
      }),
    ).toThrow("must not contain credentials");
    expect(() =>
      loadEmbeddingConfig({
        BRAIN_EMBED_ENDPOINT: "http://localhost:8000/v1/embeddings",
      }),
    ).toThrow("must use HTTPS");

    expect(
      loadEmbeddingConfig({
        NODE_ENV: "development",
        BRAIN_EMBED_ENDPOINT: "http://localhost:8000/v1/embeddings",
        BRAIN_EMBED_PROVIDER_ID: "local",
        BRAIN_EMBED_MODEL_REVISION: "test-v1",
      }).endpoint,
    ).toBe("http://localhost:8000/v1/embeddings");

    expect(
      loadEmbeddingConfig({
        NODE_ENV: "test",
        BRAIN_EMBED_ENDPOINT: "http://[::1]:8000/v1/embeddings",
        BRAIN_EMBED_PROVIDER_ID: "local",
        BRAIN_EMBED_MODEL_REVISION: "test-v1",
      }).endpoint,
    ).toBe("http://[::1]:8000/v1/embeddings");
  });

  test("accepts slash-separated model identifiers with an explicit revision", () => {
    expect(
      loadEmbeddingConfig({
        BRAIN_EMBED_MODEL: "org/embedding-model",
        BRAIN_EMBED_MODEL_REVISION: "org-model-v1",
      }).model,
    ).toBe("org/embedding-model");
  });

  test("keeps endpoint and keys out of the fingerprint", async () => {
    const defaultConfig = loadEmbeddingConfig({ BRAIN_EMBED_API_KEY: "first" });
    const sameProfileElsewhere = {
      ...defaultConfig,
      endpoint: "https://another.example.test/v1/embeddings",
      apiKey: "second",
    };

    await expect(
      fingerprintEmbeddingConfig(embeddingProfile(defaultConfig)),
    ).resolves.toBe(await fingerprintEmbeddingConfig(sameProfileElsewhere));
  });
});

describe("embedding provider requests", () => {
  test("uses OPENAI_API_KEY only for the exact official default endpoint", async () => {
    const official = loadEmbeddingConfig({ OPENAI_API_KEY: "official-key" });
    let officialHeaders: Headers | undefined;
    let officialBody: string | undefined;
    let officialRedirect: RequestRedirect | undefined;
    const fetchOfficial: EmbeddingFetch = async (_input, init) => {
      officialHeaders = new Headers(init.headers);
      officialBody = init.body as string;
      officialRedirect = init.redirect;
      return successfulResponse();
    };

    await expect(
      requestEmbedding("hello", official, fetchOfficial),
    ).resolves.toMatchObject({
      vector,
      profile: { model: BASELINE_EMBEDDING_MODEL },
    });
    expect(officialHeaders?.get("authorization")).toBe("Bearer official-key");
    expect(JSON.parse(officialBody ?? "{}")).toMatchObject({
      model: BASELINE_EMBEDDING_MODEL,
      input: "hello",
      dimensions: BASELINE_EMBEDDING_DIMENSIONS,
    });
    expect(officialRedirect).toBe("error");

    const custom = loadEmbeddingConfig({
      BRAIN_EMBED_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      BRAIN_EMBED_PROVIDER_ID: "example",
      BRAIN_EMBED_MODEL_REVISION: "example-v1",
      OPENAI_API_KEY: "must-not-leak",
    });
    let customHeaders: Headers | undefined;
    const fetchCustom: EmbeddingFetch = async (_input, init) => {
      customHeaders = new Headers(init.headers);
      return successfulResponse();
    };
    await requestEmbedding("hello", custom, fetchCustom);
    expect(customHeaders?.get("authorization")).toBeNull();
  });

  test("uses the explicitly configured key for a custom endpoint", async () => {
    const config = loadEmbeddingConfig({
      BRAIN_EMBED_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      BRAIN_EMBED_PROVIDER_ID: "example",
      BRAIN_EMBED_MODEL_REVISION: "example-v1",
      BRAIN_EMBED_API_KEY: "custom-key",
    });
    let headers: Headers | undefined;
    const fetchMock: EmbeddingFetch = async (_input, init) => {
      headers = new Headers(init.headers);
      return successfulResponse();
    };

    await requestEmbedding("hello", config, fetchMock);
    expect(headers?.get("authorization")).toBe("Bearer custom-key");
  });

  test("rejects additional vectors, mismatched models, and malformed values without exposing provider output", async () => {
    const config = loadEmbeddingConfig({
      OPENAI_API_KEY: "synthetic-test-key",
    });
    const cases = [
      { data: [{ embedding: vector }, { embedding: vector }] },
      { model: "different-model", data: [{ embedding: vector }] },
      { data: [{ embedding: [...vector.slice(0, -1), Number.NaN] }] },
    ];

    for (const payload of cases) {
      const fetchMock: EmbeddingFetch = async () =>
        new Response(JSON.stringify(payload), { status: 200 });
      await expect(
        requestEmbedding("hello", config, fetchMock),
      ).rejects.toThrow("Embedding request failed");
    }
  });

  test("does not leak provider error bodies", async () => {
    const config = loadEmbeddingConfig({
      OPENAI_API_KEY: "synthetic-test-key",
    });
    const fetchMock: EmbeddingFetch = async () =>
      new Response("secret provider diagnostic", {
        status: 401,
        statusText: "secret",
      });

    await expect(requestEmbedding("hello", config, fetchMock)).rejects.toThrow(
      "Embedding request failed",
    );
  });

  test("rejects empty and zero vectors before accepting a semantic result", async () => {
    const config = loadEmbeddingConfig({
      OPENAI_API_KEY: "synthetic-test-key",
    });
    let called = false;
    const fetchMock: EmbeddingFetch = async () => {
      called = true;
      return successfulResponse();
    };
    await expect(requestEmbedding("", config, fetchMock)).rejects.toThrow(
      "Embedding input must not be empty",
    );
    expect(called).toBe(false);

    const zeroResponse: EmbeddingFetch = async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0) }],
        }),
        { status: 200 },
      );
    await expect(
      requestEmbedding("hello", config, zeroResponse),
    ).rejects.toThrow("Embedding request failed");
  });
});

test("does not send input to the official provider without credentials", async () => {
  let called = false;
  const fetchMock: EmbeddingFetch = async () => {
    called = true;
    return successfulResponse();
  };
  await expect(
    requestEmbedding("private query", loadEmbeddingConfig({}), fetchMock),
  ).rejects.toThrow("credentials are unavailable");
  expect(called).toBe(false);
});

test("cancels rejected provider response streams", async () => {
  for (const status of [401, 200]) {
    let canceled = false;
    const fetchMock: EmbeddingFetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
        { status, headers: { "content-length": String(2 * 1024 * 1024) } },
      );
    await expect(
      requestEmbedding(
        "query",
        loadEmbeddingConfig({ OPENAI_API_KEY: "synthetic" }),
        fetchMock,
      ),
    ).rejects.toThrow("Embedding request failed");
    expect(canceled).toBe(true);
  }
});
