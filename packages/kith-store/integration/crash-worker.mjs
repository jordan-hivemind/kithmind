import pg from "pg";

import { PostgresProof } from "../dist/index.js";

const config = JSON.parse(process.env.POSTGRES_PROOF_CHILD_CONFIG ?? "null");
const apiKey = process.env.POSTGRES_PROOF_CHILD_API_KEY;
if (
  !config ||
  typeof apiKey !== "string" ||
  typeof process.send !== "function"
) {
  throw new Error("invalid_crash_worker_environment");
}

const pool = new pg.Pool(config);
const proof = new PostgresProof(pool);
const lease = await proof.claimWorkerJob(apiKey, { leaseSeconds: 2 });
if (!lease) throw new Error("expected_worker_lease");
process.send({ type: "claimed", lease });

setInterval(() => {}, 60_000);
