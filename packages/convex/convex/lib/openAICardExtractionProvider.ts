/**
 * The hosted OpenAI card-extraction provider. Same secret-handling and
 * bounded-response pattern as `cardExtractionProvider.ts`: the key is read
 * from the environment at the call site, it never enters a log, an error
 * message, a fingerprint or the repository, and every failure collapses to
 * one generic message.
 *
 * Uses Chat Completions with a forced function call for structured JSON
 * output: the OpenAI equivalent of the Anthropic runner's forced
 * `tool_choice`. Exactly one tool is declared, it writes nothing, and
 * `tool_choice` leaves the model no other move. `CardExtractionRequest`,
 * its schema rendering and its untrusted-input boundary statement are
 * already provider-neutral (built in `cardRunner.ts`), so this file only
 * adds the OpenAI wire format and credential handling.
 */

import { utf8ByteLength } from "../models/ingestion/hash";

import {
  nonNegativeInteger,
  optional,
  parseEndpoint,
  readBoundedResponse,
  REQUEST_TIMEOUT_MS,
  type CardExtractionConfig,
  type CardExtractionEnvironment,
  type CardExtractionFetch,
  type CardExtractionRequest,
  type CardExtractionResponse,
} from "./cardExtractionProvider";

export const OPENAI_CARD_EXTRACTION_ENDPOINT =
  "https://api.openai.com/v1/chat/completions";

/**
 * Reads only supplied environment values, exactly as the Anthropic config
 * loader does. `BRAIN_CARD_VENDOR=openai` reuses the same override names
 * (`BRAIN_CARD_ENDPOINT`, `BRAIN_CARD_API_KEY`) since only one vendor's
 * runners are built in a given run. `OPENAI_API_KEY` is honoured only for
 * the default endpoint, so a redirected endpoint can never be handed the
 * first-party credential — the same rule the embedding provider and the
 * Anthropic runner both apply to their own default-vendor keys.
 */
export function loadOpenAICardExtractionConfig(
  env: CardExtractionEnvironment,
): CardExtractionConfig {
  const endpoint = parseEndpoint(
    optional(env, "BRAIN_CARD_ENDPOINT") ?? OPENAI_CARD_EXTRACTION_ENDPOINT,
    optional(env, "NODE_ENV"),
  );
  const explicitKey = optional(env, "BRAIN_CARD_API_KEY");
  const apiKey =
    explicitKey ??
    (endpoint === OPENAI_CARD_EXTRACTION_ENDPOINT
      ? optional(env, "OPENAI_API_KEY")
      : undefined);
  return { endpoint, ...(apiKey ? { apiKey } : {}) };
}

/**
 * The request body, with no credential in it. Exported so the request
 * construction is unit-testable without a network call.
 */
export function openAICardExtractionBody(
  request: CardExtractionRequest,
): Record<string, unknown> {
  return {
    model: request.model,
    max_completion_tokens: request.maxTokens,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.userText },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: request.toolName,
          description: request.toolDescription,
          parameters: request.inputSchema,
          strict: true,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: request.toolName } },
  };
}

/** Reads the single forced tool call out of one Chat Completions response. */
export function parseOpenAICardExtractionResponse(
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
  const response = payload as {
    choices?: unknown;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw new Error("Card extraction request failed");
  }
  const first = response.choices[0] as { message?: { tool_calls?: unknown } };
  const toolCalls = first.message?.tool_calls;
  const call = Array.isArray(toolCalls)
    ? toolCalls.find(
        (entry): entry is { function: { name: string; arguments: string } } =>
          !!entry &&
          typeof entry === "object" &&
          (entry as { type?: unknown }).type === "function" &&
          (entry as { function?: { name?: unknown } }).function?.name ===
            request.toolName &&
          typeof (entry as { function?: { arguments?: unknown } }).function
            ?.arguments === "string",
      )
    : undefined;
  if (!call) throw new Error("Card extraction request failed");
  let output: unknown;
  try {
    output = JSON.parse(call.function.arguments);
  } catch {
    throw new Error("Card extraction request failed");
  }
  return {
    output,
    inputTokens: nonNegativeInteger(response.usage?.prompt_tokens),
    outputTokens: nonNegativeInteger(response.usage?.completion_tokens),
  };
}

/**
 * Makes one bounded structured-extraction request against OpenAI. The key is
 * sent on this one request and is never returned, logged or attached to an
 * error: every failure below is the same generic message the Anthropic
 * runner raises.
 */
export async function requestOpenAICardExtraction(
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
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(openAICardExtractionBody(request)),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Card extraction request failed");
    }
    return parseOpenAICardExtractionResponse(
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
