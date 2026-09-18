import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export class PostgresParityError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresParityError";
    this.code = code;
  }
}

export function hashFileSha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let byteLength = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk) => { hash.update(chunk); byteLength += chunk.length; });
    stream.once("error", reject);
    stream.once("end", () => resolve({ sha256: hash.digest("hex"), byteLength }));
  });
}

// The textual form of `pg_export_snapshot()` (hex groups and digits joined by
// dashes). Validated before it is interpolated into SQL: nothing else may
// reach the string literal below.
export const SNAPSHOT_ID = /^[-0-9A-F]{1,64}$/i;

// Each capture query runs in its own psql session, so a parity capture only
// describes one instant of a database that is still being written to when
// every session reads the same exported snapshot. `snapshotId` is the id the
// dump's own transaction exported; without it the queries read whatever is
// committed when they run, which is all a restored (idle) database needs.
function script(sql, snapshotId) {
  if (!snapshotId) return `${sql};\n`;
  if (!SNAPSHOT_ID.test(snapshotId)) throw new PostgresParityError("snapshot_id_invalid");
  return `begin transaction isolation level repeatable read;\nset transaction snapshot '${snapshotId}';\n${sql};\ncommit;\n`;
}

function run(psqlPath, connection, sql, timeoutMs, hashOutput = false, snapshotId) {
  const input = script(sql, snapshotId);
  return new Promise((resolve, reject) => {
    // The statements arrive on stdin rather than through `-c`, because a
    // snapshot can only be imported by an explicit transaction block. `-q`
    // keeps psql's `BEGIN`/`SET`/`COMMIT` command tags out of the hashed
    // stream; query results and COPY data are unaffected.
    const child = spawn(
      psqlPath,
      [connection, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        // `to_jsonb` renders timestamptz in the session time zone and text
        // in the client encoding, so pin both: a capture must hash the same
        // on a hosted UTC server and on a laptop restore target whose
        // server default is the local zone.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          PGTZ: "UTC",
          PGCLIENTENCODING: "UTF8",
        },
      },
    );
    const output = [];
    const errors = [];
    let errorBytes = 0;
    const hash = createHash("sha256");
    let byteLength = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new PostgresParityError("command_timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (hashOutput) {
        hash.update(chunk);
        byteLength += chunk.length;
      } else {
        output.push(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes <= 262_144) errors.push(chunk);
    });
    child.once("error", () => reject(new PostgresParityError("command_failed")));
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new PostgresParityError("command_failed"));
      } else if (hashOutput) {
        resolve({ sha256: hash.digest("hex"), byteLength });
      } else {
        resolve(Buffer.concat(output).toString("utf8").trim());
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function postgresIdentity(psqlPath, connection, timeoutMs) {
  const output = await run(
    psqlPath,
    connection,
    "select json_build_object('database',current_database(),'databaseOid',(select oid::text from pg_database where datname=current_database()),'serverStartedAt',pg_postmaster_start_time()::text,'serverPort',current_setting('port'))::text",
    timeoutMs,
  );
  try {
    const parsed = JSON.parse(output);
    if (!parsed.database || !parsed.databaseOid || !parsed.serverStartedAt || !parsed.serverPort) throw new Error();
    return parsed;
  } catch {
    throw new PostgresParityError("database_identity_invalid");
  }
}

export async function capturePostgresParity(psqlPath, connection, timeoutMs, snapshotId) {
  const names = await run(
    psqlPath,
    connection,
    "select schemaname||'.'||tablename from pg_tables where schemaname in ('finance','kith') order by schemaname collate \"C\", tablename collate \"C\"",
    timeoutMs,
    false,
    snapshotId,
  );
  const tables = [];
  for (const qualified of names ? names.split("\n") : []) {
    if (!/^(finance|kith)\.[a-z_][a-z0-9_]*$/.test(qualified)) {
      throw new PostgresParityError("table_inventory_invalid");
    }
    const [schema, table] = qualified.split(".");
    const relation = `\"${schema}\".\"${table}\"`;
    const count = Number(await run(psqlPath, connection, `select count(*)::text from ${relation}`, timeoutMs, false, snapshotId));
    if (!Number.isSafeInteger(count) || count < 0) throw new PostgresParityError("row_count_invalid");
    // psql streams one canonical JSONB value per row. Hashing the stream keeps
    // memory bounded even for the largest archive table.
    const digest = await run(
      psqlPath,
      connection,
      `copy (select to_jsonb(t)::text from ${relation} t order by to_jsonb(t)::text collate \"C\") to stdout`,
      timeoutMs,
      true,
      snapshotId,
    );
    tables.push({ name: qualified, rowCount: count, sha256: digest.sha256 });
  }
  const invalidConstraints = Number(await run(
    psqlPath,
    connection,
    "select count(*)::text from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('finance','kith') and not c.convalidated",
    timeoutMs,
    false,
    snapshotId,
  ));
  if (!Number.isSafeInteger(invalidConstraints)) throw new PostgresParityError("constraint_inventory_invalid");
  return { version: 1, tables, invalidConstraints };
}

export function validatePostgresParity(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.tables) || !Number.isSafeInteger(value.invalidConstraints)) {
    throw new PostgresParityError("parity_manifest_invalid");
  }
  const names = new Set();
  for (const row of value.tables) {
    if (!row || Object.keys(row).sort().join() !== "name,rowCount,sha256" ||
      !/^(finance|kith)\.[a-z_][a-z0-9_]*$/.test(row.name) || names.has(row.name) ||
      !Number.isSafeInteger(row.rowCount) || row.rowCount < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) {
      throw new PostgresParityError("parity_manifest_invalid");
    }
    names.add(row.name);
  }
  return value;
}

export function parityEquals(left, right) {
  return JSON.stringify(validatePostgresParity(left)) === JSON.stringify(validatePostgresParity(right));
}
