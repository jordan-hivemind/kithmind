import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import pg from "pg";

const execFileAsync = promisify(execFile);

/**
 * Finds a throwaway Postgres 17 to load into, in the order the tracker row
 * asks for: the CI `postgres-proof` job's own Docker-managed cluster first,
 * then a local throwaway database if one is reachable, otherwise skip with a
 * clear message rather than fail (P2-39b's instructions: "use a local
 * throwaway if available and say so otherwise").
 *
 * Returns `null` when nothing is available.
 */
export async function resolveTestDatabase() {
  const fromEnv = process.env.KITH_MIGRATE_TEST_DATABASE_URL;
  if (fromEnv) {
    return { connectionString: fromEnv, cleanup: async () => {} };
  }

  const docker = await tryDocker();
  if (docker) return docker;

  return tryLocalPostgres();
}

async function tryDocker() {
  try {
    // A fast, bounded preflight: `docker run` against a daemon that isn't
    // there can hang far longer than this file's own timeouts expect, so
    // check the daemon itself first rather than let the full flow stall.
    await execFileAsync("docker", ["info"], { timeout: 3_000 });
  } catch {
    return null;
  }
  let dockerPostgres;
  try {
    dockerPostgres = await import(
      "../../postgres-proof/integration/docker-postgres.mjs"
    );
  } catch {
    return null;
  }
  try {
    const cluster = await dockerPostgres.startPostgresCluster("kith-migrate");
    const admin = `postgres://${cluster.config.user}:${cluster.config.password}@${cluster.config.host}:${cluster.config.port}/${cluster.config.database}`;
    const dbName = `kith_migrate_${randomUUID().replaceAll("-", "")}`;
    await withPool(admin, (client) => client.query(`CREATE DATABASE ${dbName}`));
    const connectionString = `postgres://${cluster.config.user}:${cluster.config.password}@${cluster.config.host}:${cluster.config.port}/${dbName}`;
    return {
      connectionString,
      cleanup: async () => {
        await dockerPostgres.stopPostgresCluster(cluster);
      },
    };
  } catch (error) {
    console.error(`kith-migrate: docker throwaway Postgres unavailable (${error.message}), trying local`);
    return null;
  }
}

const LOCAL_CANDIDATES = [
  { host: "127.0.0.1", port: 5433 }, // Homebrew postgresql@17 default on this host
  { host: "127.0.0.1", port: 5432 },
];

async function tryLocalPostgres() {
  const user = process.env.USER ?? process.env.LOGNAME ?? "postgres";
  for (const candidate of LOCAL_CANDIDATES) {
    const adminUrl = `postgres://${user}@${candidate.host}:${candidate.port}/postgres`;
    const dbName = `kith_migrate_proof_${randomUUID().replaceAll("-", "")}`;
    try {
      await withPool(adminUrl, (client) =>
        client.query(`SELECT version()`),
      );
    } catch {
      continue;
    }
    await withPool(adminUrl, (client) => client.query(`CREATE DATABASE ${dbName}`));
    const connectionString = `postgres://${user}@${candidate.host}:${candidate.port}/${dbName}`;
    console.error(
      `kith-migrate: using local throwaway Postgres at ${candidate.host}:${candidate.port} (${dbName})`,
    );
    return {
      connectionString,
      cleanup: async () => {
        await withPool(adminUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${dbName}`));
      },
    };
  }
  console.error(
    "kith-migrate: no Docker and no local throwaway Postgres found; skipping the load/parity integration test",
  );
  return null;
}

async function withPool(connectionString, run) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      return await run(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
