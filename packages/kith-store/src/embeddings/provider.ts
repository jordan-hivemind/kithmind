// Ported from packages/convex/convex/lib/embeddingProvider.ts.
//
// Byte-identical where it matters. Every constant, the endpoint and identity
// validation, the byte and timeout bounds, the response parse and the
// fingerprint encoding are unchanged, because a fingerprint computed on
// Convex has to equal the one computed here: it is the value that binds a
// stored vector to the profile that produced it, and the cutover reads rows
// written by the other side. `test/embeddingSearch.test.mjs` pins the
// fingerprint of a fixed profile to a literal for exactly that reason.
//
// Two mechanical differences, neither observable:
//
//   * `sha256Hex`/`utf8ByteLength` came from `models/ingestion/hash`; the
//     same two lines live here rather than pulling the ingestion module in
//     for them. Node's `globalThis.crypto` is the same Web Crypto API
//     Convex's V8 runtime has, so the digest body is unchanged.
//   * `fetch` is injectable (it already was, as `fetchImpl`). Tests never
//     reach the network.
//
// Nothing here imports Convex, and nothing here reads `process.env` on its
// own: `loadEmbeddingConfig` takes the environment as an argument, exactly as
// the original does, so a caller decides what this module can see.

const encoder = new TextEncoder();

export const BASELINE_EMBEDDING_ENDPOINT =
  "https://api.openai.com/v1/embeddings";
export const BASELINE_EMBEDDING_PROVIDER_ID = "openai";
export const BASELINE_EMBEDDING_MODEL = "text-embedding-3-small";
/**
 * A local compatibility declaration for vectors already in this deployment.
 * It is not a claim about a pinned upstream OpenAI model release.
 */
export const BASELINE_EMBEDDING_MODEL_REVISION = "legacy-openai-small-1536-v1";
export const BASELINE_EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_PROTOCOL = "openai-embeddings-v1";
export const EMBEDDING_NORMALIZATION = "none-v1";
export const EMBEDDING_PREPROCESSING = "none-v1";

const MAX_EMBEDDING_TEXT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export type EmbeddingProfile = Readonly<{
  protocol: string;
  providerId: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  normalization: string;
  preprocessing: string;
}>;

export type EmbeddingConfig = EmbeddingProfile &
  Readonly<{
    endpoint: string;
    apiKey?: string;
  }>;

export type EmbeddingResult = Readonly<{
  vector: number[];
  fingerprint: string;
  profile: EmbeddingProfile;
}>;

export type EmbeddingEnvironment = Readonly<Record<string, string | undefined>>;

export type EmbeddingFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function optional(env: EmbeddingEnvironment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === "" ? undefined : value;
}

function requiredIdentity(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} must be explicitly configured`);
  return value;
}

function validIdentity(
  value: string,
  name: string,
  allowSlash = false,
): string {
  const characters = allowSlash ? /^[a-zA-Z0-9._:/-]+$/ : /^[a-zA-Z0-9._:-]+$/;
  if (value.length > 200 || !characters.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function parseEndpoint(value: string, environment: string | undefined): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("BRAIN_EMBED_ENDPOINT must be a valid URL");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("BRAIN_EMBED_ENDPOINT must not contain credentials");
  }
  const localhost =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:") {
    if (
      endpoint.protocol !== "http:" ||
      !localhost ||
      (environment !== "development" && environment !== "test")
    ) {
      throw new Error("BRAIN_EMBED_ENDPOINT must use HTTPS");
    }
  }
  return endpoint.toString();
}

function parseDimensions(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("BRAIN_EMBED_DIMENSIONS must be an integer");
  }
  const dimensions = Number(value);
  if (dimensions !== BASELINE_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `BRAIN_EMBED_DIMENSIONS must be ${BASELINE_EMBEDDING_DIMENSIONS} for the current vector index`,
    );
  }
  return dimensions;
}

function isDefaultEndpoint(endpoint: string): boolean {
  return endpoint === BASELINE_EMBEDDING_ENDPOINT;
}

/**
 * Reads only supplied environment values. The returned profile intentionally
 * excludes endpoint and authentication from its immutable compatibility data.
 */
export function loadEmbeddingConfig(
  env: EmbeddingEnvironment,
): EmbeddingConfig {
  const configuredEndpoint = optional(env, "BRAIN_EMBED_ENDPOINT");
  const endpoint = parseEndpoint(
    configuredEndpoint ?? BASELINE_EMBEDDING_ENDPOINT,
    optional(env, "NODE_ENV"),
  );
  const customEndpoint = !isDefaultEndpoint(endpoint);
  const configuredProviderId = optional(env, "BRAIN_EMBED_PROVIDER_ID");
  const configuredModel = optional(env, "BRAIN_EMBED_MODEL");
  const configuredRevision = optional(env, "BRAIN_EMBED_MODEL_REVISION");
  const providerId = validIdentity(
    customEndpoint
      ? requiredIdentity(configuredProviderId, "BRAIN_EMBED_PROVIDER_ID")
      : (configuredProviderId ?? BASELINE_EMBEDDING_PROVIDER_ID),
    "BRAIN_EMBED_PROVIDER_ID",
  );
  const model = validIdentity(
    configuredModel ?? BASELINE_EMBEDDING_MODEL,
    "BRAIN_EMBED_MODEL",
    true,
  );
  const identityChanged =
    providerId !== BASELINE_EMBEDDING_PROVIDER_ID ||
    model !== BASELINE_EMBEDDING_MODEL;
  const modelRevision = validIdentity(
    customEndpoint || identityChanged
      ? requiredIdentity(configuredRevision, "BRAIN_EMBED_MODEL_REVISION")
      : (configuredRevision ?? BASELINE_EMBEDDING_MODEL_REVISION),
    "BRAIN_EMBED_MODEL_REVISION",
  );
  const dimensions = parseDimensions(
    optional(env, "BRAIN_EMBED_DIMENSIONS") ??
      String(BASELINE_EMBEDDING_DIMENSIONS),
  );
  const explicitKey = optional(env, "BRAIN_EMBED_API_KEY");
  const apiKey =
    explicitKey ??
    (isDefaultEndpoint(endpoint) ? optional(env, "OPENAI_API_KEY") : undefined);

  return {
    endpoint,
    ...(apiKey ? { apiKey } : {}),
    protocol: EMBEDDING_PROTOCOL,
    providerId,
    model,
    modelRevision,
    dimensions,
    normalization: EMBEDDING_NORMALIZATION,
    preprocessing: EMBEDDING_PREPROCESSING,
  };
}

export function embeddingProfile(config: EmbeddingConfig): EmbeddingProfile {
  const {
    protocol,
    providerId,
    model,
    modelRevision,
    dimensions,
    normalization,
    preprocessing,
  } = config;
  return {
    protocol,
    providerId,
    model,
    modelRevision,
    dimensions,
    normalization,
    preprocessing,
  };
}

/** A versioned fixed-position encoding prevents object-key ordering changes. */
export async function fingerprintEmbeddingConfig(
  profile: EmbeddingProfile,
): Promise<string> {
  return await sha256Hex(
    JSON.stringify([
      "embedding-profile-v1",
      profile.protocol,
      profile.providerId,
      profile.model,
      profile.modelRevision,
      profile.dimensions,
      profile.normalization,
      profile.preprocessing,
    ]),
  );
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Embedding request failed");
  }
  if (!response.body) throw new Error("Embedding request failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Embedding request failed");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseEmbeddingResponse(
  body: string,
  config: EmbeddingConfig,
): number[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Embedding request failed");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Embedding request failed");
  }
  const response = payload as { data?: unknown; model?: unknown };
  if (response.model !== undefined && response.model !== config.model) {
    throw new Error("Embedding request failed");
  }
  if (!Array.isArray(response.data) || response.data.length !== 1) {
    throw new Error("Embedding request failed");
  }
  const first: unknown = response.data[0];
  if (
    !first ||
    typeof first !== "object" ||
    !Array.isArray((first as { embedding?: unknown }).embedding)
  ) {
    throw new Error("Embedding request failed");
  }
  const vector = (first as { embedding: unknown[] }).embedding;
  if (
    vector.length !== config.dimensions ||
    vector.every((value) => value === 0) ||
    !vector.every(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    )
  ) {
    throw new Error("Embedding request failed");
  }
  return vector;
}

/**
 * Makes one bounded OpenAI-compatible embeddings request. Errors remain
 * generic so a caller never receives credentials, endpoint response bodies,
 * or provider-specific diagnostics.
 */
export async function requestEmbedding(
  text: string,
  config: EmbeddingConfig,
  fetchImpl: EmbeddingFetch = fetch,
): Promise<EmbeddingResult> {
  if (text.length === 0) {
    throw new Error("Embedding input must not be empty");
  }
  if (utf8ByteLength(text) > MAX_EMBEDDING_TEXT_BYTES) {
    throw new Error("Embedding input exceeds the configured limit");
  }
  if (isDefaultEndpoint(config.endpoint) && !config.apiKey) {
    throw new Error("Embedding provider credentials are unavailable");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        input: text,
        dimensions: config.dimensions,
      }),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Embedding request failed");
    }
    const vector = parseEmbeddingResponse(
      await readBoundedResponse(response),
      config,
    );
    return {
      vector,
      fingerprint: await fingerprintEmbeddingConfig(config),
      profile: embeddingProfile(config),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Embedding input exceeds the configured limit" ||
        error.message === "Embedding input must not be empty")
    ) {
      throw error;
    }
    throw new Error("Embedding request failed");
  } finally {
    clearTimeout(timeout);
  }
}

// --- The daemon's batch embedder -------------------------------------------
//
// P2-39j2. `runEmbeddingFill` (`fill.ts`) takes an injected `FillEmbedder`:
// one call per page, at most `MAX_FILL_VECTORS` texts, one result per text in
// order. The web app builds its single-text equivalent from
// `loadEmbeddingConfig(process.env)` and `requestEmbedding` (section 4.4 of
// docs/plans/2026-09-16-web-mcp-postgres-surface.md); the daemon needs the
// same provider from the same environment, batched.
//
// Three properties this wrapper owes its caller.
//
//   * The environment is an argument, not a read. This module still reads no
//     `process.env` of its own; `src/deferred/cli.ts` is the one process that
//     passes it, exactly as the web app's route does.
//   * The configuration is loaded on the first batch, not when the embedder is
//     built. A daemon with no provider configured must still start, sweep and
//     drain every other kind; a misconfigured provider fails the one
//     `embedding_fill` job through `fail`'s ordinary backoff instead of taking
//     the process down at boot.
//   * No provider text escapes. `requestEmbedding` is already generic by
//     construction, but a `fetch` rejection, a DNS failure or a future
//     provider client is not, so every error out of this wrapper is one of the
//     two fixed strings below. The job's `last_error` column, which an
//     operator reads, therefore never carries a key, an endpoint, a response
//     body or a provider diagnostic.
//
// One request per text, sequentially. `requestEmbedding` is pinned to a single
// input per request (its parse requires `data.length === 1`) because the
// fingerprint it computes has to equal the one Convex computed, and a batched
// request body would be a different call than the one that was ported. One at
// a time also keeps a page from opening 32 concurrent sockets from the worker
// host.

/** What an `embedding_fill` job reports when the environment configures no
 * usable provider. Fixed text: it is written to `deferred_work.last_error`. */
export const EMBEDDING_PROVIDER_UNCONFIGURED_ERROR =
  "Embedding provider is not configured";

/** What an `embedding_fill` job reports when a provider call fails, whatever
 * the underlying cause. Fixed text, for the same reason. */
export const EMBEDDING_PROVIDER_REQUEST_ERROR =
  "Embedding provider request failed";

/**
 * The batch shape `fill.ts`'s `FillEmbedder` names, declared here so this
 * module keeps its own dependencies. The two are structurally the same type.
 */
export type BatchEmbedder = (
  texts: readonly string[],
) => Promise<ReadonlyArray<{ vector: number[]; fingerprint: string }>>;

/** The fill's own page is 32 texts. This is the wrapper's own refusal bound,
 * so a caller that passes an unbounded array is refused before the first
 * request rather than after the thirty-third. */
const MAX_BATCH_TEXTS = 64;

/**
 * The provider-backed embedder the daemon drains `embedding_fill` with.
 *
 * `env` is the environment to read the provider configuration from: the same
 * `BRAIN_EMBED_*` names `loadEmbeddingConfig` documents, falling back to
 * `OPENAI_API_KEY` on the default endpoint. `fetchImpl` is the test seam, so
 * no test in this package ever reaches a provider.
 */
export function providerBatchEmbedder(
  env: EmbeddingEnvironment,
  fetchImpl: EmbeddingFetch = fetch,
): BatchEmbedder {
  let config: EmbeddingConfig | undefined;
  return async (texts) => {
    if (texts.length === 0) return [];
    if (texts.length > MAX_BATCH_TEXTS) {
      throw new Error("Embedding batch exceeds its input bound");
    }
    if (!config) {
      try {
        config = loadEmbeddingConfig(env);
      } catch {
        throw new Error(EMBEDDING_PROVIDER_UNCONFIGURED_ERROR);
      }
    }
    const results: { vector: number[]; fingerprint: string }[] = [];
    for (const text of texts) {
      try {
        const result = await requestEmbedding(text, config, fetchImpl);
        results.push({
          vector: result.vector,
          fingerprint: result.fingerprint,
        });
      } catch {
        throw new Error(EMBEDDING_PROVIDER_REQUEST_ERROR);
      }
    }
    return results;
  };
}
