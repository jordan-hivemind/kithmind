import {
  type InlineIngestErrorCode,
  inlineIngestErrorCode,
  parseInlineIngestErrorData,
} from "@repo/db/convex/models/ingestion/inlineErrors";
import { z } from "zod";

export const MAX_INGEST_JSON_BYTES = 512 * 1024;
export const MAX_INGEST_TEXT_BYTES = 64 * 1024;

const MAX_REQUEST_ID_BYTES = 128;
const MAX_ACCOUNT_ID_BYTES = 512;
const MAX_EXTERNAL_ID_BYTES = 2_048;
const MAX_URI_BYTES = 2_048;
const MAX_TITLE_CHARS = 200;
const MAX_DOC_TYPE_CHARS = 100;
const MAX_SPACE_ID_CHARS = 256;
const RFC3339_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export class IngestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IngestHttpError";
  }
}

const sourceSchema = z
  .object({
    connector: z.literal("mcp-client"),
    accountId: z.string().min(1).max(MAX_ACCOUNT_ID_BYTES),
    externalId: z.string().min(1).max(MAX_EXTERNAL_ID_BYTES),
    uri: z.string().min(1).max(MAX_URI_BYTES).optional(),
    capturedAt: z
      .string()
      .datetime({ offset: true })
      .regex(RFC3339_INSTANT)
      .refine((value) => {
        const match = RFC3339_INSTANT.exec(value);
        if (!match || match[7] === undefined) return true;
        const offsetHour = Number(match[8]);
        const offsetMinute = Number(match[9]);
        return (
          offsetHour <= 14 &&
          offsetMinute <= 59 &&
          (offsetHour !== 14 || offsetMinute === 0) &&
          !(match[7] === "-" && offsetHour === 0 && offsetMinute === 0)
        );
      }),
  })
  .strict();

export const ingestRequestSchema = z
  .object({
    spaceId: z.string().min(1).max(MAX_SPACE_ID_CHARS).optional(),
    requestId: z.string().min(1).max(MAX_REQUEST_ID_BYTES),
    expectedDesiredProcessingEpoch: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    source: sourceSchema,
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    text: z.string(),
    docType: z.string().min(1).max(MAX_DOC_TYPE_CHARS).optional(),
  })
  .strict();

export type IngestRequest = z.infer<typeof ingestRequestSchema>;

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isValidBoundedString(value: string, maxUtf8Bytes?: number): boolean {
  return (
    hasWellFormedUtf16(value) &&
    value.trim().length > 0 &&
    (maxUtf8Bytes === undefined ||
      new TextEncoder().encode(value).byteLength <= maxUtf8Bytes)
  );
}

export function hasJsonContentType(req: Request): boolean {
  const contentType = req.headers.get("content-type");
  if (!contentType) return false;
  return /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
    contentType,
  );
}

function declaredContentLength(req: Request): number | undefined {
  const header = req.headers.get("content-length");
  if (header === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(header)) {
    throw new IngestHttpError(
      400,
      "invalid_request",
      "Content-Length must be a non-negative integer",
    );
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw new IngestHttpError(
      400,
      "invalid_request",
      "Content-Length is invalid",
    );
  }
  return length;
}

export async function readBoundedJson(req: Request): Promise<unknown> {
  const contentLength = declaredContentLength(req);
  if (contentLength !== undefined && contentLength > MAX_INGEST_JSON_BYTES) {
    throw new IngestHttpError(
      413,
      "payload_too_large",
      `JSON body exceeds ${MAX_INGEST_JSON_BYTES} bytes`,
    );
  }

  const reader = req.body?.getReader();
  if (!reader) {
    throw new IngestHttpError(400, "invalid_json", "JSON body is required");
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_INGEST_JSON_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new IngestHttpError(
        413,
        "payload_too_large",
        `JSON body exceeds ${MAX_INGEST_JSON_BYTES} bytes`,
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IngestHttpError(
      400,
      "invalid_json",
      "Request body must be valid UTF-8 JSON",
    );
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new IngestHttpError(400, "invalid_json", "Invalid JSON body");
  }
}

export function parseIngestRequest(input: unknown): IngestRequest {
  const parsed = ingestRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new IngestHttpError(400, "invalid_request", "Invalid ingest request");
  }
  const boundedUtf8Fields = [
    [parsed.data.requestId, MAX_REQUEST_ID_BYTES],
    [parsed.data.source.accountId, MAX_ACCOUNT_ID_BYTES],
    [parsed.data.source.externalId, MAX_EXTERNAL_ID_BYTES],
    ...(parsed.data.source.uri === undefined
      ? []
      : ([[parsed.data.source.uri, MAX_URI_BYTES]] as const)),
  ] as const;
  if (
    boundedUtf8Fields.some(
      ([value, maxBytes]) => !isValidBoundedString(value, maxBytes),
    ) ||
    !isValidBoundedString(parsed.data.title) ||
    (parsed.data.docType !== undefined &&
      !isValidBoundedString(parsed.data.docType)) ||
    !isValidBoundedString(parsed.data.source.capturedAt)
  ) {
    throw new IngestHttpError(400, "invalid_request", "Invalid ingest request");
  }
  if (!hasWellFormedUtf16(parsed.data.text)) {
    throw new IngestHttpError(
      400,
      "invalid_request",
      "text must contain valid Unicode",
    );
  }
  if (parsed.data.text.trim().length === 0) {
    throw new IngestHttpError(400, "invalid_request", "Invalid ingest request");
  }
  if (
    new TextEncoder().encode(parsed.data.text).byteLength >
    MAX_INGEST_TEXT_BYTES
  ) {
    throw new IngestHttpError(
      413,
      "text_too_large",
      `text exceeds ${MAX_INGEST_TEXT_BYTES} UTF-8 bytes`,
    );
  }
  return parsed.data;
}

export function backendIngestError(error: unknown): IngestHttpError {
  const structured = parseInlineIngestErrorData(
    typeof error === "object" && error !== null && "data" in error
      ? error.data
      : undefined,
  );
  if (structured) return structuredBackendIngestError(structured.code);

  const legacyCode = inlineIngestErrorCode(error);
  if (legacyCode) return structuredBackendIngestError(legacyCode);

  const message = error instanceof Error ? error.message : "";
  if (message.includes("Not authenticated")) {
    return new IngestHttpError(401, "unauthorized", "Not authenticated");
  }
  if (message.includes("Source account not found")) {
    return new IngestHttpError(403, "forbidden", "Source account not found");
  }
  if (message.includes("Space not found")) {
    return new IngestHttpError(403, "forbidden", "Space not found");
  }
  if (
    /default (?:destination|ingest space).*(?:unavailable|not available|not found)/i.test(
      message,
    )
  ) {
    return new IngestHttpError(
      403,
      "forbidden",
      "Default ingest space is not available",
    );
  }
  if (message.includes("requestId conflicts with a different request")) {
    return new IngestHttpError(
      409,
      "conflict",
      "requestId conflicts with a different request",
    );
  }
  if (message.includes("Desired processing epoch conflict")) {
    return new IngestHttpError(
      409,
      "conflict",
      "Desired processing epoch conflict",
    );
  }
  if (message.includes("Source item is forgetting")) {
    return new IngestHttpError(409, "conflict", "Source item is forgetting");
  }
  if (message.includes("Source item is forgotten")) {
    return new IngestHttpError(409, "conflict", "Source item is forgotten");
  }
  if (message.includes("Ingest rate limit exceeded")) {
    return new IngestHttpError(
      429,
      "rate_limited",
      "Ingest rate limit exceeded",
    );
  }
  return new IngestHttpError(500, "ingest_failed", "Ingestion failed");
}

function structuredBackendIngestError(
  code: InlineIngestErrorCode,
): IngestHttpError {
  switch (code) {
    case "not_authenticated":
      return new IngestHttpError(401, "unauthorized", "Not authenticated");
    case "source_account_not_found":
      return new IngestHttpError(403, "forbidden", "Source account not found");
    case "space_not_found":
      return new IngestHttpError(403, "forbidden", "Space not found");
    case "default_ingest_space_unavailable":
      return new IngestHttpError(
        403,
        "forbidden",
        "Default ingest space is not available",
      );
    case "request_conflict":
      return new IngestHttpError(
        409,
        "conflict",
        "requestId conflicts with a different request",
      );
    case "desired_processing_epoch_conflict":
      return new IngestHttpError(
        409,
        "conflict",
        "Desired processing epoch conflict",
      );
    case "ingest_rate_limited":
      return new IngestHttpError(
        429,
        "rate_limited",
        "Ingest rate limit exceeded",
      );
    case "source_item_unavailable":
      return new IngestHttpError(
        409,
        "conflict",
        "Source item is not available for admission",
      );
    case "invalid_request":
      return new IngestHttpError(
        400,
        "invalid_request",
        "Invalid ingest request",
      );
  }
}
