import { parseWorkerRequest } from "@repo/worker-protocol/request";
import type { Pool } from "pg";

import {
  identityCtx,
  principalRef,
  requireMcpPrincipal,
} from "../identity/index.js";
import { withKithTransaction } from "../schema.js";
import { dispatchWorkerRequest } from "./dispatch.js";
import {
  workerProtocolErrorCode,
  type WorkerProtocolErrorCode,
} from "./errors.js";

export const MAX_WORKER_JSON_BYTES = 512 * 1024;

const RESPONSE_HEADERS = { "Cache-Control": "no-store" } as const;

/**
 * One published protocol code, as its HTTP status and its published message.
 *
 * Exported because there is a second copy of it: `apps/web/src/lib/worker/http.ts`
 * holds the same table for the route's Convex leg, and the two have to agree or
 * one deployment answers a worker differently from the other for the same
 * refusal. The web suite asserts itself against this table for all fourteen
 * codes, which is only a real check while this is the table
 * `handlePostgresWorkerRequest` actually answers from -- so it is exported
 * rather than duplicated for the test.
 */
export const WORKER_ERRORS: Record<
  WorkerProtocolErrorCode,
  readonly [number, string]
> = {
  not_authenticated: [401, "Not authenticated"],
  not_authorized: [403, "Not authorized"],
  invalid_request: [400, "Invalid worker request"],
  not_found: [404, "Source or work is not available"],
  source_unavailable: [409, "Source is not available for worker operations"],
  request_conflict: [409, "Request ID conflicts with a different request"],
  scan_conflict: [409, "Scan state has changed"],
  scan_not_ready: [409, "Scan is not ready for this operation"],
  identity_review_required: [409, "Source identity requires operator review"],
  rate_limited: [429, "Worker rate limit exceeded"],
  reservation_expired: [409, "Reservation has expired"],
  stale_observation: [409, "A newer source observation exists"],
  desired_processing_epoch_conflict: [
    409,
    "Desired processing epoch has changed",
  ],
  lease_conflict: [409, "Work lease is no longer current"],
};

class WorkerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkerHttpError";
  }
}

function errorResponse(error: WorkerHttpError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    {
      status: error.status,
      headers: {
        ...RESPONSE_HEADERS,
        ...(error.status === 401
          ? { "WWW-Authenticate": 'Bearer realm="worker"' }
          : {}),
      },
    },
  );
}

function protocolErrorResponse(error: unknown): Response {
  const code = workerProtocolErrorCode(error);
  if (!code) {
    return errorResponse(
      new WorkerHttpError(500, "worker_failed", "Worker operation failed"),
    );
  }
  const [status, message] = WORKER_ERRORS[code];
  return errorResponse(new WorkerHttpError(status, code, message));
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return (
    contentType !== null &&
    /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      contentType,
    )
  );
}

function declaredContentLength(request: Request): number | undefined {
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(header)) {
    throw new WorkerHttpError(
      400,
      "invalid_request",
      "Content-Length must be a non-negative integer",
    );
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw new WorkerHttpError(
      400,
      "invalid_request",
      "Content-Length is invalid",
    );
  }
  return length;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = declaredContentLength(request);
  if (contentLength !== undefined && contentLength > MAX_WORKER_JSON_BYTES) {
    throw new WorkerHttpError(
      413,
      "payload_too_large",
      `JSON body exceeds ${MAX_WORKER_JSON_BYTES} bytes`,
    );
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new WorkerHttpError(400, "invalid_json", "JSON body is required");
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_WORKER_JSON_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new WorkerHttpError(
        413,
        "payload_too_large",
        `JSON body exceeds ${MAX_WORKER_JSON_BYTES} bytes`,
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
    throw new WorkerHttpError(
      400,
      "invalid_json",
      "Request body must be valid UTF-8 JSON",
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new WorkerHttpError(400, "invalid_json", "Invalid JSON body");
  }
}

/**
 * Web-standard PostgreSQL worker adapter. It is deliberately not installed in
 * the production Next route until the cutover task changes that route.
 */
export async function handlePostgresWorkerRequest(
  pool: Pool,
  request: Request,
  clock: () => number = Date.now,
): Promise<Response> {
  if (request.method !== "POST") {
    const response = errorResponse(
      new WorkerHttpError(405, "method_not_allowed", "Method not allowed"),
    );
    response.headers.set("Allow", "POST");
    return response;
  }
  const authorization = request.headers.get("authorization");
  const rawKey = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  let principal;
  try {
    const now = clock();
    principal = await withKithTransaction(pool, (client) =>
      requireMcpPrincipal(identityCtx(client, now), { rawKey }),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Not authenticated") {
      return errorResponse(
        new WorkerHttpError(401, "not_authenticated", "Not authenticated"),
      );
    }
    return errorResponse(
      new WorkerHttpError(
        503,
        "authentication_unavailable",
        "Authentication service is unavailable",
      ),
    );
  }

  if (!hasJsonContentType(request)) {
    return errorResponse(
      new WorkerHttpError(
        415,
        "unsupported_media_type",
        "Content-Type must be application/json",
      ),
    );
  }

  let parsed;
  try {
    parsed = parseWorkerRequest(await readBoundedJson(request));
  } catch (error) {
    return errorResponse(
      error instanceof WorkerHttpError
        ? error
        : new WorkerHttpError(400, "invalid_request", "Invalid worker request"),
    );
  }

  try {
    const result = await dispatchWorkerRequest(
      pool,
      principalRef(principal),
      parsed,
      clock(),
    );
    return Response.json(result, { status: 200, headers: RESPONSE_HEADERS });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}
