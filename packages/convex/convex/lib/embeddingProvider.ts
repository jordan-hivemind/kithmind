import { sha256Hex, utf8ByteLength } from "../models/ingestion/hash";

export const BASELINE_EMBEDDING_ENDPOINT =
  "https://api.openai.com/v1/embeddings";
export const BASELINE_EMBEDDING_PROVIDER_ID = "openai";
export const BASELINE_EMBEDDING_MODEL = "text-embedding-3-small";
/**
 * This is a local compatibility declaration for vectors already in this
 * deployment. It is not a claim about a pinned upstream OpenAI model release.
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
    while (true) {
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
  const row = response.data[0];
  if (
    !row ||
    typeof row !== "object" ||
    !Array.isArray((row as { embedding?: unknown }).embedding)
  ) {
    throw new Error("Embedding request failed");
  }
  const vector = (row as { embedding: unknown[] }).embedding;
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
