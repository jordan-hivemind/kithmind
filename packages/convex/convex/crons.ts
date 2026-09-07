import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "recover inline ingestion",
  { minutes: 1 },
  internal.models.ingestion.inlineWorker.recover,
  {},
);

export default crons;
