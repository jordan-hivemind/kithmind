// `PATCH /api/kith/finance-accounts/:id`: the Institutions screen's edit panel.
//
// Sets the owner's own name, last four, type and closed flag for one archive
// account (`kith.finance_account_overrides`). A blank or null field clears that
// override; all four blank clears the row. The space is always the archive's
// own, never taken from the request.
//
// Three steps rather than one transaction, and the order is the point.
//
//   1. May this caller write the archive's space? Checked first, so that the
//      404 in step 2 cannot tell somebody who may not write it whether an
//      account id exists. Read-only, and not the authoritative check: step 3's
//      `setAccountOverride` runs `requireSpaceAccess` again inside the write
//      transaction, which is the one that decides.
//   2. Does the archive hold this account? `finance_account_id` is not a
//      foreign key -- the archive is a different database -- so without this
//      any string would become a durable row that nothing ever shows or
//      collects. An archive that will not answer refuses the write rather than
//      waving it through.
//   3. The write, in one kith transaction.
//
// Step 2 is deliberately outside both transactions. It reads a second database
// through a second pool, and a kith transaction held open across it would sit
// idle for that whole round trip against a 5s idle-in-transaction timeout,
// which is the same reason `admin-data.ts` resolves the archive outside its
// page transaction.

import { admin } from "@repo/kith-store";
import { type Principal, requireSpaceAccess } from "@repo/kith-store/identity";
import { z } from "zod";

import { archiveHoldsAccount } from "@/lib/kith/admin-data";
import {
  guardedRequest,
  noContent,
  parsedBody,
  problem,
  withPrincipal,
  withPrincipalRead,
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
  const guarded = guardedRequest(request);
  if (guarded) return guarded;
  const body = await parsedBody(request, bodySchema);
  if ("response" in body) return body.response;
  const archive = resolveFinanceArchive();
  if (archive === null) return problem(404, "Finance archive not configured");

  // Step 1. `session.value` is set only if the block below ran to its end, so
  // anything else is a denial, returned as whatever `withPrincipalRead` mapped
  // it to -- the same 401 and 403 shapes every other `/api/kith/*` route
  // returns, rather than a second opinion invented here.
  const session: { value?: { principal: Principal; spaces: string[] } } = {};
  const denial = await withPrincipalRead(request, async ({ ctx, principal }) => {
    await requireSpaceAccess(ctx, principal, archive.spaceId, "write");
    session.value = {
      principal,
      spaces: await admin.getAdminSpaceIds(ctx, principal),
    };
    return noContent();
  });
  if (session.value === undefined) return denial;
  const { principal, spaces } = session.value;

  // Step 2.
  const held = await archiveHoldsAccount(archive, principal, spaces, id);
  if (held === "unavailable") {
    return problem(503, "Finance archive unavailable", "archive_unavailable");
  }
  if (!held) return problem(404, "Account not found", "not_found");

  // Step 3.
  return withPrincipal(request, async ({ ctx, principal: writer }) => {
    await admin.setAccountOverride(ctx, {
      principal: writer,
      spaceId: archive.spaceId,
      accountId: id,
      ...body.value,
    });
    return noContent();
  });
}
