// OCR for a thin-text PDF page, through the same OpenAI-compatible provider
// `packages/kith-store/src/extraction/provider.ts` already reads
// (`KITH_EXTRACT_ENDPOINT` / `KITH_EXTRACT_MODEL` / `KITH_EXTRACT_API_KEY`,
// falling back to `OPENAI_API_KEY` on the default endpoint): a vision-capable
// chat completion with the page image inline, one plain `fetch` call, no new
// vendor SDK. That module's own `read` is a text-in/JSON-out extraction call
// and has no image input, so this is a small sibling request built the same
// way rather than a reuse of one of its functions.

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

export type OcrConfig = { endpoint: string; model: string; apiKey: string | undefined };

/** Reads provider configuration the same way `extraction/provider.ts` does:
 * `KITH_EXTRACT_*`, an explicit endpoint requires no key, the default
 * endpoint needs `KITH_EXTRACT_API_KEY` or `OPENAI_API_KEY`. */
export function loadOcrConfig(
  env: Readonly<Record<string, string | undefined>>,
): OcrConfig | null {
  const endpoint = env.KITH_EXTRACT_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
  const model = env.KITH_EXTRACT_MODEL?.trim() || DEFAULT_MODEL;
  const isDefault = endpoint === DEFAULT_ENDPOINT;
  const apiKey = env.KITH_EXTRACT_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  if (isDefault && !apiKey) return null;
  return { endpoint, model, apiKey: apiKey || undefined };
}

export type OcrFetch = typeof fetch;

/** The converter identity string this OCR call contributes to an extraction
 * fingerprint: stable across runs as long as the model name does not change. */
export function ocrConverterFingerprint(config: OcrConfig): string {
  return `ocr-vision:${config.model}`;
}

/** Runs one vision completion over a rendered page image and returns the text
 * it transcribed. Throws on any provider failure; the caller decides whether
 * that is fatal for the page. */
export async function ocrPageImage(
  imagePng: Buffer,
  config: OcrConfig,
  fetchImpl: OcrFetch = fetch,
): Promise<string> {
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
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Transcribe every word of text visible in this scanned document " +
                  "page, in reading order. Output plain text only: no commentary, " +
                  "no markdown, no code fences. If the page has no legible text, " +
                  "output nothing.",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${imagePng.toString("base64")}` },
              },
            ],
          },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OCR provider request failed (${response.status})`);
    }
    const text = await readBoundedText(response);
    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parsed.choices?.[0]?.message?.content?.trim() ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("OCR provider response exceeded the size limit");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
