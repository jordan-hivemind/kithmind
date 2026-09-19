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

/** A non-OK response, and whether it looks like the endpoint refusing the
 * JSON schema rather than failing. Never escapes this module: every error out
 * of `read` is one of the two fixed strings. */
class ProviderRefusal extends Error {
  constructor(readonly retryWithoutSchema: boolean) {
    super("provider refused");
  }
}

/** Reported when a provider call fails, whatever the underlying cause. */
export const EXTRACTION_PROVIDER_REQUEST_ERROR =
  "Extraction provider request failed";

/** What one statement looks like on the wire, before any check. */
export type ModelStatement = {
  field: string;
  value_type?: string;
  value: unknown;
  page: number;
  /**
   * The line ids on that page this statement reads from, one to three.
   *
   * The citation the schema asks for. The server builds the quote from these,
   * so a citation is either in range or it is not and `quote_not_found` cannot
   * happen for a valid one. Empty when the reply used the older `quote` shape.
   */
  lines: number[];
  /** The older shape: text the model copied. Still read, because the
   * non-schema fallback path cannot require line ids. */
  quote: string;
};

export type ModelReading = {
  kind: string;
  summary: string;
  statements: ModelStatement[];
  /**
   * Entries the reply carried that named no field at all.
   *
   * Counted rather than dropped. A reply whose every entry lands here is a
   * model that answered in a shape nobody asked for, and the difference
   * between "the document says nothing" and "the reply was unreadable" is the
   * difference between a quiet no-op and a bug that hides for a week. The live
   * trial that produced this field saw exactly that: two documents extracted
   * to zero statements and one correction reading `{"fields":["(unnamed)"]}`,
   * with nothing anywhere saying how many entries had been thrown away.
   */
  unnamed: number;
};

/**
 * What the job asks the model for.
 *
 * The prompt is the human half; `kinds` and `fields` are the machine half,
 * from which the provider builds a JSON schema the reply is validated against
 * before it ever reaches us. Both are needed: a schema-capable endpoint gets
 * a contract it cannot answer outside of, and one that is not gets a prompt
 * that spells the same contract out.
 */
export type ExtractionRequest = {
  prompt: string;
  /** The model to use for this document, when the kind asks for one other
   * than the configured default. Omitted, the configured model is used. */
  model?: string;
  /** The kinds the reply may choose between. `other` is added here. */
  kinds: readonly string[];
  /** Every field name any active kind declares, as one enum. Cross-kind
   * misuse is the gate's job, not the schema's: a field that is real but
   * belongs to another kind is an ordinary `unknown_field` correction, which
   * is a better outcome than a reply the provider refuses outright. */
  fields: readonly string[];
};

/**
 * The seam the job runs through. The daemon gets the provider-backed one
 * below; a test gets a stub and never makes a call.
 */
export type ExtractionModel = {
  readonly name: string;
  read(request: ExtractionRequest): Promise<ModelReading>;
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
 * The JSON schema a schema-capable endpoint validates the reply against.
 *
 * This is the fix for the live trial's failure, and it is a contract rather
 * than a request: `field` is required and drawn from an enum, so a reply that
 * omits it, renames it, or flattens the field name into a key of its own
 * cannot come back at all. The two documents that failed both had a
 * `line_item_list` field and the third kind did not, which is why the item
 * list gets its own property here instead of sharing `value`: one property
 * that is sometimes a string and sometimes a list of objects is exactly the
 * ambiguity a model resolves creatively.
 *
 * Every property is in `required` and every object is closed, which is what
 * OpenAI's strict mode demands; a property that does not apply is passed as
 * null rather than left out.
 */
export function extractionSchema(request: ExtractionRequest): unknown {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "summary", "statements"],
    properties: {
      kind: { type: "string", enum: [...request.kinds, "other"] },
      summary: { type: "string" },
      statements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "page", "lines", "value", "line_items"],
          properties: {
            field: { type: "string", enum: [...request.fields] },
            /** 1-based, like the headings the pages are shown under. */
            page: { type: "integer", minimum: 1 },
            /**
             * One to three line ids from the numbered page. Not a quote: the
             * server builds the quote from these, which is what makes a
             * citation checkable rather than reproducible.
             */
            lines: {
              type: "array",
              items: { type: "integer", minimum: 1 },
            },
            /** The value of every field except a `line_item_list` one, which
             * passes null here and fills `line_items` instead. */
            value: { type: ["string", "null"] },
            line_items: {
              type: ["array", "null"],
              items: {
                type: "object",
                additionalProperties: false,
                required: ["description", "amount"],
                properties: {
                  description: { type: "string" },
                  amount: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
}

/** A statement's field name, under any of the three spellings a reply has
 * been seen to use. Not a guess about a value -- a mechanical rename, which
 * is safe in a way that inferring a field from its contents would not be. */
function statementField(statement: Record<string, unknown>): string {
  for (const key of ["field", "field_name", "name"]) {
    const value = statement[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * Parses the model's reply into the shape the gate checks.
 *
 * The backstop, not the contract: `extractionSchema` is the contract, and this
 * runs anyway because `KITH_EXTRACT_ENDPOINT` may point at a server that
 * honours no schema at all. Tolerant about the envelope and strict about
 * nothing, because every field here is re-checked by `gate.ts` against the
 * document type and the page text.
 *
 * It is not tolerant about *silence*, which is the one thing the live trial
 * showed it needs to be strict about: an entry with no field name is counted
 * rather than turned into an anonymous statement nobody can trace.
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
  const entries = Array.isArray(reply.statements)
    ? reply.statements.slice(0, 128)
    : [];
  const statements: ModelStatement[] = [];
  let unnamed = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      unnamed += 1;
      continue;
    }
    const statement = entry as Record<string, unknown>;
    const field = statementField(statement);
    if (!field) {
      unnamed += 1;
      continue;
    }
    // `line_items` is the schema's own property for a list field. A reply that
    // puts the list in `value` instead still reads, because the gate takes
    // either; this is which one wins when both are present.
    const items = statement.line_items;
    const value =
      Array.isArray(items) && items.length > 0 ? items : statement.value;
    const lines = Array.isArray(statement.lines)
      ? statement.lines
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id))
          .slice(0, 3)
      : [];
    statements.push({
      field,
      ...(typeof statement.value_type === "string"
        ? { value_type: statement.value_type }
        : {}),
      value,
      page: Number(statement.page),
      lines,
      quote: typeof statement.quote === "string" ? statement.quote : "",
    });
  }
  return {
    kind: typeof reply.kind === "string" ? reply.kind : "other",
    summary:
      typeof reply.summary === "string" ? reply.summary.slice(0, 500) : "",
    statements,
    unnamed,
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
  // Whether this endpoint has already refused a JSON schema. Remembered per
  // embedder, so one document pays the extra round trip and the rest of the
  // run goes straight to the looser format. A schema is the contract where it
  // is available; where it is not, the prompt carries the same contract in
  // words and `parseModelReading` is the backstop under both.
  let schemaRefused = false;
  return {
    get name() {
      return optional(env, "KITH_EXTRACT_MODEL") ?? DEFAULT_EXTRACTION_MODEL;
    },
    async read(request) {
      if (!config) {
        try {
          config = loadExtractionConfig(env);
        } catch {
          throw new Error(EXTRACTION_PROVIDER_UNCONFIGURED_ERROR);
        }
      }
      const settings = config;
      const attempt = async (useSchema: boolean): Promise<string> => {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
        );
        try {
          const response = await fetchImpl(settings.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(settings.apiKey
                ? { Authorization: `Bearer ${settings.apiKey}` }
                : {}),
            },
            body: JSON.stringify({
              model: request.model ?? settings.model,
              response_format: useSchema
                ? {
                    type: "json_schema",
                    json_schema: {
                      name: "kith_document_extraction",
                      strict: true,
                      schema: extractionSchema(request),
                    },
                  }
                : { type: "json_object" },
              messages: [{ role: "user", content: request.prompt }],
            }),
            signal: controller.signal,
            redirect: "error",
          });
          if (!response.ok) {
            await response.body?.cancel();
            // A 4xx on the schema attempt is the endpoint saying it does not
            // support one (or does not support it for this model). That is a
            // configuration fact, not a failure, so it is retried once without
            // and remembered. A 5xx is an outage and gets no reinterpretation.
            throw new ProviderRefusal(
              useSchema && response.status >= 400 && response.status < 500,
            );
          }
          const body = await readBounded(response);
          const parsed = JSON.parse(body) as {
            choices?: Array<{ message?: { content?: unknown } }>;
          };
          const content = parsed.choices?.[0]?.message?.content;
          if (typeof content !== "string") throw new Error("no content");
          return content;
        } finally {
          clearTimeout(timeout);
        }
      };

      try {
        try {
          return parseModelReading(await attempt(!schemaRefused));
        } catch (error) {
          if (!(error instanceof ProviderRefusal) || !error.retryWithoutSchema) {
            throw error;
          }
          schemaRefused = true;
          return parseModelReading(await attempt(false));
        }
      } catch {
        throw new Error(EXTRACTION_PROVIDER_REQUEST_ERROR);
      }
    },
  };
}
