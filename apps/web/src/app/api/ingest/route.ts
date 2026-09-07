import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { ConvexHttpClient } from "convex/browser";

import {
  backendIngestError,
  hasJsonContentType,
  IngestHttpError,
  parseIngestRequest,
  readBoundedJson,
} from "@/lib/ingest/http";
import { authenticateApiKey } from "@/lib/mcp/auth";
import { createConvexMcpToken } from "@/lib/mcp/convex-auth";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
} as const;

function errorResponse(error: IngestHttpError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    {
      status: error.status,
      headers: {
        ...RESPONSE_HEADERS,
        ...(error.status === 401
          ? { "WWW-Authenticate": 'Bearer realm="ingest"' }
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
      new IngestHttpError(401, "unauthorized", "Unauthorized"),
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

  let input;
  try {
    input = parseIngestRequest(await readBoundedJson(req));
  } catch (error) {
    return errorResponse(
      error instanceof IngestHttpError
        ? error
        : new IngestHttpError(400, "invalid_request", "Invalid ingest request"),
    );
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return errorResponse(
      new IngestHttpError(
        503,
        "ingest_unavailable",
        "Ingestion service is unavailable",
      ),
    );
  }

  try {
    const token = await createConvexMcpToken(identity);
    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(token);
    const result = await convex.action(api.models.ingestion.inlineMcp.ingest, {
      input: {
        ...(input.spaceId === undefined
          ? {}
          : { spaceId: input.spaceId as Id<"spaces"> }),
        requestId: input.requestId,
        expectedDesiredProcessingEpoch: input.expectedDesiredProcessingEpoch,
        source: input.source,
        title: input.title,
        text: input.text,
        ...(input.docType === undefined ? {} : { docType: input.docType }),
      },
    });
    const status =
      result.state === "ready" ? 200 : result.state === "failed" ? 500 : 202;
    return Response.json(
      {
        sourceItemId: result.sourceItemId,
        sourceRevisionId: result.sourceRevisionId,
        processingGenerationId: result.processingGenerationId,
        ingestJobId: result.ingestJobId,
        ...(result.documentId === undefined
          ? {}
          : { documentId: result.documentId }),
        desiredProcessingEpoch: result.desiredProcessingEpoch,
        isActive: result.isActive,
        state: result.state,
      },
      { status, headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    return errorResponse(backendIngestError(error));
  }
}
