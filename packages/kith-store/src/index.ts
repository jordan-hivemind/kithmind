import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { ProofError } from "./errors.js";
import { sha256 } from "./hash.js";
import {
  applyKithSchema,
  KITH_DOMAINS,
  KITH_SCHEMA,
  withKithTransaction,
} from "./schema.js";

export { ProofError } from "./errors.js";
export { sha256 } from "./hash.js";
export {
  assertKithId,
  GENERATED_KITH_ID_LENGTH,
  KITH_ID,
  newKithId,
} from "./ids.js";
export { spacePredicate, type SpacePredicate } from "./spaces.js";
export {
  keywordSearchSql,
  TEXT_SEARCH_CONFIG,
  type KeywordSearchSql,
} from "./textSearch.js";
export {
  applyKithReaderRole,
  applyKithSchema,
  createKithPool,
  KITH_DOMAINS,
  KITH_IDLE_TRANSACTION_TIMEOUT_MS,
  KITH_LOCK_TIMEOUT_MS,
  KITH_MIGRATIONS,
  KITH_SCHEMA,
  KITH_SCHEMA_LOCK_KEY,
  KITH_SCHEMA_VERSION,
  KITH_SERIALIZATION_ATTEMPTS,
  KITH_SERIALIZATION_BACKOFF_BASE_MS,
  KITH_SERIALIZATION_BACKOFF_MAX_MS,
  KITH_STATEMENT_TIMEOUT_MS,
  kithSchemaVersion,
  kithSerializationBackoffDelayMs,
  setKithSerializationSleep,
  withKithQueueTransaction,
  withKithReadTransaction,
  withKithTransaction,
  type KithMigration,
} from "./schema.js";
export * as provenance from "./provenance/index.js";
export * as documents from "./documents/index.js";
export * as embeddings from "./embeddings/index.js";
export * as memory from "./memory/index.js";
export * as eval from "./eval/index.js";
export * as ingestion from "./ingestion/index.js";
export * as workers from "./workers/index.js";
export * as records from "./records/index.js";
export * as sources from "./sources/index.js";
export * as deferred from "./deferred/index.js";
export * as admin from "./admin/index.js";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EnqueueWorkerJobInput = {
  requestId: string;
  workKind: "synthetic_document_processing";
  workKey: string;
  inputHash: string;
  maxAttempts: number;
};

export type WorkerJobState = "queued" | "running" | "succeeded" | "failed";

export type WorkerJob = {
  jobId: string;
  workKind: "synthetic_document_processing";
  workKey: string;
  inputHash: string;
  state: WorkerJobState;
  attemptCount: number;
  maxAttempts: number;
  leaseEpoch: number;
  outputHash?: string;
  failureCode?: "attempts_exhausted";
};

export type WorkerLease = WorkerJob & {
  state: "running";
  leaseToken: string;
  leaseExpiresAt: string;
};

export type EnqueueWorkerJobResult = {
  jobId: string;
  accepted: true;
};

export type CompleteWorkerJobResult = WorkerJob & {
  state: "succeeded";
  outputHash: string;
  completedAt: string;
  reused: boolean;
};

export function newSyntheticApiKey(): string {
  return `km_proof_${randomBytes(32).toString("base64url")}`;
}

function keyHash(apiKey: string): Buffer {
  if (
    typeof apiKey !== "string" ||
    apiKey.length < 32 ||
    apiKey.length > 256 ||
    !/^[\x21-\x7e]+$/.test(apiKey)
  ) {
    throw new ProofError("invalid_api_key");
  }
  return createHash("sha256").update(apiKey, "utf8").digest();
}

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new ProofError("invalid_request_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new ProofError("invalid_request_value");
}

function expectUuid(value: string, code: string): void {
  if (typeof value !== "string" || !UUID.test(value))
    throw new ProofError(code);
}

function expectHash(value: string, code: string): void {
  if (typeof value !== "string" || !SHA256.test(value))
    throw new ProofError(code);
}

function expectText(
  value: string,
  min: number,
  max: number,
  code: string,
): void {
  if (typeof value !== "string") throw new ProofError(code);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < min || bytes > max || value.includes("\0"))
    throw new ProofError(code);
}

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  code: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProofError(code);
  const keys = Object.keys(value).sort();
  const expected = [...allowed].filter((key) => key in value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  )
    throw new ProofError(code);
}

/**
 * The proof surface's entry point: apply the schema, then grant the app role
 * what it needs. The schema half is `applyKithSchema` (schema.ts), which every
 * caller in the port shares; this keeps the grant beside it so a caller cannot
 * end up with tables no role can write.
 */
export async function applyProofMigration(
  owner: Pool,
  appRole: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(appRole))
    throw new ProofError("invalid_app_role");
  const client = await owner.connect();
  try {
    await applyKithSchema(client);
  } finally {
    client.release();
  }
  await grantProofAppRole(owner, appRole);
}

export async function grantProofAppRole(
  owner: Pool,
  appRole: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(appRole))
    throw new ProofError("invalid_app_role");
  // CONNECT on the database itself, first. PostgreSQL grants CONNECT to
  // PUBLIC on a new database, so a fresh throwaway never needed this; the
  // hosted archive database is not fresh. `packages/pg/src/readerRole.ts`
  // hardens the finance reader by revoking PUBLIC's CONNECT and TEMPORARY on
  // the whole database and granting CONNECT back to the reader alone, and
  // `kith` shares that database. Without this line every grant below applies
  // and the role still cannot log in (42501 at connection), which is exactly
  // what the first hosted app-role run reported. TEMPORARY is deliberately
  // not granted: the app role has no reason to stage data in the server.
  const database = (
    await owner.query<{ db: string }>("SELECT current_database() AS db")
  ).rows[0]?.db;
  if (!database) throw new ProofError("invalid_app_role");
  await owner.query(
    `GRANT CONNECT ON DATABASE "${database.replaceAll('"', '""')}" TO "${appRole}"`,
  );
  await owner.query(`REVOKE ALL ON SCHEMA kith FROM PUBLIC`);
  await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA kith FROM PUBLIC`);
  await owner.query(`GRANT USAGE ON SCHEMA kith TO "${appRole}"`);
  await owner.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA kith TO "${appRole}"`,
  );
  // The write grant covers every table the currently exported service
  // surfaces write. P2-39e's first slice adds only the entry-resolution
  // foundation; scan, reservation, receipt and assessment tables stay
  // read-only until the operations that write them land.
  //
  // `embedding_vectors` joins the list with P2-39g1. The retrieval legs in
  // `src/embeddings/search.ts` only read it, but the vector index has a
  // writer -- the fill driver, and the tests that stand rows up for the
  // search legs -- and a table no role can write is a table the next slice
  // silently cannot fill.
  //
  // P2-39g2 adds the rest of that writer's tables and `thoughts`. Five of the
  // six are the embedding index's own bookkeeping: the profile a fingerprint
  // names, the space state holding the counters, the generation lifecycle, the
  // target rows and the build job row. `thoughts` joins them because
  // `captureThought` and `transitionMemory` in `src/memory/thoughts.ts` are
  // exported writes of that table and were reachable only through the owner
  // role until now, which made the memory domain a read-only surface for the
  // application credential by accident rather than by decision.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.worker_jobs, kith.source_items, kith.source_revisions,
    kith.source_parser_artifacts, kith.source_artifact_archive_receipts,
    kith.source_artifact_archive_bindings, kith.source_artifact_deletion_acks,
    kith.source_provider_original_references, kith.source_provider_original_bindings,
    kith.source_provider_original_detach_acks, kith.source_text_versions,
    kith.source_pages, kith.evidence_spans, kith.documents, kith.chunks,
    kith.processing_generations, kith.processing_generation_payload_manifests,
    kith.source_inventory, kith.source_alias_digests,
    kith.worker_scan_entries, kith.worker_discovery_work,
    kith.worker_protocol_rate_limits, kith.ingest_jobs,
    kith.embedding_vectors, kith.embedding_profiles,
    kith.space_embedding_states, kith.embedding_generations,
    kith.embedding_targets, kith.embedding_build_jobs,
    kith.thoughts TO "${appRole}"`);
  // P2-39i adds the four groups the web and MCP surface writes, which were the
  // gap section 4.2 of the surface plan found: "`kith.sessions` cannot be
  // written by the app role as the code stands", and the same was true of every
  // other table the dashboard touches. Until now the identity, memory, records
  // and coverage services were reachable only through the owner role, which made
  // a whole domain read-only for the application credential by accident.
  //
  // Identity is every table `src/identity/` writes: the account pair, the
  // session row logout has to be able to revoke, the API key with its two grant
  // tables, the OAuth code receipt, and the space, membership and settings rows
  // `ensurePersonalSpace` creates on first sign-in. `kith.auth_rate_limits`
  // joins the group as a P2-39i follow-up: the durable table section 8
  // question 2 of the surface plan opened a row for, written by
  // `identity/rateLimits.ts` `consumeAuthAttempt` from the same route that
  // writes `kith.sessions`.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.users, kith.auth_accounts, kith.sessions,
    kith.api_keys, kith.api_key_spaces, kith.api_key_source_accounts,
    kith.consumed_oauth_codes, kith.spaces, kith.space_members,
    kith.family_invitations, kith.user_space_settings,
    kith.auth_rate_limits TO "${appRole}"`);
  // Memory: `entities` and `facts`. `thoughts` is already granted above, with
  // P2-39g2's embedding tables.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.entities, kith.facts TO "${appRole}"`);
  // Records: the event stream `src/records/` writes and the query-session
  // bookkeeping a paged record query keeps between requests.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.events, kith.event_versions, kith.observations,
    kith.record_query_sessions, kith.record_query_space_state TO "${appRole}"`);
  // Coverage: the validated windows and the gaps between them.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.coverage_windows, kith.coverage_gaps TO "${appRole}"`);
  // Inline ingestion (P2-39e2). `kith.ingest_jobs` was already granted with the
  // worker protocol, but the four tables the inline lane owns were not, and one
  // of them was already unreachable for a lane that had landed: `discovery.ts`
  // writes `kith.ingest_requests` on every worker admission. The other three are
  // this row's: the work row the deferred handler drains, the fixed-window
  // admission limiter, and the queue-only `ingest_url` request.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.ingest_requests, kith.inline_work, kith.ingest_rate_limits,
    kith.source_fetch_requests TO "${appRole}"`);
  // The admin panel (ADM-1, migration 022): the seven configuration and
  // investment tables the admin screens own.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.document_types, kith.document_type_fields,
    kith.source_roots, kith.source_root_reports,
    kith.investments, kith.investment_entries, kith.corrections
    TO "${appRole}"`);
  // Typed extraction (ADM-5a). The daemon that drains
  // `document_extraction` connects as this role, so without this grant every
  // extraction fails with 42501 on its first INSERT -- and only in production,
  // because every test runs as the owner role, which is exactly the failure
  // mode this whole function exists to make visible. The `kith.events`,
  // `kith.event_versions` and `kith.observations` the same job writes are
  // already granted above with the records group.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.document_extractions TO "${appRole}"`);
  // The worker protocol's own tables (ADM-9, and its independent review).
  //
  // The comment further down said these would be granted "when the operations
  // that write them land". They landed. Thirteen tables that a handler in
  // `src/workers/` writes were in no group above, and reading the handlers is
  // the only way to find that: `worker_source_scans`, `worker_scan_pages`,
  // `worker_reservation_receipts`, `worker_reservation_targets`,
  // `worker_operation_receipts`, `worker_binary_operation_receipts`,
  // `worker_parsed_stages`, `worker_processing_assessments`,
  // `worker_watcher_states`, `worker_operational_incidents`,
  // `worker_watcher_reset_receipts`, `space_processing_state` and
  // `source_accounts` -- the last of which every epoch bump goes through, so
  // the gap reaches almost the whole protocol rather than one corner of it.
  //
  // This has never fired in production, and the reason is worth writing down
  // rather than guessing at: the hosted web app connects as the database OWNER
  // role, not as `kith_app`. The app-role cutover was started and never
  // finished. So this list is latent, not live -- it is what would break the
  // watcher on the day someone completes that cutover, which is exactly the
  // failure mode `test/appRoleGrants.test.mjs` exists to make visible before
  // it happens rather than after.
  //
  // `test/appRoleGrants.test.mjs` now derives its assertion from the same
  // place this list comes from: every `kith.` table named by an INSERT, UPDATE
  // or DELETE anywhere in `src/workers/`.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.source_accounts, kith.space_processing_state,
    kith.worker_source_scans, kith.worker_scan_pages,
    kith.worker_reservation_receipts, kith.worker_reservation_targets,
    kith.worker_operation_receipts, kith.worker_binary_operation_receipts,
    kith.worker_parsed_stages, kith.worker_processing_assessments,
    kith.worker_watcher_states, kith.worker_operational_incidents,
    kith.worker_watcher_reset_receipts
    TO "${appRole}"`);
  // The attention queue (ADM-8a, migration 030). `kith.corrections` is
  // already granted above with the admin panel; `kith.attention_mutes` is
  // the one new table this slice adds.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.attention_mutes TO "${appRole}"`);
  // Investment document matching (ADM-8b, migration 033). One new table.
  // `investment_entries` and `corrections` are already granted above with the
  // admin panel, and the date rule writes both of them through this same
  // credential. No new function, so there is no EXECUTE grant to forget --
  // the one trap `kith.sensitivity_rank` fell into below.
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.investment_document_links TO "${appRole}"`);
  // The change feed (migration 023) is deliberately not in the list above.
  //
  // Nothing in the application writes `kith.changes`: rows arrive only through
  // `kith.record_change()`, which is `SECURITY DEFINER` and therefore inserts
  // as the migration role that owns it. So the application credential gets no
  // INSERT -- a write through it would be a forged change row, and now it is
  // not merely unwritten but unwritable -- and no UPDATE, because a change
  // already recorded is a fact about the past.
  //
  // DELETE is the one write it does need: `removeExpiredChanges`
  // (src/deferred/sweeps.ts) runs on the daemon under this credential. SELECT
  // comes from the schema-wide grant above, which is what the feed route
  // reads through.
  //
  // The definer's rights are also what decouples the schema from the grants:
  // applying 022 and 023 to a live database cannot break an app-role write on
  // any triggered table, whether or not this function has run yet.
  await owner.query(`GRANT DELETE ON kith.changes TO "${appRole}"`);
  // Deliberately still absent, and each one is a table an application write
  // would be a bug on: `kith.schema_version`, which only a migration runner
  // writes, and the `proof_*` prototype pair, which only the owner role seeds.
  // (The worker receipt and reservation tables this note used to defer are
  // granted above as of ADM-9; their operations have all landed.)
  // `test/appRoleGrants.test.mjs` asserts the
  // app role is refused on the first two, because a grant that had quietly
  // become `ALL TABLES` would otherwise pass every assertion above.
  // pgvector lives in `public` (migration 015 says why), and every vector
  // read names its type and operators there. Applying the reader role revokes
  // PUBLIC's default USAGE on `public`, so the writer is granted it by name
  // for the same reason the domains below are.
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${appRole}"`);
  // EXECUTE on a function is granted to PUBLIC by default and revoked from
  // PUBLIC when the reader role is applied (`REVOKE ALL ON ALL ROUTINES IN
  // SCHEMA kith FROM PUBLIC`, packages/pg/src/readerRole.ts), so the writer is
  // granted it by name for the same reason the domains below are.
  //
  // `kith.sensitivity_rank` (migration 032) is the one function the
  // application calls: `src/sensitivity/model.ts` names it directly in the
  // ceiling predicate, and both sensitivity views call it too, so without this
  // grant a narrowed key's every read fails with 42501 -- and only on a host
  // where the reader role has been applied since that function was created,
  // which is the hosted archive and nowhere else. `kith.record_change` is
  // deliberately not granted: it is SECURITY DEFINER and reached only through
  // triggers, whose EXECUTE is checked when the trigger is created.
  await owner.query(
    `GRANT EXECUTE ON FUNCTION ${KITH_SCHEMA}.sensitivity_rank(text) TO "${appRole}"`,
  );
  // USAGE on a domain is granted to PUBLIC by default and revoked from PUBLIC
  // when the reader role is applied, so the writer is granted it by name.
  for (const domain of KITH_DOMAINS) {
    await owner.query(
      `GRANT USAGE ON DOMAIN ${KITH_SCHEMA}.${domain} TO "${appRole}"`,
    );
  }
}

export async function seedSyntheticSpace(
  owner: Pool,
  opaqueName: string,
  apiKey: string,
): Promise<{ spaceId: string; apiKeyId: string }> {
  expectText(opaqueName, 1, 128, "invalid_space_name");
  const spaceId = randomUUID();
  const apiKeyId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO kith.proof_spaces(id, opaque_name) VALUES ($1, $2)",
      [spaceId, opaqueName],
    );
    await client.query(
      "INSERT INTO kith.proof_api_keys(id, space_id, key_hash) VALUES ($1, $2, $3)",
      [apiKeyId, spaceId, keyHash(apiKey)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { spaceId, apiKeyId };
}

export async function addSyntheticApiKey(
  owner: Pool,
  spaceId: string,
  apiKey: string,
): Promise<{ apiKeyId: string }> {
  expectUuid(spaceId, "invalid_space_id");
  const apiKeyId = randomUUID();
  const result = await owner.query(
    "INSERT INTO kith.proof_api_keys(id, space_id, key_hash) SELECT $1, id, $2 FROM kith.proof_spaces WHERE id=$3 RETURNING id",
    [apiKeyId, keyHash(apiKey), spaceId],
  );
  if (result.rowCount !== 1) throw new ProofError("space_not_found");
  return { apiKeyId };
}

export async function revokeSyntheticApiKey(
  owner: Pool,
  apiKeyId: string,
): Promise<void> {
  expectUuid(apiKeyId, "invalid_api_key_id");
  const result = await owner.query(
    "UPDATE kith.proof_api_keys SET revoked_at = transaction_timestamp() WHERE id = $1 AND revoked_at IS NULL",
    [apiKeyId],
  );
  if (result.rowCount !== 1) throw new ProofError("api_key_not_current");
}

type AuthContext = { spaceId: string; apiKeyId: string };

/**
 * The worker-job leasing half of the original `PostgresProof` proof
 * surface. Its document half (stageGeneration, activateGeneration, search,
 * readCitation, forgetDocument, syntheticFinancialTotal) is retired by
 * migration 005 (P2-39d): `src/provenance` and `src/documents` now prove
 * the same staged/active/historical publication, stale-generation
 * rejection, sealed-text immutability and forget properties against the
 * real ported schema, so the synthetic demonstration of them is not kept
 * beside a real implementation of the same thing. Worker-job leasing is a
 * different domain (ingestion, P2-39e) that happens to share this class and
 * is untouched.
 */
export class PostgresProof {
  constructor(private readonly pool: Pool) {}

  private async authenticate(
    client: PoolClient,
    apiKey: string,
  ): Promise<AuthContext> {
    const result = await client.query<{ id: string; space_id: string }>(
      "SELECT id, space_id FROM kith.proof_api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
      [keyHash(apiKey)],
    );
    if (result.rowCount !== 1) throw new ProofError("unauthorized");
    return { spaceId: result.rows[0]!.space_id, apiKeyId: result.rows[0]!.id };
  }

  /**
   * One mutation, one `SERIALIZABLE` transaction, bounded retry: all of it
   * `withKithTransaction` (schema.ts), which the whole port shares.
   *
   * The credential is re-read *inside* the transaction, in the same snapshot as
   * the work, so a revocation that commits mid-request is seen by this request
   * rather than by the next one.
   */
  private async transaction<T>(
    work: (client: PoolClient, spaceId: string, apiKeyId: string) => Promise<T>,
    apiKey: string,
  ): Promise<T> {
    return withKithTransaction(this.pool, async (client) => {
      const auth = await this.authenticate(client, apiKey);
      return work(client, auth.spaceId, auth.apiKeyId);
    });
  }

  async enqueueWorkerJob(
    apiKey: string,
    input: EnqueueWorkerJobInput,
  ): Promise<EnqueueWorkerJobResult> {
    assertExactKeys(
      input,
      ["requestId", "workKind", "workKey", "inputHash", "maxAttempts"],
      "invalid_enqueue_shape",
    );
    expectUuid(input.requestId, "invalid_request_id");
    if (input.workKind !== "synthetic_document_processing")
      throw new ProofError("invalid_work_kind");
    expectText(input.workKey, 1, 128, "invalid_work_key");
    expectHash(input.inputHash, "invalid_input_hash");
    if (
      !Number.isSafeInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 5
    ) {
      throw new ProofError("invalid_max_attempts");
    }
    const requestHash = sha256(canonical(input));
    return this.transaction(async (client, spaceId, apiKeyId) => {
      const jobId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO kith.worker_jobs
          (id, space_id, enqueue_request_id, enqueue_request_hash, enqueued_by_api_key_id,
           work_kind, work_key, input_hash, state, max_attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9)
         ON CONFLICT (space_id, enqueue_request_id) DO NOTHING
         RETURNING id`,
        [
          jobId,
          spaceId,
          input.requestId,
          requestHash,
          apiKeyId,
          input.workKind,
          input.workKey,
          input.inputHash,
          input.maxAttempts,
        ],
      );
      if (inserted.rowCount === 1) return { jobId, accepted: true };
      const prior = await client.query<{
        id: string;
        enqueue_request_hash: string;
      }>(
        "SELECT id, enqueue_request_hash FROM kith.worker_jobs WHERE space_id=$1 AND enqueue_request_id=$2",
        [spaceId, input.requestId],
      );
      if (prior.rowCount !== 1)
        throw new ProofError("enqueue_conflict_unresolved");
      if (prior.rows[0]!.enqueue_request_hash !== requestHash)
        throw new ProofError("idempotency_conflict");
      return { jobId: prior.rows[0]!.id, accepted: true };
    }, apiKey);
  }

  async claimWorkerJob(
    apiKey: string,
    input: { leaseSeconds: number },
  ): Promise<WorkerLease | null> {
    assertExactKeys(input, ["leaseSeconds"], "invalid_claim_shape");
    if (
      !Number.isSafeInteger(input.leaseSeconds) ||
      input.leaseSeconds < 1 ||
      input.leaseSeconds > 300
    ) {
      throw new ProofError("invalid_lease_seconds");
    }
    return this.transaction(async (client, spaceId, apiKeyId) => {
      await client.query(
        `WITH exhausted AS (
           SELECT id FROM kith.worker_jobs
            WHERE space_id=$1 AND state='running' AND lease_expires_at <= clock_timestamp()
              AND attempt_count >= max_attempts
            ORDER BY lease_expires_at, id
            FOR UPDATE SKIP LOCKED LIMIT 25
         )
         UPDATE kith.worker_jobs j
            SET state='failed', lease_token_hash=NULL, leased_by_api_key_id=NULL,
                lease_expires_at=NULL, failure_code='attempts_exhausted', failed_at=clock_timestamp()
           FROM exhausted e WHERE j.id=e.id AND j.space_id=$1`,
        [spaceId],
      );
      const leaseToken = randomBytes(32).toString("base64url");
      const leaseTokenHash = createHash("sha256")
        .update(leaseToken, "utf8")
        .digest();
      const claimed = await client.query<
        WorkerJobRow & { lease_expires_at: Date }
      >(
        `WITH candidate AS (
           SELECT id FROM kith.worker_jobs
            WHERE space_id=$1 AND attempt_count < max_attempts
              AND ((state='queued' AND available_at <= clock_timestamp())
                OR (state='running' AND lease_expires_at <= clock_timestamp()))
            ORDER BY available_at, created_at, id
            FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE kith.worker_jobs j
            SET state='running', attempt_count=j.attempt_count+1, lease_epoch=j.lease_epoch+1,
                lease_token_hash=$2, leased_by_api_key_id=$3,
                lease_expires_at=clock_timestamp()+make_interval(secs => $4)
           FROM candidate c WHERE j.id=c.id AND j.space_id=$1
         RETURNING j.*, j.lease_expires_at`,
        [spaceId, leaseTokenHash, apiKeyId, input.leaseSeconds],
      );
      if (claimed.rowCount === 0) return null;
      const row = claimed.rows[0]!;
      return {
        ...workerJobFromRow(row),
        state: "running",
        leaseToken,
        leaseExpiresAt: row.lease_expires_at.toISOString(),
      };
    }, apiKey);
  }

  async completeWorkerJob(
    apiKey: string,
    input: {
      jobId: string;
      leaseEpoch: number;
      leaseToken: string;
      outputHash: string;
    },
  ): Promise<CompleteWorkerJobResult> {
    assertExactKeys(
      input,
      ["jobId", "leaseEpoch", "leaseToken", "outputHash"],
      "invalid_completion_shape",
    );
    expectUuid(input.jobId, "invalid_job_id");
    if (
      !Number.isSafeInteger(input.leaseEpoch) ||
      input.leaseEpoch < 1 ||
      input.leaseEpoch > 5
    )
      throw new ProofError("invalid_lease_epoch");
    if (
      typeof input.leaseToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.leaseToken)
    )
      throw new ProofError("invalid_lease_token");
    expectHash(input.outputHash, "invalid_output_hash");
    const tokenHash = createHash("sha256")
      .update(input.leaseToken, "utf8")
      .digest();
    return this.transaction(async (client, spaceId, apiKeyId) => {
      const locked = await client.query<{ state: WorkerJobState }>(
        "SELECT state FROM kith.worker_jobs WHERE id=$1 AND space_id=$2 FOR UPDATE",
        [input.jobId, spaceId],
      );
      if (locked.rowCount !== 1) throw new ProofError("lease_not_owned");
      const completed = await client.query<
        WorkerJobRow & { completed_at: Date }
      >(
        `UPDATE kith.worker_jobs
            SET state='succeeded', output_hash=$1, completed_at=clock_timestamp()
          WHERE id=$2 AND space_id=$3 AND state='running' AND lease_epoch=$4
            AND lease_token_hash=$5 AND leased_by_api_key_id=$6
            AND lease_expires_at > clock_timestamp()
          RETURNING *`,
        [
          input.outputHash,
          input.jobId,
          spaceId,
          input.leaseEpoch,
          tokenHash,
          apiKeyId,
        ],
      );
      if (completed.rowCount === 1) {
        const row = completed.rows[0]!;
        return {
          ...workerJobFromRow(row),
          state: "succeeded",
          outputHash: row.output_hash!,
          completedAt: row.completed_at!.toISOString(),
          reused: false,
        };
      }
      const replay = await client.query<WorkerJobRow & { completed_at: Date }>(
        `SELECT * FROM kith.worker_jobs
          WHERE id=$1 AND space_id=$2 AND state='succeeded' AND lease_epoch=$3
            AND lease_token_hash=$4 AND leased_by_api_key_id=$5 AND output_hash=$6`,
        [
          input.jobId,
          spaceId,
          input.leaseEpoch,
          tokenHash,
          apiKeyId,
          input.outputHash,
        ],
      );
      if (replay.rowCount !== 1) throw new ProofError("lease_not_owned");
      const row = replay.rows[0]!;
      return {
        ...workerJobFromRow(row),
        state: "succeeded",
        outputHash: row.output_hash!,
        completedAt: row.completed_at!.toISOString(),
        reused: true,
      };
    }, apiKey);
  }

  async getWorkerJob(apiKey: string, jobId: string): Promise<WorkerJob> {
    expectUuid(jobId, "invalid_job_id");
    return this.transaction(async (client, spaceId) => {
      const result = await client.query<WorkerJobRow>(
        "SELECT * FROM kith.worker_jobs WHERE id=$1 AND space_id=$2",
        [jobId, spaceId],
      );
      if (result.rowCount !== 1) throw new ProofError("job_not_found");
      return workerJobFromRow(result.rows[0]!);
    }, apiKey);
  }
}

type WorkerJobRow = QueryResultRow & {
  id: string;
  work_kind: "synthetic_document_processing";
  work_key: string;
  input_hash: string;
  state: WorkerJobState;
  attempt_count: number;
  max_attempts: number;
  lease_epoch: number;
  output_hash: string | null;
  failure_code: "attempts_exhausted" | null;
};

function workerJobFromRow(row: WorkerJobRow): WorkerJob {
  return {
    jobId: row.id,
    workKind: row.work_kind,
    workKey: row.work_key,
    inputHash: row.input_hash,
    state: row.state,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    leaseEpoch: row.lease_epoch,
    ...(row.output_hash === null ? {} : { outputHash: row.output_hash }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  };
}

export * as coverage from "./coverage/index.js";
