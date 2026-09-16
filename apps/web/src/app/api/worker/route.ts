// The worker protocol endpoint, on either surface.
//
// Row i4 of the web and MCP surface plan. The route keeps every step it had --
// authenticate, require JSON, read a bounded body, parse the request against
// the protocol, dispatch, map a protocol refusal to its published status -- and
// changes only which dispatcher runs. Under `convex` it is
// `models.workers.mcp.dispatch`; under `postgres` it is
// `workers.dispatchWorkerRequest` from `@repo/kith-store`, which P2-39d wrote
// and which switches on the same `operation` over the same parsed request.
//
// Wire parity is a property of three things being shared rather than of this
// file being careful:
//
//   * One parser. `parseWorkerRequest` is `@repo/worker-protocol`'s, and both
//     `@repo/db/convex/models/workers/protocol` and the store re-export it, so
//     a body that parses on one surface parses on the other and a body that
//     does not is a 400 on both.
//   * One error code set. `workerProtocolErrorCode` on the store side and
//     `parseWorkerProtocolErrorData` on the Convex side both yield a
//     `WorkerProtocolErrorCode`, and `backendWorkerError` is the single table
//     from that code to a status and a message.
//   * One result shape. Both dispatchers return `WorkerResult`, which this
//     route serializes unchanged.
//
// The store also ships `handlePostgresWorkerRequest`, a complete web-standard
// adapter. It is not used here: it authenticates the bearer itself, which would
// mean two authentications per request on this route and a second spelling of
// the credential check that the surface flag does not reach. The route
// authenticates once through `authenticateApiKey` and calls the dispatcher the
// adapter calls, so there is one authentication and one authority.

import { api } from "@repo/db/convex/_generated/api";
import { parseWorkerRequest } from "@repo/db/convex/models/workers/protocol";
import { workers } from "@repo/kith-store";
import { ConvexHttpClient } from "convex/browser";

import {
  hasJsonContentType,
  IngestHttpError,
  readBoundedJson,
} from "@/lib/ingest/http";
import { kithPool } from "@/lib/kith/pool";
import { kithPostgresSurface } from "@/lib/kith/surface";
import { authenticateApiKey, type McpIdentity } from "@/lib/mcp/auth";
import { createConvexMcpToken } from "@/lib/mcp/convex-auth";
import { backendWorkerError, workerErrorForCode } from "@/lib/worker/http";

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
 * `workerProtocolErrorCode` is the store's classifier over the same closed code
 * set `parseWorkerProtocolErrorData` reads off a `ConvexError`, so both
 * surfaces land on the same row of `backendWorkerError`'s table. An
 * unclassified failure is a defect and gets the same 500 the Convex leg gives
 * one.
 */
function postgresWorkerError(error: unknown): IngestHttpError {
  const code = workers.workerProtocolErrorCode(error);
  if (!code) {
    return new IngestHttpError(500, "worker_failed", "Worker operation failed");
  }
  return workerErrorForCode(code);
}

export async function POST(req: Request): Promise<Response> {
  const surface = kithPostgresSurface();

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

  if (surface === "postgres") {
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

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return errorResponse(
      new IngestHttpError(
        503,
        "worker_unavailable",
        "Worker service is unavailable",
      ),
    );
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(await createConvexMcpToken(identity));
    // The backend revalidates the command and current source-specific access.
    // A request can never select an arbitrary Convex function or principal.
    const result = await convex.action(api.models.workers.mcp.dispatch, {
      request,
    });
    return Response.json(result, { status: 200, headers: RESPONSE_HEADERS });
  } catch (error) {
    return errorResponse(backendWorkerError(error));
  }
}
