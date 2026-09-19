/**
 * P2-104d: synthetic `age` / `restic` / `rclone` stand-ins for the real
 * archiveCommands.ts lane.
 *
 * Everything here is generated in a temp directory. No real account, key,
 * token, recipient, repository or path appears in this file, and nothing
 * needs a real age, restic or rclone installed.
 *
 * Directory layout (a caller validating with parseConfig must keep these
 * apart, and must keep its own captureDirectory / parserOutputRoot /
 * spoolDirectory / journal directory / scanned roots outside all of them):
 *
 *   <base>/tools/       age, restic, rclone, password-command, rclone.conf
 *                       Executables and the rclone config must live OUTSIDE
 *                       every writable root (config.ts:696-724), so `tools`
 *                       is a sibling of the archive directories, never a
 *                       child of one.
 *   <base>/primary/     primary archive directory (age only)
 *   <base>/backup/      independent-backup archive directory (age + restic)
 *   <base>/repository/  the fake Dropbox remote the fake restic writes into
 */

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hex = (value) => createHash("sha256").update(value).digest("hex");

/** The fake Dropbox folder id `rclone lsjson` reports for the repository root. */
const DIRECTORY_ID = "id:synthetic-processing-folder";
const REMOTE_NAME = "kithmind_dropbox";
const ROOT_PATH = "Kith Mind Backups/Processing";

/** PQ_RECIPIENT is /^age1pq1[023456789acdefghjklmnpqrstuvwxyz]{40,4090}$/. */
const PRIMARY_RECIPIENT = `age1pq1${"q".repeat(60)}`;
const BACKUP_RECIPIENT = `age1pq1${"r".repeat(60)}`;

/** `cat config` must keep returning this, or requireResticRepository fails. */
const REPOSITORY_ID = hex("synthetic-restic-repository");

async function program(path, source) {
  await writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

/**
 * Pinned versions are exact: age must print AGE_VERSION ("v1.3.2"), restic
 * must match /^restic 0\.19\.1 compiled with go[0-9.]+ on [a-z0-9_/-]+$/, and
 * rclone's first line must be "rclone v1.74.4".
 */
const AGE_SOURCE = `
if (process.argv[2] === "--version") {
  process.stdout.write("v1.3.2\\n");
  process.exit(0);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(Buffer.concat([Buffer.from("AGE"), ...chunks]));
`;

/**
 * One object per snapshot, each with its own 64-hex id, so a run that
 * archives dozens of objects stays addressable. Snapshot ids are derived
 * from (objectName, host, tag): the caller must use a distinct operationId
 * per object, because `snapshots --host H --tag T` returning two rows is an
 * ambiguity failure in parseResticSnapshots, exactly as with real restic.
 */
const resticSource = (repository) => `
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repository = ${JSON.stringify(repository)};
const args = process.argv.slice(2);
if (args[0] === "version") {
  process.stdout.write("restic 0.19.1 compiled with go1.25.1 on darwin/arm64\\n");
  process.exit(0);
}
const objects = join(repository, "objects");
const rows = join(repository, "snapshots.jsonl");
const readRows = () => (existsSync(rows) ? readFileSync(rows, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const command = args.find((value) => ["backup", "dump", "snapshots"].includes(value));

if (args.includes("cat") && args.includes("config")) {
  process.stdout.write(JSON.stringify({ version: 2, id: ${JSON.stringify(REPOSITORY_ID)} }));
  process.exit(0);
}
if (command === "backup") {
  const objectName = args.at(-1);
  const host = args[args.indexOf("--host") + 1];
  const tag = args[args.indexOf("--tag") + 1];
  const id = createHash("sha256").update([objectName, host, tag].join("\\u0000")).digest("hex");
  const bytes = readFileSync(join(process.cwd(), objectName));
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  copyFileSync(join(process.cwd(), objectName), join(objects, id));
  chmodSync(join(objects, id), 0o600);
  appendFileSync(rows, JSON.stringify({ id, hostname: host, tags: [tag], paths: [join(repository, "kithmind", objectName)] }) + "\\n", { mode: 0o600 });
  // parseResticSummary demands exactly one summary line, last, with
  // total_files_processed === 1 and total_bytes_processed === the ciphertext.
  process.stdout.write(JSON.stringify({ message_type: "status", percent_done: 1 }) + "\\n");
  process.stdout.write(JSON.stringify({ message_type: "summary", total_files_processed: 1, total_bytes_processed: bytes.length, snapshot_id: id }) + "\\n");
  process.exit(0);
}
if (command === "dump") {
  process.stdout.write(readFileSync(join(objects, args[args.indexOf("dump") + 1])));
  process.exit(0);
}
if (command === "snapshots") {
  let matches = readRows();
  const host = args.indexOf("--host");
  const tag = args.indexOf("--tag");
  if (host >= 0) matches = matches.filter((row) => row.hostname === args[host + 1]);
  if (tag >= 0) matches = matches.filter((row) => row.tags.includes(args[tag + 1]));
  process.stdout.write(JSON.stringify(matches));
  process.exit(0);
}
process.exit(2);
`;

const RCLONE_SOURCE = `
if (process.argv[2] === "version") {
  process.stdout.write("rclone v1.74.4\\n");
  process.exit(0);
}
if (process.argv[2] === "lsjson") {
  process.stdout.write(JSON.stringify([{ Path: "Processing", Name: "Processing", Size: -1, ModTime: "", IsDir: true, ID: ${JSON.stringify(DIRECTORY_ID)} }]));
  process.exit(0);
}
process.exit(2);
`;

/**
 * The `archive` block of a PipelineConfig.pdfDocQa section.
 *
 * The repository is the REMOTE rclone variant on purpose: a local restic
 * repository in a temp directory shares a device with the primary archive
 * root, and assessLocalBackupBoundaryInternal rejects that with
 * `backup_not_independent`. The remote variant takes the remoteBoundary
 * branch and never compares devices.
 *
 * requireIndependentArchivePair (kith-store archiveBindings.ts) rejects a
 * pair that shares archiveIdentityFingerprint, recipientFingerprint,
 * repositoryKeyDomainFingerprint or storageFailureDomainFingerprint, so all
 * four differ by role. Only archiveProfileFingerprint is shared: both copies
 * are the same archive profile.
 */
export function archiveConfig(tools) {
  const fingerprints = (role) => ({
    archiveProfileFingerprint: hex("synthetic-archive-profile"),
    archiveIdentityFingerprint: hex(`synthetic-archive-identity:${role}`),
    recipientFingerprint: hex(`synthetic-recipient:${role}`),
    repositoryKeyDomainFingerprint: hex(
      `synthetic-repository-key-domain:${role}`,
    ),
    storageFailureDomainFingerprint: hex(
      `synthetic-storage-failure-domain:${role}`,
    ),
  });
  return {
    ageBinary: tools.ageBinary,
    primary: {
      directory: tools.primaryDirectory,
      recipient: PRIMARY_RECIPIENT,
      ...fingerprints("primary"),
    },
    independentBackup: {
      directory: tools.backupDirectory,
      recipient: BACKUP_RECIPIENT,
      resticBinary: tools.resticBinary,
      repository: {
        kind: "rclone_dropbox_v1",
        remoteName: REMOTE_NAME,
        rootPath: ROOT_PATH,
        rcloneBinary: tools.rcloneBinary,
        configPath: tools.rcloneConfigPath,
        configIdentityFingerprint: hex(
          `dropbox-config:v1\0${JSON.stringify([tools.rcloneConfigPath, REMOTE_NAME, "dropbox"])}`,
        ),
        expectedRootDirectoryIdHash: hex(DIRECTORY_ID),
      },
      expectedRepositoryId: REPOSITORY_ID,
      passwordCommand: tools.passwordCommand,
      host: "kithmind-independent-backup",
      ...fingerprints("independent_backup"),
    },
  };
}

/** Build the temp archive world. Pass the node:test context for cleanup. */
export async function archiveTools(t) {
  // os.tmpdir() is the per-user temp directory; every ancestor must be
  // owned by the user or root and never group/other writable, and the path
  // must already be canonical, hence the realpath.
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "kithmind-archive-")),
  );
  await chmod(base, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));

  const tools = join(base, "tools");
  const primaryDirectory = join(base, "primary");
  const backupDirectory = join(base, "backup");
  const repositoryRoot = join(base, "repository");
  for (const path of [
    tools,
    primaryDirectory,
    backupDirectory,
    repositoryRoot,
  ]) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }

  // rclone reads this through a protected-path check: mode must be exactly
  // 0600, the file non-empty, and the remote section closed to type + token.
  const rcloneConfigPath = join(tools, "rclone.conf");
  await writeFile(
    rcloneConfigPath,
    `[${REMOTE_NAME}]\ntype = dropbox\ntoken = ${JSON.stringify({ access_token: "synthetic-token", token_type: "bearer" })}\n`,
    { mode: 0o600 },
  );

  const result = {
    base,
    tools,
    ageBinary: await program(join(tools, "age"), AGE_SOURCE),
    resticBinary: await program(
      join(tools, "restic"),
      resticSource(repositoryRoot),
    ),
    rcloneBinary: await program(join(tools, "rclone"), RCLONE_SOURCE),
    rcloneConfigPath,
    passwordCommand: {
      executable: await program(
        join(tools, "password-command"),
        `process.stdout.write("synthetic-password\\n");`,
      ),
      publicArgs: ["kithmind-archive"],
    },
    primaryDirectory,
    backupDirectory,
    repositoryRoot,
  };
  return { ...result, archiveConfig: archiveConfig(result) };
}
