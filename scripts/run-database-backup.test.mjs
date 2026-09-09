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
