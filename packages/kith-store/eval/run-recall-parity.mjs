#!/usr/bin/env node
// P2-39g3: reruns the retrieval parity instrument against a throwaway
// PostgreSQL database. See docs/retrieval-parity-postgres.md.
//
// Keyword mode always runs. Hybrid mode also runs when a `BRAIN_EMBED_*`
// environment variable is set and a usable API key is available
// (`BRAIN_EMBED_API_KEY` or, for the default OpenAI endpoint,
// `OPENAI_API_KEY`) -- no credential is ever read from a committed file, and
// none is required for the keyword leg this script always exercises.
//
// Usage:
//   KITH_STORE_DATABASE_URL=postgres://... node packages/kith-store/eval/run-recall-parity.mjs
//   pnpm eval:recall:postgres            (same thing, from the repo root)
//
// Prints one JSON report `{ generatedAt, database, keyword, hybrid }` to
// standard output and exits nonzero if either mode reports a tenant leak or
// a historical leak (`report.passed === false` on the corresponding report;
// `hybrid` is `null` when it did not run). A recall miss alone never fails
// the exit code -- section 2.7 of the consolidation plan expects keyword
// recall to differ from Convex's prefix/typo-tolerant index, and
// `test/recallParity.test.mjs` is where that is pinned and asserted.

import { randomBytes } from "node:crypto";
import process from "node:process";

import pg from "pg";

import { applyKithSchema, newKithId } from "../dist/index.js";
import { identityCtx } from "../dist/identity/index.js";
import { seedRecallCorpus, scoreRecallCorpus } from "../dist/eval/index.js";
import {
  embeddingProfile,
  fingerprintEmbeddingConfig,
  loadEmbeddingConfig,
  requestEmbedding,
} from "../dist/embeddings/provider.js";

const url = process.env.KITH_STORE_DATABASE_URL;
if (!url) {
  process.stderr.write(
    "KITH_STORE_DATABASE_URL must point at a PostgreSQL server this script may create and drop a throwaway database on.\n",
  );
  process.exit(2);
}

function urlForDatabase(name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function onAdmin(work) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

async function sha256Utf8(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Stands up one space's active embedding index and writes a real vector for
 * every seeded thought, so the hybrid leg has something to search. Ported
 * from the shape `test/helpers/embeddingFixture.mjs` builds for tests
 * (`seedActiveEmbeddingIndex`/`seedThoughtVector`), using the configured
 * provider's real vectors in place of the fixture's synthetic one-hot ones.
 * Not exported from `src/eval/`: writing the embedding index is this
 * script's own job (see `recallParity.ts`'s module comment), not
 * `seedRecallCorpus`'s.
 */
async function seedEmbeddingIndex(client, seed, profile, fingerprint, embedQuery) {
  for (const account of seed.accounts) {
    const profileId = newKithId();
    const generationId = newKithId();
    const stateId = newKithId();
    const counts = { thought: account.thoughts.length, chunk: 0, card: 0 };
    await client.query(
      `INSERT INTO kith.embedding_profiles
         (id, created_at, fingerprint, protocol, provider_id, model, model_revision,
          dimensions, normalization, preprocessing)
       VALUES ($1, transaction_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        profileId,
        fingerprint,
        profile.protocol,
        profile.providerId,
        profile.model,
        profile.modelRevision,
        profile.dimensions,
        profile.normalization,
        profile.preprocessing,
      ],
    );
    await client.query(
      `INSERT INTO kith.embedding_generations
         (id, space_id, created_at, embedding_profile_id, fingerprint, state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'active')`,
      [generationId, account.spaceId, profileId, fingerprint],
    );
    await client.query(
      `INSERT INTO kith.space_embedding_states
         (id, space_id, created_at, eligibility_epoch, active_embedding_generation_id,
          active_fingerprint, eligible_counts, covered_counts, counter_drift, last_audit_at)
       VALUES ($1, $2, transaction_timestamp(), 1, $3, $4, $5::jsonb, $6::jsonb, false, transaction_timestamp())`,
      [stateId, account.spaceId, generationId, fingerprint, JSON.stringify(counts), JSON.stringify([{ fingerprint, counts }])],
    );

    for (const thought of account.thoughts) {
      const embedded = await embedQuery(thought.content);
      if (embedded.fingerprint !== fingerprint) {
        throw new Error(
          `Embedding provider fingerprint changed while indexing thought "${thought.key}" (expected ${fingerprint}, got ${embedded.fingerprint})`,
        );
      }
      const inputHash = await sha256Utf8(thought.content);
      const targetId = newKithId();
      await client.query(
        `INSERT INTO kith.embedding_targets
           (id, space_id, created_at, target_kind, target_id, input_hash,
            processing_generation_id, state, covered_fingerprint, updated_at)
         VALUES ($1, $2, transaction_timestamp(), 'thought', $3, $4, NULL, 'eligible', $5, transaction_timestamp())`,
        [targetId, account.spaceId, thought.id, inputHash, fingerprint],
      );
      const vectorId = newKithId();
      const literal = `[${embedded.vector.join(",")}]`;
      const searchScope = JSON.stringify(["embedding-vector-scope-v1", account.spaceId, fingerprint, generationId, "thought"]);
      const scopeV2 = JSON.stringify(["embedding-vector-scope-v2", account.spaceId, fingerprint, "thought"]);
      await client.query(
        `INSERT INTO kith.embedding_vectors
           (id, space_id, created_at, embedding_generation_id, embedding_fingerprint,
            target_kind, search_scope, thought_id, chunk_id, event_id,
            processing_generation_id, input_hash, embedding, scope_v2)
         VALUES ($1, $2, transaction_timestamp(), $3, $4, 'thought', $5, $6, NULL, NULL, NULL, $7, $8::public.vector, $9)`,
        [vectorId, account.spaceId, generationId, fingerprint, searchScope, thought.id, inputHash, literal, scopeV2],
      );
    }
  }
}

async function main() {
  const name = `kith_store_recall_parity_${randomBytes(8).toString("hex")}`;
  await onAdmin((admin) => admin.query(`CREATE DATABASE ${name}`));
  const client = new pg.Client({ connectionString: urlForDatabase(name) });
  client.on("error", () => {
    // The connection is going away with the throwaway database; a failure
    // here must not overwrite whatever this script is already reporting.
  });
  await client.connect();

  let output;
  try {
    await applyKithSchema(client);
    await client.query("SET search_path TO kith, public");
    const ctx = identityCtx(client);

    const seed = await seedRecallCorpus(ctx);
    const keyword = await scoreRecallCorpus(ctx, seed, {});

    let hybrid = null;
    const hybridRequested = Object.keys(process.env).some((key) => key.startsWith("BRAIN_EMBED_"));
    if (hybridRequested) {
      const config = loadEmbeddingConfig(process.env);
      if (!config.apiKey) {
        process.stderr.write(
          "BRAIN_EMBED_* is set but no usable API key is available (BRAIN_EMBED_API_KEY or, for the default endpoint, OPENAI_API_KEY); skipping the hybrid leg.\n",
        );
      } else {
        const profile = embeddingProfile(config);
        const fingerprint = await fingerprintEmbeddingConfig(profile);
        const embedQuery = async (text) => {
          const result = await requestEmbedding(text, config);
          return { vector: result.vector, fingerprint: result.fingerprint };
        };
        // A fresh seed for the hybrid run: reusing the keyword run's seed
        // would let a thought's `memory_status` (superseded/retracted by the
        // keyword run's own transitions) leak into what the hybrid run's
        // vectors are indexed against, which is exactly the kind of
        // cross-run interference a real deployment never has.
        const hybridSeed = await seedRecallCorpus(ctx);
        await seedEmbeddingIndex(client, hybridSeed, profile, fingerprint, embedQuery);
        hybrid = await scoreRecallCorpus(ctx, hybridSeed, { embedQuery });
      }
    }

    output = {
      generatedAt: new Date().toISOString(),
      database: name,
      keyword,
      hybrid,
    };
  } finally {
    await client.end().catch(() => {});
    await onAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  const leaked =
    output.keyword.totalTenantLeaks > 0 ||
    output.keyword.totalHistoricalLeaks > 0 ||
    (output.hybrid !== null && (output.hybrid.totalTenantLeaks > 0 || output.hybrid.totalHistoricalLeaks > 0));
  process.exitCode = leaked ? 1 : 0;
}

await main();
