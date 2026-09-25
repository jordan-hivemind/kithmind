// `GET /api/kith/admin/banking-transactions?days=N`: the Banking & Cards
// screen's "widen" control. `loadBanking`'s own first paint already covers
// the default 90-day window through the shared `/api/kith/admin/[screen]`
// route; this is a second, dedicated read for a wider (or, `days` omitted,
// unbounded) window so the common case never pays for it.
//
// `days` unset or unparsable as a positive integer means "no window at
// all" -- every transaction these accounts hold, still capped by
// `loadBankingTransactions`'s own hard limit.

import { loadBankingTransactions } from "@/lib/kith/admin-data";
import { guardedRequest, mutationFailure, noStoreJson, problem } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDays(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export async function GET(request: Request): Promise<Response> {
  const guarded = guardedRequest(request);
  if (guarded) return guarded;
  const days = parseDays(new URL(request.url).searchParams.get("days"));
  try {
    const data = await loadBankingTransactions(
      request.headers.get("cookie"),
      { days },
    );
    if (data === null) return problem(401, "Not authenticated", "not_authenticated");
    return noStoreJson(data);
  } catch (error) {
    return mutationFailure(error);
  }
}
