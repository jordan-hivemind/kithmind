// `/api/kith/attention`: the attention queue's read and its per-item and
// bulk writes (ADM-8a).
//
// One file for three methods, the way `investments/route.ts` is: GET is the
// screen's list-and-refetch (filters and search live in the query string,
// the same request the change feed re-issues), PATCH covers undo and both
// snooze shapes, DELETE covers both dismiss shapes -- dismiss reuses DELETE
// the way `archiveInvestment` does, because "gone from the default view,
// recoverable, remembered" is the same shape as an archive, not a hard
// delete.
//
// The space set is `getAdminSpaceIds` inside `admin.listAttention` itself
// (owner or editor only, the same gate every admin screen uses): a reader
// gets an empty list rather than a denial, matching the layout's 404.

import { admin } from "@repo/kith-store";

import {
  noContent,
  noStoreJson,
  parsedBody,
  withPrincipal,
  withPrincipalRead,
} from "@/lib/kith/api-route";
import {
  attentionSeveritySchema,
  attentionStateSchema,
  deleteAttentionSchema,
  patchAttentionSchema,
} from "@/lib/kith/attention-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_LIST = 10;

/** A comma-separated query param, validated item by item against `schema`.
 * Absent or empty reads as "no filter" (`undefined`), not "match nothing".
 * An entry that fails the schema is dropped rather than refusing the whole
 * request: this is a read, its only caller is this app's own screen, and a
 * garbled filter value should narrow to nothing that value would have
 * matched anyway, not 500. */
function listParam<T extends string>(
  params: URLSearchParams,
  name: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): T[] | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const values = raw
    .split(",")
    .slice(0, MAX_QUERY_LIST)
    .map((value) => schema.safeParse(value))
    .filter((result) => result.success)
    .map((result) => result.data!);
  return values.length === 0 ? undefined : values;
}

export async function GET(request: Request): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const params = new URL(request.url).searchParams;
    const cursor = params.get("cursor") ?? undefined;
    const limitParam = params.get("limit");
    const [{ items, nextCursor }, counts] = await Promise.all([
      admin.listAttention(ctx, {
        principal,
        state: listParam(params, "state", attentionStateSchema),
        severity: listParam(params, "severity", attentionSeveritySchema),
        detector: params.get("detector") ?? undefined,
        targetKind: params.get("targetKind") ?? undefined,
        targetId: params.get("targetId") ?? undefined,
        search: params.get("search") ?? undefined,
        cursor,
        limit: limitParam === null ? undefined : Number(limitParam),
      }),
      admin.attentionSeverityCounts(ctx, { principal }),
    ]);
    return noStoreJson({ items, nextCursor, counts });
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, patchAttentionSchema);
    if ("response" in body) return body.response;
    const value = body.value;
    if (value.action === "undo") {
      await admin.undoDismissAttention(ctx, { principal, id: value.id });
    } else if (value.action === "snooze") {
      await admin.snoozeAttention(ctx, {
        principal,
        id: value.id,
        until: value.until,
      });
    } else {
      await admin.bulkSnoozeAttention(ctx, {
        principal,
        spaceId: value.spaceId,
        filter: value.filter,
        until: value.until,
      });
    }
    return noContent();
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, deleteAttentionSchema);
    if ("response" in body) return body.response;
    const value = body.value;
    if (value.action === "dismiss") {
      await admin.dismissAttention(ctx, {
        principal,
        id: value.id,
        reason: value.reason,
      });
      return noContent();
    }
    const result = await admin.bulkDismissAttention(ctx, {
      principal,
      spaceId: value.spaceId,
      filter: value.filter,
      reason: value.reason,
    });
    return noStoreJson(result);
  });
}
