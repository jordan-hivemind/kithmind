/**
 * The hosted card-extraction provider, built on the same secret-handling
 * pattern as `embeddingProvider.ts`: the key is read from the environment at
 * the call site, it never enters a log, an error message, a fingerprint or the
 * repository, and every failure collapses to one generic message so a caller
 * can never read a credential, an endpoint body or a provider diagnostic out
 * of a thrown error.
 *
 * Section 5.3 of docs/plans/2026-09-12-document-cards.md: the runner receives
 * one document's retained text and the card schema. It gets no credentials of
 * its own, no source access, no other document and no tool but the one this
 * request declares.
 */

import { utf8ByteLength } from "../models/ingestion/hash";

export const CARD_EXTRACTION_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const CARD_EXTRACTION_API_VERSION = "2023-06-01";

const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Shared with `openAICardExtractionProvider.ts`. */
export const REQUEST_TIMEOUT_MS = 120_000;

export type CardExtractionEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type CardExtractionConfig = Readonly<{
  endpoint: string;
  apiKey?: string;
}>;

export type CardExtractionFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** The provider-neutral shape of one structured extraction request. */
export type CardExtractionRequest = Readonly<{
  model: string;
  maxTokens: number;
  /** The boundary statement and the card schema. Never a credential. */
  system: string;
  /** The document's page-delimited retained text. Untrusted input. */
  userText: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Readonly<Record<string, unknown>>;
}>;

export type CardExtractionResponse = Readonly<{
  /** The tool input the model returned, unvalidated. The caller parses it. */
  output: unknown;
  inputTokens: number;
  outputTokens: number;
}>;

export function optional(
  env: CardExtractionEnvironment,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value === "" ? undefined : value;
}

export function parseEndpoint(
  value: string,
  environment: string | undefined,
): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("BRAIN_CARD_ENDPOINT must be a valid URL");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("BRAIN_CARD_ENDPOINT must not contain credentials");
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
      throw new Error("BRAIN_CARD_ENDPOINT must use HTTPS");
    }
  }
  return endpoint.toString();
}

/**
 * Reads only supplied environment values, exactly as the embedding provider
 * does. `ANTHROPIC_API_KEY` is honoured only for the default endpoint, so a
 * redirected endpoint can never be handed the first-party credential.
 */
export function loadCardExtractionConfig(
  env: CardExtractionEnvironment,
): CardExtractionConfig {
  const endpoint = parseEndpoint(
    optional(env, "BRAIN_CARD_ENDPOINT") ?? CARD_EXTRACTION_ENDPOINT,
    optional(env, "NODE_ENV"),
  );
  const explicitKey = optional(env, "BRAIN_CARD_API_KEY");
  const apiKey =
    explicitKey ??
    (endpoint === CARD_EXTRACTION_ENDPOINT
      ? optional(env, "ANTHROPIC_API_KEY")
      : undefined);
  return { endpoint, ...(apiKey ? { apiKey } : {}) };
}

/**
 * The request body, with no credential in it. Exported so the request
 * construction is unit-testable without a network call: the boundary
 * statement, the schema and the absence of secrets are all readable here.
 *
 * Structured output is a single forced tool call. That is the boring, stable
 * mechanism, and it is also the tool boundary: exactly one tool is declared,
 * it writes nothing, and `tool_choice` leaves the model no other move.
 */
export function cardExtractionBody(
  request: CardExtractionRequest,
): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: "user", content: request.userText }],
    tools: [
      {
        name: request.toolName,
        description: request.toolDescription,
        input_schema: request.inputSchema,
      },
    ],
    tool_choice: { type: "tool", name: request.toolName },
  };
}

/**
 * Shared with `openAICardExtractionProvider.ts`: reads a response body up to
 * `MAX_RESPONSE_BYTES`, the same bound both hosted providers apply.
 */
export async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Card extraction request failed");
  }
  if (!response.body) throw new Error("Card extraction request failed");
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
        throw new Error("Card extraction request failed");
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

export function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** Reads the single forced tool call out of one Messages API response. */
export function parseCardExtractionResponse(
  body: string,
  request: CardExtractionRequest,
): CardExtractionResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Card extraction request failed");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Card extraction request failed");
  }
  const message = payload as {
    content?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  if (!Array.isArray(message.content)) {
    throw new Error("Card extraction request failed");
  }
  const call = message.content.find(
    (block): block is { type: string; name: string; input: unknown } =>
      !!block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use" &&
      (block as { name?: unknown }).name === request.toolName,
  );
  if (!call) throw new Error("Card extraction request failed");
  return {
    output: call.input,
    inputTokens: nonNegativeInteger(message.usage?.input_tokens),
    outputTokens: nonNegativeInteger(message.usage?.output_tokens),
  };
}

/**
 * Makes one bounded structured-extraction request. The key is sent on this
 * one request and is never returned, logged or attached to an error: every
 * failure below is the same generic message.
 */
export async function requestCardExtraction(
  request: CardExtractionRequest,
  config: CardExtractionConfig,
  fetchImpl: CardExtractionFetch = fetch,
): Promise<CardExtractionResponse> {
  if (utf8ByteLength(request.userText) === 0) {
    throw new Error("Card extraction input must not be empty");
  }
  if (!config.apiKey) {
    throw new Error("Card extraction provider credentials are unavailable");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": CARD_EXTRACTION_API_VERSION,
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify(cardExtractionBody(request)),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Card extraction request failed");
    }
    return parseCardExtractionResponse(
      await readBoundedResponse(response),
      request,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Card extraction input must not be empty" ||
        error.message ===
          "Card extraction provider credentials are unavailable")
    ) {
      throw error;
    }
    throw new Error("Card extraction request failed");
  } finally {
    clearTimeout(timeout);
  }
}
