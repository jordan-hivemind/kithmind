// Bounded inline text capture, on either surface.
//
// Row i4 of the web and MCP surface plan. The route's shape does not change:
// authenticate, require JSON, parse and bound the body, hand the validated
// input to the ingestion lane, and answer with the status the bounded text
// capture contract publishes. What changes is which lane runs.
//
// Under `convex` it is `models.ingestion.inlineMcp.ingest`, unchanged. Under
// `postgres` it is `ingestion.ingestInlineText` from `@repo/kith-store`, which
// is P2-39e2's port of that same action: admit, process, answer. Both the
// authentication and the work follow the flag together, which is the rule i2's
// pin existed to keep while only one of the two had moved.
//
// The response is byte-identical between the surfaces because it is built here
// from one result shape rather than by each lane, and the error mapping is the
// one table in `lib/ingest/http.ts` for the Convex leg and the store's own
// `inlineIngestErrorCode` for the PostgreSQL one -- two classifiers over the
// same closed code set, because the codes are the contract and the messages
// they are derived from live in two packages.
//
// Idempotency is the lane's, not the route's. A repeated `requestId` against
// the same source account returns the first admission's rows: `admitInlineWork`
// reuses them rather than admitting again, and a `requestId` that arrives with
// different content is a 409 rather than a second admission.

import { api } from "@repo/db/convex/_generated/api";
import { ingestion } from "@repo/kith-store";
import { ConvexHttpClient } from "convex/browser";

import {
  backendIngestError,
  hasJsonContentType,
  IngestHttpError,
  type IngestRequest,
  parseIngestRequest,
  readBoundedJson,
  structuredBackendIngestError,
} from "@/lib/ingest/http";
import { kithPool } from "@/lib/kith/pool";
import { kithPostgresSurface } from "@/lib/kith/surface";
import { authenticateApiKey, type McpIdentity } from "@/lib/mcp/auth";
import { createConvexMcpToken } from "@/lib/mcp/convex-auth";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
} as const;

/** The published status shape, identical on both surfaces. */
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
 * `inlineIngestErrorCode` returns the same closed code set
 * `parseInlineIngestErrorData` returns on the Convex leg, so both surfaces
 * reach the same row of the published table. An unclassified failure is a
 * defect and gets a 500: this must not invent a friendlier status for one.
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

async function ingestOnConvex(
  identity: McpIdentity,
  input: IngestRequest,
): Promise<InlineIngestResult> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new IngestHttpError(
      503,
      "ingest_unavailable",
      "Ingestion service is unavailable",
    );
  }
  const token = await createConvexMcpToken(identity);
  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(token);
  return await convex.action(api.models.ingestion.inlineMcp.ingest, {
    input: {
      ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
      requestId: input.requestId,
      expectedDesiredProcessingEpoch: input.expectedDesiredProcessingEpoch,
      source: input.source,
      title: input.title,
      text: input.text,
      ...(input.docType === undefined ? {} : { docType: input.docType }),
    },
  });
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
    result =
      surface === "postgres"
        ? await ingestOnPostgres(identity, input)
        : await ingestOnConvex(identity, input);
  } catch (error) {
    if (error instanceof IngestHttpError) return errorResponse(error);
    return errorResponse(
      surface === "postgres"
        ? postgresIngestError(error)
        : backendIngestError(error),
    );
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
