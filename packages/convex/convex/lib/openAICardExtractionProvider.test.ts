import { describe, expect, test } from "vitest";

import {
  CardExtractionHttpError,
  loadOpenAICardExtractionConfig,
  openAICardExtractionBody,
  OPENAI_CARD_EXTRACTION_ENDPOINT,
  parseOpenAICardExtractionResponse,
  requestOpenAICardExtraction,
  sanitizedOpenAIErrorCode,
} from "./openAICardExtractionProvider";

import {
  CARD_EXTRACTION_TOOL_NAME,
  CARD_TIER0_MODEL_OPENAI,
  CARD_UNTRUSTED_INPUT_STATEMENT,
  buildCardExtractionRequest,
} from "../models/records/cardRunner";

// Synthetic fixtures only. No test in this file reaches the network: every
// fetch below is a local stub.

const SECRET = "sk-openai-synthetic-never-real";

const PAGES = [
  { ordinal: 0, text: "Mutual Non-Disclosure Agreement\nDated 2025-03-04." },
  { ordinal: 1, text: "Between Northwind Supply and Acme Research." },
];

function noNetwork(): never {
  throw new Error("a test attempted a network call");
}

describe("OpenAI card runner request construction", () => {
  const request = buildCardExtractionRequest(
    { recordKind: "document_card", pages: PAGES },
    CARD_TIER0_MODEL_OPENAI,
  );

  test("reuses the same boundary statement and schema rendering as the Anthropic runner", () => {
    expect(request.system).toContain(CARD_UNTRUSTED_INPUT_STATEMENT);
    expect(request.system).toContain("card_title");
  });

  test("declares exactly one forced function tool, and carries no secret", () => {
    const body = openAICardExtractionBody(request);
    expect(body.model).toBe(CARD_TIER0_MODEL_OPENAI);
    const tools = body.tools as Array<{
      type: string;
      function: { name: string };
    }>;
    expect(tools.length).toBe(1);
    const [tool] = tools;
    expect(tool?.type).toBe("function");
    expect(tool?.function.name).toBe(CARD_EXTRACTION_TOOL_NAME);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: CARD_EXTRACTION_TOOL_NAME },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("api_key");
  });

  test("passes the document page-delimited and nothing else", () => {
    expect(request.userText).toContain("<<<PAGE 0>>>");
    expect(request.userText).toContain("Northwind Supply");
  });
});

describe("OpenAI card runner credentials", () => {
  test("reads the key from OPENAI_API_KEY and never returns it", async () => {
    const config = loadOpenAICardExtractionConfig({ OPENAI_API_KEY: SECRET });
    expect(config.endpoint).toBe(OPENAI_CARD_EXTRACTION_ENDPOINT);
    expect(config.apiKey).toBe(SECRET);

    let sentAuth: string | undefined;
    const request = buildCardExtractionRequest(
      { recordKind: "document_card", pages: PAGES },
      CARD_TIER0_MODEL_OPENAI,
    );
    const response = await requestOpenAICardExtraction(
      request,
      config,
      async (_input, init) => {
        sentAuth = (init.headers as Record<string, string>).Authorization;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      type: "function",
                      function: {
                        name: CARD_EXTRACTION_TOOL_NAME,
                        arguments: JSON.stringify({
                          anchor: [{ pageOrdinal: 0, quote: "Mutual" }],
                          fields: [
                            {
                              field: "card_title",
                              value: { type: "text", value: "Mutual" },
                              spans: [{ pageOrdinal: 0, quote: "Mutual" }],
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1_100, completion_tokens: 80 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    expect(sentAuth).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(response)).not.toContain(SECRET);
    expect(response.inputTokens).toBe(1_100);
    expect(response.outputTokens).toBe(80);
  });

  test("does not hand the first-party key to a redirected endpoint", () => {
    const config = loadOpenAICardExtractionConfig({
      OPENAI_API_KEY: SECRET,
      BRAIN_CARD_ENDPOINT: "https://example.invalid/v1/chat/completions",
    });
    expect(config.apiKey).toBeUndefined();
  });

  test("collapses provider failures to one generic message", async () => {
    await expect(
      requestOpenAICardExtraction(
        buildCardExtractionRequest(
          { recordKind: "document_card", pages: PAGES },
          CARD_TIER0_MODEL_OPENAI,
        ),
        { endpoint: OPENAI_CARD_EXTRACTION_ENDPOINT, apiKey: SECRET },
        async () =>
          new Response(`{"error":"${SECRET} was rejected"}`, { status: 401 }),
      ),
    ).rejects.toThrow("Card extraction request failed");
  });

  test("refuses without calling fetch when no credential is configured", async () => {
    await expect(
      requestOpenAICardExtraction(
        buildCardExtractionRequest(
          { recordKind: "document_card", pages: PAGES },
          CARD_TIER0_MODEL_OPENAI,
        ),
        loadOpenAICardExtractionConfig({}),
        noNetwork,
      ),
    ).rejects.toThrow("Card extraction provider credentials are unavailable");
  });
});

describe("parsing an OpenAI response", () => {
  test("refuses a response with no forced tool call", () => {
    expect(() =>
      parseOpenAICardExtractionResponse(
        JSON.stringify({ choices: [{ message: {} }] }),
        buildCardExtractionRequest(
          { recordKind: "document_card", pages: PAGES },
          CARD_TIER0_MODEL_OPENAI,
        ),
      ),
    ).toThrow("Card extraction request failed");
  });

  test("refuses a tool call for a different function name", () => {
    expect(() =>
      parseOpenAICardExtractionResponse(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "wrong_tool", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
        buildCardExtractionRequest(
          { recordKind: "document_card", pages: PAGES },
          CARD_TIER0_MODEL_OPENAI,
        ),
      ),
    ).toThrow("Card extraction request failed");
  });
});

describe("sanitizing an OpenAI error code", () => {
  test("reads error.code when present", () => {
    expect(
      sanitizedOpenAIErrorCode({ error: { code: "invalid_request_error" } }),
    ).toBe("invalid_request_error");
  });

  test("falls back to error.type when code is absent", () => {
    expect(
      sanitizedOpenAIErrorCode({ error: { type: "invalid_request_error" } }),
    ).toBe("invalid_request_error");
  });

  test("falls back to unknown for a shape it does not recognize", () => {
    expect(sanitizedOpenAIErrorCode({ error: {} })).toBe("unknown");
    expect(sanitizedOpenAIErrorCode(null)).toBe("unknown");
    expect(sanitizedOpenAIErrorCode("not an object")).toBe("unknown");
  });

  test("refuses a code that is unreasonably long or contains free text", () => {
    expect(
      sanitizedOpenAIErrorCode({ error: { code: "x".repeat(65) } }),
    ).toBe("unknown");
    expect(
      sanitizedOpenAIErrorCode({ error: { code: "has a space" } }),
    ).toBe("unknown");
  });
});

describe("a non-2xx OpenAI response", () => {
  test("carries the HTTP status and a sanitized code, never the body or the key", async () => {
    const request = buildCardExtractionRequest(
      { recordKind: "document_card", pages: PAGES },
      CARD_TIER0_MODEL_OPENAI,
    );
    const config = loadOpenAICardExtractionConfig({ OPENAI_API_KEY: SECRET });
    let thrown: unknown;
    try {
      await requestOpenAICardExtraction(request, config, async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_request_error",
              message: `rejected, key ${SECRET} was used`,
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CardExtractionHttpError);
    const error = thrown as CardExtractionHttpError;
    expect(error.status).toBe(400);
    expect(error.message).toContain("Card extraction request failed");
    expect(error.message).toContain("400");
    expect(error.message).toContain("invalid_request_error");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("rejected, key");
  });

  test("still carries the status when the error body is not JSON", async () => {
    const request = buildCardExtractionRequest(
      { recordKind: "document_card", pages: PAGES },
      CARD_TIER0_MODEL_OPENAI,
    );
    const config = loadOpenAICardExtractionConfig({ OPENAI_API_KEY: SECRET });
    await expect(
      requestOpenAICardExtraction(
        request,
        config,
        async () => new Response("<html>not json</html>", { status: 503 }),
      ),
    ).rejects.toMatchObject({ status: 503, message: expect.stringContaining("unknown") });
  });

  test("a subsequent thrown parse failure still collapses to the generic message", async () => {
    const request = buildCardExtractionRequest(
      { recordKind: "document_card", pages: PAGES },
      CARD_TIER0_MODEL_OPENAI,
    );
    const config = loadOpenAICardExtractionConfig({ OPENAI_API_KEY: SECRET });
    await expect(
      requestOpenAICardExtraction(
        request,
        config,
        async () =>
          new Response("not json at all", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    ).rejects.toThrow("Card extraction request failed");
  });
});
