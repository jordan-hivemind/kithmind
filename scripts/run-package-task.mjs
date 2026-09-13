import { spawnSync } from "node:child_process";

const [mode, ...command] = process.argv.slice(2);
const packageName = process.env.npm_package_name;

if (!packageName || !["build", "check-types", "test"].includes(mode) || command.length === 0) {
  throw new Error("run-package-task requires a package task and command");
}

function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runTurbo(task) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm executable is unavailable");
  run(process.execPath, [pnpmCli, "exec", "turbo", "run", task, `--filter=${packageName}`]);
}

// Turbo already orders dependency builds before the package task. Re-entering
// package build scripts from that task bypasses the graph and can rewrite a
// dependency's dist while another package is loading it. A direct package
// command enters the same filtered graph once, preserving standalone use.
if (!process.env.TURBO_HASH && mode !== "test") {
  runTurbo(mode);
} else {
  if (!process.env.TURBO_HASH) runTurbo("build");
  run(command[0], command.slice(1));
}
