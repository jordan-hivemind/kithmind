import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DatabaseBackupRunnerError,
  loadDatabaseBackupConfig,
  runDatabaseBackup,
  runWithDatabaseBackupState,
} from "./run-database-backup.mjs";

const SYSTEM_NODE = realpathSync(process.execPath);
const SHELL = realpathSync("/bin/sh");
const RUNNER = new URL("./run-database-backup.mjs", import.meta.url).pathname;
async function fixture(t, modes = ["pass", "pass"], timeoutMs = 2_000) {
  const root = await mkdtemp(join(homedir(), ".kith-db-backup-test-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  const stagingRoot = join(root, "staging");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });
  const helper = join(root, "helper.mjs");
  await writeFile(
    helper,
    `mode=$1
flag=$2
directory=$3
case "$flag" in --output-directory|--input-directory) ;; *) exit 31 ;; esac
printf '%s' "$directory" > "$directory/\${flag#--}.txt"
case "$mode" in
  fail) exit 7 ;;
  large) i=0; while [ "$i" -lt 8192 ]; do printf x; i=$((i+1)); done; while :; do :; done ;;
  hang) trap '' TERM; printf yes > "$directory/ready"; while :; do :; done ;;
  pass) printf '{"status":"passed"}\\n' ;;
  *) exit 32 ;;
esac
`,
    { mode: 0o600 },
  );
  const config = {
    version: 1,
    stateDirectory,
    stagingRoot,
    cwd: root,
    timeoutMs,
    exportCommand: { path: SHELL, args: [helper, modes[0]] },
    backupCommand: { path: SHELL, args: [helper, modes[1]] },
  };
  const configPath = join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return { root, stateDirectory, stagingRoot, configPath, config };
}
const status = async (f) =>
  JSON.parse(
    await readFile(
      join(f.stateDirectory, "database-backup-status.json"),
      "utf8",
    ),
  );
const dirs = async (f) => readdir(f.stagingRoot);

test("one fresh exact staging path passes from export to backup", async (t) => {
  const f = await fixture(t);
  const result = await runDatabaseBackup(
    await loadDatabaseBackupConfig(f.configPath),
  );
  const names = await dirs(f);
  assert.equal(names.length, 1);
  const directory = join(f.stagingRoot, names[0]);
  assert.equal(
    await readFile(join(directory, "output-directory.txt"), "utf8"),
    directory,
  );
  assert.equal(
    await readFile(join(directory, "input-directory.txt"), "utf8"),
    directory,
  );
  assert.deepEqual(await status(f), {
    version: 1,
    state: "succeeded",
    stage: "complete",
    runId: result.runId,
    startedAt: result.startedAt,
    updatedAt: result.finishedAt,
    lastSuccessAt: result.finishedAt,
    // This convex-engine path never runs a restore proof or retention; the
    // postgres engine's own runWithDatabaseBackupState suite below covers
    // proof cadence and retention tracking.
    lastProofAt: null,
    nextProofDueAt: null,
    retention: null,
  });
});
test("export failure stops backup and preserves staging", async (t) => {
  const f = await fixture(t, ["fail", "pass"]);
  await assert.rejects(
    runDatabaseBackup(await loadDatabaseBackupConfig(f.configPath)),
    (e) => e.code === "command_failed",
  );
  const [name] = await dirs(f);
  assert.equal((await status(f)).stage, "export");
  await assert.rejects(
    readFile(join(f.stagingRoot, name, "input-directory.txt")),
    { code: "ENOENT" },
  );
});
test("backup failure preserves prior success and both attempts", async (t) => {
  const f = await fixture(t);
  const config = await loadDatabaseBackupConfig(f.configPath);
  const first = await runDatabaseBackup(config);
  config.backupCommand.args[1] = "fail";
  await assert.rejects(runDatabaseBackup(config));
  const failed = await status(f);
  assert.equal(failed.stage, "backup");
  assert.equal(failed.lastSuccessAt, first.finishedAt);
  assert.equal((await dirs(f)).length, 2);
});
test("existing lock refuses overlap or orphan cleanup", async (t) => {
  const f = await fixture(t);
  const lock = join(f.stateDirectory, "database-backup.lock");
  const bytes = Buffer.from("orphan\n");
  await writeFile(lock, bytes, { mode: 0o600, flag: "wx" });
  await assert.rejects(
    runDatabaseBackup(await loadDatabaseBackupConfig(f.configPath)),
    (e) => e.code === "backup_already_running_or_recovery_required",
  );
  assert.deepEqual(await readFile(lock), bytes);
  assert.deepEqual(await dirs(f), []);
});
test("an invalid prior status is preserved and leaves the durable lock for review", async (t) => {
  const f = await fixture(t);
  const statusPath = join(f.stateDirectory, "database-backup-status.json");
  const invalid = Buffer.from('{"corrupt":true}\n');
  await writeFile(statusPath, invalid, { mode: 0o600, flag: "wx" });
  await assert.rejects(
    runDatabaseBackup(await loadDatabaseBackupConfig(f.configPath)),
  );
  assert.deepEqual(await readFile(statusPath), invalid);
  assert.equal(
    (await readFile(join(f.stateDirectory, "database-backup.lock"))).length > 0,
    true,
  );
  assert.deepEqual(await dirs(f), []);
});
test("timeout kills a process group whose child ignores SIGTERM", async (t) => {
  const f = await fixture(t, ["hang", "pass"], 150);
  await assert.rejects(
    runDatabaseBackup(await loadDatabaseBackupConfig(f.configPath)),
    (e) => e.code === "command_timeout",
  );
  assert.equal((await status(f)).failureCode, "command_timeout");
});
test("spawn errors and output overflow are bounded generic failures", async (t) => {
  const f = await fixture(t);
  const bad = join(f.root, "bad");
  await writeFile(bad, "#!/missing/interpreter\n", { mode: 0o700 });
  const config = await loadDatabaseBackupConfig(f.configPath);
  config.exportCommand = { path: bad, args: [] };
  await assert.rejects(
    runDatabaseBackup(config),
    (e) => e.code === "command_spawn_failed",
  );
  const g = await fixture(t, ["large", "pass"]);
  await assert.rejects(
    runDatabaseBackup(await loadDatabaseBackupConfig(g.configPath)),
    (e) => e.code === "command_output_too_large",
  );
});
test("config requires exact fields, 0600 mode, and canonical bound paths", async (t) => {
  const f = await fixture(t);
  await chmod(f.configPath, 0o644);
  await assert.rejects(loadDatabaseBackupConfig(f.configPath));
  await chmod(f.configPath, 0o600);
  await writeFile(f.configPath, JSON.stringify({ ...f.config, extra: true }));
  await assert.rejects(loadDatabaseBackupConfig(f.configPath));
  await writeFile(f.configPath, JSON.stringify(f.config));
  await assert.rejects(loadDatabaseBackupConfig(`${f.root}/./config.json`));
});
// BAK-1 second review, row 2: the deployed status file (`git show
// origin/main:scripts/run-database-backup.mjs`) has this shape -- no
// lastProofAt, nextProofDueAt, or retention keys at all. parseStatus's exact
// key check used to require all three, so the first run after this deploy
// threw status_invalid out of priorStatus, before runningRecorded was ever
// set, which left the durable lock behind and failed every later run with
// backup_already_running_or_recovery_required.
test("a legacy-shaped status file with no lastProofAt/nextProofDueAt/retention is accepted, a full run completes, and no lock is leaked", async (t) => {
  const f = await fixture(t);
  const statusPath = join(f.stateDirectory, "database-backup-status.json");
  const legacy = {
    version: 1,
    state: "succeeded",
    stage: "complete",
    runId: "legacy-run",
    startedAt: 1_000,
    updatedAt: 2_000,
    lastSuccessAt: 2_000,
  };
  await writeFile(statusPath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const result = await runDatabaseBackup(
    await loadDatabaseBackupConfig(f.configPath),
  );
  assert.equal(result.status, "passed");
  const journal = await status(f);
  assert.equal(journal.state, "succeeded");
  assert.equal(journal.lastSuccessAt, result.finishedAt);
  assert.equal(journal.lastProofAt, null);
  assert.equal(journal.nextProofDueAt, null);
  assert.equal(journal.retention, null);
  await assert.rejects(
    readFile(join(f.stateDirectory, "database-backup.lock")),
    { code: "ENOENT" },
  );
});

// P2-39k follow-up (BAK-1): runWithDatabaseBackupState is the postgres
// engine's own shared lock and journal (db-backup-postgres.mjs has no lock
// logic of its own). These exercise the restore-proof cadence bookkeeping it
// now carries, independent of any real pg_dump/restic/age process.
test("runWithDatabaseBackupState hands the operation a null priorProof on the first run and persists what recordProof reports", async (t) => {
  const f = await fixture(t);
  const config = await loadDatabaseBackupConfig(f.configPath);
  const seen = [];
  const result = await runWithDatabaseBackupState(config, async ({ priorProof, recordProof }) => {
    seen.push(priorProof);
    recordProof({ lastProofAt: 555, nextProofDueAt: 999 });
    return { ok: true };
  });
  assert.deepEqual(seen, [{ lastProofAt: null, nextProofDueAt: null }]);
  const journal = await status(f);
  assert.equal(journal.state, "succeeded");
  assert.equal(journal.lastProofAt, 555);
  assert.equal(journal.nextProofDueAt, 999);
  assert.equal(result.ok, true);
});

test("runWithDatabaseBackupState carries the prior proof forward when the operation never calls recordProof", async (t) => {
  const f = await fixture(t);
  const config = await loadDatabaseBackupConfig(f.configPath);
  await runWithDatabaseBackupState(config, async ({ recordProof }) => {
    recordProof({ lastProofAt: 111, nextProofDueAt: 222 });
    return { ok: true };
  });
  const seen = [];
  await runWithDatabaseBackupState(config, async ({ priorProof }) => {
    seen.push(priorProof);
    return { ok: true };
  });
  assert.deepEqual(seen, [{ lastProofAt: 111, nextProofDueAt: 222 }]);
  const journal = await status(f);
  // Unchanged: a run that did not attempt a proof must not erase the last one.
  assert.equal(journal.lastProofAt, 111);
  assert.equal(journal.nextProofDueAt, 222);
});

test("runWithDatabaseBackupState preserves the prior proof across a failed run, like lastSuccessAt", async (t) => {
  const f = await fixture(t);
  const config = await loadDatabaseBackupConfig(f.configPath);
  await runWithDatabaseBackupState(config, async ({ recordProof }) => {
    recordProof({ lastProofAt: 111, nextProofDueAt: 222 });
    return { ok: true };
  });
  await assert.rejects(
    runWithDatabaseBackupState(config, async () => {
      throw Object.assign(new Error("boom"), { code: "operation_failed" });
    }),
  );
  const journal = await status(f);
  assert.equal(journal.state, "failed");
  assert.equal(journal.lastProofAt, 111);
  assert.equal(journal.nextProofDueAt, 222);
});

// BAK-1 review row 2: the retention outcome (ok/failed/skipped) is its own
// field in the status journal, carried forward across a run that never
// reaches it, exactly like lastProofAt above.
test("runWithDatabaseBackupState defaults retention to null and persists what recordRetention reports", async (t) => {
  const f = await fixture(t);
  const config = await loadDatabaseBackupConfig(f.configPath);
  const seen = [];
  await runWithDatabaseBackupState(config, async ({ priorProof, recordRetention }) => {
    seen.push(priorProof);
    recordRetention({ state: "ok", code: null, at: 777, removed: 3, kept: 12 });
    return { ok: true };
  });
  const journal = await status(f);
  assert.deepEqual(journal.retention, { state: "ok", code: null, at: 777, removed: 3, kept: 12 });
});

test("runWithDatabaseBackupState carries the prior retention outcome forward when the operation never calls recordRetention", async (t) => {
  const f = await fixture(t);
  const config = await loadDatabaseBackupConfig(f.configPath);
  await runWithDatabaseBackupState(config, async ({ recordRetention }) => {
    recordRetention({ state: "failed", code: "command_failed", at: 100, removed: null, kept: null });
    return { ok: true };
  });
  await runWithDatabaseBackupState(config, async () => ({ ok: true }));
  const journal = await status(f);
  // Unchanged: a run that did not attempt retention must not erase the last
  // known outcome.
  assert.deepEqual(journal.retention, { state: "failed", code: "command_failed", at: 100, removed: null, kept: null });
});

test("runWithDatabaseBackupState records a skipped retention outcome and preserves it across a later run that also calls recordRetention", async (t) => {
  const f = await fixture(t);
  const config = await loadDatabaseBackupConfig(f.configPath);
  await runWithDatabaseBackupState(config, async ({ recordRetention }) => {
    recordRetention({ state: "skipped", code: null, at: 55, removed: null, kept: null });
    return { ok: true };
  });
  let journal = await status(f);
  assert.deepEqual(journal.retention, { state: "skipped", code: null, at: 55, removed: null, kept: null });
  await assert.rejects(
    runWithDatabaseBackupState(config, async ({ recordRetention }) => {
      recordRetention({ state: "skipped", code: null, at: 66, removed: null, kept: null });
      throw Object.assign(new Error("boom"), { code: "operation_failed" });
    }),
  );
  journal = await status(f);
  assert.equal(journal.state, "failed");
  assert.deepEqual(journal.retention, { state: "skipped", code: null, at: 66, removed: null, kept: null });
});

// BAK-1 second review, "also worth doing": a run that fails WITHOUT ever
// calling recordRetention (a failure before the retention step -- unlike the
// test above, which fails after explicitly recording "skipped") must not
// leave a prior run's retention outcome looking like it applies to this
// failed run. `lastSuccessAt`/`lastProofAt` do carry forward on a failure;
// retention deliberately does not, because "ok" on a failed run's own record
// reads as though retention ran fine this time, when it never ran at all.
test("runWithDatabaseBackupState does not carry a prior 'ok' retention outcome forward onto a run that fails before ever calling recordRetention", async (t) => {
  const f = await fixture(t);
  const config = await loadDatabaseBackupConfig(f.configPath);
  await runWithDatabaseBackupState(config, async ({ recordRetention }) => {
    recordRetention({ state: "ok", code: null, at: 1, removed: 2, kept: 3 });
    return { ok: true };
  });
  const before = await status(f);
  assert.equal(before.retention.state, "ok");
  await assert.rejects(
    runWithDatabaseBackupState(config, async () => {
      // Fails before ever reaching setStage/recordRetention for this run.
      throw Object.assign(new Error("boom"), { code: "operation_failed" });
    }),
  );
  const after = await status(f);
  assert.equal(after.state, "failed");
  assert.equal(after.retention.state, "skipped");
  assert.equal(after.retention.code, null);
  assert.equal(after.retention.removed, null);
  assert.equal(after.retention.kept, null);
});

test("CLI stdout is a closed safe result without private paths", async (t) => {
  const f = await fixture(t);
  const output = await new Promise((ok, no) =>
    execFile(
      SYSTEM_NODE,
      [RUNNER, "--config", f.configPath],
      { encoding: "utf8" },
      (error, stdout) => (error ? no(error) : ok(stdout)),
    ),
  );
  const value = JSON.parse(output);
  assert.deepEqual(Object.keys(value).sort(), ["runId", "status"]);
  assert.equal(value.status, "passed");
  assert.equal(output.includes(f.root), false);
});
