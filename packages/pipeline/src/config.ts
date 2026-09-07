import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import type { PipelineConfig, RootConfig } from "./types.js";
import type { JournalBinding } from "./journalTypes.js";

const ROOT_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_CONFIG_BYTES = 64 * 1024;

function fail(message: string): never {
  throw new Error(`Invalid pipeline config: ${message}`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} must be a nonempty string`);
  return value;
}
function integer(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail(`${label} is out of range`);
  return value as number;
}

export function validateEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("endpoint must be a URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/worker"
  )
    fail("endpoint must be an exact /api/worker URL");
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    fail("endpoint must use HTTPS except explicit loopback HTTP");
  return url.toString();
}

export function parseConfig(value: unknown): PipelineConfig {
  const source = object(value, "root");
  const allowed = new Set([
    "protocolVersion",
    "endpoint",
    "spaceId",
    "sourceAccountId",
    "credentialEnv",
    "roots",
    "journalDir",
    "hostAffinity",
    "watchIntervalMs",
    "maxFiles",
    "maxDepth",
    "maxFileBytes",
  ]);
  for (const key of Object.keys(source))
    if (!allowed.has(key)) fail(`unknown field ${key}`);
  if (source.protocolVersion !== 1) fail("protocolVersion must be 1");
  const rootsValue = source.roots;
  if (
    !Array.isArray(rootsValue) ||
    rootsValue.length < 1 ||
    rootsValue.length > 16
  )
    fail("roots must contain 1 through 16 entries");
  const roots: RootConfig[] = rootsValue.map((entry, index) => {
    const root = object(entry, `roots[${index}]`);
    if (Object.keys(root).some((key) => key !== "alias" && key !== "path"))
      fail(`roots[${index}] has an unknown field`);
    const alias = string(root.alias, `roots[${index}].alias`);
    if (!ROOT_ALIAS.test(alias)) fail(`roots[${index}].alias is invalid`);
    const path = string(root.path, `roots[${index}].path`);
    if (!path.startsWith("/")) fail(`roots[${index}].path must be absolute`);
    return { alias, path: resolve(path) };
  });
  if (new Set(roots.map((root) => root.alias)).size !== roots.length)
    fail("root aliases must be unique");
  const journalValue = string(source.journalDir, "journalDir");
  if (!journalValue.startsWith("/")) fail("journalDir must be absolute");
  return {
    protocolVersion: 1,
    endpoint: validateEndpoint(string(source.endpoint, "endpoint")),
    spaceId: (() => {
      const id = string(source.spaceId, "spaceId");
      if (!ID.test(id)) fail("spaceId is invalid");
      return id;
    })(),
    sourceAccountId: (() => {
      const id = string(source.sourceAccountId, "sourceAccountId");
      if (!ID.test(id)) fail("sourceAccountId is invalid");
      return id;
    })(),
    credentialEnv: (() => {
      const name = string(source.credentialEnv, "credentialEnv");
      if (!ENV.test(name)) fail("credentialEnv is invalid");
      return name;
    })(),
    roots,
    journalDir: resolve(journalValue),
    ...(source.hostAffinity === undefined
      ? {}
      : {
          hostAffinity: (() => {
            const affinity = string(source.hostAffinity, "hostAffinity");
            if (Buffer.byteLength(affinity) > 128)
              fail("hostAffinity is too long");
            return affinity;
          })(),
        }),
    watchIntervalMs: integer(
      source.watchIntervalMs ?? 300_000,
      "watchIntervalMs",
      1_000,
      3_600_000,
    ),
    maxFiles: integer(source.maxFiles ?? 256, "maxFiles", 1, 256),
    maxDepth: integer(source.maxDepth ?? 16, "maxDepth", 1, 64),
    maxFileBytes: integer(
      source.maxFileBytes ?? 65_536,
      "maxFileBytes",
      1,
      65_536,
    ),
  };
}

export async function loadPipelineConfig(
  path: string,
): Promise<PipelineConfig> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) fail("configuration must be a regular file");
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_CONFIG_BYTES) fail("configuration is too large");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch {
      fail("configuration must be UTF-8");
    }
    try {
      return parseConfig(JSON.parse(text));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Invalid pipeline config:")
      ) {
        throw error;
      }
      fail("configuration must be JSON");
    }
  } finally {
    await handle.close();
  }
}

export function requireCredential(config: PipelineConfig): string {
  const credential = process.env[config.credentialEnv];
  if (
    !credential ||
    credential.length > 8_192 ||
    /[\x00-\x1f\x7f\s]/.test(credential)
  )
    throw new Error("Worker credential is unavailable");
  return credential;
}

export function journalBindingForConfig(
  config: PipelineConfig,
): JournalBinding {
  const configFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        endpoint: config.endpoint,
        spaceId: config.spaceId,
        sourceAccountId: config.sourceAccountId,
        roots: config.roots,
      }),
    )
    .digest("hex");
  return {
    protocolVersion: 1,
    endpoint: config.endpoint,
    spaceId: config.spaceId,
    sourceAccountId: config.sourceAccountId,
    configFingerprint,
    credentialSlot: config.credentialEnv,
  };
}
