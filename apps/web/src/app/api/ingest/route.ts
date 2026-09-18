// Bounded inline text capture.
//
// Row i4 of the web and MCP surface plan. The route: authenticate, require
// JSON, parse and bound the body, hand the validated input to the ingestion
// lane, and answer with the status the bounded text capture contract publishes.
// i7b left one lane, `ingestion.ingestInlineText` from `@repo/kith-store`,
// which is P2-39e2's port of the Convex action: admit, process, answer.
//
// The response is built here from one result shape rather than by the lane, and
// the error mapping is the store's `inlineIngestErrorCode` over the published
// closed code set into `structuredBackendIngestError`'s table.
//
// Idempotency is the lane's, not the route's. A repeated `requestId` against
// the same source account returns the first admission's rows: `admitInlineWork`
// reuses them rather than admitting again, and a `requestId` that arrives with
// different content is a 409 rather than a second admission.

import { ingestion } from "@repo/kith-store";

import {
  hasJsonContentType,
  IngestHttpError,
  type IngestRequest,
  parseIngestRequest,
  readBoundedJson,
  structuredBackendIngestError,
} from "@/lib/ingest/http";
import { kithPool } from "@/lib/kith/pool";
import { authenticateApiKey, type McpIdentity } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
} as const;

/** The published status shape. */
type InlineIngestResult = {
  sourceItemId: string;
  sourceRevisionId: string;
  processingGenerationId: string;
  ingestJobId: string;
  documentId?: string;
  desiredProcessingEpoch: number;
  isActive: boolean;
  state: "ready" | "queued" | "needs_review" | "failed";
};

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

/**
 * The store's refusal, as the contract's status.
 *
 * `inlineIngestErrorCode` classifies a thrown message into the contract's closed
 * code set, and `structuredBackendIngestError` is the one table from a code to a
 * row of the published status table. An unclassified failure is a defect and
 * gets a 500: this must not invent a friendlier status for one.
 */
function postgresIngestError(error: unknown): IngestHttpError {
  const code = ingestion.inlineIngestErrorCode(error);
  if (!code) {
    return new IngestHttpError(500, "ingest_failed", "Ingestion failed");
  }
  return structuredBackendIngestError(code);
}

async function ingestOnPostgres(
  identity: McpIdentity,
  input: IngestRequest,
): Promise<InlineIngestResult> {
  return await ingestion.ingestInlineText(
    kithPool(),
    { userId: identity.userId, credentialId: identity.keyId },
    {
      ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
      requestId: input.requestId,
      expectedDesiredProcessingEpoch: input.expectedDesiredProcessingEpoch,
      source: input.source,
      title: input.title,
      text: input.text,
      ...(input.docType === undefined ? {} : { docType: input.docType }),
    },
  );
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

  let input: IngestRequest;
  try {
    input = parseIngestRequest(await readBoundedJson(req));
  } catch (error) {
    return errorResponse(
      error instanceof IngestHttpError
        ? error
        : new IngestHttpError(400, "invalid_request", "Invalid ingest request"),
    );
  }

  let result: InlineIngestResult;
  try {
    result = await ingestOnPostgres(identity, input);
  } catch (error) {
    if (error instanceof IngestHttpError) return errorResponse(error);
    return errorResponse(postgresIngestError(error));
  }

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
}
