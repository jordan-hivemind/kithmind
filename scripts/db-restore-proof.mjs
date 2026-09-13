#!/usr/bin/env node
// Isolated restore proof for the postgres dated-backup engine.  The dump is
// deliberately supplied as a protected plaintext staging file after the
// independent backup verifier has decrypted it; this command never receives
// an age identity or a restic credential.
import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";

const MAX_OUTPUT = 262_144;

export class RestoreProofError extends Error {
  constructor(code) {
    super(code);
    this.name = "RestoreProofError";
    this.code = code;
  }
}
function fail(code) { throw new RestoreProofError(code); }
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("config_invalid");
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail("config_invalid");
  return value;
}
function absolute(value) {
  if (typeof value !== "string" || !value.startsWith("/")) fail("config_invalid");
  return value;
}
function protectedExecutable(path) {
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022)) fail("file_not_protected");
}
function protectedFile(path) {
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail("file_not_protected");
}
function command(value) {
  const row = exact(value, ["path", "args"]);
  if (!Array.isArray(row.args) || row.args.length > 16 || row.args.some((arg) => typeof arg !== "string" || arg.length > 256)) fail("config_invalid");
  return { path: absolute(row.path), args: row.args };
}
function parseConfig(value) {
  const row = exact(value, ["version", "dumpPath", "pgRestorePath", "psqlPath", "sourceConnectionCommand", "destinationConnectionCommand", "expectedFinanceSchemaVersion", "expectedKithSchemaVersion", "timeoutMs"]);
  if (row.version !== 1 || !Number.isSafeInteger(row.expectedFinanceSchemaVersion) || !Number.isSafeInteger(row.expectedKithSchemaVersion) || row.expectedFinanceSchemaVersion < 1 || row.expectedKithSchemaVersion < 1 || !Number.isSafeInteger(row.timeoutMs) || row.timeoutMs < 1000 || row.timeoutMs > 3_600_000) fail("config_invalid");
  return { version: 1, dumpPath: absolute(row.dumpPath), pgRestorePath: absolute(row.pgRestorePath), psqlPath: absolute(row.psqlPath), sourceConnectionCommand: command(row.sourceConnectionCommand), destinationConnectionCommand: command(row.destinationConnectionCommand), expectedFinanceSchemaVersion: row.expectedFinanceSchemaVersion, expectedKithSchemaVersion: row.expectedKithSchemaVersion, timeoutMs: row.timeoutMs };
}
function run(path, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new RestoreProofError("command_timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > MAX_OUTPUT) { child.kill("SIGKILL"); reject(new RestoreProofError("command_output_too_large")); } else chunks.push(chunk); });
    child.once("error", () => reject(new RestoreProofError("command_failed")));
    child.once("close", (code) => { clearTimeout(timer); if (code !== 0) reject(new RestoreProofError("command_failed")); else resolve(Buffer.concat(chunks).toString("utf8")); });
  });
}
async function secret(spec, timeoutMs) {
  const value = (await run(spec.path, spec.args, timeoutMs)).replace(/\r?\n$/, "");
  if (!value) fail("secret_command_empty");
  return value;
}
const SNAPSHOT_SQL = "SELECT table_schema || '.' || table_name || ':' || n_live_tup::bigint FROM pg_stat_user_tables WHERE table_schema IN ('finance', 'kith') ORDER BY table_schema, table_name";
async function snapshot(config, connection) {
  const output = await run(config.psqlPath, [connection, "-v", "ON_ERROR_STOP=1", "-tAc", SNAPSHOT_SQL], config.timeoutMs);
  const finance = await run(config.psqlPath, [connection, "-v", "ON_ERROR_STOP=1", "-tAc", "select max(version) from finance.schema_version"], config.timeoutMs);
  const kith = await run(config.psqlPath, [connection, "-v", "ON_ERROR_STOP=1", "-tAc", "select max(version) from kith.schema_version"], config.timeoutMs);
  return { tables: output.trim().split("\n").filter(Boolean), financeVersion: Number(finance.trim()), kithVersion: Number(kith.trim()) };
}
export async function restorePostgresProof(config) {
  config = parseConfig(config);
  protectedFile(config.dumpPath); protectedExecutable(config.pgRestorePath); protectedExecutable(config.psqlPath); protectedExecutable(config.sourceConnectionCommand.path); protectedExecutable(config.destinationConnectionCommand.path);
  const source = await secret(config.sourceConnectionCommand, config.timeoutMs);
  const destination = await secret(config.destinationConnectionCommand, config.timeoutMs);
  if (source === destination) fail("restore_not_isolated");
  const before = await snapshot(config, source);
  if (before.financeVersion !== config.expectedFinanceSchemaVersion || before.kithVersion !== config.expectedKithSchemaVersion) fail("source_parity_failed");
  await run(config.pgRestorePath, ["--no-owner", "--no-acl", "--dbname", destination, config.dumpPath], config.timeoutMs);
  const after = await snapshot(config, destination);
  if (after.financeVersion !== before.financeVersion || after.kithVersion !== before.kithVersion || JSON.stringify(after.tables) !== JSON.stringify(before.tables)) fail("restore_parity_failed");
  return { status: "passed", source: before, restored: after };
}
export async function loadRestoreProofConfig(path) {
  protectedFile(path);
  let parsed; try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { fail("config_invalid"); }
  return parseConfig(parsed);
}
async function main() {
  if (process.argv.length !== 5 || process.argv[2] !== "--isolated" || process.argv[3] !== "--config") fail("usage_invalid");
  const result = await restorePostgresProof(await loadRestoreProofConfig(process.argv[4]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) main().catch((error) => { process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "runner_failed" })}\n`); process.exitCode = 1; });
