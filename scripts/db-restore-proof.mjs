#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { capturePostgresParity, hashFileSha256, parityEquals, postgresIdentity, validatePostgresParity } from "./db-postgres-parity.mjs";

const MAX_OUTPUT = 262_144;
export class RestoreProofError extends Error {
  constructor(code) { super(code); this.name = "RestoreProofError"; this.code = code; }
}
function fail(code) { throw new RestoreProofError(code); }
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail("config_invalid");
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
  const row = exact(value, ["version", "pgRestorePath", "psqlPath", "sourceConnectionCommand", "destinationConnectionCommand", "expectedFinanceSchemaVersion", "expectedKithSchemaVersion", "timeoutMs"]);
  if (row.version !== 1 || !Number.isSafeInteger(row.expectedFinanceSchemaVersion) || !Number.isSafeInteger(row.expectedKithSchemaVersion) || row.expectedFinanceSchemaVersion < 1 || row.expectedKithSchemaVersion < 1 || !Number.isSafeInteger(row.timeoutMs) || row.timeoutMs < 1000 || row.timeoutMs > 3_600_000) fail("config_invalid");
  return { version: 1, pgRestorePath: absolute(row.pgRestorePath), psqlPath: absolute(row.psqlPath), sourceConnectionCommand: command(row.sourceConnectionCommand), destinationConnectionCommand: command(row.destinationConnectionCommand), expectedFinanceSchemaVersion: row.expectedFinanceSchemaVersion, expectedKithSchemaVersion: row.expectedKithSchemaVersion, timeoutMs: row.timeoutMs };
}
function run(path, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    const chunks = []; let bytes = 0; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new RestoreProofError("command_timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > MAX_OUTPUT) { child.kill("SIGKILL"); finish(new RestoreProofError("command_output_too_large")); } else chunks.push(chunk); });
    // Drain diagnostics so a verbose pg_restore failure cannot fill its pipe
    // and deadlock. They remain deliberately undisclosed to this JSON API.
    child.stderr.resume();
    child.once("error", () => finish(new RestoreProofError("command_failed")));
    child.once("close", (code) => code === 0 ? finish(undefined, Buffer.concat(chunks).toString("utf8")) : finish(new RestoreProofError("command_failed")));
  });
}
async function secret(spec, timeoutMs) {
  const value = (await run(spec.path, spec.args, timeoutMs)).replace(/\r?\n$/, "");
  if (!value) fail("secret_command_empty");
  return value;
}
async function scalar(config, connection, sql) {
  return (await run(config.psqlPath, [connection, "-X", "-v", "ON_ERROR_STOP=1", "-tAc", sql], config.timeoutMs)).trim();
}
async function schemaVersions(config, connection) {
  return {
    financeVersion: Number(await scalar(config, connection, "select max(version) from finance.schema_version")),
    kithVersion: Number(await scalar(config, connection, "select max(version) from kith.schema_version")),
  };
}
async function assertEmptyTarget(config, connection) {
  const count = Number(await scalar(config, connection, `
    select
      (select count(*) from pg_namespace
        where nspname not in ('pg_catalog','information_schema','public')
          and nspname !~ '^pg_toast') +
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind in ('r','p','v','m','S')
          and n.nspname not in ('pg_catalog','information_schema')
          and n.nspname !~ '^pg_toast')`));
  if (count !== 0) fail("restore_target_not_empty");
}
async function requirePostgres17(binary, timeoutMs) {
  if (!/PostgreSQL\) 17\./.test(await run(binary, ["--version"], timeoutMs))) fail("postgres_client_version_mismatch");
}
function sameDatabase(left, right) {
  return left.databaseOid === right.databaseOid && left.serverStartedAt === right.serverStartedAt && left.serverPort === right.serverPort;
}
async function readManifest(path) {
  protectedFile(path);
  let manifest;
  try { manifest = JSON.parse(await readFile(path, "utf8")); } catch { fail("manifest_invalid"); }
  const keys = ["version", "engine", "createdAt", "host", "operationId", "database", "financeSchemaVersion", "kithSchemaVersion", "gitRevision", "parity", "files"];
  if (!manifest || Object.keys(manifest).sort().join() !== keys.sort().join() ||
    manifest.version !== 1 || manifest.engine !== "postgres" ||
    typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
    typeof manifest.host !== "string" || typeof manifest.operationId !== "string" ||
    typeof manifest.database !== "string" ||
    typeof manifest.gitRevision !== "string" || !/^[a-f0-9]{40}$/.test(manifest.gitRevision) ||
    !Number.isSafeInteger(manifest.financeSchemaVersion) ||
    !Number.isSafeInteger(manifest.kithSchemaVersion) ||
    !Array.isArray(manifest.files) || manifest.files.length !== 1) fail("manifest_invalid");
  const file = manifest.files[0];
  if (!file || Object.keys(file).sort().join() !== ["name", "sha256", "byteLength"].sort().join() ||
    file.name !== "kithmind.dump" || !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !Number.isSafeInteger(file.byteLength) || file.byteLength < 1) fail("manifest_invalid");
  try { validatePostgresParity(manifest.parity); } catch { fail("manifest_invalid"); }
  return manifest;
}

export async function restorePostgresProof(config, dumpPath, manifestPath) {
  config = parseConfig(config);
  dumpPath = absolute(dumpPath); manifestPath = absolute(manifestPath);
  protectedFile(dumpPath);
  const manifest = await readManifest(manifestPath);
  const dumpDigest = await hashFileSha256(dumpPath);
  if (dumpDigest.sha256 !== manifest.files[0].sha256 ||
    dumpDigest.byteLength !== manifest.files[0].byteLength) fail("dump_manifest_mismatch");
  for (const path of [config.pgRestorePath, config.psqlPath, config.sourceConnectionCommand.path, config.destinationConnectionCommand.path]) protectedExecutable(path);
  await requirePostgres17(config.psqlPath, config.timeoutMs);
  await requirePostgres17(config.pgRestorePath, config.timeoutMs);
  const source = await secret(config.sourceConnectionCommand, config.timeoutMs);
  const destination = await secret(config.destinationConnectionCommand, config.timeoutMs);
  const [sourceIdentity, destinationIdentity] = await Promise.all([
    postgresIdentity(config.psqlPath, source, config.timeoutMs),
    postgresIdentity(config.psqlPath, destination, config.timeoutMs),
  ]);
  if (sameDatabase(sourceIdentity, destinationIdentity)) fail("restore_not_isolated");
  await assertEmptyTarget(config, destination);
  const beforeVersions = await schemaVersions(config, source);
  if (manifest.database !== sourceIdentity.database ||
    beforeVersions.financeVersion !== config.expectedFinanceSchemaVersion ||
    beforeVersions.kithVersion !== config.expectedKithSchemaVersion ||
    manifest.financeSchemaVersion !== beforeVersions.financeVersion ||
    manifest.kithSchemaVersion !== beforeVersions.kithVersion) fail("source_parity_failed");
  const sourceParity = await capturePostgresParity(config.psqlPath, source, config.timeoutMs);
  if (!parityEquals(sourceParity, manifest.parity) || sourceParity.invalidConstraints !== 0) fail("source_parity_failed");
  await run(config.pgRestorePath, ["--exit-on-error", "--no-owner", "--no-acl", "--dbname", destination, dumpPath], config.timeoutMs);
  const afterVersions = await schemaVersions(config, destination);
  const restoredParity = await capturePostgresParity(config.psqlPath, destination, config.timeoutMs);
  if (afterVersions.financeVersion !== beforeVersions.financeVersion || afterVersions.kithVersion !== beforeVersions.kithVersion || restoredParity.invalidConstraints !== 0 || !parityEquals(restoredParity, manifest.parity)) fail("restore_parity_failed");
  return { status: "passed", source: beforeVersions, restored: afterVersions, tablesVerified: restoredParity.tables.length };
}
export async function loadRestoreProofConfig(path) {
  protectedFile(path);
  let parsed; try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { fail("config_invalid"); }
  return parseConfig(parsed);
}
async function main() {
  if (process.argv.length !== 9 || process.argv[2] !== "--isolated" || process.argv[3] !== "--config" || process.argv[5] !== "--dump" || process.argv[7] !== "--manifest") fail("usage_invalid");
  const result = await restorePostgresProof(await loadRestoreProofConfig(process.argv[4]), process.argv[6], process.argv[8]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main().catch((error) => { process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "runner_failed" })}\n`); process.exitCode = 1; });
