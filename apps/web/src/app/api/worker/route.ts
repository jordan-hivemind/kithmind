// The worker protocol endpoint.
//
// Row i4 of the web and MCP surface plan. The route keeps every step it had --
// authenticate, require JSON, read a bounded body, parse the request against
// the protocol, dispatch, map a protocol refusal to its published status -- and
// i7b left it with one dispatcher, `workers.dispatchWorkerRequest` from
// `@repo/kith-store`, which P2-39d wrote and which switches on the same
// `operation` over the same parsed request the Convex one did.
//
// Wire parity with what it replaced is a property of two things being shared
// rather than of this file being careful:
//
//   * One parser. `parseWorkerRequest` comes from `@repo/worker-protocol`, the
//     package the Convex protocol module was always a pure re-export of, and
//     the store imports the same package.
//   * One error code set. `workerProtocolErrorCode` yields a
//     `WorkerProtocolErrorCode`, and `workerErrorForCode` is the single table
//     from that code to a status and a message.
//
// The store also ships `handlePostgresWorkerRequest`, a complete web-standard
// adapter. It is not used here: it authenticates the bearer itself, which would
// mean two authentications per request on this route and a second spelling of
// the credential check. The route authenticates once through
// `authenticateApiKey` and calls the dispatcher the adapter calls, so there is
// one authentication and one authority.

import { workers } from "@repo/kith-store";
import { parseWorkerRequest } from "@repo/worker-protocol/request";

import {
  hasJsonContentType,
  IngestHttpError,
  readBoundedJson,
} from "@/lib/ingest/http";
import { kithPool } from "@/lib/kith/pool";
import { authenticateApiKey, type McpIdentity } from "@/lib/mcp/auth";
import { workerErrorForCode } from "@/lib/worker/http";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store" } as const;

function errorResponse(error: IngestHttpError): Response {
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

/**
 * The store's refusal, as the protocol's published status.
 *
 * `workerProtocolErrorCode` is the store's classifier over the protocol's closed
 * code set, and `workerErrorForCode` is the one table from a code to a status
 * and a message. An unclassified failure is a defect and gets a 500: this must
 * not invent a friendlier status for one.
 */
function postgresWorkerError(error: unknown): IngestHttpError {
  const code = workers.workerProtocolErrorCode(error);
  if (!code) {
    return new IngestHttpError(500, "worker_failed", "Worker operation failed");
  }
  return workerErrorForCode(code);
}

export async function POST(req: Request): Promise<Response> {

  let identity: McpIdentity | null;
  try {
    identity = await authenticateApiKey(req.headers.get("authorization"));
  } catch {
    return errorResponse(
      new IngestHttpError(
        503,
        "authentication_unavailable",
        "Authentication service is unavailable",
      ),
    );
  }
  if (!identity) {
    return errorResponse(
      new IngestHttpError(401, "not_authenticated", "Not authenticated"),
    );
  }
  if (!hasJsonContentType(req)) {
    return errorResponse(
      new IngestHttpError(
        415,
        "unsupported_media_type",
        "Content-Type must be application/json",
      ),
    );
  }

  let request;
  try {
    request = parseWorkerRequest(await readBoundedJson(req));
  } catch (error) {
    return errorResponse(
      error instanceof IngestHttpError
        ? error
        : new IngestHttpError(400, "invalid_request", "Invalid worker request"),
    );
  }

  try {
    // The dispatcher opens its own `SERIALIZABLE` transaction per request and
    // revalidates the command and the credential's current source-specific
    // access inside it. The principal reference carries no authority of its
    // own: it is the two identifiers `authenticateApiKey` returned.
    const result = await workers.dispatchWorkerRequest(
      kithPool(),
      { userId: identity.userId, credentialId: identity.keyId },
      request,
    );
    return Response.json(result, { status: 200, headers: RESPONSE_HEADERS });
  } catch (error) {
    return errorResponse(postgresWorkerError(error));
  }
}
