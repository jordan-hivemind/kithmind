// The extraction model call, built the way `../embeddings/provider.ts` is:
// the environment is an argument rather than a read, `fetch` is injectable so
// no test in this package reaches a provider, and every error out of here is
// one of two fixed strings so `deferred_work.last_error` can never carry a
// key, an endpoint or a response body.
//
// One OpenAI-compatible chat completion per document, with JSON object output.
// Nothing streams and nothing retries here: the deferred-work queue's own
// backoff is the retry, and it already bounds attempts.
//
// Environment, all optional except the key:
//
// | Name                    | Default                                        |
// | ----------------------- | ---------------------------------------------- |
// | `KITH_EXTRACT_MODEL`    | `gpt-4o-mini`                                  |
// | `KITH_EXTRACT_ENDPOINT` | `https://api.openai.com/v1/chat/completions`   |
// | `KITH_EXTRACT_API_KEY`  | falls back to `OPENAI_API_KEY` on the default endpoint |

import type {
  EmbeddingEnvironment as ProviderEnvironment,
  EmbeddingFetch as ProviderFetch,
} from "../embeddings/provider.js";

export type { ProviderEnvironment, ProviderFetch };

export const DEFAULT_EXTRACTION_ENDPOINT =
  "https://api.openai.com/v1/chat/completions";
export const DEFAULT_EXTRACTION_MODEL = "gpt-4o-mini";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Reported when the environment configures no usable provider. Fixed text:
 * it is written to `deferred_work.last_error`, which an operator reads. */
export const EXTRACTION_PROVIDER_UNCONFIGURED_ERROR =
  "Extraction provider is not configured";

/** Reported when a provider call fails, whatever the underlying cause. */
export const EXTRACTION_PROVIDER_REQUEST_ERROR =
  "Extraction provider request failed";

/** What one statement looks like on the wire, before any check. */
export type ModelStatement = {
  field: string;
  value_type?: string;
  value: unknown;
  page: number;
  quote: string;
};

export type ModelReading = {
  kind: string;
  summary: string;
  statements: ModelStatement[];
};

/**
 * The seam the job runs through. The daemon gets the provider-backed one
 * below; a test gets a stub and never makes a call.
 */
export type ExtractionModel = {
  readonly name: string;
  read(prompt: string): Promise<ModelReading>;
};

export type ExtractionConfig = {
  endpoint: string;
  model: string;
  apiKey?: string;
};

function optional(
  env: ProviderEnvironment,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value === "" ? undefined : value;
}

export function loadExtractionConfig(
  env: ProviderEnvironment,
): ExtractionConfig {
  const endpoint = optional(env, "KITH_EXTRACT_ENDPOINT") ??
    DEFAULT_EXTRACTION_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("KITH_EXTRACT_ENDPOINT must be a valid URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("KITH_EXTRACT_ENDPOINT must not contain credentials");
  }
  const localhost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localhost)) {
    throw new Error("KITH_EXTRACT_ENDPOINT must use HTTPS");
  }
  const model = optional(env, "KITH_EXTRACT_MODEL") ?? DEFAULT_EXTRACTION_MODEL;
  if (!/^[a-zA-Z0-9._:/-]{1,200}$/.test(model)) {
    throw new Error("KITH_EXTRACT_MODEL is invalid");
  }
  const apiKey =
    optional(env, "KITH_EXTRACT_API_KEY") ??
    (endpoint === DEFAULT_EXTRACTION_ENDPOINT
      ? optional(env, "OPENAI_API_KEY")
      : undefined);
  if (endpoint === DEFAULT_EXTRACTION_ENDPOINT && !apiKey) {
    throw new Error("Extraction provider credentials are unavailable");
  }
  return { endpoint, model, ...(apiKey ? { apiKey } : {}) };
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new Error("no body");
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
        throw new Error("too large");
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

/**
 * Parses the model's reply into the shape the gate checks. Tolerant about the
 * envelope and strict about nothing: every field here is re-checked by
 * `gate.ts` against the document type and the page text, so the only job of
 * this function is to not throw on an odd reply.
 */
export function parseModelReading(content: string): ModelReading {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    throw new Error(EXTRACTION_PROVIDER_REQUEST_ERROR);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error(EXTRACTION_PROVIDER_REQUEST_ERROR);
  }
  const reply = payload as {
    kind?: unknown;
    summary?: unknown;
    statements?: unknown;
  };
  const statements = Array.isArray(reply.statements) ? reply.statements : [];
  return {
    kind: typeof reply.kind === "string" ? reply.kind : "other",
    summary: typeof reply.summary === "string" ? reply.summary.slice(0, 500) : "",
    statements: statements.slice(0, 128).map((entry) => {
      const statement = (entry ?? {}) as Record<string, unknown>;
      return {
        field: typeof statement.field === "string" ? statement.field : "",
        ...(typeof statement.value_type === "string"
          ? { value_type: statement.value_type }
          : {}),
        value: statement.value,
        page: Number(statement.page),
        quote: typeof statement.quote === "string" ? statement.quote : "",
      };
    }),
  };
}

/**
 * The model the daemon runs. Configuration is loaded on the first call, not
 * when this is built, for the reason `providerBatchEmbedder` gives: a daemon
 * with no provider configured must still start and drain every other kind.
 */
export function providerExtractionModel(
  env: ProviderEnvironment,
  fetchImpl: ProviderFetch = fetch,
): ExtractionModel {
  let config: ExtractionConfig | undefined;
  return {
    get name() {
      return optional(env, "KITH_EXTRACT_MODEL") ?? DEFAULT_EXTRACTION_MODEL;
    },
    async read(prompt) {
      if (!config) {
        try {
          config = loadExtractionConfig(env);
        } catch {
          throw new Error(EXTRACTION_PROVIDER_UNCONFIGURED_ERROR);
        }
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey
              ? { Authorization: `Bearer ${config.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: config.model,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
          }),
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("not ok");
        }
        const body = await readBounded(response);
        const parsed = JSON.parse(body) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("no content");
        return parseModelReading(content);
      } catch {
        throw new Error(EXTRACTION_PROVIDER_REQUEST_ERROR);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
