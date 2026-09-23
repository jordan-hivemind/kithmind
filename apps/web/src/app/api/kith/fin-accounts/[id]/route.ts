// `PATCH /api/kith/fin-accounts/:id`: the Balances and Institutions screens'
// Rename action for a feed-only account (FIN-5, migration 052).
//
// `kith.fin_accounts` carries no space, unlike the archive account an
// override (`/api/kith/finance-accounts/:id`) corrects, so there is no
// per-resource space to check `requireSpaceAccess` against. The same rule
// the admin panel's own layout applies before this screen is reachable at
// all -- `getAdminSpaceIds` non-empty, i.e. the caller administers at least
// one space -- gates the write instead; see
// `admin.setFinAccountDisplayName`'s own comment for why that is the right
// substitute here.
//
// `id` is `kith.fin_accounts.id`, not the archive's own account id: an
// archive-linked account is never written through this route -- the same
// Rename action on that kind of row writes `kith.finance_account_overrides`
// through the existing `/api/kith/finance-accounts/:id`, so an account is
// never nameable two different ways at once.

import { admin } from "@repo/kith-store";
import { z } from "zod";

import {
  guardedRequest,
  noContent,
  parsedBody,
  withPrincipal,
} from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  displayName: z.string().max(300).nullable(),
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

  return withPrincipal(request, async ({ ctx, principal }) => {
    await admin.setFinAccountDisplayName(ctx, {
      principal,
      accountId: id,
      displayName: body.value.displayName,
    });
    return noContent();
  });
}
