import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export type DropboxCredentialConfig = {
  rcloneBinary: string;
  configPath: string;
  remoteName: string;
  configIdentityFingerprint: string;
};

export class DropboxVerificationError extends Error {
  constructor(message: string) {
    super(`Dropbox verification failed: ${message}`);
    this.name = "DropboxVerificationError";
  }
}

function fail(message: string): never {
  throw new DropboxVerificationError(message);
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** The token may refresh without changing this protected configuration identity. */
export function dropboxConfigIdentityFingerprint(
  configPath: string,
  remoteName: string,
): string {
  return digest(
    `dropbox-config:v1\0${JSON.stringify([configPath, remoteName, "dropbox"])}`,
  );
}

async function protectedPath(path: string, executable: boolean): Promise<void> {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /[\x00-\x20\x7f]/.test(path) ||
    path.length > 4096 ||
    (await realpath(path).catch(() => "")) !== path
  )
    fail("path is not canonical");
  const uid = process.getuid?.();
  if (uid === undefined || !constants.O_NOFOLLOW || !constants.O_NONBLOCK)
    fail("safe POSIX access unavailable");
  let parent = dirname(path);
  while (true) {
    const info = await lstat(parent);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.uid !== uid && info.uid !== 0) ||
      (info.mode & 0o022) !== 0
    )
      fail("unsafe ancestor directory");
    if (parent === dirname(parent)) break;
    parent = dirname(parent);
  }
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (executable
      ? (info.uid !== uid && info.uid !== 0) ||
        (info.mode & 0o022) !== 0 ||
        (info.mode & 0o111) === 0
      : info.uid !== uid ||
        (info.mode & 0o777) !== 0o600 ||
        info.size < 1 ||
        info.size > 65536)
  )
    fail("file is not protected");
}

async function readToken(config: DropboxCredentialConfig): Promise<string> {
  await protectedPath(config.configPath, false);
  const before = await lstat(config.configPath);
  const handle = await open(
    config.configPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer | undefined;
  try {
    const info = await handle.stat();
    if (
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.size !== before.size ||
      info.mtimeMs !== before.mtimeMs ||
      info.ctimeMs !== before.ctimeMs
    )
      fail("credential changed during access");
    bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      fail("credential changed during read");
    const lines = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, length))
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith("#") && !x.startsWith(";"));
    if (lines.shift() !== `[${config.remoteName}]`)
      fail("credential remote does not match");
    const fields = new Map<string, string>();
    for (const line of lines) {
      const match = /^(type|token)\s*=\s*(.+)$/.exec(line);
      if (!match || fields.has(match[1]!))
        fail("credential settings are not closed Dropbox settings");
      fields.set(match[1]!, match[2]!);
    }
    if (fields.size !== 2 || fields.get("type") !== "dropbox")
      fail("credential settings are not closed Dropbox settings");
    const token: unknown = JSON.parse(fields.get("token")!);
    if (!token || typeof token !== "object" || Array.isArray(token))
      fail("credential token is invalid");
    const values = token as Record<string, unknown>;
    if (
      Object.keys(values).some(
        (key) =>
          ![
            "access_token",
            "token_type",
            "refresh_token",
            "expiry",
            "expires_in",
          ].includes(key),
      ) ||
      typeof values.access_token !== "string" ||
      !/^[\x21-\x7e]{1,16384}$/.test(values.access_token) ||
      (values.token_type !== undefined &&
        values.token_type !== "bearer" &&
        values.token_type !== "Bearer")
    )
      fail("credential token is invalid");
    return values.access_token;
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

async function command(
  config: DropboxCredentialConfig,
  args: string[],
): Promise<Buffer> {
  await protectedPath(config.rcloneBinary, true);
  await readToken(config);
  return new Promise((resolveResult, reject) => {
    const child = spawn(config.rcloneBinary, args, {
      shell: false,
      detached: true,
      env: { LANG: "C", LC_ALL: "C", RCLONE_CONFIG: config.configPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: string | undefined;
    const stop = (reason: string) => {
      failure ??= reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(() => stop("command timed out"), 30_000);
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 512 * 1024) {
        bytes.fill(0);
        stop("command output exceeded limit");
      } else chunks.push(bytes);
    });
    child.stderr.on("data", (bytes: Buffer) => {
      size += bytes.length;
      bytes.fill(0);
      if (size > 512 * 1024) stop("command output exceeded limit");
    });
    child.on("error", () => {
      clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      reject(new DropboxVerificationError("command could not start"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        for (const chunk of chunks) chunk.fill(0);
        reject(new DropboxVerificationError(failure ?? "command failed"));
      } else {
        const output = Buffer.concat(chunks);
        for (const chunk of chunks) chunk.fill(0);
        resolveResult(output);
      }
    });
  });
}

export async function verifyDropboxCredentialConfig(
  config: DropboxCredentialConfig,
): Promise<void> {
  try {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.remoteName) ||
      config.configIdentityFingerprint !==
        dropboxConfigIdentityFingerprint(config.configPath, config.remoteName)
    )
      fail("configuration identity mismatch");
    const version = await command(config, ["version"]);
    try {
      if (version.toString("utf8").split("\n")[0] !== "rclone v1.74.4")
        fail("rclone version mismatch");
    } finally {
      version.fill(0);
    }
  } catch (error) {
    if (error instanceof DropboxVerificationError) throw error;
    fail("credential validation failed");
  }
}

function remotePath(path: string): void {
  if (
    !path ||
    path.length > 2048 ||
    /[:\\\x00-\x1f\x7f]/.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.trim() !== part,
      )
  )
    fail("remote path is invalid");
}

export async function verifyDropboxDirectoryBinding(
  config: DropboxCredentialConfig & {
    rootPath: string;
    expectedRootDirectoryIdHash: string;
  },
): Promise<{ rootDirectoryIdHash: string }> {
  try {
    remotePath(config.rootPath);
    if (!/^[a-f0-9]{64}$/.test(config.expectedRootDirectoryIdHash))
      fail("directory identity is invalid");
    await verifyDropboxCredentialConfig(config);
    const parts = config.rootPath.split("/");
    const leaf = parts.pop()!;
    const bytes = await command(config, [
      "lsjson",
      `${config.remoteName}:${parts.join("/")}`,
      "--dirs-only",
      "--max-depth",
      "1",
      "--no-modtime",
      "--no-mimetype",
    ]);
    try {
      const rows: unknown = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(rows) || rows.length > 128)
        fail("directory listing exceeds bound");
      for (const row of rows) {
        if (
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          Object.keys(row).sort().join(",") !==
            "ID,IsDir,ModTime,Name,Path,Size" ||
          row.Size !== -1 ||
          row.ModTime !== "" ||
          row.IsDir !== true ||
          typeof row.Name !== "string" ||
          !row.Name ||
          row.Name.length > 2048 ||
          /[\/\\\x00-\x1f\x7f]/.test(row.Name) ||
          row.Path !== row.Name ||
          typeof row.ID !== "string" ||
          !/^id:[A-Za-z0-9_-]{1,256}$/.test(row.ID)
        )
          fail("directory listing shape is invalid");
      }
      const matches = rows.filter(
        (row) =>
          row &&
          typeof row === "object" &&
          row.Name === leaf &&
          row.Path === leaf &&
          row.IsDir === true &&
          typeof row.ID === "string" &&
          /^id:[A-Za-z0-9_-]{1,256}$/.test(row.ID),
      );
      if (
        matches.length !== 1 ||
        digest(matches[0].ID) !== config.expectedRootDirectoryIdHash
      )
        fail("directory identity mismatch");
      return { rootDirectoryIdHash: config.expectedRootDirectoryIdHash };
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error instanceof DropboxVerificationError) throw error;
    fail("directory verification failed");
  }
}

/** Callers must never persist, log, or return the token supplied to this callback. */
export async function withDropboxAccessToken<T>(
  config: DropboxCredentialConfig,
  refreshPath: string,
  use: (token: string) => Promise<T>,
): Promise<T> {
  try {
    remotePath(refreshPath);
    await verifyDropboxCredentialConfig(config);
    // Stat is only an OAuth refresh operation. Its synthetic directory ID is never trusted.
    const refresh = await command(config, [
      "lsjson",
      `${config.remoteName}:${refreshPath}`,
      "--stat",
      "--no-modtime",
      "--no-mimetype",
    ]);
    refresh.fill(0);
    return await use(await readToken(config));
  } catch (error) {
    if (error instanceof DropboxVerificationError) throw error;
    fail("provider operation failed");
  }
}
