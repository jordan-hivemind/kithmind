// `PATCH /api/kith/finance-accounts/:id`: the Institutions screen's edit panel.
//
// Sets the owner's own name, last four, type and closed flag for one archive
// account (`kith.finance_account_overrides`). A blank or null field clears that
// override; all four blank clears the row. The space is always the archive's
// own, never taken from the request.

import { admin } from "@repo/kith-store";
import { z } from "zod";

import {
  noContent,
  parsedBody,
  problem,
  withPrincipal,
} from "@/lib/kith/api-route";
import { resolveFinanceArchive } from "@/lib/mcp/finance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  displayName: z.string().max(200).nullable(),
  accountLast4: z
    .string()
    .regex(/^[0-9]{4}$/)
    .nullable(),
  accountType: z.string().max(100).nullable(),
  closed: z.boolean(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, bodySchema);
    if ("response" in body) return body.response;
    const archive = resolveFinanceArchive();
    if (archive === null) return problem(404, "Finance archive not configured");
    await admin.setAccountOverride(ctx, {
      principal,
      spaceId: archive.spaceId,
      accountId: id,
      ...body.value,
    });
    return noContent();
  });
}
