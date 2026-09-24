// A throwaway local Postgres server this test suite starts and stops itself
// (`initdb` + `pg_ctl` from PATH), rather than requiring a pre-provisioned
// one. Skips cleanly when neither binary is on PATH -- the caller checks
// `localPostgresAvailable()` before registering its test.
//
// `max_locks_per_transaction` is raised: applying the whole `kith` schema
// (53 migrations, one transaction) needs more than the default 64 against a
// freshly initialized cluster's default `shared_buffers`.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function localPostgresAvailable() {
  try {
    await execFileAsync("initdb", ["--version"]);
    await execFileAsync("pg_ctl", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function startLocalPostgres() {
  const dataDir = await mkdtemp(join(tmpdir(), "epic-feed-pg-"));
  // A Unix socket path has a ~103-byte limit; a scratchpad-rooted temp dir
  // can exceed that, so the socket lives in a short `/tmp` directory instead
  // of `dataDir` itself.
  const socketDir = await mkdtemp("/tmp/epic-feed-pg-sock-");
  const port = 40000 + Math.floor(Math.random() * 10000);
  await execFileAsync("initdb", [
    "-D",
    dataDir,
    "-U",
    "postgres",
    "-A",
    "trust",
    "--no-sync",
  ]);
  await execFileAsync("pg_ctl", [
    "-D",
    dataDir,
    "-l",
    join(dataDir, "log.txt"),
    "-o",
    `-p ${port} -k ${socketDir} -c timezone=UTC -c max_locks_per_transaction=512 -c shared_buffers=256MB`,
    "-w",
    "start",
  ]);
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  let stopped = false;
  return {
    url,
    async stop() {
      if (stopped) return;
      stopped = true;
      await execFileAsync("pg_ctl", ["-D", dataDir, "-m", "fast", "stop"]).catch(() => {});
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      await rm(socketDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
