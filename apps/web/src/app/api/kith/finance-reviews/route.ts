import {
  FinanceReviewActionError,
  type FinanceReviewStatus,
} from "@repo/finance-archive";
import { requireSpaceAccess } from "@repo/kith-store/identity";

import {
  guardedRequest,
  noStoreJson,
  parsedBody,
  problem,
  withPrincipalRead,
} from "@/lib/kith/api-route";
import { financeReviewActionSchema } from "@/lib/kith/finance-reviews";
import { resolveFinanceReviews } from "@/lib/mcp/finance-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actionFailure(error: FinanceReviewActionError): Response {
  if (error.code === "not_found") {
    return problem(404, error.message, error.code);
  }
  if (
    error.code === "not_open" ||
    error.code === "conflict" ||
    error.code === "safeguard_not_verified"
  ) {
    return problem(409, error.message, error.code);
  }
  return problem(400, error.message, error.code);
}

function statuses(
  value: string | null,
): FinanceReviewStatus | FinanceReviewStatus[] {
  if (value === null || value === "") return "open";
  const found = value.split(",");
  return found.length === 1
    ? (found[0] as FinanceReviewStatus)
    : (found as FinanceReviewStatus[]);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const archive = resolveFinanceReviews();
    if (archive === null) {
      return problem(
        404,
        "Finance review provider is not configured",
        "not_configured",
      );
    }
    await requireSpaceAccess(ctx, principal, archive.spaceId, "read");
    try {
      const reviewId = url.searchParams.get("reviewId");
      if (reviewId !== null) {
        const detail = await archive.get(reviewId);
        return detail === null
          ? problem(404, "Finance review item not found", "not_found")
          : noStoreJson(detail);
      }
      const accountId = url.searchParams.get("accountId") ?? undefined;
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const kind = url.searchParams.getAll("kind");
      return noStoreJson(
        await archive.list({
          accountId,
          cursor,
          kind: kind.length === 0 ? undefined : kind,
          status: statuses(url.searchParams.get("status")),
          limit: 100,
        }),
      );
    } catch (error) {
      if (error instanceof FinanceReviewActionError)
        return actionFailure(error);
      throw error;
    }
  });
}

export async function POST(request: Request): Promise<Response> {
  const guarded = guardedRequest(request);
  if (guarded) return guarded;
  const body = await parsedBody(request, financeReviewActionSchema);
  if ("response" in body) return body.response;
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const archive = resolveFinanceReviews();
    if (archive === null) {
      return problem(
        404,
        "Finance review provider is not configured",
        "not_configured",
      );
    }
    await requireSpaceAccess(ctx, principal, archive.spaceId, "write");
    if (archive.act === null) {
      return problem(
        503,
        "Finance review writer is not configured",
        "writer_not_configured",
      );
    }
    try {
      return noStoreJson({ outcome: await archive.act!(body.value) });
    } catch (error) {
      if (error instanceof FinanceReviewActionError)
        return actionFailure(error);
      throw error;
    }
  });
}
