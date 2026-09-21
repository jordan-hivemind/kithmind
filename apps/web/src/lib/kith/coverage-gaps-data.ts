import { coverage } from "@repo/kith-store";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

export async function loadCoverageGaps(cookieHeader: string | null) {
  return await loadAuthenticatedPage(cookieHeader, ({ ctx, principal }) =>
    coverage.listCoverageGaps(ctx, { principal }),
  );
}
