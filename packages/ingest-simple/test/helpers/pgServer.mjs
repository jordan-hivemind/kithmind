// A throwaway local Postgres cluster for the one integration test that needs
// a real database: `initdb` a fresh data directory under a scratch temp
// folder, start it on a random TCP port with `pg_ctl`, and stop + delete it
// in the caller's `finally`. No Docker, no fixture server: this package's
// dev machine already has `initdb`/`pg_ctl`/`postgres` (Homebrew) and
// `pgvector` installed, which the kith schema's migration 015 requires.

import { randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import pg from "pg";

const run = promisify(execFile);

function randomPort() {
  return 40000 + Math.floor(Math.random() * 20000);
}

function hasCommand(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasLocalServerBinaries = hasCommand("initdb") && hasCommand("pg_ctl");

/** node:test's `skip` option: false whenever this test can reach a real
 * Postgres -- either an already-running server via `KITH_STORE_DATABASE_URL`
 * (CI already sets this, pointed at the pgvector-enabled service the `kith`
 * schema's own suite uses) or, on a dev machine with the Postgres server
 * binaries on PATH (`initdb`/`pg_ctl`, distinct from the client-only package
 * most CI images install), a throwaway cluster this file starts and stops
 * itself. Neither available skips cleanly, the same convention
 * `packages/kith-store/test/helpers/pgDatabase.mjs` uses for a missing URL. */
export const skip =
  process.env.KITH_STORE_DATABASE_URL || hasLocalServerBinaries
    ? false
    : "set KITH_STORE_DATABASE_URL to an existing Postgres, or put initdb " +
      "and pg_ctl (the server binaries, not just the client) on PATH";

/** Starts a throwaway Postgres cluster and returns its connection string plus
 * a `stop()` that shuts it down and deletes its data directory. Callers must
 * call `stop()` in a `finally` (or `t.after`) so nothing is left running. */
export async function startPg() {
  const root = await mkdtemp(join(tmpdir(), "ingest-simple-pg-"));
  const dataDir = join(root, "data");
  await run("initdb", [
    "-D",
    dataDir,
    "-U",
    "postgres",
    "--auth=trust",
    "--no-sync",
    "-E",
    "UTF8",
  ]);
  const port = randomPort();
  const logFile = join(root, "postgres.log");
  await run("pg_ctl", [
    "-D",
    dataDir,
    "-o",
    `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`,
    "-l",
    logFile,
    "-w",
    "start",
  ]);
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  let stopped = false;
  return {
    url,
    port,
    async stop() {
      if (stopped) return;
      stopped = true;
      await run("pg_ctl", ["-D", dataDir, "-m", "fast", "stop"]).catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function onAdmin(adminUrl, work) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

/** A fresh, empty database on the server `KITH_STORE_DATABASE_URL` already
 * names, dropped by `stop()` -- the same throwaway-database-per-run shape
 * `packages/kith-store/test/helpers/pgDatabase.mjs` uses, reimplemented here
 * because that helper's cleanup is tied to a `node:test` `TestContext`
 * rather than a plain `stop()` this file's two acquisition paths can share. */
async function throwawayDatabaseOnExistingServer(adminUrl) {
  const name = `ingest_simple_test_${randomBytes(8).toString("hex")}`;
  await onAdmin(adminUrl, (admin) => admin.query(`CREATE DATABASE ${name}`));
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${name}`;
  const url = parsed.toString();
  let stopped = false;
  return {
    url,
    async stop() {
      if (stopped) return;
      stopped = true;
      await onAdmin(adminUrl, (admin) =>
        admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      ).catch(() => {});
    },
  };
}

/**
 * One throwaway Postgres this test can run against, `{url, stop()}` either
 * way: a fresh database on the server `KITH_STORE_DATABASE_URL` already
 * names when that is set (CI already points it at the pgvector-enabled
 * service the `kith` schema's own suite uses), else a whole cluster this
 * file starts and stops itself (a dev machine with `initdb`/`pg_ctl` on
 * PATH). Call `stop()` in a `finally` or `t.after` so nothing is left
 * running either way.
 */
export async function acquirePostgres() {
  const existing = process.env.KITH_STORE_DATABASE_URL;
  if (existing) return throwawayDatabaseOnExistingServer(existing);
  return startPg();
}
