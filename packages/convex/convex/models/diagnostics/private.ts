import { internalMutation } from "../../_generated/server";
import { sweepMissingWorkerHeartbeats } from "./model";

export const sweepMissingWorkers = internalMutation({
  args: {},
  handler: async (ctx) => await sweepMissingWorkerHeartbeats(ctx, Date.now()),
});
