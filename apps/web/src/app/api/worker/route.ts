import { api } from "@repo/db/convex/_generated/api";
import { parseWorkerRequest } from "@repo/db/convex/models/workers/protocol";
import { ConvexHttpClient } from "convex/browser";

import {
  hasJsonContentType,
  IngestHttpError,
  readBoundedJson,
} from "@/lib/ingest/http";
import { authenticateApiKey } from "@/lib/mcp/auth";
import { createConvexMcpToken } from "@/lib/mcp/convex-auth";
import { backendWorkerError } from "@/lib/worker/http";

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

export async function POST(req: Request): Promise<Response> {
  let identity: Awaited<ReturnType<typeof authenticateApiKey>>;
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
