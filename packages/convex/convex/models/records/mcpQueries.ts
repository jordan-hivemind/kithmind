import { query } from "../../_generated/server";

import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import { listReviewQueue as listReviewQueueRows } from "./reviewQueue";
import { reviewQueueListArgs } from "./validators";

export const listReviewQueue = query({
  args: reviewQueueListArgs,
  handler: async (ctx, args) => {
    const { spaceIds: requestedSpaceIds, ...rest } = args;
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      requestedSpaceIds,
    );
    return await listReviewQueueRows(ctx, spaceIds, rest);
  },
});
