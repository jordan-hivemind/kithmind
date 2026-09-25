// `GET /api/kith/admin/banking-accounts/{id}`: the Banking & Cards account
// drawer's own read -- the account's latest 50 transactions and its last 12
// month-end balances. A dedicated route rather than folding into
// `/api/kith/admin/banking`: opening one row's drawer must not reload every
// account and the whole transactions window first.

import { loadBankingAccountDetail } from "@/lib/kith/admin-data";
import { guardedRequest, mutationFailure, noStoreJson, problem } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = guardedRequest(request);
  if (guarded) return guarded;
  const { id } = await context.params;
  try {
    const data = await loadBankingAccountDetail(request.headers.get("cookie"), id);
    if (data === null) return problem(401, "Not authenticated", "not_authenticated");
    return noStoreJson(data);
  } catch (error) {
    return mutationFailure(error);
  }
}
