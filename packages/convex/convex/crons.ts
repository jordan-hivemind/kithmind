import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "recover inline ingestion",
  { minutes: 1 },
  internal.models.ingestion.inlineWorker.recover,
  {},
);

crons.interval(
  "remove expired OAuth grants",
  { minutes: 5 },
  internal.models.oauth.cleanup.removeExpired,
  {},
);

export default crons;
