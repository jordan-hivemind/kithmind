import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IMAGE =
  "postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";
const OWNER_LABEL = "com.kithmind.postgres-proof";

async function runDocker(args, options = {}) {
  try {
    return await execFileAsync("docker", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      ...options,
    });
  } catch (error) {
    throw new Error(`docker_command_failed:${args[0]}`, { cause: error });
  }
}

let imageReady;
async function ensureImage() {
  imageReady ??= (async () => {
    try {
      await runDocker(["image", "inspect", IMAGE]);
    } catch {
      await runDocker(["pull", IMAGE], {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    }
  })();
  return imageReady;
}

async function waitReady(name) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await runDocker([
        "exec",
        name,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("postgres_container_not_ready", { cause: lastError });
}

export async function startPostgresCluster(label) {
  if (!/^[a-z0-9-]{1,32}$/.test(label))
    throw new Error("invalid_cluster_label");
  await ensureImage();
  const suffix = randomUUID().replaceAll("-", "");
  const name = `kith-pg-proof-${process.pid}-${suffix}`;
  const password = randomBytes(32).toString("base64url");
  await runDocker([
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--label",
    `${OWNER_LABEL}=${suffix}`,
    "--mount",
    "type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=536870912",
    "--memory",
    "768m",
    "--cpus",
    "2",
    "--pids-limit",
    "256",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--publish",
    "127.0.0.1::5432",
    IMAGE,
  ]);
  try {
    await waitReady(name);
    const { stdout } = await runDocker(["port", name, "5432/tcp"]);
    const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout);
    if (!match) throw new Error("unexpected_docker_port_binding");
    return {
      name,
      ownerToken: suffix,
      config: {
        host: "127.0.0.1",
        port: Number(match[1]),
        database: "postgres",
        user: "postgres",
        password,
        max: 4,
      },
    };
  } catch (error) {
    await stopPostgresCluster({ name, ownerToken: suffix }).catch(() => {});
    throw error;
  }
}

export async function stopPostgresCluster(cluster) {
  const { stdout } = await runDocker([
    "inspect",
    "--format",
    `{{ index .Config.Labels "${OWNER_LABEL}" }}`,
    cluster.name,
  ]);
  if (stdout.trim() !== cluster.ownerToken)
    throw new Error("refusing_to_stop_unowned_container");
  await runDocker(["stop", "--time", "10", cluster.name]);
}

export async function dockerDump(cluster) {
  return runBinary("docker", [
    "exec",
    cluster.name,
    "pg_dump",
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--username=postgres",
    "postgres",
  ]);
}

export async function dockerRestore(cluster, dump) {
  await runDocker([
    "exec",
    cluster.name,
    "createdb",
    "--username=postgres",
    "restored",
  ]);
  await runBinary(
    "docker",
    [
      "exec",
      "--interactive",
      cluster.name,
      "pg_restore",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "--username=postgres",
      "--dbname=restored",
    ],
    dump,
  );
  return { ...cluster.config, database: "restored" };
}

function runBinary(command, args, stdin) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 16 * 1024 * 1024) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0 && outputBytes <= 16 * 1024 * 1024)
        resolve(Buffer.concat(stdout));
      else
        reject(
          new Error(
            `${command}_binary_failed:${code}:${outputBytes > 16 * 1024 * 1024 ? "output_too_large" : Buffer.concat(stderr).toString("utf8").slice(0, 500)}`,
          ),
        );
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
